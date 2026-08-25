// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Address aliases: let `info@`, `contact@` and friends deliver into one
 * mailbox, and let that mailbox send back out as any of them.
 *
 * ## Why a separate R2 key, and not the settings blob
 *
 * An alias lives at `aliases/{address}.json` holding `{"mailbox": "..."}` and,
 * optionally, the display name that address sends under (see
 * `AliasDisplayName`). Two properties fall out of that shape and both are the
 * reason for it:
 *
 * 1. **Resolution is one keyed R2 read.** The inbound path runs on every
 *    message that does not match a mailbox outright, and a listing/scan there
 *    would cost more the more aliases exist. `mailboxes/{id}.json` already
 *    works this way — the object's *existence* is what makes a mailbox real —
 *    so aliases mirror it rather than inventing a second idea of storage.
 * 2. **It is not reachable from an AI code path.** The obvious alternative,
 *    an `aliases: []` array inside `mailboxes/{id}.json`, puts the list inside
 *    the object `getSystemPrompt()` in workers/agent/index.ts loads to build
 *    the model's system prompt. Same reasoning as workers/lib/credentials.ts:
 *    anything beside `agentSystemPrompt` is one careless `JSON.stringify` away
 *    from a prompt. It would also be a second copy of the address→mailbox
 *    mapping, and two copies drift.
 *
 * ## EMAIL_ADDRESSES
 *
 * When `EMAIL_ADDRESSES` in wrangler.jsonc is non-empty it is read here as the
 * allowlist of every address this Worker will handle *at all*, not just of
 * addresses that may become mailboxes. An alias outside the list is refused at
 * creation, because `receiveEmail` filters inbound recipients against the same
 * list before any alias lookup happens — an alias that is not on it could
 * never receive a message, so accepting one would only create a record that
 * silently does nothing. An empty list means "any address on DOMAINS", exactly
 * as it does for mailbox creation.
 *
 * ## Display names
 *
 * An alias can carry the display name it presents itself under, so `info@`
 * sends as `Acme Info <info@example.com>` rather than inheriting the mailbox
 * owner's personal name from whatever client is sending. The name is stored
 * here, beside the address it belongs to, because it is a property *of the
 * alias* — the alternative, per-mailbox settings, would have no place to put a
 * different name for each address. It never reaches an AI code path for the
 * same reason the mapping does not: see point 2 above.
 *
 * Nothing in this module encodes or escapes the name. Storing it is gated on
 * `isValidAliasName`, and the one encoder is `formatFromMailbox` in
 * workers/lib/raw-mime.ts, which every send path goes through.
 *
 * ## Domain-wildcard aliases
 *
 * An alias may also be a bare local part with no domain — spelled `brian@` —
 * which covers `brian@` on **every domain this deployment handles**, with no
 * per-domain record. That is what a catch-all pointed at this Worker asks
 * for: "everything brian@ is mine", whichever domain it arrived on.
 *
 * ### The key shape, and why it cannot collide
 *
 * A wildcard is stored at `aliases/{localPart}@.json` — the same key space as
 * every other alias, with no prefix, no marker field and no migration. It
 * cannot collide with an exact-address key because **a real address never ends
 * in `@`**: `isPlausibleAddress` requires at least one non-`@` character and a
 * dot after the `@`, so `local@domain.tld` and `local@` are disjoint sets of
 * strings, and every key written before this feature existed is in the first
 * set. `listAliases` therefore keeps reading one prefix and gets both kinds
 * back, already distinguishable by their own spelling.
 *
 * The trailing `@` is also the canonical spelling everywhere above this
 * module — the API takes it, the record carries it, the settings page shows
 * it. A bare token with no `@` at all is *not* accepted as a wildcard, on
 * purpose: `not-an-address` is overwhelmingly a typo, and reading it as
 * "every domain" would turn a typo into a catch-all.
 *
 * ### Resolution: most specific wins, and inbound stays O(1)
 *
 * A mailbox at the address beats an exact alias at it, which beats a wildcard
 * on its local part. `readDeliveryAlias` is the whole of the second and third:
 * one keyed read of the exact address, and — only if that misses — one keyed
 * read of the wildcard. No listing, ever. The inbound path runs on every
 * message that does not match a mailbox outright, and it must not get slower
 * as the registry grows.
 *
 * ### A wildcard matches the envelope recipient and nothing else
 *
 * "Every domain this deployment handles" needs a boundary, or `brian@` means
 * `brian@` anywhere in the world. The boundary is **provenance, not
 * configuration**: a wildcard may only match the SMTP envelope recipient.
 *
 * The envelope recipient is the address Cloudflare actually routed to this
 * Worker, and Email Routing only delivers domains the account owns — so
 * delivery itself is the proof that the domain is ours. The header `To:`
 * addresses are candidates too, and they are written by the *sender*: without
 * this rule a stranger addresses `To: brian@attacker.example`, the wildcard
 * accepts it, and `brian@attacker.example` sits in `delivered_to` one reply
 * away from being a From address this deployment does not own.
 *
 * It is the same reasoning that makes `delivered_to` sound evidence for
 * send-as, applied one step earlier. No envelope recipient at all — `event.to`
 * is optional — means no wildcard match, which is the fail-closed direction.
 *
 * Exact aliases and real mailboxes are unaffected and still match any
 * candidate, header `To:` included: those are explicit records for addresses
 * the deployment already holds, so a sender naming one is not asserting
 * anything the operator has not already written down.
 *
 * This replaced an earlier gate on the `DOMAINS` env var. `DOMAINS` is a
 * hand-maintained list feeding a UI hint, and a list that has to be kept in
 * sync with reality is a standing footgun — a stale or placeholder value
 * silently turns every wildcard off. Provenance needs no configuration.
 *
 * ## What this module deliberately does not do
 *
 * It never infers an alias from a pattern or a domain *on the outbound side*.
 * `resolveAlias` reads an exact record or returns null, and a wildcard is
 * invisible to it. That matters most where `validateSender` uses it to decide
 * whether an address may be spoofed as: a domain check there would let any
 * address on a configured domain send as the mailbox, which is the exact hole
 * the registry exists to close — and a wildcard resolved from an address alone
 * would say "may send as brian@anything", which is the same hole wearing a
 * different hat (see DEV-699: alias creation does not validate domains).
 *
 * A wildcard grants send-as for `brian@X` on exactly one condition: the
 * message being answered was **actually delivered to `brian@X`**, which is
 * what `delivered_to` records. That column is written in one place, from the
 * resolution above, and the message physically arriving proves Cloudflare
 * routes that domain here. `readDeliveryAlias` makes that precondition an
 * argument rather than a naming convention: its wildcard half is off unless
 * the caller passes `allowWildcard`, and the only two callers that may are the
 * ones holding a delivered address. Compose has no such address and falls back
 * to the mailbox's own, which is correct and safe.
 */

import type { Env } from "../types";

/**
 * The bindings this module touches. Narrower than `Env` on purpose — alias
 * resolution has no business reaching the AI binding, the mailbox Durable
 * Object, or the send-email binding.
 *
 * `DOMAINS` is deliberately **not** here. It is a UI hint, and nothing about
 * which addresses this deployment holds is decided from it: a wildcard is
 * bounded by where a message came from (see the module comment), and an exact
 * alias is never inferred from a domain at all.
 */
export type AliasEnv = Pick<Env, "BUCKET" | "EMAIL_ADDRESSES">;

/**
 * A display name configured on an alias, in three states that are all real and
 * all different:
 *
 * - `undefined` — **not configured.** Nothing about the outgoing display name
 *   changes; whatever the sending client set is what goes out. This is what
 *   every alias created before this feature has, and it is the default, so
 *   adding the field changed no existing behaviour.
 * - `""` — **configured as blank.** The address goes out bare, with no display
 *   name at all. This is the deliberate way to keep a personal name off a role
 *   address without inventing one for it.
 * - anything else — that name, on every send from this address.
 *
 * The three survive a JSON round trip without a marker field: `JSON.stringify`
 * drops an `undefined` value, so "not configured" is the absence of the key and
 * "blank" is the key present holding `""`.
 */
export type AliasDisplayName = string | undefined;

/** An alias as it is persisted, and as the API hands it back. */
export interface AliasRecord {
	/**
	 * The alias address itself, normalised. Either a full address
	 * (`info@example.com`) or a domain wildcard, spelled as a local part with
	 * a trailing `@` and nothing after it (`brian@`). `isWildcardAlias` is the
	 * one-character test that tells them apart.
	 */
	address: string;
	/** The mailbox id (also an email address) this alias delivers into. */
	mailbox: string;
	createdAt: string;
	/** See `AliasDisplayName`. Absent means "not configured". */
	name?: string;
}

/** What `aliases/{address}.json` actually contains. `address` is the key. */
interface StoredAlias {
	mailbox: string;
	createdAt: string;
	name?: string;
}

/**
 * Longest display name accepted. RFC 5322 hard-limits one physical header line
 * at 998 octets and `rewriteFromAddress` refuses rather than re-folding, so a
 * name long enough to blow the line would silently cost the alias its send-as.
 * A ceiling well under that keeps room for the address, the quoting and — for
 * a non-ASCII name, whose every character can cost four base64 characters —
 * the RFC 2047 encoding.
 */
export const ALIAS_NAME_MAX_CHARS = 120;

/**
 * Whether a display name may be stored at all.
 *
 * This is a validation predicate, not a sanitiser: nothing here rewrites the
 * name. The encoding and quoting is `formatFromMailbox`'s job in
 * workers/lib/raw-mime.ts, and it refuses again at the point of use. What this
 * adds is a boundary that a bad name never gets past in the first place, so a
 * stored record cannot carry one.
 *
 * Control characters are the whole point. CR and LF in a header value end the
 * header — and a CRLF CRLF ends the header block and starts an
 * attacker-chosen body — which is the injection `sanitizeHeaderValue` exists
 * to stop. A display name has no legitimate use for any C0 character, DEL
 * included, so all of them are refused outright rather than repaired.
 */
export function isValidAliasName(name: string): boolean {
	if (name.length > ALIAS_NAME_MAX_CHARS) return false;
	return !/[\u0000-\u001f\u007f]/.test(name);
}

export type AliasRejection =
	/** Not a usable email address. */
	| "invalid"
	/** Outside a non-empty EMAIL_ADDRESSES allowlist. */
	| "not-allowed"
	/** A mailbox already exists at this address. */
	| "mailbox-conflict"
	/** An alias record already exists here (possibly pointing elsewhere). */
	| "alias-exists"
	/** The target mailbox does not exist. */
	| "no-such-mailbox"
	/** The display name has a control character in it, or is too long. */
	| "invalid-name";

export type AliasCreateResult =
	| { ok: true; alias: AliasRecord }
	| { ok: false; reason: AliasRejection; message: string };

export type AliasUpdateResult =
	| { ok: true; alias: AliasRecord }
	| { ok: false; reason: "invalid-name" | "no-such-alias"; message: string };

/**
 * Mailbox ids and alias addresses are email addresses, normalised the same
 * way: trimmed and lowercased. `normalizeMailboxId` in workers/lib/credentials.ts
 * does exactly this for the same reason — the R2 key has to be derivable from
 * whatever spelling arrives.
 */
export function normalizeAddress(address: string): string {
	return address.trim().toLowerCase();
}

export function aliasKey(address: string): string {
	return `aliases/${normalizeAddress(address)}.json`;
}

function mailboxKey(address: string): string {
	return `mailboxes/${normalizeAddress(address)}.json`;
}

/**
 * Cheap structural check. Not RFC 5322 — the API layer runs `z.string().email()`
 * as well; this exists so the library cannot be talked into writing a key like
 * `aliases/../mailboxes/x.json`.
 */
export function isPlausibleAddress(address: string): boolean {
	return /^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(address);
}

/**
 * Longest local part accepted. RFC 5321 §4.5.3.1.1 caps one at 64 octets, and
 * a wildcard has no reason to want more than a real address may have.
 */
export const ALIAS_LOCAL_PART_MAX_CHARS = 64;

/**
 * Whether a bare local part may be used as a wildcard alias.
 *
 * `isPlausibleAddress` cannot answer this: it requires an `@` and a dotted
 * domain, which a local part has neither of. So this is its own predicate, and
 * it is an **allowlist** rather than a list of banned characters. The value
 * becomes part of an R2 key, and "reject the characters I thought of" is how a
 * key-namespace escape gets shipped; "accept only what a local part actually
 * needs" cannot be got past by a character nobody thought of.
 *
 * What the allowlist excludes, and why each one matters here:
 *
 * - `@` — would make the key ambiguous with an exact address, which is the
 *   one property the whole key scheme rests on.
 * - `/` and `\` — path separators. `aliases/../mailboxes/x` is the attack.
 * - whitespace and C0 controls — never part of an unquoted local part, and a
 *   CR or LF travels on into places (headers, logs) that treat it as a break.
 * - a leading or trailing dot, and `..` anywhere — RFC 5322's dot-atom forbids
 *   all three, and `.` / `..` are traversal in every storage system that has
 *   ever had a path. Excluded twice on purpose: the anchored pattern below
 *   rejects the edges, the explicit test rejects the middle.
 * - the empty string — an empty key is not a name.
 */
export function isPlausibleLocalPart(localPart: string): boolean {
	if (localPart.length === 0 || localPart.length > ALIAS_LOCAL_PART_MAX_CHARS) {
		return false;
	}
	if (localPart.includes("..")) return false;
	return /^[a-z0-9](?:[a-z0-9._+=-]*[a-z0-9])?$/.test(localPart);
}

/**
 * True for the *spelling* of a domain wildcard: something ending in `@`.
 *
 * Deliberately not a validity check — `deleteAlias("../@")` is a wildcard by
 * this test and is refused by `isPlausibleWildcard` a line later. Splitting
 * the two keeps "which kind of alias is this?" cheap enough to ask in a UI and
 * in a sort comparator, while validity stays a single gate on the write path.
 */
export function isWildcardAlias(key: string): boolean {
	return key.endsWith("@");
}

/** The local part a wildcard key covers, or null when the key is not a valid one. */
export function wildcardLocalPart(key: string): string | null {
	if (!isWildcardAlias(key)) return null;
	const localPart = key.slice(0, -1);
	return isPlausibleLocalPart(localPart) ? localPart : null;
}

/** True when this is a well-formed domain wildcard, `brian@`. */
export function isPlausibleWildcard(key: string): boolean {
	return wildcardLocalPart(key) !== null;
}

/**
 * Either kind of alias key: a full address, or a domain wildcard. The two
 * predicates are mutually exclusive — a string ending in `@` can never satisfy
 * `isPlausibleAddress`, which requires a dotted domain after it — which is
 * exactly why one key space holds both.
 */
export function isPlausibleAliasKey(key: string): boolean {
	return isPlausibleAddress(key) || isPlausibleWildcard(key);
}

/**
 * The wildcard key that would cover this address, or null when none could.
 * `brian@a.example` → `brian@`.
 */
export function wildcardKeyFor(address: string): string | null {
	const localPart = localPartOf(address);
	if (localPart === null) return null;
	return isPlausibleLocalPart(localPart) ? `${localPart}@` : null;
}

/** The local part of an address, or null when there is not one. */
function localPartOf(address: string): string | null {
	const at = address.lastIndexOf("@");
	if (at <= 0) return null;
	return address.slice(0, at) || null;
}

/** True when a non-empty EMAIL_ADDRESSES allows this address (or is empty). */
export function isAllowedAddress(env: AliasEnv, address: string): boolean {
	const allowed = ((env.EMAIL_ADDRESSES ?? []) as string[]).map(normalizeAddress);
	if (allowed.length === 0) return true;
	return allowed.includes(normalizeAddress(address));
}

/**
 * Whether a wildcard could ever receive anything, which is what makes it worth
 * storing.
 *
 * The same reasoning as `isAllowedAddress`, one level up. `EMAIL_ADDRESSES`
 * lists whole addresses, so a bare local part is never *on* it; the question a
 * wildcard has to answer instead is whether any address it would cover is.
 * `receiveEmail` filters recipients against that list before any alias lookup
 * runs, so a wildcard with no covered address on it could never deliver a
 * single message — accepting one would create a record that silently does
 * nothing, which is precisely what the exact-address check exists to prevent.
 *
 * The question is asked of the *local parts* on the list rather than of a
 * configured domain list, because there is no domain list any more: which
 * domains a wildcard covers is settled at delivery time by where the message
 * came from, not in advance by configuration. An empty `EMAIL_ADDRESSES`
 * allows every wildcard, exactly as it allows every address.
 */
export function isAllowedWildcard(env: AliasEnv, localPart: string): boolean {
	const allowed = ((env.EMAIL_ADDRESSES ?? []) as string[]).map(normalizeAddress);
	if (allowed.length === 0) return true;
	return allowed.some((address) => localPartOf(address) === localPart);
}

// ── Reads ───────────────────────────────────────────────────────────

/**
 * Resolve an address to the mailbox it **exactly** aliases, or null. One keyed
 * R2 read; no listing, no pattern matching, and no wildcard.
 *
 * The missing wildcard is the point, not an omission. The caller that matters
 * is `validateSenderWithAliases`, which asks this to decide whether a mailbox
 * may put an arbitrary address in `From:`. If a `brian@` wildcard answered
 * here, that question would come back yes for `brian@` on any domain in the
 * world — no delivery, no evidence, just a string the sender chose. Delivery
 * paths want `readDeliveryAlias` below, which is gated on an address a message
 * actually arrived at.
 */
export async function resolveAlias(
	env: AliasEnv,
	address: string,
): Promise<string | null> {
	const normalized = normalizeAddress(address);
	if (!isPlausibleAddress(normalized)) return null;

	const object = await env.BUCKET.get(aliasKey(normalized));
	if (!object) return null;
	try {
		const parsed = await object.json<StoredAlias>();
		const mailbox = parsed?.mailbox ? normalizeAddress(parsed.mailbox) : "";
		return mailbox || null;
	} catch {
		// A corrupt record resolves to nothing rather than throwing on the
		// inbound path, where a throw would bounce or retry the message.
		return null;
	}
}

/**
 * True when an *exact* alias record exists at this address, whatever it points
 * at.
 *
 * Exact-only, and the one caller — `POST /api/v1/mailboxes`, refusing a
 * mailbox that would shadow an alias — is why. A wildcard is not shadowed by a
 * mailbox: `resolveInboundDelivery` gives the mailbox the address because it is
 * the more specific record, which is the documented precedence rather than a
 * theft. Refusing mailbox creation because some wildcard covers the local part
 * would block the mailbox the operator most likely wants (`brian@` everywhere,
 * plus a real `brian@` mailbox on the main domain).
 */
export async function isAlias(env: AliasEnv, address: string): Promise<boolean> {
	const normalized = normalizeAddress(address);
	if (!isPlausibleAddress(normalized)) return false;
	return (await env.BUCKET.head(aliasKey(normalized))) !== null;
}

/**
 * Every alias pointing at one mailbox.
 *
 * This is the only operation that scans, and it is only ever called by the
 * settings page. `resolveAlias` — the one on a delivery path — is a keyed read.
 *
 * The mailbox is mirrored into R2 `customMetadata` so a listing answers from
 * the list call alone; the `get` fallback covers records written before that
 * (and any R2 implementation that omits metadata from a listing), so the JSON
 * body stays the source of truth.
 */
export async function listAliases(
	env: AliasEnv,
	mailboxId: string,
): Promise<AliasRecord[]> {
	const owner = normalizeAddress(mailboxId);
	const found: AliasRecord[] = [];
	let cursor: string | undefined;

	do {
		const page = await env.BUCKET.list({
			prefix: "aliases/",
			cursor,
			include: ["customMetadata"],
		});
		for (const object of page.objects) {
			const address = object.key.slice("aliases/".length).replace(/\.json$/, "");
			if (!address) continue;

			const hinted = object.customMetadata?.mailbox;
			// `nameState` tells the listing which of the three display-name
			// states this record is in without opening it. Only "set" — the
			// state whose *content* the listing needs — costs a `get`; the
			// other two, and every record written before the field existed,
			// are answered from the listing alone.
			const nameState = object.customMetadata?.nameState;
			if (hinted !== undefined && nameState !== NAME_STATE.set) {
				if (normalizeAddress(hinted) !== owner) continue;
				found.push({
					address,
					mailbox: owner,
					createdAt: object.customMetadata?.createdAt ?? object.uploaded.toISOString(),
					...(nameState === NAME_STATE.blank ? { name: "" } : {}),
				});
				continue;
			}
			// A "set" record still short-circuits on the wrong owner: the
			// mailbox hint is enough to skip it, and skipping it is free.
			if (hinted !== undefined && normalizeAddress(hinted) !== owner) continue;

			const record = await readAlias(env, address);
			if (record && record.mailbox === owner) found.push(record);
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);

	found.sort((a, b) => a.address.localeCompare(b.address));
	return found;
}

/**
 * The whole record at an address, or null when there is none (or it is
 * corrupt). Exported because the send paths need the display name alongside
 * the mailbox, and `resolveAlias` — which is on the inbound delivery path —
 * deliberately answers only the one question it is asked.
 */
export async function readAlias(
	env: AliasEnv,
	address: string,
): Promise<AliasRecord | null> {
	const normalized = normalizeAddress(address);
	// Takes either kind of key. The guard is new: every caller already
	// validated, but this is the function that turns a string into an R2 key,
	// so it is the right place for the check that the string cannot leave the
	// `aliases/` namespace.
	if (!isPlausibleAliasKey(normalized)) return null;
	const object = await env.BUCKET.get(aliasKey(normalized));
	if (!object) return null;
	try {
		const parsed = await object.json<StoredAlias>();
		if (!parsed?.mailbox) return null;
		return {
			address: normalized,
			mailbox: normalizeAddress(parsed.mailbox),
			createdAt: parsed.createdAt ?? object.uploaded.toISOString(),
			// A name that is not a string is not a name. A record hand-written
			// with `"name": 42` reads as "not configured" rather than throwing
			// on a send path, for the same reason the catch below is here.
			...(typeof parsed.name === "string" && isValidAliasName(parsed.name)
				? { name: parsed.name }
				: {}),
		};
	} catch {
		return null;
	}
}

/** Which record answered a delivery lookup. */
export interface DeliveryAliasMatch {
	record: AliasRecord;
	/** `"exact"` for a record at the address itself, `"wildcard"` for `local@`. */
	via: "exact" | "wildcard";
}

/**
 * The alias record covering an address a message was **actually delivered
 * to** — the exact record if there is one, and then the domain wildcard, but
 * only when the caller can vouch that the address was delivered *to*.
 *
 * ## `allowWildcard` is the whole safety property, and it defaults to off
 *
 * An exact record is a statement the operator wrote down about one address, so
 * it may be read for any address anyone names. A wildcard is not: it says
 * `brian@` on *some* set of domains, and the set is "the domains mail actually
 * arrives here for". Nothing about the address itself can establish that, so
 * the caller has to, and `allowWildcard` is where it says so.
 *
 * Two callers pass it and there are no others:
 *
 * - `resolveInboundDelivery`, for the SMTP **envelope** recipient only — the
 *   address Cloudflare routed to this Worker, which it does only for domains
 *   the account owns. Never for a header `To:` address, which the sender wrote.
 * - `resolveSendAs`, for the `delivered_to` column `resolveInboundDelivery`
 *   wrote, which is that same proven address carried forward.
 *
 * Defaulting to off means a caller that has not thought about provenance gets
 * exact-only behaviour, which is the safe half. Handed a `From:` header or a
 * compose form with `allowWildcard`, this would answer "yes, that is yours"
 * for `brian@` on any domain at all — which is why `resolveAlias` exists
 * separately and stays exact-only whatever anyone passes.
 *
 * ## Cost
 *
 * One keyed read for the exact address; a second only when that misses and the
 * caller allowed the wildcard. No listing at either step, so the inbound path
 * does not get slower as the registry grows.
 *
 * An exact record that exists but points at a deleted mailbox is still the
 * answer — `via: "exact"`, and the caller decides. Falling through to the
 * wildcard there would let a wildcard quietly inherit an address whose own
 * record says it belongs somewhere else, which is the opposite of "most
 * specific wins".
 */
export async function readDeliveryAlias(
	env: AliasEnv,
	address: string,
	options: { allowWildcard?: boolean } = {},
): Promise<DeliveryAliasMatch | null> {
	const normalized = normalizeAddress(address);
	if (!isPlausibleAddress(normalized)) return null;

	const exact = await readAlias(env, normalized);
	if (exact) return { record: exact, via: "exact" };

	if (!options.allowWildcard) return null;
	const key = wildcardKeyFor(normalized);
	if (!key) return null;

	const wildcard = await readAlias(env, key);
	return wildcard ? { record: wildcard, via: "wildcard" } : null;
}

/** True when a mailbox exists at this address. */
export async function hasMailbox(env: AliasEnv, address: string): Promise<boolean> {
	const normalized = normalizeAddress(address);
	if (!isPlausibleAddress(normalized)) return false;
	return (await env.BUCKET.head(mailboxKey(normalized))) !== null;
}

// ── Writes ──────────────────────────────────────────────────────────

/**
 * Create an alias.
 *
 * Both collision directions are checked, here and in the mailbox-creation
 * route: an alias may not shadow a mailbox, and — see `isAlias`, called from
 * `POST /api/v1/mailboxes` — a mailbox may not be created at an address that
 * is already an alias. Checking only one leaves the other ordering broken, and
 * the broken ordering is the one that silently steals another mailbox's mail.
 *
 * Re-pointing an existing alias requires `allowRepoint`. Without it an alias
 * that already exists is refused, because a silent overwrite moves someone's
 * inbound mail to a different mailbox with no trace of the previous target.
 *
 * `options.name` sets the display name at creation. Omitting it leaves the
 * name **not configured**, which is the behaviour every alias had before the
 * field existed; on a repoint it carries the existing name across rather than
 * dropping it, exactly as `createdAt` is carried across. Changing the name of
 * an alias that already exists is `setAliasName`'s job, not this one — the
 * `alias-exists` guard above is about moving somebody's mail, and naming an
 * address is not that operation.
 *
 * ## Wildcards
 *
 * `address` may also be a domain wildcard, `brian@`. Three of the checks
 * change shape and the reason is the same each time — a wildcard is not an
 * address, so a question about *the* address has no single answer:
 *
 * - **Allowlist.** `EMAIL_ADDRESSES` holds whole addresses, so the question
 *   becomes whether any address the wildcard covers is on it —
 *   `isAllowedWildcard`. There is no second check against a configured domain
 *   list: which domains a wildcard covers is decided at delivery time by where
 *   the message came from, so there is nothing to check against here and an
 *   unconfigured deployment is not a reason to refuse the record.
 * - **Mailbox collision.** Skipped, not relaxed. `mailboxes/brian@.json`
 *   cannot exist, because a mailbox id is an address. The real question — what
 *   if a mailbox exists at `brian@` on some domain? — is answered by
 *   precedence at resolution time: the mailbox wins, on that domain, and the
 *   wildcard still covers the others. Refusing here would block the most
 *   ordinary setup there is, a `brian@` wildcard alongside a real `brian@`
 *   mailbox on the main domain.
 * - **Own address.** Same: `brian@` never equals a mailbox id, and a mailbox
 *   creating the wildcard that covers its own local part is the normal case
 *   rather than the mistake the equality check was written for.
 *
 * An exact alias and a wildcard on the same local part are **not** a
 * collision — the exact one simply wins for its address — so neither refuses
 * the other. Two wildcards on the same local part are, and are refused by the
 * ordinary `alias-exists` path below, which is keyed on the record and does
 * not care which kind it is.
 */
export async function createAlias(
	env: AliasEnv,
	address: string,
	mailboxId: string,
	options: { allowRepoint?: boolean; name?: string } = {},
): Promise<AliasCreateResult> {
	const alias = normalizeAddress(address);
	const mailbox = normalizeAddress(mailboxId);
	const wildcard = isWildcardAlias(alias);

	if (wildcard ? !isPlausibleWildcard(alias) : !isPlausibleAddress(alias)) {
		return {
			ok: false,
			reason: "invalid",
			message: wildcard
				? "Not a valid wildcard: expected a local part and an @, like brian@"
				: "Not a valid email address",
		};
	}
	if (options.name !== undefined && !isValidAliasName(options.name)) {
		return { ok: false, reason: "invalid-name", message: INVALID_NAME_MESSAGE };
	}
	if (!wildcard && alias === mailbox) {
		return {
			ok: false,
			reason: "mailbox-conflict",
			message: "An alias cannot be the mailbox's own address",
		};
	}
	const permitted = wildcard
		? isAllowedWildcard(env, wildcardLocalPart(alias) ?? "")
		: isAllowedAddress(env, alias);
	if (!permitted) {
		return {
			ok: false,
			reason: "not-allowed",
			message: wildcard
				? "A wildcard needs at least one configured domain it could receive on"
				: "Aliases are restricted to configured EMAIL_ADDRESSES",
		};
	}
	if (!(await env.BUCKET.head(mailboxKey(mailbox)))) {
		return { ok: false, reason: "no-such-mailbox", message: "Mailbox not found" };
	}
	if (!wildcard && (await env.BUCKET.head(mailboxKey(alias)))) {
		return {
			ok: false,
			reason: "mailbox-conflict",
			message: "A mailbox already exists at that address",
		};
	}

	const existing = await readAlias(env, alias);
	if (existing && !options.allowRepoint) {
		return {
			ok: false,
			reason: "alias-exists",
			message:
				existing.mailbox === mailbox
					? "That alias already delivers into this mailbox"
					: `That alias already delivers into ${existing.mailbox}. Remove it there first.`,
		};
	}

	const name = options.name !== undefined ? options.name : existing?.name;
	const record: AliasRecord = {
		address: alias,
		mailbox,
		createdAt: existing?.createdAt ?? new Date().toISOString(),
		...(name !== undefined ? { name } : {}),
	};

	const written = await env.BUCKET.put(aliasKey(alias), JSON.stringify(storedBody(record)), {
		httpMetadata: { contentType: "application/json" },
		customMetadata: aliasMetadata(record),
		// Two concurrent creates must not both believe they won. On a repoint
		// the record is expected to be there, so the precondition is dropped.
		...(existing ? {} : { onlyIf: { etagDoesNotMatch: "*" } }),
	});
	if (written === null) {
		return {
			ok: false,
			reason: "alias-exists",
			message: "That alias was created by another request",
		};
	}

	return { ok: true, alias: record };
}

const INVALID_NAME_MESSAGE =
	`A display name cannot contain control characters, and must be at most ` +
	`${ALIAS_NAME_MAX_CHARS} characters`;

/**
 * Set, change or clear the display name on an alias that already exists.
 *
 * `null` clears it back to **not configured** — the client's display name is
 * used again. `""` is not the same thing: it configures the name as blank, so
 * the address goes out bare. See `AliasDisplayName`.
 *
 * Ownership-checked the way `deleteAlias` is, and for the same reason: the
 * routes are per-mailbox and Cloudflare Access is the only trust boundary this
 * app has, so a mailbox's settings page should at least not be able to rename
 * another mailbox's address out from under it.
 *
 * The mailbox and `createdAt` are re-written unchanged rather than patched in,
 * so a name change can never move where the alias delivers.
 */
export async function setAliasName(
	env: AliasEnv,
	address: string,
	mailboxId: string,
	name: string | null,
): Promise<AliasUpdateResult> {
	const alias = normalizeAddress(address);
	if (name !== null && !isValidAliasName(name)) {
		return { ok: false, reason: "invalid-name", message: INVALID_NAME_MESSAGE };
	}
	// Either kind of key: a display name is a property of an alias, and a
	// wildcard is an alias. `AliasDisplayName`'s three states apply unchanged.
	if (!isPlausibleAliasKey(alias)) {
		return { ok: false, reason: "no-such-alias", message: "Alias not found" };
	}

	const existing = await readAlias(env, alias);
	if (!existing || existing.mailbox !== normalizeAddress(mailboxId)) {
		return { ok: false, reason: "no-such-alias", message: "Alias not found" };
	}

	const record: AliasRecord = {
		address: existing.address,
		mailbox: existing.mailbox,
		createdAt: existing.createdAt,
		...(name !== null ? { name } : {}),
	};

	await env.BUCKET.put(aliasKey(alias), JSON.stringify(storedBody(record)), {
		httpMetadata: { contentType: "application/json" },
		customMetadata: aliasMetadata(record),
	});

	return { ok: true, alias: record };
}

/** The JSON body. `name` is omitted entirely when it is not configured. */
function storedBody(record: AliasRecord): StoredAlias {
	return {
		mailbox: record.mailbox,
		createdAt: record.createdAt,
		...(record.name !== undefined ? { name: record.name } : {}),
	};
}

/**
 * The R2 `customMetadata`, which `listAliases` reads instead of opening every
 * object.
 *
 * The display name itself is deliberately **not** in here. customMetadata
 * travels in HTTP headers, and a display name is free text that can be
 * non-ASCII (`Björn`) or empty — neither of which a header field round-trips
 * dependably. So the metadata carries only which of the three states the
 * record is in, and the JSON body stays the single source of the name.
 */
function aliasMetadata(record: AliasRecord): Record<string, string> {
	const nameState =
		record.name === undefined
			? NAME_STATE.unset
			: record.name === ""
				? NAME_STATE.blank
				: NAME_STATE.set;
	return { mailbox: record.mailbox, createdAt: record.createdAt, nameState };
}

const NAME_STATE = { unset: "unset", blank: "blank", set: "set" } as const;

/**
 * Delete an alias, but only if it belongs to the given mailbox. Passing a
 * mailbox that does not own it is a miss, not a delete — the routes are
 * per-mailbox and there is no per-mailbox authorization anywhere else in this
 * app (Cloudflare Access is the single trust boundary), so this at least keeps
 * one mailbox's settings page from quietly unhooking another's address.
 */
export async function deleteAlias(
	env: AliasEnv,
	address: string,
	mailboxId: string,
): Promise<boolean> {
	const alias = normalizeAddress(address);
	if (!isPlausibleAliasKey(alias)) return false;

	const existing = await readAlias(env, alias);
	if (!existing || existing.mailbox !== normalizeAddress(mailboxId)) return false;

	await env.BUCKET.delete(aliasKey(alias));
	return true;
}

// ── Inbound delivery resolution ─────────────────────────────────────

/**
 * Where a delivery candidate came from, which is what decides whether a domain
 * wildcard may match it.
 *
 * - `"envelope"` — the SMTP envelope recipient, the address Cloudflare routed
 *   this copy of the message to. Email Routing only delivers domains the
 *   account owns, so this address arriving *is* the proof that its domain is
 *   ours. A wildcard may match it.
 * - `"header"` — an address off the message's own `To:`, written by whoever
 *   sent it. It proves nothing, so it may only match records that already
 *   exist: a real mailbox, or an exact alias.
 */
export type DeliveryCandidateSource = "envelope" | "header";

/** One address an inbound message might belong to, and where it came from. */
export interface DeliveryCandidate {
	address: string;
	source: DeliveryCandidateSource;
}

/**
 * Which mailbox an inbound message belongs to, and which of its addresses
 * actually routed it.
 *
 * `deliveredTo` is captured here and nowhere else. `recipient` on the stored
 * row is every To address joined together, so it cannot answer the question:
 * one message can be addressed to several of this mailbox's aliases at once,
 * can arrive by Bcc with none of the mailbox's addresses in the headers at
 * all, or can come through a list that rewrote them. The envelope recipient is
 * the only thing that knows, and it exists only at this moment. Reconstructing
 * it later from the headers is a heuristic that picks wrong in exactly the
 * multi-alias cases aliases are for.
 *
 * Candidates are tried in order and the first hit wins: envelope recipient
 * first (it is the address the message was actually routed to), then the
 * header recipients in order. A message naming several recipients is accepted
 * as long as one of them resolves.
 *
 * Within one candidate, most specific wins: a mailbox at the address, then an
 * exact alias at it, then a domain wildcard on its local part. The first two
 * cannot normally collide — `createAlias` refuses that in both directions —
 * but the ordering is well-defined if a record is written by hand. The third
 * is expected to be shadowed and is the whole reason it goes last: a `brian@`
 * wildcard must never take mail away from a real `brian@a.example` mailbox, or
 * from an exact `brian@a.example` alias pointing somewhere else.
 *
 * Order across candidates is unchanged, and deliberately not merged with the
 * order within one: a wildcard hit on the envelope recipient beats an exact
 * alias on a header `To:` address, because the envelope is the address this
 * copy of the message was routed to and the header is a list of everyone.
 *
 * ## Why the candidates carry their provenance
 *
 * Only the envelope candidate may match a wildcard, so this function has to be
 * able to tell the two apart — a flat list of strings cannot, and a positional
 * convention ("the first one is the envelope") is one refactor away from being
 * silently wrong. `source` travels with the address instead, which also means
 * a caller with no envelope recipient at all simply does not produce an
 * envelope candidate and no wildcard can match: fail-closed by construction
 * rather than by a check somebody has to remember to write.
 */
export async function resolveInboundDelivery(
	env: AliasEnv,
	candidates: readonly DeliveryCandidate[],
): Promise<{ mailboxId: string; deliveredTo: string } | null> {
	const seen = new Set<string>();
	for (const candidate of candidates) {
		const address = normalizeAddress(candidate.address ?? "");
		if (!address || seen.has(address)) continue;
		seen.add(address);
		if (!isPlausibleAddress(address)) continue;

		if (await env.BUCKET.head(mailboxKey(address))) {
			return { mailboxId: address, deliveredTo: address };
		}
		// The wildcard is offered the envelope recipient and nothing else. An
		// exact alias and a mailbox are looked up for every candidate: those
		// are records the operator wrote, so a sender naming one asserts
		// nothing new.
		const match = await readDeliveryAlias(env, address, {
			allowWildcard: candidate.source === "envelope",
		});
		const aliased = match?.record.mailbox ?? null;
		// An alias whose mailbox has since been deleted is not a delivery
		// target; fall through and let a later candidate (or the drop) decide.
		// True of a wildcard exactly as it is of an exact alias.
		if (aliased && (await env.BUCKET.head(mailboxKey(aliased)))) {
			// `deliveredTo` is the address, never the wildcard key. A wildcard
			// is a rule about which mailbox owns an address, not an address
			// itself, and everything downstream — the reply From, the
			// `Delivered-To:` a client sees, the send-as re-resolution — needs
			// something that can actually be sent mail.
			return { mailboxId: aliased, deliveredTo: address };
		}
	}
	return null;
}
