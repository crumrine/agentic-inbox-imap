// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The delete half of the gateway write surface (DEV-671):
 *
 *   POST /api/imap/v1/{mailbox}/{folder}/copy
 *   POST /api/imap/v1/{mailbox}/{folder}/move
 *   POST /api/imap/v1/{mailbox}/{folder}/expunge
 *
 * Read-only was found to make iOS Mail unusable, not merely limited: it treats
 * a `NO` on a routine command as fatal and reconnects forever. Swipe-to-delete
 * is `+FLAGS (\Deleted)` then EXPUNGE, or a MOVE to Trash, so these three are
 * the same trap `/flags` was. That is why so much of what follows asserts what
 * must NOT fail — an unknown uid, a same-folder move, an empty batch.
 *
 * The semantics under test, settled in DEV-671:
 *
 *   - `\Deleted` alone changes nothing about placement.
 *   - EXPUNGE **relocates to Trash** in every folder except Trash.
 *   - EXPUNGE **destroys** in Trash, and nowhere else.
 *
 * Field names are literal on purpose: `uids`/`destination` in, and
 * `copied`/`moved`/`expunged` with `sourceUid`/`destUid` out, are the Go
 * struct tags on the other side. A rename here leaves those fields silently
 * zero rather than erroring.
 */

import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { IMAP_MESSAGES_MAX_LIMIT } from "../workers/durableObject";
import { IMAP_API_BASE, type ImapApiEnv, imapApi } from "../workers/routes/imap-api";
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

interface SeedEmail {
	id: string;
	folder: string;
	uid: number;
	read?: 0 | 1;
	starred?: 0 | 1;
	answered?: 0 | 1;
	deleted?: 0 | 1;
	flags?: string | null;
	rawKey?: string | null;
}

/**
 * Insert straight into SQLite so a test can pin the exact uid and flag state.
 *
 * `uid_next` is nudged past the seeded uid the same way createEmail's
 * allocator would have left it. Without that, the folder still thinks uid 1 is
 * free and the first COPY into it collides with the unique (folder_id, uid)
 * index — an artefact of hand-seeding, not a product bug, but one that would
 * make every allocation test lie.
 */
async function seed(stub: MailboxStub, email: SeedEmail): Promise<void> {
	await exec(
		stub,
		`INSERT INTO emails (
			id, folder_id, subject, sender, recipient, date, body,
			uid, read, starred, answered, deleted, flags, raw_key
		) VALUES (?1, ?2, ?3, 'sender@example.com', 'recipient@example.com',
		          '2026-03-01T10:00:00.000Z', 'body', ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
		email.id,
		email.folder,
		`Subject ${email.id}`,
		email.uid,
		email.read ?? 0,
		email.starred ?? 0,
		email.answered ?? 0,
		email.deleted ?? 0,
		email.flags ?? null,
		email.rawKey ?? null,
	);
	await exec(
		stub,
		`UPDATE folders SET uid_next = MAX(uid_next, ?2) WHERE id = ?1`,
		email.folder,
		email.uid + 1,
	);
}

async function seedAttachment(
	stub: MailboxStub,
	attachment: { id: string; emailId: string; filename: string },
): Promise<void> {
	await exec(
		stub,
		`INSERT INTO attachments (id, email_id, filename, mimetype, size)
		 VALUES (?1, ?2, ?3, 'text/plain', 5)`,
		attachment.id,
		attachment.emailId,
		attachment.filename,
	);
}

interface Relocated {
	sourceUid: number;
	destUid: number;
}

async function post(
	mailboxId: string,
	folder: string,
	verb: string,
	body: unknown,
): Promise<Response> {
	return app.request(
		`${IMAP_API_BASE}/${mailboxId}/${folder}/${verb}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
		env,
	);
}

async function copyOk(
	mailboxId: string,
	folder: string,
	destination: string,
	uids: number[],
): Promise<Relocated[]> {
	const res = await post(mailboxId, folder, "copy", { uids, destination });
	expect(res.status).toBe(200);
	return ((await res.json()) as { copied: Relocated[] }).copied;
}

async function moveOk(
	mailboxId: string,
	folder: string,
	destination: string,
	uids: number[],
): Promise<Relocated[]> {
	const res = await post(mailboxId, folder, "move", { uids, destination });
	expect(res.status).toBe(200);
	return ((await res.json()) as { moved: Relocated[] }).moved;
}

async function expungeOk(
	mailboxId: string,
	folder: string,
	body: unknown = {},
): Promise<number[]> {
	const res = await post(mailboxId, folder, "expunge", body);
	expect(res.status).toBe(200);
	return ((await res.json()) as { expunged: number[] }).expunged;
}

interface Placement {
	id: string;
	folder_id: string;
	uid: number | null;
	deleted: number;
	raw_key: string | null;
}

/** Every row's placement, ordered so assertions are stable. */
async function placements(stub: MailboxStub): Promise<Placement[]> {
	return query<Placement>(
		stub,
		`SELECT id, folder_id, uid, COALESCE(deleted, 0) AS deleted, raw_key
		   FROM emails ORDER BY folder_id, uid`,
	);
}

async function inFolder(stub: MailboxStub, folder: string): Promise<Placement[]> {
	return (await placements(stub)).filter((row) => row.folder_id === folder);
}

interface WireFolder {
	id: string;
	exists: number;
	unseen: number;
}

async function folders(mailboxId: string): Promise<Map<string, WireFolder>> {
	const res = await app.request(`${IMAP_API_BASE}/${mailboxId}/folders`, {}, env);
	expect(res.status).toBe(200);
	const list = (await res.json()) as WireFolder[];
	return new Map(list.map((f) => [f.id, f]));
}

async function messageUids(mailboxId: string, folder: string): Promise<number[]> {
	const res = await app.request(`${IMAP_API_BASE}/${mailboxId}/${folder}/messages`, {}, env);
	expect(res.status).toBe(200);
	const page = (await res.json()) as { messages: { uid: number }[] };
	return page.messages.map((m) => m.uid);
}

// ── COPY ──────────────────────────────────────────────────────────────

describe("copy", () => {
	it("leaves the source intact and creates a destination row with a new uid", async () => {
		const { id, stub } = await makeMailbox("copy-basic");
		await seed(stub, { id: "m1", folder: "inbox", uid: 3 });
		await seed(stub, { id: "m2", folder: "inbox", uid: 4 });
		// Archive already holds something, so the minted uids are provably
		// allocated rather than coincidentally 1 and 2.
		await seed(stub, { id: "a1", folder: "archive", uid: 8 });

		const copied = await copyOk(id, "inbox", "archive", [3, 4]);
		expect(copied).toEqual([
			{ sourceUid: 3, destUid: 9 },
			{ sourceUid: 4, destUid: 10 },
		]);

		// Source untouched, in place, with its original uids.
		expect((await inFolder(stub, "inbox")).map((r) => [r.id, r.uid])).toEqual([
			["m1", 3],
			["m2", 4],
		]);
		expect((await inFolder(stub, "archive")).map((r) => r.uid)).toEqual([8, 9, 10]);
	});

	it("shares the source's raw R2 object instead of duplicating the bytes", async () => {
		const { id, stub } = await makeMailbox("copy-rawkey");
		const key = "raw/copy-rawkey/m1.eml";
		await seed(stub, { id: "m1", folder: "inbox", uid: 1, rawKey: key });

		await copyOk(id, "inbox", "archive", [1]);

		const rows = await placements(stub);
		expect(rows).toHaveLength(2);
		// Same key on both rows: one object in R2, two messages pointing at it.
		expect(rows.every((row) => row.raw_key === key)).toBe(true);
		expect(new Set(rows.map((row) => row.id)).size).toBe(2);
	});

	it("preserves flags on the copy, \\Deleted included (RFC 9051 §6.4.7)", async () => {
		const { id, stub } = await makeMailbox("copy-flags");
		await seed(stub, {
			id: "m1",
			folder: "inbox",
			uid: 1,
			read: 1,
			deleted: 1,
			flags: JSON.stringify(["$Work"]),
		});

		const copied = await copyOk(id, "inbox", "archive", [1]);

		const page = await app.request(
			`${IMAP_API_BASE}/${id}/archive/messages`,
			{},
			env,
		);
		const body = (await page.json()) as { messages: { uid: number; flags: string[] }[] };
		const copy = body.messages.find((m) => m.uid === copied[0].destUid);
		expect(copy?.flags).toEqual(["\\Seen", "\\Deleted", "$Work"]);
	});

	it("does not copy attachment rows, because a blob key names its owning email", async () => {
		// Blobs live at attachments/{emailId}/{attachmentId}/{filename}, so a
		// copy could not address the original's bytes. Copying the rows anyway
		// would advertise attachments that 404 on download.
		const { id, stub } = await makeMailbox("copy-attachments");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1, rawKey: "raw/x/m1.eml" });
		await seedAttachment(stub, { id: "att1", emailId: "m1", filename: "note.txt" });

		await copyOk(id, "inbox", "archive", [1]);

		const rows = await query<{ email_id: string }>(stub, `SELECT email_id FROM attachments`);
		expect(rows).toEqual([{ email_id: "m1" }]);
	});

	it("skips an unknown uid while still copying the rest of the batch", async () => {
		const { id, stub } = await makeMailbox("copy-missing");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1 });
		await seed(stub, { id: "m3", folder: "inbox", uid: 3 });

		const copied = await copyOk(id, "inbox", "archive", [1, 2, 3]);
		expect(copied.map((c) => c.sourceUid)).toEqual([1, 3]);
		expect(await inFolder(stub, "archive")).toHaveLength(2);
	});

	it("reports the existing uid when the destination is the folder it is already in", async () => {
		const { id, stub } = await makeMailbox("copy-same");
		await seed(stub, { id: "m1", folder: "inbox", uid: 5 });

		const copied = await copyOk(id, "inbox", "inbox", [5]);
		expect(copied).toEqual([{ sourceUid: 5, destUid: 5 }]);
		// No duplicate row and no uid churn.
		expect(await placements(stub)).toHaveLength(1);
		expect(await folderUidNext(stub, "inbox")).toBe(6);
	});

	it("accepts an empty batch as a no-op", async () => {
		const { id, stub } = await makeMailbox("copy-empty");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1 });

		const res = await post(id, "inbox", "copy", { uids: [], destination: "archive" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ copied: [] });
		expect(await placements(stub)).toHaveLength(1);
	});
});

// ── MOVE ──────────────────────────────────────────────────────────────

describe("move", () => {
	it("retires the source uid and mints a new one in the destination", async () => {
		const { id, stub } = await makeMailbox("move-basic");
		await seed(stub, { id: "m1", folder: "inbox", uid: 3 });
		await seed(stub, { id: "m2", folder: "inbox", uid: 4 });
		await seed(stub, { id: "t1", folder: "trash", uid: 6 });

		const moved = await moveOk(id, "inbox", "trash", [3, 4]);
		expect(moved).toEqual([
			{ sourceUid: 3, destUid: 7 },
			{ sourceUid: 4, destUid: 8 },
		]);

		expect(await inFolder(stub, "inbox")).toEqual([]);
		expect((await inFolder(stub, "trash")).map((r) => [r.id, r.uid])).toEqual([
			["t1", 6],
			["m1", 7],
			["m2", 8],
		]);
	});

	it("never reuses a uid in either folder afterwards", async () => {
		// uid_next only ever climbs. A client that cached uid 1 in the inbox
		// must never be handed a different message under that uid.
		const { id, stub } = await makeMailbox("move-uid-reuse");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1 });
		await seed(stub, { id: "m2", folder: "inbox", uid: 2 });

		expect(await moveOk(id, "inbox", "trash", [1])).toEqual([
			{ sourceUid: 1, destUid: 1 },
		]);
		// The inbox gave up uid 1 and did not take it back.
		expect(await folderUidNext(stub, "inbox")).toBe(3);

		// Move the second message across and then back again: three distinct
		// allocations, none of them recycling a retired number.
		expect(await moveOk(id, "inbox", "trash", [2])).toEqual([
			{ sourceUid: 2, destUid: 2 },
		]);
		expect(await moveOk(id, "trash", "inbox", [2])).toEqual([
			{ sourceUid: 2, destUid: 3 },
		]);

		expect(await folderUidNext(stub, "inbox")).toBe(4);
		expect(await folderUidNext(stub, "trash")).toBe(3);
		expect((await placements(stub)).map((r) => [r.folder_id, r.id, r.uid])).toEqual([
			["inbox", "m2", 3],
			["trash", "m1", 1],
		]);
	});

	it("skips an unknown uid while still moving the rest of the batch", async () => {
		const { id, stub } = await makeMailbox("move-missing");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1 });
		await seed(stub, { id: "m3", folder: "inbox", uid: 3 });

		const moved = await moveOk(id, "inbox", "archive", [1, 2, 3]);
		expect(moved.map((m) => m.sourceUid)).toEqual([1, 3]);
		expect(await inFolder(stub, "inbox")).toEqual([]);
		expect(await inFolder(stub, "archive")).toHaveLength(2);
	});

	it("is a no-op when the destination is the folder the message is already in", async () => {
		const { id, stub } = await makeMailbox("move-same");
		await seed(stub, { id: "m1", folder: "inbox", uid: 5 });

		const moved = await moveOk(id, "inbox", "inbox", [5]);
		expect(moved).toEqual([{ sourceUid: 5, destUid: 5 }]);
		expect((await inFolder(stub, "inbox")).map((r) => r.uid)).toEqual([5]);
		expect(await folderUidNext(stub, "inbox")).toBe(6);
	});
});

// ── EXPUNGE ───────────────────────────────────────────────────────────

describe("expunge outside Trash", () => {
	it("relocates to Trash rather than destroying", async () => {
		const { id, stub } = await makeMailbox("expunge-relocate");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1, deleted: 1 });

		expect(await expungeOk(id, "inbox", { uids: [1] })).toEqual([1]);

		expect(await inFolder(stub, "inbox")).toEqual([]);
		const trash = await inFolder(stub, "trash");
		expect(trash.map((r) => r.id)).toEqual(["m1"]);
		expect(trash[0].uid).toBe(1);
	});

	it("clears \\Deleted on the relocated message so Trash is not pre-armed", async () => {
		// Leaving the flag set would mean the next EXPUNGE anyone issues in
		// Trash destroys everything that was ever swipe-deleted.
		const { id, stub } = await makeMailbox("expunge-clears-flag");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1, deleted: 1 });

		await expungeOk(id, "inbox", { uids: [1] });
		expect((await inFolder(stub, "trash"))[0].deleted).toBe(0);

		// Proof of the consequence: expunging Trash now removes nothing.
		expect(await expungeOk(id, "trash", {})).toEqual([]);
		expect(await inFolder(stub, "trash")).toHaveLength(1);
	});

	it("takes exactly the \\Deleted set and nothing else when no uid list is given", async () => {
		const { id, stub } = await makeMailbox("expunge-all-deleted");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1, deleted: 1 });
		await seed(stub, { id: "m2", folder: "inbox", uid: 2 });
		await seed(stub, { id: "m3", folder: "inbox", uid: 3, deleted: 1 });
		await seed(stub, { id: "m4", folder: "inbox", uid: 4, read: 1, starred: 1 });
		// A \Deleted message in another folder must not be swept up.
		await seed(stub, { id: "s1", folder: "sent", uid: 1, deleted: 1 });

		expect(await expungeOk(id, "inbox", {})).toEqual([1, 3]);

		expect((await inFolder(stub, "inbox")).map((r) => r.id)).toEqual(["m2", "m4"]);
		expect((await inFolder(stub, "trash")).map((r) => r.id)).toEqual(["m1", "m3"]);
		expect((await inFolder(stub, "sent")).map((r) => r.id)).toEqual(["s1"]);
	});

	it("treats a uid list as a restriction on the \\Deleted set, never an extension", async () => {
		// RFC 4315 UID EXPUNGE. A uid named without \Deleted set is left alone;
		// otherwise this endpoint would be an arbitrary delete primitive.
		const { id, stub } = await makeMailbox("expunge-restrict");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1, deleted: 1 });
		await seed(stub, { id: "m2", folder: "inbox", uid: 2 });
		await seed(stub, { id: "m3", folder: "inbox", uid: 3, deleted: 1 });

		// uid 2 is not \Deleted; uid 9 does not exist. Both are skipped.
		expect(await expungeOk(id, "inbox", { uids: [1, 2, 9] })).toEqual([1]);

		expect((await inFolder(stub, "inbox")).map((r) => r.id)).toEqual(["m2", "m3"]);
	});

	it("accepts a body with no uids, a null uids, and no body at all", async () => {
		const { id, stub } = await makeMailbox("expunge-bodies");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1 });

		expect(await expungeOk(id, "inbox", {})).toEqual([]);
		expect(await expungeOk(id, "inbox", { uids: null })).toEqual([]);

		const noBody = await app.request(
			`${IMAP_API_BASE}/${id}/inbox/expunge`,
			{ method: "POST" },
			env,
		);
		expect(noBody.status).toBe(200);
		expect(await noBody.json()).toEqual({ expunged: [] });
	});
});

describe("expunge inside Trash", () => {
	it("destroys the row and purges the R2 objects it alone owned", async () => {
		const { id, stub } = await makeMailbox("expunge-destroys");
		const rawKey = "raw/expunge-destroys/m1.eml";
		await env.BUCKET.put(rawKey, "raw bytes");
		await env.BUCKET.put("attachments/m1/att1/note.txt", "hello");
		await seed(stub, { id: "m1", folder: "trash", uid: 1, deleted: 1, rawKey });
		await seedAttachment(stub, { id: "att1", emailId: "m1", filename: "note.txt" });

		expect(await expungeOk(id, "trash", { uids: [1] })).toEqual([1]);

		expect(await placements(stub)).toEqual([]);
		// Attachment rows go with the email via ON DELETE CASCADE.
		expect(await query(stub, `SELECT id FROM attachments`)).toEqual([]);
		expect(await env.BUCKET.head(rawKey)).toBeNull();
		expect(await env.BUCKET.head("attachments/m1/att1/note.txt")).toBeNull();
	});

	it("leaves a shared raw object alone while any other row still points at it", async () => {
		// This is the COPY interaction: two rows, one set of bytes. Deleting
		// the object with the first row would strand the survivor.
		const { id, stub } = await makeMailbox("expunge-shared-raw");
		const rawKey = "raw/expunge-shared-raw/m1.eml";
		await env.BUCKET.put(rawKey, "raw bytes");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1, rawKey });

		const copied = await copyOk(id, "inbox", "trash", [1]);
		await post(id, "trash", "flags", {
			updates: [{ uid: copied[0].destUid, add: ["\\Deleted"] }],
		});

		expect(await expungeOk(id, "trash", {})).toEqual([copied[0].destUid]);

		// The copy is gone; the original and its bytes are not.
		expect((await placements(stub)).map((r) => r.id)).toEqual(["m1"]);
		expect(await env.BUCKET.head(rawKey)).not.toBeNull();

		// Now destroy the last referrer: inbox expunge relocates it to Trash,
		// a second expunge there destroys it, and only then is the key purged.
		await post(id, "inbox", "flags", { updates: [{ uid: 1, add: ["\\Deleted"] }] });
		await expungeOk(id, "inbox", {});
		await post(id, "trash", "flags", { updates: [{ uid: 2, add: ["\\Deleted"] }] });
		expect(await expungeOk(id, "trash", {})).toEqual([2]);

		expect(await placements(stub)).toEqual([]);
		expect(await env.BUCKET.head(rawKey)).toBeNull();
	});

	it("destroys only the \\Deleted messages in Trash", async () => {
		const { id, stub } = await makeMailbox("expunge-trash-subset");
		await seed(stub, { id: "t1", folder: "trash", uid: 1, deleted: 1 });
		await seed(stub, { id: "t2", folder: "trash", uid: 2 });
		await seed(stub, { id: "t3", folder: "trash", uid: 3, deleted: 1 });

		expect(await expungeOk(id, "trash", {})).toEqual([1, 3]);
		expect((await placements(stub)).map((r) => r.id)).toEqual(["t2"]);
	});
});

// ── Validation and errors ─────────────────────────────────────────────

describe("validation", () => {
	it("404s an unknown destination without saying anything about the mailbox", async () => {
		const { id, stub } = await makeMailbox("dest-404");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1 });

		for (const verb of ["copy", "move"]) {
			const res = await post(id, "inbox", verb, { uids: [1], destination: "nosuchfolder" });
			expect(res.status, verb).toBe(404);
			expect(await res.json()).toEqual({ error: "Folder not found" });
		}

		// Nothing moved, nothing copied.
		expect(await placements(stub)).toHaveLength(1);
	});

	it("404s an unknown source folder and an unknown mailbox, distinctly", async () => {
		const { id, stub } = await makeMailbox("source-404");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1 });

		for (const verb of ["copy", "move"]) {
			const res = await post(id, "nosuchfolder", verb, { uids: [1], destination: "archive" });
			expect(res.status, verb).toBe(404);
			expect(await res.json()).toEqual({ error: "Folder not found" });
		}
		const badExpunge = await post(id, "nosuchfolder", "expunge", {});
		expect(badExpunge.status).toBe(404);
		expect(await badExpunge.json()).toEqual({ error: "Folder not found" });

		for (const verb of ["copy", "move"]) {
			const res = await post("nobody@example.com", "inbox", verb, {
				uids: [1],
				destination: "archive",
			});
			expect(res.status, verb).toBe(404);
			expect(await res.json()).toEqual({ error: "Not found" });
		}
		const noMailbox = await post("nobody@example.com", "inbox", "expunge", {});
		expect(noMailbox.status).toBe(404);
		expect(await noMailbox.json()).toEqual({ error: "Not found" });
	});

	it("rejects a malformed body with 400 and no echo of the input", async () => {
		const { id, stub } = await makeMailbox("bad-body");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1 });

		const bad: unknown[] = [
			{},
			{ uids: [1] },
			{ destination: "archive" },
			{ uids: "nope", destination: "archive" },
			{ uids: [0], destination: "archive" },
			{ uids: [1.5], destination: "archive" },
			{ uids: ["1"], destination: "archive" },
			{ uids: [1], destination: "" },
			{ uids: [1], destination: "x".repeat(129) },
			{ uids: [1], destination: 7 },
		];

		for (const body of bad) {
			for (const verb of ["copy", "move"]) {
				const res = await post(id, "inbox", verb, body);
				expect(res.status, `${verb} ${JSON.stringify(body)}`).toBe(400);
				const text = await res.text();
				expect(JSON.parse(text)).toEqual({ error: "Invalid request" });
				// A zod message would carry the rejected input, uids included.
				expect(text).not.toContain("uid");
				expect(text).not.toContain("archive");
			}
		}

		const badExpunge = await post(id, "inbox", "expunge", { uids: [0] });
		expect(badExpunge.status).toBe(400);
		expect(await badExpunge.json()).toEqual({ error: "Invalid request" });

		expect(await placements(stub)).toHaveLength(1);
	});

	it("rejects a body that is not JSON at all", async () => {
		const { id } = await makeMailbox("not-json");
		for (const verb of ["copy", "move", "expunge"]) {
			const res = await app.request(
				`${IMAP_API_BASE}/${id}/inbox/${verb}`,
				{ method: "POST", headers: { "content-type": "application/json" }, body: "{" },
				env,
			);
			expect(res.status, verb).toBe(400);
			expect(await res.json()).toEqual({ error: "Invalid request" });
		}
	});

	it("rejects a batch larger than the per-request cap", async () => {
		const { id, stub } = await makeMailbox("over-cap");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1 });

		const overshoot = Array.from({ length: IMAP_MESSAGES_MAX_LIMIT + 1 }, (_, i) => i + 1);
		for (const verb of ["copy", "move"]) {
			const res = await post(id, "inbox", verb, { uids: overshoot, destination: "archive" });
			expect(res.status, verb).toBe(400);
			expect(await res.json()).toEqual({ error: "Invalid request" });
		}
		const bigExpunge = await post(id, "inbox", "expunge", { uids: overshoot });
		expect(bigExpunge.status).toBe(400);

		// Rejected whole; the one real message never moved.
		expect(await placements(stub)).toHaveLength(1);

		const atCap = await post(id, "inbox", "copy", {
			uids: overshoot.slice(0, IMAP_MESSAGES_MAX_LIMIT),
			destination: "archive",
		});
		expect(atCap.status).toBe(200);
	});
});

// ── Round trip through the read endpoints ─────────────────────────────

describe("round trip", () => {
	it("keeps the folder counts correct after a copy, a move and an expunge", async () => {
		const { id, stub } = await makeMailbox("counts");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1 });
		await seed(stub, { id: "m2", folder: "inbox", uid: 2, read: 1 });
		await seed(stub, { id: "m3", folder: "inbox", uid: 3 });

		const before = await folders(id);
		expect(before.get("inbox")).toMatchObject({ exists: 3, unseen: 2 });
		expect(before.get("archive")).toMatchObject({ exists: 0, unseen: 0 });

		// Copy an unread message: the inbox keeps it, the archive gains one.
		await copyOk(id, "inbox", "archive", [1]);
		const afterCopy = await folders(id);
		expect(afterCopy.get("inbox")).toMatchObject({ exists: 3, unseen: 2 });
		expect(afterCopy.get("archive")).toMatchObject({ exists: 1, unseen: 1 });

		// Move a read message: the inbox loses one, unseen is unchanged.
		await moveOk(id, "inbox", "archive", [2]);
		const afterMove = await folders(id);
		expect(afterMove.get("inbox")).toMatchObject({ exists: 2, unseen: 2 });
		expect(afterMove.get("archive")).toMatchObject({ exists: 2, unseen: 1 });

		// Expunge an unread one: the inbox loses it, Trash gains it.
		await post(id, "inbox", "flags", { updates: [{ uid: 3, add: ["\\Deleted"] }] });
		expect(await expungeOk(id, "inbox", {})).toEqual([3]);
		const afterExpunge = await folders(id);
		expect(afterExpunge.get("inbox")).toMatchObject({ exists: 1, unseen: 1 });
		expect(afterExpunge.get("trash")).toMatchObject({ exists: 1, unseen: 1 });
	});

	it("a moved message is fetchable in the destination and gone from the source", async () => {
		const { id, stub } = await makeMailbox("move-round-trip");
		const rawKey = "raw/move-round-trip/m1.eml";
		await env.BUCKET.put(rawKey, "From: sender@example.com\r\n\r\nhello\r\n");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1, rawKey });
		await seed(stub, { id: "m2", folder: "inbox", uid: 2 });

		const moved = await moveOk(id, "inbox", "archive", [1]);
		const destUid = moved[0].destUid;

		expect(await messageUids(id, "inbox")).toEqual([2]);
		expect(await messageUids(id, "archive")).toEqual([destUid]);

		// The raw bytes follow the message to its new uid...
		const raw = await app.request(
			`${IMAP_API_BASE}/${id}/messages/${destUid}/raw?folder=archive`,
			{},
			env,
		);
		expect(raw.status).toBe(200);
		expect(await raw.text()).toContain("hello");

		// ...and the retired source uid is a 404 in the folder it left.
		const gone = await app.request(
			`${IMAP_API_BASE}/${id}/messages/1/raw?folder=inbox`,
			{},
			env,
		);
		expect(gone.status).toBe(404);
		expect(await gone.json()).toEqual({ error: "Message not found" });
	});

	it("a copied message is fetchable at both uids from the one shared object", async () => {
		const { id, stub } = await makeMailbox("copy-round-trip");
		const rawKey = "raw/copy-round-trip/m1.eml";
		await env.BUCKET.put(rawKey, "From: sender@example.com\r\n\r\nshared body\r\n");
		await seed(stub, { id: "m1", folder: "inbox", uid: 1, rawKey });

		const copied = await copyOk(id, "inbox", "archive", [1]);

		for (const [folder, uid] of [
			["inbox", 1],
			["archive", copied[0].destUid],
		] as const) {
			const res = await app.request(
				`${IMAP_API_BASE}/${id}/messages/${uid}/raw?folder=${folder}`,
				{},
				env,
			);
			expect(res.status, folder).toBe(200);
			expect(await res.text()).toContain("shared body");
		}
	});
});
