// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
import {execFileSync,spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
import {mkdirSync} from 'node:fs';
import {build} from 'esbuild';
import assert from 'node:assert/strict';
const scorer=resolve(process.argv[2] ?? '../mail-scoring');
const pin='eaa4aa0ab1be6f017d37cd1347e8727e5960751e';
assert.equal(execFileSync('git',['-C',scorer,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),pin);
assert.equal(execFileSync('git',['-C',scorer,'status','--porcelain'],{encoding:'utf8'}).trim(),'');
const requireScorer=createRequire(join(scorer,'package.json'));
const binary=requireScorer('workerd').default;
mkdirSync('.html-inspection',{recursive:true});
await build({entryPoints:[join(scorer,'workers/private/index.ts')],outfile:'.html-inspection/scorer.js',bundle:true,format:'esm',platform:'browser',target:'es2024',external:['cloudflare:workers']});
const run=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','--config','vitest.html.config.ts'],{stdio:'inherit',env:{...process.env,MINIFLARE_WORKERD_PATH:binary}});
if(run.status!==0)process.exit(run.status??1);
