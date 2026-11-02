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
const html='<p>Security team: inspect a negative review.</p><a href="https://tracker.example/route?fallback=https%3A%2F%2Fdestination.invalid%2F">Respond now</a>';
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
  expect(state?.assessments[0]).toMatchObject({policyVersion:'inbox-html-2',status:'partial',result:{ruleSetVersion:'rules-2',heuristicScore:45,reasons:[{id:'brand_impersonation_combined'}]}});
  expect((await deliver('notice@notification.intuit.com')).folder_id).toBe('inbox');
  expect((await deliver('person@example.test','Bookkeeping discussion')).folder_id).toBe('inbox');
  const calls=scoreV1.mock.calls.length;
  const limited=await deliver('notice@sender.invalid','QuickBooks','<div>'.repeat(33));
  expect(limited.folder_id).toBe('inbox');expect((await stub.getSpamState(limited.id))?.assessments[0].status).toBe('unavailable');expect(scoreV1).toHaveBeenCalledTimes(calls);
  expect(await stub.setSpamDisposition({emailId:bad.id,disposition:'not_spam',expectedRevision:0})).toEqual({ok:true,revision:1});
  expect((await stub.getEmail(bad.id))?.folder_id).toBe('inbox');expect((await stub.getEmail(bad.id))?.uid).toBeGreaterThan(bad.uid);
  expect((await stub.getSpamState(bad.id))?.assessments).toEqual(state?.assessments);expect(forbidden).not.toHaveBeenCalled();
});
