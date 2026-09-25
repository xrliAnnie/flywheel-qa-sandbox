const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const html=fs.readFileSync(process.argv[2],'utf8');
const script=html.match(/<script nonce="__CSP_NONCE__">([\s\S]*?)<\/script>/)[1];
const sections=[...html.matchAll(/<textarea[^>]+data-comment="([^"]+)" data-title="([^"]+)"/g)].map(m=>({key:m[1],title:m[2]}));
assert.equal(sections.length,8);assert.equal((html.match(/<script/g)||[]).length,1);assert(!/<meta[^>]+Content-Security-Policy/i.test(html));assert(!/\son[a-z]+=/i.test(html));assert(!/<(?:script|link|img|iframe)[^>]+(?:src|href)=["']https?:/i.test(html));
function setup(mode,failStorage=false,path='/one'){
 const calls=[],store=new Map(),elements={};
 function el(){return {value:'',textContent:'',dataset:{},style:{},children:[],events:{},addEventListener(k,f){this.events[k]=f},append(...xs){this.children.push(...xs)},replaceChildren(){this.children=[]},setAttribute(){},select(){calls.push('select')},remove(){}}}
 const comments=sections.map(s=>Object.assign(el(),{dataset:{comment:s.key,title:s.title}}));
 for(const id of ['all-comments','chunks','status','copy-all']) elements[id]=el();
 const document={querySelectorAll(){return comments},getElementById(id){return elements[id]},createElement:el,body:el(),execCommand(x){calls.push(x);return true}};
 const navigator=mode==='missing'?{}:{clipboard:{writeText:async x=>{calls.push(x);if(mode==='reject')throw Error('denied')}}};
 const localStorage={getItem(k){if(failStorage)throw Error('disabled');return store.get(k)||null},setItem(k,v){if(failStorage)throw Error('disabled');store.set(k,v)}};
 const ctx=vm.createContext({document,navigator,location:{pathname:path},localStorage});vm.runInContext(script,ctx);
 return {comments,elements,calls,store,ctx};
}
(async()=>{
 for(const mode of ['ok','reject','missing']){
  const x=setup(mode);x.comments[0].value='<img onerror=bad> 中文\n'+ '意见😀'.repeat(1100);x.comments[0].events.input();
  assert([...x.store.keys()][0].includes('/one:'));assert(x.elements['all-comments'].value.startsWith('【页面意见汇总】FLY-2798\n'));
  const chunks=x.elements.chunks.children.filter(x=>x.readOnly);assert(chunks.length>1);assert(chunks.every(x=>x.value.length<=1800&&x.value.startsWith('【页面意见汇总】FLY-2798')));
  await x.elements['copy-all'].events.click();await new Promise(r=>setImmediate(r));assert.equal(x.elements.status.textContent,'已复制');
  if(mode!=='ok')assert(x.calls.includes('copy'));
 }
 const y=setup('missing',true);y.comments[1].value='保存被禁用也不丢当前文字';y.comments[1].events.input();assert(y.elements['all-comments'].value.includes('保存被禁用'));
 const z=setup('ok',false,'/two');z.comments[0].value='isolated';z.comments[0].events.input();assert([...z.store.keys()][0].includes('/two:'));
 console.log('PASS: 8 sections; single nonced script; no external assets/inline handlers; path-scoped storage; >1800 split markers; clipboard missing/reject fallback; storage failure; raw text preserved. VM DOM harness only, not browser QA.');
})();
