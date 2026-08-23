// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	abortAllDurableObjects,
	env,
	listDurableObjectIds,
	reset,
	runInDurableObject,
} from "cloudflare:test";
import { afterEach } from "vitest";

/**
 * Per-test isolated storage.
 *
 * @cloudflare/vitest-pool-workers v0.22 (the Vitest 4 line) dropped the
 * declarative `poolOptions.workers.isolatedStorage` flag. Its replacement,
 * `reset()`, clears neither of the two stores this app keeps state in --
 * both verified here, by probe:
 *
 *   * **Durable Object SQLite** survives it, so MailboxDO uid sequences and
 *     rows would leak between tests.
 *   * **R2** survives it too. That one is the quieter trap: `mailboxes/{id}`,
 *     `aliases/{address}` and the raw `.eml` objects are all R2 keys, so an
 *     alias created in one test is still resolvable in the next -- and
 *     `createAlias` refuses to overwrite an existing record, so the *second*
 *     test's setup silently does nothing and the test fails for a reason that
 *     has nothing to do with what it is asserting.
 *
 * So both are wiped explicitly: every MailboxDO's storage, then every R2
 * object, then abort the live instances so the next test reconstructs from
 * scratch and re-runs the migrations.
 */
afterEach(async () => {
	for (const id of await listDurableObjectIds(env.MAILBOX)) {
		await runInDurableObject(env.MAILBOX.get(id), (_instance, state) =>
			state.storage.deleteAll(),
		);
	}

	let cursor: string | undefined;
	do {
		const page = await env.BUCKET.list({ cursor, limit: 1000 });
		if (page.objects.length > 0) {
			await env.BUCKET.delete(page.objects.map((o) => o.key));
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);

	await abortAllDurableObjects();
	await reset();
});
