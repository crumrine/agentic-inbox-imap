// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * DEV-692 part two — automatic send-as.
 *
 * Part one made sending as an alias *permitted*. This makes it *automatic*: a
 * reply to something that arrived at `info@` goes back out as `info@`, with no
 * picker and no user action. Three things carry that, and each is pinned here
 * for a different reason:
 *
 * 1. **`emails.delivered_to` exists and is written.** The column is new
 *    (migration 11) and `receiveEmail` was already passing the key into
 *    `createEmail`, which built its INSERT from an explicit field list and so
 *    dropped it silently. A migration without the matching Drizzle column, or
 *    an INSERT that still omits the field, fails *quietly* — the reply just
 *    keeps using the mailbox address — so both halves are asserted directly
 *    against the row rather than through behaviour.
 *
 * 2. **NULL is a complete answer.** Every row that existed before the
 *    migration has NULL, there is no backfill, and one is not possible: the
 *    routing address lived in the SMTP envelope recipient, which exists only
 *    during the inbound call. So NULL has to mean "use the mailbox's own
 *    address" on every path, not "unknown, guess".
 *
 * 3. **The stored address is re-checked at send time.** This is the dangerous
 *    one. `delivered_to` was written when the message arrived; the alias can
 *    since have been deleted, or re-pointed at somebody else's mailbox — the
 *    settings page can do both. Trusting the stored string would mean sending
 *    as an address this mailbox no longer owns, which is precisely the spoof
 *    the registry exists to prevent. Both "deleted" and "re-pointed" are
 *    asserted, and asserted on the bytes handed to the send binding, not just
 *    on the stored Sent row.
 */

import {
	createExecutionContext,
	env,
	runInDurableObject,
	waitOnExecutionContext,
} from "cloudflare:test";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";

import { Folders } from "../shared/folders";
import { applyMigrations, mailboxMigrations } from "../workers/durableObject/migrations";
import { createAlias, deleteAlias } from "../workers/lib/aliases";
import { app, receiveEmail } from "../workers/index";
import {
	IMAP_API_BASE,
	type ImapApiEnv,
	imapApi,
} from "../workers/routes/imap-api";
import type { Env } from "../workers/types";
import { type MailboxStub, mailbox, query, restart } from "./helpers";

/**
 * Two fixed mailboxes for the whole file, not one per test.
 *
 * `test/setup.ts`'s afterEach walks every MailboxDO id that has ever been
 * named and wipes it, so a file that mints a fresh mailbox per test is
 * quadratic in teardown. Storage is still wiped between tests, so each one
 * gets a freshly migrated Durable Object out of these two names.
 */
const OWNER = "owner@example.com";
const OTHER = "other@example.com";
const ALIAS = "info@example.com";

const OUTSIDER = "outsider@somewhere-else.example";

let ownerStub: MailboxStub;
let otherStub: MailboxStub;

beforeEach(async () => {
	// R2 is reset between tests too, so the registry has to be rebuilt: a
	// mailbox exists iff its settings blob does.
	for (const id of [OWNER, OTHER]) {
		await env.BUCKET.put(`mailboxes/${id}.json`, JSON.stringify({ fromName: "Test" }));
	}
	ownerStub = mailbox(OWNER);
	otherStub = mailbox(OTHER);
	// Touching the stubs constructs them, which runs the migrations.
	await ownerStub.getFolders();
	await otherStub.getFolders();
});

// ── Fakes ─────────────────────────────────────────────────────────────

interface SentMessage {
	from: string | { email: string; name: string };
	to: string | string[];
	subject: string;
}

interface FakeEmail {
	binding: SendEmail;
	sent: SentMessage[];
}

/**
 * A stand-in for the `send_email` binding, which is `remote: true` and would
 * deliver real mail. What it records is the contract under test: the From the
 * route actually put on the wire, as opposed to the one it stored.
 */
function fakeEmail(): FakeEmail {
	const sent: SentMessage[] = [];
	const binding = {
		async send(message: unknown) {
			sent.push(message as SentMessage);
			return { messageId: `fake-${sent.length}` };
		},
	};
	return { binding: binding as unknown as SendEmail, sent };
}

function fromAddressOf(message: SentMessage): string {
	return typeof message.from === "string" ? message.from : message.from.email;
}

function appEnv(email: FakeEmail): Env {
	return { ...(env as unknown as Env), EMAIL: email.binding };
}

async function appFetch(
	email: FakeEmail,
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await app.fetch(new Request(`https://inbox.test${path}`, init), appEnv(email), ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

const imapApp = new Hono<{ Bindings: ImapApiEnv }>().route(IMAP_API_BASE, imapApi);

function imapEnv(email: FakeEmail): ImapApiEnv {
	return {
		BUCKET: env.BUCKET,
		EMAIL: email.binding,
		DOMAINS: env.DOMAINS,
		EMAIL_ADDRESSES: env.EMAIL_ADDRESSES,
		MAILBOX: env.MAILBOX,
		IMAP_AUTH_RATE_LIMIT: env.IMAP_AUTH_RATE_LIMIT,
	};
}

// ── Fixtures ──────────────────────────────────────────────────────────

/** Seed one inbox message, optionally recording the address it arrived at. */
async function seedInbound(
	stub: MailboxStub,
	id: string,
	deliveredTo: string | null,
): Promise<void> {
	await stub.createEmail(
		Folders.INBOX,
		{
			id,
			subject: "Question about pricing",
			sender: OUTSIDER,
			recipient: deliveredTo ?? OWNER,
			date: "2026-08-01T00:00:00Z",
			body: "<p>Hello.</p>",
			message_id: `${id}@somewhere-else.example`,
			thread_id: `${id}@somewhere-else.example`,
			...(deliveredTo === null ? {} : { delivered_to: deliveredTo }),
		},
		[],
	);
}

interface ReplyBody {
	to: string;
	subject: string;
	html: string;
	from?: string | { email: string; name: string };
	from_name?: string;
}

async function reply(
	email: FakeEmail,
	emailId: string,
	body: Partial<ReplyBody> = {},
	route: "reply" | "forward" = "reply",
): Promise<Response> {
	return appFetch(email, `/api/v1/mailboxes/${OWNER}/emails/${emailId}/${route}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			to: OUTSIDER,
			subject: "Re: Question about pricing",
			html: "<p>Sure.</p>",
			...body,
		}),
	});
}

async function sentSenders(stub: MailboxStub): Promise<string[]> {
	const rows = await query<{ sender: string }>(
		stub,
		`SELECT sender FROM emails WHERE folder_id = ? ORDER BY uid`,
		Folders.SENT,
	);
	return rows.map((r) => r.sender);
}

// ── Migration ─────────────────────────────────────────────────────────

describe("migration 11_add_delivered_to", () => {
	it("adds a nullable TEXT column, and is the last migration in the list", async () => {
		const applied = await query<{ name: string }>(
			ownerStub,
			`SELECT name FROM d1_migrations ORDER BY id`,
		);
		expect(applied.map((r) => r.name)).toEqual(mailboxMigrations.map((m) => m.name));

		const columns = await query<{ name: string; type: string; notnull: number }>(
			ownerStub,
			`SELECT name, type, "notnull" FROM pragma_table_info('emails')`,
		);
		const column = columns.find((c) => c.name === "delivered_to");
		expect(column).toBeDefined();
		expect(column?.type).toBe("TEXT");
		// Nullable is the design: NULL means "not known", and every reader
		// falls back to the mailbox's own address for it.
		expect(column?.notnull).toBe(0);
	});

	it("upgrades a mailbox that already has rows, leaving them intact and NULL", async () => {
		const rows = await runInDurableObject(ownerStub, async (_instance, state) => {
			// Rewind to the pre-migration-11 schema and populate it, so the
			// ALTER TABLE runs against a table that is not empty.
			await state.storage.deleteAll();
			const sql = state.storage.sql;
			applyMigrations(sql, mailboxMigrations.slice(0, 10), state.storage);

			expect([
				...sql.exec(
					`SELECT name FROM pragma_table_info('emails') WHERE name = 'delivered_to'`,
				),
			]).toHaveLength(0);

			for (const [i, id] of ["old-1", "old-2"].entries()) {
				sql.exec(
					`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, uid)
					 VALUES (?, 'inbox', ?, ?, ?, '2026-01-01T00:00:00Z', 'Body', ?)`,
					id,
					`Subject ${id}`,
					OUTSIDER,
					OWNER,
					i + 1,
				);
			}

			applyMigrations(sql, mailboxMigrations, state.storage);

			return [
				...sql.exec(`SELECT id, subject, recipient, delivered_to FROM emails ORDER BY id`),
			] as unknown as {
				id: string;
				subject: string;
				recipient: string;
				delivered_to: string | null;
			}[];
		});

		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row.subject).toBe(`Subject ${row.id}`);
			expect(row.recipient).toBe(OWNER);
			// No backfill, and none is possible: the envelope recipient that
			// knew the answer existed only during the inbound call.
			expect(row.delivered_to).toBeNull();
		}
	});

	it("runs exactly once, even across Durable Object restarts", async () => {
		const countFor = async (stub: MailboxStub) =>
			(
				await query<{ n: number }>(
					stub,
					`SELECT COUNT(*) AS n FROM d1_migrations WHERE name = ?`,
					"11_add_delivered_to",
				)
			)[0].n;

		expect(await countFor(ownerStub)).toBe(1);
		expect(await countFor(await restart(OWNER))).toBe(1);
	});
});

// ── Write path ────────────────────────────────────────────────────────

describe("delivered_to is actually stored", () => {
	it("createEmail persists it instead of dropping the key", async () => {
		// This is the regression the column exists to fix: createEmail builds
		// its INSERT from an explicit field list, so before migration 11 the
		// key `receiveEmail` was already passing went nowhere and nothing
		// failed.
		await seedInbound(ownerStub, "m1", ALIAS);
		const rows = await query<{ delivered_to: string | null }>(
			ownerStub,
			`SELECT delivered_to FROM emails WHERE id = 'm1'`,
		);
		expect(rows[0].delivered_to).toBe(ALIAS);
	});

	it("leaves it NULL when the caller does not supply one", async () => {
		await seedInbound(ownerStub, "m2", null);
		const rows = await query<{ delivered_to: string | null }>(
			ownerStub,
			`SELECT delivered_to FROM emails WHERE id = 'm2'`,
		);
		expect(rows[0].delivered_to).toBeNull();
	});

	it("records the alias a real inbound message routed through", async () => {
		await createAlias(env as unknown as Env, ALIAS, OWNER);

		const bytes = new TextEncoder().encode(
			[
				`From: ${OUTSIDER}`,
				`To: ${ALIAS}`,
				"Subject: Routed by alias",
				"Date: Sat, 22 Aug 2026 00:00:00 +0000",
				"MIME-Version: 1.0",
				'Content-Type: text/plain; charset="UTF-8"',
				"",
				"Hello.",
				"",
			].join("\r\n"),
		);
		const ctx = createExecutionContext();
		await receiveEmail(
			{
				raw: new ReadableStream({
					start(controller) {
						controller.enqueue(bytes);
						controller.close();
					},
				}),
				rawSize: bytes.byteLength,
				to: ALIAS,
			},
			env as unknown as Env,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		const rows = await query<{ subject: string; delivered_to: string | null }>(
			ownerStub,
			`SELECT subject, delivered_to FROM emails WHERE folder_id = 'inbox'`,
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].subject).toBe("Routed by alias");
		expect(rows[0].delivered_to).toBe(ALIAS);
	});
});

// ── Read path ─────────────────────────────────────────────────────────

describe("delivered_to reaches the client", () => {
	it("GET /emails/{id} includes it, and still excludes the internal columns", async () => {
		await seedInbound(ownerStub, "m3", ALIAS);
		const res = await appFetch(fakeEmail(), `/api/v1/mailboxes/${OWNER}/emails/m3`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as Record<string, unknown>;
		expect(body.delivered_to).toBe(ALIAS);
		// DEV-679/DEV-688: widening the allowlist by one must not widen it by
		// six. `raw_key` in particular names an object in R2.
		for (const leaked of ["uid", "answered", "deleted", "flags", "rfc822_size", "raw_key"]) {
			expect(body).not.toHaveProperty(leaked);
		}
	});
});

// ── Automatic send-as ─────────────────────────────────────────────────

describe("reply defaults the From to the address the message arrived at", () => {
	it("replies as the alias when the original was delivered to one", async () => {
		await createAlias(env as unknown as Env, ALIAS, OWNER);
		await seedInbound(ownerStub, "m4", ALIAS);

		const email = fakeEmail();
		expect((await reply(email, "m4")).status).toBe(202);

		// The bytes on the wire, and the Sent row, must agree.
		expect(email.sent).toHaveLength(1);
		expect(fromAddressOf(email.sent[0])).toBe(ALIAS);
		expect(await sentSenders(ownerStub)).toEqual([ALIAS]);
	});

	it("forwards as the alias too", async () => {
		await createAlias(env as unknown as Env, ALIAS, OWNER);
		await seedInbound(ownerStub, "m5", ALIAS);

		const email = fakeEmail();
		expect((await reply(email, "m5", {}, "forward")).status).toBe(202);
		expect(fromAddressOf(email.sent[0])).toBe(ALIAS);
	});

	it("keeps the display name the client asked for on the chosen address", async () => {
		await createAlias(env as unknown as Env, ALIAS, OWNER);
		await seedInbound(ownerStub, "m6", ALIAS);

		const email = fakeEmail();
		expect((await reply(email, "m6", { from_name: "Sales" })).status).toBe(202);
		expect(email.sent[0].from).toEqual({ email: ALIAS, name: "Sales" });
	});

	it("falls back to the mailbox address when delivered_to is NULL", async () => {
		// Every message received before migration 11 looks like this, and
		// there is no backfill, so this is the common case for a while.
		await seedInbound(ownerStub, "m7", null);

		const email = fakeEmail();
		expect((await reply(email, "m7")).status).toBe(202);
		expect(fromAddressOf(email.sent[0])).toBe(OWNER);
		expect(await sentSenders(ownerStub)).toEqual([OWNER]);
	});

	it("uses the mailbox address when the message came in on it directly", async () => {
		await seedInbound(ownerStub, "m8", OWNER);

		const email = fakeEmail();
		expect((await reply(email, "m8")).status).toBe(202);
		expect(fromAddressOf(email.sent[0])).toBe(OWNER);
	});

	it("still honours a From the caller named explicitly", async () => {
		await createAlias(env as unknown as Env, ALIAS, OWNER);
		await seedInbound(ownerStub, "m9", ALIAS);

		// An API client that does pick an address keeps getting it — the
		// default only fills a gap.
		const email = fakeEmail();
		expect((await reply(email, "m9", { from: OWNER })).status).toBe(202);
		expect(fromAddressOf(email.sent[0])).toBe(OWNER);
	});

	it("still rejects a From the caller named that it does not own", async () => {
		await seedInbound(ownerStub, "m10", null);

		const email = fakeEmail();
		const res = await reply(email, "m10", { from: "ceo@somewhere-else.example" });
		expect(res.status).toBe(400);
		expect(email.sent).toHaveLength(0);
	});

	it("replies from the message being answered, not from the draft answering it", async () => {
		await createAlias(env as unknown as Env, ALIAS, OWNER);
		await seedInbound(ownerStub, "m11", ALIAS);
		// A draft row has no delivered_to of its own; resolveOriginalEmail is
		// what makes the reply read the original's.
		await ownerStub.createEmail(
			Folders.DRAFT,
			{
				id: "d1",
				subject: "Re: Question about pricing",
				sender: OWNER,
				recipient: OUTSIDER,
				date: "2026-08-02T00:00:00Z",
				body: "<p>Draft.</p>",
				in_reply_to: "m11",
			},
			[],
		);

		const email = fakeEmail();
		expect((await reply(email, "d1")).status).toBe(202);
		expect(fromAddressOf(email.sent[0])).toBe(ALIAS);
	});
});

// ── The security case ─────────────────────────────────────────────────

describe("the stored delivered_to is re-validated at send time", () => {
	it("does NOT send as an alias that has since been deleted", async () => {
		await createAlias(env as unknown as Env, ALIAS, OWNER);
		await seedInbound(ownerStub, "m12", ALIAS);

		// The row still names info@; the registry no longer does. The address
		// may have been handed to somebody else by now.
		expect(await deleteAlias(env as unknown as Env, ALIAS, OWNER)).toBe(true);

		const email = fakeEmail();
		expect((await reply(email, "m12")).status).toBe(202);
		expect(fromAddressOf(email.sent[0])).toBe(OWNER);
		expect(await sentSenders(ownerStub)).toEqual([OWNER]);
	});

	it("does NOT send as an alias that has since been re-pointed elsewhere", async () => {
		await createAlias(env as unknown as Env, ALIAS, OWNER);
		await seedInbound(ownerStub, "m13", ALIAS);

		// Re-pointing is a supported operation, so this is not a hypothetical.
		const repointed = await createAlias(env as unknown as Env, ALIAS, OTHER, {
			allowRepoint: true,
		});
		expect(repointed.ok).toBe(true);

		const email = fakeEmail();
		expect((await reply(email, "m13")).status).toBe(202);
		// Sending as info@ here would be sending as an address that now
		// belongs to a different mailbox.
		expect(fromAddressOf(email.sent[0])).toBe(OWNER);
		expect(await sentSenders(ownerStub)).toEqual([OWNER]);
		expect(await sentSenders(otherStub)).toEqual([]);
	});

	it("does NOT send as an address written into delivered_to that was never an alias", async () => {
		// A row can carry anything — a hand-written record, a future code path
		// with a bug. Nothing downstream may treat the column as proof.
		await seedInbound(ownerStub, "m14", "ceo@example.com");

		const email = fakeEmail();
		expect((await reply(email, "m14")).status).toBe(202);
		expect(fromAddressOf(email.sent[0])).toBe(OWNER);
	});

	it("does not fail the send when the alias has gone — it just uses the mailbox", async () => {
		await seedInbound(ownerStub, "m15", "gone@example.com");

		// The fallback address is the one address the mailbox can always send
		// as, so falling back is always safe; refusing the reply because a
		// piece of configuration changed underneath the user would not be.
		const email = fakeEmail();
		const res = await reply(email, "m15");
		expect(res.status).toBe(202);
		expect(email.sent).toHaveLength(1);
	});
});

// ── SMTP submission ───────────────────────────────────────────────────

describe("SMTP submission accepts a verified alias", () => {
	function rawMessage(from: string): string {
		return [
			`From: ${from}`,
			`To: ${OUTSIDER}`,
			"Subject: From my phone",
			"Date: Wed, 12 Mar 2026 09:14:00 +0000",
			"Message-ID: <phone-1@example.com>",
			"MIME-Version: 1.0",
			'Content-Type: text/plain; charset="utf-8"',
			"",
			"Sent from my phone.",
			"",
		].join("\r\n");
	}

	async function submit(email: FakeEmail, from: string): Promise<Response> {
		const search = new URLSearchParams({ envelopeFrom: from, envelopeTo: OUTSIDER });
		return imapApp.request(
			`${IMAP_API_BASE}/${OWNER}/submit?${search.toString()}`,
			{
				method: "POST",
				headers: { "content-type": "message/rfc822" },
				body: rawMessage(from),
			},
			imapEnv(email),
		);
	}

	it("lets a mail client send as an alias of its mailbox", async () => {
		await createAlias(env as unknown as Env, ALIAS, OWNER);

		// The whole point: iOS Mail has no server-side reply flow to pick the
		// address for it, so it has to be allowed to say the address itself.
		const email = fakeEmail();
		expect((await submit(email, ALIAS)).status).toBe(200);
		expect(await sentSenders(ownerStub)).toEqual([ALIAS]);
	});

	it("still refuses an alias belonging to a different mailbox", async () => {
		await createAlias(env as unknown as Env, ALIAS, OTHER);

		const email = fakeEmail();
		const res = await submit(email, ALIAS);
		expect(res.status).toBe(403);
		expect(await sentSenders(ownerStub)).toEqual([]);
	});

	it("still refuses an unregistered address on the mailbox's own domain", async () => {
		// A domain check would accept this; only a per-address record can tell
		// it apart from the alias next to it.
		const email = fakeEmail();
		expect((await submit(email, "billing@example.com")).status).toBe(403);
	});

	it("still refuses an address on somebody else's domain", async () => {
		const email = fakeEmail();
		expect((await submit(email, OUTSIDER)).status).toBe(403);
	});
});
