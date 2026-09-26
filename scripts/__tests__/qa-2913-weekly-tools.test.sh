#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
node --input-type=module - "$REPO_ROOT" <<'NODE'
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const modulePath = join(process.argv[2], 'scripts/lib/qa-2913-weekly-tools.mjs');
assert.ok(await access(modulePath).then(() => true, () => false), 'weekly metadata collector exists');
const { collectWeeklyToolUse, readWeeklyToolManifest } = await import(pathToFileURL(modulePath));
const dir = await mkdtemp(join(tmpdir(), 'fly2913-weekly-'));
const cutoff = '2026-09-25T12:00:00.000Z';
const inside = '2026-09-24T12:00:00.000Z';
const entry = (path, extra = {}) => ({ path, sessionId: 'session-a', role: 'implement', vendor: 'claude', subagent: false, ...extra });
const manifest = (...transcripts) => ({ version: 1, transcripts });
const tool = (id, name = 'Read', input = {}) => ({ type: 'tool_use', id, name, input });
const assistant = (id, blocks, timestamp = inside, sessionId = 'session-a') => ({
  type: 'assistant', sessionId, timestamp, message: { id, role: 'assistant', content: blocks },
});
const file = async (name, rows) => {
  const path = join(dir, name);
  await writeFile(path, rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n');
  return path;
};
const run = (sources, extra = {}) => collectWeeklyToolUse({ manifest: manifest(...sources), cutoff, ...extra });
let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`PASS ${name}`);
}

try {
  await test('deduplicates repeated streamed assistant chunks using all three identity fields', async () => {
    const path = await file('chunks.jsonl', [
      assistant('m1', [tool('t1'), { type: 'text', text: 'PRIVATE_PROMPT' }]),
      assistant('m1', [tool('t1'), tool('t2', 'Grep')]),
      assistant('m2', [tool('t1')]),
      { type: 'progress', timestamp: inside, data: { message: assistant('nested', [tool('nested-tool', 'Write')]) } },
      { type: 'user', timestamp: inside, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'PRIVATE_RESULT' }] } },
    ]);
    const other = await file('other-session.jsonl', [assistant('m1', [tool('t1')], inside, 'session-b')]);
    const result = await run([entry(path), entry(other, { sessionId: 'session-b' })], { chunkBytes: 7 });
    assert.equal(result.totalCalls, 4);
    assert.equal(result.diagnostics.duplicateCalls, 1);
    assert.equal(result.inputCount, 2);
    assert.equal(result.counts.find(row => row.tool === 'Read').calls, 3);
    assert.equal(result.counts.find(row => row.tool === 'Grep').calls, 1);
  });

  await test('includes exact start and excludes exact cutoff over seven times 24 hours', async () => {
    const path = await file('boundaries.jsonl', [
      assistant('before', [tool('a')], '2026-09-18T11:59:59.999Z'),
      assistant('start', [tool('b')], '2026-09-18T12:00:00.000Z'),
      assistant('last', [tool('c')], '2026-09-25T11:59:59.999Z'),
      assistant('end', [tool('d')], cutoff),
    ]);
    const result = await run([entry(path)]);
    assert.deepEqual(result.window, { startInclusive: '2026-09-18T12:00:00.000Z', endExclusive: cutoff });
    assert.equal(result.totalCalls, 2);
    assert.equal(result.diagnostics.outsideWindowCalls, 2);
  });

  await test('retains only canonical Skill name and drops arguments, prompts and result bodies', async () => {
    const path = await file('skills.jsonl', [
      assistant('m1', [tool('s1', 'Skill', { skill: 'superpowers:writing-plans', args: 'PRIVATE_ARGUMENT' }), tool('b1', 'Bash', { command: 'PRIVATE_COMMAND' })]),
      assistant('m2', [tool('s2', 'Skill', { skill: 'superpowers:writing-plans PRIVATE_INLINE' })]),
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'PRIVATE_RESULT' }, { type: 'text', text: 'PRIVATE_PROMPT' }] } },
    ]);
    const result = await run([entry(path)]);
    assert.equal(result.totalCalls, 3);
    assert.equal(result.counts.find(row => row.skill === 'superpowers:writing-plans').calls, 1);
    assert.equal(result.counts.find(row => row.tool === 'Skill' && row.skill === null).calls, 1);
    assert.equal(result.diagnostics.invalidSkillNames, 1);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|"input"|"arguments"|"content"|"command"/);
  });

  await test('keeps main, subagent, review vendor and review type in distinct buckets', async () => {
    const sources = [];
    const metas = [
      { role: 'design', subagent: false }, { role: 'design', subagent: true },
      { role: 'review-design', reviewType: 'design' }, { role: 'review-code', reviewType: 'code' },
      { role: 'review-code', reviewType: 'code', vendor: 'codex' },
    ];
    for (const [i, meta] of metas.entries()) {
      const sessionId = `session-${i}`;
      const record = meta.vendor === 'codex'
        ? { type: 'response_item', timestamp: inside, payload: { type: 'function_call', assistant_message_id: 'm1', call_id: 't1', name: 'exec_command', arguments: 'PRIVATE_CODEX' } }
        : assistant('m1', [tool('t1')], inside, sessionId);
      sources.push(entry(await file(`role-${i}.jsonl`, [record]), { ...meta, sessionId }));
    }
    const result = await run(sources);
    assert.equal(result.totalCalls, 5);
    assert.equal(result.counts.length, 5);
    assert.equal(result.counts.filter(row => row.scope === 'subagent').length, 1);
    assert.equal(result.counts.filter(row => row.reviewType === 'code').length, 2);
    assert.equal(result.counts.find(row => row.vendor === 'codex').tool, 'exec_command');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CODEX/);
  });

  await test('reports unknown role, missing, unreadable, no-call, duplicate and malformed inputs separately', async () => {
    const unknown = await file('unknown.jsonl', [assistant('m1', [tool('t1')])]);
    const empty = await file('no-calls.jsonl', [{ type: 'user', message: { content: 'PRIVATE_TEXT' } }]);
    const malformed = await file('malformed.jsonl', ['{ broken PRIVATE_JSON', assistant('m2', [tool('t2')], 'bad-time'), assistant('m3', [tool('t3')], inside, 'different-session')]);
    const directory = join(dir, 'not-a-file');
    await mkdir(directory);
    const sources = [entry(unknown, { role: 'guess-implement-from-path' }), entry(join(dir, 'missing.jsonl')), entry(directory), entry(empty), entry(malformed), entry(empty)];
    const result = await run(sources);
    assert.equal(result.inputCount, 6);
    assert.equal(result.totalCalls, 1);
    assert.equal(result.counts[0].role, 'unattributed');
    for (const key of ['missingInputs', 'unreadableInputs', 'duplicateInputs', 'noCallInputs', 'unattributedInputs', 'unattributedCalls', 'malformedRecords', 'sessionMismatchRecords']) {
      assert.equal(result.diagnostics[key], 1, key);
    }
    assert.equal(result.diagnostics.malformedCalls, 1);
    assert.equal(result.inputs[4].status, 'partial');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|guess-implement/);
  });

  await test('does not invent assistant-message identities for native Codex call records', async () => {
    const path = await file('codex.jsonl', [{ type: 'response_item', timestamp: inside, payload: { type: 'function_call', call_id: 'call_a', name: 'exec_command', arguments: 'PRIVATE' } }]);
    const result = await run([entry(path, { vendor: 'codex' })]);
    assert.equal(result.totalCalls, 0);
    assert.equal(result.diagnostics.unsupportedCalls, 1);
    assert.equal(result.diagnostics.noCallInputs, 0);
    assert.equal(result.inputs[0].status, 'partial');
    assert.match(result.limitations.join(' '), /Codex.*assistant.*message/i);
  });

  await test('marks malformed Claude assistant envelopes partial while retaining valid text-only no-call inputs', async () => {
    const malformed = [
      assistant('m1', tool('t1', 'Bash', { command: 'PRIVATE_MALFORMED' })),
      { type: 'assistant', timestamp: inside },
      { type: 'assistant', timestamp: inside, message: { id: 'm2' } },
      assistant('m3', 'PRIVATE_TEXT'),
      assistant('m4', null),
    ];
    const sources = [];
    for (const [i, record] of malformed.entries()) {
      sources.push(entry(await file(`malformed-assistant-${i}.jsonl`, [record])));
    }
    sources.push(entry(await file('valid-assistant-text.jsonl', [
      assistant('text', [{ type: 'text', text: 'PRIVATE_VALID_TEXT' }]),
      assistant('empty', []),
    ])));
    const result = await run(sources);
    assert.equal(result.totalCalls, 0);
    assert.equal(result.diagnostics.malformedRecords, malformed.length);
    assert.equal(result.diagnostics.noCallInputs, 1);
    assert.ok(result.inputs.slice(0, -1).every(row => row.status === 'partial' && row.malformedRecords === 1));
    assert.equal(result.inputs.at(-1).status, 'no_calls');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  });

  await test('marks malformed Codex response-item envelopes partial while retaining valid text and result inputs', async () => {
    const malformed = [undefined, null, [], 'PRIVATE_PAYLOAD', {}, { type: 1 }];
    const sources = [];
    for (const [i, payload] of malformed.entries()) {
      sources.push(entry(await file(`malformed-codex-${i}.jsonl`, [{ type: 'response_item', timestamp: inside, payload }]), { vendor: 'codex' }));
    }
    sources.push(entry(await file('valid-codex-text.jsonl', [
      { type: 'response_item', timestamp: inside, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'PRIVATE_CODEX_TEXT' }] } },
      { type: 'response_item', timestamp: inside, payload: { type: 'function_call_output', call_id: 't1', output: 'PRIVATE_CODEX_RESULT' } },
    ]), { vendor: 'codex' }));
    const result = await run(sources);
    assert.equal(result.totalCalls, 0);
    assert.equal(result.diagnostics.malformedRecords, malformed.length);
    assert.equal(result.diagnostics.noCallInputs, 1);
    assert.ok(result.inputs.slice(0, -1).every(row => row.status === 'partial' && row.malformedRecords === 1));
    assert.equal(result.inputs.at(-1).status, 'no_calls');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  });

  await test('marks invalid Claude content blocks partial without rejecting valid typed blocks', async () => {
    const malformed = [null, 1, false, 'PRIVATE_BLOCK', [], {}, { text: 'PRIVATE_MISSING_TYPE' }, { type: null }, { type: 1 }, { type: '' }, { type: ' ' }];
    const sources = [];
    for (const [i, block] of malformed.entries()) {
      sources.push(entry(await file(`malformed-block-${i}.jsonl`, [assistant(`m${i}`, [block])])));
    }
    const textBlocks = [
      { type: 'text', text: 'PRIVATE_TEXT_BLOCK' },
      { type: 'thinking', thinking: 'PRIVATE_THINKING' },
      { type: 'redacted_thinking', data: 'PRIVATE_REDACTED' },
    ];
    sources.push(entry(await file('valid-other-blocks.jsonl', [assistant('valid-text', textBlocks)])));
    sources.push(entry(await file('valid-tool-blocks.jsonl', [assistant('valid-tool', [...textBlocks, tool('valid-call')])])));
    const result = await run(sources);
    assert.equal(result.totalCalls, 1);
    assert.equal(result.diagnostics.malformedRecords, malformed.length);
    assert.equal(result.diagnostics.noCallInputs, 1);
    assert.ok(result.inputs.slice(0, -2).every(row => row.status === 'partial' && row.malformedRecords === 1));
    assert.equal(result.inputs.at(-2).status, 'no_calls');
    assert.equal(result.inputs.at(-1).status, 'counted');
    assert.equal(result.counts[0].tool, 'Read');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  });

  await test('preserves explicit review metadata without guessing an unknown role or scope', async () => {
    const path = await file('unattributed-review.jsonl', [assistant('m1', [tool('t1')])]);
    const result = await run([entry(path, { role: 'unknown-reviewer', reviewType: 'code', subagent: null })]);
    assert.equal(result.totalCalls, 1);
    assert.equal(result.counts[0].role, 'unattributed');
    assert.equal(result.counts[0].scope, 'unattributed');
    assert.equal(result.counts[0].reviewType, 'code');
    assert.equal(result.diagnostics.unattributedCalls, 1);
    await assert.rejects(run([entry(path, { role: 'review-code', reviewType: 'design' })]), /reviewType/i);
  });

  await test('reports unsupported tool-call shapes as partial rather than no calls', async () => {
    const codex = await file('unsupported-codex.jsonl', [{ type: 'response_item', timestamp: inside, payload: { type: 'web_search_call', id: 'w1', action: { query: 'PRIVATE_SEARCH' } } }]);
    const claude = await file('unsupported-claude.jsonl', [assistant('m1', [{ type: 'server_tool_use', id: 't1', name: 'web_search', input: { query: 'PRIVATE_SEARCH' } }])]);
    const result = await run([entry(codex, { vendor: 'codex' }), entry(claude)]);
    assert.equal(result.totalCalls, 0);
    assert.equal(result.diagnostics.unsupportedCalls, 2);
    assert.equal(result.diagnostics.noCallInputs, 0);
    assert.ok(result.inputs.every(row => row.status === 'partial'));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SEARCH/);
  });

  await test('bounds line buffering and continues after an oversized record', async () => {
    const path = await file('large.jsonl', ['x'.repeat(4096), assistant('m1', [tool('t1')])]);
    const result = await run([entry(path)], { maxLineBytes: 1024, chunkBytes: 13 });
    assert.equal(result.totalCalls, 1);
    assert.equal(result.diagnostics.oversizedRecords, 1);
    assert.equal(result.diagnostics.malformedRecords, 1);
    assert.equal(result.inputs[0].status, 'partial');
  });

  await test('requires explicit manifest paths and cutoff and never expands globs or homes', async () => {
    for (const path of ['*.jsonl', '/tmp/**/session.jsonl', '~/sessions/a.jsonl', '../a.jsonl', 'file:///tmp/a.jsonl', '', '/tmp/a\n.jsonl']) {
      await assert.rejects(run([entry(path)]), /explicit.*path/i);
    }
    await assert.rejects(run([], { cutoff: undefined }), /cutoff/i);
    await assert.rejects(run([], { cutoff: '2026-09-25' }), /cutoff/i);
    await assert.rejects(run([], { cutoff: '2026-02-30T12:00:00.000Z' }), /cutoff/i);
    await assert.rejects(run([], { manifest: { version: 1, transcripts: '*.jsonl' } }), /manifest/i);
    await assert.rejects(readWeeklyToolManifest('*.json'), /explicit.*path/i);
    const transcript = await file('relative.jsonl', [assistant('m1', [tool('t1')])]);
    const manifestPath = join(dir, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest(entry('relative.jsonl'))));
    const loaded = await readWeeklyToolManifest(manifestPath);
    assert.equal(loaded.transcripts[0].path, transcript);
    assert.equal((await collectWeeklyToolUse({ manifest: loaded, cutoff })).totalCalls, 1);
  });
  console.log(`PASS ${passed} weekly collector checks`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
NODE
