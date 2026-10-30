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
import { toolMarkSpam, toolSetSenderPreference } from '../workers/lib/tools';
import { decodeResponse } from '../workers/lib/mail-scoring/protocol';
import { project } from '../workers/lib/mail-scoring/intake';
import { REASONS, type ScoreResultV1 } from '../workers/lib/mail-scoring/contract';
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
const wire = JSON.stringify(contractEvidence.fixture);
const fixture = decodeResponse(wire);
if (!fixture?.ok) throw new Error('Invalid synthetic scorer fixture');
const result = fixture.result;
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
function bindings(mode: Env['MAIL_SCORING_MODE'] = 'shadow', response: unknown = wire) {
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
  const rows = await query<{id:string;folder_id:string;raw_key:string;uid:number;delivered_to:string}>(mailbox(BOX),'SELECT id,folder_id,raw_key,uid,delivered_to FROM emails ORDER BY rowid DESC');
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

const suspiciousResult: ScoreResultV1 = {
  ...result, status:'partial', heuristicScore:45,
  signals:{spam:'present',phishing:'present',marketing:'unknown'},
  limitsHit:['auth_unknown','source_incomplete'],
  reasons:[
    {id:'reply_to_mismatch',contribution:10,reason:REASONS.reply_to_mismatch},
    {id:'impersonation_combined',contribution:10,reason:REASONS.impersonation_combined},
    {id:'sensitive_request_combined',contribution:25,reason:REASONS.sensitive_request_combined},
  ],
};
const responseFor = (value: ScoreResultV1) => JSON.stringify({rpcVersion:'1',ok:true,result:value});

describe('automatic Spam routing for new arrivals', () => {
  it('preserves existing mail, raw MIME, attachments and assessment; Not spam rescues with correct UIDs', async () => {
    await registered();const stub=mailbox(BOX);
    await stub.createEmail('inbox',emailData({id:'existing'}),[]);
    const b=bindings('filter',responseFor(suspiciousResult));
    const raw=new TextEncoder().encode(`From: sender@example.test\r\nReply-To: elsewhere@example.org\r\nTo: ${BOX}\r\nSubject: Security team\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=synthetic\r\n\r\n--synthetic\r\nContent-Type: text/plain\r\n\r\nVerify your password\r\n--synthetic\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=fixture.txt\r\nContent-Transfer-Encoding: base64\r\n\r\nU1lOVEhFVElD\r\n--synthetic--\r\n`);
    const row=await deliver(b.e,raw);
    expect(row).toMatchObject({folder_id:'spam',uid:1});
    expect((await stub.getEmail('existing'))?.uid).toBe(1);
    expect(await stub.getEmail(row.id)).toBeNull();
    expect(new Uint8Array(await (await env.BUCKET.get(row.raw_key))!.arrayBuffer())).toEqual(raw);
    expect(await query(stub,'SELECT filename,size FROM attachments')).toEqual([{filename:'fixture.txt',size:9}]);
    const original=await stub.getSpamState(row.id);
    expect(original).toMatchObject({disposition:'unknown',revision:0,assessments:[{result:suspiciousResult}]});
    expect(await (await request(b.e,`${base}/emails/${row.id}/spam`)).json()).toMatchObject({automaticQuarantine:true});
    expect((await request(b.e,`${base}/emails/${row.id}?scope=spam`)).status).toBe(200);
    expect((await request(b.e,`/api/imap/v1/${BOX}/spam/messages`)).status).toBe(200);
    expect((await request(b.e,`${base}/spam-feedback`,{emailId:row.id,disposition:'not_spam',expectedRevision:0})).status).toBe(200);
    expect((await stub.getEmail(row.id))).toMatchObject({folder_id:'inbox',uid:2,raw_key:row.raw_key});
    expect((await stub.getSpamState(row.id))?.assessments).toEqual(original?.assessments);
    await expect((await restart(BOX)).getSpamState(row.id)).resolves.toMatchObject({disposition:'not_spam'});
    expect(b.scoreV1).toHaveBeenCalledTimes(1);expect(b.ai).not.toHaveBeenCalled();expect(b.send).not.toHaveBeenCalled();
  });
  it.each(['off','shadow'] as const)('%s does not move even high scoring mail',async mode=>{
    await registered();const b=bindings(mode,responseFor(suspiciousResult));
    const row=await deliver(b.e);expect(row.folder_id).toBe('inbox');
    expect(await (await request(b.e,`${base}/emails/${row.id}/spam`)).json()).toMatchObject({automaticQuarantine:false});
  });
  it.each(['ordinary','below_threshold','marketing','quoted_content','identity_uninspected','field_bytes'])(
    '%s stays in Inbox',async kind=>{
      await registered();let value: ScoreResultV1={...suspiciousResult};
      if(kind==='ordinary') value=result;
      else if(kind==='marketing') value={...result,reasons:[{id:'marketing_headers',contribution:0,reason:REASONS.marketing_headers}]};
      else if(kind==='below_threshold') value={...value,heuristicScore:44,reasons:value.reasons.map(r=>r.id==='impersonation_combined'?{...r,contribution:9}:r)};
      else value={...value,limitsHit:[...value.limitsHit,kind as 'quoted_content'|'identity_uninspected'|'field_bytes']};
      expect((await deliver(bindings('filter',responseFor(value)).e)).folder_id).toBe('inbox');
    });
  it.each(['allow','block'] as const)('honors explicit %s preference',async preference=>{
    await registered();await mailbox(BOX).setSenderPreference({sender:'sender@example.test',preference,expectedRevision:0});
    const value=preference==='allow'?suspiciousResult:result;
    expect((await deliver(bindings('filter',responseFor(value)).e)).folder_id).toBe(preference==='block'?'spam':'inbox');
  });
  it('preserves delivery when sender preferences cannot be read',async()=>{
    await registered();
    const b=bindings('filter',responseFor(suspiciousResult));const stub=mailbox(BOX);
    b.e.MAILBOX={idFromName:env.MAILBOX.idFromName.bind(env.MAILBOX),get:()=>({
      findThreadBySubject:(...args:Parameters<typeof stub.findThreadBySubject>)=>stub.findThreadBySubject(...args),
      createEmail:(...args:Parameters<typeof stub.createEmail>)=>stub.createEmail(...args),
      getSenderPreference:async()=>{throw new Error('Synthetic preference lookup failure');},
    })} as unknown as Env['MAILBOX'];
    expect((await deliver(b.e)).folder_id).toBe('inbox');
  });
  it.each([0,5])('keeps uninspectable raw input in Inbox (padding %i)',async padding=>{
    await registered();const b=bindings('filter',responseFor(suspiciousResult));
    expect((await deliver(b.e,padding?bytes():bytes(BOX,'x'.repeat(131073)),BOX,padding)).folder_id).toBe('inbox');
    expect(b.scoreV1).not.toHaveBeenCalled();
  });
});

describe('actual app email and authenticated REST in local workerd', () => {
  it('off makes no calls, leaves legacy unknown, preserves raw bytes, attachments and UID', async () => {
    await registered(); const b = bindings('off');
    const raw = new TextEncoder().encode(`From: sender@example.test\r\nTo: ${BOX}\r\nSubject: fixture\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=synthetic\r\n\r\n--synthetic\r\nContent-Type: text/plain\r\n\r\nHello\r\n--synthetic\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=fixture.txt\r\nContent-Transfer-Encoding: base64\r\n\r\nU1lOVEhFVElD\r\n--synthetic--\r\n`);
    const first = await deliver(b.e,raw);
    expect(first.folder_id).toBe('inbox'); expect(first.uid).toBe(1);
    expect(new Uint8Array(await (await env.BUCKET.get(first.raw_key))!.arrayBuffer())).toEqual(raw);
    expect(await query(mailbox(BOX),'SELECT filename,size FROM attachments')).toEqual([{filename:'fixture.txt',size:9}]);
    expect(await mailbox(BOX).getSpamState(first.id)).toEqual({assessments:[],disposition:'unknown',revision:0});
    await deliver(b.e,bytes(BOX,'x'.repeat(140000)));
    expect(b.scoreV1).toHaveBeenCalledTimes(0); expect(b.ai).toHaveBeenCalledTimes(0); expect(b.send).toHaveBeenCalledTimes(0);
  });
  it('shadow scores once after alias/Bcc/multiple-recipient routing and persists across reads/restart', async () => {
    await registered(); const b = bindings();
    expect((await createAlias(b.e,ALIAS,BOX)).ok).toBe(true);
    const raw = bytes('stranger@example.test, other@example.test');
    const row = await deliver(b.e,raw,ALIAS);
    expect(row.delivered_to).toBe(ALIAS); expect(row.folder_id).toBe('inbox');
    expect(new Uint8Array(await (await env.BUCKET.get(row.raw_key))!.arrayBuffer())).toEqual(raw);
    expect(b.scoreV1).toHaveBeenCalledTimes(1);
    const input = JSON.parse(new TextDecoder().decode(b.scoreV1.mock.calls[0][1]));
    expect(input.addresses.envelopeFrom).toBe('bounce@example.test');
    expect(input).not.toHaveProperty('attachments'); expect(input).not.toHaveProperty('raw');
    expect(input.transport).toEqual({provenance:'unknown',complete:false,spf:'unknown',dkim:'unknown',dmarc:'unknown'});
    for (let i=0;i<2;i++) for (const path of [`${base}/emails`,`${base}/emails/${row.id}`,`${base}/emails/${row.id}/spam`,`${base}/threads/${row.id}`,
      `/api/imap/v1/${BOX}/inbox/status`,`/api/imap/v1/${BOX}/inbox/messages`,`/api/imap/v1/${BOX}/folders`]) {
      const r = await request(b.e,path); expect(r.status, path).toBe(200);
    }
    const state = await (await restart(BOX)).getSpamState(row.id);
    expect(state?.assessments[0]).toMatchObject({version:1,status:'partial',inputIncomplete:true,result});
    expect(b.scoreV1).toHaveBeenCalledTimes(1); expect(b.ai).not.toHaveBeenCalled(); expect(b.send).not.toHaveBeenCalled();
    // Header fallback still selects the first existing recipient, one delivery.
    await deliver(b.e,bytes(`stranger@example.test, ${BOX}, other@example.test`),'unknown@example.test');
    expect(b.scoreV1).toHaveBeenCalledTimes(2);
  });
  it('does not score unknown recipients', async () => {
    const b = bindings(); const raw = bytes(); const reject=vi.fn();
    await worker.email({raw:new ReadableStream({start(c){c.enqueue(raw);c.close();}}),rawSize:raw.length,to:BOX,setReject:reject} as unknown as ForwardableEmailMessage,b.e,createExecutionContext());
    expect(reject).toHaveBeenCalled(); expect(b.scoreV1).not.toHaveBeenCalled();
  });
  describe.each(['shadow','filter'] as const)('%s delivery failures', mode => {
  it.each(['missing','throw','timeout','malformed','huge','deep','version','forged_reason','invented_auth','inconsistent','nan','unavailable'])(
    '%s scorer keeps delivery and records unavailable without preferences or AI', async kind => {
      await registered(); const b = bindings(mode);
      if(kind==='missing') delete b.e.MAIL_SCORER;
      if(kind==='throw') b.scoreV1.mockImplementation(async()=>{throw new Error('SYNTHETIC_PRIVATE_CANARY');});
      if(kind==='timeout') b.scoreV1.mockImplementation(()=>new Promise(()=>{}));
      if(kind==='malformed') b.scoreV1.mockResolvedValue('SYNTHETIC_PRIVATE_CANARY');
      if(kind==='huge') b.scoreV1.mockResolvedValue('x'.repeat(4097));
      if(kind==='deep') b.scoreV1.mockResolvedValue('['.repeat(10)+'0'+']'.repeat(10));
      if(kind==='version') b.scoreV1.mockResolvedValue(wire.replace('rules-1','rules-2'));
      if(kind==='forged_reason') b.scoreV1.mockResolvedValue(JSON.stringify({rpcVersion:'1',ok:true,result:{...result,reasons:[{id:'auth_failed',contribution:20,reason:'SYNTHETIC_PRIVATE_CANARY'}],heuristicScore:20}}));
      if(kind==='invented_auth') b.scoreV1.mockResolvedValue(JSON.stringify({rpcVersion:'1',ok:true,result:{...result,reasons:[{id:'auth_failed',contribution:20,reason:'Verified transport evidence reports authentication failure.'}],heuristicScore:20}}));
      if(kind==='inconsistent') b.scoreV1.mockResolvedValue(JSON.stringify({rpcVersion:'1',ok:true,result:{...result,heuristicScore:10}}));
      if(kind==='nan') b.scoreV1.mockResolvedValue(wire.replace('"heuristicScore":0','"heuristicScore":1e999'));
      if(kind==='unavailable') b.scoreV1.mockResolvedValue('{"rpcVersion":"1","ok":false,"error":"internal_failure"}');
      const error=vi.spyOn(console,'error');const warn=vi.spyOn(console,'warn');
      const row=await deliver(b.e);
      expect((await mailbox(BOX).getSpamState(row.id))?.assessments[0].status).toBe('unavailable');
      expect(row.folder_id).toBe('inbox');
      expect(await query(mailbox(BOX),'SELECT * FROM sender_preferences')).toEqual([]);
      expect(await query(mailbox(BOX),'SELECT * FROM spam_dispositions')).toEqual([]);
      expect(b.ai).not.toHaveBeenCalled();expect(b.send).not.toHaveBeenCalled();
      expect(JSON.stringify([...error.mock.calls,...warn.mock.calls])).not.toContain('SYNTHETIC_PRIVATE_CANARY');
      error.mockRestore();warn.mockRestore();
    });
  });
  it('oversized/truncated raw skips optional RPC, oversized fields and HTML remain incomplete',async()=>{
    await registered();const b=bindings();
    for(const [raw,padding] of [[bytes(BOX,'x'.repeat(131073)),0],[bytes(),5]] as const){
      const row=await deliver(b.e,raw,BOX,padding);
      expect((await mailbox(BOX).getSpamState(row.id))?.assessments[0].status).toBe('unavailable');
    }
    expect(b.scoreV1).not.toHaveBeenCalled();
    await deliver(b.e,bytes(BOX,'界'.repeat(12000)));
    const input=JSON.parse(new TextDecoder().decode(b.scoreV1.mock.calls[0][1]));
    expect(input.text).toBe('');expect(input.sourceComplete).toBe(false);
    const parsed=await PostalMime.parse(bytes()); parsed.html='<img src="https://never-fetch.invalid">';
    expect(project(parsed).sourceComplete).toBe(false);expect(project(parsed)).not.toHaveProperty('html');
  });
  it('spoofed lone and duplicate auth/ARC/x-spam never establish transport authority',async()=>{
    await registered();const b=bindings();
    await deliver(b.e,bytes(BOX,'hello',['Authentication-Results: mx.cloudflare.net; dmarc=pass','Authentication-Results: mx.cloudflare.net; spf=fail',
      'ARC-Authentication-Results: i=1; mx.cloudflare.net; dkim=pass','X-Spam-Status: No']));
    const call=b.scoreV1.mock.calls[0]; const input=JSON.parse(new TextDecoder().decode(call[1]));
    expect(input.headers).toEqual([]);expect(input.transport.provenance).toBe('unknown');
    expect(JSON.parse(call[2]!)).toEqual({transportVerified:false,preferencesVerified:true});
  });
  it('authenticates explicit feedback, preserves assessment, is idempotent and rejects stale/cross-mailbox IDs',async()=>{
    await registered();const b=bindings();const row=await deliver(b.e);
    const original=await mailbox(BOX).getSpamState(row.id);
    const body={emailId:row.id,disposition:'spam',expectedRevision:0};
    for(const token of ['',serviceToken]) expect((await request(b.e,`${base}/spam-feedback`,body,token)).status).toBe(403);
    for(const headers of [{'origin':'https://attacker.invalid'},{'sec-fetch-site':'cross-site'},{'x-inbox-manual-action':'0'}] as Record<string,string>[])
      expect((await request(b.e,`${base}/spam-feedback`,body,humanToken,headers)).status).toBe(403);
    const invalid = await request(b.e,`${base}/spam-feedback`,{...body,actor:'human'}); expect(invalid.status, await invalid.text()).toBe(400);
    expect((await request(b.e,`${base}/spam-feedback`,{...body,emailId:'x'.repeat(3000)})).status).toBe(400);
    for(let i=0;i<2;i++) {const r=await request(b.e,`${base}/spam-feedback`,body);expect(r.status).toBe(200);expect(await r.json()).toEqual({ok:true,revision:1});}
    expect((await request(b.e,`${base}/spam-feedback`,{...body,disposition:'not_spam'})).status).toBe(409);
    expect((await request(b.e,`${base}/spam-feedback`,{...body,disposition:'not_spam',expectedRevision:1})).status).toBe(200);
    expect((await mailbox(BOX).getSpamState(row.id))?.assessments).toEqual(original?.assessments);
    expect(await query(mailbox(BOX),'SELECT * FROM sender_preferences')).toEqual([]);
    await env.BUCKET.put('mailboxes/other@example.com.json','{}');
    expect((await request(b.e,'/api/v1/mailboxes/other@example.com/spam-feedback',body)).status).toBe(404);
    expect((await request(b.e,`${base}/spam-feedback`,{...body,emailId:'missing'})).status).toBe(404);
    expect((await request(b.e,`${base}/spam-feedback`,{...body,emailId:'../invalid'})).status).toBe(400);
    const pref={sender:'sender@example.test',preference:'block',expectedRevision:0};
    const responses=await Promise.all([request(b.e,`${base}/sender-preference`,pref),request(b.e,`${base}/sender-preference`,{...pref,preference:'allow'})]);
    expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
    const state=await mailbox(BOX).getSenderPreference(pref.sender);
    expect(state?.revision).toBe(1);
    expect((await request(b.e,`${base}/sender-preference`,{...pref,preference:state?.preference})).status).toBe(200);
    expect(await mailbox('other@example.com').getSenderPreference(pref.sender)).toMatchObject({preference:'none',revision:0});
    expect(b.scoreV1).toHaveBeenCalledTimes(1);
    await expect(toolMarkSpam(b.e,BOX,body as any,{mailboxId:BOX})).rejects.toThrow('Explicit manual');
    await expect(toolSetSenderPreference(b.e,BOX,pref as any,{mailboxId:BOX})).rejects.toThrow('Explicit manual');
  });
  it('routine move, rescue and delete never train; explicit preferences affect only later shadow arrivals',async()=>{
    await registered();const b=bindings();const row=await deliver(b.e);
    for(const folderId of ['trash','inbox']) expect((await request(b.e,`${base}/emails/${row.id}/move`,{folderId})).status).toBe(200);
    expect(await query(mailbox(BOX),'SELECT * FROM sender_preferences')).toEqual([]);
    expect(await query(mailbox(BOX),'SELECT * FROM spam_dispositions')).toEqual([]);
    expect((await request(b.e,`${base}/sender-preference`,{sender:'sender@example.test',preference:'block',expectedRevision:0})).status).toBe(200);
    const next=await deliver(b.e);
    const call=b.scoreV1.mock.calls[1];const input=JSON.parse(new TextDecoder().decode(call[1]));
    expect(input.preferences).toEqual({senderAllowed:false,senderBlocked:true});
    expect(JSON.parse(call[2]!).preferencesVerified).toBe(true);
    expect(next.folder_id).toBe('inbox');
    await mailbox(BOX).deleteEmail(next.id);
    expect((await mailbox(BOX).getSenderPreference('sender@example.test'))?.preference).toBe('block');
    expect(await query(mailbox(BOX),'SELECT * FROM spam_dispositions')).toEqual([]);
    expect(b.scoreV1).toHaveBeenCalledTimes(2);expect(b.ai).not.toHaveBeenCalled();expect(b.send).not.toHaveBeenCalled();
  });
  it('migration 12 populated DB upgrades without rescanning and keeps FK/idempotence',async()=>{
    const stub=mailbox(BOX);await stub.getFolders();
    await runInDurableObject(stub,async(_instance,state)=>{
      await state.storage.deleteAll();
      applyMigrations(state.storage.sql,mailboxMigrations.slice(0,12),state.storage);
      state.storage.sql.exec("INSERT INTO emails(id,folder_id,uid,body,raw_key) VALUES ('legacy','inbox',1,'synthetic','raw/legacy')");
      applyMigrations(state.storage.sql,mailboxMigrations,state.storage);
    });
    expect(await (await restart(BOX)).getSpamState('legacy')).toEqual({assessments:[],disposition:'unknown',revision:0});
    expect(await query(stub,"SELECT body,uid,raw_key FROM emails WHERE id='legacy'")).toEqual([{body:'synthetic',uid:1,raw_key:'raw/legacy'}]);
    expect(await query(stub,"SELECT count(*) AS n FROM d1_migrations WHERE name='13_shadow_assessments_feedback'")).toEqual([{n:1}]);
    expect(await stub.setSpamDisposition({emailId:'legacy',disposition:'spam',expectedRevision:0})).toEqual({ok:true,revision:1});
    await runInDurableObject(stub,(_i,s)=>{s.storage.sql.exec("DELETE FROM emails WHERE id='legacy'");});
    expect(await query(stub,'SELECT * FROM spam_dispositions')).toEqual([]);
  });
});
