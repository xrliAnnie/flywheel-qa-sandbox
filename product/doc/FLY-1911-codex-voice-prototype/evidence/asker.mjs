// FLY-1911:房里的「她」—— 进房、问一句、把听到的全录下来。
// 这是桥那一侧的阳性对照:问题是我放的,所以「桥没听见」不可能被解释成「没人说话」。
import "libsodium-wrappers";
import { Client, GatewayIntentBits } from "discord.js";
import { joinVoiceChannel, VoiceConnectionStatus, entersState, EndBehaviorType,
         createAudioPlayer, createAudioResource, StreamType, getVoiceConnection, AudioPlayerStatus } from "@discordjs/voice";
import { readFileSync, createReadStream, writeFileSync, appendFileSync } from "node:fs";
import OpusScript from "opusscript";
const GUILD=process.env.GUILD_ID,CHAN=process.env.VOICE_CHANNEL_ID,TV=process.env.TOKEN_VAR||"TEST_BOT_TOKEN_2";
const OUT=process.env.OUT||"B1-asker", OGG=process.env.OGG||"question.ogg";
const ASK_AFTER=Number(process.env.ASK_AFTER_MS||6000), LISTEN=Number(process.env.LISTEN_MS||110000);
const log=(d,o)=>{const l=JSON.stringify({t:new Date().toISOString(),dir:d,obj:o});appendFileSync(OUT+".jsonl",l+"\n");console.log(l)};
const env=Object.fromEntries(readFileSync(process.env.HOME+"/.flywheel/.env","utf8").split("\n")
 .filter(l=>l.includes("=")&&!l.trim().startsWith("#")).map(l=>[l.slice(0,l.indexOf("=")).trim(),l.slice(l.indexOf("=")+1).trim()]));
const dec=new OpusScript(48000,2,OpusScript.Application.AUDIO);
const c=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildVoiceStates]});
const parts=[]; const speakers=new Map(); let pkts=0, t0=Date.now(), firstHeardAt=null, askedAt=null;
c.once("clientReady",async()=>{
 log("GATEWAY",{bot:c.user.tag});
 const g=await c.guilds.fetch(GUILD);
 const conn=joinVoiceChannel({channelId:CHAN,guildId:GUILD,adapterCreator:g.voiceAdapterCreator,selfDeaf:false,selfMute:false});
 try{ await entersState(conn,VoiceConnectionStatus.Ready,25000); log("JOINED",{}) }
 catch(e){ log("RESULT",{ok:false,reason:String(e?.message||e)}); return bye() }
 conn.receiver.speaking.on("start",uid=>{
   if(uid===c.user.id||speakers.has(uid))return; speakers.set(uid,true); log("HEARD-SPEAKER",{userId:uid,tMs:Date.now()-t0});
   const s=conn.receiver.subscribe(uid,{end:{behavior:EndBehaviorType.AfterSilence,duration:2000}});
   s.on("data",ch=>{ pkts++; if(!firstHeardAt)firstHeardAt=Date.now();
     try{ parts.push(Buffer.from(dec.decode(ch))) }catch{} });
   s.on("end",()=>{ speakers.delete(uid); log("SPEAKER-END",{userId:uid,pkts}) });
 });
 setTimeout(async()=>{
   const player=createAudioPlayer(); conn.subscribe(player);
   player.play(createAudioResource(createReadStream(OGG),{inputType:StreamType.OggOpus}));
   askedAt=Date.now(); log("ASKED",{tMs:askedAt-t0});
   try{ await entersState(player,AudioPlayerStatus.Idle,30000) }catch{}
   log("ASK-DONE",{tMs:Date.now()-t0});
 },ASK_AFTER);
 setTimeout(()=>{
   let wav=null;
   if(parts.length){ const pcm=Buffer.concat(parts),sr=48000,ch=2,br=sr*ch*2,h=Buffer.alloc(44);
     h.write("RIFF",0);h.writeUInt32LE(36+pcm.length,4);h.write("WAVE",8);h.write("fmt ",12);h.writeUInt32LE(16,16);
     h.writeUInt16LE(1,20);h.writeUInt16LE(ch,22);h.writeUInt32LE(sr,24);h.writeUInt32LE(br,28);h.writeUInt16LE(ch*2,32);
     h.writeUInt16LE(16,34);h.write("data",36);h.writeUInt32LE(pcm.length,40);
     writeFileSync(OUT+"-heard-in-room.wav",Buffer.concat([h,pcm]));
     wav={path:OUT+"-heard-in-room.wav",durationSec:+(pcm.length/br).toFixed(2)} }
   log("RESULT",{ok:pkts>0,opusPacketsHeard:pkts,decoded:wav,
     firstHeardAfterAskMs:(firstHeardAt&&askedAt)?firstHeardAt-askedAt:null});
   bye();
 },LISTEN);
 function bye(){ try{getVoiceConnection(GUILD)?.destroy()}catch{} setTimeout(()=>{c.destroy();process.exit(0)},1000) }
 globalThis.__bye=bye;
});
c.login(env[TV]).catch(e=>{log("LOGINFAIL",{message:String(e?.message||e)});process.exit(1)});
