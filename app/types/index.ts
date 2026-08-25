// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface SignatureSettings {
	enabled: boolean;
	text: string;
	html?: string;
}

export interface MailboxSettings {
	fromName?: string;
	forwarding?: { enabled: boolean; email: string };
	signature?: SignatureSettings;
	autoReply?: { enabled: boolean; subject: string; message: string };
	agentSystemPrompt?: string;
}

export interface Mailbox {
	id: string;
	email: string;
	name: string;
	settings?: MailboxSettings;
}

/**
 * One app password as the browser is allowed to see it.
 *
 * Mirrors `AppPasswordMetadata` in workers/lib/credentials.ts, which is the
 * safe projection: no hash, no salt, and nothing derived from the secret. If a
 * field is added there it must stay out of here unless it is safe to render.
 */
export interface AppPassword {
	id: string;
	label: string;
	createdAt: string;
	algorithm: string;
	iterations: number;
}

/**
 * The create response. `password` is plaintext and exists only in this object,
 * only for the lifetime of the dialog that displays it. It must never be
 * written to a query cache, to storage, or to a log.
 */
export interface CreatedAppPassword {
	password: string;
	metadata: AppPassword;
}

/**
 * An address that delivers into a mailbox and that the mailbox may send as.
 *
 * Mirrors `AliasRecord` in workers/lib/aliases.ts.
 */
export interface Alias {
	/**
	 * The alias itself: either a full address (`info@example.com`) or a domain
	 * wildcard, which is a local part with a trailing `@` and nothing after it
	 * (`brian@`) and covers that local part on every domain the deployment
	 * handles. `address.endsWith("@")` is the whole test, and it is safe
	 * because a real address always has a dotted domain after its `@`.
	 */
	address: string;
	mailbox: string;
	createdAt: string;
	/**
	 * The display name this address sends under, in three states: the field
	 * absent means none is configured and the sending client's own display
	 * name is used; `""` means configured-as-blank, so the address goes out
	 * bare; anything else is the name itself. See `AliasDisplayName` in
	 * workers/lib/aliases.ts.
	 */
	name?: string;
}

export interface Email {
	id: string;
	thread_id?: string | null;
	folder_id?: string | null;
	subject: string;
	sender: string;
	recipient: string;
	cc?: string;
	bcc?: string;
	date: string;
	read: boolean;
	starred: boolean;
	body?: string | null;
	in_reply_to?: string | null;
	email_references?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
	attachments?: Attachment[];
	snippet?: string | null;
	/**
	 * Which of the mailbox's addresses this message arrived at — its own, or
	 * one of its aliases. Null on outbound rows and on anything received
	 * before migration 11; the server treats null as the mailbox's own
	 * address when it picks the sending address for a reply.
	 */
	delivered_to?: string | null;
	// Thread aggregate fields (only present in threaded list view)
	thread_count?: number;
	thread_unread_count?: number;
	participants?: string;
	needs_reply?: boolean;
	has_draft?: boolean;
}

export interface Attachment {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string;
	disposition?: string;
}

export interface Folder {
	id: string;
	name: string;
	unreadCount: number;
}
