// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Domain-wildcard aliases: one record, spelled `brian@`, covering that local
 * part on every domain the deployment handles.
 *
 * The feature is two halves with opposite risk profiles, and this file is
 * organised around that split rather than around the code.
 *
 * ## Inbound: the risk is being too greedy
 *
 * A wildcard widens what this Worker accepts, and the thing it must not widen
 * is "everything". Three properties are asserted from both sides:
 *
 * 1. **Precedence, on every domain.** A real mailbox at the address beats an
 *    exact alias at it, which beats the wildcard. Each is asserted by where
 *    the message actually lands, not by what a lookup returned — the failure
 *    mode is a wildcard silently swallowing another mailbox's mail, and that
 *    looks exactly like success from the resolver's point of view.
 * 2. **An unknown address is still refused.** DEV-700 made this Worker reject
 *    rather than accept-and-discard, and a wildcard is the most plausible way
 *    to regress it. `nobody@` on a covered domain must still bounce.
 * 3. **Only the envelope recipient.** A wildcard may match the address
 *    Cloudflare actually routed here and nothing else. The header `To:`
 *    addresses are candidates too and they are written by the *sender*, so a
 *    wildcard that matched one would let a stranger get any `brian@anything`
 *    accepted and parked in `delivered_to` as a send-as candidate. Pinned from
 *    three sides, because a test that only asserted the rejection would also
 *    pass if header candidates were ignored altogether, and one that only
 *    asserted the envelope would pass if the rule were not there at all:
 *    the envelope delivers, the header alone does not, and an exact alias or a
 *    real mailbox named in that same header still does.
 *
 * ## Outbound: the risk is granting a spoof
 *
 * A wildcard must never mean "may send as brian@anything". The permission
 * comes from one place only — the message being answered having *arrived* at
 * that address, which is what `delivered_to` records — and everything without
 * that evidence has to fall back to the mailbox's own address. So compose, a
 * reply to a row with NULL `delivered_to`, and a bare From-header lookup are
 * all asserted to fall back, and both real send paths (the SPA's reply route
 * and SMTP submission) are asserted to use the delivered address, because
 * "green suite, wrong surface" is the specific way this feature has been
 * reported finished before.
 */

import {
	createExecutionContext,
	env,
	waitOnExecutionContext,
} from "cloudflare:test";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";

import { Folders } from "../shared/folders";
import {
	type AliasEnv,
	createAlias,
	deleteAlias,
	isPlausibleLocalPart,
	listAliases,
	readDeliveryAlias,
	resolveAlias,
	resolveInboundDelivery,
	ALIAS_LOCAL_PART_MAX_CHARS,
} from "../workers/lib/aliases";
import {
	resolveSendAs,
	SenderValidationError,
	validateSenderWithAliases,
} from "../workers/lib/email-helpers";
import { app, receiveEmail } from "../workers/index";
import {
	IMAP_API_BASE,
	type ImapApiEnv,
	imapApi,
} from "../workers/routes/imap-api";
import type { Env } from "../workers/types";
import { type MailboxStub, mailbox, query } from "./helpers";

/**
 * Fixed names for the whole file, not one per test.
 *
 * `test/setup.ts`'s afterEach walks every MailboxDO id that has ever been
 * named and wipes it, so minting a mailbox per test is quadratic in teardown.
 * Storage and R2 are still wiped between tests, so each one gets a freshly
 * migrated Durable Object and an empty registry out of these names.
 */
const OWNER = "owner@example.com";
const EXACT_OWNER = "exact@example.com";
/** A real mailbox sitting on one of the addresses the wildcard would cover. */
const RIVAL = "brian@example.net";

const OUTSIDER = "outsider@somewhere-else.example";

/** The wildcard itself, and the addresses it does and does not cover. */
const WILDCARD = "brian@";
const COVERED_COM = "brian@example.com";
const COVERED_NET = "brian@example.net";
/**
 * The same local part on a domain nothing here owns. A sender can put this in
 * a `To:` header; Cloudflare will never hand it to this Worker as an envelope
 * recipient, and that difference is the security boundary.
 */
const FORGED = "brian@attacker.example";

/** An address routed here that no record covers, for use as a decoy envelope. */
const UNROUTED = "unrouted@example.com";

/**
 * The ambient env, unmodified. Nothing here configures `DOMAINS`: it is a UI
 * hint and no longer bounds a wildcard, and the two covered domains above are
 * declared nowhere — which is the point, since "covers every domain" now has
 * to be a claim about where a message arrived rather than about config.
 */
const testEnv = env as unknown as Env;

let ownerStub: MailboxStub;

beforeEach(async () => {
	// R2 is reset between tests, so the registry has to be rebuilt: a mailbox
	// exists iff its settings blob does.
	for (const id of [OWNER, EXACT_OWNER]) {
		await env.BUCKET.put(`mailboxes/${id}.json`, JSON.stringify({ fromName: "Test" }));
	}
	ownerStub = mailbox(OWNER);
	await ownerStub.getFolders();
});

// ── Fakes ─────────────────────────────────────────────────────────────

interface SentMessage {
	from: string | { email: string; name: string };
	to: string | string[];
	raw?: string;
}

interface FakeEmail {
	binding: SendEmail;
	sent: SentMessage[];
}

/**
 * A stand-in for the `send_email` binding, which is `remote: true` and would
 * deliver real mail. What it records is the contract under test: the From the
 * route actually put on the wire, as opposed to the one it stored.
 */
function fakeEmail(): FakeEmail {
	const sent: SentMessage[] = [];
	const binding = {
		async send(message: unknown) {
			const envelope = message as SentMessage;
			sent.push({ from: envelope.from, to: envelope.to, raw: await rawOf(message) });
			return { messageId: `fake-${sent.length}` };
		},
	};
	return { binding: binding as unknown as SendEmail, sent };
}

/**
 * The raw body of an `EmailMessage`, when there is one. The SPA routes hand
 * the binding a structured message with no raw body; the submission route
 * hands it bytes, and those bytes are half of what this file asserts.
 */
async function rawOf(message: unknown): Promise<string | undefined> {
	const record = message as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!key.toLowerCase().includes("raw")) continue;
		const value = record[key];
		if (typeof value === "string") return value;
		if (value instanceof ReadableStream) {
			return new TextDecoder().decode(
				new Uint8Array(
					await new Response(value as ReadableStream<Uint8Array>).arrayBuffer(),
				),
			);
		}
	}
	return undefined;
}

function fromAddressOf(message: SentMessage): string {
	return typeof message.from === "string" ? message.from : message.from.email;
}

function appEnv(email: FakeEmail): Env {
	return { ...testEnv, EMAIL: email.binding };
}

async function appFetch(
	email: FakeEmail,
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await app.fetch(
		new Request(`https://inbox.test${path}`, init),
		appEnv(email),
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return res;
}

const imapApp = new Hono<{ Bindings: ImapApiEnv }>().route(IMAP_API_BASE, imapApi);

function imapEnv(email: FakeEmail): ImapApiEnv {
	return {
		BUCKET: env.BUCKET,
		EMAIL: email.binding,
		EMAIL_ADDRESSES: env.EMAIL_ADDRESSES,
		MAILBOX: env.MAILBOX,
		IMAP_AUTH_RATE_LIMIT: env.IMAP_AUTH_RATE_LIMIT,
	};
}

// ── Inbound fixtures ──────────────────────────────────────────────────

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
			`From: ${OUTSIDER}`,
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

type Delivery = Awaited<ReturnType<typeof receiveEmail>>;

/** Deliver one message, with an optional SMTP envelope recipient. */
async function deliver(
	headerTo: string,
	subject: string,
	envelopeTo?: string,
): Promise<Delivery> {
	const bytes = rawEmailBytes(headerTo, subject);
	const ctx = createExecutionContext();
	const result = await receiveEmail(
		{ raw: streamFromBytes(bytes), rawSize: bytes.byteLength, to: envelopeTo },
		testEnv,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return result;
}

async function inboxSubjects(mailboxId: string): Promise<string[]> {
	const emails = await mailbox(mailboxId).getEmails({ folder: "inbox" });
	return emails.map((e) => e.subject ?? "");
}

async function deliveredTo(mailboxId: string): Promise<(string | null)[]> {
	const rows = await query<{ delivered_to: string | null }>(
		mailbox(mailboxId),
		`SELECT delivered_to FROM emails WHERE folder_id = ? ORDER BY uid`,
		Folders.INBOX,
	);
	return rows.map((r) => r.delivered_to);
}

// ── Inbound delivery ──────────────────────────────────────────────────

describe("inbound delivery through a domain wildcard", () => {
	beforeEach(async () => {
		expect((await createAlias(testEnv, WILDCARD, OWNER)).ok).toBe(true);
	});

	it("delivers on a domain with no record of its own", async () => {
		expect(await deliver(COVERED_NET, "Wildcard one", COVERED_NET)).toMatchObject({
			status: "delivered",
			mailboxId: OWNER,
		});

		expect(await inboxSubjects(OWNER)).toEqual(["Wildcard one"]);
	});

	it("records the full address it arrived at, never the wildcard", async () => {
		await deliver(COVERED_NET, "Wildcard one", COVERED_NET);

		// Everything downstream — the reply From, the re-resolution at send
		// time — needs an address it can actually send mail to. `brian@` is a
		// rule, not an address.
		expect(await deliveredTo(OWNER)).toEqual([COVERED_NET]);
	});

	it("covers two different domains from the one record", async () => {
		await deliver(COVERED_COM, "On com", COVERED_COM);
		await deliver(COVERED_NET, "On net", COVERED_NET);

		// The listing is newest-first; `delivered_to` below is uid order, which
		// is arrival order, and is the assertion that actually matters here.
		expect([...(await inboxSubjects(OWNER))].sort()).toEqual(["On com", "On net"]);
		expect(await deliveredTo(OWNER)).toEqual([COVERED_COM, COVERED_NET]);
	});

	it("loses to an exact alias, which keeps its own mailbox", async () => {
		expect((await createAlias(testEnv, COVERED_COM, EXACT_OWNER)).ok).toBe(true);

		await deliver(COVERED_COM, "Exact wins", COVERED_COM);
		await deliver(COVERED_NET, "Wildcard still covers net", COVERED_NET);

		// Not just "the wildcard did not win" — the exact alias's own mailbox
		// got it. A wildcard that swallowed this would look identical from the
		// wildcard owner's inbox alone.
		expect(await inboxSubjects(EXACT_OWNER)).toEqual(["Exact wins"]);
		expect(await inboxSubjects(OWNER)).toEqual(["Wildcard still covers net"]);
	});

	it("loses to a real mailbox at the address", async () => {
		await env.BUCKET.put(`mailboxes/${RIVAL}.json`, JSON.stringify({ fromName: "Rival" }));

		await deliver(COVERED_NET, "Mailbox wins", COVERED_NET);

		expect(await inboxSubjects(RIVAL)).toEqual(["Mailbox wins"]);
		expect(await inboxSubjects(OWNER)).toEqual([]);
	});

	it("stops being a delivery target when its mailbox is deleted", async () => {
		await env.BUCKET.delete(`mailboxes/${OWNER}.json`);

		expect(await deliver(COVERED_NET, "Orphaned", COVERED_NET)).toMatchObject({
			status: "rejected",
		});
	});

	it("still refuses an address it does not cover (DEV-700)", async () => {
		// The wildcard is live and this message is on a covered domain. Only
		// the local part differs, which is the whole of what a wildcard keys
		// on — so a resolver that had gone greedy would accept this.
		expect(await deliver("nobody@example.net", "Unknown", "nobody@example.net")).toMatchObject({
			status: "rejected",
		});
		expect(await inboxSubjects(OWNER)).toEqual([]);
	});
});

describe("a wildcard matches the envelope recipient and nothing else", () => {
	beforeEach(async () => {
		expect((await createAlias(testEnv, WILDCARD, OWNER)).ok).toBe(true);
	});

	it("delivers when the covered address is the envelope recipient", async () => {
		// Cloudflare routed this copy here, and it only routes domains the
		// account owns. That is the whole of the wildcard's authority.
		expect(
			await deliver(OUTSIDER, "Envelope candidate", COVERED_NET),
		).toMatchObject({ status: "delivered", mailboxId: OWNER });
		expect(await deliveredTo(OWNER)).toEqual([COVERED_NET]);
	});

	it("refuses a covered address named only in the To header", async () => {
		// The security case. The To header is written by the sender, so a
		// wildcard matching it would let a stranger park any address of their
		// choosing in `delivered_to`, one reply away from being a From address.
		// This one is even on a domain the deployment really does own — the
		// rule is about where the address came from, not which domain it is on.
		expect(
			await deliver(COVERED_NET, "Header candidate", UNROUTED),
		).toMatchObject({ status: "rejected" });
		expect(await inboxSubjects(OWNER)).toEqual([]);
	});

	it("refuses a local part the sender pointed at a domain we never see", async () => {
		expect(await deliver(FORGED, "Forged header", UNROUTED)).toMatchObject({
			status: "rejected",
		});
		expect(await inboxSubjects(OWNER)).toEqual([]);
	});

	it("matches nothing at all when there is no envelope recipient", async () => {
		// `event.to` is optional, so this is reachable. No envelope, no
		// wildcard: the fail-closed direction.
		expect(await deliver(COVERED_NET, "No envelope")).toMatchObject({
			status: "rejected",
		});
		expect(await inboxSubjects(OWNER)).toEqual([]);
	});

	// The three below are the other half of the pair. Without them every
	// rejection above would also pass in an implementation that ignored header
	// candidates altogether, which would be a different (and wrong) change.

	it("still delivers a real mailbox named only in the To header", async () => {
		expect(await deliver(OWNER, "Mailbox from header", UNROUTED)).toMatchObject({
			status: "delivered",
			mailboxId: OWNER,
		});
	});

	it("still delivers an exact alias named only in the To header", async () => {
		// An exact record is something the operator wrote down about one
		// address, so a sender naming it asserts nothing new.
		const exact = "press@example.net";
		expect((await createAlias(testEnv, exact, EXACT_OWNER)).ok).toBe(true);

		expect(await deliver(exact, "Exact from header", UNROUTED)).toMatchObject({
			status: "delivered",
			mailboxId: EXACT_OWNER,
		});
		expect(await deliveredTo(EXACT_OWNER)).toEqual([exact]);
	});

	it("lets a wildcard on the envelope beat an exact alias in the header", async () => {
		// Order across candidates, which the narrowing must not have inverted:
		// the envelope is the address this copy was routed to, the header is a
		// list of everyone.
		expect((await createAlias(testEnv, COVERED_COM, EXACT_OWNER)).ok).toBe(true);

		expect(await deliver(COVERED_COM, "Envelope leads", COVERED_NET)).toMatchObject({
			status: "delivered",
			mailboxId: OWNER,
		});
		expect(await inboxSubjects(EXACT_OWNER)).toEqual([]);
	});

	it("draws the same line one level down, in the resolver itself", async () => {
		// `readDeliveryAlias` fails closed: a caller that has not said where
		// the address came from gets exact-only behaviour.
		expect(await readDeliveryAlias(testEnv, COVERED_NET)).toBeNull();
		expect(
			(await readDeliveryAlias(testEnv, COVERED_NET, { allowWildcard: true }))?.via,
		).toBe("wildcard");
		// Including for an address on a domain nothing routes here: proving the
		// domain is ours is the *caller's* job, and `resolveInboundDelivery`
		// only ever says yes for the envelope recipient.
		expect(
			(await readDeliveryAlias(testEnv, FORGED, { allowWildcard: true }))?.via,
		).toBe("wildcard");

		expect(
			await resolveInboundDelivery(testEnv, [
				{ address: COVERED_NET, source: "header" },
			]),
		).toBeNull();
		expect(
			await resolveInboundDelivery(testEnv, [
				{ address: COVERED_NET, source: "envelope" },
			]),
		).toEqual({ mailboxId: OWNER, deliveredTo: COVERED_NET });
	});
});

// ── Send-as: the web reply and forward routes ─────────────────────────

interface ReplyBody {
	to: string;
	subject: string;
	html: string;
	from?: string | { email: string; name: string };
	from_name?: string;
}

async function seedInbound(
	id: string,
	delivered: string | null,
): Promise<void> {
	await ownerStub.createEmail(
		Folders.INBOX,
		{
			id,
			subject: "Question about pricing",
			sender: OUTSIDER,
			recipient: delivered ?? OWNER,
			date: "2026-08-01T00:00:00Z",
			body: "<p>Hello.</p>",
			message_id: `${id}@somewhere-else.example`,
			thread_id: `${id}@somewhere-else.example`,
			...(delivered === null ? {} : { delivered_to: delivered }),
		},
		[],
	);
}

async function respond(
	email: FakeEmail,
	emailId: string,
	route: "reply" | "forward" = "reply",
	body: Partial<ReplyBody> = {},
): Promise<Response> {
	return appFetch(email, `/api/v1/mailboxes/${OWNER}/emails/${emailId}/${route}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			to: OUTSIDER,
			subject: "Re: Question about pricing",
			html: "<p>Sure.</p>",
			...body,
		}),
	});
}

describe("send-as on the SPA reply and forward routes", () => {
	beforeEach(async () => {
		expect((await createAlias(testEnv, WILDCARD, OWNER)).ok).toBe(true);
	});

	it("replies as the full address the message was delivered to", async () => {
		await seedInbound("wild-1", COVERED_NET);
		const email = fakeEmail();

		const res = await respond(email, "wild-1");

		expect(res.status).toBe(202);
		expect(email.sent).toHaveLength(1);
		expect(fromAddressOf(email.sent[0])).toBe(COVERED_NET);
	});

	it("forwards as the full address too", async () => {
		await seedInbound("wild-2", COVERED_COM);
		const email = fakeEmail();

		const res = await respond(email, "wild-2", "forward");

		expect(res.status).toBe(202);
		expect(fromAddressOf(email.sent[0])).toBe(COVERED_COM);
	});

	it("carries the wildcard's display name onto the send", async () => {
		expect(
			(await createAlias(testEnv, WILDCARD, OWNER, { allowRepoint: true, name: "Brian" })).ok,
		).toBe(true);
		await seedInbound("wild-3", COVERED_NET);
		const email = fakeEmail();

		await respond(email, "wild-3");

		expect(email.sent[0].from).toEqual({ email: COVERED_NET, name: "Brian" });
	});

	// ── The security half ──

	it("falls back to the mailbox when the parent knows no delivery address", async () => {
		// NULL `delivered_to`: every row written before migration 11, and every
		// outbound row. No evidence, so no wildcard send-as.
		await seedInbound("wild-4", null);
		const email = fakeEmail();

		await respond(email, "wild-4");

		expect(fromAddressOf(email.sent[0])).toBe(OWNER);
	});

	it("composes as the mailbox, never as a covered address", async () => {
		const email = fakeEmail();

		const res = await appFetch(email, `/api/v1/mailboxes/${OWNER}/emails`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ to: OUTSIDER, subject: "Hello", html: "<p>Hi.</p>" }),
		});

		expect(res.status).toBe(202);
		expect(fromAddressOf(email.sent[0])).toBe(OWNER);
	});

	it("refuses a covered address the caller asks for outright", async () => {
		// Nothing was delivered anywhere. A wildcard read as "may send as
		// brian@anything" would accept this.
		await seedInbound("wild-5", null);
		const email = fakeEmail();

		const res = await respond(email, "wild-5", "reply", { from: COVERED_NET });

		expect(res.status).toBe(400);
		expect(email.sent).toHaveLength(0);
	});
});

// ── Send-as: the SMTP submission path ─────────────────────────────────

const ORIGINAL_MSG_ID = "original-1@somewhere-else.example";

function rawReply(from: string, withParent = true): string {
	const headers = [
		`From: ${from}`,
		`To: ${OUTSIDER}`,
		"Subject: Re: Question about pricing",
		"Date: Wed, 12 Mar 2026 09:14:00 +0000",
		"Message-ID: <phone-reply-1@example.com>",
	];
	if (withParent) headers.push(`In-Reply-To: <${ORIGINAL_MSG_ID}>`);
	headers.push("MIME-Version: 1.0");
	headers.push('Content-Type: text/plain; charset="utf-8"');
	return `${headers.join("\r\n")}\r\n\r\nSure, happy to help.\r\n`;
}

async function seedSubmitParent(delivered: string | null): Promise<void> {
	await ownerStub.createEmail(
		Folders.INBOX,
		{
			id: "original-1",
			subject: "Question about pricing",
			sender: OUTSIDER,
			recipient: delivered ?? OWNER,
			date: "2026-08-01T00:00:00Z",
			body: "<p>Hello.</p>",
			message_id: ORIGINAL_MSG_ID,
			thread_id: ORIGINAL_MSG_ID,
			...(delivered === null ? {} : { delivered_to: delivered }),
		},
		[],
	);
}

async function submit(email: FakeEmail, body: string): Promise<Response> {
	const search = new URLSearchParams({ envelopeFrom: OWNER, envelopeTo: OUTSIDER });
	return imapApp.request(
		`${IMAP_API_BASE}/${OWNER}/submit?${search.toString()}`,
		{ method: "POST", headers: { "content-type": "message/rfc822" }, body },
		imapEnv(email),
	);
}

/** The `From:` header line of a raw message. */
function fromLine(raw: string): string {
	const line = raw.split("\r\n").find((l) => l.toLowerCase().startsWith("from:"));
	if (line === undefined) throw new Error("message has no From header");
	return line;
}

describe("send-as on the SMTP submission path", () => {
	beforeEach(async () => {
		expect((await createAlias(testEnv, WILDCARD, OWNER)).ok).toBe(true);
	});

	it("rewrites a default-From reply to the delivered address", async () => {
		await seedSubmitParent(COVERED_NET);
		const email = fakeEmail();

		const res = await submit(email, rawReply(OWNER));

		expect(res.status).toBe(200);
		expect(email.sent).toHaveLength(1);
		// Header and envelope together, or the message is inconsistent: a
		// mismatched envelope sender is what DMARC alignment is checked on.
		expect(fromLine(email.sent[0].raw ?? "")).toBe(`From: ${COVERED_NET}`);
		expect(email.sent[0].from).toBe(COVERED_NET);
	});

	it("leaves the bytes alone when the parent knows no delivery address", async () => {
		await seedSubmitParent(null);
		const email = fakeEmail();

		expect((await submit(email, rawReply(OWNER))).status).toBe(200);
		expect(fromLine(email.sent[0].raw ?? "")).toBe(`From: ${OWNER}`);
		expect(email.sent[0].from).toBe(OWNER);
	});

	it("leaves a fresh compose alone — no parent, no evidence", async () => {
		await seedSubmitParent(COVERED_NET);
		const email = fakeEmail();

		expect((await submit(email, rawReply(OWNER, false))).status).toBe(200);
		expect(fromLine(email.sent[0].raw ?? "")).toBe(`From: ${OWNER}`);
	});

	it("refuses a From the client set to a covered address itself", async () => {
		// Deliberately narrow: at the moment this check runs there is no
		// delivery evidence, only a header the client typed.
		await seedSubmitParent(COVERED_NET);
		const email = fakeEmail();

		const res = await submit(email, rawReply(COVERED_NET));

		expect(res.status).toBe(403);
		expect(email.sent).toHaveLength(0);
	});
});

// ── A wildcard is not a send-as permission on its own ─────────────────

describe("a wildcard grants nothing without delivery evidence", () => {
	beforeEach(async () => {
		expect((await createAlias(testEnv, WILDCARD, OWNER)).ok).toBe(true);
	});

	it("is invisible to the exact lookup the sender check uses", async () => {
		// `resolveAlias` is what decides whether a From address may be spoofed.
		// If a wildcard answered here it would mean "brian@ on any domain".
		expect(await resolveAlias(testEnv, COVERED_NET)).toBeNull();
		expect(await resolveAlias(testEnv, FORGED)).toBeNull();
	});

	it("does not let the mailbox validate a covered address as its sender", async () => {
		await expect(
			validateSenderWithAliases(testEnv, OUTSIDER, COVERED_NET, OWNER),
		).rejects.toBeInstanceOf(SenderValidationError);
	});

	it("resolves send-as from nothing at all to the mailbox address", async () => {
		for (const evidence of [null, undefined, ""]) {
			expect(await resolveSendAs(testEnv, OWNER, evidence)).toEqual({ address: OWNER });
		}
	});

	it("stops speaking for an address that has become a real mailbox", async () => {
		// The row was written while the wildcard covered this address; the
		// mailbox was created afterwards. Inbound precedence already gives the
		// address to the mailbox, and send-as has to agree or the wildcard's
		// owner keeps a spoof of somebody else's mailbox.
		expect(await resolveSendAs(testEnv, OWNER, COVERED_NET)).toEqual({
			address: COVERED_NET,
		});

		await env.BUCKET.put(`mailboxes/${RIVAL}.json`, JSON.stringify({ fromName: "Rival" }));

		expect(await resolveSendAs(testEnv, OWNER, COVERED_NET)).toEqual({ address: OWNER });
	});

	it("does not lend itself to a mailbox that does not own it", async () => {
		expect(await resolveSendAs(testEnv, EXACT_OWNER, COVERED_NET)).toEqual({
			address: EXACT_OWNER,
		});
	});

	it("stops resolving once it is deleted", async () => {
		expect(await deleteAlias(testEnv, WILDCARD, OWNER)).toBe(true);
		expect(await resolveSendAs(testEnv, OWNER, COVERED_NET)).toEqual({ address: OWNER });
	});
});

// ── The record itself ─────────────────────────────────────────────────

describe("wildcard records", () => {
	it("lists alongside exact aliases, telling itself apart by its spelling", async () => {
		await createAlias(testEnv, WILDCARD, OWNER);
		await createAlias(testEnv, "info@example.com", OWNER);
		await createAlias(testEnv, "press@", EXACT_OWNER);

		const listed = await listAliases(testEnv, OWNER);

		expect(listed.map((a) => a.address)).toEqual([WILDCARD, "info@example.com"]);
		// A trailing `@` and nothing after it is the whole test, and no real
		// address can produce it.
		expect(listed.filter((a) => a.address.endsWith("@")).map((a) => a.address)).toEqual([
			WILDCARD,
		]);
	});

	it("lists a named wildcard, which is the one state that reopens the object", async () => {
		// `listAliases` answers from R2 customMetadata except when a display
		// name is actually set, and only then re-reads the JSON body by key —
		// the one path where a wildcard key has to survive `readAlias`'s
		// validation rather than the listing's own parsing.
		await createAlias(testEnv, WILDCARD, OWNER, { name: "Brian" });

		expect(await listAliases(testEnv, OWNER)).toEqual([
			{
				address: WILDCARD,
				mailbox: OWNER,
				createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
				name: "Brian",
			},
		]);
	});

	it("refuses a second wildcard on the same local part", async () => {
		expect((await createAlias(testEnv, WILDCARD, OWNER)).ok).toBe(true);

		const stolen = await createAlias(testEnv, WILDCARD, EXACT_OWNER);

		expect(stolen).toMatchObject({ ok: false, reason: "alias-exists" });
		expect(
			(await readDeliveryAlias(testEnv, COVERED_NET, { allowWildcard: true }))?.record
				.mailbox,
		).toBe(OWNER);
	});

	it("does not collide with an exact alias on the same local part", async () => {
		expect((await createAlias(testEnv, WILDCARD, OWNER)).ok).toBe(true);
		// Either order: neither refuses the other, because they are not the
		// same record and precedence already says which one answers.
		expect((await createAlias(testEnv, COVERED_COM, EXACT_OWNER)).ok).toBe(true);

		// The exact record answers even with the wildcard switched off, which
		// is what "most specific wins" means one level down.
		expect((await readDeliveryAlias(testEnv, COVERED_COM))?.via).toBe("exact");
		expect(
			(await readDeliveryAlias(testEnv, COVERED_NET, { allowWildcard: true }))?.via,
		).toBe("wildcard");
	});

	it("cannot be removed by a mailbox that does not own it", async () => {
		await createAlias(testEnv, WILDCARD, OWNER);

		expect(await deleteAlias(testEnv, WILDCARD, EXACT_OWNER)).toBe(false);
		expect(
			(await readDeliveryAlias(testEnv, COVERED_NET, { allowWildcard: true }))?.record
				.mailbox,
		).toBe(OWNER);
	});

	it("needs a mailbox to point at, like any other alias", async () => {
		expect(await createAlias(testEnv, WILDCARD, "ghost@example.com")).toMatchObject({
			ok: false,
			reason: "no-such-mailbox",
		});
	});

	it("is created by a deployment that declares no domains at all", async () => {
		// `DOMAINS` used to gate this, and the deployed value is a placeholder
		// left behind by a public-repo sanitisation — which would have made
		// every wildcard silently refuse. Nothing reads it now, so the binding
		// is not even in `AliasEnv`.
		const unconfigured: AliasEnv = {
			BUCKET: env.BUCKET,
			EMAIL_ADDRESSES: env.EMAIL_ADDRESSES,
		};

		expect((await createAlias(unconfigured, WILDCARD, OWNER)).ok).toBe(true);
		expect((await listAliases(unconfigured, OWNER)).map((a) => a.address)).toEqual([
			WILDCARD,
		]);
	});

	it("honours a non-empty EMAIL_ADDRESSES through the addresses it would cover", async () => {
		const restricted = {
			...testEnv,
			EMAIL_ADDRESSES: [OWNER, COVERED_NET] as unknown as Env["EMAIL_ADDRESSES"],
		};

		// `brian@` covers brian@example.net, which is on the list.
		expect((await createAlias(restricted, WILDCARD, OWNER)).ok).toBe(true);
		// `sales@` covers nothing on it, so it could never receive a message —
		// `receiveEmail` filters recipients against the same list first.
		expect(await createAlias(restricted, "sales@", OWNER)).toMatchObject({
			ok: false,
			reason: "not-allowed",
		});
	});
});

// ── Local-part validation ─────────────────────────────────────────────

describe("local-part validation", () => {
	const accepted = ["brian", "b", "info-desk", "first.last", "a_b", "x+y", "n1"];
	const refused = [
		"", // empty
		"bri an", // whitespace
		"bri\tan",
		"bri an", // control character
		"bri@an", // would make the key ambiguous with an address
		"a/b", // path separator
		"a\\b",
		".", // traversal
		"..",
		"...",
		".brian", // leading dot
		"brian.", // trailing dot
		"bri..an", // consecutive dots
		"a".repeat(ALIAS_LOCAL_PART_MAX_CHARS + 1), // over-long
	];

	it("accepts ordinary local parts", () => {
		for (const value of accepted) {
			expect(isPlausibleLocalPart(value), value).toBe(true);
		}
		expect(isPlausibleLocalPart("a".repeat(ALIAS_LOCAL_PART_MAX_CHARS))).toBe(true);
	});

	it("refuses anything that could escape or traverse the key namespace", () => {
		for (const value of refused) {
			expect(isPlausibleLocalPart(value), JSON.stringify(value)).toBe(false);
		}
	});

	it("refuses the same values as a wildcard, so nothing is ever written", async () => {
		for (const value of refused) {
			expect(await createAlias(testEnv, `${value}@`, OWNER), value).toMatchObject({
				ok: false,
				reason: "invalid",
			});
		}
		expect(await listAliases(testEnv, OWNER)).toEqual([]);
	});
});

// ── The HTTP surface ──────────────────────────────────────────────────

describe("the alias API", () => {
	async function post(body: unknown): Promise<Response> {
		return appFetch(fakeEmail(), `/api/v1/mailboxes/${OWNER}/aliases`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("creates a wildcard and hands the record back", async () => {
		const res = await post({ address: WILDCARD, name: "Brian" });

		expect(res.status).toBe(201);
		expect(await res.json()).toMatchObject({
			address: WILDCARD,
			mailbox: OWNER,
			name: "Brian",
		});
	});

	it("normalises case and whitespace like any other address", async () => {
		const res = await post({ address: "  Brian@  " });

		expect(res.status).toBe(201);
		expect(await res.json()).toMatchObject({ address: WILDCARD });
	});

	it("still refuses a bare token with no @ at all", async () => {
		// A typo must not quietly become a catch-all.
		for (const address of ["brian", "not-an-address", "brian@@", "@", "@example.com"]) {
			expect((await post({ address })).status, address).toBe(400);
		}
		expect(await listAliases(testEnv, OWNER)).toEqual([]);
	});

	it("renames and removes a wildcard through the same routes", async () => {
		expect((await post({ address: WILDCARD })).status).toBe(201);
		const path = `/api/v1/mailboxes/${OWNER}/aliases/${encodeURIComponent(WILDCARD)}`;

		const renamed = await appFetch(fakeEmail(), path, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "Brian" }),
		});
		expect(renamed.status).toBe(200);
		expect(await renamed.json()).toMatchObject({ address: WILDCARD, name: "Brian" });

		expect((await appFetch(fakeEmail(), path, { method: "DELETE" })).status).toBe(204);
		expect(await listAliases(testEnv, OWNER)).toEqual([]);
	});
});
