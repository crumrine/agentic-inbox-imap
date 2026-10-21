// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve, join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const dependency=resolve(process.argv[2] ?? '../mail-scoring');
const pin='bb02819e4662e1d680805435dd886e3dc4728906';
assert.equal(execFileSync('git',['-C',dependency,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),pin);
const hashes={};
for(const [source,copy] of [['packages/core/src/contract.ts','contract.ts'],['workers/private/protocol.ts','protocol.ts']]){
 const upstream=readFileSync(join(dependency,source),'utf8');
 const local=readFileSync(`workers/lib/mail-scoring/${copy}`,'utf8');
 assert.equal(local,upstream.replaceAll('../../packages/core/src/contract.js','./contract'));
 hashes[source]=createHash('sha256').update(upstream).digest('hex');
}
const temp=mkdtempSync(join(tmpdir(),'dev-878-contract-'));
try{
 const modules={};
 for(const [name,path] of [['scorer',join(dependency,'workers/private/adapter.ts')],['caller',resolve('workers/lib/mail-scoring/intake.ts')]]){
  const out=join(temp,name+'.mjs');
  await build({entryPoints:[path],outfile:out,bundle:true,format:'esm',platform:'node'});
  modules[name]=await import(pathToFileURL(out));
 }
 const parsed={from:{address:'sender@example.test',name:'Person'},subject:'Synthetic',text:'Hello synthetic world.',headers:[],attachments:[],headerLines:[]};
 const calls=[];
 const assessment=await modules.caller.assessArrival({MAIL_SCORING_MODE:'shadow',MAIL_SCORER:{scoreV1:async(...args)=>{
  calls.push(args);return modules.scorer.scoreRpc(...args);
 }}},parsed,true,'bounce@example.test');
 assert.equal(calls.length,1);assert.equal(assessment.status,'partial');assert.equal(assessment.result.schemaVersion,'1');
 assert.ok(assessment.result.limitsHit.includes('auth_unknown'));
 assert.equal(assessment.result.heuristicScore,0);
 const fixture={rpcVersion:'1',ok:true,result:assessment.result};
 writeFileSync('docs/evidence/dev-878/contract.json',JSON.stringify({dependency:pin,hashes,fixture,passed:true},null,2)+'\n');
 console.log('Pinned scorer/caller compatibility passed');
}finally{rmSync(temp,{recursive:true,force:true});}
