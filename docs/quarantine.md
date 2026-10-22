# Recoverable Spam (DEV-879)

Source-only change, stacked on Inbox PR #7 at
`7cc31772b0ca17ec28ea4d78367e41e0a24e5ce5`. Scorer PR #3 remains pinned at
`bb02819e4662e1d680805435dd886e3dc4728906`; no scorer or gateway code changes.
Future authorized merge order: mail-scoring #1 (`ce6d9afedf607584c150d457f0e078a307047f8a`),
#2 (`8456996596af6446f533cacb90ff9ce2ecd1a4ab`), #3, Inbox #7, this PR.
No merge, release, deployment, live mail or provider testing is authorized here.

## Policy and recovery

The existing `folder_id = spam` is the quarantine boundary, including mail moved
by an alternate IMAP client. There is no second store. Scoring remains off by
default; shadow still records evidence without moving mail. Automatic quarantine
is not implemented or enabled. No numeric threshold is claimed calibrated.
Unknown, partial or failed inspection does not imply safety or trigger a move.
No SMTP rejection/deletion, sending, auto-reply or inbound AI activation is added.

Authenticated explicit **Mark as spam** records a disposition and moves to Spam
in one synchronous DO transaction. **Not spam** records a disposition and moves
from Spam to Inbox. Outside Spam, Not spam leaves the current folder alone.
**Rescue without feedback** is an ordinary move to Inbox. Sender allow/block/clear
are separate authenticated actions. They do not move existing messages or prove
sender identity. The original assessment is retained.

A feedback retry at its original revision does not replay its move, even if an
ordinary client moved the message afterward. A new deliberate action using the
current revision can move it again and advances the revision. A conflicting old
action returns 409. UID allocation uses the existing `#moveEmailRow`; old source
UIDs and other messages' UIDs do not change. A failed disposition write rolls back
the move, UIDNEXT and context epoch. Ordinary MOVE/COPY/APPEND do not train.

## Read and context boundaries

| Surface | Default | Explicit review |
| --- | --- | --- |
| Lists/search/counts | Spam excluded when no folder is specified | `folder=spam` / UI `in:spam` |
| Thread bodies/attachments/mark-read | Spam excluded | `scope=spam` selects only Spam |
| Single-message API | Spam returns 404 | `scope=spam`, only Spam |
| Attachment download | Requires normal parent message | Explicit `scope=spam`; never loaded by preview |
| Shared get-email/get-thread and MCP | Normal only | Typed `scope=spam`, bounded inert body projection |
| In-app agent | Normal only, including renamed Spam folders | Use dedicated UI review; agent has no Spam review mode |
| IMAP | Existing selected-folder visibility | Spam/Junk and SPECIAL-USE unchanged |

Thread scope is applied before conversation statistics, latest-message state,
participants, unread/needs-reply/has-draft and attachment collection. Subject
fallback excludes Spam; forged References, subjects or thread IDs cannot bypass
the folder predicate. Existing cross-folder semantics among Inbox, Sent, Draft,
Archive and Trash remain. Folder-local Spam unread badges are intentional review
metadata and are not added to normal conversation unread counts.

Direct original-message reads in draft/reply/forward, draft update/discard and
`resolveOriginalEmail` use normal `getEmail`. Draft-reply rejects a quarantined
original before optional AI verification. `/onNewEmail` refuses a quarantined or
missing message before scanning or generation. Intake still does not call it.
No dedicated notification sender exists in the inspected Worker/app paths; the
relevant surfaces are folder badges, thread summaries and agent entrypoints.

Migration 14 adds one mailbox epoch, not another mail store. SQLite triggers bump
it on any insert/delete in Spam or move crossing Spam, including IMAP mutations.
The agent compares it with its durable context marker. On first upgrade or a
change, only the latest user request begins the next context; old tool results
and derived assistant summaries stay out of model input. Subsequent history is
limited to the most recent 200 messages. A quarantine change also aborts further
model steps in an active request. Already delivered client/model output cannot be
retroactively recalled. MCP is stateless: explicit review results are labelled by
scope, and external clients own any retained transcript; normal subsequent server
retrieval never includes Spam.

SPA detail and thread cache keys include scope. Mutation handling cancels pending
reads and resets email/search caches before refetching. Active detail/thread reads
refresh every 30 seconds, matching existing list polling; a rejected normal read
hides cached content. An alternate-client move becomes visible on the next
refresh, not by a new push channel. Neither cache invalidation nor polling rescores.

## Inert review and limits

Spam bodies are shown as escaped text, without HTML parsing, inline-image rewriting,
iframes, attachments, links, styles or automatic resource loads. Collapsed previews
and search snippets also take the bounded text path. The preview maximum is
16,384 UTF-16 code units (at most 65,536 UTF-8 bytes); subject projection is 2,048,
other review metadata 512, and displayed reasons at most 32 × 160 characters.
These are display bounds, not permission to expand the scorer's inspection limits.
Scores are finite heuristic values on 0–100, never confidence percentages.
Legacy rows show unknown/unscored; partial evidence is explicitly displayed.

The existing MIME intake limit/parser, normal-message HTML renderer, full normal
thread behavior and IMAP raw bytes are outside this change. Scoring still accepts
only the bounded projection documented in `shadow-scoring.md`; no attachment-byte
inspection, URL/DNS fetching, rendering/OCR, private fixtures, raw-content logs or
paid AI was introduced.

## Verification and remaining observations

See `evidence/dev-879/README.md` for exact source/commands, failures, runtime and
mutation/browser evidence. The browser harness runs the actual SPA routes,
components, query keys and API client against synthetic responses; separate local
workerd tests exercise authenticated real app handlers, SQLite/R2 and shared
Agent/MCP callbacks with inert model/transport doubles. No live model, mail or
provider call is part of these tests.

Still pending a separately authorized observation: real desktop/mobile mail
clients, actual Cloudflare header provenance/intake, hosted CPU/billing and
real-mail false positives/misses. Synthetic tests do not establish classifier
accuracy, production threshold calibration, hosted latency or billing savings.
