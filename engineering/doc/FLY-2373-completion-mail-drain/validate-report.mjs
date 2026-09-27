import {readFileSync,writeFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const dir=new URL('./',import.meta.url);
const html=readFileSync(new URL('founder-design.html',dir),'utf8');
assert.equal((html.match(/<script /g)||[]).length,1);
assert(html.includes('<script nonce="__CSP_NONCE__">'));
assert(!/on(click|input|load)\s*=|http-equiv=["']Content-Security-Policy|<script[^>]+src=|<link[^>]+href=/i.test(html));
assert(!/innerHTML/.test(html));
const source=html.match(/<script nonce="__CSP_NONCE__">([\s\S]*?)<\/script>/)[1];
const marker='【页面意见汇总】FLY-2373';
function element(id=''){return {id,value:'',dataset:{},children:[],listeners:{},append(...v){this.children.push(...v)},appendChild(v){this.children.push(v)},replaceChildren(){this.children=[]},setAttribute(){},addEventListener(k,f){this.listeners[k]=f},select(){},remove(){}};}
async function test(mode){
 const inputs=Array.from(html.matchAll(/<textarea id="([^"]+)" data-section="([^"]+)"/g),m=>Object.assign(element(m[1]),{dataset:{section:m[2]}}));
 assert.equal(inputs.length,7);
 const els=Object.fromEntries(['summary','chunks','copy-status','copy-all'].map(id=>[id,element(id)]));
 const saved=new Map();let fallback=0;let copied='';
 const ctx={location:{pathname:'/report-A'},localStorage:{getItem(k){if(mode==='storageDenied')throw Error('denied');return saved.get(k)},setItem(k,v){if(mode==='storageDenied')throw Error('denied');saved.set(k,v)}},navigator:mode==='absent'?{}:{clipboard:{async writeText(t){if(mode==='rejected')throw Error('denied');copied=t}}},document:{querySelectorAll(){return inputs},getElementById(id){return els[id]},createElement(){return element()},body:element(),execCommand(){fallback++;return true}}};
 vm.runInNewContext(source,ctx);
 inputs[0].value='意见 <img src=x> & 原文';inputs[0].listeners.input();
 assert(els.summary.value.startsWith(marker+'\n[结论]\n意见'));
 if(mode!=='storageDenied')assert(saved.has('flywheel-comments:/report-A:c0'));
 inputs[1].value='甲'.repeat(4000);inputs[1].listeners.input();
 assert(els.chunks.children.length>=6);
 for(const el of els.chunks.children.filter(x=>x.readOnly)){assert(el.value.startsWith(marker));assert(Array.from(el.value).length<=1800);}
 await els['copy-all'].listeners.click();
 if(mode==='absent'||mode==='rejected')assert.equal(fallback,1);else assert(copied.startsWith(marker));
 assert.equal(els['copy-status'].textContent,'已复制');
}
for(const mode of ['normal','absent','rejected','storageDenied'])await test(mode);
const result={static:'PASS',interaction_vm:'PASS',cases:['7 comment inputs','pathname-scoped storage','storage-denied recovery','live aggregation','1800-codepoint chunks','clipboard success','clipboard absent fallback','clipboard rejection fallback'],browser_visual:'NOT RUN: local Chromium sandbox launch denied',product_qa:'NOT RUN: design only'};
writeFileSync(new URL('report-validation.json',dir),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
