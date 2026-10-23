// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
export const LIMITS = Object.freeze({
  requestBytes: 262144, sourceBytes: 131072, extractedBytes: 65536,
  headerBytes: 32768, headers: 100, headerFieldBytes: 8192,
  urls: 100, attachments: 32, subjectBytes: 2048, addressBytes: 512,
  urlBytes: 2048, filenameBytes: 255, typeBytes: 127,
  normalizedBytes: 65536, urlDecodePasses: 2,
  jsonDepth: 6, jsonTokens: 4096, outputBytes: 4096,
});
export const LIMIT_IDS = Object.freeze([
  'source_bytes', 'extracted_bytes', 'header_bytes', 'header_count',
  'header_field_bytes', 'url_count', 'attachment_count', 'field_bytes',
  'duplicate_header', 'control_chars', 'source_incomplete', 'html_uninspected',
  'auth_unknown', 'preferences_unknown', 'normalized_bytes', 'url_decode_limit',
  'url_uninspected', 'quoted_content', 'identity_uninspected',
] as const);
export type LimitId = typeof LIMIT_IDS[number];
export const REASONS = Object.freeze({
  auth_failed: 'Verified transport evidence reports authentication failure.',
  link_mismatch: 'A visible URL names a different host from its target.',
  link_userinfo: 'An HTTP link contains user information before its host.',
  reply_to_mismatch: 'The supplied reply address differs from the sender host.',
  display_identity_mismatch: 'The display identity names a different sender host.',
  impersonation_combined: 'An authority claim accompanies independent suspicious evidence.',
  sensitive_request_combined: 'A sensitive request accompanies suspicious link or identity evidence.',
  sender_blocked: 'An explicit verified sender block preference was supplied.',
  sender_allowed: 'An explicit verified address allow preference was supplied; other evidence remains.',
  marketing_headers: 'The message declares mailing-list or bulk characteristics.',
});
export const RULE_CAPS = Object.freeze({auth_failed:20,link_mismatch:30,link_userinfo:15,
  reply_to_mismatch:10,display_identity_mismatch:15,impersonation_combined:15,
  sensitive_request_combined:25,sender_blocked:40,sender_allowed:0,marketing_headers:0});
export const FAMILY_CAPS = Object.freeze({authentication:20,links:35,identity:20,content:25,preference:40,marketing:0});
export type ReasonId = keyof typeof REASONS;
export type AuthValue = 'pass' | 'fail' | 'unknown';
export interface ScoreInputV1 {
  schemaVersion: '1';
  policyVersion: string;
  subject: string;
  headers: Array<{name: string; value: string}>;
  text: string;
  html?: string;
  extractedText?: string;
  addresses?: {from?: string; replyTo?: string; envelopeFrom?: string; displayName?: string};
  urls?: string[];
  anchors?: Array<{text: string; href: string; quoted?: boolean}>;
  attachments?: Array<{filename: string; mediaType: string}>;
  transport?: {provenance: 'unknown' | 'upstream'; complete: boolean; spf: AuthValue; dkim: AuthValue; dmarc: AuthValue};
  preferences?: {senderAllowed: boolean; senderBlocked: boolean};
  sourceComplete: boolean;
}
/** Trusted application context, NEVER deserialized from email or scoring request. */
export interface ScoreContext { transportVerified?: boolean; preferencesVerified?: boolean; receivedAt?: number }
export type Status = 'complete' | 'partial' | 'unavailable';
export interface ScoreResultV1 {
  schemaVersion: '1'; engineVersion: '0.1.0'; ruleSetVersion: 'rules-1';
  status: Status;
  heuristicScore: number;
  signals: {spam: 'present' | 'unknown'; phishing: 'present' | 'unknown'; marketing: 'present' | 'unknown'};
  reasons: Array<{id: ReasonId; contribution: number; reason: typeof REASONS[ReasonId]}>;
  limitsHit: LimitId[];
  error: null | 'invalid_input' | 'request_limit' | 'invalid_json';
}
