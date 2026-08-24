/* 在【逐字复刻托管期 CSP】的本地副本上验这张卡。
 * ⛔ 绝不在托管页上跑 —— 那上面写 localStorage 会污染她自己的草稿。
 * 验的是四件我最可能弄错的事:脚本在 CSP 下真跑了 / 波形图没被 CSP 拦 /
 * 批注存得住 / 复制出来的第一行逐字是那个标记。*/
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const CH = process.argv[2], SRC = process.argv[3], TMP = process.argv[4];
const NONCE = "TESTNONCE1234567890";
const html = readFileSync(SRC, "utf8")
  .replaceAll("__CSP_NONCE__", NONCE)
  .replace("<meta charset=\"utf-8\">",
    `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${NONCE}'; style-src 'unsafe-inline'; img-src data:;">`);
writeFileSync(TMP, html);
const p = spawn(CH, ["--headless=new", "--remote-debugging-port=9341", "--no-sandbox", "--user-data-dir=" + process.env.TMPDIR + "/an1-chrome-" + process.pid, "about:blank"]);
let list;
for (let i = 0; i < 25; i++) { await new Promise(r => setTimeout(r, 800));
  try { list = await (await fetch("http://127.0.0.1:9341/json/list")).json(); break; } catch {} }
if (!list) { console.error("chrome 起不来"); process.exit(1); }
const s = new WebSocket(list.find(t => t.type === "page").webSocketDebuggerUrl);
let id = 0; const w = new Map(); const con = [];
s.onmessage = e => { const m = JSON.parse(e.data);
  if (m.method === "Log.entryAdded") con.push(m.params.entry.text?.slice(0, 200));
  if (w.has(m.id)) { w.get(m.id)(m); w.delete(m.id); } };
await new Promise(r => s.onopen = r);
const cmd = (m, pa = {}) => { const i = ++id; s.send(JSON.stringify({ id: i, method: m, params: pa })); return new Promise(r => w.set(i, r)); };
const ev = async x => { const r = await cmd("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }); return r.result?.result?.value ?? r.result?.exceptionDetails?.text; };
await cmd("Page.enable"); await cmd("Log.enable"); await cmd("Runtime.enable");
await cmd("Page.navigate", { url: "file://" + TMP }); await new Promise(r => setTimeout(r, 2000));
const o = {};
o.脚本在CSP下真跑了 = await ev("typeof build === 'function'");
o.波形SVG条数 = await ev("document.querySelectorAll('svg rect').length");
o.批注框数 = await ev("document.querySelectorAll('textarea').length");
await ev(`(()=>{var t=document.querySelector('textarea');t.value='本地自检写入';t.dispatchEvent(new Event('input'));return 1})()`);
o.localStorage存住了 = await ev("localStorage.getItem('fly1911sil:a0')");
o.复制第一行 = await ev(`(async()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:t=>{window.__c=t;return Promise.resolve()}}});
  document.getElementById('cp').click();await new Promise(r=>setTimeout(r,300));return (window.__c||'').split('\\n')[0]})()`);
o.复制失败时如实报错 = await ev(`(async()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>Promise.reject(new Error('x'))}});
  document.execCommand=()=>{throw new Error('x')};document.getElementById('cp').click();await new Promise(r=>setTimeout(r,400));
  return document.getElementById('st').textContent})()`);
o.页面高度 = await ev("document.documentElement.scrollHeight");
o.CSP拦截 = con.filter(x => /Content Security Policy|Refused/i.test(x || "")).slice(0, 5);
console.log(JSON.stringify(o, null, 1));
p.kill("SIGKILL"); process.exit(0);
