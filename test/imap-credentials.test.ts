// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	CREDENTIAL_ALGORITHM,
	PBKDF2_ITERATIONS,
	constantTimeEqual,
	createAppPassword,
	credentialKey,
	listAppPasswords,
	randomPassword,
	revokeAppPassword,
	verifyAppPassword,
} from "../workers/lib/credentials";

/** verifyAppPassword requires the mailbox itself to exist in R2. */
async function makeMailbox(id: string): Promise<string> {
	await env.BUCKET.put(
		`mailboxes/${id}.json`,
		JSON.stringify({ fromName: "Test", agentSystemPrompt: "be helpful" }),
	);
	return id;
}

async function rawCredentialFile(id: string): Promise<string | null> {
	const object = await env.BUCKET.get(credentialKey(id));
	return object ? await object.text() : null;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("app password generation", () => {
	it("produces 4 dash-separated groups of 5 from an unambiguous alphabet", () => {
		const password = randomPassword();
		expect(password).toMatch(/^[abcdefghjkmnpqrstvwxyz0-9]{5}(-[abcdefghjkmnpqrstvwxyz0-9]{5}){3}$/);
		// 20 symbols of payload, 100 bits.
		expect(password.replace(/-/g, "")).toHaveLength(20);
		// No characters that get confused when read off a screen.
		expect(password).not.toMatch(/[ilou]/);
	});

	it("does not repeat", () => {
		const seen = new Set(Array.from({ length: 200 }, () => randomPassword()));
		expect(seen.size).toBe(200);
	});
});

describe("constantTimeEqual", () => {
	it("compares content and length without early return", () => {
		const a = new Uint8Array([1, 2, 3, 4]);
		expect(constantTimeEqual(a, new Uint8Array([1, 2, 3, 4]))).toBe(true);
		expect(constantTimeEqual(a, new Uint8Array([1, 2, 3, 5]))).toBe(false);
		expect(constantTimeEqual(a, new Uint8Array([9, 2, 3, 4]))).toBe(false);
		expect(constantTimeEqual(a, new Uint8Array([1, 2, 3]))).toBe(false);
		expect(constantTimeEqual(a, new Uint8Array([1, 2, 3, 4, 0]))).toBe(false);
		expect(constantTimeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
	});
});

describe("create and verify", () => {
	it("verifies a freshly created password", async () => {
		const id = await makeMailbox("create-verify@example.com");
		const { password } = await createAppPassword(env, id, "Thunderbird");

		expect(await verifyAppPassword(env, id, password)).toBe(true);
	});

	it("accepts the password with or without its presentation dashes", async () => {
		const id = await makeMailbox("dashes@example.com");
		const { password } = await createAppPassword(env, id, "iOS Mail");

		expect(await verifyAppPassword(env, id, password.replace(/-/g, ""))).toBe(true);
		expect(await verifyAppPassword(env, id, password.toUpperCase())).toBe(true);
	});

	it("rejects a wrong password", async () => {
		const id = await makeMailbox("wrong-password@example.com");
		await createAppPassword(env, id, "Thunderbird");

		expect(await verifyAppPassword(env, id, randomPassword())).toBe(false);
		expect(await verifyAppPassword(env, id, "")).toBe(false);
	});

	it("rejects an unknown mailbox the same way it rejects a wrong password", async () => {
		const known = await makeMailbox("known@example.com");
		await createAppPassword(env, known, "Thunderbird");

		expect(await verifyAppPassword(env, known, randomPassword())).toBe(false);
		expect(await verifyAppPassword(env, "no-such-mailbox@example.com", randomPassword())).toBe(false);
	});

	it("rejects a mailbox that exists but has no app passwords", async () => {
		const id = await makeMailbox("no-passwords@example.com");
		expect(await verifyAppPassword(env, id, randomPassword())).toBe(false);
	});

	it("still hashes when the mailbox does not exist, so there is no fast path", async () => {
		// Coarse timing check, not a rigorous side-channel measurement: the point
		// is that the unknown-mailbox branch performs a real PBKDF2 derivation
		// rather than returning immediately. Bounds are deliberately loose.
		const known = await makeMailbox("timing@example.com");
		await createAppPassword(env, known, "Thunderbird");

		const time = async (fn: () => Promise<unknown>) => {
			const samples: number[] = [];
			for (let i = 0; i < 3; i++) {
				const start = performance.now();
				await fn();
				samples.push(performance.now() - start);
			}
			return samples.sort((a, b) => a - b)[1];
		};

		const wrongPassword = await time(() => verifyAppPassword(env, known, randomPassword()));
		const unknownMailbox = await time(() =>
			verifyAppPassword(env, `absent-${Math.random()}@example.com`, randomPassword()),
		);

		expect(unknownMailbox).toBeGreaterThan(wrongPassword * 0.5);
	});
});

describe("revocation", () => {
	it("stops accepting a revoked password", async () => {
		const id = await makeMailbox("revoke@example.com");
		const { password, metadata } = await createAppPassword(env, id, "Old laptop");
		expect(await verifyAppPassword(env, id, password)).toBe(true);

		expect(await revokeAppPassword(env, id, metadata.id)).toBe(true);

		expect(await verifyAppPassword(env, id, password)).toBe(false);
		expect(await listAppPasswords(env, id)).toEqual([]);
	});

	it("reports false for an id that was never issued", async () => {
		const id = await makeMailbox("revoke-missing@example.com");
		await createAppPassword(env, id, "Only one");
		expect(await revokeAppPassword(env, id, "deadbeefdeadbeef")).toBe(false);
		expect(await listAppPasswords(env, id)).toHaveLength(1);
	});
});

describe("multiple passwords per mailbox", () => {
	it("accepts each password independently and revokes them independently", async () => {
		const id = await makeMailbox("multi@example.com");
		const phone = await createAppPassword(env, id, "Phone");
		const laptop = await createAppPassword(env, id, "Laptop");
		const tablet = await createAppPassword(env, id, "Tablet");

		expect(await verifyAppPassword(env, id, phone.password)).toBe(true);
		expect(await verifyAppPassword(env, id, laptop.password)).toBe(true);
		expect(await verifyAppPassword(env, id, tablet.password)).toBe(true);

		// Each entry gets its own salt, so two passwords never share a hash.
		const stored = JSON.parse((await rawCredentialFile(id)) as string);
		const salts = stored.entries.map((e: { salt: string }) => e.salt);
		expect(new Set(salts).size).toBe(3);

		await revokeAppPassword(env, id, laptop.metadata.id);

		expect(await verifyAppPassword(env, id, phone.password)).toBe(true);
		expect(await verifyAppPassword(env, id, laptop.password)).toBe(false);
		expect(await verifyAppPassword(env, id, tablet.password)).toBe(true);

		expect((await listAppPasswords(env, id)).map((m) => m.label).sort()).toEqual([
			"Phone",
			"Tablet",
		]);
	});

	it("keeps mailboxes separate", async () => {
		const a = await makeMailbox("tenant-a@example.com");
		const b = await makeMailbox("tenant-b@example.com");
		const forA = await createAppPassword(env, a, "A");

		expect(await verifyAppPassword(env, a, forA.password)).toBe(true);
		expect(await verifyAppPassword(env, b, forA.password)).toBe(false);
	});
});

describe("stored representation", () => {
	it("records the iteration count per entry", async () => {
		const id = await makeMailbox("iterations@example.com");
		await createAppPassword(env, id, "Default");
		const legacy = await createAppPassword(env, id, "Legacy", { iterations: 120_000 });

		const stored = JSON.parse((await rawCredentialFile(id)) as string);
		expect(stored.entries.map((e: { iterations: number }) => e.iterations)).toEqual([
			PBKDF2_ITERATIONS,
			120_000,
		]);
		for (const entry of stored.entries) {
			expect(entry.algorithm).toBe(CREDENTIAL_ALGORITHM);
			expect(entry.keyBits).toBe(256);
		}

		// The upgrade path: an entry written at an older cost factor still
		// verifies, because verification uses the entry's own recorded count.
		expect(await verifyAppPassword(env, id, legacy.password)).toBe(true);
	});

	it("never writes the plaintext password", async () => {
		const id = await makeMailbox("no-plaintext@example.com");
		const { password } = await createAppPassword(env, id, "Thunderbird");
		const raw = (await rawCredentialFile(id)) as string;

		expect(raw).not.toContain(password);
		expect(raw).not.toContain(password.replace(/-/g, ""));
		// Not even a fragment: no 5-symbol group of the password appears.
		for (const group of password.split("-")) {
			expect(raw).not.toContain(group);
		}
	});

	it("keeps credentials out of the mailbox settings blob the agent reads", async () => {
		const id = await makeMailbox("isolation@example.com");
		await createAppPassword(env, id, "Thunderbird");

		// getSystemPrompt() in workers/agent/index.ts reads exactly this key and
		// feeds it to the model. It must stay free of credential material.
		const settings = await (await env.BUCKET.get(`mailboxes/${id}.json`))!.text();
		expect(settings).not.toContain("hash");
		expect(settings).not.toContain("salt");
		expect(settings).not.toContain("iterations");

		expect(credentialKey(id)).toBe(`credentials/${id}.json`);
		expect(await env.BUCKET.head(credentialKey(id))).not.toBeNull();
	});
});

describe("listAppPasswords", () => {
	it("returns metadata and never the hash or the salt", async () => {
		const id = await makeMailbox("list@example.com");
		await createAppPassword(env, id, "Phone");
		await createAppPassword(env, id, "Laptop");

		const list = await listAppPasswords(env, id);
		expect(list).toHaveLength(2);

		for (const entry of list) {
			expect(Object.keys(entry).sort()).toEqual([
				"algorithm",
				"createdAt",
				"id",
				"iterations",
				"label",
			]);
			expect(entry).not.toHaveProperty("hash");
			expect(entry).not.toHaveProperty("salt");
			expect(entry).not.toHaveProperty("keyBits");
			expect(entry.id).toMatch(/^[0-9a-f]{16}$/);
			expect(Date.parse(entry.createdAt)).not.toBeNaN();
		}

		// And nothing hash-shaped survived serialisation of the whole list.
		const stored = JSON.parse((await rawCredentialFile(id)) as string);
		const serialised = JSON.stringify(list);
		for (const entry of stored.entries) {
			expect(serialised).not.toContain(entry.hash);
			expect(serialised).not.toContain(entry.salt);
		}
	});

	it("returns an empty list for a mailbox with no credential file", async () => {
		expect(await listAppPasswords(env, "empty@example.com")).toEqual([]);
	});
});

describe("logging hygiene", () => {
	it("logs nothing at all on the create, verify, list and revoke paths", async () => {
		const spies = {
			log: vi.spyOn(console, "log").mockImplementation(() => {}),
			warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
			error: vi.spyOn(console, "error").mockImplementation(() => {}),
			info: vi.spyOn(console, "info").mockImplementation(() => {}),
			debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
		};

		const id = await makeMailbox("logging@example.com");
		const { password, metadata } = await createAppPassword(env, id, "Thunderbird");
		await verifyAppPassword(env, id, password);
		await verifyAppPassword(env, id, randomPassword());
		await verifyAppPassword(env, "nobody@example.com", password);
		await listAppPasswords(env, id);
		await revokeAppPassword(env, id, metadata.id);

		for (const spy of Object.values(spies)) {
			expect(spy).not.toHaveBeenCalled();
		}
	});

	it("fails closed and silently on a corrupt credential file", async () => {
		const spies = [
			vi.spyOn(console, "log").mockImplementation(() => {}),
			vi.spyOn(console, "warn").mockImplementation(() => {}),
			vi.spyOn(console, "error").mockImplementation(() => {}),
		];
		const id = await makeMailbox("corrupt@example.com");

		// Unparseable JSON.
		await env.BUCKET.put(credentialKey(id), "{not json at all");
		expect(await verifyAppPassword(env, id, randomPassword())).toBe(false);
		expect(await listAppPasswords(env, id)).toEqual([]);

		// Parseable, but the entry's base64 fields are garbage — the derivation
		// path throws and must be swallowed.
		await env.BUCKET.put(
			credentialKey(id),
			JSON.stringify({
				version: 1,
				entries: [
					{
						id: "0011223344556677",
						label: "broken",
						createdAt: new Date().toISOString(),
						algorithm: CREDENTIAL_ALGORITHM,
						iterations: PBKDF2_ITERATIONS,
						keyBits: 256,
						salt: "!!!not base64!!!",
						hash: "!!!not base64!!!",
					},
				],
			}),
		);
		expect(await verifyAppPassword(env, id, randomPassword())).toBe(false);

		for (const spy of spies) {
			expect(spy).not.toHaveBeenCalled();
		}
	});
});
