// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const folders = sqliteTable("folders", {
	id: text("id").primaryKey(),
	name: text("name").notNull().unique(),
	is_deletable: integer("is_deletable").notNull().default(1),
	/**
	 * IMAP UIDVALIDITY. Set once when the folder is created and never
	 * changed. Unix seconds. Nullable only because SQLite's ALTER TABLE
	 * ADD COLUMN cannot default to a non-constant expression; migration
	 * 9 backfills every pre-existing folder.
	 */
	uid_validity: integer("uid_validity"),
	/** Next UID to hand out in this folder. Monotonic; never decreases. */
	uid_next: integer("uid_next").notNull().default(1),
});

export const emails = sqliteTable("emails", {
	id: text("id").primaryKey(),
	folder_id: text("folder_id")
		.notNull()
		.references(() => folders.id, { onDelete: "cascade" }),
	subject: text("subject"),
	sender: text("sender"),
	recipient: text("recipient"),
	cc: text("cc"),
	bcc: text("bcc"),
	date: text("date"),
	read: integer("read").default(0),
	starred: integer("starred").default(0),
	body: text("body"),
	in_reply_to: text("in_reply_to"),
	email_references: text("email_references"),
	thread_id: text("thread_id"),
	message_id: text("message_id"),
	raw_headers: text("raw_headers"),
	/**
	 * IMAP UID. Unique *within a folder* (see idx_emails_folder_uid),
	 * ascending, never reused. Moving a message to another folder
	 * assigns a new UID there and retires the old one.
	 */
	uid: integer("uid"),
	/** IMAP \Answered */
	answered: integer("answered").default(0),
	/** IMAP \Deleted -- pre-EXPUNGE marker, not an actual row deletion. */
	deleted: integer("deleted").default(0),
	/** JSON array of custom IMAP keywords. */
	flags: text("flags"),
	rfc822_size: integer("rfc822_size"),
	/** R2 key for the raw RFC822 message. NULL for legacy messages. */
	raw_key: text("raw_key"),
	/**
	 * Precomputed IMAP BODYSTRUCTURE as JSON (see
	 * workers/imap/bodystructure.ts). NULL for legacy rows, for rows written
	 * by a path that has no raw bytes, and for any message whose MIME the
	 * deriver declined to model — all three degrade to the gateway parsing
	 * the raw message itself.
	 */
	body_structure: text("body_structure"),
	/**
	 * Which of this mailbox's own addresses the message was delivered to: its
	 * own address, or one of its aliases (see workers/lib/aliases.ts). Set on
	 * the inbound path only, and NULL for every row written before migration
	 * 11 and for every outbound row. NULL means "not known" and every reader
	 * falls back to the mailbox's own address.
	 */
	delivered_to: text("delivered_to"),
});

export const attachments = sqliteTable("attachments", {
	id: text("id").primaryKey(),
	email_id: text("email_id")
		.notNull()
		.references(() => emails.id, { onDelete: "cascade" }),
	filename: text("filename").notNull(),
	mimetype: text("mimetype").notNull(),
	size: integer("size").notNull(),
	content_id: text("content_id"),
	disposition: text("disposition"),
});
