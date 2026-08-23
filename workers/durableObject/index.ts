// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { eq, and, or, asc, desc, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import { Folders } from "../../shared/folders";
import type { Env } from "../types";
import { applyMigrations, mailboxMigrations } from "./migrations";

/**
 * SQL expression to normalize email subjects by stripping common
 * reply/forward prefixes (Re:, Fwd:, FW:, AW:, WG:, Réf:, SV:).
 * Used for conversation grouping. Hardcoded to the `subject` column.
 */
const NORMALIZED_SUBJECT_SQL = `LOWER(TRIM(
	REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
		LOWER(subject),
		'aw: ', ''), 'wg: ', ''), 'réf: ', ''), 'sv: ', ''),
		're: ', ''), 'fwd: ', ''), 'fw: ', '')
))`;

const ALLOWED_SORT_COLUMNS = [
	"id",
	"subject",
	"sender",
	"recipient",
	"date",
	"read",
	"starred",
] as const;

type SortColumn = (typeof ALLOWED_SORT_COLUMNS)[number];

/**
 * Map SortColumn string names to Drizzle column references for safe
 * ORDER BY construction (no string interpolation into SQL).
 */
const SORT_COLUMN_MAP = {
	id: schema.emails.id,
	subject: schema.emails.subject,
	sender: schema.emails.sender,
	recipient: schema.emails.recipient,
	date: schema.emails.date,
	read: schema.emails.read,
	starred: schema.emails.starred,
} satisfies Record<SortColumn, typeof schema.emails[keyof typeof schema.emails]>;

interface SearchFilterOptions {
	query: string;
	folder?: string;
	from?: string;
	to?: string;
	subject?: string;
	date_start?: string;
	date_end?: string;
	is_read?: boolean;
	is_starred?: boolean;
	has_attachment?: boolean;
}

interface GetEmailsOptions {
	folder?: string;
	thread_id?: string;
	page?: number;
	limit?: number;
	sortColumn?: SortColumn;
	sortDirection?: "ASC" | "DESC";
}

interface EmailData {
	id: string;
	subject: string;
	sender: string;
	recipient: string;
	cc?: string | null;
	bcc?: string | null;
	date: string;
	body: string;
	read?: boolean;
	starred?: boolean;
	in_reply_to?: string | null;
	email_references?: string | null;
	thread_id?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
	/** R2 key for the raw RFC822 message (see workers/lib/raw-mime.ts). Null if storage failed or wasn't attempted. */
	raw_key?: string | null;
	/** Byte length of the raw RFC822 message. */
	rfc822_size?: number | null;
}

interface AttachmentData {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
}

export class MailboxDO extends DurableObject<Env> {
	declare __DURABLE_OBJECT_BRAND: never;
	db: ReturnType<typeof drizzle>;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.db = drizzle(this.ctx.storage, { schema });
		applyMigrations(this.ctx.storage.sql, mailboxMigrations, this.ctx.storage);
	}

	// ── Email CRUD (Drizzle) ───────────────────────────────────────

	async getEmails(options: GetEmailsOptions = {}) {
		const {
			folder,
			thread_id,
			page = 1,
			limit: rawLimit = 25,
			sortColumn: rawSortColumn = "date",
			sortDirection = "DESC",
		} = options;

		// Cap pagination limit to prevent unbounded queries
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		const sortColumn: SortColumn = ALLOWED_SORT_COLUMNS.includes(
			rawSortColumn as SortColumn,
		)
			? rawSortColumn
			: "date";

		const offset = (page - 1) * limit;

		const conditions: SQL[] = [];
		if (folder) {
			conditions.push(
				sql`${schema.emails.folder_id} = (SELECT id FROM folders WHERE name = ${folder} OR id = ${folder} LIMIT 1)`,
			);
		}
		if (thread_id) {
			conditions.push(eq(schema.emails.thread_id, thread_id));
		}

		const orderCol = SORT_COLUMN_MAP[sortColumn];
		const orderDir = sortDirection === "ASC" ? asc(orderCol) : desc(orderCol);

		const result = this.db
			.select({
				id: schema.emails.id,
				subject: schema.emails.subject,
				sender: schema.emails.sender,
				recipient: schema.emails.recipient,
				cc: schema.emails.cc,
				bcc: schema.emails.bcc,
				date: schema.emails.date,
				read: schema.emails.read,
				starred: schema.emails.starred,
				in_reply_to: schema.emails.in_reply_to,
				email_references: schema.emails.email_references,
				thread_id: schema.emails.thread_id,
				folder_id: schema.emails.folder_id,
				snippet: sql<string>`SUBSTR(${schema.emails.body}, 1, 300)`,
			})
			.from(schema.emails)
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(orderDir)
			.limit(limit)
			.offset(offset)
			.all();

		return result.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
		}));
	}

	/**
	 * Count total emails matching the given filters (for pagination).
	 */
	async countEmails(options: { folder?: string; thread_id?: string } = {}) {
		const { folder, thread_id } = options;
		const conditions: string[] = [];
		const params: (string | number)[] = [];

		if (folder) {
			conditions.push(
				"folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)",
			);
			params.push(folder);
		}

		if (thread_id) {
			conditions.push(`thread_id = ?${params.length + 1}`);
			params.push(thread_id);
		}

		const where =
			conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const row = [
			...this.ctx.storage.sql.exec(
				`SELECT COUNT(*) as total FROM emails ${where}`,
				...params,
			),
		][0] as { total: number } | undefined;

		return row?.total ?? 0;
	}

	// ── Threaded queries (raw SQL — too complex for Drizzle's builder) ──

	async getThreadedEmails(options: GetEmailsOptions = {}) {
		const {
			folder,
			page = 1,
			limit: rawLimit = 25,
		} = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		if (!folder) {
			// Fallback to regular getEmails if no folder specified
			return this.getEmails(options);
		}

		const offset = (page - 1) * limit;

		// Thread grouping strategy:
		// For DRAFT folder: group by in_reply_to (the email being replied to).
		//   This ensures reply-drafts to different emails stay separate, even if
		//   they share a thread_id or subject. New drafts (no in_reply_to) each
		//   get their own group via their unique id.
		// For other folders:
		//   1. Primary: group by thread_id (from email threading headers)
		//   2. Fallback: group by normalized subject (strips Re:/Fwd:/FW: prefixes)
		//      for legacy emails that lack threading headers (thread_id IS NULL).
		const isDraftFolder = folder === Folders.DRAFT;

		if (isDraftFolder) {
			const result = this.ctx.storage.sql.exec(
				`WITH
				folder_emails AS (
					SELECT *,
						COALESCE(in_reply_to, id) as draft_group_key
					FROM emails
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				),
				draft_stats AS (
					SELECT
						draft_group_key,
						COUNT(*) as thread_count,
						SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
						GROUP_CONCAT(DISTINCT sender) as participants
					FROM folder_emails
					GROUP BY draft_group_key
				),
				latest_per_group AS (
					SELECT
						fe.*,
						ROW_NUMBER() OVER (
							PARTITION BY fe.draft_group_key
							ORDER BY fe.date DESC
						) as rn
					FROM folder_emails fe
				)
				SELECT
					lp.id, lp.subject, lp.sender, lp.recipient, lp.date,
					lp.read, lp.starred, lp.thread_id, lp.folder_id,
					lp.in_reply_to, lp.email_references,
					SUBSTR(lp.body, 1, 300) as snippet,
					ds.thread_count, ds.thread_unread_count, ds.participants
				FROM latest_per_group lp
				JOIN draft_stats ds ON lp.draft_group_key = ds.draft_group_key
				WHERE lp.rn = 1
				ORDER BY lp.date DESC
				LIMIT ?2 OFFSET ?3`,
				folder, limit, offset
			);

			const rows = [...result];
			return rows.map((row: any) => ({
				...row,
				read: !!row.read,
				starred: !!row.starred,
				thread_count: row.thread_count || 1,
				thread_unread_count: row.thread_unread_count || 0,
				participants: row.participants || row.sender,
			}));
		}

		// Non-draft folders: full threading logic
		const result = this.ctx.storage.sql.exec(
			`WITH
			folder_emails AS (
				SELECT *,
					COALESCE(thread_id, id) as raw_thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
				FROM emails
				WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
			),
			thread_to_conversation AS (
				SELECT
					raw_thread_id,
					normalized_subject,
					CASE
						WHEN thread_id IS NOT NULL THEN raw_thread_id
						ELSE MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
					END as conversation_id
				FROM folder_emails
				GROUP BY raw_thread_id, normalized_subject, thread_id
			),
			all_emails_with_conversation AS (
				SELECT
					e.*,
					COALESCE(tc.conversation_id, COALESCE(e.thread_id, e.id)) as conversation_id
				FROM emails e
				LEFT JOIN thread_to_conversation tc
					ON COALESCE(e.thread_id, e.id) = tc.raw_thread_id
			),
			conversation_stats AS (
				SELECT
					conversation_id,
					COUNT(*) as thread_count,
					SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
					SUM(CASE WHEN read = 1 THEN 1 ELSE 0 END) as thread_read_count,
					GROUP_CONCAT(DISTINCT sender) as participants,
					SUM(CASE WHEN folder_id = (SELECT id FROM folders WHERE name = 'draft' LIMIT 1) THEN 1 ELSE 0 END) as has_draft
				FROM all_emails_with_conversation
				WHERE conversation_id IN (
					SELECT DISTINCT conversation_id FROM all_emails_with_conversation
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				)
				GROUP BY conversation_id
			),
			latest_message_per_conversation AS (
				SELECT
					conversation_id,
					folder_id,
					ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY date DESC) as rn
				FROM all_emails_with_conversation
			),
			latest_in_folder AS (
				SELECT
					fe.*,
					COALESCE(tc.conversation_id, fe.raw_thread_id) as conversation_id,
					ROW_NUMBER() OVER (
						PARTITION BY COALESCE(tc.conversation_id, fe.raw_thread_id)
						ORDER BY fe.date DESC
					) as rn
				FROM folder_emails fe
				LEFT JOIN thread_to_conversation tc
					ON fe.raw_thread_id = tc.raw_thread_id
			)
			SELECT
				lif.id, lif.subject, lif.sender, lif.recipient, lif.date,
				lif.read, lif.starred, lif.thread_id, lif.folder_id,
				lif.in_reply_to, lif.email_references,
				SUBSTR(lif.body, 1, 300) as snippet,
				cs.thread_count, cs.thread_unread_count, cs.participants,
				CASE WHEN lmc.folder_id != (SELECT id FROM folders WHERE name = 'sent' LIMIT 1)
					AND lmc.folder_id != (SELECT id FROM folders WHERE name = 'draft' LIMIT 1)
					AND cs.thread_read_count > 0
					THEN 1 ELSE 0 END as needs_reply,
				CASE WHEN cs.has_draft > 0 THEN 1 ELSE 0 END as has_draft
			FROM latest_in_folder lif
			JOIN conversation_stats cs ON lif.conversation_id = cs.conversation_id
			LEFT JOIN latest_message_per_conversation lmc
				ON lmc.conversation_id = lif.conversation_id AND lmc.rn = 1
			WHERE lif.rn = 1
			ORDER BY lif.date DESC
			LIMIT ?2 OFFSET ?3`,
			folder, limit, offset
		);

		const rows = [...result];
		return rows.map((row: any) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
			thread_count: row.thread_count || 1,
			thread_unread_count: row.thread_unread_count || 0,
			participants: row.participants || row.sender,
			needs_reply: !!row.needs_reply,
			has_draft: !!row.has_draft,
		}));
	}

	/**
	 * Count threaded conversations in a folder (for pagination).
	 * Returns the number of conversation groups, not individual emails.
	 */
	async countThreadedEmails(folder: string) {
		const isDraftFolder = folder === Folders.DRAFT;

		if (isDraftFolder) {
			const row = [
				...this.ctx.storage.sql.exec(
					`SELECT COUNT(DISTINCT COALESCE(in_reply_to, id)) as total
					 FROM emails
					 WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)`,
					folder,
				),
			][0] as { total: number } | undefined;
			return row?.total ?? 0;
		}

		const row = [
			...this.ctx.storage.sql.exec(
				`WITH
				folder_emails AS (
					SELECT
						COALESCE(thread_id, id) as raw_thread_id,
						thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
					FROM emails
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				),
				thread_to_conversation AS (
					SELECT
						raw_thread_id,
						CASE
							WHEN thread_id IS NOT NULL THEN raw_thread_id
							WHEN normalized_subject != '' THEN MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
							ELSE raw_thread_id
						END as conversation_id
					FROM folder_emails
					GROUP BY raw_thread_id, normalized_subject, thread_id
				)
				SELECT COUNT(DISTINCT conversation_id) as total
				FROM thread_to_conversation`,
				folder,
			),
		][0] as { total: number } | undefined;
		return row?.total ?? 0;
	}

	// ── Single email operations (Drizzle) ──────────────────────────

	async getEmail(id: string) {
		const email = this.db
			.select()
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;

		const emailAttachments = this.db
			.select()
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, id))
			.all();

		return {
			...email,
			read: !!email.read,
			starred: !!email.starred,
			attachments: emailAttachments,
		};
	}

	/**
	 * Fetch all emails in a thread with full bodies and attachments in
	 * two queries (one for emails, one for attachments) instead of
	 * N+1 individual getEmail calls.
	 */
	async getThreadEmails(threadId: string) {
		const emailRows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM emails WHERE thread_id = ?1 ORDER BY date ASC`,
				threadId,
			),
		] as any[];

		if (emailRows.length === 0) return [];

		const emailIds = emailRows.map((e) => e.id as string);

		// Batch-fetch all attachments for the thread in a single query
		const placeholders = emailIds.map((_, i) => `?${i + 1}`).join(",");
		const attachmentRows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM attachments WHERE email_id IN (${placeholders})`,
				...emailIds,
			),
		] as any[];

		// Group attachments by email_id
		const attachmentsByEmail = new Map<string, any[]>();
		for (const att of attachmentRows) {
			const list = attachmentsByEmail.get(att.email_id) || [];
			list.push(att);
			attachmentsByEmail.set(att.email_id, list);
		}

		return emailRows.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
			attachments: attachmentsByEmail.get(email.id) || [],
		}));
	}

	async updateEmail(
		id: string,
		{ read, starred }: { read?: boolean; starred?: boolean },
	) {
		const data: { read?: number; starred?: number } = {};
		if (read !== undefined) {
			data.read = read ? 1 : 0;
		}
		if (starred !== undefined) {
			data.starred = starred ? 1 : 0;
		}

		if (Object.keys(data).length === 0) {
			return this.getEmail(id);
		}

		this.db
			.update(schema.emails)
			.set(data)
			.where(eq(schema.emails.id, id))
			.run();

		return this.getEmail(id);
	}

	async markThreadRead(threadId: string) {
		this.ctx.storage.sql.exec(
			`UPDATE emails SET read = 1 WHERE thread_id = ? AND read = 0`,
			threadId,
		);
		return { threadId, markedRead: true };
	}

	async deleteEmail(id: string) {
		const email = this.db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;

		const emailAttachments = this.db
			.select({
				id: schema.attachments.id,
				filename: schema.attachments.filename,
			})
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, id))
			.all();

		this.db
			.delete(schema.emails)
			.where(eq(schema.emails.id, id))
			.run();

		return emailAttachments;
	}

	async getAttachment(id: string) {
		return (
			this.db
				.select()
				.from(schema.attachments)
				.where(eq(schema.attachments.id, id))
				.get() ?? null
		);
	}

	// ── Folders (Drizzle) ──────────────────────────────────────────

	async getFolders() {
		const result = this.db
			.select({
				id: schema.folders.id,
				name: schema.folders.name,
				unreadCount: sql<number>`COALESCE(SUM(CASE WHEN ${schema.emails.read} = 0 THEN 1 ELSE 0 END), 0)`.mapWith(Number),
			})
			.from(schema.folders)
			.leftJoin(schema.emails, eq(schema.emails.folder_id, schema.folders.id))
			.groupBy(schema.folders.id, schema.folders.name)
			.all();
		return result;
	}

	async createFolder(id: string, name: string, is_deletable: number = 1) {
		try {
			const result = this.db
				.insert(schema.folders)
				.values({
					id,
					name,
					is_deletable,
					// UIDVALIDITY is stamped once, at folder creation, and never
					// touched again -- IMAP clients treat a change as "throw away
					// everything you cached for this folder".
					uid_validity: sql<number>`strftime('%s','now')`,
					uid_next: 1,
				})
				.returning({ id: schema.folders.id, name: schema.folders.name })
				.get();
			return { ...result, unreadCount: 0 };
		} catch (e: unknown) {
			if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) {
				return null;
			}
			throw e;
		}
	}

	async updateFolder(id: string, name: string) {
		const result = this.db
			.update(schema.folders)
			.set({ name })
			.where(eq(schema.folders.id, id))
			.returning({ id: schema.folders.id, name: schema.folders.name })
			.get();
		return result;
	}

	async deleteFolder(id: string) {
		const folder = this.db
			.select({ is_deletable: schema.folders.is_deletable })
			.from(schema.folders)
			.where(eq(schema.folders.id, id))
			.get();

		if (!folder || folder.is_deletable === 0) {
			return false;
		}

		this.db
			.delete(schema.folders)
			.where(eq(schema.folders.id, id))
			.run();

		return true;
	}

	/**
	 * Allocate the next UID for a folder.
	 *
	 * UIDs are per FOLDER, not per mailbox: `inbox` and `sent` each run
	 * their own sequence starting at 1.
	 *
	 * This is a read-modify-write of folders.uid_next, so it is expressed
	 * as a single `UPDATE ... RETURNING` statement. SQLite's RETURNING
	 * yields the *post*-update value, so the UID handed out is one less
	 * than what comes back. Doing it in one statement (and never awaiting
	 * mid-allocation) means no other request can interleave and observe
	 * the same uid_next.
	 *
	 * uid_next only ever increases. Deleting a message does not give its
	 * UID back.
	 */
	#allocateUid(folderId: string): number {
		const allocated = this.db
			.update(schema.folders)
			.set({ uid_next: sql<number>`${schema.folders.uid_next} + 1` })
			.where(eq(schema.folders.id, folderId))
			.returning({ uid_next: schema.folders.uid_next })
			.get();

		if (!allocated) {
			throw new Error(`allocateUid: folder "${folderId}" not found`);
		}

		return allocated.uid_next - 1;
	}

	async moveEmail(id: string, folderId: string) {
		const folder = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(eq(schema.folders.id, folderId))
			.get();

		if (!folder) return false;

		const current = this.db
			.select({ folder_id: schema.emails.folder_id })
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		// Unknown id, or already in the target folder: nothing to renumber.
		// (Historically this returned true for a missing id; keep that.)
		if (!current || current.folder_id === folderId) {
			return true;
		}

		// A move retires the UID in the source folder and mints a brand new
		// one in the target. The source UID is never reused.
		const uid = this.#allocateUid(folderId);

		this.db
			.update(schema.emails)
			.set({ folder_id: folderId, uid })
			.where(eq(schema.emails.id, id))
			.run();

		return true;
	}

	// ── Search (raw SQL — dynamic condition builder) ───────────────

	/**
	 * Build WHERE conditions and params for search queries.
	 * Shared between searchEmails and countSearchResults.
	 */
	#buildSearchConditions(
		options: SearchFilterOptions,
		tableAlias = "",
	): { conditions: string[]; params: (string | number)[] } {
		const { query, folder, from, to, subject, date_start, date_end, is_read, is_starred, has_attachment } = options;
		const prefix = tableAlias ? `${tableAlias}.` : "";
		const conditions: string[] = [];
		const params: (string | number)[] = [];
		let paramIdx = 0;

		const addParam = (value: string | number) => {
			paramIdx++;
			params.push(value);
			return `?${paramIdx}`;
		};

		if (query) {
			const p1 = addParam(`%${query}%`);
			const p2 = addParam(`%${query}%`);
			const p3 = addParam(`%${query}%`);
			const p4 = addParam(`%${query}%`);
			conditions.push(`(${prefix}subject LIKE ${p1} OR ${prefix}body LIKE ${p2} OR ${prefix}sender LIKE ${p3} OR ${prefix}recipient LIKE ${p4} OR ${prefix}cc LIKE ${p4} OR ${prefix}bcc LIKE ${p4})`);
		}
		if (folder) {
			const p = addParam(folder);
			conditions.push(`${prefix}folder_id = (SELECT id FROM folders WHERE name = ${p} OR id = ${p} LIMIT 1)`);
		}
		if (from) { const p = addParam(`%${from}%`); conditions.push(`${prefix}sender LIKE ${p}`); }
		if (to) { const p = addParam(`%${to}%`); conditions.push(`(${prefix}recipient LIKE ${p} OR ${prefix}cc LIKE ${p} OR ${prefix}bcc LIKE ${p})`); }
		if (subject) { const p = addParam(`%${subject}%`); conditions.push(`${prefix}subject LIKE ${p}`); }
		if (date_start) { const p = addParam(date_start); conditions.push(`${prefix}date >= ${p}`); }
		if (date_end) { const p = addParam(date_end); conditions.push(`${prefix}date <= ${p}`); }
		if (is_read !== undefined) { const p = addParam(is_read ? 1 : 0); conditions.push(`${prefix}read = ${p}`); }
		if (is_starred !== undefined) { const p = addParam(is_starred ? 1 : 0); conditions.push(`${prefix}starred = ${p}`); }
		if (has_attachment) { conditions.push(`${prefix}id IN (SELECT DISTINCT email_id FROM attachments)`); }

		return { conditions, params };
	}

	async searchEmails(options: SearchFilterOptions & { page?: number; limit?: number }) {
		const { page = 1, limit: rawLimit = 25 } = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);
		const { conditions, params } = this.#buildSearchConditions(options, "e");

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const offset = (page - 1) * limit;

		const query = `
			SELECT e.id, e.subject, e.sender, e.recipient, e.cc, e.bcc, e.date,
				e.read, e.starred, e.in_reply_to, e.email_references,
				e.thread_id, e.folder_id,
				SUBSTR(e.body, 1, 300) as snippet,
				f.name as folder_name
			FROM emails e
			LEFT JOIN folders f ON e.folder_id = f.id
			${where}
			ORDER BY e.date DESC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`;
		params.push(limit, offset);

		const result = this.ctx.storage.sql.exec(query, ...params);
		return [...result].map((row: any) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
		}));
	}

	/**
	 * Count total search results matching the given filters (for pagination).
	 */
	async countSearchResults(options: SearchFilterOptions) {
		const { conditions, params } = this.#buildSearchConditions(options);

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const query = `SELECT COUNT(*) as total FROM emails ${where}`;

		const row = [...this.ctx.storage.sql.exec(query, ...params)][0] as
			| { total: number }
			| undefined;
		return row?.total ?? 0;
	}

	// ── Threading helpers (raw SQL) ────────────────────────────────

	async findThreadBySubject(subject: string, senderAddress?: string): Promise<string | null> {
		const normalized = subject
			.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
			.trim()
			.toLowerCase();

		if (!normalized) return null;

		const result = this.ctx.storage.sql.exec(
			`SELECT thread_id, subject,
			        GROUP_CONCAT(DISTINCT LOWER(sender)) as senders,
			        GROUP_CONCAT(DISTINCT LOWER(recipient)) as recipients
			 FROM emails
			 WHERE thread_id IS NOT NULL
			   AND thread_id != id
			   AND date >= datetime('now', '-7 days')
			 GROUP BY thread_id
			 ORDER BY MAX(date) DESC
			 LIMIT 50`,
		);

		const normalizedSender = senderAddress?.toLowerCase().trim();

		for (const row of result) {
			const rowSubject = String((row as any).subject || "")
				.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
				.trim()
				.toLowerCase();
			if (rowSubject !== normalized) continue;

			if (normalizedSender) {
				const threadSenders = String((row as any).senders || "");
				const threadRecipients = String((row as any).recipients || "");
				const allParticipants = `${threadSenders},${threadRecipients}`;
				if (!allParticipants.includes(normalizedSender)) {
					continue;
				}
			}

			return String((row as any).thread_id);
		}
		return null;
	}

	// ── Rate limiting (raw SQL) ────────────────────────────────────

	/**
	 * Check if the mailbox has exceeded the send rate limit.
	 * Limits: 20 emails per hour, 100 per day per mailbox.
	 * Returns null if under limit, or an error message string if exceeded.
	 */
	async checkSendRateLimit(): Promise<string | null> {
		const hourRow = [...this.ctx.storage.sql.exec(
			`SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= datetime('now', '-1 hour')`,
			Folders.SENT,
		)][0] as { cnt: number } | undefined;

		if ((hourRow?.cnt ?? 0) >= 20) {
			return "Rate limit exceeded: max 20 emails per hour per mailbox";
		}

		const dayRow = [...this.ctx.storage.sql.exec(
			`SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= datetime('now', '-1 day')`,
			Folders.SENT,
		)][0] as { cnt: number } | undefined;

		if ((dayRow?.cnt ?? 0) >= 100) {
			return "Rate limit exceeded: max 100 emails per day per mailbox";
		}

		return null;
	}

	// ── Email creation (Drizzle) ───────────────────────────────────

	async createEmail(
		folder: string,
		email: EmailData,
		attachments: AttachmentData[],
	) {
		// Resolve folder name or ID to the actual folder ID.
		const folderRow = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(or(eq(schema.folders.id, folder), eq(schema.folders.name, folder)))
			.limit(1)
			.get();

		if (!folderRow) {
			throw new Error(
				`createEmail: folder "${folder}" not found. ` +
					"Ensure the folder exists before inserting an email.",
			);
		}

		const folderId = folderRow.id;
		const isSent = folderId === Folders.SENT;

		// Allocate the UID immediately before the INSERT, with no await in
		// between, so the allocation and the row that owns it cannot be
		// separated by another request.
		const uid = this.#allocateUid(folderId);

		// Sent emails are always read — the sender obviously knows what they wrote.
		// This prevents sent replies from inflating thread_unread_count.
		this.db
			.insert(schema.emails)
			.values({
				id: email.id,
				folder_id: folderId,
				subject: email.subject,
				sender: email.sender,
				recipient: email.recipient,
				cc: email.cc ?? null,
				bcc: email.bcc ?? null,
				date: email.date,
				read: isSent ? 1 : (email.read ? 1 : 0),
				starred: email.starred ? 1 : 0,
				body: email.body,
				in_reply_to: email.in_reply_to ?? null,
				email_references: email.email_references ?? null,
				thread_id: email.thread_id ?? null,
				message_id: email.message_id ?? null,
				raw_headers: email.raw_headers ?? null,
				raw_key: email.raw_key ?? null,
				rfc822_size: email.rfc822_size ?? null,
				uid,
			})
			.run();

		if (attachments.length > 0) {
			this.db.insert(schema.attachments).values(attachments).run();
		}
	}

	// ── IMAP read API (raw SQL — see the type block below this class) ──
	//
	// These three methods back `workers/routes/imap-api.ts`, which the Go IMAP
	// gateway consumes. Two rules shape all of them:
	//
	//   1. Nothing here touches R2. A mail client issuing FETCH over a 5,000
	//      message folder must cost SQLite work and nothing else, so every
	//      figure an IMAP FETCH needs is either a column or derived in SQL.
	//   2. Counts come from aggregates, never from loading rows and counting
	//      them in JS.

	/**
	 * Every folder with its IMAP counts. One query, all aggregates in SQL.
	 *
	 * `recent` is always 0: \Recent means "arrived since some other session
	 * last looked", and this Worker has no session state to answer that from.
	 * RFC 9051 dropped \Recent entirely and the gateway already reports
	 * NumRecent 0 on SELECT, so 0 is the consistent answer rather than a
	 * guess dressed up as a count.
	 */
	async imapFolders(): Promise<ImapFolder[]> {
		const rows = [
			...this.ctx.storage.sql.exec(
				`SELECT f.id                                AS id,
				        f.name                              AS name,
				        COALESCE(f.uid_validity, 1)         AS uid_validity,
				        COALESCE(f.uid_next, 1)             AS uid_next,
				        COALESCE(c.exists_count, 0)         AS exists_count,
				        COALESCE(c.unseen_count, 0)         AS unseen_count
				   FROM folders f
				   LEFT JOIN (
				        SELECT folder_id,
				               COUNT(*)                                          AS exists_count,
				               SUM(CASE WHEN COALESCE(read, 0) = 0 THEN 1 ELSE 0 END) AS unseen_count
				          FROM emails
				         WHERE uid IS NOT NULL
				         GROUP BY folder_id
				   ) c ON c.folder_id = f.id
				  ORDER BY f.id`,
			),
		] as unknown as {
			id: string;
			name: string;
			uid_validity: number;
			uid_next: number;
			exists_count: number;
			unseen_count: number;
		}[];

		return rows.map((row) => ({
			id: row.id,
			name: row.name,
			uidValidity: Number(row.uid_validity),
			uidNext: Number(row.uid_next),
			exists: Number(row.exists_count),
			unseen: Number(row.unseen_count),
			recent: 0,
		}));
	}

	/**
	 * A page of message metadata for one folder, by ascending UID.
	 *
	 * `folderKey` is the folder **id** (`inbox`, `sent`, …) — that is what the
	 * gateway puts in the URL. A display name is accepted too, case
	 * insensitively, purely so a hand-typed request does not 404.
	 *
	 * Returns null when the folder does not exist, which the route turns into
	 * a 404. An empty folder returns a page with no messages, not null.
	 */
	async imapMessages(
		folderKey: string,
		options: { sinceUid?: number; limit?: number } = {},
	): Promise<ImapMessagesPage | null> {
		const folder = this.#imapFolderRow(folderKey);
		if (!folder) return null;

		const sinceUid = Math.max(0, Math.trunc(options.sinceUid ?? 0));
		const limit = clampImapLimit(options.limit);
		const isDraftFolder = folder.id === Folders.DRAFT;

		const rows = [
			...this.ctx.storage.sql.exec(
				`SELECT e.uid                                AS uid,
				        COALESCE(e.read, 0)                  AS read,
				        COALESCE(e.starred, 0)               AS starred,
				        COALESCE(e.answered, 0)              AS answered,
				        COALESCE(e.deleted, 0)               AS deleted,
				        e.flags                              AS flags,
				        e.date                               AS date,
				        e.subject                            AS subject,
				        e.sender                             AS sender,
				        e.recipient                          AS recipient,
				        e.cc                                 AS cc,
				        e.message_id                         AS message_id,
				        e.in_reply_to                        AS in_reply_to,
				        e.rfc822_size                        AS rfc822_size,
				        e.raw_key                            AS raw_key,
				        ${IMAP_SIZE_ESTIMATE_SQL}            AS size_estimate,
				        ${imapHeaderSql("date")}             AS hdr_date,
				        ${imapHeaderSql("from")}             AS hdr_from,
				        ${imapHeaderSql("to")}               AS hdr_to,
				        ${imapHeaderSql("cc")}               AS hdr_cc
				   FROM emails e
				  WHERE e.folder_id = ?1
				    AND e.uid IS NOT NULL
				    AND e.uid >= ?2
				  ORDER BY e.uid ASC
				  LIMIT ?3`,
				folder.id,
				sinceUid,
				limit,
			),
		] as unknown as ImapMessageRow[];

		return {
			messages: rows.map((row) => imapMessageFromRow(row, isDraftFolder)),
			uidNext: Number(folder.uid_next),
		};
	}

	/**
	 * Everything needed to serve one message's raw bytes: the R2 key when the
	 * message has stored raw MIME, and the fields to rebuild an equivalent
	 * message when it does not (see the legacy path in the route).
	 *
	 * The three outcomes are distinguished so the route can answer "no such
	 * folder" and "no such message" differently without either of them
	 * revealing an R2 key or any other internal detail.
	 */
	async imapRawSource(folderKey: string, uid: number): Promise<ImapRawSourceResult> {
		const folder = this.#imapFolderRow(folderKey);
		if (!folder) return { status: "no-folder" };

		const row = [
			...this.ctx.storage.sql.exec(
				`SELECT e.id                      AS id,
				        e.raw_key                 AS raw_key,
				        e.message_id              AS message_id,
				        e.subject                 AS subject,
				        e.sender                  AS sender,
				        e.recipient               AS recipient,
				        e.cc                      AS cc,
				        e.bcc                     AS bcc,
				        e.date                    AS date,
				        e.body                    AS body,
				        e.in_reply_to             AS in_reply_to,
				        e.email_references        AS email_references,
				        ${imapHeaderSql("date")}  AS hdr_date,
				        ${imapHeaderSql("from")}  AS hdr_from,
				        ${imapHeaderSql("to")}    AS hdr_to,
				        ${imapHeaderSql("cc")}    AS hdr_cc
				   FROM emails e
				  WHERE e.folder_id = ?1 AND e.uid = ?2
				  LIMIT 1`,
				folder.id,
				Math.trunc(uid),
			),
		][0] as unknown as ImapRawRow | undefined;

		if (!row) return { status: "no-message" };

		const attachments = [
			...this.ctx.storage.sql.exec(
				`SELECT id, filename, mimetype, size, content_id, disposition
				   FROM attachments
				  WHERE email_id = ?1
				  ORDER BY id`,
				row.id,
			),
		] as unknown as ImapRawAttachment[];

		const from = parseAddressList(row.hdr_from ?? row.sender ?? "")[0] ?? null;

		return {
			status: "ok",
			message: {
				id: row.id,
				rawKey: row.raw_key ?? null,
				messageId: row.message_id ?? row.id,
				subject: row.subject ?? "",
				from,
				toHeader: row.hdr_to ?? row.recipient ?? null,
				ccHeader: row.hdr_cc ?? row.cc ?? null,
				bccHeader: row.bcc ?? null,
				internalDate: toRfc3339(row.date),
				dateHeader: row.hdr_date ?? null,
				body: row.body ?? "",
				inReplyTo: row.in_reply_to ?? null,
				references: parseJsonStringArray(row.email_references),
				attachments: attachments.map((a) => ({
					id: a.id,
					filename: a.filename,
					mimetype: a.mimetype,
					size: Number(a.size),
					content_id: a.content_id ?? null,
					disposition: a.disposition ?? null,
				})),
			},
		};
	}


	/**
	 * Apply a batch of IMAP flag changes to one folder in a single call.
	 *
	 * This is the write half of the gateway contract, and the reason it is not
	 * optional: iOS Mail issues `UID STORE n +FLAGS.SILENT (\Seen)` the moment
	 * it renders a message, and treats a `NO` reply as fatal — it tears the
	 * connection down and reconnects, forever. A refused STORE is a hard
	 * failure, not a degraded experience, so every plausible STORE must apply.
	 *
	 * The semantics the gateway depends on:
	 *
	 * - **One round trip.** A client may STORE an entire selected folder at
	 *   once, so the whole batch is read, folded and written here rather than
	 *   one RPC per uid. Everything runs inside `transactionSync`, so no reader
	 *   observes half a batch and a throw rolls the whole thing back.
	 * - **Unknown uids are skipped, never errors.** A message can be moved or
	 *   expunged between the client's snapshot and its STORE; failing the batch
	 *   over that would also fail it for the messages that do still exist.
	 * - **The complete resulting flag set is returned** per uid, derived by the
	 *   same `deriveImapFlags` the read endpoint uses, so the gateway can emit
	 *   an accurate untagged FETCH without a second query and the two endpoints
	 *   cannot disagree.
	 * - Updates fold in request order, so two updates naming the same uid
	 *   compose instead of the later one winning outright. Within one update
	 *   `remove` is applied before `add`, so naming a flag in both leaves it
	 *   set — IMAP itself never sends both, so this only has to be defined.
	 *
	 * Returns null when the folder does not exist, mirroring imapMessages; the
	 * route turns that into a 404.
	 */
	async imapStoreFlags(
		folderKey: string,
		updates: ImapFlagUpdate[],
	): Promise<ImapFlagStoreResult | null> {
		const folder = this.#imapFolderRow(folderKey);
		if (!folder) return null;

		// Distinct, validated uids, in the order the request first named them.
		// Filtering here is what makes the literal uid list below provably
		// safe to interpolate.
		const wanted: number[] = [];
		const seenUids = new Set<number>();
		for (const update of updates) {
			const uid = imapStoreUid(update.uid);
			if (uid === null || seenUids.has(uid)) continue;
			seenUids.add(uid);
			wanted.push(uid);
		}
		if (wanted.length === 0) return { updated: [] };

		const isDraftFolder = folder.id === Folders.DRAFT;

		return this.ctx.storage.transactionSync(() => {
			// Bound parameters would be the reflex, but SQLite caps how many
			// one statement may carry and a batch is deliberately allowed to be
			// large. Every element of `wanted` came out of imapStoreUid, so the
			// list cannot contain anything but digits.
			const rows = [
				...this.ctx.storage.sql.exec(
					`SELECT uid                   AS uid,
					        COALESCE(read, 0)     AS read,
					        COALESCE(starred, 0)  AS starred,
					        COALESCE(answered, 0) AS answered,
					        COALESCE(deleted, 0)  AS deleted,
					        flags                 AS flags
					   FROM emails
					  WHERE folder_id = ?1 AND uid IN (${wanted.join(", ")})`,
					folder.id,
				),
			] as unknown as ImapFlagRow[];

			const states = new Map<number, ImapFlagState>();
			for (const row of rows) {
				states.set(Number(row.uid), {
					read: row.read ? 1 : 0,
					starred: row.starred ? 1 : 0,
					answered: row.answered ? 1 : 0,
					deleted: row.deleted ? 1 : 0,
					keywords: parseJsonStringArray(row.flags),
					dirty: false,
				});
			}

			for (const update of updates) {
				const uid = imapStoreUid(update.uid);
				const state = uid === null ? undefined : states.get(uid);
				if (!state) continue; // Unknown uid: silently skipped.
				for (const flag of update.remove ?? []) applyStoreFlag(state, flag, false);
				for (const flag of update.add ?? []) applyStoreFlag(state, flag, true);
			}

			const updated: ImapUpdatedFlags[] = [];
			for (const uid of wanted) {
				const state = states.get(uid);
				if (!state) continue;

				const keywords = state.keywords.length > 0 ? JSON.stringify(state.keywords) : null;
				if (state.dirty) {
					this.ctx.storage.sql.exec(
						`UPDATE emails
						    SET read = ?3, starred = ?4, answered = ?5, deleted = ?6, flags = ?7
						  WHERE folder_id = ?1 AND uid = ?2`,
						folder.id,
						uid,
						state.read,
						state.starred,
						state.answered,
						state.deleted,
						keywords,
					);
				}

				updated.push({
					uid,
					flags: deriveImapFlags(
						{
							read: state.read,
							starred: state.starred,
							answered: state.answered,
							deleted: state.deleted,
							flags: keywords,
						},
						isDraftFolder,
					),
				});
			}

			return { updated };
		});
	}

	/** Resolve a folder by id (canonical) or, tolerantly, by display name. */
	#imapFolderRow(folderKey: string): { id: string; uid_next: number } | undefined {
		return [
			...this.ctx.storage.sql.exec(
				`SELECT id, COALESCE(uid_next, 1) AS uid_next
				   FROM folders
				  WHERE id = ?1 OR lower(id) = lower(?1) OR lower(name) = lower(?1)
				  ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END
				  LIMIT 1`,
				folderKey,
			),
		][0] as unknown as { id: string; uid_next: number } | undefined;
	}
}

// ── IMAP read model ──────────────────────────────────────────────────
//
// Shapes here are wire types: they are serialised verbatim by
// workers/routes/imap-api.ts and decoded by the Go structs in
// gateway/internal/backend/types.go. Field names and casing must match those
// struct tags exactly — renaming one here silently breaks the gateway, since
// encoding/json just leaves the Go field zero.

/**
 * Hard ceiling on `limit` for the message-metadata endpoint. A caller cannot
 * ask for more than this many rows in one page no matter what it sends, which
 * is what keeps a single request from turning into an unbounded result set.
 */
export const IMAP_MESSAGES_MAX_LIMIT = 1000;

/**
 * Largest value a UID can take (RFC 9051: UIDs are 32-bit unsigned). Shared
 * with the route so the two halves cannot drift apart.
 */
export const IMAP_MAX_UID = 4294967295;

/** Bytes added to a legacy message's size estimate for MIME scaffolding. */
const IMAP_LEGACY_MIME_OVERHEAD_BYTES = 512;

export interface ImapFolder {
	id: string;
	name: string;
	uidValidity: number;
	uidNext: number;
	exists: number;
	unseen: number;
	recent: number;
}

export interface ImapAddress {
	name: string;
	address: string;
}

export interface ImapEnvelope {
	subject: string;
	from: ImapAddress[];
	to: ImapAddress[];
	cc: ImapAddress[];
	messageId: string;
	inReplyTo: string;
	/** The `Date` **header**, not the internal date. See imapMessageFromRow. */
	date: string;
}

export interface ImapMessage {
	uid: number;
	flags: string[];
	/** RFC 3339. Receive time, which is what IMAP INTERNALDATE means. */
	internalDate: string;
	rfc822Size: number;
	envelope: ImapEnvelope;
	/**
	 * True when the exact bytes of this message are stored in R2. False means
	 * the raw endpoint will synthesize an equivalent message instead, so the
	 * bytes are a faithful reconstruction rather than the originals — DKIM
	 * will not verify against them and rfc822Size is an estimate.
	 */
	hasRaw: boolean;
}

export interface ImapMessagesPage {
	messages: ImapMessage[];
	uidNext: number;
}

export interface ImapRawAttachment {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id: string | null;
	disposition: string | null;
}

export interface ImapRawSource {
	id: string;
	/** R2 key of the stored raw message, or null for a legacy row. */
	rawKey: string | null;
	messageId: string;
	subject: string;
	from: ImapAddress | null;
	toHeader: string | null;
	ccHeader: string | null;
	bccHeader: string | null;
	internalDate: string;
	dateHeader: string | null;
	body: string;
	inReplyTo: string | null;
	references: string[];
	attachments: ImapRawAttachment[];
}

export type ImapRawSourceResult =
	| { status: "no-folder" }
	| { status: "no-message" }
	| { status: "ok"; message: ImapRawSource };

/** One uid's requested flag delta. Both arrays are optional and independent. */
export interface ImapFlagUpdate {
	uid: number;
	add?: string[];
	remove?: string[];
}

/** A uid's complete flag set after a store, exactly as FETCH would report it. */
export interface ImapUpdatedFlags {
	uid: number;
	flags: string[];
}

/**
 * Result of a flag batch. Uids that did not resolve to a message are absent
 * rather than reported, so `updated.length` may be shorter than the request.
 */
export interface ImapFlagStoreResult {
	updated: ImapUpdatedFlags[];
}

/** Row shape of the state read in MailboxDO.imapStoreFlags. */
interface ImapFlagRow {
	uid: number;
	read: number;
	starred: number;
	answered: number;
	deleted: number;
	flags: string | null;
}

/** In-flight flag state for one message while a batch is being folded. */
interface ImapFlagState {
	read: number;
	starred: number;
	answered: number;
	deleted: number;
	keywords: string[];
	/** Whether anything actually changed; an unchanged row is not rewritten. */
	dirty: boolean;
}

/**
 * The four settable system flags and the column each one lives in. Keys are
 * lower-cased because IMAP flags are case-insensitive atoms: a client may send
 * `\SEEN`, and a STORE that silently did nothing would leave the client
 * re-issuing it forever.
 */
const IMAP_SYSTEM_FLAG_COLUMNS: Record<string, "read" | "starred" | "answered" | "deleted"> = {
	"\\seen": "read",
	"\\flagged": "starred",
	"\\answered": "answered",
	"\\deleted": "deleted",
};

/**
 * Hard ceiling on custom keywords kept per message.
 *
 * The cap lives here rather than only in the route because the route bounds a
 * single request, and nothing stops a client from issuing a thousand of them.
 * Additions past the cap are dropped silently: the alternative is failing the
 * STORE, which is the failure mode this whole endpoint exists to avoid.
 */
export const IMAP_MAX_KEYWORDS_PER_MESSAGE = 32;

/** Validate one uid from a store request. Null means "not a possible uid". */
function imapStoreUid(value: number): number | null {
	const uid = Math.trunc(Number(value));
	if (!Number.isSafeInteger(uid) || uid < 1 || uid > IMAP_MAX_UID) return null;
	return uid;
}

/**
 * Fold one flag into a message's in-flight state.
 *
 * `\Draft` is derived from the folder and `\Recent` from session state neither
 * this Worker nor the gateway keeps, so neither is settable. They — and any
 * other backslash flag — are ignored rather than rejected: the system-flag
 * namespace is reserved, so storing an unrecognised one as a keyword would
 * invent a flag the read path would then hand back as real.
 */
function applyStoreFlag(state: ImapFlagState, rawFlag: string, on: boolean): void {
	const flag = rawFlag.trim();
	if (flag === "") return;
	const lower = flag.toLowerCase();

	const column = IMAP_SYSTEM_FLAG_COLUMNS[lower];
	if (column) {
		const next = on ? 1 : 0;
		if (state[column] !== next) {
			state[column] = next;
			state.dirty = true;
		}
		return;
	}
	if (flag.startsWith("\\")) return;

	if (on) {
		if (state.keywords.some((keyword) => keyword.trim().toLowerCase() === lower)) return;
		if (state.keywords.length >= IMAP_MAX_KEYWORDS_PER_MESSAGE) return;
		state.keywords.push(flag);
		state.dirty = true;
		return;
	}

	// Filter rather than find-and-splice: a legacy row can hold the same
	// keyword twice in different casing, and a remove has to clear all of it.
	const kept = state.keywords.filter((keyword) => keyword.trim().toLowerCase() !== lower);
	if (kept.length !== state.keywords.length) {
		state.keywords = kept;
		state.dirty = true;
	}
}

/** Row shape of the metadata query in MailboxDO.imapMessages. */
interface ImapMessageRow {
	uid: number;
	read: number;
	starred: number;
	answered: number;
	deleted: number;
	flags: string | null;
	date: string | null;
	subject: string | null;
	sender: string | null;
	recipient: string | null;
	cc: string | null;
	message_id: string | null;
	in_reply_to: string | null;
	rfc822_size: number | null;
	raw_key: string | null;
	size_estimate: number;
	hdr_date: string | null;
	hdr_from: string | null;
	hdr_to: string | null;
	hdr_cc: string | null;
}

/** Row shape of the raw-source query in MailboxDO.imapRawSource. */
interface ImapRawRow {
	id: string;
	raw_key: string | null;
	message_id: string | null;
	subject: string | null;
	sender: string | null;
	recipient: string | null;
	cc: string | null;
	bcc: string | null;
	date: string | null;
	body: string | null;
	in_reply_to: string | null;
	email_references: string | null;
	hdr_date: string | null;
	hdr_from: string | null;
	hdr_to: string | null;
	hdr_cc: string | null;
}

/**
 * Size fallback for rows predating raw-MIME storage (`rfc822_size` NULL).
 *
 * Derived entirely in SQL from column lengths so the metadata endpoint keeps
 * its promise never to read R2: header JSON bytes + body bytes + the base64
 * expansion of the attachment bytes + a flat allowance for MIME scaffolding.
 * It is an estimate and cannot be authoritative — the only authoritative
 * answer would be building the message, which means reading attachments back
 * out of R2.
 */
const IMAP_SIZE_ESTIMATE_SQL = `(
	LENGTH(CAST(COALESCE(e.raw_headers, '') AS BLOB))
	+ LENGTH(CAST(COALESCE(e.body, '') AS BLOB))
	+ ((SELECT COALESCE(SUM(a.size), 0) FROM attachments a WHERE a.email_id = e.id) * 4 + 2) / 3
	+ ${IMAP_LEGACY_MIME_OVERHEAD_BYTES}
)`;

/**
 * SQL that pulls one header value out of the `raw_headers` JSON.
 *
 * `raw_headers` is a JSON array of `{key, value}` written by the inbound
 * parser and the send paths, with lower-cased keys. Doing the lookup in SQL
 * rather than shipping the whole header blob per row is the difference
 * between a few hundred bytes and several KB of DKIM/Received noise per
 * message on a folder listing.
 *
 * Both guards matter: `json_valid`/`json_type` keeps a NULL or non-array
 * value from raising, and the inner CASE keeps `json_extract` off any array
 * element that is not an object. `name` is a literal from this module only —
 * never caller input — so it is safe to interpolate.
 */
function imapHeaderSql(name: string): string {
	return `(CASE WHEN json_valid(e.raw_headers) AND json_type(e.raw_headers) = 'array' THEN (
		SELECT json_extract(h.value, '$.value')
		  FROM json_each(e.raw_headers) AS h
		 WHERE (CASE WHEN h.type = 'object'
		             THEN lower(json_extract(h.value, '$.key'))
		        END) = '${name}'
		 LIMIT 1
	) END)`;
}

/** Clamp a caller-supplied page size into [1, IMAP_MESSAGES_MAX_LIMIT]. */
export function clampImapLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return IMAP_MESSAGES_MAX_LIMIT;
	return Math.min(Math.max(1, Math.trunc(limit)), IMAP_MESSAGES_MAX_LIMIT);
}

/**
 * Normalise a stored date into strict RFC 3339.
 *
 * This is not cosmetic. `internalDate` decodes into a Go `time.Time`, and a
 * string Go cannot parse fails the whole JSON decode — one bad legacy row
 * would take down the entire folder listing. Anything unparseable becomes the
 * epoch, which is wrong but inert.
 */
export function toRfc3339(value: string | null | undefined): string {
	if (value) {
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
	}
	return new Date(0).toISOString();
}

function parseJsonStringArray(value: string | null | undefined): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((v): v is string => typeof v === "string" && v.trim() !== "");
	} catch {
		return [];
	}
}

// ── RFC 2047 encoded-words ────────────────────────────────────────────

/**
 * Decode `=?UTF-8?B?...?=` / `?Q?` words in a header value.
 *
 * Display names in stored headers are raw wire bytes, so without this a
 * non-ASCII sender shows up as mojibake in every mail client. Any word that
 * fails to decode (unknown charset, bad base64) is left exactly as it was.
 */
export function decodeEncodedWords(value: string): string {
	if (!value.includes("=?")) return value;
	// Whitespace between two adjacent encoded-words is not part of the text.
	const joined = value.replace(/(\?=)\s+(?==\?)/g, "$1");
	return joined.replace(
		/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
		(match, charset: string, encoding: string, text: string) => {
			try {
				let bytes: Uint8Array;
				if (encoding.toLowerCase() === "b") {
					const binary = atob(text.replace(/\s+/g, ""));
					bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
				} else {
					const decoded = text
						.replace(/_/g, " ")
						.replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
							String.fromCharCode(Number.parseInt(hex, 16)),
						);
					bytes = Uint8Array.from(decoded, (ch) => ch.charCodeAt(0));
				}
				const label = charset.split("*")[0].trim().toLowerCase() || "utf-8";
				return new TextDecoder(label).decode(bytes);
			} catch {
				return match;
			}
		},
	);
}

// ── Address lists ──────────────────────────────────────────────────────

/**
 * Split an address list on the commas that actually separate addresses —
 * not the ones inside `"Lastname, Firstname"` or inside a comment.
 */
function splitAddressList(value: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quoted = false;
	let depth = 0;

	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		if (quoted) {
			if (ch === "\\" && i + 1 < value.length) {
				current += ch + value[++i];
				continue;
			}
			if (ch === '"') quoted = false;
			current += ch;
			continue;
		}
		if (ch === '"') {
			quoted = true;
			current += ch;
			continue;
		}
		if (ch === "<" || ch === "(") depth++;
		else if (ch === ">" || ch === ")") depth = Math.max(0, depth - 1);
		else if (ch === "," && depth === 0) {
			parts.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	parts.push(current);

	return parts.map((p) => p.trim()).filter((p) => p !== "");
}

/**
 * Parse `Name <addr@host>, addr2@host` into envelope addresses.
 *
 * Handles the two shapes actually stored: real `From`/`To` headers (which may
 * carry display names and encoded-words) and the bare comma-joined address
 * columns. Entries with no address part are dropped — the gateway cannot
 * represent them in an IMAP envelope anyway.
 */
export function parseAddressList(value: string | null | undefined): ImapAddress[] {
	if (!value) return [];
	const out: ImapAddress[] = [];

	for (const part of splitAddressList(value)) {
		// Group syntax ("Team: a@x, b@y;") — keep the members, drop the label.
		const bracket = /^(.*?)<([^>]*)>[^>]*$/.exec(part);
		let name = "";
		let address = "";
		if (bracket) {
			name = bracket[1].trim();
			address = bracket[2].trim();
		} else {
			address = part.replace(/\((?:[^()\\]|\\.)*\)/g, "").trim();
		}
		if (!address) continue;

		name = decodeEncodedWords(name).trim();
		if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
			name = name.slice(1, -1).replace(/\\(.)/g, "$1");
		}
		out.push({ name, address });
	}

	return out;
}

// ── Flags ──────────────────────────────────────────────────────────────

/**
 * The IMAP FLAGS list for a row.
 *
 * Four of the five system flags are boolean columns; \Draft is a property of
 * the containing folder, not of the row. Custom keywords come from the
 * `flags` JSON column and are appended, deduped case-insensitively (RFC 9051
 * §2.3.2 makes keywords case-insensitive) so a stored "\\seen" cannot show up
 * twice alongside the derived "\\Seen".
 */
export function deriveImapFlags(
	row: {
		read: number | null;
		starred: number | null;
		answered: number | null;
		deleted: number | null;
		flags: string | null;
	},
	isDraftFolder: boolean,
): string[] {
	const flags: string[] = [];
	const seen = new Set<string>();
	const add = (flag: string) => {
		const key = flag.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		flags.push(flag);
	};

	if (row.read) add("\\Seen");
	if (row.answered) add("\\Answered");
	if (row.starred) add("\\Flagged");
	if (row.deleted) add("\\Deleted");
	if (isDraftFolder) add("\\Draft");
	for (const keyword of parseJsonStringArray(row.flags)) add(keyword.trim());

	return flags;
}

/** Map one metadata row onto the wire shape the gateway decodes. */
function imapMessageFromRow(row: ImapMessageRow, isDraftFolder: boolean): ImapMessage {
	const internalDate = toRfc3339(row.date);

	// INTERNALDATE and the envelope date are different things and are kept
	// that way: `date` is receive time, the envelope date is the message's own
	// `Date:` header out of raw_headers. Falling back to internalDate when the
	// header is missing is a last resort, not the normal path.
	const envelopeDate = row.hdr_date?.trim() ? row.hdr_date.trim() : internalDate;

	return {
		uid: Number(row.uid),
		flags: deriveImapFlags(row, isDraftFolder),
		internalDate,
		rfc822Size: Number(row.rfc822_size ?? row.size_estimate ?? 0),
		envelope: {
			subject: row.subject ?? "",
			// Prefer the stored headers, which are the same bytes the raw
			// endpoint serves, so ENVELOPE and BODY[HEADER] cannot disagree.
			// The columns are only a fallback for rows with no headers.
			from: parseAddressList(row.hdr_from ?? row.sender),
			to: parseAddressList(row.hdr_to ?? row.recipient),
			cc: parseAddressList(row.hdr_cc ?? row.cc),
			messageId: row.message_id ?? "",
			inReplyTo: row.in_reply_to ?? "",
			date: envelopeDate,
		},
		hasRaw: row.raw_key !== null && row.raw_key !== undefined,
	};
}
