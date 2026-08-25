// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Folders } from "../shared/folders";
import { app } from "../workers/index";
import { toolSendEmail, toolSendReply } from "../workers/lib/tools";
import type { Env } from "../workers/types";
import { emailData, mailbox } from "./helpers";

/**
 * Every test in this file exercises a real outbound send path. The app calls
 * `env.EMAIL.send()` (a `remote: true` binding per wrangler.jsonc), which
 * requires a real Cloudflare account and hangs indefinitely under the local
 * test runner. Every path here gets a fake EMAIL binding so the send
 * "succeeds" instantly and we can assert on what got written to R2/the DO
 * without ever touching the network.
 */
function fakeEmailBinding(): Env["EMAIL"] {
	return { send: async () => ({ messageId: "fake-message-id" }) } as unknown as Env["EMAIL"];
}

function testEnv(): Env {
	return { ...(env as unknown as Env), EMAIL: fakeEmailBinding() };
}

async function jsonRequest(url: string, body: unknown): Promise<Response> {
	const request = new Request(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const ctx = createExecutionContext();
	const res = await app.fetch(request, testEnv(), ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

async function expectRawStored(mailboxId: string, emailId: string) {
	const stub = mailbox(mailboxId);
	const full = (await stub.getEmail(emailId)) as {
		raw_key: string | null;
		rfc822_size: number | null;
	};
	const expectedKey = `raw/${mailboxId}/${emailId}.eml`;
	expect(full.raw_key).toBe(expectedKey);
	expect(full.rfc822_size).toBeGreaterThan(0);

	const stored = await env.BUCKET.get(expectedKey);
	expect(stored).not.toBeNull();
	const text = await (stored as R2ObjectBody).text();
	expect(text).toContain("MIME-Version: 1.0");
	assertOnlyCRLF(text);
}

/** RFC 5322 mandates CRLF line endings. Scan for any bare LF or bare CR. */
function assertOnlyCRLF(raw: string) {
	for (let i = 0; i < raw.length; i++) {
		if (raw[i] === "\n" && raw[i - 1] !== "\r") {
			throw new Error(`Bare LF (no preceding CR) at index ${i}`);
		}
		if (raw[i] === "\r" && raw[i + 1] !== "\n") {
			throw new Error(`Bare CR (no following LF) at index ${i}`);
		}
	}
}

describe("outbound send paths write raw MIME and record raw_key (DEV-662)", () => {
	it("POST /emails (compose/send)", async () => {
		const mailboxId = "outbound-send@example.com";
		await env.BUCKET.put(`mailboxes/${mailboxId}.json`, "{}");

		const res = await jsonRequest(`https://internal/api/v1/mailboxes/${mailboxId}/emails`, {
			to: "recipient@example.com",
			from: mailboxId,
			subject: "Hello from compose",
			html: "<p>Hi there</p>",
		});
		expect(res.status).toBe(202);
		const body = (await res.json()) as { id: string };
		await expectRawStored(mailboxId, body.id);
	});

	it("POST /emails/:id/reply", async () => {
		const mailboxId = "outbound-reply@example.com";
		await env.BUCKET.put(`mailboxes/${mailboxId}.json`, "{}");
		const stub = mailbox(mailboxId);
		const original = emailData({ id: "orig-1" });
		await stub.createEmail(Folders.INBOX, original, []);

		const res = await jsonRequest(
			`https://internal/api/v1/mailboxes/${mailboxId}/emails/${original.id}/reply`,
			{
				to: original.sender,
				from: mailboxId,
				subject: `Re: ${original.subject}`,
				html: "<p>Replying now</p>",
			},
		);
		expect(res.status).toBe(202);
		const body = (await res.json()) as { id: string };
		await expectRawStored(mailboxId, body.id);
	});

	it("POST /emails/:id/forward", async () => {
		const mailboxId = "outbound-forward@example.com";
		await env.BUCKET.put(`mailboxes/${mailboxId}.json`, "{}");
		const stub = mailbox(mailboxId);
		const original = emailData({ id: "orig-2" });
		await stub.createEmail(Folders.INBOX, original, []);

		const res = await jsonRequest(
			`https://internal/api/v1/mailboxes/${mailboxId}/emails/${original.id}/forward`,
			{
				to: "someone-else@example.com",
				from: mailboxId,
				subject: `Fwd: ${original.subject}`,
				html: "<p>Forwarding this along</p>",
			},
		);
		expect(res.status).toBe(202);
		const body = (await res.json()) as { id: string };
		await expectRawStored(mailboxId, body.id);
	});

	it("toolSendReply (agent/MCP send path)", async () => {
		const mailboxId = "outbound-tool-reply@example.com";
		const stub = mailbox(mailboxId);
		const original = emailData({ id: "orig-3" });
		await stub.createEmail(Folders.INBOX, original, []);

		const result = await toolSendReply(testEnv(), mailboxId, {
			originalEmailId: original.id,
			to: original.sender,
			subject: `Re: ${original.subject}`,
			// Kept under 20 chars of visible text so verifyDraft's AI call is
			// skipped entirely (see workers/lib/ai.ts) -- this test must stay
			// hermetic and never reach the network.
			bodyHtml: "<p>Hi</p>",
		});
		expect(result).toMatchObject({ status: "sent" });
		const { messageId } = result as { messageId: string };
		await expectRawStored(mailboxId, messageId);
	});

	it("toolSendEmail (agent/MCP send path)", async () => {
		const mailboxId = "outbound-tool-send@example.com";

		const result = await toolSendEmail(testEnv(), mailboxId, {
			to: "recipient@example.com",
			subject: "New email from the agent",
			// Short body: skips the AI verifyDraft call, same reasoning as above.
			bodyHtml: "<p>Hi</p>",
		});
		expect(result).toMatchObject({ status: "sent" });
		const { messageId } = result as { messageId: string };
		await expectRawStored(mailboxId, messageId);
	});
});
