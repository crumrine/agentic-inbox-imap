// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * DEV-692 part one — the SPA-facing alias endpoints in workers/index.ts.
 *
 * The registry's own rules are pinned in aliases.test.ts. What is asserted
 * here is the HTTP surface over them, and specifically the two things a route
 * layer is able to get wrong on its own:
 *
 * 1. **A rejection reason reaches the browser as the right status.** The
 *    settings page renders `error.message` from an `ApiError` and does nothing
 *    else with the response, so a collision that came back as a 500 would show
 *    up as an unexplained failure with a live alias record possibly behind it.
 *
 * 2. **The mailbox-side collision check is actually wired.** `createAlias`
 *    refuses an alias that shadows a mailbox all by itself, but the reverse —
 *    a mailbox created at an address that is already an alias — is enforced
 *    only in `POST /api/v1/mailboxes`. That is the ordering that silently
 *    diverts an existing alias's mail, and nothing in the library would catch
 *    it if the route forgot.
 *
 * Like the app-password routes, these sit behind `requireMailbox`, so an
 * unknown mailbox is a 404 before any alias code runs — asserted for all three
 * verbs, because an alias written for a mailbox that does not exist is an
 * orphan record that would still resolve on the inbound path.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createAlias, listAliases, resolveAlias } from "../workers/lib/aliases";
import { app } from "../workers/index";
import type { Env } from "../workers/types";

const testEnv = env as unknown as Env;

let n = 0;

async function makeMailbox(prefix: string): Promise<string> {
	n += 1;
	const id = `${prefix}-${n}@example.com`;
	await env.BUCKET.put(`mailboxes/${id}.json`, JSON.stringify({ fromName: "Test" }));
	return id;
}

async function appFetch(
	path: string,
	init: RequestInit = {},
	overrides: Partial<Env> = {},
): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await app.fetch(
		new Request(`https://inbox.test${path}`, init),
		{ ...testEnv, ...overrides },
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return res;
}

function base(mailboxId: string): string {
	return `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/aliases`;
}

async function addAlias(
	mailboxId: string,
	body: unknown,
	overrides: Partial<Env> = {},
): Promise<Response> {
	return appFetch(
		base(mailboxId),
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: typeof body === "string" ? body : JSON.stringify(body),
		},
		overrides,
	);
}

describe("POST /api/v1/mailboxes/:mailboxId/aliases", () => {
	it("creates an alias and returns the record", async () => {
		const box = await makeMailbox("create");
		const address = `info-${n}@example.com`;

		const res = await addAlias(box, { address });

		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({
			address,
			mailbox: box,
			createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
		});
		expect(await resolveAlias(testEnv, address)).toBe(box);
	});

	it("lowercases and trims the address before storing it", async () => {
		const box = await makeMailbox("case");
		const res = await addAlias(box, { address: `  Info-${n}@Example.COM ` });

		expect(res.status).toBe(201);
		expect(await res.json()).toMatchObject({
			address: `info-${n}@example.com`,
		});
	});

	it("rejects a body that is missing, malformed or not an email address", async () => {
		const box = await makeMailbox("badbody");
		for (const body of [{}, { address: "" }, { address: "not-an-address" }, { address: 42 }, "{nope"]) {
			const res = await addAlias(box, body);
			expect(res.status).toBe(400);
		}
		expect(await listAliases(testEnv, box)).toEqual([]);
	});

	it("answers 409 when the address is already a mailbox", async () => {
		const box = await makeMailbox("conflict");
		const other = await makeMailbox("othermailbox");

		const res = await addAlias(box, { address: other });

		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toMatch(/mailbox/i);
	});

	it("answers 409 rather than silently re-pointing an existing alias", async () => {
		const first = await makeMailbox("owner");
		const second = await makeMailbox("claimant");
		const address = `shared-${n}@example.com`;
		expect((await addAlias(first, { address })).status).toBe(201);

		const res = await addAlias(second, { address });

		expect(res.status).toBe(409);
		expect(await resolveAlias(testEnv, address)).toBe(first);
	});

	it("answers 403 for an address outside a non-empty EMAIL_ADDRESSES", async () => {
		const box = await makeMailbox("restricted");
		const overrides = {
			EMAIL_ADDRESSES: [box] as unknown as Env["EMAIL_ADDRESSES"],
		};

		const res = await addAlias(box, { address: `nope-${n}@example.com` }, overrides);

		expect(res.status).toBe(403);
		expect(await listAliases(testEnv, box)).toEqual([]);
	});

	it("404s for a mailbox that does not exist, without writing anything", async () => {
		const missing = "ghost@example.com";
		const address = "ghost-alias@example.com";

		const res = await addAlias(missing, { address });

		expect(res.status).toBe(404);
		expect(await resolveAlias(testEnv, address)).toBeNull();
	});
});

describe("GET /api/v1/mailboxes/:mailboxId/aliases", () => {
	it("is empty for a mailbox with no aliases", async () => {
		const box = await makeMailbox("noaliases");
		const res = await appFetch(base(box));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	it("lists this mailbox's aliases and nobody else's", async () => {
		const mine = await makeMailbox("listmine");
		const theirs = await makeMailbox("listtheirs");
		await addAlias(mine, { address: `sales-${n}@example.com` });
		await addAlias(theirs, { address: `press-${n}@example.com` });

		const res = await appFetch(base(mine));
		const listed = (await res.json()) as { address: string; mailbox: string }[];

		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({
			address: `sales-${n}@example.com`,
			mailbox: mine,
		});
	});

	it("404s for a mailbox that does not exist", async () => {
		const res = await appFetch(base("ghost@example.com"));
		expect(res.status).toBe(404);
	});
});

describe("DELETE /api/v1/mailboxes/:mailboxId/aliases/:alias", () => {
	it("removes the alias and stops it resolving", async () => {
		const box = await makeMailbox("removing");
		const address = `temp-${n}@example.com`;
		await addAlias(box, { address });

		const res = await appFetch(`${base(box)}/${encodeURIComponent(address)}`, {
			method: "DELETE",
		});

		expect(res.status).toBe(204);
		expect(await resolveAlias(testEnv, address)).toBeNull();
	});

	it("404s for an alias this mailbox does not own, and leaves it alone", async () => {
		const owner = await makeMailbox("keeper");
		const intruder = await makeMailbox("intruder");
		const address = `guarded-${n}@example.com`;
		await addAlias(owner, { address });

		const res = await appFetch(
			`${base(intruder)}/${encodeURIComponent(address)}`,
			{ method: "DELETE" },
		);

		expect(res.status).toBe(404);
		expect(await resolveAlias(testEnv, address)).toBe(owner);
	});

	it("404s for an alias that was never created", async () => {
		const box = await makeMailbox("nothingthere");
		const res = await appFetch(`${base(box)}/${encodeURIComponent("nope@example.com")}`, {
			method: "DELETE",
		});
		expect(res.status).toBe(404);
	});

	it("404s for a mailbox that does not exist", async () => {
		const res = await appFetch(
			`${base("ghost@example.com")}/${encodeURIComponent("x@example.com")}`,
			{ method: "DELETE" },
		);
		expect(res.status).toBe(404);
	});
});

describe("POST /api/v1/mailboxes", () => {
	it("refuses to create a mailbox at an address that is already an alias", async () => {
		const box = await makeMailbox("holder");
		const address = `taken-${n}@example.com`;
		await createAlias(testEnv, address, box);

		const res = await appFetch("/api/v1/mailboxes", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email: address, name: "Impostor" }),
		});

		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toMatch(/alias/i);
		// The alias still points where it did, and no mailbox blob exists that
		// would out-rank it on the inbound path.
		expect(await resolveAlias(testEnv, address)).toBe(box);
		expect(await env.BUCKET.head(`mailboxes/${address}.json`)).toBeNull();
	});

	it("still creates a mailbox at an address that is not an alias", async () => {
		n += 1;
		const address = `fresh-${n}@example.com`;
		const res = await appFetch("/api/v1/mailboxes", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email: address, name: "Fresh" }),
		});

		expect(res.status).toBe(201);
		expect(await env.BUCKET.head(`mailboxes/${address}.json`)).not.toBeNull();
	});
});
