// Read-only historical execution; writes only the local regression oracle.
// Run from repo root: node engineering/doc/FLY-2567-lead-token-savings/capture-legacy-bootstrap.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';

const evidence = new URL('./evidence/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('rework-legacy-sources.json', evidence), 'utf8'));
const now = '2026-09-15T00:00:00.000Z';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const rows = Array.from({ length: 15 }, (_, i) => ({
  issueId: `issue-${i}`, issueIdentifier: i % 2 ? `FLY-${i}` : null,
  issueTitle: `任务 ${i} ${'long title 🧭 '.repeat(20)}`,
  status: 'running', sessionRole: i % 3 ? 'implement' : 'main',
  chatThreadId: i % 2 ? `thread-${i}` : undefined,
  decisionRoute: i % 2 ? 'needs_review' : null,
  lastError: `故障 ${'🧭'.repeat(110)}`,
}));
const questions = rows.map((row, i) => ({
  questionId: `question-${i}`, checkpoint: i % 2 ? 'review_code' : 'question',
  executionId: `exec-${i}`, issueIdentifier: row.issueIdentifier,
  sessionRole: row.sessionRole, chatThreadId: row.chatThreadId,
  commDbPath: '/fixture/comm.db', createdAt: now,
  content: `${i % 2 ? 'DONE: report' : 'Please decide'} ${'🧭context '.repeat(40)}`,
}));
const cases = [{
  name: 'empty', snapshot: { leadId: 'fixture-lead', activeSessions: [], pendingDecisions: [], recentFailures: [], recentEvents: [], memoryRecall: null },
}, {
  name: 'overflow-unicode-mixed', snapshot: {
    leadId: 'fixture-lead', activeSessions: rows, pendingDecisions: rows,
    recentFailures: rows, recentEvents: rows.map((row, i) => ({ seq: i + 1, event: { event_type: 'stage_changed', issue_id: row.issueId, issue_identifier: row.issueIdentifier } })),
    memoryRecall: 'memory 🧭 '.repeat(200),
    pendingGateQuestions: questions, pendingRunnerQuestions: questions,
  },
}];
const outputs = [];
for (const backend of ['mailbox', 'commdb']) {
  const path = `packages/teamlead/src/bridge/${backend}-lead-runtime.ts`;
  const entry = manifest.sources.find((item) => item.path === path);
  assert.ok(entry);
  const source = execFileSync('git', ['show', `${manifest.legacyRevision}:${path}`], { encoding: 'utf8' });
  assert.equal(sha(source), entry.sha256);
  const signature = 'private formatBootstrap(snapshot: LeadBootstrap): string {';
  const start = source.indexOf(signature);
  assert.ok(start >= 0);
  assert.equal(source.indexOf(signature, start + 1), -1);
  const method = source.slice(start).trim();
  assert.ok(method.endsWith('\n\t}\n}'));
  // The historical formatter is the final method. Remove only type syntax
  // and the class closing brace; preserve every executable expression.
  const executable = method.slice(0, -1)
    .replace(signature, 'function formatBootstrap(snapshot) {')
    .replace('const sections: string[]', 'const sections');
  for (const fixture of cases) {
    const sandbox = { snapshot: structuredClone(fixture.snapshot), Date: class extends Date { constructor() { super(now); } } };
    const content = vm.runInNewContext(`${executable}\nformatBootstrap(snapshot)`, sandbox, { timeout: 1000 });
    outputs.push({ backend, name: fixture.name, content, bytes: Buffer.byteLength(content), sha256: sha(content) });
  }
}
assert.ok(outputs.find((item) => item.name === 'overflow-unicode-mixed').content.length > 12000);
for (const fixture of cases) {
  const selected = outputs.filter((item) => item.name === fixture.name);
  assert.equal(selected[0].content, selected[1].content);
}
writeFileSync(new URL('legacy-bootstrap-oracle.json', evidence), `${JSON.stringify({ legacyRevision: manifest.legacyRevision, now, scope: 'Historical renderer bytes only; does not prove current generator, delivery, or runtime toggle behavior.', cases, outputs }, null, 2)}\n`);
console.log(JSON.stringify(outputs.map(({ backend, name, bytes, sha256 }) => ({ backend, name, bytes, sha256 })), null, 2));
