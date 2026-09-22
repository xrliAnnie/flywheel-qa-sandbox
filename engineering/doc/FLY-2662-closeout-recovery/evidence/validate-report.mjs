import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { Window } from '/Users/xiaorongli/Dev/flywheel/packages/teamlead/node_modules/happy-dom/lib/index.js';
import vm from 'node:vm';
const html = readFileSync(new URL('../founder-design.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
assert.equal(scripts.length, 1); assert.match(scripts[0][1], /nonce="__CSP_NONCE__"/);
assert(!/\son[a-z]+\s*=/i.test(html));
assert(!/<meta[^>]+content-security-policy/i.test(html));
assert(!/<(?:script|img|link)[^>]+(?:src|href)\s*=/i.test(html));
const marker='【页面意见汇总】FLY-2662';
function page(path='/report/a', storage, clipboard) {
 const w=new Window({url:'https://reports.example.test'+path});
 w.document.write(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,''));
 let fallback=0;
 w.document.execCommand=()=>{fallback++;return true;};
 const localStorage=storage??w.localStorage;
 vm.runInNewContext(scripts[0][2],{document:w.document,location:w.location,navigator:{clipboard},localStorage});
 return {w,get fallback(){return fallback;}};
}
const storage=new Map();const kv={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
let copied=''; const a=page('/report/a',kv,{writeText:async text=>{copied=text;}});
const inputs=[...a.w.document.querySelectorAll('[data-comment]')];assert.equal(inputs.length,9);
for(const section of a.w.document.querySelectorAll('section'))assert(section.querySelector('textarea'));
inputs[0].value='<img src=x onerror=alert(1)>意见';inputs[0].dispatchEvent(new a.w.Event('input'));
assert(!a.w.document.querySelector('#comment-chunks img'));
assert(a.w.document.querySelector('#comment-chunks pre').textContent.startsWith(marker+'\n\n[01'));
assert.equal(page('/report/a',kv).w.document.querySelector('textarea').value,inputs[0].value);
assert.equal(page('/report/b',kv).w.document.querySelector('textarea').value,'');
inputs[1].value='长意见😀'.repeat(1000);inputs[1].dispatchEvent(new a.w.Event('input'));
const chunks=[...a.w.document.querySelectorAll('#comment-chunks pre')].map(x=>x.textContent);
assert(chunks.length>2);for(const t of chunks){assert(t.startsWith(marker));assert(t.length<=1800);assert(!/[\uD800-\uDBFF]$/.test(t));}
a.w.document.getElementById('copy-all').click();await Promise.resolve();assert.equal(copied,chunks.join('\n\n'));
for(const clip of [undefined,{writeText:()=>Promise.reject(new Error('denied'))}]){
 const b=page('/report/a',kv,clip);b.w.document.getElementById('copy-all').click();await new Promise(r=>setTimeout(r,0));assert.equal(b.fallback,1);
}
const denied=page('/report/denied',{getItem(){throw Error('denied');},setItem(){throw Error('denied');}});
const t=denied.w.document.querySelector('textarea');t.value='仍可汇总';t.dispatchEvent(new denied.w.Event('input'));assert.match(denied.w.document.querySelector('#comment-chunks').textContent,/仍可汇总/);
console.log(JSON.stringify({ok:true,sections:inputs.length,longCommentChunks:chunks.length,checks:['single_nonce_script','no_external_assets','no_inline_handlers','every_section_comment','path_storage_isolation','reload_restore','xss_text_only','chunk_marker_and_length','clipboard_success','clipboard_missing_fallback','clipboard_reject_fallback','storage_denied_safe'],boundary:'happy-dom+VM, not browser QA or hosted CSP execution'}));
