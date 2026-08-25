// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-alias display names.
 *
 * Automatic send-as already picks the right *address*: a reply to something
 * that arrived at `info@` goes back out as `info@`. What it inherited was the
 * sending client's display name, so a role address went out as
 * `Brian Crumrine <info@example.com>` — a personal name on an address that is
 * not a person. This file pins the setting that fixes it, and the three things
 * that make it risky:
 *
 * 1. **Three states, not two.** "No name configured", "configured blank" and
 *    "configured to a name" are different settings. Not-configured has to keep
 *    behaving exactly as it did before this existed, because that is what every
 *    alias already in a deployment has; blank has to actually strip the name,
 *    including the `from_name` the SPA sends. Both are asserted on emitted
 *    bytes, on both send paths.
 *
 * 2. **A display name is free text that lands in a header.** Quoting (RFC 5322)
 *    and encoding (RFC 2047) come from the one encoder in raw-mime.ts, and a
 *    CR/LF in a name is a header-injection attempt: it would end the header and
 *    let the rest become attacker-chosen headers and a body. That is refused at
 *    the API boundary *and* neutralised at the point of use, and the emitted
 *    octets are what is asserted — the folding helper in that module was once
 *    found to re-open exactly this hole.
 *
 * 3. **The submission path's bytes are the client's bytes.** Replacing the
 *    display name replaces the whole `From:` value rather than one span, so the
 *    diff is asserted line by line: the `From:` line changes, `Message-ID:`
 *    does not, and nothing else moves.
 *
 * Both send paths are exercised for every case. This feature has a history of
 * being reported done while only one surface actually had it.
 */

import {
	createExecutionContext,
	env,
	waitOnExecutionContext,
} from "cloudflare:test";
import { Hono } from "hono";
import PostalMime from "postal-mime";
import { beforeEach, describe, expect, it } from "vitest";

import { Folders } from "../shared/folders";
import {
	ALIAS_NAME_MAX_CHARS,
	aliasKey,
	createAlias,
	listAliases,
	readAlias,
	setAliasName,
} from "../workers/lib/aliases";
import { formatFromMailbox, rewriteFromAddress } from "../workers/lib/raw-mime";
import { app } from "../workers/index";
import {
	IMAP_API_BASE,
	type ImapApiEnv,
	imapApi,
} from "../workers/routes/imap-api";
import type { Env } from "../workers/types";
import { type MailboxStub, mailbox, query } from "./helpers";

/**
 * Fixed names for the whole file, not one per test: `test/setup.ts`'s afterEach
 * walks every MailboxDO id ever named and wipes it, so minting a mailbox per
 * test is quadratic in teardown. Storage and R2 are wiped between tests, so
 * each one still gets a freshly migrated DO and an empty registry.
 */
const OWNER = "owner@example.com";
const OTHER = "other@example.com";
const ALIAS = "info@example.com";
const OUTSIDER = "outsider@somewhere-else.example";

/** The Message-ID of the inbound message every reply here answers. */
const ORIGINAL_MSG_ID = "original-1@somewhere-else.example";

const testEnv = env as unknown as Env;

let ownerStub: MailboxStub;

beforeEach(async () => {
	for (const id of [OWNER, OTHER]) {
		await env.BUCKET.put(`mailboxes/${id}.json`, JSON.stringify({ fromName: "Test" }));
	}
	ownerStub = mailbox(OWNER);
	await ownerStub.getFolders();
});

// ── Fake upstream ─────────────────────────────────────────────────────

interface SentMessage {
	from: string | { email: string; name: string };
	to: string | string[];
	/** Present only for the raw submission path. */
	raw?: string;
}

interface FakeEmail {
	binding: SendEmail;
	sent: SentMessage[];
}

/**
 * A stand-in for the `send_email` binding, which is `remote: true` and would
 * deliver real mail. Records both the structured form the SPA paths hand it
 * and the raw form the submission path does.
 */
function fakeEmail(): FakeEmail {
	const sent: SentMessage[] = [];
	const binding = {
		async send(message: unknown) {
			const record = message as SentMessage;
			const raw = await rawOf(message);
			sent.push({ from: record.from, to: record.to, ...(raw === null ? {} : { raw }) });
			return { messageId: `upstream-${sent.length}` };
		},
	};
	return { binding: binding as unknown as SendEmail, sent };
}

/**
 * The raw body off an `EmailMessage`, or null when the message is the
 * structured kind. workerd does not promise the property name, so this looks
 * rather than assumes.
 */
async function rawOf(message: unknown): Promise<string | null> {
	const record = message as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!key.toLowerCase().includes("raw")) continue;
		const value = record[key];
		if (typeof value === "string") return value;
		if (value instanceof ReadableStream) {
			return new TextDecoder().decode(
				new Uint8Array(await new Response(value as ReadableStream<Uint8Array>).arrayBuffer()),
			);
		}
	}
	return null;
}

// ── Harnesses ─────────────────────────────────────────────────────────

async function appFetch(
	email: FakeEmail,
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await app.fetch(
		new Request(`https://inbox.test${path}`, init),
		{ ...testEnv, EMAIL: email.binding },
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
		DOMAINS: env.DOMAINS,
		EMAIL_ADDRESSES: env.EMAIL_ADDRESSES,
		MAILBOX: env.MAILBOX,
		IMAP_AUTH_RATE_LIMIT: env.IMAP_AUTH_RATE_LIMIT,
	};
}

// ── Fixtures ──────────────────────────────────────────────────────────

/** The inbound message a reply answers, and the address it arrived at. */
async function seedOriginal(deliveredTo: string | null): Promise<void> {
	await ownerStub.createEmail(
		Folders.INBOX,
		{
			id: "original-1",
			subject: "Question about pricing",
			sender: OUTSIDER,
			recipient: deliveredTo ?? OWNER,
			date: "2026-08-01T00:00:00Z",
			body: "<p>Hello.</p>",
			message_id: ORIGINAL_MSG_ID,
			thread_id: ORIGINAL_MSG_ID,
			...(deliveredTo === null ? {} : { delivered_to: deliveredTo }),
		},
		[],
	);
}

/** Create the alias with a display name in a given state, and seed a reply. */
async function withAlias(name: string | undefined): Promise<void> {
	const created = await createAlias(testEnv, ALIAS, OWNER, {
		...(name === undefined ? {} : { name }),
	});
	expect(created.ok).toBe(true);
	await seedOriginal(ALIAS);
}

interface ReplyBody {
	from_name?: string;
	from?: string | { email: string; name: string };
}

/** POST the SPA reply (or forward) route. */
async function reply(
	email: FakeEmail,
	body: ReplyBody = {},
	route: "reply" | "forward" = "reply",
): Promise<Response> {
	return appFetch(email, `/api/v1/mailboxes/${OWNER}/emails/original-1/${route}`, {
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

/**
 * The bytes the SPA path stored for its Sent copy.
 *
 * These are the emitted octets for that path. Cloudflare's `send_email`
 * binding builds the wire MIME from the structured fields itself and we never
 * see those bytes, so the stored `.eml` — built by the same `buildRawMime`
 * from the same `from` value — is what a header assertion can stand on.
 */
async function sentRawMime(): Promise<string> {
	const rows = await query<{ raw_key: string | null }>(
		ownerStub,
		`SELECT raw_key FROM emails WHERE folder_id = ? ORDER BY uid`,
		Folders.SENT,
	);
	expect(rows).toHaveLength(1);
	const stored = await env.BUCKET.get(rows[0].raw_key as string);
	expect(stored).not.toBeNull();
	return (stored as R2ObjectBody).text();
}

interface RawOptions {
	/** The full `From:` header value, display name and all. */
	from?: string;
	messageId?: string;
	extraHeaders?: string[];
}

/** A small, valid RFC 5322 reply, CRLF throughout, as a real client sends. */
function rawReply(options: RawOptions = {}): string {
	const headers = [
		`From: ${options.from ?? OWNER}`,
		`To: ${OUTSIDER}`,
		"Subject: Re: Question about pricing",
		"Date: Wed, 12 Mar 2026 09:14:00 +0000",
		`Message-ID: <${options.messageId ?? "phone-reply-1@example.com"}>`,
		`In-Reply-To: <${ORIGINAL_MSG_ID}>`,
		`References: <${ORIGINAL_MSG_ID}>`,
		...(options.extraHeaders ?? []),
		"MIME-Version: 1.0",
		'Content-Type: text/plain; charset="utf-8"',
	];
	return `${headers.join("\r\n")}\r\n\r\nSure, happy to help.\r\n`;
}

/** Submit through the SMTP path and return the one message the fake saw. */
async function submitOk(email: FakeEmail, body: string): Promise<SentMessage> {
	const search = new URLSearchParams({ envelopeFrom: OWNER, envelopeTo: OUTSIDER });
	const res = await imapApp.request(
		`${IMAP_API_BASE}/${OWNER}/submit?${search.toString()}`,
		{ method: "POST", headers: { "content-type": "message/rfc822" }, body },
		imapEnv(email),
	);
	expect(res.status).toBe(200);
	expect(email.sent).toHaveLength(1);
	return email.sent[0];
}

/** The `From:` header line of a raw message. */
function fromLine(raw: string): string {
	const line = raw.split("\r\n").find((l) => l.toLowerCase().startsWith("from:"));
	if (line === undefined) throw new Error("message has no From header");
	return line;
}

/** Parse a whole message and hand back the single mailbox in its From. */
async function parsedFrom(raw: string): Promise<{ name: string; address: string }> {
	const parsed = await PostalMime.parse(raw);
	const from = parsed.from;
	if (!from) throw new Error("message has no From header");
	return { name: from.name ?? "", address: from.address ?? "" };
}

// ── The registry: three states ────────────────────────────────────────

describe("an alias's display name has three distinguishable states", () => {
	it("is absent from the record and the stored JSON when never configured", async () => {
		expect((await createAlias(testEnv, ALIAS, OWNER)).ok).toBe(true);

		const record = await readAlias(testEnv, ALIAS);
		expect(record).not.toBeNull();
		// Not null, not "" — absent. Every alias that existed before this
		// feature looks exactly like this, which is what makes "unset" the
		// state that must change nothing.
		expect(record).not.toHaveProperty("name");

		const stored = await env.BUCKET.get(aliasKey(ALIAS));
		expect(await (stored as R2ObjectBody).json()).toEqual({
			mailbox: OWNER,
			createdAt: expect.any(String),
		});
	});

	it("round-trips a configured name", async () => {
		expect((await createAlias(testEnv, ALIAS, OWNER, { name: "Acme Info" })).ok).toBe(true);
		expect((await readAlias(testEnv, ALIAS))?.name).toBe("Acme Info");
	});

	it("round-trips a name configured as explicitly blank", async () => {
		expect((await createAlias(testEnv, ALIAS, OWNER, { name: "" })).ok).toBe(true);

		const record = await readAlias(testEnv, ALIAS);
		// The key is present holding "": that is the difference between "send a
		// bare address" and "say nothing about the display name".
		expect(record).toHaveProperty("name");
		expect(record?.name).toBe("");
	});

	it("reports all three states through listAliases", async () => {
		await createAlias(testEnv, "unset@example.com", OWNER);
		await createAlias(testEnv, "blank@example.com", OWNER, { name: "" });
		await createAlias(testEnv, "named@example.com", OWNER, { name: "Acme Info" });

		const listed = await listAliases(testEnv, OWNER);
		expect(listed.map((a) => a.address)).toEqual([
			"blank@example.com",
			"named@example.com",
			"unset@example.com",
		]);
		// The listing answers from R2 customMetadata where it can; the name
		// itself is never in that metadata, so "set" is the one state whose
		// content it has to open the object for.
		expect(listed.find((a) => a.address === "unset@example.com")).not.toHaveProperty("name");
		expect(listed.find((a) => a.address === "blank@example.com")?.name).toBe("");
		expect(listed.find((a) => a.address === "named@example.com")?.name).toBe("Acme Info");
	});

	it("does not list another mailbox's named alias", async () => {
		await createAlias(testEnv, ALIAS, OTHER, { name: "Someone Else" });
		expect(await listAliases(testEnv, OWNER)).toEqual([]);
	});
});

describe("setAliasName", () => {
	beforeEach(async () => {
		expect((await createAlias(testEnv, ALIAS, OWNER)).ok).toBe(true);
	});

	it("sets a name on an alias that already exists, without a re-point", async () => {
		const result = await setAliasName(testEnv, ALIAS, OWNER, "Acme Info");
		expect(result.ok).toBe(true);
		expect((await readAlias(testEnv, ALIAS))?.name).toBe("Acme Info");
	});

	it("keeps the mailbox and createdAt exactly as they were", async () => {
		const before = await readAlias(testEnv, ALIAS);
		await setAliasName(testEnv, ALIAS, OWNER, "Acme Info");
		const after = await readAlias(testEnv, ALIAS);

		// Naming an address must never move where its mail is delivered.
		expect(after?.mailbox).toBe(before?.mailbox);
		expect(after?.createdAt).toBe(before?.createdAt);
	});

	it("configures a blank name, which is not the same as clearing it", async () => {
		await setAliasName(testEnv, ALIAS, OWNER, "");
		expect(await readAlias(testEnv, ALIAS)).toHaveProperty("name", "");
	});

	it("clears back to not-configured with null", async () => {
		await setAliasName(testEnv, ALIAS, OWNER, "Acme Info");
		expect((await setAliasName(testEnv, ALIAS, OWNER, null)).ok).toBe(true);
		expect(await readAlias(testEnv, ALIAS)).not.toHaveProperty("name");
	});

	it("refuses to name an alias belonging to another mailbox", async () => {
		await createAlias(testEnv, "theirs@example.com", OTHER, { name: "Theirs" });
		const result = await setAliasName(testEnv, "theirs@example.com", OWNER, "Mine");

		expect(result).toMatchObject({ ok: false, reason: "no-such-alias" });
		expect((await readAlias(testEnv, "theirs@example.com"))?.name).toBe("Theirs");
	});

	it("refuses an alias that does not exist", async () => {
		expect(await setAliasName(testEnv, "nope@example.com", OWNER, "X")).toMatchObject({
			ok: false,
			reason: "no-such-alias",
		});
	});

	it("refuses a name carrying a control character, and stores nothing", async () => {
		for (const bad of ["A\rB", "A\nB", "A\r\nB", "A\r\nX-Injected: yes", "A\u0000B", "A\u0007B"]) {
			expect(await setAliasName(testEnv, ALIAS, OWNER, bad)).toMatchObject({
				ok: false,
				reason: "invalid-name",
			});
		}
		expect(await readAlias(testEnv, ALIAS)).not.toHaveProperty("name");
	});

	it("refuses a name past the length ceiling", async () => {
		expect(
			await setAliasName(testEnv, ALIAS, OWNER, "n".repeat(ALIAS_NAME_MAX_CHARS + 1)),
		).toMatchObject({ ok: false, reason: "invalid-name" });
		expect(
			await setAliasName(testEnv, ALIAS, OWNER, "n".repeat(ALIAS_NAME_MAX_CHARS)),
		).toMatchObject({ ok: true });
	});
});

describe("createAlias and the display name", () => {
	it("refuses a name with a line break at creation", async () => {
		const result = await createAlias(testEnv, ALIAS, OWNER, { name: "Bad\r\nX-Injected: yes" });
		expect(result).toMatchObject({ ok: false, reason: "invalid-name" });
		// Nothing written: a refused create must not leave a record behind.
		expect(await readAlias(testEnv, ALIAS)).toBeNull();
	});

	it("carries the name across a re-point rather than dropping it", async () => {
		await createAlias(testEnv, ALIAS, OWNER, { name: "Acme Info" });
		const repointed = await createAlias(testEnv, ALIAS, OTHER, { allowRepoint: true });

		expect(repointed.ok).toBe(true);
		expect((await readAlias(testEnv, ALIAS))?.name).toBe("Acme Info");
		expect((await readAlias(testEnv, ALIAS))?.mailbox).toBe(OTHER);
	});
});

// ── The API surface ───────────────────────────────────────────────────

describe("the alias API carries the display name", () => {
	const base = `/api/v1/mailboxes/${OWNER}/aliases`;
	const email = fakeEmail();

	async function patchName(address: string, body: unknown): Promise<Response> {
		return appFetch(email, `${base}/${encodeURIComponent(address)}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("accepts a name on create and hands it back", async () => {
		const res = await appFetch(email, base, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ address: ALIAS, name: "Acme Info" }),
		});
		expect(res.status).toBe(201);
		expect(await res.json()).toMatchObject({ address: ALIAS, name: "Acme Info" });
	});

	it("400s a name with a line break on create", async () => {
		const res = await appFetch(email, base, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ address: ALIAS, name: "Bad\r\nX-Injected: yes" }),
		});
		expect(res.status).toBe(400);
		expect(await readAlias(testEnv, ALIAS)).toBeNull();
	});

	it("PATCHes a name onto an existing alias without re-pointing it", async () => {
		await createAlias(testEnv, ALIAS, OWNER);
		const res = await patchName(ALIAS, { name: "Acme Info" });

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ address: ALIAS, mailbox: OWNER, name: "Acme Info" });
	});

	it("PATCHes a blank name and a cleared name as different things", async () => {
		await createAlias(testEnv, ALIAS, OWNER, { name: "Acme Info" });

		expect((await patchName(ALIAS, { name: "" })).status).toBe(200);
		expect(await readAlias(testEnv, ALIAS)).toHaveProperty("name", "");

		expect((await patchName(ALIAS, { name: null })).status).toBe(200);
		expect(await readAlias(testEnv, ALIAS)).not.toHaveProperty("name");
	});

	it("400s a PATCH that says nothing about the name", async () => {
		await createAlias(testEnv, ALIAS, OWNER);
		// Silently doing nothing here is how a settings page ends up appearing
		// to save a value it never sent.
		expect((await patchName(ALIAS, {})).status).toBe(400);
	});

	it("400s a PATCH carrying a line break", async () => {
		await createAlias(testEnv, ALIAS, OWNER);
		expect((await patchName(ALIAS, { name: "Bad\r\nX-Injected: yes" })).status).toBe(400);
		expect(await readAlias(testEnv, ALIAS)).not.toHaveProperty("name");
	});

	it("404s a PATCH for an alias this mailbox does not own", async () => {
		await createAlias(testEnv, ALIAS, OTHER, { name: "Theirs" });
		expect((await patchName(ALIAS, { name: "Mine" })).status).toBe(404);
		expect((await readAlias(testEnv, ALIAS))?.name).toBe("Theirs");
	});
});

// ── Send path one: the SPA reply and forward routes ───────────────────

describe("web reply/forward uses the alias's display name", () => {
	it("puts the configured name on the wire and in the stored bytes", async () => {
		await withAlias("Acme Info");

		const email = fakeEmail();
		expect((await reply(email)).status).toBe(202);

		expect(email.sent[0].from).toEqual({ email: ALIAS, name: "Acme Info" });
		expect(fromLine(await sentRawMime())).toBe(`From: Acme Info <${ALIAS}>`);
	});

	it("does the same on forward", async () => {
		await withAlias("Acme Info");

		const email = fakeEmail();
		expect((await reply(email, {}, "forward")).status).toBe(202);

		expect(email.sent[0].from).toEqual({ email: ALIAS, name: "Acme Info" });
		expect(fromLine(await sentRawMime())).toBe(`From: Acme Info <${ALIAS}>`);
	});

	it("sends a bare address when the name is configured blank", async () => {
		await withAlias("");

		// `from_name` is what the SPA always sends, filled from the mailbox
		// settings. A blank alias name has to beat it, or "no personal name on
		// this address" is not actually achievable from the settings page.
		const email = fakeEmail();
		expect((await reply(email, { from_name: "Test Owner" })).status).toBe(202);

		expect(email.sent[0].from).toBe(ALIAS);
		expect(fromLine(await sentRawMime())).toBe(`From: <${ALIAS}>`);
	});

	it("leaves the client's display name alone when nothing is configured", async () => {
		await withAlias(undefined);

		// The pre-existing behaviour, unchanged. This is what every alias in a
		// running deployment has.
		const email = fakeEmail();
		expect((await reply(email, { from_name: "Test Owner" })).status).toBe(202);

		expect(email.sent[0].from).toEqual({ email: ALIAS, name: "Test Owner" });
		expect(fromLine(await sentRawMime())).toBe(`From: Test Owner <${ALIAS}>`);
	});

	it("still honours a From the caller named explicitly", async () => {
		await withAlias("Acme Info");

		const email = fakeEmail();
		const named = { email: OWNER, name: "Test Owner" };
		expect((await reply(email, { from: named })).status).toBe(202);

		// Naming the address is the caller taking the decision; the alias's
		// name belongs to the address the caller did not pick.
		expect(email.sent[0].from).toEqual(named);
	});

	it("does not use a re-pointed alias's name, any more than its address", async () => {
		await withAlias("Acme Info");
		expect((await createAlias(testEnv, ALIAS, OTHER, { allowRepoint: true })).ok).toBe(true);

		const email = fakeEmail();
		expect((await reply(email, { from_name: "Test Owner" })).status).toBe(202);

		// The address falls back to the mailbox, so the name has to as well —
		// `Acme Info <owner@example.com>` would be the worst of both.
		expect(email.sent[0].from).toEqual({ email: OWNER, name: "Test Owner" });
	});

	it("quotes a name containing a comma so the From still parses as one address", async () => {
		await withAlias("Acme Info, Ltd");

		const email = fakeEmail();
		expect((await reply(email)).status).toBe(202);

		const raw = await sentRawMime();
		expect(fromLine(raw)).toBe(`From: "Acme Info, Ltd" <${ALIAS}>`);
		// The real assertion: a parser reads one mailbox out of it, not two.
		expect(await parsedFrom(raw)).toEqual({ name: "Acme Info, Ltd", address: ALIAS });
	});

	it("RFC 2047-encodes a non-ASCII name", async () => {
		await withAlias("Bjørn Ørsted");

		const email = fakeEmail();
		expect((await reply(email)).status).toBe(202);

		const raw = await sentRawMime();
		expect(fromLine(raw)).toContain("=?UTF-8?B?");
		expect(fromLine(raw)).not.toContain("Bjørn");
		expect(await parsedFrom(raw)).toEqual({ name: "Bjørn Ørsted", address: ALIAS });
	});

	it("escapes a name containing a quote rather than breaking out of one", async () => {
		await withAlias('Acme "Info" Desk');

		const email = fakeEmail();
		expect((await reply(email)).status).toBe(202);

		const raw = await sentRawMime();
		expect(fromLine(raw)).toBe(`From: "Acme \\"Info\\" Desk" <${ALIAS}>`);
		expect(await parsedFrom(raw)).toEqual({ name: 'Acme "Info" Desk', address: ALIAS });
	});

	it("neutralises a line break in a hand-written record instead of emitting it", async () => {
		// The API refuses such a name, so getting one stored takes writing the
		// R2 object directly — a hand-edited record, or a future code path with
		// a bug. Nothing downstream may take the stored string on trust.
		await createAlias(testEnv, ALIAS, OWNER);
		const record = await readAlias(testEnv, ALIAS);
		await env.BUCKET.put(
			aliasKey(ALIAS),
			JSON.stringify({
				mailbox: OWNER,
				createdAt: record?.createdAt,
				name: "Evil\r\nX-Injected: yes",
			}),
			{ customMetadata: { mailbox: OWNER, createdAt: record?.createdAt ?? "", nameState: "set" } },
		);
		await seedOriginal(ALIAS);

		const email = fakeEmail();
		expect((await reply(email, { from_name: "Test Owner" })).status).toBe(202);

		// The name is dropped as unusable and the send still happens as the
		// alias; what must not happen is the header appearing anywhere.
		const raw = await sentRawMime();
		expect(raw).not.toContain("X-Injected");
		expect(fromLine(raw)).toBe(`From: Test Owner <${ALIAS}>`);
		expect(email.sent[0].from).toEqual({ email: ALIAS, name: "Test Owner" });
	});
});

// ── Send path two: SMTP submission ────────────────────────────────────

describe("SMTP submission uses the alias's display name", () => {
	it("replaces the client's display name with the configured one", async () => {
		await withAlias("Acme Info");

		const email = fakeEmail();
		const sent = await submitOk(email, rawReply({ from: `Test Owner <${OWNER}>` }));

		// The whole point: iOS Mail only ever emits the account's own name.
		expect(fromLine(sent.raw as string)).toBe(`From: Acme Info <${ALIAS}>`);
		expect(sent.from).toBe(ALIAS);
	});

	it("sends a bare address when the name is configured blank", async () => {
		await withAlias("");

		const email = fakeEmail();
		const sent = await submitOk(email, rawReply({ from: `Test Owner <${OWNER}>` }));

		expect(fromLine(sent.raw as string)).toBe(`From: <${ALIAS}>`);
		expect(sent.from).toBe(ALIAS);
	});

	it("leaves the client's display name alone when nothing is configured", async () => {
		await withAlias(undefined);

		const email = fakeEmail();
		const sent = await submitOk(email, rawReply({ from: `Test Owner <${OWNER}>` }));

		// Today's behaviour, unchanged: only the addr-spec span moves.
		expect(fromLine(sent.raw as string)).toBe(`From: Test Owner <${ALIAS}>`);
	});

	it("quotes a name containing a comma so the From still parses as one address", async () => {
		await withAlias("Acme Info, Ltd");

		const email = fakeEmail();
		const sent = await submitOk(email, rawReply({ from: `Test Owner <${OWNER}>` }));

		expect(fromLine(sent.raw as string)).toBe(`From: "Acme Info, Ltd" <${ALIAS}>`);
		expect(await parsedFrom(sent.raw as string)).toEqual({
			name: "Acme Info, Ltd",
			address: ALIAS,
		});
	});

	it("RFC 2047-encodes a non-ASCII name", async () => {
		await withAlias("Bjørn Ørsted");

		const email = fakeEmail();
		const sent = await submitOk(email, rawReply({ from: `Test Owner <${OWNER}>` }));

		expect(fromLine(sent.raw as string)).toContain("=?UTF-8?B?");
		expect(await parsedFrom(sent.raw as string)).toEqual({
			name: "Bjørn Ørsted",
			address: ALIAS,
		});
	});

	it("changes the From line and not one other octet, Message-ID included", async () => {
		await withAlias("Acme Info");

		const email = fakeEmail();
		const raw = rawReply({ from: `Test Owner <${OWNER}>`, messageId: "phone-dedup@example.com" });
		const sent = await submitOk(email, raw);

		const before = raw.split("\r\n");
		const after = (sent.raw as string).split("\r\n");
		expect(after).toHaveLength(before.length);

		const differing = before
			.map((line, i) => (line === after[i] ? null : i))
			.filter((i): i is number => i !== null);
		expect(differing).toEqual([0]);
		expect(before[0]).toBe(`From: Test Owner <${OWNER}>`);
		expect(after[0]).toBe(`From: Acme Info <${ALIAS}>`);
		// Named explicitly: the client's own APPENDed Sent copy dedups on it.
		expect(sent.raw).toContain("Message-ID: <phone-dedup@example.com>");
	});

	it("does not emit a line break from a hand-written record", async () => {
		await createAlias(testEnv, ALIAS, OWNER);
		const record = await readAlias(testEnv, ALIAS);
		await env.BUCKET.put(
			aliasKey(ALIAS),
			JSON.stringify({
				mailbox: OWNER,
				createdAt: record?.createdAt,
				name: "Evil\r\nX-Injected: yes",
			}),
			{ customMetadata: { mailbox: OWNER, createdAt: record?.createdAt ?? "", nameState: "set" } },
		);
		await seedOriginal(ALIAS);

		const email = fakeEmail();
		const sent = await submitOk(email, rawReply({ from: `Test Owner <${OWNER}>` }));

		expect(sent.raw).not.toContain("X-Injected");
		expect(fromLine(sent.raw as string)).toBe(`From: Test Owner <${ALIAS}>`);
	});

	it("refuses the whole rewrite when the From names more than one mailbox", async () => {
		await withAlias("Acme Info");

		const email = fakeEmail();
		const from = `Test Owner <${OWNER}>, Someone <second@example.com>`;
		const sent = await submitOk(email, rawReply({ from }));

		// Replacing the value would silently drop the second mailbox, so the
		// rewrite refuses and the client's bytes go out untouched — the
		// pre-send-as behaviour, which is never wrong, only less helpful.
		expect(fromLine(sent.raw as string)).toBe(`From: ${from}`);
		expect(sent.from).toBe(OWNER);
	});
});

// ── The encoder and the splice, directly ──────────────────────────────

describe("formatFromMailbox", () => {
	it("refuses every shape of line break rather than repairing it", () => {
		for (const bad of ["A\rB", "A\nB", "A\r\nB", "A\r\nX-Injected: yes", "A\u0000B"]) {
			expect(formatFromMailbox(ALIAS, bad)).toBeNull();
		}
	});

	it("emits the bare address form for a blank name", () => {
		expect(formatFromMailbox(ALIAS, "")).toBe(`<${ALIAS}>`);
	});

	it("quotes specials and encodes non-ASCII", () => {
		expect(formatFromMailbox(ALIAS, "Acme Info, Ltd")).toBe(`"Acme Info, Ltd" <${ALIAS}>`);
		expect(formatFromMailbox(ALIAS, "Bjørn")).toContain("=?UTF-8?B?");
	});
});

describe("rewriteFromAddress with a display name", () => {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	function rewrite(fromValue: string, name?: string): string | null {
		const raw = encoder.encode(
			`From: ${fromValue}\r\nSubject: Hi\r\nMessage-ID: <m1@example.com>\r\n\r\nBody\r\n`,
		);
		const out = rewriteFromAddress(raw, OWNER, ALIAS, name);
		return out === null ? null : decoder.decode(out);
	}

	it("refuses a name the sanitiser would have had to touch", () => {
		expect(rewrite(`Test Owner <${OWNER}>`, "Evil\r\nX-Injected: yes")).toBeNull();
		expect(rewrite(`Test Owner <${OWNER}>`, "Evil\rX")).toBeNull();
		expect(rewrite(`Test Owner <${OWNER}>`, "Evil\nX")).toBeNull();
	});

	it("refuses a value with an unbalanced quote", () => {
		expect(rewrite(`"Broken <${OWNER}>`, "Acme Info")).toBeNull();
		// The address-only rewrite is unaffected: it never reads the name.
		expect(rewrite(`"Broken <${OWNER}>`)).toContain(`From: "Broken <${ALIAS}>`);
	});

	it("refuses a value with an unbalanced angle bracket", () => {
		expect(rewrite(`Test Owner <${OWNER}`, "Acme Info")).toBeNull();
		expect(rewrite(`Test Owner ${OWNER}>`, "Acme Info")).toBeNull();
	});

	it("refuses a group list", () => {
		expect(rewrite(`Team: ${OWNER};`, "Acme Info")).toBeNull();
	});

	it("accepts a quoted display name that contains a comma", () => {
		// The comma is content, not a separator, so this is a single mailbox.
		expect(rewrite(`"Owner, Test" <${OWNER}>`, "Acme Info")).toContain(
			`From: Acme Info <${ALIAS}>`,
		);
	});

	it("leaves the rest of the message byte-identical", () => {
		const out = rewrite(`Test Owner <${OWNER}>`, "Acme Info");
		expect(out).toBe(
			`From: Acme Info <${ALIAS}>\r\nSubject: Hi\r\nMessage-ID: <m1@example.com>\r\n\r\nBody\r\n`,
		);
	});
});
