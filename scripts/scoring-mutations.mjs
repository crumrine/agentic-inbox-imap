// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
import {readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const root=process.cwd(), records=[];
const wire=JSON.stringify(JSON.parse(readFileSync('docs/evidence/dev-878/contract.json','utf8')).fixture);
const parsed={subject:'Synthetic',text:'hello',headers:[],headerLines:[],attachments:[]};
const tests=[
 ['off','intake.ts',s=>s.replace("if (env.MAIL_SCORING_MODE !== 'shadow') return undefined;",''),async m=>{
  let calls=0;await m.assessArrival({MAIL_SCORING_MODE:'off',MAIL_SCORER:{scoreV1:async()=>{calls++;return wire;}}},parsed,true);assert.equal(calls,0);
 }],
 ['response_bound','protocol.ts',s=>s.replace("||wire.length>RPC_OUTPUT_BYTES",'').replace('if(new TextEncoder().encode(wire).byteLength>RPC_OUTPUT_BYTES)return null;',''),async m=>{
  assert.equal(m.decodeResponse(wire+' '.repeat(4096)),null);
 }],
 ['auth_provenance','intake.ts',s=>s.replace("provenance:'unknown'","provenance:'upstream'"),async m=>{
  assert.equal(m.project(parsed).transport.provenance,'unknown');
 }],
 ['manual_authority','feedback.ts',s=>s.replace('authorities.has(authority)','true'),async m=>{
  assert.equal(m.hasManualAuthority({mailboxId:'a@example.test'},'a@example.test'),false);
 }],
];
for(const [name,file,mutate,check] of tests){
 const temp=mkdtempSync(join(root,'.scoring-mutation-'));
 try{
  cpSync('workers/lib/mail-scoring',join(temp,'source'),{recursive:true});
  for(const mutant of [false,true]){
   const source=readFileSync(`workers/lib/mail-scoring/${file}`,'utf8');
   if(mutant) assert.notEqual(mutate(source),source);
   writeFileSync(join(temp,'source',file),mutant?mutate(source):source);
   const out=join(temp,`${mutant}.mjs`);
   await build({entryPoints:[join(temp,'source',file)],outfile:out,bundle:true,platform:'node',format:'esm'});
   const m=await import(pathToFileURL(out));let failed=false;
   try{await check(m);}catch(e){if(!(e instanceof assert.AssertionError))throw e;failed=true;}
   assert.equal(failed,mutant,`${name}: expected baseline pass/mutant assertion failure`);
  }
  records.push({name,baseline:'passed',mutant:'assertion_failed'});
 }finally{rmSync(temp,{recursive:true,force:true});}
}
if(process.argv.includes('--workerd')){
 for(const name of ['concurrency','mailbox_message_id']){
  const temp=mkdtempSync(join(tmpdir(),'dev-878-mutation-'));
  try{
   for(const path of ['workers','shared','test','docs/evidence/dev-878','app','package.json','package-lock.json','vitest.config.ts','wrangler.jsonc','worker-configuration.d.ts'])cpSync(path,join(temp,path),{recursive:true});
   symlinkSync(join(root,'node_modules'),join(temp,'node_modules'),'dir');
   const path=join(temp,'workers/durableObject/index.ts');const source=readFileSync(path,'utf8');
   const mutant=name==='concurrency'?source.replace("if ((old?.revision ?? 0) !== expectedRevision) return {ok:false, error:'conflict'};",''):
    source.replace("if (!email) return {ok:false, error:'not_found'};",'');
   assert.notEqual(source,mutant);writeFileSync(path,mutant);
   const r=spawnSync(process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run','test/shadow-scoring.test.ts','-t','authenticates explicit feedback'],{cwd:temp,encoding:'utf8',timeout:240000,env:{...process.env,XDG_CONFIG_HOME:'/tmp/dev-878-xdg',WRANGLER_SEND_METRICS:'false'}});
   const log=(r.stdout??'')+(r.stderr??'');
   writeFileSync(`docs/evidence/dev-878/mutation-${name}.log`,log.trimEnd()+'\n');
   assert.equal(r.status,1);assert.match(log,/AssertionError/);assert.match(log,/authenticates explicit feedback/);
   records.push({name,mutant:'assertion_failed',log:`mutation-${name}.log`});
  }finally{rmSync(temp,{recursive:true,force:true});}
 }
}
writeFileSync('docs/evidence/dev-878/mutations.json',JSON.stringify({records},null,2)+'\n');
console.log(JSON.stringify(records));
