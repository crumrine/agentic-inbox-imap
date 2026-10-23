// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

vi.mock("agents", () => ({ routeAgentRequest: () => { throw new Error("forbidden_agent"); } }));
vi.mock("../workers/agent", () => ({ EmailAgent: class {} }));
vi.mock("../workers/mcp", () => ({ EmailMCP: { serve: () => ({ fetch: () => { throw new Error("forbidden_mcp"); } }) } }));
import worker from "../workers/app";
import { app } from "../workers/index";
import { storeRawMime } from "../workers/lib/raw-mime";
import type { Env } from "../workers/types";
import { mailbox } from "./helpers";

const BOX = "diagnostics@inbox.test";
const CANARY = "PRIVATE_SYNTHETIC_CANARY\nforged_log_record";
const raw = new TextEncoder().encode(`From: sender@sender.test\r\nTo: ${BOX}\r\nSubject: ${CANARY.split("\n")[0]}\r\nContent-Type: text/plain\r\n\r\nSynthetic body.`);
function message() {
  return { raw: new ReadableStream({ start(c) { c.enqueue(raw); c.close(); } }), rawSize: raw.length,
    from: "sender@sender.test", to: BOX, setReject: vi.fn() } as unknown as ForwardableEmailMessage;
}
function bindings(bucket: R2Bucket) {
  const forbidden = vi.fn(() => { throw new Error("forbidden_send_or_ai"); });
  const e = { ...env, BUCKET: bucket, DOMAINS: "inbox.test", EMAIL_ADDRESSES: [], MAIL_SCORING_MODE: "off",
    EMAIL: { send: forbidden }, AI: { run: forbidden }, EMAIL_AGENT: { idFromName: forbidden, get: forbidden } } as unknown as Env;
  return { e, forbidden };
}

describe("content-free inbound diagnostics", () => {
  it("keeps deferred send failures content-free while preserving the accepted response", async () => {
    await env.BUCKET.put(`mailboxes/${BOX}.json`, "{}");
    const send = vi.fn(async () => { throw new Error(CANARY); });
    const e = { ...env, EMAIL: { send } } as unknown as Env;
    const ctx = createExecutionContext(), log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await app.fetch(new Request(`https://internal/api/v1/mailboxes/${BOX}/emails`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: BOX, to: "recipient@sender.test", subject: "Synthetic", text: "Synthetic." }),
      }), e, ctx);
      await waitOnExecutionContext(ctx);
      expect(r.status).toBe(202); expect(send).toHaveBeenCalledTimes(1);
      expect(log.mock.calls).toEqual([["deferred_email_delivery_failed"]]);
    } finally { log.mockRestore(); }
  });
  it("preserves actual inbound delivery after raw storage failure, with only a static diagnostic", async () => {
    await env.BUCKET.put(`mailboxes/${BOX}.json`, "{}");
    const put = vi.fn(async () => { throw new Error(CANARY); });
    const bucket = new Proxy(env.BUCKET, { get(target, key) {
      if (key === "put") return put;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const b = bindings(bucket), m = message(), ctx = createExecutionContext();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await worker.email(m, b.e, ctx); await waitOnExecutionContext(ctx);
      const rows = await mailbox(BOX).getEmails({ folder: "inbox" });
      expect(rows).toHaveLength(1);
      const full = await mailbox(BOX).getEmail(rows[0].id) as { raw_key: string | null; rfc822_size: number };
      expect(full.raw_key).toBeNull(); expect(full.rfc822_size).toBe(raw.length);
      expect(put).toHaveBeenCalledTimes(1); expect(m.setReject).not.toHaveBeenCalled();
      expect(b.forbidden).not.toHaveBeenCalled();
      expect(log.mock.calls).toEqual([["raw_mime_storage_failed"]]);
    } finally { log.mockRestore(); }
  });

  it.each([null, "synthetic string", { get message(): never { throw new Error(CANARY); } }])(
    "raw storage also preserves the fallback for arbitrary thrown values (%#)", async failure => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const bucket = { put: async () => { throw failure; } } as unknown as R2Bucket;
        expect(await storeRawMime(bucket, BOX, "synthetic-id", raw)).toEqual({ raw_key: null, rfc822_size: raw.length, body_structure: null });
        expect(log.mock.calls).toEqual([["raw_mime_storage_failed"]]);
      } finally { log.mockRestore(); }
    },
  );

  it.each([new Error(CANARY), null, { get message(): never { throw new Error(CANARY); }, get stack(): never { throw new Error(CANARY); } }])(
    "keeps internal failures thrown without exposing untrusted diagnostics (%#)", async failure => {
      const b = bindings({ head: async () => { throw failure; } } as unknown as R2Bucket);
      const m = message(), ctx = createExecutionContext();
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(worker.email(m, b.e, ctx)).rejects.toThrow("inbound_email_processing_failed");
        expect(m.setReject).not.toHaveBeenCalled(); expect(b.forbidden).not.toHaveBeenCalled();
        expect(log.mock.calls).toEqual([["inbound_email_processing_failed"]]);
      } finally { log.mockRestore(); }
    },
  );
});
