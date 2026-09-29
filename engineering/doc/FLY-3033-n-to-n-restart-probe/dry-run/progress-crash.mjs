// 用真实 flywheel-comm runProgress（只替换 session 查询），在内部切点 SIGKILL 自己，复现前体被杀留下的账本残留。
// 用法：node progress-crash.mjs <after-lock|before-rename|after-rename|after-commit>   （cwd = 临时仓；env REAL_PROGRESS_JS = dist/commands/progress.js）
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const { runProgress } = await import(process.env.REAL_PROGRESS_JS);
const file = 'engineering/doc/FLY-3033-n-to-n-restart-probe/progress.md';
const mode = process.argv[2];
const die = (point) => { if (mode === point) process.kill(process.pid, 'SIGKILL'); };
const result = runProgress({ execId: 'exec-dry', file, phase: 'implement', cursor: '1/3', next: 'Task 3' }, {
  env: process.env, cwd: () => process.cwd(),
  readSession: () => ({ status: 'running', session_role: 'eng_implement', issue_identifier: 'FLY-3033', session_stage: 'implement' }),
  existsSync: fs.existsSync, readFileSync: (p) => fs.readFileSync(p, 'utf8'),
  writeTempAndRename: (p, content) => {
    const tmp = `${p}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, content, 'utf8'); die('before-rename');
    fs.renameSync(tmp, p); die('after-rename');
  },
  restoreFile: (p, content) => { if (content === null) fs.rmSync(p, { force: true }); else fs.writeFileSync(p, content); },
  withLock: (p, fn) => {
    const fd = fs.openSync(`${p}.lock`, 'wx'); die('after-lock');
    try { return fn(); } finally { fs.closeSync(fd); fs.rmSync(`${p}.lock`, { force: true }); }
  },
  git: (a) => { const r = spawnSync('git', a, { encoding: 'utf8' }); if (a[0] === 'commit' && r.status === 0) die('after-commit'); return r; },
});
console.log(JSON.stringify(result));
if (!result.ok) process.exit(1);
