# DEV-879: unavailable thread correction

Fix for independent review `638b7886-6c85-4b15-98cc-1e1aa062b9d3` against
`661cdd848194254ad94ca1b732f3e13508bdb658`, on the same branch and stacked PR #8.
The review found that failed thread refreshes retained quarantined children even
when the selected message's independent detail read succeeded.

`EmailPanel` now excludes unvalidated children before constructing the conversation.
During an in-flight read, its retries or an error, the conversation and actions
are hidden. Failed reads offer retry/back controls. Source/image dialog snapshots
are cleared when validation is lost. Successful reads restore current scoped
messages. Counts and reply targets cannot consume the retained children.
The scoped query keys and shared backend readers are unchanged. Repository caller
search found only this consumer of `useThreadReplies`.

## Browser verification

`scripts/quarantine-thread-browser.mjs` uses the actual SPA routes, components,
query hooks and API client with synthetic intercepted HTTP responses. The test
provider now matches production's two retries for server errors and no retries
for 4xx. No fake timers, forced clicks, cache injection, live mail or model calls.

- Negative control on the unfixed component: after 35 seconds, one initial thread
  request plus three rejected requests; selected detail refreshed successfully.
  Participant, snippet, two-message count and Reply remained visible. The intended
  exclusion assertion failed `1 !== 0`. See `before/` and `before.log`.
- Desktop 1440 and mobile 390 pass: the same three rejected requests hide all
  four stale surfaces. Manual retry retrieves the current single-message thread;
  an ordinary external rescue restores the reply on the subsequent production
  30-second poll. Each run ends with six thread requests, zero external request
  attempts and zero page errors. See `after-desktop/` and `after-mobile-retry/`.
- Existing `scripts/quarantine-browser.mjs` passes both viewports: 20,551-character
  hostile body becomes 16,384 inert characters, reasons remain escaped/capped at
  160, no active HTML or fetches, sender block/allow/clear, mark unread and Not spam
  recovery. See `preview/`. Error, recovery and preview screenshots were inspected.

These are synthetic browser viewports, not physical-device or hosted acceptance.
The synthetic list row keeps its original aggregate fixture; the thread regression
asserts the panel's current message count. Real backend aggregates are exercised
by the existing workerd suite. No new calibration, latency or billing claim.

## Reproduction and source checks

Use the committed npm lock and Node 24 (local 24.15.0/npm 11.12.1). No dependency
change/install. Local versions are in `runtime.json`; Playwright 1.64.1 uses
Chromium 148.0.7778.96. Host library/font/XDG setup remains as documented in
`../dev-879/README.md`. The standalone Vite browser fixture has no Worker bindings.

```sh
INBOX_LOCAL_ONLY=1 WRANGLER_SEND_METRICS=false npm run typecheck
npm test -- --maxWorkers=1 --testTimeout=30000 --hookTimeout=30000
npm exec vite -- --config test/browser/vite.config.mjs
# In another terminal, with the local-only fixture listening:
BROWSER_WIDTHS=1440 EVIDENCE_DIR=/tmp/thread-desktop node scripts/quarantine-thread-browser.mjs
BROWSER_WIDTHS=390 EVIDENCE_DIR=/tmp/thread-mobile node scripts/quarantine-thread-browser.mjs
EVIDENCE_DIR=/tmp/spam-preview node scripts/quarantine-browser.mjs
```

Full typecheck/workerd and Go validation belongs to the exact-head CI receipts
linked in PR #8 and the Trellis implementation report. No new local full-suite or
Go pass is claimed. Existing authenticated workerd/shared-tool coverage, pinned
scorer contract and prior mutation evidence remain in the earlier bundles; they
are not relabelled as fresh executions by this browser-only correction.

## Interrupted and repaired attempts

The first combined desktop/mobile command exited 143 without results. Its cause
is unknown. Required sanitized Jev advice was `insufficient_evidence` (0.85),
saved with model/usage/timing/input hash. Bounded repair ran each viewport
separately, preserving timers and assertions; both passed. Mobile initially tried
to click the offscreen Inbox link while its sidebar was closed. The fixture now
uses the visible Toggle sidebar control; that deterministic failure is retained
in `after-mobile.log`. Desktop's earlier pass remains valid; only the mobile
navigation branch changed.

Two combined local typecheck attempts exited 143 after Wrangler declaration
generation without TypeScript diagnostics. The second ran alone. Both are retained
as interruptions, not passes. Jev again returned insufficient evidence (1.0);
the unchanged advice was reused for the second interruption. Route generation and `npm exec tsc -- -b`
passed separately (exit 0). No checks or compiler options were weakened. Final compiler
and exact-head CI outcomes are recorded in the stage report.

## Pins and delivery boundary

Inbox PR #7/base `codex/dev-878-shadow-scoring` stays at
`7cc31772b0ca17ec28ea4d78367e41e0a24e5ce5`. Mail Scoring PR #3 is unchanged at
`bb02819e4662e1d680805435dd886e3dc4728906`. Future separately authorized merge order:
scorer #1 `ce6d9afedf607584c150d457f0e078a307047f8a` -> #2
`8456996596af6446f533cacb90ff9ce2ecd1a4ab` -> #3 -> Inbox #7 -> #8.

No gateway/scorer/backend/config changes in this correction. Scoring stays
off/shadow, automatic quarantine disabled. No merge, deployment, routing changes,
live mail/provider requests, private samples, npm publication or paid resources.
DEV-878 owner event 5416 records persisted Disable builds=true for production
and nonproduction and authorizes source publication. Leave it disabled.
The existing failed external Workers Builds check has no known cause and is not
configured as a required source check (`rulesets.json` empty, base unprotected).
Current-head checks remain explicitly disclosed on PR #8; no provider retry.

Pending separately authorized observations remain real mail clients/devices,
actual intake/header provenance, hosted CPU/billing and real-mail efficacy.
Polling remains foreground-only and subject to the existing request timeout;
already delivered external transcripts cannot be recalled. Source completion
requires independent review of the new exact PR head on this same ticket.
