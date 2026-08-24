#!/usr/bin/env node
/*
 * FLY-1911 主线:把 Codex 的嘴和耳朵接进 Discord 语音房。
 * 验收线(Annie 原话):起码我们能够在 Discord 里面去聊天,看它真的能做事情。
 *
 *   她在房里说话 ─48k立体声 Opus→ 解码 → 降到 24k 单声道 → codex appendAudio
 *   codex outputAudio/delta ─24k单声道→ 升到 48k 立体声 → Opus → 放回房里
 *
 * 走 v2/websocket:音频进出就是 JSON-RPC 上的 base64 PCM,和 Discord 这边接起来最直接。
 * ⚠️ 这是一次性验证原型。重采样是最朴素的做法(线性插值/取平均),不是音频工程。
 * ⚠️ 刻意不套用旧那条腿的「回合」形态 —— 复用代码可以,复用形态假设不行。
 */
import "libsodium-wrappers";
import { Client, GatewayIntentBits } from "discord.js";
import { joinVoiceChannel, VoiceConnectionStatus, entersState, EndBehaviorType,
         createAudioPlayer, createAudioResource, StreamType, getVoiceConnection } from "@discordjs/voice";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { readFileSync, appendFileSync, realpathSync } from "node:fs";
import OpusScript from "opusscript";

const GUILD=process.env.GUILD_ID, CHAN=process.env.VOICE_CHANNEL_ID, TV=process.env.TOKEN_VAR||"TEST_BOT_TOKEN_1";
const OUT=process.env.OUT||"B1-bridge", RUN_MIN=Number(process.env.RUN_MIN||10);
const log=(d,o)=>{const l=JSON.stringify({t:new Date().toISOString(),dir:d,obj:o});appendFileSync(OUT+".jsonl",l+"\n");console.log(l)};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const env=Object.fromEntries(readFileSync(process.env.HOME+"/.flywheel/.env","utf8").split("\n")
 .filter(l=>l.includes("=")&&!l.trim().startsWith("#")).map(l=>[l.slice(0,l.indexOf("=")).trim(),l.slice(l.indexOf("=")+1).trim()]));
const token=env[TV]; if(!token){log("FATAL",{msg:TV+" 不在 .env"});process.exit(1)}

/* ---------- 采样率转换(朴素,原型级) ---------- */
// 48k 立体声 Int16 → 24k 单声道 Int16:先左右取平均,再每两个取一个
function down48stereoTo24mono(buf){
  const n=buf.length/4;                       // 每帧 4 字节(L+R)
  const out=Buffer.alloc(Math.floor(n/2)*2);
  let o=0;
  for(let i=0;i+1<n;i+=2){
    const l=buf.readInt16LE(i*4), r=buf.readInt16LE(i*4+2);
    out.writeInt16LE(Math.max(-32768,Math.min(32767,(l+r)>>1)), o); o+=2;
  }
  return out.subarray(0,o);
}
// 24k 单声道 → 48k 立体声:线性插值补一个点,左右同值
function up24monoTo48stereo(buf){
  const n=buf.length/2;
  const out=Buffer.alloc(n*2*4);
  let o=0;
  for(let i=0;i<n;i++){
    const cur=buf.readInt16LE(i*2);
    const nxt=i+1<n?buf.readInt16LE((i+1)*2):cur;
    const mid=(cur+nxt)>>1;
    for(const v of [cur,mid]){ out.writeInt16LE(v,o); out.writeInt16LE(v,o+2); o+=4; }
  }
  return out.subarray(0,o);
}

/* ---------- codex app-server ---------- */
const BIN=process.env.CODEX_BIN||"/Users/xiaorongli/.codex-mufasa/packages/standalone/releases/0.148.0-aarch64-apple-darwin/bin/codex";
const cx=spawn(realpathSync(BIN),["--enable","realtime_conversation","app-server"],{stdio:["pipe","pipe","pipe"]});
let threadId=null, rpcId=0, buf=""; const waiters=new Map();
const stats={heardChunks:0,heardBytes:0,spokeChunks:0,spokeBytes:0,userTx:[],asstTx:[],approvals:0,errors:[]};
let speaker=null;   // 播回房里的 PassThrough
cx.stdout.on("data",d=>{buf+=d;let n;while((n=buf.indexOf("\n"))>=0){const l=buf.slice(0,n).trim();buf=buf.slice(n+1);
 if(!l)continue;let m;try{m=JSON.parse(l)}catch{continue}
 if(m.method?.startsWith("mcpServer/"))continue;
 if(m.method==="thread/realtime/outputAudio/delta"){
   const raw=Buffer.from(m.params?.audio?.data||"","base64");
   stats.spokeChunks++; stats.spokeBytes+=raw.length;
   globalThis.__pushOut?.(up24monoTo48stereo(raw));
   continue;
 }
 if(m.method==="thread/realtime/transcript/done"){
   const p=m.params||{};
   (p.role==="user"?stats.userTx:stats.asstTx).push(p.text);
   log("TX",{role:p.role,text:p.text}); continue;
 }
 if(m.method==="item/commandExecution/requestApproval"||m.method==="item/fileChange/requestApproval"){
   stats.approvals++; log("APPROVE",{reason:(m.params?.reason||"").slice(0,90)});
   cx.stdin.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{decision:"acceptForSession"}})+"\n"); continue;
 }
 if(m.method==="error"){const e=(m.params?.error?.message||"").slice(0,160);stats.errors.push(e);log("CODEX-ERR",{msg:e});continue}
 if(m.method==="thread/realtime/started")log("CODEX",{state:"realtime started",version:m.params?.version});
 if(m.method==="thread/realtime/closed")log("CODEX",{state:"realtime closed",reason:m.params?.reason});
 if(m.id!==undefined&&waiters.has(m.id)){waiters.get(m.id)(m);waiters.delete(m.id)}}});
cx.stderr.on("data",d=>{const s=d.toString().replace(/\x1b\[[0-9;]*m/g,"").trim();if(s)log("CODEX-STDERR",s.slice(0,160))});
const rpc=(me,pa)=>{const i=++rpcId;cx.stdin.write(JSON.stringify({jsonrpc:"2.0",id:i,method:me,params:pa})+"\n");
 return new Promise(r=>{waiters.set(i,r);setTimeout(()=>{if(waiters.has(i)){waiters.delete(i);r({__timeout:true})}},30000)})};

async function startCodex(){
  await rpc("initialize",{clientInfo:{name:"fly1911-discord-bridge",title:"FLY-1911 Discord↔Codex",version:"0.0.1"},capabilities:{experimentalApi:true}});
  cx.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"initialized",params:{}})+"\n"); await sleep(300);
  const th=await rpc("thread/start",{}); threadId=th?.result?.thread?.id;
  if(!threadId) throw new Error("thread/start 没给回 threadId");
  const r=await rpc("thread/realtime/start",{threadId,transport:{type:"websocket"},outputModality:"audio",
    voice:process.env.RT_VOICE||"marin",version:"v2",
    realtimeStartInstructions:"你必须始终使用中文回答,无论用户用什么语言提问。回答简短、口语化,像在语音通话里说话。"});
  if(r?.error) throw new Error("realtime/start 被拒:"+JSON.stringify(r.error));
  return threadId;
}

/* ---------- Discord ---------- */
const dec=new OpusScript(48000,2,OpusScript.Application.AUDIO);
const dc=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildVoiceStates]});
dc.once("clientReady",async()=>{
  log("GATEWAY",{bot:dc.user.tag});
  try{ await startCodex(); }catch(e){ log("RESULT",{ok:false,where:"codex",reason:String(e?.message||e)}); return bye(); }
  const g=await dc.guilds.fetch(GUILD);
  const conn=joinVoiceChannel({channelId:CHAN,guildId:GUILD,adapterCreator:g.voiceAdapterCreator,selfDeaf:false,selfMute:false});
  try{ await entersState(conn,VoiceConnectionStatus.Ready,25000); log("JOINED",{}); }
  catch(e){ log("RESULT",{ok:false,where:"discord",reason:String(e?.message||e)}); return bye(); }

  // 嘴:把 codex 的音频放回房里(Raw = 48k 立体声 Int16,正好是我们升采样后的格式)
  // ⚠️ 关键:播放流一旦空掉,player 就进 Idle 不再消费 —— 声音永远进不了房。
  // 所以下行也必须是一条常开流:有 Codex 的音频就放它,没有就放静音。
  speaker=new PassThrough();
  const FRAME48=Buffer.alloc(48000*2*2*0.02);      // 20ms @48k 立体声 = 3840 字节
  const outQ=[];                                    // 待播的 48k 立体声数据
  globalThis.__pushOut=(b)=>outQ.push(b);
  let outCarry=Buffer.alloc(0);
  setInterval(()=>{
    while(outCarry.length<FRAME48.length&&outQ.length) outCarry=Buffer.concat([outCarry,outQ.shift()]);
    if(outCarry.length>=FRAME48.length){ speaker.write(outCarry.subarray(0,FRAME48.length)); outCarry=outCarry.subarray(FRAME48.length); }
    else speaker.write(FRAME48);                    // 没东西可放就送静音,别让流断
  },20);
  const player=createAudioPlayer();
  conn.subscribe(player);
  player.on("error",e=>log("PLAYER-ERR",{msg:String(e?.message||e)}));
  player.on("stateChange",(o,n)=>{ if(o.status!==n.status) log("PLAYER",{from:o.status,to:n.status}) });
  player.play(createAudioResource(speaker,{inputType:StreamType.Raw}));

  // 耳朵:房里谁说话就订阅谁,解码降采样喂给 codex
  const subs=new Set();
  conn.receiver.speaking.on("start",uid=>{
    if(uid===dc.user.id||subs.has(uid))return;      // 不听自己说话
    subs.add(uid); log("SPEAKING",{userId:uid});
    const s=conn.receiver.subscribe(uid,{end:{behavior:EndBehaviorType.AfterSilence,duration:800}});
    s.on("data",chunk=>{
      let pcm48; try{ pcm48=Buffer.from(dec.decode(chunk)) }catch{ return }
      globalThis.__pushIn?.(down48stereoTo24mono(pcm48));   // 只入队,由常开的上行流统一送
    });
    s.on("end",()=>{ subs.delete(uid); log("STREAM-END",{userId:uid,heardChunks:stats.heardChunks}) });
  });

  // ⚠️ 同一条教训的另一半:喂给 Codex 的也必须是常开流。
  // Discord 只在有人说话时才有包,中间是断的;服务端 VAD 需要连续的流才判得出「说完了」。
  const FRAME24=Buffer.alloc(24000*2*0.02);        // 20ms @24k 单声道 = 960 字节
  const inQ=[]; let inCarry=Buffer.alloc(0);
  globalThis.__pushIn=(b)=>inQ.push(b);
  setInterval(()=>{
    if(!threadId)return;
    while(inCarry.length<FRAME24.length&&inQ.length) inCarry=Buffer.concat([inCarry,inQ.shift()]);
    let frame;
    if(inCarry.length>=FRAME24.length){ frame=inCarry.subarray(0,FRAME24.length); inCarry=inCarry.subarray(FRAME24.length);
      stats.heardChunks++; stats.heardBytes+=frame.length; }
    else frame=FRAME24;                             // 房里没人说话就送静音,别让麦克风「被拔掉」
    rpc("thread/realtime/appendAudio",{threadId,audio:{data:frame.toString("base64"),
      sampleRate:24000,numChannels:1,samplesPerChannel:frame.length/2}});
  },20);

  log("READY",{msg:"房里可以说话了",runMinutes:RUN_MIN});
  // 打个招呼,证明嘴是通的
  await sleep(1200);
  await rpc("thread/realtime/appendSpeech",{threadId,text:"我上线了,现在可以跟我说话。"});

  setTimeout(()=>{
    log("RESULT",{ok:true, heardChunks:stats.heardChunks, heardBytes:stats.heardBytes,
      spokeChunks:stats.spokeChunks, spokeBytes:stats.spokeBytes,
      userTranscripts:stats.userTx, assistantTranscripts:stats.asstTx,
      approvals:stats.approvals, codexErrors:stats.errors});
    bye();
  }, RUN_MIN*60000);
  function bye(){ try{getVoiceConnection(GUILD)?.destroy()}catch{}
    try{cx.stdin.end()}catch{}
    setTimeout(()=>{try{cx.kill("SIGKILL")}catch{};dc.destroy();process.exit(0)},1200) }
  globalThis.__bye=bye;
});
function bye(){ try{getVoiceConnection(GUILD)?.destroy()}catch{} try{cx.stdin.end()}catch{}
  setTimeout(()=>{try{cx.kill("SIGKILL")}catch{};dc.destroy();process.exit(0)},1200) }
dc.login(token).catch(e=>{log("LOGINFAIL",{message:String(e?.message||e)});process.exit(1)});
