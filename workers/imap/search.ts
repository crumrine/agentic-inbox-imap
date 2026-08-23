// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Server-side IMAP SEARCH push-down (DEV-682).
 *
 * ## Why this exists
 *
 * The gateway evaluates SEARCH locally, message by message, against the
 * metadata payload. Anything the payload cannot answer — BODY, TEXT, BCC, a
 * custom header — makes it download the raw message from R2. It is lazy and
 * ordered cheapest-first, with a hard budget of 2000 raw fetches after which
 * it answers `NO [LIMIT]`, so it is bounded but slow and expensive: a
 * `SEARCH SINCE 1-Aug-2026 FROM alice BODY "invoice"` over a 5,000 message
 * folder can pull thousands of raw messages to find three.
 *
 * This module lets the Worker answer the parts it can from SQLite, so the
 * gateway is left with a handful of candidates instead of a folder.
 *
 * ## The two rules
 *
 * 1. **`uids` is the set of messages satisfying every criterion in
 *    `handled`, and nothing else has been applied.** Top-level IMAP search
 *    keys are a conjunction, so the gateway completes the answer by applying
 *    the `unhandled` criteria to the returned uids and to nothing else. That
 *    is only sound because `uids` is a superset of the true answer, which is
 *    the invariant every decision in here protects.
 * 2. **A criterion is either evaluated exactly or reported unhandled.**
 *    There is no third state. An approximate match that reports itself as
 *    handled makes a mail client render a wrong result set with no way to
 *    notice, which is strictly worse than being told the server did half the
 *    job.
 *
 * ## Exactness by construction
 *
 * The matcher does not re-derive anything. It runs against an
 * {@link ImapSearchRow}, which the Durable Object builds with the *same*
 * helpers that build the `/messages` payload — `deriveImapFlags`,
 * `parseAddressList`, `toRfc3339`, the same size expression. So "exact" here
 * means "matches what the gateway would have computed from the metadata it
 * was served", which is the strongest guarantee available and the only one
 * that keeps a pushed-down search and a locally evaluated one agreeing.
 *
 * SQL is used only to *narrow*, never to decide: {@link buildSearchSql} emits
 * a deliberately loose superset and {@link matchSearchRow} makes the call.
 * Every SQL predicate in here therefore only has to be sound (never excludes
 * a true match), not tight.
 *
 * ## What is not handled, and why
 *
 * - **BODY / TEXT.** The `body` column holds the *parsed* body the app
 *   rendered — `parsedEmail.html || parsedEmail.text`, one representation,
 *   never both, and never an attached text part. RFC 9051 BODY searches the
 *   decoded text of every body part. So a `body` column search is neither
 *   sound (it misses a needle that is only in the text/plain alternative, or
 *   in an attachment) nor an obvious superset (a stored HTML body matches
 *   markup a plain-text client never sees). Reporting it as handled would
 *   break rule 2, so it is reported unhandled — and the endpoint still pays
 *   for itself, because the gateway then downloads raw only for the
 *   candidates that survived every other criterion.
 *
 *   If true server-side BODY is ever wanted, the fix is a searchable-text
 *   column derived from the raw bytes at the `storeRawMime` seam, the same
 *   way `body_structure` is — not this column.
 * - **SENTSINCE / SENTBEFORE.** The `Date` header is stored as arbitrary
 *   text (RFC 5322 on one path, ISO 8601 on another) and cannot be compared
 *   in SQL. The gateway already answers these from the metadata it holds,
 *   with no raw fetch, so pushing them down would buy nothing.
 * - **Header keys outside {@link SEARCH_FIELD_BY_HEADER}.** `raw_headers` is
 *   the complete header block only for messages that arrived as bytes
 *   (inbound, APPEND, SUBMIT). The app's own send paths write a hand-built
 *   seven-header subset, so a match on, say, `X-Mailer` would miss those
 *   rows. Per-row completeness is not knowable per-request, so the whole
 *   criterion is unhandled.
 */

import { z } from "zod";

// ── Wire types ────────────────────────────────────────────────────────
//
// These mirror `imap.SearchCriteria` from go-imap v2 field for field, so the
// gateway side is a plain `encoding/json` marshal of the criteria it was
// already handed. Two fields are deliberately absent:
//
//   - `SeqNum`, because sequence numbers are a property of the gateway's
//     snapshot, not of the mailbox. The gateway resolves them to uids.
//   - `ModSeq`, because there is no CONDSTORE support to push down.

/** One inclusive uid range. `end` omitted means "up to the largest uid". */
export interface ImapSearchUidRange {
	start: number;
	end?: number | null;
}

/** One `HEADER <key> <value>` term. FROM/TO/CC/BCC/SUBJECT arrive as these. */
export interface ImapSearchHeaderField {
	key: string;
	value: string;
}

export interface ImapSearchCriteria {
	uid?: ImapSearchUidRange[];
	/** INTERNALDATE >= this date. Date-only comparison, per RFC 9051. */
	since?: string;
	/** INTERNALDATE < this date. */
	before?: string;
	/** `Date:` header comparisons. Reported unhandled — see the module note. */
	sentSince?: string;
	sentBefore?: string;
	flag?: string[];
	notFlag?: string[];
	/** RFC822.SIZE > this. Absent or 0 means unset, as in go-imap. */
	larger?: number;
	/** RFC822.SIZE < this. */
	smaller?: number;
	header?: ImapSearchHeaderField[];
	body?: string[];
	text?: string[];
	not?: ImapSearchCriteria[];
	or?: [ImapSearchCriteria, ImapSearchCriteria][];
}

/**
 * Caps on one request.
 *
 * None of these are tuning knobs. Each bounds work a hostile or careless
 * caller could otherwise hand a Durable Object, and crossing one is a 400
 * rather than a truncation: a silently shortened criteria list is exactly the
 * "wrong result with no indication" this endpoint exists to avoid.
 */
export const SEARCH_MAX_UID_RANGES = 256;
export const SEARCH_MAX_FLAGS = 64;
export const SEARCH_MAX_HEADERS = 32;
export const SEARCH_MAX_STRINGS = 16;
export const SEARCH_MAX_BRANCHES = 16;
export const SEARCH_MAX_PATTERN_CHARS = 1024;
export const SEARCH_MAX_KEY_CHARS = 128;
/** Deepest NOT/OR nesting accepted. */
export const SEARCH_MAX_DEPTH = 8;
/** Most criteria nodes (the root plus every NOT/OR child) accepted. */
export const SEARCH_MAX_NODES = 64;

/**
 * Most rows the matcher will examine for one request.
 *
 * Reaching it is reported as "too large" rather than answered, because this
 * contract has no way to express a truncated `uids` list: the gateway is told
 * to apply the unhandled criteria to `uids` and to nothing else, so dropping
 * matches from it would produce exactly the silent wrong answer rule 1
 * forbids. The gateway falls back to its own local evaluation, which has its
 * own budget and its own `NO [LIMIT]`.
 */
export const IMAP_SEARCH_MAX_SCAN = 20_000;

const FlagPattern = z.string().min(1).max(SEARCH_MAX_KEY_CHARS);
const Pattern = z.string().max(SEARCH_MAX_PATTERN_CHARS);
const DateString = z.string().min(1).max(64);
const Uint32 = z.number().int().min(0).max(4294967295);

/**
 * The request body's `criteria`.
 *
 * Recursive through `not`/`or`, so depth and total node count cannot be
 * expressed here; {@link checkSearchCriteriaSize} enforces both after
 * parsing.
 */
export const ImapSearchCriteriaSchema: z.ZodType<ImapSearchCriteria> = z.lazy(() =>
	z
		.object({
			uid: z
				.array(z.object({ start: Uint32, end: Uint32.nullish() }))
				.max(SEARCH_MAX_UID_RANGES)
				.optional(),
			since: DateString.optional(),
			before: DateString.optional(),
			sentSince: DateString.optional(),
			sentBefore: DateString.optional(),
			flag: z.array(FlagPattern).max(SEARCH_MAX_FLAGS).optional(),
			notFlag: z.array(FlagPattern).max(SEARCH_MAX_FLAGS).optional(),
			larger: z.number().int().min(0).optional(),
			smaller: z.number().int().min(0).optional(),
			header: z
				.array(z.object({ key: z.string().max(SEARCH_MAX_KEY_CHARS), value: Pattern }))
				.max(SEARCH_MAX_HEADERS)
				.optional(),
			body: z.array(Pattern).max(SEARCH_MAX_STRINGS).optional(),
			text: z.array(Pattern).max(SEARCH_MAX_STRINGS).optional(),
			not: z.array(ImapSearchCriteriaSchema).max(SEARCH_MAX_BRANCHES).optional(),
			or: z
				.array(z.tuple([ImapSearchCriteriaSchema, ImapSearchCriteriaSchema]))
				.max(SEARCH_MAX_BRANCHES)
				.optional(),
		})
		// Strict, not stripping. A key this build does not know is a criterion
		// nothing would apply and `classifySearchCriteria` could not report,
		// which is the silent wrong answer rule 1 exists to prevent. A 400 is
		// the only safe reading of "I sent you something you did not use".
		.strict(),
);

/**
 * Enforce the depth and node-count caps the recursive schema cannot.
 *
 * Returns false when the tree is too big, which the route turns into a 400.
 */
export function checkSearchCriteriaSize(criteria: ImapSearchCriteria): boolean {
	let nodes = 0;
	const walk = (node: ImapSearchCriteria, depth: number): boolean => {
		nodes += 1;
		if (depth > SEARCH_MAX_DEPTH || nodes > SEARCH_MAX_NODES) return false;
		for (const child of node.not ?? []) {
			if (!walk(child, depth + 1)) return false;
		}
		for (const [left, right] of node.or ?? []) {
			if (!walk(left, depth + 1)) return false;
			if (!walk(right, depth + 1)) return false;
		}
		return true;
	};
	return walk(criteria, 1);
}

// ── The row the matcher sees ──────────────────────────────────────────

/**
 * One message, projected into exactly the values the `/messages` payload
 * would have carried for it.
 *
 * The Durable Object builds this with the same helpers that build the wire
 * payload, which is what makes "handled" mean "answered identically to a
 * gateway evaluating it locally" rather than "answered by some other rule".
 */
export interface ImapSearchRow {
	uid: number;
	/** RFC 3339, as `internalDate` on the wire. */
	internalDate: string;
	/** RFC822.SIZE, from the same expression the metadata endpoint uses. */
	size: number;
	/** The complete derived FLAGS list, `\Draft` included. */
	flags: string[];
	subject: string;
	/** Envelope addresses rendered `Name <addr>`, as the gateway renders them. */
	from: string[];
	to: string[];
	cc: string[];
	/**
	 * The stored Bcc list, rendered the same way.
	 *
	 * Bcc is not part of an IMAP envelope, so the gateway can only answer
	 * `SEARCH BCC` by downloading the raw message — and for outbound mail it
	 * is the one header a recipient's copy never carries. The column is the
	 * authoritative record of who was blind-copied, so answering from it is
	 * both cheaper and better than parsing bytes.
	 */
	bcc: string[];
	messageId: string;
	inReplyTo: string;
}

// ── Classification ────────────────────────────────────────────────────

/** A field the matcher can evaluate, and the header keys that reach it. */
export type ImapSearchField =
	| "subject"
	| "from"
	| "to"
	| "cc"
	| "bcc"
	| "messageId"
	| "inReplyTo";

/**
 * Header keys this module can answer, lower-cased.
 *
 * `date` is deliberately absent: the envelope date falls back to
 * INTERNALDATE when the header is missing, and that fallback happens in JS
 * at projection time, so there is no column holding the string a
 * `HEADER DATE` substring search would have to match.
 */
export const SEARCH_FIELD_BY_HEADER: Readonly<Record<string, ImapSearchField>> = {
	subject: "subject",
	from: "from",
	to: "to",
	cc: "cc",
	bcc: "bcc",
	"message-id": "messageId",
	"in-reply-to": "inReplyTo",
};

/** The four fields whose stored value is an address list, not plain text. */
const ADDRESS_FIELDS: ReadonlySet<ImapSearchField> = new Set([
	"from",
	"to",
	"cc",
	"bcc",
]);

/** The handled subset of a criteria tree, normalised for evaluation. */
export interface HandledCriteria {
	uid?: { start: number; end: number }[];
	/** `YYYY-MM-DD`, UTC. */
	since?: string;
	before?: string;
	flag?: string[];
	notFlag?: string[];
	larger?: number;
	smaller?: number;
	header?: { field: ImapSearchField; pattern: string }[];
	not?: HandledCriteria[];
	or?: [HandledCriteria, HandledCriteria][];
}

export interface SearchClassification {
	/** Tokens for the criteria that `handled` evaluates. */
	handled: string[];
	/** Tokens for the criteria the caller must still apply itself. */
	unhandled: string[];
	/** Only the handled criteria, normalised. */
	tree: HandledCriteria;
}

const MAX_UID = 4294967295;

/**
 * Split a criteria tree into what this module evaluates and what it does not.
 *
 * Tokens are positional paths — `"since"`, `"header[1]"`, `"flag[0]"`,
 * `"or[0]"` — so the caller can map each one back to the exact term it sent
 * even when two terms share a key. A NOT or OR node is reported as a single
 * token and is handled only when *every* leaf inside it is: a negation over a
 * partially evaluated subtree flips a superset into a subset, which is the
 * one direction rule 1 cannot survive.
 */
export function classifySearchCriteria(criteria: ImapSearchCriteria): SearchClassification {
	const handled: string[] = [];
	const unhandled: string[] = [];
	const tree: HandledCriteria = {};

	if (criteria.uid && criteria.uid.length > 0) {
		tree.uid = criteria.uid.map((range) => ({
			start: range.start,
			end: range.end === undefined || range.end === null ? MAX_UID : range.end,
		}));
		handled.push("uid");
	}

	for (const key of ["since", "before"] as const) {
		const raw = criteria[key];
		if (raw === undefined) continue;
		const day = utcDay(raw);
		if (day === null) {
			// An unparseable bound cannot be applied, and guessing at it would
			// silently widen or narrow the result set.
			unhandled.push(key);
			continue;
		}
		tree[key] = day;
		handled.push(key);
	}

	for (const key of ["sentSince", "sentBefore"] as const) {
		if (criteria[key] !== undefined) unhandled.push(key);
	}

	for (const key of ["flag", "notFlag"] as const) {
		const list = criteria[key];
		if (!list) continue;
		// Every flag the payload can carry is decidable from the derived FLAGS
		// list, including keywords and including \Recent (which this server
		// never sets, so it simply never matches).
		tree[key] = [...list];
		list.forEach((_, i) => handled.push(`${key}[${i}]`));
	}

	if (criteria.larger) {
		tree.larger = criteria.larger;
		handled.push("larger");
	}
	if (criteria.smaller) {
		tree.smaller = criteria.smaller;
		handled.push("smaller");
	}

	criteria.header?.forEach((entry, i) => {
		const field = SEARCH_FIELD_BY_HEADER[entry.key.trim().toLowerCase()];
		if (!field) {
			unhandled.push(`header[${i}]`);
			return;
		}
		(tree.header ??= []).push({ field, pattern: entry.value });
		handled.push(`header[${i}]`);
	});

	criteria.body?.forEach((_, i) => unhandled.push(`body[${i}]`));
	criteria.text?.forEach((_, i) => unhandled.push(`text[${i}]`));

	criteria.not?.forEach((child, i) => {
		const sub = classifySearchCriteria(child);
		if (sub.unhandled.length > 0) {
			unhandled.push(`not[${i}]`);
			return;
		}
		(tree.not ??= []).push(sub.tree);
		handled.push(`not[${i}]`);
	});

	criteria.or?.forEach(([left, right], i) => {
		const a = classifySearchCriteria(left);
		const b = classifySearchCriteria(right);
		if (a.unhandled.length > 0 || b.unhandled.length > 0) {
			// Either branch can carry the match, so an OR is only decidable
			// when both branches are.
			unhandled.push(`or[${i}]`);
			return;
		}
		(tree.or ??= []).push([a.tree, b.tree]);
		handled.push(`or[${i}]`);
	});

	return { handled, unhandled, tree };
}

/** `2026-01-31` or `2026-01-31T00:00:00Z` -> `2026-01-31`. Null if unparseable. */
function utcDay(value: string): string | null {
	const parsed = new Date(value.trim());
	if (Number.isNaN(parsed.getTime())) return null;
	return parsed.toISOString().slice(0, 10);
}

// ── Exact evaluation ──────────────────────────────────────────────────

/**
 * Does this message satisfy every handled criterion?
 *
 * This is the decision. The SQL below only ever narrows what reaches here.
 */
export function matchSearchRow(row: ImapSearchRow, tree: HandledCriteria): boolean {
	if (tree.uid && !tree.uid.some((r) => row.uid >= r.start && row.uid <= r.end)) {
		return false;
	}

	if (tree.since || tree.before) {
		// IMAP compares dates, not instants: the message's INTERNALDATE is
		// truncated to its UTC day before the comparison, exactly as the
		// gateway's matchDate does.
		const day = row.internalDate.slice(0, 10);
		if (tree.since && day < tree.since) return false;
		if (tree.before && day >= tree.before) return false;
	}

	if (tree.flag) {
		for (const flag of tree.flag) {
			if (!hasFlag(row.flags, flag)) return false;
		}
	}
	if (tree.notFlag) {
		for (const flag of tree.notFlag) {
			if (hasFlag(row.flags, flag)) return false;
		}
	}

	if (tree.larger !== undefined && row.size <= tree.larger) return false;
	if (tree.smaller !== undefined && row.size >= tree.smaller) return false;

	if (tree.header) {
		for (const { field, pattern } of tree.header) {
			if (!matchStrings(fieldValues(row, field), pattern)) return false;
		}
	}

	for (const child of tree.not ?? []) {
		if (matchSearchRow(row, child)) return false;
	}
	for (const [left, right] of tree.or ?? []) {
		if (!matchSearchRow(row, left) && !matchSearchRow(row, right)) return false;
	}

	return true;
}

/** RFC 9051 §2.3.2: keywords and system flags are case-insensitive. */
function hasFlag(flags: string[], want: string): boolean {
	const lower = want.trim().toLowerCase();
	return flags.some((flag) => flag.trim().toLowerCase() === lower);
}

/**
 * Substring match, case-insensitive, over a field's values.
 *
 * An empty pattern means "this field is present", which is what
 * `SEARCH HEADER SUBJECT ""` asks and what the gateway's matchStrings does.
 */
function matchStrings(values: string[], pattern: string): boolean {
	if (pattern === "") return values.length > 0;
	const needle = pattern.toLowerCase();
	return values.some((value) => value.toLowerCase().includes(needle));
}

function fieldValues(row: ImapSearchRow, field: ImapSearchField): string[] {
	switch (field) {
		case "from":
			return row.from;
		case "to":
			return row.to;
		case "cc":
			return row.cc;
		case "bcc":
			return row.bcc;
		case "subject":
			return nonEmpty(row.subject);
		case "messageId":
			return nonEmpty(row.messageId);
		case "inReplyTo":
			return nonEmpty(row.inReplyTo);
	}
}

function nonEmpty(value: string): string[] {
	return value.trim() === "" ? [] : [value];
}

// ── SQL narrowing ─────────────────────────────────────────────────────

/**
 * The SQL expressions the caller's schema uses for each searchable value.
 *
 * Passed in rather than written here so this module never imports the Durable
 * Object (which imports it), and so the size and header expressions stay
 * literally the same strings the metadata query uses.
 */
export interface ImapSearchColumns {
	uid: string;
	/** The stored internal date, as text. */
	internalDate: string;
	/** RFC822.SIZE, already coalesced with the legacy estimate. */
	size: string;
	read: string;
	answered: string;
	starred: string;
	deleted: string;
	subject: string;
	from: string;
	to: string;
	cc: string;
	bcc: string;
	messageId: string;
	inReplyTo: string;
}

export interface SearchSql {
	/** Conditions to AND into the WHERE clause. Possibly empty. */
	conditions: string[];
	/** Positional parameters, in order, starting at `firstParamIndex`. */
	params: (string | number)[];
}

/**
 * The four system flags that are boolean columns. `\Draft` is a property of
 * the folder and is folded into a constant; everything else (keywords,
 * `\Recent`) is left to the matcher.
 */
const FLAG_COLUMN: Readonly<Record<string, keyof ImapSearchColumns>> = {
	"\\seen": "read",
	"\\answered": "answered",
	"\\flagged": "starred",
	"\\deleted": "deleted",
};

/**
 * Characters that {@link ImapSearchRow} rendering can insert or remove around
 * a value, and which therefore cannot appear in a token used to prefilter.
 *
 * `parseAddressList` re-renders an address as `name <address>`, so the space,
 * the angle brackets and the comma separators are glue rather than content.
 * Backslash and quote go because unquoting rewrites them.
 */
const TOKEN_SPLIT = /[\s<>"'(),\\]+/;

/**
 * Values whose Unicode lowercasing produces ASCII that SQLite's ASCII-only
 * `LIKE` folding does not.
 *
 * `İ`.toLowerCase() is `i` + a combining dot, `K` (Kelvin sign) lowercases to
 * `k`, and `ſ` (long s) to `s`. A row containing one of these can match an
 * ASCII needle in the matcher while failing `LIKE` in SQLite, so any row
 * containing one is admitted unconditionally. Without this the prefilter
 * would be unsound, which is the one thing it may not be.
 */
const ASCII_FOLD_ESCAPES = ["İ", "K", "ſ"];

/**
 * Build the WHERE conditions that narrow the candidate set.
 *
 * **Every condition here must be a sound superset**: it may admit rows that
 * do not match, never exclude rows that do. {@link matchSearchRow} makes the
 * actual decision, so looseness costs a little scanning and nothing else,
 * while tightness that is wrong costs correctness.
 *
 * Only top-level conjunctive terms contribute. NOT and OR nodes are left out
 * entirely — the negation of a superset is a subset, and a disjunction is
 * only as narrow as its widest branch — so they are decided in JS.
 *
 * `firstParamIndex` is the 1-based number of the first `?N` placeholder this
 * builder may use, so the caller can bind its own parameters first.
 */
export function buildSearchSql(
	tree: HandledCriteria,
	columns: ImapSearchColumns,
	isDraftFolder: boolean,
	firstParamIndex: number,
): SearchSql {
	const conditions: string[] = [];
	const params: (string | number)[] = [];
	let index = firstParamIndex - 1;
	const bind = (value: string | number): string => {
		index += 1;
		params.push(value);
		return `?${index}`;
	};

	if (tree.uid) {
		const ranges = tree.uid.map((r) => `${columns.uid} BETWEEN ${bind(r.start)} AND ${bind(r.end)}`);
		conditions.push(`(${ranges.join(" OR ")})`);
	}

	// A stored date SQLite cannot parse yields NULL, and the matcher may still
	// read it as a real instant, so those rows have to pass through.
	if (tree.since) {
		conditions.push(
			`(date(${columns.internalDate}) >= date(${bind(tree.since)}) OR date(${columns.internalDate}) IS NULL)`,
		);
	}
	if (tree.before) {
		conditions.push(
			`(date(${columns.internalDate}) < date(${bind(tree.before)}) OR date(${columns.internalDate}) IS NULL)`,
		);
	}

	for (const flag of tree.flag ?? []) {
		const condition = flagCondition(flag, columns, isDraftFolder, true);
		if (condition) conditions.push(condition);
	}
	for (const flag of tree.notFlag ?? []) {
		const condition = flagCondition(flag, columns, isDraftFolder, false);
		if (condition) conditions.push(condition);
	}

	if (tree.larger !== undefined) conditions.push(`${columns.size} > ${bind(tree.larger)}`);
	if (tree.smaller !== undefined) conditions.push(`${columns.size} < ${bind(tree.smaller)}`);

	for (const { field, pattern } of tree.header ?? []) {
		const condition = headerCondition(field, pattern, columns, bind);
		if (condition) conditions.push(condition);
	}

	return { conditions, params };
}

function flagCondition(
	flag: string,
	columns: ImapSearchColumns,
	isDraftFolder: boolean,
	want: boolean,
): string | null {
	const lower = flag.trim().toLowerCase();
	if (lower === "\\draft") {
		// Constant for the whole folder, so it is either free or decisive.
		return isDraftFolder === want ? "1 = 1" : "1 = 0";
	}
	const column = FLAG_COLUMN[lower];
	if (!column) return null; // keyword or \Recent: the matcher decides.
	return `COALESCE(${columns[column]}, 0) = ${want ? 1 : 0}`;
}

/**
 * A sound superset predicate for one header criterion, or null when no useful
 * one exists (in which case the matcher sees every candidate).
 */
function headerCondition(
	field: ImapSearchField,
	pattern: string,
	columns: ImapSearchColumns,
	bind: (value: string | number) => string,
): string | null {
	// "field is present" cannot be narrowed usefully: an empty column and an
	// unparseable one are both non-matches the matcher has to sort out.
	if (pattern === "") return null;

	const token = longestAsciiToken(pattern);
	if (!token) return null;

	const column = columns[field];
	const terms = [`${column} LIKE ${bind(`%${escapeLike(token)}%`)} ESCAPE '\\'`];
	for (const escape of ASCII_FOLD_ESCAPES) {
		terms.push(`${column} LIKE ${bind(`%${escape}%`)} ESCAPE '\\'`);
	}

	if (ADDRESS_FIELDS.has(field)) {
		// Rendering an address decodes RFC 2047 encoded words, strips
		// quoted-string quoting and drops comments. A value carrying any of
		// those can render into text the raw column does not contain, so it
		// has to be admitted and left to the matcher. A value carrying none of
		// them renders to substrings of itself, which is what makes the token
		// test above sound.
		for (const marker of ["=?", '"', "("]) {
			terms.push(`${column} LIKE ${bind(`%${escapeLike(marker)}%`)} ESCAPE '\\'`);
		}
	}

	return `(${terms.join(" OR ")})`;
}

/**
 * The longest run of the pattern that survives address rendering intact, or
 * null when there is none (or when it is not plain ASCII, where SQLite's
 * ASCII-only `LIKE` folding cannot be trusted to agree with the matcher's
 * Unicode `toLowerCase`).
 */
function longestAsciiToken(pattern: string): string | null {
	let best = "";
	for (const token of pattern.split(TOKEN_SPLIT)) {
		if (token.length > best.length) best = token;
	}
	if (best === "") return null;
	// Non-ASCII: SQLite folds case for ASCII only, so `LIKE` could reject a
	// row the matcher's Unicode `toLowerCase` would accept. No prefilter is
	// slower; an unsound one is wrong.
	if (/[^\x00-\x7f]/.test(best)) return null;
	return best;
}

/** Escape the LIKE metacharacters, for `ESCAPE '\'`. */
function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, "\\$&");
}
