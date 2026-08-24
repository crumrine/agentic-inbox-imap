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

import { deriveBodyStructure } from "../imap/bodystructure";

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
	/**
	 * Precomputed IMAP BODYSTRUCTURE as JSON, or null when it could not be
	 * derived exactly. Deriving it here means a mail client's initial sync
	 * never has to pull raw bytes out of R2 just to learn a message's shape.
	 *
	 * Set only when raw_key is non-null. With no stored bytes the raw endpoint
	 * synthesizes a message instead, and a structure describing bytes nobody
	 * will be served is worse than no structure at all.
	 */
	body_structure: string | null;
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
	const bytes =
		typeof raw === "string"
			? new TextEncoder().encode(raw)
			: raw instanceof Uint8Array
				? raw
				: new Uint8Array(raw);
	const size = bytes.byteLength;
	const key = rawMimeKey(mailboxId, emailId);
	try {
		await bucket.put(key, bytes);
		return {
			raw_key: key,
			rfc822_size: size,
			body_structure: deriveBodyStructure(bytes),
		};
	} catch (e) {
		console.error(`Failed to store raw MIME at ${key}:`, (e as Error).message);
		// No stored bytes, so no structure: see StoreRawMimeResult.body_structure.
		return { raw_key: null, rfc822_size: size, body_structure: null };
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

/**
 * `Name <addr>` for a `From:` header, or null when `name` cannot be carried in
 * a header value as written.
 *
 * Exported for the send-as paths, which put an operator-configured per-alias
 * display name on the wire. An empty `name` yields the bare `<addr>` form —
 * that is the "explicitly no display name" answer, not a failure.
 *
 * SECURITY: a display name is free text, and once it is stored it is as
 * attacker-influenced as any other configuration this app holds. It ends up in
 * a header, so it obeys the same two rules every other header value here does:
 * quote or RFC 2047-encode it (`formatMailbox`, unchanged), then run the result
 * through `sanitizeHeaderValue` and require it back *identical*. Equality is
 * the stricter test — it refuses anything the sanitiser had to touch rather
 * than trusting the repaired value — and it is exactly what
 * `rewriteFromAddress` already does for the address. There is deliberately no
 * second encoder and no second sanitiser here.
 */
export function formatFromMailbox(email: string, name: string): string | null {
	const formatted = formatMailbox(email, name);
	return sanitizeHeaderValue(formatted) === formatted ? formatted : null;
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

// -- From-header rewriting (SMTP submission send-as) -----------------------

/**
 * Largest header block this will look at, in bytes. A message whose headers
 * run past this is not rewritten at all — the caller falls back to sending
 * the client's bytes untouched, which is the pre-existing behaviour and never
 * wrong, only less helpful.
 *
 * The cap exists because the rewrite decodes the header region into a string
 * to work on it. The body never is: it is spliced back as the original bytes.
 */
const REWRITE_MAX_HEADER_BYTES = 256 * 1024;

/** RFC 5322 §2.1.1 hard limit on one physical line, excluding the CRLF. */
const MAX_HEADER_LINE_OCTETS = 998;

/**
 * The `From:` header, captured whole: everything after the colon on that line
 * plus every folded continuation (a following line that starts with SP/HTAB).
 *
 * `^` under `m` anchors to a line start, so `Resent-From:` and a `From:`
 * appearing inside a folded value of some other header cannot match.
 */
const FROM_HEADER_RE = /^From:([^\r\n]*(?:\r?\n[ \t][^\r\n]*)*)/im;

/**
 * Swap the address inside a message's `From:` header — and, when the caller
 * supplies one, the display name beside it — changing nothing else in the
 * message: not one byte of the body, not another header, and not the
 * `Message-ID:` the Sent-copy deduplication depends on.
 *
 * ## Why an in-place splice rather than a rebuild
 *
 * The SMTP submission path (`workers/routes/imap-api.ts`) is the one place in
 * this app where the stored `.eml` is byte-exact by construction, because the
 * client hands over the actual message. Round-tripping it through
 * `buildRawMime` would break S/MIME signatures and quietly drop anything the
 * builder does not model. So this finds the address, replaces exactly that
 * span, and leaves the rest of the octets alone.
 *
 * ## The display name, and why it is opt-in
 *
 * With `newName` omitted, the client's display name survives verbatim —
 * including an RFC 2047 encoded word, which this deliberately never decodes —
 * folding and all. That is the default and it is unchanged: nothing about a
 * plain address rewrite touches the name.
 *
 * With `newName` given, the whole header *value* is replaced by
 * `formatFromMailbox(newAddress, newName)`, so the name is quoted per RFC 5322
 * and RFC 2047-encoded when non-ASCII by the one encoder this module has. The
 * empty string is a real value meaning "no display name": it yields the bare
 * `<addr>` form, which is how an operator says a role address should not carry
 * a personal name. The edit is still confined to the `From:` header's own
 * span; every other octet in the message is copied through untouched.
 *
 * Replacing the value discards whatever was outside the address, so this mode
 * additionally insists — via `isSingleMailbox` — that the header names exactly
 * one mailbox. A `From:` with a second address or a group list is refused
 * outright rather than silently collapsed to one, even though the address-only
 * rewrite could have handled it: mixing the two outcomes would make the
 * caller's fallback log say something untrue.
 *
 * ## Refusing is a normal outcome
 *
 * Returns `null` whenever it is not certain which span is the address: no
 * `From:` at all, angle brackets around something that is not `oldAddress`,
 * an unbracketed value where the address appears more than once, a rewrite
 * that would push a header line past 998 octets, a `newAddress` that the
 * sanitiser had to alter, or — in name-replacing mode — a value that is not a
 * single mailbox or a `newName` the sanitiser had to alter. The caller treats
 * `null` as "send the client's bytes as they are". A half-understood header is
 * not something to guess at when the alternative is merely the old,
 * correct-but-less-helpful behaviour.
 *
 * @param oldAddress The current From address, lowercased. The caller has
 *   already established this equals the mailbox's own address.
 * @param newAddress The address to put in its place.
 * @param newName The display name to put in its place, or `undefined` to keep
 *   whatever the client set. `""` means "no display name at all".
 */
export function rewriteFromAddress(
	raw: Uint8Array,
	oldAddress: string,
	newAddress: string,
	newName?: string,
): Uint8Array | null {
	if (!oldAddress || !newAddress) return null;
	// Same address and nothing to say about the name: there is no edit to make.
	if (oldAddress === newAddress && newName === undefined) return null;

	// SECURITY: the replacement goes through the same sanitiser every built
	// header value does, and then the result is required to be *identical* to
	// the input. Equality is the stricter test: it refuses anything the
	// sanitiser had to touch, rather than trusting that what came back is
	// safe. A CR/LF here would end the header block and let the rest of the
	// value become attacker-chosen headers and body — the injection this
	// module's folding helper was once found to re-open.
	const safeAddress = sanitizeHeaderValue(newAddress);
	if (safeAddress !== newAddress || /[\r\n\t ]/.test(safeAddress)) return null;

	const headerBytes = headerBlockLength(raw);
	if (headerBytes > REWRITE_MAX_HEADER_BYTES) return null;

	const head = bytesToLatin1(raw.subarray(0, headerBytes));
	const match = FROM_HEADER_RE.exec(head);
	if (!match) return null;

	const value = match[1];
	const span = locateFromAddress(value, oldAddress);
	if (!span) return null;

	let newValue: string;
	if (newName === undefined) {
		newValue = value.slice(0, span.start) + safeAddress + value.slice(span.end);
	} else {
		if (!isSingleMailbox(value)) return null;
		const formatted = formatFromMailbox(safeAddress, newName);
		if (formatted === null) return null;
		// The leading space is the one that followed the colon in the original;
		// `match[1]` captured it, and a value replaced wholesale has to put it
		// back or `From:Name <addr>` is what lands on the wire.
		newValue = ` ${formatted}`;
	}

	// Never emit a line longer than RFC 5322 allows. Re-folding to fit would
	// mean changing octets outside the address, which is the one thing this
	// function promises not to do, so an over-long result is refused instead.
	const tooLong = `From:${newValue}`
		.split(/\r?\n/)
		.some((line) => line.length > MAX_HEADER_LINE_OCTETS);
	if (tooLong) return null;

	const rewrittenHead =
		head.slice(0, match.index) + `From:${newValue}` + head.slice(match.index + match[0].length);

	return concatBytes(latin1ToBytes(rewrittenHead), raw.subarray(headerBytes));
}

/**
 * Where `address` sits inside a raw `From:` header value, or null when that
 * cannot be answered unambiguously.
 *
 * Angle brackets win when present: `Name <addr>` is the common form, and the
 * bracketed span is the addr-spec by definition, so a display name that
 * happens to repeat the address (`user@example.com <user@example.com>`) resolves
 * correctly instead of ambiguously. Without brackets the value is an
 * addr-spec possibly trailed by a comment (`addr (Name)`), and a single
 * occurrence of the address is the answer; two or more is ambiguous.
 */
function locateFromAddress(
	value: string,
	address: string,
): { start: number; end: number } | null {
	const open = value.lastIndexOf("<");
	if (open !== -1) {
		const close = value.indexOf(">", open + 1);
		if (close === -1) return null;
		const inner = value.slice(open + 1, close);
		if (inner.trim().toLowerCase() !== address) return null;
		const lead = inner.length - inner.trimStart().length;
		const trail = inner.length - inner.trimEnd().length;
		return { start: open + 1 + lead, end: close - trail };
	}

	const lower = value.toLowerCase();
	const first = lower.indexOf(address);
	if (first === -1) return null;
	if (lower.indexOf(address, first + 1) !== -1) return null;
	return { start: first, end: first + address.length };
}

/**
 * True when a raw `From:` header value names exactly one mailbox and nothing
 * else: no second address, no group list, nothing trailing the angle brackets.
 *
 * Only the display-name replacement needs this. Swapping the *address* edits
 * one span and leaves everything around it, so a value it cannot fully account
 * for still comes out right. Replacing the *name* discards everything outside
 * the address, so a second mailbox hiding in the value would be dropped
 * without a trace — hence: understand the whole value, or refuse it.
 *
 * Quoted strings are masked first, because a comma inside one
 * (`"Owner, Test" <owner@example.com>`) belongs to the display name and is not
 * a separator. An unbalanced quote or an unbalanced angle bracket is not
 * something to interpret, so both are refusals.
 */
function isSingleMailbox(value: string): boolean {
	const masked = maskQuoted(value);
	if (masked === null) return false;
	// A comma separates mailboxes; a colon opens a group and a semicolon closes
	// one. None of the three can appear unquoted in a lone mailbox.
	if (/[,:;]/.test(masked)) return false;

	const opens = masked.split("<").length - 1;
	const closes = masked.split(">").length - 1;
	if (opens !== closes || opens > 1) return false;
	if (opens === 1) {
		const open = masked.indexOf("<");
		const close = masked.indexOf(">");
		if (close < open) return false;
		// `Name <addr> (note)` — a trailing comment is a shape this does not
		// model, and dropping it silently is the thing being avoided.
		if (masked.slice(close + 1).trim() !== "") return false;
	}
	return true;
}

/**
 * Replace the contents of every quoted-string with `x`, so a structural scan
 * cannot trip over a special character that is really part of a display name.
 * Returns null when a quote is left open, since the value's structure is then
 * anybody's guess. Backslash escapes inside a quoted-string are honoured.
 */
function maskQuoted(value: string): string | null {
	let out = "";
	let inQuotes = false;
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (inQuotes && char === "\\") {
			// The escape and whatever it escapes are both content.
			out += i + 1 < value.length ? "xx" : "x";
			i += 1;
			continue;
		}
		if (char === '"') {
			inQuotes = !inQuotes;
			out += '"';
			continue;
		}
		out += inQuotes ? "x" : char;
	}
	return inQuotes ? null : out;
}

/**
 * Bytes in `raw` up to and including the LF that ends the last header line.
 *
 * The blank line separating headers from body, and everything after it, stays
 * in the caller's hands as untouched original bytes. A message with no blank
 * line at all is all headers.
 */
function headerBlockLength(raw: Uint8Array): number {
	for (let i = 0; i < raw.length - 1; i++) {
		if (raw[i] !== 0x0a) continue;
		if (raw[i + 1] === 0x0a) return i + 1;
		if (raw[i + 1] === 0x0d && raw[i + 2] === 0x0a) return i + 1;
	}
	return raw.length;
}

/** Chunked so a large header block cannot blow the argument limit. */
const LATIN1_CHUNK = 0x8000;

/**
 * One byte to one char, so string indices are byte offsets and a non-ASCII
 * octet that has no business being in a header survives the round trip
 * unchanged. `TextDecoder` would replace it with U+FFFD and corrupt bytes the
 * caller promised not to touch.
 */
function bytesToLatin1(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i += LATIN1_CHUNK) {
		out += String.fromCharCode(...bytes.subarray(i, i + LATIN1_CHUNK));
	}
	return out;
}

function latin1ToBytes(text: string): Uint8Array {
	const out = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
	return out;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
	const combined = new Uint8Array(a.length + b.length);
	combined.set(a, 0);
	combined.set(b, a.length);
	return combined;
}
