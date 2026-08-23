<div align="center">
  <h1>Agentic Inbox IMAP</h1>
  <p><em>A fork of Cloudflare's Agentic Inbox that adds IMAP and SMTP, so ordinary mail clients can use it</em></p>
</div>

> **This is an unofficial fork.** It is not maintained by, endorsed by, or
> affiliated with Cloudflare. The upstream project is
> [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox),
> Apache 2.0, and everything it does is still here. See [NOTICE](./NOTICE) for
> provenance and [what changed](#what-this-fork-adds).

Agentic Inbox lets you send, receive, and manage emails through a modern web
interface, all powered by your own Cloudflare account. Incoming mail arrives via
[Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/),
each mailbox is isolated in its own
[Durable Object](https://developers.cloudflare.com/durable-objects/) with a
SQLite database, and attachments are stored in
[R2](https://developers.cloudflare.com/r2/).

An **AI-powered Email Agent** can read your inbox, search conversations, and
draft replies, built with the
[Cloudflare Agents SDK](https://developers.cloudflare.com/agents/) and
[Workers AI](https://developers.cloudflare.com/workers-ai/).

![Agentic Inbox screenshot](./demo_app.png)

## What this fork adds

Upstream is a web client. This fork adds the pieces needed to point **Apple
Mail, iOS Mail or Thunderbird** at the same mailbox:

- **`gateway/`** - `agentic-imapd`, a stateless IMAP and SMTP submission server
  in Go. Workers cannot accept inbound TCP, so the protocol terminates on a
  small always-on host that holds no mail and no state of its own. It binds
  only a Tailscale address by default and refuses to start on a public one
  unless told to.
- **Raw MIME retention.** Upstream stored a parsed rendering of each message.
  IMAP needs the original bytes, so they are now kept in R2 and served
  verbatim. DKIM verifies against what is stored.
- **Per-mailbox app passwords**, because mail clients cannot present a
  Cloudflare Access identity.
- **A full IMAP write path** on the Worker: flags, copy, move, expunge, append
  and SMTP submission, so sent mail flows through the app's own sender
  validation and rate limiting.

Read [docs/imap-gateway.md](./docs/imap-gateway.md) for the design, the security
model, and a post-mortem of three failures that only appeared in production.

Read the blog post to learn more about Cloudflare Email Service and how to use it with the Agents SDK, MCP, and from the Wrangler CLI: [Email for Agents](https://blog.cloudflare.com/email-for-agents/).

## How to setup

**Important**: Clicking the 'Deploy to Cloudflare' button is only one part of the setup. You must follow the **After deploying** steps as well. For a full step-by-step guide with screenshots, refer to this comment: 
https://github.com/cloudflare/agentic-inbox/issues/4#issuecomment-4269118513

### To set up

1. Deploy to Cloudflare. The deploy flow will automatically provision R2, Durable Objects, and Workers AI. You'll be prompted for **DOMAINS**, which is the domain (yourdomain.com) you want to receive emails for (email@yourdomain.com).

     [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/crumrine/agentic-inbox-imap)

2. **Configure Cloudflare Access** -- Enable [one-click Cloudflare Access](https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/) on your Worker under Settings > Domains & Routes. The modal will show your `POLICY_AUD` and `TEAM_DOMAIN` values. `TEAM_DOMAIN` can be either your Access team URL or the full `.../cdn-cgi/access/certs` URL. **You must set these as secrets for your Worker.**
3. **Set up Email Routing** -- In the Cloudflare dashboard, go to your domain > Email Routing and create a catch-all rule that forwards to this Worker
4. **Enable Email Service** -- The worker needs the `send_email` binding to send outbound emails. See [Email Service docs](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/)
5. **Create a mailbox** -- Visit your deployed app and create a mailbox for any address on your domain (e.g. `hello@example.com`)

### Troubleshooting Access

1. If you see `Invalid or expired Access token`, that usually means `POLICY_AUD` or `TEAM_DOMAIN` secrets are incorrect.
   * Resolution: [turn Access off and back on for the Worker to get the Access modal again](https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/), then reset your Worker secrets to the latest `POLICY_AUD` and `TEAM_DOMAIN` values shown there.
2. If you see `Cloudflare Access must be configured in production`, this application is intentionally enforcing Cloudflare Access so your inbox is not exposed to anyone on the internet.
   * Resolution: enable Access using [one-click Cloudflare Access for Workers](https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/), then set the `POLICY_AUD` and `TEAM_DOMAIN` Worker secrets from the modal values.

## Features

- **Full email client** - Send and receive emails via Cloudflare Email Routing with a rich text composer, reply/forward threading, folder organization, search, and attachments
- **Per-mailbox isolation** - Each mailbox runs in its own Durable Object with SQLite storage and R2 for attachments
- **Built-in AI agent** - Side panel with 9 email tools for reading, searching, drafting, and sending
- **Auto-draft on new email** - Agent automatically reads inbound emails and generates draft replies, always requiring explicit confirmation before sending
- **Configurable and persistent** - Custom system prompts per mailbox, persistent chat history, streaming markdown responses, and tool call visibility

## Stack

- **Frontend:** React 19, React Router v7, Tailwind CSS, Zustand, TipTap, `@cloudflare/kumo`
- **Backend:** Hono, Cloudflare Workers, Durable Objects (SQLite), R2, Email Routing
- **AI Agent:** Cloudflare Agents SDK (`AIChatAgent`), AI SDK v6, Workers AI (`@cf/moonshotai/kimi-k2.5`), `react-markdown` + `remark-gfm`
- **Auth:** Cloudflare Access JWT validation (required outside local development)

## Getting Started

```bash
npm install
npm run dev
```

### Configuration

1. Set your domain in `wrangler.jsonc`
2. Create an R2 bucket named `agentic-inbox`: `wrangler r2 bucket create agentic-inbox`

### Deploy

```bash
npm run deploy
```

## Prerequisites

- Cloudflare account with a domain
- [Email Routing](https://developers.cloudflare.com/email-routing/) enabled for receiving
- [Email Service](https://developers.cloudflare.com/email-service/) enabled for sending
- [Workers AI](https://developers.cloudflare.com/workers-ai/) enabled (for the agent)
- [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) configured for deployed/shared environments (required in production)

## Security model

Anyone who passes the shared Cloudflare Access policy can reach every mailbox in this app, by design. This includes the MCP server at `/mcp` -- external AI tools (Claude Code, Cursor, etc.) connected via MCP can operate on any mailbox by passing a `mailboxId` parameter. There is no per-mailbox authorization behind Access; a single team policy is the trust boundary for the web app and the MCP server.

The IMAP gateway adds a second, narrower path, and it changes that picture. It's worth understanding both what it adds and what it doesn't protect against.

**App passwords are a second credential, scoped per mailbox.** Ordinary mail clients cannot present a Cloudflare Access identity, so each mailbox can have its own app passwords for IMAP login. They're hashed with PBKDF2-HMAC-SHA256 (600,000 iterations, a per-entry random salt) and stored in R2 at `credentials/{mailboxId}.json`, a key deliberately separate from `mailboxes/{id}.json`. That settings object is loaded into the AI agent's system prompt, so keeping credential material out of it isn't a style choice, it's what keeps a prompt injection or a stray `JSON.stringify` from being able to leak a password hash.

**The gateway itself is a trusted component, not a per-request-verified one.** It authenticates a mail client's app password once, at `POST /api/imap/v1/auth`, then uses a Cloudflare Access service token for every subsequent call: listing folders, fetching messages, reading raw MIME. Those read routes do not re-check the app password; they trust the gateway to have already matched the session to the right mailbox. That means a compromised or misbehaving gateway can read every mailbox behind that service token, not just the one it authenticated. The Worker has no way to tell those cases apart.

**Setting this up requires an explicit Access policy change.** The Cloudflare Access application in front of the Worker needs an allow rule for the gateway's service token (policy action "Service Auth", selecting the token), or the gateway can't reach the Worker at all. Once that rule exists, anything holding that token has the same reach the gateway does.

**The actual compensating control is network placement, not the service token.** The gateway (`gateway/`) binds only to a loopback or Tailscale (100.64.0.0/10) address and refuses to start on any other address unless `AGENTIC_ALLOW_PUBLIC_BIND=true` is explicitly set. There is no public IMAP port and therefore no internet-facing surface for password guessing. If you set that variable and expose it publicly, that's your decision and your risk to own; the default is closed.

**Brute-forcing app passwords is rate-limited per mailbox.** A Durable Object counts failed `/auth` attempts against each mailbox id and blocks further attempts once the window's limit is hit, so a sustained guess against one mailbox is bounded.

What this doesn't cover, stated plainly:

- **Auth response timing leaks how many app passwords a mailbox has, not whether it exists.** An unknown mailbox does one dummy password derivation to keep its timing close to a real check, but a mailbox with N app passwords does N derivations, so response time scales with N and an attacker can use that to estimate it. Response bodies are identical either way, so this is a minor signal, not a mailbox-existence oracle.
- **The rate limiter is per mailbox, not global.** An attacker guessing one password each across many different mailboxes isn't bounded by it; only repeated guesses against a single mailbox are.
- **The service-token trust path has been verified by reading the code, not by testing it against a live Cloudflare Access edge.** The Worker's Access middleware validates only the JWT's issuer and audience and never inspects an identity claim, which is why it accepts a service-token JWT the same way it accepts a user's, but that has been confirmed by code review, not by an end-to-end run through Access.
- **There's no UI yet for creating or revoking app passwords.** The credential store (`workers/lib/credentials.ts`) exists and is exercised by the gateway's auth flow, but today an app password can only be minted by calling that code directly, not from the app's UI.

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Browser    │────>│  Hono Worker     │────>│  MailboxDO      │
│  React SPA   │     │  (API + SSR)     │     │  (SQLite + R2)  │
│  Agent Panel │     │                  │     └─────────────────┘
└──────┬───────┘     │  /agents/* ──────┼────>┌─────────────────┐
       │             │                  │     │  EmailAgent DO  │
       │ WebSocket   │                  │     │  (AIChatAgent)  │
       └─────────────┤                  │     │  9 email tools  │
                     │                  │────>│  Workers AI     │
                     └──────────────────┘     └─────────────────┘
```

## License

Apache 2.0 -- see [LICENSE](LICENSE).
