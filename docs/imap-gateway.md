# IMAP/SMTP Gateway

Design and build record for exposing Agentic Inbox mailboxes to standard mail
clients (Apple Mail, Thunderbird, mobile clients) over IMAP, with SMTP
submission still to come.

Status: phases 0 and 1 are done and verified against a live iOS Mail client
over a real Worker. Most of phase 2 (STORE, COPY, MOVE, EXPUNGE) landed early
too, for reasons explained below. What remains is APPEND, SMTP submission, a
real push channel for IDLE, an app-password management UI, and open-source
packaging. See "What actually shipped" for the detailed state and "Where this
went wrong" for the three production-only failures that shaped it.

## Why a gateway exists at all

IMAP is a TCP protocol. Workers cannot accept inbound TCP connections, and
Cloudflare does not offer an IMAP service, so the protocol cannot terminate
inside the Worker. From the Workers TCP sockets documentation:

> Support for handling inbound TCP connections is coming soon. Currently, it
> is not possible to make an inbound TCP connection to your Worker.

So IMAP requires one always-on host. The design goal was to make that host as
close to disposable as possible: the gateway holds no mail, no database, and
no durable state. That goal held up. The Durable Object is still the single
source of truth, and `agentic-imapd` remains stateless in production.

```
  Mail client                 Gateway host                  Cloudflare
 ┌───────────┐  IMAP 993   ┌────────────────┐  HTTPS     ┌──────────────┐
 │ Apple Mail│────────────>│ agentic-imapd  │───────────>│ Worker       │
 │Thunderbird│  SMTP 465   │ go-imap        │  Access    │  /api/imap   │
 └───────────┘────────────>│ go-smtp        │  service   │      │       │
       ▲                   │ (stateless)    │  token     │      v       │
       └── private overlay └────────────────┘            │  MailboxDO   │
           network only                                  │  SQLite + R2 │
                                                         └──────────────┘
```

### Private network binding

The gateway listens only on its private overlay network interface
(Tailscale), never on a public address. This is a deliberate security and
operations decision, not a convenience:

- No public 993/465 means no credential stuffing, no brute-force surface, and
  no need for fail2ban, connection throttling, or abuse monitoring. Public
  IMAP endpoints attract automated attacks within hours of opening.
- TLS certificates come from `tailscale cert`, so there is no ACME/renewal
  path to maintain.
- Clients must be on the tailnet. This is acceptable for a self-hosted inbox
  and is the recommended default. Operators who want public exposure can do
  it, but they own the hardening.

This is enforced in code, not just by convention: `internal/config` resolves
the configured listen address and refuses to start unless it is loopback or
in the Tailscale CGNAT range (`100.64.0.0/10`), short of an explicit
`AGENTIC_ALLOW_PUBLIC_BIND=true` override. `internal/config/config_test.go`
covers the guard.

## Why the data model needed work first

Agentic Inbox stored a *rendering* of each message, not the message. IMAP is a
*store* protocol and needs the original bytes plus stable identity. Phase 0
closed these gaps:

| Gap | Original state | Closed by |
|---|---|---|
| Raw MIME discarded | `workers/index.ts` parsed with PostalMime, dropped the buffer | `raw_key` on `emails`, `raw/{mailboxId}/{emailId}.eml` in R2 |
| No UID / UIDVALIDITY | ids were `crypto.randomUUID()` | `uid`, `uid_validity`, `uid_next` in migration `9_imap_uid_flags` |
| Flags were two ints | `read`, `starred` in `workers/db/schema.ts` | `answered`, `deleted`, `flags` (JSON keyword array) added alongside them |
| No message size | not stored | `rfc822_size` |
| No APPEND path | n/a | still open, see below |
| Access JWT was the only auth | `workers/app.ts` middleware | app passwords, see Authentication |

### Raw MIME retention

This was the one item flagged as urgent and non-backfillable, and that held.
Messages received before the migration have no raw form and never will; the
`/raw` endpoint serves synthesized MIME for those (`raw_key IS NULL`), which
is a different message than what arrived byte-for-byte. DKIM verification on
a synthesized message will not match, though this has not needed to matter in
practice since testing has used mail that arrived after the migration.

Storing raw at receive time, before `PostalMime` consumes the ArrayBuffer,
shipped in phase 0 as planned. Outbound mail's mirror problem (Cloudflare's
send binding builds the MIME, so there is no raw copy of what was
transmitted) was also solved as planned: a compliant message is synthesized
at send time and stored, which does not byte-match what Cloudflare sent but
is fine for reading back your own Sent folder.

## Schema changes

Migration `9_imap_uid_flags` in `workers/durableObject/migrations.ts`, with
`workers/db/schema.ts` updated by hand to match (Drizzle is a query builder
here, not a migration tool). This shipped as designed:

```
folders:  uid_validity INTEGER NOT NULL   -- set once at folder creation
          uid_next     INTEGER NOT NULL DEFAULT 1

emails:   uid          INTEGER            -- per folder, ascending, stable
          answered     INTEGER DEFAULT 0  -- \Answered
          deleted      INTEGER DEFAULT 0  -- \Deleted, pre-EXPUNGE
          flags        TEXT               -- JSON array, custom keywords
          rfc822_size  INTEGER            -- byte length of the raw message
          raw_key      TEXT               -- R2 key, NULL for legacy messages

UNIQUE INDEX on (folder_id, uid)
```

Notes, all confirmed by the implementation:

- UIDs are per folder, not per mailbox. A message moved between folders gets
  a new UID in the target.
- The Durable Object is a single writer, so UID allocation needs no locking.
- The migration backfilled UIDs per folder ordered by `date`, then set
  `uid_next`. One time, deterministic.
- `read` and `starred` stayed as they are and keep mapping to `\Seen` and
  `\Flagged`. The SPA is untouched.
- `raw_key` avoids an R2 HEAD per message during a full-folder FETCH.
- `raw_key` is also shared between rows produced by COPY, which turned out to
  matter for EXPUNGE. See "EXPUNGE and hard delete" below.

### R2 layout additions

```
raw/{mailboxId}/{emailId}.eml          the original message
credentials/{mailboxId}.json           app password hashes
```

Credentials deliberately live outside `mailboxes/{id}.json`. That settings
blob is read into the agent's prompt path (`getSystemPrompt`), and credential
material must never be reachable from an AI code path. This boundary held as
built.

## Authentication

Two independent legs, as designed, though the reasoning is now sharper than
"OWASP guidance" because of what production forced.

**Client to gateway:** app passwords, one or more per mailbox, generated in
Settings and shown once. Hashed with PBKDF2-HMAC-SHA256 (`workers/lib/credentials.ts`)
at **100,000 iterations, not 600,000**. Clients authenticate with
`AUTHENTICATE PLAIN` over implicit TLS, and the gateway checks the password
once, at IMAP LOGIN, against `POST /api/imap/v1/auth`. It does not re-send the
password on every subsequent read; those requests carry only the Access
service-token headers, which is a narrower exposure than replaying a user
credential on each FETCH.

**Gateway to Worker:** a Cloudflare Access service token
(`CF-Access-Client-Id` / `CF-Access-Client-Secret`), which is the supported way
for a non-browser client to pass an Access policy.

### The security model changed, and this is where it landed

Cloudflare Access is no longer the single trust boundary. App passwords are a
second, weaker door into a mailbox: a leaked app password lets an attacker
read and write that mailbox without ever touching Access. The gateway itself
is a trusted component too, since it holds an Access service token that can
reach every mailbox on the Worker, not just the one it is currently serving;
nothing at the Worker layer scopes a gateway request to one mailbox beyond
what the gateway itself chooses to send. The compensating control for both
of these is the same one that was already in place: the gateway binds only to
the tailnet, so reaching it at all requires being on the private network.

The PBKDF2 ceiling (below) means the KDF protecting app passwords is weaker
than originally intended. That is acceptable only because app passwords are
machine-generated at 100 bits of entropy (`scripts/mint-app-password.mjs`),
where the derivation function is defense in depth rather than the actual
barrier to an offline attack. If this system ever accepts a user-chosen
password instead of a generated one, 100,000 iterations is not enough, and
that has to be revisited before it does.

## What actually shipped

### Worker API for the gateway

A dedicated surface at `IMAP_API_BASE = "/api/imap/v1"` (`workers/routes/imap-api.ts`),
mounted before the React Router catch-all, alongside `/mcp` and `/agents/*`.
The endpoint list changed from the original plan in one concrete way: there
is no WebSocket `/events` endpoint, because IDLE turned out not to need one
yet (see below), and APPEND has no endpoint yet because it has no client side
to call it.

```
POST   /api/imap/v1/auth                              verify app password
GET    /api/imap/v1/{mailbox}/folders                 uid_validity, uid_next, counts
GET    /api/imap/v1/{mailbox}/{folder}/messages        batch metadata by UID range
GET    /api/imap/v1/{mailbox}/messages/{uid}/raw       stream the .eml
POST   /api/imap/v1/{mailbox}/{folder}/flags           batch flag updates
POST   /api/imap/v1/{mailbox}/{folder}/copy            COPY
POST   /api/imap/v1/{mailbox}/{folder}/move            MOVE
POST   /api/imap/v1/{mailbox}/{folder}/expunge         EXPUNGE, relocate or hard-delete
POST   /api/imap/v1/{mailbox}/{folder}/search          SEARCH push-down (DEV-682)
```

`search` takes a JSON mirror of go-imap's `imap.SearchCriteria` and answers
the part it can evaluate exactly from SQLite, reporting the rest. Its response
carries `handled` / `unhandled` token lists and a `partial` flag: `uids` is
the set matching the handled criteria and *only* those, so a caller finishes
by applying the unhandled ones to that list. BODY and TEXT are deliberately
unhandled — the `body` column is the parsed body the app rendered, not the
message's parts — but the endpoint still turns a folder-wide raw download into
a handful of fetches by narrowing on everything else first. The full contract,
including why each unhandled criterion is unhandled, is in
`workers/imap/search.ts`.

The metadata endpoint returns everything a FETCH needs without touching the
raw body: uid, flags, internaldate, rfc822_size, and envelope fields, so a
full sync never pulls raw bytes just to answer a size or envelope query.

### The gateway (`gateway/`)

Serving: CAPABILITY, NOOP, LOGOUT, AUTHENTICATE PLAIN, LOGIN, ID, LIST, LSUB,
STATUS, SELECT, EXAMINE, CLOSE, UNSELECT, SEARCH, FETCH (ENVELOPE,
BODYSTRUCTURE, BODY[...] with HEADER.FIELDS and partial ranges), IDLE, STORE
of message flags, COPY, MOVE, and EXPUNGE. MOVE and UIDPLUS are advertised, so
a client moves a message in one round trip and gets a real COPYUID response
back.

Not served: APPEND answers NO and keeps the connection alive. SMTP submission
(`internal/smtp`) is still an empty placeholder.

Verified against iOS Mail over the tailnet with a live Worker: connect, full
folder sync, UID SEARCH, UID FETCH with BODY.PEEK[HEADER] and partial ranges,
IDLE holding open until DONE, and flag writes persisting. COPY, MOVE, and
EXPUNGE are covered against a fake backend and an in-process go-imap server,
including a replay of the exact swipe-to-delete sequence
(`UID STORE +FLAGS (\Deleted)` then `UID EXPUNGE`), but have not yet run
against a real client.

### Flag writes could not be optional

Read-only IMAP was the original phase 1 scope, with "marking a message read
will not stick" written down as a mild, accepted cost. That was wrong. A real
client does not treat a routine command failing as a degraded experience, it
treats it as a broken server. iOS Mail sets `\Seen` the instant it displays a
message and interprets a `NO` on that STORE as a fatal server error: it tore
the connection down and reconnected in a loop, without ever successfully
rendering the message it had just fetched. Captured from the live client:

```
UID STORE 3 +FLAGS.SILENT (\Seen)
NO [CANNOT] STORE is not supported: this mailbox is served read-only
<connection torn down, reconnect, repeat>
```

That is what pulled STORE, COPY, MOVE, and EXPUNGE forward from phase 2 into
what shipped alongside phase 1. Read-only IMAP is not a smaller version of the
product, it is a non-functional one against any client that was not written
to expect it.

`+FLAGS`, `-FLAGS`, and `FLAGS` all work, in both `.SILENT` and echoing form.
`\Draft` and `\Recent` are accepted and ignored rather than rejected: `\Draft`
is a property of the folder in this data model, not a per-message flag, and
nothing is ever reported as recent. PERMANENTFLAGS advertises exactly what
STORE will persist; an EXAMINE'd mailbox advertises none and refuses STORE,
per RFC 9051.

### EXPUNGE and hard delete

`\Deleted` alone changes nothing about where a message lives. EXPUNGE
relocates the message to Trash from every folder except Trash itself, where
it hard-deletes. Only one place in the system ever destroys a message. The
`\Deleted` flag is cleared on relocation, so a message that was swipe-deleted
into Trash is not automatically armed for destruction the next time something
expunges Trash.

COPY is `INSERT ... SELECT` and shares `raw_key` between the original row and
the copy: two database rows, one R2 object, no duplicated bytes. That makes
hard delete reference-counted rather than unconditional. Deleting a row whose
`raw_key` is still referenced by another row leaves the R2 object alone;
purging only happens once no row references it. This was verified live:
hard-deleting two copies that shared an object with a message still sitting
in the inbox left that inbox message's bytes intact.

Attachment blobs are single-owner (their R2 key embeds the owning email id, so
a copy cannot address the original's attachments), which means hard delete
purges attachment blobs unconditionally rather than needing the same
reference count. Only legacy rows with `raw_key IS NULL` lose attachment
access on copy, which is an acceptable edge for pre-migration mail.

### Sequence-number renumbering had to be handled structurally

The original design assumed an append-only snapshot: numbers only ever grow.
EXPUNGE breaks that assumption on purpose, since RFC 9051 requires a client's
sequence numbers to shrink and renumber when a message is removed.

Untagged EXPUNGE responses are emitted in **descending** sequence order.
Removing the highest number first means every lower number is still valid
when its turn comes; ascending order would require the client (or the server)
to account for already-reported removals when interpreting each subsequent
number, which is exactly the kind of arithmetic that points a client at the
wrong message.

The two cases are kept structurally separate, not by convention. The
snapshot-shrinking code path is reachable only through the function that
first emits the untagged EXPUNGE responses and then shrinks, so the snapshot
can only shrink where the client was actually told it did. `Poll` and `Idle`
never shrink or renumber: a message deleted somewhere other than an IMAP
EXPUNGE (the web UI, for instance) stays addressable in the client's view and
simply fails to fetch, rather than silently renumbering a mailbox the client
was never told changed. A stale entry is judged less harmful than a
renumbering the client didn't ask for.

### IDLE is polling, not push

IDLE cannot be refused, full stop: go-imap's `availableCaps()` appends it
unconditionally whenever IMAP4rev1 is supported, so every real client uses it
regardless of what the server would prefer to advertise. Refusing it or
returning an error mid-IDLE is also unsafe: go-imap writes `+ idling` and
runs the session's `Idle` call in a goroutine while blocking on the client's
`DONE`, so an early error is withheld from the client until `DONE` arrives,
leaving the client believing it is idling correctly for updates that will
never come.

`Idle` now blocks until told to stop, refreshing the selected folder on entry
and again on a 30-second timer (`DefaultIdleInterval`), emitting EXISTS when
the folder has grown. The refresh on entry matters as much as the ticks: mail
that arrives between SELECT and the first tick would otherwise be missed
until the interval elapsed. It calls the same `poll()` function the ordinary
NOOP-driven poll path uses, so the append-only rules and error tolerance are
identical by construction rather than reimplemented.

30 seconds is the freshness ceiling a client watching a mailbox gets today. A
real push channel from the Durable Object (tracked as Trellis DEV-674) is the
better answer and is still open.

## Where this went wrong: three production-only failures

These are the most valuable thing in this document. All three passed every
local test and failed only against the real platform or a real client; none
was, or could have been, caught by the test suite that existed at the time.

### 1. The PBKDF2 iteration count exceeded a platform ceiling no test could see

App-password hashing was built at 600,000 PBKDF2-HMAC-SHA256 iterations,
OWASP's current guidance. All 114 tests passed locally. Every real login
failed in production, with:

```
NotSupportedError: Pbkdf2 failed: iteration counts above 100000
are not supported (requested 600000).
```

Cloudflare Workers' WebCrypto caps PBKDF2 at 100,000 iterations. Local
`workerd` (the vitest pool this repo tests against) does not enforce that
cap, so a value above it is invisible in CI and only throws against the real
runtime. It was compounded by `verifyAppPassword` catching everything and
returning `false`, which turned a platform exception into an ordinary wrong
password, and by the auth route mapping that to a 401 identical to a real bad
password. Diagnosing it took a deploy and a live probe against the runtime,
not a test run. Fixed by lowering to 100,000, the maximum the platform
accepts, with the reasoning for why that is acceptable recorded at the
constant in `workers/lib/credentials.ts` so it can't be quietly re-raised
later. A regression test now asserts the ceiling explicitly
(`test/mint-script-compat.test.ts`), because the runtime itself will not
catch it for you locally.

### 2. go-imap has no ID handler, and that is fatal, not cosmetic

Apple Mail and Thunderbird both send `ID` as their first command, before
`LOGIN`. go-imap v2.0.0-beta.8's `imapserver` has no handler for `ID`, and its
default behavior for an unrecognized command while unauthenticated is to
terminate the connection outright, as an anti cross-protocol-attack measure.
Apple Mail's own trace:

```
a2 ID ("name" "Mac OS X Mail" "version" "16.0")
a2 BAD Unknown command
* BYE Unknown command
```

Neither client could connect at all, and the failure surfaced to the user as
a bad password, not a protocol error. No supported fix exists inside go-imap:
`Options` has no custom-command hook, beta.8 is the newest available tag, and
there is no resolvable upstream branch carrying a handler. The fix lives
below the library: `gateway/internal/imap/idproxy.go` wraps the accepted
`net.Conn` and answers `ID` itself, inspecting bytes only until the first
command that is not ID, CAPABILITY, or NOOP, then becoming a byte-for-byte
pass-through forever so it cannot corrupt a literal during LOGIN or APPEND.
ID is answered but never advertised in CAPABILITY, since both clients send it
unsolicited and advertising it would mean rewriting outbound responses for no
functional gain.

One consequence worth knowing: wrapping the connection defeats go-imap's own
`c.conn.(*tls.Conn)` TLS detection, so the server has to be told
`InsecureAuth: true` and the wrapper itself takes over enforcing "reject
cleartext by default," with an explicit test-only opt-out
(`AllowCleartext()`). That invariant now lives in a different file from the
code that depends on it, which is exactly the kind of thing that gets
silently broken later; it's called out here and in the code comments so it
doesn't happen by accident.

### 3. IDLE cannot answer NO, and the library doesn't make that obvious

Covered in detail above. The version that matters for this section: refusing
IDLE looked reasonable when phase 1 was scoped as read-only, but go-imap
advertises it unconditionally regardless of what the session reports it
supports, and an error path mid-IDLE desynchronizes the client rather than
failing cleanly, because the client has already committed to waiting for
updates by the time the error would arrive. This is not a case a unit test
against a fake backend was likely to exercise, since it depends on the
interaction between go-imap's IDLE state machine and how a client actually
behaves while idling, not on the server's own logic.

### The general lesson

This happened three times, in three different subsystems, for what is really
one reason: a command that a real mail client considers routine cannot answer
`NO`, no matter how reasonable the refusal seems from the server's side, and
a green local test suite says nothing about a platform-enforced ceiling or a
gap in a third-party library, because neither one exists in the local
environment the suite runs against. The fix in every case was the same shape
too: stop trying to refuse the thing, and verify against the real client and
the real runtime, not just the fake backend and local `workerd`.

## Repository layout

```
gateway/
  go.mod                        separate module; the Node build never sees it
  cmd/agentic-imapd/             entrypoint, TLS listener, ID-proxy wiring
  internal/imap/                 go-imap session: fetch, search, store, mutate (copy/move/expunge), idproxy
  internal/smtp/                 empty package placeholder (submission not built yet)
  internal/backend/              HTTP client for /api/imap/v1
  internal/config/               env config, validation, public-bind guard
  README.md                      build, configure, deploy
  deploy/                        systemd unit, example env file
docs/imap-gateway.md             this document
```

### Licensing and attribution

This repository is a fork of `cloudflare/agentic-inbox` under Apache 2.0, and
existing files carry `Copyright (c) 2026 Cloudflare, Inc.` headers. New files
must not claim Cloudflare copyright. Before publishing:

- New source files get an Apache 2.0 header with correct attribution.
- A `NOTICE` file records the fork, upstream project, and license.
- The README states what is upstream and what is added here.

## What remains

- **APPEND.** No endpoint and no gateway handler. Needed for clients that
  save their own Sent and Drafts copies rather than relying on the app's
  send path to populate them.
- **SMTP submission.** `internal/smtp` is still an empty placeholder. Needs
  to authenticate against the same app passwords and hand off to the
  existing Worker send path so `validateSender`, the per-mailbox rate limit,
  Sent recording, and threading all still apply. Do not point clients at
  `smtp.mx.cloudflare.net` directly: it works, but the password is a
  Cloudflare API token authorized for every address on the domain, and mail
  sent that way never enters the app, so the Sent folder silently diverges.
- **IDLE via real push**, replacing the 30-second poll, tracked as Trellis
  DEV-674. Use the hibernatable WebSocket API so an idle client does not
  hold the Durable Object in memory and accrue duration charges. The
  inbound-mail hook that already fires the agent's auto-draft is the natural
  broadcast point.
- **App-password management UI** in Settings. Passwords can be minted today
  with `scripts/mint-app-password.mjs`; there is no in-app flow yet.
- **Open-source packaging**: the licensing and attribution checklist above,
  plus whatever else falls out of actually publishing the fork.
- **CONDSTORE/QRESYNC**, if client resync cost ends up justifying it. Not
  started, not blocking anything today.

## Risks

- **go-imap v2 API churn.** The v2 `imapserver` package has been pre-1.0 for a
  long time, has already required a below-the-library workaround for a
  missing `ID` handler, and should be expected to break again on upgrade.
  Pin the version deliberately.
- **Legacy messages are permanently lossy** over IMAP. Nothing recovers raw
  bytes for mail received before the migration.
- **PBKDF2 at 100,000 iterations is a real reduction** from the 600,000
  originally intended, forced by the platform. Acceptable only as long as app
  passwords stay machine-generated at their current entropy; revisit if that
  ever changes.
- **The gateway is a high-value target.** It holds an Access service token
  that can reach every mailbox, not just the one currently connected. The
  tailnet-only bind is the only thing standing between a compromised gateway
  host and every mailbox on the Worker.
- **5 MiB outbound limit**, once SMTP submission exists. Cloudflare Email
  Service caps total message size, including attachments, at 5 MiB. Mail
  clients do not know this and will attach a 12 MB photo. Surface the
  failure clearly at submission time.
- **Two writers to Drafts**, once auto-draft and client-side APPEND coexist.
  UID assignment is centralized in the Durable Object, so this stays
  consistent, but clients will occasionally resync.
- **DO duration billing** if a future push-based IDLE holds connections
  without hibernation.
- **`EMAIL_ADDRESSES` allowlist** interacts with mailbox visibility over IMAP
  and still needs a decision on whether LIST reflects it.

## Effort, planned vs. actual

The original estimate assumed phases would land in order and mostly stay in
their lane:

| Phase | Estimate |
|---|---|
| 0, foundations | 4 to 5 days |
| 1, read-only IMAP | 1 to 1.5 weeks |
| 2, writes and SMTP | 1 to 1.5 weeks |
| 3, full integration | ~1 week |

That did not hold, for the reason documented above: read-only IMAP was not
viable against a real client, so STORE, COPY, MOVE, and EXPUNGE moved out of
phase 2 and into the same push as phase 1, compressing the schedule for those
two phases into one continuous effort. SMTP submission and real-push IDLE are
still ahead of where the original phase 2/3 estimate put them.

`go-imap` handles the wire format. It did not, and does not, handle
correctness: UIDVALIDITY discipline, EXPUNGE sequencing, and FETCH partials
were where the time actually went, along with the three failures above that
only a live client and a live deploy could surface.
