/*
 * FLY-1911 任务 4(P-6):建一条语音会话,中间大段沉默,半小时后还能不能继续说话。
 * 会议模式(FLY-1851)在等这个数。房里不需要人 —— 所以不接 Discord,直接对 codex 跑。
 *
 * 做法:v3 全程把麦克风开着(只送静音),
 *   第一次问 → 确认它活着 → 静默 SILENCE_MIN 分钟 → 再问一次 → 看它还答不答。
 * ⚠️ v3 的铁律:麦克风一停它就当被拔了。所以静默期送的是**静音帧**,不是不送。
 */
import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { RTCPeerConnection, MediaStreamTrack, RtpPacket, RtpHeader } from "werift";
import OpusScript from "opusscript";
const OUT=process.env.OUT||"T4-p6", SIL_MIN=Number(process.env.SILENCE_MIN||30);
const WAV=process.env.WAV||"question48.wav";
const sha=b=>createHash("sha256").update(b).digest("hex");
const log=(d,o)=>{const l=JSON.stringify({t:new Date().toISOString(),dir:d,obj:o});appendFileSync(OUT+".jsonl",l+"\n");console.log(l)};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const opus=new OpusScript(48000,2,OpusScript.Application.AUDIO);
const FRAME=960, BPF=FRAME*2*2;
const SIL=Buffer.from(opus.encode(Buffer.alloc(BPF),FRAME));
const BIN=realpathSync(process.env.CODEX_BIN||"/Users/xiaorongli/.codex-mufasa/packages/standalone/releases/0.148.0-aarch64-apple-darwin/bin/codex");
const c=spawn(BIN,["--enable","realtime_conversation","app-server"],{stdio:["pipe","pipe","pipe"]});
let buf="",id=0; const w=new Map();
let answerSdp=null, rtpIn=0, phase="启动";
const tx=[], events=[];
c.stdout.on("data",d=>{buf+=d;let n;while((n=buf.indexOf("\n"))>=0){const l=buf.slice(0,n).trim();buf=buf.slice(n+1);
 if(!l)continue;let m;try{m=JSON.parse(l)}catch{continue}
 if(m.method==="thread/realtime/sdp"){answerSdp=String(m.params?.sdp||"");}
 else if(m.method==="thread/realtime/transcript/done"){const p=m.params||{};
   tx.push({phase,role:p.role,text:p.text,at:new Date().toISOString()}); log("TX",{phase,role:p.role,text:p.text}); }
 else if(/^thread\/realtime\/(started|closed|error)$|^error$/.test(m.method||"")){
   events.push({phase,method:m.method,p:m.params?.message??m.params?.error?.message??m.params?.reason??m.params?.version??null,at:new Date().toISOString()});
   log("EV",events.at(-1)); }
 if(m.id!==undefined&&w.has(m.id)){w.get(m.id)(m);w.delete(m.id)}}});
c.stderr.on("data",d=>{const s=d.toString().replace(/\x1b\[[0-9;]*m/g,"").trim();if(s)log("STDERR",s.slice(0,200))});
const rpc=(me,pa={})=>{const i=++id;c.stdin.write(JSON.stringify({jsonrpc:"2.0",id:i,method:me,params:pa})+"\n");
 return new Promise(r=>{w.set(i,r);setTimeout(()=>{if(w.has(i)){w.delete(i);r({__timeout:true})}},30000)})};

const M={issue:"FLY-1911",probe:`任务4 P-6 静默 ${SIL_MIN} 分钟`,startedAt:new Date().toISOString(),
  codexResolved:BIN,codexSha256:sha(readFileSync(BIN)),probeSha256:sha(readFileSync(new URL(import.meta.url))),
  silenceMinutes:SIL_MIN};
await rpc("initialize",{clientInfo:{name:"fly1911-p6",title:"p6",version:"0.0.1"},capabilities:{experimentalApi:true}});
c.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"initialized",params:{}})+"\n"); await sleep(400);
const th=await rpc("thread/start",{}); const threadId=th?.result?.thread?.id; M.threadId=threadId;
const pc=new RTCPeerConnection({}); const dch=pc.createDataChannel("oai-events");
const dcKinds=new Set(); dch.onMessage.subscribe(msg=>{let o;try{o=JSON.parse(String(msg))}catch{return} dcKinds.add(o.type)});
const track=new MediaStreamTrack({kind:"audio"}); pc.addTransceiver(track,{direction:"sendrecv"});
pc.onTrack.subscribe(t=>t.onReceiveRtp.subscribe(()=>{rtpIn++}));
const off=await pc.createOffer(); await pc.setLocalDescription(off);
const r=await rpc("thread/realtime/start",{threadId,transport:{type:"webrtc",sdp:pc.localDescription.sdp},
  outputModality:"audio",voice:"cove",version:"v3",delegationAckFiller:true,codexResponseHandoffMode:"thinking",
  realtimeStartInstructions:"你必须始终使用中文回答。回答简短、口语化。"});
if(r?.error){ M.startRejected=r.error; fin(); await sleep(3000); }
const s2=Date.now(); while(!answerSdp&&Date.now()-s2<20000) await sleep(100);
if(!answerSdp){ M.fail="没等到 SDP answer"; fin(); await sleep(3000); }
await pc.setRemoteDescription({type:"answer",sdp:answerSdp});
const s3=Date.now(); while(pc.connectionState!=="connected"&&Date.now()-s3<25000) await sleep(200);
M.pcStateAtStart=pc.connectionState;
if(pc.connectionState!=="connected"){ M.fail="WebRTC 没连上"; fin(); await sleep(3000); }

/* 常开麦克风:静音一直送,只有要问话时换成真音频 */
let seq=(Math.floor(Date.now()/7)%30000)+1, ts=0; const ssrc=track.ssrc||123456789;
const speakQ=[]; let rtpOut=0;
let next=Date.now()+20;
(function mic(){ const now=Date.now(); let g=0;
  while(next<=now&&g<10){ const pl=speakQ.length?speakQ.shift():SIL;
    try{ track.writeRtp(new RtpPacket(new RtpHeader({version:2,payloadType:96,sequenceNumber:seq++&0xffff,timestamp:ts>>>0,ssrc}),pl)); rtpOut++ }catch{}
    ts=(ts+FRAME)>>>0; next+=20; g++ }
  if(next<=now) next=now+20;
  setTimeout(mic,Math.max(1,next-Date.now()));
})();
function say(){ const src=readFileSync(WAV); let off2=12,data=null;
  while(off2+8<=src.length){const idd=src.toString("ascii",off2,off2+4),sz=src.readUInt32LE(off2+4);
    if(idd==="data"){data=src.subarray(off2+8,off2+8+sz);break} off2+=8+sz+(sz%2)}
  let n=0;
  for(let o=0;o<data.length;o+=BPF){ let sl=data.subarray(o,o+BPF);
    if(sl.length<BPF){const p2=Buffer.alloc(BPF);sl.copy(p2);sl=p2}
    try{ speakQ.push(Buffer.from(opus.encode(sl,FRAME))); n++ }catch{} }
  return n;
}
async function ask(tag){
  phase=tag; const before=tx.length, t0=Date.now();
  const frames=say(); log("ASK",{phase:tag,frames});
  // 等它答(最多 150 秒)
  const until=Date.now()+150000;
  while(Date.now()<until){ await sleep(500);
    if(tx.filter(x=>x.phase===tag&&x.role==="assistant").length) break; }
  const got=tx.filter(x=>x.phase===tag);
  const firstAsst=got.find(x=>x.role==="assistant");
  const res={phase:tag, 它听成:got.filter(x=>x.role==="user").map(x=>x.text),
    它答了:got.filter(x=>x.role==="assistant").map(x=>x.text),
    多久开口ms: firstAsst? (new Date(firstAsst.at).getTime()-t0) : null,
    回话了: !!firstAsst };
  log("ASK-RESULT",res); return res;
}
M.第一次=await ask("静默前");
log("SILENCE-START",{分钟:SIL_MIN});
phase="静默中";
const silStart=Date.now(), silEnd=silStart+SIL_MIN*60000;
const marks=[];
while(Date.now()<silEnd){ await sleep(60000);
  const mk={分钟:+((Date.now()-silStart)/60000).toFixed(1), pcState:pc.connectionState,
    dcState:dch.readyState, rtpOut, rtpIn, 会话事件数:events.length};
  marks.push(mk); log("MARK",mk);
  if(pc.connectionState!=="connected"){ log("DIED",{在第几分钟:mk.分钟}); break }
}
M.静默期观测=marks;
M.静默结束时={pcState:pc.connectionState,dcState:dch.readyState,rtpOut,rtpIn};
log("SILENCE-END",M.静默结束时);
M.第二次=await ask("静默后");
M.dcEventKinds=[...dcKinds];
M.总时长分钟=+((Date.now()-new Date(M.startedAt).getTime())/60000).toFixed(1);
M.结论={ 静默前能对话:!!M.第一次?.回话了, 静默后还能对话:!!M.第二次?.回话了,
  连接是否一直在:pc.connectionState==="connected" };
try{ await rpc("thread/realtime/stop",{threadId}) }catch{}
await sleep(500);
fin();
function fin(){ try{pc?.close()}catch{}
  M.transcripts=tx; M.events=events;
  writeFileSync(OUT+"-manifest.json",JSON.stringify(M,null,2));
  console.log("=== 结论 ===",JSON.stringify(M.结论??{fail:M.fail??M.startRejected},null,1));
  try{c.stdin.end()}catch{}; setTimeout(()=>{try{c.kill("SIGKILL")}catch{};process.exit(0)},800) }
