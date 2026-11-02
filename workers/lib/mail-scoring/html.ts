// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
export const HTML_LIMITS = Object.freeze({sourceBytes:65536,tags:1024,depth:32,textBytes:16384,anchors:50,linkBytes:16384,fieldBytes:2048});
type Anchor = {text:string;href:string};
type Inspection = {text:string;anchors:Anchor[]};
const encoder = new TextEncoder();
const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
const OMIT = new Set(['head','script','style','template','noscript','iframe','object','svg','math','blockquote']);
const BREAK = new Set(['p','div','br','li','tr','td','h1','h2','h3','h4','section','hr']);
class InspectionLimit extends Error {constructor(){super('html_inspection_limit');}}
const requireBound = (ok:boolean) => {if(!ok)throw new InspectionLimit();};
// Fixed-length numeric/common entities only; no recursive decoding or unbounded pattern.
function decodeText(text:string):string {
  const named:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',Tab:'\t',NewLine:'\n'};
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos|nbsp|Tab|NewLine);/g,(_match,key:string)=>{
    if(key[0]!=='#')return named[key];
    const point=key[1]==='x'?Number.parseInt(key.slice(2),16):Number.parseInt(key.slice(1),10);
    return point>0 && point<=0x10ffff && !(point>=0xd800 && point<=0xdfff)?String.fromCodePoint(point):'\ufffd';
  });
}

/** Native non-rendering, non-network parsing. Any exceeded bound discards all derived features. */
export async function inspectHtml(html:string):Promise<Inspection|null> {
  if(html.length>HTML_LIMITS.sourceBytes || encoder.encode(html).byteLength>HTML_LIMITS.sourceBytes)return null;
  let tags=0,depth=0,omitted=0,textBytes=0,linkBytes=0;
  const text:string[]=[];
  const anchors:Anchor[]=[];
  let active:Anchor|null=null;
  let anchorBytes=0;
  const append=(value:string)=>{
    if(omitted)return;
    const bytes=encoder.encode(value).byteLength;
    requireBound(textBytes+bytes<=HTML_LIMITS.textBytes);textBytes+=bytes;text.push(value);
    if(active){requireBound(anchorBytes+bytes<=HTML_LIMITS.fieldBytes);anchorBytes+=bytes;active.text+=value;}
  };
  try {
    const transformed=new HTMLRewriter().on('*',{
      element(element){
        requireBound(++tags<=HTML_LIMITS.tags);
        const tag=element.tagName;
        const paired=!VOID.has(tag);
        if(paired)requireBound(++depth<=HTML_LIMITS.depth);
        const skip=OMIT.has(tag) || element.hasAttribute('hidden') || element.getAttribute('aria-hidden')==='true' ||
          /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(element.getAttribute('style')??'') ||
          /(?:^|\s)(?:gmail_quote|yahoo_quoted)(?:\s|$)/.test(element.getAttribute('class')??'');
        if(BREAK.has(tag))append('\n');
        if(skip)omitted++;
        let anchor:Anchor|null=null;
        if(tag==='a' && !omitted){
          const rawHref=element.getAttribute('href');
          const href=rawHref===null?null:decodeText(rawHref);
          if(href && /^(?:https?:)?\/\//i.test(href.trim())){
            requireBound(anchors.length<HTML_LIMITS.anchors);
            requireBound(href.length<=HTML_LIMITS.fieldBytes && encoder.encode(href).byteLength<=HTML_LIMITS.fieldBytes);
            linkBytes+=encoder.encode(href).byteLength;requireBound(linkBytes<=HTML_LIMITS.linkBytes);
            anchor={text:'',href:href.trim().startsWith('//')?'https:'+href.trim():href.trim()};anchors.push(anchor);active=anchor;anchorBytes=0;
          }
        }
        if(paired)element.onEndTag(()=>{
          if(active===anchor)active=null;
          if(skip)omitted--;
          depth--;
          if(BREAK.has(tag))append('\n');
        });
        else if(skip)omitted--;
      },
    }).onDocument({text(chunk){append(chunk.text);}}).transform(new Response(html));
    // Native consumption propagates callback failure and cancels parsing; output is at most sourceBytes.
    await transformed.arrayBuffer();
    return {text:decodeText(text.join('')),anchors:anchors.map(a=>({href:a.href,text:decodeText(a.text)}))};
  } catch {return null;}
}
