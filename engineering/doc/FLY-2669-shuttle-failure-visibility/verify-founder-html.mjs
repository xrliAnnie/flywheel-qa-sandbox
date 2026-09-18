import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pathToFileURL, fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(dir, 'founder-design.html'), 'utf8');
assert.equal((html.match(/<script\b/g)||[]).length,1);
assert.ok(html.includes('<script nonce="__CSP_NONCE__">'));
assert.ok(!/\son\w+\s*=/i.test(html));
assert.ok(!/<meta[^>]+content-security-policy/i.test(html));
assert.ok(!/<(?:script|link|img|iframe)[^>]+(?:src|href)=/i.test(html));
const script = html.match(/<script nonce="__CSP_NONCE__">([\s\S]*?)<\/script>/)[1];
new vm.Script(script);
const root = path.resolve(dir, '../../..');
const roots = [process.env.FLYWHEEL_HTML_TEST_ROOT, root, '/Users/xiaorongli/Dev/flywheel'].filter(Boolean);
let modulePath;
for (const r of roots) {
  const pnpm=path.join(r,'node_modules/.pnpm');
  if (!fs.existsSync(pnpm)) continue;
  const entry=fs.readdirSync(pnpm).find(x=>x.startsWith('happy-dom@'));
  if(entry){modulePath=path.join(pnpm,entry,'node_modules/happy-dom/lib/index.js');break;}
}
assert.ok(modulePath,'happy-dom test dependency required');
const { Window } = await import(pathToFileURL(modulePath).href);
async function makeWindow({blocked=false,reject=false,absent=false}={}){
  const win=new Window({url:'https://reports.example/r/FLY-2669',settings:{disableJavaScriptEvaluation:true}});
  win.document.write(html.replace(/<script[\s\S]*?<\/script>/,''));
  const copied=[]; let fallback=0;
  Object.defineProperty(win.navigator,'clipboard',{value:absent?undefined:{writeText:async t=>{if(reject)throw Error('denied');copied.push(t);}},configurable:true});
  win.document.execCommand=()=>{fallback++;return true;};
  if(blocked)Object.defineProperty(win,'localStorage',{get(){throw Error('disabled')},configurable:true});
  win.eval(script);
  return {win,copied,getFallback:()=>fallback};
}
const {win,copied}=await makeWindow();
const inputs=[...win.document.querySelectorAll('[data-comment]')];
assert.equal(inputs.length,8);
assert.equal(win.document.querySelectorAll('section[data-title]').length,8);
inputs[0].value='<img src=x onerror=alert(1)>\n第一节意见';
inputs[0].dispatchEvent(new win.Event('input'));
assert.equal(win.localStorage.getItem('founder-comments:/r/FLY-2669:0'),inputs[0].value);
assert.equal(win.document.querySelector('#chunks img'),null);
let summary=win.document.querySelector('#chunks textarea').value;
assert.ok(summary.startsWith('【页面意见汇总】FLY-2669\n'));
assert.ok(summary.includes('每一项都有结果\n<img'));
inputs[1].value='长意见'.repeat(2000);
inputs[1].dispatchEvent(new win.Event('input'));
let chunks=[...win.document.querySelectorAll('#chunks textarea')];
assert.ok(chunks.length>3);
for(const area of chunks){assert.ok(area.value.startsWith('【页面意见汇总】FLY-2669\n'));assert.ok(area.value.length<=1800);}
win.document.getElementById('copy-all').click();
await new Promise(r=>setTimeout(r,0));
assert.equal(copied.length,1);assert.ok(copied[0].startsWith('【页面意见汇总】FLY-2669\n'));
inputs[0].value='';inputs[0].dispatchEvent(new win.Event('input'));
assert.ok(!win.document.querySelector('#chunks textarea').value.includes('每一项都有结果'));
for(const options of [{blocked:true,reject:true},{absent:true}]){
  const result=await makeWindow(options);
  result.win.document.getElementById('copy-all').click();
  await new Promise(r=>setTimeout(r,0));assert.equal(result.getFallback(),1);
  result.win.happyDOM.abort();
}
win.happyDOM.abort();
console.log('PASS: structure, nonce, script syntax, 8 comments, scoped save, hostile text, live aggregation, chunk limits, clipboard success/rejection/absence, blocked storage. No browser visual QA.');
