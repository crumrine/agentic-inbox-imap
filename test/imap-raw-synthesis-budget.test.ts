// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Regression coverage for the legacy-synthesis memory finding in
 * workers/routes/imap-api.ts: rebuilding a raw message for a row with no
 * stored bytes (`raw_key IS NULL`) used to read every attachment fully into
 * memory (`object.arrayBuffer()`), convert it to a binary string, and
 * base64-encode it -- multiple full copies of the attachment live at once,
 * with no ceiling. A single legacy message with a large attachment could
 * exceed the isolate's 128 MB limit and kill the request that this fallback
 * exists to rescue.
 *
 * Two independent things are tested:
 *  - `streamToBase64` produces byte-identical output to a naive
 *    whole-buffer base64 encode, across chunk boundaries that don't land on
 *    a multiple of 3 bytes (the case that would corrupt output if the
 *    leftover-carry logic were wrong).
 *  - The `/raw` route now refuses outright, with a clear 413 and no R2 read
 *    at all, when a legacy row's declared attachment size exceeds
 *    `SYNTHESIS_BUDGET_BYTES` -- rather than either attempting the OOM-prone
 *    read or silently truncating.
 */

import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import {
	IMAP_API_BASE,
	type ImapApiEnv,
	imapApi,
	streamToBase64,
	SYNTHESIS_BUDGET_BYTES,
} from "../workers/routes/imap-api";
import { type MailboxStub, exec, mailbox } from "./helpers";

const app = new Hono<{ Bindings: ImapApiEnv }>().route(IMAP_API_BASE, imapApi);

let n = 0;
function uniqueMailbox(prefix: string): string {
	n += 1;
	return `${prefix}-${n}@example.com`;
}

async function makeMailbox(prefix: string): Promise<{ id: string; stub: MailboxStub }> {
	const id = uniqueMailbox(prefix);
	await env.BUCKET.put(`mailboxes/${id}.json`, JSON.stringify({ fromName: "Test" }));
	return { id, stub: mailbox(id) };
}

async function seed(stub: MailboxStub, id: string): Promise<void> {
	await exec(
		stub,
		`INSERT INTO emails (
			id, folder_id, subject, sender, recipient, date, read, starred,
			body, uid, answered, deleted, raw_key
		) VALUES (?1, 'inbox', 'Subject', 'sender@example.com', 'recipient@example.com',
			'2026-03-01T10:00:00.000Z', 0, 0, 'body text', 1, 0, 0, NULL)`,
		id,
	);
}

async function get(path: string): Promise<Response> {
	return app.request(`${IMAP_API_BASE}${path}`, {}, env);
}

function randomBytes(seed: number, n: number): Uint8Array {
	const bytes = new Uint8Array(n);
	let x = seed;
	for (let i = 0; i < n; i++) {
		// xorshift32 -- deterministic, no crypto needed for test fixtures.
		x ^= x << 13;
		x ^= x >>> 17;
		x ^= x << 5;
		bytes[i] = x & 0xff;
	}
	return bytes;
}

function naiveBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

/** A ReadableStream that yields `bytes` split at the given chunk boundaries,
 * so the leftover-carry logic in streamToBase64 is exercised deliberately
 * rather than however the test runtime happens to buffer things. */
function chunkedStream(bytes: Uint8Array, chunkSizes: number[]): ReadableStream<Uint8Array> {
	let offset = 0;
	let chunkIndex = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= bytes.length) {
				controller.close();
				return;
			}
			const size = chunkSizes[chunkIndex % chunkSizes.length];
			chunkIndex += 1;
			const end = Math.min(offset + size, bytes.length);
			controller.enqueue(bytes.slice(offset, end));
			offset = end;
		},
	});
}

describe("streamToBase64", () => {
	it("matches a naive whole-buffer base64 encode for an empty stream", async () => {
		const bytes = randomBytes(1, 0);
		expect(await streamToBase64(chunkedStream(bytes, [7]))).toBe(naiveBase64(bytes));
	});

	it("matches a naive whole-buffer base64 encode across 1-byte-at-a-time chunks", async () => {
		const bytes = randomBytes(2, 500);
		expect(await streamToBase64(chunkedStream(bytes, [1]))).toBe(naiveBase64(bytes));
	});

	it("matches a naive whole-buffer base64 encode across chunk sizes that never align to 3", async () => {
		const bytes = randomBytes(3, 5003); // length itself not a multiple of 3
		for (const chunkSizes of [[4], [5, 7], [2, 9, 1], [10000]]) {
			expect(await streamToBase64(chunkedStream(bytes, chunkSizes))).toBe(naiveBase64(bytes));
		}
	});

	it("matches a naive whole-buffer base64 encode for lengths 1 and 2 (padding cases)", async () => {
		for (const len of [1, 2]) {
			const bytes = randomBytes(4 + len, len);
			expect(await streamToBase64(chunkedStream(bytes, [1]))).toBe(naiveBase64(bytes));
		}
	});
});

describe("GET /{mailbox}/messages/{uid}/raw: legacy synthesis budget", () => {
	it("refuses to synthesize when declared attachment size exceeds the budget, without reading R2", async () => {
		const { id, stub } = await makeMailbox("synth-budget");
		await seed(stub, "big1");
		// Declare an attachment bigger than the budget. Deliberately do NOT
		// put anything at the corresponding R2 key -- if the budget check ran
		// after (or never checked) attachment size, this would still 200 with
		// a truncated message (missing attachment) rather than failing loudly,
		// which is exactly the failure mode this test guards against.
		await exec(
			stub,
			`INSERT INTO attachments (id, email_id, filename, mimetype, size, content_id, disposition)
			 VALUES ('bigatt', 'big1', 'huge.bin', 'application/octet-stream', ?1, NULL, 'attachment')`,
			SYNTHESIS_BUDGET_BYTES + 1,
		);

		const res = await get(`/${id}/messages/1/raw?folder=inbox`);
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: "Message too large to reconstruct" });
	});

	it("still synthesizes normally when total attachment size is within the budget", async () => {
		const { id, stub } = await makeMailbox("synth-budget-ok");
		await seed(stub, "small1");
		await exec(
			stub,
			`INSERT INTO attachments (id, email_id, filename, mimetype, size, content_id, disposition)
			 VALUES ('smallatt', 'small1', 'note.txt', 'text/plain', 5, NULL, 'attachment')`,
		);
		await env.BUCKET.put(`attachments/small1/smallatt/note.txt`, new TextEncoder().encode("hello"));

		const res = await get(`/${id}/messages/1/raw?folder=inbox`);
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain(btoa("hello"));
	});
});
