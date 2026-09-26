#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
node --input-type=module - "$REPO_ROOT" <<'NODE'
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { access, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const modulePath = join(process.argv[2], 'scripts/lib/qa-2913-context-probe.mjs');
assert.ok(await access(modulePath).then(() => true, () => false), 'bounded context probe helper exists');
const { probeClaudeContext } = await import(pathToFileURL(modulePath));
const slot = `/tmp/flywheel-test-slot-${process.pid}${Date.now()}`;
await mkdir(slot); // Test-owned filesystem fixture; never a room deployment.
const cwd = await mkdtemp(join(slot, 'probe-fixture-'));
const model = 'claude-test-model[1m]';
const settings = JSON.stringify({ enabledPlugins: {
  'discord@flywheel-plugins': false,
  'discord@claude-plugins-official': false,
}, env: { PRIVATE_SETTING: 'PRIVATE_SETTINGS_VALUE' } });
const args = () => ['--print', '--session-id', randomUUID(), '--model', model,
  '--effort', 'high', '--input-format', 'stream-json', '--output-format', 'stream-json',
  '--verbose', '--settings', settings, '--permission-mode', 'default', '--no-chrome'];
const context = () => ({ model, totalTokens: 12, categories: [
  { name: 'System prompt', tokens: 9, kind: 'used' },
  { name: 'MCP server instructions', tokens: 2, kind: 'used' },
  { name: 'Messages', tokens: 1, kind: 'used' },
  { name: 'MCP tools (deferred)', tokens: 4, kind: 'deferred', isDeferred: true },
], mcpTools: [{ name: 'mcp__fixture__read', serverName: 'fixture', tokens: 4, isLoaded: false,
  description: 'PRIVATE_TOOL_DESCRIPTION', config: { token: 'PRIVATE_TOKEN' } }],
  memoryFiles: [{ path: '/PRIVATE_ACCOUNT/rules.md', type: 'PRIVATE_TYPE', tokens: 2 }],
  agents: [{ agentType: 'PRIVATE_AGENT', source: 'PRIVATE_SOURCE', tokens: 1 }],
  skills: { totalSkills: 2, includedSkills: 1, tokens: 1,
    skillFrontmatter: [{ name: 'PRIVATE_SKILL', source: 'PRIVATE_SOURCE', tokens: 1 }] },
  systemPrompt: 'PRIVATE_SYSTEM_PROMPT', messages: ['PRIVATE_MESSAGE'],
});
const servers = (status = 'connected', toolName = 'read') => ({ mcpServers: [
  { name: 'fixture', status, tools: [{ name: toolName, description: 'PRIVATE_DESCRIPTION' }],
    config: { url: 'https://PRIVATE_URL', env: { token: 'PRIVATE_TOKEN' } },
    error: 'PRIVATE_ERROR', account: 'PRIVATE_ACCOUNT' },
] });

function fake(options = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.requests = [];
  child.kills = [];
  child.closed = false;
  child.close = (code = 0, signal = null) => {
    if (child.closed) return;
    child.closed = true;
    child.emit('exit', code, signal);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', code, signal);
  };
  child.reply = (request, response, extra = {}) => child.stdout.write(`${JSON.stringify({
    type: 'control_response', response: { subtype: 'success', request_id: request.request_id,
      response, ...extra },
  })}\n`);
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const request = JSON.parse(String(chunk));
    child.requests.push(request);
    queueMicrotask(() => {
      if (options.onRequest) return options.onRequest(request, child);
      const subtype = request.request.subtype;
      child.reply(request, subtype === 'mcp_status' ? servers() : subtype === 'get_context_usage' ? context() : {});
    });
    done();
  } });
  child.stdin.on('finish', () => {
    child.stdinEnded = true;
    if (options.closeOnEnd !== false) setImmediate(() => child.close(options.exitCode ?? 0));
  });
  child.kill = (signal) => {
    child.kills.push(signal);
    if (!options.ignoreKills && (signal === 'SIGKILL' || !options.ignoreTerm)) setImmediate(() => child.close(null, signal));
    return true;
  };
  child.spawn = (binary, launchArgs, launchOptions) => {
    child.launch = { binary, args: launchArgs, options: launchOptions };
    if (options.onSpawn) queueMicrotask(() => options.onSpawn(child));
    return child;
  };
  return child;
}
const run = (child, overrides = {}) => probeClaudeContext({ binary: '/fake/claude', args: args(), cwd,
  timeoutMs: 1000, controlTimeoutMs: 200, closeWaitMs: 10, pollIntervalMs: 1, ...overrides }, child.spawn);
const failed = (result, code) => {
  assert.equal(result.status, 'failed');
  assert.equal(result.failure, code);
  assert.equal(result.context, null);
  assert.equal(result.purpose, 'diagnostic-capability-only');
  assert.equal(result.roleBaseline, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|https:\/\/|\/fake\/|"env"|"config"/);
};
let passed = 0;
async function test(name, fn) { await fn(); console.log(`PASS ${name}`); passed++; }
try {
  await test('uses only ordered SDK controls, preserves launcher and environment, waits for child close', async () => {
    const child = fake();
    const launchArgs = args();
    const env = { ...process.env, PRIVATE_AUTH: 'PRIVATE_AUTH_VALUE' };
    const result = await run(child, { args: launchArgs, env });
    assert.equal(result.status, 'complete');
    assert.equal(result.purpose, 'diagnostic-capability-only');
    assert.equal(result.roleBaseline, false);
    assert.deepEqual(child.requests.map(r => r.request.subtype), ['initialize', 'mcp_status', 'get_context_usage', 'mcp_status']);
    assert.deepEqual(child.requests[2].request, { subtype: 'get_context_usage', detail: 'full' });
    assert.ok(child.requests.every(r => r.type === 'control_request' && typeof r.request_id === 'string'));
    assert.equal(new Set(child.requests.map(r => r.request_id)).size, child.requests.length);
    assert.deepEqual(child.launch.args, launchArgs);
    assert.strictEqual(child.launch.options.env, env);
    assert.equal(child.launch.options.cwd, await realpath(cwd));
    assert.equal(child.launch.options.shell, false);
    assert.equal(child.launch.options.detached, false);
    assert.equal(child.closed, true);
    assert.deepEqual(child.kills, []);
    assert.equal(result.cleanup.closed, true);
    assert.equal(result.context.knownFixedCategoryTokens, 11);
    assert.equal(result.context.fixedPrefixTokens, null);
    assert.equal(result.context.systemTools, null);
    assert.equal(result.context.deferredBuiltinTools, null);
    assert.equal(result.protocol.requests, 4);
    assert.equal(result.protocol.responses, 4);
  });

  await test('preserves xhigh effort used by current Claude reviewers', async () => {
    const child = fake();
    const reviewerArgs = args().map(value => value === 'high' ? 'xhigh' : value);
    const result = await run(child, { args: reviewerArgs });
    assert.equal(result.status, 'complete');
    assert.deepEqual(child.launch.args, reviewerArgs);
  });

  await test('polls pending servers until terminal before collecting context', async () => {
    let polls = 0;
    const child = fake({ onRequest(request, c) {
      const kind = request.request.subtype;
      if (kind === 'mcp_status') c.reply(request, servers(++polls < 3 ? 'pending' : 'connected'));
      else c.reply(request, kind === 'get_context_usage' ? context() : {});
    } });
    const result = await run(child);
    assert.equal(result.status, 'complete');
    assert.deepEqual(child.requests.map(r => r.request.subtype), ['initialize', 'mcp_status', 'mcp_status', 'mcp_status', 'get_context_usage', 'mcp_status']);
    assert.equal(result.protocol.pendingPolls, 2);
  });

  for (const state of ['failed', 'disconnected', 'needs-auth', 'disabled']) {
    await test(`reports stable ${state} servers as incomplete diagnostic`, async () => {
      const child = fake({ onRequest(r, c) { c.reply(r, r.request.subtype === 'mcp_status' ? servers(state) : r.request.subtype === 'get_context_usage' ? context() : {}); } });
      const result = await run(child);
      assert.equal(result.status, 'incomplete');
      assert.equal(result.failure, 'mcp_not_connected');
      assert.equal(result.mcpServers[0].status, state);
      assert.ok(result.context);
      assert.equal(child.closed, true);
    });
  }

  await test('rejects changed server/tool fingerprints and discards partial context', async () => {
    let polls = 0;
    const child = fake({ onRequest(r, c) { c.reply(r, r.request.subtype === 'mcp_status' ? servers('connected', ++polls === 1 ? 'read' : 'write') : r.request.subtype === 'get_context_usage' ? context() : {}); } });
    const result = await run(child);
    failed(result, 'unstable_mcp');
    assert.notEqual(result.mcpFingerprintBefore, result.mcpFingerprintAfter);
  });

  await test('retains names and numeric diagnostics while dropping all raw/context/config/account text', async () => {
    const child = fake({ onSpawn(c) { c.stderr.write('PRIVATE_STDERR\n'); } });
    const result = await run(child);
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.mcpServers, [{ name: 'fixture', status: 'connected', tools: [{ name: 'read' }] }]);
    assert.equal(result.context.mcpTools[0].name, 'mcp__fixture__read');
    assert.equal(result.stderr.bytes, Buffer.byteLength('PRIVATE_STDERR\n'));
    assert.equal(result.stderr.sha256, createHash('sha256').update('PRIVATE_STDERR\n').digest('hex'));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|https:\/\/|"path"|"source"|"env"|"config"|"account"/);
  });

  const invalidArgs = [
    a => [...a, '--resume', randomUUID()], a => [...a, '--continue'], a => [...a, 'PRIVATE_PROMPT'],
    a => a.filter((_, i) => i !== a.indexOf('--model') && i !== a.indexOf('--model') + 1),
    a => a.filter((_, i) => i !== a.indexOf('--effort') && i !== a.indexOf('--effort') + 1),
    a => a.filter(v => v !== '--verbose'), a => a.map(v => v === 'stream-json' ? 'json' : v),
    a => [...a, '--model', model], a => a.map(v => v === settings ? '{}' : v),
    a => a.map(v => v === settings ? settings.replace('false', 'true') : v),
    a => a.map(v => v === settings ? '/PRIVATE_SETTINGS_FILE' : v),
    a => a.map(v => /^[a-f0-9-]{36}$/.test(v) ? 'old-session' : v),
  ];
  await test('rejects resume, prompts, duplicate or missing controls and absent Discord denies before spawn', async () => {
    for (const alter of invalidArgs) {
      const child = fake();
      failed(await run(child, { args: alter(args()) }), 'invalid_launcher');
      assert.equal(child.launch, undefined);
    }
  });

  await test('requires a fresh session UUID within this collector process', async () => {
    const launchArgs = args();
    assert.equal((await run(fake(), { args: launchArgs })).status, 'complete');
    const child = fake();
    failed(await run(child, { args: launchArgs }), 'session_reused');
    assert.equal(child.launch, undefined);
  });

  await test('rejects non-slot cwd, nonexistent cwd and symlink escape without spawning or creating directories', async () => {
    const link = join(cwd, 'escape');
    await symlink('/tmp', link);
    for (const location of ['/tmp', join(cwd, 'missing'), link]) {
      const child = fake();
      failed(await run(child, { cwd: location }), 'invalid_cwd');
      assert.equal(child.launch, undefined);
    }
    assert.equal(await access(join(cwd, 'missing')).then(() => true, () => false), false);
  });

  await test('control timeout ends stdin then escalates only its own child to SIGKILL', async () => {
    const child = fake({ onRequest() {}, closeOnEnd: false, ignoreTerm: true });
    failed(await run(child, { controlTimeoutMs: 10 }), 'control_timeout');
    assert.equal(child.stdinEnded, true);
    assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
    assert.equal(child.closed, true);
  });

  await test('overall deadline bounds indefinitely pending MCP polls', async () => {
    const child = fake({ onRequest(r, c) { c.reply(r, r.request.subtype === 'mcp_status' ? servers('pending') : {}); } });
    failed(await run(child, { timeoutMs: 25, controlTimeoutMs: 200 }), 'overall_timeout');
    assert.ok(child.requests.every(r => r.request.subtype !== 'get_context_usage'));
    assert.equal(child.closed, true);
  });

  await test('stdout EOF alone is not child cleanup evidence', async () => {
    const child = fake({ closeOnEnd: false, ignoreTerm: true });
    child.stdin.on('finish', () => child.stdout.end());
    const result = await run(child);
    failed(result, 'cleanup_required_kill');
    assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
    assert.equal(result.cleanup.closed, true);
  });

  await test('reports unconfirmed cleanup after bounded SIGKILL wait', async () => {
    const child = fake({ onRequest() {}, closeOnEnd: false, ignoreKills: true });
    const result = await run(child, { controlTimeoutMs: 10 });
    failed(result, 'cleanup_unconfirmed');
    assert.equal(result.cleanup.closed, false);
    assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
    child.close(null, 'SIGKILL');
  });

  const failures = [
    ['spawn_error', { onSpawn(c) { c.emit('error', new Error('PRIVATE_SPAWN_ERROR')); c.close(-2); } }],
    ['nonzero_exit', { exitCode: 9 }],
    ['malformed_response', { onRequest(_r, c) { c.stdout.write('PRIVATE_MALFORMED\n'); } }],
    ['missing_request_id', { onRequest(r, c) { c.reply(r, {}, { request_id: undefined }); } }],
    ['unexpected_request_id', { onRequest(r, c) { c.reply(r, {}, { request_id: 'PRIVATE_UNKNOWN_ID' }); } }],
    ['control_error', { onRequest(r, c) { c.reply(r, {}, { subtype: 'error', error: 'PRIVATE_ERROR' }); } }],
    ['unexpected_turn', { onRequest(_r, c) { c.stdout.write(JSON.stringify({ type: 'user', message: 'PRIVATE_USER_TURN' }) + '\n'); } }],
    ['unexpected_model', { onRequest(r, c) { c.reply(r, r.request.subtype === 'mcp_status' ? servers() : r.request.subtype === 'get_context_usage' ? { ...context(), model: 'PRIVATE_WRONG_MODEL' } : {}); } }],
    ['invalid_context', { onRequest(r, c) { c.reply(r, r.request.subtype === 'mcp_status' ? servers() : r.request.subtype === 'get_context_usage' ? { ...context(), totalTokens: 999 } : {}); } }],
    ['stdout_limit', { onRequest(_r, c) { c.stdout.write('x'.repeat(1024 * 1024 + 1)); } }],
  ];
  for (const [reason, options] of failures) await test(`${reason} is explicit, sanitized and closes child`, async () => {
    const child = fake(options);
    failed(await run(child), reason);
    assert.equal(child.closed, true);
  });

  await test('FLY-2913 counts SessionStart hook frames without keeping their output', async () => {
    const hookFrame = (subtype) => JSON.stringify({ type: 'system', subtype, hook_id: 'h1', hook_name: 'SessionStart:startup',
      hook_event: 'SessionStart', output: 'PRIVATE_HOOK_OUTPUT', stdout: 'PRIVATE_HOOK_STDOUT', session_id: 'x' }) + '\n';
    const child = fake({ onSpawn(c) { c.stdout.write(hookFrame('hook_started')); c.stdout.write(hookFrame('hook_response')); },
      onRequest(r, c) {
        if (r.request.subtype === 'initialize') c.stdout.write(hookFrame('hook_progress'));
        c.reply(r, r.request.subtype === 'mcp_status' ? servers() : r.request.subtype === 'get_context_usage' ? context() : {});
      } });
    const result = await run(child);
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.protocol.hookFrames, { hook_started: 1, hook_progress: 1, hook_response: 1 });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  });

  await test('FLY-2913 still rejects other system frames', async () => {
    const child = fake({ onSpawn(c) { c.stdout.write(JSON.stringify({ type: 'system', subtype: 'PRIVATE_UNKNOWN' }) + '\n'); } });
    failed(await run(child), 'malformed_response');
  });

  await test('FLY-2913 opt-in inventory emits only item names, source kinds, basenames and tokens', async () => {
    const withNames = () => ({ ...context(),
      memoryFiles: [{ path: '/PRIVATE_ACCOUNT/.claude/rules/gog.md', type: 'User', tokens: 2 }],
      agents: [{ agentType: 'belle-lead', source: 'userSettings', tokens: 1, description: 'PRIVATE_AGENT_TEXT' }],
      skills: { totalSkills: 2, includedSkills: 1, tokens: 1,
        skillFrontmatter: [{ name: 'everything-claude-code:go-test', source: 'plugin', tokens: 1, description: 'PRIVATE_SKILL_TEXT' }] } });
    const child = fake({ onRequest(r, c) {
      c.reply(r, r.request.subtype === 'mcp_status' ? servers() : r.request.subtype === 'get_context_usage' ? withNames() : {});
    } });
    const result = await run(child, { inventoryNames: true });
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.inventory, {
      skills: [{ name: 'everything-claude-code:go-test', source: 'plugin', tokens: 1 }],
      agents: [{ name: 'belle-lead', source: 'userSettings', tokens: 1 }],
      memoryFiles: [{ file: 'gog.md', type: 'User', tokens: 2 }],
    });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|https:\/\/|"path"|"env"|"config"|"description"/);
    const plain = await run(fake());
    assert.equal(plain.inventory, undefined);
  });

  await test('FLY-2913 opt-in inventory fails closed on an unsafe item name', async () => {
    const bad = () => ({ ...context(), agents: [{ agentType: 'bad name; rm', source: 'userSettings', tokens: 1 }] });
    const child = fake({ onRequest(r, c) {
      c.reply(r, r.request.subtype === 'mcp_status' ? servers() : r.request.subtype === 'get_context_usage' ? bad() : {});
    } });
    failed(await run(child, { inventoryNames: true }), 'invalid_context');
  });

  await test('parses split UTF-8 JSON lines and ignores source/tool ordering in fingerprint', async () => {
    let polls = 0;
    const child = fake({ onRequest(r, c) {
      const response = r.request.subtype === 'mcp_status'
        ? { mcpServers: [{ name: 'claude.ai Claude Docs', status: 'connected', tools: ++polls === 1 ? [{ name: 'read' }, { name: 'write' }] : [{ name: 'write' }, { name: 'read' }] }] }
        : r.request.subtype === 'get_context_usage' ? context() : { ignored: '字 PRIVATE_INIT' };
      const bytes = Buffer.from(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: r.request_id, response } }) + '\n');
      for (let i = 0; i < bytes.length; i += 7) c.stdout.write(bytes.subarray(i, i + 7));
    } });
    assert.equal((await run(child)).status, 'complete');
  });
  console.log(`${passed} context probe fixture tests passed (no Claude/model/room launched)`);
} finally {
  await rm(slot, { recursive: true, force: true });
}
NODE
