// FLY-2358 QA A6: C2/C3 — Bridge startup sweep must keep a LIVE keyed runner's lease + token,
// and must reclaim a terminal/orphan one, without ever deleting the home.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
const M='/Users/xiaorongli/Dev/flywheel-FLY-2358/packages/claude-runner/dist/codex-home.js';
const { admitCodexAgentHome, provisionCodexAgentHome, scrubOrphanedCodexAgentHomes,
        scrubOrphanedCodexHomes, provisionCodexHome, codexAgentHomeDir, codexHomeDir } = await import(M);

const BASE=fs.mkdtempSync(path.join(os.tmpdir(),'fly2358-a6-'));
const ROOT=path.join(BASE,'homes'), SRC=path.join(BASE,'src'), SESS=path.join(BASE,'sessions');
for(const n of ['school','personal','business']) fs.mkdirSync(path.join(SRC,'profiles',n),{recursive:true});
fs.writeFileSync(path.join(SRC,'config.toml'),'model = "x"\n');
const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
fs.writeFileSync(path.join(SRC,'auth.json'),JSON.stringify({tokens:{id_token:[b64({alg:'none'}),b64({email:'personal@example.test','https://api.openai.com/auth':{chatgpt_account_id:'acct-personal',chatgpt_plan_type:'pro'}}),'s'].join('.'),access_token:'a',refresh_token:'r'}}));
const REG=path.join(BASE,'r.json'); fs.writeFileSync(REG,JSON.stringify({version:1,primary:'personal',profiles:[{name:'school',email:'s@e.test',role:'manual_backup'},{name:'personal',email:'personal@example.test',role:'primary'},{name:'business',email:'b@e.test',role:'manual_backup'}]}));
const LEDGER=path.join(BASE,'l'), CONTRACT=path.join(BASE,'c.md'); fs.writeFileSync(CONTRACT,'# c\n');
const WT=path.join(BASE,'wt'); fs.mkdirSync(WT);
const env={...process.env,FLYWHEEL_CODEX_HOMES_ROOT:ROOT,FLYWHEEL_CODEX_SOURCE_HOME:SRC,FLYWHEEL_CODEX_SESSION_DIR:SESS};
const ID={project:'flywheel',role:'implement'}; const HOME=codexAgentHomeDir(ID,env);
const prov=h=>provisionCodexAgentHome(h,{env,contractSourcePath:CONTRACT,skillFrameworkMode:'superpowers',trustedProjectPath:WT,ghToken:'gho_TOKEN_A6',registryPath:REG,ledgerRoot:LEDGER});
const out=[],rec=(n,p,d)=>out.push({n,p,d});
const leases=()=>fs.readdirSync(path.join(HOME,'.flywheel-leases')).sort();
const cfg=()=>fs.readFileSync(path.join(HOME,'config.toml'),'utf8');

const live=await admitCodexAgentHome({...ID,executionId:'exec-live',requestedAssemblyArm:'superpowers'},env); await prov(live.handle);
const dead=await admitCodexAgentHome({...ID,executionId:'exec-dead',requestedAssemblyArm:'superpowers'},env);
const ghost=await admitCodexAgentHome({...ID,executionId:'exec-ghost',requestedAssemblyArm:'superpowers'},env);
rec('three leases before sweep', leases().length===3, leases().join(','));

// Bridge startup view: live is running, dead is terminal, ghost has no session row at all.
const sessions=new Map([
  ['exec-live', {...ID, status:'running'}],
  ['exec-dead', {...ID, status:'completed'}],
]);
const removed=await scrubOrphanedCodexAgentHomes(sessions, env);
rec('C2: the LIVE runner lease survives the Bridge startup sweep', leases().includes('exec-live'), leases().join(','));
rec('C2: the LIVE runner GH_TOKEN survives the sweep', cfg().includes('gho_TOKEN_A6'), cfg().includes('gho_TOKEN_A6')?'token retained':'TOKEN STRIPPED — C2 REGRESSION');
rec('terminal + orphan leases reclaimed', removed===2 && !leases().includes('exec-dead') && !leases().includes('exec-ghost'), `removed=${removed} left=${leases().join(',')}`);
rec('the sweep NEVER deletes the keyed home', fs.existsSync(HOME) && fs.existsSync(path.join(HOME,'.flywheel-agent-home.json')), HOME);

// identity drift must be refused, not silently reclaimed
const drift=await admitCodexAgentHome({...ID,executionId:'exec-drift',requestedAssemblyArm:'superpowers'},env);
const r2=await scrubOrphanedCodexAgentHomes(new Map([['exec-live',{...ID,status:'running'}],['exec-drift',{project:'geoforge3d',role:'implement',status:'completed'}]]), env);
rec('identity-drifted lease is REFUSED, not reclaimed', leases().includes('exec-drift') && r2===0, `removed=${r2} left=${leases().join(',')}`);

// legacy sweep still works on the old execution-scoped homes, and skips agents/
const LEG='exec-legacy-a6';
provisionCodexHome({executionId:LEG,env,contractSourcePath:CONTRACT,trustedProjectPath:WT,ghToken:'gho_LEGACY_A6',registryPath:REG,ledgerRoot:LEDGER});
const legCfg=()=>fs.readFileSync(path.join(codexHomeDir(LEG,env),'config.toml'),'utf8');
rec('legacy home provisioned with its token', legCfg().includes('gho_LEGACY_A6'), 'ok');
const n=scrubOrphanedCodexHomes(new Set(), env);
rec('legacy orphan sweep still scrubs the legacy home', !legCfg().includes('gho_LEGACY_A6') && n>=1, `scrubbed=${n}`);
rec('legacy sweep did NOT touch the keyed home token', cfg().includes('gho_TOKEN_A6'), cfg().includes('gho_TOKEN_A6')?'keyed token intact':'KEYED TOKEN STRIPPED BY LEGACY SWEEP');
rec('legacy sweep did NOT delete anything under agents/', fs.existsSync(HOME), HOME);

let f=0; for(const r of out){ if(!r.p) f++; console.log(`${r.p?'PASS':'FAIL'}  ${r.n}  :: ${r.d}`); }
console.log(`\n--- A6: ${out.length-f}/${out.length} passed ---`);
process.exit(f?1:0);
