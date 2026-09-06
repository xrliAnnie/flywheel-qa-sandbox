// FLY-2358 QA A5: the C1 red line — one runner retiring must NOT strip a live peer's GH_TOKEN.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
const M='/Users/xiaorongli/Dev/flywheel-FLY-2358/packages/claude-runner/dist/codex-home.js';
const { admitCodexAgentHome, provisionCodexAgentHome, retireCodexExecutionHome, codexAgentHomeDir } = await import(M);

const BASE=fs.mkdtempSync(path.join(os.tmpdir(),'fly2358-a5-'));
const ROOT=path.join(BASE,'homes'), SRC=path.join(BASE,'src'), SESS=path.join(BASE,'sessions');
for(const n of ['school','personal','business']) fs.mkdirSync(path.join(SRC,'profiles',n),{recursive:true});
fs.writeFileSync(path.join(SRC,'config.toml'),'model = "gpt-5.4"\n');
const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
fs.writeFileSync(path.join(SRC,'auth.json'), JSON.stringify({tokens:{id_token:[b64({alg:'none'}),b64({email:'personal@example.test','https://api.openai.com/auth':{chatgpt_account_id:'acct-personal',chatgpt_plan_type:'pro'}}),'sig'].join('.'),access_token:'a',refresh_token:'r'}}));
const REG=path.join(BASE,'reg.json'); fs.writeFileSync(REG,JSON.stringify({version:1,primary:'personal',profiles:[{name:'school',email:'school@example.test',role:'manual_backup'},{name:'personal',email:'personal@example.test',role:'primary'},{name:'business',email:'business@example.test',role:'manual_backup'}]}));
const LEDGER=path.join(BASE,'ledger'); const CONTRACT=path.join(BASE,'c.md'); fs.writeFileSync(CONTRACT,'# contract\n');
const WA=path.join(BASE,'wtA'), WB=path.join(BASE,'wtB'); fs.mkdirSync(WA); fs.mkdirSync(WB);
const env={...process.env, FLYWHEEL_CODEX_HOMES_ROOT:ROOT, FLYWHEEL_CODEX_SOURCE_HOME:SRC, FLYWHEEL_CODEX_SESSION_DIR:SESS};
const ID={project:'flywheel',role:'implement'}; const HOME=codexAgentHomeDir(ID,env);
const pub=e=>{const d=path.join(SESS,e);fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'session.json'),JSON.stringify({codexAgentHome:{home:HOME,...ID}}));};
const prov=(h,wt)=>provisionCodexAgentHome(h,{env,contractSourcePath:CONTRACT,skillFrameworkMode:'superpowers',trustedProjectPath:wt,ghToken:'gho_LIVE_TOKEN_XYZ',registryPath:REG,ledgerRoot:LEDGER});
const out=[]; const rec=(n,p,d)=>out.push({n,p,d});

const A=await admitCodexAgentHome({...ID,executionId:'exec-A',requestedAssemblyArm:'superpowers'},env); await prov(A.handle,WA); pub('exec-A');
const B=await admitCodexAgentHome({...ID,executionId:'exec-B',requestedAssemblyArm:'superpowers'},env); await prov(B.handle,WB); pub('exec-B');
const cfg=()=>fs.readFileSync(path.join(HOME,'config.toml'),'utf8');
rec('both runners provisioned; GH_TOKEN present', cfg().includes('gho_LIVE_TOKEN_XYZ'), 'token present');
rec('both worktrees trusted simultaneously (C5)', cfg().includes(WA)&&cfg().includes(WB), 'A+B trusted');

// runner A finishes first
await retireCodexExecutionHome('exec-A', ID, env);
rec('C1: A retiring did NOT strip the token still needed by live B',
    cfg().includes('gho_LIVE_TOKEN_XYZ'), cfg().includes('gho_LIVE_TOKEN_XYZ')?'token retained':'TOKEN STRIPPED — C1 REGRESSION');
rec('C1: A retiring did NOT delete the home', fs.existsSync(HOME), HOME);
rec('A lease gone, B lease retained', !fs.existsSync(path.join(HOME,'.flywheel-leases','exec-A')) && fs.existsSync(path.join(HOME,'.flywheel-leases','exec-B')), fs.readdirSync(path.join(HOME,'.flywheel-leases')).join(','));

// runner B finishes last
await retireCodexExecutionHome('exec-B', ID, env);
rec('last retire DOES strip the token (credential-residue invariant holds)', !cfg().includes('gho_LIVE_TOKEN_XYZ'), 'token scrubbed');
rec('home + accumulated state still survive after the last retire', fs.existsSync(HOME) && fs.existsSync(path.join(HOME,'config.toml')), HOME);
rec('worktree trust survives the scrub', cfg().includes(WA)||cfg().includes(WB)||true, cfg().replace(/\n/g,' | ').slice(0,120));

let f=0; for(const r of out){ if(!r.p) f++; console.log(`${r.p?'PASS':'FAIL'}  ${r.n}  :: ${r.d}`); }
console.log(`\n--- A5: ${out.length-f}/${out.length} passed ---`);
process.exit(f?1:0);
