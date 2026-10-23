<!-- Copyright (c) 2026 Brian Crumrine; SPDX-License-Identifier: Apache-2.0 -->
# DEV-879: unavailable folder-list correction

Correction for the final P2 finding in independent review
`7eec8b31-d6cd-42ed-8f82-7000ca7c97ec` against
`e469f6dd6918e18a20760686c2081729a5a9230c`. Same ticket, existing branch
`codex/dev-879-spam-isolation`, stacked Inbox PR #8. Brian explicitly requested
"Please fix the blocker" after the third-review human hold.

`app/routes/email-list.tsx` is the only consumer of `useEmails`. It now derives
rows and total count only from a successful query that is not fetching. Retained
TanStack data cannot render senders, subjects, snippets, row actions, indicators,
conversation counts or pagination during revalidation/retries or after failure.
An unavailable folder offers **Retry emails** rather than an empty-folder claim.
Successful retry restores current scoped results. The backend, query keys,
30-second polling, production retry policy and explicit Spam scope are unchanged.

## Actual browser regression

`scripts/quarantine-list-browser.mjs` runs the committed SPA routes/components,
query hooks and API client through the existing standalone Vite fixture. Only
HTTP responses are intercepted; mailbox addresses and messages are synthetic.
The provider matches production's two retries for server errors. The fixture has
no Worker bindings. No fake timers, forced clicks, cache injection, remote model,
mail-provider or send operations.

- **Negative control:** the original `e469f6d` list renders one Inbox row. An
  external move changes its folder to Spam; subsequent Inbox reads fail with
  HTTP 503. After the real 30-second poll plus two retries (three rejected
  requests), the subject, row and conversation count each remain in the DOM.
  The exclusion assertion fails `1 !== 0`, exit 1. See `before/` and `before.log`.
  The initial Spam view is verified empty, preventing the prior review's
  navigation race from producing a false pass.
- **Fixed desktop 1440/mobile 390:** the same three rejected reads leave zero
  stale subjects, rows or counts. Retry with a deliberately held response keeps
  them absent, then restores the empty Inbox. Explicit Spam review retrieves the
  moved row; an ordinary external rescue plus Refresh restores the normal row
  and count. A second held successful refresh confirms existing rows/counts
  disappear during revalidation. Both complete with zero external requests and
  zero page errors. Error and recovery screenshots were visually inspected.

These are synthetic viewports, not physical-device/live-mail acceptance. The
list fixture supplies a conversation aggregate; real backend semantics remain
covered by the workerd suite and previous immutable evidence. Existing preview,
thread, search, contract and mutation evidence is preserved, not claimed as
freshly rerun here.

## Checks and reproduction

Local Node 24.19.0, npm 11.17.0, macOS arm64. Locked npm dependencies installed
with `npm ci --no-audit --no-fund`; package/lock unchanged. npm's existing policy
left uncovered lifecycle scripts disabled; the packaged native binaries worked.
Bundled Playwright 1.64.1 was linked into ignored `node_modules`; existing Google
Chrome 155.0.8059.85 used through `CHROME_PATH`. No browser downloaded or package
manifest changed. Package versions are in `runtime.json`.

```sh
npm ci --no-audit --no-fund
INBOX_LOCAL_ONLY=1 WRANGLER_SEND_METRICS=false npm run typecheck
INBOX_LOCAL_ONLY=1 WRANGLER_SEND_METRICS=false npm test -- --maxWorkers=1 --testTimeout=30000 --hookTimeout=30000
npm exec vite -- --config test/browser/vite.config.mjs
# With the local-only server listening, and installed Playwright/Chrome:
BROWSER_WIDTHS=1440,390 CHROME_PATH='/path/to/chrome' EVIDENCE_DIR=/tmp/list-check node scripts/quarantine-list-browser.mjs
```

Typecheck passed. Full local workerd suite passed **563/563 tests in 32 files**,
77.58 seconds, using real local SQLite/R2 and synthetic/inert bindings. Full logs
are under `checks/`. `node --check scripts/quarantine-list-browser.mjs` and
`git diff --check` passed. No Go source changed; no fresh local Go pass claimed.
Exact submitted commit, remote CI and workflow disposition are recorded in the
PR and Trellis correction handoff rather than a self-referential commit hash.

## Retained browser attempts

The first fixed run passed the failed-refresh assertions but checked a held
request before React committed its batched state update. Its later in-flight
assertion failed; retained in `attempt1/` and `attempt1.log`. The harness now
waits for the subject to detach while the actual HTTP response remains held,
then asserts absence. No product change or assertion was removed for this repair.

The next desktop run passed completely. Its mobile navigation timed out because
CSS visibility alone does not detect a translated offscreen drawer. The harness
now opens the drawer with the visible Toggle sidebar control. The successful
mobile rerun changes only this mobile navigation branch. See
`desktop-and-mobile-navigation.log` and `mobile.log`. All attempts are retained;
failed attempts are not labelled passes. The baseline's core exclusion assertion
is unchanged by these later-phase navigation/timing repairs.

## Stack and delivery boundary

Inbox PR #7 stays at `7cc31772b0ca17ec28ea4d78367e41e0a24e5ce5` and is still
the PR #8 base. Mail Scoring PR #3 stays at
`bb02819e4662e1d680805435dd886e3dc4728906`. Both live prerequisite heads were
rechecked, and actual contributor/security/architecture/research/work-plan
instructions read at those revisions. Future separately authorized merge order:
scorer #1 `ce6d9afedf607584c150d457f0e078a307047f8a` -> #2
`8456996596af6446f533cacb90ff9ce2ecd1a4ab` -> #3 -> Inbox #7 -> #8.

No gateway, scorer, dependencies, CI or runtime configuration changed. Scoring
remains off/shadow and automatic quarantine disabled. No merge, deployment,
routing change, live mail/provider operation, private sample or paid resource.
DEV-878 owner event 5416 authorizes source publication with Cloudflare Builds
disabled. Leave it disabled; the existing external Workers Builds failure is
separate from source CI and this review finding. Its cause is still unverified.

The original review-cycle limit remains in the audit trail. The explicit owner
request permits normal requeue on the same ticket after this correction; no
direct counter edits or duplicate ticket/run are used. Independent review of the
new exact head remains required before completion. Pending live observations
(real devices, intake/header provenance, hosted CPU/billing and efficacy) retain
the previously documented separate authorization boundary.
