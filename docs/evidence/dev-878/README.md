# DEV-878 implementation evidence

All fixtures are synthetic; all Worker tests use `remoteBindings:false` and fake
send/AI bindings. The new integration suite calls the real `workers/app.ts`
email export and fetch router, with production authentication enabled and signed
synthetic JWT/JWKS. Only unrelated Agent/MCP/SSR surfaces are inert test doubles.
R2 and mailbox Durable Object SQLite are local workerd implementations. This is
not hosted validation, live mail, detection accuracy or billing evidence.

Source pins and limits: [integration report](../../shadow-scoring.md).
Runtime versions: [runtime.json](runtime.json). Protocol source digests and
synthetic pinned response: [contract.json](contract.json).

## Reproduction

Use Node 24.15.0/npm 11.12.1. On a restricted runner, choose a writable
`XDG_CONFIG_HOME` (this run used `/tmp/dev-878-xdg`) and set
`WRANGLER_SEND_METRICS=false`. For Vite/typegen/build, set `INBOX_LOCAL_ONLY=1` to
disable remote bindings. Do not use `npm run deploy` or the real email binding.

```sh
npm ci --ignore-scripts --no-audit --no-fund
INBOX_LOCAL_ONLY=1 npm run typecheck
npm exec vitest run test/shadow-scoring.test.ts
npm test -- --maxWorkers=1 --testTimeout=30000 --hookTimeout=30000
node scripts/check-scoring-contract.mjs ../mail-scoring
node scripts/scoring-mutations.mjs --workerd
git diff --check
```

The contract script requires the exact scorer checkout; it bundles only its
local deterministic source, invokes no network, verifies source copies and
records the output. The mutation script uses disposable copies, removes one
protection at a time and requires an assertion failure. Tests/implementation in
the working branch are never mutated. Four lightweight baseline/mutant probes
cover off, output bytes, provenance and manual capability; two actual workerd
mutants remove revision and message-existence checks. Results are in
[mutations.json](mutations.json) and the two named synthetic logs.

The initial harness used the removed `cloudflare:test.fetchMock` API. This was
repaired with a global fetch mock accepting only the synthetic JWKS URL and
throwing for all other requests. The initial alias fixture reversed the helper
arguments; it now asserts alias creation succeeds before delivery. Vitest's
DEV bypass is explicitly disabled with `vi.stubEnv('DEV',false)` so the real
JWT boundary runs. No application assertion was relaxed to fix these failures.
Writable XDG configuration removes the initial Wrangler log EROFS warning.
Jev's bounded-startup advice is recorded in [jev-startup.json](jev-startup.json);
it returned insufficient evidence, not an authorization or test result.

The first full single-worker run with default deadlines was interrupted after
three existing APPEND cases failed with cleanup aborts (8.6-13.2 seconds). The
bounded retry kept assertions unchanged and set test/hook deadlines to 30
seconds. `imap-append` plus `shadow-scoring` then passed all 55 tests (35 existing,
20 new), 158.44s wall. That supports a runner/deadline interaction but is not a
production parser performance guarantee. A complete two-worker retry reproduced five APPEND failures with cleanup
aborts and was stopped. The final complete retry uses one worker and the same
30-second harness deadlines; its final result is recorded in `validation.json`.
Jev advice is in `jev-suite.json` and `jev-suite-parallel.json`; neither advice
record establishes a root cause. Do not call either interrupted run a pass.

No Go files changed. No gateway check result is claimed by this local stage.
Final command results and source identity are in [validation.json](validation.json).
The serial full run passed 550 tests across 30 files in 499.10s. Typecheck and
all six mutation checks passed. Full logs, including the two interrupted runs,
are retained here with digests. Runtime/test sources are unchanged from
`1eb607f3f34cf415a8a4a2ffeb232b01ab26f63c`; the final evidence commit and recovery
bundle identity are recorded in the same-ticket Trellis implementation result.

## Historical push/PR blocker (resolved)

The observations below describe the initial blocked run, not the current gate.
Trellis DEV-878 event 5416 records an owner-requested dashboard change on
2026-10-21 America/Los_Angeles: `Disable builds=true` was saved and verified
after reloading. Automatic main and non-production branch builds, deployments
and version uploads are paused. The running Worker and traffic were unchanged.
That note explicitly authorizes this runner to rely on the observation and
publish the existing source branch/PR without local access to the screenshot.
This runner did not independently inspect the dashboard. Account identifiers
and the private screenshot are intentionally not copied into this public repo.
Leave builds disabled until a separately authorized release. No deployment,
merge, live routing or scoring activation is authorized by this resolution.

The resumed implementation's checks are in `resume-validation.json`. CI now
sets `INBOX_LOCAL_ONLY=1` and disables Wrangler metrics; its test command uses
the validated serial 30-second deadlines without changing assertions.

[GitHub check evidence](external-build-check.json) confirms that an existing
external **Workers Builds: agentic-inbox** integration ran on a non-main branch
(PR #5, commit `061da3255440e6c0fee5a55c6eee0a0453e2a866`). Its output identifies
a Worker version; that is not proof of deployment state. GitHub repository
hooks/deployments/rulesets expose no applicable current Cloudflare branch or
deploy commands. No Cloudflare API-token environment variable or local Wrangler
OAuth configuration is available; no secret values or host `.env` were read.
Available connected tools expose no suitable Cloudflare configuration reader.

Cloudflare documents configurable build/deploy commands and branch controls:
https://developers.cloudflare.com/workers/ci-cd/builds/configuration/ and
https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/ . Defaults
cannot establish this project's actual settings. A Pages skip-commit convention
is not documented proof of a Workers Builds exclusion. No push was attempted
as a way of discovering whether it deploys.

The originally missing external input was verified Workers Builds settings excluding
`codex/dev-878-shadow-scoring` from deployment/provider mutation, or an owner
configuration change that disables that automation for this source-only branch.
Event 5416 resolves this input before push/PR. The initial stage did not claim
implementation success without a pushed PR. The resumed stage preserves the
same branch/ticket and records the final exact PR head in Trellis.

Real Cloudflare intake/header provenance and hosted measurements remain pending
owner-authorized work. Those are documented limitations, not the push blocker.
