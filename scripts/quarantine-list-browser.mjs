// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
// Actual SPA/list query/API client; synthetic HTTP only, with production timers/retries.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const out = process.env.EVIDENCE_DIR || 'docs/evidence/dev-879-list-fix';
await fs.mkdir(out, { recursive: true });
const origin = 'http://127.0.0.1:5189';
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
try {
  for (const width of (process.env.BROWSER_WIDTHS || '1440,390').split(',').map(Number)) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    page.setDefaultTimeout(45000);
    let failed = false, holdResponse, responseStarted;
    const requests = [], network = [], errors = [];
    const row = { id: 'external-move', subject: 'QUARANTINE_LIST_SUBJECT',
      sender: 'QUARANTINE_LIST_SENDER@example.test', recipient: 'ui@example.test',
      folder_id: 'inbox', date: '2026-10-21T10:00:00Z', read: false,
      thread_id: 'crossing', thread_count: 2, thread_unread_count: 1,
      needs_reply: true, has_draft: true, participants: 'QUARANTINE_LIST_SENDER@example.test',
      snippet: 'QUARANTINE_LIST_SNIPPET', body: 'Synthetic body', attachments: [] };
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { network.push(url.href); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const path = url.pathname.split('/').slice(5).join('/');
      let data;
      if (path === 'folders') {
        data = ['inbox', 'sent', 'draft', 'archive', 'trash', 'spam'].map(id =>
          ({ id, name: id, is_deletable: false, unreadCount: 0 }));
      } else if (path === 'emails') {
        const folder = url.searchParams.get('folder');
        requests.push({ folder, status: folder === 'inbox' && failed ? 503 : 200 });
        if (folder === 'inbox' && failed) {
          return route.fulfill({ status: 503, json: { error: 'Synthetic unavailable list' } });
        }
        if (folder === 'inbox' && holdResponse) {
          responseStarted();
          await holdResponse;
        }
        const emails = row.folder_id === folder ? [row] : [];
        data = { emails, totalCount: emails.length };
      } else if (url.pathname === '/api/v1/config') {
        data = { domains: ['example.test'], emailAddresses: [] };
      } else {
        data = { id: 'ui@example.test', email: 'ui@example.test', name: 'Synthetic mailbox', settings: {} };
      }
      return route.fulfill({ json: data });
    });
    async function folderLink(folder) {
      const link = page.locator(`a[href="/mailbox/ui@example.test/emails/${folder}"]`);
      // A translated offscreen sidebar still has CSS visibility on mobile.
      if (width < 768 && !await page.getByRole('button', { name: 'Close sidebar', exact: true }).isVisible()) {
        await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
      }
      await link.click();
    }
    const subject = page.getByText(row.subject, { exact: true });
    const count = page.getByText('1 conversation', { exact: true });
    const rows = page.locator('[role="button"][tabindex="0"]');
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    // The fixture starts in Spam. It must NOT contain the row before the move.
    await page.getByText('No spam', { exact: true }).waitFor();
    assert.equal(await subject.count(), 0);
    await folderLink('inbox');
    await subject.waitFor();
    assert.equal(await count.count(), 1);
    assert.equal(await rows.count(), 1);
    assert.ok((await rows.textContent()).includes(row.snippet));
    console.log(JSON.stringify({ phase: 'initial-inbox', width, requests }));

    row.folder_id = 'spam'; failed = true;
    // Exercise the real 30-second poll and both production server-error retries.
    await page.waitForTimeout(35000);
    const result = { width, browser: browser.version(), requests,
      rejectedCalls: requests.filter(r => r.folder === 'inbox' && r.status === 503).length,
      staleSubject: await subject.count(), staleCount: await count.count(),
      staleRows: await rows.count(), network, errors };
    await fs.writeFile(`${out}/list-${width}.json`, JSON.stringify(result, null, 2) + '\n');
    await page.screenshot({ path: `${out}/list-error-${width}.png`, fullPage: true });
    assert.equal(result.rejectedCalls, 3, 'Real polling must exhaust two retries');
    assert.equal(result.staleSubject, 0, 'Failed list revalidation must hide quarantined subjects');
    assert.equal(result.staleCount, 0, 'Failed list revalidation must hide retained aggregates');
    assert.equal(result.staleRows, 0, 'Sender, snippet, unread, needs-reply and draft indicators must leave the DOM');
    await page.getByRole('alert').filter({ hasText: 'Emails unavailable. Retry to refresh this folder.' }).waitFor();

    // Hold a real response: retained data must also be absent while retry is pending.
    failed = false;
    let releaseResponse;
    holdResponse = new Promise(resolve => { releaseResponse = resolve; });
    const started = new Promise(resolve => { responseStarted = resolve; });
    await page.getByRole('button', { name: 'Retry emails', exact: true }).click();
    await started;
    assert.equal(await subject.count(), 0);
    assert.equal(await count.count(), 0);
    assert.equal(await rows.count(), 0);
    releaseResponse(); holdResponse = undefined;
    await page.getByText('Your inbox is empty', { exact: true }).waitFor();
    result.retryRecovered = true;

    await folderLink('spam');
    await subject.waitFor();
    assert.equal(await count.count(), 1, 'Explicit Spam review remains available');
    result.explicitSpamReview = true;
    await folderLink('inbox');
    await page.getByText('Your inbox is empty', { exact: true }).waitFor();
    // An ordinary external rescue restores normal list metadata on manual refresh.
    row.folder_id = 'inbox';
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await subject.waitFor();
    assert.equal(await count.count(), 1);
    assert.equal(await rows.count(), 1);
    assert.ok((await rows.textContent()).includes(row.snippet));
    result.externalRescueRestored = true;

    // Revalidate an already-visible row slowly, rather than only the error case.
    holdResponse = new Promise(resolve => { releaseResponse = resolve; });
    const refreshing = new Promise(resolve => { responseStarted = resolve; });
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await refreshing;
    // The intercepted request can start before React commits its batched update.
    await subject.waitFor({ state: 'detached' });
    assert.equal(await subject.count(), 0, 'In-flight refresh must hide cached rows');
    assert.equal(await count.count(), 0, 'In-flight refresh must hide cached count');
    releaseResponse(); holdResponse = undefined;
    await subject.waitFor();
    result.inFlightHidesRowsAndCount = true;
    assert.deepEqual(network, []); assert.deepEqual(errors, []);
    await page.screenshot({ path: `${out}/list-recovered-${width}.png`, fullPage: true });
    await fs.writeFile(`${out}/list-${width}.json`, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
    await page.close();
  }
} finally { await browser.close(); }
