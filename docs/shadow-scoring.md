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

## Source pins and compatibility

Inbox base: `d01da09e26adf76ef8fe60e2a5f76226426a167b`.
Scorer: https://github.com/crumrine/mail-scoring/pull/3 at
`bb02819e4662e1d680805435dd886e3dc4728906`, still unmerged when inspected.
`workers/lib/mail-scoring/{contract,protocol}.ts` are Apache-2.0 copies from
`packages/core/src/contract.ts` and `workers/private/protocol.ts` at that pin;
only the protocol import path changes. No Mailguard source or scanner package
is imported into Inbox. Digests and a real pinned scorer response are in
`evidence/dev-878/contract.json`. Reproduce with
`node scripts/check-scoring-contract.mjs ../mail-scoring` at the exact pin.

RPC: `scoreV1('1', Uint8Array UTF-8 JSON, context JSON)` returns bounded JSON.
Supported result: schema `1`, engine `0.1.0`, rules `rules-1`. Strict response
validation rejects unknown versions/rules/reasons, inconsistent/nonfinite
contributions, malformed JSON, depth >6 and >4096-byte output. Unknown remains
distinct from safe. Responses inventing trusted authentication or preferences
not supplied by this mailbox are rejected.

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
No HTML, URLs/anchors extracted from HTML, attachment data, body duplication,
raw MIME, mailbox IDs, credentials or raw storage keys enter the scorer.
Omissions, duplicates and truncation remain incomplete. Final serialization
is bounded by the pinned 262144-byte wire ceiling. A 1000ms wait limit does
not cancel an RPC or synchronous CPU. Static failures are stored without
logging service errors or attacker strings. If optional assessment storage
itself fails, delivery is retained and the read API reports unknown/unscored.

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
