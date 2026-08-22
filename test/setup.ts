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
 * `reset()`, empties KV/R2/D1/cache but -- verified here -- does NOT clear
 * Durable Object SQLite, so MailboxDO uid sequences would leak between tests.
 *
 * So: wipe each MailboxDO's storage explicitly, then abort every live instance
 * so the next test reconstructs from scratch and re-runs the migrations.
 */
afterEach(async () => {
	for (const id of await listDurableObjectIds(env.MAILBOX)) {
		await runInDurableObject(env.MAILBOX.get(id), (_instance, state) =>
			state.storage.deleteAll(),
		);
	}
	await abortAllDurableObjects();
	await reset();
});
