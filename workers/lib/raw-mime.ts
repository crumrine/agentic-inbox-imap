// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Hand-rolled RFC 5322 / MIME message builder + R2 storage for outbound mail.
 *
 * The app hands structured fields (to/cc/subject/html/text/attachments) to
 * Cloudflare's `send_email` binding, which builds the actual wire MIME
 * itself -- we never see those transmitted bytes. This module synthesizes an
 * equivalent RFC 5322 message so the Sent folder is readable over IMAP. The
 * synthesized bytes will not byte-match what Cloudflare actually transmitted;
 * that's expected, it only needs to be a faithful, valid representation of
 * what was sent.
 *
 * Every line ends in CRLF -- the single most common way hand-rolled MIME
 * breaks.
 */

const CRLF = "\r\n";

// -- Public types -----------------------------------------------------

export interface RawMimeAttachment {
	filename: string;
	/** MIME type, e.g. "application/pdf". */
	type: string;
	/** Base64-encoded content (unwrapped or wrapped, whitespace is stripped). */
	content: string;
	contentId?: string;
	disposition?: string;
}

export interface BuildRawMimeInput {
	/** Message-ID, without angle brackets. */
	messageId: string;
	from: string | { email: string; name: string };
	to: string | string[];
	cc?: string | string[] | null;
	bcc?: string | string[] | null;
	subject: string;
	html?: string | null;
	text?: string | null;
	/** Defaults to `new Date()`. */
	date?: Date;
	/** In-Reply-To message id, without angle brackets. */
	inReplyTo?: string | null;
	/** References chain, without angle brackets. */
	references?: string[] | null;
	attachments?: RawMimeAttachment[];
}

export interface StoreRawMimeResult {
	raw_key: string | null;
	rfc822_size: number;
}

// -- R2 storage ---------------------------------------------------------

export function rawMimeKey(mailboxId: string, emailId: string): string {
	return `raw/${mailboxId}/${emailId}.eml`;
}

/**
 * Store raw RFC 5322 bytes to R2. Never throws -- a storage hiccup must not
 * bounce or drop mail. On failure, logs and returns `raw_key: null` so the
 * caller can still insert the email row.
 */
export async function storeRawMime(
	bucket: R2Bucket,
	mailboxId: string,
	emailId: string,
	raw: Uint8Array | ArrayBuffer | string,
): Promise<StoreRawMimeResult> {
	const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
	const size = bytes instanceof Uint8Array ? bytes.byteLength : bytes.byteLength;
	const key = rawMimeKey(mailboxId, emailId);
	try {
		await bucket.put(key, bytes);
		return { raw_key: key, rfc822_size: size };
	} catch (e) {
		console.error(`Failed to store raw MIME at ${key}:`, (e as Error).message);
		return { raw_key: null, rfc822_size: size };
	}
}

/** Build the outbound MIME message and store it in one call. */
export async function buildAndStoreOutboundMime(
	bucket: R2Bucket,
	mailboxId: string,
	emailId: string,
	input: BuildRawMimeInput,
): Promise<StoreRawMimeResult> {
	const raw = buildRawMime(input);
	return storeRawMime(bucket, mailboxId, emailId, raw);
}

// -- RFC 2047 encoded-words ---------------------------------------------

/** Bytes per base64 chunk when RFC 2047-encoding a header value. Keeps each
 * encoded-word (`=?UTF-8?B?...?=`, 12 chars of overhead) comfortably under
 * the 75-char-per-encoded-word limit even after a header-name prefix. */
const RFC2047_BYTES_PER_CHUNK = 30;

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

function isAscii(s: string): boolean {
	return !/[^\x00-\x7f]/.test(s);
}

/**
 * RFC 2047-encode a header value if it contains non-ASCII characters.
 * Long values are split into multiple encoded-words joined by CRLF + space
 * (folding whitespace) -- decoders decode each word independently and
 * concatenate the resulting octets, so splitting mid-character is safe.
 */
function encodeRFC2047(text: string): string {
	if (!text || isAscii(text)) return text;

	const bytes = new TextEncoder().encode(text);
	const words: string[] = [];
	for (let i = 0; i < bytes.length; i += RFC2047_BYTES_PER_CHUNK) {
		const chunk = bytes.slice(i, i + RFC2047_BYTES_PER_CHUNK);
		words.push(`=?UTF-8?B?${bytesToBase64(chunk)}?=`);
	}
	return words.join(`${CRLF} `);
}

/** Format a mailbox (display name + address) for a From/Sender header. */
function formatMailbox(email: string, name?: string): string {
	if (!name) return `<${email}>`;
	if (!isAscii(name)) return `${encodeRFC2047(name)} <${email}>`;
	if (/["\\(),:;<>@[\]]/.test(name)) {
		const escaped = name.replace(/([\\"])/g, "\\$1");
		return `"${escaped}" <${email}>`;
	}
	return `${name} <${email}>`;
}

function joinAddresses(addr: string | string[] | null | undefined): string | undefined {
	if (!addr) return undefined;
	const joined = Array.isArray(addr) ? addr.join(", ") : addr;
	return joined || undefined;
}

// -- RFC 5322 date --------------------------------------------------------

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
	"Jan", "Feb", "Mar", "Apr", "May", "Jun",
	"Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function formatRFC5322Date(date: Date): string {
	const day = DAYS[date.getUTCDay()];
	const dd = pad2(date.getUTCDate());
	const month = MONTHS[date.getUTCMonth()];
	const yyyy = date.getUTCFullYear();
	const hh = pad2(date.getUTCHours());
	const mi = pad2(date.getUTCMinutes());
	const ss = pad2(date.getUTCSeconds());
	return `${day}, ${dd} ${month} ${yyyy} ${hh}:${mi}:${ss} +0000`;
}

// -- Header folding -------------------------------------------------------

/** Soft cap; RFC 5322 recommends <=78, hard-limits at 998. */
const MAX_LINE_LENGTH = 78;

/**
 * Strip line breaks that are not legitimate folding whitespace.
 *
 * SECURITY: header values carry attacker-controlled text - a Subject copied
 * from an inbound message, a display name decoded out of an RFC 2047 encoded
 * word. A bare CR/LF in one of those emits a real header break, and a CRLF
 * CRLF ends the header block entirely and starts an attacker-chosen body.
 *
 * Nothing upstream catches it. CR and LF are ASCII, so `encodeRFC2047` returns
 * the value verbatim instead of base64-wrapping it, and the quoting test in
 * `formatMailbox` does not list them.
 *
 * A CRLF followed by SP/HTAB is this module's own pre-folding (`encodeRFC2047`
 * joins encoded-words with CRLF + space) and is the one form preserved.
 * Everything else collapses to a space.
 */
function sanitizeHeaderValue(value: string): string {
	// NUL is never legal in a header, so it is safe to borrow as a sentinel
	// marking the folds worth keeping. Strip any genuine ones first.
	const FOLD = "\u0000";
	return value
		.replace(/\u0000/g, "")
		.replace(/\r\n(?=[ \t])/g, FOLD)
		.replace(/[\r\n]/g, " ")
		.split(FOLD)
		.join(CRLF);
}

/**
 * Fold "Name: value" into multiple physical lines so none exceeds
 * MAX_LINE_LENGTH, breaking only at whitespace (never inside a token) and
 * joining continuation lines with CRLF + space. Values that already contain
 * CRLF (e.g. pre-folded RFC 2047 encoded-words) are folded segment-by-segment
 * so they are never re-split mid encoded-word.
 */
function foldHeaderLine(name: string, value: string): string {
	const rawLine = `${sanitizeHeaderValue(name)}: ${sanitizeHeaderValue(value)}`;
	const segments = rawLine.split(CRLF);
	return segments
		.map((seg, i) => {
			// SECURITY: sanitizeHeaderValue only preserves a CRLF that is followed
			// by SP/HTAB, so every segment after the first must begin with folding
			// whitespace. Re-assert it here rather than trusting that invariant to
			// hold across future edits: a continuation line that starts at column 0
			// is a new header, which is exactly the injection we are preventing.
			const folded = foldSegment(seg);
			if (i === 0 || /^[ \t]/.test(folded)) return folded;
			return ` ${folded}`;
		})
		.join(CRLF);
}

function foldSegment(segment: string): string {
	if (segment.length <= MAX_LINE_LENGTH) return segment;

	// Preserve any leading folding whitespace. Splitting on " " yields an empty
	// first token for a continuation segment, and the accumulator below drops it
	// (`current ? ... : token` with an empty `current`), which would strip the
	// leading space and promote the continuation to a real header line.
	const leading = /^[ \t]*/.exec(segment)?.[0] ?? "";
	const tokens = segment.slice(leading.length).split(" ");
	const lines: string[] = [];
	let current = "";
	for (const token of tokens) {
		const candidate = current ? `${current} ${token}` : token;
		if (candidate.length > MAX_LINE_LENGTH && current) {
			lines.push(current);
			current = token;
		} else {
			current = candidate;
		}
	}
	if (current) lines.push(current);
	return leading + lines.join(`${CRLF} `);
}

// -- Quoted-printable -------------------------------------------------------

const QP_SOFT_LIMIT = 75;

function qpEncodeLine(line: string): string {
	const bytes = new TextEncoder().encode(line);
	let out = "";
	for (let i = 0; i < bytes.length; i++) {
		const b = bytes[i];
		const isTrailingWhitespace = (b === 0x20 || b === 0x09) && i === bytes.length - 1;
		const printable = b >= 0x21 && b <= 0x7e && b !== 0x3d;
		const plainSpace = (b === 0x20 || b === 0x09) && !isTrailingWhitespace;
		if (printable || plainSpace) {
			out += String.fromCharCode(b);
		} else {
			out += `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
		}
	}
	return softWrapQP(out);
}

/** Insert "=CRLF" soft line breaks so no encoded line exceeds the QP limit,
 * never splitting inside an "=XX" escape triplet, and never leaving a soft
 * break immediately after raw whitespace.
 *
 * RFC 2045 forbids whitespace at the end of an encoded line, and decoders
 * strip trailing SP/HTAB before honoring a soft break -- so a break chosen
 * purely by column count can silently eat a space or tab that happened to
 * land at the boundary. Back the break position off past any such
 * whitespace so the break always follows a non-whitespace character. */
function softWrapQP(line: string): string {
	if (line.length <= QP_SOFT_LIMIT) return line;

	let result = "";
	let i = 0;
	while (line.length - i > QP_SOFT_LIMIT) {
		let breakAt = i + QP_SOFT_LIMIT;
		if (line[breakAt - 1] === "=") breakAt -= 1;
		else if (line[breakAt - 2] === "=") breakAt -= 2;

		// Never end a soft-broken line in SP/HTAB.
		while (breakAt > i && (line[breakAt - 1] === " " || line[breakAt - 1] === "\t")) {
			breakAt -= 1;
		}

		if (breakAt === i) {
			// The whole candidate chunk is whitespace (a long run of spaces or
			// tabs) -- there is nowhere to back off to. Escape one whitespace
			// character to a literal =20/=09 so it can never be mistaken for
			// trailing fold whitespace, and make forward progress one byte at
			// a time until we clear the run.
			const ch = line[i];
			result += ch === "\t" ? "=09" : "=20";
			i += 1;
			continue;
		}

		result += line.slice(i, breakAt) + `=${CRLF}`;
		i = breakAt;
	}
	result += line.slice(i);
	return result;
}

/** Quoted-printable-encode a body, normalizing all line endings to CRLF. */
function qpEncode(text: string): string {
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	return normalized.split("\n").map(qpEncodeLine).join(CRLF);
}

// -- Base64 wrapping (attachments) -----------------------------------------

/** Re-wrap base64 content to 76-char lines, per RFC 2045. */
function wrapBase64(b64: string): string {
	const clean = b64.replace(/\s+/g, "");
	const lines: string[] = [];
	for (let i = 0; i < clean.length; i += 76) {
		lines.push(clean.slice(i, i + 76));
	}
	return lines.join(CRLF);
}

// -- Boundaries -------------------------------------------------------------

function makeBoundary(): string {
	return `----=_Part_${crypto.randomUUID().replace(/-/g, "")}`;
}

// -- Part / multipart assembly ----------------------------------------------

function quoteParam(value: string): string {
	// SECURITY: strip CR/LF before escaping. Attachment filenames and content
	// types reach a header line through here, and escaping only \ and " would
	// let a line break out of the quoted string. See sanitizeHeaderValue.
	return value.replace(/[\r\n]/g, " ").replace(/([\\"])/g, "\\$1");
}

function buildPartBlock(headers: [string, string][], content: string): string {
	const headerBlock = headers.map(([n, v]) => foldHeaderLine(n, v)).join(CRLF);
	return `${headerBlock}${CRLF}${CRLF}${content}`;
}

function buildTextPart(body: string, mimeType: "text/plain" | "text/html"): string {
	return buildPartBlock(
		[
			["Content-Type", `${mimeType}; charset="UTF-8"`],
			["Content-Transfer-Encoding", "quoted-printable"],
		],
		qpEncode(body),
	);
}

function buildAttachmentPart(att: RawMimeAttachment): string {
	const safeName = quoteParam(att.filename || "untitled");
	const disposition = att.disposition || "attachment";
	const headers: [string, string][] = [
		["Content-Type", `${att.type || "application/octet-stream"}; name="${safeName}"`],
		["Content-Transfer-Encoding", "base64"],
		["Content-Disposition", `${disposition}; filename="${safeName}"`],
	];
	if (att.contentId) headers.push(["Content-ID", `<${att.contentId}>`]);
	return buildPartBlock(headers, wrapBase64(att.content));
}

/** Wrap part blocks in a multipart envelope with the given boundary. */
function buildMultipart(boundary: string, parts: string[]): string {
	return parts.map((p) => `--${boundary}${CRLF}${p}${CRLF}`).join("") + `--${boundary}--${CRLF}`;
}

interface BodyResult {
	bodyHeaders: [string, string][];
	bodyContent: string;
}

/** Build multipart/alternative parts for a message with both text and html. */
function buildAlternativeParts(input: BuildRawMimeInput): { boundary: string; parts: string[] } {
	const boundary = makeBoundary();
	const parts = [buildTextPart(input.text as string, "text/plain"), buildTextPart(input.html as string, "text/html")];
	return { boundary, parts };
}

/** Build the single primary body part block (headers + content), whether
 * that's a multipart/alternative envelope or a lone text/plain or text/html
 * part. Used standalone, or nested inside a multipart/mixed wrapper when
 * attachments are present. */
function buildPrimaryPart(input: BuildRawMimeInput): string {
	const hasHtml = !!input.html;
	const hasText = !!input.text;
	if (hasHtml && hasText) {
		const { boundary, parts } = buildAlternativeParts(input);
		return buildPartBlock([["Content-Type", `multipart/alternative; boundary="${boundary}"`]], buildMultipart(boundary, parts));
	}
	const mimeType = hasHtml ? "text/html" : "text/plain";
	const body = hasHtml ? (input.html as string) : (input.text ?? "");
	return buildTextPart(body, mimeType);
}

function buildBody(input: BuildRawMimeInput): BodyResult {
	const attachments = input.attachments ?? [];
	const hasHtml = !!input.html;
	const hasText = !!input.text;

	if (attachments.length === 0) {
		if (hasHtml && hasText) {
			const { boundary, parts } = buildAlternativeParts(input);
			return {
				bodyHeaders: [["Content-Type", `multipart/alternative; boundary="${boundary}"`]],
				bodyContent: buildMultipart(boundary, parts),
			};
		}
		const mimeType = hasHtml ? "text/html" : "text/plain";
		const body = hasHtml ? (input.html as string) : (input.text ?? "");
		return {
			bodyHeaders: [
				["Content-Type", `${mimeType}; charset="UTF-8"`],
				["Content-Transfer-Encoding", "quoted-printable"],
			],
			bodyContent: qpEncode(body),
		};
	}

	// Attachments present: multipart/mixed wraps the primary part + each attachment.
	const mixedBoundary = makeBoundary();
	const parts = [buildPrimaryPart(input), ...attachments.map(buildAttachmentPart)];
	return {
		bodyHeaders: [["Content-Type", `multipart/mixed; boundary="${mixedBoundary}"`]],
		bodyContent: buildMultipart(mixedBoundary, parts),
	};
}

// -- Top-level builder --------------------------------------------------

/**
 * Synthesize an RFC 5322 message from structured send parameters.
 *
 * This does not byte-match what Cloudflare's send_email binding actually
 * transmits (we never see those bytes) -- it's a faithful re-derivation for
 * reading back the Sent folder over IMAP.
 */
export function buildRawMime(input: BuildRawMimeInput): string {
	const date = input.date ?? new Date();

	const fromHeader = typeof input.from === "string" ? `<${input.from}>` : formatMailbox(input.from.email, input.from.name);
	const toHeader = joinAddresses(input.to);
	const ccHeader = joinAddresses(input.cc);
	const bccHeader = joinAddresses(input.bcc);

	const headers: [string, string][] = [];
	headers.push(["From", fromHeader]);
	if (toHeader) headers.push(["To", toHeader]);
	if (ccHeader) headers.push(["Cc", ccHeader]);
	if (bccHeader) headers.push(["Bcc", bccHeader]);
	headers.push(["Subject", encodeRFC2047(input.subject ?? "")]);
	headers.push(["Date", formatRFC5322Date(date)]);
	headers.push(["Message-ID", `<${input.messageId}>`]);
	if (input.inReplyTo) headers.push(["In-Reply-To", `<${input.inReplyTo}>`]);
	if (input.references?.length) {
		headers.push(["References", input.references.map((r) => `<${r}>`).join(" ")]);
	}
	headers.push(["MIME-Version", "1.0"]);

	const { bodyHeaders, bodyContent } = buildBody(input);
	headers.push(...bodyHeaders);

	const headerBlock = headers.map(([n, v]) => foldHeaderLine(n, v)).join(CRLF);
	return `${headerBlock}${CRLF}${CRLF}${bodyContent}`;
}
