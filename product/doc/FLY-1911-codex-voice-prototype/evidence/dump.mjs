/*
 * FLY-1911 任务 2:把 codex app-server 干活期间吐的**全部**事件原样接住。
 *
 * 上一轮的洞:桥把 mcpServer/* 和大部分 item/* 直接 continue 掉了,
 * 于是「它有没有交办」这种问题 grep 出来是 0 —— 而那个 0 的意思是「我没记」,不是「没发生」。
 * 这一版**一行都不丢**:先原样落盘,再谈过滤。
 *
 * 不接 Discord。要的是事件清单,不是体验 —— 这是能回答问题的最便宜那一档。
 */
import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
const OUT=process.env.OUT||"T2-dump";
const ASK=process.env.ASK||"今天 Flywheel 这个仓库有几个 PR 还没合并?去真的查一下再告诉我。";
const HOLD=Number(process.env.HOLD_MS||150000);
const sha=b=>createHash("sha256").update(b).digest("hex");
const RAW=`${OUT}-raw.jsonl`;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const BIN=realpathSync(process.env.CODEX_BIN||"/Users/xiaorongli/.codex-mufasa/packages/standalone/releases/0.148.0-aarch64-apple-darwin/bin/codex");
const c=spawn(BIN,["--enable","realtime_conversation","app-server"],{stdio:["pipe","pipe","pipe"]});

let t0=Date.now(), askAt=null;
const kinds=new Map();          // method -> {n, firstAt, sample}
let audioChunks=0, audioBytes=0;
function note(m, line){
  const k=m.method ?? (m.id!==undefined ? "(rpc-response)" : "(unknown)");
  const rec=kinds.get(k) ?? {n:0, firstSinceAskMs:null, sample:null, sampleKeys:null};
  rec.n++;
  if(rec.firstSinceAskMs===null && askAt) rec.firstSinceAskMs=Date.now()-askAt;
  if(!rec.sample){
    // 音频那种巨大 payload 不留原文,只留形状
    const p=m.params ?? m.result ?? null;
    rec.sampleKeys = p && typeof p==="object" ? Object.keys(p) : null;
    rec.sample = JSON.stringify(m).length>600 ? JSON.stringify(m).slice(0,600)+"…(截断)" : JSON.stringify(m);
  }
  kinds.set(k,rec);
}
let buf="", id=0; const w=new Map();
c.stdout.on("data",d=>{buf+=d;let n;while((n=buf.indexOf("\n"))>=0){const l=buf.slice(0,n).trim();buf=buf.slice(n+1);
 if(!l)continue;
 let m; try{m=JSON.parse(l)}catch{ appendFileSync(RAW, JSON.stringify({t:new Date().toISOString(),unparsed:l.slice(0,300)})+"\n"); continue }
 // ① 先原样落盘 —— 音频只记大小,不然文件会爆
 let store=m;
 if(m.method==="thread/realtime/outputAudio/delta"){
   const len=(m.params?.audio?.data||"").length; audioChunks++; audioBytes+=len;
   store={...m, params:{...m.params, audio:{...(m.params?.audio||{}), data:`<${len} chars base64 略去>`}}};
 }
 appendFileSync(RAW, JSON.stringify({t:new Date().toISOString(), sinceAskMs: askAt?Date.now()-askAt:null, msg:store})+"\n");
 // ② 再统计
 note(m,l);
 if(m.method==="item/commandExecution/requestApproval"||m.method==="item/fileChange/requestApproval"){
   c.stdin.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{decision:"acceptForSession"}})+"\n");
 }
 if(m.id!==undefined&&w.has(m.id)){w.get(m.id)(m);w.delete(m.id)}}});
c.stderr.on("data",d=>{const s=d.toString().replace(/\x1b\[[0-9;]*m/g,"").trim();
  if(s) appendFileSync(RAW, JSON.stringify({t:new Date().toISOString(),stderr:s.slice(0,400)})+"\n")});
const rpc=(me,pa={})=>{const i=++id;c.stdin.write(JSON.stringify({jsonrpc:"2.0",id:i,method:me,params:pa})+"\n");
 return new Promise(r=>{w.set(i,r);setTimeout(()=>{if(w.has(i)){w.delete(i);r({__timeout:true})}},30000)})};

const M={issue:"FLY-1911", probe:"任务2 全事件 firehose", startedAt:new Date().toISOString(),
  codexResolved:BIN, codexSha256:sha(readFileSync(BIN)), probeSha256:sha(readFileSync(new URL(import.meta.url))),
  transport:"websocket", version:"v2", ask:ASK};
await rpc("initialize",{clientInfo:{name:"fly1911-dump",title:"dump",version:"0.0.1"},capabilities:{experimentalApi:true}});
c.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"initialized",params:{}})+"\n"); await sleep(400);
const th=await rpc("thread/start",{}); const threadId=th?.result?.thread?.id; M.threadId=threadId;
const r=await rpc("thread/realtime/start",{threadId,transport:{type:"websocket"},outputModality:"audio",
  voice:"marin",version:"v2",
  realtimeStartInstructions:"你必须始终使用中文回答。回答简短、口语化。"});
M.startRejected = r?.error ?? null;
if(r?.error){ fin(); }
await sleep(2500);
askAt=Date.now();
appendFileSync(RAW, JSON.stringify({t:new Date().toISOString(),marker:"ASK",text:ASK})+"\n");
await rpc("thread/realtime/appendSpeech",{threadId,text:ASK});
// 一直等到它安静下来
const until=Date.now()+HOLD; let lastN=-1, quiet=Date.now();
while(Date.now()<until){ await sleep(500);
  const n=[...kinds.values()].reduce((a,b)=>a+b.n,0);
  if(n!==lastN){lastN=n;quiet=Date.now()} else if(Date.now()-quiet>25000) break; }
M.heldSec=+((Date.now()-t0)/1000).toFixed(1);
M.audio={chunks:audioChunks, base64Chars:audioBytes};
M.eventKinds=[...kinds.entries()].sort((a,b)=>b[1].n-a[1].n)
  .map(([k,v])=>({method:k, count:v.n, firstSinceAskMs:v.firstSinceAskMs, paramKeys:v.sampleKeys, sample:v.sample}));
try{ await rpc("thread/realtime/stop",{threadId}) }catch{}
await sleep(600);
fin();
function fin(){
  writeFileSync(`${OUT}-manifest.json`, JSON.stringify(M,null,2));
  console.log(JSON.stringify({startRejected:M.startRejected, heldSec:M.heldSec, audio:M.audio,
    kinds:M.eventKinds?.map(e=>({method:e.method,count:e.count,firstSinceAskMs:e.firstSinceAskMs,paramKeys:e.paramKeys}))},null,1));
  try{c.stdin.end()}catch{}; setTimeout(()=>{try{c.kill("SIGKILL")}catch{}; process.exit(0)},800);
}
