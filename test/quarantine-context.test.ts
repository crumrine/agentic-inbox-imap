// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
import { env } from 'cloudflare:test';
import { describe,it,expect,vi } from 'vitest';
import { mailbox,emailData } from './helpers';
import type { Env } from '../workers/types';
const captured=vi.hoisted(()=>({calls:[] as any[]}));
vi.mock('@cloudflare/ai-chat',()=>({AIChatAgent:class {}}));
vi.mock('workers-ai-provider',()=>({createWorkersAI:()=>()=>({})}));
vi.mock('ai',()=>({streamText:(options:any)=>{captured.calls.push(options);return {toUIMessageStreamResponse:()=>new Response('synthetic')};},generateText:()=>{throw new Error('AI forbidden');},convertToModelMessages:(messages:any)=>messages,stepCountIs:()=>()=>true}));
vi.mock('agents/mcp',()=>({McpAgent:class {}}));
import { createEmailTools,EmailAgent } from '../workers/agent';
import { EmailMCP } from '../workers/mcp';
const box='context@example.com';
async function fixture(){
 await env.BUCKET.put(`mailboxes/${box}.json`,'{}');
 const stub=mailbox(box);
 await stub.createEmail('inbox',{...emailData({id:'normal'}),thread_id:'thread',body:'normal'},[]);
 await stub.createEmail('spam',{...emailData({id:'evil'}),thread_id:'thread',body:'CONTEXT_CANARY'},[]);
 return stub;
}
describe('actual agent and MCP registered callbacks with inert model/transport',()=>{
 it('agent default retrieval is isolated and cannot explicitly load Spam',async()=>{
  await fixture();const tools=createEmailTools(env as unknown as Env,box);
  expect(await tools.get_email.execute({emailId:'evil'})).toHaveProperty('error');
  expect(JSON.stringify(await tools.get_thread.execute({threadId:'thread'}))).not.toContain('CONTEXT_CANARY');
  expect(await tools.search_emails.execute({query:'',folder:'spam'})).toHaveProperty('error');
  expect(await tools.list_emails.execute({folder:'spam',limit:20,page:1})).toHaveProperty('error');
  await mailbox(box).updateFolder('spam','Renamed junk');
  expect(await tools.list_emails.execute({folder:'Renamed junk',limit:20,page:1})).toEqual([]);
  expect(await tools.search_emails.execute({query:'',folder:'Renamed junk'})).toEqual([]);
 });
 it('onNewEmail actual handler refuses Spam before any model invocation',async()=>{
  await fixture();captured.calls.length=0;
  const fake={env,name:box,handleNewEmail:EmailAgent.prototype.handleNewEmail};
  const r=await EmailAgent.prototype.onRequest.call(fake as any,new Request('https://local/onNewEmail',{method:'POST',body:JSON.stringify({mailboxId:box,emailId:'evil',threadId:'thread',sender:'hostile',subject:'hostile'})}));
  expect(await r.json()).toEqual({status:'skipped'});expect(captured.calls).toEqual([]);
 });
 it('persisted chat context is cut off after quarantine changes, including between model steps',async()=>{
  const stub=await fixture();const state=new Map<string,any>();
  const fake={env,name:box,ctx:{storage:{get:async(k:string)=>state.get(k),put:async(k:string,v:any)=>{state.set(k,v);}}},messages:[{id:'old',role:'assistant',parts:[{type:'text',text:'OLD_CANARY'}]},{id:'user1',role:'user',parts:[{type:'text',text:'new request'}]}]};
  await EmailAgent.prototype.onChatMessage.call(fake as any,()=>{});
  expect(JSON.stringify(captured.calls.at(-1).messages)).not.toContain('OLD_CANARY');
  fake.messages.push({id:'derived',role:'assistant',parts:[{type:'text',text:'NOW_QUARANTINED_CANARY'}]});
  fake.messages.push({id:'user2',role:'user',parts:[{type:'text',text:'another request'}]});
  await stub.moveEmail('normal','spam');
  await expect(captured.calls.at(-1).prepareStep()).rejects.toThrow('quarantine changed');
  await EmailAgent.prototype.onChatMessage.call(fake as any,()=>{});
  expect(captured.calls.at(-1).messages).toEqual([fake.messages.at(-1)]);
 });
 it('MCP real registry callbacks default normal and provide explicit Spam review',async()=>{
  await fixture();const registry=new Map<string,{schema:any,call:Function}>();
  const fake={env,server:{tool:(name:string,_desc:string,schema:any,call:Function)=>{registry.set(name,{schema,call});}}};
  await EmailMCP.prototype.init.call(fake as any);
  for(const [name,args] of [['get_email',{emailId:'evil'}],['get_thread',{threadId:'thread'}],['search_emails',{query:'CONTEXT_CANARY'}]] as const){
   const tool=registry.get(name)!;
   expect(JSON.stringify(await tool.call({mailboxId:box,...args}))).not.toContain('CONTEXT_CANARY');
  }
  expect(registry.get('get_email')!.schema.scope.parse(undefined)).toBe('normal');
  const explicit=await registry.get('get_email')!.call({mailboxId:box,emailId:'evil',scope:'spam'});
  expect(JSON.stringify(explicit)).toContain('CONTEXT_CANARY');
  const mark=registry.get('mark_email_read')!;
  expect(JSON.stringify(await mark.call({mailboxId:box,emailId:'evil',read:true}))).toContain('Email not found');
  expect((await mailbox(box).getEmail('evil','spam'))?.read).toBe(false);
  await mark.call({mailboxId:box,emailId:'evil',read:true,scope:'spam'});
  expect((await mailbox(box).getEmail('evil','spam'))?.read).toBe(true);
  expect(registry.has('mark_spam')).toBe(false);expect(registry.has('set_sender_preference')).toBe(false);
 });
});
