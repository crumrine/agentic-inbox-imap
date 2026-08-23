# Contributing

## Layout

Two components, deliberately separable:

- **Worker + SPA** at the repository root. TypeScript, Cloudflare Workers,
  React Router, Durable Objects, R2.
- **`gateway/`** is a **separate Go module**
  (`github.com/crumrine/agentic-inbox-imap/gateway`) with its own `LICENSE` and
  `NOTICE`. It has no *code* dependency on the Worker, but it is not useful
  without one: it is a client of the `/api/imap/v1` HTTP contract, and every
  IMAP command it serves needs a matching Worker endpoint. The two are
  co-developed on purpose, which is why they share a repository.

Please keep that boundary. **No commit should touch both `gateway/` and the
Worker.** A commit spanning the two produces mangled history if the gateway is
ever split out with `git subtree split`.

## Building and testing

```bash
npm install            # this repo is npm-locked, not pnpm
npm run typecheck      # regenerates worker-configuration.d.ts; the real gate
npm test

cd gateway
go build ./... && go vet ./... && gofmt -l .
go test ./... -count=1
go test ./internal/... -race -count=2
```

`-count=2` on the race run is deliberate. A harness flake was found that only
reproduced at count 2, and every earlier race-clean claim had been made at
count 1 and would not have caught it.

## Testing expectations

A passing test is not evidence on its own. **Check that a new test fails
against the unfixed code**, especially for anything security-relevant.

One real example from this codebase: a non-buffering assertion passed with
buffering deliberately reintroduced, because the fake type-asserted the reader
and a buffering implementation handed over a different type, so the assertion
fell through to the zero value. A type-assertion-guarded assertion is vacuous
exactly when the behaviour under test is broken.

## Things that will not be obvious

- **The Durable Object runtime forbids SQL-level `BEGIN TRANSACTION`.** See the
  `txn()` helper and `storage.transactionSync()` in the migration runner.
- **Drizzle is a query builder here, not a migration tool.** Schema changes go
  in `workers/durableObject/migrations.ts` and `workers/db/schema.ts` must be
  updated by hand to match.
- **`send_email` is bound with `"remote": true`.** It genuinely delivers from
  local dev, and it hangs under the test runner, so tests substitute a fake.
- **A mail client treats a refused routine command as a fatal server error.**
  Returning `NO` to something a client considers ordinary causes reconnect
  loops, not graceful degradation. This cost three separate rounds during
  development; see the post-mortem in `docs/imap-gateway.md`.

## Licensing

Apache 2.0. New files must carry their own copyright, not the upstream
Cloudflare notice. See `NOTICE` for provenance.
