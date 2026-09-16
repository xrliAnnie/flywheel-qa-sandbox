#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync, writeFileSync, chmodSync, symlinkSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readPatrolGithubFacts} from './scripts/lead-patrol-github-facts.mjs';
const home = realpathSync(mkdtempSync(join(tmpdir(), 'patrol-facts-')));
const path = join(home, 'facts.json');
const facts = {
 projectName: 'demo', leadId: 'eng',
 pulls: [{number: 1, draft: false, head: {sha: 'a'.repeat(40)}, updated_at: '2026-09-14T00:00:00Z'}],
 runs: {workflow_runs: [{id: 2, status: 'completed', created_at: '2026-09-14T00:00:00Z'}]},
};
const put = value => {writeFileSync(path, JSON.stringify(value), {mode: 0o600}); chmodSync(path, 0o600);};
try {
 put(facts);
 assert.deepEqual(readPatrolGithubFacts(path, 'demo', 'eng'), facts);
 assert.throws(() => readPatrolGithubFacts(path, 'foreign', 'eng'), /patrol_github_facts_invalid/);
 assert.throws(() => readPatrolGithubFacts(path, 'demo', 'other'), /patrol_github_facts_invalid/);
 for (const value of [{...facts, token: 'secret'}, {...facts, pulls: Array(51).fill(facts.pulls[0])}, {...facts, runs: {workflow_runs: [{...facts.runs.workflow_runs[0], status: 'bad\nline'}]}}]) {
  put(value);
  assert.throws(() => readPatrolGithubFacts(path, 'demo', 'eng'), /patrol_github_facts_invalid/);
 }
 put(facts); chmodSync(path, 0o644);
 assert.throws(() => readPatrolGithubFacts(path, 'demo', 'eng'), /patrol_github_facts_invalid/);
 chmodSync(path, 0o600);
 symlinkSync(path, join(home, 'link.json'));
 assert.throws(() => readPatrolGithubFacts(join(home, 'link.json'), 'demo', 'eng'), /patrol_github_facts_invalid/);
 writeFileSync(path, 'x'.repeat(131073));
 assert.throws(() => readPatrolGithubFacts(path, 'demo', 'eng'), /patrol_github_facts_invalid/);
 console.log('PASS: bounded parent GitHub facts, scope, schema, private file, symlink and byte guards');
} finally {rmSync(home, {recursive: true, force: true});}
JS

if bash scripts/lead-patrol-snapshot.sh --project demo --lead eng --github-facts "" >/dev/null 2>&1; then
 echo "FAIL: explicit empty facts must reject before gh fallback" >&2; exit 1
fi
if bash scripts/lead-patrol-snapshot.sh --project demo --lead eng --github-facts /unused --record-dwell-receipts normal >/dev/null 2>&1; then
 echo "FAIL: facts input must not be combined with receipt writes" >&2; exit 1
fi
echo "PASS: explicit facts options reject empty and mixed write modes"
