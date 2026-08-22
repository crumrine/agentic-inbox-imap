// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * App-password credential store for the IMAP gateway.
 *
 * ## Why a separate R2 key
 *
 * Credentials live at `credentials/{mailboxId}.json`, deliberately NOT inside
 * `mailboxes/{mailboxId}.json`. The mailbox settings blob is loaded verbatim
 * into the AI agent's prompt path (`getSystemPrompt()` in workers/agent/index.ts
 * reads that object and returns `settings.agentSystemPrompt` as the system
 * prompt). Anything stored beside it is one prompt-injection or one careless
 * `JSON.stringify(settings)` away from being echoed to a model, a tool call, or
 * a chat transcript. Credential material must never be reachable from an AI
 * code path, so it gets its own key that no AI code reads.
 *
 * ## Hashing
 *
 * PBKDF2-HMAC-SHA256 through WebCrypto (`crypto.subtle`) — available on Workers
 * with no WASM and no nodejs_compat dependency. Iteration count is stored per
 * entry so it can be raised later without invalidating existing passwords: a
 * verify uses the entry's own recorded count, and only newly created passwords
 * pick up the new default.
 */

import type { Env } from "../types";

/**
 * The only binding this module touches. Narrower than `Env` on purpose: nothing
 * in the credential store should be able to reach the AI binding, the mailbox
 * Durable Object, or the send-email binding.
 */
export type CredentialEnv = Pick<Env, "BUCKET">;

/**
 * Cloudflare Workers' WebCrypto refuses PBKDF2 above 100,000 iterations:
 *
 *   NotSupportedError: Pbkdf2 failed: iteration counts above 100000
 *   are not supported (requested 600000).
 *
 * This is a hard platform ceiling, not a tuning choice. OWASP's current figure
 * for PBKDF2-HMAC-SHA256 is 600,000, which we cannot reach here.
 *
 * That is acceptable *only* because app passwords are machine-generated with
 * 100 bits of entropy (see randomPassword). At that strength an offline attack
 * is infeasible regardless of iteration count, so the KDF is defence in depth
 * rather than the thing standing between an attacker and the mailbox. If this
 * ever accepts a user-chosen password, 100k is not enough and the hashing
 * would need to move somewhere without this ceiling.
 *
 * Note that local workerd (the vitest pool) does NOT enforce this limit, so a
 * value above it passes every test and fails only in production. PBKDF2_MAX
 * exists so a test can assert the ceiling that the runtime will not.
 */
export const PBKDF2_MAX_ITERATIONS = 100_000;
export const PBKDF2_ITERATIONS = 100_000;

/** Derived key length in bits. Matches the SHA-256 output; no truncation. */
export const DERIVED_KEY_BITS = 256;

export const CREDENTIAL_ALGORITHM = "PBKDF2-HMAC-SHA256";

/**
 * Crockford-flavoured lowercase base32: no i/l/o/u, so nothing looks like
 * another character and nothing accidentally spells a word. Exactly 32 symbols,
 * which matters — see `randomPassword()`.
 */
const PASSWORD_ALPHABET = "abcdefghjkmnpqrstvwxyz0123456789";

/** 20 symbols x log2(32) = 100 bits of entropy. */
const PASSWORD_SYMBOLS = 20;

/** Rendered as 4 dash-separated groups of 5, e.g. `k3fq7-2vmxa-9hbnp-rt4ws`. */
const PASSWORD_GROUP = 5;

const SALT_BYTES = 16;
const ID_BYTES = 8;

/** One app password as it is persisted. `hash` and `salt` never leave this module. */
export interface StoredAppPassword {
	id: string;
	label: string;
	createdAt: string;
	algorithm: typeof CREDENTIAL_ALGORITHM;
	iterations: number;
	keyBits: number;
	/** base64 */
	salt: string;
	/** base64 */
	hash: string;
}

/** The safe projection: everything except the hash and the salt. */
export interface AppPasswordMetadata {
	id: string;
	label: string;
	createdAt: string;
	algorithm: string;
	iterations: number;
}

export interface CredentialFile {
	version: 1;
	entries: StoredAppPassword[];
}

export interface CreatedAppPassword {
	/** Plaintext. Returned exactly once, at creation. Never persisted, never logged. */
	password: string;
	metadata: AppPasswordMetadata;
}

const EMPTY_FILE: CredentialFile = { version: 1, entries: [] };

export function credentialKey(mailboxId: string): string {
	return `credentials/${normalizeMailboxId(mailboxId)}.json`;
}

/** Mailbox ids are email addresses and are stored lowercased on creation. */
export function normalizeMailboxId(mailboxId: string): string {
	return mailboxId.trim().toLowerCase();
}

// ── Encoding helpers ────────────────────────────────────────────────

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function randomHex(byteLength: number): string {
	const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Password generation ─────────────────────────────────────────────

/**
 * CSPRNG app password: 100 bits of entropy in a shape a human can retype into
 * a mail client's password field.
 *
 * The alphabet is exactly 32 symbols and a byte is uniform over 0..255, so
 * `byte & 31` is uniform over the alphabet — no modulo bias and no rejection
 * loop. (This is only true because 256 is a whole multiple of 32; do not change
 * the alphabet length without changing this.)
 */
export function randomPassword(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(PASSWORD_SYMBOLS));
	const groups: string[] = [];
	for (let i = 0; i < PASSWORD_SYMBOLS; i += PASSWORD_GROUP) {
		let group = "";
		for (let j = i; j < i + PASSWORD_GROUP; j++) {
			group += PASSWORD_ALPHABET[bytes[j] & 31];
		}
		groups.push(group);
	}
	return groups.join("-");
}

/**
 * Dashes are presentation only. Mail clients mangle them (autocomplete, copy
 * from a UI that renders them differently), so normalise before hashing and
 * before verifying.
 */
function canonicalizePassword(password: string): string {
	return password.replace(/-/g, "").toLowerCase();
}

// ── Hashing ─────────────────────────────────────────────────────────

async function deriveBits(
	password: string,
	salt: Uint8Array,
	iterations: number,
	keyBits: number,
): Promise<Uint8Array> {
	const keyMaterial = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(canonicalizePassword(password)),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const bits = await crypto.subtle.deriveBits(
		{
			name: "PBKDF2",
			hash: "SHA-256",
			// BufferSource: copy into a fresh ArrayBuffer-backed view.
			salt: salt.slice().buffer as ArrayBuffer,
			iterations,
		},
		keyMaterial,
		keyBits,
	);
	return new Uint8Array(bits);
}

/**
 * Constant-time comparison. Workers has no `crypto.timingSafeEqual`, and
 * `crypto.subtle.timingSafeEqual` is not available either, so this is explicit:
 * no early return, no short-circuit, and the loop length does not depend on
 * where the first difference is.
 *
 * Length is folded into the accumulator rather than returned early, so a
 * length mismatch costs the same as a content mismatch.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
	const length = Math.max(a.length, b.length);
	let diff = a.length ^ b.length;
	for (let i = 0; i < length; i++) {
		diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
	}
	return diff === 0;
}

// ── Storage ─────────────────────────────────────────────────────────

interface LoadedFile {
	file: CredentialFile;
	etag: string | null;
}

async function loadFile(env: CredentialEnv, mailboxId: string): Promise<LoadedFile> {
	const object = await env.BUCKET.get(credentialKey(mailboxId));
	if (!object) return { file: { ...EMPTY_FILE, entries: [] }, etag: null };
	try {
		const parsed = await object.json<CredentialFile>();
		if (!parsed || !Array.isArray(parsed.entries)) {
			return { file: { ...EMPTY_FILE, entries: [] }, etag: object.etag };
		}
		return { file: parsed, etag: object.etag };
	} catch {
		// Corrupt credential file: treat as empty rather than throwing a parse
		// error that might carry a fragment of the file into a log line.
		return { file: { ...EMPTY_FILE, entries: [] }, etag: object.etag };
	}
}

/**
 * Conditional write so two concurrent create/revoke calls cannot silently drop
 * each other's entry. Returns false when the precondition failed (someone else
 * wrote first) and the caller should re-read and retry.
 */
async function saveFile(
	env: CredentialEnv,
	mailboxId: string,
	file: CredentialFile,
	etag: string | null,
): Promise<boolean> {
	const key = credentialKey(mailboxId);
	const body = JSON.stringify(file);
	try {
		const result = await env.BUCKET.put(key, body, {
			onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: "*" },
			httpMetadata: { contentType: "application/json" },
		});
		// R2 returns null when the precondition fails.
		return result !== null;
	} catch {
		// Some R2 implementations throw a 412 instead of returning null.
		return false;
	}
}

const MAX_WRITE_ATTEMPTS = 4;

async function mutate<T>(
	env: CredentialEnv,
	mailboxId: string,
	apply: (file: CredentialFile) => { next: CredentialFile; result: T } | null,
): Promise<T | null> {
	for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
		const { file, etag } = await loadFile(env, mailboxId);
		const applied = apply(file);
		if (applied === null) return null;
		if (await saveFile(env, mailboxId, applied.next, etag)) {
			return applied.result;
		}
	}
	throw new Error("Credential store write contention");
}

// ── Public API ──────────────────────────────────────────────────────

function toMetadata(entry: StoredAppPassword): AppPasswordMetadata {
	// Explicit projection, not a spread-and-delete: a future field added to
	// StoredAppPassword cannot leak through this by accident.
	return {
		id: entry.id,
		label: entry.label,
		createdAt: entry.createdAt,
		algorithm: entry.algorithm,
		iterations: entry.iterations,
	};
}

/**
 * Mint a new app password for a mailbox. The plaintext is returned once and is
 * never stored; only the PBKDF2 output and its parameters are persisted.
 */
export async function createAppPassword(
	env: CredentialEnv,
	mailboxId: string,
	label: string,
	options: { iterations?: number } = {},
): Promise<CreatedAppPassword> {
	const iterations = options.iterations ?? PBKDF2_ITERATIONS;
	const password = randomPassword();
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const hash = await deriveBits(password, salt, iterations, DERIVED_KEY_BITS);

	const entry: StoredAppPassword = {
		id: randomHex(ID_BYTES),
		label: label.slice(0, 128),
		createdAt: new Date().toISOString(),
		algorithm: CREDENTIAL_ALGORITHM,
		iterations,
		keyBits: DERIVED_KEY_BITS,
		salt: toBase64(salt),
		hash: toBase64(hash),
	};

	await mutate(env, mailboxId, (file) => ({
		next: { version: 1 as const, entries: [...file.entries, entry] },
		result: true as const,
	}));

	return { password, metadata: toMetadata(entry) };
}

/**
 * Verify a candidate password against every live app password for a mailbox.
 *
 * Anti-enumeration: this function does the same work whether the mailbox
 * exists, exists with no app passwords, or exists with the wrong password. When
 * there is nothing to check it still runs one PBKDF2 derivation against a
 * throwaway salt at the default iteration count, so an unknown mailbox is not a
 * fast path. It also does not stop at the first match — every entry is derived
 * and compared — so the position of the matching entry is not observable.
 */
export async function verifyAppPassword(
	env: CredentialEnv,
	mailboxId: string,
	password: string,
): Promise<boolean> {
	// Both lookups happen unconditionally: branching on the mailbox head would
	// make "no such mailbox" one R2 round trip cheaper than "wrong password".
	const [mailboxHead, loaded] = await Promise.all([
		env.BUCKET.head(`mailboxes/${normalizeMailboxId(mailboxId)}.json`),
		loadFile(env, mailboxId),
	]);

	const entries = mailboxHead ? loaded.file.entries : [];

	if (entries.length === 0) {
		// Burn one derivation so the unknown-mailbox path costs roughly what a
		// wrong-password path costs. The result is discarded.
		await deriveBits(
			password,
			crypto.getRandomValues(new Uint8Array(SALT_BYTES)),
			PBKDF2_ITERATIONS,
			DERIVED_KEY_BITS,
		);
		return false;
	}

	let matched = false;
	for (const entry of entries) {
		let ok = false;
		try {
			const expected = fromBase64(entry.hash);
			const actual = await deriveBits(
				password,
				fromBase64(entry.salt),
				entry.iterations,
				entry.keyBits ?? DERIVED_KEY_BITS,
			);
			ok = constantTimeEqual(actual, expected);
		} catch {
			// A malformed entry fails closed. No logging: the caught value could
			// stringify part of the stored material.
			ok = false;
		}
		// Deliberately no `break` — every entry is always evaluated.
		matched = matched || ok;
	}
	return matched;
}

/** Metadata for every app password on a mailbox. Never returns hashes or salts. */
export async function listAppPasswords(
	env: CredentialEnv,
	mailboxId: string,
): Promise<AppPasswordMetadata[]> {
	const { file } = await loadFile(env, mailboxId);
	return file.entries.map(toMetadata);
}

/** Revoke one app password by id. Returns false if there was no such id. */
export async function revokeAppPassword(
	env: CredentialEnv,
	mailboxId: string,
	id: string,
): Promise<boolean> {
	const result = await mutate(env, mailboxId, (file) => {
		const next = file.entries.filter((entry) => entry.id !== id);
		if (next.length === file.entries.length) return null;
		return { next: { version: 1 as const, entries: next }, result: true };
	});
	return result === true;
}
