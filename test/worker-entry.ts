// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Test-only Worker entrypoint.
 *
 * The real entrypoint (workers/app.ts) imports the React Router server build
 * through a Vite virtual module that only exists during a `react-router
 * build`, so tests point `main` here instead.
 *
 * MailboxDO and ImapAuthRateLimitDO are the real classes. EMAIL_AGENT and
 * EMAIL_MCP are bound in wrangler.jsonc but are deliberately replaced with
 * inert stubs here: importing the real EmailAgent drags in the whole Agents
 * SDK / MCP dependency tree and its sourcemap noise, which tests do not need.
 *
 * The stubs are not optional. `receiveEmail()` fires the agent auto-draft via
 * `ctx.waitUntil(EMAIL_AGENT...fetch(...))`, so an unbound EMAIL_AGENT surfaces
 * as an uncaught "does not export a EmailAgent Durable Object" rejection during
 * the inbound tests. The tests still passed, but an uncaught exception in the
 * run is exactly the thing that hides a real failure later.
 */

import { DurableObject } from "cloudflare:workers";

export { MailboxDO } from "../workers/durableObject";
export { ImapAuthRateLimitDO } from "../workers/durableObject/authRateLimit";

/** Inert stand-in for the real EmailAgent. Accepts and discards auto-draft triggers. */
export class EmailAgent extends DurableObject {
	async fetch(): Promise<Response> {
		return new Response(null, { status: 204 });
	}
}

/** Inert stand-in for the real EmailMCP. Nothing exercises it yet; bound so it cannot surprise us. */
export class EmailMCP extends DurableObject {
	async fetch(): Promise<Response> {
		return new Response(null, { status: 204 });
	}
}

export default {
	fetch(): Response {
		return new Response("test entrypoint", { status: 200 });
	},
};
