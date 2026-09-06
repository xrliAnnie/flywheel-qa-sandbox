// FLY-2358 QA A8: the hot shared home's failure mode — a crashed runner leaves a
// stale admission lock. With ~70 starts/day on ONE (flywheel, implement) home this
// is the most likely production stall. Prove it self-heals and does not wedge.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
const M='/Users/xiaorongli/Dev/flywheel-FLY-2358/packages/claude-runner/dist/codex-home.js';
const { admitCodexAgentHome, releaseCodexAgentHomeLease, codexAgentHomeDir } = await import(M);

const BASE=fs.mkdtempSync(path.join(os.tmpdir(),'fly2358-a8-'));
const ROOT=path.join(BASE,'homes');
const env={...process.env, FLYWHEEL_CODEX_HOMES_ROOT:ROOT};
const ID={project:'flywheel',role:'implement'};
const HOME=codexAgentHomeDir(ID,env);
const out=[],rec=(n,p,d)=>out.push({n,p,d});

// establish the home + its lock dir
const a=await admitCodexAgentHome({...ID,executionId:'exec-a8-1',requestedAssemblyArm:'superpowers'},env);
rec('baseline admit works', a.handle.home===HOME, HOME);
const locksRoot=path.join(path.dirname(HOME),'.locks');
const lockPath=path.join(locksRoot, path.basename(HOME));
rec('admission lock lives OUTSIDE the home (a wedged lock cannot corrupt memory)',
    fs.existsSync(locksRoot) && !lockPath.startsWith(HOME+path.sep), lockPath);

// a role literally named ".locks" must not be able to collide with the lock dir
let dotThrew=false; try { codexAgentHomeDir({project:'flywheel', role:'.locks'}, env); } catch { dotThrew=true; }
rec('a role named ".locks" cannot collide with the lock directory', dotThrew, dotThrew?'rejected':'ACCEPTED — collision risk');

// simulate a crashed holder: recreate the lock dir and backdate it beyond staleMs (60s)
fs.mkdirSync(lockPath,{recursive:true});
const old=new Date(Date.now()-10*60_000);
fs.utimesSync(lockPath, old, old);
rec('stale lock planted (10 min old)', true, `${lockPath} mtime=${fs.statSync(lockPath).mtime.toISOString()}`);

const t0=Date.now();
let admitted=null, err=null;
try { admitted=await admitCodexAgentHome({...ID,executionId:'exec-a8-2',requestedAssemblyArm:'superpowers'},env); }
catch(e){ err=e.message; }
const dt=Date.now()-t0;
rec('a STALE lock is reclaimed, not a permanent wedge',
    admitted!==null && admitted.handle.home===HOME, err ?? `home=${admitted?.handle.home}`);
rec('stale reclaim is fast (well under the 10s lock timeout)', dt<10_000, `${dt} ms`);
rec('both leases present after reclaim',
    fs.readdirSync(path.join(HOME,'.flywheel-leases')).sort().join(',')==='exec-a8-1,exec-a8-2',
    fs.readdirSync(path.join(HOME,'.flywheel-leases')).sort().join(','));

// a FRESH lock held by someone else must NOT be stolen: admission must fail closed on timeout
fs.mkdirSync(lockPath,{recursive:true});
const t1=Date.now(); let err2=null;
try { await admitCodexAgentHome({...ID,executionId:'exec-a8-3',requestedAssemblyArm:'superpowers'},env); }
catch(e){ err2=e.message; }
const dt2=Date.now()-t1;
rec('RULER: a FRESH lock is NOT stolen — admission fails closed instead',
    err2!==null, err2 ?? 'STOLE THE LOCK — would corrupt a concurrent provision');
rec('fail-closed happens at the 10s timeout, it does not hang forever', dt2<20_000, `${dt2} ms`);
rec('the failed admission left no lease behind',
    !fs.existsSync(path.join(HOME,'.flywheel-leases','exec-a8-3')), 'no exec-a8-3 lease');
fs.rmSync(lockPath,{recursive:true,force:true});
const c=await admitCodexAgentHome({...ID,executionId:'exec-a8-4',requestedAssemblyArm:'superpowers'},env);
rec('once the holder releases, admission resumes normally', c.handle.home===HOME, `liveLeases=${c.liveLeases}`);

let f=0; for(const r of out){ if(!r.p) f++; console.log(`${r.p?'PASS':'FAIL'}  ${r.n}  :: ${r.d}`); }
console.log(`\n--- A8: ${out.length-f}/${out.length} passed ---`);
process.exit(f?1:0);
