// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * DEV-675 — the SPA-facing app-password endpoints in workers/index.ts.
 *
 * workers/lib/credentials.ts had `createAppPassword`, `listAppPasswords` and
 * `revokeAppPassword` fully tested and **nothing called them**: the only way to
 * mint a password was `scripts/mint-app-password.mjs` plus a hand upload to R2.
 * These three routes are what make the project runnable by someone who is not
 * its author, so the things they must never get wrong are pinned here:
 *
 * 1. The list surface never carries a hash, a salt, or a plaintext. The
 *    projection lives in credentials.ts, but the *route* is where a widened
 *    projection would actually reach a browser, so the assertion is made
 *    against the serialised HTTP body rather than against the helper's return
 *    value — a `JSON.stringify` of a stored entry slipped in anywhere between
 *    here and R2 would still be caught.
 * 2. A password minted through the route authenticates through the real verify
 *    path. A create endpoint that returns a plausible-looking string which no
 *    mail client can actually use is a failure that only shows up on someone
 *    else's device, so it is checked end to end and not against the stored hash.
 * 3. Revoke actually stops it authenticating. Same reasoning: a revoke that
 *    removes the row from the list but leaves the credential live is the worst
 *    possible failure mode here, and it looks identical from the UI.
 *
 * The routes sit behind `requireMailbox`, so an unknown mailbox is a 404 before
 * any credential code runs — asserted for all three verbs, because an endpoint
 * that mints credentials for a mailbox that does not exist would write a
 * `credentials/{id}.json` orphan that nothing ever reads or cleans up.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
	credentialKey,
	listAppPasswords,
	verifyAppPassword,
} from "../workers/lib/credentials";
import { app } from "../workers/index";
import type { Env } from "../workers/types";

let n = 0;

/** A mailbox exists iff its R2 settings blob does. */
async function makeMailbox(prefix: string): Promise<string> {
	n += 1;
	const id = `${prefix}-${n}@example.com`;
	await env.BUCKET.put(`mailboxes/${id}.json`, JSON.stringify({ fromName: "Test" }));
	return id;
}

async function appFetch(path: string, init: RequestInit = {}): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await app.fetch(
		new Request(`https://inbox.test${path}`, init),
		env as unknown as Env,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return res;
}

function base(mailboxId: string): string {
	return `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/app-passwords`;
}

async function create(
	mailboxId: string,
	body: unknown = { label: "iphone" },
): Promise<Response> {
	return appFetch(base(mailboxId), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

interface CreatedBody {
	password: string;
	metadata: {
		id: string;
		label: string;
		createdAt: string;
		algorithm: string;
		iterations: number;
	};
}

/** Create and unwrap, for the tests that only care about the resulting credential. */
async function createOk(mailboxId: string, label = "iphone"): Promise<CreatedBody> {
	const res = await create(mailboxId, { label });
	expect(res.status).toBe(201);
	return (await res.json()) as CreatedBody;
}

describe("POST /api/v1/mailboxes/:mailboxId/app-passwords", () => {
	it("returns a plaintext password and its metadata", async () => {
		const id = await makeMailbox("create");

		const res = await create(id, { label: "iPhone Mail" });

		expect(res.status).toBe(201);
		const body = (await res.json()) as CreatedBody;
		// The shape a mail client can actually be given: 4 groups of 5 from the
		// unambiguous alphabet.
		expect(body.password).toMatch(
			/^[abcdefghjkmnpqrstvwxyz0-9]{5}(-[abcdefghjkmnpqrstvwxyz0-9]{5}){3}$/,
		);
		expect(body.metadata).toEqual({
			id: expect.stringMatching(/^[0-9a-f]{16}$/),
			label: "iPhone Mail",
			createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
			algorithm: "PBKDF2-HMAC-SHA256",
			iterations: 100_000,
		});
		// No hash or salt rides along with the create response either.
		expect(Object.keys(body.metadata).sort()).toEqual([
			"algorithm",
			"createdAt",
			"id",
			"iterations",
			"label",
		]);
	});

	it("tells intermediaries not to store the one-time secret", async () => {
		const id = await makeMailbox("nostore");
		const res = await create(id);
		expect(res.headers.get("cache-control")).toBe("no-store");
	});

	it("persists the entry so it survives the request", async () => {
		const id = await makeMailbox("persist");
		const created = await createOk(id, "thunderbird");

		const stored = await listAppPasswords(env, id);
		expect(stored).toHaveLength(1);
		expect(stored[0].id).toBe(created.metadata.id);
		expect(stored[0].label).toBe("thunderbird");
	});

	it("never returns the same plaintext twice", async () => {
		const id = await makeMailbox("distinct");
		const first = await createOk(id, "a");
		const second = await createOk(id, "b");
		expect(first.password).not.toBe(second.password);
		expect(first.metadata.id).not.toBe(second.metadata.id);
	});

	it("keeps several passwords side by side", async () => {
		const id = await makeMailbox("several");
		await createOk(id, "phone");
		await createOk(id, "laptop");
		await createOk(id, "tablet");

		const res = await appFetch(base(id));
		const list = (await res.json()) as { label: string }[];
		expect(list.map((entry) => entry.label)).toEqual(["phone", "laptop", "tablet"]);
	});

	it("rejects a missing, empty or whitespace-only label", async () => {
		const id = await makeMailbox("label");
		for (const body of [{}, { label: "" }, { label: "   " }, { label: 42 }]) {
			const res = await create(id, body);
			expect(res.status).toBe(400);
		}
		// Nothing was written on any of those.
		expect(await listAppPasswords(env, id)).toEqual([]);
	});

	it("rejects a body that is not JSON without throwing", async () => {
		const id = await makeMailbox("badjson");
		const res = await create(id, "{not json");
		expect(res.status).toBe(400);
	});

	it("caps an over-long label instead of storing it", async () => {
		const id = await makeMailbox("longlabel");
		const res = await create(id, { label: "x".repeat(500) });
		expect(res.status).toBe(400);
		expect(await listAppPasswords(env, id)).toEqual([]);
	});
});

describe("GET /api/v1/mailboxes/:mailboxId/app-passwords", () => {
	it("is empty for a mailbox that has never minted one", async () => {
		const id = await makeMailbox("empty");
		const res = await appFetch(base(id));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	it("never exposes the hash, the salt or the plaintext", async () => {
		const id = await makeMailbox("projection");
		const created = await createOk(id, "leaky");

		// What is actually on disk, so the test knows the real secret material
		// rather than a guess at it.
		const raw = await env.BUCKET.get(credentialKey(id));
		const stored = (await raw!.json()) as {
			entries: { hash: string; salt: string }[];
		};
		expect(stored.entries[0].hash).toBeTruthy();
		expect(stored.entries[0].salt).toBeTruthy();

		const res = await appFetch(base(id));
		const text = await res.text();

		// Asserted against the serialised body: a widened projection, or a stray
		// JSON.stringify of a stored entry, shows up here whatever shape it takes.
		expect(text).not.toContain(stored.entries[0].hash);
		expect(text).not.toContain(stored.entries[0].salt);
		expect(text).not.toContain(created.password);
		// The canonicalised form the KDF actually consumes, too.
		expect(text).not.toContain(created.password.replace(/-/g, ""));
		expect(text).not.toMatch(/"(hash|salt|keyBits|password)"/);

		const list = JSON.parse(text) as Record<string, unknown>[];
		expect(list).toHaveLength(1);
		expect(Object.keys(list[0]).sort()).toEqual([
			"algorithm",
			"createdAt",
			"id",
			"iterations",
			"label",
		]);
	});

	it("does not leak one mailbox's passwords into another", async () => {
		const mine = await makeMailbox("mine");
		const theirs = await makeMailbox("theirs");
		await createOk(mine, "mine-only");

		const res = await appFetch(base(theirs));
		expect(await res.json()).toEqual([]);
	});
});

describe("a password minted through the API authenticates", () => {
	it("verifies through the real verify path", async () => {
		const id = await makeMailbox("verify");
		const { password } = await createOk(id, "thunderbird");

		expect(await verifyAppPassword(env, id, password)).toBe(true);
	});

	it("verifies with the dashes stripped, the way a client may send it", async () => {
		const id = await makeMailbox("dashes");
		const { password } = await createOk(id, "apple-mail");

		expect(await verifyAppPassword(env, id, password.replace(/-/g, ""))).toBe(true);
	});

	it("does not verify a password minted for a different mailbox", async () => {
		const a = await makeMailbox("cross-a");
		const b = await makeMailbox("cross-b");
		const { password } = await createOk(a, "phone");

		expect(await verifyAppPassword(env, b, password)).toBe(false);
	});

	it("leaves a sibling password working", async () => {
		const id = await makeMailbox("sibling");
		const first = await createOk(id, "phone");
		const second = await createOk(id, "laptop");

		expect(await verifyAppPassword(env, id, first.password)).toBe(true);
		expect(await verifyAppPassword(env, id, second.password)).toBe(true);
	});
});

describe("DELETE /api/v1/mailboxes/:mailboxId/app-passwords/:id", () => {
	it("returns 204 and stops the password authenticating", async () => {
		const id = await makeMailbox("revoke");
		const created = await createOk(id, "stolen-laptop");
		expect(await verifyAppPassword(env, id, created.password)).toBe(true);

		const res = await appFetch(`${base(id)}/${created.metadata.id}`, {
			method: "DELETE",
		});

		expect(res.status).toBe(204);
		expect(await res.text()).toBe("");
		expect(await verifyAppPassword(env, id, created.password)).toBe(false);
		expect(await listAppPasswords(env, id)).toEqual([]);
	});

	it("revokes only the named password", async () => {
		const id = await makeMailbox("revoke-one");
		const keep = await createOk(id, "phone");
		const drop = await createOk(id, "laptop");

		const res = await appFetch(`${base(id)}/${drop.metadata.id}`, {
			method: "DELETE",
		});
		expect(res.status).toBe(204);

		expect(await verifyAppPassword(env, id, drop.password)).toBe(false);
		expect(await verifyAppPassword(env, id, keep.password)).toBe(true);
		const remaining = await listAppPasswords(env, id);
		expect(remaining.map((entry) => entry.id)).toEqual([keep.metadata.id]);
	});

	it("404s an unknown id without touching what is there", async () => {
		const id = await makeMailbox("revoke-unknown");
		const created = await createOk(id, "phone");

		const res = await appFetch(`${base(id)}/deadbeefdeadbeef`, {
			method: "DELETE",
		});

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "App password not found" });
		expect(await verifyAppPassword(env, id, created.password)).toBe(true);
	});

	it("404s a second revoke of the same id", async () => {
		const id = await makeMailbox("revoke-twice");
		const created = await createOk(id, "phone");
		const url = `${base(id)}/${created.metadata.id}`;

		expect((await appFetch(url, { method: "DELETE" })).status).toBe(204);
		expect((await appFetch(url, { method: "DELETE" })).status).toBe(404);
	});

	it("404s an id belonging to another mailbox", async () => {
		const a = await makeMailbox("owner");
		const b = await makeMailbox("other");
		const mine = await createOk(a, "phone");
		await createOk(b, "theirs");

		const res = await appFetch(`${base(b)}/${mine.metadata.id}`, {
			method: "DELETE",
		});

		expect(res.status).toBe(404);
		expect(await verifyAppPassword(env, a, mine.password)).toBe(true);
	});
});

describe("unknown mailbox", () => {
	const ghost = "no-such-mailbox@example.com";

	it("404s the list", async () => {
		const res = await appFetch(base(ghost));
		expect(res.status).toBe(404);
	});

	it("404s the create, and writes no credential file", async () => {
		const res = await create(ghost);
		expect(res.status).toBe(404);
		expect(await env.BUCKET.head(credentialKey(ghost))).toBeNull();
	});

	it("404s the revoke", async () => {
		const res = await appFetch(`${base(ghost)}/deadbeefdeadbeef`, {
			method: "DELETE",
		});
		expect(res.status).toBe(404);
	});
});
