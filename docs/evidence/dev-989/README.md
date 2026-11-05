<!-- Copyright (c) 2026 Brian Crumrine; SPDX-License-Identifier: Apache-2.0 -->
# DEV-989 source and integration verification

Repository: https://github.com/crumrine/agentic-inbox-imap
Base (`origin/main`): `08b92457015b3615e325cf4b57954daa12a628c2`
Scorer dependency (`crumrine/mail-scoring` merged PR #6, `DEV-988`): `faa15bea06db52f2dc240257d5335a66a933f909` (tree-identical to independently approved `b70dff1b9f9476dc966aa72aade7a223de337ade`)
Legacy scorer baseline (`rules-1`): `2fab406320ae3b3596345d2c76e0ef8a08593211`

See `../../quarantine.md` and `../../shadow-scoring.md` for full routing policy,
explicit sender `allow`/`block` precedence, mixed-version caller-first rollout,
and rollback documentation.

## Scope and behavior verified

1. **Contract & RPC validator parity (`workers/lib/mail-scoring/contract.ts`, `workers/lib/mail-scoring/protocol.ts`)**:
   - Synced Apache-2.0 copies with `crumrine/mail-scoring` `faa15bea06db52f2dc240257d5335a66a933f909` (`ENGINE_VERSION = '0.1.0'`, `RULE_SET_VERSION = 'rules-2'`, `RULE_SET_VERSIONS = ['rules-1', 'rules-2']`, `GTUBE_MARKER`, `REASONS.gtube`, `RULE_CAPS.gtube = 100`, `FAMILY_CAPS.test = 100`).
   - `decodeResponse` accepts both `rules-1` and `rules-2` for caller-first rollout and stored-assessment readability, rejects `id === 'gtube'` when `ruleSetVersion === 'rules-1'`, and continues rejecting unknown versions, arbitrary reason IDs, altered reason text, invalid contributions, malformed JSON, depth > 6, or > 4,096-byte outputs.
2. **Narrow GTUBE routing decision (`workers/lib/mail-scoring/intake.ts`)**:
   - Preserves fail-open to `inbox` when scoring or preference lookup is unavailable.
   - Preserves explicit sender `allow` override (`preference === 'allow'` keeps a validated `gtube` message in `inbox` while storing score `100` and `sender_allowed` + `gtube` reasons) and `block` precedence (`preference === 'block'` routes to `spam` when scoring succeeds, clipping `gtube` to `60` behind `sender_blocked` `40`).
   - Routes new arrivals to recoverable `spam` in `filter` mode when `result.ruleSetVersion === 'rules-2'`, `result.signals.spam === 'present'`, and `result.reasons` includes a validated `gtube` reason with positive contribution, without requiring unrelated identity, sensitive-request, or transport-auth evidence.
   - Keeps ordinary non-GTUBE quarantine thresholds (`heuristicScore >= 45`, `limitsHit` restricted to `auth_unknown | source_incomplete`, `sensitive_request_combined === 25`, and positive identity reason) strictly intact.
3. **Joined local `workerd` integration (`vitest.config.ts`, `test/shadow-scoring.test.ts`)**:
   - Bundled both the current `mail-scoring` private RPC Worker (`faa15bea06db52f2dc240257d5335a66a933f909`, `MAIL_SCORER`) and the legacy `rules-1` Worker (`2fab406320ae3b3596345d2c76e0ef8a08593211`, `MAIL_SCORER_LEGACY`) into local `workerd` service bindings so `test/shadow-scoring.test.ts` exercises real MIME intake (`postal-mime`), real private RPC (`scoreV1`), R2 (`BUCKET`), DO SQLite (`MAILBOX`), authenticated REST, and IMAP API with no canned classifier score on the joined suite:
     - Positive GTUBE (plain-text, `base64`, `quoted-printable`, mixed quote + unquoted GTUBE, multipart with attachment) lands in `spam` under `filter` mode, preserves raw MIME bytes and attachment metadata/bytes in R2, is excluded from ordinary lists/search/threads/counts/agent context/draft-reply, is visible in explicit Spam review (`scope=spam`, `folder=spam`) and IMAP `/api/imap/v1/:mailboxId/spam/messages`, and rescues via `Not spam` feedback or ordinary REST/IMAP moves with proper UID allocation and unchanged assessment.
     - Negative GTUBE, nonspam controls (score `0` and score `10`), lowercase/internal-space/line-break near-matches, quoted/forwarded GTUBE lines, subject-only GTUBE, forged `X-Spam-Flag`/`X-Spam-Status`/`Authentication-Results` headers, HTML-only GTUBE, oversized text fields (`> 32,768` bytes), oversized raw messages (`> 131,072` bytes), zero-padded raw bytes, and `off`/`shadow` modes remain in `inbox`.
     - Explicit `allow`/`block` preferences, ordinary partial-inspection guards (`quoted_content` preventing ordinary score-45 quarantine), caller-first mixed-version rollout/rollback (`rules-1` ↔ `rules-2`), stored assessment readability across DO restarts, single-score-on-arrival, untouched existing mail, and zero outbound/AI/network calls are verified.

## Executions

All fixtures, addresses, JWTs/JWKS, bodies, and attachments are synthetic or use the
official public SpamAssassin GTUBE string. No private mail, live email delivery,
external network requests, paid AI, or production deployment was performed. GitHub
Actions remains disabled (`enabled: false`) per owner instruction (2026-11-04).

| Check | Evidence |
| --- | --- |
| Fresh `npm ci --ignore-scripts --cache /tmp/dev-989-npm-cache --no-audit --no-fund` | `install.log`, 564 packages |
| `node scripts/check-scoring-contract.mjs /home/brian/r9-jobs/home/symphony-workspaces/siteforge/mail-scoring` | `contract.log`, `contract.json` (`faa15bea06db52f2dc240257d5335a66a933f909` + legacy `2fab406320ae3b3596345d2c76e0ef8a08593211`) |
| `INBOX_LOCAL_ONLY=1 npm run typecheck` | `typecheck.log`, passed (`wrangler types`, `react-router typegen`, `tsc -b`) |
| `INBOX_LOCAL_ONLY=1 NODE_OPTIONS="--max-old-space-size=1536" npm run build` | `build.log`, passed (client + SSR bundles) |
| `MAIL_SCORING_DIR=... npm exec vitest run test/shadow-scoring.test.ts test/quarantine.test.ts test/quarantine-context.test.ts -- --maxWorkers=1 --testTimeout=30000 --hookTimeout=30000` | `focused-workerd.log`, 68/68 tests in 3 files, 61.33s |
| Full `MAIL_SCORING_DIR=... INBOX_LOCAL_ONLY=1 npm test -- --maxWorkers=1 --testTimeout=30000 --hookTimeout=30000` | `full-tests.log`, 619/619 tests in 35 files, 633.13s |
| `node scripts/scoring-mutations.mjs --workerd` | `scoring-mutations.log`, `scoring-mutations.json`, `mutation-*.log`: 7 unit mutants + 4 `workerd` mutants (`concurrency`, `mailbox_message_id`, `gtube_routing_workerd`, `gtube_detection_workerd`), all 11 caught |
| `node scripts/quarantine-mutations.mjs` | `quarantine-mutations.log`, `mutations.json`, `mutant-*.log`: all 6 quarantine isolation/preview mutants caught |
| `npm exec vite -- --config test/browser/vite.config.mjs`, then `node scripts/quarantine-browser.mjs` | `browser.log`, `browser.json`, `spam-1440.png`, `spam-390.png`, `gtube-1440.png`, `gtube-390.png`: desktop (`1440px`) and mobile (`390px`) safe preview, GTUBE score `100 / 100`, static reason, and `Not spam` rescue verified with 0 external requests and 0 errors |
| Go gateway checks | No Go files changed; `go` toolchain is not installed on this runner, so no local Go execution is claimed |

Local tooling: Node `24.15.0`, npm `11.12.1`, TypeScript `5.9.3`, Vite `6.4.1`,
Vitest `4.1.11`, Workers pool `0.22.0` (nested Wrangler `4.124.0` / `workerd`
`1.20260815.1`), root Wrangler `4.74.0` / `workerd` `1.20260312.1`, Playwright
`1.64.1`, Chromium `148.0.7778.96`.

Browser reproduction on this runner uses the existing extracted libraries and fonts
documented in `../dev-879/README.md`:

```sh
export LD_LIBRARY_PATH=/tmp/dev-860-apt/root/usr/lib/x86_64-linux-gnu
export CHROME_PATH=/home/brian/r9-jobs/home/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome
export XDG_CONFIG_HOME=/tmp/dev-879-browser-config
export XDG_CACHE_HOME=/tmp/dev-879-browser-cache
export FONTCONFIG_FILE=/tmp/dev-879-browser-config/fontconfig/fonts.conf
```

## Retained attempts

`attempts/` retains earlier failed attempts from this run without relabeling them:

- `focused-attempt-1.log` and `focused-attempt-2.log`: initial test-fixture assumptions
  in `test/shadow-scoring.test.ts` (seed `createEmail` assigns UID when `uid` is omitted
  on `emailData`, real scorer score on the synthetic deceptive control is `45` from
  `sensitive_request_combined (25) + display_identity_mismatch (15) + reply_to_mismatch (10)`
  capped at identity family cap `20`, and `/threads/:threadId` matches `email.thread_id`).
  Repaired in the test fixture without relaxing production code or assertions.
- `browser-attempt-1.log` and `browser-attempt-2.log`: Playwright Chromium launch failed
  before setting `LD_LIBRARY_PATH` and `CHROME_PATH` to the runner's existing extracted
  libraries and Chromium binary.
- `typecheck-attempt-1.log` and `typecheck-attempt-2.log`: `wrangler types` regenerates
  `worker-configuration.d.ts`, overwriting manual edits there; moved test service-binding
  declarations (`MAIL_SCORER`, `MAIL_SCORER_LEGACY`) to `test/env.d.ts` and typed
  `controls` with `ReturnType<typeof bytes>`.
- `build-attempt-1.log` through `build-attempt-4.log`: `react-router build` hit default
  1 GB V8 heap OOM (`attempt-1`, `attempt-4`) or cgroup OOM kill when heap was set too
  high (`attempt-2`, `attempt-3`). Jev advisory is retained in `jev-build-memory.json`.
  Setting `NODE_OPTIONS="--max-old-space-size=1536"` completed both client and SSR builds
  cleanly (`build.log`).

## Boundaries

Source and local integration verification only. No production deployment, live mail
capture, external email sending, or runtime configuration mutation was performed in
`DEV-989`. Manual deployment and live verification belong to `OPS-599`.

`verification.json` records SHA-256 digests for all files in this evidence directory.
Committed text logs normalize trailing whitespace and ANSI sequences while preserving
all assertions, results, timings, and failure messages.
