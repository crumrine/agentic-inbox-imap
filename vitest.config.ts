// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSync } from "esbuild";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const SCORER_PIN = "cf588bf2870964f691e420f5e5249aa3255806f8";
const GENERAL1_SCORER_PIN = "041e79c5f56880b8eff0e210968569461cb95fc0";
const PREVIOUS_SCORER_PIN = "faa15bea06db52f2dc240257d5335a66a933f909";
const LEGACY_SCORER_PIN = "2fab406320ae3b3596345d2c76e0ef8a08593211";

function buildScorerWorkers() {
	const dir = [
		process.env.MAIL_SCORING_DIR,
		resolve(process.cwd(), "../mail-scoring"),
		resolve(process.cwd(), "../../mail-scoring"),
		"/Users/brian/projects/mail-scoring",
		"/home/brian/r9-jobs/home/symphony-workspaces/siteforge/mail-scoring",
	].find((candidate): candidate is string => Boolean(candidate && existsSync(join(candidate, "workers/private/index.ts"))));
	if (!dir) return undefined;
	const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	if (head !== SCORER_PIN) {
		throw new Error(`Expected mail-scoring HEAD ${SCORER_PIN}, got ${head}`);
	}
	const bundle = (entry: string) =>
		buildSync({
			entryPoints: [entry],
			bundle: true,
			write: false,
			nodePaths:[join(dir,"node_modules")],
			format: "esm",
			platform: "neutral",
			external: ["cloudflare:workers"],
		}).outputFiles[0].text;
	const current = bundle(join(dir, "workers/private/index.ts"));
	const temp = mkdtempSync(join(tmpdir(), "mail-scoring-legacy-"));
	let legacy: string;
	let previous: string;
	let general1: string;
	try {
		const archive = execFileSync("git", ["-C", dir, "archive", LEGACY_SCORER_PIN, "tsconfig.json", "packages/core", "workers/private"], { maxBuffer: 8 * 1024 * 1024 });
		execFileSync("tar", ["-x", "-C", temp], { input: archive });
		legacy = bundle(join(temp, "workers/private/index.ts"));
		const old = execFileSync("git", ["-C", dir, "archive", PREVIOUS_SCORER_PIN, "tsconfig.json", "packages/core", "workers/private"], {maxBuffer:8*1024*1024});
		execFileSync("tar", ["-x", "-C", temp], {input:old});
		previous = bundle(join(temp, "workers/private/index.ts"));
		const general = execFileSync("git", ["-C", dir, "archive", GENERAL1_SCORER_PIN, "tsconfig.json", "packages/core", "workers/private"], {maxBuffer:8*1024*1024});
		execFileSync("tar", ["-x", "-C", temp], {input:general});
		general1 = bundle(join(temp,"workers/private/index.ts"));
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
	return {
		serviceBindings: {
			MAIL_SCORER: "mail-scoring-private",
			MAIL_SCORER_LEGACY: "mail-scoring-legacy",
			MAIL_SCORER_PREVIOUS: "mail-scoring-previous",
			MAIL_SCORER_GENERAL1: "mail-scoring-general1",
		},
		workers: [
			{ name:"mail-scoring-general1", compatibilityDate:"2025-11-28", modules:[{type:"ESModule" as const,path:"index.mjs",contents:general1}] },
			{ name:"mail-scoring-previous", compatibilityDate:"2025-11-28", modules:[{type:"ESModule" as const, path:"index.mjs", contents:previous}] },
			{
				name: "mail-scoring-private",
				compatibilityDate: "2025-11-28",
				modules: [{ type: "ESModule" as const, path: "index.mjs", contents: current }],
			},
			{
				name: "mail-scoring-legacy",
				compatibilityDate: "2025-11-28",
				modules: [{ type: "ESModule" as const, path: "index.mjs", contents: legacy }],
			},
		],
	};
}

export default defineConfig({
	resolve: { alias: { "virtual:react-router/server-build": new URL("./test/ssr-stub.ts", import.meta.url).pathname } },
	plugins: [
		cloudflareTest({
			// wrangler.jsonc's `main` is the React Router worker, which imports
			// the `virtual:react-router/server-build` module that only exists
			// during a `react-router build`. Tests only need the Durable Object
			// classes, so they run against a thin entrypoint that exports them.
			main: "./test/worker-entry.ts",
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: buildScorerWorkers(),
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
