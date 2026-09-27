// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { requireAccess } from "./access";
import { createRequestHandler } from "react-router";
import { app as apiApp, handleInboundEmail } from "./index";
import { EmailMCP } from "./mcp";
import { imapApi, IMAP_API_BASE } from "./routes/imap-api";
import type { Env } from "./types";

export { MailboxDO } from "./durableObject";
export { EmailAgent } from "./agent";
export { EmailMCP } from "./mcp";
export { ImapAuthRateLimitDO } from "./durableObject/authRateLimit";

declare module "react-router" {
	export interface AppLoadContext {
		cloudflare: {
			env: Env;
			ctx: ExecutionContext;
		};
	}
}

const requestHandler = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

// Main app that wraps the API and adds React Router fallback
const app = new Hono<{ Bindings: Env }>();

// Cloudflare Access JWT validation middleware (production only)
app.use("*", (c, next) => {
	if (import.meta.env.DEV) return next();
	return requireAccess(c, next);
});

// MCP server endpoint — used by AI coding tools (ProtoAgent, Claude Code, Cursor, etc.)
// Must be before API routes and React Router catch-all
const mcpHandler = EmailMCP.serve("/mcp", { binding: "EMAIL_MCP" });
app.all("/mcp", async (c) => {
	return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});
app.all("/mcp/*", async (c) => {
	return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});

// Mount the API routes
app.route("/", apiApp);

// IMAP gateway API — must be before the React Router catch-all, which would
// otherwise swallow it and answer with the SPA shell. Mounted after apiApp so
// that apiApp's `/api/*` CORS middleware (registered earlier, therefore
// composed ahead of these handlers) applies to it too. Sits inside the Access
// middleware registered at the top of this file.
app.route(IMAP_API_BASE, imapApi);

// Agent WebSocket routing - must be before React Router catch-all
app.all("/agents/*", async (c) => {
	const response = await routeAgentRequest(c.req.raw, c.env);
	if (response) return response;
	return c.text("Agent not found", 404);
});

// React Router catch-all: serves the SPA for all non-API routes
app.all("*", (c) => {
	return requestHandler(c.req.raw, {
		cloudflare: { env: c.env, ctx: c.executionCtx as ExecutionContext },
	});
});

/**
 * The Hono app, plus the inbound-mail handler.
 *
 * `message` is a `ForwardableEmailMessage`, the type Cloudflare's runtime
 * actually passes. It was previously annotated `{ raw, rawSize }`, which was
 * simply wrong — `receiveEmail` has always read `.to` off it — and it hid
 * `.setReject`, which is the whole mechanism for refusing a message.
 *
 * ## Two failure shapes, deliberately different
 *
 * **The recipient does not exist here** (no mailbox, no alias, or filtered out
 * by `EMAIL_ADDRESSES`), or the message is structurally unusable or oversize.
 * `handleInboundEmail` calls `setReject`, which the docs describe as returning
 * "a permanent SMTP error" to the connecting server. That is correct and
 * desirable: no retry will conjure the mailbox into existence, and the sending
 * server's own bounce is what tells the human they typed the address wrong.
 * The domain routes catch-all to this Worker, so without this every typo was
 * accepted with a 250 and then discarded — the sender believed it arrived.
 *
 * **Anything internal** — an R2 hiccup, a Durable Object error, a bug — throws
 * out of `handleInboundEmail` and is re-thrown here. It must never reach
 * `setReject`, because permanently rejecting perfectly deliverable mail on
 * account of our own outage is strictly worse than any alternative.
 *
 * ## What throwing actually does: not documented
 *
 * The previous comment here claimed the re-throw lets "Cloudflare's email
 * routing retry delivery or bounce the message". **That claim is unverified
 * and this code should not be read as relying on it.** Cloudflare's Email
 * Service docs do not state what an unhandled exception in an `email()`
 * handler does. The inbound flowchart in the email-lifecycle page models
 * exactly three outcomes out of the Worker node — `forward`, `reply`,
 * `setReject` — and has no edge for an exception at all. The 4xx-soft-bounce /
 * 5xx-hard-bounce retry language on that same page describes Cloudflare's
 * *outbound* delivery attempts to a destination server, a different leg of a
 * different pipeline; it does not transfer to Worker execution.
 *
 * Nor is there any documented way to ask for a temporary failure. There is no
 * `setDefer`, no 4xx equivalent, nothing analogous to Queues' `message.retry()`
 * or Workflows' `NonRetryableError`. `setReject` is the only rejection
 * primitive and it is permanent.
 *
 * So the re-throw is a choice between one known-bad outcome and one unknown
 * one, and it takes the unknown: an undocumented disposition might be a retry,
 * a generic failure, or a drop, but `setReject` here is *certainly* a permanent
 * rejection of mail that would deliver fine once the fault clears. The
 * console.error is the load-bearing half — it is what surfaces the failure in
 * the Workers logs, and it must stay even if the throw semantics are one day
 * pinned down. If anyone establishes empirically what a throw does (deploy a
 * throwing handler and read the SMTP session; local `wrangler dev` will not
 * tell you), record it here.
 */
export default {
	fetch: app.fetch,
	async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
		try {
			await handleInboundEmail(message, env, ctx);
		} catch (e) {
			console.error("Failed to process incoming email:", (e as Error).message, (e as Error).stack);
			throw e;
		}
	},
};
