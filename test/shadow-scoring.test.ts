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
import { toolMarkSpam, toolSetSenderPreference, toolGetEmail, toolGetThread, toolListEmails, toolSearchEmails, toolDraftReply } from '../workers/lib/tools';
import { decodeResponse } from '../workers/lib/mail-scoring/protocol';
import { project } from '../workers/lib/mail-scoring/intake';
import { GTUBE_MARKER, REASONS, type ScoreResultV1 } from '../workers/lib/mail-scoring/contract';
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
    const b=realBindings('filter');const stub=mailbox(BOX);
    b.e.MAILBOX={idFromName:env.MAILBOX.idFromName.bind(env.MAILBOX),get:()=>({
      findThreadBySubject:(...args:Parameters<typeof stub.findThreadBySubject>)=>stub.findThreadBySubject(...args),
      createEmail:(...args:Parameters<typeof stub.createEmail>)=>stub.createEmail(...args),
      getSenderPreference:async()=>{throw new Error('Synthetic preference lookup failure');},
    })} as unknown as Env['MAILBOX'];
    const row=await deliver(b.e,bytes(BOX,GTUBE_MARKER));
    expect(row.folder_id).toBe('inbox');
    expect((await stub.getSpamState(row.id))?.assessments[0].result?.heuristicScore).toBe(100);
    expect(b.scoreV1).toHaveBeenCalledTimes(1);
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
  it.each(['missing','throw','timeout','malformed','huge','deep','version','rules1_gtube','arbitrary_reason','forged_reason','invented_auth','inconsistent','nan','unavailable'])(
    '%s scorer keeps delivery and records unavailable without preferences or AI', async kind => {
      await registered(); const b = bindings(mode);
      if(kind==='missing') delete b.e.MAIL_SCORER;
      if(kind==='throw') b.scoreV1.mockImplementation(async()=>{throw new Error('SYNTHETIC_PRIVATE_CANARY');});
      if(kind==='timeout') b.scoreV1.mockImplementation(()=>new Promise(()=>{}));
      if(kind==='malformed') b.scoreV1.mockResolvedValue('SYNTHETIC_PRIVATE_CANARY');
      if(kind==='huge') b.scoreV1.mockResolvedValue('x'.repeat(4097));
      if(kind==='deep') b.scoreV1.mockResolvedValue('['.repeat(10)+'0'+']'.repeat(10));
      if(kind==='version') b.scoreV1.mockResolvedValue(wire.replace('rules-1','rules-3'));
      if(kind==='rules1_gtube') b.scoreV1.mockResolvedValue(JSON.stringify({rpcVersion:'1',ok:true,result:{...result,ruleSetVersion:'rules-1',heuristicScore:100,signals:{spam:'present',phishing:'unknown',marketing:'unknown'},reasons:[{id:'gtube',contribution:100,reason:REASONS.gtube}]}}));
      if(kind==='arbitrary_reason') b.scoreV1.mockResolvedValue(JSON.stringify({rpcVersion:'1',ok:true,result:{...result,ruleSetVersion:'rules-2',heuristicScore:100,signals:{spam:'present',phishing:'unknown',marketing:'unknown'},reasons:[{id:'custom_spam',contribution:100,reason:REASONS.gtube}]}}));
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

function realBindings(mode: Env['MAIL_SCORING_MODE'] = 'filter', scorer = env.MAIL_SCORER) {
  if (!scorer) throw new Error('Expected real MAIL_SCORER workerd service binding');
  const scoreV1 = vi.fn((version: string, input: Uint8Array, context?: string) => scorer.scoreV1(version, input, context));
  const send = vi.fn(() => {throw new Error('Outbound forbidden');});
  const ai = vi.fn(() => {throw new Error('AI forbidden');});
  const e = {...env, POLICY_AUD:'synthetic-aud',TEAM_DOMAIN:'https://access.example.test',
    MAIL_SCORING_MODE:mode,MAIL_SCORER:{scoreV1},EMAIL:{send},AI:{run:ai},EMAIL_AGENT:{idFromName:ai,get:ai}} as unknown as Env;
  return {e,scoreV1,send,ai};
}

const reportedPhishing = 'Security team alert: please verify your password immediately.';
function inlinePhishingReport(nestedHeaders: string[]) {
  return new TextEncoder().encode([
    'From: Security Team <sender@example.test>',
    'Reply-To: helpdesk@other.example.org',
    `To: ${BOX}`,
    'Subject: Forwarded security report',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary=inline-report',
    '', '--inline-report', 'Content-Type: text/plain', '',
    'Please investigate the attached phishing report.',
    '--inline-report', 'Content-Type: message/rfc822', 'Content-Disposition: inline', '',
    ...nestedHeaders, 'MIME-Version: 1.0', 'Content-Type: text/plain', '',
    reportedPhishing, '--inline-report--', '',
  ].join('\r\n'));
}

describe('inline forwarded MIME inspection provenance', () => {
  it('keeps inline forwarded phishing reports in Inbox with intact raw mail and assessments', async () => {
    await registered();
    const b = realBindings('filter');
    const ids: string[] = [];
    for (const headers of [
      ['From: Reported Sender <reported@example.test>', 'To: reporter@example.test', 'Subject: Reported message', 'Date: Thu, 1 Oct 2026 12:00:00 +0000'],
      ['To: reporter@example.test', 'Subject: Reported message'],
      ['From: reported@example.test'],
      ['Subject: Reported message'],
    ]) {
      const raw = inlinePhishingReport(headers);
      const parsed = await PostalMime.parse(raw);
      expect(parsed.attachments).toEqual([]);
      expect(parsed.text).toContain(reportedPhishing);
      const row = await deliver(b.e, raw);
      expect(row).toMatchObject({folder_id:'inbox', uid:ids.length + 1});
      ids.push(row.id);
      expect(new Uint8Array(await (await env.BUCKET.get(row.raw_key))!.arrayBuffer())).toEqual(raw);
      expect((await mailbox(BOX).getEmail(row.id))?.body).toContain('verify your password');
      expect(await mailbox(BOX).getSpamState(row.id)).toMatchObject({
        disposition:'unknown', revision:0,
        assessments:[{policyVersion:'inbox-shadow-1', status:'partial', inputIncomplete:true,
          result:{ruleSetVersion:'rules-2', heuristicScore:20, reasons:[
            {id:'reply_to_mismatch', contribution:10},
            {id:'impersonation_combined', contribution:10},
          ]}}],
      });
      expect((await request(b.e, `${base}/emails/${row.id}`)).status).toBe(200);
      const imap = await request(b.e, `/api/imap/v1/${BOX}/inbox/messages`);
      expect(imap.status).toBe(200);
      expect(await imap.json()).toMatchObject({messages:ids.map((_id, index) => ({uid:index + 1, hasRaw:true})), uidNext:ids.length + 1});
      const fetchedRaw = await request(b.e, `/api/imap/v1/${BOX}/messages/${row.uid}/raw?folder=inbox`);
      expect(fetchedRaw.status).toBe(200);
      expect(new Uint8Array(await fetchedRaw.arrayBuffer())).toEqual(raw);
    }
    const restarted = await restart(BOX);
    for (const id of ids) expect((await restarted.getSpamState(id))?.assessments[0].result?.heuristicScore).toBe(20);
    expect(b.scoreV1).toHaveBeenCalledTimes(ids.length);
    expect(b.send).not.toHaveBeenCalled();
    expect(b.ai).not.toHaveBeenCalled();
  });

  it('still quarantines a direct current-body phishing request', async () => {
    await registered();
    const b = realBindings('filter');
    const raw = new TextEncoder().encode([
      'From: Security Team <sender@example.test>', 'Reply-To: helpdesk@other.example.org',
      `To: ${BOX}`, 'Subject: Account notice', 'MIME-Version: 1.0',
      'Content-Type: text/plain', '', reportedPhishing,
    ].join('\r\n'));
    const row = await deliver(b.e, raw);
    expect(row.folder_id).toBe('spam');
    expect((await mailbox(BOX).getSpamState(row.id))?.assessments[0].result).toMatchObject({heuristicScore:45});
  });

  it('keeps ordinary separator/header-like bodies inspectable and bounds forwarded body omission', async () => {
    for (const text of ['Meeting notes\n---\nStatus: complete', 'From: Operations\nPlease review the schedule.', '-'.repeat(32000) + '\nFroX: ordinary near-match']) {
      const parsed = await PostalMime.parse(bytes(BOX, text));
      expect(project(parsed).text).toBe(parsed.text);
    }
    for (const text of ['Report\n---\nFrom: reported@example.test\n' + reportedPhishing,
      '-'.repeat(32000) + '\nSubject: Report\n' + reportedPhishing,
      'é'.repeat(16384) + '\n---\nFrom: reported@example.test']) {
      expect(project(await PostalMime.parse(bytes(BOX, text)))).toMatchObject({text:'', urls:[], sourceComplete:false});
    }
  });
});

describe('suite delivery and quarantine conformance', () => {
  it('keeps mixed quoted/broken markers and legitimate security/Unicode mail in Inbox with actual scoring', async () => {
    await registered(); const b=realBindings('filter');
    for (const control of ['\x00','\x85','\u202e']) {
      const body=`${control}> ${GTUBE_MARKER}\n${GTUBE_MARKER.replace('GTUBE',`GT${control}UBE`)}`;
      const row=await deliver(b.e,bytes(BOX,Buffer.from(body).toString('base64'),['Content-Transfer-Encoding: base64']));
      expect(row.folder_id).toBe('inbox');
      const assessment=(await mailbox(BOX).getSpamState(row.id))?.assessments[0];
      expect(assessment).toMatchObject({status:'partial',result:{heuristicScore:0,reasons:[]}});
      expect(assessment?.result?.limitsHit).toEqual(expect.arrayContaining(['control_chars','quoted_content']));
    }
    for (const body of ['Your sign-in verification code is 123456. Never share it.',
      'Receipt for your order https://shop.example.test/order.', 'こんにちは。明日の会議は午後三時です。',
      'مرحباً، شكراً على رسالتك.', 'Thank you.\n> Security team: send your password https://user@example.test/']) {
      const row=await deliver(b.e,bytes(BOX,body));
      expect(row.folder_id).toBe('inbox');
      expect((await mailbox(BOX).getSpamState(row.id))?.assessments[0].result).toMatchObject({heuristicScore:0,reasons:[]});
    }
    expect(b.ai).not.toHaveBeenCalled(); expect(b.send).not.toHaveBeenCalled();
  });

  it('routes an alias/Bcc arrival to exactly one mailbox before actual GTUBE scoring', async () => {
    await registered(); const b=realBindings('filter');
    await env.BUCKET.put('mailboxes/other@example.test.json','{}');
    await mailbox('other@example.test').setSenderPreference({sender:'sender@example.test',preference:'allow',expectedRevision:0});
    expect((await createAlias(b.e,ALIAS,BOX)).ok).toBe(true);
    const raw=bytes('stranger@example.test, other@example.test',GTUBE_MARKER,[`Bcc: ${BOX}`]);
    const row=await deliver(b.e,raw,ALIAS);
    expect(row).toMatchObject({folder_id:'spam',delivered_to:ALIAS});
    expect(await query(mailbox(BOX),'SELECT id FROM emails')).toHaveLength(1);
    expect(await query(mailbox('other@example.test'),'SELECT id FROM emails')).toHaveLength(0);
    expect((await mailbox(BOX).getSpamState(row.id))?.assessments[0].result?.heuristicScore).toBe(100);
    expect(b.scoreV1).toHaveBeenCalledTimes(1);
  });

  it('retains accepted mail and recovery when optional assessment persistence fails', async () => {
    await registered(); const b=realBindings('filter'); const stub=mailbox(BOX);
    await runInDurableObject(stub,(_i,state)=>{state.storage.sql.exec("CREATE TRIGGER synthetic_assessment_failure BEFORE INSERT ON spam_assessments BEGIN SELECT RAISE(ABORT, 'synthetic'); END");});
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    try {
      const raw=bytes(BOX,GTUBE_MARKER); const row=await deliver(b.e,raw);
      expect(row.folder_id).toBe('spam');
      expect((await stub.getSpamState(row.id))?.assessments).toEqual([]);
      expect(new Uint8Array(await (await env.BUCKET.get(row.raw_key))!.arrayBuffer())).toEqual(raw);
      expect((await request(b.e,`${base}/spam-feedback`,{emailId:row.id,disposition:'not_spam',expectedRevision:0})).status).toBe(200);
      expect(await stub.getEmail(row.id)).toMatchObject({folder_id:'inbox',uid:1});
      expect(b.scoreV1).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls).toEqual([['Optional assessment storage unavailable']]);
    } finally {
      warn.mockRestore();
      await runInDurableObject(stub,(_i,state)=>{state.storage.sql.exec('DROP TRIGGER synthetic_assessment_failure');});
    }
  });

  it('keeps the stored body and IMAP fallback when raw persistence fails with real scoring', async () => {
    await registered(); const b=realBindings('filter');
    const put=vi.fn(async()=>{throw new Error('synthetic_raw_storage_failure');});
    b.e.BUCKET=new Proxy(env.BUCKET,{get(target,key){if(key==='put')return put;const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
    const error=vi.spyOn(console,'error').mockImplementation(()=>{});
    try {
      const row=await deliver(b.e,bytes(BOX,GTUBE_MARKER));
      expect(row).toMatchObject({folder_id:'spam',raw_key:null});
      expect((await mailbox(BOX).getSpamState(row.id))?.assessments[0].result?.heuristicScore).toBe(100);
      const raw=await request(b.e,`/api/imap/v1/${BOX}/messages/${row.uid}/raw?folder=spam`);
      expect(raw.status).toBe(200);
      expect(new TextDecoder().decode(await raw.arrayBuffer())).toContain(GTUBE_MARKER);
      expect(put).toHaveBeenCalledTimes(1); expect(b.scoreV1).toHaveBeenCalledTimes(1);
      expect(error.mock.calls).toEqual([['raw_mime_storage_failed']]);
      expect(b.ai).not.toHaveBeenCalled(); expect(b.send).not.toHaveBeenCalled();
    } finally {error.mockRestore();}
  });
});

describe('bounded plain-text URL projection', () => {
  it('projects literal and encoded URLs with bounded original tokens and quote exclusions', async () => {
    const parsed = await PostalMime.parse(bytes());
    parsed.text = `Receipt (https://例え.test/order). HTTPS://user@example.test/path!\n` +
      `https%3A%2F%2Fuser%40example.test/path\n> https://quoted@other.test/\n` +
      `\u202e> https://hidden@other.test/\n-----Original\u202e Message-----\nhttps://forward@other.test/`;
    const input = project(parsed);
    expect(input.urls).toEqual(['https://例え.test/order', 'HTTPS://user@example.test/path', 'https%3A%2F%2Fuser%40example.test/path']);
    expect(input.sourceComplete).toBe(false);
    parsed.text = `xhttps://embedded@other.test/ https://broken\u202e@other.test/ https://ok.test/`;
    expect(project(parsed).urls).toEqual(['https://ok.test/']);
  });

  it('limits URL count, UTF-8 token bytes and source work before projection', async () => {
    const parsed = await PostalMime.parse(bytes());
    parsed.text = ('https://user@example.test/ ').repeat(101);
    expect(project(parsed).urls).toHaveLength(100);
    expect(project(parsed).sourceComplete).toBe(false);
    parsed.text = `https://example.test/${'界'.repeat(700)} https://ok.test/`;
    expect(project(parsed).urls).toEqual(['https://ok.test/']);
    expect(project(parsed).sourceComplete).toBe(false);
    parsed.text = `${'a'.repeat(32769)} https://user@example.test/`;
    expect(project(parsed)).toMatchObject({text:'', urls:[], sourceComplete:false});
  });

  it('bounds the original URL token before trimming prose punctuation', async () => {
    const parsed = await PostalMime.parse(bytes());
    parsed.headers = [];
    parsed.text = 'https://user@example.test/' + '.'.repeat(3000);
    expect(project(parsed)).toMatchObject({urls:[], sourceComplete:false});
  });
});

describe('joined plain-text URL symbols and capped composites', () => {
  it('projects URL evidence through real MIME/scorer RPC with exact composites and disposition', async () => {
    await registered();
    const b = realBindings('filter');
    for (const [body, headers, reasons, folder] of [
      ['Receipt https://shop.example.test/order.', [], [], 'inbox'],
      ['Newsletter https://news.example.test/', ['List-Id: news.example.test'], [['marketing_headers',0]], 'inbox'],
      ['New contact HTTPS://person@example.test/path.', [], [['link_userinfo',15]], 'inbox'],
      ['https://user@例え.test/', [], [['link_userinfo',15]], 'inbox'],
      ['https://user@[2001:db8::1]', [], [['link_userinfo',15]], 'inbox'],
      ['https://user@[2001:db8::1]/path', [], [['link_userinfo',15]], 'inbox'],
      ['[https://user@[2001:db8::1]]', [], [['link_userinfo',15]], 'inbox'],
      ['(https://user@[2001:db8::1]).', [], [['link_userinfo',15]], 'inbox'],
      ['https%3A%2F%2Fuser%40example.test/', [], [['link_userinfo',15]], 'inbox'],
      ['> https://user@example.test/\nOrdinary reply', [], [], 'inbox'],
      ['-----Original Message-----\nhttps://user@example.test/', [], [], 'inbox'],
      ['https://[broken', [], [], 'inbox'],
      ['verify your password https://person@example.test/', [], [['link_userinfo',15],['sensitive_request_combined',25]], 'inbox'],
      ['verify your password https://person@example.test/', ['Reply-To: reply@other.test'], [['link_userinfo',15],['reply_to_mismatch',10],['sensitive_request_combined',25]], 'spam'],
      ['Security team: verify your password ' + ('https://person@example.test/ ').repeat(20), ['Reply-To: reply@other.test'], [['link_userinfo',15],['reply_to_mismatch',10],['impersonation_combined',10],['sensitive_request_combined',25]], 'spam'],
    ] as const) {
      const raw = bytes(BOX, body, [...headers]);
      const row = await deliver(b.e, raw);
      const assessment = (await mailbox(BOX).getSpamState(row.id))?.assessments[0];
      expect(row.folder_id, body).toBe(folder);
      expect(assessment?.result?.reasons.map(r => [r.id,r.contribution]), body).toEqual(reasons);
      expect(assessment?.result?.heuristicScore, body).toBe(reasons.reduce((total,reason) => total + reason[1], 0));
      expect(assessment?.status).toBe('partial');
      expect(new Uint8Array(await (await env.BUCKET.get(row.raw_key))!.arrayBuffer())).toEqual(raw);
    }
    expect(b.ai).not.toHaveBeenCalled(); expect(b.send).not.toHaveBeenCalled();
  });

  it('retains explicit allow precedence and shadow behavior for combined URL evidence', async () => {
    await registered();
    const body = 'verify your password https://person@example.test/';
    const b = realBindings('shadow');
    expect((await deliver(b.e, bytes(BOX, body, ['Reply-To: reply@other.test']))).folder_id).toBe('inbox');
    await mailbox(BOX).setSenderPreference({sender:'sender@example.test',preference:'allow',expectedRevision:0});
    const filter = realBindings('filter');
    expect((await deliver(filter.e, bytes(BOX, body, ['Reply-To: reply@other.test']))).folder_id).toBe('inbox');
  });
});

const gtubeBody = [
  'This is the GTUBE, the',
  '\tGeneric',
  '\tTest for',
  '\tUnsolicited',
  '\tBulk',
  '\tEmail',
  '',
  'If your spam filter supports it, the GTUBE provides a test by which you',
  'can verify that the filter is installed correctly and is detecting incoming',
  'spam. You can send yourself a test mail containing the following string of',
  'characters (in upper case and with no white spaces and line breaks):',
  '',
  GTUBE_MARKER,
  '',
  'You should send this test mail from an account outside of your network.',
].join('\r\n');

describe('joined local workerd GTUBE integration with separate actual scorer RPC', () => {
  it('routes positive GTUBE to Spam, isolates it from normal views/tools/agent epoch, and rescues via Not spam or ordinary/IMAP move with intact UIDs and assessment', async () => {
    await registered();
    const stub = mailbox(BOX);
    await stub.createEmail('inbox', {...emailData({id:'existing'}), subject:'Same thread', body:'Existing body', thread_id:'shared-thread'}, []);
    await env.BUCKET.put('raw/existing', 'EXISTING_RAW_BYTES');
    const epochBefore = await stub.getQuarantineEpoch();
    const b = realBindings('filter');
    const raw = new TextEncoder().encode([
      'From: Test Sender <sender@example.test>',
      `To: ${BOX}`,
      'Subject: Re: Same thread',
      'In-Reply-To: <shared-thread>',
      'References: <shared-thread>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary=gtube-part',
      '',
      '--gtube-part',
      'Content-Type: text/plain; charset=utf-8',
      '',
      gtubeBody,
      '--gtube-part',
      'Content-Type: text/plain',
      'Content-Disposition: attachment; filename=fixture.txt',
      'Content-Transfer-Encoding: base64',
      '',
      'U1lOVEhFVElD',
      '--gtube-part--',
      '',
    ].join('\r\n'));
    const row = await deliver(b.e, raw);
    expect(row).toMatchObject({folder_id:'spam', uid:1});
    expect(await stub.getQuarantineEpoch()).toBeGreaterThan(epochBefore);
    // Existing mail and bytes remain untouched
    expect((await stub.getEmail('existing'))).toMatchObject({folder_id:'inbox', uid:1, body:'Existing body'});
    expect(await (await env.BUCKET.get('raw/existing'))?.text()).toBe('EXISTING_RAW_BYTES');
    // Raw MIME and attachment metadata/bytes preserved
    expect(new Uint8Array(await (await env.BUCKET.get(row.raw_key))!.arrayBuffer())).toEqual(raw);
    const attachments = await query<{id:string;filename:string;size:number}>(stub, 'SELECT id,filename,size FROM attachments WHERE email_id = ?', row.id);
    expect(attachments).toMatchObject([{filename:'fixture.txt', size:9}]);
    expect((await request(b.e, `${base}/emails/${row.id}/attachments/${attachments[0].id}`)).status).toBe(404);
    const attResp = await request(b.e, `${base}/emails/${row.id}/attachments/${attachments[0].id}?scope=spam`);
    expect(attResp.status).toBe(200);
    expect(await attResp.text()).toBe('SYNTHETIC');
    // Stored assessment from real scorer RPC
    const state = await stub.getSpamState(row.id);
    expect(state).toMatchObject({
      disposition:'unknown',
      revision:0,
      assessments:[{
        version:1,
        policyVersion:'inbox-shadow-1',
        status:'partial',
        inputIncomplete:true,
        result:{
          schemaVersion:'1',
          engineVersion:'0.1.0',
          ruleSetVersion:'rules-2',
          status:'partial',
          heuristicScore:100,
          signals:{spam:'present', phishing:'unknown', marketing:'unknown'},
          reasons:[{id:'gtube', contribution:100, reason:REASONS.gtube}],
        },
      }],
    });
    // Excluded from ordinary lists, search, threads, counts, and draft-reply
    expect(await stub.getEmail(row.id)).toBeNull();
    expect(await stub.countEmails()).toBe(1);
    const normalList = await (await request(b.e, `${base}/emails`)).json() as any[];
    expect(normalList.map(e => e.id)).toEqual(['existing']);
    const threadedInbox = await (await request(b.e, `${base}/emails?folder=inbox&threaded=true`)).json() as any;
    expect(threadedInbox.emails[0]).toMatchObject({id:'existing', thread_count:1});
    expect(JSON.stringify(threadedInbox)).not.toContain(GTUBE_MARKER);
    expect((await request(b.e, `${base}/emails/${row.id}`)).status).toBe(404);
    const normalThread = await (await request(b.e, `${base}/threads/shared-thread`)).json() as any[];
    expect(normalThread.map(e => e.id)).toEqual(['existing']);
    expect(await (await request(b.e, `${base}/search?query=GTUBE`)).json()).toMatchObject({emails:[], totalCount:0});
    expect(await toolGetEmail(b.e, BOX, row.id)).toEqual({error:'Email not found'});
    expect(JSON.stringify(await toolGetThread(b.e, BOX, 'shared-thread'))).not.toContain(GTUBE_MARKER);
    expect(JSON.stringify(await toolListEmails(b.e, BOX, {folder:'inbox', limit:20, page:1}))).not.toContain(GTUBE_MARKER);
    expect(await toolSearchEmails(b.e, BOX, {query:'GTUBE'})).toEqual([]);
    expect(await toolDraftReply(b.e, BOX, {originalEmailId:row.id, to:'sender@example.test', subject:'Re', body:'x', runVerifyDraft:true})).toHaveProperty('error');
    // Visible in explicit Spam review and IMAP
    expect((await request(b.e, `${base}/emails/${row.id}?scope=spam`)).status).toBe(200);
    const spamThread = await (await request(b.e, `${base}/threads/shared-thread?scope=spam`)).json() as any[];
    expect(spamThread.map(e => e.id)).toEqual([row.id]);
    expect(await (await request(b.e, `${base}/search?query=GTUBE&folder=spam`)).json()).toMatchObject({totalCount:1});
    expect(await (await request(b.e, `${base}/emails/${row.id}/spam`)).json()).toMatchObject({
      automaticQuarantine:true,
      disposition:'unknown',
      revision:0,
      assessments:state?.assessments,
    });
    expect(JSON.stringify(await toolGetEmail(b.e, BOX, row.id, 'spam'))).toContain(GTUBE_MARKER);
    expect((await toolSearchEmails(b.e, BOX, {query:'GTUBE', folder:'spam'}) as any[]).length).toBe(1);
    const imapSpam = await request(b.e, `/api/imap/v1/${BOX}/spam/messages`);
    expect(imapSpam.status).toBe(200);
    expect(await imapSpam.json()).toMatchObject({messages:[{uid:1}], uidNext:2});
    // Rescue via Not spam feedback allocates next Inbox UID and keeps original assessment
    expect((await request(b.e, `${base}/spam-feedback`, {emailId:row.id, disposition:'not_spam', expectedRevision:0})).status).toBe(200);
    expect(await stub.getEmail(row.id)).toMatchObject({folder_id:'inbox', uid:2, raw_key:row.raw_key});
    expect((await stub.getSpamState(row.id))).toMatchObject({disposition:'not_spam', revision:1, assessments:state?.assessments});
    // Second positive GTUBE arrival rescued via ordinary IMAP/REST moves without rescoring
    const second = await deliver(b.e, bytes(BOX, gtubeBody));
    expect(second).toMatchObject({folder_id:'spam', uid:2});
    expect((await request(b.e, `/api/imap/v1/${BOX}/spam/move`, {uids:[2], destination:'inbox'})).status).toBe(200);
    expect(await stub.getEmail(second.id)).toMatchObject({folder_id:'inbox', uid:3});
    expect((await stub.getSpamState(second.id))).toMatchObject({disposition:'unknown', revision:0, assessments:[{result:{ruleSetVersion:'rules-2', heuristicScore:100}}]});
    expect((await request(b.e, `${base}/emails/${second.id}/move`, {folderId:'spam'})).status).toBe(200);
    expect((await request(b.e, `${base}/emails/${second.id}/move`, {folderId:'inbox'})).status).toBe(200);
    expect(await stub.getEmail(second.id)).toMatchObject({folder_id:'inbox', uid:4});
    expect(b.scoreV1).toHaveBeenCalledTimes(2);
    expect(b.ai).not.toHaveBeenCalled();
    expect(b.send).not.toHaveBeenCalled();
  });

  it('routes plain-text, base64, quoted-printable, and mixed-quote GTUBE arrivals while keeping HTML-only and oversized/padded inputs in Inbox', async () => {
    await registered();
    const b = realBindings('filter');
    const b64Body = Buffer.from(gtubeBody, 'utf8').toString('base64');
    const qpBody = `Leading text=\r\n\r\n${GTUBE_MARKER.slice(0, 24)}=\r\n${GTUBE_MARKER.slice(24)}\r\n`;
    for (const [label, raw] of [
      ['plain', bytes(BOX, gtubeBody)],
      ['base64', bytes(BOX, b64Body, ['Content-Transfer-Encoding: base64'])],
      ['quoted-printable', bytes(BOX, qpBody, ['Content-Transfer-Encoding: quoted-printable'])],
      ['unquoted-plus-quoted', bytes(BOX, `> Earlier quote\r\n${GTUBE_MARKER}`)],
    ] as const) {
      const row = await deliver(b.e, raw);
      expect(row.folder_id, label).toBe('spam');
      const state = await mailbox(BOX).getSpamState(row.id);
      expect(state?.assessments[0].result, label).toMatchObject({
        ruleSetVersion:'rules-2',
        heuristicScore:100,
        signals:{spam:'present'},
        reasons:[{id:'gtube', contribution:100, reason:REASONS.gtube}],
      });
    }
    const callsAfterPositive = b.scoreV1.mock.calls.length;
    expect(callsAfterPositive).toBe(4);
    // HTML-only GTUBE remains uninspected and stays in Inbox
    const htmlOnly = new TextEncoder().encode([
      'From: sender@example.test',
      `To: ${BOX}`,
      'Subject: HTML only GTUBE',
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      `<p>${GTUBE_MARKER}</p>`,
    ].join('\r\n'));
    const htmlRow = await deliver(b.e, htmlOnly);
    expect(htmlRow.folder_id).toBe('inbox');
    const htmlState = await mailbox(BOX).getSpamState(htmlRow.id);
    expect(htmlState?.assessments[0]).toMatchObject({
      status:'partial',
      inputIncomplete:true,
      result:{ruleSetVersion:'rules-2', heuristicScore:0, reasons:[]},
    });
    // Oversized text field (>32768 bytes) omits text, marks sourceIncomplete, stays in Inbox
    const overFieldRow = await deliver(b.e, bytes(BOX, `${'a'.repeat(32769)}\r\n${GTUBE_MARKER}`));
    expect(overFieldRow.folder_id).toBe('inbox');
    const overFieldState = await mailbox(BOX).getSpamState(overFieldRow.id);
    expect(overFieldState?.assessments[0]).toMatchObject({
      status:'partial',
      inputIncomplete:true,
      result:{ruleSetVersion:'rules-2', heuristicScore:0, reasons:[]},
    });
    expect(overFieldState?.assessments[0].result?.limitsHit).toContain('source_incomplete');
    // Oversized raw (>131072 bytes) and zero-padded raw skip RPC and stay in Inbox
    const callsBeforeRawLimits = b.scoreV1.mock.calls.length;
    for (const [raw, padding] of [
      [bytes(BOX, `${GTUBE_MARKER}\r\n${'x'.repeat(131072)}`), 0],
      [bytes(BOX, gtubeBody), 4],
    ] as const) {
      const row = await deliver(b.e, raw, BOX, padding);
      expect(row.folder_id).toBe('inbox');
      expect((await mailbox(BOX).getSpamState(row.id))?.assessments[0].status).toBe('unavailable');
    }
    expect(b.scoreV1).toHaveBeenCalledTimes(callsBeforeRawLimits);
  });

  it('keeps negative GTUBE, nonspam controls (score 0 and 10), near-matches, quoted/forwarded markers, forged headers, and off/shadow modes in Inbox', async () => {
    await registered();
    const b = realBindings('filter');
    const controls: Array<[string, ReturnType<typeof bytes>, number, string[]]> = [
      ['negative-gtube', bytes(BOX, `${GTUBE_MARKER.slice(0, -1)}Y`), 0, []],
      ['nonspam-0', bytes(BOX, 'Standard nonspam control paragraph without suspicious signals.', ['List-Unsubscribe: <mailto:leave@example.test>']), 0, ['marketing_headers']],
      ['nonspam-10', bytes(BOX, 'Standard nonspam control with separate reply address.', ['Reply-To: list@example.org', 'List-Id: <updates.example.test>']), 10, ['reply_to_mismatch', 'marketing_headers']],
      ['lowercase', bytes(BOX, GTUBE_MARKER.toLowerCase()), 0, []],
      ['internal-space', bytes(BOX, `${GTUBE_MARKER.slice(0, 20)} ${GTUBE_MARKER.slice(20)}`), 0, []],
      ['line-break', bytes(BOX, `${GTUBE_MARKER.slice(0, 20)}\r\n${GTUBE_MARKER.slice(20)}`), 0, []],
      ['quoted-gtube', bytes(BOX, `> ${GTUBE_MARKER}`), 0, []],
      ['forwarded-original', bytes(BOX, `See below:\r\n-----Original Message-----\r\n${GTUBE_MARKER}`), 0, []],
      ['forwarded-divider', bytes(BOX, `See below:\r\n---------- Forwarded message ---------\r\n${GTUBE_MARKER}`), 0, []],
      ['subject-only', bytes(BOX, 'Normal body text', [`Subject: ${GTUBE_MARKER}`]), 0, []],
      ['forged-headers', bytes(BOX, 'Normal body text', [
        'X-Spam-Flag: YES',
        'X-Spam-Status: Yes, score=100.0 required=5.0 tests=GTUBE',
        'Authentication-Results: mx.example.test; spf=fail; dkim=fail; dmarc=fail',
      ]), 0, []],
    ];
    for (const [label, raw, expectedScore, expectedReasons] of controls) {
      const row = await deliver(b.e, raw);
      expect(row.folder_id, label).toBe('inbox');
      const state = await mailbox(BOX).getSpamState(row.id);
      expect(state?.assessments[0].result?.heuristicScore, label).toBe(expectedScore);
      expect(state?.assessments[0].result?.reasons.map(r => r.id), label).toEqual(expectedReasons);
    }
    // off and shadow never move positive GTUBE
    const offB = realBindings('off');
    const offRow = await deliver(offB.e, bytes(BOX, gtubeBody));
    expect(offRow.folder_id).toBe('inbox');
    expect(offB.scoreV1).not.toHaveBeenCalled();
    const shadowB = realBindings('shadow');
    const shadowRow = await deliver(shadowB.e, bytes(BOX, gtubeBody));
    expect(shadowRow.folder_id).toBe('inbox');
    expect(shadowB.scoreV1).toHaveBeenCalledTimes(1);
    expect((await mailbox(BOX).getSpamState(shadowRow.id))?.assessments[0].result).toMatchObject({
      ruleSetVersion:'rules-2',
      heuristicScore:100,
      reasons:[{id:'gtube', contribution:100, reason:REASONS.gtube}],
    });
  });

  it('preserves explicit sender allow/block precedence on GTUBE and keeps ordinary quarantine partial-inspection guards intact', async () => {
    await registered();
    const stub = mailbox(BOX);
    const b = realBindings('filter');
    // Allow preference overrides automatic quarantine for GTUBE while retaining score 100 and both reasons
    await stub.setSenderPreference({sender:'sender@example.test', preference:'allow', expectedRevision:0});
    const allowedGtube = await deliver(b.e, bytes(BOX, gtubeBody));
    expect(allowedGtube.folder_id).toBe('inbox');
    expect((await stub.getSpamState(allowedGtube.id))?.assessments[0].result).toMatchObject({
      ruleSetVersion:'rules-2',
      heuristicScore:100,
      signals:{spam:'present'},
      reasons:[
        {id:'sender_allowed', contribution:0, reason:REASONS.sender_allowed},
        {id:'gtube', contribution:100, reason:REASONS.gtube},
      ],
    });
    // Block preference routes ordinary mail and caps combined GTUBE + sender_blocked at 100
    await stub.setSenderPreference({sender:'sender@example.test', preference:'block', expectedRevision:1});
    const blockedOrdinary = await deliver(b.e, bytes(BOX, 'Ordinary message from blocked sender'));
    expect(blockedOrdinary.folder_id).toBe('spam');
    expect((await stub.getSpamState(blockedOrdinary.id))?.assessments[0].result).toMatchObject({
      heuristicScore:40,
      reasons:[{id:'sender_blocked', contribution:40, reason:REASONS.sender_blocked}],
    });
    const blockedGtube = await deliver(b.e, bytes(BOX, gtubeBody));
    expect(blockedGtube.folder_id).toBe('spam');
    expect((await stub.getSpamState(blockedGtube.id))?.assessments[0].result).toMatchObject({
      heuristicScore:100,
      reasons:[
        {id:'sender_blocked', contribution:40, reason:REASONS.sender_blocked},
        {id:'gtube', contribution:60, reason:REASONS.gtube},
      ],
    });
    // Clear preference and verify ordinary threshold vs partial-inspection guard with real scorer
    await stub.setSenderPreference({sender:'sender@example.test', preference:'none', expectedRevision:2});
    const deceptiveRaw = new TextEncoder().encode([
      'From: Security Team <sender@example.test>',
      'Reply-To: attacker@other.example.org',
      `To: ${BOX}`,
      'Subject: Account notice',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Security team alert: please verify your password immediately.',
    ].join('\r\n'));
    const deceptiveRow = await deliver(b.e, deceptiveRaw);
    expect(deceptiveRow.folder_id).toBe('spam');
    expect((await stub.getSpamState(deceptiveRow.id))?.assessments[0].result?.heuristicScore).toBe(45);
    // Adding quoted content to ordinary deceptive mail hits quoted_content limit and keeps it in Inbox
    const deceptiveWithQuote = new TextEncoder().encode([
      'From: Security Team <sender@example.test>',
      'Reply-To: attacker@other.example.org',
      `To: ${BOX}`,
      'Subject: Account notice',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Security team alert: please verify your password immediately.',
      '> prior quoted line',
    ].join('\r\n'));
    const quotedDeceptiveRow = await deliver(b.e, deceptiveWithQuote);
    expect(quotedDeceptiveRow.folder_id).toBe('inbox');
    const quotedDeceptiveState = await stub.getSpamState(quotedDeceptiveRow.id);
    expect(quotedDeceptiveState?.assessments[0].result?.heuristicScore).toBe(45);
    expect(quotedDeceptiveState?.assessments[0].result?.limitsHit).toContain('quoted_content');
  });

  it('supports caller-first mixed-version rollout and rollback between rules-1 and rules-2 while preserving stored assessment readability', async () => {
    await registered();
    const stub = mailbox(BOX);
    // Step 1: Caller updated first, connected to deployed legacy rules-1 scorer
    const legacyB = realBindings('filter', env.MAIL_SCORER_LEGACY);
    const legacyGtube = await deliver(legacyB.e, bytes(BOX, gtubeBody));
    expect(legacyGtube.folder_id).toBe('inbox');
    const legacyState = await stub.getSpamState(legacyGtube.id);
    expect(legacyState?.assessments[0].result).toMatchObject({
      ruleSetVersion:'rules-1',
      heuristicScore:0,
      reasons:[],
    });
    const deceptiveRaw = new TextEncoder().encode([
      'From: Security Team <sender@example.test>',
      'Reply-To: attacker@other.example.org',
      `To: ${BOX}`,
      'Subject: Account notice',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Security team alert: please verify your password immediately.',
    ].join('\r\n'));
    const legacyDeceptive = await deliver(legacyB.e, deceptiveRaw);
    expect(legacyDeceptive.folder_id).toBe('spam');
    expect((await stub.getSpamState(legacyDeceptive.id))?.assessments[0].result?.ruleSetVersion).toBe('rules-1');
    // Step 2: Scorer upgraded to rules-2
    const currentB = realBindings('filter', env.MAIL_SCORER);
    const currentGtube = await deliver(currentB.e, bytes(BOX, gtubeBody));
    expect(currentGtube.folder_id).toBe('spam');
    expect((await stub.getSpamState(currentGtube.id))?.assessments[0].result).toMatchObject({
      ruleSetVersion:'rules-2',
      heuristicScore:100,
      reasons:[{id:'gtube', contribution:100, reason:REASONS.gtube}],
    });
    // Both old rules-1 and new rules-2 stored assessments remain readable across DO restart and REST
    const restarted = await restart(BOX);
    expect((await restarted.getSpamState(legacyGtube.id))?.assessments[0].result?.ruleSetVersion).toBe('rules-1');
    expect((await restarted.getSpamState(currentGtube.id))?.assessments[0].result?.ruleSetVersion).toBe('rules-2');
    expect((await request(currentB.e, `${base}/emails/${legacyGtube.id}/spam`)).status).toBe(200);
    expect((await request(currentB.e, `${base}/emails/${currentGtube.id}/spam`)).status).toBe(200);
    // Step 3: Scorer rollback to rules-1 keeps new caller operating and preserves rules-2 readability
    const rollbackRow = await deliver(legacyB.e, bytes(BOX, 'Post-rollback arrival'));
    expect(rollbackRow.folder_id).toBe('inbox');
    expect((await stub.getSpamState(rollbackRow.id))?.assessments[0].result?.ruleSetVersion).toBe('rules-1');
    expect((await stub.getSpamState(currentGtube.id))?.assessments[0].result?.ruleSetVersion).toBe('rules-2');
  });
});
