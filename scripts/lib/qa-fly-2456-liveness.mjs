import { isAbsolute } from "node:path";

// This module only renders the host command. It never executes a process.
export const livenessSource = String.raw`
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const {probeCodexDaemonLiveness,resolveDaemonSocketPath,codexSessionStateDir}=await import(pathToFileURL(process.argv[1]).href);
const rows=[];
for(const executionId of process.argv.slice(2)) {
 const readPgid=()=>{try{const s=JSON.parse(readFileSync(join(codexSessionStateDir(executionId,process.env),'session.json'),'utf8'));return s.daemonPgid??s.daemonPid??null;}catch{return null;}};
 const persistedPgidBefore=readPgid();
 const verdict=await probeCodexDaemonLiveness(executionId,{env:process.env});
 const socketPath=resolveDaemonSocketPath(executionId,process.env);
 const options={encoding:'utf8',timeout:2000,maxBuffer:65536,stdio:['ignore','pipe','pipe']};
 let holderPids=[],holderError=null;
 try {
  const pids=execFileSync('lsof',['-t','--',socketPath],options).trim().split(/\s+/).filter(Boolean);
  holderPids=[...new Set(pids)].map(pid=>{
   if(!/^[1-9][0-9]*$/.test(pid))throw new Error('invalid holder pid');
   const pgid=Number(execFileSync('ps',['-o','pgid=','-p',pid],options).trim());
   if(!Number.isSafeInteger(pgid)||pgid<=1)throw new Error('invalid holder pgid');
   return {pid:Number(pid),pgid};
  });
 }catch(error){holderError=String(error.code??error.status??'unavailable');}
 let groupState='unknown';
 if(Number.isSafeInteger(persistedPgidBefore)&&persistedPgidBefore>1) {
  try{process.kill(-persistedPgidBefore,0);groupState='alive';}
  catch(error){groupState=error.code==='ESRCH'?'absent':error.code==='EPERM'?'alive':'unknown';}
 }
 const persistedPgidAfter=readPgid();
 rows.push({executionId,verdict,socketPath,persistedPgidBefore,persistedPgidAfter,groupState,holderPids,holderError,observedAt:new Date().toISOString()});
}
console.log(JSON.stringify(rows));
`.trim();
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
export function livenessCommand({
	runtimeModule,
	stateDir,
	socketRoot,
	markerDir,
	executions,
	nodeExecutable = process.execPath,
}) {
	if (
		![runtimeModule, stateDir, socketRoot, markerDir, nodeExecutable].every(
			(x) => typeof x === "string" && isAbsolute(x) && !x.includes("\0"),
		)
	)
		throw new Error("absolute liveness paths required");
	if (
		!Array.isArray(executions) ||
		!executions.length ||
		new Set(executions).size !== executions.length ||
		executions.some((x) => typeof x !== "string" || !/^[A-Za-z0-9_-]+$/.test(x))
	)
		throw new Error("execution identities invalid");
	return [
		"env",
		quote(`FLYWHEEL_CODEX_SESSION_DIR=${stateDir}`),
		quote(`FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT=${socketRoot}`),
		quote(`FLYWHEEL_BRIDGE_SYNCOP_DIR=${markerDir}`),
		quote(nodeExecutable),
		"--input-type=module -e",
		quote(livenessSource),
		"--",
		quote(runtimeModule),
		...executions.map(quote),
	].join(" ");
}
