// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Precomputed BODYSTRUCTURE (DEV-678).
 *
 * ## What these assertions are actually checking against
 *
 * The gateway derives BODYSTRUCTURE with go-imap's
 * `imapserver.ExtractBodyStructure`, and both paths stay live — an
 * unbackfilled row still goes the lazy way — so the stored structure has to
 * be the *same value*, not merely a plausible one. The expected objects below
 * are therefore written out by hand from that function's behaviour rather
 * than snapshotted from our own output, and the derivation each one pins is
 * named in a comment:
 *
 *   - a part's `size` is the length of its **encoded** body, excluding the
 *     CRLF that belongs to the following boundary delimiter,
 *   - `numLines` counts `\n` bytes in that same encoded body,
 *   - a multipart keeps the *whole* Content-Type parameter map (boundary
 *     included) on its extended data,
 *   - `encoding` / `id` / `description` are the raw header values, undecoded
 *     and not lower-cased.
 *
 * `sizesAgreeWithRawBytes` re-derives every part's extent from the raw bytes
 * by a completely separate route, so a shared misunderstanding between the
 * deriver and a hand-written literal still fails.
 *
 * ## The other half: what must NOT be answered
 *
 * A missing BODYSTRUCTURE costs one R2 GET on the gateway. A wrong one makes
 * a mail client render the wrong part of a message, and the client has no way
 * to notice. So the refusals are tested as hard as the successes.
 */

import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import {
	BODY_STRUCTURE_VERSION,
	deriveBodyStructure,
	isStoredMultiPart,
	parseStoredBodyStructure,
	type StoredBodyStructure,
	type StoredMultiPart,
} from "../workers/imap/bodystructure";
import { IMAP_API_BASE, type ImapApiEnv, imapApi } from "../workers/routes/imap-api";
import { type MailboxStub, exec, mailbox, query } from "./helpers";

const app = new Hono<{ Bindings: ImapApiEnv }>().route(IMAP_API_BASE, imapApi);

let n = 0;
async function makeMailbox(prefix: string): Promise<{ id: string; stub: MailboxStub }> {
	n += 1;
	const id = `${prefix}-${n}@example.com`;
	await env.BUCKET.put(`mailboxes/${id}.json`, JSON.stringify({ fromName: "Test" }));
	return { id, stub: mailbox(id) };
}

/** The structure only, with the version wrapper stripped. */
function derive(raw: string): StoredBodyStructure | null {
	const stored = deriveBodyStructure(raw);
	if (stored === null) return null;
	const parsed = parseStoredBodyStructure(stored);
	expect(parsed).not.toBeNull();
	if (!parsed) return null;
	const { v, ...node } = parsed;
	expect(v).toBe(BODY_STRUCTURE_VERSION);
	return node as StoredBodyStructure;
}

// ── Fixtures ──────────────────────────────────────────────────────────

const PLAIN_BODY = "Hello there.\r\nSecond line.\r\n";

const PLAIN_MESSAGE =
	[
		"From: Ada Lovelace <ada@example.com>",
		"To: bob@example.net",
		"Subject: Hello there",
		"Date: Wed, 12 Mar 2026 09:14:00 +0000",
		"Message-ID: <plain@example.com>",
		"MIME-Version: 1.0",
		'Content-Type: text/plain; charset="utf-8"',
		"Content-Transfer-Encoding: 7bit",
	].join("\r\n") +
	"\r\n\r\n" +
	PLAIN_BODY;

const TEXT_PART_BODY = "Hello body\r\nwith two lines";
const PDF_PART_BODY = "QUJDREVGRw==";

const MIXED_MESSAGE =
	[
		"From: Ada Lovelace <ada@example.com>",
		"To: bob@example.net",
		"Subject: With an attachment",
		"Date: Wed, 12 Mar 2026 09:14:00 +0000",
		"Message-ID: <mixed@example.com>",
		"MIME-Version: 1.0",
		'Content-Type: multipart/mixed; boundary="BOUND1"',
	].join("\r\n") +
	"\r\n\r\n" +
	// A preamble, which every real client emits and go-imap skips.
	"This is a multi-part message in MIME format.\r\n" +
	"--BOUND1\r\n" +
	"Content-Type: text/plain; charset=utf-8\r\n" +
	"\r\n" +
	TEXT_PART_BODY +
	"\r\n--BOUND1\r\n" +
	'Content-Type: application/pdf; name="report.pdf"\r\n' +
	"Content-Transfer-Encoding: base64\r\n" +
	'Content-Disposition: attachment; filename="report.pdf"\r\n' +
	"Content-Id: <att-1@example.com>\r\n" +
	"\r\n" +
	PDF_PART_BODY +
	"\r\n--BOUND1--\r\n";

const ALT_TEXT_BODY = "plain alternative";
const ALT_HTML_BODY = "<p>html alternative</p>";
const NESTED_PDF_BODY = "QUJD";

const NESTED_MESSAGE =
	[
		"From: Ada Lovelace <ada@example.com>",
		"To: bob@example.net",
		"Subject: Nested",
		"MIME-Version: 1.0",
		"Content-Type: multipart/mixed; boundary=OUTER",
	].join("\r\n") +
	"\r\n\r\n" +
	"--OUTER\r\n" +
	'Content-Type: multipart/alternative; boundary="INNER"\r\n' +
	"\r\n" +
	"--INNER\r\n" +
	"Content-Type: text/plain\r\n" +
	"\r\n" +
	ALT_TEXT_BODY +
	"\r\n--INNER\r\n" +
	"Content-Type: text/html; charset=us-ascii\r\n" +
	"\r\n" +
	ALT_HTML_BODY +
	"\r\n--INNER--\r\n" +
	"--OUTER\r\n" +
	"Content-Type: application/octet-stream\r\n" +
	"Content-Transfer-Encoding: BASE64\r\n" +
	"\r\n" +
	NESTED_PDF_BODY +
	"\r\n--OUTER--\r\n";

/**
 * Independent cross-check: walk the raw bytes with a naive splitter and
 * confirm each declared `size` really is the length of that part's body.
 *
 * Deliberately does not share a line of code with the deriver. If both were
 * wrong about, say, whether the CRLF before a boundary belongs to the part,
 * the hand-written expectations further down would agree with them and this
 * would not.
 */
function sizesAgreeWithRawBytes(raw: string, node: StoredBodyStructure, region: string): void {
	if (isStoredMultiPart(node)) {
		const multipart = node;
		const boundary = multipart.params?.boundary;
		expect(boundary).toBeDefined();
		const delimiter = `\r\n--${boundary}`;
		// Drop the preamble, then split on the delimiter. The last chunk is
		// the closing "--" plus any epilogue.
		const first = region.startsWith(`--${boundary}`)
			? region.slice(`--${boundary}`.length)
			: region.slice(region.indexOf(delimiter) + delimiter.length);
		const chunks = first.split(delimiter);
		const parts = chunks.slice(0, -1);
		expect(parts.length).toBe(multipart.children.length);
		parts.forEach((chunk, index) => {
			// A chunk begins with the rest of the delimiter line.
			const afterLine = chunk.slice(chunk.indexOf("\r\n") + 2);
			const blank = afterLine.indexOf("\r\n\r\n");
			const body = afterLine.startsWith("\r\n")
				? afterLine.slice(2)
				: afterLine.slice(blank + 4);
			sizesAgreeWithRawBytes(raw, multipart.children[index], body);
		});
		return;
	}
	expect(node.size).toBe(region.length);
	if (node.type === "text") {
		expect(node.numLines).toBe(region.split("\n").length - 1);
	}
}

/** The body of a whole message: everything after the header blank line. */
function messageBody(raw: string): string {
	return raw.slice(raw.indexOf("\r\n\r\n") + 4);
}

// ── Derivation ────────────────────────────────────────────────────────

describe("deriveBodyStructure", () => {
	it("describes a plain-text message the way ExtractBodyStructure does", () => {
		const node = derive(PLAIN_MESSAGE);
		expect(node).toEqual({
			type: "text",
			subtype: "plain",
			params: { charset: "utf-8" },
			// Content-Transfer-Encoding verbatim: go-imap does not normalise it.
			encoding: "7bit",
			size: PLAIN_BODY.length,
			numLines: 2,
		});
		// No Content-Disposition / Content-Language / Content-Location in the
		// message, so those extended fields must be absent, not empty strings.
		expect(node).not.toHaveProperty("disposition");
		expect(node).not.toHaveProperty("language");
		expect(node).not.toHaveProperty("location");
	});

	it("defaults a message with no Content-Type to text/plain with no params", () => {
		const raw = "Subject: bare\r\n\r\nbody\r\n";
		expect(derive(raw)).toEqual({
			type: "text",
			subtype: "plain",
			size: "body\r\n".length,
			numLines: 1,
		});
	});

	it("describes a multipart message with an attachment", () => {
		const node = derive(MIXED_MESSAGE);
		expect(node).toEqual({
			type: "multipart",
			subtype: "mixed",
			// The whole Content-Type parameter map, boundary included: that is
			// what lands on BodyStructureMultiPartExt.Params.
			params: { boundary: "BOUND1" },
			children: [
				{
					type: "text",
					subtype: "plain",
					params: { charset: "utf-8" },
					size: TEXT_PART_BODY.length,
					numLines: 1,
				},
				{
					type: "application",
					subtype: "pdf",
					params: { name: "report.pdf" },
					id: "<att-1@example.com>",
					encoding: "base64",
					size: PDF_PART_BODY.length,
					disposition: { value: "attachment", params: { filename: "report.pdf" } },
				},
			],
		});

		sizesAgreeWithRawBytes(MIXED_MESSAGE, node as StoredBodyStructure, messageBody(MIXED_MESSAGE));
	});

	it("recurses into a nested multipart and stops at the enclosing boundary", () => {
		const node = derive(NESTED_MESSAGE);
		expect(node).toEqual({
			type: "multipart",
			subtype: "mixed",
			params: { boundary: "OUTER" },
			children: [
				{
					type: "multipart",
					subtype: "alternative",
					params: { boundary: "INNER" },
					children: [
						{ type: "text", subtype: "plain", size: ALT_TEXT_BODY.length, numLines: 0 },
						{
							type: "text",
							subtype: "html",
							params: { charset: "us-ascii" },
							size: ALT_HTML_BODY.length,
							numLines: 0,
						},
					],
				},
				{
					type: "application",
					subtype: "octet-stream",
					// Verbatim again: "BASE64" as written, not lower-cased.
					encoding: "BASE64",
					size: NESTED_PDF_BODY.length,
				},
			],
		});

		sizesAgreeWithRawBytes(
			NESTED_MESSAGE,
			node as StoredBodyStructure,
			messageBody(NESTED_MESSAGE),
		);
	});

	it("does not swallow the next part when one part has an empty body", () => {
		// The subtle case in go's scanUntilBoundary: with no body, the CRLF
		// that would precede the next boundary has already been consumed as
		// the blank line ending this part's headers.
		const raw =
			"Content-Type: multipart/mixed; boundary=B\r\n\r\n" +
			"--B\r\n" +
			"Content-Type: text/plain\r\n" +
			"\r\n" +
			"--B\r\n" +
			"Content-Type: text/html\r\n" +
			"\r\n" +
			"tail" +
			"\r\n--B--\r\n";
		expect(derive(raw)).toEqual({
			type: "multipart",
			subtype: "mixed",
			params: { boundary: "B" },
			children: [
				{ type: "text", subtype: "plain", size: 0, numLines: 0 },
				{ type: "text", subtype: "html", size: 4, numLines: 0 },
			],
		});
	});

	it("keeps scanning past a boundary-lookalike inside a body", () => {
		// "--Bx" starts with "--B" but is not the boundary; go's
		// matchAfterPrefix rejects it and the bytes stay in the body.
		const body = "before\r\n--Bxnot a boundary\r\nafter";
		const raw =
			"Content-Type: multipart/mixed; boundary=B\r\n\r\n" +
			"--B\r\n" +
			"Content-Type: text/plain\r\n" +
			"\r\n" +
			body +
			"\r\n--B--\r\n";
		const node = derive(raw) as StoredMultiPart;
		expect(node.children).toHaveLength(1);
		expect(node.children[0]).toMatchObject({ size: body.length, numLines: 2 });
	});

	it("unfolds a folded Content-Type the way go-message does", () => {
		const raw =
			"Content-Type: multipart/mixed;\r\n\tboundary=\"B\"\r\n\r\n" +
			"--B\r\nContent-Type: text/plain\r\n\r\nx\r\n--B--\r\n";
		expect(derive(raw)).toMatchObject({
			type: "multipart",
			subtype: "mixed",
			params: { boundary: "B" },
		});
	});
});

// ── Refusals ──────────────────────────────────────────────────────────

describe("deriveBodyStructure refusals", () => {
	const refused: [string, string][] = [
		[
			"a message with bare LF line endings",
			"Content-Type: text/plain\n\nbody\n",
		],
		[
			"a message/rfc822 part, which go-imap also extracts a nested envelope from",
			"Content-Type: multipart/mixed; boundary=B\r\n\r\n" +
				"--B\r\nContent-Type: message/rfc822\r\n\r\n" +
				"Subject: inner\r\n\r\ninner body\r\n--B--\r\n",
		],
		[
			"an RFC 2231 continuation parameter",
			"Content-Type: text/plain\r\n" +
				"Content-Disposition: attachment; filename*=UTF-8''caf%C3%A9.txt\r\n\r\nbody\r\n",
		],
		[
			"an encoded-word inside a parameter value",
			'Content-Type: text/plain; name="=?UTF-8?B?Zm9v?="\r\n\r\nbody\r\n',
		],
		[
			"a multipart with no boundary parameter",
			"Content-Type: multipart/mixed\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\nx\r\n--B--\r\n",
		],
		[
			"a multipart that is never terminated",
			"Content-Type: multipart/mixed; boundary=B\r\n\r\n" +
				"--B\r\nContent-Type: text/plain\r\n\r\nx\r\n",
		],
		[
			"a multipart whose boundary never appears",
			"Content-Type: multipart/mixed; boundary=B\r\n\r\nnothing here\r\n",
		],
		[
			// go-imap's writeBodyTypeMpart panics on a childless multipart, so
			// this one must never reach it as a stored structure.
			"a multipart with no parts at all",
			"Content-Type: multipart/mixed; boundary=B\r\n\r\n--B--\r\n",
		],
		[
			"a non-ASCII byte in a header block",
			"Content-Type: text/plain\r\nSubject: café\r\n\r\nbody\r\n",
		],
		[
			"a repeated Content-Type, where go-message answers with the last one",
			"Content-Type: text/plain\r\nContent-Type: text/html\r\n\r\nbody\r\n",
		],
		[
			"a header block with no blank line terminating it",
			"Content-Type: text/plain\r\n",
		],
		["an empty message", ""],
	];

	for (const [label, raw] of refused) {
		it(`refuses ${label}`, () => {
			expect(deriveBodyStructure(raw)).toBeNull();
		});
	}

	it("never throws, whatever it is handed", () => {
		const hostile = [
			"\r\n",
			"\r\n\r\n",
			"Content-Type: multipart/mixed; boundary=B\r\n\r\n--B",
			"Content-Type: multipart/mixed; boundary=\"\"\r\n\r\n----\r\n",
			"Content-Type: ;;;\r\n\r\nbody\r\n",
			"Content-Type: text/plain; charset=\r\n\r\nbody\r\n",
			":\r\n\r\nbody\r\n",
		];
		for (const raw of hostile) {
			expect(() => deriveBodyStructure(raw)).not.toThrow();
		}
	});

	it("refuses a multipart nested past the depth ceiling", () => {
		// 12 levels: past MAX_DEPTH, so the whole message is refused rather
		// than answered with a truncated tree.
		let raw = "Content-Type: text/plain\r\n\r\ndeep\r\n";
		for (let level = 12; level >= 1; level--) {
			const boundary = `B${level}`;
			raw = `--${boundary}\r\n${raw}\r\n--${boundary}--\r\n`;
			raw = `Content-Type: multipart/mixed; boundary=${boundary}\r\n\r\n${raw}`;
		}
		expect(deriveBodyStructure(raw)).toBeNull();
	});
});

// ── Round trip through the column ─────────────────────────────────────

describe("parseStoredBodyStructure", () => {
	it("rejects anything it does not recognise rather than half-decoding it", () => {
		expect(parseStoredBodyStructure(null)).toBeNull();
		expect(parseStoredBodyStructure("")).toBeNull();
		expect(parseStoredBodyStructure("not json")).toBeNull();
		expect(parseStoredBodyStructure("[]")).toBeNull();
		expect(parseStoredBodyStructure('{"type":"text","subtype":"plain"}')).toBeNull();
		// A version this build does not know: the row belongs to a newer
		// format, so it is not ours to serve.
		expect(parseStoredBodyStructure('{"v":99,"type":"text","subtype":"plain"}')).toBeNull();
	});
});

// ── The wire ──────────────────────────────────────────────────────────

describe("bodyStructure on GET /{mailbox}/{folder}/messages", () => {
	async function listed(mailboxId: string, folder: string) {
		const res = await app.request(`${IMAP_API_BASE}/${mailboxId}/${folder}/messages`, {}, env);
		expect(res.status).toBe(200);
		return (await res.json()) as {
			messages: (Record<string, unknown> & { uid: number })[];
			uidNext: number;
		};
	}

	async function appendRaw(mailboxId: string, folder: string, raw: string): Promise<number> {
		const res = await app.request(
			`${IMAP_API_BASE}/${mailboxId}/${folder}/append`,
			{ method: "POST", headers: { "content-type": "message/rfc822" }, body: raw },
			env,
		);
		expect(res.status).toBe(200);
		return ((await res.json()) as { uid: number }).uid;
	}

	it("serves the structure APPEND computed, matching the deriver", async () => {
		const { id } = await makeMailbox("bs-append");
		await appendRaw(id, "draft", MIXED_MESSAGE);

		const page = await listed(id, "draft");
		expect(page.messages).toHaveLength(1);
		expect(page.messages[0].bodyStructure).toEqual({
			v: BODY_STRUCTURE_VERSION,
			...(derive(MIXED_MESSAGE) as StoredBodyStructure),
		});
	});

	it("stores it in the column, once, at write time", async () => {
		const { id, stub } = await makeMailbox("bs-column");
		await appendRaw(id, "draft", PLAIN_MESSAGE);

		const rows = await query<{ body_structure: string | null }>(
			stub,
			`SELECT body_structure FROM emails`,
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].body_structure).toBe(deriveBodyStructure(PLAIN_MESSAGE));
	});

	it("omits the field entirely for a row with nothing stored", async () => {
		const { id, stub } = await makeMailbox("bs-legacy");
		await exec(
			stub,
			`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, read, body, uid)
			 VALUES ('legacy', 'inbox', 'Legacy', 'a@example.com', 'b@example.com',
			         '2026-03-01T10:00:00.000Z', 0, 'Body', 1)`,
		);

		const page = await listed(id, "inbox");
		expect(page.messages).toHaveLength(1);
		expect(page.messages[0]).not.toHaveProperty("bodyStructure");
		// It must be missing, not present-and-broken: the gateway reads a
		// missing field as "fetch the raw message", which is exactly right.
		expect(page.messages[0].bodyStructure).toBeUndefined();
	});

	it("omits the field when the stored value is unreadable", async () => {
		const { id, stub } = await makeMailbox("bs-corrupt");
		await exec(
			stub,
			`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, read, body, uid,
			                     body_structure)
			 VALUES ('corrupt', 'inbox', 'Corrupt', 'a@example.com', 'b@example.com',
			         '2026-03-01T10:00:00.000Z', 0, 'Body', 1, '{ this is not json')`,
		);

		const page = await listed(id, "inbox");
		expect(page.messages[0]).not.toHaveProperty("bodyStructure");
	});

	it("is purely additive: nothing else about the payload changed", async () => {
		const { id, stub } = await makeMailbox("bs-additive");
		await exec(
			stub,
			`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, read, body, uid)
			 VALUES ('plain', 'inbox', 'Legacy', 'a@example.com', 'b@example.com',
			         '2026-03-01T10:00:00.000Z', 0, 'Body', 1)`,
		);
		// Nothing allocated uid 1, so park uid_next past it before appending.
		await exec(stub, `UPDATE folders SET uid_next = 2 WHERE id = 'inbox'`);
		await appendRaw(id, "inbox", PLAIN_MESSAGE);

		const page = await listed(id, "inbox");
		expect(Object.keys(page).sort()).toEqual(["messages", "uidNext"]);

		const withoutStructure = page.messages.find((m) => m.uid === 1);
		const withStructure = page.messages.find((m) => m.uid !== 1);
		const legacyKeys = [
			"envelope",
			"flags",
			"hasRaw",
			"internalDate",
			"rfc822Size",
			"uid",
		];
		expect(Object.keys(withoutStructure ?? {}).sort()).toEqual(legacyKeys);
		// The only difference is the one new key.
		expect(Object.keys(withStructure ?? {}).sort()).toEqual(
			[...legacyKeys, "bodyStructure"].sort(),
		);
	});

	it("carries the structure to a COPY, which shares the same bytes", async () => {
		const { id } = await makeMailbox("bs-copy");
		const uid = await appendRaw(id, "inbox", MIXED_MESSAGE);

		const res = await app.request(
			`${IMAP_API_BASE}/${id}/inbox/copy`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ destination: "archive", uids: [uid] }),
			},
			env,
		);
		expect(res.status).toBe(200);

		const source = await listed(id, "inbox");
		const copy = await listed(id, "archive");
		expect(copy.messages).toHaveLength(1);
		expect(copy.messages[0].bodyStructure).toEqual(source.messages[0].bodyStructure);
	});

	it("stores nothing for a message whose MIME the deriver declines", async () => {
		const { id, stub } = await makeMailbox("bs-declined");
		// A message/rfc822 attachment: refused, so the row keeps NULL and the
		// gateway parses the raw bytes as before.
		const raw =
			"From: ada@example.com\r\nTo: bob@example.net\r\nSubject: Forwarded\r\n" +
			"Message-ID: <fwd@example.com>\r\nMIME-Version: 1.0\r\n" +
			"Content-Type: multipart/mixed; boundary=B\r\n\r\n" +
			"--B\r\nContent-Type: text/plain\r\n\r\nsee attached\r\n" +
			"--B\r\nContent-Type: message/rfc822\r\n\r\nSubject: inner\r\n\r\ninner\r\n--B--\r\n";
		await appendRaw(id, "draft", raw);

		const rows = await query<{ body_structure: string | null }>(
			stub,
			`SELECT body_structure FROM emails`,
		);
		expect(rows[0].body_structure).toBeNull();

		const page = await listed(id, "draft");
		expect(page.messages[0]).not.toHaveProperty("bodyStructure");
		// The message itself is unaffected — only its structure is missing.
		expect(page.messages[0].hasRaw).toBe(true);
	});
});
