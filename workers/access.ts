// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { MiddlewareHandler } from "hono";
import { jwtVerify, createRemoteJWKSet } from "jose";
import type { Env } from "./types";

// Only trusted binding-derived URLs are keys. jose owns key expiry, cooldown,
// and rotation; no token or authorization result is cached here.
const accessKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getAccessKeySet(certsUrl: URL) {
	const key = certsUrl.href;
	let resolver = accessKeySets.get(key);
	if (!resolver) {
		resolver = createRemoteJWKSet(certsUrl);
		accessKeySets.set(key, resolver);
	}
	return resolver;
}

function getAccessUrls(teamDomain: string) {
	const certsPath = "/cdn-cgi/access/certs";
	const teamUrl = new URL(teamDomain);
	const issuer = teamUrl.origin;
	const certsUrl = teamUrl.pathname.endsWith(certsPath)
		? teamUrl
		: new URL(certsPath, issuer);

	return { issuer, certsUrl };
}

// Production boundary; development bypass stays in app.ts.
export const requireAccess: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
	const { POLICY_AUD, TEAM_DOMAIN } = c.env;

	// Fail closed in production if Access is not configured.
	if (!POLICY_AUD || !TEAM_DOMAIN) {
		return c.text(
			"Cloudflare Access must be configured in production. Set POLICY_AUD and TEAM_DOMAIN.",
			500,
		);
	}

	const token = c.req.header("cf-access-jwt-assertion");
	if (!token) {
		return c.text("Missing required CF Access JWT", 403);
	}

	try {
		const { issuer, certsUrl } = getAccessUrls(TEAM_DOMAIN);
		const JWKS = getAccessKeySet(certsUrl);
		await jwtVerify(token, JWKS, {
			issuer,
			audience: POLICY_AUD,
		});
	} catch {
		return c.text("Invalid or expired Access token", 403);
	}

	// Authorization model note: once a teammate passes the shared Cloudflare
	// Access policy, they can access all mailboxes in this app by design.
	//
	// Service tokens: the IMAP gateway authenticates with a Cloudflare Access
	// service token (CF-Access-Client-Id / CF-Access-Client-Secret). Access
	// validates the pair at the edge and mints the same cf-access-jwt-assertion,
	// but a service-token JWT carries `common_name` instead of `email` and has
	// no identity claims at all. The verification above checks only the
	// signature, issuer and audience and never reads an identity claim, so it
	// accepts service-token JWTs as-is — no change needed. Do not add an
	// `email`-claim check here without exempting service tokens, or the gateway
	// breaks. The Access application policy must include an allow rule for the
	// gateway's service token (action "Service Auth", selector "Service Token").
	return next();
};
