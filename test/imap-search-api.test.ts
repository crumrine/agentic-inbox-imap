// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * POST /api/imap/v1/{mailbox}/{folder}/search — the SEARCH push-down (DEV-682).
 *
 * The contract this pins is not "these uids came back". It is:
 *
 *   1. `uids` holds every message satisfying the criteria named in `handled`,
 *      and nothing else has been applied — so when `partial` is true the
 *      gateway can finish the job by filtering `uids` and only `uids`.
 *   2. Anything the server could not evaluate appears in `unhandled` rather
 *      than being dropped.
 *
 * Rule 2 is the one worth testing hardest: a criterion silently ignored
 * produces a plausible, wrong result set that no client can detect.
 */

import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { IMAP_API_BASE, type ImapApiEnv, imapApi } from "../workers/routes/imap-api";
import { IMAP_SEARCH_MAX_SCAN } from "../workers/imap/search";
import { type MailboxStub, exec, mailbox } from "./helpers";

const app = new Hono<{ Bindings: ImapApiEnv }>().route(IMAP_API_BASE, imapApi);

/**
 * One mailbox id for the whole file, deliberately.
 *
 * `test/setup.ts` wipes every MailboxDO's storage and aborts every instance
 * after each test, so a fixed id still gives each test a freshly migrated,
 * empty mailbox — and it keeps that teardown O(1) instead of walking a list
 * that grows by one Durable Object per test.
 */
const MAILBOX_ID = "search@example.com";

async function makeMailbox(): Promise<{ id: string; stub: MailboxStub }> {
	await env.BUCKET.put(`mailboxes/${MAILBOX_ID}.json`, JSON.stringify({ fromName: "Test" }));
	return { id: MAILBOX_ID, stub: mailbox(MAILBOX_ID) };
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
	rfc822Size?: number | null;
}

/** Straight into SQLite, so a test can pin the exact uid and column values. */
async function seed(stub: MailboxStub, email: SeedEmail): Promise<void> {
	await exec(
		stub,
		`INSERT INTO emails (
			id, folder_id, subject, sender, recipient, cc, bcc, date, read, starred,
			body, in_reply_to, message_id, raw_headers, uid, answered, deleted, flags,
			rfc822_size
		) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)`,
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
	);
}

function headersJson(pairs: [string, string][]): string {
	return JSON.stringify(pairs.map(([key, value]) => ({ key, value })));
}

interface WireSearch {
	uids: number[];
	partial: boolean;
	handled: string[];
	unhandled: string[];
	scanned: number;
}

async function search(
	mailboxId: string,
	folder: string,
	criteria: unknown,
): Promise<Response> {
	return app.request(
		`${IMAP_API_BASE}/${encodeURIComponent(mailboxId)}/${folder}/search`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ criteria }),
		},
		env,
	);
}

async function searchOk(
	mailboxId: string,
	folder: string,
	criteria: unknown,
): Promise<WireSearch> {
	const res = await search(mailboxId, folder, criteria);
	expect(res.status).toBe(200);
	return (await res.json()) as WireSearch;
}

/**
 * A small fixed corpus. Every assertion below names uids from this table, so
 * the fixture is the readable half of each test.
 *
 *   uid 1  alice, unread,  2026-01-05, subject "Invoice 1001",   size 1000
 *   uid 2  bob,   seen,    2026-02-10, subject "Lunch?",         size 5000
 *   uid 3  carol, flagged, 2026-03-15, subject "Invoice 1002",   size 9000
 *   uid 4  alice, seen,    2026-04-20, subject "Re: Lunch?",     size 200
 */
async function seedCorpus(stub: MailboxStub): Promise<void> {
	// One statement, not four: every test in this file seeds this corpus, and
	// a Durable Object round trip per row is most of the suite's runtime.
	await exec(
		stub,
		`INSERT INTO emails (
			id, folder_id, subject, sender, recipient, cc, bcc, date, read, starred,
			body, in_reply_to, message_id, raw_headers, uid, rfc822_size, flags
		) VALUES
			('m1', 'inbox', 'Invoice 1001', 'alice@example.com', 'me@example.com',
			 NULL, NULL, '2026-01-05T08:00:00.000Z', 0, 0,
			 'Body m1', NULL, 'm1@example.com', ?1, 1, 1000, NULL),
			('m2', 'inbox', 'Lunch?', 'bob@example.com', 'me@example.com',
			 'carol@example.com', 'secret@example.com', '2026-02-10T08:00:00.000Z', 1, 0,
			 'Body m2', NULL, 'm2@example.com', NULL, 2, 5000, NULL),
			('m3', 'inbox', 'Invoice 1002', 'carol@example.com', 'me@example.com',
			 NULL, NULL, '2026-03-15T08:00:00.000Z', 0, 1,
			 'Body m3', NULL, 'm3@example.com', NULL, 3, 9000, ?2),
			('m4', 'inbox', 'Re: Lunch?', 'alice@example.com', 'me@example.com',
			 NULL, NULL, '2026-04-20T08:00:00.000Z', 1, 0,
			 'Body m4', 'm2@example.com', 'm4@example.com', NULL, 4, 200, NULL)`,
		headersJson([
			["from", "Alice Adams <alice@example.com>"],
			["to", "Me <me@example.com>"],
		]),
		JSON.stringify(["$Important"]),
	);
}

async function corpus(): Promise<string> {
	const { id, stub } = await makeMailbox();
	await seedCorpus(stub);
	return id;
}

describe("POST /{mailbox}/{folder}/search — supported criteria", () => {
	it("with no criteria at all returns every message in the folder", async () => {
		const id = await corpus();
		const result = await searchOk(id, "inbox", {});
		expect(result.uids).toEqual([1, 2, 3, 4]);
		expect(result.partial).toBe(false);
		expect(result.unhandled).toEqual([]);
	});

	it("narrows by uid range", async () => {
		const id = await corpus();
		const result = await searchOk(id, "inbox", { uid: [{ start: 2, end: 3 }] });
		expect(result.uids).toEqual([2, 3]);
		expect(result.handled).toContain("uid");
	});

	it("treats an omitted range end as open-ended", async () => {
		const id = await corpus();
		const result = await searchOk(id, "inbox", { uid: [{ start: 3 }] });
		expect(result.uids).toEqual([3, 4]);
	});

	it("applies SINCE and BEFORE to the internal date, by day", async () => {
		const id = await corpus();
		expect((await searchOk(id, "inbox", { since: "2026-03-01" })).uids).toEqual([3, 4]);
		expect((await searchOk(id, "inbox", { before: "2026-03-01" })).uids).toEqual([1, 2]);
		expect(
			(await searchOk(id, "inbox", { since: "2026-02-01", before: "2026-04-01" })).uids,
		).toEqual([2, 3]);
	});

	it("treats SINCE as inclusive of the message's own day, whatever the time", async () => {
		const id = await corpus();
		// uid 3 is 2026-03-15T08:00Z; SINCE 15-Mar must include it.
		expect((await searchOk(id, "inbox", { since: "2026-03-15" })).uids).toEqual([3, 4]);
		// BEFORE 15-Mar must exclude it: BEFORE is strictly earlier.
		expect((await searchOk(id, "inbox", { before: "2026-03-15" })).uids).toEqual([1, 2]);
	});

	it("accepts an RFC 3339 date, which is what Go marshals a time.Time to", async () => {
		const id = await corpus();
		const result = await searchOk(id, "inbox", { since: "2026-03-01T00:00:00Z" });
		expect(result.uids).toEqual([3, 4]);
		expect(result.partial).toBe(false);
	});

	it("matches system flags and their negations", async () => {
		const id = await corpus();
		expect((await searchOk(id, "inbox", { flag: ["\\Seen"] })).uids).toEqual([2, 4]);
		expect((await searchOk(id, "inbox", { notFlag: ["\\Seen"] })).uids).toEqual([1, 3]);
		expect((await searchOk(id, "inbox", { flag: ["\\Flagged"] })).uids).toEqual([3]);
	});

	it("matches custom keywords case-insensitively", async () => {
		const id = await corpus();
		expect((await searchOk(id, "inbox", { flag: ["$important"] })).uids).toEqual([3]);
		expect((await searchOk(id, "inbox", { notFlag: ["$IMPORTANT"] })).uids).toEqual([1, 2, 4]);
	});

	it("answers \\Draft from the folder, not from a column", async () => {
		const { id, stub } = await makeMailbox();
		await seed(stub, { id: "d1", folder: "draft", uid: 1 });
		await seed(stub, { id: "i1", folder: "inbox", uid: 1 });

		expect((await searchOk(id, "draft", { flag: ["\\Draft"] })).uids).toEqual([1]);
		expect((await searchOk(id, "inbox", { flag: ["\\Draft"] })).uids).toEqual([]);
		expect((await searchOk(id, "inbox", { notFlag: ["\\Draft"] })).uids).toEqual([1]);
	});

	it("never matches \\Recent, which this server does not set", async () => {
		const id = await corpus();
		// Not an omission: /folders reports recent 0 for every folder, so the
		// consistent answer is "no message is \Recent" rather than a guess.
		expect((await searchOk(id, "inbox", { flag: ["\\Recent"] })).uids).toEqual([]);
		expect((await searchOk(id, "inbox", { notFlag: ["\\Recent"] })).uids).toEqual([1, 2, 3, 4]);
	});

	it("compares LARGER and SMALLER strictly", async () => {
		const id = await corpus();
		expect((await searchOk(id, "inbox", { larger: 5000 })).uids).toEqual([3]);
		expect((await searchOk(id, "inbox", { smaller: 5000 })).uids).toEqual([1, 4]);
	});

	it("matches SUBJECT, MESSAGE-ID and IN-REPLY-TO as case-insensitive substrings", async () => {
		const id = await corpus();
		expect(
			(await searchOk(id, "inbox", { header: [{ key: "Subject", value: "invoice" }] })).uids,
		).toEqual([1, 3]);
		expect(
			(await searchOk(id, "inbox", { header: [{ key: "message-id", value: "m3@" }] })).uids,
		).toEqual([3]);
		expect(
			(await searchOk(id, "inbox", { header: [{ key: "in-reply-to", value: "m2@" }] })).uids,
		).toEqual([4]);
	});

	it("matches FROM, TO and CC against the envelope the metadata endpoint serves", async () => {
		const id = await corpus();
		expect(
			(await searchOk(id, "inbox", { header: [{ key: "from", value: "alice" }] })).uids,
		).toEqual([1, 4]);
		// The display name only exists in raw_headers for uid 1.
		expect(
			(await searchOk(id, "inbox", { header: [{ key: "from", value: "Alice Adams" }] })).uids,
		).toEqual([1]);
		expect(
			(await searchOk(id, "inbox", { header: [{ key: "cc", value: "carol" }] })).uids,
		).toEqual([2]);
		expect((await searchOk(id, "inbox", { header: [{ key: "to", value: "me@" }] })).uids).toEqual([
			1, 2, 3, 4,
		]);
	});

	it("answers BCC from the stored column, which raw bytes cannot", async () => {
		const id = await corpus();
		const result = await searchOk(id, "inbox", {
			header: [{ key: "bcc", value: "secret@example.com" }],
		});
		expect(result.uids).toEqual([2]);
		expect(result.partial).toBe(false);
	});

	it("reads an empty header pattern as 'this field is present'", async () => {
		const id = await corpus();
		expect((await searchOk(id, "inbox", { header: [{ key: "cc", value: "" }] })).uids).toEqual([2]);
		expect(
			(await searchOk(id, "inbox", { header: [{ key: "in-reply-to", value: "" }] })).uids,
		).toEqual([4]);
	});

	it("matches an RFC 2047 encoded display name by its decoded text", async () => {
		// "Nürnberg Team", base64. The needle below is plain ASCII and appears
		// nowhere in the stored bytes, so the SQL prefilter can only admit
		// this row via its encoded-word escape hatch. Drop that hatch and this
		// search silently returns nothing, which is the failure mode the whole
		// superset discipline exists to prevent.
		const { id, stub } = await makeMailbox();
		await seed(stub, {
			id: "e1",
			folder: "inbox",
			uid: 1,
			sender: "team@example.com",
			rawHeaders: headersJson([["from", "=?UTF-8?B?TsO8cm5iZXJnIFRlYW0=?= <team@example.com>"]]),
		});
		await seed(stub, { id: "e2", folder: "inbox", uid: 2, sender: "other@example.com" });

		const result = await searchOk(id, "inbox", {
			header: [{ key: "from", value: "nberg Team" }],
		});
		expect(result.uids).toEqual([1]);
		expect(result.partial).toBe(false);
	});

	it("matches an address whose comment the envelope strips", async () => {
		// parseAddressList drops RFC 5322 comments, so the rendered address is
		// not a substring of the stored header. The comment escape hatch is
		// what keeps the prefilter from excluding the row.
		const { id, stub } = await makeMailbox();
		await seed(stub, {
			id: "c1",
			folder: "inbox",
			uid: 1,
			sender: "dana(the intern)@example.com",
		});

		const result = await searchOk(id, "inbox", {
			header: [{ key: "from", value: "dana@example.com" }],
		});
		expect(result.uids).toEqual([1]);
	});

	it("matches a quoted display name whose quotes the envelope strips", async () => {
		const { id, stub } = await makeMailbox();
		await seed(stub, {
			id: "q1",
			folder: "inbox",
			uid: 1,
			sender: "john@example.com",
			rawHeaders: headersJson([["from", '"Smith, John" <john@example.com>']]),
		});

		// The envelope renders this as `Smith, John <john@example.com>`; the
		// raw column still has the quotes, so a literal LIKE would miss it.
		const result = await searchOk(id, "inbox", {
			header: [{ key: "from", value: "Smith, John <john@" }],
		});
		expect(result.uids).toEqual([1]);
	});

	it("ANDs several criteria", async () => {
		const id = await corpus();
		const result = await searchOk(id, "inbox", {
			since: "2026-02-01",
			header: [{ key: "subject", value: "invoice" }],
			notFlag: ["\\Seen"],
		});
		expect(result.uids).toEqual([3]);
		expect(result.partial).toBe(false);
	});

	it("evaluates NOT and OR trees", async () => {
		const id = await corpus();
		expect(
			(await searchOk(id, "inbox", { not: [{ header: [{ key: "subject", value: "invoice" }] }] }))
				.uids,
		).toEqual([2, 4]);
		expect(
			(
				await searchOk(id, "inbox", {
					or: [[{ header: [{ key: "from", value: "bob" }] }, { flag: ["\\Flagged"] }]],
				})
			).uids,
		).toEqual([2, 3]);
	});

	it("returns an empty list, not an error, when nothing matches", async () => {
		const id = await corpus();
		const result = await searchOk(id, "inbox", {
			header: [{ key: "subject", value: "nothing matches this" }],
		});
		expect(result.uids).toEqual([]);
		expect(result.partial).toBe(false);
		expect(result.unhandled).toEqual([]);
	});

	it("only ever looks in the folder it was asked about", async () => {
		const { id, stub } = await makeMailbox();
		await seed(stub, { id: "i1", folder: "inbox", uid: 1, subject: "Invoice" });
		await seed(stub, { id: "s1", folder: "sent", uid: 1, subject: "Invoice" });

		const result = await searchOk(id, "sent", {
			header: [{ key: "subject", value: "invoice" }],
		});
		expect(result.uids).toEqual([1]);
		expect(result.scanned).toBe(1);
	});
});

describe("POST /{mailbox}/{folder}/search — honesty about what it did not do", () => {
	it("reports BODY as unhandled and still applies everything else", async () => {
		const id = await corpus();
		const result = await searchOk(id, "inbox", {
			header: [{ key: "subject", value: "invoice" }],
			body: ["anything"],
		});
		// uids is the set matching the *handled* criteria only, so the gateway
		// can finish by filtering it. It must not have been narrowed by BODY.
		expect(result.uids).toEqual([1, 3]);
		expect(result.partial).toBe(true);
		expect(result.handled).toEqual(["header[0]"]);
		expect(result.unhandled).toEqual(["body[0]"]);
	});

	it("reports TEXT as unhandled", async () => {
		const id = await corpus();
		const result = await searchOk(id, "inbox", { text: ["Body m1"] });
		expect(result.partial).toBe(true);
		expect(result.unhandled).toEqual(["text[0]"]);
		// Not narrowed at all: the caller has to do this one itself.
		expect(result.uids).toEqual([1, 2, 3, 4]);
	});

	it("reports SENTSINCE and SENTBEFORE as unhandled", async () => {
		const id = await corpus();
		const result = await searchOk(id, "inbox", {
			sentSince: "2026-01-01T00:00:00Z",
			sentBefore: "2027-01-01T00:00:00Z",
		});
		expect(result.unhandled).toEqual(["sentSince", "sentBefore"]);
		expect(result.partial).toBe(true);
	});

	it("reports a header key it has no column for", async () => {
		const id = await corpus();
		const result = await searchOk(id, "inbox", {
			header: [
				{ key: "subject", value: "invoice" },
				{ key: "X-Mailer", value: "kmail" },
			],
		});
		expect(result.uids).toEqual([1, 3]);
		expect(result.handled).toEqual(["header[0]"]);
		expect(result.unhandled).toEqual(["header[1]"]);
		expect(result.partial).toBe(true);
	});

	it("keeps positional tokens distinct when two terms share a key", async () => {
		const id = await corpus();
		const result = await searchOk(id, "inbox", {
			header: [
				{ key: "x-one", value: "a" },
				{ key: "subject", value: "invoice" },
				{ key: "x-two", value: "b" },
			],
		});
		expect(result.handled).toEqual(["header[1]"]);
		expect(result.unhandled).toEqual(["header[0]", "header[2]"]);
	});

	it("refuses a NOT whose subtree it cannot fully evaluate", async () => {
		const id = await corpus();
		const result = await searchOk(id, "inbox", {
			not: [{ body: ["invoice"] }],
		});
		// Applying NOT over a partially evaluated subtree would turn a
		// superset into a subset and drop real matches, so the whole node
		// goes back to the caller.
		expect(result.unhandled).toEqual(["not[0]"]);
		expect(result.uids).toEqual([1, 2, 3, 4]);
	});

	it("refuses an OR when either branch is not fully evaluable", async () => {
		const id = await corpus();
		const result = await searchOk(id, "inbox", {
			or: [[{ header: [{ key: "from", value: "bob" }] }, { body: ["invoice"] }]],
		});
		expect(result.unhandled).toEqual(["or[0]"]);
		expect(result.handled).toEqual([]);
		expect(result.uids).toEqual([1, 2, 3, 4]);
	});

	it("handles a NOT and an OR whose subtrees are fully evaluable", async () => {
		const id = await corpus();
		const result = await searchOk(id, "inbox", {
			not: [{ flag: ["\\Seen"] }],
			or: [[{ header: [{ key: "subject", value: "invoice" }] }, { flag: ["\\Flagged"] }]],
		});
		expect(result.unhandled).toEqual([]);
		expect(result.uids).toEqual([1, 3]);
	});

	it("mixes handled and unhandled criteria across the whole tree", async () => {
		const id = await corpus();
		const result = await searchOk(id, "inbox", {
			since: "2026-02-01",
			flag: ["\\Seen"],
			body: ["invoice"],
			text: ["lunch"],
			sentSince: "2026-01-01T00:00:00Z",
			header: [{ key: "to", value: "me@" }],
			not: [{ text: ["x"] }],
		});
		expect(result.handled).toEqual(["since", "flag[0]", "header[0]"]);
		expect(result.unhandled).toEqual(["sentSince", "body[0]", "text[0]", "not[0]"]);
		expect(result.partial).toBe(true);
		expect(result.uids).toEqual([2, 4]);
	});
});

describe("POST /{mailbox}/{folder}/search — errors and bounds", () => {
	it("404s an unknown mailbox", async () => {
		const res = await search("nobody@example.com", "inbox", {});
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Not found" });
	});

	it("404s an unknown folder", async () => {
		const id = await corpus();
		const res = await search(id, "no-such-folder", {});
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Folder not found" });
	});

	it("400s a criteria key it does not recognise, rather than ignoring it", async () => {
		const id = await corpus();
		const res = await search(id, "inbox", { keywordsomething: ["x"] });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Invalid request" });
	});

	it("400s a malformed body", async () => {
		const id = await corpus();
		const res = await app.request(
			`${IMAP_API_BASE}/${encodeURIComponent(id)}/inbox/search`,
			{ method: "POST", headers: { "content-type": "application/json" }, body: "not json" },
			env,
		);
		expect(res.status).toBe(400);
	});

	it("400s a criteria tree nested past the depth cap", async () => {
		const id = await corpus();
		let node: Record<string, unknown> = { flag: ["\\Seen"] };
		for (let i = 0; i < 12; i++) node = { not: [node] };
		const res = await search(id, "inbox", node);
		expect(res.status).toBe(400);
	});

	it("400s an over-long uid range list", async () => {
		const id = await corpus();
		const uid = Array.from({ length: 300 }, (_, i) => ({ start: i + 1, end: i + 1 }));
		const res = await search(id, "inbox", { uid });
		expect(res.status).toBe(400);
	});
});

describe("POST /{mailbox}/{folder}/search — narrowing", () => {
	/**
	 * The point of the endpoint is that the gateway stops downloading a
	 * folder's worth of raw messages, and the point of the SQL prefilter is
	 * that the Durable Object does not answer by loading a folder's worth of
	 * rows either. `scanned` reports how many rows reached the matcher, so a
	 * regression that turns the prefilter into a full table scan shows up as
	 * a number instead of just a slower test.
	 */
	const CORPUS_SIZE = 400;

	/**
	 * One INSERT for the whole folder, with literal values.
	 *
	 * Row-at-a-time seeding is a Durable Object round trip per message and
	 * turns this suite into a minute of waiting, and the DO's SQLite caps a
	 * statement at 100 bound variables, so a parameterised bulk insert is out
	 * too. Everything interpolated here is generated a few lines above.
	 */
	async function bigFolder(): Promise<string> {
		const { id, stub } = await makeMailbox();
		const tuples: string[] = [];
		for (let uid = 1; uid <= CORPUS_SIZE; uid++) {
			const subject = uid === 137 ? "Quarterly invoice" : `Newsletter ${uid}`;
			const sender = uid === 137 ? "billing@example.com" : `list-${uid}@example.com`;
			const date = `2026-05-${String((uid % 28) + 1).padStart(2, "0")}T09:00:00.000Z`;
			tuples.push(
				`('big-${uid}', 'inbox', '${subject}', '${sender}', 'me@example.com', '${date}', ${uid}, ${1000 + uid})`,
			);
		}
		await exec(
			stub,
			`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, uid, rfc822_size)
			 VALUES ${tuples.join(", ")}`,
		);
		return id;
	}

	it("finds one subject in a large folder without loading every row", async () => {
		const id = await bigFolder();
		const result = await searchOk(id, "inbox", {
			header: [{ key: "subject", value: "Quarterly invoice" }],
		});
		expect(result.uids).toEqual([137]);
		expect(result.scanned).toBe(1);
	});

	it("narrows an address search in SQL before the matcher sees it", async () => {
		const id = await bigFolder();
		const result = await searchOk(id, "inbox", {
			header: [{ key: "from", value: "billing@example.com" }],
		});
		expect(result.uids).toEqual([137]);
		expect(result.scanned).toBe(1);
	});

	it("narrows on flags, size and uid range too", async () => {
		const id = await bigFolder();
		const result = await searchOk(id, "inbox", {
			uid: [{ start: 100, end: 140 }],
			larger: 1136,
			header: [{ key: "subject", value: "invoice" }],
		});
		expect(result.uids).toEqual([137]);
		expect(result.scanned).toBe(1);
	});

	it("still narrows when an unhandled criterion rides along", async () => {
		const id = await bigFolder();
		const result = await searchOk(id, "inbox", {
			header: [{ key: "subject", value: "Quarterly invoice" }],
			body: ["overdue"],
		});
		// This is the whole value proposition: the gateway is left with one
		// raw fetch instead of 400.
		expect(result.uids).toEqual([137]);
		expect(result.partial).toBe(true);
		expect(result.scanned).toBe(1);
	});

	it("scans the folder when nothing is narrowable, and says how much", async () => {
		const id = await bigFolder();
		const result = await searchOk(id, "inbox", { body: ["overdue"] });
		expect(result.uids.length).toBe(CORPUS_SIZE);
		expect(result.scanned).toBe(CORPUS_SIZE);
		expect(result.scanned).toBeLessThan(IMAP_SEARCH_MAX_SCAN);
	});
});
