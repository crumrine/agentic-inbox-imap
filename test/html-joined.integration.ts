// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
import {createExecutionContext,env,waitOnExecutionContext} from 'cloudflare:test';
import {it,expect,vi,afterEach} from 'vitest';
vi.mock('agents',()=>({routeAgentRequest:()=>{throw new Error('forbidden_agent');}}));
vi.mock('../workers/agent',()=>({EmailAgent:class {}}));
vi.mock('../workers/mcp',()=>({EmailMCP:{serve:()=>({fetch:()=>{throw new Error('forbidden_mcp');}})}}));
import worker from '../workers/app';
import type {Env} from '../workers/types';
import {mailbox,query} from './helpers';
const BOX='html-joined@example.test';
const html='<img src="https://never-fetch.invalid/pixel"><style>@import "https://never-fetch.invalid/style";</style><script src="https://never-fetch.invalid/script">throw 1</script><p>Security team: inspect a negative review.</p><a href="https://tracker.example/route?fallback=https%3A%2F%2Fdestination.invalid%2F">Respond now</a>';
afterEach(()=>vi.unstubAllGlobals());
it('joins actual MIME intake, native HTML parser, private Worker RPC, SQLite, recoverable routing and rescue',async()=>{
  await env.BUCKET.put(`mailboxes/${BOX}.json`,'{}');const stub=mailbox(BOX);await stub.getFolders();
  const forbidden=vi.fn(()=>{throw new Error('forbidden_network_send_ai');});vi.stubGlobal('fetch',forbidden);
  const binding=(env as unknown as Env).MAIL_SCORER!;
  const scoreV1=vi.fn((...args:Parameters<typeof binding.scoreV1>)=>binding.scoreV1(...args));
  const e={...env,MAIL_SCORING_MODE:'filter',MAIL_SCORER:{scoreV1},EMAIL:{send:forbidden},AI:{run:forbidden},EMAIL_AGENT:{idFromName:forbidden,get:forbidden}} as unknown as Env;
  async function deliver(from:string,name='QuickBooks',body=html){
    const raw=new TextEncoder().encode(`From: ${name} <${from}>\r\nTo: ${BOX}\r\nSubject: Synthetic notice\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${body}`);
    const ctx=createExecutionContext();const reject=vi.fn();
    await worker.email({raw:new ReadableStream({start(c){c.enqueue(raw);c.close();}}),rawSize:raw.length,to:BOX,from,setReject:reject} as unknown as ForwardableEmailMessage,e,ctx);
    await waitOnExecutionContext(ctx);expect(reject).not.toHaveBeenCalled();
    const [row]=await query<{id:string;folder_id:string;raw_key:string;uid:number}>(stub,'SELECT id,folder_id,raw_key,uid FROM emails ORDER BY rowid DESC');
    expect(new Uint8Array(await (await env.BUCKET.get(row.raw_key))!.arrayBuffer())).toEqual(raw);
    return row;
  }
  const bad=await deliver('notice@sender.invalid');expect(bad.folder_id,JSON.stringify(await stub.getSpamState(bad.id))).toBe('spam');expect(await stub.getEmail(bad.id)).toBeNull();
  const state=await stub.getSpamState(bad.id);
  expect(state?.assessments[0]).toMatchObject({policyVersion:'inbox-scoring-10',status:'partial',result:{ruleSetVersion:'rules-11',heuristicScore:45,reasons:[{id:'brand_impersonation_combined'}]}});
  expect((await deliver('notice@notification.intuit.com')).folder_id).toBe('inbox');
  expect((await deliver('person@example.test','Bookkeeping discussion')).folder_id).toBe('inbox');
  const calls=scoreV1.mock.calls.length;
  const limited=await deliver('notice@sender.invalid','QuickBooks','<div>'.repeat(33));
  expect(limited.folder_id).toBe('inbox');expect((await stub.getSpamState(limited.id))?.assessments[0].status).toBe('unavailable');expect(scoreV1).toHaveBeenCalledTimes(calls);
  expect(await stub.setSpamDisposition({emailId:bad.id,disposition:'not_spam',expectedRevision:0})).toEqual({ok:true,revision:1});
  expect((await stub.getEmail(bad.id))?.folder_id).toBe('inbox');expect((await stub.getEmail(bad.id))?.uid).toBeGreaterThan(bad.uid);
  expect((await stub.getSpamState(bad.id))?.assessments).toEqual(state?.assessments);expect(forbidden).not.toHaveBeenCalled();
});

it('keeps all frozen legitimate controls in Inbox under rules-11',async()=>{
  const {CONTEXT_LEGITIMATE_CONTROLS}=await import('./context-legitimate-controls');
  const {BALANCED_LEGITIMATE_CONTROLS}=await import('./balanced-legitimate-controls');
  const box='html-legitimate-controls@example.test';
  await env.BUCKET.put(`mailboxes/${box}.json`,'{}');const stub=mailbox(box);await stub.getFolders();
  const forbidden=vi.fn(()=>{throw new Error('forbidden_network_send_ai');});vi.stubGlobal('fetch',forbidden);
  const e={...env,MAIL_SCORING_MODE:'filter',EMAIL:{send:forbidden},AI:{run:forbidden},EMAIL_AGENT:{idFromName:forbidden,get:forbidden}} as unknown as Env;
  const escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  for(const sample of [...CONTEXT_LEGITIMATE_CONTROLS,...BALANCED_LEGITIMATE_CONTROLS])for(const html of [false,true]) {
    expect(sample.label).toBe('ham');
    const raw=new TextEncoder().encode(['From: Person <sender@example.test>',`To: ${box}`,`Subject: ${sample.subject}`,'MIME-Version: 1.0',`Content-Type: text/${html?'html':'plain'}; charset=utf-8`,'',html?`<p>${escape(sample.text)}</p>`:sample.text].join('\r\n'));
    const ctx=createExecutionContext();const reject=vi.fn();
    await worker.email({raw:new ReadableStream({start(c){c.enqueue(raw);c.close();}}),rawSize:raw.length,to:box,from:'sender@example.test',setReject:reject} as unknown as ForwardableEmailMessage,e,ctx);
    await waitOnExecutionContext(ctx);expect(reject,sample.id).not.toHaveBeenCalled();
    const [row]=await query<{id:string;folder_id:string;raw_key:string}>(stub,'SELECT id,folder_id,raw_key FROM emails ORDER BY rowid DESC');
    expect(row.folder_id,sample.id).toBe('inbox');
    expect((await stub.getSpamState(row.id))?.assessments[0]).toMatchObject({policyVersion:'inbox-scoring-10',status:'partial',result:{status:'partial',ruleSetVersion:'rules-11',heuristicScore:0}});
    expect(new Uint8Array(await (await env.BUCKET.get(row.raw_key))!.arrayBuffer())).toEqual(raw);
  }
  expect(forbidden).not.toHaveBeenCalled();
},30000);

it('retains the existing HTML statistical regression and positive controls',async()=>{
  const {default:PostalMime}=await import('postal-mime');
  const {assessArrival,shouldQuarantine}=await import('../workers/lib/mail-scoring/intake');
  const {STATISTICAL_SPAM,PHARMACY_SPAM,FRAGILE_SPAM,REFIT_FRAGILE_SPAM,CONTEXT_FRAGILE_SPAM}=await import('./statistical-fixture');
  const e={...env,MAIL_SCORING_MODE:'filter'} as unknown as Env;
  for(const [body,expected] of [[STATISTICAL_SPAM,60],[PHARMACY_SPAM,60],[FRAGILE_SPAM,0],[REFIT_FRAGILE_SPAM,0],[CONTEXT_FRAGILE_SPAM,0]] as const) {
    const raw=`From: Person <sender@example.test>\r\nTo: receiver@example.test\r\nSubject: \r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>${body}</p>`;
    const assessment=await assessArrival(e,await PostalMime.parse(raw),true,'sender@example.test','none');
    expect(assessment?.status).toBe('partial');expect(assessment?.result?.ruleSetVersion).toBe('rules-11');
    expect(assessment?.result?.heuristicScore).toBe(expected);expect(shouldQuarantine(assessment,'none')).toBe(expected===60);
  }
});
