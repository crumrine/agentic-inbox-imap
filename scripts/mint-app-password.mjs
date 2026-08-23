#!/usr/bin/env node
// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Mint an IMAP app password without a UI.
 *
 * There is no app-password management UI yet (Trellis DEV-675), so this
 * produces a credential file byte-compatible with workers/lib/credentials.ts
 * and prints the wrangler commands to install it.
 *
 * Everything here mirrors constants in that module. If they change there,
 * change them here. The parameters are asserted against it by a unit test.
 *
 *   node scripts/mint-app-password.mjs you@example.com "apple mail"
 */

// Cloudflare Workers caps PBKDF2 at 100,000 iterations. See
// workers/lib/credentials.ts for why that ceiling is acceptable here.
const PBKDF2_ITERATIONS = 100_000;
const DERIVED_KEY_BITS = 256;
const CREDENTIAL_ALGORITHM = "PBKDF2-HMAC-SHA256";
const PASSWORD_ALPHABET = "abcdefghjkmnpqrstvwxyz0123456789";
const PASSWORD_SYMBOLS = 20;
const PASSWORD_GROUP = 5;
const SALT_BYTES = 16;
const ID_BYTES = 8;

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const hex = (bytes) => Buffer.from(bytes).toString("hex");

/** 20 symbols over a 32-char alphabet = 100 bits. `& 31` is bias-free. */
function randomPassword() {
	const bytes = crypto.getRandomValues(new Uint8Array(PASSWORD_SYMBOLS));
	const groups = [];
	for (let i = 0; i < PASSWORD_SYMBOLS; i += PASSWORD_GROUP) {
		let group = "";
		for (let j = i; j < i + PASSWORD_GROUP; j++) group += PASSWORD_ALPHABET[bytes[j] & 31];
		groups.push(group);
	}
	return groups.join("-");
}

/** Dashes are presentation only; the Worker canonicalises before hashing. */
const canonicalize = (p) => p.replace(/-/g, "").toLowerCase();

async function derive(password, salt) {
	const keyMaterial = await crypto.subtle.importKey(
		"raw", new TextEncoder().encode(canonicalize(password)), "PBKDF2", false, ["deriveBits"],
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt: salt.buffer, iterations: PBKDF2_ITERATIONS },
		keyMaterial, DERIVED_KEY_BITS,
	);
	return new Uint8Array(bits);
}

const [mailbox, label = "imap"] = process.argv.slice(2);
if (!mailbox || !mailbox.includes("@")) {
	console.error("usage: node scripts/mint-app-password.mjs <mailbox@domain> [label]");
	process.exit(1);
}

const mailboxId = mailbox.trim().toLowerCase();
const password = randomPassword();
const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
const hash = await derive(password, salt);

const file = {
	version: 1,
	entries: [{
		id: hex(crypto.getRandomValues(new Uint8Array(ID_BYTES))),
		label,
		createdAt: new Date().toISOString(),
		algorithm: CREDENTIAL_ALGORITHM,
		iterations: PBKDF2_ITERATIONS,
		keyBits: DERIVED_KEY_BITS,
		salt: b64(salt),
		hash: b64(hash),
	}],
};

const out = `credentials-${mailboxId}.json`;
await (await import("node:fs/promises")).writeFile(out, JSON.stringify(file, null, 2));

console.log(`
App password for ${mailboxId}

    ${password}

Shown once. It is not recoverable from the stored file.

Wrote ${out}

WARNING: the put below REPLACES all app passwords for this mailbox. If any
already exist, fetch and merge first:

    npx wrangler r2 object get agentic-inbox/credentials/${mailboxId}.json --remote --file existing.json

Install:

    npx wrangler r2 object put agentic-inbox/credentials/${mailboxId}.json --remote --file ${out}

Then delete ${out} - it contains the hash, though not the password.
`);
