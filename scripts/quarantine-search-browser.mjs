// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const out=process.env.EVIDENCE_DIR || 'docs/evidence/dev-879-fixes';
await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
const hostile=`<script>window.previewExecuted=1</script><img src="https://tracker.invalid/pixel" onerror="window.previewExecuted=2"><img srcset="https://tracker.invalid/2x 2x"><style>@import 'https://tracker.invalid/css';body{background:url(https://tracker.invalid/bg)}</style><svg onload="window.previewExecuted=3"></svg><iframe src="https://tracker.invalid/frame"></iframe><form action="https://tracker.invalid/form"><input autofocus></form><meta http-equiv="refresh" content="0;url=https://tracker.invalid/refresh"><a href="https://tracker.invalid/link">click</a>`;
const results=[];
const oversizedBody=hostile+'x'.repeat(20000);
try {
 for(const width of (process.env.BROWSER_WIDTHS || '1440,390').split(',').map(Number)) {
  const page=await browser.newPage({viewport:{width,height:1000}});page.setDefaultTimeout(60000);page.setDefaultNavigationTimeout(120000);const network=[],errors=[],actions=[];
  const rows=[{id:'evil',subject:'Synthetic suspicious message',sender:'sender@example.test',recipient:'ui@example.test',folder_id:'spam',date:'2026-10-21T10:00:00Z',read:true,body:oversizedBody,thread_id:'shared',snippet:hostile,attachments:[{id:'image',filename:'track.png',mimetype:'image/png',size:10}]},{id:'trusted',subject:'Trusted conversation',sender:'friend@example.test',recipient:'ui@example.test',folder_id:'inbox',date:'2026-10-21T09:00:00Z',read:true,body:'<p>Normal</p>',thread_id:'shared',snippet:'Normal',attachments:[]}];
  let revision=0,disposition='unknown',pref='none',prefRevision=0, searchCalls=0, failSearch=false;
  const searchPages=[], threadRequests=[];
  rows[0].thread_id='x'.repeat(512)+'/h?&é'.repeat(22);
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
   }else if(path==='search') {
    searchCalls++;searchPages.push(Number(url.searchParams.get('page')));
    if(failSearch) return route.fulfill({status:503,json:{error:'Synthetic unavailable'}});
    const spam=url.searchParams.get('folder')==='spam';
    const matches=rows.filter(e=>(e.folder_id==='spam')===spam);
    data={emails:matches.slice((Number(url.searchParams.get('page'))-1)*25,Number(url.searchParams.get('page'))*25),totalCount:matches.length};
   }
   else if(path==='folders') data=['inbox','sent','draft','archive','trash','spam'].map(id=>({id,name:id,is_deletable:false,unreadCount:0}));
   else if(path==='emails') {const folder=url.searchParams.get('folder');data={emails:rows.filter(e=>e.folder_id===folder),totalCount:rows.filter(e=>e.folder_id===folder).length};}
   else if(path==='emails/evil/spam') data={revision,disposition,assessments:[{status:'partial',result:{heuristicScore:42,reasons:[{reason:hostile}]}}]};
   else if(path==='emails/trusted/spam') data={revision:0,disposition:'unknown',assessments:[]};
   else if(path==='sender-preference') data={preference:pref,revision:prefRevision};
   else if(path.startsWith('threads/')) {
    const threadId=decodeURIComponent(path.slice('threads/'.length));threadRequests.push(threadId);
    data=rows.filter(e=>e.thread_id===threadId && (e.folder_id==='spam')===(url.searchParams.get('scope')==='spam'));
   }
   else if(path.startsWith('emails/')) {const row=rows.find(e=>e.id===path.split('/')[1]);if(!row || (row.folder_id==='spam')!==(url.searchParams.get('scope')==='spam'))return route.fulfill({status:404,json:{error:'Not found'}});data=row;}
   else if(url.pathname==='/api/v1/config')data={domains:['example.test'],emailAddresses:[]};
   else data={id:'ui@example.test',email:'ui@example.test',name:'Synthetic mailbox',settings:{}};
   return route.fulfill({json:data});
  });
  await page.goto('http://127.0.0.1:5189',{waitUntil:'domcontentloaded'});
  const threadResponse=page.waitForResponse(r=>new URL(r.url()).pathname.includes('/threads/'));
  await page.getByText('Synthetic suspicious message',{exact:true}).click();
  await page.getByRole('region',{name:'Safe Spam preview'}).waitFor();
  await threadResponse;
  assert.equal(threadRequests[0],rows[0].thread_id,'API client must encode lossless thread path');
  await page.getByRole('button',{name:'Back to Spam',exact:true}).click();
  async function search(q) {
    const input=page.getByPlaceholder('Search emails...', {exact:false});
    if(!await input.isVisible()) await page.getByRole('button',{name:'Search',exact:true}).click();
    await input.fill(q);await input.press('Enter');
  }
  await search('Trusted');
  await page.getByText('Trusted conversation',{exact:true}).waitFor();
  // Real browser timers: no product interval override or forced cache mutation.
  const before=searchCalls;
  rows[1].folder_id='spam';
  await page.waitForTimeout(35000);
  assert.equal(await page.getByText('Trusted conversation',{exact:true}).count(),0,
    'Normal search must remove alternate-client quarantine within the refresh window');
  assert.ok(searchCalls>before);
  await page.getByText('0 results for "Trusted"',{exact:true}).waitFor();
  // Explicit Spam search can still review the same row, with inert snippets.
  await search('in:spam Trusted');
  await page.getByText('Trusted conversation',{exact:true}).waitFor();
  rows[1].folder_id='inbox';
  await page.waitForTimeout(35000);
  assert.equal(await page.getByText('Trusted conversation',{exact:true}).count(),0);
  await search('Trusted');
  await page.getByText('Trusted conversation',{exact:true}).waitFor();
  // A failed refresh must hide old rows/counts rather than claim current results.
  failSearch=true;
  await page.getByText('Search unavailable. Retry to refresh results.',{exact:true}).waitFor({timeout:40000});
  assert.equal(await page.getByText('Trusted conversation',{exact:true}).count(),0);
  assert.equal(await page.getByText('1 result for "Trusted"',{exact:true}).count(),0);
  failSearch=false;rows[1].folder_id='spam';
  await page.getByRole('button',{name:'Retry search',exact:true}).click();
  await page.getByText('0 results for "Trusted"',{exact:true}).waitFor();
  // Count shrink on a later page must select a valid page and refresh it.
  for(let i=0;i<26;i++)rows.push({...rows[1],id:`page-${i}`,folder_id:'inbox',subject:`Paged result ${i}`});
  await search('Paged');
  await page.getByText('26 results for "Paged"',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Next page',exact:true}).click();
  await page.getByText('Paged result 25',{exact:true}).waitFor();
  for(const row of rows)if(row.id.startsWith('page-') && row.id!=='page-0')row.folder_id='spam';
  await page.getByText('Paged result 0',{exact:true}).waitFor({timeout:40000});
  await page.getByText('1 result for "Paged"',{exact:true}).waitFor();
  assert.equal(await page.getByText('Paged result 25',{exact:true}).count(),0);
  assert.equal(searchPages.at(-1),1);
  assert.equal(network.length,0,JSON.stringify(network));assert.deepEqual(errors,[]);
  await page.screenshot({path:`${out}/search-${width}.png`,fullPage:true});
  results.push({width,searchCalls,searchPages,normalExternalMove:true,spamExternalRescue:true,
    failedRefreshHidesRowsAndCount:true,paginationShrink:true,network,errors});
  console.log(JSON.stringify(results.at(-1)));
  await fs.writeFile(`${out}/browser.json`,JSON.stringify({browser:browser.version(),results},null,2)+'\n');
  await page.close();
 }
 await fs.writeFile(`${out}/browser.json`,JSON.stringify({browser:browser.version(),results},null,2)+'\n');
} finally {await browser.close();}
