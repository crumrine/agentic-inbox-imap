// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * scripts/mint-app-password.mjs writes a credential file by hand, outside the
 * Worker, because there is no app-password UI yet (Trellis DEV-675). It
 * hardcodes the KDF parameters, so it silently stops producing usable files
 * the moment those constants change here.
 *
 * These tests pin the contract from both directions: the constants the script
 * copies, and an end-to-end proof that a file built with them authenticates.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
	CREDENTIAL_ALGORITHM,
	DERIVED_KEY_BITS,
	PBKDF2_ITERATIONS,
	PBKDF2_MAX_ITERATIONS,
	credentialKey,
	verifyAppPassword,
} from "../workers/lib/credentials";

/** Exactly what scripts/mint-app-password.mjs hardcodes. Keep in sync. */
const SCRIPT = {
	PBKDF2_ITERATIONS: 100_000,
	DERIVED_KEY_BITS: 256,
	CREDENTIAL_ALGORITHM: "PBKDF2-HMAC-SHA256",
	PASSWORD_ALPHABET: "abcdefghjkmnpqrstvwxyz0123456789",
	SALT_BYTES: 16,
};

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

/** Mirrors the script's derivation, including dash/case canonicalisation. */
async function deriveLikeScript(password: string, salt: Uint8Array): Promise<Uint8Array> {
	const keyMaterial = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password.replace(/-/g, "").toLowerCase()),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt: salt.slice().buffer as ArrayBuffer, iterations: SCRIPT.PBKDF2_ITERATIONS },
		keyMaterial,
		SCRIPT.DERIVED_KEY_BITS,
	);
	return new Uint8Array(bits);
}

describe("mint-app-password.mjs compatibility", () => {
	it("the constants the script copies still match the module", () => {
		expect(SCRIPT.PBKDF2_ITERATIONS).toBe(PBKDF2_ITERATIONS);
		expect(SCRIPT.DERIVED_KEY_BITS).toBe(DERIVED_KEY_BITS);
		expect(SCRIPT.CREDENTIAL_ALGORITHM).toBe(CREDENTIAL_ALGORITHM);
	});

	it("a credential file built the way the script builds it actually authenticates", async () => {
		const mailboxId = "bc@example.test";
		const password = "k3fq7-2vmxa-9hbnp-rt4ws";
		const salt = crypto.getRandomValues(new Uint8Array(SCRIPT.SALT_BYTES));

		const file = {
			version: 1,
			entries: [
				{
					id: "0011223344556677",
					label: "imap",
					createdAt: new Date(0).toISOString(),
					algorithm: SCRIPT.CREDENTIAL_ALGORITHM,
					iterations: SCRIPT.PBKDF2_ITERATIONS,
					keyBits: SCRIPT.DERIVED_KEY_BITS,
					salt: toBase64(salt),
					hash: toBase64(await deriveLikeScript(password, salt)),
				},
			],
		};

		// The mailbox must exist. verifyAppPassword treats a missing mailbox as
		// zero entries and burns a dummy derivation, so a credential file alone
		// authenticates nothing. This is the anti-enumeration behaviour, and it
		// is also the first thing to check when a real app password "does not
		// work": create the mailbox in the UI before minting one.
		await env.BUCKET.put(`mailboxes/${mailboxId}.json`, JSON.stringify({ fromName: "Test" }));
		await env.BUCKET.put(credentialKey(mailboxId), JSON.stringify(file));

		expect(await verifyAppPassword(env as never, mailboxId, password)).toBe(true);
		// Dashes are presentation only, so the undashed form must work too.
		expect(await verifyAppPassword(env as never, mailboxId, "k3fq72vmxa9hbnprt4ws")).toBe(true);
		expect(await verifyAppPassword(env as never, mailboxId, "wrong-pass-word-here")).toBe(false);
	});
});

/**
 * Regression guard for a production-only failure.
 *
 * Cloudflare Workers' WebCrypto rejects PBKDF2 above 100,000 iterations:
 *
 *   NotSupportedError: Pbkdf2 failed: iteration counts above 100000
 *   are not supported (requested 600000).
 *
 * Local workerd does NOT enforce that ceiling, so 600,000 passed every test
 * here and threw on the first real request. verifyAppPassword's catch turned
 * the exception into a plain `false`, which the auth route reported as 401 -
 * indistinguishable from a wrong password. It cost a production deploy and a
 * live diagnostic probe to find.
 *
 * The runtime will not fail this for us locally, so assert it explicitly.
 */
describe("PBKDF2 iteration ceiling (Workers platform limit)", () => {
	it("stays at or below the 100,000 the runtime accepts", () => {
		expect(PBKDF2_MAX_ITERATIONS).toBe(100_000);
		expect(PBKDF2_ITERATIONS).toBeLessThanOrEqual(PBKDF2_MAX_ITERATIONS);
	});

	it("derives at the configured count without throwing", async () => {
		const salt = crypto.getRandomValues(new Uint8Array(16));
		const km = await crypto.subtle.importKey(
			"raw", new TextEncoder().encode("probe"), "PBKDF2", false, ["deriveBits"],
		);
		await expect(
			crypto.subtle.deriveBits(
				{ name: "PBKDF2", hash: "SHA-256", salt: salt.slice().buffer as ArrayBuffer, iterations: PBKDF2_ITERATIONS },
				km,
				DERIVED_KEY_BITS,
			),
		).resolves.toBeDefined();
	});
});
