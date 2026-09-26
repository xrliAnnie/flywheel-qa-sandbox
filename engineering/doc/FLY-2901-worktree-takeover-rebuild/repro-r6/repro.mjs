import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runTakeoverTransaction } from './worktree-takeover-transaction.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const safe = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', '-c', 'core.sshCommand=false', '-c', 'core.askpass=false', '-c', 'protocol.ext.allow=never'];
function git(cwd, ...args) {
  return execFileSync('git', [...safe, '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function reproduce(mode) {
  const root = fs.mkdtempSync(path.join(here, `${mode}-`));
  const main = path.join(root, 'main');
  const origin = path.join(root, 'origin.git');
  const wt = path.join(root, 'shared');
  fs.mkdirSync(main); fs.mkdirSync(origin);
  git(origin, 'init', '--bare', '-q', '-b', 'main');
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.name', 'Design Review');
  git(main, 'config', 'user.email', 'review@example.invalid');
  fs.writeFileSync(path.join(main, '.gitignore'), 'drafts/\n');
  fs.writeFileSync(path.join(main, 'tracked'), 'base\n');
  git(main, 'add', '.'); git(main, 'commit', '-qm', 'H');
  const H = git(main, 'rev-parse', 'HEAD').trim();
  if (mode === 'ignore-rule-removed') {
    fs.writeFileSync(path.join(main, '.gitignore'), '# drafts are no longer ignored\n');
    git(main, 'add', '.gitignore');
  } else {
    fs.mkdirSync(path.join(main, 'drafts'));
    fs.writeFileSync(path.join(main, 'drafts', 'unpublished.md'), 'TARGET CONTENT\n');
    git(main, 'add', '-f', 'drafts/unpublished.md');
  }
  git(main, 'commit', '-qm', 'S');
  const S = git(main, 'rev-parse', 'HEAD').trim();
  const branch = 'flywheel-FLY-2901';
  git(main, 'worktree', 'add', '-qb', branch, wt, H);
  git(main, 'remote', 'add', 'origin', origin);
  git(main, 'push', '-q', 'origin', 'main', branch);
  const marker = git(wt, 'rev-parse', '--path-format=absolute', '--git-path', 'flywheel-generation').trim();
  fs.writeFileSync(marker, 'generation-review\n');
  fs.mkdirSync(path.join(wt, 'drafts'));
  const workFile = path.join(wt, 'drafts', 'unpublished.md');
  const original = 'UNIQUE LOCAL WORK NEVER COMMITTED\n';
  fs.writeFileSync(workFile, original);
  const beforeStatus = git(wt, 'status', '--porcelain=v2', '-z', '--untracked-files=all');
  const ignoredBefore = git(wt, 'ls-files', '--others', '--ignored', '--exclude-standard').trim();
  assert.equal(beforeStatus, '');
  let snapshotCalls = 0;
  const events = [];
  const steps = [];
  const host = {
    git: async (args, cwd, options = {}) => execFileSync('git', [...safe, ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeoutMs ?? 15000,
      env: { ...process.env, ...options.env },
    }),
    lockAvailable: true,
    expected: () => ({ path: wt, branch }),
    listRegistered: async () => git(main, 'worktree', 'list', '--porcelain').trim().split('\n\n').map(block => {
      const lines = block.split('\n');
      return { path: lines.find(s => s.startsWith('worktree ')).slice(9),
        branch: lines.find(s => s.startsWith('branch '))?.slice(7) ?? null,
        head: lines.find(s => s.startsWith('HEAD '))?.slice(5) ?? null };
    }),
    readGeneration: async () => fs.readFileSync(marker, 'utf8').trim(),
    snapshot: async () => { snapshotCalls++; throw new Error('Unexpected snapshot of clean ignored-only tree'); },
    create: async () => { throw new Error('Unexpected create'); },
    removeIfExistsUnlocked: async () => { throw new Error('Unexpected legacy removal'); },
    ensureExcludes: async () => {
      const exclude = git(main, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude').trim();
      fs.appendFileSync(exclude, '\n.flywheel/runs/\n.flywheel/review-targets/\n');
    },
    rescueStateDir: path.join(root, 'state'),
  };
  const outcome = await runTakeoverTransaction(host, {
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
    onStep: step => { steps.push({ step, exists: fs.existsSync(workFile), content: fs.existsSync(workFile) ? fs.readFileSync(workFile, 'utf8') : null }); },
  });
  const afterContent = fs.existsSync(workFile) ? fs.readFileSync(workFile, 'utf8') : null;
  assert.equal(outcome.kind, 'rescued');
  assert.equal(outcome.evidence.manifest.class, 'head_behind');
  assert.equal(outcome.evidence.manifest.snapshot, null);
  assert.deepEqual(outcome.evidence.manifest.rescues, []);
  assert.notEqual(afterContent, original);
  assert.equal(git(wt, 'status', '--porcelain=v2').trim(), '');
  const result = { mode, root, H, S, beforeStatus, ignoredBefore, outcome: outcome.kind,
    class: outcome.evidence.manifest.class, snapshotCalls, snapshot: outcome.evidence.manifest.snapshot,
    rescueRefs: outcome.evidence.manifest.rescues, events: events.map(x => x.kind), steps,
    fileExistsAfter: fs.existsSync(workFile), afterContent, originalBytesLost: afterContent !== original,
    finalHeadIsS: git(wt, 'rev-parse', 'HEAD').trim() === S,
    finalStatus: git(wt, 'status', '--porcelain=v2').trim() };
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

const results = [];
for (const mode of ['ignore-rule-removed', 'target-overwrites-ignored']) results.push(await reproduce(mode));
fs.writeFileSync(path.join(here, 'results.json'), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
