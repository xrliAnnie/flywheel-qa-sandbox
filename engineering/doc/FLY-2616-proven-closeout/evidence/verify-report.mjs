import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const html = fs.readFileSync(new URL('../founder-design.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
assert.equal(scripts.length, 1); assert.match(scripts[0][1], /nonce="__CSP_NONCE__"/);
assert(!/\son[a-z]+\s*=|<meta[^>]+Content-Security-Policy|<script[^>]+src=|<link[^>]+href=/i.test(html));
assert(!/https?:\/\//.test(html));
assert.equal((html.match(/<section\b/g)||[]).length, (html.match(/data-comment=/g)||[]).length);
const keys = [];
const writes = [];
let fallbackCalls = 0;
const data = new Map();
class Element {
  constructor(id='') {this.id=id;this.value='';this.dataset={};this.handlers={};this.children=[];this.style={};this.textContent='';}
  addEventListener(name,fn){this.handlers[name]=fn;}
  setAttribute(){} select(){} remove(){}
  appendChild(el){this.children.push(el);}
  replaceChildren(){this.children=[];}
  closest(){return {dataset:{section:this.title}};}
}
const inputs = [...html.matchAll(/data-comment="([^"]+)"/g)].map((m,i)=>{
 const e=new Element(m[1]);e.dataset.comment=m[1];e.title='Section '+i;return e;
});
const els = {'chunks':new Element(),'copy-all':new Element(),'copy-status':new Element()};
let denyStorage = false;
const context={document:{body:new Element(),querySelectorAll:()=>inputs,getElementById:id=>els[id],createElement:()=>new Element(),execCommand:()=>{fallbackCalls++;return true;}},location:{pathname:'/report/alpha'},localStorage:{getItem:k=>{keys.push(k);if(denyStorage)throw Error('denied');return data.get(k)||null;},setItem:(k,v)=>{keys.push(k);if(denyStorage)throw Error('denied');data.set(k,v);}},navigator:{clipboard:{writeText:async text=>{writes.push(text);}}}};
vm.runInNewContext(scripts[0][2],context);
inputs[0].value='<script>literal</script> hello';inputs[0].handlers.input();
await els['copy-all'].handlers.click();
assert(writes.at(-1).startsWith('【页面意见汇总】FLY-2616\n'));
assert(writes.at(-1).includes('[Section 0]\n<script>literal</script> hello'));
assert(keys.every(k=>k.includes('/report/alpha')));
inputs[1].value='长😀'.repeat(1600);inputs[1].handlers.input();
const rendered = els.chunks.children.filter(e=>e.textContent.startsWith('【页面意见汇总】FLY-2616'));
assert(rendered.length>1);assert(rendered.every(e=>Array.from(e.textContent).length<=1800));
context.navigator.clipboard.writeText=async()=>{throw Error('clipboard rejected');};
await els['copy-all'].handlers.click();assert.equal(fallbackCalls,1);
delete context.navigator.clipboard;await els['copy-all'].handlers.click();assert.equal(fallbackCalls,2);
denyStorage=true;inputs[2].value='storage unavailable';inputs[2].handlers.input();
vm.runInNewContext(scripts[0][2],context);
context.location.pathname='/report/beta';denyStorage=false;vm.runInNewContext(scripts[0][2],context);
assert(inputs.every(el=>el.value===''));
console.log(JSON.stringify({staticChecks:'PASS',commentBehavior:'PASS',pathIsolation:'PASS',storageFailure:'PASS',chunkBound:1800,clipboardRejectFallback:'PASS',clipboardMissingFallback:'PASS',browserQA:'NOT RUN: Chromium MachPort sandbox denied',diagram:'PENDING LOCAL RENDER'},null,2));
