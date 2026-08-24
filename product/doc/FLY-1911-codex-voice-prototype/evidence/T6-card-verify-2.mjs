import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire('/Users/xiaorongli/Dev/flywheel/node_modules/.pnpm/ws@8.21.1/node_modules/ws/index.js');
const WebSocket = require('/Users/xiaorongli/Dev/flywheel/node_modules/.pnpm/ws@8.21.1/node_modules/ws');

const CHROME = '/Users/xiaorongli/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const URL_ = process.argv[2];
const PORT = 9334;
const UD = '/tmp/fly1911cdp2';

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
ws.on('message', (m) => { const msg = JSON.parse(m.toString()); if (msg.id && pend.has(msg.id)) { pend.get(msg.id)(msg); pend.delete(msg.id); } });
function send(method, params = {}) { const i = ++id; return new Promise(res => { pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); }); }
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: URL_ });
await sleep(2500);

const out = {};
// stub clipboard SUCCESS so we can walk the chunk sequence
await evalJs(`(()=>{window.__copied=[];try{Object.defineProperty(navigator,'clipboard',{value:{writeText:function(s){window.__copied.push(s);return Promise.resolve()}},configurable:true})}catch(e){};return 1})()`);
await evalJs(`(()=>{const T=[...document.querySelectorAll('textarea')];T.forEach((t,i)=>{t.value='第'+(i+1)+'条意见 '+'字'.repeat(400);t.dispatchEvent(new Event('input'))});return 1})()`);
await sleep(300);
await evalJs(`document.getElementById('cp').click()`); await sleep(300);
out.afterClick1_status = await evalJs(`document.getElementById('st').textContent`);
out.afterClick1_btn = await evalJs(`document.getElementById('cp').textContent`);
out.chunk2FirstLine = await evalJs(`document.getElementById('pv').textContent.split('\\n')[0]`);
await evalJs(`document.getElementById('cp').click()`); await sleep(300);
out.afterClick2_status = await evalJs(`document.getElementById('st').textContent`);
out.copiedCount = await evalJs(`window.__copied.length`);
out.copiedAllStartWithMarker = await evalJs(`window.__copied.every(function(s){return s.split('\\n')[0]==='【页面意见汇总】FLY-1911'})`);
out.copiedLens = await evalJs(`window.__copied.map(function(s){return s.length})`);
out.copiedCoversAll8 = await evalJs(`(function(){var j=window.__copied.join('\\n');var n=0;for(var i=1;i<=8;i++){if(j.indexOf('第'+i+'条意见')>=0)n++}return n})()`);

console.log(JSON.stringify(out, null, 2));
ws.close(); child.kill('SIGKILL'); process.exit(0);
