// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The write surface the Go IMAP gateway consumes:
 *
 *   POST /api/imap/v1/{mailbox}/{folder}/flags
 *
 * This endpoint is why a real client works at all. iOS Mail sends
 * `UID STORE n +FLAGS.SILENT (\Seen)` the instant it displays a message; the
 * read-only gateway answered `NO [CANNOT]`, iOS treated that as fatal, and the
 * captured trace is 20,000 lines of teardown-and-reconnect. So the assertions
 * below are as much about what must NOT fail (an unknown uid, an unsettable
 * flag) as about what must be written.
 *
 * Field names are literal on purpose: `updates`/`uid`/`add`/`remove` in, and
 * `updated`/`uid`/`flags` out, are the Go struct tags on the other side, and a
 * rename here would leave those fields silently zero rather than erroring.
 */

import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { IMAP_MAX_KEYWORDS_PER_MESSAGE, IMAP_MESSAGES_MAX_LIMIT } from "../workers/durableObject";
import { IMAP_API_BASE, type ImapApiEnv, imapApi } from "../workers/routes/imap-api";
import { type MailboxStub, exec, mailbox, query } from "./helpers";

const app = new Hono<{ Bindings: ImapApiEnv }>().route(IMAP_API_BASE, imapApi);

let n = 0;
/** Distinct mailbox per test: Durable Object storage is keyed by this name. */
async function makeMailbox(prefix: string): Promise<{ id: string; stub: MailboxStub }> {
	n += 1;
	const id = `${prefix}-${n}@example.com`;
	await env.BUCKET.put(`mailboxes/${id}.json`, JSON.stringify({ fromName: "Test" }));
	return { id, stub: mailbox(id) };
}

interface SeedEmail {
	id: string;
	folder: string;
	uid: number;
	read?: 0 | 1;
	starred?: 0 | 1;
	answered?: 0 | 1;
	deleted?: 0 | 1;
	flags?: string | null;
}

/** Insert straight into SQLite so a test can pin the exact starting flag state. */
async function seed(stub: MailboxStub, email: SeedEmail): Promise<void> {
	await exec(
		stub,
		`INSERT INTO emails (
			id, folder_id, subject, sender, recipient, date, body,
			uid, read, starred, answered, deleted, flags
		) VALUES (?1, ?2, ?3, 'sender@example.com', 'recipient@example.com',
		          '2026-03-01T10:00:00.000Z', 'body', ?4, ?5, ?6, ?7, ?8, ?9)`,
		email.id,
		email.folder,
		`Subject ${email.id}`,
		email.uid,
		email.read ?? 0,
		email.starred ?? 0,
		email.answered ?? 0,
		email.deleted ?? 0,
		email.flags ?? null,
	);
}

interface FlagUpdate {
	uid: number;
	add?: string[];
	remove?: string[];
}

interface WireUpdated {
	updated: { uid: number; flags: string[] }[];
}

async function store(
	mailboxId: string,
	folder: string,
	body: unknown,
): Promise<Response> {
	return app.request(
		`${IMAP_API_BASE}/${mailboxId}/${folder}/flags`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
		env,
	);
}

/** The happy path: expect 200 and hand back the decoded body. */
async function storeOk(
	mailboxId: string,
	folder: string,
	updates: FlagUpdate[],
): Promise<WireUpdated> {
	const res = await store(mailboxId, folder, { updates });
	expect(res.status).toBe(200);
	return (await res.json()) as WireUpdated;
}

interface FlagColumns {
	read: number;
	starred: number;
	answered: number;
	deleted: number;
	flags: string | null;
}

async function columns(stub: MailboxStub, uid: number): Promise<FlagColumns> {
	const rows = await query<FlagColumns>(
		stub,
		`SELECT COALESCE(read, 0) AS read, COALESCE(starred, 0) AS starred,
		        COALESCE(answered, 0) AS answered, COALESCE(deleted, 0) AS deleted,
		        flags AS flags
		   FROM emails WHERE uid = ?1`,
		uid,
	);
	return rows[0];
}

// ── System flags map onto their columns ───────────────────────────────

describe("system flags", () => {
	const cases: [string, keyof Omit<FlagColumns, "flags">][] = [
		["\\Seen", "read"],
		["\\Flagged", "starred"],
		["\\Answered", "answered"],
		["\\Deleted", "deleted"],
	];

	for (const [flag, column] of cases) {
		it(`adding ${flag} sets ${column} and removing it clears the column`, async () => {
			const { id, stub } = await makeMailbox("sysflag");
			await seed(stub, { id: "m1", folder: "inbox", uid: 1 });

			const added = await storeOk(id, "inbox", [{ uid: 1, add: [flag] }]);
			expect(added.updated).toEqual([{ uid: 1, flags: [flag] }]);
			expect((await columns(stub, 1))[column]).toBe(1);

			const removed = await storeOk(id, "inbox", [{ uid: 1, remove: [flag] }]);
			expect(removed.updated).toEqual([{ uid: 1, flags: [] }]);
			expect((await columns(stub, 1))[column]).toBe(0);
		});
	}

	it("leaves the other three columns alone when one flag changes", async () => {
		const { id, stub } = await makeMailbox("sysflag-isolated");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1, starred: 1, answered: 1 });

		await storeOk(id, "inbox", [{ uid: 1, add: ["\\Seen"] }]);

		expect(await columns(stub, 1)).toMatchObject({
			read: 1,
			starred: 1,
			answered: 1,
			deleted: 0,
		});
	});

	it("treats flag names case-insensitively, as IMAP atoms are", async () => {
		// A client sending \SEEN and getting silence would just re-issue it.
		const { id, stub } = await makeMailbox("sysflag-case");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1 });

		const res = await storeOk(id, "inbox", [{ uid: 1, add: ["\\SEEN", "\\flagged"] }]);
		expect(res.updated[0].flags).toEqual(["\\Seen", "\\Flagged"]);
		expect(await columns(stub, 1)).toMatchObject({ read: 1, starred: 1 });
	});

	it("returns the complete resulting flag set, not just what changed", async () => {
		// The gateway echoes this straight back as an untagged FETCH, so a
		// partial answer would desync every client that trusts it.
		const { id, stub } = await makeMailbox("complete-set");
		await seed(stub, {
			id: "m1",
			folder: "inbox",
			uid: 1,
			answered: 1,
			starred: 1,
			flags: JSON.stringify(["$Important"]),
		});

		const res = await storeOk(id, "inbox", [{ uid: 1, add: ["\\Seen"] }]);
		expect(res.updated).toEqual([
			{ uid: 1, flags: ["\\Seen", "\\Answered", "\\Flagged", "$Important"] },
		]);
	});
});

// ── Custom keywords ───────────────────────────────────────────────────

describe("custom keywords", () => {
	it("adds a keyword while preserving the existing ones", async () => {
		const { id, stub } = await makeMailbox("kw-add");
		await seed(stub, {
			id: "m1",
			folder: "inbox",
			uid: 1,
			flags: JSON.stringify(["$Important", "NonJunk"]),
		});

		const res = await storeOk(id, "inbox", [{ uid: 1, add: ["$Label1"] }]);
		expect(res.updated[0].flags).toEqual(["$Important", "NonJunk", "$Label1"]);
		expect(JSON.parse((await columns(stub, 1)).flags!)).toEqual([
			"$Important",
			"NonJunk",
			"$Label1",
		]);
	});

	it("removes only the named keyword and leaves the unrelated ones", async () => {
		const { id, stub } = await makeMailbox("kw-remove");
		await seed(stub, {
			id: "m1",
			folder: "inbox",
			uid: 1,
			flags: JSON.stringify(["$Important", "NonJunk", "$Label1"]),
		});

		const res = await storeOk(id, "inbox", [{ uid: 1, remove: ["NonJunk"] }]);
		expect(res.updated[0].flags).toEqual(["$Important", "$Label1"]);
		expect(JSON.parse((await columns(stub, 1)).flags!)).toEqual(["$Important", "$Label1"]);
	});

	it("does not duplicate a keyword the message already carries", async () => {
		const { id, stub } = await makeMailbox("kw-dup");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1, flags: JSON.stringify(["$Important"]) });

		// Different casing, same atom.
		const res = await storeOk(id, "inbox", [{ uid: 1, add: ["$important"] }]);
		expect(res.updated[0].flags).toEqual(["$Important"]);
	});

	it("removing a keyword the message never had is a no-op, not an error", async () => {
		const { id, stub } = await makeMailbox("kw-absent");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1 });

		const res = await storeOk(id, "inbox", [{ uid: 1, remove: ["Nope"] }]);
		expect(res.updated).toEqual([{ uid: 1, flags: [] }]);
		expect((await columns(stub, 1)).flags).toBeNull();
	});

	it("caps how many keywords one message can accumulate", async () => {
		// The route caps a single request; this cap is what stops a caller
		// growing the array without bound across many requests.
		const { id, stub } = await makeMailbox("kw-cap");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1 });

		const many = Array.from({ length: IMAP_MAX_KEYWORDS_PER_MESSAGE + 10 }, (_, i) => `kw${i}`);
		for (const keyword of many) {
			await storeOk(id, "inbox", [{ uid: 1, add: [keyword] }]);
		}

		const stored = JSON.parse((await columns(stub, 1)).flags!) as string[];
		expect(stored).toHaveLength(IMAP_MAX_KEYWORDS_PER_MESSAGE);
		// The overflow is dropped rather than failing the STORE.
		expect(stored[0]).toBe("kw0");
		expect(stored).not.toContain(`kw${IMAP_MAX_KEYWORDS_PER_MESSAGE}`);
	});
});

// ── Unsettable flags ──────────────────────────────────────────────────

describe("unsettable flags", () => {
	it("ignores \\Draft and \\Recent instead of failing the store", async () => {
		const { id, stub } = await makeMailbox("unsettable");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1 });

		const res = await storeOk(id, "inbox", [
			{ uid: 1, add: ["\\Draft", "\\Recent", "\\Seen"] },
		]);
		// \Seen still applied; the other two left no trace anywhere.
		expect(res.updated).toEqual([{ uid: 1, flags: ["\\Seen"] }]);
		expect((await columns(stub, 1)).flags).toBeNull();
	});

	it("cannot remove \\Draft from a message in the drafts folder", async () => {
		const { id, stub } = await makeMailbox("undraft");
		await seed(stub, { id: "m1", folder: "draft", uid: 1 });

		const res = await storeOk(id, "draft", [{ uid: 1, remove: ["\\Draft"] }]);
		// \Draft is derived from the folder, so it survives the attempt.
		expect(res.updated).toEqual([{ uid: 1, flags: ["\\Draft"] }]);
	});

	it("does not store an unrecognised system-namespace flag as a keyword", async () => {
		const { id, stub } = await makeMailbox("unknown-system");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1 });

		const res = await storeOk(id, "inbox", [{ uid: 1, add: ["\\Nonsense"] }]);
		expect(res.updated).toEqual([{ uid: 1, flags: [] }]);
		expect((await columns(stub, 1)).flags).toBeNull();
	});
});

// ── Batching ──────────────────────────────────────────────────────────

describe("batching", () => {
	it("applies several uids in one call", async () => {
		const { id, stub } = await makeMailbox("batch");
		for (const uid of [1, 2, 3]) {
			await seed(stub, { id: `m${uid}`, folder: "inbox", uid });
		}

		const res = await storeOk(id, "inbox", [
			{ uid: 1, add: ["\\Seen"] },
			{ uid: 2, add: ["\\Flagged", "$Work"] },
			{ uid: 3, add: ["\\Deleted"] },
		]);

		expect(res.updated).toEqual([
			{ uid: 1, flags: ["\\Seen"] },
			{ uid: 2, flags: ["\\Flagged", "$Work"] },
			{ uid: 3, flags: ["\\Deleted"] },
		]);
		expect(await columns(stub, 1)).toMatchObject({ read: 1 });
		expect(await columns(stub, 2)).toMatchObject({ starred: 1 });
		expect(await columns(stub, 3)).toMatchObject({ deleted: 1 });
	});

	it("skips an unknown uid while still applying the rest of the batch", async () => {
		// A message can be expunged between the client's snapshot and its
		// STORE. Failing the batch over that would fail it for the messages
		// that do still exist, which is exactly the loop this endpoint fixes.
		const { id, stub } = await makeMailbox("batch-missing");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1 });
		await seed(stub, { id: "m3", folder: "inbox", uid: 3 });

		const res = await storeOk(id, "inbox", [
			{ uid: 1, add: ["\\Seen"] },
			{ uid: 2, add: ["\\Seen"] },
			{ uid: 3, add: ["\\Seen"] },
		]);

		expect(res.updated).toEqual([
			{ uid: 1, flags: ["\\Seen"] },
			{ uid: 3, flags: ["\\Seen"] },
		]);
		expect(res.updated.map((u) => u.uid)).not.toContain(2);
	});

	it("only touches uids inside the folder it was asked for", async () => {
		const { id, stub } = await makeMailbox("batch-scoped");
		await seed(stub, { id: "in-inbox", folder: "inbox", uid: 1 });
		await seed(stub, { id: "in-sent", folder: "sent", uid: 1 });

		await storeOk(id, "inbox", [{ uid: 1, add: ["\\Seen"] }]);

		const rows = await query<{ id: string; read: number }>(
			stub,
			`SELECT id, COALESCE(read, 0) AS read FROM emails ORDER BY id`,
		);
		expect(rows).toEqual([
			{ id: "in-inbox", read: 1 },
			{ id: "in-sent", read: 0 },
		]);
	});

	it("folds two updates naming the same uid instead of letting one win", async () => {
		const { id, stub } = await makeMailbox("batch-same-uid");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1, starred: 1 });

		const res = await storeOk(id, "inbox", [
			{ uid: 1, add: ["\\Seen"] },
			{ uid: 1, remove: ["\\Flagged"] },
		]);
		expect(res.updated).toEqual([{ uid: 1, flags: ["\\Seen"] }]);
	});

	it("accepts an empty batch as a no-op", async () => {
		const { id, stub } = await makeMailbox("batch-empty");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1 });

		const res = await store(id, "inbox", { updates: [] });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ updated: [] });
	});
});

// ── Validation and errors ─────────────────────────────────────────────

describe("validation", () => {
	it("rejects a malformed body with 400 and no echo of the input", async () => {
		const { id, stub } = await makeMailbox("bad-body");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1 });

		const bad: unknown[] = [
			{},
			{ updates: "nope" },
			{ updates: [{}] },
			{ updates: [{ uid: "1", add: ["\\Seen"] }] },
			{ updates: [{ uid: 0, add: ["\\Seen"] }] },
			{ updates: [{ uid: 1.5, add: ["\\Seen"] }] },
			{ updates: [{ uid: 1, add: "\\Seen" }] },
			{ updates: [{ uid: 1, add: [""] }] },
			{ updates: [{ uid: 1, add: [123] }] },
			{ updates: [{ uid: 1, add: ["x".repeat(65)] }] },
			{ updates: [{ uid: 1, add: Array.from({ length: 65 }, (_, i) => `kw${i}`) }] },
		];

		for (const body of bad) {
			const res = await store(id, "inbox", body);
			expect(res.status, JSON.stringify(body)).toBe(400);
			const text = await res.text();
			expect(JSON.parse(text)).toEqual({ error: "Invalid request" });
			// A zod message would carry the rejected input, uids included.
			expect(text).not.toContain("uid");
			expect(text).not.toContain("Seen");
		}

		// Nothing was written by any of them.
		expect(await columns(stub, 1)).toMatchObject({ read: 0, starred: 0 });
	});

	it("rejects a body that is not JSON at all", async () => {
		const { id } = await makeMailbox("not-json");
		const res = await app.request(
			`${IMAP_API_BASE}/${id}/inbox/flags`,
			{ method: "POST", headers: { "content-type": "application/json" }, body: "{" },
			env,
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Invalid request" });
	});

	it("rejects a batch larger than the per-request cap", async () => {
		const { id, stub } = await makeMailbox("over-cap");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1 });

		const overshoot = Array.from({ length: IMAP_MESSAGES_MAX_LIMIT + 1 }, (_, i) => ({
			uid: i + 1,
			add: ["\\Seen"],
		}));
		const res = await store(id, "inbox", { updates: overshoot });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Invalid request" });
		// Rejected whole; the first uid in the batch is untouched.
		expect(await columns(stub, 1)).toMatchObject({ read: 0 });

		// One under the cap is accepted.
		const atCap = await store(id, "inbox", { updates: overshoot.slice(0, IMAP_MESSAGES_MAX_LIMIT) });
		expect(atCap.status).toBe(200);
	});

	it("404s for an unknown folder and an unknown mailbox, distinctly", async () => {
		const { id, stub } = await makeMailbox("store-404");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1 });

		const badFolder = await store(id, "nosuchfolder", { updates: [{ uid: 1, add: ["\\Seen"] }] });
		expect(badFolder.status).toBe(404);
		expect(await badFolder.json()).toEqual({ error: "Folder not found" });

		const badMailbox = await store("nobody@example.com", "inbox", {
			updates: [{ uid: 1, add: ["\\Seen"] }],
		});
		expect(badMailbox.status).toBe(404);
		expect(await badMailbox.json()).toEqual({ error: "Not found" });
	});
});

// ── Round trip against the read endpoint ──────────────────────────────

describe("round trip", () => {
	it("reads back through /messages exactly what the store returned", async () => {
		// The two endpoints derive flags from the same place; this is the test
		// that keeps them from drifting apart.
		const { id, stub } = await makeMailbox("round-trip");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1, flags: JSON.stringify(["$Existing"]) });
		await seed(stub, { id: "m2", folder: "inbox", uid: 2, read: 1, starred: 1 });

		const stored = await storeOk(id, "inbox", [
			{ uid: 1, add: ["\\Seen", "\\Answered", "$Work"] },
			{ uid: 2, remove: ["\\Flagged"], add: ["\\Deleted"] },
		]);

		const page = (await (
			await app.request(`${IMAP_API_BASE}/${id}/inbox/messages`, {}, env)
		).json()) as { messages: { uid: number; flags: string[] }[] };

		const readBack = new Map(page.messages.map((m) => [m.uid, m.flags]));
		for (const entry of stored.updated) {
			expect(readBack.get(entry.uid), `uid ${entry.uid}`).toEqual(entry.flags);
		}
		expect(readBack.get(1)).toEqual(["\\Seen", "\\Answered", "$Existing", "$Work"]);
		expect(readBack.get(2)).toEqual(["\\Seen", "\\Deleted"]);
	});

	it("shows a \\Seen store in the folder unseen count", async () => {
		const { id, stub } = await makeMailbox("round-trip-counts");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1 });
		await seed(stub, { id: "m2", folder: "inbox", uid: 2 });

		const before = (await (
			await app.request(`${IMAP_API_BASE}/${id}/folders`, {}, env)
		).json()) as { id: string; unseen: number }[];
		expect(before.find((f) => f.id === "inbox")!.unseen).toBe(2);

		await storeOk(id, "inbox", [{ uid: 1, add: ["\\Seen"] }]);

		const after = (await (
			await app.request(`${IMAP_API_BASE}/${id}/folders`, {}, env)
		).json()) as { id: string; unseen: number }[];
		expect(after.find((f) => f.id === "inbox")!.unseen).toBe(1);
	});
});
