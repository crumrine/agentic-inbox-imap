// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The SPA-facing email endpoints in workers/index.ts, and the two things that
 * were wrong with them.
 *
 * **DEV-687 — the delete path leaked R2 objects, inconsistently.** It purged
 * attachment blobs and never the stored `.eml`, so every message deleted from
 * the web UI orphaned its raw bytes forever. The dangerous half was the
 * asymmetry with IMAP: COPY leaves two rows sharing one `raw_key`, and the
 * IMAP hard-delete re-checks inside its transaction whether any survivor still
 * references a key before calling it purgeable. Bolting a raw purge onto the
 * app path *without* that check would have been worse than the leak — deleting
 * one copy would silently gut the other, leaving a message the UI still lists
 * that serves no bytes over IMAP. So the tests below pin both halves: the raw
 * object goes when it is the last reference, and stays when it is not.
 *
 * **DEV-679 — internal IMAP columns leaked into the responses.** Migration 9
 * added `uid`, `answered`, `deleted`, `flags`, `rfc822_size` and `raw_key`, and
 * the two single-email reads hand back whole rows, so all six started reaching
 * the browser. `raw_key` is an internal R2 path and none of them mean anything
 * to the client. The endpoints sit behind Cloudflare Access so this was never
 * live exposure; the point of the test is the *next* column, which must not
 * cross the boundary just because someone added it to the table.
 *
 * The field names asserted here are the contract with `Email` in
 * app/types/index.ts. A field dropped from the allowlist by accident shows up
 * as a blank pane in the UI, not as an error, so both directions are asserted:
 * what must be absent and what must still be there.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { Folders } from "../shared/folders";
import { app } from "../workers/index";
import { IMAP_API_BASE, type ImapApiEnv, imapApi } from "../workers/routes/imap-api";
import type { Env } from "../workers/types";
import { type MailboxStub, mailbox, query } from "./helpers";

/** The gateway router, mounted exactly as workers/app.ts mounts it. */
const imapApp = new Hono<{ Bindings: ImapApiEnv }>().route(IMAP_API_BASE, imapApi);

let n = 0;
/** Distinct mailbox per test: Durable Object storage is keyed by this name. */
async function makeMailbox(prefix: string): Promise<{ id: string; stub: MailboxStub }> {
	n += 1;
	const id = `${prefix}-${n}@example.com`;
	await env.BUCKET.put(`mailboxes/${id}.json`, JSON.stringify({ fromName: "Test" }));
	return { id, stub: mailbox(id) };
}

async function appFetch(path: string, init: RequestInit = {}): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await app.fetch(
		new Request(`https://inbox.test${path}`, init),
		env as unknown as Env,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return res;
}

const RAW_BYTES = "From: sender@example.com\r\nSubject: Stored\r\n\r\nBody\r\n";

interface SeedOptions {
	id: string;
	folder?: string;
	rawKey?: string | null;
	threadId?: string | null;
	subject?: string;
	attachments?: { id: string; filename: string }[];
}

/**
 * Write one email through `createEmail`, so it gets a real uid from the
 * allocator rather than a hand-picked one, and put its blobs in R2.
 */
async function seed(
	stub: MailboxStub,
	{ id, folder = Folders.INBOX, rawKey = null, threadId = null, subject, attachments = [] }: SeedOptions,
): Promise<void> {
	if (rawKey) await env.BUCKET.put(rawKey, RAW_BYTES);
	for (const att of attachments) {
		await env.BUCKET.put(`attachments/${id}/${att.id}/${att.filename}`, "blob bytes");
	}

	await stub.createEmail(
		folder,
		{
			id,
			subject: subject ?? `Subject ${id}`,
			sender: "sender@example.com",
			recipient: "recipient@example.com",
			cc: "cc@example.com",
			bcc: "bcc@example.com",
			date: "2026-03-01T10:00:00.000Z",
			body: "<p>Body</p>",
			in_reply_to: null,
			email_references: null,
			thread_id: threadId,
			message_id: `${id}@example.com`,
			raw_headers: JSON.stringify([{ key: "subject", value: subject ?? `Subject ${id}` }]),
			raw_key: rawKey,
			rfc822_size: rawKey ? RAW_BYTES.length : null,
		},
		attachments.map((att) => ({
			id: att.id,
			email_id: id,
			filename: att.filename,
			mimetype: "text/plain",
			size: 10,
		})),
	);
}

async function uidOf(stub: MailboxStub, id: string): Promise<number> {
	const rows = await query<{ uid: number }>(stub, `SELECT uid FROM emails WHERE id = ?`, id);
	return rows[0].uid;
}

async function rowCount(stub: MailboxStub, id: string): Promise<number> {
	const rows = await query(stub, `SELECT 1 FROM emails WHERE id = ?`, id);
	return rows.length;
}

// ── DEV-687: the delete path and the shared raw object ───────────────

describe("DELETE /api/v1/mailboxes/{mailbox}/emails/{id}", () => {
	it("purges the stored raw .eml when the deleted row was its only reference", async () => {
		const { id, stub } = await makeMailbox("app-delete-raw");
		const rawKey = `raw/${id}/only.eml`;
		await seed(stub, { id: "only", rawKey });

		expect(await env.BUCKET.head(rawKey)).not.toBeNull();

		const res = await appFetch(`/api/v1/mailboxes/${id}/emails/only`, { method: "DELETE" });

		expect(res.status).toBe(204);
		expect(await rowCount(stub, "only")).toBe(0);
		// The whole point of DEV-687: this used to survive the delete forever.
		expect(await env.BUCKET.head(rawKey)).toBeNull();
	});

	it("still purges attachment blobs", async () => {
		const { id, stub } = await makeMailbox("app-delete-att");
		await seed(stub, {
			id: "withatt",
			attachments: [
				{ id: "a1", filename: "notes.txt" },
				{ id: "a2", filename: "second.txt" },
			],
		});

		const keys = [
			"attachments/withatt/a1/notes.txt",
			"attachments/withatt/a2/second.txt",
		];
		for (const key of keys) expect(await env.BUCKET.head(key)).not.toBeNull();

		expect((await appFetch(`/api/v1/mailboxes/${id}/emails/withatt`, { method: "DELETE" })).status).toBe(204);

		for (const key of keys) expect(await env.BUCKET.head(key)).toBeNull();
		// ON DELETE CASCADE takes the rows; the blobs are ours to remove.
		expect(
			(await query(stub, `SELECT 1 FROM attachments WHERE email_id = ?`, "withatt")).length,
		).toBe(0);
	});

	it("leaves a raw object alone while an IMAP COPY still references it, and the survivor still serves it", async () => {
		const { id, stub } = await makeMailbox("app-delete-shared");
		const rawKey = `raw/${id}/shared.eml`;
		await seed(stub, { id: "shared", rawKey });

		// COPY duplicates the row into Archive carrying raw_key verbatim: two
		// rows, one R2 object.
		const sourceUid = await uidOf(stub, "shared");
		const copy = await stub.imapCopyMessages(Folders.INBOX, Folders.ARCHIVE, [sourceUid]);
		expect(copy.status).toBe("ok");
		const destUid = copy.status === "ok" ? copy.entries[0].destUid : -1;

		expect((await appFetch(`/api/v1/mailboxes/${id}/emails/shared`, { method: "DELETE" })).status).toBe(204);

		expect(await rowCount(stub, "shared")).toBe(0);
		// Deleting one copy must not gut the other.
		expect(await env.BUCKET.head(rawKey)).not.toBeNull();

		// And the survivor is still a working message end to end, not just a
		// row: /raw streams the shared object.
		const raw = await imapApp.request(
			`${IMAP_API_BASE}/${id}/messages/${destUid}/raw?folder=${Folders.ARCHIVE}`,
			{},
			env as ImapApiEnv,
		);
		expect(raw.status).toBe(200);
		expect(await raw.text()).toBe(RAW_BYTES);
	});

	it("purges the shared raw object once the last copy is deleted too", async () => {
		const { id, stub } = await makeMailbox("app-delete-last");
		const rawKey = `raw/${id}/last.eml`;
		await seed(stub, { id: "orig", rawKey });

		const copy = await stub.imapCopyMessages(Folders.INBOX, Folders.ARCHIVE, [
			await uidOf(stub, "orig"),
		]);
		expect(copy.status).toBe("ok");
		const copyId = (
			await query<{ id: string }>(
				stub,
				`SELECT id FROM emails WHERE folder_id = ? AND raw_key = ?`,
				Folders.ARCHIVE,
				rawKey,
			)
		)[0].id;

		await appFetch(`/api/v1/mailboxes/${id}/emails/orig`, { method: "DELETE" });
		expect(await env.BUCKET.head(rawKey)).not.toBeNull();

		await appFetch(`/api/v1/mailboxes/${id}/emails/${copyId}`, { method: "DELETE" });
		expect(await env.BUCKET.head(rawKey)).toBeNull();
	});

	it("still 404s an unknown id without touching anything", async () => {
		const { id, stub } = await makeMailbox("app-delete-404");
		const rawKey = `raw/${id}/kept.eml`;
		await seed(stub, { id: "kept", rawKey });

		const res = await appFetch(`/api/v1/mailboxes/${id}/emails/nope`, { method: "DELETE" });

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Not found" });
		expect(await rowCount(stub, "kept")).toBe(1);
		expect(await env.BUCKET.head(rawKey)).not.toBeNull();
	});

	it("removes the row for a legacy message with no raw_key", async () => {
		const { id, stub } = await makeMailbox("app-delete-legacy");
		await seed(stub, { id: "legacy", rawKey: null });

		expect((await appFetch(`/api/v1/mailboxes/${id}/emails/legacy`, { method: "DELETE" })).status).toBe(204);
		expect(await rowCount(stub, "legacy")).toBe(0);
	});
});

// ── DEV-679: what the SPA is allowed to see ──────────────────────────

/** Migration-9 columns that must never reach the browser. */
const INTERNAL_FIELDS = ["raw_key", "uid", "flags", "answered", "deleted", "rfc822_size"];

/** Everything `Email` in app/types/index.ts expects from a single-email read. */
const CLIENT_FIELDS = [
	"id", "thread_id", "folder_id", "subject", "sender", "recipient",
	"cc", "bcc", "date", "read", "starred", "body", "in_reply_to",
	"email_references", "message_id", "raw_headers", "attachments",
];

function expectNarrowed(email: Record<string, unknown>): void {
	for (const field of INTERNAL_FIELDS) expect(email).not.toHaveProperty(field);
	for (const field of CLIENT_FIELDS) expect(email).toHaveProperty(field);
}

describe("SPA email reads do not leak internal IMAP columns", () => {
	it("GET /emails/{id} returns the client fields and none of the IMAP ones", async () => {
		const { id, stub } = await makeMailbox("proj-email");
		await seed(stub, { id: "e1", rawKey: `raw/${"proj"}/e1.eml`, threadId: "t1" });

		const res = await appFetch(`/api/v1/mailboxes/${id}/emails/e1`);
		expect(res.status).toBe(200);

		const email = (await res.json()) as Record<string, unknown>;
		expectNarrowed(email);

		// Values, not just key presence — the projection must copy, not blank.
		expect(email.id).toBe("e1");
		expect(email.subject).toBe("Subject e1");
		expect(email.thread_id).toBe("t1");
		expect(email.body).toBe("<p>Body</p>");
		expect(email.cc).toBe("cc@example.com");
		expect(email.read).toBe(false);
		expect(email.starred).toBe(false);
	});

	it("keeps attachment metadata on the projected email", async () => {
		const { id, stub } = await makeMailbox("proj-att");
		await seed(stub, { id: "e2", attachments: [{ id: "a1", filename: "notes.txt" }] });

		const email = (await (await appFetch(`/api/v1/mailboxes/${id}/emails/e2`)).json()) as {
			attachments: { id: string; filename: string; mimetype: string; size: number }[];
		};

		expect(email.attachments).toHaveLength(1);
		expect(email.attachments[0]).toMatchObject({
			id: "a1",
			filename: "notes.txt",
			mimetype: "text/plain",
			size: 10,
		});
	});

	it("PUT /emails/{id} echoes back a narrowed row too", async () => {
		const { id, stub } = await makeMailbox("proj-update");
		await seed(stub, { id: "e3", rawKey: `raw/${"proj"}/e3.eml` });

		const res = await appFetch(`/api/v1/mailboxes/${id}/emails/e3`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ read: true, starred: true }),
		});
		expect(res.status).toBe(200);

		const email = (await res.json()) as Record<string, unknown>;
		expectNarrowed(email);
		expect(email.read).toBe(true);
		expect(email.starred).toBe(true);
	});

	it("GET /threads/{threadId} narrows every message, not just the first", async () => {
		const { id, stub } = await makeMailbox("proj-thread");
		await seed(stub, { id: "t-a", rawKey: `raw/${"proj"}/t-a.eml`, threadId: "thr" });
		await seed(stub, { id: "t-b", folder: Folders.SENT, threadId: "thr" });

		const res = await appFetch(`/api/v1/mailboxes/${id}/threads/thr`);
		expect(res.status).toBe(200);

		const emails = (await res.json()) as Record<string, unknown>[];
		expect(emails).toHaveLength(2);
		for (const email of emails) expectNarrowed(email);
		expect(emails.map((e) => e.id).sort()).toEqual(["t-a", "t-b"]);
	});

	it("still hands the IMAP read API every column it needs", async () => {
		const { id, stub } = await makeMailbox("proj-imap");
		const rawKey = `raw/${"proj"}/imap.eml`;
		await seed(stub, { id: "m1", rawKey });

		const res = await imapApp.request(
			`${IMAP_API_BASE}/${id}/${Folders.INBOX}/messages`,
			{},
			env as ImapApiEnv,
		);
		expect(res.status).toBe(200);

		const { messages } = (await res.json()) as {
			messages: Record<string, unknown>[];
		};
		expect(messages).toHaveLength(1);
		// The gateway decodes these by name; narrowing the SPA payload must not
		// have reached this router.
		for (const field of ["uid", "flags", "rfc822Size", "hasRaw"]) {
			expect(messages[0]).toHaveProperty(field);
		}
		expect(messages[0].uid).toBe(await uidOf(stub, "m1"));
		expect(messages[0].hasRaw).toBe(true);
	});
});
