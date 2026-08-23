// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-folder status (DEV-685):
 *
 *   GET /api/imap/v1/{mailbox}/{folder}/status
 *
 * The gateway's poll loop and its IDLE refresh want one question answered —
 * did this folder grow? — and were listing every folder in the mailbox to
 * answer it, every 30 seconds, for as long as a client sat idle.
 *
 * The load-bearing assertion in here is not any individual count: it is that
 * the status object is **byte-identical** to the matching element of
 * `/folders`. The gateway decodes both into the same `backend.Folder` struct,
 * so the two endpoints disagreeing would show up as a folder that changes
 * size depending on which call the client happened to make.
 */

import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { IMAP_API_BASE, type ImapApiEnv, imapApi } from "../workers/routes/imap-api";
import { type MailboxStub, exec, mailbox, query } from "./helpers";

const app = new Hono<{ Bindings: ImapApiEnv }>().route(IMAP_API_BASE, imapApi);

interface FolderStatus {
	id: string;
	name: string;
	uidValidity: number;
	uidNext: number;
	exists: number;
	unseen: number;
	recent: number;
}

let n = 0;
async function makeMailbox(prefix: string): Promise<{ id: string; stub: MailboxStub }> {
	n += 1;
	const id = `${prefix}-${n}@example.com`;
	await env.BUCKET.put(`mailboxes/${id}.json`, JSON.stringify({ fromName: "Test" }));
	return { id, stub: mailbox(id) };
}

/**
 * Insert straight into SQLite so a test can pin the exact uid and read flag.
 * `uid_next` is nudged past the seeded uid the same way the other IMAP tests
 * do it, because nothing here allocates one.
 */
async function seed(
	stub: MailboxStub,
	email: { id: string; folder: string; uid: number; read?: 0 | 1 },
): Promise<void> {
	await exec(
		stub,
		`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, read, body, uid)
		 VALUES (?1, ?2, ?3, 'sender@example.com', 'recipient@example.com',
		         '2026-03-01T10:00:00.000Z', ?4, 'Body', ?5)`,
		email.id,
		email.folder,
		`Subject ${email.id}`,
		email.read ?? 0,
		email.uid,
	);
	await exec(
		stub,
		`UPDATE folders SET uid_next = MAX(uid_next, ?2) WHERE id = ?1`,
		email.folder,
		email.uid + 1,
	);
}

async function status(mailboxId: string, folder: string): Promise<Response> {
	return app.request(`${IMAP_API_BASE}/${mailboxId}/${folder}/status`, {}, env);
}

async function statusOk(mailboxId: string, folder: string): Promise<FolderStatus> {
	const res = await status(mailboxId, folder);
	expect(res.status).toBe(200);
	return (await res.json()) as FolderStatus;
}

async function folders(mailboxId: string): Promise<FolderStatus[]> {
	const res = await app.request(`${IMAP_API_BASE}/${mailboxId}/folders`, {}, env);
	expect(res.status).toBe(200);
	return (await res.json()) as FolderStatus[];
}

describe("GET /{mailbox}/{folder}/status", () => {
	it("counts messages and unread messages from the folder", async () => {
		const { id, stub } = await makeMailbox("status-counts");
		await seed(stub, { id: "a", folder: "inbox", uid: 1, read: 1 });
		await seed(stub, { id: "b", folder: "inbox", uid: 2, read: 0 });
		await seed(stub, { id: "c", folder: "inbox", uid: 3, read: 0 });
		// A message in another folder must not leak into inbox's counts.
		await seed(stub, { id: "d", folder: "archive", uid: 1, read: 0 });

		const inbox = await statusOk(id, "inbox");
		expect(inbox.id).toBe("inbox");
		expect(inbox.name).toBe("Inbox");
		expect(inbox.exists).toBe(3);
		expect(inbox.unseen).toBe(2);
		expect(inbox.uidNext).toBe(4);
		expect(inbox.recent).toBe(0);

		const archive = await statusOk(id, "archive");
		expect(archive.exists).toBe(1);
		expect(archive.unseen).toBe(1);
	});

	it("reports the folder's real uidValidity, not a placeholder", async () => {
		const { id, stub } = await makeMailbox("status-uidvalidity");
		const [row] = await query<{ uid_validity: number }>(
			stub,
			`SELECT uid_validity FROM folders WHERE id = 'inbox'`,
		);

		const inbox = await statusOk(id, "inbox");
		expect(inbox.uidValidity).toBe(Number(row.uid_validity));
		// Migration 9 stamps it with strftime('%s','now'); a 1 here would mean
		// the COALESCE fallback fired and every client would resync.
		expect(inbox.uidValidity).toBeGreaterThan(1);
	});

	it("answers an empty folder with zeroes rather than 404", async () => {
		const { id } = await makeMailbox("status-empty");
		const spam = await statusOk(id, "spam");
		expect(spam).toEqual({
			id: "spam",
			name: "Spam",
			uidValidity: spam.uidValidity,
			uidNext: 1,
			exists: 0,
			unseen: 0,
			recent: 0,
		});
	});

	it("matches the corresponding entry of /folders exactly, for every folder", async () => {
		const { id, stub } = await makeMailbox("status-matches-folders");
		await seed(stub, { id: "a", folder: "inbox", uid: 1, read: 0 });
		await seed(stub, { id: "b", folder: "inbox", uid: 2, read: 1 });
		await seed(stub, { id: "c", folder: "sent", uid: 1, read: 1 });
		await seed(stub, { id: "d", folder: "trash", uid: 7, read: 0 });

		const listing = await folders(id);
		expect(listing.length).toBeGreaterThan(0);

		for (const folder of listing) {
			expect(await statusOk(id, folder.id)).toEqual(folder);
		}
	});

	it("resolves a folder by display name as tolerantly as the other routes", async () => {
		const { id, stub } = await makeMailbox("status-by-name");
		await seed(stub, { id: "a", folder: "draft", uid: 1, read: 0 });

		// "Drafts" is the display name of the folder whose id is "draft".
		const byName = await statusOk(id, "Drafts");
		const byId = await statusOk(id, "draft");
		expect(byName).toEqual(byId);
		expect(byName.id).toBe("draft");
	});

	it("404s an unknown folder without naming what does exist", async () => {
		const { id } = await makeMailbox("status-unknown-folder");
		const res = await status(id, "no-such-folder");
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Folder not found" });
	});

	it("404s an unknown mailbox before it reaches the Durable Object", async () => {
		const res = await status("never-created@example.com", "inbox");
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Not found" });
	});

	it("does not shadow the sibling routes on the same path shape", async () => {
		const { id, stub } = await makeMailbox("status-routing");
		await seed(stub, { id: "a", folder: "inbox", uid: 1, read: 0 });

		// /folders and /{folder}/messages must still resolve to themselves.
		expect((await folders(id)).some((f) => f.id === "inbox")).toBe(true);

		const messages = await app.request(`${IMAP_API_BASE}/${id}/inbox/messages`, {}, env);
		expect(messages.status).toBe(200);
		expect((await messages.json()) as { uidNext: number }).toMatchObject({ uidNext: 2 });
	});
});
