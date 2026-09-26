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
const { verifyPair, summarizeRole, runPrefixControls, buildProbeArgv, buildFirstTurnArgv, parseFirstTurnUsage, CONTROL_ROLES } = lib;

let passed = 0;
async function test(name, fn) { await fn(); console.log(`PASS ${name}`); passed++; }

const compiled = { stamp: { hiddenSkillDescriptions: ['gemini-image'], excludedRules: ['gog.md'] } };
const inventory = (skills, agents, files) => ({
  skills: skills.map((s) => (typeof s === 'string' ? { name: s, source: 'userSettings', tokens: 10 } : { source: 'userSettings', ...s })),
  agents: agents.map((name) => ({ name, source: 'userSettings', tokens: 10 })),
  memoryFiles: files.map((file) => ({ file, type: 'User', tokens: 10 })),
});
const legacy = inventory(['implement', 'gemini-image'], ['Explore'], ['context7.md', 'gog.md']);

await test('hidden descriptions keep the skill listed with a smaller cost; excluded rules disappear', async () => {
  const v = verifyPair({ legacy, roleV1: inventory(['implement', { name: 'gemini-image', tokens: 2 }], ['Explore'], ['context7.md']), compiled, requiredSkills: ['implement'] });
  assert.equal(v.pass, true);
  assert.equal(v.controls.skills.effective, true);
  assert.equal(v.controls.rules.effective, true);
});

await test('a control the CLI ignored is reported as ineffective, not as over-removal', async () => {
  const v = verifyPair({ legacy, roleV1: inventory(['implement', 'gemini-image'], ['Explore'], ['context7.md', 'gog.md']), compiled, requiredSkills: ['implement'] });
  assert.equal(v.pass, true);
  assert.deepEqual(v.controls.skills.stillPresent, ['gemini-image']);
  assert.deepEqual(v.controls.rules.stillPresent, ['User:gog.md']);
});

await test('a skill that disappears entirely, even a targeted one, fails: name-only must keep it invocable', async () => {
  const v = verifyPair({ legacy, roleV1: inventory(['implement'], ['Explore'], ['context7.md']), compiled, requiredSkills: ['implement'] });
  assert.equal(v.pass, false);
  assert.deepEqual(v.unintendedLoss.skills, ['gemini-image']);
});

await test('hiding a required or untargeted description fails the pair', async () => {
  const hiddenRequired = verifyPair({ legacy, roleV1: inventory([{ name: 'implement', tokens: 2 }, { name: 'gemini-image', tokens: 2 }], ['Explore'], ['context7.md']), compiled, requiredSkills: ['implement'] });
  assert.equal(hiddenRequired.pass, false);
  assert.deepEqual(hiddenRequired.requiredMissing, ['implement']);
  const collateral = verifyPair({ legacy, roleV1: inventory([{ name: 'implement', tokens: 2 }, { name: 'gemini-image', tokens: 2 }], ['Explore'], ['context7.md']), compiled, requiredSkills: [] });
  assert.equal(collateral.pass, false);
  assert.deepEqual(collateral.unintendedLoss.unintendedHidden, ['implement']);
  const agentLoss = verifyPair({ legacy, roleV1: inventory(['implement', { name: 'gemini-image', tokens: 2 }], [], ['context7.md']), compiled, requiredSkills: [] });
  assert.deepEqual(agentLoss.unintendedLoss.agents, ['Explore']);
});

await test('memory files are compared by type and name, so one CLAUDE.md cannot mask another', async () => {
  const withProject = { ...legacy, memoryFiles: [...legacy.memoryFiles, { file: 'CLAUDE.md', type: 'Project', tokens: 10 }, { file: 'CLAUDE.md', type: 'User', tokens: 10 }] };
  const roleV1 = { ...inventory(['implement', { name: 'gemini-image', tokens: 2 }], ['Explore'], []), memoryFiles: [{ file: 'context7.md', type: 'User', tokens: 10 }, { file: 'CLAUDE.md', type: 'User', tokens: 10 }] };
  const v = verifyPair({ legacy: withProject, roleV1, compiled, requiredSkills: ['implement'] });
  assert.equal(v.pass, false);
  assert.deepEqual(v.unintendedLoss.rules, ['Project:CLAUDE.md']);
});

await test('summaries use real first-turn usage as the primary measure', async () => {
  const sample = (fixed, status = 'complete') => ({ status, context: { knownFixedCategoryTokens: fixed } });
  const turns = (before, after) => ({ legacy: { status: 'complete', promptTokens: before }, roleV1: { status: 'complete', promptTokens: after } });
  const controls = (stillSkills = []) => ({
    skills: { targetedPresentInLegacy: 2, reduced: 2 - stillSkills.length, stillPresent: stillSkills, effective: stillSkills.length === 0 },
    rules: { targetedPresentInLegacy: 1, removed: 1, stillPresent: [], effective: true },
  });
  const ok = { legacy: sample(100), roleV1: sample(100), turns: turns(1000, 900), verdict: { pass: true, controls: controls() } };
  assert.deepEqual(summarizeRole([ok, ok, { ...ok, turns: turns(1100, 950) }]), {
    samples: 3, completePairs: 3, measurementMethod: 'first-turn-api-usage',
    before: { p50: 1000, min: 1000, max: 1100 }, after: { p50: 900, min: 900, max: 950 }, deltaP50: 100,
    diagnosticEstimate: { before: { p50: 100, min: 100, max: 100 }, after: { p50: 100, min: 100, max: 100 }, deltaP50: 0 },
    allPairsPass: true, ineffective: { skills: [], rules: [] }, mcpDegraded: [], allControlsEffective: true,
  });
  const servers = (status) => [{ name: 'linear-api', status, tools: [] }];
  const degradedSample = (status) => ({ status: 'incomplete', failure: 'mcp_not_connected', mcpServers: servers(status), context: { knownFixedCategoryTokens: 1 } });
  const sameOutage = summarizeRole([{ legacy: degradedSample('failed'), roleV1: degradedSample('failed'), turns: turns(10, 8), verdict: { pass: true, controls: controls() } }]);
  assert.equal(sameOutage.completePairs, 1);
  assert.deepEqual(sameOutage.mcpDegraded, ['linear-api:failed']);
  const differentOutage = summarizeRole([{ legacy: degradedSample('connected'), roleV1: degradedSample('failed'), turns: turns(10, 8), verdict: { pass: true, controls: controls() } }]);
  assert.equal(differentOutage.completePairs, 0);
  assert.equal(differentOutage.allPairsPass, false);
  const inert = summarizeRole([{ ...ok, verdict: { pass: true, controls: controls(['docs']) } }]);
  assert.deepEqual(inert.ineffective.skills, ['docs']);
  assert.equal(inert.allControlsEffective, false);
  const noTurn = summarizeRole([ok, { ...ok, turns: { legacy: { status: 'failed' }, roleV1: { status: 'complete', promptTokens: 1 } } }]);
  assert.equal(noTurn.completePairs, 1);
  assert.equal(noTurn.allPairsPass, false);
});

await test('first-turn usage keeps only numbers and fails closed on missing fields', async () => {
  assert.deepEqual(parseFirstTurnUsage(JSON.stringify({ num_turns: 1, result: 'PRIVATE_TEXT', usage: { input_tokens: 2, cache_creation_input_tokens: 70000, cache_read_input_tokens: 448 } })),
    { status: 'complete', promptTokens: 70450, usage: { input: 2, cacheCreation: 70000, cacheRead: 448 } });
  assert.deepEqual(parseFirstTurnUsage(JSON.stringify({ num_turns: 1, usage: { input_tokens: 2 } })), { status: 'failed', failure: 'missing_usage' });
  assert.deepEqual(parseFirstTurnUsage(JSON.stringify({ num_turns: 2, usage: { input_tokens: 4, cache_creation_input_tokens: 1, cache_read_input_tokens: 1 } })), { status: 'failed', failure: 'not_single_request' });
  assert.deepEqual(parseFirstTurnUsage(JSON.stringify({ num_turns: 1, is_error: true, usage: { input_tokens: 2, cache_creation_input_tokens: 1, cache_read_input_tokens: 1 } })), { status: 'failed', failure: 'not_single_request' });
  assert.deepEqual(parseFirstTurnUsage('PRIVATE not json'), { status: 'failed', failure: 'malformed_result' });
  const argv = buildFirstTurnArgv({ model: 'm', effort: 'low', sessionId: 's', settings: { a: 1 }, noChrome: false });
  assert.deepEqual(argv.slice(0, 2), ['-p', 'Reply with exactly: OK']);
  assert.ok(argv.includes('--no-session-persistence'));
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'bypassPermissions');
});

await test('pairs differ only in settings and run interleaved for every role', async () => {
  const config = await import(pathToFileURL(join(root, 'packages/config/dist/index.js')));
  const launches = [];
  const turnsSeen = [];
  const FIXTURE_SKILLS = ['implement', 'onboarding', 'claude-api', 'gemini-image', 'docs'];
  const hiddenBy = (settings) => { const o = settings.skillOverrides ?? {}; return FIXTURE_SKILLS.filter((s) => o[s] === 'name-only'); };
  const probe = async (options) => {
    launches.push(options);
    const settings = JSON.parse(options.args[options.args.indexOf('--settings') + 1]);
    const hidden = hiddenBy(settings);
    return { status: 'complete', context: { knownFixedCategoryTokens: 5000 }, inventory: inventory(FIXTURE_SKILLS.map((name) => ({ name, tokens: hidden.includes(name) ? 2 : 10 })), [], []) };
  };
  const firstTurn = async (options) => { turnsSeen.push(options); return { status: 'complete', promptTokens: 1000 - 8 * hiddenBy(options.settings).length }; };
  const result = await runPrefixControls({ binary: '/fake/claude', cwd: '/tmp/flywheel-test-slot-9/p', model: 'm', effort: 'high',
    rounds: 2, probe, firstTurn, config, pinnedAgents: readPinnedAgents(root), claudeConfigDir: '/Users/fixture/.claude', env: {} });
  assert.deepEqual(Object.keys(result.roles), CONTROL_ROLES);
  assert.equal(launches.length, CONTROL_ROLES.length * 4);
  assert.equal(turnsSeen.length, CONTROL_ROLES.length * 4);
  for (let i = 0; i < launches.length; i += 2) {
    const strip = (a) => a.filter((_v, j) => a[j - 1] !== '--settings' && a[j - 1] !== '--session-id');
    assert.deepEqual(strip(launches[i].args), strip(launches[i + 1].args));
    assert.equal(launches[i].inventoryNames, true);
    const [legacySettings, slimSettings] = [launches[i], launches[i + 1]].map((l) => JSON.parse(l.args[l.args.indexOf('--settings') + 1]));
    assert.equal(legacySettings.skillOverrides, undefined);
    assert.equal(slimSettings.enabledPlugins['discord@flywheel-plugins'], false);
    assert.equal(turnsSeen[i].settings.skillOverrides, undefined);
    assert.deepEqual(turnsSeen[i + 1].settings, slimSettings);
  }
  for (const role of CONTROL_ROLES) {
    const summary = result.roles[role].summary;
    assert.equal(summary.allPairsPass, true, role);
    const expected = result.roles[role].hiddenSkillDescriptions.filter((s) => FIXTURE_SKILLS.includes(s)).length;
    assert.ok(expected >= 1, role);
    assert.equal(summary.deltaP50, 8 * expected, role);
  }
  const qaArgs = launches[CONTROL_ROLES.indexOf('qa') * 4].args;
  assert.equal(qaArgs.includes('--no-chrome'), false);
});

await test('probe children never inherit the caller runner identity or credentials', async () => {
  const env = lib.probeEnv({ HOME: '/h', PATH: '/bin', LANG: 'C.UTF-8', USER: 'u', FLYWHEEL_CALLBACK_PORT: '1', FLYWHEEL_CALLBACK_TOKEN: 't', FLYWHEEL_EXEC_ID: 'e',
    TEAMLEAD_API_TOKEN: 'x', GITHUB_TOKEN: 'g', FLYWHEEL_MARKER_DIR: '/tmp/flywheel/sessions', GOOGLE_APPLICATION_CREDENTIALS: '/c.json',
    SSH_AUTH_SOCK: '/s', AWS_PROFILE: 'p', GH_CONFIG_DIR: '/g', KUBECONFIG: '/k', NPM_CONFIG_USERCONFIG: '/n' });
  assert.deepEqual(env, { HOME: '/h', PATH: '/bin', LANG: 'C.UTF-8', USER: 'u', FLYWHEEL_MARKER_DIR: '/nonexistent/fly2913-probe-markers' });
  const seen = [];
  const config = await import(pathToFileURL(join(root, 'packages/config/dist/index.js')));
  await runPrefixControls({ binary: '/fake/claude', cwd: '/tmp/flywheel-test-slot-9/p', model: 'm', effort: 'high', rounds: 1, roles: ['qa'],
    probe: async (o) => { seen.push(o.env); return { status: 'complete', context: { knownFixedCategoryTokens: 1 }, inventory: inventory([], [], []) }; },
    firstTurn: async (o) => { seen.push(o.env); return { status: 'complete', promptTokens: 1 }; },
    config, pinnedAgents: readPinnedAgents(root), claudeConfigDir: '/Users/fixture/.claude', env: { HOME: '/h', FLYWHEEL_CALLBACK_TOKEN: 'secret' } });
  assert.equal(seen.length, 4);
  for (const e of seen) assert.deepEqual(e, { HOME: '/h', FLYWHEEL_MARKER_DIR: '/nonexistent/fly2913-probe-markers' });
});

await test('probe argv keeps the validated launcher shape', async () => {
  const argv = buildProbeArgv({ model: 'm', effort: 'high', sessionId: 's', settings: { a: 1 }, noChrome: true });
  assert.deepEqual(argv.slice(-5), ['{"a":1}', '--permission-mode', 'bypassPermissions', '--no-session-persistence', '--no-chrome']);
});

console.log(`${passed} prefix control fixture tests passed (no Claude/model/room launched)`);
NODE
