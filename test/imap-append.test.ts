// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * APPEND, the last routine IMAP command the gateway still refused (DEV-672):
 *
 *   POST /api/imap/v1/{mailbox}/{folder}/append
 *
 * iOS Mail APPENDs to save a draft; nearly every client APPENDs a copy of what
 * it just submitted into Sent. ID, STORE and EXPUNGE each proved that a `NO`
 * on a routine command is not a degraded experience but an infinite reconnect
 * loop, so a good half of what follows asserts what must NOT fail: an unknown
 * flag, a malformed internalDate, a message with no Message-ID.
 *
 * Two properties carry most of the weight:
 *
 *   - **The stored bytes are the client's bytes.** This is the only path in
 *     the app where the `.eml` is byte-exact by construction rather than by
 *     reconstruction, so it is asserted directly against R2 and again through
 *     the `/raw` round trip.
 *   - **Message-ID deduplicates in `sent`, and only there.** The Sent copy a
 *     client appends is the message the app already recorded on its own send
 *     path; without dedup every sent message would show up twice. Applying the
 *     same rule to `draft` would be silent data loss, because that is exactly
 *     how a client saves an edit to a draft — same Message-ID, new body.
 *
 * `uid` / `uidValidity` / `deduplicated` are literal: they are the Go struct
 * tags on the gateway side, where a rename fails silently as a zero value.
 */

import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { IMAP_API_BASE, IMAP_APPEND_MAX_BYTES, type ImapApiEnv, imapApi } from "../workers/routes/imap-api";
import { type MailboxStub, exec, folderUidNext, mailbox, query } from "./helpers";

const app = new Hono<{ Bindings: ImapApiEnv }>().route(IMAP_API_BASE, imapApi);

let n = 0;
/** Distinct mailbox per test: Durable Object storage is keyed by this name. */
async function makeMailbox(prefix: string): Promise<{ id: string; stub: MailboxStub }> {
	n += 1;
	const id = `${prefix}-${n}@example.com`;
	await env.BUCKET.put(`mailboxes/${id}.json`, JSON.stringify({ fromName: "Test" }));
	return { id, stub: mailbox(id) };
}

/**
 * A small, valid RFC 5322 message. CRLF line endings throughout — the single
 * most common way a hand-written test message stops being a real one.
 */
function rawMessage(
	options: {
		messageId?: string | null;
		subject?: string;
		from?: string;
		to?: string;
		cc?: string;
		date?: string;
		body?: string;
		inReplyTo?: string;
		references?: string;
	} = {},
): string {
	const headers: string[] = [
		`From: ${options.from ?? "Ada Lovelace <ada@example.com>"}`,
		`To: ${options.to ?? "bob@example.net"}`,
	];
	if (options.cc) headers.push(`Cc: ${options.cc}`);
	headers.push(`Subject: ${options.subject ?? "Hello there"}`);
	headers.push(`Date: ${options.date ?? "Wed, 12 Mar 2026 09:14:00 +0000"}`);
	if (options.messageId !== null) {
		headers.push(`Message-ID: <${options.messageId ?? "abc123@example.com"}>`);
	}
	if (options.inReplyTo) headers.push(`In-Reply-To: <${options.inReplyTo}>`);
	if (options.references) headers.push(`References: ${options.references}`);
	headers.push("MIME-Version: 1.0");
	headers.push('Content-Type: text/plain; charset="utf-8"');
	return `${headers.join("\r\n")}\r\n\r\n${options.body ?? "Body text.\r\n"}`;
}

interface AppendResponse {
	uid: number;
	uidValidity: number;
	deduplicated: boolean;
}

function appendUrl(
	mailboxId: string,
	folder: string,
	params: { flags?: string; internalDate?: string } = {},
): string {
	const search = new URLSearchParams();
	if (params.flags !== undefined) search.set("flags", params.flags);
	if (params.internalDate !== undefined) search.set("internalDate", params.internalDate);
	const qs = search.toString();
	return `${IMAP_API_BASE}/${mailboxId}/${folder}/append${qs ? `?${qs}` : ""}`;
}

async function append(
	mailboxId: string,
	folder: string,
	body: BodyInit,
	params: { flags?: string; internalDate?: string; contentLength?: string } = {},
): Promise<Response> {
	const headers: Record<string, string> = { "content-type": "message/rfc822" };
	if (params.contentLength !== undefined) headers["content-length"] = params.contentLength;
	return app.request(appendUrl(mailboxId, folder, params), { method: "POST", headers, body }, env);
}

async function appendOk(
	mailboxId: string,
	folder: string,
	body: BodyInit,
	params: { flags?: string; internalDate?: string } = {},
): Promise<AppendResponse> {
	const res = await append(mailboxId, folder, body, params);
	expect(res.status).toBe(200);
	return (await res.json()) as AppendResponse;
}

interface ListedMessage {
	uid: number;
	flags: string[];
	internalDate: string;
	rfc822Size: number;
	hasRaw: boolean;
	envelope: {
		subject: string;
		from: { name: string; address: string }[];
		to: { name: string; address: string }[];
		cc: { name: string; address: string }[];
		messageId: string;
		inReplyTo: string;
		date: string;
	};
}

/** The folder as the gateway sees it, through the endpoint FETCH actually uses. */
async function listMessages(mailboxId: string, folder: string): Promise<ListedMessage[]> {
	const res = await app.request(`${IMAP_API_BASE}/${mailboxId}/${folder}/messages`, {}, env);
	expect(res.status).toBe(200);
	return ((await res.json()) as { messages: ListedMessage[] }).messages;
}

async function fetchRaw(mailboxId: string, folder: string, uid: number): Promise<Uint8Array> {
	const res = await app.request(
		`${IMAP_API_BASE}/${mailboxId}/messages/${uid}/raw?folder=${folder}`,
		{},
		env,
	);
	expect(res.status).toBe(200);
	return new Uint8Array(await res.arrayBuffer());
}

async function rowCount(stub: MailboxStub, folderId: string): Promise<number> {
	const rows = await query<{ cnt: number }>(
		stub,
		`SELECT COUNT(*) AS cnt FROM emails WHERE folder_id = ?1`,
		folderId,
	);
	return Number(rows[0].cnt);
}

async function storedKeys(stub: MailboxStub): Promise<(string | null)[]> {
	const rows = await query<{ raw_key: string | null }>(
		stub,
		`SELECT raw_key FROM emails ORDER BY uid`,
	);
	return rows.map((r) => r.raw_key);
}

describe("APPEND: the message lands", () => {
	it("creates a message the metadata endpoint reports with the right envelope", async () => {
		const { id } = await makeMailbox("append-envelope");
		const raw = rawMessage({
			subject: "Quarterly numbers",
			from: "Ada Lovelace <ada@example.com>",
			to: "bob@example.net",
			cc: "carol@example.org",
			messageId: "q3-numbers@example.com",
			inReplyTo: "parent@example.com",
			date: "Wed, 12 Mar 2026 09:14:00 +0000",
		});

		const result = await appendOk(id, "inbox", raw);
		expect(result.deduplicated).toBe(false);

		const messages = await listMessages(id, "inbox");
		expect(messages).toHaveLength(1);
		const message = messages[0];

		expect(message.uid).toBe(result.uid);
		expect(message.envelope.subject).toBe("Quarterly numbers");
		expect(message.envelope.from).toEqual([{ name: "Ada Lovelace", address: "ada@example.com" }]);
		expect(message.envelope.to[0].address).toBe("bob@example.net");
		expect(message.envelope.cc[0].address).toBe("carol@example.org");
		expect(message.envelope.messageId).toBe("q3-numbers@example.com");
		expect(message.envelope.inReplyTo).toBe("parent@example.com");
		// The envelope date is the message's own Date: header, not the
		// internal date, and comes out of the stored raw_headers.
		expect(message.envelope.date).toBe("Wed, 12 Mar 2026 09:14:00 +0000");
	});

	it("reports the exact byte length as RFC822.SIZE and claims stored bytes", async () => {
		const { id } = await makeMailbox("append-size");
		const raw = rawMessage({ body: "x".repeat(500) });
		const expected = new TextEncoder().encode(raw).byteLength;

		await appendOk(id, "inbox", raw);

		const [message] = await listMessages(id, "inbox");
		expect(message.rfc822Size).toBe(expected);
		expect(message.hasRaw).toBe(true);
	});

	it("reports the uidValidity of the destination folder", async () => {
		const { id, stub } = await makeMailbox("append-uidvalidity");
		const rows = await query<{ uid_validity: number }>(
			stub,
			`SELECT uid_validity FROM folders WHERE id = 'inbox'`,
		);

		const result = await appendOk(id, "inbox", rawMessage());
		expect(result.uidValidity).toBe(Number(rows[0].uid_validity));
	});

	it("stores the raw bytes byte-for-byte, not a rebuild of them", async () => {
		const { id, stub } = await makeMailbox("append-bytes");
		// Deliberately awkward: an unusual header order, a non-ASCII body, and
		// a trailing blank line. A parse-and-rebuild round trip loses all of it.
		const raw =
			"X-Weird-Header: kept\r\n" +
			"From: Ada <ada@example.com>\r\n" +
			"Subject: =?UTF-8?B?w6nDqcOp?=\r\n" +
			"To: bob@example.net\r\n" +
			"Message-ID: <verbatim@example.com>\r\n" +
			"MIME-Version: 1.0\r\n" +
			'Content-Type: text/plain; charset="utf-8"\r\n' +
			"\r\n" +
			"Ünïcödé body with trailing space \r\n" +
			"\r\n";
		const sent = new TextEncoder().encode(raw);

		await appendOk(id, "inbox", sent);

		const keys = await storedKeys(stub);
		expect(keys).toHaveLength(1);
		const key = keys[0];
		expect(key).not.toBeNull();

		const object = await env.BUCKET.get(key as string);
		expect(object).not.toBeNull();
		const stored = new Uint8Array(await (object as R2ObjectBody).arrayBuffer());
		expect(stored).toEqual(sent);
	});

	it("round trips: what /raw hands back is what was appended", async () => {
		const { id } = await makeMailbox("append-roundtrip");
		const raw = rawMessage({ subject: "Round trip", body: "Line one.\r\nLine two.\r\n" });
		const sent = new TextEncoder().encode(raw);

		const result = await appendOk(id, "inbox", sent);
		const fetched = await fetchRaw(id, "inbox", result.uid);

		expect(fetched).toEqual(sent);
	});
});

describe("APPEND: uid allocation", () => {
	it("allocates from the target folder and advances its uid_next", async () => {
		const { id, stub } = await makeMailbox("append-uid");
		expect(await folderUidNext(stub, "inbox")).toBe(1);

		const first = await appendOk(id, "inbox", rawMessage({ messageId: "one@example.com" }));
		expect(first.uid).toBe(1);
		expect(await folderUidNext(stub, "inbox")).toBe(2);

		const second = await appendOk(id, "inbox", rawMessage({ messageId: "two@example.com" }));
		expect(second.uid).toBe(2);
		expect(await folderUidNext(stub, "inbox")).toBe(3);
	});

	it("runs a separate uid sequence per folder", async () => {
		const { id, stub } = await makeMailbox("append-per-folder");

		const inbox = await appendOk(id, "inbox", rawMessage({ messageId: "in@example.com" }));
		const draft = await appendOk(id, "draft", rawMessage({ messageId: "dr@example.com" }));

		expect(inbox.uid).toBe(1);
		expect(draft.uid).toBe(1);
		expect(await folderUidNext(stub, "inbox")).toBe(2);
		expect(await folderUidNext(stub, "draft")).toBe(2);
	});

	it("accepts the folder's display name as well as its id", async () => {
		// The gateway sends the id, but #imapFolderRow is tolerant and the
		// other endpoints are too; APPEND must not be the odd one out.
		const { id, stub } = await makeMailbox("append-folder-name");

		await appendOk(id, "Drafts", rawMessage());

		expect(await rowCount(stub, "draft")).toBe(1);
	});
});

describe("APPEND: flags", () => {
	it("applies the supplied flags", async () => {
		const { id } = await makeMailbox("append-flags");
		await appendOk(id, "inbox", rawMessage(), { flags: "\\Seen,\\Flagged,\\Answered" });

		const [message] = await listMessages(id, "inbox");
		expect(message.flags).toEqual(["\\Seen", "\\Answered", "\\Flagged"]);
	});

	it("keeps a custom keyword", async () => {
		const { id } = await makeMailbox("append-keyword");
		await appendOk(id, "inbox", rawMessage(), { flags: "\\Seen,$Important" });

		const [message] = await listMessages(id, "inbox");
		expect(message.flags).toEqual(["\\Seen", "$Important"]);
	});

	it("ignores \\Recent instead of failing, and does not store it as a keyword", async () => {
		const { id } = await makeMailbox("append-recent");
		const res = await append(id, "inbox", rawMessage(), { flags: "\\Recent,\\Seen" });
		expect(res.status).toBe(200);

		const [message] = await listMessages(id, "inbox");
		expect(message.flags).toEqual(["\\Seen"]);
	});

	it("ignores \\Draft, which is derived from the folder", async () => {
		const { id } = await makeMailbox("append-draft-flag");
		await appendOk(id, "draft", rawMessage(), { flags: "\\Draft,\\Seen" });

		const [message] = await listMessages(id, "draft");
		// \Draft is present because the folder is Drafts, not because it was sent.
		expect(message.flags).toEqual(["\\Seen", "\\Draft"]);
	});

	it("treats flag atoms case insensitively, as IMAP does", async () => {
		const { id } = await makeMailbox("append-flag-case");
		await appendOk(id, "inbox", rawMessage(), { flags: "\\SEEN" });

		const [message] = await listMessages(id, "inbox");
		expect(message.flags).toEqual(["\\Seen"]);
	});

	it("appends unflagged when no flags are supplied", async () => {
		const { id } = await makeMailbox("append-no-flags");
		await appendOk(id, "inbox", rawMessage());

		const [message] = await listMessages(id, "inbox");
		expect(message.flags).toEqual([]);
	});

	it("marks a Sent copy read even when the client omitted \\Seen", async () => {
		// The app's own invariant: a message in Sent is read by construction,
		// or every thread's unread count is wrong.
		const { id } = await makeMailbox("append-sent-read");
		await appendOk(id, "sent", rawMessage());

		const [message] = await listMessages(id, "sent");
		expect(message.flags).toEqual(["\\Seen"]);
	});
});

describe("APPEND: internalDate", () => {
	it("honours a supplied internalDate", async () => {
		const { id } = await makeMailbox("append-internaldate");
		await appendOk(id, "inbox", rawMessage(), { internalDate: "2026-08-22T22:05:03Z" });

		const [message] = await listMessages(id, "inbox");
		expect(message.internalDate).toBe("2026-08-22T22:05:03.000Z");
	});

	it("defaults to receive time when absent, not to the Date header", async () => {
		const { id } = await makeMailbox("append-internaldate-default");
		const before = Date.now();
		await appendOk(id, "inbox", rawMessage({ date: "Wed, 12 Mar 2020 09:14:00 +0000" }));
		const after = Date.now();

		const [message] = await listMessages(id, "inbox");
		const internal = new Date(message.internalDate).getTime();
		expect(internal).toBeGreaterThanOrEqual(before - 1000);
		expect(internal).toBeLessThanOrEqual(after + 1000);
		// The envelope still carries the message's own, much older, Date header.
		expect(message.envelope.date).toBe("Wed, 12 Mar 2020 09:14:00 +0000");
	});

	it("falls back to receive time on an unparseable internalDate rather than refusing", async () => {
		const { id } = await makeMailbox("append-internaldate-junk");
		const res = await append(id, "inbox", rawMessage(), { internalDate: "not-a-date" });
		expect(res.status).toBe(200);

		const [message] = await listMessages(id, "inbox");
		expect(Number.isNaN(new Date(message.internalDate).getTime())).toBe(false);
	});
});

describe("APPEND: deduplication by Message-ID", () => {
	it("returns the existing uid and writes nothing on a repeat", async () => {
		const { id, stub } = await makeMailbox("append-dedup");
		const raw = rawMessage({ messageId: "sent-copy@example.com", subject: "Sent copy" });

		const first = await appendOk(id, "sent", raw);
		expect(first.deduplicated).toBe(false);

		const second = await appendOk(id, "sent", raw);
		expect(second.deduplicated).toBe(true);
		expect(second.uid).toBe(first.uid);
		expect(second.uidValidity).toBe(first.uidValidity);

		expect(await rowCount(stub, "sent")).toBe(1);
		expect(await listMessages(id, "sent")).toHaveLength(1);
	});

	it("does not burn a uid on the deduplicated append", async () => {
		const { id, stub } = await makeMailbox("append-dedup-uid");
		const raw = rawMessage({ messageId: "steady@example.com" });

		await appendOk(id, "sent", raw);
		expect(await folderUidNext(stub, "sent")).toBe(2);

		await appendOk(id, "sent", raw);
		expect(await folderUidNext(stub, "sent")).toBe(2);
	});

	it("dedups within a folder only, never across the mailbox", async () => {
		const { id, stub } = await makeMailbox("append-dedup-scope");
		const raw = rawMessage({ messageId: "same-id@example.com" });

		const sent = await appendOk(id, "sent", raw);
		const inbox = await appendOk(id, "inbox", raw);

		expect(sent.deduplicated).toBe(false);
		expect(inbox.deduplicated).toBe(false);
		expect(await rowCount(stub, "sent")).toBe(1);
		expect(await rowCount(stub, "inbox")).toBe(1);
	});

	it("applies the second append's flags to the message it deduplicated onto", async () => {
		// A client saving its Sent copy with \Flagged against a row the app
		// already recorded must not have that silently dropped on the floor.
		const { id } = await makeMailbox("append-dedup-flags");
		const raw = rawMessage({ messageId: "flag-me@example.com" });

		const first = await appendOk(id, "sent", raw);
		expect((await listMessages(id, "sent"))[0].flags).toEqual(["\\Seen"]);

		const second = await appendOk(id, "sent", raw, { flags: "\\Flagged,$Later" });
		expect(second.deduplicated).toBe(true);
		expect(second.uid).toBe(first.uid);

		const [message] = await listMessages(id, "sent");
		expect(message.flags).toEqual(["\\Seen", "\\Flagged", "$Later"]);
	});

	it("marks an already-recorded Sent copy read when the client appends it \\Seen", async () => {
		// The app records a sent row read, so seed the unread case directly:
		// a message the app put somewhere else and a client then syncs.
		const { id, stub } = await makeMailbox("append-dedup-seen");
		const raw = rawMessage({ messageId: "unread-copy@example.com" });

		await appendOk(id, "sent", raw);
		await exec(stub, `UPDATE emails SET read = 0 WHERE folder_id = 'sent'`);
		expect((await listMessages(id, "sent"))[0].flags).toEqual([]);

		const second = await appendOk(id, "sent", raw, { flags: "\\Seen" });
		expect(second.deduplicated).toBe(true);
		expect((await listMessages(id, "sent"))[0].flags).toEqual(["\\Seen"]);
	});

	it("never dedups in draft: a re-APPENDed draft is a new row with the new body", async () => {
		// This is the data-loss case the Sent-only rule exists for. Clients
		// edit a draft by re-APPENDing it with the SAME Message-ID and then
		// expunging the old copy. Dedup here would return the original uid
		// without writing the edit, and the client would then expunge the copy
		// it believed it had just replaced.
		const { id, stub } = await makeMailbox("append-draft-edit");
		const first = await appendOk(
			id,
			"draft",
			rawMessage({ messageId: "wip@example.com", body: "First attempt.\r\n" }),
		);

		const edited = rawMessage({ messageId: "wip@example.com", body: "Second attempt, better.\r\n" });
		const second = await appendOk(id, "draft", edited);

		expect(second.deduplicated).toBe(false);
		expect(second.uid).not.toBe(first.uid);
		expect(await rowCount(stub, "draft")).toBe(2);

		// And the new uid serves the bytes that were actually posted.
		expect(await fetchRaw(id, "draft", second.uid)).toEqual(new TextEncoder().encode(edited));
	});

	it("never dedups in inbox either", async () => {
		const { id, stub } = await makeMailbox("append-inbox-nodedup");
		const raw = rawMessage({ messageId: "twice@example.com" });

		const first = await appendOk(id, "inbox", raw);
		const second = await appendOk(id, "inbox", raw);

		expect(second.deduplicated).toBe(false);
		expect(second.uid).not.toBe(first.uid);
		expect(await rowCount(stub, "inbox")).toBe(2);
	});

	it("appends twice as two rows when the message carries no Message-ID", async () => {
		// In `sent`, where dedup does apply, so this proves the missing id is
		// what stops it rather than the folder.
		const { id, stub } = await makeMailbox("append-no-msgid");
		const raw = rawMessage({ messageId: null });

		const first = await appendOk(id, "sent", raw);
		const second = await appendOk(id, "sent", raw);

		expect(first.deduplicated).toBe(false);
		expect(second.deduplicated).toBe(false);
		expect(second.uid).not.toBe(first.uid);
		expect(await rowCount(stub, "sent")).toBe(2);
	});

	it("leaves no orphaned R2 object behind when it deduplicates", async () => {
		const { id, stub } = await makeMailbox("append-dedup-r2");
		const raw = rawMessage({ messageId: "no-litter@example.com" });

		await appendOk(id, "sent", raw);
		await appendOk(id, "sent", raw);

		const listed = await env.BUCKET.list({ prefix: `raw/${id}/` });
		expect(listed.objects).toHaveLength(1);
		// And the one that survived is the one the surviving row points at.
		expect(await storedKeys(stub)).toEqual([listed.objects[0].key]);
	});
});

describe("APPEND: rejections", () => {
	it("404s an unknown folder without saying anything about the mailbox", async () => {
		const { id, stub } = await makeMailbox("append-bad-folder");
		const res = await append(id, "no-such-folder", rawMessage());

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Folder not found" });
		expect(await rowCount(stub, "inbox")).toBe(0);
		expect((await env.BUCKET.list({ prefix: `raw/${id}/` })).objects).toHaveLength(0);
	});

	it("404s an unknown mailbox", async () => {
		const res = await append("nobody@example.com", "inbox", rawMessage());
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Not found" });
	});

	it("413s a body past the size cap, from the declared length alone", async () => {
		const { id, stub } = await makeMailbox("append-too-large-declared");
		const res = await append(id, "inbox", rawMessage(), {
			contentLength: String(IMAP_APPEND_MAX_BYTES + 1),
		});

		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: "Message too large" });
		expect(await rowCount(stub, "inbox")).toBe(0);
	});

	it("413s a body past the size cap when the length was never declared", async () => {
		const { id, stub } = await makeMailbox("append-too-large-streamed");
		// A stream with no Content-Length: the cap has to hold against bytes
		// actually received, not against what the client claimed.
		const oversize = IMAP_APPEND_MAX_BYTES + 1024;
		const chunk = new Uint8Array(64 * 1024);
		let remaining = oversize;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (remaining <= 0) {
					controller.close();
					return;
				}
				const size = Math.min(chunk.byteLength, remaining);
				remaining -= size;
				controller.enqueue(chunk.subarray(0, size));
			},
		});

		const res = await app.request(
			appendUrl(id, "inbox"),
			{ method: "POST", headers: { "content-type": "message/rfc822" }, body, duplex: "half" } as RequestInit,
			env,
		);

		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: "Message too large" });
		expect(await rowCount(stub, "inbox")).toBe(0);
		expect((await env.BUCKET.list({ prefix: `raw/${id}/` })).objects).toHaveLength(0);
	});

	it("400s an empty body", async () => {
		const { id } = await makeMailbox("append-empty");
		const res = await append(id, "inbox", "");

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Empty message" });
	});
});

describe("APPEND: hostile and degenerate input", () => {
	it("stores a message with no headers at all rather than refusing it", async () => {
		const { id, stub } = await makeMailbox("append-headerless");
		const sent = new TextEncoder().encode("just some bytes, not really a message");

		const result = await appendOk(id, "inbox", sent);
		expect(result.deduplicated).toBe(false);

		// No Message-ID to dedup on, but the bytes are kept verbatim.
		expect(await fetchRaw(id, "inbox", result.uid)).toEqual(sent);
		expect(await rowCount(stub, "inbox")).toBe(1);
	});

	it("accepts a message right at the size cap", async () => {
		// One byte under is not the interesting case; the boundary is.
		const { id } = await makeMailbox("append-at-cap");
		const header = "From: a@example.com\r\nTo: b@example.net\r\nSubject: Big\r\n\r\n";
		const padding = "y".repeat(IMAP_APPEND_MAX_BYTES - header.length);
		const sent = new TextEncoder().encode(header + padding);
		expect(sent.byteLength).toBe(IMAP_APPEND_MAX_BYTES);

		const result = await appendOk(id, "inbox", sent);
		const [message] = await listMessages(id, "inbox");
		expect(message.uid).toBe(result.uid);
		expect(message.rfc822Size).toBe(IMAP_APPEND_MAX_BYTES);
	});

	it("drops an absurdly long flag atom without failing the append", async () => {
		const { id } = await makeMailbox("append-long-flag");
		const res = await append(id, "inbox", rawMessage(), {
			flags: `\\Seen,${"k".repeat(500)}`,
		});
		expect(res.status).toBe(200);

		const [message] = await listMessages(id, "inbox");
		expect(message.flags).toEqual(["\\Seen"]);
	});
});
