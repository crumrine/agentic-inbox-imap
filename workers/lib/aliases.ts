// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Address aliases: let `info@`, `contact@` and friends deliver into one
 * mailbox, and let that mailbox send back out as any of them.
 *
 * ## Why a separate R2 key, and not the settings blob
 *
 * An alias lives at `aliases/{address}.json` holding `{"mailbox": "..."}`.
 * Two properties fall out of that shape and both are the reason for it:
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
 * ## What this module deliberately does not do
 *
 * It never infers an alias from a pattern or a domain. `resolveAlias` reads a
 * record or returns null. That matters most on the outbound side, where
 * `validateSender` uses it to decide whether an address may be spoofed as: a
 * domain check there would let any address on a configured domain send as the
 * mailbox, which is the exact hole the registry exists to close.
 */

import type { Env } from "../types";

/**
 * The bindings this module touches. Narrower than `Env` on purpose — alias
 * resolution has no business reaching the AI binding, the mailbox Durable
 * Object, or the send-email binding.
 */
export type AliasEnv = Pick<Env, "BUCKET" | "EMAIL_ADDRESSES">;

/** An alias as it is persisted, and as the API hands it back. */
export interface AliasRecord {
	/** The alias address itself. Normalised. */
	address: string;
	/** The mailbox id (also an email address) this alias delivers into. */
	mailbox: string;
	createdAt: string;
}

/** What `aliases/{address}.json` actually contains. `address` is the key. */
interface StoredAlias {
	mailbox: string;
	createdAt: string;
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
	| "no-such-mailbox";

export type AliasCreateResult =
	| { ok: true; alias: AliasRecord }
	| { ok: false; reason: AliasRejection; message: string };

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

/** True when a non-empty EMAIL_ADDRESSES allows this address (or is empty). */
export function isAllowedAddress(env: AliasEnv, address: string): boolean {
	const allowed = ((env.EMAIL_ADDRESSES ?? []) as string[]).map(normalizeAddress);
	if (allowed.length === 0) return true;
	return allowed.includes(normalizeAddress(address));
}

// ── Reads ───────────────────────────────────────────────────────────

/**
 * Resolve an address to the mailbox it aliases, or null when it is not an
 * alias. One keyed R2 read; no listing, no pattern matching.
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

/** True when an alias record exists at this address, whatever it points at. */
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
			if (hinted !== undefined) {
				if (normalizeAddress(hinted) !== owner) continue;
				found.push({
					address,
					mailbox: owner,
					createdAt: object.customMetadata?.createdAt ?? object.uploaded.toISOString(),
				});
				continue;
			}

			const record = await readAlias(env, address);
			if (record && record.mailbox === owner) found.push(record);
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);

	found.sort((a, b) => a.address.localeCompare(b.address));
	return found;
}

async function readAlias(
	env: AliasEnv,
	address: string,
): Promise<AliasRecord | null> {
	const normalized = normalizeAddress(address);
	const object = await env.BUCKET.get(aliasKey(normalized));
	if (!object) return null;
	try {
		const parsed = await object.json<StoredAlias>();
		if (!parsed?.mailbox) return null;
		return {
			address: normalized,
			mailbox: normalizeAddress(parsed.mailbox),
			createdAt: parsed.createdAt ?? object.uploaded.toISOString(),
		};
	} catch {
		return null;
	}
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
 */
export async function createAlias(
	env: AliasEnv,
	address: string,
	mailboxId: string,
	options: { allowRepoint?: boolean } = {},
): Promise<AliasCreateResult> {
	const alias = normalizeAddress(address);
	const mailbox = normalizeAddress(mailboxId);

	if (!isPlausibleAddress(alias)) {
		return { ok: false, reason: "invalid", message: "Not a valid email address" };
	}
	if (alias === mailbox) {
		return {
			ok: false,
			reason: "mailbox-conflict",
			message: "An alias cannot be the mailbox's own address",
		};
	}
	if (!isAllowedAddress(env, alias)) {
		return {
			ok: false,
			reason: "not-allowed",
			message: "Aliases are restricted to configured EMAIL_ADDRESSES",
		};
	}
	if (!(await env.BUCKET.head(mailboxKey(mailbox)))) {
		return { ok: false, reason: "no-such-mailbox", message: "Mailbox not found" };
	}
	if (await env.BUCKET.head(mailboxKey(alias))) {
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

	const record: AliasRecord = {
		address: alias,
		mailbox,
		createdAt: existing?.createdAt ?? new Date().toISOString(),
	};
	const body: StoredAlias = { mailbox: record.mailbox, createdAt: record.createdAt };

	const written = await env.BUCKET.put(aliasKey(alias), JSON.stringify(body), {
		httpMetadata: { contentType: "application/json" },
		customMetadata: { mailbox: record.mailbox, createdAt: record.createdAt },
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
	if (!isPlausibleAddress(alias)) return false;

	const existing = await readAlias(env, alias);
	if (!existing || existing.mailbox !== normalizeAddress(mailboxId)) return false;

	await env.BUCKET.delete(aliasKey(alias));
	return true;
}

// ── Inbound delivery resolution ─────────────────────────────────────

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
 * header recipients in order. A mailbox at the address beats an alias at it,
 * which cannot normally happen — `createAlias` refuses that collision in both
 * directions — but is well-defined if a record is written by hand.
 */
export async function resolveInboundDelivery(
	env: AliasEnv,
	candidates: readonly string[],
): Promise<{ mailboxId: string; deliveredTo: string } | null> {
	const seen = new Set<string>();
	for (const raw of candidates) {
		const address = normalizeAddress(raw ?? "");
		if (!address || seen.has(address)) continue;
		seen.add(address);
		if (!isPlausibleAddress(address)) continue;

		if (await env.BUCKET.head(mailboxKey(address))) {
			return { mailboxId: address, deliveredTo: address };
		}
		const aliased = await resolveAlias(env, address);
		// An alias whose mailbox has since been deleted is not a delivery
		// target; fall through and let a later candidate (or the drop) decide.
		if (aliased && (await env.BUCKET.head(mailboxKey(aliased)))) {
			return { mailboxId: aliased, deliveredTo: address };
		}
	}
	return null;
}
