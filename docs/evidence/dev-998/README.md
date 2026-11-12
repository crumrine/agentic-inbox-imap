# DEV-998 caller integration evidence

Source is recorded in `receipt.json`; this directory is an evidence-only child.
Scorer is merged DEV-997 `041e79c5f56880b8eff0e210968569461cb95fc0`.
Base includes merged DEV-1001 inline-forward and omitted-body safety.

The bounded projection now supplies HTML only when meaningful inspectable plain
text is absent. Present oversized plain text never falls back to HTML. Selected
HTML also has a 32 KiB UTF-8 cap; omitted bodies are unavailable before RPC.
PostalMime's generated inline HTML report wrapper becomes the existing redacted
quote marker, retaining ordinary quarantine safeguards. Raw/display are intact.

Policy `inbox-scoring-2` adds a rules-3 score >=60 path requiring a positive
validated statistical reason, spam present and only four reviewed uncertainty
limits. Quoted/over-budget/failed/unknown-preference inputs stay Inbox. Allow
wins; successful explicit block still wins. GTUBE supports both rules-2/3;
ordinary score45 identity+sensitive rules remain unchanged. Both policy versions
and all three actual rule versions survive storage/restart/reads without a
migration or rescoring. Contract/protocol copies are exact except local import.

`full-tests.log`, `typecheck.log`, `build.log`, `contract.json`,
`projection-growth.json`, `scoring-mutations.json`, patches/restored logs and
`browser.json` establish checks. The SPA browser uses synthetic HTTP responses;
the joined backend tests use actual local workerd scorer service bindings,
PostalMime, R2, SQLite, authenticated REST and IMAP API. These are separate
proofs, not a fresh provider delivery or physical-client acceptance.

31 removal checks comprise 17 local and 14 workerd cases. Restored cases verify
source digests and successful targeted behavior. Statistical detection removal
uses an isolated exact-pin shared Git clone and existing dependency link, never
mutates the original scorer or copies a worktree .git file.

Run using Node24.15.0 and `MAIL_SCORING_DIR` at the exact merged scorer pin:

```
node scripts/check-scoring-contract.mjs /path/to/mail-scoring
INBOX_LOCAL_ONLY=1 WRANGLER_SEND_METRICS=false npm test -- --maxWorkers=1 --testTimeout=30000 --hookTimeout=30000
INBOX_LOCAL_ONLY=1 WRANGLER_SEND_METRICS=false npm run typecheck
INBOX_LOCAL_ONLY=1 WRANGLER_SEND_METRICS=false npm run build
node scripts/scoring-mutations.mjs --workerd
node scripts/projection-growth.mjs
node node_modules/vite/bin/vite.js --config test/browser/vite.config.mjs
# second terminal, installed Chrome:
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node scripts/quarantine-browser.mjs
```

`EVIDENCE_DIR` redirects generated output. Historical evidence is preserved.
No held-out predictions were produced here. DEV-999 owns paired acceptance;
OPS-614 owns independent exact-artifact/plan review, manual release and actual
production receipts. GitHub Actions and automatic Builds remain paused.
