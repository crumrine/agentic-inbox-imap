// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

declare module "cloudflare:test" {
	// Bindings available to tests, from wrangler.jsonc via `wrangler types`.
	interface ProvidedEnv extends Env {}
}
