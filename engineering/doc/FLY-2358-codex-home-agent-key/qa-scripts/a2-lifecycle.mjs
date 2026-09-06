// FLY-2358 QA A2+A3: lazy create, persistence across two spawns, delete protection.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const M = '/Users/xiaorongli/Dev/flywheel-FLY-2358/packages/claude-runner/dist/codex-home.js';
const { admitCodexAgentHome, provisionCodexAgentHome, releaseCodexAgentHomeLease,
        removeCodexHome, codexAgentHomeDir, codexHomeDir, provisionCodexHome,
        resolveExecutionCodexHome } = await import(M);

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'fly2358-qa-a2-'));
const ROOT = path.join(BASE, 'codex-homes');
const SRC  = path.join(BASE, 'src-codex');
const SESS = path.join(BASE, 'codex-sessions');
fs.mkdirSync(SRC, { recursive: true });
for (const n of ['school','personal','business']) fs.mkdirSync(path.join(SRC, 'profiles', n), { recursive: true });
fs.writeFileSync(path.join(SRC, 'config.toml'), 'model = "gpt-5.4"\n');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = [ b64({alg:'none'}), b64({ email:'personal@example.test', 'https://api.openai.com/auth': { chatgpt_account_id:'acct-personal', chatgpt_plan_type:'pro' } }), 'signature' ].join('.');
fs.writeFileSync(path.join(SRC, 'auth.json'), JSON.stringify({ tokens: { id_token: jwt, access_token:'qa-access', refresh_token:'qa-refresh' } }));
const REGISTRY = path.join(BASE, 'codex-account-registry.json');
fs.writeFileSync(REGISTRY, JSON.stringify({ version:1, primary:'personal', profiles:[{ name:'school', email:'school@example.test', role:'manual_backup' },{ name:'personal', email:'personal@example.test', role:'primary' },{ name:'business', email:'business@example.test', role:'manual_backup' }] }));
const LEDGER = path.join(BASE, 'codex-account-ledger');
const CONTRACT = path.join(BASE, 'contract.md');
fs.writeFileSync(CONTRACT, '# codex runner contract (qa fixture)\n');
const TRUST = path.join(BASE, 'worktree-a'); fs.mkdirSync(TRUST, { recursive: true });
const TRUST2 = path.join(BASE, 'worktree-b'); fs.mkdirSync(TRUST2, { recursive: true });

const env = { ...process.env,
  FLYWHEEL_CODEX_HOMES_ROOT: ROOT,
  FLYWHEEL_CODEX_SOURCE_HOME: SRC,
  FLYWHEEL_CODEX_SESSION_DIR: SESS };

const out = []; const rec = (n,p,d) => out.push({n,p,d});
const logs = []; const origErr = console.error, origWarn = console.warn;
console.error = (...a) => { logs.push(['error', a.join(' ')]); origErr(...a); };
console.warn  = (...a) => { logs.push(['warn',  a.join(' ')]); origWarn(...a); };

const ID = { project: 'flywheel', role: 'implement' };
const KEYED = codexAgentHomeDir(ID, env);

// --- A2: nothing pre-created ---
rec('home not pre-created before first admit', !fs.existsSync(KEYED), KEYED);

const prov = async (handle, trusted) => provisionCodexAgentHome(handle, {
  env, contractSourcePath: CONTRACT, skillFrameworkMode: 'superpowers',
  trustedProjectPath: trusted, ghToken: 'gho_qatoken123',
  registryPath: REGISTRY, ledgerRoot: LEDGER,
});

// --- spawn #1 ---
const a1 = await admitCodexAgentHome({ ...ID, executionId: 'exec-one', requestedAssemblyArm: 'superpowers' }, env);
const h1 = await prov(a1.handle, TRUST);
rec('spawn#1 created keyed home on first use', fs.existsSync(KEYED) && h1 === KEYED, h1);
rec('spawn#1 marker written', fs.existsSync(path.join(KEYED, '.flywheel-agent-home.json')),
    fs.readFileSync(path.join(KEYED, '.flywheel-agent-home.json'), 'utf8').trim());

// runner writes a "memory" artefact into the shared home
fs.mkdirSync(path.join(KEYED, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(KEYED, 'sessions', 'memory-from-exec-one.txt'), 'accumulated memory\n');

// publish the session reverse-lookup the way the adapter does
const pubSession = (exec) => {
  const d = path.join(SESS, exec); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'session.json'), JSON.stringify({ codexAgentHome: { home: KEYED, ...ID } }));
};
pubSession('exec-one');

// end of spawn #1
await releaseCodexAgentHomeLease(a1.handle, env);
rec('after last lease released the keyed home SURVIVES (not deleted with the task)',
    fs.existsSync(KEYED) && fs.existsSync(path.join(KEYED, 'sessions', 'memory-from-exec-one.txt')), KEYED);
const cfg0 = fs.readFileSync(path.join(KEYED,'config.toml'),'utf8');
rec('GH_TOKEN managed block scrubbed on last-lease-exit',
    !cfg0.includes('gho_qatoken123'), cfg0.includes('gho_qatoken123') ? 'TOKEN STILL PRESENT' : 'token gone');
rec('OBSERVATION: auth.json persists in the keyed home between tasks',
    true, `auth.json exists=${fs.existsSync(path.join(KEYED,'auth.json'))} (mode ${fs.existsSync(path.join(KEYED,'auth.json')) ? (fs.statSync(path.join(KEYED,'auth.json')).mode & 0o777).toString(8) : 'n/a'})`);

// --- spawn #2, same (agent, project) ---
const a2 = await admitCodexAgentHome({ ...ID, executionId: 'exec-two', requestedAssemblyArm: 'superpowers' }, env);
const h2 = await prov(a2.handle, TRUST2);
rec('spawn#2 same (agent,project) resolves to the SAME path', h2 === h1, `${h1} == ${h2}`);
rec('spawn#2 sees spawn#1 accumulated memory', fs.existsSync(path.join(KEYED,'sessions','memory-from-exec-one.txt')), 'memory file present');
const cfg = fs.readFileSync(path.join(KEYED,'config.toml'),'utf8');
rec('worktree trust accumulates across spawns', cfg.includes(TRUST) && cfg.includes(TRUST2), 'both worktrees trusted');
pubSession('exec-two');

// --- A3: delete protection ---
const r1 = removeCodexHome('exec-two', env);
rec('removeCodexHome on a KEYED execution is REFUSED',
    r1.removed === false && r1.reason === 'agent_home_protected', JSON.stringify(r1));
rec('refusal is visible in logs (refuse_remove_agent_home)',
    logs.some(([lvl,m]) => lvl==='error' && m.includes('refuse_remove_agent_home') && m.includes('exec-two')),
    logs.filter(([,m])=>m.includes('refuse_remove_agent_home')).map(([,m])=>m).join(' | '));
rec('keyed home still on disk after refused delete', fs.existsSync(KEYED), KEYED);

// concurrent second lease on the same home
const a3 = await admitCodexAgentHome({ ...ID, executionId: 'exec-three', requestedAssemblyArm: 'superpowers' }, env);
rec('two concurrent executions share ONE home', a3.handle.home === KEYED && a3.liveLeases === 2, `liveLeases=${a3.liveLeases}`);
await releaseCodexAgentHomeLease(a3.handle, env);
rec('releasing one of two leases keeps the home', fs.existsSync(KEYED), KEYED);
await releaseCodexAgentHomeLease(a2.handle, env);

// --- legacy behaviour unchanged ---
const LEGACY_EXEC = 'exec-legacy-9';
const lh = provisionCodexHome({ executionId: LEGACY_EXEC, env, contractSourcePath: CONTRACT, trustedProjectPath: TRUST, registryPath: REGISTRY, ledgerRoot: LEDGER });
rec('legacy execution-scoped home still provisions at <root>/<executionId>', lh === codexHomeDir(LEGACY_EXEC, env) && fs.existsSync(lh), lh);
const res = resolveExecutionCodexHome(LEGACY_EXEC, undefined, env);
rec('legacy execution classified legacy', res.kind === 'legacy', JSON.stringify(res));
const r2 = removeCodexHome(LEGACY_EXEC, env);
rec('removeCodexHome on a LEGACY execution still deletes (behaviour unchanged)',
    r2.removed === true && !fs.existsSync(lh), JSON.stringify(r2));

// --- unknown classification refuses to delete ---
const d = path.join(SESS, 'exec-bogus'); fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(d, 'session.json'), JSON.stringify({ codexAgentHome: { home: '/etc', project: 'flywheel', role: 'implement' } }));
const r3 = removeCodexHome('exec-bogus', env);
rec('tampered/unknown record refuses deletion', r3.removed === false && r3.reason !== undefined, JSON.stringify(r3));

console.error = origErr; console.warn = origWarn;
let fails = 0;
for (const r of out) { if (!r.p) fails++; console.log(`${r.p?'PASS':'FAIL'}  ${r.n}  :: ${r.d}`); }
console.log(`\n--- A2+A3: ${out.length-fails}/${out.length} passed --- (sandbox ${BASE})`);
process.exit(fails ? 1 : 0);
