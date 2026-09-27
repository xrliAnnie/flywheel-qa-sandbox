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

// Literal model of plan blob 794f3515971bf7b2f76f998c4c491125312e3ca0 §4.7a, not a production implementation.
function planGuard(wt, H, target) {
  const D = nul(git(wt, 'diff', '--name-only', '-z', '--no-renames', target));
  const index = nul(git(wt, 'ls-files', '-z', '--cached'));
  let ignoreCase = false;
  try { ignoreCase = git(wt, 'config', '--bool', '--get', 'core.ignorecase').trim() === 'true'; } catch {}
  const fold = p => ignoreCase ? p.toLowerCase() : p;
  const inIndex = p => index.some(i => fold(i) === fold(p));
  const stat = p => {
    try { return fs.lstatSync(path.join(wt, p)); }
    catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; }
  };
  const ignored = p => {
    const r = spawnSync('git', [...safe, '-C', wt, 'check-ignore', '--no-index', '-q', '--', p], {env, stdio: 'pipe'});
    if (r.status !== 0 && r.status !== 1) throw new Error('check-ignore failed: ' + r.stderr);
    return r.status === 0;
  };
  const conflicts = [];
  for (const p of D) {
    const s = stat(p);
    if (s?.isDirectory()) conflicts.push({rule:'a',path:p});
    if (!inIndex(p) && s && ignored(p)) conflicts.push({rule:'b',path:p});
    let ancestor = path.posix.dirname(p);
    while (ancestor !== '.') {
      const a = stat(ancestor);
      if (a && !a.isDirectory() && !inIndex(ancestor)) conflicts.push({rule:'c',path:ancestor});
      ancestor = path.posix.dirname(ancestor);
    }
    if (path.posix.basename(p).toLowerCase() === '.gitignore') conflicts.push({rule:'d',path:p});
  }
  const configured = spawnSync('git', [...safe,'-C',wt,'config','--path','--get','core.excludesFile'], {env, encoding:'utf8'});
  let excludesFile = null;
  if (configured.status === 0) {
    excludesFile = fs.realpathSync(path.resolve(wt, configured.stdout.trim()));
    const rel = path.relative(fs.realpathSync(wt), excludesFile);
    if (rel === '' || (!rel.startsWith('../') && !path.isAbsolute(rel))) conflicts.push({rule:'e',path:excludesFile});
  } else if (configured.status !== 1) throw new Error('config failed');
  return {allowed:conflicts.length === 0,D,index,ignoreCase,excludesFile,conflicts};
}


export { planGuard, git, env, safe, put };
