// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Automatic send-as on the SMTP submission path (DEV-692 part three):
 *
 *   POST /api/imap/v1/{mailbox}/submit?envelopeFrom=&envelopeTo=
 *
 * Part two made an alias *permitted* here — the client picks the From address
 * and the endpoint stopped refusing it. That helps a client that can pick, and
 * not at all the one the user actually sends from: iOS Mail only ever emits
 * the account address, so a reply to something that arrived at `info@` went
 * back out as the mailbox. This file pins the rewrite that fixes it, and, more
 * importantly, every case where the rewrite must *not* happen.
 *
 * Three things make this dangerous enough to test from both sides:
 *
 * 1. **Overriding an explicit choice is worse than the bug.** A client that
 *    set From to an alias itself (macOS Mail can) meant it. The rewrite is
 *    confined to the case where From is the mailbox's own address, which is
 *    the only value that could have come from a client with no picker.
 *
 * 2. **The bytes are the client's bytes.** This is the one path where the
 *    stored `.eml` is byte-exact by construction. The rewrite is the single
 *    intentional edit, so it is asserted as a diff: the From line changes and
 *    every other octet does not — `Message-ID:` above all, because the Sent
 *    copy the client APPENDs afterwards deduplicates against this row by it.
 *
 * 3. **The stored routing address is a hint, not an authorisation.**
 *    `delivered_to` was written when the message arrived; the alias can since
 *    have been deleted or re-pointed at somebody else's mailbox. Both are
 *    asserted on the bytes handed to the send binding, not just on the row.
 */

import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";

import { Folders } from "../shared/folders";
import { createAlias, deleteAlias } from "../workers/lib/aliases";
import {
	IMAP_API_BASE,
	type ImapApiEnv,
	imapApi,
} from "../workers/routes/imap-api";
import { type MailboxStub, mailbox, query } from "./helpers";

const app = new Hono<{ Bindings: ImapApiEnv }>().route(IMAP_API_BASE, imapApi);

/**
 * Fixed names for the whole file, not one per test.
 *
 * `test/setup.ts`'s afterEach walks every MailboxDO id that has ever been
 * named and wipes it, so minting a mailbox per test is quadratic in teardown.
 * Storage and R2 are still wiped between tests, so each one gets a freshly
 * migrated Durable Object and an empty registry out of these names.
 */
const OWNER = "owner@example.com";
const OTHER = "other@example.com";
/** The alias the inbound message was delivered to. */
const ALIAS = "info@example.com";
/** A second alias of OWNER, for the "the client picked one itself" case. */
const CHOSEN = "sales@example.com";
const OUTSIDER = "outsider@somewhere-else.example";

/** The Message-ID of the inbound message every reply here answers. */
const ORIGINAL_MSG_ID = "original-1@somewhere-else.example";

let ownerStub: MailboxStub;

beforeEach(async () => {
	for (const id of [OWNER, OTHER]) {
		await env.BUCKET.put(`mailboxes/${id}.json`, JSON.stringify({ fromName: "Test" }));
	}
	ownerStub = mailbox(OWNER);
});

// ── Fake upstream ─────────────────────────────────────────────────────

interface SentMessage {
	from: string;
	to: string;
	raw: string;
}

interface FakeEmail {
	binding: ImapApiEnv["EMAIL"];
	sent: SentMessage[];
}

/**
 * A stand-in for the `send_email` binding. `env.EMAIL` is a `remote: true`
 * binding that hangs under the local runner, and the envelope sender is half
 * of what this file asserts, so the fake records both ends of every send.
 */
function fakeEmail(): FakeEmail {
	const sent: SentMessage[] = [];
	const binding = {
		async send(message: unknown) {
			const envelope = message as { from: string; to: string };
			sent.push({ from: envelope.from, to: envelope.to, raw: await rawOf(message) });
			return { messageId: `upstream-${sent.length}` };
		},
	};
	return { binding: binding as unknown as ImapApiEnv["EMAIL"], sent };
}

/**
 * Read the raw body back off the `EmailMessage` the route constructed.
 * workerd exposes it under an own property whose name it does not promise, so
 * this looks rather than assumes and throws loudly if the shape ever changes,
 * instead of quietly asserting nothing.
 */
async function rawOf(message: unknown): Promise<string> {
	const record = message as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!key.toLowerCase().includes("raw")) continue;
		const value = record[key];
		if (typeof value === "string") return value;
		if (value instanceof ReadableStream) {
			return new TextDecoder().decode(
				new Uint8Array(await new Response(value as ReadableStream<Uint8Array>).arrayBuffer()),
			);
		}
	}
	throw new Error(
		`EmailMessage exposes no raw body; own keys were [${Object.keys(record).join(", ")}]`,
	);
}

function testEnv(email: FakeEmail): ImapApiEnv {
	return {
		BUCKET: env.BUCKET,
		EMAIL: email.binding,
		EMAIL_ADDRESSES: env.EMAIL_ADDRESSES,
		MAILBOX: env.MAILBOX,
		IMAP_AUTH_RATE_LIMIT: env.IMAP_AUTH_RATE_LIMIT,
	};
}

// ── Fixtures ──────────────────────────────────────────────────────────

/** Seed the inbound message a reply answers, with the address it arrived at. */
async function seedOriginal(deliveredTo: string | null): Promise<void> {
	await ownerStub.createEmail(
		Folders.INBOX,
		{
			id: "original-1",
			subject: "Question about pricing",
			sender: OUTSIDER,
			recipient: deliveredTo ?? OWNER,
			date: "2026-08-01T00:00:00Z",
			body: "<p>Hello.</p>",
			message_id: ORIGINAL_MSG_ID,
			thread_id: ORIGINAL_MSG_ID,
			...(deliveredTo === null ? {} : { delivered_to: deliveredTo }),
		},
		[],
	);
}

interface RawOptions {
	/** The full `From:` header value, display name and all. */
	from?: string;
	inReplyTo?: string | null;
	references?: string | null;
	messageId?: string;
}

/** A small, valid RFC 5322 reply. CRLF throughout, as a real one has. */
function rawReply(options: RawOptions = {}): string {
	const headers = [
		`From: ${options.from ?? OWNER}`,
		`To: ${OUTSIDER}`,
		"Subject: Re: Question about pricing",
		"Date: Wed, 12 Mar 2026 09:14:00 +0000",
		`Message-ID: <${options.messageId ?? "phone-reply-1@example.com"}>`,
	];
	if (options.inReplyTo !== null) {
		headers.push(`In-Reply-To: <${options.inReplyTo ?? ORIGINAL_MSG_ID}>`);
	}
	if (options.references !== null) {
		headers.push(`References: <${options.references ?? ORIGINAL_MSG_ID}>`);
	}
	headers.push("MIME-Version: 1.0");
	headers.push('Content-Type: text/plain; charset="utf-8"');
	return `${headers.join("\r\n")}\r\n\r\nSure, happy to help.\r\n`;
}

async function submit(
	email: FakeEmail,
	envelopeFrom: string,
	body: string,
): Promise<Response> {
	const search = new URLSearchParams({ envelopeFrom, envelopeTo: OUTSIDER });
	return app.request(
		`${IMAP_API_BASE}/${OWNER}/submit?${search.toString()}`,
		{ method: "POST", headers: { "content-type": "message/rfc822" }, body },
		testEnv(email),
	);
}

/** Submit and assert it succeeded, returning the one message the fake saw. */
async function submitOk(
	email: FakeEmail,
	envelopeFrom: string,
	body: string,
): Promise<SentMessage> {
	const res = await submit(email, envelopeFrom, body);
	expect(res.status).toBe(200);
	expect(email.sent).toHaveLength(1);
	return email.sent[0];
}

/** The `From:` header line of a raw message. */
function fromLine(raw: string): string {
	const line = raw.split("\r\n").find((l) => l.toLowerCase().startsWith("from:"));
	if (line === undefined) throw new Error("message has no From header");
	return line;
}

async function sentSenders(): Promise<string[]> {
	const rows = await query<{ sender: string }>(
		ownerStub,
		`SELECT sender FROM emails WHERE folder_id = ? ORDER BY uid`,
		Folders.SENT,
	);
	return rows.map((r) => r.sender);
}

// ── The rewrite happens ───────────────────────────────────────────────

describe("a default-From reply to an alias-delivered message is rewritten", () => {
	beforeEach(async () => {
		await createAlias(env, ALIAS, OWNER);
		await seedOriginal(ALIAS);
	});

	it("rewrites the From header bytes and the envelope sender together", async () => {
		const email = fakeEmail();
		const sent = await submitOk(email, OWNER, rawReply());

		// Both, or the message is inconsistent: a mismatched envelope sender is
		// what SPF and DMARC alignment are checked against.
		expect(fromLine(sent.raw)).toBe(`From: ${ALIAS}`);
		expect(sent.from).toBe(ALIAS);
		expect(sent.to).toBe(OUTSIDER);
	});

	it("records the alias as the Sent row's sender, agreeing with the bytes", async () => {
		const email = fakeEmail();
		await submitOk(email, OWNER, rawReply());
		expect(await sentSenders()).toEqual([ALIAS]);
	});

	it("stores in R2 the same bytes it sent", async () => {
		const email = fakeEmail();
		const sent = await submitOk(email, OWNER, rawReply());

		const rows = await query<{ raw_key: string | null }>(
			ownerStub,
			`SELECT raw_key FROM emails WHERE folder_id = ?`,
			Folders.SENT,
		);
		const stored = await env.BUCKET.get(rows[0].raw_key as string);
		expect(stored).not.toBeNull();
		expect(await (stored as R2ObjectBody).text()).toBe(sent.raw);
	});

	it("finds the original through References when In-Reply-To is absent", async () => {
		const email = fakeEmail();
		const sent = await submitOk(email, OWNER, rawReply({ inReplyTo: null }));
		expect(fromLine(sent.raw)).toBe(`From: ${ALIAS}`);
	});

	it("changes the From line and not one other octet", async () => {
		const email = fakeEmail();
		const raw = rawReply();
		const sent = await submitOk(email, OWNER, raw);

		const before = raw.split("\r\n");
		const after = sent.raw.split("\r\n");
		expect(after).toHaveLength(before.length);

		const differing = before
			.map((line, i) => (line === after[i] ? null : i))
			.filter((i): i is number => i !== null);
		expect(differing).toEqual([0]);
		expect(before[0]).toBe(`From: ${OWNER}`);
		expect(after[0]).toBe(`From: ${ALIAS}`);
	});

	it("leaves the Message-ID alone, so the client's Sent copy still dedups", async () => {
		const email = fakeEmail();
		const raw = rawReply({ messageId: "phone-dedup@example.com" });
		const sent = await submitOk(email, OWNER, raw);

		// The header the whole dedup rule turns on, in the transmitted bytes.
		expect(sent.raw).toContain("Message-ID: <phone-dedup@example.com>");

		// The client now APPENDs *its own* copy — which still says From: owner@,
		// because the client never learns about the rewrite. Dedup is by
		// Message-ID alone, so it must collapse onto the row already there.
		const appended = await app.request(
			`${IMAP_API_BASE}/${OWNER}/${Folders.SENT}/append?flags=%5CSeen`,
			{ method: "POST", headers: { "content-type": "message/rfc822" }, body: raw },
			testEnv(email),
		);
		expect(appended.status).toBe(200);
		expect(await appended.json()).toMatchObject({ deduplicated: true });

		// One row, still carrying the alias the Worker wrote.
		expect(await sentSenders()).toEqual([ALIAS]);
	});
});

// ── Display names survive ─────────────────────────────────────────────

describe("the display name survives the rewrite", () => {
	beforeEach(async () => {
		await createAlias(env, ALIAS, OWNER);
		await seedOriginal(ALIAS);
	});

	it("keeps a plain display name", async () => {
		const email = fakeEmail();
		const sent = await submitOk(email, OWNER, rawReply({ from: `Test Owner <${OWNER}>` }));
		expect(fromLine(sent.raw)).toBe(`From: Test Owner <${ALIAS}>`);
	});

	it("keeps a quoted display name containing the address itself", async () => {
		const email = fakeEmail();
		// The ambiguous case: the address appears twice on the line. The
		// bracketed span is the addr-spec by definition, so only it may move.
		const sent = await submitOk(email, OWNER, rawReply({ from: `"${OWNER}" <${OWNER}>` }));
		expect(fromLine(sent.raw)).toBe(`From: "${OWNER}" <${ALIAS}>`);
	});

	it("keeps an RFC 2047 encoded display name byte-for-byte", async () => {
		const email = fakeEmail();
		// "Björn Öwner" as a base64 encoded-word. The rewrite must never decode
		// and re-encode it: that would change bytes outside the address.
		const encoded = "=?UTF-8?B?QmrDtnJuIMOWd25lcg==?=";
		const sent = await submitOk(email, OWNER, rawReply({ from: `${encoded} <${OWNER}>` }));
		expect(fromLine(sent.raw)).toBe(`From: ${encoded} <${ALIAS}>`);
	});
});

// ── The rewrite does not happen ───────────────────────────────────────

describe("the rewrite is withheld when it would be wrong", () => {
	it("falls back to the mailbox when the alias was deleted after delivery", async () => {
		await createAlias(env, ALIAS, OWNER);
		await seedOriginal(ALIAS);
		// The row still says info@; the registry no longer agrees.
		expect(await deleteAlias(env, ALIAS, OWNER)).toBe(true);

		const email = fakeEmail();
		const sent = await submitOk(email, OWNER, rawReply());

		expect(fromLine(sent.raw)).toBe(`From: ${OWNER}`);
		expect(sent.from).toBe(OWNER);
		expect(await sentSenders()).toEqual([OWNER]);
	});

	it("falls back to the mailbox when the alias was re-pointed elsewhere", async () => {
		await createAlias(env, ALIAS, OWNER);
		await seedOriginal(ALIAS);
		// The settings page can do exactly this. Sending as it now would be
		// sending as an address this mailbox no longer owns.
		const repointed = await createAlias(env, ALIAS, OTHER, { allowRepoint: true });
		expect(repointed.ok).toBe(true);

		const email = fakeEmail();
		const sent = await submitOk(email, OWNER, rawReply());

		expect(fromLine(sent.raw)).toBe(`From: ${OWNER}`);
		expect(sent.from).toBe(OWNER);
		expect(await sentSenders()).toEqual([OWNER]);
	});

	it("honours a From the client chose itself, never overriding it", async () => {
		await createAlias(env, ALIAS, OWNER);
		await createAlias(env, CHOSEN, OWNER);
		await seedOriginal(ALIAS);

		// A client that supports alias selection picked sales@ for a reply to a
		// message that arrived at info@. That is a deliberate choice.
		const email = fakeEmail();
		const sent = await submitOk(email, CHOSEN, rawReply({ from: CHOSEN }));

		expect(fromLine(sent.raw)).toBe(`From: ${CHOSEN}`);
		expect(sent.from).toBe(CHOSEN);
		expect(await sentSenders()).toEqual([CHOSEN]);
	});

	it("leaves a non-reply alone: no In-Reply-To and no References", async () => {
		await createAlias(env, ALIAS, OWNER);
		await seedOriginal(ALIAS);

		const email = fakeEmail();
		const sent = await submitOk(
			email,
			OWNER,
			rawReply({ inReplyTo: null, references: null }),
		);

		// A fresh compose has no routing address to inherit and nothing to infer
		// one from, even with the alias sitting right there in the mailbox.
		expect(fromLine(sent.raw)).toBe(`From: ${OWNER}`);
		expect(sent.from).toBe(OWNER);
	});

	it("leaves a reply whose original predates delivered_to alone", async () => {
		await createAlias(env, ALIAS, OWNER);
		await seedOriginal(null);

		const email = fakeEmail();
		const sent = await submitOk(email, OWNER, rawReply());

		// NULL is a complete answer meaning "not known", not an error and not a
		// reason to guess.
		expect(fromLine(sent.raw)).toBe(`From: ${OWNER}`);
		expect(sent.from).toBe(OWNER);
		expect(await sentSenders()).toEqual([OWNER]);
	});

	it("leaves a reply to a message this mailbox does not hold alone", async () => {
		await createAlias(env, ALIAS, OWNER);
		await seedOriginal(ALIAS);

		const email = fakeEmail();
		const sent = await submitOk(
			email,
			OWNER,
			rawReply({ inReplyTo: "unknown@elsewhere.example", references: "unknown@elsewhere.example" }),
		);

		expect(fromLine(sent.raw)).toBe(`From: ${OWNER}`);
		expect(sent.from).toBe(OWNER);
	});
});
