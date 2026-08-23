// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Precomputed IMAP BODYSTRUCTURE (DEV-678).
 *
 * ## Why this exists
 *
 * Mail clients ask for `BODYSTRUCTURE` during ordinary sync. The metadata
 * endpoint did not carry it, so the gateway fell back to downloading the
 * **raw message** from R2 and parsing it (`rawEntry.bodyStructure()` in
 * `gateway/internal/imap/cache.go`). A first sync of a large folder therefore
 * pulled raw bytes for nearly every message — exactly the cost the metadata
 * endpoint exists to avoid. Deriving the structure once, at the moment we
 * already hold the raw bytes, moves that work off the hot path for good.
 *
 * ## The contract with the gateway
 *
 * The gateway derives BODYSTRUCTURE with
 * `imapserver.ExtractBodyStructure(bytes.NewReader(raw))` from go-imap
 * v2.0.0-beta.8. Whatever we store must reconstruct into *the same value*,
 * because both paths stay live: an unbackfilled row still goes the lazy way,
 * and a client must not see one answer for one message and a different kind
 * of answer for its neighbour.
 *
 * So this module is a deliberate re-implementation of
 * `imapserver.extractBodyStructure` + the `go-message` header and multipart
 * parsing it sits on, restricted to the input shapes where the two provably
 * agree:
 *
 *   - the message is strictly CRLF (no bare CR, no bare LF anywhere),
 *   - every header block is 7-bit ASCII,
 *   - `Content-Type` / `Content-Disposition` parse as plain RFC 2045
 *     `token`/`quoted-string` parameters — no RFC 2231 continuations
 *     (`name*0=`, `name*=`), no encoded-words in parameter values,
 *   - no `message/rfc822` / `message/global` part (go-imap recurses into
 *     those *and* extracts a nested ENVELOPE; a second envelope parser is a
 *     second thing to get wrong),
 *   - every multipart is properly delimited and terminated.
 *
 * **Anything outside that returns null**, and null means the row stores no
 * structure and the gateway keeps doing what it does today. A missing
 * BODYSTRUCTURE costs one R2 GET. A *wrong* BODYSTRUCTURE makes a client
 * render the wrong part of a message, and it has no way to notice. Those
 * failure modes are not comparable, so every ambiguity in here resolves to
 * "don't answer".
 *
 * ## Storage format
 *
 * A JSON object carrying `v: 1` plus the node itself, stored verbatim in
 * `emails.body_structure` and served as an additive `bodyStructure` field on
 * the `/messages` payload. The field names map one-to-one onto
 * `imap.BodyStructureSinglePart` / `imap.BodyStructureMultiPart`, so the Go
 * side is a plain `encoding/json` decode plus a `children != nil` switch.
 * Absent optional fields mean the Go zero value (nil map, nil slice, "").
 *
 * Three things the Go reconstructor must get right, because go-imap's
 * `writeBodyType1part` / `writeBodyTypeMpart` do not tolerate them:
 *
 *   1. **`Extended` must always be allocated**, on every node, even when
 *      disposition, language and location are all absent. `ExtractBodyStructure`
 *      always sets it, and the extended writer dereferences it unconditionally
 *      — a nil `Extended` is a nil-pointer panic, not a missing field.
 *   2. A nil `Params` map and an empty one are indistinguishable on the wire
 *      (`writeBodyFldParam` emits NIL for both), which is why `params` is
 *      omitted rather than serialised as `{}`.
 *   3. A multipart must have at least one child; the writer panics otherwise.
 *      This module refuses such a message rather than storing one.
 */

/**
 * Format version of a stored structure. A reader that does not recognise the
 * version ignores the row, which degrades to the lazy path rather than
 * serving a structure it may be misreading.
 */
export const BODY_STRUCTURE_VERSION = 1;

/** `Content-Disposition`, as `imap.BodyStructureDisposition`. */
export interface StoredDisposition {
	value: string;
	params?: Record<string, string>;
}

/** One non-multipart entity, as `imap.BodyStructureSinglePart`. */
export interface StoredSinglePart {
	/** Primary type, lower-cased: `text`, `image`, `application`, … */
	type: string;
	subtype: string;
	params?: Record<string, string>;
	/** `Content-Id`, verbatim. */
	id?: string;
	description?: string;
	encoding?: string;
	/** Byte length of the encoded body — what `RFC822.SIZE` means per part. */
	size: number;
	/** `BodyStructureText.NumLines`; present only for `text/*`. */
	numLines?: number;
	disposition?: StoredDisposition;
	language?: string[];
	location?: string;
}

/** One multipart entity, as `imap.BodyStructureMultiPart`. */
export interface StoredMultiPart {
	type: "multipart";
	subtype: string;
	children: StoredBodyStructure[];
	params?: Record<string, string>;
	disposition?: StoredDisposition;
	language?: string[];
	location?: string;
}

export type StoredBodyStructure = StoredSinglePart | StoredMultiPart;

/**
 * Narrow a node to a multipart.
 *
 * `type` is not usable as a TypeScript discriminant here — a single part's
 * type is an arbitrary lower-cased token — so the presence of `children` is
 * the test, which is also what the Go side switches on.
 */
export function isStoredMultiPart(node: StoredBodyStructure): node is StoredMultiPart {
	return "children" in node;
}

/** What actually lands in the column and on the wire. */
export type StoredBodyStructureEnvelope = StoredBodyStructure & { v: number };

/**
 * Ceilings. None of these are tuning knobs: each one bounds work a hostile
 * message could otherwise ask an isolate to do, and crossing one is a bail,
 * not a truncation.
 */
const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
const MAX_HEADER_BLOCK_BYTES = 64 * 1024;
const MAX_PARTS = 256;
const MAX_DEPTH = 10;

const CR = 0x0d;
const LF = 0x0a;
const DASH = 0x2d;
const SPACE = 0x20;
const TAB = 0x09;

const CRLF = new Uint8Array([CR, LF]);
const CRLFCRLF = new Uint8Array([CR, LF, CR, LF]);

/** Headers this module reads. A repeat of any of them is a bail — see below. */
const SIGNIFICANT_HEADERS = [
	"content-type",
	"content-transfer-encoding",
	"content-disposition",
	"content-id",
	"content-description",
	"content-language",
	"content-location",
] as const;

/**
 * Derive the stored structure for one raw RFC 822 message.
 *
 * Returns the JSON string to put in `emails.body_structure`, or **null** when
 * the message falls outside the shapes this module can reproduce exactly.
 * Null is a normal, expected outcome; callers store it as SQL NULL and the
 * gateway falls back to parsing the raw bytes itself.
 *
 * Never throws: a caller is always on a write path where the message matters
 * more than its structure, so a bug in here must not lose mail.
 */
export function deriveBodyStructure(raw: Uint8Array | string): string | null {
	try {
		const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
		const node = buildBodyStructure(bytes);
		if (!node) return null;
		return JSON.stringify({ v: BODY_STRUCTURE_VERSION, ...node });
	} catch {
		return null;
	}
}

/**
 * Read a stored structure back for serving.
 *
 * Anything unrecognised — malformed JSON, a version this build does not know,
 * a shape that is not a body structure — comes back null, so a column written
 * by a future format cannot be served as if it were this one.
 */
export function parseStoredBodyStructure(
	stored: string | null | undefined,
): StoredBodyStructureEnvelope | null {
	if (!stored) return null;
	try {
		const parsed = JSON.parse(stored) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const candidate = parsed as Partial<StoredBodyStructureEnvelope>;
		if (candidate.v !== BODY_STRUCTURE_VERSION) return null;
		if (typeof candidate.type !== "string" || typeof candidate.subtype !== "string") {
			return null;
		}
		return candidate as StoredBodyStructureEnvelope;
	} catch {
		return null;
	}
}

/** The structure only, with no version wrapper. Exported for tests. */
export function buildBodyStructure(bytes: Uint8Array): StoredBodyStructure | null {
	if (bytes.length === 0 || bytes.length > MAX_MESSAGE_BYTES) return null;
	// Strict CRLF is the single assumption everything else rests on. Go's
	// multipart reader switches to LF-only delimiters when it meets one, and
	// header unfolding differs with it; rather than mirror that state machine
	// we refuse mixed input. Every producer that reaches this code (SMTP
	// inbound, the MIME builder, an IMAP APPEND literal) emits CRLF.
	if (!isStrictCrlf(bytes)) return null;

	const state: ParseState = { parts: 0 };
	const parsed = parseEntity(bytes, 0, bytes.length, null, 0, state);
	return parsed ? parsed.node : null;
}

interface ParseState {
	parts: number;
}

/** A boundary context: the two delimiter forms Go scans for. */
interface BoundaryContext {
	dash: Uint8Array; // "--boundary"
	nlDash: Uint8Array; // "\r\n--boundary"
}

interface ParsedEntity {
	node: StoredBodyStructure;
	/**
	 * Index just past the `--boundary` token that ended this entity's body,
	 * or -1 for the top-level entity (which ends at end of message).
	 */
	delimEnd: number;
}

/**
 * One entity: header block, then body, then (inside a multipart) the boundary
 * that ends it.
 *
 * `end` is the hard limit this entity may not read past — the enclosing
 * multipart's body end, or the end of the message at the top level. Header
 * parsing deliberately is *not* bounded by the boundary, which is exactly
 * what go-message does: `newPart` reads headers straight off the shared
 * buffered reader.
 */
function parseEntity(
	buf: Uint8Array,
	start: number,
	end: number,
	ctx: BoundaryContext | null,
	depth: number,
	state: ParseState,
): ParsedEntity | null {
	if (depth > MAX_DEPTH) return null;
	if (start > end) return null;

	// An entity with nothing in it at all: no header, no body. go-message's
	// ReadHeader returns an empty header at EOF and the body reads as zero
	// bytes, giving the default text/plain. Reachable for an empty part.
	if (start === end) {
		if (ctx) return null; // an empty part still needs a delimiter after it
		return { node: emptyTextPlain(), delimEnd: -1 };
	}

	const header = readHeaderBlock(buf, start, end);
	if (!header) return null;

	const bodyStart = header.bodyStart;

	// Where the body stops, and where the delimiter that stopped it ends.
	let bodyEnd: number;
	let delimEnd: number;
	if (ctx) {
		const stop = scanToBoundary(buf, bodyStart, end, ctx);
		if (!stop) return null;
		bodyEnd = stop.bodyEnd;
		delimEnd = stop.delimEnd;
	} else {
		bodyEnd = end;
		delimEnd = -1;
	}

	const node = describeEntity(buf, header.fields, bodyStart, bodyEnd, depth, state);
	if (!node) return null;
	return { node, delimEnd };
}

/** The structure go-imap produces for an entity with no headers and no body. */
function emptyTextPlain(): StoredSinglePart {
	// Content-Type absent means text/plain with a *nil* parameter map, which
	// is why `params` is omitted rather than set to {}.
	return { type: "text", subtype: "plain", size: 0, numLines: 0 };
}

/**
 * Turn one entity's headers and body extent into a node.
 *
 * This is `imapserver.extractBodyStructure` line for line: the multipart
 * branch keeps the whole Content-Type parameter map on `Extended.Params`, the
 * single-part branch keeps the raw `Content-Id` / `Content-Description` /
 * `Content-Transfer-Encoding` values and the *encoded* body length.
 */
function describeEntity(
	buf: Uint8Array,
	fields: Map<string, string>,
	bodyStart: number,
	bodyEnd: number,
	depth: number,
	state: ParseState,
): StoredBodyStructure | null {
	const rawContentType = fields.get("content-type");
	let mediaType: string;
	let typeParams: Record<string, string> | null;
	if (rawContentType === undefined || rawContentType === "") {
		// go-message's Header.ContentType: no Content-Type is text/plain with
		// a nil parameter map.
		mediaType = "text/plain";
		typeParams = null;
	} else {
		const parsed = parseMediaType(rawContentType);
		// A Content-Type go's mime.ParseMediaType would reject takes a
		// fallback path in go-message that hands the *raw* header value back
		// as the media type. Reproducing that faithfully is not worth it.
		if (!parsed) return null;
		mediaType = parsed.value;
		typeParams = parsed.params;
	}

	const slash = mediaType.indexOf("/");
	const primaryType = slash < 0 ? mediaType : mediaType.slice(0, slash);
	const subtype = slash < 0 ? "" : mediaType.slice(slash + 1);

	const disposition = readDisposition(fields);
	if (disposition === INVALID) return null;
	const language = readLanguage(fields);
	const location = fields.get("content-location") ?? "";

	if (primaryType === "multipart") {
		const boundary = typeParams?.boundary;
		// go's multipart reader with an empty boundary yields no parts at all,
		// which would store "a multipart with no children" — a structure no
		// client can use. Refuse instead.
		if (!boundary) return null;

		const children = splitMultipart(buf, bodyStart, bodyEnd, boundary, depth, state);
		if (!children) return null;
		// go-imap *panics* on a multipart with no children
		// (`writeBodyTypeMpart`), so a body whose first delimiter is already
		// the closing one must never be stored as a structure.
		if (children.length === 0) return null;

		const node: StoredMultiPart = { type: "multipart", subtype, children };
		if (typeParams && Object.keys(typeParams).length > 0) node.params = typeParams;
		if (disposition) node.disposition = disposition;
		if (language) node.language = language;
		if (location) node.location = location;
		return node;
	}

	// go-imap recurses into these *and* extracts a nested ENVELOPE. Getting a
	// second envelope parser byte-identical is a separate piece of work; until
	// then a forwarded-as-attachment message keeps the lazy path.
	if (mediaType === "message/rfc822" || mediaType === "message/global") return null;

	const node: StoredSinglePart = {
		type: primaryType,
		subtype,
		size: bodyEnd - bodyStart,
	};
	if (typeParams && Object.keys(typeParams).length > 0) node.params = typeParams;
	const id = fields.get("content-id");
	if (id) node.id = id;
	const description = fields.get("content-description");
	if (description) node.description = description;
	const encoding = fields.get("content-transfer-encoding");
	if (encoding) node.encoding = encoding;
	if (primaryType === "text") {
		node.numLines = countByte(buf, bodyStart, bodyEnd, LF);
	}
	if (disposition) node.disposition = disposition;
	if (language) node.language = language;
	if (location) node.location = location;
	return node;
}

/** Sentinel for a Content-Disposition we refuse to guess at. */
const INVALID = Symbol("invalid-disposition");

function readDisposition(
	fields: Map<string, string>,
): StoredDisposition | null | typeof INVALID {
	const raw = fields.get("content-disposition");
	// Absent (or empty) is the common case: mime.ParseMediaType("") errors,
	// go-imap sees an empty disposition value and stores nil.
	if (!raw) return null;
	const parsed = parseMediaType(raw);
	if (!parsed) return INVALID;
	if (parsed.value === "") return null;
	const disposition: StoredDisposition = { value: parsed.value };
	if (Object.keys(parsed.params).length > 0) disposition.params = parsed.params;
	return disposition;
}

function readLanguage(fields: Map<string, string>): string[] | null {
	const raw = fields.get("content-language");
	if (!raw) return null;
	return raw.split(",").map((lang) => lang.trim());
}

// ── Header block ──────────────────────────────────────────────────────

interface HeaderBlock {
	fields: Map<string, string>;
	/** First byte of the body, i.e. just past the blank line. */
	bodyStart: number;
}

/**
 * Parse one header block and report where the body begins.
 *
 * Only the seven headers this module reads are kept. A repeat of any of them
 * is a bail: go-message's `Get` answers with the *last* occurrence, which is
 * a rule nothing in the wild relies on deliberately, so a message with two
 * `Content-Type`s is exactly the kind of thing to hand back to the raw path.
 */
function readHeaderBlock(buf: Uint8Array, start: number, end: number): HeaderBlock | null {
	// A leading CRLF is an entity with no headers at all.
	if (startsWith(buf, CRLF, start, end)) {
		return { fields: new Map(), bodyStart: start + 2 };
	}

	const blank = indexOfSeq(buf, CRLFCRLF, start, end);
	if (blank < 0) return null;
	const headerEnd = blank + 2; // include the CRLF ending the last field
	if (headerEnd - start > MAX_HEADER_BLOCK_BYTES) return null;

	// 7-bit only. A non-ASCII byte in a header is already out of spec, and
	// decoding it would mean picking a charset go never picked.
	for (let i = start; i < headerEnd; i++) {
		if (buf[i] >= 0x80) return null;
	}

	const block = asciiSlice(buf, start, headerEnd);
	const fields = new Map<string, string>();
	const seen = new Set<string>();

	// Unfold: a line beginning with SP/HTAB continues the previous one.
	const lines = block.split("\r\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

	const logical: string[] = [];
	for (const line of lines) {
		if (line === "") return null; // no blank line can survive inside a block
		if (line.startsWith(" ") || line.startsWith("\t")) {
			if (logical.length === 0) return null; // continuation with nothing to continue
			logical[logical.length - 1] += `\n${line}`;
			continue;
		}
		logical.push(line);
	}

	for (const field of logical) {
		const colon = field.indexOf(":");
		if (colon < 0) return null; // go-message errors out here too
		const key = field.slice(0, colon).trim().toLowerCase();
		if (key === "" || !isValidHeaderKey(key)) return null;
		if (!(SIGNIFICANT_HEADERS as readonly string[]).includes(key)) continue;
		if (seen.has(key)) return null;
		seen.add(key);
		fields.set(key, unfoldValue(field.slice(colon + 1)));
	}

	return { fields, bodyStart: blank + 4 };
}

/**
 * go-message's `trimAroundNewlines`: each physical line is stripped of its CR
 * and of surrounding SP/HTAB, empty pieces vanish, and the rest are joined
 * with exactly one space.
 */
function unfoldValue(value: string): string {
	let out = "";
	for (const rawSegment of value.split("\n")) {
		const segment = trimSpaceTab(
			rawSegment.endsWith("\r") ? rawSegment.slice(0, -1) : rawSegment,
		);
		if (segment === "") continue;
		if (out !== "") out += " ";
		out += segment;
	}
	return out;
}

function trimSpaceTab(value: string): string {
	let i = 0;
	let j = value.length;
	while (i < j && (value[i] === " " || value[i] === "\t")) i++;
	while (j > i && (value[j - 1] === " " || value[j - 1] === "\t")) j--;
	return value.slice(i, j);
}

/** RFC 5322 §2.2 field-name: printable US-ASCII except colon. */
function isValidHeaderKey(key: string): boolean {
	for (let i = 0; i < key.length; i++) {
		const c = key.charCodeAt(i);
		if (c < 33 || c > 126 || c === 58) return false;
	}
	return true;
}

// ── Content-Type / Content-Disposition ────────────────────────────────

interface MediaType {
	/** Lower-cased type, e.g. `text/plain` or `attachment`. */
	value: string;
	params: Record<string, string>;
}

/**
 * A strict subset of Go's `mime.ParseMediaType`.
 *
 * Null means "we are not confident", and the two documented gaps are both
 * deliberate: RFC 2231 continuations (`name*0*=`) and encoded-words inside a
 * parameter value both get rewritten by go-message before go-imap sees them,
 * and reproducing either exactly is a bigger surface than the feature is
 * worth. Both are rare in Content-Type; a filename that needs one is carried
 * by `Content-Disposition` on messages this refuses, which then take the
 * lazy path intact.
 */
function parseMediaType(header: string): MediaType | null {
	const semi = header.indexOf(";");
	const base = semi < 0 ? header : header.slice(0, semi);
	const value = base.trim().toLowerCase();
	if (!isValidMediaTypeValue(value)) return null;

	const params: Record<string, string> = {};
	let rest = header.slice(base.length);

	while (rest.length > 0) {
		rest = rest.replace(/^\s+/, "");
		if (rest.length === 0) break;
		if (!rest.startsWith(";")) return null;
		rest = rest.slice(1).replace(/^\s+/, "");
		// A trailing semicolon is tolerated, exactly as Go tolerates it.
		if (rest.length === 0) break;

		const key = consumeToken(rest);
		if (key.token === "") return null;
		const name = key.token.toLowerCase();
		// RFC 2231. See the doc comment.
		if (name.includes("*")) return null;

		rest = key.rest.replace(/^\s+/, "");
		if (!rest.startsWith("=")) return null;
		rest = rest.slice(1).replace(/^\s+/, "");

		const parsedValue = consumeValue(rest);
		if (!parsedValue) return null;
		// Encoded-words in a parameter value are decoded by go-message with a
		// charset table this module does not carry.
		if (parsedValue.value.includes("=?")) return null;

		if (name in params) {
			// Go allows a duplicate only when it repeats the same value.
			if (params[name] !== parsedValue.value) return null;
		}
		params[name] = parsedValue.value;
		rest = parsedValue.rest;
	}

	return { value, params };
}

/** Go's `checkMediaTypeDisposition`: `token` or `token "/" token`. */
function isValidMediaTypeValue(value: string): boolean {
	const first = consumeToken(value);
	if (first.token === "") return false;
	if (first.rest === "") return true;
	if (!first.rest.startsWith("/")) return false;
	const second = consumeToken(first.rest.slice(1));
	if (second.token === "") return false;
	return second.rest === "";
}

const TSPECIALS = '()<>@,;:\\"/[]?=';

function isTokenChar(c: string): boolean {
	const code = c.charCodeAt(0);
	if (code <= 0x20 || code >= 0x7f) return false;
	return !TSPECIALS.includes(c);
}

function consumeToken(input: string): { token: string; rest: string } {
	let i = 0;
	while (i < input.length && isTokenChar(input[i])) i++;
	return { token: input.slice(0, i), rest: input.slice(i) };
}

/** Go's `consumeValue`: a bare token, or a quoted-string with `\` escapes. */
function consumeValue(input: string): { value: string; rest: string } | null {
	if (!input.startsWith('"')) {
		const token = consumeToken(input);
		if (token.token === "") return null;
		return { value: token.token, rest: token.rest };
	}

	let out = "";
	let i = 1;
	while (i < input.length) {
		const c = input[i];
		if (c === "\\") {
			if (i + 1 >= input.length) return null;
			out += input[i + 1];
			i += 2;
			continue;
		}
		if (c === '"') return { value: out, rest: input.slice(i + 1) };
		out += c;
		i++;
	}
	return null; // unterminated quoted-string
}

// ── Multipart ─────────────────────────────────────────────────────────

/**
 * Split a multipart body into children.
 *
 * This mirrors `textproto.MultipartReader`: skip the preamble to the first
 * `--boundary` line, read a part per delimiter, stop at `--boundary--`. The
 * one place it is deliberately *stricter* is a malformed delimiter line —
 * where Go stops iterating and silently reports the parts it already had,
 * this refuses the whole message, because a structure missing its last part
 * is precisely the wrong answer a client cannot detect.
 */
function splitMultipart(
	buf: Uint8Array,
	start: number,
	end: number,
	boundary: string,
	depth: number,
	state: ParseState,
): StoredBodyStructure[] | null {
	const ctx = boundaryContext(boundary);
	if (!ctx) return null;

	// The first delimiter may sit at the very start of the body with no
	// leading CRLF; otherwise it is the first `\r\n--boundary` line.
	let cursor: number;
	if (startsWith(buf, ctx.dash, start, end) && isBoundaryFollower(buf, start + ctx.dash.length, end)) {
		cursor = start + ctx.dash.length;
	} else {
		const first = findDelimiter(buf, start, end, ctx.nlDash);
		if (first < 0) return null;
		cursor = first + ctx.nlDash.length;
	}

	const children: StoredBodyStructure[] = [];
	for (;;) {
		const tail = classifyDelimiterTail(buf, cursor, end);
		if (tail === "invalid") return null;
		if (tail === "final") return children;

		state.parts += 1;
		if (state.parts > MAX_PARTS) return null;

		const partStart = tail.partStart;
		const child = parseEntity(buf, partStart, end, ctx, depth + 1, state);
		if (!child) return null;
		children.push(child.node);
		cursor = child.delimEnd;
	}
}

function boundaryContext(boundary: string): BoundaryContext | null {
	// Boundaries are RFC 2046 bchars; anything else and our byte comparison
	// would not be comparing the same thing Go compares.
	if (boundary.length === 0 || boundary.length > 200) return null;
	for (let i = 0; i < boundary.length; i++) {
		const code = boundary.charCodeAt(i);
		if (code <= 0x20 || code >= 0x7f) return null;
	}
	const encoder = new TextEncoder();
	return {
		dash: encoder.encode(`--${boundary}`),
		nlDash: encoder.encode(`\r\n--${boundary}`),
	};
}

/**
 * `matchAfterPrefix`: a boundary token only counts when what follows it is
 * whitespace, a line ending, a dash, or end of input. `--foo` inside `--foobar`
 * is body text, and Go keeps scanning past it.
 */
function isBoundaryFollower(buf: Uint8Array, index: number, end: number): boolean {
	if (index >= end) return true; // end of input
	const c = buf[index];
	return c === SPACE || c === TAB || c === CR || c === LF || c === DASH;
}

/** First `\r\n--boundary` in `[from, end)` that is really a boundary. */
function findDelimiter(buf: Uint8Array, from: number, end: number, nlDash: Uint8Array): number {
	let p = from;
	for (;;) {
		const i = indexOfSeq(buf, nlDash, p, end);
		if (i < 0) return -1;
		if (isBoundaryFollower(buf, i + nlDash.length, end)) return i;
		// Go consumes the near-miss as body bytes and carries on.
		p = i + nlDash.length;
	}
}

/**
 * What follows a `--boundary` token: the rest of a delimiter line, the closing
 * `--`, or something we refuse to interpret.
 */
function classifyDelimiterTail(
	buf: Uint8Array,
	cursor: number,
	end: number,
): { partStart: number } | "final" | "invalid" {
	let i = cursor;
	if (i + 1 < end && buf[i] === DASH && buf[i + 1] === DASH) {
		i += 2;
		while (i < end && (buf[i] === SPACE || buf[i] === TAB)) i++;
		if (i === end) return "final";
		// Anything after the closing line is the epilogue, which is ignored.
		if (startsWith(buf, CRLF, i, end)) return "final";
		return "invalid";
	}
	while (i < end && (buf[i] === SPACE || buf[i] === TAB)) i++;
	if (!startsWith(buf, CRLF, i, end)) return "invalid";
	return { partStart: i + 2 };
}

/**
 * Where a part's body stops.
 *
 * The `total == 0` case in Go's `scanUntilBoundary` is the subtle one: a part
 * whose body is empty is followed *immediately* by `--boundary` with no
 * leading CRLF of its own, because the CRLF that would have preceded it was
 * consumed as the blank line ending the part's headers. Missing that case
 * would swallow the next part into this one's size.
 */
function scanToBoundary(
	buf: Uint8Array,
	bodyStart: number,
	end: number,
	ctx: BoundaryContext,
): { bodyEnd: number; delimEnd: number } | null {
	if (
		startsWith(buf, ctx.dash, bodyStart, end) &&
		isBoundaryFollower(buf, bodyStart + ctx.dash.length, end)
	) {
		return { bodyEnd: bodyStart, delimEnd: bodyStart + ctx.dash.length };
	}
	const i = findDelimiter(buf, bodyStart, end, ctx.nlDash);
	if (i < 0) return null;
	return { bodyEnd: i, delimEnd: i + ctx.nlDash.length };
}

// ── Byte helpers ──────────────────────────────────────────────────────

/**
 * Every CR is followed by LF and every LF is preceded by CR.
 *
 * Two native scans rather than a per-byte loop: this runs over the whole
 * message on every receive, and a 25 MiB attachment should not cost a
 * 25-million-iteration interpreter loop.
 */
function isStrictCrlf(buf: Uint8Array): boolean {
	for (let i = buf.indexOf(LF); i !== -1; i = buf.indexOf(LF, i + 1)) {
		if (i === 0 || buf[i - 1] !== CR) return false;
	}
	for (let i = buf.indexOf(CR); i !== -1; i = buf.indexOf(CR, i + 1)) {
		if (i + 1 >= buf.length || buf[i + 1] !== LF) return false;
	}
	return true;
}

function startsWith(buf: Uint8Array, needle: Uint8Array, at: number, end: number): boolean {
	if (at + needle.length > end) return false;
	for (let i = 0; i < needle.length; i++) {
		if (buf[at + i] !== needle[i]) return false;
	}
	return true;
}

/** First index of `needle` within `[from, end)`, or -1. */
function indexOfSeq(buf: Uint8Array, needle: Uint8Array, from: number, end: number): number {
	const first = needle[0];
	const last = end - needle.length;
	let i = from;
	while (i <= last) {
		const found = buf.indexOf(first, i);
		if (found < 0 || found > last) return -1;
		if (startsWith(buf, needle, found, end)) return found;
		i = found + 1;
	}
	return -1;
}

function countByte(buf: Uint8Array, from: number, to: number, byte: number): number {
	let count = 0;
	for (let i = buf.indexOf(byte, from); i !== -1 && i < to; i = buf.indexOf(byte, i + 1)) {
		count++;
	}
	return count;
}

/** `[from, to)` as a string, one char per byte. Callers guarantee ASCII. */
function asciiSlice(buf: Uint8Array, from: number, to: number): string {
	let out = "";
	const CHUNK = 4096;
	for (let i = from; i < to; i += CHUNK) {
		out += String.fromCharCode(...buf.subarray(i, Math.min(i + CHUNK, to)));
	}
	return out;
}
