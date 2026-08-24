import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire('/Users/xiaorongli/Dev/flywheel/node_modules/.pnpm/ws@8.21.1/node_modules/ws/index.js');
const WebSocket = require('/Users/xiaorongli/Dev/flywheel/node_modules/.pnpm/ws@8.21.1/node_modules/ws');

const CHROME = '/Users/xiaorongli/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const URL_ = process.argv[2];
const PORT = 9333;
const UD = '/tmp/fly1911cdp';

const child = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=880,900', 'about:blank'
], { stdio: 'ignore', detached: false });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find(t => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error('no page target');
}

const wsUrl = await getWs();
const ws = new WebSocket(wsUrl);
await new Promise(r => ws.on('open', r));
let id = 0; const pend = new Map();
ws.on('message', (m) => {
  const msg = JSON.parse(m.toString());
  if (msg.id && pend.has(msg.id)) { pend.get(msg.id)(msg); pend.delete(msg.id); }
});
function send(method, params = {}) {
  const i = ++id;
  return new Promise(res => { pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
}
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: URL_ });
await sleep(2500);

const out = {};
for (const w of [880, 1200, 390]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  out[`height@${w}`] = await evalJs('document.documentElement.scrollHeight');
  out[`hscroll@${w}`] = await evalJs('document.documentElement.scrollWidth > document.documentElement.clientWidth');
}
await send('Emulation.setDeviceMetricsOverride', { width: 880, height: 900, deviceScaleFactor: 1, mobile: false });

out.textareas = await evalJs('document.querySelectorAll("textarea").length');

await evalJs(`(()=>{const t=document.querySelectorAll('textarea')[0];t.value='测试意见一';t.dispatchEvent(new Event('input'));return 1})()`);
await sleep(200);
out.previewFirstLine = await evalJs(`document.getElementById('pv').textContent.split('\\n')[0]`);
out.lsPersisted = await evalJs(`localStorage.getItem('fly1911v:s1')`);

await evalJs(`(()=>{const T=[...document.querySelectorAll('textarea')];T.forEach((t,i)=>{t.value='第'+(i+1)+'条意见 '+'字'.repeat(400);t.dispatchEvent(new Event('input'))});return 1})()`);
await sleep(300);
out.chunkBtnLabel = await evalJs(`document.getElementById('cp').textContent`);
out.chunk1FirstLine = await evalJs(`document.getElementById('pv').textContent.split('\\n')[0]`);
out.chunk1Len = await evalJs(`document.getElementById('pv').textContent.length`);

await evalJs(`(()=>{try{Object.defineProperty(navigator,'clipboard',{get:()=>undefined,configurable:true})}catch(e){};document.execCommand=function(){return false};return 1})()`);
await evalJs(`document.getElementById('cp').click()`);
await sleep(400);
out.failPathStatus = await evalJs(`document.getElementById('st').textContent`);
out.failPathStillOnChunk1 = await evalJs(`document.getElementById('cp').textContent`);

console.log(JSON.stringify(out, null, 2));
ws.close();
child.kill('SIGKILL');
process.exit(0);
