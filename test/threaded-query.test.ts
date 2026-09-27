// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	env,
	runInDurableObject,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { expect, it } from "vitest";
import baseline from "./fixtures/threaded-baseline.json";
import { mailbox, emailData, query, exec, type MailboxStub } from "./helpers";
import { app } from "../workers/index";
import type { Env } from "../workers/types";

// Frozen SQL from d01da09: preserves even the legacy empty-subject list/count
// discrepancy and mapping multiplicity. Never regenerate from the optimized query.
async function original(
	stub: MailboxStub,
	folder: string,
	page = 1,
	limit = 25,
) {
	const draft = folder === "draft";
	const rows = await query<any>(
		stub,
		draft ? baseline.draft : baseline.inbox,
		folder,
		limit,
		(page - 1) * limit,
	);
	const count = await query<any>(
		stub,
		draft ? baseline.draftCount : baseline.inboxCount,
		folder,
	);
	return {
		emails: rows.map((row) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
			thread_count: row.thread_count || 1,
			thread_unread_count: row.thread_unread_count || 0,
			participants: row.participants || row.sender,
			...(!draft
				? { needs_reply: !!row.needs_reply, has_draft: !!row.has_draft }
				: {}),
		})),
		totalCount: count[0].total,
	};
}

it("matches baseline grouping, deep pages and immediate mutation reads through the REST route", async () => {
	const id = "threaded@example.com";
	const stub = mailbox(id);
	await env.BUCKET.put(`mailboxes/${id}.json`, "{}");
	for (let i = 0; i < 80; i++) {
		await stub.createEmail(
			i % 9 === 0 ? "draft" : i % 7 === 0 ? "sent" : "inbox",
			{
				...emailData({
					id: `m-${i}`,
					date: new Date(
						1700000000000 + Math.floor(i / 2) * 1000,
					).toISOString(),
				}),
				subject: ["Topic", "Re: Topic", "Fwd: Topic", "Other", "", null][
					i % 6
				] as any,
				thread_id: i % 3 === 0 ? null : `thread-${i % 11}`,
				in_reply_to: i % 4 === 0 ? "parent" : null,
				sender: `sender-${i % 5}@example.com`,
				body: "🙂abc".repeat(2000),
			},
			[],
		);
	}
	const verify = async () => {
		for (const folder of ["inbox", "draft", "sent", "archive", "missing"]) {
			for (const page of [1, 3, 99]) {
				const expected = await original(stub, folder, page, 3);
				const ctx = createExecutionContext();
				const res = await app.fetch(
					new Request(
						`https://test/api/v1/mailboxes/${id}/emails?threaded=true&folder=${folder}&page=${page}&limit=3`,
					),
					env as unknown as Env,
					ctx,
				);
				await waitOnExecutionContext(ctx);
				expect(res.status).toBe(200);
				expect(await res.json()).toEqual(expected);
			}
		}
	};
	await verify();
	await stub.createEmail(
		"inbox",
		{
			...emailData({ id: "new", date: "2026-09-27T00:00:00Z" }),
			thread_id: "thread-1",
		},
		[],
	);
	await verify();
	await stub.updateEmail("new", { read: true });
	await stub.markThreadRead("thread-2");
	await verify();
	await stub.createEmail(
		"draft",
		{
			...emailData({ id: "reply-draft" }),
			in_reply_to: "new",
			thread_id: "thread-1",
		},
		[],
	);
	await exec(
		stub,
		"UPDATE emails SET body = ?, date = ? WHERE id = ?",
		"updated draft",
		"2026-09-28T00:00:00Z",
		"reply-draft",
	);
	await verify();
	await stub.moveEmail("new", "archive");
	await stub.deleteEmail("reply-draft");
	await verify();
	// Name and ID resolution remain identical, including draft classification by input.
	await exec(stub, "UPDATE folders SET name = 'Saved' WHERE id = 'archive'");
	expect(await stub.getThreadedEmailPage({ folder: "Saved" })).toEqual(
		await original(stub, "Saved"),
	);
}, 60_000);

it("matches baseline full refreshes at 1k and 10k messages", async () => {
	for (const size of [1000, 10000]) {
		const stub = mailbox(`bench-${size}`);
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.transactionSync(() => {
				for (let i = 0; i < size; i++)
					state.storage.sql.exec(
						`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, thread_id, read, in_reply_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						`b-${i}`,
						i % 10 === 0 ? "draft" : i % 4 === 0 ? "sent" : "inbox",
						`Topic ${Math.floor(i / 5)}`,
						`s${i % 7}@example.com`,
						"to@example.com",
						new Date(1700000000000 + i * 1000).toISOString(),
						"0123456789".repeat(1000),
						i % 13 === 0 ? null : `t-${Math.floor(i / 5)}`,
						i % 2,
						i % 3 === 0 ? `b-${i - 1}` : null,
					);
			});
		});
		for (const folder of ["inbox", "draft"])
			for (const page of [1, 10]) {
				const expected = await original(stub, folder, page);
				expect(await stub.getThreadedEmailPage({ folder, page })).toEqual(
					expected,
				);
			}
	}
}, 120_000);
