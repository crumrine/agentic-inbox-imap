# HTML review repair checks

Scorer source `f2f65698e87e28f95bc0c4694e8f593c132a03d4`; Inbox source is this commit. Original synthetic fixtures only. The previous reconciliation record remains unchanged.

On Node v24.15.0, scorer typecheck, 70 core tests, workerd, mutation, growth and Worker checks passed. One full-check run failed its restored mutation baseline without saving diagnostics; the standalone baseline and complete mutation rerun passed. npm 11.17.0 was used to install the lockfile with engine strict disabled because the project specifies npm 11.12.1. The new redirect regression failed on the prior scorer, then passed after the fix.

Inbox typecheck, build and 661 tests passed against the pinned rules-10 scorer. The joined rules-11 Worker tests and contract check passed against the scorer above, including actual multipart MIME, native HTML parsing, private RPC, mailbox routing, recovery, forwarding, unknown and path-embedded redirects and 310 frozen legitimate controls. The new multipart regression failed on the prior Inbox source, then passed after the fix. The contract result is in `contract.json`.

These synthetic checks do not establish production accuracy or hosted CPU cost. Unrecognized query parameters and nested redirect queries conservatively prevent automatic brand routing.
