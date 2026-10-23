# Error diagnostics and clean installs

Original work copyright (c) 2026 Brian Crumrine, Apache-2.0.

Raw storage failures now emit only `raw_mime_storage_failed`; the fallback still
records the byte count and delivers the message with no raw key. The catch does
not inspect exception properties. The email entry point emits and throws only
`inbound_email_processing_failed`, preserving the internal-failure path without
passing private exception text to runtime logging. Deferred sends retain their
accepted response and emit only `deferred_email_delivery_failed` on failure.

`test/inbound-diagnostics.test.ts` exercises actual email/REST entry points and
local R2/SQLite with synthetic storage/send faults. It checks delivery, accepted
responses, no permanent rejection, and exact static diagnostics. Arbitrary null,
string and throwing-getter exceptions cannot defeat the raw-storage fallback.
All seven initial cases failed on the original source. The added deferred-send
case also failed when its original diagnostic was restored, then passed with
the correction. No live mail or model calls are made.

Cloudflare's failed build log identified npm 10.9.2 `EUSAGE`: the lock lacked
the test pool's optional workers-types 5.x peer. Added exactly that nested entry
(`5.20261023.1`), retaining every existing package version and platform record.
An isolated npm 10.9.2 clean install reproduced the missing-peer error before
the repair and succeeded afterward with lifecycle scripts disabled. A fresh
install's dependencies then passed typecheck, 558 tests in 31 files and the
local production build under Node 24.13.0. Gateway source is unchanged; CI runs
its checks. This does not establish provider deployment or live-mail acceptance.

Reproduce with Node 24 and the committed lock:

```sh
npm ci --ignore-scripts --no-audit --no-fund
INBOX_LOCAL_ONLY=1 WRANGLER_SEND_METRICS=false npm run typecheck
INBOX_LOCAL_ONLY=1 WRANGLER_SEND_METRICS=false npm test -- --maxWorkers=1 --testTimeout=30000 --hookTimeout=30000
INBOX_LOCAL_ONLY=1 WRANGLER_SEND_METRICS=false npm run build
```

Cloudflare automatic builds were verified disabled before source publication.
Leave them disabled. The previous failed provider check is historical evidence;
neither retrying it nor deploying is part of this validation.
