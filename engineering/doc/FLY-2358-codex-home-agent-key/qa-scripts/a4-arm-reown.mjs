// FLY-2358 QA A4: arm inheritance (换体) <-> Bridge reown contract, real modules.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
const CR='/Users/xiaorongli/Dev/flywheel-FLY-2358/packages/claude-runner/dist/codex-home.js';
const RO='/Users/xiaorongli/Dev/flywheel-FLY-2358/packages/teamlead/dist/bridge/codex-session-reown.js';
const { admitCodexAgentHome, releaseCodexAgentHomeLease, resolveExecutionCodexHome, codexAgentHomeDir } = await import(CR);
const { prepareCodexRecoveryAgentHome } = await import(RO);

const BASE = fs.mkdtempSync(path.join(os.tmpdir(),'fly2358-a4-'));
const ROOT = path.join(BASE,'homes'); const SESS = path.join(BASE,'sessions');
const env = { ...process.env, FLYWHEEL_CODEX_HOMES_ROOT: ROOT, FLYWHEEL_CODEX_SESSION_DIR: SESS };
// prepareCodexRecoveryAgentHome uses module-level default deps bound to process.env,
// so mirror the sandbox roots onto process.env for the whole run.
process.env.FLYWHEEL_CODEX_HOMES_ROOT = ROOT;
process.env.FLYWHEEL_CODEX_SESSION_DIR = SESS;

const out=[]; const rec=(n,p,d)=>out.push({n,p,d});
const ID = { project:'flywheel', role:'implement' };
const HOME = codexAgentHomeDir(ID, env);
const publish = (exec) => { const d=path.join(SESS,exec); fs.mkdirSync(d,{recursive:true});
  fs.writeFileSync(path.join(d,'session.json'), JSON.stringify({ codexAgentHome:{ home:HOME, ...ID }})); };

// runner A claims the home on the `matt` arm
const A = await admitCodexAgentHome({ ...ID, executionId:'exec-A', requestedAssemblyArm:'matt' }, env);
rec('A first-in sets the home arm', A.effectiveAssemblyArm==='matt' && !A.inherited, A.effectiveAssemblyArm);
publish('exec-A');

// runner B on the SAME (agent,project) requests a DIFFERENT arm while A is live
const B = await admitCodexAgentHome({ ...ID, executionId:'exec-B', requestedAssemblyArm:'superpowers' }, env);
rec('B on a live shared home INHERITS the home arm (换体 request does not flip a live home)',
    B.inherited===true && B.effectiveAssemblyArm==='matt' && B.handle.home===A.handle.home, `effective=${B.effectiveAssemblyArm} inherited=${B.inherited}`);
rec('both leases live on one home', B.liveLeases===2, `liveLeases=${B.liveLeases}`);
publish('exec-B');

const session = (exec) => ({ execution_id: exec, project_name: ID.project, workflow_node_id: ID.role });
const snap = (arm) => ({ launchContext: { skillFrameworkMode: arm } });
const baseCtx = { executionId: 'x' };

// Bridge restarts. B resumes carrying the EFFECTIVE arm the Blueprint persisted.
const ctxB = await prepareCodexRecoveryAgentHome({ session: session('exec-B'), snapshot: snap('matt'), context: baseCtx });
rec('reown of B succeeds when the snapshot carries the EFFECTIVE (inherited) arm',
    ctxB.codexAgentHome?.home===HOME && ctxB.codexAgentHome?.assemblyArm==='matt',
    JSON.stringify(ctxB.codexAgentHome && { home: ctxB.codexAgentHome.home===HOME, arm: ctxB.codexAgentHome.assemblyArm, createdLease: ctxB.codexAgentHome.createdLease }));
rec('reown re-uses B existing lease (no duplicate)', ctxB.codexAgentHome?.createdLease===false, `createdLease=${ctxB.codexAgentHome?.createdLease}`);

// Ruler self-check: had the snapshot carried the REQUESTED arm, reown must fail closed.
let threw=null; try { await prepareCodexRecoveryAgentHome({ session: session('exec-B'), snapshot: snap('superpowers'), context: baseCtx }); }
catch(e){ threw = e.message; }
rec('RULER: a snapshot carrying the un-inherited requested arm fails CLOSED (arm mismatch)',
    threw && /arm_mismatch/.test(threw), threw ?? 'DID NOT THROW');
const leasesNow = fs.readdirSync(path.join(HOME,'.flywheel-leases'));
rec('failed reown did not leak a lease', leasesNow.length===2, leasesNow.join(','));

// no workflow_node_id (legacy / non-DAG session) -> untouched context, no throw
const legacyCtx = await prepareCodexRecoveryAgentHome({ session: { execution_id:'exec-legacy', project_name:'flywheel' }, snapshot: snap('superpowers'), context: baseCtx });
rec('a session without a workflow role reowns unchanged (legacy path intact)', legacyCtx===baseCtx || legacyCtx.codexAgentHome===undefined, JSON.stringify(legacyCtx));

// arm can be re-elected only after the home goes idle
await releaseCodexAgentHomeLease(A.handle, env);
await releaseCodexAgentHomeLease(B.handle, env);
const C = await admitCodexAgentHome({ ...ID, executionId:'exec-C', requestedAssemblyArm:'bare' }, env);
rec('after ALL leases drain, a new arm IS adopted (换体 works on an idle home)',
    C.effectiveAssemblyArm==='bare' && !C.inherited && C.handle.home===HOME, C.effectiveAssemblyArm);
rec('the home itself survived the drain (memory kept across the arm switch)', fs.existsSync(HOME), HOME);

let f=0; for(const r of out){ if(!r.p) f++; console.log(`${r.p?'PASS':'FAIL'}  ${r.n}  :: ${r.d}`); }
console.log(`\n--- A4: ${out.length-f}/${out.length} passed --- (${BASE})`);
process.exit(f?1:0);
