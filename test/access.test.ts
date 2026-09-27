// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { requireAccess } from "../workers/access";
import type { Env } from "../workers/types";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requireAccess);
app.get("*", (c) => c.text("authorized"));
let signingKey: CryptoKey;
let otherKey: CryptoKey;
let keys: Awaited<ReturnType<typeof exportJWK>>[];
let issuer: string;
let sequence = 0;
let fetchKeys: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
	const first = await generateKeyPair("RS256");
	const second = await generateKeyPair("RS256");
	signingKey = first.privateKey;
	otherKey = second.privateKey;
	keys = [
		{ ...await exportJWK(first.publicKey), kid: "first", alg: "RS256" },
		{ ...await exportJWK(second.publicKey), kid: "second", alg: "RS256" },
	];
});
beforeEach(() => {
	// Unique trusted configuration isolates each test without a production reset API.
	issuer = `https://team-${++sequence}.cloudflareaccess.com`;
	fetchKeys = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
		Response.json({ keys: [keys[0]] }),
	);
});
afterEach(() => vi.restoreAllMocks());

async function token(options: {
	key?: CryptoKey; kid?: string; iss?: string; aud?: string; exp?: number;
	service?: boolean;
} = {}) {
	return new SignJWT(options.service ? { common_name: "gateway.access" } : { email: "synthetic@example.test" })
		.setProtectedHeader({ alg: "RS256", kid: options.kid ?? "first" })
		.setIssuer(options.iss ?? issuer)
		.setAudience(options.aud ?? "policy")
		.setExpirationTime(options.exp ?? Math.floor(Date.now() / 1000) + 3600)
		.sign(options.key ?? signingKey);
}
function request(jwt?: string, config: Partial<Env> = {}) {
	return app.request("https://inbox.test/api/imap/v1/test/folders", {
		headers: jwt ? { "cf-access-jwt-assertion": jwt } : {},
	}, { TEAM_DOMAIN: issuer, POLICY_AUD: "policy", ...config } as Env);
}

describe("production Access boundary", () => {
	it("reuses fetched keys across sequential independently verified requests", async () => {
		for (let i = 0; i < 5; i++) expect((await request(await token())).status).toBe(200);
		expect(fetchKeys).toHaveBeenCalledTimes(1);
		expect(String(fetchKeys.mock.calls[0][0])).toBe(`${issuer}/cdn-cgi/access/certs`);
	});

	it.each([
		["signature", () => ({ key: otherKey })],
		["issuer", () => ({ iss: "https://untrusted.test" })],
		["audience", () => ({ aud: "other-policy" })],
		["expiry", () => ({ exp: Math.floor(Date.now() / 1000) - 60 })],
	] as const)("rejects invalid %s after warming the cache", async (_name, options) => {
		expect((await request(await token())).status).toBe(200);
		expect((await request(await token(options()))).status).toBe(403);
		expect(fetchKeys).toHaveBeenCalledTimes(1);
	});

	it("accepts service-token JWTs without email and rejects missing/malformed tokens", async () => {
		expect((await request(await token({ service: true }))).status).toBe(200);
		expect((await request()).status).toBe(403);
		expect((await request("malformed")).status).toBe(403);
		expect(fetchKeys).toHaveBeenCalledTimes(1);
	});

	it("checks the current audience even when the exact same token/key was previously accepted", async () => {
		const jwt = await token();
		expect((await request(jwt)).status).toBe(200);
		expect((await request(jwt, { POLICY_AUD: "changed" })).status).toBe(403);
		expect((await request(await token({ aud: "changed" }), { POLICY_AUD: "changed" })).status).toBe(200);
		expect(fetchKeys).toHaveBeenCalledTimes(1);
	});

	it("isolates trusted issuers and preserves full certs URL configuration", async () => {
		const jwt = await token();
		expect((await request(jwt)).status).toBe(200);
		const secondIssuer = "https://second-team.cloudflareaccess.com";
		expect((await request(jwt, { TEAM_DOMAIN: secondIssuer })).status).toBe(403);
		expect((await request(await token({ iss: secondIssuer }), { TEAM_DOMAIN: secondIssuer })).status).toBe(200);
		expect((await request(jwt, { TEAM_DOMAIN: `${issuer}/cdn-cgi/access/certs` })).status).toBe(200);
		expect(fetchKeys).toHaveBeenCalledTimes(2);
		expect(String(fetchKeys.mock.calls[1][0])).toBe(`${secondIssuer}/cdn-cgi/access/certs`);
	});

	it("refreshes rotated signing keys when jose's default key cache expires", async () => {
		expect((await request(await token())).status).toBe(200);
		fetchKeys.mockImplementation(async () => Response.json({ keys }));
		const rotated = await token({ key: otherKey, kid: "second" });
		expect(fetchKeys).toHaveBeenCalledTimes(1);
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now + 601_000);
		expect((await request(rotated)).status).toBe(200);
		expect((await request(rotated)).status).toBe(200);
		expect(fetchKeys).toHaveBeenCalledTimes(2);
	});

	it("fails closed on missing/invalid configuration and failed certs fetch, then can recover", async () => {
		const jwt = await token();
		expect((await request(jwt, { POLICY_AUD: "" })).status).toBe(500);
		expect((await request(jwt, { TEAM_DOMAIN: "" })).status).toBe(500);
		expect((await request(jwt, { TEAM_DOMAIN: "not a URL" })).status).toBe(403);
		expect(fetchKeys).not.toHaveBeenCalled();
		fetchKeys.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
		expect((await request(jwt)).status).toBe(403);
		expect((await request(jwt)).status).toBe(200);
		expect(fetchKeys).toHaveBeenCalledTimes(2);
	});
});
