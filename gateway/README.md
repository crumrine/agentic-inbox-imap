# agentic-imapd

A small, stateless IMAP/SMTP gateway for [agentic-inbox](../README.md).

Cloudflare Workers cannot accept inbound TCP connections, so IMAP cannot
terminate in the Worker. `agentic-imapd` is an always-on process - meant to
run on a small VPS or home server on your [Tailscale](https://tailscale.com)
network - that speaks IMAP and SMTP submission to mail
clients and calls the Worker's HTTP API as its only backing store.

**It is stateless.** No mail, no database, no durable state on disk. The
mailbox Durable Object in the Worker stays the single source of truth;
`agentic-imapd` is a protocol translator in front of it.

## Status

Read/write IMAP. Configuration, the backend HTTP client, the process
entrypoint, deploy files, and the IMAP protocol session
(`internal/imap.Session`) are all implemented.

Serving now: CAPABILITY, NOOP, LOGOUT, AUTHENTICATE PLAIN, LOGIN, ID, LIST,
LSUB, STATUS, SELECT, EXAMINE, CLOSE, UNSELECT, SEARCH, FETCH (including
ENVELOPE, BODYSTRUCTURE, BODY[...] with HEADER.FIELDS and partial ranges),
IDLE, STORE of message flags, COPY, MOVE, EXPUNGE and APPEND. MOVE and
UIDPLUS are advertised, so clients use one round trip to move a message and
get real COPYUID and APPENDUID response codes back.

APPEND streams the client's literal straight through to the Worker and is
never buffered here: it is the one request whose size a client chooses, so
buffering it would be the one place this process could be made to allocate
arbitrarily. APPENDLIMIT is advertised and matches the size the fetch path
will serve back, so an oversize message is refused with NO [TOOBIG] before
a byte of it is uploaded. The Worker deduplicates on Message-ID, which is
what stops every sent message appearing twice when a client saves its own
Sent copy after submission.

New mail reaches a client two ways, both through the same append-only
refresh: `Poll` runs after every command, and `Idle` runs it on a timer for
as long as the client holds an IDLE open. Neither ever renumbers or removes
a message inside a selection, so a deletion made elsewhere stays visible
until the client reselects.

IDLE is polling, not push. `DefaultIdleInterval` is 30s, which is the
freshness a client watching a mailbox gets. A push channel from the Durable
Object (Trellis DEV-674) is the better answer and is still open.

ID is answered but not advertised: go-imap has no handler for it and builds
CAPABILITY from a fixed list, so the gateway intercepts it below the library
(`internal/imap/idproxy.go`) rather than rewriting responses on the way out.
Clients send it unsolicited, which is the case that matters.

Flag writes are served because refusing them is not survivable. iOS Mail
sets `\Seen` the moment it displays a message; a NO to that was treated as a
fatal server error, and the client tore the connection down and reconnected
in a loop without ever rendering the message. `+FLAGS`, `-FLAGS` and `FLAGS`
all work, in both the `.SILENT` and echoing forms. `\Draft` and `\Recent`
are ignored rather than rejected: `\Draft` is a property of the folder in
this data model, and nothing is ever reported as recent. PERMANENTFLAGS
advertises exactly what STORE will persist, and an EXAMINE'd mailbox
advertises none and refuses STORE, as RFC 9051 requires.

Deleting works the way clients expect it to. `\Deleted` plus EXPUNGE, and
MOVE to Trash, both do what they say. Expunging renumbers, which is the one
place the snapshot shrinks: the untagged EXPUNGE responses go out in
descending sequence order so each removal only renumbers messages the
client has already been told about. A message that disappears any other way,
such as a deletion in the web UI, deliberately does *not* shrink the
snapshot; it stays addressable and fails to fetch, because renumbering a
mailbox under a client that was never sent an EXPUNGE is worse than a stale
entry.

There is one case where staying stale is not safe, and it is handled
differently. If the selected folder is replaced (UIDVALIDITY changes) or
disappears entirely, every UID the client holds now means something else,
or nothing. That is the only situation in which continuing would make a
client *actively wrong* rather than merely behind, so the selection is
poisoned: every subsequent FETCH, SEARCH, STORE, COPY, MOVE and UID EXPUNGE
fails with a `NO` telling the client to reselect, until it does. The
snapshot is not renumbered or shrunk on the way, the connection survives,
and both SELECT and CLOSE clear the fault. A transient backend failure does
*not* poison: it says nothing about the folder, so the snapshot is kept.

### Folder size ceiling

IMAP sequence numbers are positional, so the whole mapping has to be known
at SELECT and the snapshot cannot be lazy. `DefaultMaxFolderMessages` caps
one selection at 50,000 messages; beyond that SELECT answers `NO [LIMIT]`
rather than silently serving a prefix.

The bound is memory, and it is measured rather than assumed:
`BenchmarkSelectionFootprint` reports about 500 bytes per message with
realistic envelopes, so the ceiling is roughly 24 MiB for one selected
folder, and a few connections each selecting something different multiply
it. Raising the constant is a one-line change; multiply by the measured
figure first.

Not served: mailbox management (CREATE, DELETE, RENAME, SUBSCRIBE) answers
NO and keeps the connection alive.

## SMTP submission

`internal/smtp` accepts outbound mail on **465, implicit TLS only**, using
the same certificate, the same tailnet bind interlock and the same app
passwords as IMAP. There is deliberately no cleartext port and no STARTTLS
on 587: the whole posture is that nothing listens publicly and credentials
never cross unencrypted. A cleartext connection is dropped by the listener
before it is greeted, and `AllowInsecureAuth` is off so AUTH is not even
advertised on one.

Every message is streamed to `POST /api/imap/v1/{mailbox}/submit`, never
buffered, which is what puts it through `validateSender`, the per-mailbox
rate limit and the Sent folder. `MAIL FROM` must equal the authenticated
mailbox and is rejected before DATA, so a client is told before it uploads.
`SIZE 5242880` is advertised, matching Cloudflare's outbound cap, so an
oversize message is refused up front rather than after the upload.

The temporary/permanent split on failures is deliberately asymmetric. Only
the statuses the contract defines as the client's own fault are permanent
(403 sender validation to 550, 413 too large to 552); everything else,
including anything unrecognised, is a 451 so the client queues and retries.
Losing a message the user wrote is worse than a retry loop, which is at
least visible.

The `From:` header is **not** checked here, only the envelope sender. See
`internal/smtp/smtp.go` for why.

Both listeners are independently optional and neither can stop IMAP from
starting. `AGENTIC_SMTP_ADDR` (465) and `AGENTIC_SMTP_STARTTLS_ADDR` (587)
each default to the detected Tailscale address on their port; set either to
`off` to disable it. If a listener cannot bind, the daemon logs the failure
and carries on. The journal records which listeners came up, so a
misconfiguration is visible there rather than only as a client error.

Verified against iOS Mail over the tailnet with a live Worker: connect, full
folder sync, UID SEARCH, UID FETCH with BODY.PEEK[HEADER] and partial ranges,
IDLE holding open until DONE, flag writes persisting, and COPY, MOVE and
EXPUNGE against a real mailbox (COPYUID correct, descending EXPUNGE, no UID
reuse). APPEND is covered against a fake backend and an in-process go-imap
server, including appending a real message over the wire and reading it back
out, but has not yet run against a real client.

SMTP submission on 465 is verified live: a real send authenticated, queued,
recorded a Sent copy with the client's Message-ID, and was delivered back
into the inbox. The 587 STARTTLS door is covered against a fake backend and
a real go-smtp server over a pipe, including a real TLS handshake and a
full EHLO/STARTTLS/EHLO/AUTH/MAIL/RCPT/DATA/QUIT exchange, but has not yet
carried a real message.

## Why Tailscale-only

`agentic-imapd` listens **only** on a Tailscale interface address
(100.64.0.0/10) or loopback - never a public address. This is a deliberate
security decision, not a temporary limitation:

- No public port 993 means no credential-stuffing surface and no
  abuse-monitoring burden.
- TLS certificates come from `tailscale cert`, so there is no ACME/Let's
  Encrypt path to operate, and no public DNS record is required.
- Mail clients (or a client-side Tailscale-aware proxy) reach it over your
  tailnet exactly like any other private service.

This is enforced in code, not just by convention: `internal/config`
resolves the configured listen address and refuses to start if it is not
loopback or in the Tailscale CGNAT range, unless
`AGENTIC_ALLOW_PUBLIC_BIND=true` is explicitly set. There is a unit test
(`internal/config/config_test.go`) covering this guard.

## Layout

```
gateway/
  go.mod                     separate Go module: github.com/crumrine/agentic-inbox-imap/gateway
  cmd/agentic-imapd/main.go  entrypoint: load config, build backend client, start listener, graceful shutdown
  internal/config/           configuration from environment, with validation and the public-bind guard
  internal/backend/          typed HTTP client for the Worker's IMAP-gateway API
  internal/imap/             imapserver.Session: FETCH, SEARCH, append-only Poll, plus
                             STORE/COPY/MOVE/EXPUNGE/APPEND mutations (mutate.go)
  internal/smtp/             empty package placeholder (phase 2)
  deploy/                    systemd unit + example env file
```

It is a separate Go module (its own `go.mod`) so the Node/TypeScript build
in the rest of this repo never sees it, and `npm`/`vitest` never try to
touch Go files.

## Build

Requires Go 1.27+.

```sh
cd gateway
go build ./...
go vet ./...
go test ./...
```

Produces a single static binary at `./agentic-imapd` if you build the
`cmd/agentic-imapd` package directly:

```sh
go build -o agentic-imapd ./cmd/agentic-imapd
```

## Dependencies

Dependency surface is intentionally small - this is meant to be
open-sourced, and every dependency is a maintenance and audit cost:

- [`github.com/emersion/go-imap/v2`](https://github.com/emersion/go-imap)
  **pinned at `v2.0.0-beta.8`**. The `imapserver` package has been pre-1.0
  for a long time and has broken its API across beta releases before;
  bumping this pin should be a deliberate, tested change, not a routine `go
  get -u`. Pulls in `github.com/emersion/go-message` and
  `github.com/emersion/go-sasl` transitively.
- Everything else is the standard library. No config framework, no logging
  framework (uses `log/slog`), no HTTP router (the backend client builds
  requests by hand).

## Configuration

All configuration is environment variables, validated at startup - the
process fails fast with an error naming the missing or invalid variable. No
secret value is ever included in an error message or log line.

| Variable | Required | Description |
|---|---|---|
| `AGENTIC_INBOX_URL` | yes | Base URL of the Worker, e.g. `https://mail.example.com` |
| `AGENTIC_ACCESS_CLIENT_ID` | one of client ID/secret or cookie | Cloudflare Access service token client ID, sent as the `CF-Access-Client-Id` header on every request to the Worker |
| `AGENTIC_ACCESS_CLIENT_SECRET` | one of client ID/secret or cookie | Cloudflare Access service token secret, sent as `CF-Access-Client-Secret` |
| `AGENTIC_ACCESS_COOKIE` | one of client ID/secret or cookie | A full `CF_Authorization=...` cookie header, used instead of the service token for local testing only |
| `AGENTIC_TLS_CERT` | yes | Path to a certificate from `tailscale cert` |
| `AGENTIC_TLS_KEY` | yes | Path to the matching private key from `tailscale cert` |
| `AGENTIC_IMAP_ADDR` | no | Listen address, `host:port`. If unset, `agentic-imapd` scans local interfaces for a `100.64.0.0/10` address and binds it on port 993. 993 is privileged, so the shipped systemd unit grants `CAP_NET_BIND_SERVICE`; set a port above 1024 here if you would rather drop that capability. |
| `AGENTIC_LOG_LEVEL` | no | `debug` \| `info` (default) \| `warn` \| `error` |
| `AGENTIC_ALLOW_PUBLIC_BIND` | no | `true` to disable the public-bind safety interlock. Leave unset in production. |

See `deploy/agentic-imapd.env.example` for a filled-out template.

## Deploy

1. Build the binary (or cross-compile: `GOOS=linux GOARCH=arm64 go build -o
   agentic-imapd ./cmd/agentic-imapd`) and copy it to the target host as
   `/usr/local/bin/agentic-imapd`.
2. Bring up Tailscale on the host and run `tailscale cert
   <your-magicdns-name>` to get a cert/key pair. Point
   `AGENTIC_TLS_CERT`/`AGENTIC_TLS_KEY` at them. `tailscale cert` refreshes
   certificates as they approach expiry when run again (e.g. from a cron
   job or timer) - `agentic-imapd` does not manage renewal itself.
3. Create a Cloudflare Access service token for the Worker's `/api/imap/v1/`
   routes and put its ID/secret in `AGENTIC_ACCESS_CLIENT_ID` /
   `AGENTIC_ACCESS_CLIENT_SECRET`.
4. Copy `deploy/agentic-imapd.env.example` to
   `/etc/agentic-imapd/agentic-imapd.env`, fill it in, and `chmod 600` it
   (it holds a secret).
5. Copy `deploy/agentic-imapd.service` to
   `/etc/systemd/system/agentic-imapd.service`, create the
   `agentic-imapd` system user/group it runs as, then:

   ```sh
   sudo systemctl daemon-reload
   sudo systemctl enable --now agentic-imapd
   ```

The unit runs with heavy sandboxing (`ProtectSystem=strict`, no writable
paths, and `CAP_NET_BIND_SERVICE` as its only capability) since the process
is stateless and only needs outbound HTTPS to the Worker, inbound TLS on
the tailnet, and read access to the cert/key files.

That one capability exists because the default listen port is 993, which is
privileged: without it a default install fails `bind(2)` with `EACCES` and
restart-loops. If you set `AGENTIC_IMAP_ADDR` to a port above 1024 you can
empty both `CapabilityBoundingSet=` and `AmbientCapabilities=` in the unit
and run with no capabilities at all, at the cost of configuring a
non-default port by hand in every mail client.

## Requirements this gateway assumes

- The host is on your Tailscale network (`tailscale up` has been run and
  the interface has a `100.64.0.0/10` address).
- The Worker exposes `/api/imap/v1/*` behind Cloudflare Access, and a
  service token has been provisioned for this gateway.
- Nothing else - no database, no local mail storage, no cron jobs. If the
  process is killed and restarted, it comes back up with zero local state.
