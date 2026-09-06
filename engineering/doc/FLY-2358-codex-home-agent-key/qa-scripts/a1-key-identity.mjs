// FLY-2358 QA A1: same (agent,project) -> same path; four-group separation.
import { codexAgentHomeDir, codexHomesRoot, codexHomeDir } from '/Users/xiaorongli/Dev/flywheel-FLY-2358/packages/claude-runner/dist/codex-home.js';

const ROOT = '/tmp/fly2358-qa-a1-root';
const env = { ...process.env, FLYWHEEL_CODEX_HOMES_ROOT: ROOT };
const out = [];
const rec = (name, pass, detail) => { out.push({name, pass, detail}); };

// group 1: identical pair resolves identically across two independent calls
const p1a = codexAgentHomeDir({ project: 'flywheel', role: 'implement' }, env);
const p1b = codexAgentHomeDir({ project: 'flywheel', role: 'implement' }, env);
rec('same (flywheel,implement) twice -> same path', p1a === p1b, p1a);

// group 2: same project, different role
const p2 = codexAgentHomeDir({ project: 'flywheel', role: 'qa' }, env);
rec('same project, different role -> different path', p1a !== p2, p2);

// group 3: different project, same role
const p3 = codexAgentHomeDir({ project: 'geoforge3d', role: 'implement' }, env);
rec('different project, same role -> different path', p1a !== p3 && p2 !== p3, p3);

// group 4: both different
const p4 = codexAgentHomeDir({ project: 'geoforge3d', role: 'design' }, env);
rec('both different -> distinct from all', new Set([p1a,p2,p3,p4]).size === 4, p4);

// case-sensitivity injectivity (macOS APFS is case-insensitive by default)
const pUpper = codexAgentHomeDir({ project: 'Flywheel', role: 'Implement' }, env);
rec('case-differing identity -> distinct encoded path', pUpper !== p1a, pUpper);

// all six real projects x five IC roles: no collision
const projects = ['flywheel','geoforge3d','joycon-typeless','tidal-echo','flywheel-interviews','sub-content'];
const roles = ['design','implement','qa','review','research','flywheel-eng-lead'];
const seen = new Map();
let collision = null;
for (const pr of projects) for (const r of roles) {
  const path = codexAgentHomeDir({ project: pr, role: r }, env);
  if (seen.has(path)) collision = `${seen.get(path)} vs ${pr}/${r} -> ${path}`;
  seen.set(path, `${pr}/${r}`);
}
rec('6 projects x 6 roles (incl. a Lead role) -> 36 distinct paths', seen.size === 36 && !collision, collision ?? `${seen.size} distinct`);

// root override honored
rec('FLYWHEEL_CODEX_HOMES_ROOT honored', p1a.startsWith(ROOT + '/agents/'), codexHomesRoot(env));

// legacy execution-scoped shape unchanged
const legacy = codexHomeDir('exec-abc-123', env);
rec('legacy codexHomeDir shape unchanged', legacy === ROOT + '/exec-abc-123', legacy);

// hostile identities rejected
for (const bad of [{project:'..', role:'implement'}, {project:'a/b', role:'implement'}, {project:'flywheel', role:'../../etc'}, {project:'flywheel', role:''}]) {
  let threw = false;
  try { codexAgentHomeDir(bad, env); } catch { threw = true; }
  rec(`hostile identity rejected: ${JSON.stringify(bad)}`, threw, threw ? 'threw' : 'ACCEPTED');
}

let fails = 0;
for (const r of out) { if (!r.pass) fails++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  :: ${r.detail}`); }
console.log(`\n--- A1: ${out.length - fails}/${out.length} passed ---`);
process.exit(fails ? 1 : 0);
