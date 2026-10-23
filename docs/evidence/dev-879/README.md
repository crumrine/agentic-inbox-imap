<!-- Copyright (c) 2026 Brian Crumrine; SPDX-License-Identifier: Apache-2.0 -->
# DEV-879 source verification

PR: https://github.com/crumrine/agentic-inbox-imap/pull/8 (stacked, not merged).
Runtime source: `898752770b109943bc514d83dee74d81b4577844`.
The submission head recorded on the PR and Trellis can add this evidence only.
Prerequisite Inbox #7: `7cc31772b0ca17ec28ea4d78367e41e0a24e5ce5`.
Scorer #3: `bb02819e4662e1d680805435dd886e3dc4728906`, unchanged.
Future separately authorized merge order is scorer #1 -> #2 -> #3 -> Inbox #7 -> #8.
See `../../quarantine.md` for the full behavior/caller inventory and limits.

## Executions

All mail, bodies, addresses, JWTs/JWKS, attachments and classifier responses are
synthetic fixtures, authored for this Apache-2.0 project or reused from its public
prerequisite tests. No private samples, live mail, Cloudflare provider/model calls,
paid AI, send operation, npm publication, merge or deployment was performed.

| Check | Evidence |
| --- | --- |
| Fresh `npm ci --ignore-scripts --cache /tmp/dev-879-npm-cache --no-audit --no-fund` | `install.log`, 564 packages |
| `INBOX_LOCAL_ONLY=1 npm run typecheck` | `typecheck.log`, passed; fresh declarations, Router typegen and TypeScript |
| `npm exec vitest run test/quarantine.test.ts test/quarantine-context.test.ts test/imap-append.test.ts -- --maxWorkers=1 --testTimeout=30000 --hookTimeout=30000` | `focused-workerd.log`, 47/47 in 3 files, 176.05s |
| Final context-window regression, same flags, `test/quarantine-context.test.ts` | `context-final.log`, 4/4, 17.25s |
| Full `npm test -- --maxWorkers=1 --testTimeout=30000 --hookTimeout=30000` | Exact-source CI receipts below; 562 tests/32 files. The local full attempts were stopped, not counted as passes. |
| `node scripts/check-scoring-contract.mjs ../mail-scoring` | `contract.log`, pinned actual scorer adapter/caller schema compatibility |
| `node scripts/quarantine-mutations.mjs` | `mutations.json` and `mutant-*.log`: aggregate, direct-read, thread, retained-context, inert-preview and cache-scope protections removed separately; all assertion failures, not startup failures |
| `node scripts/scoring-mutations.mjs --workerd` | `scoring/`: all 6 inherited negative controls caught; the message-existence mutation selector was updated for the new atomic move code |
| `npm exec vite -- --config test/browser/vite.config.mjs`, then `node scripts/quarantine-browser.mjs` | `browser.json`, `spam-1440.png`, `spam-390.png`; actual SPA routes/components/query keys/API client with synthetic responses |
| Go build/vet/format/test/race | Source CI green; no Go source changes or local Go execution claimed |

Local tooling: Node 24.15.0, npm 11.12.1, TypeScript 5.9.3, Vite 6.4.1,
Vitest 4.1.11, Workers pool 0.22.0. The pool selects nested Wrangler 4.124.0 /
workerd 1.20260815.1, distinct from root Wrangler 4.74.0 / workerd 1.20260312.1.
Browser: pinned Playwright 1.64.1, Chromium 148.0.7778.96. Local test settings:
`WRANGLER_SEND_METRICS=false`, writable XDG directories, `remoteBindings:false`;
email/model bindings are inert doubles. The retained-context and MCP tests execute
actual registered callbacks with inert SDK/model transport, not a hosted model or
external MCP client session. REST/email tests exercise the real app's production
JWT middleware with synthetic signatures and real local DO SQLite/R2.

The browser consumes an actual 20,551-character hostile body and measures a
16,384-character inert preview, with each displayed reason capped at 160. Both
viewports record zero external request attempts and zero page errors. Script,
SVG/event handlers, CSS URLs/imports, image/srcset, iframe, form, meta refresh and
links remain text. Sender block -> allow -> clear, mark unread and explicit Not
spam recovery use the actual UI/API client. Ordinary rescue, atomic rollback,
revision/idempotence, original assessments and source/destination UIDs are verified
through the actual workerd handlers. Browser API responses are synthetic; they do
not bypass or alter production manual-action authorization.

The browser's Unix host repair uses existing libraries and fonts, not a system
installation. Reproduction on this runner uses:

```sh
export LD_LIBRARY_PATH=/tmp/dev-860-apt/root/usr/lib/x86_64-linux-gnu
export CHROME_PATH=/home/brian/r9-jobs/home/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome
export XDG_CONFIG_HOME=/tmp/dev-879-browser-config
export XDG_CACHE_HOME=/tmp/dev-879-browser-cache
export FONTCONFIG_FILE=/tmp/dev-879-browser-config/fontconfig/fonts.conf
```

The fontconfig file points to `/tmp/dev-860-apt/root/usr/share/fonts` and the writable
cache directory, with DejaVu Sans/Mono aliases. These host paths are not portable
runtime dependencies; on a normal development machine use Playwright's installed
Chromium and system libraries/fonts. The fixture has no Worker or provider bindings.

## Failed and superseded attempts

`attempts/` retains failures rather than relabeling them:

- Initial typecheck caught nullable preview props, unsupported ES2023 `findLast`,
  and an accidental MCP callback parameter; all repaired. Initial PR CI then
  caught the type on the test-only rollback callback, fixed in `4bb4f6a`.
- One first quarantine assertion assumed `/emails` always returned a paginated
  object; this existing API returns an array without pagination. A later IMAP
  assertion assumed internal row IDs were in the wire contract; it returns UIDs.
  Assertions now verify the actual public shapes. The synthetic rollback error
  is caught inside the test DO callback so it does not create unhandled RPC
  rejections. The rollback assertions remain intact.
- A concurrent local full run hit multiple 30s APPEND deadlines and was stopped
  with exit 130. After shutting down competing work, all 47 focused cases,
  including all 35 APPEND cases, passed with unchanged deadlines. The serial
  full run then started but was stopped as redundant once exact-source CI had
  passed all 562 tests. No local full-suite pass is claimed. CI on `147df61`
  passed 562/32 in 123.75s (`ci-source-147df61.log`); final source/submission
  checks are separately recorded below and on Trellis.
- Browser startup timed out, then zero-size text exposed missing local fonts.
  A Tailwind source-scan attempt alone did not fix the overlapping sidebar.
  CSSOM inspection established that two generated stylesheets let a later
  `.fixed` rule override the responsive rule. The fixture now imports the real
  stylesheet once with the production app source scan. No forced clicks,
  disabled safety assertions or production CSS workaround was used.
- Three sanitized Jev advisories are retained with model, usage, timing, input
  hash and `audit_saved:false`. They were advisory, not authorization or proof
  of a failure's cause.

## External check and release boundary

Workers Builds remains **FAILED**, with an instantaneous result and no diagnostic
annotations. This is not an all-checks-green claim. `rulesets.json` is empty and
`required-checks.json` reports the stacked base unprotected: this deployment
integration is not a configured required source check. Its cause is unknown.
DEV-878 owner event 5416 explicitly records persisted Disable builds=true for
production and non-production, authorizes reliance without screenshot access,
and permits source-only dependent PRs. No provider retry/configuration change
was made; automatic builds must stay disabled.

Real-device IMAP/mail clients, actual Cloudflare intake/header provenance, hosted
CPU/billing, efficacy/false positives and production threshold calibration remain
for separately authorized observation. Synthetic viewports are not physical
mobile-device acceptance. Active SPA views observe alternate-client moves on the
existing 30-second refresh cycle; no push channel was added. Already delivered
external MCP transcripts cannot be recalled; explicit review is opt-in and
normal server reads exclude Spam. These are documented limits, not a deployment
gate for the requested reviewed-PR deliverable.

## Exact source CI receipt

[Source CI run 39734671688](https://github.com/crumrine/agentic-inbox-imap/actions/runs/39734671688)
verified source `898752770b109943bc514d83dee74d81b4577844`: typecheck passed,
562/562 tests in 32 files passed (120.26s), and all Go build/vet/format/test/race
steps passed. See `ci-source-8987527.json`, `ci-source-8987527.log` and
`checks-source-8987527.json`. The six quarantine mutations were rerun against
this same source and all failed the intended assertions. The final submission
adds only this evidence directory; its immutable head and repeat CI URLs are
recorded in PR #8 and the DEV-879 implementation result.

`verification.json` records SHA-256 digests for this bundle. Screenshots, logs
and fixture data contain synthetic/public test material only; no private mail
or credentials are included. Failed attempt logs are deliberately retained.

Committed text logs normalize trailing whitespace and trailing blank lines;
assertions, results, timing and failure text are preserved.
