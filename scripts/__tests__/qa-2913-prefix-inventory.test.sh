#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const subject = await import('./scripts/qa-2913-prefix-inventory.mjs').catch(() => ({}));
assert.equal(typeof subject.summarizePrefixInventory, 'function', 'T1 must expose the inventory evidence summarizer');
const { summarizePrefixInventory, inventoryCsv } = subject;
const root = mkdtempSync(join(tmpdir(), 'fly2913-inventory-'));
try {
  const evidence = join(root, 'context.json');
  writeFileSync(evidence, '{"diagnostic":"fixture"}\n');
  const kinds = ['system-role', 'builtin-tools', 'mcp-deferred', 'mcp-expanded', 'skills-agents', 'rules-memory', 'hook-context', 'unattributed'];
  const make = (mode, pair, total = 800) => ({
    role: 'implement', mode, pairId: String(pair), sessionId: `${mode}-${pair}`,
    executionId: `exec-${pair}`, capturedAt: '2026-09-26T05:00:00Z',
    cliVersion: '2.1.283', cliSha256: 'a'.repeat(64), head: 'b'.repeat(40),
    model: 'fable', effort: 'xhigh', cwd: '/tmp/flywheel-test-slot-1/project-slot-1',
    project: 'test-slot-1', taskDigest: 'c'.repeat(64), permissionMode: 'default',
    skillArm: 'superpowers', carrier: 'claude-tmux', settingsDigest: 'd'.repeat(64),
    sourceManifestDigest: 'e'.repeat(64), profileDigest: 'f'.repeat(64),
    fixedPrefixTokens: total, measurementMethod: 'diagnostic-estimate',
    evidencePaths: [evidence], components: kinds.map(kind => ({ kind, tokens: total / 8 })),
    sources: [{ sourceName: 'Bash', kind: 'tool', version: '2.1.283', sha256: 'a'.repeat(64),
      loaded: true, advertised: true, deferred: false, tokens: total / 8,
      observedCalls: 4, requiredBy: ['implement'], decision: 'keep', reason: 'test runner',
      plugin: null, secret: 'NEVER-EXPORT', description: 'NEVER-EXPORT' }],
  });
  const input = {version: 1, samples: [1,2,3].flatMap(n => [make('legacy',n,800+n*8),make('role-v1',n,400+n*8)])};
  const report = summarizePrefixInventory(input);
  const role = report.roles.find(r => r.role === 'implement');
  assert.equal(role.before.p50, 816);
  assert.equal(role.after.p50, 416);
  assert.deepEqual(role.before.range, [808,824]);
  assert.equal(role.pairedSamples, 3);
  assert.equal(role.deltaP50, -400);
  assert.equal(role.measurementComplete, true);
  const unpaired = structuredClone(input);
  unpaired.samples.push(make('legacy','extra',8000));
  assert.equal(summarizePrefixInventory(unpaired).roles.find(r => r.role === 'implement').measurementComplete,false,'an unmatched extra sample cannot pass paired measurement');
  assert.equal(report.roles.find(r => r.role === 'qa').before.p50, null, 'unmeasured is never zero');
  assert.equal(report.complete, false, 'one role cannot prove all five');
  assert.equal(report.samples[0].components[0].percent, 12.5);
  assert.match(report.samples[0].evidence[0].sha256, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(report).includes('NEVER-EXPORT'));
  assert.ok(!inventoryCsv(report).includes('NEVER-EXPORT'));
  const unknownSource = structuredClone(input);
  unknownSource.samples[0].sources[0].tokens = null;
  assert.equal(summarizePrefixInventory(unknownSource).roles.find(r => r.role === 'implement').inventoryComplete, false, 'per-item unknown tokens cannot pass the inventory');
  const unknown = make('legacy','unknown');
  unknown.components[0].tokens = null;
  const unknownReport = summarizePrefixInventory({version:1,samples:[unknown]});
  assert.equal(unknownReport.samples[0].measurementComplete, false);
  assert.equal(unknownReport.samples[0].components[0].percent, null);
  assert.equal(unknownReport.roles[1].before?.p50 ?? null, null);
  const missing = make('legacy','missing');
  missing.components.pop();
  assert.throws(() => summarizePrefixInventory({version:1,samples:[missing]}), /component/);
  const wrongTotal = make('legacy','wrong'); wrongTotal.fixedPrefixTokens = 999;
  assert.throws(() => summarizePrefixInventory({version:1,samples:[wrongTotal]}), /reconcile/);
  assert.throws(() => summarizePrefixInventory({version:1,samples:[make('legacy',1),make('legacy',1)]}), /duplicate/);
  const mismatch = make('role-v1',1); mismatch.effort = 'low';
  assert.throws(() => summarizePrefixInventory({version:1,samples:[make('legacy',1),mismatch]}), /paired.*effort/);
  const glob = make('legacy','glob'); glob.evidencePaths = [join(root,'*.json')];
  assert.throws(() => summarizePrefixInventory({version:1,samples:[glob]}), /explicit/);
  const bad = make('legacy','bad'); bad.measurementMethod = 'provider-billed-exact';
  assert.throws(() => summarizePrefixInventory({version:1,samples:[bad]}), /measurement/);
  const context = make('legacy','context'); context.components.push({kind:'history',tokens:5});
  assert.throws(() => summarizePrefixInventory({version:1,samples:[context]}), /component/);
  assert.equal(typeof subject.summarizeClaudeContextDiagnostic, 'function', 'current CLI diagnostic needs a metadata-only reader');
  const diagnostic = subject.summarizeClaudeContextDiagnostic({
    model:'claude-opus-5-5[1m]', totalTokens: 54233,
    categories: [
      {name:'System prompt',tokens:2250,kind:'used'}, {name:'System tools',tokens:782,kind:'used'},
      {name:'MCP tools (deferred)',tokens:3971,kind:'deferred',isDeferred:true},
      {name:'System tools (deferred)',tokens:13907,kind:'deferred',isDeferred:true},
      {name:'Custom agents',tokens:8839,kind:'used'}, {name:'Memory files',tokens:33219,kind:'used'},
      {name:'Skills',tokens:9133,kind:'used'}, {name:'Messages',tokens:10,kind:'used'},
      {name:'Autocompact buffer',tokens:33000,kind:'buffer'}, {name:'Free space',tokens:912767,kind:'free'},
    ],
    skills:{totalSkills:1,includedSkills:1,tokens:9,skillFrontmatter:[{name:'tdd',source:'user',tokens:9,description:'NEVER-EXPORT'}]},
    memoryFiles:[{path:'/tmp/CLAUDE.md',type:'project',tokens:10,content:'NEVER-EXPORT'}],
    agents:[{agentType:'planner',source:'plugin',tokens:11}],
    mcpTools:[{name:'read',serverName:'docs',tokens:42,isLoaded:false}], account:{token:'NEVER-EXPORT'},
  });
  assert.equal(diagnostic.knownFixedCategoryTokens,54223);
  assert.equal(diagnostic.deferredSchemaTokens,17878, 'deferred schema estimates are not transmitted prefix totals');
  assert.equal(diagnostic.fixedPrefixTokens,null, 'hook and deferred roster placement still require measurement');
  assert.equal(diagnostic.skills.skillFrontmatter[0].name,'tdd');
  assert.equal(diagnostic.mcpTools[0].isLoaded,false);
  assert.ok(!JSON.stringify(diagnostic).includes('NEVER-EXPORT'));
  assert.throws(() => subject.summarizeClaudeContextDiagnostic({totalTokens:12,categories:[{name:'New category',tokens:12,kind:'used'}]}), /unrecognized/);
  writeFileSync(join(root,'weekly-manifest.json'),JSON.stringify({version:1,transcripts:[]}));
  const weeklyCli = spawnSync(process.execPath,['scripts/qa-2913-prefix-inventory.mjs','weekly',join(root,'weekly-manifest.json'),'2026-09-26T05:00:00Z',join(root,'weekly-tool-use.json')],{encoding:'utf8'});
  assert.equal(weeklyCli.status,0,`weekly report CLI: ${weeklyCli.stderr}`);
  console.log('PASS: paired medians, missing coverage, unknown buckets, reconciliation, redaction, provenance and negative controls');
} finally { rmSync(root, {recursive:true,force:true}); }
JS
