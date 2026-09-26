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


export { planGuard, git, env, safe, put };
