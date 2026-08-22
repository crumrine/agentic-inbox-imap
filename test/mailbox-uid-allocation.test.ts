// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { emailData, folderUidNext, mailbox, query, restart, uids } from "./helpers";

describe("UID allocation", () => {
	it("hands out 1, 2, 3... per folder, with independent sequences", async () => {
		const stub = mailbox("uid-alloc");

		await stub.createEmail("inbox", emailData({ id: "i1" }), []);
		await stub.createEmail("inbox", emailData({ id: "i2" }), []);
		await stub.createEmail("inbox", emailData({ id: "i3" }), []);
		await stub.createEmail("sent", emailData({ id: "s1" }), []);
		await stub.createEmail("sent", emailData({ id: "s2" }), []);

		expect(await uids(stub)).toEqual([
			{ id: "i1", folder_id: "inbox", uid: 1 },
			{ id: "i2", folder_id: "inbox", uid: 2 },
			{ id: "i3", folder_id: "inbox", uid: 3 },
			{ id: "s1", folder_id: "sent", uid: 1 },
			{ id: "s2", folder_id: "sent", uid: 2 },
		]);

		expect(await folderUidNext(stub, "inbox")).toBe(4);
		expect(await folderUidNext(stub, "sent")).toBe(3);
		expect(await folderUidNext(stub, "archive")).toBe(1);
	});

	it("gives a user-created folder its own sequence and a uid_validity", async () => {
		const stub = mailbox("uid-custom-folder");
		await stub.createFolder("projects", "Projects");

		const folder = (
			await query<{ uid_validity: number | null; uid_next: number }>(
				stub,
				`SELECT uid_validity, uid_next FROM folders WHERE id = 'projects'`,
			)
		)[0];
		expect(typeof folder.uid_validity).toBe("number");
		expect(folder.uid_validity).toBeGreaterThan(1_600_000_000);
		expect(folder.uid_next).toBe(1);

		await stub.createEmail("inbox", emailData({ id: "i1" }), []);
		await stub.createEmail("projects", emailData({ id: "p1" }), []);
		await stub.createEmail("projects", emailData({ id: "p2" }), []);

		expect(await uids(stub)).toEqual([
			{ id: "i1", folder_id: "inbox", uid: 1 },
			{ id: "p1", folder_id: "projects", uid: 1 },
			{ id: "p2", folder_id: "projects", uid: 2 },
		]);
	});

	it("never reuses a uid after a delete", async () => {
		const stub = mailbox("uid-delete");

		await stub.createEmail("inbox", emailData({ id: "a" }), []);
		await stub.createEmail("inbox", emailData({ id: "b" }), []);
		await stub.createEmail("inbox", emailData({ id: "c" }), []);

		await stub.deleteEmail("c");
		await stub.deleteEmail("a");

		// uid_next does not roll back when rows disappear.
		expect(await folderUidNext(stub, "inbox")).toBe(4);

		await stub.createEmail("inbox", emailData({ id: "d" }), []);
		await stub.createEmail("inbox", emailData({ id: "e" }), []);

		expect(await uids(stub)).toEqual([
			{ id: "b", folder_id: "inbox", uid: 2 },
			{ id: "d", folder_id: "inbox", uid: 4 },
			{ id: "e", folder_id: "inbox", uid: 5 },
		]);
	});
});

describe("moveEmail", () => {
	it("mints a new uid in the target folder and retires the old one", async () => {
		const stub = mailbox("uid-move");

		await stub.createEmail("inbox", emailData({ id: "i1" }), []);
		await stub.createEmail("inbox", emailData({ id: "i2" }), []);
		await stub.createEmail("archive", emailData({ id: "a1" }), []);

		expect(await stub.moveEmail("i2", "archive")).toBe(true);

		// New uid in archive (archive was at uid_next 2), old inbox uid retired.
		expect(await uids(stub)).toEqual([
			{ id: "a1", folder_id: "archive", uid: 1 },
			{ id: "i2", folder_id: "archive", uid: 2 },
			{ id: "i1", folder_id: "inbox", uid: 1 },
		]);
		expect(await folderUidNext(stub, "archive")).toBe(3);
		// The source folder's sequence is untouched by the move: uid 2 is burned.
		expect(await folderUidNext(stub, "inbox")).toBe(3);

		await stub.createEmail("inbox", emailData({ id: "i3" }), []);
		const inboxUids = (await uids(stub))
			.filter((r) => r.folder_id === "inbox")
			.map((r) => r.uid);
		expect(inboxUids).toEqual([1, 3]);
	});

	it("does not renumber a message moved to the folder it is already in", async () => {
		const stub = mailbox("uid-move-noop");
		await stub.createEmail("inbox", emailData({ id: "i1" }), []);

		expect(await stub.moveEmail("i1", "inbox")).toBe(true);

		expect(await uids(stub)).toEqual([
			{ id: "i1", folder_id: "inbox", uid: 1 },
		]);
		expect(await folderUidNext(stub, "inbox")).toBe(2);
	});

	it("burns no uid for an unknown message or an unknown folder", async () => {
		const stub = mailbox("uid-move-unknown");
		await stub.createEmail("inbox", emailData({ id: "i1" }), []);

		expect(await stub.moveEmail("nope", "archive")).toBe(true);
		expect(await stub.moveEmail("i1", "nope")).toBe(false);

		expect(await folderUidNext(stub, "archive")).toBe(1);
		expect(await folderUidNext(stub, "inbox")).toBe(2);
	});
});

describe("uid_validity", () => {
	it("is stable across Durable Object restarts", async () => {
		const name = "uid-validity";
		const first = mailbox(name);
		await first.getFolders();

		const readValidity = async (stub: Awaited<ReturnType<typeof restart>>) =>
			Object.fromEntries(
				(
					await query<{ id: string; uid_validity: number }>(
						stub,
						`SELECT id, uid_validity FROM folders ORDER BY id`,
					)
				).map((r) => [r.id, r.uid_validity]),
			);

		const before = await readValidity(first);
		expect(Object.keys(before)).toHaveLength(6);

		const second = await restart(name);
		expect(await readValidity(second)).toEqual(before);

		const third = await restart(name);
		expect(await readValidity(third)).toEqual(before);
	});
});

describe("UNIQUE(folder_id, uid)", () => {
	it("rejects a duplicate uid within a folder but allows it across folders", async () => {
		const stub = mailbox("uid-unique");
		await stub.createEmail("inbox", emailData({ id: "i1" }), []);

		const outcome = await runInDurableObject(stub, (_instance, state) => {
			const insert = (id: string, folder: string, uid: number) =>
				state.storage.sql.exec(
					`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, uid)
					 VALUES (?, ?, 's', 'a@example.com', 'b@example.com', '2026-01-01T00:00:00Z', 'b', ?)`,
					id,
					folder,
					uid,
				);

			let duplicateError: string | null = null;
			try {
				insert("dup", "inbox", 1);
			} catch (e) {
				duplicateError = String(e);
			}

			// Same uid, different folder: perfectly legal, uids are per folder.
			insert("other-folder", "sent", 1);

			return {
				duplicateError,
				rows: [
					...state.storage.sql.exec(
						`SELECT id, folder_id, uid FROM emails ORDER BY folder_id, uid`,
					),
				],
			};
		});

		expect(outcome.duplicateError).toMatch(/UNIQUE constraint failed/);
		expect(outcome.rows).toEqual([
			{ id: "i1", folder_id: "inbox", uid: 1 },
			{ id: "other-folder", folder_id: "sent", uid: 1 },
		]);
	});
});

describe("isolated storage", () => {
	// These two tests share a Durable Object name on purpose: the pool gives
	// each test its own storage stack frame, so the write in the first must
	// not be visible in the second.
	it("writes state under a shared name", async () => {
		const stub = mailbox("shared-name");
		await stub.createEmail("inbox", emailData({ id: "leak-check" }), []);
		expect(await uids(stub)).toHaveLength(1);
	});

	it("does not see the previous test's state", async () => {
		const stub = mailbox("shared-name");
		expect(await uids(stub)).toEqual([]);
		expect(await folderUidNext(stub, "inbox")).toBe(1);
	});
});
