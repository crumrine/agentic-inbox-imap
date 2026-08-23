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
