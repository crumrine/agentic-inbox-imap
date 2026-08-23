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

import { Hono, type Context } from "hono";
import { z } from "zod";
import {
	IMAP_MAX_UID,
	IMAP_MESSAGES_MAX_LIMIT,
	type ImapRawAttachment,
	type ImapRawSource,
	type ImapRelocateResult,
	type MailboxDO,
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

const MessagesQuery = z.object({
	sinceUid: z.coerce.number().int().min(0).max(IMAP_MAX_UID).optional(),
	// Not `.max()`: an over-large limit is clamped server-side rather than
	// rejected, so a client asking for "everything" gets a bounded page
	// instead of an error. The clamp lives in clampImapLimit.
	limit: z.coerce.number().int().min(1).optional(),
});

/**
 * Caps on a single flag-store request.
 *
 * `MAX_FLAG_UPDATES` bounds the work one call can hand the Durable Object: a
 * client is allowed to STORE a whole selected folder, and the read endpoint
 * only ever shows it IMAP_MESSAGES_MAX_LIMIT messages at a time, so matching
 * that number lets a client act on everything it has seen and no more.
 * `MAX_FLAGS_PER_UPDATE` bounds one message's share of that;
 * IMAP_MAX_KEYWORDS_PER_MESSAGE in the Durable Object is the separate ceiling
 * on what actually gets stored, which a caller cannot climb past by splitting
 * the work across many requests.
 */
const MAX_FLAG_UPDATES = IMAP_MESSAGES_MAX_LIMIT;
const MAX_FLAGS_PER_UPDATE = 64;
/** Long enough for any real keyword; short enough that 64 of them are cheap. */
const MAX_FLAG_LENGTH = 64;

const FlagName = z.string().min(1).max(MAX_FLAG_LENGTH);

/**
 * Caps on a COPY / MOVE / EXPUNGE request.
 *
 * Same reasoning as `MAX_FLAG_UPDATES`: a client is allowed to act on every
 * message the read endpoint has shown it in one page, and no more.
 * `MAX_FOLDER_KEY_LENGTH` bounds the destination string before it reaches the
 * Durable Object — folder ids are slugs, so anything long is not a folder.
 */
const MAX_RELOCATE_UIDS = IMAP_MESSAGES_MAX_LIMIT;
const MAX_FOLDER_KEY_LENGTH = 128;

const UidList = z.array(z.number().int().min(1).max(IMAP_MAX_UID)).max(MAX_RELOCATE_UIDS);

const RelocateBody = z.object({
	uids: UidList,
	destination: z.string().min(1).max(MAX_FOLDER_KEY_LENGTH),
});

/**
 * `uids` absent, null, or an empty object all mean "every message with
 * `\Deleted` set". Only a present list restricts the set (RFC 4315 UID
 * EXPUNGE), and it can only narrow it: a uid named without `\Deleted` is
 * left alone.
 */
const ExpungeBody = z.object({
	uids: UidList.nullish(),
});

const FlagsBody = z.object({
	updates: z
		.array(
			z.object({
				uid: z.number().int().min(1).max(IMAP_MAX_UID),
				add: z.array(FlagName).max(MAX_FLAGS_PER_UPDATE).optional(),
				remove: z.array(FlagName).max(MAX_FLAGS_PER_UPDATE).optional(),
			}),
		)
		.max(MAX_FLAG_UPDATES),
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
	if (!folder || !Number.isInteger(uid) || uid < 1 || uid > IMAP_MAX_UID) {
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

// ── Write API: flags ─────────────────────────────────────

/**
 * POST /api/imap/v1/{mailbox}/{folder}/flags
 *   { "updates": [ { "uid": 3, "add": ["\\Seen"], "remove": ["\\Flagged"] } ] }
 *   -> 200 { "updated": [ { "uid": 3, "flags": ["\\Seen", "\\Answered"] } ] }
 *   -> 400 { "error": "Invalid request" }
 *   -> 404 { "error": "Not found" | "Folder not found" }
 *
 * The write half of the gateway contract, and the endpoint that makes the
 * mailbox usable from a real client at all: iOS Mail sends
 * `UID STORE n +FLAGS.SILENT (\Seen)` as soon as it displays a message, and a
 * `NO` reply makes it drop the connection and reconnect in a loop. Read-only
 * is not a lesser mode here, it is an unusable one.
 *
 * Each entry comes back with its **complete** resulting flag set so the
 * gateway can emit an untagged FETCH without re-reading. Uids that no longer
 * exist are omitted from `updated` rather than failing the batch — a message
 * can vanish between the client's snapshot and its STORE.
 *
 * Auth is the Access service token, same as the read routes above, and for
 * the same reason: the app password is a login credential, not a per-request
 * one. This route mutates, but it mutates only within a mailbox the caller
 * already has full read access to.
 */
imapApi.post("/:mailboxId/:folder/flags", async (c) => {
	let body: z.infer<typeof FlagsBody>;
	try {
		body = FlagsBody.parse(await c.req.json());
	} catch {
		// Never `err.message`: a zod error embeds the input it rejected, which
		// would put message flags and uids into an error body for anything that
		// logs it. 400 says the envelope was wrong and nothing else.
		return c.json(INVALID_REQUEST_BODY, 400);
	}

	const stub = await resolveMailbox(c.env, c.req.param("mailboxId"));
	if (!stub) return c.json(NOT_FOUND_BODY, 404);

	const result = await stub.imapStoreFlags(c.req.param("folder"), body.updates);
	if (!result) return c.json(FOLDER_NOT_FOUND_BODY, 404);

	return c.json(result);
});

// ── Write API: copy, move, expunge ───────────────────────────────────
//
// The other half of "a read-only mailbox is an unusable one". iOS Mail's
// swipe-to-delete is either `+FLAGS (\Deleted)` followed by EXPUNGE or a
// straight MOVE to Trash; both answered `NO` before these routes existed, and
// a `NO` on a routine command is what drops iOS into its reconnect loop.
//
// Shared shape across all three: uids that no longer resolve are skipped and
// omitted from the response rather than failing the batch, exactly as /flags
// does, because a message can vanish between a client's snapshot and its
// command. Everything is applied in one Durable Object round trip inside a
// transaction, so a concurrent reader never sees half a batch.

/**
 * POST /api/imap/v1/{mailbox}/{folder}/copy
 *   { "uids": [3, 4], "destination": "archive" }
 *   -> 200 { "copied": [ { "sourceUid": 3, "destUid": 9 }, ... ] }
 *   -> 400 { "error": "Invalid request" }
 *   -> 404 { "error": "Not found" | "Folder not found" }
 *
 * The source messages are left exactly as they were. The copy shares the
 * original's raw R2 object instead of duplicating the bytes — see
 * `MailboxDO.imapCopyMessages` for what that means for attachments and for
 * the delete path.
 */
imapApi.post("/:mailboxId/:folder/copy", async (c) => {
	const body = await parseRelocateBody(c.req.raw);
	if (!body) return c.json(INVALID_REQUEST_BODY, 400);

	const stub = await resolveMailbox(c.env, c.req.param("mailboxId"));
	if (!stub) return c.json(NOT_FOUND_BODY, 404);

	const result = await stub.imapCopyMessages(c.req.param("folder"), body.destination, body.uids);
	return relocateResponse(c, result, "copied");
});

/**
 * POST /api/imap/v1/{mailbox}/{folder}/move
 *   { "uids": [3, 4], "destination": "trash" }
 *   -> 200 { "moved": [ { "sourceUid": 3, "destUid": 7 }, ... ] }
 *   -> 400 { "error": "Invalid request" }
 *   -> 404 { "error": "Not found" | "Folder not found" }
 *
 * The source uid is retired and never handed out again; the message gets a
 * brand new uid in the destination. Moving to the folder the message is
 * already in is a no-op that reports the uid unchanged, rather than churning
 * it for no reason.
 */
imapApi.post("/:mailboxId/:folder/move", async (c) => {
	const body = await parseRelocateBody(c.req.raw);
	if (!body) return c.json(INVALID_REQUEST_BODY, 400);

	const stub = await resolveMailbox(c.env, c.req.param("mailboxId"));
	if (!stub) return c.json(NOT_FOUND_BODY, 404);

	const result = await stub.imapMoveMessages(c.req.param("folder"), body.destination, body.uids);
	return relocateResponse(c, result, "moved");
});

/**
 * POST /api/imap/v1/{mailbox}/{folder}/expunge
 *   { "uids": [3] }   // optional; absent or null means every \Deleted message
 *   -> 200 { "expunged": [3] }
 *   -> 400 { "error": "Invalid request" }
 *   -> 404 { "error": "Not found" | "Folder not found" }
 *
 * **EXPUNGE moves to Trash everywhere except in Trash, where it destroys.**
 * The reasoning for that decision lives on `MailboxDO.imapExpunge`; the short
 * version is that every mail client spells "delete" as \Deleted + EXPUNGE and
 * every user of one expects that to mean "it is in the Trash", and this app's
 * own UI already works that way.
 *
 * `expunged` holds the source uids that left the folder, ascending, which is
 * what the gateway turns into untagged EXPUNGE responses.
 */
imapApi.post("/:mailboxId/:folder/expunge", async (c) => {
	const uids = await parseExpungeBody(c.req.raw);
	if (uids === INVALID) return c.json(INVALID_REQUEST_BODY, 400);

	const stub = await resolveMailbox(c.env, c.req.param("mailboxId"));
	if (!stub) return c.json(NOT_FOUND_BODY, 404);

	const result = await stub.imapExpunge(c.req.param("folder"), uids);
	if (result.status === "no-folder") return c.json(FOLDER_NOT_FOUND_BODY, 404);

	// The rows are already gone and committed, so a failed purge is a leaked
	// R2 object and nothing worse. Never fail the response over it: the client
	// is owed its EXPUNGE, and telling it the delete failed when the messages
	// are demonstrably gone is the refusal loop all over again.
	if (result.orphanedKeys.length > 0) {
		await purgeR2Keys(c.env.BUCKET, result.orphanedKeys);
	}

	return c.json({ expunged: result.expunged });
});

/**
 * Parse a copy/move body. Null means "reject with 400".
 *
 * Reads the raw Request rather than `c.req.json()` so a malformed body raises
 * here instead of somewhere Hono turns into a 500, and never surfaces the zod
 * error: it embeds the input it rejected, which is a list of uids.
 */
async function parseRelocateBody(
	request: Request,
): Promise<z.infer<typeof RelocateBody> | null> {
	try {
		return RelocateBody.parse(await request.json());
	} catch {
		return null;
	}
}

/** Sentinel for "the expunge body was malformed", distinct from "no uid list". */
const INVALID = Symbol("invalid");

/**
 * Parse an expunge body into a uid list, `null` for "all \Deleted", or
 * `INVALID`. A completely empty body is accepted as `null`: the uid list is
 * optional in the contract, and a client that sends no body at all means the
 * same thing as one that sends `{}`.
 */
async function parseExpungeBody(request: Request): Promise<number[] | null | typeof INVALID> {
	try {
		const raw = (await request.text()).trim();
		const parsed = ExpungeBody.parse(raw === "" ? {} : JSON.parse(raw));
		return parsed.uids ?? null;
	} catch {
		return INVALID;
	}
}

/** Turn a COPY/MOVE result into its response, under the key the contract names. */
function relocateResponse(
	c: Context<{ Bindings: ImapApiEnv }>,
	result: ImapRelocateResult,
	key: "copied" | "moved",
): Response {
	// Source and destination collapse to the same body on purpose. Which of
	// the two the caller got wrong is not a secret worth an extra shape, and
	// keeping one body means no future edit can turn this route into a probe
	// for which folders a mailbox has.
	if (result.status !== "ok") return c.json(FOLDER_NOT_FOUND_BODY, 404);
	return c.json({ [key]: result.entries });
}

/**
 * Delete R2 objects that no row references any more, in batches R2 accepts.
 *
 * Failures are logged and swallowed — see the call site. The keys are not
 * echoed into the log line; the count is enough to notice a systematic leak.
 */
async function purgeR2Keys(bucket: R2Bucket, keys: string[]): Promise<void> {
	const R2_DELETE_BATCH = 1000;
	for (let i = 0; i < keys.length; i += R2_DELETE_BATCH) {
		const batch = keys.slice(i, i + R2_DELETE_BATCH);
		try {
			await bucket.delete(batch);
		} catch (e) {
			console.error(`Failed to purge ${batch.length} expunged R2 object(s):`, (e as Error).message);
		}
	}
}

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
