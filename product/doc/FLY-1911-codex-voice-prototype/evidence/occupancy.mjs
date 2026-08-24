// FLY-1911 C2:真正那个数(语音会话期间能不能完成一次 agent turn)量不了 —— 干活那条端点 401。
// 但「是不是整段被占住」这一层能量,而且它正是口径 2 关心的东西:
// 语音正在流式播放的时候,这个进程还理不理别的请求?量 RTT,带无语音对照组。
// ⚠️ 边界:这量的是进程/传输层还活着,不等于它能完成一次真正的 agent turn。两者不许混。
import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
const OUT=process.env.OUT||"C2", WITH_VOICE=process.env.WITH_VOICE!=="0";
const PROBES=Number(process.env.PROBES||12), GAP=Number(process.env.GAP_MS||500);
const LOG=`${OUT}.jsonl`, sha=b=>createHash("sha256").update(b).digest("hex");
const log=(d,o)=>appendFileSync(LOG,JSON.stringify({t:new Date().toISOString(),dir:d,obj:o})+"\n");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const BIN=process.env.CODEX_BIN||"/Users/xiaorongli/.codex-mufasa/packages/standalone/releases/0.148.0-aarch64-apple-darwin/bin/codex";
const c=spawn(realpathSync(BIN),["--enable","realtime_conversation","app-server"],{stdio:["pipe","pipe","pipe"]});
const ev=[]; let buf="",id=0; const w=new Map(); let audio=0,lastAudioAt=null;
c.stdout.on("data",d=>{buf+=d;let n;while((n=buf.indexOf("\n"))>=0){const l=buf.slice(0,n).trim();buf=buf.slice(n+1);
 if(!l)continue;let m;try{m=JSON.parse(l)}catch{continue}
 if(m.method==="thread/realtime/outputAudio/delta"){audio++;lastAudioAt=Date.now();continue}
 if(m.method?.startsWith("thread/realtime/"))ev.push(m);
 if(m.id!==undefined&&w.has(m.id)){w.get(m.id)(m);w.delete(m.id)}}});
c.stderr.on("data",d=>{const s=d.toString().replace(/\x1b\[[0-9;]*m/g,"").trim();if(s)log("STDERR",s.slice(0,160))});
const rpc=(me,pa)=>{const i=++id;c.stdin.write(JSON.stringify({jsonrpc:"2.0",id:i,method:me,params:pa})+"\n");
 return new Promise(r=>{w.set(i,r);setTimeout(()=>{if(w.has(i)){w.delete(i);r({__timeout:true})}},20000)})};
async function main(){
 const M={issue:"FLY-1911",probe:"语音流式播放期间进程还理不理别的请求(RTT)",withVoice:WITH_VOICE,
  startedAt:new Date().toISOString(),codexSha256:sha(readFileSync(realpathSync(BIN))),
  probeSha256:sha(readFileSync(new URL(import.meta.url))),
  boundary:"量的是进程/传输层是否仍即时应答;不等于能完成一次真正的 agent turn"};
 await rpc("initialize",{clientInfo:{name:"fly1911-occ",title:"occupancy",version:"0.0.1"},capabilities:{experimentalApi:true}});
 c.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"initialized",params:{}})+"\n"); await sleep(300);
 if(WITH_VOICE){
  const tv=await rpc("thread/start",{}); const vt=tv?.result?.thread?.id;
  await rpc("thread/realtime/start",{threadId:vt,transport:{type:"websocket"},outputModality:"audio",voice:"marin",version:"v2"});
  const s=Date.now(); while(!ev.find(e=>/thread\/realtime\/(started|error)$/.test(e.method))&&Date.now()-s<25000) await sleep(50);
  const e=ev.find(e=>/thread\/realtime\/(started|error)$/.test(e.method));
  M.voiceSession=e?.method.endsWith("started")?"started":"failed";
  if(M.voiceSession!=="started"){M.result="语音会话没开起来,这组不算数";return fin(M)}
  await rpc("thread/realtime/appendSpeech",{threadId:vt,text:"请你慢慢地、详细地讲一段话,至少一分钟,不要停下来。"});
  const s2=Date.now(); while(audio===0&&Date.now()-s2<20000) await sleep(50);
  M.audioStarted=audio>0; log("VOICE",{audioStarted:M.audioStarted,chunks:audio});
  if(!audio){M.result="它没开口,这组不算数";return fin(M)}
 }
 const rtts=[]; const before=audio;
 for(let i=0;i<PROBES;i++){
  const t0=Date.now(); const r=await rpc("thread/start",{}); const dt=Date.now()-t0;
  const streaming = WITH_VOICE ? (lastAudioAt!==null && Date.now()-lastAudioAt < 1500) : null;
  rtts.push({i,rttMs:dt,timedOut:!!r?.__timeout,audioChunksSoFar:audio,voiceStreamingRightNow:streaming});
  await sleep(GAP);
 }
 M.probes=rtts; M.audioDuringProbes=audio-before;
 const ok=rtts.filter(x=>!x.timedOut).map(x=>x.rttMs).sort((a,b)=>a-b);
 M.rttSummary={n:ok.length,timedOut:rtts.filter(x=>x.timedOut).length,
  minMs:ok[0]??null,medianMs:ok[Math.floor(ok.length/2)]??null,maxMs:ok[ok.length-1]??null};
 M.windowSec=+(((PROBES*(GAP))+ok.reduce((a,b)=>a+b,0))/1000).toFixed(1);
 log("RESULT",{rttSummary:M.rttSummary,audioDuringProbes:M.audioDuringProbes,windowSec:M.windowSec});
 fin(M);
}
function fin(M){writeFileSync(`${OUT}-manifest.json`,JSON.stringify(M,null,2));
 console.log(JSON.stringify({withVoice:M.withVoice,voiceSession:M.voiceSession,audioStarted:M.audioStarted,
  rttSummary:M.rttSummary,audioDuringProbes:M.audioDuringProbes,windowSec:M.windowSec,result:M.result},null,1));
 try{c.stdin.end()}catch{};setTimeout(()=>{try{c.kill("SIGKILL")}catch{};process.exit(0)},600)}
main().catch(e=>{log("THROW",String(e?.stack||e));console.error(e);fin({threw:String(e)})});
