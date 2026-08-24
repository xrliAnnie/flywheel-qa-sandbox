// FLY-1911 E3:验 Annie 说的那个「前面即时应声 + 后面真干活」在 v3 上是不是真的,
// 顺带验它能不能一直说中文。转写走 JSON-RPC,所以不需要接完 WebRTC 媒体面就能看行为。
import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { RTCPeerConnection } from "werift";
const OUT=process.env.OUT||"E3", VERSION=process.env.RT_VERSION||"v3", VOICE=process.env.RT_VOICE||"cove";
const ACK=process.env.ACK_FILLER!=="0", MODE=process.env.HANDOFF_MODE||"thinking";
const ASK=process.env.ASK||"今天 Flywheel 有几个 PR 还没合并?";
const HOLD=Number(process.env.HOLD_MS||150000);
const LOG=`${OUT}.jsonl`, sha=b=>createHash("sha256").update(b).digest("hex");
const log=(d,o)=>appendFileSync(LOG,JSON.stringify({t:new Date().toISOString(),dir:d,obj:o})+"\n");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const BIN=process.env.CODEX_BIN||"/Users/xiaorongli/.codex-mufasa/packages/standalone/releases/0.148.0-aarch64-apple-darwin/bin/codex";
const c=spawn(realpathSync(BIN),["--enable","realtime_conversation","app-server"],{stdio:["pipe","pipe","pipe"]});
const tx=[],ev=[],approvals=[]; let t0=Date.now(),askAt=null,audio=0,firstAudioAt=null;
let buf="";const w=new Map();
c.stdout.on("data",d=>{buf+=d;let n;while((n=buf.indexOf("\n"))>=0){const l=buf.slice(0,n).trim();buf=buf.slice(n+1);
 if(!l)continue;let m;try{m=JSON.parse(l)}catch{continue} if(m.method?.startsWith("mcpServer/"))continue;
 if(m.method==="thread/realtime/outputAudio/delta"){audio++;if(!firstAudioAt)firstAudioAt=Date.now();continue}
 if(m.method?.startsWith("thread/realtime/transcript/")){const p=m.params||{},k=m.method.endsWith("done")?"done":"delta";
  if(k==="done"){tx.push({role:p.role,text:p.text,tMs:Date.now()-t0,sinceAskMs:askAt?Date.now()-askAt:null});
   log("<<TX",tx[tx.length-1])} continue}
 if(m.method==="item/commandExecution/requestApproval"||m.method==="item/fileChange/requestApproval"){
  approvals.push({reason:m.params?.reason??null,sinceAskMs:askAt?Date.now()-askAt:null});log("APPROVE",approvals.at(-1));
  c.stdin.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{decision:"acceptForSession"}})+"\n");continue}
 if(m.method==="thread/realtime/sdp"){ev.push(m);continue}
 if(m.method==="thread/realtime/itemAdded"){const it=m.params?.item||{};
  if(it.type==="handoff_request")log("HANDOFF",{heard:it.input_transcript,sinceAskMs:askAt?Date.now()-askAt:null});continue}
 if(/^(thread\/realtime\/(started|error|closed)|turn\/(started|completed)|error)$/.test(m.method||"")){
  log("<<",{method:m.method,p:m.params?.message??m.params?.error?.message??m.params?.turn?.status??m.params?.version??null,
            sinceAskMs:askAt?Date.now()-askAt:null});ev.push(m)}
 if(m.id!==undefined&&w.has(m.id)){w.get(m.id)(m);w.delete(m.id)}}});
c.stderr.on("data",d=>{const s=d.toString().replace(/\x1b\[[0-9;]*m/g,"").trim();if(s)log("ERR",s.slice(0,300))});
let id=0;const rpc=(me,pa)=>{const i=++id;log(">>",{i,me,pa:me==="thread/realtime/start"?{...pa,transport:{type:pa.transport.type,sdp:"<redacted>"}}:pa});
 c.stdin.write(JSON.stringify({jsonrpc:"2.0",id:i,method:me,params:pa})+"\n");
 return new Promise(r=>{w.set(i,r);setTimeout(()=>{if(w.has(i)){w.delete(i);r({__timeout:true})}},30000)})};
async function main(){
 const M={issue:"FLY-1911",probe:"v3 ack-filler + 中文",startedAt:new Date().toISOString(),
   codexResolved:realpathSync(BIN),codexSha256:sha(readFileSync(realpathSync(BIN))),
   probeSha256:sha(readFileSync(new URL(import.meta.url))),
   params:{version:VERSION,voice:VOICE,delegationAckFiller:ACK,codexResponseHandoffMode:MODE},ask:ASK};
 await rpc("initialize",{clientInfo:{name:"fly1911-v3",title:"v3 probe",version:"0.0.1"},capabilities:{experimentalApi:true}});
 c.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"initialized",params:{}})+"\n"); await sleep(300);
 const th=await rpc("thread/start",{}); const threadId=th?.result?.thread?.id; M.threadId=threadId;
 const pc=new RTCPeerConnection({}); pc.addTransceiver("audio",{direction:"sendrecv"});
 const o=await pc.createOffer(); await pc.setLocalDescription(o);
 t0=Date.now();
 const start={threadId,transport:{type:"webrtc",sdp:pc.localDescription.sdp},outputModality:"audio",voice:VOICE,version:VERSION,
   delegationAckFiller:ACK,codexResponseHandoffMode:MODE,
   realtimeStartInstructions:"你必须始终使用中文回答,无论用户用什么语言提问。回答简短口语化。"};
 const r=await rpc("thread/realtime/start",start);
 if(r?.error){M.result={admitted:false,error:r.error};return fin(M)}
 const s=Date.now(); while(!ev.find(e=>/started|error$/.test(e.method))&&Date.now()-s<25000) await sleep(50);
 const e=ev.find(e=>/thread\/realtime\/(started|error)$/.test(e.method));
 M.startOutcome={outcome:e?.method.endsWith("started")?"started":"error",version:e?.params?.version,message:e?.params?.message};
 log("START",M.startOutcome);
 if(M.startOutcome.outcome!=="started"){M.result={admitted:false};return fin(M)}
 await sleep(500); askAt=Date.now();
 await rpc("thread/realtime/appendText",{threadId,text:ASK,role:"user"});
 const until=Date.now()+HOLD; let last=-1,quiet=Date.now();
 while(Date.now()<until){await sleep(300);const n=tx.length+audio;
  if(n!==last){last=n;quiet=Date.now()} else if(tx.some(x=>x.role==="assistant")&&Date.now()-quiet>8000)break}
 M.transcripts=tx; M.approvals=approvals; M.audioChunks=audio;
 M.firstAssistantMs=tx.find(x=>x.role==="assistant")?.sinceAskMs??null;
 M.lastAssistantMs=[...tx].reverse().find(x=>x.role==="assistant")?.sinceAskMs??null;
 M.firstAudioSinceAskMs=firstAudioAt&&askAt?firstAudioAt-askAt:null;
 await rpc("thread/realtime/stop",{threadId}); await sleep(600); try{pc.close()}catch{}
 fin(M);
}
function fin(M){writeFileSync(`${OUT}-manifest.json`,JSON.stringify(M,null,2));
 console.log(JSON.stringify({startOutcome:M.startOutcome,firstAssistantMs:M.firstAssistantMs,lastAssistantMs:M.lastAssistantMs,
  audioChunks:M.audioChunks,approvals:M.approvals,transcripts:M.transcripts},null,1));
 try{c.stdin.end()}catch{} setTimeout(()=>{try{c.kill("SIGKILL")}catch{};process.exit(0)},800)}
main().catch(e=>{log("THROW",String(e?.stack||e));console.error(e);fin({threw:String(e)})});
