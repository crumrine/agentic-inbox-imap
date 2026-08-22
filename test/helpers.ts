// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";

export type MailboxStub = DurableObjectStub<
	import("../workers/durableObject").MailboxDO
>;

/** Get (and implicitly construct) a MailboxDO by name. */
export function mailbox(name: string): MailboxStub {
	return env.MAILBOX.get(env.MAILBOX.idFromName(name));
}

/**
 * Force the Durable Object to be torn down and reconstructed.
 *
 * Eviction discards the in-memory instance but keeps durable storage, so the
 * next stub access re-runs the constructor -- and therefore applyMigrations().
 */
export async function restart(name: string): Promise<MailboxStub> {
	await evictDurableObject(mailbox(name));
	return mailbox(name);
}

/** Run a read query directly against the DO's SQLite and return all rows. */
export async function query<T = Record<string, unknown>>(
	stub: MailboxStub,
	sql: string,
	...params: (string | number | null)[]
): Promise<T[]> {
	return runInDurableObject(stub, (_instance, state) => {
		return [...state.storage.sql.exec(sql, ...params)] as T[];
	});
}

/** Run a statement directly against the DO's SQLite. */
export async function exec(
	stub: MailboxStub,
	sql: string,
	...params: (string | number | null)[]
): Promise<void> {
	await runInDurableObject(stub, (_instance, state) => {
		state.storage.sql.exec(sql, ...params);
	});
}

export interface UidRow {
	id: string;
	folder_id: string;
	uid: number | null;
}

/** All (id, folder_id, uid) triples, ordered for stable assertions. */
export async function uids(stub: MailboxStub): Promise<UidRow[]> {
	return query<UidRow>(
		stub,
		`SELECT id, folder_id, uid FROM emails ORDER BY folder_id, uid`,
	);
}

export async function folderUidNext(
	stub: MailboxStub,
	folderId: string,
): Promise<number> {
	const rows = await query<{ uid_next: number }>(
		stub,
		`SELECT uid_next FROM folders WHERE id = ?`,
		folderId,
	);
	return rows[0].uid_next;
}

let seq = 0;

/** Minimal EmailData for createEmail(). */
export function emailData(overrides: { id?: string; date?: string } = {}) {
	seq += 1;
	return {
		id: overrides.id ?? `msg-${seq}`,
		subject: `Subject ${seq}`,
		sender: "sender@example.com",
		recipient: "recipient@example.com",
		date: overrides.date ?? `2026-01-${String(seq).padStart(2, "0")}T00:00:00Z`,
		body: `Body ${seq}`,
	};
}
