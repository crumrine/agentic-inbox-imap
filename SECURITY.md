# Security policy

## Reporting a vulnerability

Report privately via GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository. Please do not open a public issue for anything exploitable.

This is a self-hosted personal project maintained on a best-effort basis. There
is no SLA. Expect an acknowledgement within a week.

## Scope

This repository is two components with different exposure:

- **The Worker** (`workers/`, `app/`) runs on Cloudflare and is gated by
  Cloudflare Access.
- **The gateway** (`gateway/`) is an IMAP/SMTP server. By default it binds only
  a Tailscale address and refuses to start on any other address unless
  `AGENTIC_ALLOW_PUBLIC_BIND=true` is set explicitly.

## Known and accepted limitations

These are documented rather than hidden. They are design constraints, not
undiscovered bugs, and reports about them are unlikely to be actionable.

- **Cloudflare Access is the primary trust boundary and there is no per-mailbox
  authorization.** Anyone past the Access policy can operate on every mailbox,
  including through the MCP endpoint. This is inherited from the upstream
  project and is by design.
- **App passwords are a second, weaker credential path.** Mail clients cannot
  present a Cloudflare Access identity, so each mailbox can have app passwords
  for IMAP and SMTP.
- **PBKDF2 runs at 100,000 iterations, below OWASP guidance of 600,000.**
  Cloudflare Workers' WebCrypto refuses anything higher. This is acceptable
  only because app passwords are machine-generated with 100 bits of entropy, so
  the KDF is defence in depth rather than the barrier. If this ever accepts a
  user-chosen password, 100,000 is not enough.
- **The gateway is a trusted component.** It authenticates a client's app
  password once, then uses a Cloudflare Access service token for every
  subsequent call. A compromised gateway can read every mailbox behind that
  token.
- **Auth response timing leaks how many app passwords a mailbox has**, though
  not whether the mailbox exists. Response bodies are identical.
- **App-password rate limiting is per mailbox.** A single guess sprayed across
  many mailboxes is not bounded by it.

See `docs/imap-gateway.md` for the full security model and the reasoning behind
each of these.
