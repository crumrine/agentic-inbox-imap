# Shadow scoring and manual feedback (DEV-878)

This document describes source behavior. OPS-615 owns the manual deployment and
live receipts; merging source does not establish production activation. GitHub
Actions and automatic Cloudflare Builds remain paused.

Missing `MAIL_SCORING_MODE` or `off` makes no scoring calls. `shadow` records an
assessment without moving mail. `filter` scores once per new resolved arrival
through the private `MAIL_SCORER` service binding, then applies the recoverable
policy in [quarantine.md](quarantine.md). Reads, refreshes, IMAP and ordinary moves
do not score again. Failures retain Inbox delivery; there is no historical scan.

## Current source compatibility

The reconciled source uses scorer `eaa4aa0ab1be6f017d37cd1347e8727e5960751e`, `rules-11` and policy `inbox-scoring-10`; the decoder retains `rules-1` through `rules-10` and stored policies through `inbox-scoring-9`. The new brand reason is accepted only under rules-11. The balanced statistical reason remains valid under both rules-10 and rules-11 for caller-first rollout. [HTML inspection](html-inspection.md) and [reconciliation evidence](evidence/html-reconcile/README.md) describe the current checks.

## Historical source pins and compatibility (DEV-1018)

The following records the earlier rules-9 source state and is retained as history.

The current contract and protocol copies come from merged `mail-scoring` PR #19,
`453cc3423e222b0e853bf3d8e9d590ee01e44bf7`, with only the protocol import path
changed. The engine remains `0.1.0`, schema/RPC remain `1`, and the rules are
`rules-9`. No scanner package or new dependency is imported into Inbox. The
independent scorer contains the bounded parser and frozen public-corpus model;
see that repository's `docs/contextual-precision.md` for provenance and limitations.

The strict decoder accepts `rules-1 | rules-2 | rules-3 | rules-4 | rules-5 | rules-6 | rules-7 | rules-8 | rules-9`, rejects GTUBE under
rules-1, and rejects statistical reasons/new HTML or statistics limits under
older rule sets. Unknown versions/reasons, altered static text, inconsistent or
nonfinite contributions, JSON depth over 6 and output over 4096 UTF-8 bytes are
rejected. Invented authentication or preferences are also rejected.

The arrival policy is now `inbox-scoring-8`. Storage also accepts historical
`inbox-shadow-1`, `inbox-scoring-2`, `inbox-scoring-3`, `inbox-scoring-4`, `inbox-scoring-5`, `inbox-scoring-6` and `inbox-scoring-7` assessments without rewriting their policy or rule version.
There is no schema migration or old-mail re-evaluation.

`node scripts/check-scoring-contract.mjs /path/to/mail-scoring` requires the exact
current pin. `evidence/dev-1018/contract.json` records contract digests, current
plain/HTML general-spam results, and actual previous rules-2
(`faa15bea06db52f2dc240257d5335a66a933f909`) and legacy rules-1
(`2fab406320ae3b3596345d2c76e0ef8a08593211`) compatibility.
Historical general-1/2/3/4/5/6 statistical evidence remains readable but does not trigger automatic generic routing. GTUBE remains supported under rules-2–9. Statistical reasons are accepted only under their exact rule version; new `statistical_word_pair_spam` is valid only under rules-9. Tests run nine actual private Worker versions, including the deployed rules-5 scorer and failed rules-8 scorer62919bc8f939bc94c0552fc6a3917c03a3373646. Historical policy7/refit8 survives restart, REST Not spam and IMAP rescue with unchanged assessments and no scorer calls.
Historical rules-7/robust evidence (archived scorer143e24e938365c31f2669fd5f9e918408383dc7e) and policy6 remain strictly readable and recoverable; they never activate generic routing. Historical evidence remains unchanged in its original directories.

### Manual rollout and rollback

OPS-615 requires reviewed merged source, DEV-1009 paired held-out acceptance,
independent review of the exact artifacts/plan, and fresh production config
receipts. Deploy this caller before the rules-9 private scorer. The caller works
with either older scorer while the transition happens. No public scorer route,
preview, new binding, gateway change or automatic workflow is needed.

To stop future automatic routing, use this compatible caller with mode `shadow`
or `off`; stored mail, folders, UIDs, preferences and assessments remain intact.
To roll the scorer back, use only the approved rules-5 artifact and retain this caller so stored rules-9/policy8 assessments remain readable. Failed rules-6/7/8 are never rollback targets. Keep this caller in shadow/off mode when stopping routing.
A source merge alone does not prove any of these operations occurred.

## Inspection bounds and inherited limits

Before scoring extraction, inspect only raw buffers up to 131072 bytes and
skip scoring for larger buffers or a stream whose actual byte count differs from its declared size. A complete MIME message containing NUL bytes remains eligible; binary attachment bytes are never projected. The stream reader explicitly supplies byte completeness, and missing/false completeness always skips scoring. This is a scoring limit,
not a mail acceptance limit. Off skips this inspection altogether. The current
intake still buffers and parses accepted mail up to its inherited 25 MiB
limit with PostalMime 2.7.3, before mailbox resolution. Raw storage also derives
BODYSTRUCTURE. Those existing parsers are not made CPU/memory-safe by these
new limits; no inherited MIME parsing safety or arbitrary nesting guarantee is
claimed. The inherited short-stream zero padding behavior is unchanged.

Projection uses the already-parsed subject (2048 bytes), plain text (32768),
From/display name/first Reply-To/envelope From (512 each). It checks string
length before bounded UTF-8 allocation and omits entire over-limit fields.
At most 100 existing headers are considered; only List-Id, List-Unsubscribe
and Precedence are forwarded (2048 bytes/value, conservative 8192-byte total).
Plain-text HTTP(S) tokens and encoded HTTP(S) schemes use the existing `urls`
field, capped at 100 tokens and 2048 UTF-8 bytes per token. The 32768-byte body
ceiling bounds the linear line/token scans before URL parsing. Quote prefixes
are checked with C0/C1/bidi controls removed; quoted lines and the remainder
after an original/forwarded-message divider are omitted. URL bytes retain their
original spelling, with trailing prose punctuation removed by a linear scan.
Original token bytes are checked before trimming, and balanced IPv6 authority
brackets are retained. Oversized tokens,
controls, count/work ceilings and quoted omissions mark `sourceComplete:false`.
The scorer retains its bounded decoding, URL diagnostics and contribution caps.
When meaningful bounded plain text is absent, a bounded HTML field (32768 UTF-8
bytes) is supplied to the scorer's inert text parser. A present oversized plain
body is never replaced with HTML. Omitted plain or selected HTML bodies make
inspection unavailable before RPC. HTML visibility remains incomplete; no HTML
anchors/URLs are extracted by Inbox and no mail URLs are fetched. Hidden/quoted
and parser work-limit handling is documented in the scorer. No attachment data,
raw MIME, mailbox IDs, credentials or raw storage keys enter the scorer.
Omissions, duplicates and truncation remain incomplete. Final serialization
is bounded by the pinned 262144-byte wire ceiling. A 1000ms wait limit does
not cancel an RPC or synchronous CPU. Static failures are stored without
logging service errors or attacker strings. If optional assessment storage
itself fails, delivery is retained and the read API reports unknown/unscored.

### Inline forwarded MIME reports (DEV-1001)

PostalMime 2.7.3 can flatten an inline `message/rfc822` into the parsed body,
including a generated separator and From/Subject/Date/recipient header block.
After the existing 32 KiB field preflight, the scoring projection recognizes
that generated plain-text header pattern, replaces the whole scoring body with
a redacted `>` quote marker and marks the input incomplete. The marker retains
the existing `quoted_content` limit, so copied phishing subjects or display
labels cannot bypass the ordinary partial-inspection guard. Raw MIME, stored display content and attachments
remain intact. Explicit sender preferences and other bounded metadata remain
available; normal current-body phishing and GTUBE controls are unchanged.

This is conservative recognition of a known formatter pattern, not complete
nested-MIME provenance. Omitting the entire scoring body can miss direct spam
in a message that also forwards another message. It does not classify the
retained report as safe. No MIME parser option, schema or gateway changes were
made by DEV-1001. DEV-998 also recognizes PostalMime's generated HTML
`class="postal-email-header"` wrapper on selected HTML and preserves the same
redacted quote marker. Recognition is bounded and specific to this formatter.
OPS-614 owns the separately gated manual rollout.

The authored legitimate inline report fails as Inbox-to-Spam on the unfixed
code. Joined tests check four nested-header variants, stored partial evidence,
unchanged raw/display, restart, REST and IMAP UID/raw retrieval, with one score
per arrival. A copied phishing subject still scores 45 but remains in Inbox
with explicit quoted inspection, while direct current-body phishing at 45 still
routes to Spam. Inspectable forwarded reports still honor explicit sender
blocks through successful partial scoring. Removal/restored mutations prove omission,
quote-state and over-budget failure
regressions; ordinary
separator/header-like controls and 15 within-budget growth cases retain the
existing URL regressions. Set `EVIDENCE_DIR=docs/evidence/dev-1001` when running
the contract, scoring-mutation and projection-growth scripts to preserve older
receipts.

If the plain body exceeds the existing field budget, optional inspection is
unavailable and no RPC runs. That also protects large forwarded reports whose
generated header marker was omitted with the body: subject-only clues cannot
route them automatically. Raw delivery is retained; unavailable inspection is
distinct from a scored zero. Explicit block routing still requires successful
inspection, as it does for other inspection failures.

DEV-993 adoption map uses original synthetic fixtures and implementation. The
Rspamd composite-test approach inspired exact reason/contribution/disposition
assertions; no Rspamd code, weights or corpus was copied. Existing Mailguard-derived
`linkTarget` remains in the pinned scorer, with its existing MIT notices. This
change fills only the missing plain-text projection, reusing the current wire
contract, limits, reasons and family caps. Existing tests cover GTUBE, recovery,
MIME, RPC failures and inert preview; added tests cover projection, omissions,
ordinary-link negatives, exact combined contributions and removal/bound mutations.
Run `node scripts/projection-growth.mjs` for the hostile within-budget token
growth control; its original-token and IPv6 regressions are also in the joined suite.

Existing routing is preserved: envelope first, then To candidates, allowlist,
mailbox/alias/wildcard resolution, one mailbox per receive event. To-less mail
still follows existing rejection behavior; Bcc with a usable unrelated To
header is supported. Raw bytes, attachments, thread behavior and central UID
allocation are unchanged. There is no new inbound AI or outbound mail action.

## Storage and explicit actions

Append-only migration 13 adds mailbox-local `spam_assessments`,
`spam_dispositions` and `sender_preferences`. Drizzle definitions mirror SQL.
Assessment version 1 is immutable, with the original rule contributions,
versions and completeness; no message body copy is stored. Existing rows have
no assessment, disposition unknown, revision 0. Foreign keys cascade on actual
message deletion. Sender preferences survive deletion, as explicit choices.

All endpoints below are under `/api/v1/mailboxes/:mailboxId`:

- `GET /emails/:emailId/spam`: original assessment and manual disposition/revision.
- `POST /spam-feedback`: `{emailId, disposition: "spam" | "not_spam", expectedRevision}`.
- `GET /sender-preference?sender=...`: sender preference/revision.
- `POST /sender-preference`: `{sender, preference: "allow" | "block" | "none", expectedRevision}`.

Writes require a verified human Access JWT (`email`, no `common_name`), exact
same-origin Origin, `Sec-Fetch-Site: same-origin`, JSON and
`X-Inbox-Manual-Action: 1`. Bodies are limited to 2048 bytes/depth 4 before
parsing. Service tokens keep their existing API access but cannot authorize
these writes. DEV authentication bypass does not authorize feedback. Agent/MCP
registries do not expose these actions. Shared tools require an in-process
capability minted at this REST boundary; a JSON actor/boolean cannot create it.
This prevents email/model tool arguments from becoming persistent preferences;
it is not proof of a physical human click by arbitrary clients holding a human
JWT. Access remains the existing shared app policy, not per-user mailbox ACLs.

Mutation checks and writes are in `transactionSync`. Repeating the same action
at its original/current revision is idempotent; stale conflicting changes
return 409. Unknown messages/other-mailbox IDs return 404. Sender clear uses a
`none` tombstone so stale revisions cannot resurrect an older choice. Feedback
never changes folder placement or creates a preference. Stored preferences are
passed as verified mailbox-local facts for subsequent shadow assessments only;
address allow does not erase other evidence or establish authentication.

## Transport provenance and pending live checks

Cloudflare's email handler exposes envelope from/to, raw and Headers. These
interfaces alone do not establish the authorship of Authentication-Results,
ARC or x-spam header text. No header name, claimed authserv-id or duplicate
aggregation proves provenance. This implementation passes envelope From only
as a lexical address and always sets transport provenance unknown, SPF/DKIM/
DMARC unknown, complete false and context `transportVerified:false`. Auth
header strings are never sent to the scorer. No DNS/auth replay/IP blocklists.

Reference: https://developers.cloudflare.com/email-service/api/route-emails/email-handler/ .
The ticket's independent Mailguard evaluation is supplied evidence, not a
benchmark rerun here. Its forged lone header finding reinforces this boundary.
Live intake/header availability, per-message provenance, hosted CPU/billing,
classification efficacy and thresholds remain pending separately authorized
owner observation. No live private message capture is authorized or performed.
