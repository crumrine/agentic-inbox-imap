// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const out=process.env.EVIDENCE_DIR || 'docs/evidence/dev-879';
await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
const hostile=`<script>window.previewExecuted=1</script><img src="https://tracker.invalid/pixel" onerror="window.previewExecuted=2"><img srcset="https://tracker.invalid/2x 2x"><style>@import 'https://tracker.invalid/css';body{background:url(https://tracker.invalid/bg)}</style><svg onload="window.previewExecuted=3"></svg><iframe src="https://tracker.invalid/frame"></iframe><form action="https://tracker.invalid/form"><input autofocus></form><meta http-equiv="refresh" content="0;url=https://tracker.invalid/refresh"><a href="https://tracker.invalid/link">click</a>`;
const results=[];
const oversizedBody=hostile+'x'.repeat(20000);
try {
 for(const width of [1440,390]) {
  const page=await browser.newPage({viewport:{width,height:1000}});page.setDefaultTimeout(60000);page.setDefaultNavigationTimeout(120000);const network=[],errors=[],actions=[];
  const rows=[{id:'evil',subject:'Synthetic suspicious message',sender:'sender@example.test',recipient:'ui@example.test',folder_id:'spam',date:'2026-10-21T10:00:00Z',read:true,body:oversizedBody,thread_id:'shared',snippet:hostile,attachments:[{id:'image',filename:'track.png',mimetype:'image/png',size:10}]},{id:'trusted',subject:'Trusted conversation',sender:'friend@example.test',recipient:'ui@example.test',folder_id:'inbox',date:'2026-10-21T09:00:00Z',read:true,body:'<p>Normal</p>',thread_id:'shared',snippet:'Normal',attachments:[]}];
  let revision=0,disposition='unknown',pref='none',prefRevision=0;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(url.origin!=='http://127.0.0.1:5189'){network.push(req.url());return route.abort();}
   if(!url.pathname.startsWith('/api/')) return route.continue();
   const path=url.pathname.split('/').slice(5).join('/');let data;
   if(req.method()==='POST'||req.method()==='PUT'){
    const body=req.postDataJSON();actions.push({path,body,headers:req.headers()});
    if(path==='spam-feedback'){assert.equal(req.headers()['x-inbox-manual-action'],'1');assert.equal(body.expectedRevision,revision);disposition=body.disposition;revision++;rows[0].folder_id=disposition==='spam'?'spam':'inbox';}
    if(path==='sender-preference'){assert.equal(req.headers()['x-inbox-manual-action'],'1');assert.equal(body.expectedRevision,prefRevision);pref=body.preference;prefRevision++;}
    if(path==='emails/evil/move') rows[0].folder_id=body.folderId;
    if(path==='emails/evil') rows[0].read=body.read;
    data={ok:true,revision};
   }else if(path==='folders') data=['inbox','sent','draft','archive','trash','spam'].map(id=>({id,name:id,is_deletable:false,unreadCount:0}));
   else if(path==='emails') {const folder=url.searchParams.get('folder');data={emails:rows.filter(e=>e.folder_id===folder),totalCount:rows.filter(e=>e.folder_id===folder).length};}
   else if(path==='emails/evil/spam') data={revision,disposition,assessments:[{status:'partial',result:{heuristicScore:42,reasons:[{reason:hostile}]}}]};
   else if(path==='emails/trusted/spam') data={revision:0,disposition:'unknown',assessments:[]};
   else if(path==='sender-preference') data={preference:pref,revision:prefRevision};
   else if(path.startsWith('threads/')) data=rows.filter(e=>(e.folder_id==='spam')===(url.searchParams.get('scope')==='spam'));
   else if(path.startsWith('emails/')) {const row=rows.find(e=>e.id===path.split('/')[1]);if(!row || (row.folder_id==='spam')!==(url.searchParams.get('scope')==='spam'))return route.fulfill({status:404,json:{error:'Not found'}});data=row;}
   else if(url.pathname==='/api/v1/config')data={domains:['example.test'],emailAddresses:[]};
   else data={id:'ui@example.test',email:'ui@example.test',name:'Synthetic mailbox',settings:{}};
   return route.fulfill({json:data});
  });
  await page.goto('http://127.0.0.1:5189',{waitUntil:'domcontentloaded'});
  await page.getByText('Synthetic suspicious message',{exact:true}).click();
  await page.getByRole('region',{name:'Safe Spam preview'}).waitFor();
  assert.equal(await page.locator('iframe').count(),0);
  assert.equal((await page.locator('section[aria-label="Safe Spam preview"] pre').textContent()).length,16384);
  assert.equal((await page.locator('section[aria-label="Spam controls"] li').textContent()).length,160);
  assert.equal(await page.locator('section[aria-label="Safe Spam preview"] img,section[aria-label="Safe Spam preview"] a,section[aria-label="Safe Spam preview"] style,section[aria-label="Safe Spam preview"] script').count(),0);
  assert.equal(await page.evaluate(()=>window.previewExecuted),undefined);
  assert.ok(await page.getByRole('region',{name:'Spam controls'}).textContent().then(t=>t.includes('<script>')));
  await page.screenshot({path:`${out}/spam-${width}.png`,fullPage:true});
  await page.getByRole('button',{name:'Always block sender',exact:true}).click();
  await page.getByText('Sender preference: block.',{exact:false}).waitFor();
  await page.getByRole('button',{name:'Always allow sender',exact:true}).click();
  await page.getByText('Sender preference: allow.',{exact:false}).waitFor();
  await page.getByRole('button',{name:'Clear sender preference',exact:true}).click();
  await page.getByText('Sender preference: none.',{exact:false}).waitFor();
  await page.getByRole('button',{name:'Mark unread',exact:true}).click();
  await page.getByRole('button',{name:'Mark read',exact:true}).waitFor();
  await page.getByRole('button',{name:'Not spam — move to Inbox',exact:true}).click();
  await page.getByText('No spam',{exact:true}).waitFor();
  assert.equal(disposition,'not_spam');assert.equal(pref,'none');
  assert.equal(network.length,0,JSON.stringify(network));assert.deepEqual(errors,[]);
  results.push({width,blockedExternalRequests:network.length,errors,actions:actions.map(({path,body})=>({path,body})),escapedReason:true,inertPreview:true,inputBodyCharacters:oversizedBody.length,renderedBodyCharacters:16384,renderedReasonCharacters:160});
  await page.close();
 }
 await fs.writeFile(`${out}/browser.json`,JSON.stringify({browser:browser.version(),results},null,2)+'\n');
} finally {await browser.close();}
