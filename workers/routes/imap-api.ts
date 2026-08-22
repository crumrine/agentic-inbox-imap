// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * `/api/imap/v1` — the surface the Go IMAP gateway talks to.
 *
 * ## Trust model
 *
 * Everything else in this app is gated by Cloudflare Access alone: pass the
 * team policy and you reach every mailbox. Mail clients cannot speak Access,
 * so the gateway holds an app password on the user's behalf. That is a real
 * and deliberate weakening — a bearer secret now exists that did not before —
 * so this router assumes it is under attack:
 *
 * - The gateway itself still authenticates to the Worker with a **Cloudflare
 *   Access service token** (`CF-Access-Client-Id` / `CF-Access-Client-Secret`).
 *   Access validates the pair at the edge and forwards a signed JWT, so the
 *   middleware in workers/app.ts covers this router unchanged. **The Access
 *   application policy must be configured with an allow rule for that service
 *   token** (Policy action "Service Auth", selector "Service Token"), otherwise
 *   the gateway gets a 403 from the edge and never reaches this code.
 * - The app password is the second factor, checked here.
 *
 * ## Extension
 *
 * The folder and message endpoints live on this same router (see the read API
 * section at the bottom of this file); they inherit the mount point and the
 * Access middleware automatically.
 *
 * An earlier draft of this note said those endpoints must re-check the app
 * password too. They deliberately do not, because the finished Go client does
 * not send one: `gateway/internal/backend/client.go` presents only the Access
 * service-token headers on `/folders`, `/messages` and `/raw`, and holds the
 * app password solely for the one-shot `POST /auth` at IMAP LOGIN. Requiring
 * it per read would mean the gateway replaying a user password on every FETCH
 * — more exposure for the same trust decision, not less.
 */

import { Hono } from "hono";
import { z } from "zod";
import type {
	ImapRawAttachment,
	ImapRawSource,
	MailboxDO,
} from "../durableObject";
import { authRateLimiter } from "../durableObject/authRateLimit";
import { normalizeMailboxId, verifyAppPassword } from "../lib/credentials";
import { buildRawMime, type RawMimeAttachment } from "../lib/raw-mime";
import type { Env } from "../types";

/** Where workers/app.ts mounts this router. Exported so tests mount it identically. */
export const IMAP_API_BASE = "/api/imap/v1";

/**
 * Only the bindings this router actually needs. `MAILBOX` was added when the
 * folder/message endpoints landed; keeping the `Pick` narrow means a route
 * here cannot reach the `AI` binding by accident.
 */
export type ImapApiEnv = Pick<Env, "BUCKET" | "IMAP_AUTH_RATE_LIMIT" | "MAILBOX">;

/**
 * The single failure response. Wrong password, unknown mailbox, mailbox with no
 * app passwords, malformed credential file — all of it collapses to this exact
 * status and body. Nothing here is parameterised, so no future edit can
 * accidentally make one failure distinguishable from another.
 */
const AUTH_FAILURE_BODY = { error: "Authentication failed" } as const;

const RATE_LIMIT_BODY = { error: "Too many authentication attempts" } as const;

const AuthBody = z.object({
	// Length caps only. Rejecting on shape (an @, a valid domain) would turn
	// the validator into an oracle for which strings are plausible mailboxes,
	// and it bounds how many Durable Objects an attacker can name into
	// existence with the rate-limit key.
	mailbox: z.string().min(1).max(320),
	password: z.string().min(1).max(512),
});

export const imapApi = new Hono<{ Bindings: ImapApiEnv }>();

/**
 * POST /api/imap/v1/auth
 *   { "mailbox": "user@example.com", "password": "..." }
 *   -> 200 { "mailbox": "user@example.com" }
 *   -> 401 { "error": "Authentication failed" }
 *   -> 429 { "error": "Too many authentication attempts" }
 */
imapApi.post("/auth", async (c) => {
	let parsed: z.infer<typeof AuthBody>;
	try {
		parsed = AuthBody.parse(await c.req.json());
	} catch {
		// Deliberately not `err.message`: a zod error echoes the parsed input,
		// which is the password. 400 here is about the request envelope and
		// says nothing about any mailbox.
		return c.json({ error: "Invalid request" }, 400);
	}

	const mailbox = normalizeMailboxId(parsed.mailbox);

	// Consume budget before verifying, so an attempt that is abandoned or that
	// errors out still costs the caller.
	const limiter = authRateLimiter(c.env, mailbox);
	const decision = await limiter.consume();
	if (!decision.allowed) {
		return c.json(RATE_LIMIT_BODY, 429, {
			"Retry-After": String(decision.retryAfterSeconds),
		});
	}

	let ok = false;
	try {
		ok = await verifyAppPassword(c.env, mailbox, parsed.password);
	} catch {
		// Fail closed and stay silent. The caught value can carry the R2 key,
		// a fragment of the credential file, or the derivation inputs; none of
		// that belongs in a log line, and the caller learns nothing either way.
		// The attempt has already been counted against the limiter.
		return c.json(AUTH_FAILURE_BODY, 401);
	}

	if (!ok) {
		return c.json(AUTH_FAILURE_BODY, 401);
	}

	// Successful login hands the budget back, so a mail client that reconnects
	// all day never walks into the limit.
	await limiter.reset();

	return c.json({ mailbox });
});

// ── Read API: folders, message metadata, raw bytes ────────────────────
//
// Everything below is consumed by the Go client in
// gateway/internal/backend/client.go and decoded into the structs in
// gateway/internal/backend/types.go. Those struct tags are the contract:
// `uidValidity`, `uidNext`, `rfc822Size`, `internalDate`, `hasRaw`, and a
// messages page of `{ messages, uidNext }`. Renaming a field here does not
// fail anything loudly — encoding/json just leaves the Go field zero — so
// treat the names as fixed.
//
// Auth: these routes sit behind the same Cloudflare Access middleware in
// workers/app.ts as everything else, and deliberately add nothing on top of
// it. The app password is a *login* credential the gateway checks once at
// IMAP LOGIN time via POST /auth; re-checking it per read would mean the
// gateway holding and replaying the user's password on every FETCH, which is
// strictly worse than the service token it already presents.

/** Unknown mailbox. Same body the rest of the app uses for a missing mailbox. */
const NOT_FOUND_BODY = { error: "Not found" } as const;
const FOLDER_NOT_FOUND_BODY = { error: "Folder not found" } as const;
const MESSAGE_NOT_FOUND_BODY = { error: "Message not found" } as const;
const INVALID_REQUEST_BODY = { error: "Invalid request" } as const;
const MESSAGE_TOO_LARGE_BODY = { error: "Message too large to reconstruct" } as const;

/** Largest value a UID can take (RFC 9051: UIDs are 32-bit unsigned). */
const MAX_UID = 4294967295;

const MessagesQuery = z.object({
	sinceUid: z.coerce.number().int().min(0).max(MAX_UID).optional(),
	// Not `.max()`: an over-large limit is clamped server-side rather than
	// rejected, so a client asking for "everything" gets a bounded page
	// instead of an error. The clamp lives in clampImapLimit.
	limit: z.coerce.number().int().min(1).optional(),
});

/**
 * Resolve the `{mailbox}` path segment to a Durable Object stub, or null when
 * no such mailbox exists.
 *
 * Mailbox ids are email addresses. Go's url.PathEscape leaves `@` alone and
 * Hono percent-decodes path params, so `c.req.param` already hands back the
 * decoded address; decoding it a second time (as workers/lib/mailbox.ts does)
 * would mangle an id containing a literal `%`.
 */
async function resolveMailbox(
	env: ImapApiEnv,
	rawId: string | undefined,
): Promise<DurableObjectStub<MailboxDO> | null> {
	if (!rawId) return null;
	const mailboxId = normalizeMailboxId(rawId);
	if (!mailboxId) return null;
	if (!(await env.BUCKET.head(`mailboxes/${mailboxId}.json`))) return null;
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
}

/**
 * GET /api/imap/v1/{mailbox}/folders
 *   -> 200 [{ id, name, uidValidity, uidNext, exists, unseen, recent }, ...]
 *   -> 404 { "error": "Not found" }
 *
 * `id` is the slug the gateway puts back into the URL of the other two
 * endpoints; `name` is the display name it advertises over LIST. They are
 * different strings ("inbox" vs "Inbox") and must both be returned.
 */
imapApi.get("/:mailboxId/folders", async (c) => {
	const stub = await resolveMailbox(c.env, c.req.param("mailboxId"));
	if (!stub) return c.json(NOT_FOUND_BODY, 404);
	return c.json(await stub.imapFolders());
});

/**
 * GET /api/imap/v1/{mailbox}/{folder}/messages?sinceUid=&limit=
 *   -> 200 { messages: [...], uidNext }
 *   -> 400 { "error": "Invalid request" }
 *   -> 404 { "error": "Not found" | "Folder not found" }
 *
 * `{folder}` is the folder **id** (`inbox`, `sent`, a slug for a user-created
 * folder), which is what MailboxDO.imapMessages resolves first.
 *
 * This is the hot path: an IMAP client issues it on every SELECT and every
 * resync, so it must answer everything FETCH needs — flags, INTERNALDATE,
 * RFC822.SIZE, ENVELOPE — without reading a single raw message out of R2. The
 * only R2 call on this route is the mailbox existence head above.
 */
imapApi.get("/:mailboxId/:folder/messages", async (c) => {
	const query = MessagesQuery.safeParse({
		sinceUid: c.req.query("sinceUid"),
		limit: c.req.query("limit"),
	});
	if (!query.success) return c.json(INVALID_REQUEST_BODY, 400);

	const stub = await resolveMailbox(c.env, c.req.param("mailboxId"));
	if (!stub) return c.json(NOT_FOUND_BODY, 404);

	const page = await stub.imapMessages(c.req.param("folder"), query.data);
	if (!page) return c.json(FOLDER_NOT_FOUND_BODY, 404);

	return c.json(page);
});

/**
 * GET /api/imap/v1/{mailbox}/messages/{uid}/raw?folder={folder}
 *   -> 200 message/rfc822
 *   -> 400 { "error": "Invalid request" }
 *   -> 404 { "error": "Not found" | "Folder not found" | "Message not found" }
 *
 * Stored messages stream straight from R2 — the body is never pulled into the
 * isolate. Legacy rows (raw_key NULL, written before raw MIME was kept) are
 * rebuilt on the fly instead, so the gateway never has to special-case a
 * message that has no bytes. A rebuilt message is necessarily buffered: it
 * does not exist until it is assembled.
 */
imapApi.get("/:mailboxId/messages/:uid/raw", async (c) => {
	const folder = c.req.query("folder");
	const uid = Number(c.req.param("uid"));
	if (!folder || !Number.isInteger(uid) || uid < 1 || uid > MAX_UID) {
		return c.json(INVALID_REQUEST_BODY, 400);
	}

	const stub = await resolveMailbox(c.env, c.req.param("mailboxId"));
	if (!stub) return c.json(NOT_FOUND_BODY, 404);

	const found = await stub.imapRawSource(folder, uid);
	if (found.status === "no-folder") return c.json(FOLDER_NOT_FOUND_BODY, 404);
	if (found.status === "no-message") return c.json(MESSAGE_NOT_FOUND_BODY, 404);

	const source = found.message;

	if (source.rawKey) {
		const object = await c.env.BUCKET.get(source.rawKey);
		if (object) {
			return new Response(object.body, {
				headers: {
					"content-type": "message/rfc822",
					"content-length": String(object.size),
				},
			});
		}
		// The row claims stored bytes but R2 does not have them. Falling
		// through to synthesis keeps the promise that every message the
		// metadata endpoint listed can be fetched; 404 here would strand a
		// message in a client's view forever. The key is never echoed.
		console.error(`Raw message missing from R2 for email ${source.id}; synthesizing`);
	}

	let raw: string;
	try {
		raw = await synthesizeRawMime(c.env.BUCKET, source, normalizeMailboxId(c.req.param("mailboxId") ?? ""));
	} catch (e) {
		if (e instanceof SynthesisTooLargeError) {
			// Loud and explicit, not a truncated 200: a partial message here
			// would be exactly what this fallback exists to avoid -- a mail
			// client that fetches it once caches it as complete.
			console.error(e.message);
			return c.json(MESSAGE_TOO_LARGE_BODY, 413);
		}
		throw e;
	}
	const bytes = new TextEncoder().encode(raw);
	return new Response(bytes, {
		headers: {
			"content-type": "message/rfc822",
			"content-length": String(bytes.byteLength),
		},
	});
});

/**
 * Hard ceiling on total attachment bytes (raw, pre-base64) the synthesis path
 * below will hold live for a single legacy row.
 *
 * `readAttachmentBase64` streams each attachment through R2 rather than
 * buffering the whole thing (see its own comment), which cuts peak memory but
 * does not bound it -- the assembled base64 content, the CRLF-rewrapped copy
 * `wrapBase64` makes of it in raw-mime.ts, and the final message string are
 * all still live at once, together several times an attachment's raw size.
 * Nothing here could legitimately exceed `MAX_EMAIL_SIZE` (workers/index.ts's
 * 25 MB inbound acceptance cap) since that is the most any real send or
 * receive could have produced, so a legacy row summing to more than that is
 * either corrupt bookkeeping or adversarial. Either way, refuse outright
 * rather than risk the isolate's 128 MB ceiling assembling a message nothing
 * could have legitimately sent -- the same request this fallback exists to
 * rescue.
 */
export const SYNTHESIS_BUDGET_BYTES = 25 * 1024 * 1024;

/**
 * Thrown by `synthesizeRawMime` when a legacy row's total content exceeds
 * `SYNTHESIS_BUDGET_BYTES`. The `/raw` route turns this into a loud 413
 * instead of letting the request either OOM the isolate or -- worse --
 * silently serve a partial message that a mail client caches as complete.
 */
export class SynthesisTooLargeError extends Error {}

/**
 * Rebuild an RFC 5322 message for a row that has no stored raw bytes.
 *
 * The result is a faithful reconstruction, not the original transmission:
 * signatures will not verify against it and its length will not match the
 * `rfc822Size` estimate the metadata endpoint reported. `hasRaw: false` is
 * how a caller is told which of the two it is holding.
 *
 * @throws {SynthesisTooLargeError} when the row's total content exceeds
 *   `SYNTHESIS_BUDGET_BYTES`.
 */
async function synthesizeRawMime(
	bucket: R2Bucket,
	source: ImapRawSource,
	mailboxId: string,
): Promise<string> {
	// Cheap: `att.size` comes from the metadata row, so this budget check
	// never has to open R2 to be enforced.
	const totalBytes = source.attachments.reduce((sum, att) => sum + att.size, 0) + source.body.length;
	if (totalBytes > SYNTHESIS_BUDGET_BYTES) {
		throw new SynthesisTooLargeError(
			`Legacy message ${source.id} is too large to reconstruct (${totalBytes} bytes exceeds the ${SYNTHESIS_BUDGET_BYTES} byte synthesis budget)`,
		);
	}

	const attachments: RawMimeAttachment[] = [];
	for (const att of source.attachments) {
		const content = await readAttachmentBase64(bucket, source.id, att);
		if (content === null) continue; // Blob gone; a truncated message beats no message.
		attachments.push({
			filename: att.filename,
			type: att.mimetype,
			content,
			contentId: att.content_id ?? undefined,
			disposition: att.disposition ?? undefined,
		});
	}

	// The body column holds whichever of html/text the message had; there is
	// no column recording which. Sniffing for a tag is the only signal left,
	// and guessing wrong only affects the Content-Type of the rebuilt part.
	const isHtml = /<[a-z!/][^>]*>/i.test(source.body);
	const dateHeader = source.dateHeader ? new Date(source.dateHeader) : null;
	const date =
		dateHeader && !Number.isNaN(dateHeader.getTime())
			? dateHeader
			: new Date(source.internalDate);

	return buildRawMime({
		messageId: source.messageId,
		from: source.from
			? source.from.name
				? { email: source.from.address, name: source.from.name }
				: source.from.address
			: mailboxId,
		to: source.toHeader ?? "",
		cc: source.ccHeader,
		bcc: source.bccHeader,
		subject: source.subject,
		html: isHtml ? source.body : null,
		text: isHtml ? null : source.body,
		date,
		inReplyTo: source.inReplyTo,
		references: source.references,
		attachments,
	});
}

/**
 * Attachment blobs are stored at `attachments/{emailId}/{attachmentId}/{filename}`.
 *
 * Streams the R2 body and base64-encodes it as chunks arrive, instead of
 * `object.arrayBuffer()` followed by a from-scratch pass over the whole
 * thing: the old shape held the full raw bytes, a full binary string, and
 * the full base64 string live simultaneously (~3x the attachment size before
 * `wrapBase64` in raw-mime.ts adds a fourth copy). Streaming collapses the
 * first two into a bounded amount of in-flight chunk data, leaving only the
 * base64 output itself as a full-size live value -- see
 * `SYNTHESIS_BUDGET_BYTES` for the hard ceiling on top of this.
 */
async function readAttachmentBase64(
	bucket: R2Bucket,
	emailId: string,
	att: ImapRawAttachment,
): Promise<string | null> {
	const object = await bucket.get(`attachments/${emailId}/${att.id}/${att.filename}`);
	if (!object) return null;
	return streamToBase64(object.body);
}

/**
 * Base64-encode a byte stream incrementally. Base64 groups input 3 bytes at
 * a time, so each chunk read from the stream is combined with the 0-2
 * leftover bytes carried from the previous chunk, encoded down to the
 * largest multiple of 3 (which needs no padding), and the remainder is
 * carried forward; only the final flush -- 0-2 bytes -- may need padding.
 */
export async function streamToBase64(body: ReadableStream<Uint8Array>): Promise<string> {
	const reader = body.getReader();
	let leftover: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
	let out = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value.length === 0) continue;
			const combined = leftover.length === 0 ? value : concatBytes(leftover, value);
			const usableLen = combined.length - (combined.length % 3);
			if (usableLen > 0) out += toBase64(combined.subarray(0, usableLen));
			leftover = combined.subarray(usableLen);
		}
	} finally {
		reader.releaseLock();
	}
	if (leftover.length > 0) out += toBase64(leftover);
	return out;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
	const combined = new Uint8Array(a.length + b.length);
	combined.set(a, 0);
	combined.set(b, a.length);
	return combined;
}

/** Chunked so a large input cannot blow the argument limit of fromCharCode. */
function toBase64(bytes: Uint8Array): string {
	const CHUNK = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}
