# HTML review repair checks

Scorer source `e203c9765678b64a0b4222062f67fec79af8b5e8`; Inbox source is this commit. Original synthetic fixtures only. The previous reconciliation record remains unchanged.

On Node v24.15.0, the scorer `npm run check` passed (70 core tests, typecheck, workerd, mutation, growth and Worker checks). npm 11.17.0 was used to install the lockfile with engine strict disabled because the project specifies npm 11.12.1. The new redirect regression failed on the prior scorer, then passed after the fix.

Inbox typecheck, build and 661 tests passed against the pinned rules-10 scorer. The joined rules-11 Worker tests and contract check passed against the scorer above, including actual multipart MIME, native HTML parsing, private RPC, mailbox routing, recovery, forwarding, unknown redirect and 310 frozen legitimate controls. The new multipart regression failed on the prior Inbox source, then passed after the fix. The contract result is in `contract.json`.

These synthetic checks do not establish production accuracy or hosted CPU cost. Unrecognized query parameters and nested redirect queries conservatively prevent automatic brand routing.
