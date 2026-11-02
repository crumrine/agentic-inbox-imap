// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
import {describe,it,expect,vi,afterEach} from 'vitest';
import {inspectHtml,HTML_LIMITS} from '../workers/lib/mail-scoring/html';
import {assessArrival,shouldQuarantine} from '../workers/lib/mail-scoring/intake';
import {REASONS,type ScoreResultV1} from '../workers/lib/mail-scoring/contract';
import type {Env} from '../workers/types';
import PostalMime from 'postal-mime';

const synthetic='<h1>Account notice</h1><p>Security team: inspect a negative review.</p><a href="https://tracker.example/route?fallback=https%3A%2F%2Fdestination.invalid%2F">Respond now</a>';
const result:ScoreResultV1={schemaVersion:'1',engineVersion:'0.1.0',ruleSetVersion:'rules-2',status:'partial',heuristicScore:45,
  reasons:[{id:'brand_impersonation_combined',contribution:45,reason:REASONS.brand_impersonation_combined}],
  signals:{spam:'present',phishing:'present',marketing:'unknown'},limitsHit:['auth_unknown','source_incomplete'],error:null};
afterEach(()=>vi.unstubAllGlobals());
describe('bounded native HTML inspection in real workerd',()=>{
  it('extracts inert text, inline fragments, entity text and HTTP action anchors without executing or fetching',async()=>{
    const fetch=vi.fn(()=>{throw new Error('Network forbidden');});vi.stubGlobal('fetch',fetch);
    const html='<script>throw new Error("execute forbidden")</script><style>@import "https://never-fetch.invalid";</style><img src="https://never-fetch.invalid/pixel" onerror="throw 1"><p>secur&#105;ty <b>team</b> &amp; notice</p><a href="https://other.invalid/?x=1&amp;y=2">https://good.test/</a>';
    const output=await inspectHtml(html);
    expect(output).not.toBeNull();
    expect(output!.text).toContain('security team & notice');
    expect(output!.text).not.toMatch(/execute forbidden|@import|throw 1/);
    expect(output!.anchors).toEqual([{text:'https://good.test/',href:'https://other.invalid/?x=1&y=2'}]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('omits active, quoted and explicitly hidden text and links; ignores base, meta refresh and non-HTTP links',async()=>{
    const output=await inspectHtml('<base href="https://never-fetch.invalid"><meta http-equiv="refresh" content="0;url=https://never-fetch.invalid"><blockquote>'+synthetic+'</blockquote><div hidden>'+synthetic+'</div><div class="gmail_quote">'+synthetic+'</div><svg><a href="https://never-fetch.invalid">hidden</a></svg><a href="javascript:alert(1)">safe text</a><a href="/relative">relative</a><p>Visible</p>');
    expect(output?.anchors).toEqual([]);expect(output?.text).not.toContain('Security team');expect(output?.text).toContain('Visible');
  });
  it.each([
    ['source','x'.repeat(HTML_LIMITS.sourceBytes+1)],
    ['UTF-8 source','界'.repeat(22000)],
    ['depth','<div>'.repeat(33)+'x'+'</div>'.repeat(33)],
    ['tags','<br>'.repeat(1025)],
    ['text','x'.repeat(HTML_LIMITS.textBytes+1)],
    ['anchor count','<a href="https://other.invalid">x</a>'.repeat(51)],
    ['attribute','<a href="https://other.invalid/'+'x'.repeat(2048)+'">x</a>'],
    ['anchor text','<a href="https://other.invalid">'+'x'.repeat(2049)+'</a>'],
    ['link bytes',('<a href="https://other.invalid/'+'x'.repeat(1800)+'">x</a>').repeat(10)],
  ])('discards all derived features at the %s limit',async(_name,html)=>{
    expect(await inspectHtml(html)).toBeNull();
  });
  it('accepts exact source, nesting, tag, text and anchor ceilings before rejecting the next item',async()=>{
    const exact='<script>'+'x'.repeat(HTML_LIMITS.sourceBytes-17)+'</script>';
    expect(new TextEncoder().encode(exact).length).toBe(HTML_LIMITS.sourceBytes);
    expect(await inspectHtml(exact)).toEqual({text:'',anchors:[]});
    expect(await inspectHtml(exact+'x')).toBeNull();
    for(const html of ['<div>'.repeat(32)+'x'+'</div>'.repeat(32),'<br>'.repeat(1024),'x'.repeat(16384),'<a href="https://other.invalid">x</a>'.repeat(50)])expect(await inspectHtml(html)).not.toBeNull();
    const prefix='//other.invalid/';const href=prefix+'x'.repeat(2048-6-prefix.length);
    expect((await inspectHtml(`<a href="${href}">x</a>`))?.anchors[0].href).toHaveLength(2048);
    expect(await inspectHtml(`<a href="${href}x">x</a>`)).toBeNull();
  });
  it('bounds malformed tags, unclosed active content, entity runs and multibyte text without throwing',async()=>{
    for(const html of ['<'.repeat(65536),'<a href="'+'x'.repeat(60000),'<script>'+synthetic,'<div><p>x</div></p>','&#x110000;'.repeat(1000),'😀'.repeat(4096)]) {
      const out=await inspectHtml(html);
      if(out)expect(new TextEncoder().encode(out.text).length).toBeLessThanOrEqual(HTML_LIMITS.textBytes);
    }
  });
  it('projects HTML-only mail into existing scorer fields, and quarantines the combined rule with recovery policy',async()=>{
    const parsed=await PostalMime.parse('From: QuickBooks <notice@sender.invalid>\r\nTo: receiver@example.test\r\nSubject: Synthetic notice\r\nContent-Type: text/html; charset=utf-8\r\n\r\n'+synthetic);
    const scoreV1=vi.fn(async(_version:string,_input:Uint8Array)=>JSON.stringify({rpcVersion:'1',ok:true,result}));
    const assessment=await assessArrival({MAIL_SCORING_MODE:'filter',MAIL_SCORER:{scoreV1}} as unknown as Env,parsed,true,undefined,'none');
    expect(assessment?.status).toBe('partial');expect(shouldQuarantine(assessment,'none')).toBe(true);expect(shouldQuarantine(assessment,'allow')).toBe(false);
    const input=JSON.parse(new TextDecoder().decode(scoreV1.mock.calls[0][1]));
    expect(input.extractedText).toContain('negative review');expect(input.anchors).toHaveLength(1);expect(input).not.toHaveProperty('html');
    for(const limit of ['quoted_content','url_uninspected','field_bytes'] as const)expect(shouldQuarantine({...assessment!,result:{...result,limitsHit:[...result.limitsHit,limit]}},'none')).toBe(false);
  });
  it('preserves delivery and skips the scorer on parser limit, failure, and off mode',async()=>{
    const parsed=await PostalMime.parse('From: sender@example.test\r\nContent-Type: text/html\r\n\r\n'+'<div>'.repeat(33));
    const scoreV1=vi.fn();const e={MAIL_SCORING_MODE:'filter',MAIL_SCORER:{scoreV1}} as unknown as Env;
    const limited=await assessArrival(e,parsed,true,undefined,'none');
    expect(limited?.status).toBe('unavailable');expect(shouldQuarantine(limited,'none')).toBe(false);expect(scoreV1).not.toHaveBeenCalled();
    vi.stubGlobal('HTMLRewriter',class {constructor(){throw new Error('Synthetic private parser failure');}});
    parsed.html=synthetic;expect((await assessArrival(e,parsed,true,undefined,'none'))?.status).toBe('unavailable');
    expect(await assessArrival({...e,MAIL_SCORING_MODE:'off'},parsed,true)).toBeUndefined();expect(scoreV1).not.toHaveBeenCalled();
  });
});
