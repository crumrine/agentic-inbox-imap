// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

export const feedbackSchema = z.object({
  emailId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.-]+$/),
  disposition: z.enum(['spam', 'not_spam']),
  expectedRevision: z.number().int().min(0).max(2147483646),
}).strict();
export const preferenceSchema = z.object({
  sender: z.string().max(254).email().transform(s => s.toLowerCase()),
  preference: z.enum(['allow', 'block', 'none']),
  expectedRevision: z.number().int().min(0).max(2147483646),
}).strict();
export type Feedback = z.infer<typeof feedbackSchema>;
export type Preference = z.infer<typeof preferenceSchema>;
export type MutationResult = {ok:true; revision:number} | {ok:false; error:'not_found' | 'conflict' | 'invalid'};

// Identity/capability is not serializable mail/tool input. Only the REST
// boundary mints it, from verified Access human identity and browser intent.
const authorities = new WeakSet<object>();
export interface ManualAuthority { readonly mailboxId: string }
export function authorizeManualFeedback(request: Request, mailboxId: string, verifiedHuman: string | undefined): ManualAuthority | null {
  if (!verifiedHuman || request.headers.get('origin') !== new URL(request.url).origin ||
      request.headers.get('sec-fetch-site') !== 'same-origin' ||
      request.headers.get('x-inbox-manual-action') !== '1' ||
      request.headers.get('content-type')?.split(';')[0] !== 'application/json') return null;
  const authority = Object.freeze({mailboxId});
  authorities.add(authority);
  return authority;
}
export function hasManualAuthority(authority: ManualAuthority, mailboxId: string): boolean {
  return authorities.has(authority) && authority.mailboxId === mailboxId;
}
