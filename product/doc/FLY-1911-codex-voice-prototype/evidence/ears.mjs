// FLY-1911 D4:耳朵那半 —— 一个 bot 在房里说,另一个 bot 听,把听到的解码存成 wav。
// 这是自带阳性对照的测法:声源是我自己放的,所以「没听到」不可能是「没人说话」。
import "libsodium-wrappers";
import { Client, GatewayIntentBits } from "discord.js";
import { joinVoiceChannel, VoiceConnectionStatus, entersState, EndBehaviorType, getVoiceConnection } from "@discordjs/voice";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import OpusScript from "opusscript";
const GUILD=process.env.GUILD_ID,CHAN=process.env.VOICE_CHANNEL_ID,TV=process.env.TOKEN_VAR||"TEST_BOT_TOKEN_2";
const OUT=process.env.OUT||"D4-ears", LISTEN_MS=Number(process.env.LISTEN_MS||25000);
const log=(d,o)=>{const l=JSON.stringify({t:new Date().toISOString(),dir:d,obj:o});appendFileSync(OUT+".jsonl",l+"\n");console.log(l)};
const env=Object.fromEntries(readFileSync(process.env.HOME+"/.flywheel/.env","utf8").split("\n")
 .filter(l=>l.includes("=")&&!l.trim().startsWith("#")).map(l=>[l.slice(0,l.indexOf("=")).trim(),l.slice(l.indexOf("=")+1).trim()]));
const token=env[TV]; if(!token){log("FATAL",{msg:TV+" 不在 .env"});process.exit(1)}
const dec=new OpusScript(48000,2,OpusScript.Application.AUDIO);
const c=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildVoiceStates]});
const speakers=new Map(); const pcmParts=[]; let packets=0,bytes=0,firstAt=null;
c.once("clientReady",async()=>{
 log("GATEWAY",{bot:c.user.tag});
 const g=await c.guilds.fetch(GUILD);
 const conn=joinVoiceChannel({channelId:CHAN,guildId:GUILD,adapterCreator:g.voiceAdapterCreator,selfDeaf:false,selfMute:true});
 try{ await entersState(conn,VoiceConnectionStatus.Ready,25000); log("JOINED",{}); }
 catch(e){ log("RESULT",{heard:false,reason:"进不去房:"+String(e?.message||e)}); return bye() }
 const rec=conn.receiver;
 rec.speaking.on("start",uid=>{
  if(speakers.has(uid))return; speakers.set(uid,true);
  log("SPEAKING",{userId:uid});
  const s=rec.subscribe(uid,{end:{behavior:EndBehaviorType.AfterSilence,duration:1500}});
  s.on("data",chunk=>{ packets++; bytes+=chunk.length; if(!firstAt)firstAt=Date.now();
    try{ pcmParts.push(Buffer.from(dec.decode(chunk))) }catch(e){ /* 单包解不出不致命 */ } });
  s.on("end",()=>log("STREAM-END",{userId:uid,packets,bytes}));
 });
 setTimeout(()=>{
  const pcm=Buffer.concat(pcmParts);
  let wav=null;
  if(pcm.length){ const sr=48000,ch=2,br=sr*ch*2,h=Buffer.alloc(44);
   h.write("RIFF",0);h.writeUInt32LE(36+pcm.length,4);h.write("WAVE",8);h.write("fmt ",12);
   h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(ch,22);h.writeUInt32LE(sr,24);
   h.writeUInt32LE(br,28);h.writeUInt16LE(ch*2,32);h.writeUInt16LE(16,34);h.write("data",36);h.writeUInt32LE(pcm.length,40);
   writeFileSync(OUT+"-heard.wav",Buffer.concat([h,pcm]));
   wav={path:OUT+"-heard.wav",bytes:pcm.length,durationSec:+(pcm.length/br).toFixed(2)}; }
  log("RESULT",{heard:packets>0,opusPackets:packets,opusBytes:bytes,decodedWav:wav,speakers:[...speakers.keys()]});
  bye();
 },LISTEN_MS);
 function bye(){ try{getVoiceConnection(GUILD)?.destroy()}catch{} setTimeout(()=>{c.destroy();process.exit(0)},1000) }
});
c.login(token).catch(e=>{log("LOGINFAIL",{message:String(e?.message||e)});process.exit(1)});
