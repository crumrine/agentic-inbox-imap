// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Migration 10 adds `emails.body_structure` (DEV-678).
 *
 * The interesting property is what it *doesn't* do. There is no backfill:
 * deriving a structure for an existing row means reading its raw bytes back
 * out of R2, once per message, inside a Durable Object constructor — the
 * exact cost the precomputation exists to avoid, paid all at once and with no
 * bound on how long it takes. Existing rows keep NULL, and NULL is a complete
 * answer: the gateway parses the raw message for those, exactly as it does
 * today.
 *
 * So this test upgrades a populated pre-migration-10 mailbox and asserts the
 * rows survive untouched.
 */

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { applyMigrations, mailboxMigrations } from "../workers/durableObject/migrations";
import { mailbox, query, restart } from "./helpers";

const MIGRATION_NAME = "10_add_body_structure";

describe("migration 10_add_body_structure", () => {
	it("adds a nullable TEXT column on a fresh mailbox", async () => {
		const stub = mailbox("m10-fresh");
		await stub.getFolders();

		const applied = await query<{ name: string }>(
			stub,
			`SELECT name FROM d1_migrations ORDER BY id`,
		);
		expect(applied.map((r) => r.name)).toEqual(mailboxMigrations.map((m) => m.name));

		const columns = await query<{ name: string; type: string; notnull: number }>(
			stub,
			`SELECT name, type, "notnull" FROM pragma_table_info('emails')`,
		);
		const column = columns.find((c) => c.name === "body_structure");
		expect(column).toBeDefined();
		expect(column?.type).toBe("TEXT");
		// Nullable is the design, not an ALTER TABLE concession: NULL is how a
		// row says "no precomputed structure, fetch the raw message".
		expect(column?.notnull).toBe(0);
	});

	it("upgrades an existing mailbox without touching its rows", async () => {
		const stub = mailbox("m10-upgrade");
		await stub.getFolders();

		const rows = await runInDurableObject(stub, async (_instance, state) => {
			// Rewind to the pre-migration-10 schema and populate it.
			await state.storage.deleteAll();
			const sql = state.storage.sql;
			applyMigrations(sql, mailboxMigrations.slice(0, 9), state.storage);

			const before = [
				...sql.exec(`SELECT name FROM pragma_table_info('emails') WHERE name = 'body_structure'`),
			];
			expect(before).toHaveLength(0);

			for (const id of ["old-1", "old-2"]) {
				sql.exec(
					`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, uid, raw_key)
					 VALUES (?, 'inbox', ?, 'a@example.com', 'b@example.com',
					         '2026-01-01T00:00:00Z', 'Body', ?, ?)`,
					id,
					`Subject ${id}`,
					id === "old-1" ? 1 : 2,
					`raw/${id}.eml`,
				);
			}

			applyMigrations(sql, mailboxMigrations, state.storage);

			return [
				...sql.exec(`SELECT id, subject, raw_key, body_structure FROM emails ORDER BY id`),
			] as unknown as {
				id: string;
				subject: string;
				raw_key: string | null;
				body_structure: string | null;
			}[];
		});

		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row.subject).toBe(`Subject ${row.id}`);
			expect(row.raw_key).toBe(`raw/${row.id}.eml`);
			// No backfill: a pre-existing row keeps NULL and the gateway keeps
			// deriving BODYSTRUCTURE from the raw message for it.
			expect(row.body_structure).toBeNull();
		}
	});

	it("runs exactly once, even across Durable Object restarts", async () => {
		const name = "m10-once";
		const first = mailbox(name);
		await first.getFolders();

		const countFor = async (stub: Awaited<ReturnType<typeof restart>>) =>
			(
				await query<{ n: number }>(
					stub,
					`SELECT COUNT(*) AS n FROM d1_migrations WHERE name = ?`,
					MIGRATION_NAME,
				)
			)[0].n;

		expect(await countFor(first)).toBe(1);
		expect(await countFor(await restart(name))).toBe(1);
	});
});
