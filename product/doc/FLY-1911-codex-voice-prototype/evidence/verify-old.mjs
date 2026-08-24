// 在**逐字复刻托管期 CSP** 的本地副本上验 —— 上一轮我在 file:// 上验,那里没有 CSP,所以什么都没验到
import { spawn } from "node:child_process";
const CH=process.argv[2], URL_=process.argv[3];
const p=spawn(CH,["--headless=new","--remote-debugging-port=9337","--no-sandbox","--autoplay-policy=no-user-gesture-required","about:blank"]);
await new Promise(r=>setTimeout(r,2500));
const list=await (await fetch("http://127.0.0.1:9337/json/list")).json();
const s=new WebSocket(list.find(t=>t.type==="page").webSocketDebuggerUrl);
let id=0;const w=new Map();const console_=[];
s.onmessage=e=>{const m=JSON.parse(e.data);
 if(m.method==="Log.entryAdded")console_.push(m.params.entry.text?.slice(0,180));
 if(m.method==="Runtime.consoleAPICalled")console_.push("console:"+(m.params.args?.[0]?.value||""));
 if(w.has(m.id)){w.get(m.id)(m);w.delete(m.id);}};
await new Promise(r=>s.onopen=r);
const cmd=(m,pa={})=>{const i=++id;s.send(JSON.stringify({id:i,method:m,params:pa}));return new Promise(r=>w.set(i,r));};
const ev=async x=>{const r=await cmd("Runtime.evaluate",{expression:x,returnByValue:true,awaitPromise:true});return r.result?.result?.value ?? r.result?.exceptionDetails?.text;};
await cmd("Page.enable");await cmd("Log.enable");await cmd("Runtime.enable");
await cmd("Page.navigate",{url:URL_});await new Promise(r=>setTimeout(r,2500));
const o={};
o.scriptRan = await ev("typeof draw === 'function'");                 // 脚本到底有没有执行
o.hasPlayBtn = await ev("!!document.getElementById('pb')");
o.audioTagGone = await ev("document.querySelectorAll('audio').length");
// 播放:AudioContext 解 PCM —— 不是 fetch,不受 CSP fetch 指令管
o.play = await ev(`(async()=>{document.getElementById('pb').click();await new Promise(r=>setTimeout(r,600));
  return document.getElementById('pb').textContent+' | '+document.getElementById('ps').textContent})()`);
// 批注 + localStorage
await ev(`(()=>{var t=document.querySelector('textarea');t.value='CSP 测试';t.dispatchEvent(new Event('input'));return 1})()`);
o.stored = await ev("localStorage.getItem('fly1911:s1')");
// 复制成功路径
o.copyOk = await ev(`(async()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>Promise.resolve()}});
  document.getElementById('cp').click();await new Promise(r=>setTimeout(r,300));return document.getElementById('st').textContent})()`);
// 复制失败路径必须如实报错
o.copyFail = await ev(`(async()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>Promise.reject(new Error('x'))}});
  document.execCommand=()=>{throw new Error('x')};document.getElementById('cp').click();await new Promise(r=>setTimeout(r,400));
  return document.getElementById('st').textContent})()`);
o.height = await ev("document.documentElement.scrollHeight");
o.cspViolations = console_.filter(x=>/Content Security Policy|refused/i.test(x||"")).slice(0,4);
console.log(JSON.stringify(o,null,1));
p.kill("SIGKILL");process.exit(0);
