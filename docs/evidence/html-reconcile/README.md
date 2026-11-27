# HTML inspection reconciliation evidence

The scorer candidate is `eaa4aa0ab1be6f017d37cd1347e8727e5960751e` (rules-11). The prior `html-inspection` evidence describes a different rules-2 candidate and is historical.

Local Node 24.13.0, npm 11.12.1, pinned scorer workerd 1.20261021.1: scorer core 69 tests, native scorer RPC, 37 core mutations and 10 Worker mutations passed. The Inbox test suite passed 661 tests against the separately pinned rules-10 scorer. The `check-scoring-contract.mjs` check passed against the rules-11 candidate and invokes native workerd joined checks. Those checks cover MIME, actual RPC, recoverable Spam, parser failures, 155 frozen legitimate examples in both plain and HTML forms, and existing HTML positive and false-positive controls. The 310 examples remained in Inbox with their raw bytes unchanged. Inbox typecheck and build passed. Fixtures are synthetic; these checks do not establish real-mail accuracy or hosted performance.

`contract.json` is produced by the check script and records static synthetic results and dependency pins. The candidate remains subject to independent review and production release requirements.
