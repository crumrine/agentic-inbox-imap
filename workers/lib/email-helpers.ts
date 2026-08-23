// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared email helpers to eliminate duplication across API routes, MCP, and agent.
 *
 * Includes: DO stub helpers, sender validation, message-ID generation,
 * threading, HTML utilities, and tool-logic (getFullEmail / getFullThread).
 */
import type { MailboxDO } from "../durableObject";
import type { EmailFull } from "./schemas";
import { type AliasEnv, normalizeAddress, resolveAlias } from "./aliases";
import { Folders } from "../../shared/folders";
import type { Env } from "../types";
import { formatQuotedDate } from "../../shared/dates";

// ── DO Stub ────────────────────────────────────────────────────────

/**
 * Resolve a MailboxDO stub from a mailbox email address.
 * Replaces the repeated 3-line ns.idFromName / ns.get pattern.
 */
export function getMailboxStub(
	env: Env,
	mailboxId: string,
): DurableObjectStub<MailboxDO> {
	const ns = env.MAILBOX;
	const id = ns.idFromName(mailboxId);
	return ns.get(id);
}

// ── Mailbox Listing ────────────────────────────────────────────────

/**
 * List all mailboxes from R2 bucket metadata.
 */
export async function listMailboxes(
	bucket: R2Bucket,
): Promise<{ id: string; email: string }[]> {
	const list = await bucket.list({ prefix: "mailboxes/" });
	return list.objects.map((obj) => {
		const id = obj.key.replace("mailboxes/", "").replace(".json", "");
		return { id, email: id };
	});
}

// ── Sender Validation ──────────────────────────────────────────────

/**
 * Normalise to/from addresses and validate the sender matches the mailbox.
 * Returns the normalised values or throws with a user-facing message.
 *
 * `allowedSenders` widens the invariant from "From must equal the mailbox" to
 * "the mailbox, or one of these addresses". It is a caller-supplied list of
 * addresses **already verified** to alias to this mailbox — never a pattern,
 * never a domain. Nothing in here infers membership; a caller that does not
 * pass the list gets the original, strictest behaviour, so every existing call
 * site (including the SMTP submission path in workers/routes/imap-api.ts) keeps
 * exactly the strictness it had.
 *
 * The verification itself is async, so it cannot happen inside this function
 * without changing its signature for every caller. `validateSenderWithAliases`
 * below is the async front door that does the registry read and then delegates
 * here; this stays synchronous and stays the single definition of "the sender
 * matches".
 */
export function validateSender(
	to: string | string[],
	from: string | { email: string; name: string },
	mailboxId: string,
	allowedSenders: readonly string[] = [],
): { toStr: string; fromEmail: string; fromDomain: string } {
	const toStr = (Array.isArray(to) ? to.join(", ") : to).toLowerCase();
	const fromEmail = (typeof from === "string" ? from : from.email).toLowerCase();

	const permitted =
		fromEmail === mailboxId.toLowerCase() ||
		allowedSenders.some((a) => a.trim().toLowerCase() === fromEmail);
	if (!permitted) {
		throw new SenderValidationError("From address must match the mailbox email address");
	}

	const fromDomain = fromEmail.split("@")[1];
	if (!fromDomain) {
		throw new SenderValidationError("Invalid sender email address");
	}

	return { toStr, fromEmail, fromDomain };
}

/**
 * `validateSender`, plus one registry read that lets the mailbox send as an
 * address verified to alias to it.
 *
 * The verification is a keyed read of `aliases/{from}.json` and a comparison of
 * what it points at against this mailbox. It is deliberately *not* a check that
 * the address is on a configured domain: that would let anyone past the Access
 * gate send as any address the deployment owns, which is precisely the spoof
 * the equality check was there to stop. Send is not a hot path, so the read is
 * affordable — and it is skipped entirely when From already equals the mailbox.
 */
export async function validateSenderWithAliases(
	env: AliasEnv,
	to: string | string[],
	from: string | { email: string; name: string },
	mailboxId: string,
): Promise<{ toStr: string; fromEmail: string; fromDomain: string }> {
	const fromEmail = normalizeAddress(typeof from === "string" ? from : from.email);
	const mailbox = normalizeAddress(mailboxId);

	const allowedSenders: string[] = [];
	if (fromEmail !== mailbox) {
		const owner = await resolveAlias(env, fromEmail);
		if (owner === mailbox) allowedSenders.push(fromEmail);
	}

	return validateSender(to, from, mailboxId, allowedSenders);
}

export class SenderValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SenderValidationError";
	}
}

// ── Message ID ─────────────────────────────────────────────────────

/**
 * Generate an internal UUID and a proper RFC 2822 Message-ID.
 */
export function generateMessageId(fromDomain: string): {
	messageId: string;
	outgoingMessageId: string;
} {
	const messageId = crypto.randomUUID();
	const outgoingMessageId = `${messageId}@${fromDomain}`;
	return { messageId, outgoingMessageId };
}

// ── Threading ──────────────────────────────────────────────────────

/**
 * Build the References chain and In-Reply-To from an original email.
 */
export function buildReferencesChain(original: EmailFull): {
	originalMsgId: string;
	references: string[];
	threadId: string;
} {
	const originalMsgId = original.message_id || original.id;
	let existingRefs: string[] = [];
	if (original.email_references) {
		try {
			existingRefs = JSON.parse(original.email_references);
		} catch {
			// Malformed JSON in email_references — treat as empty
		}
	}
	const references = [...existingRefs, originalMsgId].filter(Boolean);
	const threadId = original.thread_id || original.id;
	return { originalMsgId, references, threadId };
}

/**
 * Build threading headers (In-Reply-To + References) for the email binding.
 */
export function buildThreadingHeaders(
	originalMsgId: string,
	references: string[],
): Record<string, string> {
	return {
		"In-Reply-To": `<${originalMsgId}>`,
		...(references.length > 0
			? { References: references.map((r) => `<${r}>`).join(" ") }
			: {}),
	};
}

// ── Draft-follows-in_reply_to ──────────────────────────────────────

/**
 * If the given email is a draft with an in_reply_to, resolve the real original.
 * Used by reply/forward routes to avoid threading against the draft itself.
 */
export async function resolveOriginalEmail(
	stub: DurableObjectStub<MailboxDO>,
	email: EmailFull,
): Promise<EmailFull> {
	if (email.folder_id === Folders.DRAFT && email.in_reply_to) {
		const realOriginal = (await stub.getEmail(email.in_reply_to)) as EmailFull | null;
		if (realOriginal) return realOriginal;
	}
	return email;
}

// ── HTML Utilities ─────────────────────────────────────────────────

/**
 * Escape all five OWASP-recommended HTML special characters in plain text.
 * Safe for use in both text content and attribute contexts.
 */
export function escapeHtml(text: string): string {
	if (!text) return "";
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Convert plain text to a simple HTML block with preserved whitespace.
 * Uses both `white-space:pre-wrap` (modern clients) and `<br>` tags
 * (clients that strip inline styles, e.g. Outlook) as a belt-and-suspenders approach.
 */
export function textToHtml(text: string): string {
	if (!text) return "";
	const escaped = escapeHtml(text).replace(/\n/g, "<br>");
	return `<div style="white-space:pre-wrap">${escaped}</div>`;
}

/**
 * Strip HTML tags and normalize whitespace to produce plain text.
 * Removes <style> and <script> blocks first to avoid injecting their
 * content into the output.
 */
export function stripHtmlToText(html: string): string {
	if (!html) return "";
	return html
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Format a date string for use in quoted reply blocks.
 * @deprecated Use `formatQuotedDate` from `shared/dates` directly.
 */
export const formatEmailDate = formatQuotedDate;

/**
 * Build a quoted reply block HTML string from original email data.
 */
export function buildQuotedReplyBlock(original: {
	date?: string;
	sender?: string;
	body?: string;
}): string {
	if (!original.body) return "";
	
	// HTML-escape sender and date to prevent injection
	const originalSender = escapeHtml(original.sender || "unknown");
	const originalDate = escapeHtml(formatEmailDate(original.date || ""));

	// Sanitize the body to plain text to prevent stored XSS.
	// The original HTML renders safely in the sandboxed iframe, but quoted
	// reply blocks are injected into the compose editor and outgoing emails
	// where raw HTML would execute. Convert to escaped plain text instead.
	const plainBody = stripHtmlToText(original.body);
	const bodyToQuote = escapeHtml(plainBody).replace(/\n/g, "<br>");

	return `<br><blockquote style="border-left: 2px solid #ccc; margin: 0; padding-left: 1em; color: #666;">On ${originalDate}, ${originalSender} wrote:<br><br>${bodyToQuote}</blockquote>`;
}

// ── Client Email Projection ─────────────────────────────────────────

/**
 * The `emails` columns that are safe to hand to something outside the DO's
 * own trust boundary — the SPA, the MCP tool results, and the AI agent's
 * context. An allowlist, so a column added to the table later cannot
 * silently start crossing this boundary.
 *
 * Migration 9 added `uid`, `answered`, `deleted`, `flags`, `rfc822_size` and
 * `raw_key` for IMAP, and the wide-row reads (`getEmail`, `getThreadEmails`)
 * hand back whole rows, so all six started leaking out through both the SPA
 * endpoints (DEV-679) and `getFullEmail`/`getFullThread` below (DEV-688),
 * which feed the MCP `get_email`/`get_thread` tool results and, from there,
 * an LLM's context window. None of the six mean anything to a client or a
 * model, and `raw_key` names an object in R2 — an internal storage path
 * that has no business appearing in prompt content.
 *
 * `/mcp` is reachable by any external client past the Cloudflare Access
 * gate, not just the first-party SPA, so this boundary matters even though
 * neither leak is exploitable on its own (Access gates both).
 *
 * The narrowing lives here rather than in the DO on purpose: the IMAP read
 * paths, the raw-MIME code, `send_reply`/`send_email` and the reply/forward
 * routes all read the same wide rows directly (via `stub.getEmail`) and
 * legitimately need the full set — they are not projected through this.
 *
 * Keep in step with the `Email` interface in app/types/index.ts. The thread
 * aggregate fields there (`thread_count`, `participants`, …) come from the
 * list queries, which already project explicitly, and are simply absent here.
 */
export const CLIENT_EMAIL_FIELDS = [
	"id", "thread_id", "folder_id", "subject", "sender", "recipient",
	"cc", "bcc", "date", "read", "starred", "body", "in_reply_to",
	"email_references", "message_id", "raw_headers", "snippet", "attachments",
] as const;

/** Project a wide `emails` row down to `CLIENT_EMAIL_FIELDS`. */
export function toClientEmail(email: object): Record<string, unknown> {
	const row = email as Record<string, unknown>;
	const projected: Record<string, unknown> = {};
	for (const key of CLIENT_EMAIL_FIELDS) {
		if (key in row) projected[key] = row[key];
	}
	return projected;
}

// ── Tool Logic (getFullEmail / getFullThread) ──────────────────────

type MailboxThreadReaderStub = {
	getThreadEmails: (threadId: string) => Promise<EmailFull[]>;
};

/**
 * Fetch a single email and return it, narrowed to `CLIENT_EMAIL_FIELDS`,
 * with both HTML and plain-text body added. Returns null if not found.
 *
 * Feeds the MCP `get_email` tool result and the AI agent's context — see
 * the block comment on `CLIENT_EMAIL_FIELDS` for why this is narrowed.
 */
export async function getFullEmail(
	stub: DurableObjectStub<MailboxDO>,
	emailId: string,
) {
	const email = (await stub.getEmail(emailId)) as EmailFull | null;
	if (!email) return null;

	const textBody = email.body ? stripHtmlToText(email.body) : "";
	return { ...toClientEmail(email), body_text: textBody, body_html: email.body };
}

/**
 * Fetch all emails in a thread with full bodies in a single DO call, each
 * narrowed to `CLIENT_EMAIL_FIELDS`. Uses `getThreadEmails` which runs 2 SQL
 * queries (emails + attachments) instead of the previous N+1 pattern (1 list
 * query + N getEmail calls).
 *
 * Feeds the MCP `get_thread` tool result and the AI agent's context — see
 * the block comment on `CLIENT_EMAIL_FIELDS` for why this is narrowed.
 */
export async function getFullThread(
	stub: DurableObjectStub<MailboxDO>,
	threadId: string,
) {
	const threadStub = stub as unknown as MailboxThreadReaderStub;
	const emails = await threadStub.getThreadEmails(threadId);

	const enriched: Record<string, unknown>[] = emails.map((email) => {
		const textBody = email.body ? stripHtmlToText(email.body) : "";
		return { ...toClientEmail(email), body_text: textBody };
	});

	// Already sorted ASC by the DO query, but ensure consistency
	enriched.sort(
		(a, b) => new Date(a.date as string).getTime() - new Date(b.date as string).getTime(),
	);

	return { thread_id: threadId, message_count: enriched.length, messages: enriched };
}
