// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
import {cloudflareTest} from '@cloudflare/vitest-pool-workers';
import {defineConfig} from 'vitest/config';
export default defineConfig({
  resolve:{alias:{'virtual:react-router/server-build':new URL('./test/ssr-stub.ts',import.meta.url).pathname}},
  plugins:[cloudflareTest({main:'./test/worker-entry.ts',wrangler:{configPath:'./wrangler.jsonc'},remoteBindings:false,
    miniflare:{serviceBindings:{MAIL_SCORER:'html-scorer'},workers:[{name:'html-scorer',modules:true,
      scriptPath:'./.html-inspection/scorer.js',compatibilityDate:'2026-10-21',
      outboundService:()=>{throw new Error('forbidden_scorer_network');}}]},
  })],
  test:{include:['test/html-joined.integration.ts'],setupFiles:['./test/setup.ts'],maxWorkers:1,testTimeout:30000,hookTimeout:30000},
});
