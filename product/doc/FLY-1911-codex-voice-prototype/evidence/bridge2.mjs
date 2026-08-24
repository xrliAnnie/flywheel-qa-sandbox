#!/usr/bin/env node
/*
 * FLY-1911 任务 3:把 v3 焊进 Discord 桥。同一个文件也还能跑 v2(RT_VERSION=v2)。
 *
 * 为什么 v3 值得焊:v2 是回合制 —— 它说话的时候不听你说,而且不会「先应一声」。
 * Annie 的三条抱怨(问完很久没动静 / 打不断它 / 声音卡顿)都指向这里。
 *
 * ⭐ 顺手解掉「卡顿」最大的嫌疑人:
 *   v2 的音频是 24k 单声道,Discord 是 48k 立体声 ⇒ 上一版要做两次朴素重采样(线性插值/左右取平均)。
 *   v3 本身就是 48k 立体声 Opus,和 Discord 一模一样 ⇒ **这一版一次重采样都不做。**
 *   · 上行(她 → 它):Discord 的 Opus 包**原样**塞进 RTP,连解码都不解。
 *   · 下行(它 → 她):Opus 解成 48k 立体声 PCM 直接播,不改采样率。
 *   ⚠️ 这是**消除了一个嫌疑人**,不等于卡顿一定好了 —— 卡顿本来就没量过,别当成已修。
 *
 * ⚠️ v3 的铁律(上一轮验出来的):麦克风一停就当被拔了,会话自己关。
 *   所以两个方向都必须是**常开流**:没声音要送静音,不能不送。
 */
import "libsodium-wrappers";
import { Client, GatewayIntentBits } from "discord.js";
import { joinVoiceChannel, VoiceConnectionStatus, entersState, EndBehaviorType,
         createAudioPlayer, createAudioResource, StreamType, getVoiceConnection } from "@discordjs/voice";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { readFileSync, appendFileSync, writeFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import OpusScript from "opusscript";
import { RTCPeerConnection, MediaStreamTrack, RtpPacket, RtpHeader } from "werift";

const GUILD=process.env.GUILD_ID, CHAN=process.env.VOICE_CHANNEL_ID, TV=process.env.TOKEN_VAR||"TEST_BOT_TOKEN_1";
const VER=process.env.RT_VERSION||"v3";
const OUT=process.env.OUT||"T3-bridge", RUN_MIN=Number(process.env.RUN_MIN||10);
const LIVE=process.env.LIVE_LOG||(process.env.HOME+"/.fly1911/live.jsonl");
const RAW=`${OUT}-raw.jsonl`;
const sha=b=>createHash("sha256").update(b).digest("hex");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// 一条日志同时写两处:归档给我看,live 给她的窗口看
const log=(d,o)=>{const l=JSON.stringify({t:new Date().toISOString(),dir:d,obj:o});
  appendFileSync(OUT+".jsonl",l+"\n"); try{appendFileSync(LIVE,l+"\n")}catch{} console.log(l)};
const rawlog=o=>{try{appendFileSync(RAW,JSON.stringify({t:new Date().toISOString(),...o})+"\n")}catch{}};

const env=Object.fromEntries(readFileSync(process.env.HOME+"/.flywheel/.env","utf8").split("\n")
 .filter(l=>l.includes("=")&&!l.trim().startsWith("#")).map(l=>[l.slice(0,l.indexOf("=")).trim(),l.slice(l.indexOf("=")+1).trim()]));
const token=env[TV]; if(!token){console.error(TV+" 不在 .env");process.exit(1)}

/* ⭐ 不漂移的节拍器 —— 这是这一版最重要的修。
 * 上一轮实测:setInterval(fn,20) 在负载下真实周期是 ~25ms,
 * 于是 4 分钟里该发 12000 帧只发了 9578 帧 ⇒ **音频是按真实时间的 80% 在送的**。
 * 后果两条,而且正好对上她抱怨的两件事:
 *   · 上行:她的话被拉长/断续送进去 ⇒ ASR 听错(这次把"有几个 PR 还没合并"听成了"有个邮件")
 *   · 下行:播放流喂不满 ⇒ player 饿着 ⇒ 她耳朵里就是**卡顿**
 * 修法:按绝对时刻排程,落后了就在同一拍里补发,不让误差累积。
 */
function pace(everyMs, tick){
  let next=Date.now()+everyMs;
  const loop=()=>{
    const now=Date.now();
    let n=0;
    while(next<=now && n<10){ try{tick()}catch(e){} next+=everyMs; n++; }   // 落后就补,最多补 10 帧防雪崩
    if(next<=now) next=now+everyMs;                                          // 落后太多就认栽,重新对表
    setTimeout(loop, Math.max(1,next-Date.now()));
  };
  setTimeout(loop, everyMs);
}
let paceStats={outTicks:0,inTicks:0,startedAt:Date.now()};
/* 三个开关 —— 不是为了留配置,是为了能做对照实验:
 * 一次只动一个变量,才说得出「是哪一个在起作用」。 */
const SW={ pacer: process.env.SW_PACER!=="0",        // 不漂移节拍器 vs 裸 setInterval
           jitter: process.env.SW_JITTER!=="0",      // 上行抖动缓冲 vs 空了就塞静音
           depth: process.env.SW_DEPTH!=="0" };      // 下行按缓冲深度补写 vs 一拍一帧
// 关掉节拍器时退回原来那个会漂移的做法,好让对照跑的是真实的旧行为
const schedule=(ms,fn)=> SW.pacer ? pace(ms,fn) : setInterval(fn,ms);

const opus=new OpusScript(48000,2,OpusScript.Application.AUDIO);
const FRAME=960;                       // 20ms @48k
const SILENCE_PCM=Buffer.alloc(FRAME*2*2);
let SILENCE_OPUS=null; try{ SILENCE_OPUS=Buffer.from(opus.encode(SILENCE_PCM,FRAME)) }catch(e){ console.error("静音帧编码失败",e); }

/* ---------- codex app-server ---------- */
const BIN=realpathSync(process.env.CODEX_BIN||"/Users/xiaorongli/.codex-mufasa/packages/standalone/releases/0.148.0-aarch64-apple-darwin/bin/codex");
const cx=spawn(BIN,["--enable","realtime_conversation","app-server"],{stdio:["pipe","pipe","pipe"]});
let threadId=null, rpcId=0, buf=""; const waiters=new Map();
let answerSdp=null;
const stats={version:VER, roomOpusIn:0, rtpOut:0, rtpIn:0, pcmOutBytes:0,
  userTx:[], asstTx:[], plans:[], runs:[], answers:[], handoffs:[], approvals:0, errors:[], dcKinds:new Set()};

function onCodexEvent(m){
  const meth=m.method;
  // ① 原样落盘(音频只留大小)—— 上一轮那个「grep 出来是 0」的洞,从这里堵死
  if(meth==="thread/realtime/outputAudio/delta"){
    rawlog({msg:{...m,params:{...m.params,audio:{len:(m.params?.audio?.data||"").length}}}});
  } else rawlog({msg:m});

  if(meth==="thread/realtime/sdp"){ answerSdp=String(m.params?.sdp||""); log("SDP",{chars:answerSdp.length}); return; }
  // v2 才走这条(音频在 JSON-RPC 上);v3 的音频走 RTP
  if(meth==="thread/realtime/outputAudio/delta"){ globalThis.__v2Audio?.(Buffer.from(m.params?.audio?.data||"","base64")); return; }
  if(meth==="thread/realtime/transcript/done"){
    const p=m.params||{}; (p.role==="user"?stats.userTx:stats.asstTx).push(p.text);
    log("TX",{role:p.role,text:p.text}); return;
  }
  if(meth==="thread/realtime/itemAdded"){
    const it=m.params?.item||{};
    if(it.type==="handoff_request"){
      stats.handoffs.push({heard:it.input_transcript??null});
      log("HANDOFF",{"交办时用的转写":it.input_transcript??null});
    }
    return;
  }
  // ⭐ 任务 2 挖出来的那批 —— 她要的 indicator 全在这里,以前被 continue 掉了
  if(meth==="item/started"||meth==="item/completed"){
    const it=m.params?.item||{};
    if(it.type==="commandExecution" && meth==="item/started"){
      stats.runs.push(it.command); log("RUN",{command:it.command}); return;
    }
    if(it.type==="reasoning" && meth==="item/started"){ log("THINK",{}); return; }
    if(it.type==="agentMessage" && meth==="item/completed"){
      if(it.phase==="commentary"){ stats.plans.push(it.text); log("PLAN",{text:it.text}); return; }
      if(it.phase==="final_answer"){ stats.answers.push(it.text); log("ANSWER",{text:it.text}); return; }
    }
    return;
  }
  if(meth==="account/rateLimits/updated"){ log("QUOTA",m.params?.rateLimits||{}); return; }
  if(meth==="mcpServer/startupStatus/updated"){ if(m.params?.status==="failed") log("MCP",m.params); return; }
  if(meth==="item/commandExecution/requestApproval"||meth==="item/fileChange/requestApproval"){
    stats.approvals++; log("APPROVE",{reason:(m.params?.reason||"").slice(0,90)});
    cx.stdin.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{decision:"acceptForSession"}})+"\n"); return;
  }
  if(meth==="error"){const e=(m.params?.error?.message||m.params?.message||"").slice(0,200);stats.errors.push(e);log("CODEX-ERR",{msg:e});return}
  if(meth==="thread/realtime/started") log("CODEX",{state:"realtime started",version:m.params?.version});
  if(meth==="thread/realtime/closed")  log("CODEX",{state:"realtime closed",reason:m.params?.reason??null});
}
cx.stdout.on("data",d=>{buf+=d;let n;while((n=buf.indexOf("\n"))>=0){const l=buf.slice(0,n).trim();buf=buf.slice(n+1);
 if(!l)continue;let m;try{m=JSON.parse(l)}catch{continue}
 try{ onCodexEvent(m) }catch(e){ rawlog({handlerThrew:String(e)}) }
 if(m.id!==undefined&&waiters.has(m.id)){waiters.get(m.id)(m);waiters.delete(m.id)}}});
cx.stderr.on("data",d=>{const s=d.toString().replace(/\x1b\[[0-9;]*m/g,"").trim();if(s)rawlog({stderr:s.slice(0,300)})});
const rpc=(me,pa)=>{const i=++rpcId;cx.stdin.write(JSON.stringify({jsonrpc:"2.0",id:i,method:me,params:pa})+"\n");
 return new Promise(r=>{waiters.set(i,r);setTimeout(()=>{if(waiters.has(i)){waiters.delete(i);r({__timeout:true})}},30000)})};

/* ---------- Discord ---------- */
const dec=new OpusScript(48000,2,OpusScript.Application.AUDIO);
const dc=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildVoiceStates]});

dc.once("clientReady",async()=>{
  log("GATEWAY",{bot:dc.user.tag});
  const M={issue:"FLY-1911",probe:"任务3 v3 焊进 Discord",startedAt:new Date().toISOString(),
    codexResolved:BIN,codexSha256:sha(readFileSync(BIN)),
    probeSha256:sha(readFileSync(new URL(import.meta.url))),version:VER,resampling:"无(48k 立体声全程)"};

  await rpc("initialize",{clientInfo:{name:"fly1911-bridge2",title:"FLY-1911 v3 Discord",version:"0.0.2"},capabilities:{experimentalApi:true}});
  cx.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"initialized",params:{}})+"\n"); await sleep(400);
  const th=await rpc("thread/start",{}); threadId=th?.result?.thread?.id;
  if(!threadId){ log("RESULT",{ok:false,where:"thread/start"}); return bye(M) }

  /* ---- 建 realtime 会话 ---- */
  let pc=null, outTrack=null;
  const inOpusQ=[];                        // 房里来的 Opus 包(原样,不解码)
  const outPcmQ=[];                        // 要放给她听的 48k 立体声 PCM

  if(VER==="v3"){
    pc=new RTCPeerConnection({});
    const dchan=pc.createDataChannel("oai-events");
    dchan.onMessage.subscribe(msg=>{ let o;try{o=JSON.parse(String(msg))}catch{return}
      stats.dcKinds.add(o.type); rawlog({dc:o.type,peek:JSON.stringify(o).slice(0,300)}); });
    outTrack=new MediaStreamTrack({kind:"audio"});
    pc.addTransceiver(outTrack,{direction:"sendrecv"});
    pc.onTrack.subscribe(track=>{ track.onReceiveRtp.subscribe(rtp=>{ stats.rtpIn++;
      if(rtp.payload&&rtp.payload.length>2){
        try{ const pcm=Buffer.from(dec.decode(rtp.payload)); outPcmQ.push(pcm); stats.pcmOutBytes+=pcm.length; }catch{}
      }});});
    const off=await pc.createOffer(); await pc.setLocalDescription(off);
    const r=await rpc("thread/realtime/start",{threadId,transport:{type:"webrtc",sdp:pc.localDescription.sdp},
      outputModality:"audio",voice:process.env.RT_VOICE||"cove",version:"v3",
      delegationAckFiller:process.env.ACK_FILLER!=="0", codexResponseHandoffMode:process.env.HANDOFF_MODE||"thinking",
      realtimeStartInstructions:"你必须始终使用中文回答，无论用户用什么语言提问。回答简短、口语化，像在语音通话里说话。"});
    if(r?.error){ M.startRejected=r.error; log("RESULT",{ok:false,where:"realtime/start",error:r.error}); return bye(M) }
    // 接完握手 —— 不接的话事件不会回流
    const s2=Date.now(); while(!answerSdp&&Date.now()-s2<20000) await sleep(100);
    M.gotAnswer=!!answerSdp;
    if(!answerSdp){ log("RESULT",{ok:false,where:"没等到 SDP answer"}); return bye(M) }
    await pc.setRemoteDescription({type:"answer",sdp:answerSdp});
    const s3=Date.now(); while(pc.connectionState!=="connected"&&Date.now()-s3<25000) await sleep(200);
    M.pcState=pc.connectionState; log("PC",{state:pc.connectionState});
    if(pc.connectionState!=="connected"){ log("RESULT",{ok:false,where:"WebRTC 没连上",state:pc.connectionState}); return bye(M) }
  } else {
    const r=await rpc("thread/realtime/start",{threadId,transport:{type:"websocket"},outputModality:"audio",
      voice:process.env.RT_VOICE||"marin",version:"v2",
      realtimeStartInstructions:"你必须始终使用中文回答。回答简短、口语化。"});
    if(r?.error){ M.startRejected=r.error; log("RESULT",{ok:false,where:"realtime/start",error:r.error}); return bye(M) }
  }

  /* ---- 进房 ---- */
  const g=await dc.guilds.fetch(GUILD);
  const conn=joinVoiceChannel({channelId:CHAN,guildId:GUILD,adapterCreator:g.voiceAdapterCreator,selfDeaf:false,selfMute:false});
  try{ await entersState(conn,VoiceConnectionStatus.Ready,25000); log("JOINED",{}); }
  catch(e){ log("RESULT",{ok:false,where:"discord",reason:String(e?.message||e)}); return bye(M) }

  /* ---- 嘴:把它的声音放进房里(48k 立体声,不重采样) ---- */
  const speaker=new PassThrough();
  const F48=Buffer.alloc(FRAME*2*2);
  let outCarry=Buffer.alloc(0);
  globalThis.__v2Audio=(raw24)=>{ // v2 回退路径才需要:24k 单声道 → 48k 立体声
    const n=raw24.length/2, o=Buffer.alloc(n*2*4); let k=0;
    for(let i=0;i<n;i++){ const cur=raw24.readInt16LE(i*2), nxt=i+1<n?raw24.readInt16LE((i+1)*2):cur, mid=(cur+nxt)>>1;
      for(const v of [cur,mid]){ o.writeInt16LE(v,k); o.writeInt16LE(v,k+2); k+=4 } }
    outPcmQ.push(o.subarray(0,k)); stats.pcmOutBytes+=k;
  };
  /* ⭐ 下行不能「一拍写一帧」。
   * discord 的 player 是**按精确 50 帧/秒来拉**的,而我们的定时器实测只有 48 帧/秒(慢 4%)——
   * 差这 4% 意味着**每秒有约 2 次它伸手来拿、缓冲里却是空的**,那就是一次断音。
   * 修法:不数自己写了几帧,而是**把缓冲维持在目标深度**;它拉得快,我们就多写几帧补上。
   * 这样即便定时器不准,player 也永远拿得到。 */
  const TARGET_FRAMES=5;               // 100ms 余量:够吸收抖动,又不至于让延迟明显变大
  let starved=0, wrote=0;
  schedule(20,()=>{
    paceStats.outTicks++;
    let guard=0;
    const oneFrame=()=>{
      while(outCarry.length<F48.length&&outPcmQ.length) outCarry=Buffer.concat([outCarry,outPcmQ.shift()]);
      if(outCarry.length>=F48.length){ speaker.write(outCarry.subarray(0,F48.length)); outCarry=outCarry.subarray(F48.length); }
      else speaker.write(F48);          // 常开流:没内容就送静音,流一断 player 就 idle 再也不消费
      wrote++;
    };
    if(SW.depth){ while(speaker.readableLength < TARGET_FRAMES*F48.length && guard++ < 12) oneFrame(); }
    else oneFrame();                    // 旧行为:一拍只写一帧,播放器拉得比我们快就会饿着
    if(speaker.readableLength < F48.length) starved++;   // 真饿着了,记一笔
  });
  globalThis.__outStats=()=>({播放缓冲写入帧:wrote, 缓冲见底次数:starved});
  const player=createAudioPlayer(); conn.subscribe(player);
  player.on("error",e=>log("PLAYER-ERR",{msg:String(e?.message||e)}));
  player.play(createAudioResource(speaker,{inputType:StreamType.Raw}));
  /* ⭐ 真正的尺子:missedFrames 是 discord 的播放器自己记的
   * 「我到点伸手拿音频、结果没拿到」的次数 —— 每一次就是她耳朵里的一次断音。
   * 我原先自己数的「缓冲见底」是我在**我的**时刻看到的,不是播放器的经历 ——
   * 那是个近似,不是那个属性本身。这里换成播放器自己的账。 */
  globalThis.__missed=()=>{ const st=player.state; return {
    状态:st.status,
    播放器漏掉的帧:(st.status==="playing"||st.status==="buffering")?st.missedFrames??null:null,
    已播放毫秒:st.resource?.playbackDuration??null }; };

  /* ---- 耳朵:房里的 Opus 包原样往上送(v3),或解码降采样(v2) ---- */
  const subs=new Set();
  conn.receiver.speaking.on("start",uid=>{
    if(uid===dc.user.id||subs.has(uid))return;
    subs.add(uid); log("SPEAKING",{userId:uid});
    const s=conn.receiver.subscribe(uid,{end:{behavior:EndBehaviorType.AfterSilence,duration:800}});
    s.on("data",chunk=>{ stats.roomOpusIn++;
      if(VER==="v3") inOpusQ.push(chunk);         // ← 原样,不解码不重采样
      else { try{ const pcm48=Buffer.from(dec.decode(chunk));
        const n=pcm48.length/4, o=Buffer.alloc(Math.floor(n/2)*2); let k=0;
        for(let i=0;i+1<n;i+=2){ const l=pcm48.readInt16LE(i*4), r2=pcm48.readInt16LE(i*4+2);
          o.writeInt16LE(Math.max(-32768,Math.min(32767,(l+r2)>>1)),k); k+=2 }
        globalThis.__v2In?.(o.subarray(0,k)); }catch{} }
    });
    s.on("end",()=>{ subs.delete(uid); log("STREAM-END",{userId:uid}) });
  });

  /* ---- 上行常开流 ---- */
  if(VER==="v3"){
    let seq=(Math.floor(Date.now()/7)%30000)+1, ts=0; const ssrc=outTrack.ssrc||123456789;
    /* 抖动缓冲:房里的包不会精准每 20ms 到一个,时快时慢。
     * 一旦某一拍队列恰好是空的就塞静音,等于**在她一句话中间剪进一段空白** —— ASR 会听错。
     * 所以:攒够 PREBUF 帧才开始放,放空了才回到静音状态。 */
    const PREBUF=3; let draining=false;
    schedule(20,()=>{
      paceStats.inTicks++;
      let payload;
      if(SW.jitter){
        if(!draining && inOpusQ.length>=PREBUF) draining=true;
        if(draining && inOpusQ.length===0) draining=false;
        if(draining && inOpusQ.length){ payload=inOpusQ.shift(); }
        else { payload=SILENCE_OPUS; stats.silenceOut=(stats.silenceOut||0)+1; }
      } else {
        // 旧行为:队列这一拍恰好空了就塞静音 —— 等于在她一句话中间剪进空白
        if(inOpusQ.length){ payload=inOpusQ.shift(); }
        else { payload=SILENCE_OPUS; stats.silenceOut=(stats.silenceOut||0)+1; }
      }
      if(inOpusQ.length>PREBUF*4) inOpusQ.splice(0, inOpusQ.length-PREBUF*2);  // 攒太多说明追不上,丢老的保实时
      if(!payload) return;
      try{ outTrack.writeRtp(new RtpPacket(new RtpHeader({version:2,payloadType:96,
        sequenceNumber:seq++&0xffff,timestamp:ts>>>0,ssrc}),payload)); stats.rtpOut++; }catch(e){}
      ts=(ts+FRAME)>>>0;
    });
  } else {
    const F24=Buffer.alloc(24000*2*0.02); const inQ=[]; let inCarry=Buffer.alloc(0);
    globalThis.__v2In=b=>inQ.push(b);
    schedule(20,()=>{ if(!threadId)return;
      while(inCarry.length<F24.length&&inQ.length) inCarry=Buffer.concat([inCarry,inQ.shift()]);
      let f; if(inCarry.length>=F24.length){ f=inCarry.subarray(0,F24.length); inCarry=inCarry.subarray(F24.length) } else f=F24;
      rpc("thread/realtime/appendAudio",{threadId,audio:{data:f.toString("base64"),sampleRate:24000,numChannels:1,samplesPerChannel:f.length/2}});
    });
  }

  log("READY",{msg:"房里可以说话了",通道:VER,重采样:VER==="v3"?"没有":"有(24k↔48k)",runMinutes:RUN_MIN});

  // v3 没有文字触发口(服务端支持的动作清单里没有 response.create),打招呼这一步只在 v2 有效。
  if(VER==="v2"){ await sleep(1200); await rpc("thread/realtime/appendSpeech",{threadId,text:"我上线了，现在可以跟我说话。"}); }
  else log("NOTE",{msg:"v3 是音频驱动的:没有文字触发口,所以不会自己先打招呼 —— 直接对它说话就行"});

  setTimeout(()=>{
    const el=(Date.now()-paceStats.startedAt)/1000;
    M.开关=SW;
    M.播放缓冲=globalThis.__outStats?.()??null;
    M.播放器自己的账=globalThis.__missed?.()??null;
    M.节拍器={上行帧每秒:+(paceStats.inTicks/el).toFixed(2), 下行帧每秒:+(paceStats.outTicks/el).toFixed(2),
      应为:50, 说明:"低于 50 就说明音频在按慢于真实时间的速度送,会同时造成听错和卡顿"};
    Object.assign(M,{ok:true, roomOpusIn:stats.roomOpusIn, rtpOut:stats.rtpOut, rtpIn:stats.rtpIn, silenceOut:stats.silenceOut??0,
      pcmOutBytes:stats.pcmOutBytes, userTranscripts:stats.userTx, assistantTranscripts:stats.asstTx,
      plans:stats.plans, runs:stats.runs, answers:stats.answers, handoffs:stats.handoffs,
      approvals:stats.approvals, codexErrors:stats.errors, dcEventKinds:[...stats.dcKinds].slice(0,60)});
    log("RESULT",M); bye(M);
  }, RUN_MIN*60000);

  function bye(m){ try{writeFileSync(`${OUT}-manifest.json`,JSON.stringify(m??M,null,2))}catch{}
    try{getVoiceConnection(GUILD)?.destroy()}catch{} try{pc?.close()}catch{} try{cx.stdin.end()}catch{}
    setTimeout(()=>{try{cx.kill("SIGKILL")}catch{};dc.destroy();process.exit(0)},1200) }
  globalThis.__bye=bye;
});
function bye(m){ try{if(m)writeFileSync(`${OUT}-manifest.json`,JSON.stringify(m,null,2))}catch{}
  try{getVoiceConnection(GUILD)?.destroy()}catch{} try{cx.stdin.end()}catch{}
  setTimeout(()=>{try{cx.kill("SIGKILL")}catch{};dc.destroy();process.exit(0)},1200) }
dc.login(token).catch(e=>{console.error("登录失败",e);process.exit(1)});
