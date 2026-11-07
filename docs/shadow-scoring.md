# Shadow scoring and manual feedback (DEV-878)

Source-only integration. No deployment or activation is authorized by this PR.
Missing `MAIL_SCORING_MODE` (or `off`) makes zero scoring calls and performs no
scoring-only projection. An operator may later configure `shadow` and a private
service binding named `MAIL_SCORER` after separately authorizing release. No
production binding or mode change is included here. Example binding only:

```json
{"services":[{"binding":"MAIL_SCORER","service":"mail-scoring-private"}],"vars":{"MAIL_SCORING_MODE":"shadow"}}
```

Use the actual approved scorer's configured Worker name at release time; this
example does not provision a Worker. Score once per resolved incoming arrival.
Reads, UI's 30-second refresh, IMAP and routine moves never call the scorer.
There is no historical scan or re-evaluation endpoint. Shadow never moves mail.
The later owner-authorized `filter` mode uses the same scoring path with the
recoverable new-arrival routing policy in `quarantine.md`. Scoring failures keep
delivery in Inbox. Returning to `shadow` disables automatic routing.

## Source pins and compatibility

Inbox base: `d01da09e26adf76ef8fe60e2a5f76226426a167b` (initial `DEV-878`);
updated in `DEV-989` on Inbox `main` `08b92457015b3615e325cf4b57954daa12a628c2`.
Scorer (`DEV-988` merged PR #6): https://github.com/crumrine/mail-scoring at
`faa15bea06db52f2dc240257d5335a66a933f909` (`rules-2`, advancing from `rules-1`
main baseline `2fab406320ae3b3596345d2c76e0ef8a08593211` and historical PR #3
pin `bb02819e4662e1d680805435dd886e3dc4728906`).
`workers/lib/mail-scoring/{contract,protocol}.ts` are Apache-2.0 copies from
`packages/core/src/contract.ts` and `workers/private/protocol.ts` at that pin;
only the protocol import path changes. No Mailguard source or scanner package
is imported into Inbox. Digests and real pinned scorer responses are in
`evidence/dev-989/contract.json` (preserving historical `evidence/dev-878/contract.json`).
Reproduce with `node scripts/check-scoring-contract.mjs ../mail-scoring` at the exact pin.

RPC: `scoreV1('1', Uint8Array UTF-8 JSON, context JSON)` returns bounded JSON.
Supported results: schema `1`, engine `0.1.0`, rules `rules-1` or `rules-2`.
`decodeResponse` accepts both `rules-1` and `rules-2` for caller-first rollout
and stored-assessment readability, rejects `id === "gtube"` when
`ruleSetVersion === "rules-1"`, and rejects unknown versions/rules/reasons,
inconsistent/nonfinite contributions, malformed JSON, depth >6 and >4096-byte
output. Unknown remains distinct from safe. Responses inventing trusted
authentication or preferences not supplied by this mailbox are rejected.

### Rollout and rollback order (`rules-1` ↔ `rules-2`)

1. **Caller-first rollout**: Deploy the updated Agentic Inbox caller (`DEV-989`,
   accepting `rules-1 | rules-2`) **before** deploying the `rules-2` `mail-scoring`
   Worker (`faa15bea06db52f2dc240257d5335a66a933f909`). While the caller is on
   `DEV-989` and the deployed scorer is still on `2fab406320ae3b3596345d2c76e0ef8a08593211`
   (`rules-1`), `rules-1` assessments continue validating and routing normally.
   Once the `rules-2` scorer is deployed (`OPS-599`), validated `gtube` arrivals
   route to Spam in `filter` mode (unless overridden by an explicit sender `allow`
   preference), and existing stored `rules-1` rows remain readable.
2. **Rollback**:
   - To disable automatic Spam routing immediately without redeploying scorer code,
     set `MAIL_SCORING_MODE=shadow` (or `off`). Stored mail, UIDs, preferences and
     prior `rules-1`/`rules-2` assessments remain intact.
   - To roll back the scorer Worker to `2fab406320ae3b3596345d2c76e0ef8a08593211`
     (`rules-1`), keep the `DEV-989` caller deployed; it accepts `rules-1` RPC
     responses and continues reading stored `rules-2` assessments.
   - Only roll the Inbox caller back to `08b92457015b3615e325cf4b57954daa12a628c2`
     (`rules-1`-only) after the scorer has been rolled back to `rules-1` or
     `MAIL_SCORING_MODE` is `off`.

Eventual merge order, only after separate authorization: mail-scoring #1
(`ce6d9afedf607584c150d457f0e078a307047f8a`) → #2
(`8456996596af6446f533cacb90ff9ce2ecd1a4ab`) → #3 → Inbox DEV-878 → DEV-879.
Inbox targets its own main; it cannot share Git ancestry with the scorer.
Old unmerged Inbox performance PRs #5 and #6 are not included.

## Inspection bounds and inherited limits

Before scoring extraction, inspect only raw buffers up to 131072 bytes and
skip scoring for larger buffers or zero padding. This is a scoring limit,
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
No HTML, URLs/anchors extracted from HTML, attachment data,
raw MIME, mailbox IDs, credentials or raw storage keys enter the scorer.
Omissions, duplicates and truncation remain incomplete. Final serialization
is bounded by the pinned 262144-byte wire ceiling. A 1000ms wait limit does
not cancel an RPC or synchronous CPU. Static failures are stored without
logging service errors or attacker strings. If optional assessment storage
itself fails, delivery is retained and the read API reports unknown/unscored.

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
