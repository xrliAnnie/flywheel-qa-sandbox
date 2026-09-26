#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
node --input-type=module - "$REPO_ROOT" <<'NODE'
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
const lib = await import(pathToFileURL(join(root, 'scripts/lib/qa-2913-prefix-controls.mjs')));
const { readPinnedAgents } = await import(pathToFileURL(join(root, 'scripts/qa-2913-prefix-controls.mjs')));
const { verifyPair, summarizeRole, runPrefixControls, buildProbeArgv, CONTROL_ROLES } = lib;

let passed = 0;
async function test(name, fn) { await fn(); console.log(`PASS ${name}`); passed++; }

const compiled = { stamp: { removed: { skills: ['gemini-image'], agents: ['belle-lead'], rules: ['gog.md'] } } };
const inventory = (skills, agents, files) => ({
  skills: skills.map((name) => ({ name, source: 'userSettings', tokens: 10 })),
  agents: agents.map((name) => ({ name, source: 'userSettings', tokens: 10 })),
  memoryFiles: files.map((file) => ({ file, type: 'User', tokens: 10 })),
});
const legacy = inventory(['implement', 'gemini-image'], ['Explore', 'belle-lead'], ['context7.md', 'gog.md']);

await test('an effective removal passes and reports each control as effective', async () => {
  const v = verifyPair({ legacy, roleV1: inventory(['implement'], ['Explore'], ['context7.md']), compiled, requiredSkills: ['implement'] });
  assert.equal(v.pass, true);
  for (const kind of ['skills', 'agents', 'rules']) assert.equal(v.controls[kind].effective, true, kind);
});

await test('a removal the CLI ignored is reported as ineffective, not as over-removal', async () => {
  const v = verifyPair({ legacy, roleV1: inventory(['implement', 'gemini-image'], ['Explore', 'belle-lead'], ['context7.md']), compiled, requiredSkills: ['implement'] });
  assert.equal(v.pass, true);
  assert.deepEqual(v.controls.skills.stillPresent, ['gemini-image']);
  assert.equal(v.controls.agents.effective, false);
  assert.equal(v.controls.rules.effective, true);
});

await test('memory files are compared by type and name, so one CLAUDE.md cannot mask another', async () => {
  const withProject = { ...legacy, memoryFiles: [...legacy.memoryFiles, { file: 'CLAUDE.md', type: 'Project', tokens: 10 }, { file: 'CLAUDE.md', type: 'User', tokens: 10 }] };
  const roleV1 = { ...inventory(['implement'], ['Explore'], ['context7.md']), memoryFiles: [{ file: 'context7.md', type: 'User', tokens: 10 }, { file: 'CLAUDE.md', type: 'User', tokens: 10 }] };
  const v = verifyPair({ legacy: withProject, roleV1, compiled, requiredSkills: ['implement'] });
  assert.equal(v.pass, false);
  assert.deepEqual(v.unintendedLoss.rules, ['Project:CLAUDE.md']);
});

await test('losing a required or an unlisted item fails the pair', async () => {
  const missingRequired = verifyPair({ legacy, roleV1: inventory([], ['Explore'], ['context7.md']), compiled, requiredSkills: ['implement'] });
  assert.equal(missingRequired.pass, false);
  assert.deepEqual(missingRequired.requiredMissing, ['implement']);
  const collateral = verifyPair({ legacy, roleV1: inventory(['implement'], [], ['context7.md']), compiled, requiredSkills: [] });
  assert.equal(collateral.pass, false);
  assert.deepEqual(collateral.unintendedLoss.agents, ['Explore']);
});

await test('summaries use complete pairs only and flag incomplete runs', async () => {
  const sample = (fixed, status = 'complete') => ({ status, context: { knownFixedCategoryTokens: fixed } });
  const controls = (stillSkills = []) => ({
    skills: { targetedPresentInLegacy: 2, removed: 2 - stillSkills.length, stillPresent: stillSkills, effective: stillSkills.length === 0 },
    agents: { targetedPresentInLegacy: 1, removed: 1, stillPresent: [], effective: true },
    rules: { targetedPresentInLegacy: 0, removed: 0, stillPresent: [], effective: false },
  });
  const ok = { legacy: sample(100), roleV1: sample(70), verdict: { pass: true, controls: controls() } };
  assert.deepEqual(summarizeRole([ok, ok, { ...ok, legacy: sample(110), roleV1: sample(72) }]), {
    samples: 3, completePairs: 3,
    before: { p50: 100, min: 100, max: 110 }, after: { p50: 70, min: 70, max: 72 },
    deltaP50: 30, allPairsPass: true,
    ineffective: { skills: [], agents: [], rules: [] }, allControlsEffective: true,
  });
  const inert = summarizeRole([{ ...ok, verdict: { pass: true, controls: controls(['everything-claude-code:go-test']) } }]);
  assert.deepEqual(inert.ineffective.skills, ['everything-claude-code:go-test']);
  assert.equal(inert.allControlsEffective, false);
  assert.equal(inert.allPairsPass, true);
  const partial = summarizeRole([ok, { legacy: sample(100), roleV1: sample(null, 'failed'), verdict: null }]);
  assert.equal(partial.completePairs, 1);
  assert.equal(partial.allPairsPass, false);
});

await test('pairs differ only in settings and run interleaved for every role', async () => {
  const config = await import(pathToFileURL(join(root, 'packages/config/dist/index.js')));
  const launches = [];
  const FIXTURE_SKILLS = ['implement', 'onboarding', 'claude-api', 'gemini-image'];
  const probe = async (options) => {
    launches.push(options);
    const settings = JSON.parse(options.args[options.args.indexOf('--settings') + 1]);
    const off = settings.skillOverrides ?? {};
    const skills = FIXTURE_SKILLS.filter((s) => off[s] !== 'off');
    return { status: 'complete', context: { knownFixedCategoryTokens: 1000 + skills.length }, inventory: inventory(skills, [], []) };
  };
  const result = await runPrefixControls({ binary: '/fake/claude', cwd: '/tmp/flywheel-test-slot-9/p', model: 'm', effort: 'high',
    rounds: 2, probe, config, pinnedAgents: readPinnedAgents(root), claudeConfigDir: '/Users/fixture/.claude', env: {} });
  assert.deepEqual(Object.keys(result.roles), CONTROL_ROLES);
  assert.equal(launches.length, CONTROL_ROLES.length * 4);
  for (let i = 0; i < launches.length; i += 2) {
    const strip = (a) => a.filter((_v, j) => a[j - 1] !== '--settings' && a[j - 1] !== '--session-id');
    assert.deepEqual(strip(launches[i].args), strip(launches[i + 1].args));
    assert.equal(launches[i].inventoryNames, true);
    assert.notEqual(launches[i].args[launches[i].args.indexOf('--session-id') + 1], launches[i + 1].args[launches[i + 1].args.indexOf('--session-id') + 1]);
    const [legacySettings, slimSettings] = [launches[i], launches[i + 1]].map((l) => JSON.parse(l.args[l.args.indexOf('--settings') + 1]));
    assert.equal(legacySettings.skillOverrides, undefined);
    assert.equal(slimSettings.enabledPlugins['discord@flywheel-plugins'], false);
  }
  for (const role of CONTROL_ROLES) {
    const summary = result.roles[role].summary;
    assert.equal(summary.allPairsPass, true, role);
    const expected = result.roles[role].removed.skills.filter((s) => FIXTURE_SKILLS.includes(s)).length;
    assert.ok(expected >= 1, role);
    assert.equal(summary.deltaP50, expected, role);
  }
  const qaArgs = launches[CONTROL_ROLES.indexOf('qa') * 4].args;
  assert.equal(qaArgs.includes('--no-chrome'), false);
});

await test('probe argv keeps the validated launcher shape', async () => {
  const argv = buildProbeArgv({ model: 'm', effort: 'high', sessionId: 's', settings: { a: 1 }, noChrome: true });
  assert.deepEqual(argv.slice(-4), ['{"a":1}', '--permission-mode', 'bypassPermissions', '--no-chrome']);
});

console.log(`${passed} prefix control fixture tests passed (no Claude/model/room launched)`);
NODE
