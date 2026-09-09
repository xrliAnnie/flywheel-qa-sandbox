// Artifact-only verification; uses an existing happy-dom installation.
// FLY2351_DOM_MODULE may point to an already-installed happy-dom/lib/index.js.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { Window } = await import(process.env.FLY2351_DOM_MODULE || 'happy-dom');
const html = readFileSync(new URL('./design.html', import.meta.url), 'utf8');
const script = html.match(/<script nonce="__CSP_NONCE__">([\s\S]*?)<\/script>/)[1];
assert.equal((html.match(/<script\b/g)||[]).length, 1);
assert(!/\son\w+\s*=/i.test(html));
assert(!/<meta[^>]*Content-Security-Policy/i.test(html));
assert(!/<(?:script|link|img)[^>]*(?:src|href)="https?:/i.test(html));
const windows = [];
function page(path='/report/fly2351', saved, blocked=false) {
  const w = new Window({url:'https://example.test'+path}); windows.push(w);
  w.document.write(html.replace(/<script[\s\S]*?<\/script>/, ''));
  if(saved) for(const [k,v] of Object.entries(saved)) w.localStorage.setItem(k,v);
  if(blocked) Object.defineProperty(w,'localStorage',{value:{getItem(){throw Error('denied')},setItem(){throw Error('denied')}}});
  w.eval(script); return w;
}
function input(w, value, i=0) {
  const field=w.document.querySelectorAll('[data-comment]')[i];
  field.value=value; field.dispatchEvent(new w.Event('input',{bubbles:true})); return field;
}
const w=page();
assert.equal(w.document.querySelectorAll('section').length,9);
for(const section of w.document.querySelectorAll('section')) assert(section.querySelector('textarea[data-comment]'));
assert(w.document.querySelector('#copy-all').disabled);
input(w, '<img src=x onerror=alert(1)>\n明确修改意见');
const key='flywheel-comments:/report/fly2351:FLY-2351:summary';
assert.equal(w.localStorage.getItem(key),'<img src=x onerror=alert(1)>\n明确修改意见');
assert(!w.document.querySelector('#comment-chunks img'));
assert(w.document.querySelector('#comment-chunks pre').textContent.startsWith('【页面意见汇总】FLY-2351\n\n【一句话方案】'));
assert.equal(page('/report/fly2351',{[key]:'保存恢复'}).document.querySelector('[data-comment]').value,'保存恢复');
assert.equal(page('/report/other',{[key]:'不该泄漏'}).document.querySelector('[data-comment]').value,'');
input(w,'长评论😀'.repeat(900));
input(w,'第二节评论',1);
input(w,'整体意见',8);
const pieces=Array.from(w.document.querySelectorAll('#comment-chunks pre'),p=>p.textContent);
assert(pieces.length>2);
for(const text of pieces){assert(text.startsWith('【页面意见汇总】FLY-2351'));assert(Array.from(text).length<=1800)}
assert(pieces.join('').includes('【核心流程】\n第二节评论'));
assert(pieces.join('').includes('【整体意见】\n整体意见'));
let copied='';
Object.defineProperty(w.navigator,'clipboard',{configurable:true,value:{async writeText(t){copied=t}}});
w.document.querySelector('#copy-all').click();await new Promise(r=>setTimeout(r,10));
assert.equal(copied,pieces.join('\n\n'));
let fallbacks=0;
w.document.execCommand=(name)=>{assert.equal(name,'copy');copied=w.document.activeElement.value;fallbacks++;return true};
Object.defineProperty(w.navigator,'clipboard',{configurable:true,value:{async writeText(){throw Error('reject')}}});
w.document.querySelector('#copy-all').click();await new Promise(r=>setTimeout(r,10));
assert.equal(fallbacks,1);assert.equal(copied,pieces.join('\n\n'));
Object.defineProperty(w.navigator,'clipboard',{configurable:true,value:undefined});
w.document.querySelector('#comment-chunks button').click();await new Promise(r=>setTimeout(r,10));
assert.equal(fallbacks,2);assert.equal(copied,pieces[0]);
w.document.execCommand=()=>false;
w.document.querySelector('#copy-all').click();await new Promise(r=>setTimeout(r,10));
assert(w.document.querySelector('#copy-status').textContent.includes('手动复制'));
const blocked=page('/report/blocked',undefined,true);
input(blocked,'存储失败也能评论');
assert(blocked.document.querySelector('#comment-chunks pre').textContent.includes('存储失败也能评论'));
assert(blocked.document.querySelector('#save-status').textContent.includes('失败'));
console.log(JSON.stringify({ok:true,checks:['9 section comment fields','autosave and restore','pathname isolation','text injection safe','1800-character chunks with marker','copy-all','clipboard success','rejected clipboard fallback','missing clipboard fallback','manual fallback','storage denial safe','single nonce script/no external assets'],chunks:pieces.length,bytes:Buffer.byteLength(html)}));
for(const window of windows) await window.happyDOM.close();
