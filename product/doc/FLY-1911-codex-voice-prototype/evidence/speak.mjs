// FLY-1911 D3:让 Codex 那段真回答从 Discord 语音房里放出来。
// 先转成 ogg/opus,省掉 JS 侧的 opus 编码器 —— 最便宜的一档。
import "libsodium-wrappers";
import { Client, GatewayIntentBits } from "discord.js";
import { joinVoiceChannel, VoiceConnectionStatus, entersState, createAudioPlayer,
         createAudioResource, StreamType, AudioPlayerStatus, getVoiceConnection } from "@discordjs/voice";
import { readFileSync, createReadStream, appendFileSync } from "node:fs";
const GUILD=process.env.GUILD_ID, CHAN=process.env.VOICE_CHANNEL_ID, TV=process.env.TOKEN_VAR||"TEST_BOT_TOKEN_1";
const OGG=process.env.OGG||"reply.ogg", LOG=(process.env.OUT||"speak")+".jsonl";
const log=(d,o)=>{const l=JSON.stringify({t:new Date().toISOString(),dir:d,obj:o});appendFileSync(LOG,l+"\n");console.log(l)};
const env=Object.fromEntries(readFileSync(process.env.HOME+"/.flywheel/.env","utf8").split("\n")
 .filter(l=>l.includes("=")&&!l.trim().startsWith("#")).map(l=>[l.slice(0,l.indexOf("=")).trim(),l.slice(l.indexOf("=")+1).trim()]));
const token=env[TV]; if(!token){log("FATAL",{msg:TV+" 不在 .env"});process.exit(1)}
const c=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildVoiceStates]});
c.once("clientReady",async()=>{
 log("GATEWAY",{bot:c.user.tag});
 const g=await c.guilds.fetch(GUILD);
 const conn=joinVoiceChannel({channelId:CHAN,guildId:GUILD,adapterCreator:g.voiceAdapterCreator,selfDeaf:false,selfMute:false});
 const tj=Date.now();
 try{ await entersState(conn,VoiceConnectionStatus.Ready,25000); log("JOINED",{readyMs:Date.now()-tj}); }
 catch(e){ log("RESULT",{spoke:false,reason:"进不去房:"+String(e?.message||e)}); return bye(); }
 const player=createAudioPlayer();
 conn.subscribe(player);
 const res=createAudioResource(createReadStream(OGG),{inputType:StreamType.OggOpus,inlineVolume:false});
 const tp=Date.now(); let started=null;
 player.on("stateChange",(o,n)=>{ if(n.status===AudioPlayerStatus.Playing&&!started)started=Date.now();
   log("PLAYER",{from:o.status,to:n.status,ms:Date.now()-tp}) });
 player.on("error",e=>log("PLAYERR",{message:String(e?.message||e)}));
 player.play(res);
 try{
   await entersState(player,AudioPlayerStatus.Playing,10000);
   await entersState(player,AudioPlayerStatus.Idle,60000);
   log("RESULT",{spoke:true,startedAfterMs:started?started-tp:null,totalMs:Date.now()-tp});
 }catch(e){ log("RESULT",{spoke:false,reason:String(e?.message||e),playerStatus:player.state.status}); }
 bye();
 function bye(){ try{getVoiceConnection(GUILD)?.destroy()}catch{} setTimeout(()=>{c.destroy();process.exit(0)},1000) }
});
c.login(token).catch(e=>{log("LOGINFAIL",{message:String(e?.message||e)});process.exit(1)});
