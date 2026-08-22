// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { env } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	AUTH_FAILURE_LIMIT,
	authRateLimiter,
} from "../workers/durableObject/authRateLimit";
import { createAppPassword, randomPassword, revokeAppPassword } from "../workers/lib/credentials";
import { IMAP_API_BASE, type ImapApiEnv, imapApi } from "../workers/routes/imap-api";

/**
 * Mount the router exactly the way workers/app.ts does. app.ts itself cannot be
 * imported here — it pulls in `virtual:react-router/server-build`, which only
 * exists during a `react-router build` — so this reproduces the mount point via
 * the shared IMAP_API_BASE constant.
 */
const app = new Hono<{ Bindings: ImapApiEnv }>().route(IMAP_API_BASE, imapApi);

async function auth(body: unknown): Promise<Response> {
	return app.request(
		`${IMAP_API_BASE}/auth`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: typeof body === "string" ? body : JSON.stringify(body),
		},
		env,
	);
}

async function makeMailbox(id: string): Promise<string> {
	await env.BUCKET.put(`mailboxes/${id}.json`, JSON.stringify({ fromName: "Test" }));
	return id;
}

/**
 * Every test uses a distinct mailbox id. The rate limiter is a Durable Object
 * keyed by mailbox id, and test/setup.ts only wipes MailboxDO storage, so
 * sharing an id between tests would leak failure counts across them.
 */
let n = 0;
function uniqueMailbox(prefix: string): string {
	n += 1;
	return `${prefix}-${n}@example.com`;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("POST /api/imap/v1/auth", () => {
	it("returns 200 and the mailbox for a valid app password", async () => {
		const id = await makeMailbox(uniqueMailbox("ok"));
		const { password } = await createAppPassword(env, id, "Thunderbird");

		const res = await auth({ mailbox: id, password });

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ mailbox: id });
	});

	it("normalises the mailbox before looking it up", async () => {
		const id = await makeMailbox(uniqueMailbox("case"));
		const { password } = await createAppPassword(env, id, "Thunderbird");

		const res = await auth({ mailbox: `  ${id.toUpperCase()}  `, password });

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ mailbox: id });
	});

	it("returns 401 for a wrong password", async () => {
		const id = await makeMailbox(uniqueMailbox("wrong"));
		await createAppPassword(env, id, "Thunderbird");

		const res = await auth({ mailbox: id, password: randomPassword() });

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "Authentication failed" });
	});

	it("returns 401 for a revoked password", async () => {
		const id = await makeMailbox(uniqueMailbox("revoked"));
		const { password, metadata } = await createAppPassword(env, id, "Old laptop");
		expect((await auth({ mailbox: id, password })).status).toBe(200);

		await revokeAppPassword(env, id, metadata.id);

		const res = await auth({ mailbox: id, password });
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "Authentication failed" });
	});
});

describe("user enumeration", () => {
	it("makes an unknown mailbox indistinguishable from a wrong password", async () => {
		const known = await makeMailbox(uniqueMailbox("enum-known"));
		await createAppPassword(env, known, "Thunderbird");
		const unknown = uniqueMailbox("enum-unknown");
		const emptyMailbox = await makeMailbox(uniqueMailbox("enum-empty"));

		const guess = randomPassword();
		const responses = await Promise.all([
			auth({ mailbox: known, password: guess }),
			auth({ mailbox: unknown, password: guess }),
			auth({ mailbox: emptyMailbox, password: guess }),
		]);

		const shapes = await Promise.all(
			responses.map(async (res) => ({
				status: res.status,
				contentType: res.headers.get("content-type"),
				body: await res.text(),
			})),
		);

		// Byte-identical status, content type and body across all three cases.
		expect(shapes[1]).toEqual(shapes[0]);
		expect(shapes[2]).toEqual(shapes[0]);
		expect(shapes[0].status).toBe(401);
		expect(shapes[0].body).toBe(JSON.stringify({ error: "Authentication failed" }));

		// No header set on one response distinguishes it from another either.
		const headerNames = responses.map((res) => [...res.headers.keys()].sort().join(","));
		expect(new Set(headerNames).size).toBe(1);
	});

	it("does not leak how many app passwords a mailbox has", async () => {
		const one = await makeMailbox(uniqueMailbox("count-one"));
		await createAppPassword(env, one, "A");
		const many = await makeMailbox(uniqueMailbox("count-many"));
		await createAppPassword(env, many, "A");
		await createAppPassword(env, many, "B");
		await createAppPassword(env, many, "C");

		const guess = randomPassword();
		const a = await auth({ mailbox: one, password: guess });
		const b = await auth({ mailbox: many, password: guess });

		expect(b.status).toBe(a.status);
		expect(await b.text()).toBe(await a.text());
	});
});

describe("rate limiting", () => {
	it("blocks further attempts once the per-mailbox threshold is reached", async () => {
		const id = await makeMailbox(uniqueMailbox("ratelimit"));
		const { password } = await createAppPassword(env, id, "Thunderbird");

		for (let i = 0; i < AUTH_FAILURE_LIMIT; i++) {
			const res = await auth({ mailbox: id, password: randomPassword() });
			expect(res.status).toBe(401);
		}

		const blocked = await auth({ mailbox: id, password: randomPassword() });
		expect(blocked.status).toBe(429);
		expect(await blocked.json()).toEqual({ error: "Too many authentication attempts" });
		expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);

		// The correct password is refused too — the limit is on the oracle, not
		// on wrong answers, so an attacker cannot use a hit to escape it.
		const evenCorrect = await auth({ mailbox: id, password });
		expect(evenCorrect.status).toBe(429);
	});

	it("limits per mailbox, not globally", async () => {
		const attacked = await makeMailbox(uniqueMailbox("ratelimit-victim"));
		const bystander = await makeMailbox(uniqueMailbox("ratelimit-bystander"));
		const { password } = await createAppPassword(env, bystander, "Thunderbird");

		for (let i = 0; i < AUTH_FAILURE_LIMIT + 1; i++) {
			await auth({ mailbox: attacked, password: randomPassword() });
		}
		expect((await auth({ mailbox: attacked, password: randomPassword() })).status).toBe(429);

		expect((await auth({ mailbox: bystander, password })).status).toBe(200);
	});

	it("counts unknown mailboxes too, so the limiter is not bypassable", async () => {
		const unknown = uniqueMailbox("ratelimit-unknown");

		for (let i = 0; i < AUTH_FAILURE_LIMIT; i++) {
			expect((await auth({ mailbox: unknown, password: randomPassword() })).status).toBe(401);
		}
		expect((await auth({ mailbox: unknown, password: randomPassword() })).status).toBe(429);
	});

	it("hands the budget back after a successful login", async () => {
		const id = await makeMailbox(uniqueMailbox("ratelimit-reset"));
		const { password } = await createAppPassword(env, id, "Thunderbird");

		for (let i = 0; i < AUTH_FAILURE_LIMIT - 1; i++) {
			await auth({ mailbox: id, password: randomPassword() });
		}
		expect(await authRateLimiter(env, id).peek()).toBe(AUTH_FAILURE_LIMIT - 1);

		expect((await auth({ mailbox: id, password })).status).toBe(200);
		expect(await authRateLimiter(env, id).peek()).toBe(0);

		// A long-running mail client can keep going well past the raw threshold.
		for (let i = 0; i < AUTH_FAILURE_LIMIT + 5; i++) {
			expect((await auth({ mailbox: id, password })).status).toBe(200);
		}
	});
});

describe("request validation", () => {
	it("rejects malformed bodies without saying anything about mailboxes", async () => {
		for (const body of [
			"not json",
			{},
			{ mailbox: "a@example.com" },
			{ password: "x" },
			{ mailbox: "", password: "x" },
			{ mailbox: "a@example.com", password: "" },
			{ mailbox: 42, password: "x" },
			{ mailbox: "a".repeat(400) + "@example.com", password: "x" },
		]) {
			const res = await auth(body);
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "Invalid request" });
		}
	});
});

describe("logging hygiene", () => {
	it("never writes the password to any console channel on any path", async () => {
		const calls: unknown[][] = [];
		const record =
			(): ((...args: unknown[]) => void) =>
			(...args: unknown[]) => {
				calls.push(args);
			};
		vi.spyOn(console, "log").mockImplementation(record());
		vi.spyOn(console, "warn").mockImplementation(record());
		vi.spyOn(console, "error").mockImplementation(record());
		vi.spyOn(console, "info").mockImplementation(record());
		vi.spyOn(console, "debug").mockImplementation(record());

		const id = await makeMailbox(uniqueMailbox("logging"));
		const { password } = await createAppPassword(env, id, "Thunderbird");
		const wrong = randomPassword();
		const secrets = [password, password.replace(/-/g, ""), wrong];

		// Happy path, wrong password, unknown mailbox, malformed body, and the
		// rate-limited path.
		await auth({ mailbox: id, password });
		await auth({ mailbox: id, password: wrong });
		await auth({ mailbox: uniqueMailbox("logging-absent"), password });
		await auth("not json");
		for (let i = 0; i < AUTH_FAILURE_LIMIT + 2; i++) {
			await auth({ mailbox: id, password: wrong });
		}

		// Also make sure the stored salt and hash never surface.
		const stored = JSON.parse(
			await (await env.BUCKET.get(`credentials/${id}.json`))!.text(),
		) as { entries: { salt: string; hash: string }[] };
		for (const entry of stored.entries) secrets.push(entry.salt, entry.hash);

		const logged = calls.map((args) => args.map((a) => String(a)).join(" ")).join("\n");
		for (const secret of secrets) {
			expect(logged).not.toContain(secret);
		}
	});
});
