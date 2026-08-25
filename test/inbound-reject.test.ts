// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * DEV-700: mail this deployment cannot deliver is rejected, not discarded.
 *
 * The domain has a catch-all routing rule, so every address on it reaches the
 * Worker. Before this, an address with no mailbox and no alias was logged and
 * returned from — the sending server got a 250 and the message evaporated.
 * These tests pin the two halves of the fix:
 *
 *   * a message no recipient of which resolves gets `setReject`, and nothing
 *     is written to the Durable Object or R2 on the way there;
 *   * a message that *is* deliverable is never rejected. Over-rejecting is the
 *     catastrophic direction — it turns "some mail is lost" into "all mail is
 *     bounced" — so the negative cases carry as much weight as the positive.
 *
 * One fixed mailbox id for the whole file: test/setup.ts's afterEach walks
 * every Durable Object that has ever been constructed, so minting an id per
 * test makes teardown quadratic.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createAlias } from "../workers/lib/aliases";
import { handleInboundEmail, REJECT_REASONS } from "../workers/index";
import type { Env } from "../workers/types";
import { mailbox } from "./helpers";

const testEnv = env as unknown as Env;

/** The single mailbox this file uses. R2 is wiped between tests, so it is reusable. */
const MAILBOX = "recipient@example.com";
const ALIAS = "info@example.com";
const STRANGER = "nobody@example.com";

async function makeMailbox(id: string = MAILBOX): Promise<string> {
	await env.BUCKET.put(`mailboxes/${id}.json`, JSON.stringify({ fromName: "Test" }));
	return id;
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

function rawEmailBytes(to: string, subject = "Inbound"): Uint8Array {
	return new TextEncoder().encode(
		[
			"From: outsider@somewhere-else.example",
			`To: ${to}`,
			`Subject: ${subject}`,
			"Date: Sat, 22 Aug 2026 00:00:00 +0000",
			"MIME-Version: 1.0",
			'Content-Type: text/plain; charset="UTF-8"',
			"",
			"Hello.",
			"",
		].join("\r\n"),
	);
}

interface Attempt {
	/** Every reason passed to setReject, in order. Empty means never rejected. */
	rejects: string[];
	status: "delivered" | "rejected";
}

/**
 * Run one message through the real inbound entry point with a `setReject` spy
 * standing in for the runtime's.
 */
async function deliver(
	opts: {
		headerTo: string;
		subject?: string;
		envelopeTo?: string;
		/** Override the declared body size, for the oversize/zero-size cases. */
		rawSize?: number;
		env?: Env;
	},
): Promise<Attempt> {
	const bytes = rawEmailBytes(opts.headerTo, opts.subject ?? "Inbound");
	const rejects: string[] = [];
	const ctx = createExecutionContext();
	const result = await handleInboundEmail(
		{
			raw: streamFromBytes(bytes),
			rawSize: opts.rawSize ?? bytes.byteLength,
			to: opts.envelopeTo ?? opts.headerTo.split(",")[0].trim(),
			setReject: (reason: string) => {
				rejects.push(reason);
			},
		},
		opts.env ?? testEnv,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return { rejects, status: result.status };
}

async function inboxSubjects(mailboxId: string): Promise<string[]> {
	const emails = await mailbox(mailboxId).getEmails({ folder: "inbox" });
	return emails.map((e) => e.subject ?? "");
}

/** Every R2 key that is not one of the registry blobs the test itself wrote. */
async function strayR2Keys(): Promise<string[]> {
	const page = await env.BUCKET.list({ limit: 1000 });
	return page.objects
		.map((o) => o.key)
		.filter((k) => !k.startsWith("mailboxes/") && !k.startsWith("aliases/"));
}

// ── Rejected ────────────────────────────────────────────────────────

describe("inbound: mail we cannot deliver is rejected", () => {
	it("rejects an address that is neither a mailbox nor an alias, and writes nothing", async () => {
		await makeMailbox();

		const attempt = await deliver({ headerTo: STRANGER, subject: "Nowhere to go" });

		expect(attempt.status).toBe("rejected");
		expect(attempt.rejects).toEqual([REJECT_REASONS.unknownRecipient]);

		// The existing mailbox must not have caught it, and no blob may have
		// been written on the way to the rejection.
		expect(await inboxSubjects(MAILBOX)).toEqual([]);
		expect(await strayR2Keys()).toEqual([]);
	});

	it("rejects an alias whose target mailbox has since been deleted", async () => {
		await makeMailbox();
		expect((await createAlias(testEnv, ALIAS, MAILBOX)).ok).toBe(true);

		// The alias record outlives the mailbox it points at. Delivery has
		// nowhere to land, so this is a rejection and not a silent drop.
		await env.BUCKET.delete(`mailboxes/${MAILBOX}.json`);

		const attempt = await deliver({ headerTo: ALIAS, subject: "Dangling alias" });

		expect(attempt.status).toBe("rejected");
		expect(attempt.rejects).toEqual([REJECT_REASONS.unknownRecipient]);
		expect(await strayR2Keys()).toEqual([]);
	});

	it("rejects when a non-empty EMAIL_ADDRESSES filters every recipient out", async () => {
		await makeMailbox();
		// The mailbox exists and would otherwise resolve; the allowlist is what
		// refuses it, and that refusal has to reject rather than drop too.
		const restricted = {
			...testEnv,
			EMAIL_ADDRESSES: ["somebody-else@example.com"] as unknown as Env["EMAIL_ADDRESSES"],
		};

		const attempt = await deliver({
			headerTo: MAILBOX,
			subject: "Not on the list",
			env: restricted,
		});

		expect(attempt.status).toBe("rejected");
		expect(attempt.rejects).toEqual([REJECT_REASONS.unknownRecipient]);
		expect(await inboxSubjects(MAILBOX)).toEqual([]);
	});

	it("permanently rejects an oversize message rather than retrying it", async () => {
		await makeMailbox();

		// 25 MiB is MAX_EMAIL_SIZE; one byte over is the boundary. The declared
		// size is what is checked, so the body need not actually be that big --
		// which is the point: the check happens before anything is buffered.
		const attempt = await deliver({
			headerTo: MAILBOX,
			subject: "Far too big",
			rawSize: 25 * 1024 * 1024 + 1,
		});

		expect(attempt.status).toBe("rejected");
		expect(attempt.rejects).toEqual([REJECT_REASONS.tooLarge]);
		expect(await inboxSubjects(MAILBOX)).toEqual([]);
	});

	it("permanently rejects a structurally invalid message", async () => {
		await makeMailbox();

		const attempt = await deliver({
			headerTo: MAILBOX,
			subject: "Zero bytes",
			rawSize: 0,
		});

		expect(attempt.status).toBe("rejected");
		expect(attempt.rejects).toEqual([REJECT_REASONS.malformed]);
	});
});

// ── Delivered: the direction that must never regress ────────────────

describe("inbound: deliverable mail is never rejected", () => {
	it("delivers to an existing mailbox", async () => {
		await makeMailbox();

		const attempt = await deliver({ headerTo: MAILBOX, subject: "Straight in" });

		expect(attempt.status).toBe("delivered");
		expect(attempt.rejects).toEqual([]);
		expect(await inboxSubjects(MAILBOX)).toEqual(["Straight in"]);
	});

	it("delivers to an alias", async () => {
		await makeMailbox();
		expect((await createAlias(testEnv, ALIAS, MAILBOX)).ok).toBe(true);

		const attempt = await deliver({ headerTo: ALIAS, subject: "Via the alias" });

		expect(attempt.status).toBe("delivered");
		expect(attempt.rejects).toEqual([]);
		expect(await inboxSubjects(MAILBOX)).toEqual(["Via the alias"]);
	});

	it("delivers when only one of several recipients resolves", async () => {
		await makeMailbox();

		// Two strangers first, so a naive "does candidates[0] resolve?" check
		// would reject. Rejection is only correct when *nothing* resolves.
		const attempt = await deliver({
			headerTo: `${STRANGER}, someone@somewhere-else.example, ${MAILBOX}`,
			subject: "One of us",
			envelopeTo: STRANGER,
		});

		expect(attempt.status).toBe("delivered");
		expect(attempt.rejects).toEqual([]);
		expect(await inboxSubjects(MAILBOX)).toEqual(["One of us"]);
	});

	it("does not reject on an internal failure", async () => {
		// An R2 hiccup while resolving the recipient says nothing about whether
		// the address exists. Rejecting here would permanently destroy mail
		// that is deliverable the moment the fault clears, so the failure must
		// propagate out of the handler untouched -- setReject never called.
		const failingBucket = {
			head: async () => {
				throw new Error("simulated R2 outage");
			},
			get: async () => {
				throw new Error("simulated R2 outage");
			},
			put: async () => {
				throw new Error("simulated R2 outage");
			},
		} as unknown as Env["BUCKET"];

		const bytes = rawEmailBytes(MAILBOX, "Should not bounce");
		const rejects: string[] = [];
		const ctx = createExecutionContext();

		await expect(
			handleInboundEmail(
				{
					raw: streamFromBytes(bytes),
					rawSize: bytes.byteLength,
					to: MAILBOX,
					setReject: (reason: string) => {
						rejects.push(reason);
					},
				},
				{ ...testEnv, BUCKET: failingBucket },
				ctx,
			),
		).rejects.toThrow("simulated R2 outage");
		await waitOnExecutionContext(ctx);

		expect(rejects).toEqual([]);
	});
});

// ── The reason string goes into an SMTP response ────────────────────

describe("reject reasons are safe to put on the wire", () => {
	it("contain no CR, LF or other control characters", () => {
		for (const reason of Object.values(REJECT_REASONS)) {
			expect(reason).not.toMatch(/[\r\n]/);
			// eslint-disable-next-line no-control-regex
			expect(reason).not.toMatch(/[\x00-\x1f\x7f]/);
			expect(reason.length).toBeLessThanOrEqual(120);
		}
	});

	it("never echo the rejected recipient back", async () => {
		// Recipients carrying SMTP-injection payloads, in the envelope and in
		// the To header, folded and unfolded. Which rejection reason each one
		// lands on depends on how far PostalMime gets, and that is not the
		// point -- the point is that whichever it is, it is one of the fixed
		// constants and carries nothing from the input.
		const hostile = [
			'nasty+"250 OK"@example.com',
			"nasty@example.com>\r\nX-Injected: yes",
			`nasty-${"x".repeat(300)}@example.com`,
		];

		for (const address of hostile) {
			await makeMailbox();
			const attempt = await deliver({ headerTo: address, subject: "Injection attempt" });

			expect(attempt.status).toBe("rejected");
			expect(attempt.rejects).toHaveLength(1);
			for (const reason of attempt.rejects) {
				expect(Object.values(REJECT_REASONS)).toContain(reason);
				expect(reason).not.toMatch(/[\r\n]/);
				expect(reason).not.toContain("nasty");
				expect(reason).not.toContain("250 OK");
				expect(reason).not.toContain("X-Injected");
				expect(reason).not.toContain("example.com");
			}
		}
	});
});
