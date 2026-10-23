<!-- Copyright (c) 2026 Brian Crumrine; SPDX-License-Identifier: Apache-2.0 -->
# DEV-879 corrected dependency validation

Same ticket, existing branch `codex/dev-879-spam-isolation` and stacked
[Inbox PR #8](https://github.com/crumrine/agentic-inbox-imap/pull/8).
Product/test source validated here is
`43889e5c0ba7fd43090e830fbeac048a9551ffc8`. This continuation adds documentation
and synthetic evidence only. The exact submission commit and its CI URLs are
recorded in the implementation result on DEV-879 and the PR description.
Renewed independent review is required; the earlier approval of `b876506` does
not approve the corrected dependency or this submission.

## Source lineage and scope

- Inbox #7: `2838cfb45b870054297fd09e7b88a0c1545801f1`, independently reviewed
  successor of `7cc31772b0ca17ec28ea4d78367e41e0a24e5ce5`, incorporated by the
  source-branch merge `43889e5`. Base remains `codex/dev-878-shadow-scoring`.
- Mail Scoring #3: `bb02819e4662e1d680805435dd886e3dc4728906`, unchanged, with
  ancestor #2 `8456996596af6446f533cacb90ff9ce2ecd1a4ab` and #1
  `ce6d9afedf607584c150d457f0e078a307047f8a`.
- Future separately authorized merge order: scorer #1 -> #2 -> #3 -> Inbox #7
  -> #8. These PRs remain unmerged; no merge or release is authorized here.

The dependency correction changes three static diagnostic catches, adds eight
actual-handler cases and the optional nested workers-types lock entry.
Compared with prior approved `b876506`, quarantine product code, tests, browser
scripts and historical bundles are byte-identical. Current docs now name the
corrected prerequisite and record the provider-build correction described below.
No gateway or scorer source change, runtime/CI configuration change, automatic
quarantine, inbound AI or expanded scope is introduced.

All fixtures are synthetic public-project test material: generated mail,
JWT/JWKS, exception canaries, HTTP responses and inert model/send doubles.
Workerd tests use real local Durable Object SQLite/R2 and actual app email/REST
handlers. Agent/MCP tests execute registered callbacks with inert SDK/model
transport. `remoteBindings:false` prevents remote binding use. The generic AI
binding startup warning in the logs does not describe a model call by these
fixtures. No private mail, provider acceptance, paid AI or live sending is used.

## Reproduction and checked evidence

Node 24.15.0/npm 11.12.1 on Linux. Full versions, including distinct root and
pool-nested Wrangler/workerd versions, are in `runtime.json`.

```sh
npm ci --ignore-scripts --no-audit --no-fund
INBOX_LOCAL_ONLY=1 WRANGLER_SEND_METRICS=false npm run typecheck
INBOX_LOCAL_ONLY=1 WRANGLER_SEND_METRICS=false npm test -- --maxWorkers=1 --testTimeout=30000 --hookTimeout=30000
node scripts/check-scoring-contract.mjs ../mail-scoring
```

Clean install passed (564 packages); typecheck passed; the full local suite
passed **571 tests in 33 files, 547.03 seconds**. It includes quarantine,
quarantine-context, shadow-scoring and inbound-diagnostics through actual
handlers/shared tools, mixed folders, forged chains/subjects, long operational
IDs, mark-read, ordinary IMAP moves, rescue, feedback revisions, UID allocation,
legacy rows and off/shadow behavior. Tests ran with one worker and unchanged
30-second deadlines. No local full-suite failure or interrupted attempt occurred
in this continuation. Contract reproduction passed against pinned scorer source
and produced byte-identical existing contract evidence.

`diagnostics-negative.py` exported the submitted source into a disposable
directory, then restored only the three affected files from prior approved
`b876506`. All eight diagnostics cases failed with assertion failures, exit 1
(18.42 seconds). `diagnostics-negative.json` records the exact source/baseline;
the corrected versions passed in the full suite. No submitted product source
was mutated and no assertion or timeout was weakened. Run the driver from the
Inbox root with the same Node/local-only environment; it writes receipts under
`../implementation-v4-evidence`.

`historical-hashes.json` rechecks all **117 artifacts** across the four prior
quarantine bundles. Five list-fix source digests still match; the recorded old
lock digest differs as expected because of the prerequisite repair. Historical
six quarantine and six scoring mutations, and search/long-ID/thread/list
negative-control assertion failures, were inspected and rehashed rather than
relabelled as new executions. Earlier failed/interrupted attempts are preserved.

No Go source changed. Repository-required Go build/vet/format/test/race-count2
and fresh Worker CI are checked on the final submission head and recorded in
Trellis; no local Go execution is claimed.

## Fresh browser results

All four committed SPA scripts passed at desktop 1440 and mobile 390 widths
using Playwright 1.64.1 / Chromium 148.0.7778.96. The standalone Vite fixture
uses actual routes, components, query keys and API client with synthetic HTTP
responses and no Worker bindings. No fake timers, forced clicks or relaxed
assertions were introduced. Every successful case records zero external
request attempts and zero page errors.

- `preview/browser.json`: 20,551 hostile input characters become 16,384 inert
  preview characters, each displayed reason capped at 160. Script/image/SVG/
  CSS/iframe/form/link text stays escaped; no active nodes or execution.
  Separate block/allow/clear preferences, mark unread and Not spam recovery pass.
- `list/list-1440.json` and `list-390/list-390.json`: three rejected refresh
  attempts leave zero stale subjects, rows and counts. Held-response retries,
  explicit Spam review, ordinary external rescue and in-flight hiding pass.
- `thread-1440/` and `thread-390/`: three rejected thread reads leave zero
  stale participants, snippets, message counts and reply actions; manual retry
  and ordinary rescue restore current messages.
- `search-1440/` and `search-390/`: normal quarantine and explicit-Spam rescue
  refreshes, failed-refresh row/count hiding, long thread-ID URL round trips,
  and pagination shrink pass. Each records 11 search requests with page 2
  returning to page 1 after the result set shrinks.

Preview, failed-list/thread and search screenshots at both widths were visually
inspected. Synthetic viewports do not establish physical-device acceptance.
The drivers include the existing writable XDG/font/library setup for this
runner; these host paths are not application dependencies. Per-viewport
`execution.json` files and the original `browser-runs.json` record timing.
All started processes completed or were terminated; fixture port 5189 was
confirmed closed after the final run.

`source-parity.json` hashes all 130 tracked product/test/configuration files,
unchanged from `43889e5`. `manifest.json` hashes this bundle. Committed text
logs remove trailing whitespace/blank lines only; assertions, timings and
failures are preserved. Original execution logs remain in the local
`implementation-v4-evidence` directory.

## Retained browser interruption

The initial combined browser driver exited 143 (SIGTERM) during mobile list
validation, without an assertion failure or Python traceback. Preview at both
widths and list desktop had completed; mobile list was incomplete and thread/
search had not started. The fixture port was confirmed closed afterward.
`browser-interruption.json`, original logs and driver preserve this unfavorable
attempt; it is not counted as a complete pass.

The user-required Jev advisory returned `insufficient_evidence`, confidence 1.0;
the exact cause remains unproved. Its response, model, usage, timing and input
hash are retained in `jev-browser-interruption.json` (`audit_saved:false`).
The bounded repair uses `run-browser-one.py` to run each remaining unchanged
script/viewport in its own session, with unchanged assertions and production
polling/retry timing. This is an execution-harness change only.

## Provider history and remaining observations

DEV-878 event 5468 and DEV-879 event 5470 supersede the earlier no-upload
inference: Production **Disable builds=true** did not prevent branch uploads.
The earlier correction created ready versions `cffc2c23` (#7) and `407121d7`
(#8). The coordinator reported production `3c48b616` still at 100% traffic,
then separately disabled/saved/reloaded preview-branch builds. This stage relies
on that owner record; it does not reobserve the dashboard or claim current
traffic. Leave both production and preview builds disabled. No provider build
retry, manual deployment, configuration/routing change or merge is authorized.
See `../../diagnostics-validation.md`; historical bundles retain original
observations and must be read with the correction.

Physical desktop/mobile mail clients, actual intake/header provenance, hosted
CPU/billing and real-mail efficacy remain separately authorized observations.
Synthetic timing is not hosted performance or billing; heuristic scores are
not calibrated confidence. Foreground polling/request timeouts and already
emitted external MCP transcripts retain the limits in `../../quarantine.md`.
Source delivery remains off/shadow, recoverable, and PR-only.
