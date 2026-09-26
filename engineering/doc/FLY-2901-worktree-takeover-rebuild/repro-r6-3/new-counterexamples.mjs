import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runTakeoverTransaction } from './worktree-takeover-transaction.ts';
import { SnapshotHarness } from './snapshot-extracted.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const safe = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', '-c', 'core.sshCommand=false', '-c', 'core.askpass=false', '-c', 'protocol.ext.allow=never'];
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
const nul = s => s.split('\0').filter(Boolean);
function git(cwd, ...args) {
  return execFileSync('git', [...safe, '-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function put(root, rel, contents) {
  const dest = path.join(root, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, contents);
}
const norm = p => p.replace(/\/$/, '');
const below = (p, root) => norm(p) === norm(root) || norm(p).startsWith(norm(root) + '/');
const overlaps = (a, b) => below(a, b) || below(b, a);

// Literal model of plan blob 89260d6b2c84c8795ed1f1b74c8780d866b49f33 §4.7a, not a production implementation.
function planGuard(wt, H, target) {
  const I = nul(git(wt, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'));
  if (I.length === 0) return { allowed: true, I };
  const records = nul(git(wt, 'ls-tree', '-r', '-z', target)).map(row => {
    const tab = row.indexOf('\t');
    const [mode, type, oid] = row.slice(0, tab).split(' ');
    return { mode, type, oid, name: row.slice(tab + 1) };
  });
  const P = records.map(r => r.name);
  let ignoreCase = false;
  try { ignoreCase = git(wt, 'config', '--bool', '--get', 'core.ignorecase').trim() === 'true'; } catch {}
  const fold = p => ignoreCase ? p.toLowerCase() : p;
  const collision = I.filter(i => P.some(p => overlaps(fold(i), fold(p))));
  const G = [...new Set([...P, ...nul(git(wt, 'ls-files', '-z', '--cached')), ...nul(git(wt, 'ls-files', '-z', '--others', '--exclude-standard'))].filter(p => p.split('/').at(-1) === '.gitignore'))];
  const ignoreComparisons = G.map(g => {
    let current = null;
    try { if (fs.lstatSync(path.join(wt, g)).isFile()) current = git(wt, 'hash-object', '--no-filters', '--', g).trim(); }
    catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
    const targetOid = records.find(r => r.name === g)?.oid ?? null;
    return { path: g, current, target: targetOid, changed: current !== targetOid };
  });
  const ignoreChanged = ignoreComparisons.filter(x => x.changed).map(x => x.path);
  return { allowed: collision.length === 0 && ignoreChanged.length === 0, I, P, collision, G, ignoreCase, ignoreChanged, ignoreComparisons };
}

async function runCase(c) {
  const root = fs.mkdtempSync(path.join(here, c.name + '-'));
  const main = path.join(root, 'main'), origin = path.join(root, 'origin.git'), wt = path.join(root, 'shared');
  fs.mkdirSync(main); fs.mkdirSync(origin);
  git(origin, 'init', '--bare', '-q', '-b', 'main');
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.name', 'Scoped Design Review');
  git(main, 'config', 'user.email', 'review@example.invalid');
  if (c.ignoreCase) git(main, 'config', 'core.ignorecase', 'true');
  put(main, c.ignoreName ?? '.gitignore', c.hIgnore ?? '# base\n');
  if (c.excludesFile) put(main, 'project.ignore', 'drafts/\n');
  if (c.fileToDir) put(main, 'drafts', 'TRACKED FILE IN H\n');
  put(main, 'tracked', 'base\n');
  // Keep ls-files from coalescing the whole untracked .flywheel parent.
  put(main, '.flywheel/anchor', 'tracked anchor\n');
  git(main, 'add', '.'); git(main, 'commit', '-qm', 'H');
  const H = git(main, 'rev-parse', 'HEAD').trim();
  if (!c.sameHead) {
    put(main, 'tracked', 'target\n');
    if (c.sIgnore !== undefined) put(main, c.ignoreName ?? '.gitignore', c.sIgnore);
    if (c.excludesFile) put(main, 'project.ignore', '# ignore rule removed\n');
    git(main, 'add', '.');
    if (c.trackVictim) { const trackedPath = c.targetFile ?? c.file; put(main, trackedPath, 'TARGET CONTENT\n'); git(main, 'add', '-f', trackedPath); }
    git(main, 'commit', '-qm', 'S');
  }
  const S = git(main, 'rev-parse', 'HEAD').trim(), target = c.sameHead ? H : S;
  const branch = 'flywheel-FLY-2901';
  git(main, 'worktree', 'add', '-qb', branch, wt, H);
  git(main, 'remote', 'add', 'origin', origin);
  git(main, 'push', '-q', 'origin', 'main', branch);
  if (c.excludesFile) git(main, 'config', 'core.excludesFile', path.join(wt, 'project.ignore'));
  const marker = git(wt, 'rev-parse', '--path-format=absolute', '--git-path', 'flywheel-generation').trim();
  fs.writeFileSync(marker, 'generation-review\n');
  const exclude = git(main, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude').trim();
  function ensureExcludes() {
    let s = fs.readFileSync(exclude, 'utf8');
    for (const rule of ['.flywheel/runs/', '.flywheel/review-targets/']) if (!s.split('\n').includes(rule)) s += '\n' + rule + '\n';
    fs.writeFileSync(exclude, s);
    const check = fs.readFileSync(exclude, 'utf8').split('\n');
    assert(check.includes('.flywheel/runs/') && check.includes('.flywheel/review-targets/'));
  }
  ensureExcludes();
  if (c.localIgnore !== undefined) put(wt, '.gitignore', c.localIgnore);
  if (c.stageIgnore) git(wt, 'add', '.gitignore');
  if (c.untrackIgnore) git(wt, 'rm', '--cached', '.gitignore');
  if (c.dirtyTracked) put(wt, 'tracked', 'ordinary dirty bytes\n');
  const original = 'UNIQUE LOCAL WORK NEVER COMMITTED: ' + c.name + '\n';
  if (c.fileToDir) fs.unlinkSync(path.join(wt, 'drafts'));
  put(wt, c.file, original);
  const beforeStatus = git(wt, 'status', '--porcelain=v2', '-z', '--untracked-files=all');
  const ignoredBefore = nul(git(wt, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard'));
  const checkIgnore = git(wt, 'check-ignore', '--no-index', '-v', '--', c.file).trim();
  assert(ignoredBefore.includes(c.file), `${c.name}: flat ls-files must see ignored victim`);
  const blob = execFileSync('git', ['hash-object', '--stdin'], { input: original, encoding: 'utf8', env }).trim();
  const guards = [{ phase: 'before-any-rescue-write', ...planGuard(wt, H, target) }];
  if (c.fileToDir) assert.deepEqual(guards[0].I, [], '--directory listing misses ignored content beneath an index file replaced by a directory');
  const events = [], steps = [];
  let snapshotCalls = 0, outcome;
  if (!guards[0].allowed) {
    assert.equal(c.expected, 'blocked');
    outcome = { kind: 'refused-by-plan-model', reason: 'ignored_content_at_risk' };
  } else {
    assert.notEqual(c.expected, 'blocked');
    const exec = async (cmd, args, cwd, options = {}) => ({ stdout: execFileSync(cmd, args, {
      cwd, env: { ...env, ...options.env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
    }) });
    const snap = new SnapshotHarness(exec);
    const host = {
      git: async (args, cwd, options = {}) => {
        // Every fixture has nestedMoves=[]; this is the first destructive operation.
        if (args.includes('reset') && args.includes('--hard')) {
          const guard = { phase: 'before-destructive-reset', ...planGuard(wt, H, target) };
          guards.push(guard);
          assert(guard.allowed, `${c.name}: unexpected second-gate refusal`);
        }
        return (await exec('git', [...safe, ...args], cwd, options)).stdout;
      },
      lockAvailable: true,
      expected: () => ({ path: wt, branch }),
      listRegistered: async () => git(main, 'worktree', 'list', '--porcelain').trim().split('\n\n').map(block => {
        const lines = block.split('\n');
        return { path: lines.find(s => s.startsWith('worktree ')).slice(9), branch: lines.find(s => s.startsWith('branch '))?.slice(7) ?? null, head: lines.find(s => s.startsWith('HEAD '))?.slice(5) ?? null };
      }),
      readGeneration: async () => fs.readFileSync(marker, 'utf8').trim(),
      snapshot: async opts => { snapshotCalls++; return snap.snapshotWorktreeState(opts); },
      create: async () => { throw new Error('Unexpected create'); },
      removeIfExistsUnlocked: async () => { throw new Error('Unexpected legacy removal'); },
      ensureExcludes: async () => ensureExcludes(),
      rescueStateDir: path.join(root, 'state'),
    };
    outcome = await runTakeoverTransaction(host, {
      mainRepoPath: main, projectName: 'flywheel', issueId: 'FLY-2901', issueKey: 'FLY-2901',
      runId: 'run-review-2901', successorExec: 'successor-review-2901', startPoint: S,
      permit: { allowed: true, reason: 'no_live_writer', predecessors: [
        { executionId: 'predecessor-review', sessionStatus: 'failed', liveness: 'dead', pathSource: 'both' },
      ] },
      rescueDisabled: false, stabilityWaitMs: 0,
      recorder: {
        loadPendingTakeoverRescue: async () => [],
        recordRescue: async x => { events.push({ kind: 'rescued', ...x }); },
        recordCleaned: async x => { events.push({ kind: 'cleaned', ...x }); },
      },
      onStep: step => { steps.push({ step, victimExists: fs.existsSync(path.join(wt, c.file)), status: step === 'clean_done' ? git(wt, 'status', '--porcelain=v2').trim() : undefined }); },
    });
    assert.equal(outcome.kind, 'rescued', JSON.stringify(outcome));
    assert.deepEqual(outcome.evidence.manifest.nestedMoves, []);
    assert.equal(guards.length, 2);
    assert.deepEqual(events.map(e => e.kind), ['rescued', 'cleaned']);
    assert.equal(steps.find(s => s.step === 'clean_done').status, '');
    assert.equal(git(wt, 'status', '--porcelain=v2').trim(), c.finalStatus ?? '');
    assert.equal(git(wt, 'rev-parse', 'HEAD').trim(), target);
  }
  const afterBytes = fs.existsSync(path.join(wt, c.file)) ? fs.readFileSync(path.join(wt, c.file), 'utf8') : null;
  const originalPreserved = afterBytes === original;
  assert.equal(originalPreserved, c.expected !== 'lost', c.name);
  const originalBlobStored = spawnSync('git', [...safe, '-C', main, 'cat-file', '-e', blob], { env, stdio: 'pipe' }).status === 0;
  assert.equal(originalBlobStored, false, 'ignored original bytes must never have been stored by snapshot');
  if (c.expected === 'blocked') assert.equal(git(wt, 'rev-parse', 'HEAD').trim(), H);
  const refs = outcome.evidence?.manifest.rescues ?? [];
  for (const ref of refs) assert.equal(git(main, 'ls-tree', '-r', '--name-only', ref.tip, '--', c.file).trim(), '');
  const result = {
    case: c.name, expected: c.expected, root, H, S, beforeStatus, ignoredBefore, checkIgnore, guards,
    outcome: outcome.kind, class: outcome.evidence?.manifest.class ?? null, snapshotCalls,
    snapshot: outcome.evidence?.manifest.snapshot ?? null, rescueRefs: refs, events: events.map(x => x.kind), steps,
    originalPreserved, originalBlobStored, afterBytes, finalStatus: git(wt, 'status', '--porcelain=v2').trim(),
  };
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

const cases = [
  { name: 'index-file-now-ignored-directory', sameHead: true, hIgnore: 'drafts/\n', fileToDir: true, file: 'drafts/unpublished.md', expected: 'lost' },
  { name: 'uppercase-ignore-changes', hIgnore: 'drafts/\n', sIgnore: '# rule removed\n', ignoreName: '.GITIGNORE', file: 'drafts/unpublished.md', expected: 'lost' },
  { name: 'excludes-file-in-worktree-changes', excludesFile: true, file: 'drafts/unpublished.md', expected: 'lost' },
];
const results = [];
for (const c of cases) {
  const result = await runCase(c);
  results.push(result);
  console.log(JSON.stringify({ case: result.case, expected: result.expected, guards: result.guards.map(g => g.allowed), outcome: result.outcome, class: result.class, snapshotCalls: result.snapshotCalls, events: result.events, originalPreserved: result.originalPreserved }));
}
fs.writeFileSync(path.join(here, 'new-counterexamples-results.json'), JSON.stringify({ gitVersion: git(here, '--version').trim(), results }, null, 2) + '\n');
console.log(`ASSERTIONS PASSED: ${results.length} cases; ${results.filter(r => !r.originalPreserved).length} data-loss counterexamples`);

export { planGuard, git, env, safe };
