// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
import {readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve, join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const dependency=resolve(process.argv[2] ?? '../mail-scoring');
const pin='f8aa6004c7a0990ae99dff51b2da0afe41bad412';
const wordpairPin='453cc3423e222b0e853bf3d8e9d590ee01e44bf7';
const refitPin='62919bc8f939bc94c0552fc6a3917c03a3373646';
const robustPin='143e24e938365c31f2669fd5f9e918408383dc7e';
const linearPin='0041d47f20d2565dc8725a3c11f0ed1af113ca74';
const generalizedPin='5ed110e5cdfc9905fc5ee2940a4a39cd9e4864b0';
const contextPin='cf588bf2870964f691e420f5e5249aa3255806f8';
const general1Pin='041e79c5f56880b8eff0e210968569461cb95fc0';
const previousPin='faa15bea06db52f2dc240257d5335a66a933f909';
const legacyPin='2fab406320ae3b3596345d2c76e0ef8a08593211';
const outDir=resolve(process.env.EVIDENCE_DIR ?? 'docs/evidence/dev-1022');
assert.equal(execFileSync('git',['-C',dependency,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),pin);
assert.equal(execFileSync('git',['-C',dependency,'cat-file','-t',legacyPin],{encoding:'utf8'}).trim(),'commit');
const hashes={};
for(const [source,copy] of [['packages/core/src/contract.ts','contract.ts'],['workers/private/protocol.ts','protocol.ts']]){
 const upstream=readFileSync(join(dependency,source),'utf8');
 const local=readFileSync(`workers/lib/mail-scoring/${copy}`,'utf8');
 assert.equal(local,upstream.replaceAll('../../packages/core/src/contract.js','./contract'));
 hashes[source]=createHash('sha256').update(upstream).digest('hex');
}
const temp=mkdtempSync(join(tmpdir(),'dev-989-contract-'));
try{
 const legacyDir=join(temp,'legacy-src');
 mkdirSync(legacyDir,{recursive:true});
 const archive=execFileSync('git',['-C',dependency,'archive',legacyPin,'tsconfig.json','packages/core','workers/private'],{maxBuffer:8*1024*1024});
 execFileSync('tar',['-x','-C',legacyDir],{input:archive});
 const previousDir=join(temp,'previous-src');
 mkdirSync(previousDir);
 execFileSync('tar',['-x','-C',previousDir],{input:execFileSync('git',['-C',dependency,'archive',previousPin,'tsconfig.json','packages/core','workers/private'],{maxBuffer:8*1024*1024})});
 const general1Dir=join(temp,'general1-src');
 mkdirSync(general1Dir);
 execFileSync('tar',['-x','-C',general1Dir],{input:execFileSync('git',['-C',dependency,'archive',general1Pin,'tsconfig.json','packages/core','workers/private'],{maxBuffer:8*1024*1024})});
 const contextDir=join(temp,'context-src');mkdirSync(contextDir);
 execFileSync('tar',['-x','-C',contextDir],{input:execFileSync('git',['-C',dependency,'archive',contextPin,'tsconfig.json','packages/core','workers/private'],{maxBuffer:8*1024*1024})});
 const generalizedDir=join(temp,'generalized-src');mkdirSync(generalizedDir);
 execFileSync('tar',['-x','-C',generalizedDir],{input:execFileSync('git',['-C',dependency,'archive',generalizedPin,'tsconfig.json','packages/core','workers/private'],{maxBuffer:8*1024*1024})});
 const linearDir=join(temp,'linear-src');mkdirSync(linearDir);
 execFileSync('tar',['-x','-C',linearDir],{input:execFileSync('git',['-C',dependency,'archive',linearPin,'tsconfig.json','packages/core','workers/private'],{maxBuffer:8*1024*1024})});
 const robustDir=join(temp,'robust-src');mkdirSync(robustDir);
 execFileSync('tar',['-x','-C',robustDir],{input:execFileSync('git',['-C',dependency,'archive',robustPin,'tsconfig.json','packages/core','workers/private'],{maxBuffer:8*1024*1024})});
 const refitDir=join(temp,'refit-src');mkdirSync(refitDir);
 execFileSync('tar',['-x','-C',refitDir],{input:execFileSync('git',['-C',dependency,'archive',refitPin,'tsconfig.json','packages/core','workers/private'],{maxBuffer:8*1024*1024})});
 const wordpairDir=join(temp,'wordpair-src');mkdirSync(wordpairDir);
 execFileSync('tar',['-x','-C',wordpairDir],{input:execFileSync('git',['-C',dependency,'archive',wordpairPin,'tsconfig.json','packages/core','workers/private'],{maxBuffer:8*1024*1024})});
 const modules={};
 for(const [name,path] of [
  ['scorer',join(dependency,'workers/private/adapter.ts')],
  ['wordpairScorer',join(wordpairDir,'workers/private/adapter.ts')],
  ['refitScorer',join(refitDir,'workers/private/adapter.ts')],
  ['robustScorer',join(robustDir,'workers/private/adapter.ts')],
  ['linearScorer',join(linearDir,'workers/private/adapter.ts')],
  ['generalizedScorer',join(generalizedDir,'workers/private/adapter.ts')],
  ['contextScorer',join(contextDir,'workers/private/adapter.ts')],
  ['general1Scorer',join(general1Dir,'workers/private/adapter.ts')],
  ['previousScorer',join(previousDir,'workers/private/adapter.ts')],
  ['authored',resolve('test/statistical-fixture.ts')],
  ['legacyScorer',join(legacyDir,'workers/private/adapter.ts')],
  ['caller',resolve('workers/lib/mail-scoring/intake.ts')],
  ['protocol',resolve('workers/lib/mail-scoring/protocol.ts')],
  ['contract',resolve('workers/lib/mail-scoring/contract.ts')],
 ]){
  const out=join(temp,name+'.mjs');
  await build({entryPoints:[path],outfile:out,bundle:true,format:'esm',platform:'node',nodePaths:[join(dependency,'node_modules')]});
  modules[name]=await import(pathToFileURL(out));
 }
 const parsed={from:{address:'sender@example.test',name:'Person'},subject:'Synthetic',text:'Hello synthetic world.',headers:[],attachments:[],headerLines:[]};
 const calls=[];
 const assessment=await modules.caller.assessArrival({MAIL_SCORING_MODE:'shadow',MAIL_SCORER:{scoreV1:async(...args)=>{
  calls.push(args);return modules.scorer.scoreRpc(...args);
 }}},parsed,true,'bounce@example.test');
 assert.equal(calls.length,1);assert.equal(assessment.status,'partial');
 assert.equal(assessment.result.schemaVersion,'1');assert.equal(assessment.result.ruleSetVersion,'rules-10');
 assert.ok(assessment.result.limitsHit.includes('auth_unknown'));
 assert.equal(assessment.result.heuristicScore,0);
 assert.equal(modules.caller.shouldQuarantine(assessment,'none'),false);
 const fixture={rpcVersion:'1',ok:true,result:assessment.result};
 const preferenceResults={};
 for(const preference of ['none','allow','block']){
  const value=await modules.caller.assessArrival({MAIL_SCORING_MODE:'shadow',MAIL_SCORER:{scoreV1:async(...args)=>modules.scorer.scoreRpc(...args)}},parsed,true,'bounce@example.test',preference);
  assert.equal(value.status,'partial');assert.ok(value.result);
  const ids=value.result.reasons.map(r=>r.id);
  assert.equal(ids.includes('sender_allowed'),preference==='allow');
  assert.equal(ids.includes('sender_blocked'),preference==='block');
  assert.equal(ids.includes('auth_failed'),false);
  assert.equal(modules.caller.shouldQuarantine(value,preference),preference==='block');
  preferenceResults[preference]=value.result;
 }
 const marker=modules.contract.GTUBE_MARKER;
 const gtubeParsed={...parsed,subject:'Test spam mail (GTUBE)',text:`Header text\n\n${marker}\n\nFooter text.`};
 const gtubePreferenceResults={};
 for(const preference of ['none','allow','block']){
  const value=await modules.caller.assessArrival({MAIL_SCORING_MODE:'filter',MAIL_SCORER:{scoreV1:async(...args)=>modules.scorer.scoreRpc(...args)}},gtubeParsed,true,'bounce@example.test',preference);
  assert.equal(value.status,'partial');assert.ok(value.result);
  assert.equal(value.result.ruleSetVersion,'rules-10');
  assert.equal(value.result.heuristicScore,100);
  assert.equal(value.result.signals.spam,'present');
  const ids=value.result.reasons.map(r=>r.id);
  assert.ok(ids.includes('gtube'));
  assert.equal(ids.includes('sender_allowed'),preference==='allow');
  assert.equal(ids.includes('sender_blocked'),preference==='block');
  assert.equal(modules.caller.shouldQuarantine(value,preference),preference!=='allow');
  gtubePreferenceResults[preference]={quarantine:modules.caller.shouldQuarantine(value,preference),result:value.result};
 }
 const negativeParsed={...parsed,subject:'Test non-trigger near-match mail',text:marker.slice(0,-1)+'Y'};
 const negativeAssessment=await modules.caller.assessArrival({MAIL_SCORING_MODE:'filter',MAIL_SCORER:{scoreV1:async(...args)=>modules.scorer.scoreRpc(...args)}},negativeParsed,true,'bounce@example.test','none');
 assert.equal(negativeAssessment.result.heuristicScore,0);
 assert.equal(modules.caller.shouldQuarantine(negativeAssessment,'none'),false);
 const quotedParsed={...parsed,subject:'Re: Test spam mail (GTUBE)',text:`> ${marker}`};
 const quotedAssessment=await modules.caller.assessArrival({MAIL_SCORING_MODE:'filter',MAIL_SCORER:{scoreV1:async(...args)=>modules.scorer.scoreRpc(...args)}},quotedParsed,true,'bounce@example.test','none');
 assert.equal(quotedAssessment.result.heuristicScore,0);
 assert.ok(quotedAssessment.result.limitsHit.includes('quoted_content'));
 assert.equal(modules.caller.shouldQuarantine(quotedAssessment,'none'),false);
 // Mixed-version caller-first transition: updated caller accepts legacy rules-1 scorer output
 const legacyAssessment=await modules.caller.assessArrival({MAIL_SCORING_MODE:'filter',MAIL_SCORER:{scoreV1:async(...args)=>modules.legacyScorer.scoreRpc(...args)}},gtubeParsed,true,'bounce@example.test','none');
 assert.equal(legacyAssessment.status,'partial');
 assert.equal(legacyAssessment.result.ruleSetVersion,'rules-1');
 assert.equal(legacyAssessment.result.heuristicScore,0);
 assert.equal(modules.caller.shouldQuarantine(legacyAssessment,'none'),false);
 // Reject gtube reason under rules-1 and reject unknown ruleSetVersion / reason IDs
 const gtubeWire=JSON.stringify({rpcVersion:'1',ok:true,result:gtubePreferenceResults.none.result});
 assert.equal(modules.protocol.decodeResponse(gtubeWire.replace('"rules-10"','"rules-1"')),null);
 assert.equal(modules.protocol.decodeResponse(gtubeWire.replace('"rules-10"','"rules-11"')),null);
 assert.equal(modules.protocol.decodeResponse(gtubeWire.replace('"gtube"','"unknown_reason"')),null);
 const previous=await modules.caller.assessArrival({MAIL_SCORING_MODE:'filter',MAIL_SCORER:{scoreV1:async(...args)=>modules.previousScorer.scoreRpc(...args)}},gtubeParsed,true,'bounce@example.test','none');
 assert.equal(previous.result.ruleSetVersion,'rules-2');assert.equal(modules.caller.shouldQuarantine(previous,'none'),true);
 const general1Gtube=await modules.caller.assessArrival({MAIL_SCORING_MODE:'filter',MAIL_SCORER:{scoreV1:async(...args)=>modules.general1Scorer.scoreRpc(...args)}},gtubeParsed,true,'bounce@example.test','none');
 assert.equal(general1Gtube.result.ruleSetVersion,'rules-3');assert.equal(modules.caller.shouldQuarantine(general1Gtube,'none'),true);
 const general1=await modules.caller.assessArrival({MAIL_SCORING_MODE:'filter',MAIL_SCORER:{scoreV1:async(...args)=>modules.general1Scorer.scoreRpc(...args)}},{...parsed,text:modules.authored.STATISTICAL_SPAM},true,'bounce@example.test','none');
 assert.equal(general1.result.heuristicScore,60);assert.equal(general1.result.ruleSetVersion,'rules-3');
 assert.ok(modules.protocol.decodeResponse(JSON.stringify({rpcVersion:'1',ok:true,result:general1.result})));
 assert.equal(modules.caller.shouldQuarantine(general1,'none'),false);
 const contextGtube=await modules.caller.assessArrival({MAIL_SCORING_MODE:'filter',MAIL_SCORER:{scoreV1:async(...args)=>modules.contextScorer.scoreRpc(...args)}},gtubeParsed,true,'bounce@example.test','none');
 assert.equal(contextGtube.result.ruleSetVersion,'rules-4');assert.equal(modules.caller.shouldQuarantine(contextGtube,'none'),true);
 const context=await modules.caller.assessArrival({MAIL_SCORING_MODE:'filter',MAIL_SCORER:{scoreV1:async(...args)=>modules.contextScorer.scoreRpc(...args)}},{...parsed,text:modules.authored.STATISTICAL_SPAM},true,'bounce@example.test','none');
 assert.equal(context.result.heuristicScore,60);assert.equal(context.result.ruleSetVersion,'rules-4');assert.equal(modules.caller.shouldQuarantine(context,'none'),false);
 assert.ok(modules.protocol.decodeResponse(JSON.stringify({rpcVersion:'1',ok:true,result:context.result})));
 const oldPharmacy=await modules.caller.assessArrival({MAIL_SCORING_MODE:'filter',MAIL_SCORER:{scoreV1:async(...args)=>modules.contextScorer.scoreRpc(...args)}},{...parsed,text:modules.authored.PHARMACY_SPAM},true,'bounce@example.test','none');
 assert.equal(oldPharmacy.result.heuristicScore,0);assert.equal(modules.caller.shouldQuarantine(oldPharmacy,'none'),false);
 const generalizedGtube=await modules.caller.assessArrival({MAIL_SCORING_MODE:'filter',MAIL_SCORER:{scoreV1:async(...args)=>modules.generalizedScorer.scoreRpc(...args)}},gtubeParsed,true,'bounce@example.test','none');
 assert.equal(generalizedGtube.result.ruleSetVersion,'rules-5');assert.equal(modules.caller.shouldQuarantine(generalizedGtube,'none'),true);
 const generalized=await modules.caller.assessArrival({MAIL_SCORING_MODE:'filter',MAIL_SCORER:{scoreV1:async(...args)=>modules.generalizedScorer.scoreRpc(...args)}},{...parsed,text:modules.authored.STATISTICAL_SPAM},true,'bounce@example.test','none');
 assert.equal(generalized.result.heuristicScore,60);assert.equal(generalized.result.ruleSetVersion,'rules-5');assert.equal(modules.caller.shouldQuarantine(generalized,'none'),false);
 assert.ok(modules.protocol.decodeResponse(JSON.stringify({rpcVersion:'1',ok:true,result:generalized.result})));
 for(const complete of [false,undefined,null,0])assert.equal(modules.caller.inspectableRaw(new Uint8Array([0]),complete),false);
 assert.equal(modules.caller.inspectableRaw(new Uint8Array([0]),true),true);
 assert.equal(modules.caller.inspectableRaw(new Uint8Array(131072),true),true);
 assert.equal(modules.caller.inspectableRaw(new Uint8Array(131073),true),false);
 const linearGtube=await modules.caller.assessArrival({MAIL_SCORING_MODE:'filter',MAIL_SCORER:{scoreV1:async(...args)=>modules.linearScorer.scoreRpc(...args)}},gtubeParsed,true,'bounce@example.test','none');
 assert.equal(linearGtube.result.ruleSetVersion,'rules-6');assert.equal(modules.caller.shouldQuarantine(linearGtube,'none'),true);
 const linear=await modules.caller.assessArrival({MAIL_SCORING_MODE:'filter',MAIL_SCORER:{scoreV1:async(...args)=>modules.linearScorer.scoreRpc(...args)}},{...parsed,text:modules.authored.STATISTICAL_SPAM},true,'bounce@example.test','none');
 assert.equal(linear.result.heuristicScore,60);assert.equal(linear.result.ruleSetVersion,'rules-6');assert.equal(modules.caller.shouldQuarantine(linear,'none'),false);
 assert.ok(modules.protocol.decodeResponse(JSON.stringify({rpcVersion:'1',ok:true,result:linear.result})));
 const robustGtube=await modules.caller.assessArrival({MAIL_SCORING_MODE:'filter',MAIL_SCORER:{scoreV1:async(...args)=>modules.robustScorer.scoreRpc(...args)}},gtubeParsed,true,'bounce@example.test','none');
 assert.equal(robustGtube.result.ruleSetVersion,'rules-7');assert.equal(modules.caller.shouldQuarantine(robustGtube,'none'),true);
 const robust=await modules.caller.assessArrival({MAIL_SCORING_MODE:'filter',MAIL_SCORER:{scoreV1:async(...args)=>modules.robustScorer.scoreRpc(...args)}},{...parsed,text:modules.authored.STATISTICAL_SPAM},true,'bounce@example.test','none');
 assert.equal(robust.result.heuristicScore,60);assert.equal(robust.result.ruleSetVersion,'rules-7');assert.equal(modules.caller.shouldQuarantine(robust,'none'),false);
 assert.ok(modules.protocol.decodeResponse(JSON.stringify({rpcVersion:'1',ok:true,result:robust.result})));
 const refitGtube=await modules.caller.assessArrival({MAIL_SCORING_MODE:'filter',MAIL_SCORER:{scoreV1:async(...args)=>modules.refitScorer.scoreRpc(...args)}},gtubeParsed,true,'bounce@example.test','none');
 assert.equal(refitGtube.result.ruleSetVersion,'rules-8');assert.equal(modules.caller.shouldQuarantine(refitGtube,'none'),true);
 const refit=await modules.caller.assessArrival({MAIL_SCORING_MODE:'filter',MAIL_SCORER:{scoreV1:async(...args)=>modules.refitScorer.scoreRpc(...args)}},{...parsed,text:modules.authored.STATISTICAL_SPAM},true,'bounce@example.test','none');
 assert.equal(refit.result.heuristicScore,60);assert.equal(refit.result.ruleSetVersion,'rules-8');assert.equal(modules.caller.shouldQuarantine(refit,'none'),false);
 assert.ok(modules.protocol.decodeResponse(JSON.stringify({rpcVersion:'1',ok:true,result:refit.result})));
 const wordpairGtube=await modules.caller.assessArrival({MAIL_SCORING_MODE:'filter',MAIL_SCORER:{scoreV1:async(...args)=>modules.wordpairScorer.scoreRpc(...args)}},gtubeParsed,true,'bounce@example.test','none');
 assert.equal(wordpairGtube.result.ruleSetVersion,'rules-9');assert.equal(modules.caller.shouldQuarantine(wordpairGtube,'none'),true);
 const wordpair=await modules.caller.assessArrival({MAIL_SCORING_MODE:'filter',MAIL_SCORER:{scoreV1:async(...args)=>modules.wordpairScorer.scoreRpc(...args)}},{...parsed,text:modules.authored.STATISTICAL_SPAM},true,'bounce@example.test','none');
 assert.equal(wordpair.result.heuristicScore,60);assert.equal(wordpair.result.ruleSetVersion,'rules-9');assert.equal(modules.caller.shouldQuarantine(wordpair,'none'),false);
 assert.ok(modules.protocol.decodeResponse(JSON.stringify({rpcVersion:'1',ok:true,result:wordpair.result})));
 const fragileResults={};
 for(const [name,body] of [['original',modules.authored.FRAGILE_SPAM],['shorter',modules.authored.REFIT_FRAGILE_SPAM],['contextual',modules.authored.CONTEXT_FRAGILE_SPAM]])for(const html of [false,true]){
  const value=await modules.caller.assessArrival({MAIL_SCORING_MODE:'filter',MAIL_SCORER:{scoreV1:async(...args)=>modules.scorer.scoreRpc(...args)}},{...parsed,subject:'',text:html?'':body,html:html?`<p>${body}</p>`:undefined},true,'bounce@example.test','none');
  assert.equal(value.status,'partial');assert.equal(value.result.ruleSetVersion,'rules-10');assert.equal(value.result.heuristicScore,0);assert.equal(modules.caller.shouldQuarantine(value,'none'),false);fragileResults[name+(html?'Html':'Plain')]=value;
 }
 const generalResults={};
 for(const [kind,body,isHtml] of [['plain',modules.authored.STATISTICAL_SPAM,false],['html',modules.authored.STATISTICAL_SPAM,true],['pharmacyPlain',modules.authored.PHARMACY_SPAM,false],['pharmacyHtml',modules.authored.PHARMACY_SPAM,true]]) {
  const value=await modules.caller.assessArrival({MAIL_SCORING_MODE:'filter',MAIL_SCORER:{scoreV1:async(...args)=>modules.scorer.scoreRpc(...args)}},
   {...parsed,text:isHtml?'':body,html:isHtml?`<p>${body}</p>`:undefined},true,'bounce@example.test','none');
  assert.equal(value.result.heuristicScore,60);assert.equal(modules.caller.shouldQuarantine(value,'none'),true);
  const generalWire=JSON.stringify({rpcVersion:'1',ok:true,result:value.result});
  assert.equal(modules.protocol.decodeResponse(generalWire.replace('"rules-10"','"rules-2"')),null);
  assert.equal(modules.protocol.decodeResponse(generalWire.replace('"rules-10"','"rules-1"')),null);
  assert.equal(modules.protocol.decodeResponse(generalWire.replace('"rules-10"','"rules-3"')),null);
  assert.equal(modules.protocol.decodeResponse(generalWire.replace('"rules-10"','"rules-4"')),null);
  assert.equal(modules.protocol.decodeResponse(generalWire.replace('"rules-10"','"rules-5"')),null);
  assert.equal(modules.protocol.decodeResponse(generalWire.replace('"rules-10"','"rules-6"')),null);
  assert.equal(modules.protocol.decodeResponse(generalWire.replace('"rules-10"','"rules-7"')),null);
  assert.equal(modules.protocol.decodeResponse(generalWire.replace('"rules-10"','"rules-8"')),null);
  assert.equal(modules.protocol.decodeResponse(generalWire.replace('"rules-10"','"rules-9"')),null);
  generalResults[kind]=value;
 }
 mkdirSync(outDir,{recursive:true});
 writeFileSync(join(outDir,'contract.json'),JSON.stringify({
  dependency:pin,
  wordpairDependency:wordpairPin,
  wordpairResult:wordpair,
  wordpairGtubeResult:wordpairGtube.result,
  refitDependency:refitPin,
  refitResult:refit,
  refitGtubeResult:refitGtube.result,
  robustDependency:robustPin,
  robustResult:robust,
  robustGtubeResult:robustGtube.result,
  linearDependency:linearPin,
  linearResult:linear,
  linearGtubeResult:linearGtube.result,
  fragileResults,
  generalizedDependency:generalizedPin,
  generalizedResult:generalized,
  generalizedGtubeResult:generalizedGtube.result,
  contextDependency:contextPin,
  contextResult:context,
  contextGtubeResult:contextGtube.result,
  oldPharmacyResult:oldPharmacy.result,
  general1Dependency:general1Pin,
  general1Result:general1,
  general1GtubeResult:general1Gtube.result,
  previousDependency:previousPin,
  previousGtubeResult:previous.result,
  generalResults,
  legacyDependency:legacyPin,
  hashes,
  fixture,
  preferenceResults,
  gtubePreferenceResults,
  negativeResult:negativeAssessment.result,
  quotedResult:quotedAssessment.result,
  legacyGtubeResult:legacyAssessment.result,
  passed:true,
 },null,2)+'\n');
 console.log('Pinned scorer/caller compatibility passed');
}finally{rmSync(temp,{recursive:true,force:true});}
