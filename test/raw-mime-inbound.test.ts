// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Env } from "../workers/types";
import { receiveEmail } from "../workers/index";
import { mailbox } from "./helpers";

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

function rawEmailBytes(to: string, subject = "Inbound test"): Uint8Array {
	const raw = [
		"From: sender@example.com",
		`To: ${to}`,
		`Subject: ${subject}`,
		"Date: Wed, 21 Aug 2026 00:00:00 +0000",
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=\"UTF-8\"",
		"",
		"Hello from the outside world.",
		"",
	].join("\r\n");
	return new TextEncoder().encode(raw);
}

describe("receiveEmail: raw MIME storage (DEV-661)", () => {
	it("stores the raw bytes to R2 byte-for-byte and records raw_key + rfc822_size", async () => {
		const mailboxId = "inbound-raw@example.com";
		await env.BUCKET.put(`mailboxes/${mailboxId}.json`, "{}");

		const bytes = rawEmailBytes(mailboxId);
		const ctx = createExecutionContext();
		await receiveEmail(
			{ raw: streamFromBytes(bytes), rawSize: bytes.byteLength },
			env as unknown as Env,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		const stub = mailbox(mailboxId);
		const emails = await stub.getEmails({ folder: "inbox" });
		expect(emails).toHaveLength(1);
		const created = emails[0] as { id: string };

		const full = (await stub.getEmail(created.id)) as {
			raw_key: string | null;
			rfc822_size: number | null;
		};
		expect(full.raw_key).toBe(`raw/${mailboxId}/${created.id}.eml`);
		expect(full.rfc822_size).toBe(bytes.byteLength);

		const stored = await env.BUCKET.get(full.raw_key as string);
		expect(stored).not.toBeNull();
		const storedBytes = new Uint8Array(await (stored as R2ObjectBody).arrayBuffer());
		expect(Array.from(storedBytes)).toEqual(Array.from(bytes));
	});

	it("never loses mail: if the R2 put throws, the email row is still created with raw_key NULL", async () => {
		const mailboxId = "inbound-r2-outage@example.com";
		const mailboxKey = `mailboxes/${mailboxId}.json`;

		// A bucket stand-in whose `put` always fails (simulating an R2 outage),
		// but whose `head` still reports the mailbox as existing so receiveEmail
		// gets past its "mailbox exists" check.
		const failingBucket = {
			head: async (key: string) => (key === mailboxKey ? ({} as R2Object) : null),
			put: async () => {
				throw new Error("simulated R2 outage");
			},
		} as unknown as Env["BUCKET"];

		const testEnv = { ...(env as unknown as Env), BUCKET: failingBucket };

		const bytes = rawEmailBytes(mailboxId, "Should still land in the inbox");
		const ctx = createExecutionContext();
		await receiveEmail({ raw: streamFromBytes(bytes), rawSize: bytes.byteLength }, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		// The email itself must exist -- a storage hiccup must not drop mail.
		const stub = mailbox(mailboxId);
		const emails = await stub.getEmails({ folder: "inbox" });
		expect(emails).toHaveLength(1);

		const full = (await stub.getEmail(emails[0].id)) as {
			raw_key: string | null;
			rfc822_size: number | null;
			subject: string | null;
		};
		expect(full.subject).toBe("Should still land in the inbox");
		expect(full.raw_key).toBeNull();
		// Size is still recorded -- it's just a byte count, independent of
		// whether the storage attempt succeeded.
		expect(full.rfc822_size).toBe(bytes.byteLength);
	});
});

/**
 * BODYSTRUCTURE is derived once, where the raw bytes already exist, so a
 * client's initial sync never pulls a message out of R2 just to learn its
 * shape. Inbound is the path that matters: it is every message received.
 */
describe("receiveEmail: precomputed BODYSTRUCTURE (DEV-678)", () => {
	function multipartBytes(to: string): Uint8Array {
		const raw = [
			"From: sender@example.com",
			`To: ${to}`,
			"Subject: With an attachment",
			"Date: Wed, 21 Aug 2026 00:00:00 +0000",
			"MIME-Version: 1.0",
			'Content-Type: multipart/mixed; boundary="BOUND"',
			"",
			"--BOUND",
			'Content-Type: text/plain; charset="UTF-8"',
			"",
			"See attached.",
			"--BOUND",
			"Content-Type: application/pdf",
			"Content-Transfer-Encoding: base64",
			'Content-Disposition: attachment; filename="r.pdf"',
			"",
			"aGVsbG8=",
			"--BOUND--",
			"",
		].join("\r\n");
		return new TextEncoder().encode(raw);
	}

	async function deliver(mailboxId: string, bytes: Uint8Array) {
		await env.BUCKET.put(`mailboxes/${mailboxId}.json`, "{}");
		const ctx = createExecutionContext();
		await receiveEmail(
			{ raw: streamFromBytes(bytes), rawSize: bytes.byteLength },
			env as unknown as Env,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		const stub = mailbox(mailboxId);
		const emails = (await stub.getEmails({ folder: "inbox" })) as { id: string }[];
		return (await stub.getEmail(emails[0].id)) as {
			raw_key: string | null;
			body_structure: string | null;
		};
	}

	it("populates body_structure alongside raw_key", async () => {
		const full = await deliver("bs-inbound@example.com", multipartBytes("bs-inbound@example.com"));

		expect(full.raw_key).not.toBeNull();
		expect(full.body_structure).not.toBeNull();

		const parsed = JSON.parse(full.body_structure as string);
		expect(parsed.type).toBe("multipart");
		expect(parsed.subtype).toBe("mixed");
		expect(parsed.children).toHaveLength(2);
		expect(parsed.children[1].subtype).toBe("pdf");
	});

	it("leaves body_structure NULL when the raw bytes could not be stored", async () => {
		// A structure describing bytes nobody will be served is worse than none:
		// with raw_key NULL the raw endpoint synthesizes a different message.
		const mailboxId = "bs-r2-outage@example.com";
		await env.BUCKET.put(`mailboxes/${mailboxId}.json`, "{}");

		const original = env.BUCKET.put.bind(env.BUCKET);
		(env.BUCKET as unknown as { put: unknown }).put = async (key: string, ...rest: unknown[]) => {
			if (key.startsWith("raw/")) throw new Error("simulated R2 outage");
			return original(key, ...(rest as [never]));
		};
		try {
			const bytes = multipartBytes(mailboxId);
			const ctx = createExecutionContext();
			await receiveEmail(
				{ raw: streamFromBytes(bytes), rawSize: bytes.byteLength },
				env as unknown as Env,
				ctx,
			);
			await waitOnExecutionContext(ctx);
		} finally {
			(env.BUCKET as unknown as { put: unknown }).put = original;
		}

		const stub = mailbox(mailboxId);
		const emails = (await stub.getEmails({ folder: "inbox" })) as { id: string }[];
		const full = (await stub.getEmail(emails[0].id)) as {
			raw_key: string | null;
			body_structure: string | null;
		};
		expect(full.raw_key).toBeNull();
		expect(full.body_structure).toBeNull();
	});
});
