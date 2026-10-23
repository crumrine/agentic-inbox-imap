// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
import { suspiciousText } from 'shared/mail-scope';
export default function SuspiciousPreview({body}: {body?: string | null}) {
  return <section aria-label="Safe Spam preview" className="p-4">
    <p className="text-sm mb-3">Spam review: source shown as text. Images, links, styles and attachments are inactive. Preview limited to 16,384 characters.</p>
    <pre className="whitespace-pre-wrap break-all text-sm">{suspiciousText(body)}</pre>
  </section>;
}
