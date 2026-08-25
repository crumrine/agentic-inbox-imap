// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * DEV-692 part one — the alias registry, inbound routing through it, and the
 * outbound invariant it relaxes.
 *
 * Three things here are load-bearing and each is pinned for a different reason:
 *
 * 1. **Inbound no longer drops silently.** Before this, `receiveEmail` ignored
 *    any message whose recipient had no `mailboxes/{id}.json` — an `info@`
 *    pointed at a mailbox received nothing and logged a line. That is data
 *    loss, so the delivery test asserts the message actually lands in the
 *    inbox, not that a lookup returned something.
 *
 * 2. **Collisions are refused in both creation orders.** Alias-then-mailbox
 *    and mailbox-then-alias are separate code paths in separate files
 *    (`createAlias` in workers/lib/aliases.ts, `POST /api/v1/mailboxes` in
 *    workers/index.ts). Checking one direction and not the other is the
 *    natural half-implementation, and the missing half is the one where a new
 *    mailbox silently steals an existing alias's mail —
 *    `resolveInboundDelivery` prefers a mailbox at an address over an alias at
 *    it.
 *
 * 3. **`validateSender` still cannot be talked into a spoof.** The equality
 *    check `fromEmail === mailboxId` was the single thing standing between an
 *    Access-authenticated caller and sending as any address the deployment
 *    owns. Relaxing it to "the mailbox, or a verified alias" is only safe if
 *    "verified" means a registry record. The four rejection cases below —
 *    unrelated address, alias belonging to another mailbox, unregistered
 *    lookalike on the same domain, unregistered address on a domain that has
 *    registered aliases — are chosen so that replacing the lookup with any
 *    domain- or pattern-based check fails at least two of them.
 */

import {
	createExecutionContext,
	env,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
	aliasKey,
	createAlias,
	deleteAlias,
	type DeliveryCandidate,
	isAlias,
	listAliases,
	resolveAlias,
	resolveInboundDelivery,
} from "../workers/lib/aliases";
import {
	SenderValidationError,
	validateSender,
	validateSenderWithAliases,
} from "../workers/lib/email-helpers";
import { receiveEmail } from "../workers/index";
import type { Env } from "../workers/types";
import { mailbox } from "./helpers";

const testEnv = env as unknown as Env;

let n = 0;

/** A mailbox exists iff its R2 settings blob does. */
async function makeMailbox(prefix: string): Promise<string> {
	n += 1;
	const id = `${prefix}-${n}@example.com`;
	await env.BUCKET.put(`mailboxes/${id}.json`, JSON.stringify({ fromName: "Test" }));
	return id;
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

function rawEmailBytes(to: string, subject: string): Uint8Array {
	return new TextEncoder().encode(
		[
			"From: outsider@somewhere-else.example",
			`To: ${to}`,
			`Subject: ${subject}`,
			"Date: Sat, 22 Aug 2026 00:00:00 +0000",
			"MIME-Version: 1.0",
			'Content-Type: text/plain; charset="UTF-8"',
			"",
			"Hello.",
			"",
		].join("\r\n"),
	);
}

/** Deliver one message, with an optional SMTP envelope recipient. */
async function deliver(
	headerTo: string,
	subject: string,
	envelopeTo?: string,
): Promise<void> {
	const bytes = rawEmailBytes(headerTo, subject);
	const ctx = createExecutionContext();
	await receiveEmail(
		{ raw: streamFromBytes(bytes), rawSize: bytes.byteLength, to: envelopeTo },
		testEnv,
		ctx,
	);
	await waitOnExecutionContext(ctx);
}

async function inboxSubjects(mailboxId: string): Promise<string[]> {
	const emails = await mailbox(mailboxId).getEmails({ folder: "inbox" });
	return emails.map((e) => e.subject ?? "");
}

// ── Registry ────────────────────────────────────────────────────────

describe("alias registry", () => {
	it("resolves an alias to the mailbox it points at", async () => {
		const box = await makeMailbox("owner");
		const alias = `info-${n}@example.com`;

		const created = await createAlias(testEnv, alias, box);
		expect(created.ok).toBe(true);
		expect(await resolveAlias(testEnv, alias)).toBe(box);
	});

	it("normalises addresses the way mailbox ids are normalised", async () => {
		const box = await makeMailbox("norm");
		const alias = `Contact-${n}@Example.COM`;

		expect((await createAlias(testEnv, `  ${alias}  `, box)).ok).toBe(true);
		// Stored under, and resolvable by, the lowercased form regardless of
		// how it is spelled on the way in.
		expect(await env.BUCKET.head(aliasKey(alias.toLowerCase()))).not.toBeNull();
		expect(await resolveAlias(testEnv, alias.toUpperCase())).toBe(box);
		expect(await resolveAlias(testEnv, ` ${alias} `)).toBe(box);
	});

	it("resolves an address that is not an alias to null", async () => {
		expect(await resolveAlias(testEnv, "nobody@example.com")).toBeNull();
		expect(await resolveAlias(testEnv, "not-an-address")).toBeNull();
	});

	it("lists only the aliases belonging to the mailbox asked about", async () => {
		const mine = await makeMailbox("mine");
		const theirs = await makeMailbox("theirs");
		await createAlias(testEnv, `sales-${n}@example.com`, mine);
		await createAlias(testEnv, `billing-${n}@example.com`, mine);
		await createAlias(testEnv, `press-${n}@example.com`, theirs);

		const listed = await listAliases(testEnv, mine);
		expect(listed.map((a) => a.address)).toEqual([
			`billing-${n}@example.com`,
			`sales-${n}@example.com`,
		]);
		expect(listed.every((a) => a.mailbox === mine)).toBe(true);
	});

	it("refuses an alias for a mailbox that does not exist", async () => {
		const result = await createAlias(
			testEnv,
			"orphan@example.com",
			"no-such-mailbox@example.com",
		);
		expect(result).toMatchObject({ ok: false, reason: "no-such-mailbox" });
		// And wrote nothing, so no record is left for a later mailbox to inherit.
		expect(await env.BUCKET.head(aliasKey("orphan@example.com"))).toBeNull();
	});

	it("refuses an alias equal to the mailbox's own address", async () => {
		const box = await makeMailbox("self");
		expect(await createAlias(testEnv, box, box)).toMatchObject({
			ok: false,
			reason: "mailbox-conflict",
		});
	});

	it("honours a non-empty EMAIL_ADDRESSES allowlist", async () => {
		const box = await makeMailbox("allowlist");
		const permitted = `desk-${n}@example.com`;
		const restricted = {
			...testEnv,
			EMAIL_ADDRESSES: [box, permitted] as unknown as Env["EMAIL_ADDRESSES"],
		};

		expect((await createAlias(restricted, permitted, box)).ok).toBe(true);
		// Same domain, not on the list. An alias here could never receive mail:
		// receiveEmail filters recipients against the same list before any
		// alias lookup runs, so accepting it would only create a dead record.
		expect(
			await createAlias(restricted, `stranger-${n}@example.com`, box),
		).toMatchObject({ ok: false, reason: "not-allowed" });
	});
});

// ── Collisions, both orders ─────────────────────────────────────────

describe("alias/mailbox collisions", () => {
	it("refuses an alias at an address that is already a mailbox", async () => {
		const box = await makeMailbox("target");
		const other = await makeMailbox("existing");

		const result = await createAlias(testEnv, other, box);
		expect(result).toMatchObject({ ok: false, reason: "mailbox-conflict" });
		// The other mailbox's mail is untouched: nothing was written.
		expect(await resolveAlias(testEnv, other)).toBeNull();
	});

	it("refuses a mailbox at an address that is already an alias", async () => {
		const box = await makeMailbox("holder");
		const alias = `taken-${n}@example.com`;
		expect((await createAlias(testEnv, alias, box)).ok).toBe(true);

		// This is the direction that steals mail if it is missed: a mailbox at
		// the alias's address wins delivery over the alias.
		expect(await isAlias(testEnv, alias)).toBe(true);
		// The route-level assertion for this lives in aliases-api.test.ts; here
		// the point is that the registry can answer the question at all.
		expect(await isAlias(testEnv, `untaken-${n}@example.com`)).toBe(false);
	});

	it("does not silently re-point an alias that already exists", async () => {
		const first = await makeMailbox("first");
		const second = await makeMailbox("second");
		const alias = `shared-${n}@example.com`;

		expect((await createAlias(testEnv, alias, first)).ok).toBe(true);

		const stolen = await createAlias(testEnv, alias, second);
		expect(stolen).toMatchObject({ ok: false, reason: "alias-exists" });
		expect(stolen.ok === false && stolen.message).toContain(first);
		// Still pointing where it did.
		expect(await resolveAlias(testEnv, alias)).toBe(first);

		// Re-creating it on the mailbox that already owns it is refused too,
		// rather than quietly resetting the record.
		expect(await createAlias(testEnv, alias, first)).toMatchObject({
			ok: false,
			reason: "alias-exists",
		});

		// Re-pointing is possible, but only by saying so.
		const repointed = await createAlias(testEnv, alias, second, {
			allowRepoint: true,
		});
		expect(repointed.ok).toBe(true);
		expect(await resolveAlias(testEnv, alias)).toBe(second);
	});

	it("stops resolving once the alias is deleted", async () => {
		const box = await makeMailbox("deleting");
		const alias = `temp-${n}@example.com`;
		await createAlias(testEnv, alias, box);
		expect(await resolveAlias(testEnv, alias)).toBe(box);

		expect(await deleteAlias(testEnv, alias, box)).toBe(true);
		expect(await resolveAlias(testEnv, alias)).toBeNull();
		expect(await listAliases(testEnv, box)).toEqual([]);
		// And a second delete is a miss, not a success.
		expect(await deleteAlias(testEnv, alias, box)).toBe(false);
	});

	it("will not let one mailbox delete another mailbox's alias", async () => {
		const owner = await makeMailbox("keeper");
		const intruder = await makeMailbox("intruder");
		const alias = `guarded-${n}@example.com`;
		await createAlias(testEnv, alias, owner);

		expect(await deleteAlias(testEnv, alias, intruder)).toBe(false);
		expect(await resolveAlias(testEnv, alias)).toBe(owner);
	});
});

// ── Inbound ─────────────────────────────────────────────────────────

describe("receiveEmail: delivery through the alias registry", () => {
	it("delivers mail addressed to an alias into the aliased mailbox", async () => {
		const box = await makeMailbox("inbound");
		const alias = `info-${n}@example.com`;
		await createAlias(testEnv, alias, box);

		await deliver(alias, "Reaches the mailbox behind the alias");

		expect(await inboxSubjects(box)).toEqual([
			"Reaches the mailbox behind the alias",
		]);
	});

	it("still ignores an address that is neither a mailbox nor an alias", async () => {
		const box = await makeMailbox("unrelated");

		await deliver(`stranger-${n}@example.com`, "Should be dropped");

		expect(await inboxSubjects(box)).toEqual([]);
	});

	it("stops delivering once the alias is removed", async () => {
		const box = await makeMailbox("revoked");
		const alias = `gone-${n}@example.com`;
		await createAlias(testEnv, alias, box);

		await deliver(alias, "Before removal");
		await deleteAlias(testEnv, alias, box);
		await deliver(alias, "After removal");

		expect(await inboxSubjects(box)).toEqual(["Before removal"]);
	});

	it("prefers a real mailbox over an alias when both recipients are ours", async () => {
		const direct = await makeMailbox("direct");
		const aliased = await makeMailbox("aliased");
		const alias = `also-${n}@example.com`;
		await createAlias(testEnv, alias, aliased);

		// Header order decides among header recipients; the mailbox comes first
		// here, so it wins and the alias's mailbox gets nothing.
		await deliver(`${direct}, ${alias}`, "Two of ours");

		expect(await inboxSubjects(direct)).toEqual(["Two of ours"]);
		expect(await inboxSubjects(aliased)).toEqual([]);
	});

	it("routes by the SMTP envelope recipient when the headers do not name us", async () => {
		const box = await makeMailbox("bcc");
		const alias = `hidden-${n}@example.com`;
		await createAlias(testEnv, alias, box);

		// What a Bcc looks like from inside the Worker: the message names
		// somebody else entirely, and only the envelope knows it came here.
		await deliver("someone-else@somewhere-else.example", "Blind copy", alias);

		expect(await inboxSubjects(box)).toEqual(["Blind copy"]);
	});
});

// ── resolveInboundDelivery, directly ────────────────────────────────

/**
 * The candidate list `receiveEmail` builds: the SMTP envelope recipient, then
 * the header `To:` addresses in order. Every address here is an exact alias or
 * a real mailbox, so the provenance changes nothing — see
 * test/alias-wildcard.test.ts, where it is the whole subject.
 */
function candidates(
	envelopeTo: string | null,
	...headerTo: string[]
): DeliveryCandidate[] {
	return [
		...(envelopeTo ? [{ address: envelopeTo, source: "envelope" } as const] : []),
		...headerTo.map((address): DeliveryCandidate => ({ address, source: "header" })),
	];
}

describe("resolveInboundDelivery", () => {
	it("reports which address routed the message, not just the mailbox", async () => {
		const box = await makeMailbox("delivered-to");
		const alias = `support-${n}@example.com`;
		await createAlias(testEnv, alias, box);

		// This is the value the `delivered_to` column will hold. It has to be
		// the alias the message arrived at, not the mailbox it landed in —
		// otherwise automatic send-as has nothing to key on.
		expect(await resolveInboundDelivery(testEnv, candidates(alias))).toEqual({
			mailboxId: box,
			deliveredTo: alias,
		});
		expect(await resolveInboundDelivery(testEnv, candidates(box))).toEqual({
			mailboxId: box,
			deliveredTo: box,
		});
	});

	it("distinguishes two of the same mailbox's aliases on one message", async () => {
		const box = await makeMailbox("multi");
		const first = `sales-${n}@example.com`;
		const second = `press-${n}@example.com`;
		await createAlias(testEnv, first, box);
		await createAlias(testEnv, second, box);

		// Both belong to the same mailbox, so `recipient` (every To joined)
		// cannot say which one routed it. The envelope can, and leads.
		expect(await resolveInboundDelivery(testEnv, candidates(second, first))).toEqual({
			mailboxId: box,
			deliveredTo: second,
		});
	});

	it("returns null when nothing matches", async () => {
		expect(
			await resolveInboundDelivery(testEnv, candidates("nope@example.com", "also-nope")),
		).toBeNull();
	});

	it("does not deliver through an alias whose mailbox has been deleted", async () => {
		const box = await makeMailbox("orphaned");
		const alias = `dangling-${n}@example.com`;
		await createAlias(testEnv, alias, box);
		await env.BUCKET.delete(`mailboxes/${box}.json`);

		expect(await resolveInboundDelivery(testEnv, candidates(alias))).toBeNull();
	});
});

// ── Outbound ────────────────────────────────────────────────────────

describe("validateSender: sending as an alias", () => {
	async function expectRejected(
		from: string,
		mailboxId: string,
	): Promise<void> {
		await expect(
			validateSenderWithAliases(testEnv, "someone@example.com", from, mailboxId),
		).rejects.toBeInstanceOf(SenderValidationError);
	}

	it("still accepts the mailbox's own address", async () => {
		const box = await makeMailbox("plain");
		const result = await validateSenderWithAliases(
			testEnv,
			"someone@example.com",
			box,
			box,
		);
		expect(result.fromEmail).toBe(box);
	});

	it("accepts an address verified to alias to this mailbox", async () => {
		const box = await makeMailbox("sendas");
		const alias = `hello-${n}@example.com`;
		await createAlias(testEnv, alias, box);

		const result = await validateSenderWithAliases(
			testEnv,
			"someone@example.com",
			{ email: alias, name: "Hello" },
			box,
		);
		expect(result.fromEmail).toBe(alias);
		expect(result.fromDomain).toBe("example.com");
	});

	it("rejects an unrelated address", async () => {
		const box = await makeMailbox("unrelated-from");
		await expectRejected("attacker@somewhere-else.example", box);
	});

	it("rejects an address aliased to a DIFFERENT mailbox", async () => {
		const victim = await makeMailbox("victim");
		const attacker = await makeMailbox("attacker");
		const alias = `ceo-${n}@example.com`;
		await createAlias(testEnv, alias, victim);

		// The record exists — it just does not point here. A check that only
		// asked "is this a known alias?" would pass this.
		expect(await resolveAlias(testEnv, alias)).toBe(victim);
		await expectRejected(alias, attacker);
	});

	it("rejects an unregistered lookalike on the mailbox's own domain", async () => {
		const box = await makeMailbox("lookalike");
		// Never registered. A domain check would accept it, because it is on
		// the same domain as the mailbox itself.
		await expectRejected(`billing-${n}@example.com`, box);
	});

	it("rejects an unregistered address on a domain that HAS registered aliases", async () => {
		const box = await makeMailbox("neighbour");
		await createAlias(testEnv, `real-${n}@example.com`, box);

		// The alias next to it is real and points here; this one is not. Only a
		// per-address record can tell them apart.
		await expectRejected(`fake-${n}@example.com`, box);
	});

	it("rejects an alias after it has been deleted", async () => {
		const box = await makeMailbox("expired");
		const alias = `once-${n}@example.com`;
		await createAlias(testEnv, alias, box);
		await validateSenderWithAliases(testEnv, "someone@example.com", alias, box);

		await deleteAlias(testEnv, alias, box);
		await expectRejected(alias, box);
	});

	it("keeps the synchronous form strict for callers that pass no aliases", async () => {
		const box = await makeMailbox("sync");
		const alias = `sync-alias-${n}@example.com`;
		await createAlias(testEnv, alias, box);

		// A registered alias must NOT slip through a call that never asked for
		// one: `allowedSenders` is the whole permission, and defaulting it to
		// empty is what keeps every caller that has not opted in strict.
		// (The SMTP submission path in workers/routes/imap-api.ts did call it
		// exactly like this; DEV-692 part two moved it to the async form so a
		// mail client can send as an alias. This still pins the sync form.)
		expect(() => validateSender("someone@example.com", alias, box)).toThrow(
			SenderValidationError,
		);
	});
});
