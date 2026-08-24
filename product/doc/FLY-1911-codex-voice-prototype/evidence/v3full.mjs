// FLY-1911 E4:把 v3 的 WebRTC 握手接完(data channel + setRemoteDescription),
// 这样事件才会流回来。目的:验 Annie 说的「前面即时应声、后面真干活」,以及它能不能一直说中文。
import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { RTCPeerConnection, MediaStreamTrack, RtpPacket, RtpHeader } from "werift";
import OpusScript from "opusscript";
const opus=new OpusScript(48000,2,OpusScript.Application.AUDIO);
const pcmParts=[];
const OUT=process.env.OUT||"E4", VOICE=process.env.RT_VOICE||"cove";
const ACK=process.env.ACK_FILLER!=="0", MODE=process.env.HANDOFF_MODE||"thinking";
const ASK=process.env.ASK||"今天 Flywheel 有几个 PR 还没合并?";
const HOLD=Number(process.env.HOLD_MS||120000);
const LOG=`${OUT}.jsonl`, sha=b=>createHash("sha256").update(b).digest("hex");
const log=(d,o)=>appendFileSync(LOG,JSON.stringify({t:new Date().toISOString(),dir:d,obj:o})+"\n");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const BIN=process.env.CODEX_BIN||"/Users/xiaorongli/.codex-mufasa/packages/standalone/releases/0.148.0-aarch64-apple-darwin/bin/codex";
const c=spawn(realpathSync(BIN),["--enable","realtime_conversation","app-server"],{stdio:["pipe","pipe","pipe"]});
const ev=[],dcEvents=[],tx=[],approvals=[];
let t0=Date.now(),askAt=null,rtpPackets=0,firstRtpAt=null,answerSdp=null;
let buf="";const w=new Map();
c.stdout.on("data",d=>{buf+=d;let n;while((n=buf.indexOf("\n"))>=0){const l=buf.slice(0,n).trim();buf=buf.slice(n+1);
 if(!l)continue;let m;try{m=JSON.parse(l)}catch{continue} if(m.method?.startsWith("mcpServer/"))continue;
 if(m.method==="thread/realtime/sdp"){answerSdp=String(m.params?.sdp||"");
  log("<<SDP",{chars:answerSdp.length,sha256:sha(answerSdp),
   codec:answerSdp.split("\n").map(x=>x.trim()).filter(x=>/^(m=audio|a=rtpmap)/.test(x))});ev.push(m);continue}
 if(m.method?.startsWith("thread/realtime/transcript/")&&m.method.endsWith("done")){
  const p=m.params||{};tx.push({src:"jsonrpc",role:p.role,text:p.text,sinceAskMs:askAt?Date.now()-askAt:null});
  log("<<TX",tx.at(-1));continue}
 if(m.method==="item/commandExecution/requestApproval"||m.method==="item/fileChange/requestApproval"){
  approvals.push({reason:m.params?.reason??null,sinceAskMs:askAt?Date.now()-askAt:null});log("APPROVE",approvals.at(-1));
  c.stdin.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{decision:"acceptForSession"}})+"\n");continue}
 if(/^(thread\/realtime\/(started|error|closed)|turn\/(started|completed)|error)$/.test(m.method||"")){
  log("<<",{method:m.method,p:m.params?.message??m.params?.error?.message??m.params?.turn?.status??m.params?.version??null,
   sinceAskMs:askAt?Date.now()-askAt:null});ev.push(m)}
 if(m.id!==undefined&&w.has(m.id)){w.get(m.id)(m);w.delete(m.id)}}});
c.stderr.on("data",d=>{const s=d.toString().replace(/\x1b\[[0-9;]*m/g,"").trim();if(s)log("ERR",s.slice(0,300))});
let id=0;const rpc=(me,pa)=>{const i=++id;
 log(">>",{i,me,pa:me==="thread/realtime/start"?{...pa,transport:{type:"webrtc",sdp:"<redacted>"}}:pa});
 c.stdin.write(JSON.stringify({jsonrpc:"2.0",id:i,method:me,params:pa})+"\n");
 return new Promise(r=>{w.set(i,r);setTimeout(()=>{if(w.has(i)){w.delete(i);r({__timeout:true})}},30000)})};
async function main(){
 const M={issue:"FLY-1911",probe:"v3 full webrtc handshake",startedAt:new Date().toISOString(),
  codexResolved:realpathSync(BIN),codexSha256:sha(readFileSync(realpathSync(BIN))),
  probeSha256:sha(readFileSync(new URL(import.meta.url))),
  params:{version:"v3",voice:VOICE,delegationAckFiller:ACK,codexResponseHandoffMode:MODE},ask:ASK};
 await rpc("initialize",{clientInfo:{name:"fly1911-v3full",title:"v3 full",version:"0.0.1"},capabilities:{experimentalApi:true}});
 c.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"initialized",params:{}})+"\n");await sleep(300);
 const th=await rpc("thread/start",{});const threadId=th?.result?.thread?.id;M.threadId=threadId;
 const pc=new RTCPeerConnection({});
 const dc=pc.createDataChannel("oai-events");           // ← 上次缺的就是它
 dc.onMessage.subscribe(msg=>{ let o;try{o=JSON.parse(String(msg))}catch{return}
   dcEvents.push(o.type);
   if(/response|transcript|audio|delegat|handoff|error/.test(o.type||""))log("<<DC",{type:o.type,sinceAskMs:askAt?Date.now()-askAt:null,peek:JSON.stringify(o).slice(0,220)});
   if(/transcript|text/.test(o.type||"")){
     const t=o.transcript??o.delta??o.text;
     if(typeof t==="string"&&t.trim()&&/done|completed/.test(o.type)){
       tx.push({src:"datachannel",type:o.type,text:t,sinceAskMs:askAt?Date.now()-askAt:null});log("<<DC-TX",tx.at(-1));}
   }
   if(/error/.test(o.type||""))log("<<DC-ERR",o);
 });
 dc.stateChanged.subscribe(s=>log("DC",{state:s}));
 const outTrack=new MediaStreamTrack({kind:"audio"});
 const tr=pc.addTransceiver(outTrack,{direction:"sendrecv"});
 pc.onTrack.subscribe(track=>{ track.onReceiveRtp.subscribe(rtp=>{rtpPackets++;if(!firstRtpAt)firstRtpAt=Date.now();
   try{ if(rtp.payload&&rtp.payload.length>2) pcmParts.push(Buffer.from(opus.decode(rtp.payload))) }catch(e){} }); });
 const o=await pc.createOffer();await pc.setLocalDescription(o);
 t0=Date.now();
 const r=await rpc("thread/realtime/start",{threadId,transport:{type:"webrtc",sdp:pc.localDescription.sdp},
  outputModality:"audio",voice:VOICE,version:"v3",delegationAckFiller:ACK,codexResponseHandoffMode:MODE,
  realtimeStartInstructions:"你必须始终使用中文回答,无论用户用什么语言提问。回答简短、口语化。"});
 if(r?.error){M.result={admitted:false,error:r.error};return fin(M,pc)}
 const s=Date.now();while(!ev.find(e=>/thread\/realtime\/(started|error)$/.test(e.method))&&Date.now()-s<25000)await sleep(50);
 const e=ev.find(e=>/thread\/realtime\/(started|error)$/.test(e.method));
 M.startOutcome={outcome:e?.method.endsWith("started")?"started":"error",version:e?.params?.version,message:e?.params?.message};
 log("START",M.startOutcome); if(M.startOutcome.outcome!=="started")return fin(M,pc);
 // 接完握手 —— 这是上次缺的一步
 const s2=Date.now();while(!answerSdp&&Date.now()-s2<15000)await sleep(100);
 M.gotAnswer=!!answerSdp;
 if(answerSdp){ await pc.setRemoteDescription({type:"answer",sdp:answerSdp}); log("HANDSHAKE",{setRemoteDescription:"ok"}); }
 const s3=Date.now();while(pc.connectionState!=="connected"&&Date.now()-s3<25000)await sleep(200);
 M.pcState=pc.connectionState; M.dcState=dc.readyState; log("PC",{state:pc.connectionState,dc:dc.readyState});
 await sleep(1500); askAt=Date.now();
 const AM=process.env.APPEND_METHOD||"appendSpeech";
 // v3 是 frameless bidi:塞完上下文还要显式触发一轮,二进制里那个事件名就叫 response.create
 await rpc(`thread/realtime/${AM}`, AM==="appendText"?{threadId,text:ASK,role:"user"}:{threadId,text:ASK});
 await sleep(400);
 // v3 没有文字触发口(服务端逐字列过它支持的九个动作,里面没有 response.create)
 // ⇒ 唯一的驱动方式是把真音频经 RTP 推进去
 if(process.env.PUSH_AUDIO!=="0"){
   const src=readFileSync(process.env.IN48||"probe-in-48k.wav");
   let off=12,data=null;
   while(off+8<=src.length){const id=src.toString("ascii",off,off+4),sz=src.readUInt32LE(off+4);
     if(id==="data"){data=src.subarray(off+8,off+8+sz);break} off+=8+sz+(sz%2)}
   const FRAME=960; // 20ms @48k
   const bytesPerFrame=FRAME*2*2;
   let seq=(Math.floor(Date.now()/7)%30000)+1, ts=0; const ssrc=outTrack.ssrc||123456789;
   let sent=0;
   for(let o=0;o<data.length;o+=bytesPerFrame){
     let slice=data.subarray(o,o+bytesPerFrame);
     if(slice.length<bytesPerFrame){const pad=Buffer.alloc(bytesPerFrame);slice.copy(pad);slice=pad}
     let payload; try{ payload=Buffer.from(opus.encode(slice,FRAME)) }catch(e){ log("ENC-FAIL",{e:String(e)}); break }
     const header=new RtpHeader({version:2,payloadType:96,sequenceNumber:seq++&0xffff,timestamp:ts>>>0,ssrc,marker:sent===0});
     try{ outTrack.writeRtp(new RtpPacket(header,payload)) }catch(e){ log("RTP-FAIL",{e:String(e)}); break }
     ts=(ts+FRAME)>>>0; sent++;
     await sleep(20);
   }
   // v3 是「麦克风一直开着」的形态:一停止推流,它就当麦克风被拔了,会话会自己关。
   // 所以尾部不是补 50 帧就完事 —— 要像真麦克风一样持续送静音,直到我不想听了为止。
   const sil=Buffer.alloc(bytesPerFrame);
   let keepAlive=true;
   globalThis.__stopMic=()=>{keepAlive=false};
   (async()=>{ let n=0;
     while(keepAlive){ try{ const p2=Buffer.from(opus.encode(sil,FRAME));
       outTrack.writeRtp(new RtpPacket(new RtpHeader({version:2,payloadType:96,sequenceNumber:seq++&0xffff,timestamp:ts>>>0,ssrc}),p2));
       ts=(ts+FRAME)>>>0; n++ }catch(e){}
       await sleep(20); }
     log("MIC-KEEPALIVE",{silenceFramesSent:n});
   })();
   log("RTP-PUSH",{framesSent:sent,micKeptOpen:true});
 }
 const until=Date.now()+HOLD;let last=-1,quiet=Date.now();
 while(Date.now()<until){await sleep(300);const n=tx.length+dcEvents.length+rtpPackets;
  if(n!==last){last=n;quiet=Date.now()}else if(tx.length&&Date.now()-quiet>10000)break}
 if(pcmParts.length){ const pcm=Buffer.concat(pcmParts),sr=48000,ch=2,br=sr*ch*2,h=Buffer.alloc(44);
  h.write("RIFF",0);h.writeUInt32LE(36+pcm.length,4);h.write("WAVE",8);h.write("fmt ",12);h.writeUInt32LE(16,16);
  h.writeUInt16LE(1,20);h.writeUInt16LE(ch,22);h.writeUInt32LE(sr,24);h.writeUInt32LE(br,28);h.writeUInt16LE(ch*2,32);
  h.writeUInt16LE(16,34);h.write("data",36);h.writeUInt32LE(pcm.length,40);
  writeFileSync(OUT+"-v3.wav",Buffer.concat([h,pcm]));
  M.v3Audio={path:OUT+"-v3.wav",bytes:pcm.length,durationSec:+(pcm.length/br).toFixed(2),sampleRate:sr,channels:ch}; }
 try{globalThis.__stopMic?.()}catch{}
 await sleep(300);
 M.transcripts=tx;M.approvals=approvals;M.rtpPackets=rtpPackets;
 M.firstRtpSinceAskMs=firstRtpAt&&askAt?firstRtpAt-askAt:null;
 M.dcEventKinds=[...new Set(dcEvents)].slice(0,40);
 await rpc("thread/realtime/stop",{threadId});await sleep(600);
 fin(M,pc);
}
function fin(M,pc){try{pc?.close()}catch{}
 writeFileSync(`${OUT}-manifest.json`,JSON.stringify(M,null,2));
 console.log(JSON.stringify({startOutcome:M.startOutcome,gotAnswer:M.gotAnswer,pcState:M.pcState,dcState:M.dcState,
  rtpPackets:M.rtpPackets,firstRtpSinceAskMs:M.firstRtpSinceAskMs,v3Audio:M.v3Audio,approvals:M.approvals,
  transcripts:M.transcripts,dcEventKinds:M.dcEventKinds},null,1));
 try{c.stdin.end()}catch{};setTimeout(()=>{try{c.kill("SIGKILL")}catch{};process.exit(0)},800)}
main().catch(e=>{log("THROW",String(e?.stack||e));console.error(e);fin({threw:String(e)})});
