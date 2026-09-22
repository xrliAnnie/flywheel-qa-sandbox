import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const path=new URL('./founder-design.html',import.meta.url);
const html=fs.readFileSync(path,'utf8');
assert.equal((html.match(/<script\b/g)||[]).length,1);
assert.match(html,/<script nonce="__CSP_NONCE__">/);
assert.doesNotMatch(html,/\son[a-z]+\s*=|http-equiv=["']Content-Security-Policy|<(?:script|link|img)[^>]+(?:src|href)=["']https?:/i);
assert.equal((html.match(/<section\b/g)||[]).length,(html.match(/data-comment=/g)||[]).length);
const code=html.match(/<script nonce="__CSP_NONCE__">([\s\S]*?)<\/script>/)[1];
const definitions=[...html.matchAll(/data-comment="([^"]+)" data-title="([^"]+)"/g)];
function env(pathname, clipboard='reject',storageFails=false){
 const saved=new Map(), copied=[],elements=new Map();let fallback=0;
 function element(){return {value:'',dataset:{},children:[],listeners:{},textContent:'',addEventListener(k,f){this.listeners[k]=f},setAttribute(){},append(...xs){this.children.push(...xs)},appendChild(x){this.children.push(x)},replaceChildren(){this.children=[]},select(){copied.push(this.value)},remove(){}}}
 const inputs=definitions.map(([,key,title])=>{let e=element();e.dataset={comment:key,title};return e});
 for(const id of ['chunks','copy-status','copy-all'])elements.set(id,element());
 const document={querySelectorAll:()=>inputs,getElementById:id=>elements.get(id),createElement:element,body:element(),execCommand:()=>{fallback++;return true}};
 const localStorage={getItem:k=>{if(storageFails)throw Error();return saved.get(k)},setItem:(k,v)=>{if(storageFails)throw Error();saved.set(k,v)}};
 const navigator=clipboard==='missing'?{}:{clipboard:{writeText:async x=>{if(clipboard==='reject')throw Error('denied');copied.push(x)}}};
 vm.runInNewContext(code,{document,localStorage,location:{pathname},navigator});
 return {inputs,elements,saved,copied,get fallback(){return fallback}};
}
const marker='【页面意见汇总】FLY-2693';
for(const mode of ['reject','missing','ok']){
 const e=env('/reports/test-a',mode);e.inputs[0].value='观点 <img onerror=bad> & 证据';e.inputs[0].listeners.input();
 assert.ok([...e.saved.keys()][0].includes('/reports/test-a'));
 assert.match(e.elements.get('chunks').children[0].value,/【先让健康有证据】\n观点/);
 await e.elements.get('copy-all').listeners.click();
 assert.equal(e.copied.at(-1).split('\n')[0],marker);
 assert.equal(e.fallback,mode==='ok'?0:1);
 e.inputs[1].value='😀'.repeat(2100);e.inputs[1].listeners.input();
 const chunks=e.elements.get('chunks').children.filter(x=>x.readOnly).map(x=>x.value);
 assert.ok(chunks.length>2);chunks.forEach(c=>{assert.ok(c.startsWith(marker+'\n'));assert.ok(c.length<=1800)});
 assert.ok(chunks.join('').includes('<img onerror=bad>'));
}
const bad=env('/reports/test-b','reject',true);bad.inputs[0].value='可复制';bad.inputs[0].listeners.input();await bad.elements.get('copy-all').listeners.click();assert.ok(bad.copied.at(-1).includes('可复制'));
const a=env('/reports/a'), b=env('/reports/b');a.inputs[0].value='a';a.inputs[0].listeners.input();b.inputs[0].value='b';b.inputs[0].listeners.input();assert.notEqual([...a.saved.keys()][0],[...b.saved.keys()][0]);
console.log(JSON.stringify({result:'PASS',checks:['single nonced script','section comment coverage','path-scoped storage','storage failure tolerance','live title aggregation','literal unsafe strings retained as text','clipboard ok/rejected/unavailable','unicode chunks <=1800 with exact first-line marker'],scope:'static + Node VM DOM harness; not browser rendering or production voice QA'}));
