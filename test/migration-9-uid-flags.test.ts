// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
	applyMigrations,
	mailboxMigrations,
} from "../workers/durableObject/migrations";
import { exec, mailbox, query, restart } from "./helpers";

const MIGRATION_NAME = "9_imap_uid_flags";

describe("migration 9_imap_uid_flags", () => {
	it("applies cleanly on a fresh mailbox", async () => {
		const stub = mailbox("m9-fresh");
		await stub.getFolders();

		const applied = await query<{ name: string }>(
			stub,
			`SELECT name FROM d1_migrations ORDER BY id`,
		);
		expect(applied.map((r) => r.name)).toEqual(
			mailboxMigrations.map((m) => m.name),
		);

		const folderCols = await query<{ name: string; notnull: number; dflt_value: string | null }>(
			stub,
			`SELECT name, "notnull", dflt_value FROM pragma_table_info('folders')`,
		);
		const folderColMap = new Map(folderCols.map((c) => [c.name, c]));
		expect(folderColMap.has("uid_validity")).toBe(true);
		expect(folderColMap.has("uid_next")).toBe(true);
		// UIDVALIDITY is an identity value; no row may omit it after the
		// forward constraint migration has run.
		expect(folderColMap.get("uid_validity")?.notnull).toBe(1);
		// uid_next must be NOT NULL DEFAULT 1 -- allowed because 1 is a constant.
		expect(folderColMap.get("uid_next")?.notnull).toBe(1);
		expect(folderColMap.get("uid_next")?.dflt_value).toBe("1");

		const emailCols = await query<{ name: string; dflt_value: string | null }>(
			stub,
			`SELECT name, dflt_value FROM pragma_table_info('emails')`,
		);
		const emailColMap = new Map(emailCols.map((c) => [c.name, c]));
		for (const col of ["uid", "answered", "deleted", "flags", "rfc822_size", "raw_key"]) {
			expect(emailColMap.has(col), `emails.${col} exists`).toBe(true);
		}
		expect(emailColMap.get("answered")?.dflt_value).toBe("0");
		expect(emailColMap.get("deleted")?.dflt_value).toBe("0");

		// read/starred are untouched -- they are the \Seen and \Flagged mapping.
		expect(emailColMap.get("read")?.dflt_value).toBe("0");
		expect(emailColMap.get("starred")?.dflt_value).toBe("0");

		const indexes = await query<{ name: string; unique: number }>(
			stub,
			`SELECT name, "unique" FROM pragma_index_list('emails')`,
		);
		const uidIndex = indexes.find((i) => i.name === "idx_emails_folder_uid");
		expect(uidIndex).toBeDefined();
		expect(uidIndex?.unique).toBe(1);
		const indexCols = await query<{ name: string }>(
			stub,
			`SELECT name FROM pragma_index_info('idx_emails_folder_uid')`,
		);
		expect(indexCols.map((c) => c.name)).toEqual(["folder_id", "uid"]);

		// Every seeded folder gets a uid_validity and an empty uid sequence.
		const folders = await query<{
			id: string;
			uid_validity: number | null;
			uid_next: number;
		}>(stub, `SELECT id, uid_validity, uid_next FROM folders ORDER BY id`);
		expect(folders).toHaveLength(6);
		for (const folder of folders) {
			expect(folder.uid_next).toBe(1);
			expect(typeof folder.uid_validity).toBe("number");
			expect(folder.uid_validity).toBeGreaterThan(1_600_000_000);
		}

		await expect(
			exec(
				stub,
				`INSERT INTO folders (id, name, is_deletable, uid_validity, uid_next)
				 VALUES ('missing-validity', 'Missing validity', 1, NULL, 1)`,
			),
		).rejects.toThrow();
	});

	it("runs exactly once, even across Durable Object restarts", async () => {
		const name = "m9-once";
		const first = mailbox(name);
		await first.getFolders();

		// Tag the live instance so we can prove the second construction is a
		// genuinely new object rather than the cached one.
		await runInDurableObject(first, (instance) => {
			(instance as unknown as { __tag?: string }).__tag = "first";
		});

		const countFor = async (stub: Awaited<ReturnType<typeof restart>>) =>
			(
				await query<{ n: number }>(
					stub,
					`SELECT COUNT(*) AS n FROM d1_migrations WHERE name = ?`,
					MIGRATION_NAME,
				)
			)[0].n;

		expect(await countFor(first)).toBe(1);

		const second = await restart(name);
		// Construction happened again -> the instance tag is gone.
		const tag = await runInDurableObject(
			second,
			(instance) => (instance as unknown as { __tag?: string }).__tag ?? null,
		);
		expect(tag).toBeNull();

		expect(await countFor(second)).toBe(1);
		const total = await query<{ n: number }>(
			second,
			`SELECT COUNT(*) AS n FROM d1_migrations`,
		);
		expect(total[0].n).toBe(mailboxMigrations.length);
	});

	it("backfills per-folder uids in date order and parks uid_next past the max", async () => {
		const stub = mailbox("m9-backfill");
		await stub.getFolders();

		const result = await runInDurableObject(stub, async (_instance, state) => {
			// Rewind to the pre-migration-9 schema: wipe everything, then apply
			// migrations 1..8 only.
			await state.storage.deleteAll();
			const sql = state.storage.sql;
			applyMigrations(sql, mailboxMigrations.slice(0, 8), state.storage);

			const insert = (id: string, folder: string, date: string | null) =>
				sql.exec(
					`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
					id,
					folder,
					`s-${id}`,
					"a@example.com",
					"b@example.com",
					date,
					`body-${id}`,
				);

			// Inserted deliberately out of date order.
			insert("i-late", "inbox", "2024-01-03T00:00:00Z");
			insert("i-early", "inbox", "2024-01-01T00:00:00Z");
			insert("i-mid", "inbox", "2024-01-02T00:00:00Z");
			// A separate folder gets its own sequence starting at 1.
			insert("s-late", "sent", "2024-05-02T00:00:00Z");
			insert("s-early", "sent", "2024-05-01T00:00:00Z");
			// NULL dates must still get a distinct uid (they sort first).
			insert("a-null", "archive", null);
			insert("a-dated", "archive", "2020-01-01T00:00:00Z");

			// Now apply the full list; only migration 9 is outstanding.
			applyMigrations(sql, mailboxMigrations, state.storage);

			return {
				emails: [
					...sql.exec(
						`SELECT id, folder_id, uid FROM emails ORDER BY folder_id, uid`,
					),
				] as { id: string; folder_id: string; uid: number }[],
				folders: [
					...sql.exec(`SELECT id, uid_next FROM folders ORDER BY id`),
				] as { id: string; uid_next: number }[],
			};
		});

		expect(result.emails).toEqual([
			{ id: "a-null", folder_id: "archive", uid: 1 },
			{ id: "a-dated", folder_id: "archive", uid: 2 },
			{ id: "i-early", folder_id: "inbox", uid: 1 },
			{ id: "i-mid", folder_id: "inbox", uid: 2 },
			{ id: "i-late", folder_id: "inbox", uid: 3 },
			{ id: "s-early", folder_id: "sent", uid: 1 },
			{ id: "s-late", folder_id: "sent", uid: 2 },
		]);

		expect(Object.fromEntries(result.folders.map((f) => [f.id, f.uid_next]))).toEqual({
			archive: 3,
			draft: 1,
			inbox: 4,
			sent: 3,
			spam: 1,
			trash: 1,
		});
	});

	it("upgrades a migration-11 mailbox without losing rows or foreign keys", async () => {
		const stub = mailbox("m12-preserves-mailbox");
		const result = await runInDurableObject(stub, async (_instance, state) => {
			await state.storage.deleteAll();
			const sql = state.storage.sql;
			applyMigrations(sql, mailboxMigrations.slice(0, 11), state.storage);

			sql.exec(
				`INSERT INTO emails (id, folder_id, subject, uid, raw_key, rfc822_size)
				 VALUES ('legacy-email', 'inbox', 'Preserve me', 7, 'raw/legacy-email', 42)`,
			);
			sql.exec(
				`UPDATE folders SET uid_next = 8 WHERE id = 'inbox'`,
			);
			sql.exec(
				`INSERT INTO attachments (id, email_id, filename, mimetype, size)
				 VALUES ('legacy-attachment', 'legacy-email', 'note.txt', 'text/plain', 42)`,
			);

			applyMigrations(sql, mailboxMigrations, state.storage);
			return {
				folders: [...sql.exec(`SELECT id, uid_validity, uid_next FROM folders WHERE id = 'inbox'`)],
				emails: [...sql.exec(`SELECT id, folder_id, uid, raw_key, rfc822_size FROM emails`)],
				attachments: [...sql.exec(`SELECT id, email_id FROM attachments`)],
				foreignKeyErrors: [...sql.exec(`PRAGMA foreign_key_check`)],
				uidValidity: [...sql.exec(`SELECT "notnull" FROM pragma_table_info('folders') WHERE name = 'uid_validity'`)],
			};
		});

		expect(result.folders).toHaveLength(1);
		expect(result.folders[0]).toMatchObject({ id: "inbox", uid_next: 8 });
		expect(typeof (result.folders[0] as { uid_validity: unknown }).uid_validity).toBe("number");
		expect(result.emails).toEqual([
			{ id: "legacy-email", folder_id: "inbox", uid: 7, raw_key: "raw/legacy-email", rfc822_size: 42 },
		]);
		expect(result.attachments).toEqual([{ id: "legacy-attachment", email_id: "legacy-email" }]);
		expect(result.foreignKeyErrors).toEqual([]);
		expect((result.uidValidity[0] as { notnull: number }).notnull).toBe(1);
	});
});
