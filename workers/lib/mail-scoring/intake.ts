// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
import type { Email } from 'postal-mime';
import type { Env } from '../../types';
import { decodeResponse, encodeBoundedJson, type ScoreInputV1, type ScoreResultV1 } from './protocol';
import { LIMITS } from './contract';

export const POLICY_VERSION = 'inbox-scoring-8';

export interface Assessment {
  version: 1;
  policyVersion: 'inbox-shadow-1' | 'inbox-scoring-2' | 'inbox-scoring-3' | 'inbox-scoring-4' | 'inbox-scoring-5' | 'inbox-scoring-6' | 'inbox-scoring-7' | typeof POLICY_VERSION;
  status: 'partial' | 'unavailable';
  inputIncomplete: boolean;
  result: ScoreResultV1 | null;
}
export const unavailable = (): Assessment => ({version:1, policyVersion:POLICY_VERSION, status:'unavailable', inputIncomplete:true, result:null});
export const RAW_INSPECTION_BYTES = 131072;

/** Scoring-only preflight; it does not make the inherited MIME parser safe. */
export function inspectableRaw(raw: Uint8Array, complete: boolean): boolean {
  return complete === true && raw.byteLength <= RAW_INSPECTION_BYTES;
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
  let text = field(parsed.text, 32768);
  // Do not replace a present over-budget plain body with a different HTML body.
  const plainOmitted = Boolean(parsed.text) && !text;
  let html = plainOmitted || text.trim() ? undefined : field(parsed.html, 32768) || undefined;
  // PostalMime flattens inline message/rfc822 bodies beneath these generated headers.
  // shortcut: omit the whole scoring body; split current/forwarded provenance if mixed-mail recall requires it.
  if (/(?:^|[\r\n])-{3,}[\r\n]+(?:From|Subject|Date|To|Cc|Bcc):[ \t]/.test(text) || html?.includes('class="postal-email-header"')) {
    // Preserve quote status so copied subject/name clues cannot cause automatic routing.
    text = '>';
    html = undefined;
    complete = false;
  }
  const urls: string[] = [];
  // The 32 KiB body cap bounds the linear line/token scans.
  for (const line of text.split(/\r\n|[\r\n]/)) {
    const prefix = line.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').replace(/^[ \t]+/, '').slice(0, 29).toLowerCase();
    if (prefix.startsWith('>')) { complete = false; continue; }
    if (prefix.startsWith('-----original message-----') || prefix.startsWith('---------- forwarded message')) {
      complete = false;
      break;
    }
    for (const match of line.matchAll(/https?(?::\/\/|%)[^\s<>"']+/gi)) {
      if (match.index > 0 && /[\p{L}\p{N}_%]/u.test(line[match.index - 1])) continue;
      if (urls.length === LIMITS.urls) { complete = false; break; }
      const token = field(match[0], LIMITS.urlBytes);
      if (!token) continue;
      let brackets = 0;
      for (const char of token) {
        if (char === '[') brackets++;
        else if (char === ']') brackets--;
      }
      let end = token.length;
      while (end > 0) {
        const last = token[end - 1];
        if (last === ']' && brackets < 0) brackets++;
        else if (!'.,;:!?)}'.includes(last)) break;
        end--;
      }
      const url = token.slice(0, end);
      // Keep raw URL controls from being stripped into new URL evidence downstream.
      if (/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(url)) { complete = false; continue; }
      if (url) urls.push(url);
    }
    if (urls.length === LIMITS.urls) { complete = false; break; }
  }
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
  // HTML visibility, attachments and remaining headers are not completely inspected.
  // Keep omissions explicit even when the upstream service says complete.
  if (parsed.html || parsed.attachments.length || parsed.headers.length !== headers.length || (parsed.replyTo?.length ?? 0) > 1) complete = false;
  return {schemaVersion:'1', policyVersion:POLICY_VERSION, subject, text, urls, addresses, headers, ...(html ? {html} : {}),
    sourceComplete:complete, transport:{provenance:'unknown',complete:false,spf:'unknown',dkim:'unknown',dmarc:'unknown'}};
}

export async function assessArrival(env: Env, parsed: Email, rawInspectable: boolean, envelopeFrom?: string, preference?: 'allow' | 'block' | 'none'): Promise<Assessment | undefined> {
  if (env.MAIL_SCORING_MODE !== 'shadow' && env.MAIL_SCORING_MODE !== 'filter') return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!rawInspectable || !env.MAIL_SCORER) return unavailable();
    const input = project(parsed, envelopeFrom);
    // A body omitted by the inspection budget must not become a subject-only verdict.
    if ((parsed.text && !input.text) || (!input.text.trim() && parsed.html && !input.html)) return unavailable();
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
    return {version:1, policyVersion:POLICY_VERSION, status:'partial', inputIncomplete:!input.sourceComplete, result:decoded.result};
  } catch { return unavailable(); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

export function shouldQuarantine(assessment: Assessment | undefined, preference: 'allow' | 'block' | 'none' | undefined): boolean {
  const result = assessment?.result;
  if (!result || assessment.status === 'unavailable' || result.status === 'unavailable' ||
      preference === undefined || preference === 'allow') return false;
  if (preference === 'block') return true;
  if ((result.ruleSetVersion === 'rules-2' || result.ruleSetVersion === 'rules-3' || result.ruleSetVersion === 'rules-4' || result.ruleSetVersion === 'rules-5' || result.ruleSetVersion === 'rules-6' || result.ruleSetVersion === 'rules-7' || result.ruleSetVersion === 'rules-8' || result.ruleSetVersion === 'rules-9') && result.signals.spam === 'present' &&
      result.reasons.some(reason => reason.id === 'gtube' && reason.contribution > 0)) return true;
  // Only the current model enables content routing; historical assessments remain readable.
  if (result.ruleSetVersion === 'rules-9' && result.heuristicScore >= 60 && result.signals.spam === 'present' &&
      result.limitsHit.every(limit => ['auth_unknown', 'source_incomplete', 'html_uninspected', 'identity_uninspected'].includes(limit)) &&
      result.reasons.some(reason => reason.id === 'statistical_word_pair_spam' && reason.contribution > 0)) return true;
  // shortcut: conservative rules-1 policy, recalibrate with privately labelled mail before broadening.
  return result.heuristicScore >= 45 &&
    result.limitsHit.every(limit => limit === 'auth_unknown' || limit === 'source_incomplete') &&
    result.reasons.some(reason => reason.id === 'sensitive_request_combined' && reason.contribution === 25) &&
    result.reasons.some(reason => ['reply_to_mismatch', 'display_identity_mismatch', 'impersonation_combined'].includes(reason.id) && reason.contribution > 0);
}
