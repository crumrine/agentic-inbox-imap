// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The read surface the Go IMAP gateway consumes:
 *
 *   GET /api/imap/v1/{mailbox}/folders
 *   GET /api/imap/v1/{mailbox}/{folder}/messages?sinceUid=&limit=
 *   GET /api/imap/v1/{mailbox}/messages/{uid}/raw?folder={folder}
 *
 * The assertions here are deliberately literal about JSON field names. They
 * are the Go struct tags in gateway/internal/backend/types.go, and a rename on
 * this side does not fail loudly on that side — encoding/json just leaves the
 * field zero — so the names are pinned here instead.
 */

import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { IMAP_MESSAGES_MAX_LIMIT } from "../workers/durableObject";
import { IMAP_API_BASE, type ImapApiEnv, imapApi } from "../workers/routes/imap-api";
import { type MailboxStub, exec, mailbox } from "./helpers";

const app = new Hono<{ Bindings: ImapApiEnv }>().route(IMAP_API_BASE, imapApi);

let n = 0;
/** Distinct mailbox per test: Durable Object storage is keyed by this name. */
function uniqueMailbox(prefix: string): string {
	n += 1;
	return `${prefix}-${n}@example.com`;
}

async function makeMailbox(prefix: string): Promise<{ id: string; stub: MailboxStub }> {
	const id = uniqueMailbox(prefix);
	await env.BUCKET.put(`mailboxes/${id}.json`, JSON.stringify({ fromName: "Test" }));
	return { id, stub: mailbox(id) };
}

interface SeedEmail {
	id: string;
	folder: string;
	uid: number;
	date?: string;
	subject?: string;
	sender?: string;
	recipient?: string;
	cc?: string | null;
	bcc?: string | null;
	body?: string;
	read?: 0 | 1;
	starred?: 0 | 1;
	answered?: 0 | 1;
	deleted?: 0 | 1;
	flags?: string | null;
	messageId?: string | null;
	inReplyTo?: string | null;
	rawHeaders?: string | null;
	rawKey?: string | null;
	rfc822Size?: number | null;
}

/**
 * Insert straight into SQLite rather than going through createEmail, so a test
 * can pin the exact uid, flag columns and raw_key it needs — including the
 * legacy shapes createEmail can no longer produce.
 */
async function seed(stub: MailboxStub, email: SeedEmail): Promise<void> {
	await exec(
		stub,
		`INSERT INTO emails (
			id, folder_id, subject, sender, recipient, cc, bcc, date, read, starred,
			body, in_reply_to, message_id, raw_headers, uid, answered, deleted, flags,
			rfc822_size, raw_key
		) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)`,
		email.id,
		email.folder,
		email.subject ?? `Subject ${email.id}`,
		email.sender ?? "sender@example.com",
		email.recipient ?? "recipient@example.com",
		email.cc ?? null,
		email.bcc ?? null,
		email.date ?? "2026-03-01T10:00:00.000Z",
		email.read ?? 0,
		email.starred ?? 0,
		email.body ?? `Body ${email.id}`,
		email.inReplyTo ?? null,
		email.messageId ?? null,
		email.rawHeaders ?? null,
		email.uid,
		email.answered ?? 0,
		email.deleted ?? 0,
		email.flags ?? null,
		email.rfc822Size ?? null,
		email.rawKey ?? null,
	);
}

/** Keep folders.uid_next honest after direct inserts. */
async function bumpUidNext(stub: MailboxStub, folder: string, uidNext: number): Promise<void> {
	await exec(stub, `UPDATE folders SET uid_next = ?2 WHERE id = ?1`, folder, uidNext);
}

function headersJson(pairs: [string, string][]): string {
	return JSON.stringify(pairs.map(([key, value]) => ({ key, value })));
}

async function get(path: string, bindings: ImapApiEnv = env): Promise<Response> {
	return app.request(`${IMAP_API_BASE}${path}`, {}, bindings);
}

interface WireFolder {
	id: string;
	name: string;
	uidValidity: number;
	uidNext: number;
	exists: number;
	unseen: number;
	recent: number;
}

interface WireMessage {
	uid: number;
	flags: string[];
	internalDate: string;
	rfc822Size: number;
	envelope: {
		subject: string;
		from: { name: string; address: string }[];
		to: { name: string; address: string }[];
		cc: { name: string; address: string }[];
		messageId: string;
		inReplyTo: string;
		date: string;
	};
	hasRaw: boolean;
}

interface WirePage {
	messages: WireMessage[];
	uidNext: number;
}

// ── Folders ───────────────────────────────────────────────────────────

describe("GET /{mailbox}/folders", () => {
	it("returns per-folder counts from SQL aggregates", async () => {
		const { id, stub } = await makeMailbox("folders");
		await seed(stub, { id: "a", folder: "inbox", uid: 1, read: 1 });
		await seed(stub, { id: "b", folder: "inbox", uid: 2, read: 0 });
		await seed(stub, { id: "c", folder: "inbox", uid: 3, read: 0 });
		await seed(stub, { id: "d", folder: "sent", uid: 1, read: 1 });
		await bumpUidNext(stub, "inbox", 4);
		await bumpUidNext(stub, "sent", 2);

		const res = await get(`/${id}/folders`);
		expect(res.status).toBe(200);

		const folders = (await res.json()) as WireFolder[];
		const inbox = folders.find((f) => f.id === "inbox")!;
		expect(inbox.exists).toBe(3);
		expect(inbox.unseen).toBe(2);
		expect(inbox.uidNext).toBe(4);
		expect(inbox.uidValidity).toBeGreaterThan(0);

		const sent = folders.find((f) => f.id === "sent")!;
		expect(sent.exists).toBe(1);
		expect(sent.unseen).toBe(0);
		expect(sent.uidNext).toBe(2);

		// Empty folders still appear, with zeroed counts.
		const archive = folders.find((f) => f.id === "archive")!;
		expect(archive.exists).toBe(0);
		expect(archive.unseen).toBe(0);
		expect(archive.uidNext).toBe(1);
	});

	it("returns id and name as separate fields, with the slug in id", async () => {
		const { id, stub } = await makeMailbox("folder-ids");
		await seed(stub, { id: "a", folder: "inbox", uid: 1 });

		const folders = (await (await get(`/${id}/folders`)).json()) as WireFolder[];
		const byId = new Map(folders.map((f) => [f.id, f]));

		expect(byId.get("inbox")!.name).toBe("Inbox");
		expect(byId.get("sent")!.name).toBe("Sent");
		expect(byId.get("draft")!.name).toBe("Drafts");
		// The two are genuinely different strings; the gateway routes on id and
		// advertises name over LIST.
		expect(byId.get("inbox")!.id).not.toBe(byId.get("inbox")!.name);
		expect([...byId.keys()].sort()).toEqual([
			"archive",
			"draft",
			"inbox",
			"sent",
			"spam",
			"trash",
		]);
	});

	it("reports recent as 0, matching the gateway's own NumRecent", async () => {
		const { id, stub } = await makeMailbox("folder-recent");
		await seed(stub, { id: "a", folder: "inbox", uid: 1, read: 0 });

		const folders = (await (await get(`/${id}/folders`)).json()) as WireFolder[];
		expect(folders.every((f) => f.recent === 0)).toBe(true);
	});

	it("404s for an unknown mailbox without saying why", async () => {
		const res = await get(`/nobody@example.com/folders`);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Not found" });
	});
});

// ── Message metadata ──────────────────────────────────────────────────

describe("GET /{mailbox}/{folder}/messages", () => {
	it("keys the folder path segment on the folder id", async () => {
		const { id, stub } = await makeMailbox("folder-key");
		await seed(stub, { id: "a", folder: "inbox", uid: 7 });
		await bumpUidNext(stub, "inbox", 8);

		const page = (await (await get(`/${id}/inbox/messages`)).json()) as WirePage;
		expect(page.messages.map((m) => m.uid)).toEqual([7]);
		expect(page.uidNext).toBe(8);

		// The display name is tolerated too, but the id is the documented form.
		const byName = (await (await get(`/${id}/Inbox/messages`)).json()) as WirePage;
		expect(byName.messages.map((m) => m.uid)).toEqual([7]);
	});

	it("derives every system flag and carries custom keywords through", async () => {
		const { id, stub } = await makeMailbox("flags");
		await seed(stub, { id: "plain", folder: "inbox", uid: 1 });
		await seed(stub, { id: "seen", folder: "inbox", uid: 2, read: 1 });
		await seed(stub, { id: "flagged", folder: "inbox", uid: 3, starred: 1 });
		await seed(stub, { id: "answered", folder: "inbox", uid: 4, answered: 1 });
		await seed(stub, { id: "deleted", folder: "inbox", uid: 5, deleted: 1 });
		await seed(stub, {
			id: "keywords",
			folder: "inbox",
			uid: 6,
			read: 1,
			starred: 1,
			answered: 1,
			deleted: 1,
			// "\\Seen" here is already derived from the read column: it must not
			// appear twice.
			flags: JSON.stringify(["$Important", "\\Seen", "NonJunk"]),
		});
		await seed(stub, { id: "draft", folder: "draft", uid: 1 });

		const page = (await (await get(`/${id}/inbox/messages`)).json()) as WirePage;
		const flagsByUid = new Map(page.messages.map((m) => [m.uid, m.flags]));

		expect(flagsByUid.get(1)).toEqual([]);
		expect(flagsByUid.get(2)).toEqual(["\\Seen"]);
		expect(flagsByUid.get(3)).toEqual(["\\Flagged"]);
		expect(flagsByUid.get(4)).toEqual(["\\Answered"]);
		expect(flagsByUid.get(5)).toEqual(["\\Deleted"]);
		expect(flagsByUid.get(6)).toEqual([
			"\\Seen",
			"\\Answered",
			"\\Flagged",
			"\\Deleted",
			"$Important",
			"NonJunk",
		]);

		// \Draft is a property of the folder, not of a column.
		const drafts = (await (await get(`/${id}/draft/messages`)).json()) as WirePage;
		expect(drafts.messages[0].flags).toEqual(["\\Draft"]);
	});

	it("returns internalDate, rfc822Size and hasRaw for a stored message", async () => {
		const { id, stub } = await makeMailbox("meta");
		await seed(stub, {
			id: "m1",
			folder: "inbox",
			uid: 1,
			date: "2026-02-03T04:05:06.000Z",
			rfc822Size: 4242,
			rawKey: `raw/${"x"}/m1.eml`,
		});

		const page = (await (await get(`/${id}/inbox/messages`)).json()) as WirePage;
		const msg = page.messages[0];
		expect(msg.internalDate).toBe("2026-02-03T04:05:06.000Z");
		expect(msg.rfc822Size).toBe(4242);
		expect(msg.hasRaw).toBe(true);
	});

	it("marks a legacy row hasRaw:false and estimates its size", async () => {
		const { id, stub } = await makeMailbox("legacy-meta");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1, body: "x".repeat(100) });

		const page = (await (await get(`/${id}/inbox/messages`)).json()) as WirePage;
		expect(page.messages[0].hasRaw).toBe(false);
		// Non-authoritative, but must be a plausible positive number rather
		// than 0 — clients use it for progress and for SEARCH LARGER/SMALLER.
		expect(page.messages[0].rfc822Size).toBeGreaterThan(100);
	});

	it("builds the envelope from the stored headers, not just the columns", async () => {
		const { id, stub } = await makeMailbox("envelope");
		await seed(stub, {
			id: "m1",
			folder: "inbox",
			uid: 1,
			subject: "Quarterly numbers",
			sender: "ada@example.com",
			recipient: "grace@example.net",
			messageId: "abc123@example.com",
			inReplyTo: "prior@example.com",
			rawHeaders: headersJson([
				["from", "Ada Lovelace <ada@example.com>"],
				["to", '"Hopper, Grace" <grace@example.net>, bob@example.org'],
				["cc", "Carol <carol@example.org>"],
				["date", "Tue, 03 Feb 2026 04:05:06 +0000"],
			]),
		});

		const page = (await (await get(`/${id}/inbox/messages`)).json()) as WirePage;
		const env0 = page.messages[0].envelope;

		expect(env0.subject).toBe("Quarterly numbers");
		expect(env0.from).toEqual([{ name: "Ada Lovelace", address: "ada@example.com" }]);
		expect(env0.to).toEqual([
			{ name: "Hopper, Grace", address: "grace@example.net" },
			{ name: "", address: "bob@example.org" },
		]);
		expect(env0.cc).toEqual([{ name: "Carol", address: "carol@example.org" }]);
		expect(env0.messageId).toBe("abc123@example.com");
		expect(env0.inReplyTo).toBe("prior@example.com");
	});

	it("takes the envelope date from the Date header, not from internalDate", async () => {
		const { id, stub } = await makeMailbox("envelope-date");
		await seed(stub, {
			id: "m1",
			folder: "inbox",
			uid: 1,
			// Receive time: days after the message claims to have been written.
			date: "2026-02-10T00:00:00.000Z",
			rawHeaders: headersJson([["date", "Tue, 03 Feb 2026 04:05:06 +0000"]]),
		});

		const page = (await (await get(`/${id}/inbox/messages`)).json()) as WirePage;
		const msg = page.messages[0];
		expect(msg.internalDate).toBe("2026-02-10T00:00:00.000Z");
		expect(msg.envelope.date).toBe("Tue, 03 Feb 2026 04:05:06 +0000");
		expect(msg.envelope.date).not.toBe(msg.internalDate);
	});

	it("falls back to internalDate when there is no Date header", async () => {
		const { id, stub } = await makeMailbox("envelope-date-missing");
		await seed(stub, {
			id: "no-headers",
			folder: "inbox",
			uid: 1,
			date: "2026-02-10T00:00:00.000Z",
			rawHeaders: null,
		});
		await seed(stub, {
			id: "other-headers",
			folder: "inbox",
			uid: 2,
			date: "2026-02-11T00:00:00.000Z",
			rawHeaders: headersJson([["subject", "no date here"]]),
		});

		const page = (await (await get(`/${id}/inbox/messages`)).json()) as WirePage;
		expect(page.messages[0].envelope.date).toBe("2026-02-10T00:00:00.000Z");
		expect(page.messages[1].envelope.date).toBe("2026-02-11T00:00:00.000Z");
	});

	it("normalises an unparseable stored date instead of emitting it raw", async () => {
		// internalDate decodes into a Go time.Time; a string Go cannot parse
		// fails the whole page, so one bad legacy row must not poison the rest.
		const { id, stub } = await makeMailbox("bad-date");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1, date: "not a date" });

		const page = (await (await get(`/${id}/inbox/messages`)).json()) as WirePage;
		expect(page.messages[0].internalDate).toBe("1970-01-01T00:00:00.000Z");
	});

	it("honours sinceUid", async () => {
		const { id, stub } = await makeMailbox("since");
		for (const uid of [1, 2, 3, 4, 5]) {
			await seed(stub, { id: `m${uid}`, folder: "inbox", uid });
		}

		const page = (await (await get(`/${id}/inbox/messages?sinceUid=3`)).json()) as WirePage;
		// "at or after this UID", per the Go client's own doc comment.
		expect(page.messages.map((m) => m.uid)).toEqual([3, 4, 5]);
	});

	it("honours limit and returns messages in ascending uid order", async () => {
		const { id, stub } = await makeMailbox("limit");
		for (const uid of [5, 1, 4, 2, 3]) {
			await seed(stub, { id: `m${uid}`, folder: "inbox", uid });
		}

		const page = (await (await get(`/${id}/inbox/messages?limit=2`)).json()) as WirePage;
		expect(page.messages.map((m) => m.uid)).toEqual([1, 2]);
	});

	it("clamps limit to the server maximum", async () => {
		const { id, stub } = await makeMailbox("clamp");
		const overshoot = IMAP_MESSAGES_MAX_LIMIT + 25;
		await exec(
			stub,
			`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, read, body, uid)
			 SELECT 'm' || n, 'inbox', 'Subject', 'a@example.com', 'b@example.com',
			        '2026-01-01T00:00:00.000Z', 0, 'body', n
			   FROM (WITH RECURSIVE seq(n) AS (
			           SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?1
			         ) SELECT n FROM seq)`,
			overshoot,
		);

		const asked = (await (
			await get(`/${id}/inbox/messages?limit=999999`)
		).json()) as WirePage;
		expect(asked.messages.length).toBe(IMAP_MESSAGES_MAX_LIMIT);

		// Absent limit is the same ceiling, not "everything".
		const defaulted = (await (await get(`/${id}/inbox/messages`)).json()) as WirePage;
		expect(defaulted.messages.length).toBe(IMAP_MESSAGES_MAX_LIMIT);
	});

	it("rejects a malformed sinceUid or limit", async () => {
		const { id, stub } = await makeMailbox("bad-query");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1 });

		for (const query of ["sinceUid=abc", "limit=abc", "limit=0", "limit=-5", "sinceUid=-1"]) {
			const res = await get(`/${id}/inbox/messages?${query}`);
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "Invalid request" });
		}
	});

	it("404s for an unknown folder and an unknown mailbox, distinctly", async () => {
		const { id, stub } = await makeMailbox("missing");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1 });

		const badFolder = await get(`/${id}/nosuchfolder/messages`);
		expect(badFolder.status).toBe(404);
		expect(await badFolder.json()).toEqual({ error: "Folder not found" });

		const badMailbox = await get(`/nobody@example.com/inbox/messages`);
		expect(badMailbox.status).toBe(404);
		expect(await badMailbox.json()).toEqual({ error: "Not found" });
	});

	it("returns an empty page rather than a 404 for an empty folder", async () => {
		const { id } = await makeMailbox("empty");
		const res = await get(`/${id}/archive/messages`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ messages: [], uidNext: 1 });
	});
});

// ── The metadata endpoint must never read R2 ──────────────────────────

/** Wrap the R2 binding so every call it receives is recorded. */
function trackBucket(calls: string[]): ImapApiEnv {
	const bucket = new Proxy(env.BUCKET, {
		get(target, prop) {
			const value = Reflect.get(target, prop) as unknown;
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				calls.push(`${String(prop)} ${String(args[0])}`);
				return (value as (...a: unknown[]) => unknown).apply(target, args);
			};
		},
	});
	return {
		BUCKET: bucket,
		// Never called on a read path; present only because the submit
		// endpoint added it to ImapApiEnv.
		EMAIL: env.EMAIL,
		DOMAINS: env.DOMAINS,
		EMAIL_ADDRESSES: env.EMAIL_ADDRESSES,
		MAILBOX: env.MAILBOX,
		IMAP_AUTH_RATE_LIMIT: env.IMAP_AUTH_RATE_LIMIT,
	};
}

describe("R2 discipline", () => {
	it("serves message metadata without reading a single message body", async () => {
		const { id, stub } = await makeMailbox("no-r2");
		for (const uid of [1, 2, 3]) {
			await seed(stub, {
				id: `m${uid}`,
				folder: "inbox",
				uid,
				rawKey: `raw/${id}/m${uid}.eml`,
				rfc822Size: 900,
				rawHeaders: headersJson([
					["from", "Ada <ada@example.com>"],
					["date", "Tue, 03 Feb 2026 04:05:06 +0000"],
				]),
			});
			await env.BUCKET.put(`raw/${id}/m${uid}.eml`, "should never be read");
		}

		const calls: string[] = [];
		const res = await get(`/${id}/inbox/messages`, trackBucket(calls));
		expect(res.status).toBe(200);
		const page = (await res.json()) as WirePage;
		expect(page.messages).toHaveLength(3);
		expect(page.messages.every((m) => m.hasRaw)).toBe(true);

		// The mailbox existence head is the only R2 operation allowed here.
		expect(calls).toEqual([`head mailboxes/${id}.json`]);
	});

	it("does not read R2 to list folders either", async () => {
		const { id, stub } = await makeMailbox("no-r2-folders");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1 });

		const calls: string[] = [];
		expect((await get(`/${id}/folders`, trackBucket(calls))).status).toBe(200);
		expect(calls).toEqual([`head mailboxes/${id}.json`]);
	});
});

// ── Raw bytes ─────────────────────────────────────────────────────────

describe("GET /{mailbox}/messages/{uid}/raw", () => {
	it("streams a stored message back byte-identically", async () => {
		const { id, stub } = await makeMailbox("raw-stored");
		const key = `raw/${id}/m1.eml`;
		const original =
			"From: Ada <ada@example.com>\r\n" +
			"To: grace@example.net\r\n" +
			"Subject: =?UTF-8?B?w6ljaG8=?=\r\n" +
			"Date: Tue, 03 Feb 2026 04:05:06 +0000\r\n" +
			"Message-ID: <abc123@example.com>\r\n" +
			"\r\n" +
			"Body with a literal CRLF and a café.\r\n";
		const originalBytes = new TextEncoder().encode(original);
		await env.BUCKET.put(key, originalBytes);
		await seed(stub, {
			id: "m1",
			folder: "inbox",
			uid: 1,
			rawKey: key,
			rfc822Size: originalBytes.byteLength,
		});

		const res = await get(`/${id}/messages/1/raw?folder=inbox`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("message/rfc822");

		const got = new Uint8Array(await res.arrayBuffer());
		expect(got.byteLength).toBe(originalBytes.byteLength);
		expect([...got]).toEqual([...originalBytes]);
	});

	it("synthesizes a legacy message that has no stored bytes", async () => {
		const { id, stub } = await makeMailbox("raw-legacy");
		await seed(stub, {
			id: "legacy1",
			folder: "inbox",
			uid: 3,
			subject: "Old news",
			sender: "ada@example.com",
			recipient: "grace@example.net",
			cc: "carol@example.org",
			body: "<p>Plain enough.</p>",
			messageId: "legacy-1@example.com",
			date: "2026-02-10T00:00:00.000Z",
			rawHeaders: headersJson([
				["from", "Ada Lovelace <ada@example.com>"],
				["to", "grace@example.net"],
				["date", "Tue, 03 Feb 2026 04:05:06 +0000"],
			]),
			rawKey: null,
		});

		const res = await get(`/${id}/messages/3/raw?folder=inbox`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("message/rfc822");

		const text = await res.text();
		expect(text).toContain("From: Ada Lovelace <ada@example.com>");
		expect(text).toContain("To: grace@example.net");
		expect(text).toContain("Cc: carol@example.org");
		expect(text).toContain("Subject: Old news");
		expect(text).toContain("Message-ID: <legacy-1@example.com>");
		// The Date header wins over the receive time when rebuilding, so the
		// reconstructed bytes agree with the envelope the metadata reported.
		expect(text).toContain("Date: Tue, 03 Feb 2026 04:05:06 +0000");
		expect(text).toContain("Content-Type: text/html");
		// Every line break is a CRLF -- the classic way hand-rolled MIME breaks.
		// The final segment has no trailing newline at all, hence slice(0, -1).
		const lines = text.split("\n");
		expect(lines.slice(0, -1).every((line) => line.endsWith("\r"))).toBe(true);

		// And the metadata for the same row says the bytes are reconstructed.
		const page = (await (await get(`/${id}/inbox/messages`)).json()) as WirePage;
		expect(page.messages[0].hasRaw).toBe(false);
	});

	it("includes attachment bytes when rebuilding a legacy message", async () => {
		const { id, stub } = await makeMailbox("raw-legacy-att");
		await seed(stub, { id: "legacy2", folder: "inbox", uid: 1, body: "see attached" });
		await exec(
			stub,
			`INSERT INTO attachments (id, email_id, filename, mimetype, size, content_id, disposition)
			 VALUES ('att1', 'legacy2', 'note.txt', 'text/plain', 5, NULL, 'attachment')`,
		);
		await env.BUCKET.put(`attachments/legacy2/att1/note.txt`, new TextEncoder().encode("hello"));

		const text = await (await get(`/${id}/messages/1/raw?folder=inbox`)).text();
		expect(text).toContain("multipart/mixed");
		expect(text).toContain('filename="note.txt"');
		// "hello" base64-encoded.
		expect(text).toContain(btoa("hello"));
	});

	it("falls back to synthesis when the stored object has vanished from R2", async () => {
		const { id, stub } = await makeMailbox("raw-missing-blob");
		await seed(stub, {
			id: "gone",
			folder: "inbox",
			uid: 1,
			subject: "Still readable",
			rawKey: `raw/${id}/gone.eml`,
		});

		const res = await get(`/${id}/messages/1/raw?folder=inbox`);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("Subject: Still readable");
	});

	it("404s distinctly for unknown mailbox, folder and uid, leaking nothing", async () => {
		const { id, stub } = await makeMailbox("raw-404");
		const key = `raw/${id}/m1.eml`;
		await env.BUCKET.put(key, "x");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1, rawKey: key });

		const cases: [string, number, unknown][] = [
			[`/nobody@example.com/messages/1/raw?folder=inbox`, 404, { error: "Not found" }],
			[`/${id}/messages/1/raw?folder=nosuchfolder`, 404, { error: "Folder not found" }],
			[`/${id}/messages/99/raw?folder=inbox`, 404, { error: "Message not found" }],
			[`/${id}/messages/1/raw`, 400, { error: "Invalid request" }],
			[`/${id}/messages/abc/raw?folder=inbox`, 400, { error: "Invalid request" }],
			[`/${id}/messages/0/raw?folder=inbox`, 400, { error: "Invalid request" }],
		];

		for (const [path, status, body] of cases) {
			const res = await get(path);
			expect(res.status, path).toBe(status);
			const text = await res.text();
			expect(JSON.parse(text)).toEqual(body);
			// No R2 key, no folder id, no email id in any error body.
			expect(text).not.toContain("raw/");
			expect(text).not.toContain(id);
		}
	});

	it("finds a uid only inside the folder it was asked for", async () => {
		const { id, stub } = await makeMailbox("raw-folder-scoped");
		await seed(stub, { id: "in-inbox", folder: "inbox", uid: 1, subject: "Inbox copy" });
		await seed(stub, { id: "in-sent", folder: "sent", uid: 1, subject: "Sent copy" });

		expect(await (await get(`/${id}/messages/1/raw?folder=inbox`)).text()).toContain(
			"Subject: Inbox copy",
		);
		expect(await (await get(`/${id}/messages/1/raw?folder=sent`)).text()).toContain(
			"Subject: Sent copy",
		);
	});
});
