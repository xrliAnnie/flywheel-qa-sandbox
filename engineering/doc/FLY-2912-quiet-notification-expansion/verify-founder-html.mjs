import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const {Window}=await import('/Users/xiaorongli/Dev/flywheel/packages/teamlead/node_modules/happy-dom/lib/index.js');
const html=readFileSync(process.argv[2] || new URL('./founder-report.html',import.meta.url),'utf8');
assert.equal((html.match(/<script\b/g)||[]).length,1);
assert(!/\son\w+\s*=|<script[^>]+src=|<link\b|<iframe\b/i.test(html));
const script=html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
function boot(path,storageBlocked=false){
 const w=new Window({url:'https://reports.example'+path});
 w.document.write(html.replace(/<script[\s\S]*?<\/script>/,''));
 if(storageBlocked)Object.defineProperty(w,'localStorage',{get(){throw new Error('blocked')}});
 w.eval(script);return w;
}
const w=boot('/FLY-2912/report');
const inputs=[...w.document.querySelectorAll('textarea.comment')];
assert.equal(inputs.length,w.document.querySelectorAll('section').length);
inputs[0].value='验证意见';inputs[0].dispatchEvent(new w.Event('input'));
assert.equal(w.localStorage.getItem('fly2912-comments:/FLY-2912/report:flow'),'验证意见');
inputs[1].value='长意见'.repeat(1800);inputs[1].dispatchEvent(new w.Event('input'));
const chunks=[...w.document.querySelectorAll('#summary pre')].map(x=>x.textContent);
assert(chunks.length>1);
for(const c of chunks){assert.equal(c.split('\n')[0],'【页面意见汇总】FLY-2912');assert([...c].length<=1800)}
let copied='';let fallbacks=0;
w.document.execCommand=()=>{fallbacks++;return true};
Object.defineProperty(w.navigator,'clipboard',{configurable:true,value:{writeText:async text=>{copied=text}}});
w.document.querySelector('#copy-all').click();await new Promise(r=>setTimeout(r,10));
assert(copied.startsWith('【页面意见汇总】FLY-2912\n'));assert(copied.includes('[01 ·'));
Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async()=>{throw new Error('denied')}}});
w.document.querySelector('#copy-all').click();await new Promise(r=>setTimeout(r,10));assert.equal(fallbacks,1);
Object.defineProperty(w.navigator,'clipboard',{value:undefined});
w.document.querySelector('#copy-all').click();await new Promise(r=>setTimeout(r,10));assert.equal(fallbacks,2);
inputs[2].value='<img src=x onerror=alert(1)>';inputs[2].dispatchEvent(new w.Event('input'));
assert.equal(w.document.querySelectorAll('img').length,0);
const blocked=boot('/FLY-2912/blocked',true);const b=blocked.document.querySelector('textarea.comment');b.value='storage unavailable';b.dispatchEvent(new blocked.Event('input'));assert(blocked.document.querySelector('#summary').textContent.includes('storage unavailable'));
const second=boot('/different-report');assert.equal(second.document.querySelector('textarea.comment').value,'');
console.log(JSON.stringify({structural:'PASS',controller:'PASS',sections:inputs.length,chunks:chunks.length,clipboard_success:true,clipboard_rejection_fallback:true,clipboard_absent_fallback:true,storage_failure_safe:true,path_scoped_storage:true,html_injection_safe:true,visual_browser:'NOT_RUN: new_page denied by approval policy',diagrams:'PENDING_LOCAL_RENDER'}));
await Promise.all([w,blocked,second].map(x=>x.happyDOM.close()));
