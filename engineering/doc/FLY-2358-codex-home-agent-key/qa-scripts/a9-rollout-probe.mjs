// FLY-2358 QA A9: C4 — the reown liveness probe must find rollouts inside the
// KEYED home (before the fix it looked at <root>/<executionId>/sessions, which a
// keyed execution no longer has, so reown liveness silently degraded to "absent").
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
const M='/Users/xiaorongli/Dev/flywheel-FLY-2358/packages/claude-runner/dist/codex-rollout-probe.js';
const H='/Users/xiaorongli/Dev/flywheel-FLY-2358/packages/claude-runner/dist/codex-home.js';
const { probeCodexRolloutMtime } = await import(M);
const { codexAgentHomeDir, codexHomeDir } = await import(H);

const BASE=fs.mkdtempSync(path.join(os.tmpdir(),'fly2358-a9-'));
const ROOT=path.join(BASE,'homes'), SESS=path.join(BASE,'codex-sessions');
const env={...process.env, FLYWHEEL_CODEX_HOMES_ROOT:ROOT, FLYWHEEL_CODEX_SESSION_DIR:SESS};
const ID={project:'flywheel',role:'implement'};
const HOME=codexAgentHomeDir(ID,env);
const out=[],rec=(n,p,d)=>out.push({n,p,d});

// stand up a keyed home the way admit does, plus its session reverse record
fs.mkdirSync(path.join(HOME,'.flywheel-leases'),{recursive:true});
fs.writeFileSync(path.join(HOME,'.flywheel-agent-home.json'), JSON.stringify({version:1,...ID,createdAt:new Date().toISOString(),assemblyArm:'superpowers',materializedArm:'superpowers'}));
const EXEC='exec-a9-keyed';
const THREAD='thr-a9-keyed-0001';
fs.writeFileSync(path.join(HOME,'.flywheel-leases',EXEC), 'a'.repeat(32)+'\n');
const sd=path.join(SESS,EXEC); fs.mkdirSync(sd,{recursive:true});
fs.writeFileSync(path.join(sd,'session.json'), JSON.stringify({threadId:THREAD, codexAgentHome:{home:HOME,...ID}}));

// before any rollout exists
rec('keyed home with no rollout yet -> absent (not unknown)',
    probeCodexRolloutMtime(EXEC, env).kind==='absent', JSON.stringify(probeCodexRolloutMtime(EXEC, env)));

// write a rollout inside the KEYED home
const roll=path.join(HOME,'sessions','2026','09','05'); fs.mkdirSync(roll,{recursive:true});
const rf=path.join(roll,`rollout-2026-09-05T12-00-00-${THREAD}.jsonl`);
fs.writeFileSync(rf, '{"x":1}\n');
const want=fs.statSync(rf).mtimeMs;
const got=probeCodexRolloutMtime(EXEC, env);
rec('C4: probe FINDS the rollout inside the keyed home',
    got.kind==='found' && Math.abs(got.mtimeMs-want)<2, JSON.stringify(got));

// ruler: the pre-fix location must NOT be what makes this pass
const legacyDir=path.join(codexHomeDir(EXEC, env),'sessions');
rec('RULER: the old <root>/<executionId>/sessions path does not even exist',
    !fs.existsSync(legacyDir), legacyDir);

// legacy execution keeps the old behaviour exactly
const LEG='exec-a9-legacy';
const LTHREAD='thr-a9-legacy-0001';
const lsd=path.join(SESS,LEG); fs.mkdirSync(lsd,{recursive:true});
fs.writeFileSync(path.join(lsd,'session.json'), JSON.stringify({threadId:LTHREAD}));
const lroll=path.join(codexHomeDir(LEG, env),'sessions','2026','09','05');
fs.mkdirSync(lroll,{recursive:true});
const lf=path.join(lroll,`rollout-2026-09-05T12-00-00-${LTHREAD}.jsonl`); fs.writeFileSync(lf,'{"y":1}\n');
const lgot=probeCodexRolloutMtime(LEG, env);
rec('legacy execution still probed at <root>/<executionId>/sessions (unchanged)',
    lgot.kind==='found' && Math.abs(lgot.mtimeMs-fs.statSync(lf).mtimeMs)<2, JSON.stringify(lgot));

// a tampered session record must not send the probe somewhere else
const BAD='exec-a9-bad'; const bd=path.join(SESS,BAD); fs.mkdirSync(bd,{recursive:true});
fs.writeFileSync(path.join(bd,'session.json'), JSON.stringify({threadId:'thr-bad', codexAgentHome:{home:'/etc',...ID}}));
rec('tampered record -> unknown, probe refuses to read an arbitrary path',
    probeCodexRolloutMtime(BAD, env).kind==='unknown', JSON.stringify(probeCodexRolloutMtime(BAD, env)));

let f=0; for(const r of out){ if(!r.p) f++; console.log(`${r.p?'PASS':'FAIL'}  ${r.n}  :: ${r.d}`); }
console.log(`\n--- A9: ${out.length-f}/${out.length} passed ---`);
process.exit(f?1:0);
