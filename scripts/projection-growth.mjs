// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const scratch = await mkdtemp(resolve('.projection-growth-'));
const out = resolve(process.env.EVIDENCE_DIR || 'docs/evidence/dev-993');
try {
  const module = join(scratch, 'intake.mjs');
  await build({entryPoints:['workers/lib/mail-scoring/intake.ts'], outfile:module, bundle:true, platform:'node', format:'esm'});
  const {project} = await import(pathToFileURL(module));
  const samples = [];
  for (const size of [2048, 4096, 8192, 16384, 32000]) {
    const text = 'https://' + '.'.repeat(size) + 'a';
    const started = performance.now();
    const input = project({subject:'Synthetic', text, headers:[], attachments:[]});
    const elapsedMs = performance.now() - started;
    samples.push({sourceCharacters:text.length, elapsedMs, retainedUrls:input.urls.length});
    await mkdir(out, {recursive:true});
    await writeFile(join(out, 'projection-growth.json'), JSON.stringify({node:process.version, samples,
      scope:'Synthetic local synchronous projection wall time; not hosted CPU or billing. A wide 250ms ceiling catches the former multi-second suffix-regex regression.'}, null, 2) + '\n');
    assert.deepEqual(input.urls, []);
    assert.equal(input.sourceComplete, false);
    assert.ok(elapsedMs < 250, 'bounded original URL token projection exceeded 250ms');
  }
  console.log(JSON.stringify(samples));
} finally {
  await rm(scratch, {recursive:true, force:true});
}
