# IMAP/SMTP Gateway

Design doc for exposing Agentic Inbox mailboxes to standard mail clients
(Apple Mail, Thunderbird, mobile clients) over IMAP, with SMTP submission.

Status: planned. Nothing in this document is implemented yet.

## Why a gateway exists at all

IMAP is a TCP protocol. Workers cannot accept inbound TCP connections, and
Cloudflare does not offer an IMAP service, so the protocol cannot terminate
inside the Worker. From the Workers TCP sockets documentation:

> Support for handling inbound TCP connections is coming soon. Currently, it
> is not possible to make an inbound TCP connection to your Worker.

So IMAP requires one always-on host. The design goal is to make that host as
close to disposable as possible: the gateway holds no mail, no database, and
no durable state. The Durable Object remains the single source of truth.

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

## Why the data model needs work first

Agentic Inbox stores a *rendering* of each message, not the message. IMAP is a
*store* protocol and needs the original bytes plus stable identity. The gaps:

| Gap | Current state | Needed for |
|---|---|---|
| Raw MIME discarded | `workers/index.ts` parses with PostalMime, drops the buffer | `BODY[]`, `RFC822`, `BODYSTRUCTURE` |
| No UID / UIDVALIDITY | ids are `crypto.randomUUID()` | Every IMAP operation |
| Flags are two ints | `read`, `starred` in `workers/db/schema.ts` | `\Answered`, `\Deleted`, `\Draft`, keywords |
| No message size | not stored | `RFC822.SIZE` on every FETCH |
| No APPEND path | n/a | Clients saving Sent and Drafts copies |
| Access JWT is the only auth | `workers/app.ts` middleware | Mail clients cannot speak Access |

### Raw MIME retention is urgent and not backfillable

This is the one item that gets more expensive every day it waits. Existing
messages have no raw form and never will. For those, the gateway must
synthesize MIME from the stored body, R2 attachments, and the `raw_headers`
JSON. Synthesized MIME is a *different message* than what arrived: DKIM
verification fails, S/MIME and PGP signatures break, and byte sizes shift.

Storing raw costs about three lines at receive time, where the ArrayBuffer is
already in hand before `PostalMime` consumes it. Ship it independently of
whether the rest of this plan ever happens.

Outbound mail has the mirror problem: the app hands structured fields to the
send binding and Cloudflare builds the MIME, so there is no raw copy of sent
messages either. Synthesize a compliant message at send time and store that.
It will not byte-match what Cloudflare transmitted, but for reading back your
own Sent folder that is fine.

## Schema changes

Migration `9_imap_uid_flags` in `workers/durableObject/migrations.ts`, with
`workers/db/schema.ts` updated by hand to match (Drizzle is a query builder
here, not a migration tool).

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

Notes:

- UIDs are per folder, not per mailbox. A message moved between folders gets a
  new UID in the target. `MailboxDO.createEmail` and `MailboxDO.moveEmail` are
  the only assignment sites.
- The Durable Object is a single writer, so UID allocation needs no locking.
  This is one of the places the existing architecture pays off.
- The migration backfills UIDs per folder ordered by `date`, then sets
  `uid_next`. One time, deterministic.
- `read` and `starred` stay as they are and keep mapping to `\Seen` and
  `\Flagged`. The SPA is untouched.
- `raw_key` avoids an R2 HEAD per message during a full-folder FETCH.
- The existing `date` column already stores receive time rather than the `Date`
  header, which is exactly the right value for INTERNALDATE. The header date
  for ENVELOPE comes from parsing the raw message.

### R2 layout additions

```
raw/{mailboxId}/{emailId}.eml          the original message
credentials/{mailboxId}.json           app password hashes
```

Credentials deliberately live outside `mailboxes/{id}.json`. That settings blob
is read into the agent's prompt path (`getSystemPrompt`), and credential
material must never be reachable from an AI code path.

## Authentication

Two independent legs.

**Client to gateway:** app passwords, one or more per mailbox, generated in
Settings and shown once. Hashed with PBKDF2-HMAC-SHA256 (available in Workers
WebCrypto without WASM) at current OWASP iteration guidance. Clients
authenticate with `AUTHENTICATE PLAIN` over implicit TLS.

**Gateway to Worker:** a Cloudflare Access service token
(`CF-Access-Client-Id` / `CF-Access-Client-Secret`), which is the supported way
for a non-browser client to pass an Access policy.

### This changes the security model, and the docs must say so

The README currently states that Cloudflare Access is the single trust
boundary. After this work that is no longer true: app passwords are a second,
weaker door into every mailbox. The gateway is also trusted to scope each
session to the authenticated mailbox, since it holds a service token that can
reach all of them. Both facts need to be written down rather than discovered.

## Worker API for the gateway

A dedicated surface under `/api/imap/v1`, shaped for IMAP access patterns
rather than reusing the SPA API. Mounted before the React Router catch-all,
alongside `/mcp` and `/agents/*`.

```
POST   /api/imap/v1/auth                                  verify app password
GET    /api/imap/v1/{mailbox}/folders                     uid_validity, uid_next, counts
GET    /api/imap/v1/{mailbox}/{folder}/messages           batch metadata by UID range
GET    /api/imap/v1/{mailbox}/messages/{uid}/raw          stream the .eml
POST   /api/imap/v1/{mailbox}/{folder}/flags              batch flag updates      (phase 2)
POST   /api/imap/v1/{mailbox}/{folder}/append             store a client message  (phase 2)
POST   /api/imap/v1/{mailbox}/{folder}/expunge                                    (phase 2)
GET    /api/imap/v1/{mailbox}/events                      WebSocket, for IDLE     (phase 3)
```

The metadata endpoint returns everything a FETCH needs without touching the raw
body: uid, flags, internaldate, rfc822_size, and envelope fields. A client doing
a full sync should never pull raw bytes just to answer a size or envelope query.

## Phases

### Phase 0: foundations (Worker only, no gateway)

Ships value on its own and stops the archive from getting worse. Raw MIME
retention, the schema migration, and the credential store.

### Phase 1: read-only IMAP

Proof of concept and the useful 80%. Go module at `gateway/`, `go-imap` v2
`imapserver.Session` implementation, tailnet bind, `tailscale cert`, systemd
unit.

In scope: CAPABILITY, NOOP, LOGOUT, AUTHENTICATE PLAIN, LOGIN, LIST, LSUB,
STATUS, SELECT (served read-only), EXAMINE, CLOSE, UNSELECT, SEARCH (ALL, UID,
sequence sets, SINCE/BEFORE, FROM/TO/SUBJECT/BODY/TEXT, SEEN/UNSEEN, FLAGGED),
FETCH (UID, FLAGS, INTERNALDATE, RFC822.SIZE, ENVELOPE, BODYSTRUCTURE, BODY[],
BODY[HEADER], BODY[TEXT], BODY[HEADER.FIELDS (...)], partial `<n.m>`).

Explicitly out: STORE, APPEND, COPY, MOVE, EXPUNGE, IDLE, CONDSTORE. Clients
poll. Marking a message read in the client will not stick, which is the known
and accepted cost of a read-only phase.

Acceptance: Apple Mail on macOS and iOS plus Thunderbird all connect over the
tailnet, list folders, sync the inbox, and render a threaded HTML message with
attachments. A DKIM-signed message verifies in Thunderbird, which proves the
raw pipeline is byte-exact end to end.

### Phase 2: writes and submission

STORE for `\Seen`, `\Flagged`, `\Answered`, `\Deleted` and custom keywords.
COPY, MOVE, EXPUNGE, APPEND. `go-smtp` submission on the tailnet, authenticating
against the same app passwords and handing off to the existing Worker send path
so `validateSender`, the per-mailbox rate limit, Sent recording, and threading
all still apply.

Two decisions to record when implementing:

- **EXPUNGE semantics.** `\Deleted` sets the column. EXPUNGE moves to Trash for
  every folder except Trash itself, where it hard-deletes. This matches both
  client expectation and the app's existing move-to-trash model.
- **Sent duplication.** Most clients APPEND their own copy to Sent after
  submission, and the app records its own. Deduplicate on `Message-ID`.

Do not point clients at `smtp.mx.cloudflare.net` directly. It works, but the
password is a Cloudflare API token authorized for every address on the domain,
and mail sent that way never enters the app, so the Sent folder silently
diverges.

### Phase 3: full integration

IDLE, backed by a WebSocket from the gateway to the mailbox DO. Use the
hibernatable WebSocket API so an idle client does not hold the DO in memory and
accrue duration charges. The inbound-mail hook that already fires the agent's
auto-draft is the natural broadcast point.

Then: CONDSTORE/QRESYNC if client resync cost justifies it, app password
management in Settings, agent-authored drafts visible in the client Drafts
folder, and the open-source packaging work.

## Repository layout

```
gateway/
  go.mod                        separate module; the Node build never sees it
  cmd/agentic-imapd/
  internal/imap/                go-imap session implementation
  internal/smtp/                go-smtp submission
  internal/backend/             HTTP client for /api/imap/v1
  README.md                     build, configure, deploy
  deploy/                       systemd unit, example config
docs/imap-gateway.md            this document
```

### Licensing and attribution

This repository is a fork of `cloudflare/agentic-inbox` under Apache 2.0, and
existing files carry `Copyright (c) 2026 Cloudflare, Inc.` headers. New files
must not claim Cloudflare copyright. Before publishing:

- New source files get an Apache 2.0 header with correct attribution.
- A `NOTICE` file records the fork, upstream project, and license.
- The README states what is upstream and what is added here.

## Risks

- **go-imap v2 API churn.** The v2 `imapserver` package has been pre-1.0 for a
  long time. Pin the version and expect breaking changes on upgrade.
- **Legacy messages are permanently lossy** over IMAP. Nothing recovers them.
- **5 MiB outbound limit.** Cloudflare Email Service caps total message size,
  including attachments, at 5 MiB. Mail clients do not know this and will
  attach a 12 MB photo. Surface the failure clearly at submission time.
- **Two writers to Drafts.** The agent auto-drafts while a client syncs the same
  folder. UID assignment is centralized in the DO, so this is consistent, but
  clients will occasionally resync.
- **DO duration billing** if IDLE connections are held without hibernation.
- **`EMAIL_ADDRESSES` allowlist** interacts with mailbox visibility over IMAP
  and needs a decision on whether LIST reflects it.

## Effort

Rough, part-time:

| Phase | Estimate |
|---|---|
| 0, foundations | 4 to 5 days |
| 1, read-only IMAP | 1 to 1.5 weeks |
| 2, writes and SMTP | 1 to 1.5 weeks |
| 3, full integration | ~1 week |

`go-imap` handles the wire format. It does not handle correctness: UIDVALIDITY
discipline, EXPUNGE sequencing, and FETCH partials are where the time goes.
