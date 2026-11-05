// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
import {readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const root=process.cwd(), outDir=resolve(process.env.EVIDENCE_DIR || 'docs/evidence/dev-989'), records=[];
mkdirSync(outDir,{recursive:true});
const contract989=JSON.parse(readFileSync('docs/evidence/dev-989/contract.json','utf8'));
const wire=JSON.stringify(contract989.fixture);
const gtubeResult=contract989.gtubePreferenceResults.none.result;
const gtubeWire=JSON.stringify({rpcVersion:'1',ok:true,result:gtubeResult});
const gtubeAssessment={version:1,policyVersion:'inbox-shadow-1',status:'partial',inputIncomplete:false,result:gtubeResult};
const parsed={subject:'Synthetic',text:'hello',headers:[],headerLines:[],attachments:[]};
const tests=[
 ['off','intake.ts',s=>s.replace("if (env.MAIL_SCORING_MODE !== 'shadow' && env.MAIL_SCORING_MODE !== 'filter') return undefined;",''),async m=>{
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
 ['gtube_routing','intake.ts',s=>s.replace("  if (result.ruleSetVersion === 'rules-2' && result.signals.spam === 'present' &&\n      result.reasons.some(reason => reason.id === 'gtube' && reason.contribution > 0)) return true;\n",''),async m=>{
  assert.equal(m.shouldQuarantine(gtubeAssessment,'none'),true);
 }],
 ['gtube_allow_precedence','intake.ts',s=>s.replace("|| preference === 'allow'",''),async m=>{
  assert.equal(m.shouldQuarantine(gtubeAssessment,'allow'),false);
 }],
 ['gtube_version_guard','protocol.ts',s=>s.replace("if(r.ruleSetVersion==='rules-1'&&id==='gtube')return false;",''),async m=>{
  assert.equal(m.decodeResponse(gtubeWire.replace('"rules-2"','"rules-1"')),null);
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
 for(const [name,file,mutate,pattern] of [
  ['concurrency','workers/durableObject/index.ts',s=>s.replace("if ((old?.revision ?? 0) !== expectedRevision) return {ok:false, error:'conflict'};",''),'authenticates explicit feedback'],
  ['mailbox_message_id','workers/durableObject/index.ts',s=>s.replace("if (!email) return {ok:false, error:'not_found'};",''),'authenticates explicit feedback'],
  ['gtube_routing_workerd','workers/lib/mail-scoring/intake.ts',s=>s.replace("  if (result.ruleSetVersion === 'rules-2' && result.signals.spam === 'present' &&\n      result.reasons.some(reason => reason.id === 'gtube' && reason.contribution > 0)) return true;\n",''),'routes positive GTUBE to Spam'],
  ['gtube_detection_workerd','workers/lib/mail-scoring/protocol.ts',s=>s.replace('!RULE_SET_VERSIONS.includes(r.ruleSetVersion as RuleSetVersion)',"r.ruleSetVersion!=='rules-1'"),'routes positive GTUBE to Spam'],
 ]){
  const temp=mkdtempSync(join(tmpdir(),'dev-989-mutation-'));
  try{
   for(const path of ['workers','shared','test','docs/evidence/dev-878','docs/evidence/dev-989','app','package.json','package-lock.json','vitest.config.ts','wrangler.jsonc','worker-configuration.d.ts'])cpSync(path,join(temp,path),{recursive:true});
   symlinkSync(join(root,'node_modules'),join(temp,'node_modules'),'dir');
   const target=join(temp,file);const source=readFileSync(target,'utf8');
   const mutant=mutate(source);
   assert.notEqual(source,mutant,name);writeFileSync(target,mutant);
   const r=spawnSync(process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run','test/shadow-scoring.test.ts','-t',pattern,'--maxWorkers=1','--testTimeout=30000','--hookTimeout=30000'],{cwd:temp,encoding:'utf8',timeout:240000,env:{...process.env,MAIL_SCORING_DIR:resolve(root,'../mail-scoring'),XDG_CONFIG_HOME:'/tmp/dev-989-xdg',WRANGLER_SEND_METRICS:'false'}});
   const log=(r.stdout??'')+(r.stderr??'');
   writeFileSync(join(outDir,`mutation-${name}.log`),log.trimEnd()+'\n');
   assert.equal(r.status,1,name);assert.match(log,/AssertionError/);assert.match(log,new RegExp(pattern));
   records.push({name,mutant:'assertion_failed',log:`mutation-${name}.log`});
  }finally{rmSync(temp,{recursive:true,force:true});}
 }
}
writeFileSync(join(outDir,'scoring-mutations.json'),JSON.stringify({records},null,2)+'\n');
console.log(JSON.stringify(records));
