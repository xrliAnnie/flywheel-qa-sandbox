#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = process.cwd();
const temp = mkdtempSync(join(tmpdir(), 'fly2533-assets-'));
const run = (args, cwd = temp) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
try {
  for (const path of ['scripts/sync-phase-protocols.mjs', 'packages/teamlead/phase-protocols', '.flywheel/agents/nodes', 'engineering/doc/FLY-2533-snapshot-phase-protocol/protocol-extraction.md']) {
    mkdirSync(join(temp, path, '..'), { recursive: true });
    cpSync(join(root, path), join(temp, path), { recursive: true });
  }
  const script = join(temp, 'scripts/sync-phase-protocols.mjs');
  assert.equal(run([script]).status, 0, 'default check accepts exact projections');
  const file = join(temp, '.flywheel/agents/nodes/qa.md');
  const original = readFileSync(file, 'utf8');
  writeFileSync(file, original.replace('Preserve FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL', 'Discard FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL'));
  const drift = run([script, '--check']);
  assert.notEqual(drift.status, 0);
  assert.match(drift.stderr, /qa\.md/);
  assert.match(readFileSync(file, 'utf8'), /Discard FLYWHEEL/, 'check never repairs');
  assert.equal(run([script, '--write']).status, 0);
  assert.equal(readFileSync(file, 'utf8'), original);
  for (const bad of [original.replace(':qa:END', ':implement:END'), original.replace('<!-- FLYWHEEL_PHASE_PROTOCOL:qa:END -->', ''), original + original, original.replace(':qa:BEGIN', ':implement:BEGIN')]) {
    writeFileSync(file, bad);
    const result = run([script, '--write']);
    assert.notEqual(result.status, 0, 'malformed blocks cannot be repaired by guessing');
    assert.match(result.stderr, /qa\.md/);
    assert.equal(readFileSync(file, 'utf8'), bad);
  }
  writeFileSync(file, original);
  const canonicalFile = join(temp, 'packages/teamlead/phase-protocols/review.md');
  const canonical = readFileSync(canonicalFile, 'utf8');
  writeFileSync(canonicalFile, '  \n');
  assert.notEqual(run([script]).status, 0, 'empty canonical review is rejected even without a legacy projection');
  writeFileSync(canonicalFile, canonical);
  const migrationFile = join(temp, 'engineering/doc/FLY-2533-snapshot-phase-protocol/protocol-extraction.md');
  const migration = readFileSync(migrationFile, 'utf8');
  writeFileSync(migrationFile, migration.replaceAll('.flywheel/agents/nodes/general.matt.md', 'missing.md'));
  assert.notEqual(run([script]).status, 0, 'every variant needs a migration entry');
  writeFileSync(migrationFile, migration);
  assert.notEqual(run([script, '--unknown']).status, 0);
  const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--cache', join(temp, 'npm-cache'), '--pack-destination', temp], { cwd: join(root, 'packages/teamlead'), encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const archive = JSON.parse(packed.stdout)[0].filename;
  assert.equal(spawnSync('tar', ['-xzf', join(temp, archive), '-C', temp]).status, 0);
  for (const type of ['design', 'implement', 'qa', 'generic', 'review']) {
    assert.equal(readFileSync(join(temp, 'package/phase-protocols', `${type}.md`), 'utf8'), readFileSync(join(root, 'packages/teamlead/phase-protocols', `${type}.md`), 'utf8'));
  }
  const installed = join(temp, 'package/dist/workflow-phase-protocol.js');
  const runner = join(temp, 'installed-check.mjs');
  writeFileSync(runner, `import { loadWorkflowPhaseProtocols } from ${JSON.stringify(installed)}; loadWorkflowPhaseProtocols(['design','implement','qa','generic','review']);`);
  const installedResult = run([runner]);
  assert.equal(installedResult.status, 0, `installed dist loader needs no source checkout: ${installedResult.stderr}`);
  rmSync(join(temp, 'package/phase-protocols/qa.md'));
  const missing = run([runner]);
  assert.notEqual(missing.status, 0, 'installed loader cannot fall back to source assets');
  assert.match(missing.stderr, /qa/);
  console.log('PASS: FLY-2533 generator guards and isolated packed protocol assets');
} finally { rmSync(temp, { recursive: true, force: true }); }
JS
