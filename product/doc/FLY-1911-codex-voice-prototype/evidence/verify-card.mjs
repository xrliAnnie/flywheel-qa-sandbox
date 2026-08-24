// 只在本地 file:// 这一份上做交互核验 —— 托管页只读、绝不写、绝不 clear(Lead 2026-08-19 纪律)
import { spawn } from "node:child_process";
const CH=process.argv[2], FILE=process.argv[3];
const p=spawn(CH,["--headless=new","--remote-debugging-port=9334","--no-sandbox","about:blank"]);
await new Promise(r=>setTimeout(r,2500));
const list=await (await fetch("http://127.0.0.1:9334/json/list")).json();
const s=new WebSocket(list.find(t=>t.type==="page").webSocketDebuggerUrl);
let id=0; const w=new Map();
s.onmessage=e=>{const m=JSON.parse(e.data); if(w.has(m.id)){w.get(m.id)(m);w.delete(m.id);}};
await new Promise(r=>s.onopen=r);
const cmd=(method,params={})=>{const i=++id;s.send(JSON.stringify({id:i,method,params}));return new Promise(r=>w.set(i,r));};
const ev=async(x)=>{const r=await cmd("Runtime.evaluate",{expression:x,returnByValue:true,awaitPromise:true});return r.result?.result?.value ?? r.result?.exceptionDetails?.text;};
await cmd("Page.enable");
const go=async()=>{await cmd("Page.navigate",{url:"file://"+FILE});await new Promise(r=>setTimeout(r,1800));};
const out={};
await go();
// 1) 写字 -> localStorage
await ev(`(()=>{const t=document.querySelector('textarea');t.value='测试批注 ABC';t.dispatchEvent(new Event('input'));return 1})()`);
out.storedAfterType = await ev(`localStorage.getItem('fly1911:s1')`);
// 2) 刷新后还在吗
await go();
out.survivesReload = await ev(`document.querySelector('textarea').value`);
// 3) 复制成功路径
out.copyOk = await ev(`(async()=>{document.querySelector('textarea').value='x';Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:(t)=>{window.__got=t;return Promise.resolve()}}});document.getElementById('cp').click();await new Promise(r=>setTimeout(r,300));return document.getElementById('st').textContent})()`);
// 4) 复制失败路径:两条都打断,它必须如实说没成功
await go();
out.copyFail = await ev(`(async()=>{document.querySelector('textarea').value='x';
 navigator.clipboard={writeText:()=>Promise.reject(new Error('blocked'))};
 document.execCommand=()=>{throw new Error('blocked')};
 document.getElementById('cp').click();await new Promise(r=>setTimeout(r,400));
 return document.getElementById('st').textContent})()`);
out.previewShowsTextOnFail = await ev(`document.getElementById('pv').textContent.slice(0,40)`);
console.log(JSON.stringify(out,null,1));
p.kill("SIGKILL");process.exit(0);
