// Artifact controller checks; this fixture does not prove browser rendering.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script,createContext} from 'node:vm';
const html=readFileSync(new URL('./founder-design.html',import.meta.url),'utf8');
const scripts=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
assert.equal(scripts.length,1);assert.match(scripts[0][1],/nonce="__CSP_NONCE__"/);
assert.doesNotMatch(html,/Content-Security-Policy/i);assert.doesNotMatch(html,/\bon[a-z]+\s*=/i);
assert.doesNotMatch(html,/<(?:script|link|img|iframe)[^>]+(?:src|href)=/i);
assert.doesNotMatch(html,/(?:@import|url\(\s*['"]?https?:)/i);
assert.doesNotMatch(scripts[0][2],/innerHTML/);assert(Buffer.byteLength(html)<512*1024);
const inputs=[...html.matchAll(/<textarea[^>]*data-comment="([^"]+)"[^>]*data-title="([^"]+)"/g)];
const sections=[...html.matchAll(/<section\b[\s\S]*?<\/section>/g)];
assert.equal(inputs.length,10);assert.equal(inputs.length,sections.length);assert(sections.every(s=>/data-comment=/.test(s[0])));
assert.equal(new Set(inputs.map(x=>x[1])).size,inputs.length);
assert.equal((html.match(/DIAGRAM PENDING LOCAL RENDER/g)||[]).length+(html.match(/<svg\b/g)||[]).length,2);
const executable=new Script(scripts[0][2]); const marker='【页面意见汇总】FLY-2447';
class Element {
 constructor(){Object.assign(this,{value:'',dataset:{},style:{},events:{},children:[],textContent:''});}
 addEventListener(n,f){this.events[n]=f;} appendChild(c){this.children.push(c);} append(...cs){this.children.push(...cs);}
 replaceChildren(){this.children=[];} setAttribute(){} select(){} remove(){} querySelector(){return this.label;}
}
function fixture({pathname='/reports/one',saved=new Map(),denyStorage=false,clipboard='success',fallback=true}={}){
 const rows=inputs.map(([,key,title])=>{const r=new Element();r.dataset={comment:key,title};r.parentElement=new Element();r.parentElement.label=new Element();return r;});
 const chunks=new Element(),status=new Element(),button=new Element(),copied=[]; let fallbacks=0;
 const doc={body:new Element(),querySelectorAll:()=>rows,getElementById:id=>({'comment-chunks':chunks,'copy-status':status,'copy-all':button})[id],createElement:()=>new Element(),execCommand:cmd=>{assert.equal(cmd,'copy');fallbacks++;return fallback;}};
 const navigator={};if(clipboard!=='absent')navigator.clipboard={writeText:async t=>{if(clipboard==='reject')throw Error('denied');copied.push(t);}};
 executable.runInContext(createContext({document:doc,navigator,location:{pathname},localStorage:{getItem:k=>{if(denyStorage)throw Error('denied');return saved.get(k);},setItem:(k,v)=>{if(denyStorage)throw Error('denied');saved.set(k,v);}}}));
 return {rows,chunks,status,button,copied,saved,get fallbacks(){return fallbacks;}};
}
const f=fixture();assert(f.button.disabled);assert.match(f.chunks.children[0].textContent,/还没有意见/);
f.rows[0].value='请说明未知状态';f.rows[0].events.input();
assert.equal(f.saved.get('flywheel-comments:/reports/one:FLY-2447:outcome'),'请说明未知状态');
assert(f.chunks.children[0].children[1].value.startsWith(marker+'\n'));
assert(f.chunks.children[0].children[1].value.includes(f.rows[0].dataset.title));
assert.equal(fixture({saved:f.saved}).rows[0].value,f.rows[0].value);assert.equal(fixture({pathname:'/reports/two',saved:f.saved}).rows[0].value,'');
const long='🧪<img src=x onerror=alert(1)> & 长意见'.repeat(300);
f.rows[1].value=long;f.rows[1].events.input();assert(f.chunks.children.length>1);
const chunks=f.chunks.children.map(x=>x.children[1].value);
for(const c of chunks){assert(c.startsWith(marker+'\n'));assert(c.length<=1800);assert.doesNotMatch(c,/[\uD800-\uDBFF]$/);}
const reconstructed=chunks.map(x=>x.slice(marker.length).replace(/^\n\n/,'')).join('');
assert(reconstructed.includes(long));
await f.button.events.click();assert.equal(f.copied[0],chunks.join('\n\n'));assert.match(f.status.textContent,/已复制/);
await f.chunks.children[1].children[2].events.click();assert.equal(f.copied[1],chunks[1]);
for(const clipboard of ['reject','absent']){const d=fixture({clipboard,denyStorage:true});d.rows[0].value='存储被禁也可复制';d.rows[0].events.input();await d.button.events.click();assert.equal(d.fallbacks,1);assert.match(d.status.textContent,/已复制/);assert.match(d.rows[0].parentElement.label.textContent,/未能保存/);}
const failed=fixture({clipboard:'reject',fallback:false});failed.rows[0].value='a';failed.rows[0].events.input();await failed.button.events.click();assert.match(failed.status.textContent,/自动复制失败/);
for(const r of f.rows){r.value='';r.events.input();}assert(f.button.disabled);assert.equal(f.chunks.children.length,1);
console.log('PASS: 10 section comments; one nonce script; no external assets/inline handlers; safe runtime text; path-scoped storage; reload/isolation/denied storage; complete Unicode chunks <=1800 UTF-16; all/chunk copy; rejected/absent clipboard fallback; failure and clear state.');
console.log('LIMIT: VM fixture only, no browser visual QA. Both diagrams use verified local Mermaid SVGs with distinct IDs.');
