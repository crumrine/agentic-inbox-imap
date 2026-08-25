// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import PostalMime from "postal-mime";
import { describe, expect, it } from "vitest";

import { buildRawMime, type BuildRawMimeInput } from "../workers/lib/raw-mime";

function baseInput(overrides: Partial<BuildRawMimeInput> = {}): BuildRawMimeInput {
	return {
		messageId: "abc123@example.com",
		from: "sender@example.com",
		to: "recipient@example.com",
		subject: "Test subject",
		text: "Hello there",
		...overrides,
	};
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

function randomBytes(n: number): Uint8Array {
	const bytes = new Uint8Array(n);
	for (let i = 0; i < n; i++) bytes[i] = (i * 37 + 11) % 256; // deterministic pseudo-random
	return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

function toBytes(content: ArrayBuffer | string): Uint8Array {
	return typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
}

describe("buildRawMime: CRLF correctness", () => {
	it("uses CRLF exclusively, never a bare LF or CR", () => {
		const raw = buildRawMime(
			baseInput({
				subject: "Non-ascii café ☕ subject that keeps going and going and going to force folding",
				html: "<p>Hi</p>",
				text: "Hi\nsecond line\nthird line",
				references: Array.from({ length: 15 }, (_, i) => `ref-${i}@example.com`),
			}),
		);
		assertOnlyCRLF(raw);
	});
});

describe("buildRawMime: round trip via PostalMime", () => {
	it("plain text only", async () => {
		const raw = buildRawMime(baseInput({ text: "Just plain text here." }));
		assertOnlyCRLF(raw);
		const parsed = await PostalMime.parse(raw);
		expect(parsed.subject).toBe("Test subject");
		expect(parsed.from?.address).toBe("sender@example.com");
		expect(parsed.to?.[0]?.address).toBe("recipient@example.com");
		expect(parsed.text?.trim()).toBe("Just plain text here.");
		expect(parsed.html).toBeFalsy();
		expect(parsed.attachments).toHaveLength(0);
	});

	it("html only", async () => {
		const raw = buildRawMime(baseInput({ text: undefined, html: "<p>Hello <b>world</b></p>" }));
		assertOnlyCRLF(raw);
		const parsed = await PostalMime.parse(raw);
		expect(parsed.html).toContain("Hello");
		expect(parsed.html).toContain("<b>world</b>");
		expect(parsed.text).toBeFalsy();
	});

	it("both text and html (multipart/alternative)", async () => {
		const raw = buildRawMime(
			baseInput({ text: "Plain version", html: "<p>HTML version</p>" }),
		);
		assertOnlyCRLF(raw);
		expect(raw).toContain("multipart/alternative");
		const parsed = await PostalMime.parse(raw);
		expect(parsed.text?.trim()).toBe("Plain version");
		expect(parsed.html).toContain("HTML version");
	});

	it("with attachments (multipart/mixed), attachment bytes survive exactly", async () => {
		const attachmentBytes = randomBytes(500);
		const raw = buildRawMime(
			baseInput({
				text: "See attached.",
				attachments: [
					{
						filename: "data.bin",
						type: "application/octet-stream",
						content: bytesToBase64(attachmentBytes),
					},
				],
			}),
		);
		assertOnlyCRLF(raw);
		expect(raw).toContain("multipart/mixed");
		const parsed = await PostalMime.parse(raw);
		expect(parsed.text?.trim()).toBe("See attached.");
		expect(parsed.attachments).toHaveLength(1);
		const att = parsed.attachments[0];
		expect(att.filename).toBe("data.bin");
		const decodedBytes = toBytes(att.content);
		expect(Array.from(decodedBytes)).toEqual(Array.from(attachmentBytes));
	});

	it("html + text + attachments together", async () => {
		const attachmentBytes = randomBytes(120);
		const raw = buildRawMime(
			baseInput({
				text: "Plain body",
				html: "<p>HTML body</p>",
				attachments: [
					{
						filename: "note.txt",
						type: "text/plain",
						content: bytesToBase64(attachmentBytes),
						disposition: "attachment",
					},
				],
			}),
		);
		assertOnlyCRLF(raw);
		const parsed = await PostalMime.parse(raw);
		expect(parsed.text?.trim()).toBe("Plain body");
		expect(parsed.html).toContain("HTML body");
		expect(parsed.attachments).toHaveLength(1);
		expect(Array.from(toBytes(parsed.attachments[0].content))).toEqual(Array.from(attachmentBytes));
	});

	it("non-ASCII subject round-trips correctly", async () => {
		const subject = "Café ☕ — 日本語のテスト — düşünce";
		const raw = buildRawMime(baseInput({ subject }));
		assertOnlyCRLF(raw);
		expect(raw).toContain("=?UTF-8?B?");
		const parsed = await PostalMime.parse(raw);
		expect(parsed.subject).toBe(subject);
	});

	it("non-ASCII display name round-trips correctly", async () => {
		const name = "Bälle Ünïcode 名前";
		const raw = buildRawMime(baseInput({ from: { email: "sender@example.com", name } }));
		assertOnlyCRLF(raw);
		const parsed = await PostalMime.parse(raw);
		expect(parsed.from?.name).toBe(name);
		expect(parsed.from?.address).toBe("sender@example.com");
	});

	it("long subject header folds and round-trips intact", async () => {
		const subject = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
		const raw = buildRawMime(baseInput({ subject }));
		assertOnlyCRLF(raw);
		// Folding should have occurred: the Subject header spans more than one line.
		const subjectHeaderBlock = raw.split("\r\n\r\n")[0];
		const subjectLine = subjectHeaderBlock
			.split(/\r\n(?!\s)/) // split on CRLF NOT followed by whitespace (i.e. not a folded continuation)
			.find((l) => l.startsWith("Subject:"));
		expect(subjectLine).toBeDefined();
		expect((subjectLine as string).includes("\r\n")).toBe(true);
		const parsed = await PostalMime.parse(raw);
		expect(parsed.subject).toBe(subject);
	});

	it("long References chain folds and round-trips intact", async () => {
		const references = Array.from({ length: 25 }, (_, i) => `msg-${i}-${"x".repeat(10)}@example.com`);
		const raw = buildRawMime(baseInput({ inReplyTo: references[references.length - 1], references }));
		assertOnlyCRLF(raw);
		const headerBlock = raw.split("\r\n\r\n")[0];
		const refsLine = headerBlock
			.split(/\r\n(?!\s)/)
			.find((l) => l.startsWith("References:"));
		expect(refsLine).toBeDefined();
		expect((refsLine as string).includes("\r\n")).toBe(true); // folded across multiple lines

		const parsed = await PostalMime.parse(raw);
		const parsedRefs = (parsed.references || "")
			.split(/\s+/)
			.filter(Boolean)
			.map((r) => r.replace(/^<|>$/g, ""));
		expect(parsedRefs).toEqual(references);
		expect(parsed.inReplyTo?.replace(/^<|>$/g, "")).toBe(references[references.length - 1]);
	});

	it("plain single-part message when neither html nor text is given", async () => {
		const raw = buildRawMime(baseInput({ text: undefined, html: undefined }));
		assertOnlyCRLF(raw);
		expect(raw).not.toContain("multipart/");
		const parsed = await PostalMime.parse(raw);
		expect(parsed.subject).toBe("Test subject");
	});

	it("Message-ID, cc, and date headers are present and well-formed", async () => {
		const raw = buildRawMime(baseInput({ cc: ["cc1@example.com", "cc2@example.com"] }));
		assertOnlyCRLF(raw);
		expect(raw).toContain("Message-ID: <abc123@example.com>");
		expect(raw).toContain("Cc: cc1@example.com, cc2@example.com");
		expect(raw).toMatch(/Date: \w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} \+0000/);
		const parsed = await PostalMime.parse(raw);
		expect(parsed.messageId?.replace(/^<|>$/g, "")).toBe("abc123@example.com");
		expect(parsed.cc?.map((a) => a.address)).toEqual(["cc1@example.com", "cc2@example.com"]);
	});
});

/**
 * Regression tests for the CRLF header-injection fix in sanitizeHeaderValue.
 *
 * Header values carry attacker-controlled text: a Subject copied into a reply,
 * a display name decoded out of an RFC 2047 word. Before the fix, a bare CRLF
 * in any of them became a real header break, and CRLF CRLF ended the header
 * block and started an attacker-chosen body.
 */
describe("buildRawMime: CRLF header injection", () => {
	/** Header block is everything before the first blank line. */
	function headerBlock(raw: string): string {
		return raw.split("\r\n\r\n")[0]!;
	}

	/** Count real header lines (a CRLF NOT followed by folding whitespace). */
	function headerLines(raw: string): string[] {
		return headerBlock(raw).split(/\r\n(?!\s)/);
	}

	it("a CRLF in the subject cannot inject a new header", () => {
		const raw = buildRawMime(
			baseInput({ subject: "Hi\r\nBcc: attacker@evil.test" }),
		);
		assertOnlyCRLF(raw);
		expect(headerLines(raw).some((l) => /^Bcc:/i.test(l))).toBe(false);
	});

	it("a CRLF CRLF in the subject cannot terminate the header block", () => {
		const raw = buildRawMime(
			baseInput({
				subject: "Hi\r\n\r\n<h1>injected body</h1>",
				text: "the real body",
			}),
		);
		assertOnlyCRLF(raw);
		// The real body must still be the body. The injected text is allowed to
		// survive as inert Subject content -- what must not happen is it becoming
		// a body of its own, which is what a surviving CRLF CRLF would cause.
		expect(raw.split("\r\n\r\n").slice(1).join("\r\n\r\n")).toContain("the real body");
		expect(headerLines(raw).some((l) => l.startsWith("<h1>"))).toBe(false);
		expect(headerLines(raw).filter((l) => /^Subject:/i.test(l))).toHaveLength(1);
	});

	it("a CRLF in a display name cannot forge a second From header", () => {
		const raw = buildRawMime(
			baseInput({
				from: { email: "attacker@evil.test", name: "Bob\r\nFrom: ceo@bank.test" },
			}),
		);
		assertOnlyCRLF(raw);
		// Exactly one From line, and the forged address is trapped inside the
		// quoted display name rather than starting a header of its own.
		const fromLines = headerLines(raw).filter((l) => /^From:/i.test(l));
		expect(fromLines).toHaveLength(1);
		expect(fromLines[0]).toContain("<attacker@evil.test>");
		expect(headerLines(raw).some((l) => l.startsWith("From: ceo@bank.test"))).toBe(false);
	});

	it("a bare LF (not CRLF) is also neutralised", () => {
		const raw = buildRawMime(
			baseInput({ subject: "Hi\nBcc: attacker@evil.test" }),
		);
		assertOnlyCRLF(raw);
		expect(headerLines(raw).some((l) => /^Bcc:/i.test(l))).toBe(false);
	});

	it("a CRLF in an attachment filename cannot inject a part header", () => {
		const raw = buildRawMime(
			baseInput({
				attachments: [
					{
						filename: 'x.txt"\r\nX-Injected: yes',
						type: "text/plain",
						content: btoa("hi"),
					},
				],
			}),
		);
		assertOnlyCRLF(raw);
		expect(raw).not.toMatch(/\r\nX-Injected:/);
	});

	it("still folds a long non-ASCII subject correctly (the fix must not break real folding)", async () => {
		const subject = `Ré: ${"très long sujet ".repeat(12)}`;
		const raw = buildRawMime(baseInput({ subject }));
		assertOnlyCRLF(raw);
		for (const line of headerBlock(raw).split("\r\n")) {
			expect(line.length).toBeLessThanOrEqual(78);
		}
		const parsed = await PostalMime.parse(raw);
		expect(parsed.subject).toBe(subject);
	});
});

/**
 * Regression test for the foldSegment bypass of sanitizeHeaderValue.
 *
 * sanitizeHeaderValue preserves CRLF + SP/HTAB as legitimate folding. foldSegment
 * then split the segment on " " and dropped the resulting empty leading token,
 * stripping that space -- but only when the segment exceeded MAX_LINE_LENGTH,
 * which is why the module's own short encoded-word folds never tripped it.
 * The result was a continuation line starting at column 0, i.e. a real header.
 */
/**
 * Regression tests for the quoted-printable soft-wrap bug: the break
 * position was chosen purely by column count, so a break landing right
 * after a raw space or tab produced a line ending " =\r\n" or "\t=\r\n".
 * RFC 2045 section 6.7 requires trailing whitespace to be hex-escaped
 * rather than left dangling before a soft line break, precisely because a
 * compliant decoder strips it before honoring the break -- silently
 * dropping the character from the decoded body.
 *
 * postal-mime's own QP decoder (used everywhere else in this file) is
 * lenient: it deletes the literal "=\r\n" sequence and does NOT implement
 * the RFC's trailing-whitespace-stripping rule (see
 * node_modules/postal-mime/src/qp-decoder.js, `SOFT_LINE_BREAK_REGEX`), so
 * round-tripping through PostalMime.parse cannot catch this bug -- it
 * reports the space as present even when the encoder produced a
 * spec-violating line. These tests instead assert directly against the
 * wire bytes (no line may end in raw SP/HTAB immediately before a soft
 * break) and against a minimal *strict* RFC 2045 decoder that does
 * implement the stripping rule, which any compliant mail client is
 * entitled to do.
 *
 * QP_SOFT_LIMIT is 75 and qpEncodeLine passes plain ASCII through
 * unescaped, so a body whose 75th character (index 74) is whitespace lands
 * the naive break position exactly one character past it.
 */
function qpBodyOf(raw: string): string {
	return raw.split("\r\n\r\n").slice(1).join("\r\n\r\n");
}

/** RFC 2045 section 6.7: trailing whitespace on an encoded line is
 * insignificant and must be stripped before honoring a soft line break.
 * Implements exactly that rule, nothing else: a line ending in "=" is a
 * soft break -- strip any SP/HTAB immediately before that "=", drop the
 * marker, and join with the next line without inserting a line break. */
function decodeQPStrict(encoded: string): string {
	const lines = encoded.split("\r\n");
	let unwrapped = "";
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.endsWith("=")) {
			unwrapped += line.slice(0, -1).replace(/[ \t]+$/, "");
		} else {
			unwrapped += line;
			if (i < lines.length - 1) unwrapped += "\r\n";
		}
	}
	return unwrapped.replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

describe("buildRawMime: QP soft-wrap does not drop whitespace at the boundary", () => {
	it("never emits a soft-broken line ending in raw space or tab", () => {
		const line = `${"A".repeat(74)} ${"B".repeat(50)}`;
		expect(line[74]).toBe(" "); // sanity: boundary math lines up with QP_SOFT_LIMIT
		const raw = buildRawMime(baseInput({ text: line, html: undefined }));
		assertOnlyCRLF(raw);
		expect(qpBodyOf(raw)).not.toMatch(/[ \t]=\r\n/);
	});

	it("a space landing exactly at the 75-column soft-wrap boundary survives strict RFC 2045 decoding", () => {
		const line = `${"A".repeat(74)} ${"B".repeat(50)}`;
		const raw = buildRawMime(baseInput({ text: line, html: undefined }));
		assertOnlyCRLF(raw);
		expect(decodeQPStrict(qpBodyOf(raw))).toBe(line);
	});

	it("a tab landing exactly at the 75-column soft-wrap boundary survives strict RFC 2045 decoding", () => {
		const line = `${"A".repeat(74)}\t${"B".repeat(50)}`;
		const raw = buildRawMime(baseInput({ text: line, html: undefined }));
		assertOnlyCRLF(raw);
		expect(decodeQPStrict(qpBodyOf(raw))).toBe(line);
	});

	it("a long run of spaces spanning the boundary survives strict RFC 2045 decoding", () => {
		const line = `${"A".repeat(60)}${" ".repeat(30)}${"B".repeat(40)}`;
		const raw = buildRawMime(baseInput({ text: line, html: undefined }));
		assertOnlyCRLF(raw);
		expect(decodeQPStrict(qpBodyOf(raw))).toBe(line);
	});

	it("still round-trips through PostalMime.parse (real-world decoder compatibility)", async () => {
		const line = `${"A".repeat(74)} ${"B".repeat(50)}`;
		const raw = buildRawMime(baseInput({ text: line, html: undefined }));
		assertOnlyCRLF(raw);
		const parsed = await PostalMime.parse(raw);
		expect(parsed.text?.trim()).toBe(line);
	});
});

describe("buildRawMime: folding cannot promote a continuation to a header", () => {
	it("a long injected segment stays a folded continuation", () => {
		const raw = buildRawMime(
			baseInput({
				subject: `hello\r\n X-Injected: ${"A".repeat(70)} tail`,
			}),
		);
		assertOnlyCRLF(raw);
		const headerBlock = raw.split("\r\n\r\n")[0]!;
		// No physical line may begin with the injected header name at column 0.
		for (const line of headerBlock.split("\r\n")) {
			expect(line.startsWith("X-Injected:")).toBe(false);
		}
		// And it must not register as a header when split on real header boundaries.
		const realHeaders = headerBlock.split(/\r\n(?!\s)/);
		expect(realHeaders.some((h) => /^X-Injected:/i.test(h))).toBe(false);
	});

	it("every continuation line begins with folding whitespace", () => {
		const raw = buildRawMime(
			baseInput({
				subject: `start\r\n ${"B".repeat(200)}`,
				references: Array.from({ length: 12 }, (_, i) => `msg-${i}-${"c".repeat(30)}@example.com`),
			}),
		);
		assertOnlyCRLF(raw);
		const headerBlock = raw.split("\r\n\r\n")[0]!;
		for (const line of headerBlock.split("\r\n")) {
			// A line is either a new header (Name: ...) or a folded continuation.
			const isHeaderStart = /^[!-9;-~]+:/.test(line);
			const isContinuation = /^[ \t]/.test(line);
			expect(isHeaderStart || isContinuation).toBe(true);
		}
	});
});
