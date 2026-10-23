// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
import {readFileSync,writeFileSync,mkdtempSync,cpSync,rmSync,symlinkSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {pathToFileURL} from 'node:url';
const root=process.cwd(),out=resolve('docs/evidence/dev-879');mkdirSync(out,{recursive:true});
const records=[];
for(const [name,file,mutate,test,pattern] of [
 ['aggregate-scope','workers/durableObject/index.ts',s=>s.replace("WHERE (COALESCE(e.folder_id, '') = 'spam') =\n                  ((SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1) = 'spam')",''),'test/quarantine.test.ts','excludes forged-chain'],
 ['direct-scope','workers/durableObject/index.ts',s=>s.replace(' || (email.folder_id === Folders.SPAM) !== (scope === "spam")','').replace(".where(and(eq(schema.emails.id, id), sql`(COALESCE(${schema.emails.folder_id}, '') = 'spam') = ${scope === \"spam\" ? 1 : 0}`))",'.where(eq(schema.emails.id, id))'),'test/quarantine.test.ts','excludes forged-chain'],
 ['thread-scope','workers/durableObject/index.ts',s=>s.replace("AND (COALESCE(folder_id, '') = 'spam') = ?2 ORDER BY date ASC","AND ?2 IN (0, 1) ORDER BY date ASC"),'test/quarantine.test.ts','excludes forged-chain'],
 ['retained-context','workers/agent/index.ts',s=>s.replace('convertToModelMessages(context)','convertToModelMessages(this.messages)'),'test/quarantine-context.test.ts','persisted chat context'],
]){
 const temp=mkdtempSync(join(tmpdir(),'dev879-mutant-'));
 try{
  for(const path of ['workers','shared','test','docs/evidence/dev-878','app','package.json','package-lock.json','vitest.config.ts','wrangler.jsonc','worker-configuration.d.ts'])cpSync(path,join(temp,path),{recursive:true});
  symlinkSync(join(root,'node_modules'),join(temp,'node_modules'),'dir');
  const path=join(temp,file),source=readFileSync(path,'utf8'),changed=mutate(source);assert.notEqual(changed,source,name);writeFileSync(path,changed);
  const r=spawnSync(process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run',test,'-t',pattern,'--maxWorkers=1','--testTimeout=30000','--hookTimeout=30000'],{cwd:temp,encoding:'utf8',timeout:240000,env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
  const log=(r.stdout??'')+(r.stderr??'');writeFileSync(join(out,`mutant-${name}.log`),log);
  assert.equal(r.status,1,name);assert.match(log,/AssertionError/);assert.match(log,new RegExp(pattern));records.push({name,result:'assertion_failed'});
 }finally{rmSync(temp,{recursive:true,force:true});}
}
// Small compiled browser-boundary checks: the same actual component and cache factory.
for(const [name,file,mutate,check] of [
 ['preview','app/components/SuspiciousPreview.tsx',s=>s.replace('<pre className="whitespace-pre-wrap break-all text-sm">{suspiciousText(body)}</pre>','<div dangerouslySetInnerHTML={{__html:body || ""}} />'),async m=>{
   const {renderToStaticMarkup}=await import('react-dom/server');const {createElement}=await import('react');
   const html=renderToStaticMarkup(createElement(m.default,{body:'<img src="https://tracker.invalid/p"><script>evil()</script>'}));assert.ok(!/<img|<script/.test(html));
 }],
 ['cache-scope','app/queries/keys.ts',s=>s.replace('emailId, scope]','emailId]').replace('threadId, scope]','threadId]'),async m=>{
   assert.notDeepEqual(m.queryKeys.emails.detail('m','e','spam'),m.queryKeys.emails.detail('m','e','normal'));
   assert.notDeepEqual(m.queryKeys.emails.thread('m','t','spam'),m.queryKeys.emails.thread('m','t','normal'));
 }],
]){
 const temp=mkdtempSync(join(root,'.quarantine-mutation-'));
 try{
  for(const mutant of [false,true]){
   const source=readFileSync(file,'utf8');if(mutant)assert.notEqual(mutate(source),source);
   writeFileSync(join(temp,'source.tsx'),mutant?mutate(source):source);
   const output=join(temp,`${mutant}.mjs`);
   await build({entryPoints:[join(temp,'source.tsx')],outfile:output,bundle:true,platform:'node',format:'esm',jsx:'automatic',external:['react','react-dom/server'],alias:{shared:join(root,'shared')}});
   let failed=false;try{await check(await import(pathToFileURL(output)));}catch(e){if(!(e instanceof assert.AssertionError))throw e;failed=true;}
   assert.equal(failed,mutant,name);
  }
  records.push({name,baseline:'passed',mutant:'assertion_failed'});
 }finally{rmSync(temp,{recursive:true,force:true});}
}
writeFileSync(join(out,'mutations.json'),JSON.stringify(records,null,2)+'\n');console.log(records);
