// FLY-1911 接手后第一件事:v2 / v3 两条通道现在到底进不进得去(只读,不说话)。
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { RTCPeerConnection, MediaStreamTrack } from "werift";
const BIN=realpathSync("/Users/xiaorongli/.codex-mufasa/packages/standalone/releases/0.148.0-aarch64-apple-darwin/bin/codex");
const c=spawn(BIN,["--enable","realtime_conversation","app-server"],{stdio:["pipe","pipe","pipe"]});
let buf="",id=0;const w=new Map(),ev=[];
c.stdout.on("data",d=>{buf+=d;let n;while((n=buf.indexOf("\n"))>=0){const l=buf.slice(0,n).trim();buf=buf.slice(n+1);
 if(!l)continue;let m;try{m=JSON.parse(l)}catch{continue}
 if(/^thread\/realtime\/(started|error|closed)$|^error$/.test(m.method||"")) ev.push({m:m.method,p:m.params?.message??m.params?.error?.message??m.params?.version??null});
 if(m.id!==undefined&&w.has(m.id)){w.get(m.id)(m);w.delete(m.id)}}});
const rpc=(me,pa={})=>{const i=++id;c.stdin.write(JSON.stringify({jsonrpc:"2.0",id:i,method:me,params:pa})+"\n");
 return new Promise(r=>{w.set(i,r);setTimeout(()=>{if(w.has(i)){w.delete(i);r({__timeout:true})}},25000)})};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await rpc("initialize",{clientInfo:{name:"fly1911-admit",title:"admit",version:"0.0.1"},capabilities:{experimentalApi:true}});
c.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"initialized",params:{}})+"\n");await sleep(400);
const out={at:new Date().toISOString()};
// v2
{ const th=await rpc("thread/start",{}); const threadId=th?.result?.thread?.id;
  const r=await rpc("thread/realtime/start",{threadId,transport:{type:"websocket"},outputModality:"audio",voice:"marin",version:"v2"});
  await sleep(2500);
  out.v2={rpcError:r?.error?.message??null, events:ev.splice(0)};
  await rpc("thread/realtime/stop",{threadId}); await sleep(500); }
// v3
{ const th=await rpc("thread/start",{}); const threadId=th?.result?.thread?.id;
  const pc=new RTCPeerConnection({}); pc.createDataChannel("oai-events");
  pc.addTransceiver(new MediaStreamTrack({kind:"audio"}),{direction:"sendrecv"});
  const o=await pc.createOffer(); await pc.setLocalDescription(o);
  const r=await rpc("thread/realtime/start",{threadId,transport:{type:"webrtc",sdp:pc.localDescription.sdp},
    outputModality:"audio",voice:"cove",version:"v3"});
  await sleep(4000);
  out.v3={rpcError:r?.error?.message??null, events:ev.splice(0)};
  try{pc.close()}catch{} }
console.log(JSON.stringify(out,null,1));
c.stdin.end();setTimeout(()=>{try{c.kill("SIGKILL")}catch{};process.exit(0)},600);
