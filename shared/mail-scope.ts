// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
/** Explicit Spam review is isolated from every normal cross-folder read. */
export type MailScope = 'normal' | 'spam';
export function mailScope(value?: string): MailScope { return value === 'spam' ? 'spam' : 'normal'; }
/** Inert, bounded text: never parse suspicious HTML into a DOM or activate links. */
export function suspiciousText(value: unknown, limit = 16384): string {
  return typeof value === 'string' ? value.slice(0, Math.min(limit, 16384)) : '';
}
