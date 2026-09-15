#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {mkdtempSync,readFileSync,writeFileSync,statSync,chmodSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=mkdtempSync(join(tmpdir(),'fly2570-cli-'));
const path=join(root,'models.json');
function command(args, ok=true, config=path) {
 const result=spawnSync(process.execPath,['scripts/design-model-split.mjs',...args,'--config',config],{encoding:'utf8'});
 assert.equal(result.status===0,ok,result.stderr);
 return ok ? JSON.parse(result.stdout) : result.stderr;
}
try {
 const misplaced=spawnSync(process.execPath,['scripts/design-model-split.mjs','show','--config','--codex-percent'],{encoding:'utf8'});
 assert.notEqual(misplaced.status,0,'an option must not be accepted as a config path');
 assert.equal(command(['show']).ruleVersion,'fly2403-v1');
 let version;
 for(const percent of [75,0,100,37.125,75]) {
  const result=command(['set','--codex-percent',String(percent)]);
  assert.equal(result.codexPercent,percent);
  assert.equal(result.fablePercent,100-percent);
  assert.equal(command(['show']).ruleVersion,result.ruleVersion);
  assert.equal(statSync(path).mode & 0o777,0o600);
  assert.equal(statSync(path).uid,process.getuid());
  if(percent===75) { if(version) assert.equal(result.ruleVersion,version); version=result.ruleVersion; }
 }
 const doc=JSON.parse(readFileSync(path)); doc.founderExtension={keep:true}; writeFileSync(path,JSON.stringify(doc));
 command(['set','--codex-percent','0']); assert.deepEqual(JSON.parse(readFileSync(path)).founderExtension,{keep:true});
 const before=readFileSync(path,'utf8');
 writeFileSync(path,JSON.stringify({version:1,modelSplit:{enabled:true,rule:'issue_number_parity',version:'constant-a',odd:{arm:'A',model:'astra'},even:{arm:'A',model:'astra'}}}));
 assert.equal(command(['show']).codexPercent,100);
 writeFileSync(path,before);
 for(const value of ['', 'wat','Infinity','-1','101','NaN']) {
  command(['set','--codex-percent',value],false); assert.equal(readFileSync(path,'utf8'),before);
 }
 for(const args of [['set','--codex-percent','75','--codex-percent','0'],['show','--codex-percent','0'],['set','--wat','0'],['show','--config',path]]) command(args,false);
 chmodSync(path,0o644); command(['set','--codex-percent','75'],false); assert.equal(readFileSync(path,'utf8'),before); chmodSync(path,0o600);
 const link=join(root,'link.json'); symlinkSync(path,link); command(['set','--codex-percent','75'],false,link);
 for(const bytes of ['{','{"version":2}','{"version":1,"bindings":{"fable":"unknown"}}','{"version":1,"modelSplit":{"rule":"bad"}}']) {
  writeFileSync(path,bytes); command(['show'],false); command(['set','--codex-percent','75'],false); assert.equal(readFileSync(path,'utf8'),bytes);
 }
 assert.match(command(['set','--codex-percent','0'],false,join(root,'missing','models.json')),/parent directory.*missing/);
 writeFileSync(path,before);
 const moduleUrl=pathToFileURL(resolve('packages/config/dist/index.js')).href;
 const holder=spawn(process.execPath,['--input-type=module','-e',`import {withModelAuthorityLock} from ${JSON.stringify(moduleUrl)}; await withModelAuthorityLock(process.argv[1],async()=>{console.log('held'); await new Promise(()=>{setInterval(()=>{},1000);});});`,path],{stdio:['ignore','pipe','inherit']});
 // A timer keeps the orphan fixture alive while its lock body is suspended.
 await once(holder.stdout,'data');
 assert.match(command(['set','--codex-percent','75'],false),/acquisition budget exhausted.*Retry/);
 assert.equal(readFileSync(path,'utf8'),before);
 const closed=once(holder,'close'); holder.kill('SIGKILL'); await closed;
 assert.equal(command(['set','--codex-percent','0']).codexPercent,0);
 const backup=join(root,'known-good.json');writeFileSync(backup,readFileSync(path),{mode:0o600});writeFileSync(path,'{');
 const runbook=readFileSync('engineering/doc/FLY-2570-dynamic-design-split/operator.md','utf8');
 const restore=runbook.match(/<<'JS'\n([\s\S]*?)\nJS/)[1];
 const recovery=spawnSync(process.execPath,['--input-type=module','-',path,backup],{input:restore,encoding:'utf8'});
 assert.equal(recovery.status,0,recovery.stderr);
 assert.equal(command(['show']).codexPercent,0);
 console.log('PASS: percentage CLI, rollback, safety, strict input and preservation');
} finally {rmSync(root,{recursive:true,force:true});}
JS
