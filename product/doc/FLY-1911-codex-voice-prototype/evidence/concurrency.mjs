// FLY-1911 C1:Annie 问的「开半小时会的同时,它还能不能 orchestrate 自己的 runner?」
// 量法:同一个 app-server 里,一边挂着语音会话,一边给另一条 thread 发正经活,量它多久做完。
// 带对照组:同样的活,在没有语音会话的干净进程里再跑一次。没有对照组的数字说明不了任何事。
import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
const OUT=process.env.OUT||"C1", WITH_VOICE=process.env.WITH_VOICE!=="0";
const TASK=process.env.TASK||"用一句话说出这个仓库当前分支的名字,只说名字。";
const LOG=`${OUT}.jsonl`, sha=b=>createHash("sha256").update(b).digest("hex");
const log=(d,o)=>appendFileSync(LOG,JSON.stringify({t:new Date().toISOString(),dir:d,obj:o})+"\n");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const BIN=process.env.CODEX_BIN||"/Users/xiaorongli/.codex-mufasa/packages/standalone/releases/0.148.0-aarch64-apple-darwin/bin/codex";
const c=spawn(realpathSync(BIN),["--enable","realtime_conversation","app-server"],{stdio:["pipe","pipe","pipe"]});
const ev=[]; let buf="",id=0; const w=new Map();
let turnStartedAt=null,turnDoneAt=null,turnStatus=null,firstItemAt=null,voiceAudio=0;
c.stdout.on("data",d=>{buf+=d;let n;while((n=buf.indexOf("\n"))>=0){const l=buf.slice(0,n).trim();buf=buf.slice(n+1);
 if(!l)continue;let m;try{m=JSON.parse(l)}catch{continue}
 if(m.method==="thread/realtime/outputAudio/delta"){voiceAudio++;continue}
 if(m.method?.startsWith("mcpServer/"))continue;
 if(m.method==="item/commandExecution/requestApproval"||m.method==="item/fileChange/requestApproval"){
   c.stdin.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{decision:"acceptForSession"}})+"\n");
   log("APPROVE",{reason:(m.params?.reason||"").slice(0,80)});continue}
 if(m.method==="turn/started"){turnStartedAt=Date.now();log("TURN",{state:"started"})}
 if(m.method==="item/started"&&!firstItemAt){firstItemAt=Date.now();log("FIRST-ITEM",{msAfterTurnStart:firstItemAt-turnStartedAt})}
 if(m.method==="turn/completed"){turnDoneAt=Date.now();turnStatus=m.params?.turn?.status;log("TURN",{state:"completed",status:turnStatus})}
 if(m.method==="error")log("ERR",{msg:(m.params?.error?.message||"").slice(0,140)});
 if(m.method?.startsWith("thread/realtime/"))ev.push(m);
 if(m.id!==undefined&&w.has(m.id)){w.get(m.id)(m);w.delete(m.id)}}});
c.stderr.on("data",d=>{const s=d.toString().replace(/\x1b\[[0-9;]*m/g,"").trim();if(s)log("STDERR",s.slice(0,200))});
const rpc=(me,pa)=>{const i=++id;c.stdin.write(JSON.stringify({jsonrpc:"2.0",id:i,method:me,params:pa})+"\n");
 return new Promise(r=>{w.set(i,r);setTimeout(()=>{if(w.has(i)){w.delete(i);r({__timeout:true})}},60000)})};
async function main(){
 const M={issue:"FLY-1911",probe:"语音会话进行中还能不能干别的活",withVoice:WITH_VOICE,
  startedAt:new Date().toISOString(),codexResolved:realpathSync(BIN),codexSha256:sha(readFileSync(realpathSync(BIN))),
  probeSha256:sha(readFileSync(new URL(import.meta.url))),task:TASK};
 await rpc("initialize",{clientInfo:{name:"fly1911-conc",title:"concurrency",version:"0.0.1"},capabilities:{experimentalApi:true}});
 c.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"initialized",params:{}})+"\n"); await sleep(300);
 if(WITH_VOICE){
   const tv=await rpc("thread/start",{}); const voiceThread=tv?.result?.thread?.id; M.voiceThreadId=voiceThread;
   await rpc("thread/realtime/start",{threadId:voiceThread,transport:{type:"websocket"},outputModality:"audio",voice:"marin",version:"v2"});
   const s=Date.now(); while(!ev.find(e=>/thread\/realtime\/(started|error)$/.test(e.method))&&Date.now()-s<25000) await sleep(50);
   const e=ev.find(e=>/thread\/realtime\/(started|error)$/.test(e.method));
   M.voiceSession=e?.method.endsWith("started")?"started":"failed";
   log("VOICE",{state:M.voiceSession});
   if(M.voiceSession!=="started"){M.result="语音会话没开起来,这次不算数";return fin(M)}
   // 让它在会话里一直说话,模拟「正在开会」
   await rpc("thread/realtime/appendSpeech",{threadId:voiceThread,text:"请你慢慢地、详细地讲一段话,至少一分钟,不要停。"});
   await sleep(3000);
   M.voiceAudioBeforeTask=voiceAudio;
   log("VOICE",{state:"正在说话",audioChunks:voiceAudio});
 }
 // 会议进行中,另开一条 thread 干正经活
 const tt=await rpc("thread/start",{}); const workThread=tt?.result?.thread?.id; M.workThreadId=workThread;
 const t0=Date.now();
 await rpc("turn/start",{threadId:workThread,input:[{type:"text",text:TASK}]});
 const until=Date.now()+120000;
 while(!turnDoneAt&&Date.now()<until) await sleep(200);
 M.task={ requestedAt:t0, turnStartedAfterMs:turnStartedAt?turnStartedAt-t0:null,
   firstItemAfterMs:firstItemAt?firstItemAt-t0:null,
   completedAfterMs:turnDoneAt?turnDoneAt-t0:null, status:turnStatus,
   timedOut:!turnDoneAt };
 M.voiceAudioAfterTask=voiceAudio;
 M.voiceStillStreaming = WITH_VOICE ? (voiceAudio > (M.voiceAudioBeforeTask||0)) : null;
 log("TASK",M.task);
 fin(M);
}
function fin(M){writeFileSync(`${OUT}-manifest.json`,JSON.stringify(M,null,2));
 console.log(JSON.stringify({withVoice:M.withVoice,voiceSession:M.voiceSession,task:M.task,
  voiceAudioBefore:M.voiceAudioBeforeTask,voiceAudioAfter:M.voiceAudioAfterTask,voiceStillStreaming:M.voiceStillStreaming},null,1));
 try{c.stdin.end()}catch{};setTimeout(()=>{try{c.kill("SIGKILL")}catch{};process.exit(0)},800)}
main().catch(e=>{log("THROW",String(e?.stack||e));console.error(e);fin({threw:String(e)})});
