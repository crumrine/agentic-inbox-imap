// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			// wrangler.jsonc's `main` is the React Router worker, which imports
			// the `virtual:react-router/server-build` module that only exists
			// during a `react-router build`. Tests only need the Durable Object
			// classes, so they run against a thin entrypoint that exports them.
			main: "./test/worker-entry.ts",
			wrangler: { configPath: "./wrangler.jsonc" },
			// Keep tests fully local: never reach for a real Cloudflare account
			// for the `ai` / `send_email` bindings.
			remoteBindings: false,
		}),
	],
	test: {
		include: ["test/**/*.test.ts"],
		// Isolated storage: see test/setup.ts. v0.22 of the pool replaced the
		// old `poolOptions.workers.isolatedStorage` flag with an explicit
		// reset() hook.
		setupFiles: ["./test/setup.ts"],
	},
});
