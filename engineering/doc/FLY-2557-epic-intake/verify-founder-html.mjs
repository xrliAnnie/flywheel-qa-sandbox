import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {Script,createContext} from 'node:vm';
const require=createRequire(new URL('../../../packages/teamlead/package.json',import.meta.url));
let parser;
try {parser=await import(require.resolve('parse5'));}
catch {parser=await import(createRequire('/Users/xiaorongli/Dev/flywheel/packages/teamlead/package.json').resolve('parse5'));}
const html=readFileSync(new URL('./founder-design.html',import.meta.url),'utf8');
const scripts=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
assert.equal(scripts.length,1); assert.match(scripts[0][1],/nonce="__CSP_NONCE__"/);
assert.doesNotMatch(html,/Content-Security-Policy/i);
assert.doesNotMatch(scripts[0][2],/innerHTML|eval\(|fetch\(/);
assert(Buffer.byteLength(html)<512*1024);
const nodes=[];function walk(n){nodes.push(n);for(const c of n.childNodes??[])walk(c)}walk(parser.parse(html));
const els=nodes.filter(n=>n.tagName); const attr=(n,k)=>n.attrs?.find(a=>a.name===k)?.value;
for(const n of els)for(const a of n.attrs??[]){assert(!/^on/i.test(a.name));if(['src','href'].includes(a.name))assert(!/^(https?:|\/\/)/.test(a.value));}
const ids=els.map(n=>attr(n,'id')).filter(Boolean);assert.equal(new Set(ids).size,ids.length);
const sections=els.filter(n=>n.tagName==='section');const inputs=els.filter(n=>n.tagName==='textarea'&&attr(n,'data-comment'));
assert.equal(inputs.length,sections.length); assert.equal(inputs.length,8);
for(const s of sections){let found=false;function visit(n){if(n.tagName==='textarea'&&attr(n,'data-comment'))found=true;for(const c of n.childNodes??[])visit(c)}visit(s);assert(found)}
assert.equal((html.match(/DIAGRAM PENDING LOCAL RENDER/g)||[]).length+(html.match(/<svg\b/g)||[]).length,2);
class Element {constructor(){this.value='';this.dataset={};this.style={};this.events={};this.children=[];this.textContent=''}addEventListener(k,v){this.events[k]=v}appendChild(x){this.children.push(x)}replaceChildren(){this.children=[]}select(){}remove(){}}
const marker='【页面意见汇总】FLY-2557';
function fixture({pathname='/reports/one',saved=new Map(),storageFail=false,clipboard='success',fallback=true}={}){
 const rows=inputs.map(n=>Object.assign(new Element(),{dataset:{comment:attr(n,'data-comment'),title:attr(n,'data-title')}}));
 const box=new Element(),status=new Element(),all=new Element(),body=new Element();
 const labels=new Map(rows.map(x=>[x.dataset.comment,new Element()]));const copied=[];let fallbackCount=0;
 const document={body,querySelectorAll:()=>rows,querySelector:s=>labels.get(s.match(/="([^"]+)"/)[1]),getElementById:id=>({'comment-chunks':box,'copy-status':status,'copy-all':all})[id],createElement:()=>new Element(),execCommand:()=>{fallbackCount++;return fallback}};
 const navigator={};if(clipboard!=='absent')navigator.clipboard={writeText:async s=>{if(clipboard==='reject')throw Error('denied');copied.push(s)}};
 new Script(scripts[0][2]).runInContext(createContext({document,navigator,location:{pathname},localStorage:{getItem:k=>{if(storageFail)throw Error('denied');return saved.get(k)},setItem:(k,v)=>{if(storageFail)throw Error('denied');saved.set(k,v)}}}));
 return {rows,box,status,all,saved,copied,labels,get fallbackCount(){return fallbackCount}};
}
let f=fixture();assert(f.box.children[0].children[0].textContent.startsWith(marker+'\n'));
f.rows[0].value='核对开始时间';f.rows[0].events.input();assert.equal(f.saved.get('flywheel:FLY-2557:comments:/reports/one:summary'),'核对开始时间');
assert.equal(fixture({saved:f.saved}).rows[0].value,'核对开始时间');assert.equal(fixture({pathname:'/reports/two',saved:f.saved}).rows[0].value,'');
f.rows[1].value='🧪长意见'.repeat(1000);f.rows[1].events.input();assert(f.box.children.length>3);
for(const c of f.box.children){const s=c.children[0].textContent;assert(s.startsWith(marker+'\n'));assert(s.length<=1800);assert(!/[\uD800-\uDBFF]$/.test(s));}
await f.all.events.click();assert(f.copied[0].startsWith(marker+'\n'));assert.equal(f.status.textContent,'已复制');await f.box.children[1].children[1].events.click();assert.equal(f.copied.length,2);
for(const clipboard of ['reject','absent']){const t=fixture({clipboard,storageFail:true});t.rows[0].value='保存失败仍可复制';t.rows[0].events.input();await t.all.events.click();assert.equal(t.fallbackCount,1);assert.equal(t.status.textContent,'已复制');assert.match(t.labels.get('summary').textContent,/不可用/)}
const bad=fixture({clipboard:'reject',fallback:false});await bad.all.events.click();assert.match(bad.status.textContent,/复制失败/);
f.rows[0].value='<img src=x onerror=alert(1)>';f.rows[0].events.input();assert(f.box.children[0].children[0].textContent.includes('<img src=x'));
f.rows.forEach(x=>{x.value='';x.events.input()});assert.equal(f.box.children.length,1);assert.match(f.box.children[0].children[0].textContent,/暂无意见/);
console.log(JSON.stringify({structural:'PASS',controller:'PASS',sections:inputs.length,bytes:Buffer.byteLength(html),browserVisual:'NOT RUN',diagramRender:html.includes('DIAGRAM PENDING LOCAL RENDER')?'PENDING LOCAL RENDER':'SVG'},null,2));
