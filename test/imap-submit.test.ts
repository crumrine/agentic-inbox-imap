// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * SMTP submission (DEV-673):
 *
 *   POST /api/imap/v1/{mailbox}/submit?envelopeFrom=&envelopeTo=
 *
 * Before this endpoint a mail client's outgoing server pointed somewhere else
 * entirely, so mail sent from a phone never entered the app: nothing landed in
 * Sent, `validateSender` never ran, and the per-mailbox rate limit did not
 * apply to the one path most able to abuse it. Everything asserted here is one
 * of those three gates, or one of the two ways the endpoint can quietly do the
 * wrong thing while appearing to work:
 *
 *   - **Bcc.** Delivery must use the SMTP envelope, not the `To:`/`Cc:`
 *     headers. A version that reads recipients out of the headers passes every
 *     naive test and silently drops every blind copy.
 *   - **Message-ID.** Clients APPEND their own Sent copy straight after
 *     submitting and `/append` deduplicates against `sent` by Message-ID. Mint
 *     a new id here and the client's copy can never match, so every sent
 *     message shows up twice. The APPEND-after-submit round trip is asserted
 *     directly rather than inferred.
 *
 * `env.EMAIL` is a `remote: true` binding that hangs under the local runner
 * (see test/raw-mime-outbound.test.ts), so every test here substitutes a fake
 * that records what it was handed.
 */

import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { Folders } from "../shared/folders";
import {
	IMAP_API_BASE,
	IMAP_SUBMIT_MAX_BYTES,
	type ImapApiEnv,
	imapApi,
} from "../workers/routes/imap-api";
import { type MailboxStub, mailbox, query } from "./helpers";

const app = new Hono<{ Bindings: ImapApiEnv }>().route(IMAP_API_BASE, imapApi);

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
 * A stand-in for the `send_email` binding.
 *
 * `failFor` names recipients the upstream refuses; everything else succeeds.
 * The raw body is read back off the `EmailMessage` the route constructed —
 * workerd exposes it under an own property whose name it does not promise, so
 * `rawOf` looks rather than assumes and throws loudly if the shape ever
 * changes, instead of quietly asserting nothing.
 */
function fakeEmail(failFor: (recipient: string) => boolean = () => false): FakeEmail {
	const sent: SentMessage[] = [];
	const binding = {
		async send(message: unknown) {
			const envelope = message as { from: string; to: string };
			if (failFor(envelope.to)) {
				throw new Error(`550 5.1.1 no such user: ${envelope.to}`);
			}
			sent.push({ from: envelope.from, to: envelope.to, raw: await rawOf(message) });
			return { messageId: `upstream-${sent.length}` };
		},
	};
	return { binding: binding as unknown as ImapApiEnv["EMAIL"], sent };
}

async function rawOf(message: unknown): Promise<string> {
	const record = message as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!key.toLowerCase().includes("raw")) continue;
		const value = record[key];
		if (typeof value === "string") return value;
		// The route passes a stream so 8-bit bodies survive; read it as bytes
		// and decode here, where the fixtures are all UTF-8 by construction.
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

let n = 0;
/** Distinct mailbox per test: Durable Object storage is keyed by this name. */
async function makeMailbox(prefix: string): Promise<{ id: string; stub: MailboxStub }> {
	n += 1;
	const id = `${prefix}-${n}@example.com`;
	await env.BUCKET.put(`mailboxes/${id}.json`, JSON.stringify({ fromName: "Test" }));
	return { id, stub: mailbox(id) };
}

/** A small, valid RFC 5322 message. CRLF throughout, as a real one has. */
function rawMessage(
	options: {
		from?: string;
		to?: string;
		cc?: string;
		subject?: string;
		messageId?: string | null;
		body?: string;
	} = {},
): string {
	const headers: string[] = [
		`From: ${options.from ?? "sender@example.com"}`,
		`To: ${options.to ?? "recipient@example.net"}`,
	];
	if (options.cc) headers.push(`Cc: ${options.cc}`);
	headers.push(`Subject: ${options.subject ?? "From my phone"}`);
	headers.push("Date: Wed, 12 Mar 2026 09:14:00 +0000");
	if (options.messageId !== null) {
		headers.push(`Message-ID: <${options.messageId ?? "phone-1@example.com"}>`);
	}
	headers.push("MIME-Version: 1.0");
	headers.push('Content-Type: text/plain; charset="utf-8"');
	return `${headers.join("\r\n")}\r\n\r\n${options.body ?? "Sent from my phone.\r\n"}`;
}

interface SubmitResponse {
	messageId: string;
	sentUid: number;
	sentUidValidity: number;
	failedRecipients?: string[];
}

function submitUrl(mailboxId: string, envelopeFrom: string, envelopeTo: string[]): string {
	const search = new URLSearchParams();
	search.set("envelopeFrom", envelopeFrom);
	if (envelopeTo.length > 0) search.set("envelopeTo", envelopeTo.join(","));
	return `${IMAP_API_BASE}/${mailboxId}/submit?${search.toString()}`;
}

async function submit(
	email: FakeEmail,
	mailboxId: string,
	envelope: { from: string; to: string[] },
	body: BodyInit,
): Promise<Response> {
	return app.request(
		submitUrl(mailboxId, envelope.from, envelope.to),
		{ method: "POST", headers: { "content-type": "message/rfc822" }, body },
		testEnv(email),
	);
}

async function submitOk(
	email: FakeEmail,
	mailboxId: string,
	envelope: { from: string; to: string[] },
	body: BodyInit,
): Promise<SubmitResponse> {
	const res = await submit(email, mailboxId, envelope, body);
	expect(res.status).toBe(200);
	return (await res.json()) as SubmitResponse;
}

interface SentRow {
	id: string;
	uid: number;
	message_id: string | null;
	subject: string;
	sender: string;
	recipient: string;
	bcc: string | null;
	read: number;
	raw_key: string | null;
	rfc822_size: number | null;
}

async function sentRows(stub: MailboxStub): Promise<SentRow[]> {
	return query<SentRow>(
		stub,
		`SELECT id, uid, message_id, subject, sender, recipient, bcc, read, raw_key, rfc822_size
		   FROM emails WHERE folder_id = ? ORDER BY uid`,
		Folders.SENT,
	);
}

// ── Happy path ────────────────────────────────────────────────────────

describe("submission delivers, records, and stays byte-exact", () => {
	it("sends to the envelope recipient and files a Sent copy", async () => {
		const { id, stub } = await makeMailbox("submit-happy");
		const email = fakeEmail();
		const raw = rawMessage({ from: id, messageId: "phone-happy@example.com" });

		const body = await submitOk(email, id, { from: id, to: ["recipient@example.net"] }, raw);

		expect(email.sent).toHaveLength(1);
		expect(email.sent[0].from).toBe(id);
		expect(email.sent[0].to).toBe("recipient@example.net");
		// The upstream gets the client's bytes, not a rebuild of them.
		expect(email.sent[0].raw).toBe(raw);

		// The response literals are the gateway's Go struct tags; a rename here
		// fails silently on the other side as a zero value.
		expect(body.messageId).toBe("<phone-happy@example.com>");
		expect(body.sentUid).toBe(1);
		expect(body.sentUidValidity).toBeGreaterThan(0);

		const rows = await sentRows(stub);
		expect(rows).toHaveLength(1);
		expect(rows[0].message_id).toBe("phone-happy@example.com");
		expect(rows[0].subject).toBe("From my phone");
		expect(rows[0].sender).toBe(id);
		expect(rows[0].recipient).toBe("recipient@example.net");
		// A message the user sent is read by construction.
		expect(rows[0].read).toBe(1);
		expect(rows[0].rfc822_size).toBe(new TextEncoder().encode(raw).byteLength);

		const stored = await env.BUCKET.get(rows[0].raw_key as string);
		expect(stored).not.toBeNull();
		expect(await (stored as R2ObjectBody).text()).toBe(raw);
	});

	it("round-trips through the read endpoints the gateway already uses", async () => {
		const { id } = await makeMailbox("submit-roundtrip");
		const email = fakeEmail();
		const raw = rawMessage({ from: id, subject: "Round trip", messageId: "rt@example.com" });

		const body = await submitOk(email, id, { from: id, to: ["recipient@example.net"] }, raw);

		const list = await app.request(
			`${IMAP_API_BASE}/${id}/${Folders.SENT}/messages`,
			{},
			testEnv(email),
		);
		expect(list.status).toBe(200);
		const page = (await list.json()) as {
			messages: { uid: number; envelope: { subject: string; messageId: string } }[];
		};
		expect(page.messages).toHaveLength(1);
		expect(page.messages[0].uid).toBe(body.sentUid);
		expect(page.messages[0].envelope.subject).toBe("Round trip");

		const fetched = await app.request(
			`${IMAP_API_BASE}/${id}/messages/${body.sentUid}/raw?folder=${Folders.SENT}`,
			{},
			testEnv(email),
		);
		expect(fetched.status).toBe(200);
		expect(await fetched.text()).toBe(raw);
	});

	it("lets the client's own APPENDed Sent copy deduplicate against the row", async () => {
		// The whole reason the submitted Message-ID is preserved. A client
		// submits, then APPENDs the same message into Sent; without a matching
		// id the mailbox would show it twice.
		const { id, stub } = await makeMailbox("submit-dedup");
		const email = fakeEmail();
		const raw = rawMessage({ from: id, messageId: "dedup-me@example.com" });

		const submitted = await submitOk(email, id, { from: id, to: ["recipient@example.net"] }, raw);

		const appended = await app.request(
			`${IMAP_API_BASE}/${id}/${Folders.SENT}/append?flags=${encodeURIComponent("\\Seen")}`,
			{ method: "POST", headers: { "content-type": "message/rfc822" }, body: raw },
			testEnv(email),
		);
		expect(appended.status).toBe(200);
		expect(await appended.json()).toEqual({
			uid: submitted.sentUid,
			uidValidity: submitted.sentUidValidity,
			deduplicated: true,
		});

		expect(await sentRows(stub)).toHaveLength(1);
	});
});

// ── Sender validation ─────────────────────────────────────────────────

describe("validateSender runs on both the envelope and the header", () => {
	it("refuses an envelope From that is not the mailbox", async () => {
		const { id, stub } = await makeMailbox("submit-envelope-from");
		const email = fakeEmail();

		const res = await submit(
			email,
			id,
			{ from: "someone-else@example.com", to: ["recipient@example.net"] },
			rawMessage({ from: id }),
		);

		expect(res.status).toBe(403);
		expect((await res.json()) as { error: string }).toMatchObject({
			error: expect.stringContaining("Envelope sender"),
		});
		// Refused before the body was read, let alone sent.
		expect(email.sent).toHaveLength(0);
		expect(await sentRows(stub)).toHaveLength(0);
	});

	it("refuses a From header that is not the mailbox, even with a clean envelope", async () => {
		const { id, stub } = await makeMailbox("submit-header-from");
		const email = fakeEmail();

		const res = await submit(
			email,
			id,
			{ from: id, to: ["recipient@example.net"] },
			rawMessage({ from: "spoofed@evil.example" }),
		);

		expect(res.status).toBe(403);
		expect((await res.json()) as { error: string }).toMatchObject({
			error: expect.stringContaining("From header"),
		});
		expect(email.sent).toHaveLength(0);
		expect(await sentRows(stub)).toHaveLength(0);
	});

	it("refuses a message with no From header at all", async () => {
		const { id } = await makeMailbox("submit-no-from");
		const email = fakeEmail();

		const res = await submit(
			email,
			id,
			{ from: id, to: ["recipient@example.net"] },
			"Subject: headerless\r\n\r\nbody\r\n",
		);

		expect(res.status).toBe(403);
		expect(email.sent).toHaveLength(0);
	});
});

// ── Rate limiting ─────────────────────────────────────────────────────

describe("the per-mailbox send rate limit applies", () => {
	it("returns 429 with a usable Retry-After once the hourly cap is spent", async () => {
		const { id, stub } = await makeMailbox("submit-ratelimit");
		const now = Date.now();
		for (let i = 0; i < 20; i++) {
			await stub.createEmail(
				Folders.SENT,
				{
					id: `prior-${i}`,
					subject: `Prior ${i}`,
					sender: id,
					recipient: "recipient@example.net",
					date: new Date(now - i * 1000).toISOString(),
					body: "",
				},
				[],
			);
		}

		const email = fakeEmail();
		const res = await submit(
			email,
			id,
			{ from: id, to: ["recipient@example.net"] },
			rawMessage({ from: id }),
		);

		expect(res.status).toBe(429);
		expect((await res.json()) as { error: string }).toMatchObject({
			error: expect.stringContaining("Rate limit exceeded"),
		});

		// A refusal with no interval is what makes a client retry in a hot
		// loop, so the header is the point of the test, not decoration.
		const retryAfter = Number(res.headers.get("Retry-After"));
		expect(Number.isInteger(retryAfter)).toBe(true);
		expect(retryAfter).toBeGreaterThan(0);
		expect(retryAfter).toBeLessThanOrEqual(3600);

		expect(email.sent).toHaveLength(0);
		expect(await sentRows(stub)).toHaveLength(20);
	});
});

// ── Size ──────────────────────────────────────────────────────────────

describe("oversize is refused before the upstream is touched", () => {
	it("returns 413 with the real limit and never calls the binding", async () => {
		const { id, stub } = await makeMailbox("submit-oversize");
		const email = fakeEmail();

		const filler = "x".repeat(IMAP_SUBMIT_MAX_BYTES);
		const res = await submit(
			email,
			id,
			{ from: id, to: ["recipient@example.net"] },
			rawMessage({ from: id, body: filler }),
		);

		expect(res.status).toBe(413);
		const error = ((await res.json()) as { error: string }).error;
		// A human with a stuck Outbox has to be able to act on this.
		expect(error).toContain("5 MiB");
		expect(error).toContain("attachments");

		expect(email.sent).toHaveLength(0);
		expect(await sentRows(stub)).toHaveLength(0);
	});
});

// ── Envelope vs headers ───────────────────────────────────────────────

describe("delivery follows the envelope, not the headers", () => {
	it("delivers to a Bcc'd recipient who appears in no header", async () => {
		const { id, stub } = await makeMailbox("submit-bcc");
		const email = fakeEmail();
		// The classic Bcc shape: the message names one recipient, the envelope
		// names three. Reading recipients out of the headers loses two of them.
		const raw = rawMessage({
			from: id,
			to: "visible@example.net",
			cc: "copied@example.net",
			messageId: "bcc-1@example.com",
		});

		await submitOk(
			email,
			id,
			{ from: id, to: ["visible@example.net", "copied@example.net", "blind@example.org"] },
			raw,
		);

		// Sorted: the sends go out in parallel, so arrival order is not a
		// property worth pinning. The set of recipients is.
		expect(email.sent.map((m) => m.to).sort()).toEqual([
			"blind@example.org",
			"copied@example.net",
			"visible@example.net",
		]);
		// Same bytes to every recipient, and no Bcc header invented in them.
		for (const message of email.sent) {
			expect(message.raw).toBe(raw);
			expect(message.raw).not.toContain("blind@example.org");
		}

		// The row shows what the message said, not who it actually went to:
		// the blind copy must not surface in the thread view.
		const rows = await sentRows(stub);
		expect(rows).toHaveLength(1);
		expect(rows[0].recipient).toBe("visible@example.net");
		expect(rows[0].bcc).toBeNull();
	});
});

// ── Upstream failure ──────────────────────────────────────────────────

describe("an upstream failure is a 502 and leaves no trace", () => {
	it("records no Sent row and stores no raw object", async () => {
		const { id, stub } = await makeMailbox("submit-upstream-fail");
		const email = fakeEmail(() => true);

		const res = await submit(
			email,
			id,
			{ from: id, to: ["recipient@example.net"] },
			rawMessage({ from: id }),
		);

		expect(res.status).toBe(502);
		const error = ((await res.json()) as { error: string }).error;
		// Enough to diagnose: the upstream's own refusal text comes through.
		expect(error).toContain("550 5.1.1");

		// A Sent row for a message that never left is worse than no row — it is
		// what the user reads to decide whether to send again, and it counts
		// against the rate limit.
		expect(await sentRows(stub)).toHaveLength(0);
		expect((await env.BUCKET.list({ prefix: `raw/${id}/` })).objects).toHaveLength(0);
	});

	it("still records the copy when only some recipients fail", async () => {
		const { id, stub } = await makeMailbox("submit-partial");
		const email = fakeEmail((to) => to === "bad@example.org");

		const body = await submitOk(
			email,
			id,
			{ from: id, to: ["good@example.net", "bad@example.org"] },
			rawMessage({ from: id }),
		);

		// The message left for someone, so re-submitting it would double-deliver.
		expect(body.sentUid).toBe(1);
		expect(body.failedRecipients).toEqual(["bad@example.org"]);
		expect(await sentRows(stub)).toHaveLength(1);
	});
});

// ── Message-ID ────────────────────────────────────────────────────────

describe("Message-ID handling", () => {
	it("generates and inserts one when the client sent none", async () => {
		const { id, stub } = await makeMailbox("submit-no-msgid");
		const email = fakeEmail();
		const raw = rawMessage({ from: id, messageId: null });

		const body = await submitOk(email, id, { from: id, to: ["recipient@example.net"] }, raw);

		expect(body.messageId).toMatch(/^<[^<>@]+@example\.com>$/);
		const bare = body.messageId.slice(1, -1);

		// Reported, sent and stored must all agree, which is why the header is
		// inserted into the bytes rather than only recorded on the row.
		expect(email.sent[0].raw).toBe(`Message-ID: <${bare}>\r\n${raw}`);
		const rows = await sentRows(stub);
		expect(rows[0].message_id).toBe(bare);
		const stored = await env.BUCKET.get(rows[0].raw_key as string);
		expect(await (stored as R2ObjectBody).text()).toBe(`Message-ID: <${bare}>\r\n${raw}`);
	});
});

// ── Request envelope ──────────────────────────────────────────────────

describe("malformed requests", () => {
	it("404s an unknown mailbox", async () => {
		const email = fakeEmail();
		const res = await submit(
			email,
			"nobody@example.com",
			{ from: "nobody@example.com", to: ["recipient@example.net"] },
			rawMessage({ from: "nobody@example.com" }),
		);
		expect(res.status).toBe(404);
		expect(email.sent).toHaveLength(0);
	});

	it("400s when the envelope is missing", async () => {
		const { id } = await makeMailbox("submit-no-envelope");
		const email = fakeEmail();

		const noRecipients = await submit(email, id, { from: id, to: [] }, rawMessage({ from: id }));
		expect(noRecipients.status).toBe(400);

		const noSender = await submit(
			email,
			id,
			{ from: "", to: ["recipient@example.net"] },
			rawMessage({ from: id }),
		);
		expect(noSender.status).toBe(400);

		expect(email.sent).toHaveLength(0);
	});

	it("400s an empty body", async () => {
		const { id } = await makeMailbox("submit-empty");
		const email = fakeEmail();
		const res = await submit(email, id, { from: id, to: ["recipient@example.net"] }, "");
		expect(res.status).toBe(400);
		expect(email.sent).toHaveLength(0);
	});
});
