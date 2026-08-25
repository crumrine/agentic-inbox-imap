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

import { EmailMessage } from "cloudflare:email";
import { Hono, type Context } from "hono";
import PostalMime from "postal-mime";
import { z } from "zod";
import {
	IMAP_MAX_UID,
	IMAP_MESSAGES_MAX_LIMIT,
	type ImapRawAttachment,
	type ImapRawSource,
	type ImapRelocateResult,
	type MailboxDO,
} from "../durableObject";
import {
	checkSearchCriteriaSize,
	ImapSearchCriteriaSchema,
	type ImapSearchCriteria,
} from "../imap/search";
import { authRateLimiter } from "../durableObject/authRateLimit";
import { normalizeMailboxId, verifyAppPassword } from "../lib/credentials";
import { normalizeAddress } from "../lib/aliases";
import {
	generateMessageId,
	resolveSendAs,
	type SendAsIdentity,
	SenderValidationError,
	validateSenderWithAliases,
} from "../lib/email-helpers";
import {
	buildRawMime,
	type RawMimeAttachment,
	rewriteFromAddress,
	storeRawMime,
} from "../lib/raw-mime";
import type { Env } from "../types";
import { Folders } from "../../shared/folders";

/** Where workers/app.ts mounts this router. Exported so tests mount it identically. */
export const IMAP_API_BASE = "/api/imap/v1";

/**
 * Only the bindings this router actually needs. `MAILBOX` was added when the
 * folder/message endpoints landed; keeping the `Pick` narrow means a route
 * here cannot reach the `AI` binding by accident.
 */
// `EMAIL_ADDRESSES` and `DOMAINS` are here because submission consults the
// alias registry (`validateSenderWithAliases`, `resolveSendAs`), whose
// `AliasEnv` includes both — `DOMAINS` bounds which domains a wildcard alias
// covers, so leaving it out would silently turn wildcard send-as off on this
// path alone.
export type ImapApiEnv = Pick<
	Env,
	| "BUCKET"
	| "DOMAINS"
	| "EMAIL"
	| "EMAIL_ADDRESSES"
	| "IMAP_AUTH_RATE_LIMIT"
	| "MAILBOX"
>;

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
const SEARCH_TOO_LARGE_BODY = { error: "Search too large" } as const;

/**
 * The search request envelope.
 *
 * Strict at both levels: an unrecognised key here or inside `criteria` is a
 * 400, because the alternative is silently ignoring a term the caller
 * believed was applied. Absent or empty `criteria` means "every message in
 * the folder", which is what `SEARCH ALL` asks for.
 */
const SearchBody = z.object({ criteria: ImapSearchCriteriaSchema.optional() }).strict();

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
 * GET /api/imap/v1/{mailbox}/{folder}/status
 *   -> 200 { id, name, uidValidity, uidNext, exists, unseen, recent }
 *   -> 404 { "error": "Not found" | "Folder not found" }
 *
 * One folder, in the shape of one element of `/folders` — the same object,
 * from the same SQL, so the gateway decodes it into the `Folder` struct it
 * already has and cannot see the two endpoints disagree.
 *
 * This exists because `/folders` was answering a question nobody asked
 * (DEV-685). The gateway's poll loop and its IDLE refresh only want to know
 * whether *this* folder grew, and with a client idling that is one full
 * listing of every folder every 30 seconds, all day, almost always to learn
 * nothing changed. It also gives IMAP `STATUS` a direct backing call instead
 * of fetching every folder and throwing all but one away.
 *
 * An unknown folder is a plain 404: same body as everywhere else on this
 * router, naming nothing about what does exist.
 */
imapApi.get("/:mailboxId/:folder/status", async (c) => {
	const stub = await resolveMailbox(c.env, c.req.param("mailboxId"));
	if (!stub) return c.json(NOT_FOUND_BODY, 404);

	const status = await stub.imapFolderStatus(c.req.param("folder"));
	if (!status) return c.json(FOLDER_NOT_FOUND_BODY, 404);

	return c.json(status);
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

// ── Read API: search ─────────────────────────────────────

/**
 * POST /api/imap/v1/{mailbox}/{folder}/search
 *   { "criteria": { "since": "2026-08-01", "header": [{ "key": "from", "value": "alice" }] } }
 *   -> 200 { "uids": [3, 7, 12], "partial": false, "handled": [...], "unhandled": [], "scanned": 12 }
 *   -> 400 { "error": "Invalid request" }
 *   -> 404 { "error": "Not found" | "Folder not found" }
 *   -> 413 { "error": "Search too large" }
 *
 * The push-down half of IMAP SEARCH (DEV-682). The gateway evaluates SEARCH
 * locally today and downloads the raw message for anything the metadata
 * payload cannot answer — BODY, TEXT, BCC, a custom header — with a hard
 * budget of 2000 fetches before it gives up with `NO [LIMIT]`. Answering the
 * cheap half here leaves it a handful of candidates instead of a folder.
 *
 * ## The contract
 *
 * `criteria` mirrors go-imap's `imap.SearchCriteria` field for field, minus
 * `SeqNum` (a property of the gateway's snapshot, not of the mailbox) and
 * `ModSeq` (no CONDSTORE to push down). An unknown key is a 400, never a
 * shrug: a criterion nobody applied and nobody reported is exactly the wrong
 * answer this endpoint is supposed to prevent.
 *
 * **`uids` is the set satisfying every criterion in `handled`, and only
 * those.** Top-level IMAP search keys are a conjunction, so when `partial` is
 * true the caller finishes the job by applying the `unhandled` criteria to
 * `uids` and to nothing else — sound because `uids` is then a superset of the
 * true answer. `handled` and `unhandled` are positional tokens (`"since"`,
 * `"header[1]"`, `"flag[0]"`, `"or[0]"`) naming the exact terms that were
 * sent, so two terms sharing a key stay distinguishable.
 *
 * `workers/imap/search.ts` documents which criteria are answered and why the
 * rest are not — the short version is that BODY and TEXT are *not*, because
 * the `body` column holds the parsed body the app rendered rather than the
 * message's parts, and a search over it is neither sound nor complete.
 *
 * ## Additive by construction
 *
 * A gateway that never calls this endpoint keeps working exactly as it does
 * now: nothing else on this router changed, and this route is the only way
 * into it.
 *
 * Auth is the Access service token, like every other route here.
 */
imapApi.post("/:mailboxId/:folder/search", async (c) => {
	let criteria: ImapSearchCriteria;
	try {
		const body = SearchBody.parse(await c.req.json());
		criteria = body.criteria ?? {};
	} catch {
		// Never `err.message`: a zod error echoes the input, and the input to
		// this route is what the user typed into their mail client's search box.
		return c.json(INVALID_REQUEST_BODY, 400);
	}
	if (!checkSearchCriteriaSize(criteria)) return c.json(INVALID_REQUEST_BODY, 400);

	const stub = await resolveMailbox(c.env, c.req.param("mailboxId"));
	if (!stub) return c.json(NOT_FOUND_BODY, 404);

	const result = await stub.imapSearch(c.req.param("folder"), criteria);
	if (result.status === "no-folder") return c.json(FOLDER_NOT_FOUND_BODY, 404);
	if (result.status === "too-large") {
		// Refused rather than truncated. The response has no way to say "these
		// uids plus some others", so a shortened list would read as a complete
		// answer. The gateway still has its own local evaluation to fall back
		// on, and its own NO [LIMIT] when that runs out too.
		return c.json(SEARCH_TOO_LARGE_BODY, 413);
	}

	return c.json({
		uids: result.uids,
		partial: result.partial,
		handled: result.handled,
		unhandled: result.unhandled,
		scanned: result.scanned,
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

// ── Write API: append ────────────────────────────────────────────────

/**
 * Hard ceiling on a single APPEND body, matched to `MAX_EMAIL_SIZE` in
 * workers/index.ts — the 25 MiB this app already accepts from Cloudflare Email
 * Routing. Two limits for "how big may a message in this mailbox be" that
 * disagree would mean a message a client could APPEND but the inbound path
 * would refuse, or the reverse.
 */
export const IMAP_APPEND_MAX_BYTES = 25 * 1024 * 1024;

const APPEND_TOO_LARGE_BODY = { error: "Message too large" } as const;
const EMPTY_MESSAGE_BODY = { error: "Empty message" } as const;

/**
 * POST /api/imap/v1/{mailbox}/{folder}/append?flags=&internalDate=
 *   Content-Type: message/rfc822
 *   body: the raw RFC 5322 bytes
 *   -> 200 { "uid": 5, "uidValidity": 1787427939, "deduplicated": false }
 *   -> 400 { "error": "Empty message" }
 *   -> 404 { "error": "Not found" | "Folder not found" }
 *   -> 413 { "error": "Message too large" }
 *
 * The last routine IMAP command this gateway still answered `NO` to. iOS Mail
 * APPENDs to save a draft and nearly every client APPENDs a copy of what it
 * just submitted into Sent; a refusal on either is the reconnect loop that ID,
 * STORE and EXPUNGE each caused in turn.
 *
 * **The stored bytes are the client's bytes.** This is the one path in the
 * whole app where the `.eml` in R2 is byte-exact by construction rather than
 * by reconstruction, because the client hands over the actual message. The
 * body is therefore never round-tripped through the MIME builder;
 * `postal-mime` is used only to read the columns out of it, and the same
 * buffer that was parsed is what goes to R2.
 *
 * **Deduplication by Message-ID, in `sent` and nowhere else.** The Sent copy a
 * client appends is the same message the app already recorded on its own send
 * path, so without dedup every sent message shows up twice. A duplicate
 * returns the uid that already exists, applies the flags the client sent, and
 * writes no new row — an answer, not a refusal, so the client still gets a
 * usable `APPENDUID`.
 *
 * The rule stops at Sent deliberately. A client edits a draft by re-APPENDing
 * it with the **same Message-ID** and expunging the old copy; deduplicating
 * there would return the original uid without writing the new body, and the
 * client would then expunge the copy it thought it had just replaced. Silent
 * data loss on a routine action. See `MailboxDO.imapAppendDedup`.
 *
 * Auth is the Access service token, same as every other route on this router.
 */
imapApi.post("/:mailboxId/:folder/append", async (c) => {
	// Cheap rejection before a byte is read, when the client declared a size.
	// A missing or lying Content-Length is caught by the reader's own cap.
	const declared = Number(c.req.header("content-length"));
	if (Number.isFinite(declared) && declared > IMAP_APPEND_MAX_BYTES) {
		return c.json(APPEND_TOO_LARGE_BODY, 413);
	}

	const stub = await resolveMailbox(c.env, c.req.param("mailboxId"));
	if (!stub) return c.json(NOT_FOUND_BODY, 404);

	const raw = await readBoundedBody(c.req.raw, IMAP_APPEND_MAX_BYTES);
	if (raw === TOO_LARGE) return c.json(APPEND_TOO_LARGE_BODY, 413);
	if (raw.byteLength === 0) return c.json(EMPTY_MESSAGE_BODY, 400);

	const parsed = await parseAppendMessage(raw);
	const folderKey = c.req.param("folder");
	const flags = parseAppendFlags(c.req.query("flags"));

	// Pre-flight: 404 an unknown folder, and settle a Sent-copy duplicate,
	// before spending an R2 PUT on bytes that would only be deleted again.
	// The duplicate is the common case for a Sent copy, so this saving is the
	// normal path rather than an optimisation for a corner. On a hit the
	// client's flags are applied to the message that is already there.
	const dedup = await stub.imapAppendDedup(folderKey, parsed.messageId, flags);
	if (dedup.status === "no-folder") return c.json(FOLDER_NOT_FOUND_BODY, 404);
	if (dedup.existingUid !== null) {
		return c.json({
			uid: dedup.existingUid,
			uidValidity: dedup.uidValidity,
			deduplicated: true,
		});
	}

	const mailboxId = normalizeMailboxId(c.req.param("mailboxId") ?? "");
	const emailId = crypto.randomUUID();

	// Bytes before row, so a row never points at an object that is not there.
	// storeRawMime never throws; a failed PUT yields raw_key null and the row
	// still lands, exactly as the inbound path does — /raw then falls back to
	// reconstruction rather than the message vanishing.
	const stored = await storeRawMime(c.env.BUCKET, mailboxId, emailId, raw);

	const result = await stub.imapAppend(folderKey, {
		id: emailId,
		messageId: parsed.messageId,
		subject: parsed.subject,
		sender: parsed.sender,
		recipient: parsed.recipient,
		cc: parsed.cc,
		bcc: parsed.bcc,
		date: appendInternalDate(c.req.query("internalDate")),
		body: parsed.body,
		inReplyTo: parsed.inReplyTo,
		references: parsed.references,
		threadId: parsed.references[0] ?? parsed.inReplyTo ?? emailId,
		rawHeaders: parsed.rawHeaders,
		rawKey: stored.raw_key,
		rfc822Size: raw.byteLength,
		// Derived from the bytes that were just stored, and only when they
		// were stored: if the PUT failed, `/raw` will *synthesize* a message
		// instead of serving these bytes, and a structure describing bytes
		// nobody will ever be served is the one thing worse than none.
		bodyStructure: stored.body_structure,
		flags,
	});

	// The folder vanished between the pre-flight and the write, or a
	// concurrent APPEND of the same Message-ID won the race. Either way the
	// object just written belongs to no row, so take it back out.
	if (result.status === "no-folder" || result.deduplicated) {
		if (stored.raw_key) await purgeR2Keys(c.env.BUCKET, [stored.raw_key]);
	}
	if (result.status === "no-folder") return c.json(FOLDER_NOT_FOUND_BODY, 404);

	return c.json({
		uid: result.uid,
		uidValidity: result.uidValidity,
		deduplicated: result.deduplicated,
	});
});

/** Sentinel for "the body ran past the cap", distinct from any real body. */
const TOO_LARGE = Symbol("too-large");

/**
 * Read a request body into one buffer, refusing past `max` bytes.
 *
 * `c.req.arrayBuffer()` would be the reflex, but it buffers whatever arrives:
 * a client that sends no Content-Length, or lies in it, could hand the
 * isolate far more than the cap before anything noticed. Reading it here
 * means the cap is enforced against bytes actually received.
 *
 * The single-chunk case — every message small enough to arrive in one read —
 * returns that chunk directly, with no copy at all. Otherwise each chunk is
 * released as it is copied into the result, so the peak is one full-size
 * buffer plus one chunk rather than two full-size buffers.
 */
async function readBoundedBody(
	request: Request,
	max: number,
): Promise<Uint8Array | typeof TOO_LARGE> {
	const body = request.body;
	if (!body) return new Uint8Array(0);

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value.byteLength === 0) continue;
			total += value.byteLength;
			if (total > max) {
				await reader.cancel();
				return TOO_LARGE;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	if (chunks.length === 0) return new Uint8Array(0);
	if (chunks.length === 1) return chunks[0];

	const out = new Uint8Array(total);
	let offset = 0;
	while (chunks.length > 0) {
		const chunk = chunks.shift() as Uint8Array;
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/**
 * Per-column caps on what an APPEND writes into SQLite.
 *
 * Not style, correctness: the Durable Object's SQLite refuses a value past
 * roughly 2 MB with `SQLITE_TOOBIG`, and an APPEND is allowed to carry 25 MiB.
 * A plain-text message anywhere near the cap would therefore throw inside the
 * insert and come back a 500 — a refused APPEND, which is the exact failure
 * this endpoint exists to prevent. Measured here: 2,100,000 bytes in one
 * column succeeds and 2,500,000 does not.
 *
 * Truncating is safe in a way it would not be elsewhere in this app, because
 * on this path the row is only a *projection* of the message for the UI and
 * for search. The message itself is in R2 intact and byte-exact, and that is
 * what `/raw` and therefore every IMAP client actually reads. Everything here
 * sums to well under 1 MB even when every field is at its cap.
 */
const APPEND_MAX_BODY_CHARS = 512 * 1024;
const APPEND_MAX_HEADERS_CHARS = 256 * 1024;
const APPEND_MAX_ADDRESS_CHARS = 16 * 1024;
const APPEND_MAX_SUBJECT_CHARS = 8 * 1024;
/** Long enough for any real Message-ID; a longer one is not one. */
const APPEND_MAX_MESSAGE_ID_CHARS = 998;
/** RFC 5322 puts no bound on References; a thread this deep is pathological. */
const APPEND_MAX_REFERENCES = 100;

/** The headers kept when the full set will not fit. Enough for ENVELOPE. */
const APPEND_ENVELOPE_HEADERS = new Set([
	"date",
	"from",
	"sender",
	"reply-to",
	"to",
	"cc",
	"bcc",
	"subject",
	"message-id",
	"in-reply-to",
	"references",
]);

/** Truncate to `max` characters. Null in, null out; empty stays empty. */
function clampText(value: string, max: number): string {
	return value.length <= max ? value : value.slice(0, max);
}

/**
 * Serialise the parsed headers, shrinking rather than corrupting.
 *
 * `raw_headers` is read back with SQLite's `json_extract` (see
 * `imapHeaderSql`), so a value cut off mid-string would not be invalid JSON in
 * some abstract sense — it would silently stop answering, taking every
 * envelope field with it. So an over-long set is filtered down to the headers
 * ENVELOPE actually needs and re-serialised; only if *that* still will not fit
 * is the column left null.
 */
function serializeAppendHeaders(headers: { key: string; value: string }[]): string | null {
	const full = JSON.stringify(headers);
	if (full.length <= APPEND_MAX_HEADERS_CHARS) return full;

	const essential = JSON.stringify(
		headers.filter((h) => APPEND_ENVELOPE_HEADERS.has(h.key.toLowerCase())),
	);
	return essential.length <= APPEND_MAX_HEADERS_CHARS ? essential : null;
}

/** The columns an APPEND fills in, read out of the message the client sent. */
interface AppendColumns {
	messageId: string | null;
	subject: string;
	sender: string;
	recipient: string;
	cc: string | null;
	bcc: string | null;
	body: string;
	inReplyTo: string | null;
	references: string[];
	rawHeaders: string | null;
}

/** An unparseable message still gets stored; it just has nothing to index by. */
const EMPTY_APPEND_COLUMNS: AppendColumns = {
	messageId: null,
	subject: "",
	sender: "",
	recipient: "",
	cc: null,
	bcc: null,
	body: "",
	inReplyTo: null,
	references: [],
	rawHeaders: null,
};

/**
 * Pull the row's columns out of the raw message.
 *
 * Read-only with respect to the bytes: the same buffer is handed to R2
 * afterwards, so nothing here may rebuild or re-encode it. Attachment *rows*
 * are deliberately not written either — the blob key embeds the owning email
 * id and writing them would mean a second pass holding every attachment in
 * memory, which is exactly what the size discipline on this route exists to
 * avoid. `/raw` still serves the attachments perfectly, because it streams the
 * stored bytes. This is the same trade `imapCopyMessages` already makes.
 *
 * A message postal-mime cannot parse is stored anyway, with empty columns: the
 * bytes are the client's and are not ours to reject, and a null Message-ID
 * simply means it can never be recognised as a duplicate.
 */
async function parseAppendMessage(raw: Uint8Array): Promise<AppendColumns> {
	let parsed: Awaited<ReturnType<PostalMime["parse"]>>;
	try {
		parsed = await new PostalMime().parse(raw);
	} catch (e) {
		// Never the message: a parser error can quote the body it choked on.
		console.error("APPEND: could not parse message; storing with empty columns:", (e as Error).name);
		return EMPTY_APPEND_COLUMNS;
	}

	const references = (parsed.references ? parsed.references.split(/\s+/) : [])
		.filter(Boolean)
		.slice(0, APPEND_MAX_REFERENCES)
		.map((ref) => clampText(extractMessageId(ref), APPEND_MAX_MESSAGE_ID_CHARS));

	const messageId = parsed.messageId ? extractMessageId(parsed.messageId) : "";
	const inReplyTo = parsed.inReplyTo ? extractMessageId(parsed.inReplyTo) : "";

	return {
		// Clamped, not rejected: see the cap block above. Every one of these
		// columns is a projection for the UI; the message is intact in R2.
		messageId: messageId ? clampText(messageId, APPEND_MAX_MESSAGE_ID_CHARS) : null,
		subject: clampText(parsed.subject || "", APPEND_MAX_SUBJECT_CHARS),
		sender: clampText((parsed.from?.address || "").toLowerCase(), APPEND_MAX_ADDRESS_CHARS),
		recipient: clampText(addressList(parsed.to), APPEND_MAX_ADDRESS_CHARS),
		cc: clampText(addressList(parsed.cc), APPEND_MAX_ADDRESS_CHARS) || null,
		bcc: clampText(addressList(parsed.bcc), APPEND_MAX_ADDRESS_CHARS) || null,
		body: clampText(parsed.html || parsed.text || "", APPEND_MAX_BODY_CHARS),
		inReplyTo: inReplyTo ? clampText(inReplyTo, APPEND_MAX_MESSAGE_ID_CHARS) : null,
		references,
		rawHeaders: serializeAppendHeaders(parsed.headers),
	};
}

function addressList(addresses: { address?: string }[] | undefined): string {
	if (!addresses) return "";
	return addresses
		.map((a) => a.address)
		.filter((a): a is string => !!a)
		.join(", ");
}

/** `<id@host>` -> `id@host`. Same rule the inbound parser uses. */
function extractMessageId(value: string): string {
	const match = value.match(/<([^>]+)>/);
	return match ? match[1] : value.trim().split(/\s+/)[0] || "";
}

/**
 * The `flags=` query parameter, comma separated.
 *
 * Never rejects. Over the cap is truncated and an over-long atom is dropped,
 * because the whole point of this endpoint is that a routine command must not
 * come back `NO` — and a client that sent a flag we will not store is no worse
 * off than one that sent `\Recent`, which the Durable Object ignores too.
 */
function parseAppendFlags(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(",")
		.map((flag) => flag.trim())
		.filter((flag) => flag !== "" && flag.length <= MAX_FLAG_LENGTH)
		.slice(0, MAX_FLAGS_PER_UPDATE);
}

/**
 * The `internalDate=` query parameter as an ISO timestamp, defaulting to now.
 *
 * An unparseable value falls back to now rather than 400ing. The gateway
 * formats this itself from the APPEND date-time, so a bad one is a bug on our
 * side of the wire — and losing a timestamp is a far smaller failure than
 * refusing the command and restarting the reconnect loop.
 */
function appendInternalDate(raw: string | undefined): string {
	if (raw) {
		const parsed = new Date(raw);
		if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
		console.error("APPEND: unparseable internalDate; using receive time");
	}
	return new Date().toISOString();
}

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
 *
 * Exported because the app's own delete route (workers/index.ts) purges the
 * same key list, produced by the same `MailboxDO.#deleteEmailRows`. Two
 * batching-and-swallowing helpers that had to stay in step is exactly the
 * duplication that let the app path drift into leaking raw objects.
 */
export async function purgeR2Keys(bucket: R2Bucket, keys: string[]): Promise<void> {
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

// ── Write API: submit ────────────────────────────────────────────────

/**
 * Hard ceiling on a submitted message.
 *
 * **Deliberately not `IMAP_APPEND_MAX_BYTES`.** Cloudflare accepts 25 MiB
 * *inbound* but caps what a Worker may *send* at 5 MiB, attachments included,
 * and because attachments travel base64 that is roughly 3.75 MB of real file.
 * Discovering the difference as an opaque upstream refusal after the whole
 * body has been read and the rate limit spent is the bad version of this;
 * refusing here, with the numbers in the message, is the good one.
 */
export const IMAP_SUBMIT_MAX_BYTES = 5 * 1024 * 1024;

/** RFC 5321 §4.5.3.1.8 sets 100 as the minimum a server must accept. */
const SUBMIT_MAX_RECIPIENTS = 100;

/** RFC 5321 §4.5.3.1.3 caps a path at 256 octets. Anything longer is not one. */
const SUBMIT_MAX_ADDRESS_CHARS = 256;

const SUBMIT_EMPTY_BODY = { error: "Empty message" } as const;

/**
 * POST /api/imap/v1/{mailbox}/submit?envelopeFrom=&envelopeTo=
 *   Content-Type: message/rfc822
 *   body: the raw RFC 5322 message the client submitted
 *   -> 200 { "messageId": "<id@domain>", "sentUid": 7, "sentUidValidity": 1787427939 }
 *   -> 400 { "error": ... }   malformed envelope, or an empty body
 *   -> 403 { "error": ... }   sender validation failed
 *   -> 404 { "error": "Not found" }
 *   -> 413 { "error": ... }   over the outbound size cap
 *   -> 429 { "error": ... }   rate limited, with Retry-After
 *   -> 502 { "error": ... }   upstream send failed
 *
 * ## Why this exists
 *
 * Until now a mail client's *outgoing* server pointed somewhere else
 * entirely, so mail sent from a phone never entered this app at all: nothing
 * landed in Sent, `validateSender` never ran, and the per-mailbox rate limit
 * did not apply to the one path most able to abuse it. This endpoint is what
 * the gateway's SMTP submission listener calls, so a client's send goes
 * through the same three gates the SPA already passes.
 *
 * ## The envelope is not the headers
 *
 * Delivery uses `envelopeTo`, never the `To:`/`Cc:` of the message. They
 * differ whenever there is a Bcc — that *is* Bcc — so reading recipients out
 * of the headers would silently drop every blind copy while appearing to
 * work. The gateway has the real RCPT TO list; it passes it here and it is
 * what gets used.
 *
 * ## Sender validation runs twice, on purpose
 *
 * Once on the SMTP envelope (`envelopeFrom`) and once on the message's own
 * `From:` header. A client that authenticated as one mailbox and put another
 * address in either place is refused. Both go through the same
 * `validateSenderWithAliases` the SPA send paths use, rather than a
 * hand-rolled comparison, so there is exactly one definition of "the sender
 * matches".
 *
 * ## Aliases (DEV-692 part two)
 *
 * "Matches" means the mailbox's own address **or** an address the registry
 * says aliases to it. This path used the synchronous `validateSender`, which
 * accepts only the mailbox's own address, so a real mail client could not send
 * as `info@` at all — the one client where there is no server-side reply flow
 * to pick the address for the user, and so the one that most needs to be able
 * to say it itself. Nothing is inferred: `validateSenderWithAliases` reads
 * `aliases/{from}.json` and checks it points here. An address on a configured
 * domain with no record is still refused, exactly as before.
 *
 * ## The bytes are the client's bytes
 *
 * What goes to the upstream, what goes to R2 and what `/raw` later serves are
 * the same buffer. Nothing here re-encodes the message: an MSA that rewrites
 * a submission breaks S/MIME signatures and mangles anything the builder does
 * not model. The two exceptions are a message with no `Message-ID:` at all,
 * below, and automatic send-as, next.
 *
 * ## Automatic send-as (DEV-692 part three)
 *
 * Part two made an alias *permitted* here: the client picks the From address
 * and this endpoint stopped refusing it. That is enough for a client that can
 * pick — macOS Mail can — and no help at all to iOS Mail, which only ever
 * emits the account address. So a reply to something that arrived at `info@`
 * went back out as the mailbox, which is the bug the whole feature exists to
 * fix, on the one client the user actually sends from.
 *
 * `resolveSubmissionSendAs` below rewrites the From address, but only when the
 * client is demonstrably using its default. If the client set From to anything
 * other than the mailbox's own address that is a deliberate choice by a client
 * that supports alias selection, and it is honoured untouched — silently
 * overriding it would be a worse bug than the one being fixed. There is no way
 * to tell "the user chose the default" from "the client can only produce the
 * default", so confining the rewrite to the default is what keeps this from
 * overriding intent.
 *
 * The rewrite changes the `From:` header **in the raw bytes** and the SMTP
 * envelope sender together. Either alone is an inconsistent message: a
 * mismatched envelope is what SPF and DMARC alignment are checked against.
 *
 * `rewriteFromAddress` splices the address in place rather than rebuilding the
 * message, so the byte-exactness above still holds everywhere except that one
 * span — `Message-ID:` included, which is what keeps the client's own APPENDed
 * Sent copy able to deduplicate against the row written here.
 *
 * ## Per-alias display names
 *
 * An alias can carry a display name, and when it does the rewrite replaces the
 * whole `From:` value rather than only the address: a reply from `info@` goes
 * out as `Support <info@example.com>` instead of inheriting the phone's account
 * name. A name configured as the empty string is a real setting meaning "no
 * display name", and produces the bare `<info@example.com>` form. An alias with
 * nothing configured is untouched in every respect — the client's own display
 * name survives verbatim, exactly as before. The whole edit still lives inside
 * the `From:` header's span.
 *
 * ## Message-ID is preserved, and that is load-bearing
 *
 * Clients APPEND their own Sent copy right after submitting, and
 * `/{folder}/append` deduplicates against `sent` **by Message-ID**. Minting a
 * fresh id here would leave the client's copy unable to match, and every sent
 * message would appear twice. So the id read out of the submitted message is
 * what the Sent row records.
 *
 * A message with no `Message-ID:` gets one generated *and inserted into the
 * bytes*, which is what RFC 4409 §8.1 asks a submission server to do. Note
 * that the client's later APPEND still carries no Message-ID, so that one copy
 * genuinely cannot dedup and will show up twice. Every real client sets the
 * header; this path exists so a message without one is still delivered rather
 * than refused.
 */
imapApi.post("/:mailboxId/submit", async (c) => {
	// Cheap rejection before a byte is read, when the client declared a size.
	// A missing or lying Content-Length is caught by the reader's own cap.
	const declared = Number(c.req.header("content-length"));
	if (Number.isFinite(declared) && declared > IMAP_SUBMIT_MAX_BYTES) {
		return c.json(tooLargeBody(declared), 413);
	}

	const rawMailboxId = c.req.param("mailboxId") ?? "";
	const mailboxId = normalizeMailboxId(rawMailboxId);
	const stub = await resolveMailbox(c.env, rawMailboxId);
	if (!stub) return c.json(NOT_FOUND_BODY, 404);

	const envelope = parseEnvelope(c.req.query("envelopeFrom"), c.req.queries("envelopeTo"));
	if (!envelope) return c.json(INVALID_REQUEST_BODY, 400);

	// Envelope first, so a mismatched MAIL FROM is refused without reading a
	// 5 MiB body off the wire.
	const envelopeCheck = await checkSender(c.env, envelope.to, envelope.from, mailboxId);
	if (envelopeCheck) return c.json({ error: `Envelope sender rejected: ${envelopeCheck}` }, 403);

	const raw = await readBoundedBody(c.req.raw, IMAP_SUBMIT_MAX_BYTES);
	if (raw === TOO_LARGE) return c.json(tooLargeBody(null), 413);
	if (raw.byteLength === 0) return c.json(SUBMIT_EMPTY_BODY, 400);

	const parsed = await parseAppendMessage(raw);

	// The header `From:`, through the same validator. `parsed.sender` is the
	// address already lowercased; a message with no From at all arrives here
	// as "" and is refused, which is the right answer.
	const headerCheck = await checkSender(c.env, envelope.to, parsed.sender, mailboxId);
	if (headerCheck) return c.json({ error: `From header rejected: ${headerCheck}` }, 403);

	const limited = await stub.checkSendRateLimitDetailed();
	if (limited) {
		return c.json({ error: limited.error }, 429, {
			"Retry-After": String(limited.retryAfterSeconds),
		});
	}

	let outbound = raw;
	// The envelope sender and the Sent row's `sender`, which automatic send-as
	// moves in step with the `From:` header — see the block comment above.
	let envelopeFrom = envelope.from;
	let sender = parsed.sender;

	const sendAs = await resolveSubmissionSendAs(c.env, stub, mailboxId, envelope.from, parsed);
	if (sendAs) {
		// `sendAs.name` is the alias's configured display name, or undefined
		// when it has none — in which case the client's own display name is
		// left exactly where it is, as it always was.
		const rewritten = rewriteFromAddress(raw, parsed.sender, sendAs.address, sendAs.name);
		if (rewritten) {
			outbound = rewritten;
			envelopeFrom = sendAs.address;
			sender = sendAs.address;
		} else {
			// A `From:` this cannot splice unambiguously. Falling through sends
			// the client's bytes untouched, which is the pre-send-as behaviour:
			// the reply goes out as the mailbox rather than the alias. Worth a
			// line in the log, not worth refusing a send over.
			console.error("SUBMIT: could not rewrite From for automatic send-as; sending as the mailbox");
		}
	}

	// RFC 4409 §8.1: supply a Message-ID when the submission has none. Done by
	// prepending a header line — header order is free in RFC 5322 — so the
	// bytes sent, the bytes stored and the id reported all still agree.
	let messageId = parsed.messageId;
	if (!messageId) {
		const fromDomain = mailboxId.split("@")[1] ?? "invalid";
		messageId = generateMessageId(fromDomain).outgoingMessageId;
		outbound = concatBytes(
			new TextEncoder().encode(`Message-ID: <${messageId}>\r\n`),
			outbound,
		);
		console.error(
			"SUBMIT: message had no Message-ID; generated one. The client's own " +
				"APPENDed Sent copy will not deduplicate against this row.",
		);
	}

	// Send before recording. A Sent row for a message that never left is worse
	// than no row: it is what the user reads to decide whether to send again,
	// and it also counts against the rate limit. The other send paths record
	// first and deliver in `waitUntil` because their caller is a browser that
	// wants a 202; here the caller is an SMTP listener holding a client
	// connection open for a real answer.
	const delivery = await deliverToEnvelope(c.env.EMAIL, envelopeFrom, envelope.to, outbound);
	if (delivery.delivered.length === 0) {
		return c.json({ error: `Upstream send failed: ${delivery.reason}` }, 502);
	}

	const emailId = crypto.randomUUID();
	// Bytes before row, so a row never points at an object that is not there.
	// storeRawMime never throws; a failed PUT yields raw_key null and the row
	// still lands, exactly as APPEND and the inbound path do.
	const stored = await storeRawMime(c.env.BUCKET, mailboxId, emailId, outbound);

	const recorded = await stub.imapAppend(Folders.SENT, {
		id: emailId,
		messageId,
		subject: parsed.subject,
		// `sender`, not `parsed.sender`: after a send-as rewrite the two differ,
		// and this column has to agree with the `From:` in the stored bytes.
		sender,
		// The header recipients, not the envelope: this column is what the SPA
		// renders as "To", and showing Bcc'd addresses there would leak them
		// back into the thread view. The envelope list is not persisted.
		recipient: parsed.recipient,
		cc: parsed.cc,
		bcc: parsed.bcc,
		date: new Date().toISOString(),
		body: parsed.body,
		inReplyTo: parsed.inReplyTo,
		references: parsed.references,
		threadId: parsed.references[0] ?? parsed.inReplyTo ?? emailId,
		rawHeaders: parsed.rawHeaders,
		rawKey: stored.raw_key,
		rfc822Size: outbound.byteLength,
		// `outbound`, not `raw`: those differ by a generated Message-ID
		// header, and `outbound` is what went to R2 and to the recipient.
		// Null when the PUT failed, for the same reason as APPEND.
		bodyStructure: stored.body_structure,
		flags: ["\\Seen"],
	});

	if (recorded.status === "no-folder" || recorded.deduplicated) {
		// The object just written belongs to no row. `no-folder` cannot
		// normally happen — every mailbox gets `sent` from the migrations —
		// and `deduplicated` means the client raced its own APPEND in ahead of
		// this response.
		if (stored.raw_key) await purgeR2Keys(c.env.BUCKET, [stored.raw_key]);
	}

	if (recorded.status === "no-folder") {
		// The mail is already gone. Reporting a failure here would make the
		// gateway retry and send it a second time, so this answers 200 with a
		// uid of 0: the gateway simply omits APPENDUID.
		console.error(`SUBMIT: mailbox has no ${Folders.SENT} folder; message sent but not recorded`);
		return c.json({ messageId: `<${messageId}>`, sentUid: 0, sentUidValidity: 0 });
	}

	if (delivery.failed.length > 0) {
		// Partial delivery. The message left for someone, so it is recorded and
		// the call succeeds; the gateway needs the list to tell the client
		// which recipients to retry, and re-submitting the whole message would
		// double-deliver to everyone who did get it.
		console.error(`SUBMIT: ${delivery.failed.length} of ${envelope.to.length} recipients failed`);
	}

	return c.json({
		messageId: `<${messageId}>`,
		sentUid: recorded.uid,
		sentUidValidity: recorded.uidValidity,
		...(delivery.failed.length > 0 ? { failedRecipients: delivery.failed } : {}),
	});
});

/**
 * The 413 body. Says what the limit is and, when the size is known, what was
 * sent — a human staring at a stuck Outbox can act on "your attachment is too
 * big", not on "too large".
 */
function tooLargeBody(declaredBytes: number | null): { error: string } {
	const limit = `${IMAP_SUBMIT_MAX_BYTES / (1024 * 1024)} MiB`;
	const actual = declaredBytes === null ? "" : ` (this one is ${(declaredBytes / (1024 * 1024)).toFixed(1)} MiB)`;
	return {
		error:
			`Message too large to send${actual}. The outbound limit is ${limit} including ` +
			"attachments, which are base64-encoded and so about a third larger than the " +
			"original files. Send fewer or smaller attachments, or share a link instead.",
	};
}

/**
 * The `envelopeFrom` / `envelopeTo` query parameters.
 *
 * `envelopeTo` may repeat and each occurrence may be a comma-separated list,
 * because both spellings are natural for a caller building a query string out
 * of a RCPT TO list. Null means "reject with 400": an envelope is not
 * something to guess at, and falling back to the header recipients is exactly
 * the Bcc-dropping bug this endpoint exists to avoid.
 */
function parseEnvelope(
	from: string | undefined,
	to: string[] | undefined,
): { from: string; to: string[] } | null {
	const fromAddress = (from ?? "").trim();
	if (!fromAddress || fromAddress.length > SUBMIT_MAX_ADDRESS_CHARS) return null;

	const recipients = (to ?? [])
		.flatMap((value) => value.split(","))
		.map((value) => value.trim())
		.filter(Boolean);

	if (recipients.length === 0 || recipients.length > SUBMIT_MAX_RECIPIENTS) return null;
	if (recipients.some((r) => !r.includes("@") || r.length > SUBMIT_MAX_ADDRESS_CHARS)) return null;

	return { from: fromAddress, to: recipients };
}

/**
 * The address this submission should go out as, or null for "leave the
 * client's message exactly as it is".
 *
 * Three conditions, all of which must hold. Each is a guard against a
 * different way this could be wrong:
 *
 * 1. **The client is using its default.** Both the message's `From:` and the
 *    SMTP envelope sender are the mailbox's own address. iOS Mail can produce
 *    nothing else, which is why this feature is needed at all; a client that
 *    put an alias in either place chose it deliberately and is honoured
 *    untouched. "The user picked the default" and "the client can only emit
 *    the default" are indistinguishable from here, so the default is the only
 *    thing safe to overwrite.
 *
 * 2. **It is a reply to a message this mailbox actually holds, which knows
 *    where it was delivered.** No `In-Reply-To`/`References` means a fresh
 *    compose, and a fresh compose has no routing address to inherit and
 *    nothing to infer one from — the same reasoning as the `POST /emails`
 *    route in workers/index.ts. `In-Reply-To` is tried first and the tail of
 *    `References` second, per the threading logic in `receiveEmail`: both name
 *    the direct parent, and the direct parent is the message being answered.
 *    A parent with a NULL `delivered_to` — every row written before migration
 *    11, and every outbound row — is a complete answer meaning "not known".
 *
 * 3. **The alias still resolves here, checked now.** `resolveSendAs` does
 *    exactly this and falls back to the mailbox address, so a `delivered_to`
 *    naming an alias that has since been deleted or re-pointed at somebody
 *    else's mailbox comes back as the mailbox's own address — which this reads
 *    as "nothing to do". The stored string is never trusted as stored; see the
 *    block comment on `resolveReplyFrom` for why that matters. The same read
 *    also yields the alias's configured display name, which the rewrite puts
 *    on the header alongside the address.
 *
 * A domain-wildcard alias (`brian@`) reaches this path through condition 2 and
 * nothing else, and that is the intended shape rather than a gap. `checkSender`
 * above runs before any of this, on the address the *client* chose, and it
 * consults the exact registry only — so a client that names a wildcard-covered
 * address itself is refused, while a client using its default and answering a
 * message that really arrived at `brian@b.example` is rewritten to it. The
 * asymmetry is the point: condition 2 is delivery evidence, and a From header
 * a client typed is not.
 */
async function resolveSubmissionSendAs(
	env: ImapApiEnv,
	stub: DurableObjectStub<MailboxDO>,
	mailboxId: string,
	envelopeFrom: string,
	parsed: AppendColumns,
): Promise<SendAsIdentity | null> {
	if (parsed.sender !== mailboxId) return null;
	if (normalizeAddress(envelopeFrom) !== mailboxId) return null;

	const parents = [parsed.inReplyTo, parsed.references.at(-1)].filter(
		(id): id is string => !!id,
	);
	const candidates = [...new Set(parents)];
	if (candidates.length === 0) return null;

	const deliveredTo = await stub.lookupDeliveredTo(candidates);
	if (!deliveredTo) return null;

	const identity = await resolveSendAs(env, mailboxId, deliveredTo);
	return identity.address === mailboxId ? null : identity;
}

/**
 * Run sender validation and return its message, or null when it passes.
 *
 * Wrapping rather than reimplementing matters: this is the invariant the whole
 * app rests on, and a second copy of the comparison here is how the two would
 * eventually disagree. Async because the alias check is one keyed R2 read —
 * and it is skipped entirely when From already equals the mailbox.
 */
async function checkSender(
	env: ImapApiEnv,
	to: string[],
	from: string,
	mailboxId: string,
): Promise<string | null> {
	try {
		await validateSenderWithAliases(env, to, from, mailboxId);
		return null;
	} catch (e) {
		if (e instanceof SenderValidationError) return e.message;
		throw e;
	}
}

/**
 * Hand the raw message to the upstream, once per envelope recipient.
 *
 * The binding's raw form takes a single RCPT TO, so a multi-recipient
 * submission is N sends of the same bytes. They go out together rather than in
 * a loop of awaits: `SUBMIT_MAX_RECIPIENTS` is 100, and a hundred round trips
 * in series would keep the client's SMTP connection open long past where it
 * gives up.
 *
 * `allSettled` rather than `all`, because a partial failure is a real outcome
 * here and the caller has to be able to tell it from a total one — the message
 * has left for some recipients and re-submitting would deliver to them twice.
 *
 * `reason` is the first failure's message, and it is a message from the
 * binding — not a stack, not a key, not the message body — so it is safe to
 * hand back to the gateway, which is what makes a 502 diagnosable rather than
 * opaque.
 */
async function deliverToEnvelope(
	binding: SendEmail,
	from: string,
	recipients: string[],
	raw: Uint8Array,
): Promise<{ delivered: string[]; failed: string[]; reason: string }> {
	const results = await Promise.allSettled(
		// A stream of the original bytes, not `TextDecoder().decode(raw)`.
		// Decoding would run the message through UTF-8 replacement, so a
		// submission carrying 8-bit non-UTF-8 content — an 8BITMIME body in a
		// legacy charset is the everyday case — would arrive full of U+FFFD.
		// A stream is consumed once, so each recipient gets its own over the
		// same underlying buffer.
		recipients.map((to) => binding.send(new EmailMessage(from, to, bytesToStream(raw)))),
	);

	const delivered: string[] = [];
	const failed: string[] = [];
	let reason = "";

	results.forEach((result, i) => {
		if (result.status === "fulfilled") {
			delivered.push(recipients[i]);
			return;
		}
		failed.push(recipients[i]);
		const error = result.reason as Error;
		if (!reason) reason = error?.message || error?.name || "unknown error";
		console.error("SUBMIT: upstream refused a recipient:", error?.name);
	});

	return { delivered, failed, reason: reason || "no recipients" };
}

/** A single-chunk stream over `bytes`. Nothing is copied. */
function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}
