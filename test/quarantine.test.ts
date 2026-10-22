// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
// Unrelated Agent/MCP/SPA surfaces are inert; the actual app JWT middleware,
// REST routing and email export remain under test.
vi.mock('agents',()=>({routeAgentRequest:()=>{throw new Error('Agent forbidden');}}));
vi.mock('../workers/agent',()=>({EmailAgent:class {}}));
vi.mock('../workers/mcp',()=>({EmailMCP:{serve:()=>({fetch:()=>{throw new Error('MCP forbidden');}})}}));
import worker from '../workers/app';
import { createAlias } from '../workers/lib/aliases';
import { toolMarkSpam, toolSetSenderPreference, toolGetEmail, toolGetThread, toolListEmails, toolSearchEmails, toolDraftReply, toolSendReply } from '../workers/lib/tools';
import { decodeResponse } from '../workers/lib/mail-scoring/protocol';
import { project } from '../workers/lib/mail-scoring/intake';
import { applyMigrations, mailboxMigrations } from '../workers/durableObject/migrations';
import type { Env } from '../workers/types';
import { mailbox, query, restart, emailData } from './helpers';
import PostalMime from 'postal-mime';

const BOX = 'shadow@example.com';
const ALIAS = 'shadow-alias@example.com';
const ORIGIN = 'https://inbox.example.test';
// Static wire fixture is regenerated/compared against the exact pinned scorer
// by scripts/check-scoring-contract.mjs; no private content is used.
import contractEvidence from '../docs/evidence/dev-878/contract.json';
const result = contractEvidence.fixture.result;
const wire = JSON.stringify(contractEvidence.fixture);
let humanToken: string;
let serviceToken: string;
let jwks: string;
beforeAll(async () => {
  vi.stubEnv('DEV', false);
  const keys = await generateKeyPair('RS256', {extractable:true});
  jwks = JSON.stringify({keys:[{...await exportJWK(keys.publicKey),kid:'synthetic',alg:'RS256'}]});
  const token = (payload: Record<string,string>) => new SignJWT(payload).setProtectedHeader({alg:'RS256',kid:'synthetic'})
    .setIssuer('https://access.example.test').setAudience('synthetic-aud').setExpirationTime('1h').sign(keys.privateKey);
  humanToken = await token({email:'operator@example.test'});
  serviceToken = await token({common_name:'synthetic-service'});
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== 'https://access.example.test/cdn-cgi/access/certs') throw new Error('External network forbidden');
    return new Response(jwks,{headers:{'content-type':'application/json'}});
  }));
});
afterAll(() => {vi.unstubAllGlobals();vi.unstubAllEnvs();});
function bindings(mode: 'off' | 'shadow' = 'shadow', response: unknown = wire) {
  const scoreV1 = vi.fn(async (_version: string, _input: Uint8Array, _context?: string) => response as string);
  const send = vi.fn(() => {throw new Error('Outbound forbidden');});
  const ai = vi.fn(() => {throw new Error('AI forbidden');});
  const e = {...env, POLICY_AUD:'synthetic-aud',TEAM_DOMAIN:'https://access.example.test',
    MAIL_SCORING_MODE:mode,MAIL_SCORER:{scoreV1},EMAIL:{send},AI:{run:ai},EMAIL_AGENT:{idFromName:ai,get:ai}} as unknown as Env;
  return {e,scoreV1,send,ai};
}
async function registered() {
  await env.BUCKET.put(`mailboxes/${BOX}.json`, '{}');
  await mailbox(BOX).getFolders();
}
function bytes(to = BOX, body = 'Hello synthetic world.', extra: string[] = []) {
  return new TextEncoder().encode(['From: Person <sender@example.test>',`To: ${to}`,'Subject: Synthetic',
    ...extra,'MIME-Version: 1.0','Content-Type: text/plain; charset=utf-8','',''+body].join('\r\n'));
}
async function deliver(e: Env, raw = bytes(), to = BOX, padding = 0) {
  const reject = vi.fn();
  const ctx = createExecutionContext();
  await worker.email({raw:new ReadableStream({start(c){c.enqueue(raw);c.close();}}),rawSize:raw.length+padding,
    to,from:'bounce@example.test',setReject:reject} as unknown as ForwardableEmailMessage,e,ctx);
  await waitOnExecutionContext(ctx);
  expect(reject).not.toHaveBeenCalled();
  const rows = await query<{id:string;folder_id:string;raw_key:string;uid:number;delivered_to:string}>(mailbox(BOX),'SELECT id,folder_id,raw_key,uid,delivered_to FROM emails ORDER BY uid DESC');
  expect(rows.length).toBeGreaterThan(0);
  return rows[0];
}
async function request(e: Env, path: string, body?: unknown, token = humanToken, headers: Record<string,string> = {}) {
  const ctx = createExecutionContext();
  const r = await worker.fetch(new Request(ORIGIN+path,{method:body === undefined ? 'GET':'POST',headers:{
    'cf-access-jwt-assertion':token,'content-type':'application/json','origin':ORIGIN,
    'sec-fetch-site':'same-origin','x-inbox-manual-action':'1',...headers},body:body === undefined ? undefined : JSON.stringify(body)}),e,ctx);
  await waitOnExecutionContext(ctx);
  return r;
}
const base = `/api/v1/mailboxes/${BOX}`;

async function crossing() {
  await registered(); const stub=mailbox(BOX);
  for(const [id,folder,read,date,sender] of [
    ['trusted','inbox',true,'2026-10-20T01:00:00Z','friend@example.test'],
    ['sent','sent',true,'2026-10-20T02:00:00Z',BOX],
    ['evil','spam',false,'2026-10-20T03:00:00Z','QUARANTINE_CANARY@example.test'],
  ] as const) await stub.createEmail(folder,{...emailData({id,date}),read,sender,subject:'same subject',body:id==='evil'?'QUARANTINE_CANARY <img src="https://tracker.invalid/pixel">':'hello',thread_id:'forged-chain',in_reply_to:'trusted',email_references:'["trusted"]'},[]);
  return stub;
}
async function json(path:string) { const r=await request(bindings().e,base+path); expect(r.status,path).toBe(200);return r.json() as Promise<any>; }
describe('quarantine through actual authenticated app handlers and shared tools',()=>{
  it('excludes forged-chain Spam from normal bodies, participants, unread and needs-reply; explicit review isolates Spam',async()=>{
    await crossing();
    const list=await json('/emails?folder=inbox&threaded=true');
    expect(list.emails[0]).toMatchObject({thread_count:2,thread_unread_count:0,needs_reply:false,has_draft:false});
    expect(JSON.stringify(list)).not.toContain('QUARANTINE_CANARY');
    const normal=await json('/threads/forged-chain');expect(normal.map((e:any)=>e.id)).toEqual(['trusted','sent']);
    expect((await request(bindings().e,base+'/emails/evil')).status).toBe(404);
    expect((await json('/emails/evil?scope=spam')).id).toBe('evil');
    expect((await json('/threads/forged-chain?scope=spam')).map((e:any)=>e.id)).toEqual(['evil']);
    expect((await json('/emails?folder=spam&threaded=true')).emails[0]).toMatchObject({thread_count:1,thread_unread_count:1});
    expect((await request(bindings().e,base+'/emails/trusted?scope=spam')).status).toBe(404);
    const b=bindings();
    expect(await toolGetEmail(b.e,BOX,'evil')).toEqual({error:'Email not found'});
    expect(JSON.stringify(await toolGetThread(b.e,BOX,'forged-chain'))).not.toContain('QUARANTINE_CANARY');
    expect(JSON.stringify(await toolGetThread(b.e,BOX,'forged-chain','spam'))).toContain('QUARANTINE_CANARY');
    const review=await toolGetEmail(b.e,BOX,'evil','spam');expect(review).toMatchObject({attachments:[]});expect(review).not.toHaveProperty('raw_key');
    expect(JSON.stringify(await toolListEmails(b.e,BOX,{folder:'inbox',limit:20,page:1}))).not.toContain('QUARANTINE_CANARY');
  });
  it('default search, counts, no-folder lists and explicit Spam searches agree',async()=>{
    const stub=await crossing();
    expect(await stub.countEmails()).toBe(2);
    expect((await json('/emails')).map((e:any)=>e.id).sort()).toEqual(['sent','trusted']);
    for (const path of ['/search?query=QUARANTINE_CANARY','/search?query=QUARANTINE_CANARY&folder=inbox']) {
      expect(await json(path)).toMatchObject({emails:[],totalCount:0});
    }
    expect(await json('/search?query=QUARANTINE_CANARY&folder=spam')).toMatchObject({totalCount:1});
    expect(await toolSearchEmails(bindings().e,BOX,{query:'QUARANTINE_CANARY'})).toEqual([]);
    expect((await toolSearchEmails(bindings().e,BOX,{query:'QUARANTINE_CANARY',folder:'spam'}) as any[]).length).toBe(1);
  });
  it('scopes mark-read and rejects quarantined original before AI verification or reply',async()=>{
    const stub=await crossing(); const b=bindings();
    expect((await request(b.e,base+'/threads/forged-chain/read',{})).status).toBe(200);
    expect((await stub.getEmail('evil','spam'))?.read).toBe(false);
    expect((await toolDraftReply(b.e,BOX,{originalEmailId:'evil',to:'sender@example.test',subject:'reply',body:'x',runVerifyDraft:true}))).toHaveProperty('error');
    expect((await request(b.e,base+'/emails/evil/reply',{to:'sender@example.test',subject:'Re',html:'hello'})).status).toBe(404);
    expect((await request(b.e,base+'/emails/evil/forward',{to:'sender@example.test',subject:'Fw',html:'hello'})).status).toBe(404);
    expect(b.ai).not.toHaveBeenCalled();expect(b.send).not.toHaveBeenCalled();
    expect((await request(b.e,base+'/threads/forged-chain/read?scope=spam',{})).status).toBe(200);
    expect((await stub.getEmail('evil','spam'))?.read).toBe(true);
  });
  it('manual feedback moves atomically, keeps original assessment and UID history, and rescues',async()=>{
    const stub=await crossing();const b=bindings();
    const before=await query(stub,'SELECT id,uid,folder_id FROM emails ORDER BY id');
    const feedback={emailId:'trusted',disposition:'spam',expectedRevision:0};
    expect((await request(b.e,base+'/spam-feedback',feedback)).status).toBe(200);
    expect(await stub.getEmail('trusted')).toBeNull();
    const moved=await stub.getEmail('trusted','spam');expect(moved?.uid).toBe(2);
    expect((await request(b.e,base+'/spam-feedback',feedback)).status).toBe(200);
    expect((await stub.getEmail('trusted','spam'))?.uid).toBe(2);
    expect((await request(b.e,base+'/spam-feedback',{...feedback,disposition:'not_spam',expectedRevision:1})).status).toBe(200);
    expect((await stub.getEmail('trusted'))?.uid).toBe(2);
    expect(await query(stub,'SELECT id,uid,folder_id FROM emails WHERE id != ? ORDER BY id','trusted')).toEqual(before.filter((r:any)=>r.id!=='trusted'));
    expect((await stub.getSpamState('trusted'))).toMatchObject({disposition:'not_spam',revision:2,assessments:[]});
    expect(await query(stub,'SELECT * FROM sender_preferences')).toEqual([]);
    expect((await request(b.e,base+'/spam-feedback',feedback)).status).toBe(409);
    expect((await json('/threads/forged-chain')).map((e:any)=>e.id)).toEqual(['trusted','sent']);
  });
  it('ordinary alternate-client MOVE and rescue never infer feedback; retries do not undo a later ordinary move',async()=>{
    const stub=await crossing();const b=bindings();
    const epoch=await stub.getQuarantineEpoch();
    const r=await request(b.e,`/api/imap/v1/${BOX}/inbox/move`,{uids:[1],destination:'spam'});
    expect(r.status,await r.clone().text()).toBe(200);
    expect(await stub.getEmail('trusted')).toBeNull();expect(await stub.getQuarantineEpoch()).toBeGreaterThan(epoch);
    expect(await query(stub,'SELECT * FROM spam_dispositions')).toEqual([]);
    expect((await request(b.e,base+'/emails/trusted/move',{folderId:'inbox'})).status).toBe(200);
    expect(await query(stub,'SELECT * FROM sender_preferences')).toEqual([]);
    const action={emailId:'trusted',disposition:'spam',expectedRevision:0};
    expect((await request(b.e,base+'/spam-feedback',action)).status).toBe(200);
    expect((await request(b.e,base+'/emails/trusted/move',{folderId:'inbox'})).status).toBe(200);
    expect((await request(b.e,base+'/spam-feedback',action)).status).toBe(200);
    expect(await stub.getEmail('trusted')).not.toBeNull(); // exact retry does not replay move
    expect((await request(b.e,base+'/spam-feedback',{...action,expectedRevision:1})).status).toBe(200);
    expect(await stub.getEmail('trusted')).toBeNull(); // fresh deliberate action does
  });
  it('subject fallback and legacy/null thread collisions do not include Spam',async()=>{
    const stub=await crossing();
    await stub.createEmail('inbox',{...emailData({id:'legacy'}),subject:'collision',thread_id:null},[]);
    await stub.createEmail('spam',{...emailData({id:'evil-legacy'}),subject:'collision',thread_id:null,sender:'QUARANTINE_CANARY'},[]);
    const list=await json('/emails?folder=inbox&threaded=true');
    expect(JSON.stringify(list)).not.toContain('QUARANTINE_CANARY');
    expect(list.emails.find((e:any)=>e.id==='legacy').thread_count).toBe(1);
    await stub.createEmail('spam',{...emailData({id:'subject-trap',date:new Date().toISOString()}),subject:'only in spam',thread_id:'trap',sender:'sender@example.test'},[]);
    expect(await stub.findThreadBySubject('Re: only in spam','sender@example.test')).toBeNull();
  });
});

describe('quarantine transaction and attachment boundaries',()=>{
  it('rolls back destination UID and folder when feedback storage fails',async()=>{
    const stub=await crossing();
    const before=await query(stub,'SELECT id,uid_next FROM folders ORDER BY id');
    await runInDurableObject(stub,(_i,state)=>{state.storage.sql.exec("CREATE TRIGGER synthetic_feedback_failure BEFORE INSERT ON spam_dispositions BEGIN SELECT RAISE(ABORT, 'synthetic'); END");});
    const failed = await runInDurableObject(stub,async instance=>{
      try { await (instance as import('../workers/durableObject').MailboxDO).setSpamDisposition({emailId:'trusted',disposition:'spam',expectedRevision:0}); return false; } catch { return true; }
    });
    expect(failed).toBe(true);
    expect((await stub.getEmail('trusted'))?.folder_id).toBe('inbox');
    expect(await query(stub,'SELECT id,uid_next FROM folders ORDER BY id')).toEqual(before);
    expect(await query(stub,'SELECT * FROM spam_dispositions')).toEqual([]);
  });
  it('requires explicit Spam scope for attachment downloads and preserves IMAP visibility',async()=>{
    await registered();const stub=mailbox(BOX);
    await stub.createEmail('spam',{...emailData({id:'attachment-mail'})},[{id:'att',email_id:'attachment-mail',filename:'fixture.txt',mimetype:'text/plain',size:9}]);
    await env.BUCKET.put('attachments/attachment-mail/att/fixture.txt','SYNTHETIC');
    const b=bindings();
    expect((await request(b.e,base+'/emails/attachment-mail/attachments/att')).status).toBe(404);
    const review=await request(b.e,base+'/emails/attachment-mail/attachments/att?scope=spam');
    expect(review.status).toBe(200);expect(await review.text()).toBe('SYNTHETIC');
    const imap=await request(b.e,`/api/imap/v1/${BOX}/spam/messages`);expect(imap.status).toBe(200);
    expect(await imap.json()).toMatchObject({messages:[{uid:1,envelope:{from:[{address:'sender@example.com'}]}}],uidNext:2});
  });
});
