// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
import {LIMITS, LIMIT_IDS, REASONS, RULE_CAPS, type ScoreResultV1} from './contract';
export type {ScoreInputV1, ScoreResultV1, ScoreContext} from './contract';
export const RPC_VERSION = '1';
export const RPC_OUTPUT_BYTES = 4096;
export const CONTEXT_BYTES = 256;
export const RPC_ERRORS = ['unsupported_version','invalid_input','invalid_json','request_limit','internal_failure'] as const;
export type RpcError = typeof RPC_ERRORS[number];
export type RpcResponseV1 = {rpcVersion:'1'; ok:true; result:ScoreResultV1} | {rpcVersion:'1'; ok:false; error:RpcError};
/** Wire arguments are checked at runtime; strings/bytes avoid traversing arbitrary objects. */
export interface ScorerBinding {scoreV1(version: string, input: Uint8Array, context?: string): Promise<string>}
export function failure(error:RpcError):string {return JSON.stringify({rpcVersion:RPC_VERSION,ok:false,error});}
const keys=(v:unknown, names:readonly string[]):v is Record<string,unknown> =>
  v!==null && typeof v==='object' && !Array.isArray(v) && Object.keys(v).length===names.length && Object.keys(v).every(k=>names.includes(k));
/** Only called on bounded JSON.parse output, never RPC objects with accessors. */
function resultValid(r:unknown):r is ScoreResultV1 {
  if(!keys(r,['schemaVersion','engineVersion','ruleSetVersion','status','heuristicScore','signals','reasons','limitsHit','error']))return false;
  if(r.schemaVersion!=='1'||r.engineVersion!=='0.1.0'||r.ruleSetVersion!=='rules-1')return false;
  if(!['complete','partial','unavailable'].includes(r.status as string)||typeof r.heuristicScore!=='number'||!Number.isFinite(r.heuristicScore)||r.heuristicScore<0||r.heuristicScore>100)return false;
  if(!keys(r.signals,['spam','phishing','marketing'])||!Object.values(r.signals).every(v=>v==='present'||v==='unknown'))return false;
  if(!Array.isArray(r.reasons)||r.reasons.length>Object.keys(REASONS).length||!Array.isArray(r.limitsHit)||r.limitsHit.length>LIMIT_IDS.length)return false;
  const seen=new Set<string>();let sum=0;
  for(const v of r.reasons) {
    if(!keys(v,['id','contribution','reason'])||typeof v.id!=='string'||!Object.hasOwn(REASONS,v.id)||seen.has(v.id))return false;
    const id=v.id as keyof typeof REASONS;
    if(v.reason!==REASONS[id]||typeof v.contribution!=='number'||!Number.isFinite(v.contribution)||v.contribution<0||v.contribution>RULE_CAPS[id])return false;
    seen.add(id);sum+=v.contribution;
  }
  if(sum!==r.heuristicScore||!r.limitsHit.every(v=>LIMIT_IDS.includes(v))||new Set(r.limitsHit).size!==r.limitsHit.length)return false;
  if(r.status==='unavailable')return ['invalid_input','request_limit','invalid_json'].includes(r.error as string)&&sum===0&&r.reasons.length===0&&r.limitsHit.length===0&&Object.values(r.signals).every(v=>v==='unknown');
  return r.error===null && (r.status==='partial'?r.limitsHit.length>0:r.limitsHit.length===0);
}
export function decodeResponse(wire:unknown):RpcResponseV1|null {
  if(typeof wire!=='string'||wire.length>RPC_OUTPUT_BYTES)return null;
  if(new TextEncoder().encode(wire).byteLength>RPC_OUTPUT_BYTES)return null;
  // Bound depth before parsing even a compromised service response.
  let depth=0,quoted=false,escaped=false;
  for(const c of wire){if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}if(c==='"')quoted=true;if(c==='{'||c==='[')if(++depth>6)return null;if(c==='}'||c===']')depth--;}
  try {
    const r:unknown=JSON.parse(wire);
    if(keys(r,['rpcVersion','ok','error'])&&r.rpcVersion==='1'&&r.ok===false&&RPC_ERRORS.includes(r.error as RpcError))return r as RpcResponseV1;
    if(keys(r,['rpcVersion','ok','result'])&&r.rpcVersion==='1'&&r.ok===true&&resultValid(r.result))return r as RpcResponseV1;
  }catch{/* Static failure only. */}
  return null;
}
/** Caller must construct bounded fields before serialization; never stringify arbitrary mail objects. */
export function encodeBoundedJson(json:unknown):Uint8Array|null {
  if(typeof json!=='string'||json.length>LIMITS.requestBytes)return null;
  const bytes=new TextEncoder().encode(json);
  return bytes.byteLength<=LIMITS.requestBytes?bytes:null;
}
