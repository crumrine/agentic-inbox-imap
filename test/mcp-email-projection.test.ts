// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * DEV-688 — internal IMAP columns leaked into MCP tool results and, from
 * there, into an LLM's context window.
 *
 * DEV-679 fixed this for the SPA by projecting `getEmail`/`getThreadEmails`
 * through a `CLIENT_EMAIL_FIELDS` allowlist in `workers/index.ts`. But
 * `getFullEmail`/`getFullThread` in `workers/lib/email-helpers.ts` still
 * spread the wide DO row directly, and those two feed `toolGetEmail`/
 * `toolGetThread` in `workers/lib/tools.ts` — which are exactly what the MCP
 * `get_email`/`get_thread` tools (and the AI agent, when it calls the same
 * tools) return. So `uid`, `answered`, `deleted`, `flags`, `rfc822_size` and
 * `raw_key` (an internal R2 path) were still reaching anything connected to
 * `/mcp`, and were still ending up in prompt content fed to a model.
 *
 * This file pins the fix at the `toolGetEmail`/`toolGetThread` boundary —
 * the exact functions the MCP server and the agent call — so a regression
 * that reintroduces `...email` in `getFullEmail`/`getFullThread` fails here
 * even without spinning up the MCP protocol layer.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Folders } from "../shared/folders";
import { toolGetEmail, toolGetThread } from "../workers/lib/tools";
import type { Env } from "../workers/types";
import { mailbox, type MailboxStub } from "./helpers";

let n = 0;
async function makeMailbox(prefix: string): Promise<{ id: string; stub: MailboxStub }> {
	n += 1;
	const id = `${prefix}-${n}@example.com`;
	await env.BUCKET.put(`mailboxes/${id}.json`, JSON.stringify({ fromName: "Test" }));
	return { id, stub: mailbox(id) };
}

interface SeedOptions {
	id: string;
	folder?: string;
	threadId?: string | null;
	subject?: string;
}

/** Seed one email with a raw_key/rfc822_size so IMAP-only columns are populated. */
async function seed(
	stub: MailboxStub,
	{ id, folder = Folders.INBOX, threadId = null, subject }: SeedOptions,
): Promise<void> {
	await stub.createEmail(
		folder,
		{
			id,
			subject: subject ?? `Subject ${id}`,
			sender: "sender@example.com",
			recipient: "recipient@example.com",
			cc: "cc@example.com",
			bcc: "bcc@example.com",
			date: "2026-03-01T10:00:00.000Z",
			body: "<p>Body</p>",
			in_reply_to: null,
			email_references: null,
			thread_id: threadId,
			message_id: `${id}@example.com`,
			raw_headers: JSON.stringify([{ key: "subject", value: subject ?? `Subject ${id}` }]),
			raw_key: `raw/mbox/${id}.eml`,
			rfc822_size: 1234,
		},
		[],
	);
}

/** Migration-9 columns that must never reach an MCP tool result or the agent's context. */
const INTERNAL_FIELDS = ["raw_key", "uid", "flags", "answered", "deleted", "rfc822_size"];

/** Everything the agent / MCP client / reply-forward path actually needs off a full email. */
const CLIENT_FIELDS = [
	"id", "thread_id", "folder_id", "subject", "sender", "recipient",
	"cc", "bcc", "date", "read", "starred", "body", "in_reply_to",
	"email_references", "message_id", "raw_headers", "attachments",
];

function expectNarrowed(email: Record<string, unknown>): void {
	for (const field of INTERNAL_FIELDS) expect(email).not.toHaveProperty(field);
	for (const field of CLIENT_FIELDS) expect(email).toHaveProperty(field);
}

describe("MCP get_email / get_thread do not leak internal IMAP columns (DEV-688)", () => {
	it("toolGetEmail (backs the MCP get_email tool) narrows the result", async () => {
		const { id } = await makeMailbox("mcp-email");
		const stub = mailbox(id);
		await seed(stub, { id: "e1", threadId: "t1" });

		const result = (await toolGetEmail(env as unknown as Env, id, "e1")) as Record<string, unknown>;

		expectNarrowed(result);
		// The computed plain/HTML body pair the agent and MCP clients rely on
		// must survive the projection — it's added on top, not part of the row.
		expect(result.body_text).toBe("Body");
		expect(result.body_html).toBe("<p>Body</p>");

		// Values, not just key presence.
		expect(result.id).toBe("e1");
		expect(result.thread_id).toBe("t1");
		expect(result.subject).toBe("Subject e1");
		expect(result.cc).toBe("cc@example.com");
	});

	it("toolGetThread (backs the MCP get_thread tool) narrows every message", async () => {
		const { id } = await makeMailbox("mcp-thread");
		const stub = mailbox(id);
		await seed(stub, { id: "t-a", threadId: "thr" });
		await seed(stub, { id: "t-b", folder: Folders.SENT, threadId: "thr" });

		const result = (await toolGetThread(env as unknown as Env, id, "thr")) as {
			thread_id: string;
			message_count: number;
			messages: Record<string, unknown>[];
		};

		expect(result.thread_id).toBe("thr");
		expect(result.message_count).toBe(2);
		for (const message of result.messages) {
			expectNarrowed(message);
			expect(message.body_text).toBe("Body");
		}
		expect(result.messages.map((m) => m.id).sort()).toEqual(["t-a", "t-b"]);
	});

	it("toolGetEmail still reports a clean not-found error, not a leak of nothing", async () => {
		const { id } = await makeMailbox("mcp-missing");

		const result = await toolGetEmail(env as unknown as Env, id, "nope");

		expect(result).toEqual({ error: "Email not found" });
	});
});
