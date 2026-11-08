// Copyright (c) 2026 Brian Crumrine
// SPDX-License-Identifier: Apache-2.0
import {existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync, execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const SCORER_PIN = '041e79c5f56880b8eff0e210968569461cb95fc0';
const LEGACY_SCORER_PIN = '2fab406320ae3b3596345d2c76e0ef8a08593211';
const root = process.cwd();
const outDir = resolve(process.env.EVIDENCE_DIR || 'docs/evidence/dev-998');
const records = [];
const sha256 = text => createHash('sha256').update(text).digest('hex');
const stripAnsi = text => text.replace(/\x1b\[[0-9;]*m/g, '').replace(/[ \t]+$/gm, '');
mkdirSync(outDir, {recursive: true});

const contractEvidence = JSON.parse(readFileSync(join(outDir,'contract.json'), 'utf8'));
const wire = JSON.stringify(contractEvidence.fixture);
const gtubeResult = contractEvidence.gtubePreferenceResults.none.result;
const gtubeWire = JSON.stringify({rpcVersion: '1', ok: true, result: gtubeResult});
const gtubeAssessment = {version: 1, policyVersion: 'inbox-shadow-1', status: 'partial', inputIncomplete: false, result: gtubeResult};
const parsed = {subject: 'Synthetic', text: 'hello', headers: [], headerLines: [], attachments: []};

const removeInlineForwardGuard = source => source.replace("  if (/(?:^|[\\r\\n])-{3,}[\\r\\n]+(?:From|Subject|Date|To|Cc|Bcc):[ \\t]/.test(text) || html?.includes('class=\"postal-email-header\"')) {\n    // Preserve quote status so copied subject/name clues cannot cause automatic routing.\n    text = '>';\n    html = undefined;\n    complete = false;\n  }\n", '');

const statisticalAssessment=contractEvidence.generalResults.plain;
const removeStatisticalRouting = source => source.replace(/  if \(result\.ruleSetVersion === 'rules-3' && result\.heuristicScore >= 60[\s\S]*?return true;\n/, '');
const tests = [
 ['statistical_routing', 'intake.ts', removeStatisticalRouting, async m => {assert.equal(m.shouldQuarantine(statisticalAssessment,'none'),true);} ],
 ['html_projection', 'intake.ts', s=>s.replace('...(html ? {html} : {}),',''), async m=>{assert.equal(m.project({...parsed,text:'',html:'<p>body</p>'}).html,'<p>body</p>');}],
 ['html_source_bound', 'intake.ts', s=>s.replace('field(parsed.html, 32768)','field(parsed.html, 327680)'), async m=>{assert.equal(m.project({...parsed,text:'',html:'é'.repeat(16385)}).html,undefined);}],
 ['omitted_body_failure', 'intake.ts', source => source.replace('    if ((parsed.text && !input.text) || (!input.text.trim() && parsed.html && !input.html)) return unavailable();\n', ''), async m => {
  let calls=0;const assessment=await m.assessArrival({MAIL_SCORING_MODE:'filter',MAIL_SCORER:{scoreV1:async()=>{calls++;return wire;}}},{...parsed,text:'x'.repeat(32769)},true);
  assert.equal(assessment.status,'unavailable');assert.equal(calls,0);
 }],
 ['inline_quote_provenance', 'intake.ts', source => source.replace("text = '>';", "text = '';"), async m => {
  assert.equal(m.project({...parsed,text:'Report\n----\nFrom: reported@example.test\nVerify your password.'}).text,'>');
 }],
 ['inline_forward_omission', 'intake.ts', removeInlineForwardGuard, async m => {
  const input=m.project({...parsed,text:'Please investigate.\n----\nFrom: reported@example.test\nVerify your password.'});
  assert.equal(input.text,'>');assert.equal(input.sourceComplete,false);
 }],
 ['off', 'intake.ts', s => s.replace("if (env.MAIL_SCORING_MODE !== 'shadow' && env.MAIL_SCORING_MODE !== 'filter') return undefined;", ''), async m => {
  let calls = 0; await m.assessArrival({MAIL_SCORING_MODE: 'off', MAIL_SCORER: {scoreV1: async () => {calls++; return wire;}}}, parsed, true); assert.equal(calls, 0);
 }],
 ['response_bound', 'protocol.ts', s => s.replace('||wire.length>RPC_OUTPUT_BYTES', '').replace('if(new TextEncoder().encode(wire).byteLength>RPC_OUTPUT_BYTES)return null;', ''), async m => {
  assert.equal(m.decodeResponse(wire + ' '.repeat(4096)), null);
 }],
 ['auth_provenance', 'intake.ts', s => s.replace("provenance:'unknown'", "provenance:'upstream'"), async m => {
  assert.equal(m.project(parsed).transport.provenance, 'unknown');
 }],
 ['url_projection', 'intake.ts', s => s.replace('subject, text, urls, addresses', 'subject, text, urls:[], addresses'), async m => {
  assert.deepEqual(m.project({...parsed,text:'https://user@example.test/'}).urls, ['https://user@example.test/']);
 }],
 ['url_count_bound', 'intake.ts', s => s.replaceAll('urls.length === LIMITS.urls', 'false'), async m => {
  const projected=m.project({...parsed,text:'https://user@example.test/ '.repeat(101)});
  assert.equal(projected.urls.length,100);
  assert.equal(projected.sourceComplete,false);
 }],
 ['url_source_bound', 'intake.ts', s => s.replace('field(parsed.text, 32768)', 'field(parsed.text, 327680)'), async m => {
  const projected=m.project({...parsed,text:'a'.repeat(32769)+' https://user@example.test/'});
  assert.deepEqual(projected.urls,[]);
  assert.equal(projected.sourceComplete,false);
 }],
 ['url_original_token_bound', 'intake.ts', s => s.replace('field(match[0], LIMITS.urlBytes)', 'match[0]'), async m => {
  const projected=m.project({...parsed,text:'https://user@example.test/'+'.'.repeat(3000)});
  assert.deepEqual(projected.urls,[]);
  assert.equal(projected.sourceComplete,false);
 }],
 ['manual_authority', 'feedback.ts', s => s.replace('authorities.has(authority)', 'true'), async m => {
  assert.equal(m.hasManualAuthority({mailboxId: 'a@example.test'}, 'a@example.test'), false);
 }],
 ['gtube_routing', 'intake.ts', s => s.replace("  if ((result.ruleSetVersion === 'rules-2' || result.ruleSetVersion === 'rules-3') && result.signals.spam === 'present' &&\n      result.reasons.some(reason => reason.id === 'gtube' && reason.contribution > 0)) return true;\n", ''), async m => {
  assert.equal(m.shouldQuarantine(gtubeAssessment, 'none'), true);
 }],
 ['gtube_allow_precedence', 'intake.ts', s => s.replace("|| preference === 'allow'", ''), async m => {
  assert.equal(m.shouldQuarantine(gtubeAssessment, 'allow'), false);
 }],
 ['gtube_version_guard', 'protocol.ts', s => s.replace("if(r.ruleSetVersion==='rules-1'&&id==='gtube')return false;", ''), async m => {
  assert.equal(m.decodeResponse(gtubeWire.replace('"rules-3"', '"rules-1"')), null);
 }],
];

for (const [name, file, mutate, check] of tests) {
 const temp = mkdtempSync(join(root, '.scoring-mutation-'));
 try {
  cpSync('workers/lib/mail-scoring', join(temp, 'source'), {recursive: true});
  for (const mutant of [false, true]) {
   const source = readFileSync(`workers/lib/mail-scoring/${file}`, 'utf8');
   if (mutant) assert.notEqual(mutate(source), source);
   writeFileSync(join(temp, 'source', file), mutant ? mutate(source) : source);
   const out = join(temp, `${mutant}.mjs`);
   await build({entryPoints: [join(temp, 'source', file)], outfile: out, bundle: true, platform: 'node', format: 'esm'});
   const m = await import(pathToFileURL(out));
   let failed = false;
   try { await check(m); } catch (e) { if (!(e instanceof assert.AssertionError)) throw e; failed = true; }
   assert.equal(failed, mutant, `${name}: expected baseline pass/mutant assertion failure`);
  }
  records.push({name, baseline: 'passed', mutant: 'assertion_failed'});
 } finally {
  rmSync(temp, {recursive: true, force: true});
 }
}

if (process.argv.includes('--workerd')) {
 const scorerRoot = [
  process.env.MAIL_SCORING_DIR,
  resolve(root, '../mail-scoring'),
  resolve(root, '../../mail-scoring'),
  '/Users/brian/projects/mail-scoring',
  '/home/brian/r9-jobs/home/symphony-workspaces/siteforge/mail-scoring',
 ].find(candidate => Boolean(candidate && existsSync(join(candidate, 'workers/private/index.ts'))));
 assert.ok(scorerRoot, 'Expected mail-scoring repository checkout');
 assert.equal(execFileSync('git', ['-C', scorerRoot, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), SCORER_PIN);
 assert.equal(execFileSync('git', ['-C', scorerRoot, 'status', '--porcelain'], {encoding: 'utf8'}).trim(), '');

 const workerdMutants = [
  {name:'statistical_routing_workerd',repo:'agentic-inbox-imap',file:'workers/lib/mail-scoring/intake.ts',mutate:removeStatisticalRouting,
   pattern:'routes actual plain and HTML statistical spam',spamInboxRegression:true,verifyRestored:true},
  {name:'statistical_detection_workerd',repo:'mail-scoring',file:'packages/core/src/index.ts',mutate:s=>s.replace('!features.gtube&&generalSpam(input,limits)','false'),
   pattern:'routes actual plain and HTML statistical spam',spamInboxRegression:true,verifyRestored:true},
  {name:'html_projection_workerd',repo:'agentic-inbox-imap',file:'workers/lib/mail-scoring/intake.ts',mutate:s=>s.replace('...(html ? {html} : {}),',''),
   pattern:'routes actual plain and HTML statistical spam',spamInboxRegression:true,verifyRestored:true},
  {name:'html_forward_provenance_workerd',repo:'agentic-inbox-imap',file:'workers/lib/mail-scoring/intake.ts',mutate:s=>s.replace(' || html?.includes(\'class="postal-email-header"\')',''),
   pattern:'keeps inline forwarded HTML reports',spamInboxRegression:false,verifyRestored:true},
  {name:'html_source_bound_workerd',repo:'agentic-inbox-imap',file:'workers/lib/mail-scoring/intake.ts',mutate:s=>s.replace('field(parsed.html, 32768)','field(parsed.html, 327680)'),
   pattern:'bounds selected HTML',spamInboxRegression:false,verifyRestored:true},

  {
   name: 'omitted_body_failure_workerd',
   repo: 'agentic-inbox-imap',
   file: 'workers/lib/mail-scoring/intake.ts',
   mutate: source => source.replace('    if ((parsed.text && !input.text) || (!input.text.trim() && parsed.html && !input.html)) return unavailable();\n', ''),
   pattern: 'keeps oversized inline reports',
   spamInboxRegression: false,
   verifyRestored: true,
  },
  {
   name: 'inline_quote_provenance_workerd',
   repo: 'agentic-inbox-imap',
   file: 'workers/lib/mail-scoring/intake.ts',
   mutate: source => source.replace("text = '>';", "text = '';"),
   pattern: 'preserves explicit sender block on inspectable inline reports',
   spamInboxRegression: true,
   verifyRestored: true,
  },
  {
   name: 'inline_forward_omission_workerd',
   repo: 'agentic-inbox-imap',
   file: 'workers/lib/mail-scoring/intake.ts',
   mutate: removeInlineForwardGuard,
   pattern: 'keeps inline forwarded phishing reports',
   spamInboxRegression: false,
   verifyRestored: true,
  },
  {
   name: 'url_projection_workerd',
   repo: 'agentic-inbox-imap',
   file: 'workers/lib/mail-scoring/intake.ts',
   mutate: s => s.replace('subject, text, urls, addresses', 'subject, text, urls:[], addresses'),
   pattern: 'projects URL evidence through real MIME',
   spamInboxRegression: false,
   verifyRestored: true,
  },
  {
   name: 'concurrency',
   repo: 'agentic-inbox-imap',
   file: 'workers/durableObject/index.ts',
   mutate: s => s.replace("if ((old?.revision ?? 0) !== expectedRevision) return {ok:false, error:'conflict'};", ''),
   pattern: 'authenticates explicit feedback',
   spamInboxRegression: false,
   verifyRestored: false,
  },
  {
   name: 'mailbox_message_id',
   repo: 'agentic-inbox-imap',
   file: 'workers/durableObject/index.ts',
   mutate: s => s.replace("if (!email) return {ok:false, error:'not_found'};", ''),
   pattern: 'authenticates explicit feedback',
   spamInboxRegression: false,
   verifyRestored: false,
  },
  {
   name: 'gtube_version_rejection_workerd',
   repo: 'agentic-inbox-imap',
   file: 'workers/lib/mail-scoring/protocol.ts',
   mutate: s => s.replace('!RULE_SET_VERSIONS.includes(r.ruleSetVersion as RuleSetVersion)', "r.ruleSetVersion!=='rules-1'"),
   pattern: 'routes positive GTUBE to Spam',
   spamInboxRegression: true,
   verifyRestored: false,
  },
  {
   name: 'gtube_routing_workerd',
   repo: 'agentic-inbox-imap',
   file: 'workers/lib/mail-scoring/intake.ts',
   mutate: s => s.replace("  if ((result.ruleSetVersion === 'rules-2' || result.ruleSetVersion === 'rules-3') && result.signals.spam === 'present' &&\n      result.reasons.some(reason => reason.id === 'gtube' && reason.contribution > 0)) return true;\n", ''),
   pattern: 'routes positive GTUBE to Spam',
   spamInboxRegression: true,
   verifyRestored: true,
  },
  {
   name: 'gtube_detection_workerd',
   repo: 'mail-scoring',
   file: 'packages/core/src/inspection.ts',
   mutate: s => s.replace('if(line.includes(GTUBE_MARKER))found=true;', ''),
   pattern: 'routes positive GTUBE to Spam',
   spamInboxRegression: true,
   verifyRestored: true,
  },
 ];

 for (const {name, repo, file, mutate, pattern, spamInboxRegression, verifyRestored} of workerdMutants) {
  const temp = mkdtempSync(join(tmpdir(), 'dev-989-mutation-'));
  try {
   for (const path of ['workers', 'shared', 'test', 'docs/evidence/dev-878', 'docs/evidence/dev-998', 'app', 'package.json', 'package-lock.json', 'vitest.config.ts', 'wrangler.jsonc', 'worker-configuration.d.ts']) {
    cpSync(path, join(temp, path), {recursive: true});
   }
   symlinkSync(join(root, 'node_modules'), join(temp, 'node_modules'), 'dir');

   let activeScorerDir = scorerRoot;
   if (repo === 'mail-scoring') {
    activeScorerDir = join(temp, 'mail-scoring');
    execFileSync('git',['clone','--shared','--no-checkout',scorerRoot,activeScorerDir],{stdio:'pipe'});
    execFileSync('git',['-C',activeScorerDir,'checkout','--detach',SCORER_PIN],{stdio:'pipe'});
    symlinkSync(join(scorerRoot,'node_modules'),join(activeScorerDir,'node_modules'),'dir');
    writeFileSync(join(activeScorerDir,'.git/info/exclude'),'node_modules\n');
    assert.equal(execFileSync('git', ['-C', activeScorerDir, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), SCORER_PIN);
    assert.equal(execFileSync('git', ['-C', activeScorerDir, 'status', '--porcelain'], {encoding: 'utf8'}).trim(), '');
   }

   const targetBase = repo === 'mail-scoring' ? activeScorerDir : temp;
   const target = join(targetBase, file);
   const source = readFileSync(target, 'utf8');
   const originalSha256 = sha256(source);
   const mutant = mutate(source);
   assert.notEqual(source, mutant, name);
   const mutantSha256 = sha256(mutant);
   writeFileSync(target, mutant);

   let patchFile;
   if (verifyRestored) {
    patchFile = `mutation-${name}.patch`;
    const rawPatch = repo === 'mail-scoring'
     ? execFileSync('git', ['-C', activeScorerDir, 'diff', '--', file], {encoding: 'utf8'})
     : (spawnSync('git', ['diff', '--no-index', '--', join(root, file), target], {encoding: 'utf8'}).stdout ?? '')
        .replaceAll(join(root, file), '/' + file)
        .replaceAll(target, '/' + file);
    assert.ok(rawPatch.trim().length > 0, `${name}: expected non-empty patch`);
    writeFileSync(join(outDir, patchFile), stripAnsi(rawPatch).trim() + '\n');
   }

   const runVitest = () => spawnSync(
    process.execPath,
    [join(root, 'node_modules/vitest/vitest.mjs'), 'run', 'test/shadow-scoring.test.ts', '-t', pattern, '--maxWorkers=1', '--testTimeout=30000', '--hookTimeout=30000'],
    {cwd: temp, encoding: 'utf8', timeout: 240000, env: {...process.env, MAIL_SCORING_DIR: activeScorerDir, XDG_CONFIG_HOME: '/tmp/dev-989-xdg', WRANGLER_SEND_METRICS: 'false'}}
   );

   const r = runVitest();
   const log = stripAnsi((r.stdout ?? '') + (r.stderr ?? '')).trim() + '\n';
   writeFileSync(join(outDir, `mutation-${name}.log`), log);
   assert.equal(r.status, 1, name);
   assert.match(log, /AssertionError/);
   assert.match(log, new RegExp(pattern));
   if (spamInboxRegression) {
    assert.match(log, /-\s*"folder_id":\s*"spam"[\s\S]*\+\s*"folder_id":\s*"inbox"/, `${name}: expected Spam-versus-Inbox regression`);
   }

   const inlineRegression = ['inline_forward_omission_workerd', 'omitted_body_failure_workerd'].includes(name);
   if (inlineRegression) {
    assert.match(log, /-\s*"folder_id":\s*"inbox"[\s\S]*\+\s*"folder_id":\s*"spam"/, 'expected legitimate report Inbox-to-Spam regression');
   }

   const record = {
    name,
    repo,
    ...(repo === 'mail-scoring' ? {scorerPin: SCORER_PIN, legacyScorerPin: LEGACY_SCORER_PIN} : {}),
    file,
    originalSha256,
    mutantSha256,
    ...(patchFile ? {patch: patchFile} : {}),
    mutant: 'assertion_failed',
    ...(spamInboxRegression ? {regression: 'folder_id spam -> inbox'} : {}),
    ...(inlineRegression ? {regression: 'folder_id inbox -> spam'} : {}),
    log: `mutation-${name}.log`,
   };

   if (verifyRestored) {
    writeFileSync(target, source);
    const restoredSha256 = sha256(readFileSync(target, 'utf8'));
    assert.equal(restoredSha256, originalSha256, `${name}: expected restored source digest to match original`);
    if (repo === 'mail-scoring') {
     assert.equal(execFileSync('git', ['-C', activeScorerDir, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), SCORER_PIN);
     assert.equal(execFileSync('git', ['-C', activeScorerDir, 'status', '--porcelain'], {encoding: 'utf8'}).trim(), '');
    }
    const restored = runVitest();
    const restoredLog = stripAnsi((restored.stdout ?? '') + (restored.stderr ?? '')).trim() + '\n';
    const restoredLogFile = `mutation-${name}-restored.log`;
    writeFileSync(join(outDir, restoredLogFile), restoredLog);
    assert.equal(restored.status, 0, `${name}: expected restored run to pass`);
    assert.match(restoredLog, /1 passed/);
    record.restoredSha256 = restoredSha256;
    record.restored = 'passed';
    record.restoredLog = restoredLogFile;
   }

   records.push(record);
  } finally {
   rmSync(temp, {recursive: true, force: true});
  }
 }

 assert.equal(execFileSync('git', ['-C', scorerRoot, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), SCORER_PIN);
 assert.equal(execFileSync('git', ['-C', scorerRoot, 'status', '--porcelain'], {encoding: 'utf8'}).trim(), '');
}

writeFileSync(join(outDir, 'scoring-mutations.json'), JSON.stringify({
 scorerPin: SCORER_PIN,
 legacyScorerPin: LEGACY_SCORER_PIN,
 records,
}, null, 2) + '\n');
console.log(JSON.stringify(records));
