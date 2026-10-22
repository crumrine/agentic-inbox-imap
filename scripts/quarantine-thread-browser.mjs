// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
// Actual SPA/query/API client; all mail and HTTP responses are synthetic.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const out = process.env.EVIDENCE_DIR || 'docs/evidence/dev-879-thread-fix';
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
try {
 for (const width of (process.env.BROWSER_WIDTHS || '1440,390').split(',').map(Number)) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  page.setDefaultTimeout(60000);
  let failed = false, threadCalls = 0, selectedCalls = 0, rejectedCalls = 0;
  const network = [], errors = [];
  const selected = { id: 'trusted', subject: 'Trusted thread', sender: 'friend@example.test', recipient: 'ui@example.test', folder_id: 'inbox', date: '2026-10-21T10:00:00Z', read: true, body: '<p>Trusted body</p>', thread_id: 'crossing', snippet: 'Trusted body', attachments: [], thread_count: 2 };
  const moved = { ...selected, id: 'reply', sender: 'QUARANTINE_PARTICIPANT@example.test', body: '<p>QUARANTINE_BODY_CANARY</p>', snippet: 'QUARANTINE_BODY_CANARY', date: '2026-10-21T09:00:00Z' };
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
   const req = route.request(), url = new URL(req.url());
   if (url.origin !== 'http://127.0.0.1:5189') { network.push(req.url()); return route.abort(); }
   if (!url.pathname.startsWith('/api/')) return route.continue();
   const path = url.pathname.split('/').slice(5).join('/'); let data;
   if (path === 'folders') data = ['inbox','sent','draft','archive','trash','spam'].map(id => ({ id, name: id, is_deletable: false, unreadCount: 0 }));
   else if (path === 'emails') data = { emails: url.searchParams.get('folder') === 'inbox' ? [selected] : [], totalCount: url.searchParams.get('folder') === 'inbox' ? 1 : 0 };
   else if (path.startsWith('threads/')) {
    threadCalls++;
    if (failed) { rejectedCalls++; return route.fulfill({ status: 503, json: { error: 'Synthetic rejected thread refresh' } }); }
    data = [selected, moved].filter(e => e.folder_id !== 'spam');
   } else if (path === 'emails/trusted/spam') data = { revision: 0, disposition: 'unknown', assessments: [] };
   else if (path === 'sender-preference') data = { preference: 'none', revision: 0 };
   else if (path === 'emails/trusted') { selectedCalls++; data = selected; }
   else if (url.pathname === '/api/v1/config') data = { domains: ['example.test'], emailAddresses: [] };
   else data = { id: 'ui@example.test', email: 'ui@example.test', name: 'Synthetic mailbox', settings: {} };
   return route.fulfill({ json: data });
  });
  await page.goto('http://127.0.0.1:5189', { waitUntil: 'domcontentloaded' });
  if (width < 768) await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
  await page.locator('a[href="/mailbox/ui@example.test/emails/inbox"]').click();
  await page.getByText('Trusted thread', { exact: true }).click();
  await page.getByText('QUARANTINE_PARTICIPANT@example.test', { exact: true }).waitFor();
  await page.getByText('2 messages in this thread', { exact: true }).waitFor();
  console.log(JSON.stringify({phase:'initial-thread',width,threadCalls,selectedCalls}));
  const beforeSelected = selectedCalls;
  moved.folder_id = 'spam'; failed = true;
  // Real production 30-second polling and retry delays. No fake timers/cache writes.
  await page.waitForTimeout(35000);
  const result = { width, threadCalls, rejectedCalls, selectedCalls, beforeSelected,
   visibleParticipant: await page.getByText('QUARANTINE_PARTICIPANT@example.test', { exact: true }).count(),
   visibleSnippet: await page.getByText('QUARANTINE_BODY_CANARY', { exact: true }).count(),
   visibleThreadCount: await page.getByText('2 messages in this thread', { exact: true }).count(),
   visibleReply: await page.getByRole('button', { name: 'Reply', exact: true }).count(), network, errors };
  await fs.writeFile(`${out}/thread-${width}.json`, JSON.stringify(result, null, 2));
  await page.screenshot({ path: `${out}/thread-error-${width}.png`, fullPage: true });
  assert.ok(rejectedCalls >= 3, 'Failed refresh must exhaust the production two retries');
  assert.ok(selectedCalls > beforeSelected, 'Selected detail must refresh successfully independently');
  assert.equal(result.visibleParticipant, 0, 'Failed thread refresh must discard quarantined participants');
  assert.equal(result.visibleSnippet, 0, 'Failed thread refresh must discard quarantined snippets');
  assert.equal(result.visibleThreadCount, 0, 'Unvalidated children must not supply message counts');
  assert.equal(result.visibleReply, 0, 'Unvalidated children must not supply reply targets');
  await page.getByText('Conversation unavailable. Retry to load its current messages.', { exact: true }).waitFor();
  failed = false;
  await page.getByRole('button', { name: 'Retry conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Reply', exact: true }).waitFor();
  assert.equal(await page.getByText('QUARANTINE_PARTICIPANT@example.test', { exact: true }).count(), 0);
  assert.equal(await page.getByText('2 messages in this thread', { exact: true }).count(), 0);
  result.manualRetryRecovered = true;
  // Ordinary alternate-client rescue restores the reply on a subsequent successful poll.
  moved.folder_id = 'inbox';
  await page.getByText('QUARANTINE_PARTICIPANT@example.test', { exact: true }).waitFor();
  await page.getByText('2 messages in this thread', { exact: true }).waitFor();
  result.rescueRestored = true;
  result.finalThreadCalls = threadCalls;
  assert.deepEqual(network, []); assert.deepEqual(errors, []);
  await page.screenshot({ path: `${out}/thread-recovered-${width}.png`, fullPage: true });
  await fs.writeFile(`${out}/thread-${width}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  await page.close();
 }
} finally { await browser.close(); }
