// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
import type { Email } from 'postal-mime';
import type { Env } from '../../types';
import { decodeResponse, encodeBoundedJson, type ScoreInputV1, type ScoreResultV1 } from './protocol';

export interface Assessment {
  version: 1;
  policyVersion: 'inbox-shadow-1';
  status: 'partial' | 'unavailable';
  inputIncomplete: boolean;
  result: ScoreResultV1 | null;
}
export const unavailable = (): Assessment => ({version:1, policyVersion:'inbox-shadow-1', status:'unavailable', inputIncomplete:true, result:null});
export const RAW_INSPECTION_BYTES = 131072;

/** Scoring-only preflight; it does not make the inherited MIME parser safe. */
export function inspectableRaw(raw: Uint8Array): boolean {
  if (raw.byteLength > RAW_INSPECTION_BYTES) return false;
  // Do not decode raw MIME. A short declared stream is zero padded by the
  // existing intake helper; never call that complete scoring input.
  return !raw.includes(0);
}

/** Construct only fixed bounded fields; never serialize a mail object. */
export function project(parsed: Email, envelopeFrom?: string): ScoreInputV1 {
  let complete = true;
  const field = (value: string | undefined, max: number): string => {
    if (!value) return '';
    if (value.length > max || new TextEncoder().encode(value).byteLength > max) {
      complete = false;
      return ''; // Omit whole over-limit fields; no broken UTF-8 truncation.
    }
    return value;
  };
  const subject = field(parsed.subject, 2048);
  const text = field(parsed.text, 32768);
  const addresses = {
    from: field(parsed.from?.address, 512),
    replyTo: field(parsed.replyTo?.[0]?.address, 512),
    envelopeFrom: field(envelopeFrom, 512),
    displayName: field(parsed.from?.name, 512),
  };
  const headers: ScoreInputV1['headers'] = [];
  // Only marketing evidence is useful here. Auth/ARC/x-spam header strings
  // cannot establish provenance and are deliberately never forwarded.
  const allowed = new Set(['list-id', 'list-unsubscribe', 'precedence']);
  if (parsed.headers.length > 100) complete = false;
  let headerBytes = 0;
  for (let i = 0; i < Math.min(parsed.headers.length, 100); i++) {
    const h = parsed.headers[i];
    if (h.key.length > 64) { complete = false; continue; }
    if (!allowed.has(h.key.toLowerCase())) continue;
    const value = field(h.value, 2048);
    headerBytes += value.length * 3 + h.key.length;
    if (headerBytes > 8192) { complete = false; break; }
    headers.push({name:h.key.toLowerCase(), value});
  }
  // HTML, attachments and remaining headers are intentionally uninspected.
  // Keep omissions explicit even when the upstream service says complete.
  if (parsed.html || parsed.attachments.length || parsed.headers.length !== headers.length || (parsed.replyTo?.length ?? 0) > 1) complete = false;
  return {schemaVersion:'1', policyVersion:'inbox-shadow-1', subject, text, addresses, headers,
    sourceComplete:complete, transport:{provenance:'unknown',complete:false,spf:'unknown',dkim:'unknown',dmarc:'unknown'}};
}

export async function assessArrival(env: Env, parsed: Email, rawInspectable: boolean, envelopeFrom?: string, preference?: 'allow' | 'block' | 'none'): Promise<Assessment | undefined> {
  if (env.MAIL_SCORING_MODE !== 'shadow') return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!rawInspectable || !env.MAIL_SCORER) return unavailable();
    const input = project(parsed, envelopeFrom);
    if (preference) input.preferences = {senderAllowed:preference === 'allow',senderBlocked:preference === 'block'};
    const bytes = encodeBoundedJson(JSON.stringify(input));
    if (!bytes) return unavailable();
    // Bounds protect synchronous work. This timer only limits waiting and
    // does not cancel service CPU or an already-started RPC.
    const wire = await Promise.race([
      env.MAIL_SCORER.scoreV1('1', bytes, JSON.stringify({transportVerified:false,preferencesVerified:preference !== undefined})),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1000); }),
    ]);
    const decoded = decodeResponse(wire);
    if (!decoded?.ok || decoded.result.status === 'unavailable') return unavailable();
    // The caller never supplies trusted authentication facts. Reject a service
    // response that invents those facts, even if its wire shape is valid.
    if (decoded.result.reasons.some(r => r.id === 'auth_failed' ||
        (r.id === 'sender_allowed' && preference !== 'allow') ||
        (r.id === 'sender_blocked' && preference !== 'block'))) return unavailable();
    // Unverified transport always leaves this intake assessment partial.
    return {version:1, policyVersion:'inbox-shadow-1', status:'partial', inputIncomplete:!input.sourceComplete, result:decoded.result};
  } catch { return unavailable(); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
