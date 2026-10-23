# DEV-879 review corrections

This implementation revision addresses both findings from independent review
97b58118-401f-4b2b-8962-aaf41c6a1f0e against
`aac2c0a23ad2f80294b58ff037f30371f105517c`. Same ticket, branch and PR #8.

Search now polls every 30 seconds while active, revalidates on mount/focus,
passes cancellation through the API client, and hides cached rows/counts during
refresh or error. A failed refresh presents a retry control. Rows and counts
come from one response; a shrinking result count clamps the current page.
No scoring, feedback, mail sending or live provider request is triggered.

Spam detail and shared tool projections preserve the exact operational thread
identity, including IDs longer than 512 characters and prefix collisions.
The SPA percent-encodes thread identities in read/mark-read URLs. Display limits
remain body 16384, subject 2048, other displayed metadata 512 and reason 160
UTF-16 code units. Operational email/thread IDs are lossless keys rather than
preview text; this correction does not add a new input-size policy or claim a
new total thread-output bound. Existing MIME intake and legacy storage semantics
remain unchanged.

## Pins and boundary

Inbox prerequisite PR #7: `7cc31772b0ca17ec28ea4d78367e41e0a24e5ce5`,
base `codex/dev-878-shadow-scoring`, OPEN/unmerged. Mail Scoring PR #3 unchanged:
`bb02819e4662e1d680805435dd886e3dc4728906`, OPEN/unmerged.
Future separately authorized merge order: scorer #1
`ce6d9afedf607584c150d457f0e078a307047f8a` -> #2
`8456996596af6446f533cacb90ff9ce2ecd1a4ab` -> #3 -> Inbox #7 -> #8.
No gateway/scorer edits, merge, deployment, production configuration/routing,
live mail, private fixtures, provider acceptance calls or paid resources.
Automatic quarantine stays disabled and scoring stays off/shadow.

DEV-878 owner event 5416 records persisted Disable builds=true for production
and non-production and authorizes dependent source publication. Builds remain
disabled. The external Workers Builds check has failed without diagnostics at
prior heads; no cause or all-checks-green claim. Repository rulesets are empty
and the stacked branch is unprotected. Do not retry provider builds or change
configuration. Current source CI/head/check receipts accompany the stage report.

## Reproduction

Use Node 24.15.0/npm 11.12.1 and the existing npm lock. No dependency changes.
`INBOX_LOCAL_ONLY=1`, `WRANGLER_SEND_METRICS=false`, writable XDG directories,
remoteBindings:false, synthetic auth/mail fixtures and inert AI/send bindings.

- `INBOX_LOCAL_ONLY=1 npm run typecheck`
- `node scripts/check-scoring-contract.mjs ../mail-scoring`
- `npm test -- --maxWorkers=1 --testTimeout=30000 --hookTimeout=30000`
- `npm exec vite -- --config test/browser/vite.config.mjs`
- `EVIDENCE_DIR=../fix-evidence/search-after node scripts/quarantine-search-browser.mjs`
- `EVIDENCE_DIR=../fix-evidence/preview node scripts/quarantine-browser.mjs`

Browser host uses the existing library/font/XDG setup documented in
`../dev-879/README.md`. Both browser scripts use actual SPA route/components,
query hooks and API client against synthetic intercepted HTTP. Real timers
exercise the production 30-second search interval; no interval override, forced
click or cache injection. Zero external requests/page errors are required.
Production JWT/auth handlers and shared readers are exercised separately under
workerd; this is not a hosted or physical-device acceptance claim.

## Validation results

Source commit `79a6d1bc6d860ee51ea542049815ca2c0e22ad78` passed
[push CI 39738403586](https://github.com/crumrine/agentic-inbox-imap/actions/runs/39738403586):
563/563 tests in 32 files, 85.77 seconds, including all nine quarantine tests.
CI used Node 24.21.0/npm 11.19.0 (local versions below).
Typecheck and Go build/vet/format/test/race-count2 passed. No local Go run claimed.
`ci-source-worker.log` was fetched through the job logs API; `gh run view --log`
initially returned an empty output, so that empty response was not evidence.
Local typecheck and exact pinned scorer contract comparison passed. The local
full suite was stopped (exit 130) after the exact runtime source passed CI;
`full.log` is a partial run, not a local full-suite pass. No assertion failure
was emitted by that interrupted run. The final submission adds evidence and
mobile fixture navigation only; its exact SHA/CI URLs belong in PR #8 and the
stage report, avoiding a self-referential commit hash.

Browser validation passed: desktop1440 and mobile390 each made 11 search
requests with page sequence `[1,1,1,1,1,1,1,1,2,2,1]`. Both proved external
quarantine removal, explicit Spam search/external rescue, failed-refresh rows
and count hiding, and count-shrink pagination recovery. Both had zero external
request attempts and zero page errors. `search-desktop.json` comes from the
successful desktop portion before the mobile-only selector repair;
`search-mobile.json` is the subsequent successful managed mobile retry
(`BROWSER_WIDTHS=390`). All product runtime code is identical across these runs.
The shared browser script now defaults to both widths. `preview.json` separately
passes desktop/mobile inert-body, escaped-reason, sender preference, mark unread
and Not spam recovery checks. Screenshots were visually inspected. A 20551-char
hostile body remains 16384 inert characters; reasons remain 160.

## Negative controls and failed attempts

`thread-before.log`: the new actual-auth detail-to-thread regression fails on
the old projection at the identity equality assertion (one failed, eight
skipped). `search-before.log`: actual Chromium normal search remains stale after
35 seconds on the old query, failing the intended removal assertion. Neither
failure is a startup failure. These prove the regressions detect the removed
protections. The thread test also asserts prefix collision separation, normal
scope exclusion, shared tool round trip, mark-read separation, and display caps.

The first post-fix thread run exposed a test-only mistaken array return-shape
assumption for get_thread; eight tests passed and the new test failed after its
REST assertions. Corrected to the actual `messages` field. Initial typecheck
caught the same fixture typing error. Initial negative-control run also emitted
a read-only Wrangler log-path warning; it still reached the intended assertion.
Subsequent commands use writable XDG directories. An early browser rerun was
stopped before completion to add encoded-identity coverage after a local path
typo prevented that script edit; it is not a passing run. The first full browser attempt passed desktop but timed out filling the collapsed
mobile search input. The fixture now uses the visible Search toggle and Back to
Spam controls, with no forced clicks or product change. A subsequent mobile fixture attempt
used the normal-mail Back to list label, which is absent in Spam; corrected to
the existing Back to Spam control. Desktop search assertions passed in both
attempts; only mobile was rerun after that selector correction. These deterministic
fixture/setup issues did not require a model diagnostic. A later mobile rerun
and its Vite session exited 143 without diagnostic output before results. No
cause is asserted and it is not a passing run. The required sanitized Jev
advisory returned insufficient_evidence (0.90); `audit_saved:false`, so
`jev-browser-terminated.json` is the durable model/usage/timing/hash record.
Bounded repair: run the local server and browser together under one managed
command with cleanup, retaining the same timers and assertions. Earlier revision's
failure records remain in `../dev-879` and the Trellis review result.

## Remaining observations

Real-device mail clients, actual intake/header provenance, hosted CPU/billing
and real-mail efficacy/calibration require separate authorization. Foreground
polling observes other-client moves after the next refresh; responses are
subject to the existing 30-second API timeout. External MCP transcripts already
delivered cannot be recalled. The inherited normal HTML/MIME path is unchanged.
