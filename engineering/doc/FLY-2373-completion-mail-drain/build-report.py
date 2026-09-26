from pathlib import Path
from html import escape
d=Path(__file__).parent
sections=[
('结论','交卷不再被空门铃卡住','正文已经读过，一次交卷成功；真正没读的新指令，先直接返回原文，在同一轮读完并确认后，第二次交卷成功。'),
('核心流程','让消息在当前这一轮被读到','一轮工作，是模型从开始处理到交还控制的一段对话。修复后的完工流程无需先结束这一轮，也无需重开执行体。'),
('数据关系','通知、正文、消费记录分开保存','消费凭据，就是系统记录“哪个执行体通过读取或确认入口接收了哪个版本的正文”。投递系统的接收记录不能冒充它；旧记录没有可靠来源时，重新读原文。'),
('取舍','保留检查，移除循环依赖','不采用“忽略所有延后通知”，也不自动确认未读消息。新增精确消费与结算记录，会增加少量数据和恢复逻辑；换来的是每条消息都有去向，重复通知不会挡住交卷。'),
('验收','必须看到真实执行体读消息','独立测试房将启动真实 Codex 执行体，在长轮次内投递 Lead 新指令和复审结果。新指令最多两次交卷；已读复审结果一次。保存模型读取、执行、确认和成功回执；Claude 路径也要实测。'),
('边界','这是设计，尚未实现或上线','实现与独立验收均交给 Opus。旧执行体仍有活窗口时的正式收尾恢复，已明确交给生命周期负责人另项处理；本设计不把它说成已修复。设计通过不代表生产验证通过。')]
parts=[]
for n,(title,heading,body) in enumerate(sections):
 diagram=''
 if n in (1,2):
  fn='flow' if n==1 else 'model'
  if (d/(fn+'.svg')).exists(): diagram=(d/(fn+'.svg')).read_text()
  else: diagram='<div class="pending">DIAGRAM PENDING LOCAL RENDER<br><span>本机图形进程被权限限制；Mermaid 图源已保留，未使用远程渲染。</span></div>'
 parts.append('<section class="card"><span class="eyebrow">'+escape(title)+'</span><h2>'+escape(heading)+'</h2>'+diagram+'<p>'+escape(body)+'</p><label for="c'+str(n)+'">这一节的意见</label><textarea id="c'+str(n)+'" data-section="'+escape(title,quote=True)+'" placeholder="写下意见，自动保存在这台设备"></textarea></section>')
script="""(function(){
'use strict';
const marker='【页面意见汇总】FLY-2373';
const prefix='flywheel-comments:'+location.pathname+':';
const inputs=Array.from(document.querySelectorAll('textarea[data-section]'));
const summary=document.getElementById('summary');
const chunks=document.getElementById('chunks');
const status=document.getElementById('copy-status');
function allText(){return inputs.filter(x=>x.value.trim()).map(x=>'['+x.dataset.section+']\\n'+x.value.trim()).join('\\n\\n');}
function chunkText(body){
const room=1800-marker.length-1;
const points=Array.from(body);
const result=[];
if(!points.length)return [marker];
for(let i=0;i<points.length;i+=room)result.push(marker+'\\n'+points.slice(i,i+room).join(''));
return result;
}
async function copy(text){
try {if(!navigator.clipboard || !navigator.clipboard.writeText)throw new Error('clipboard unavailable');await navigator.clipboard.writeText(text);}
catch(e){const el=document.createElement('textarea');el.value=text;document.body.appendChild(el);el.select();const ok=document.execCommand('copy');el.remove();if(!ok)throw new Error('copy failed');}
}
async function reportCopy(text){try{await copy(text);status.textContent='已复制';}catch(e){status.textContent='复制失败，请手动选择汇总文字';}}
function refresh(){
const body=allText();summary.value=marker+(body?'\\n'+body:'');
chunks.replaceChildren();
const list=chunkText(body);
if(list.length>1)list.forEach((part,i)=>{const area=document.createElement('textarea');area.readOnly=true;area.value=part;area.setAttribute('aria-label','第 '+(i+1)+' 段意见');const button=document.createElement('button');button.type='button';button.textContent='复制第 '+(i+1)+' 段';button.addEventListener('click',()=>reportCopy(part));chunks.append(area,button);});
}
inputs.forEach(input=>{
try{input.value=localStorage.getItem(prefix+input.id)||'';}catch(e){}
input.addEventListener('input',()=>{try{localStorage.setItem(prefix+input.id,input.value);}catch(e){}refresh();});
});
document.getElementById('copy-all').addEventListener('click',()=>reportCopy(summary.value));
refresh();
})();"""
html='''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FLY-2373 · 交卷不再卡在门铃</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f5f7;color:#1d1d1f;font-family:-apple-system,system-ui,sans-serif;line-height:1.65}main{max-width:960px;margin:auto;padding:38px 20px 64px}h1{font-size:clamp(28px,5vw,44px);line-height:1.2;letter-spacing:-.03em}h2{font-size:23px;line-height:1.35;margin:9px 0 16px}.intro{color:#6e6e73}.card{background:white;border-radius:12px;padding:26px;margin:20px 0;border-left:4px solid #007aff;box-shadow:0 1px 3px rgba(0,0,0,.06)}.eyebrow{color:#007aff;font-size:13px;font-weight:650}label{display:block;font-size:13px;color:#6e6e73;margin-top:24px}textarea{display:block;width:100%;min-height:86px;padding:12px;border:1px solid #d2d2d7;border-radius:8px;font:inherit;font-size:14px;resize:vertical;background:#fafafa}textarea:focus{outline:2px solid #007aff;outline-offset:2px}.pending{border:1px dashed #c68a28;background:#fff9ed;color:#7c560f;padding:26px;text-align:center;border-radius:8px;font-weight:650}.pending span{font-size:13px;font-weight:400}button{background:#007aff;color:white;border:0;border-radius:8px;padding:11px 17px;margin:12px 8px 12px 0;cursor:pointer;font:inherit}#summary{min-height:160px}svg{max-width:100%;height:auto}#copy-status{font-size:14px;color:#6e6e73}@media(max-width:600px){main{padding:24px 12px}.card{padding:20px}}
</style></head><body><main><p class="eyebrow">FLY-2373 · 技术设计</p><h1>交卷不再卡在门铃</h1><p class="intro">已读的通知可以结算；没读的指令必须送到模型面前。</p>'''+''.join(parts)+'''<section class="card"><span class="eyebrow">意见汇总</span><h2>把意见带回讨论</h2><label for="overall">其它意见</label><textarea id="overall" data-section="其它意见"></textarea><p>以下内容会实时汇总。它只表达修改意见，不代表设计通过。</p><textarea id="summary" readonly aria-label="页面意见汇总"></textarea><button id="copy-all" type="button">复制全部意见</button><span id="copy-status" role="status"></span><div id="chunks"></div></section></main><script nonce="__CSP_NONCE__">'''+script+'''</script></body></html>'''
(d/'founder-design.html').write_text(html)
(d/'render-evidence.md').write_text('# FLY-2373 本地渲染记录\n\n2026-09-25 两张Mermaid图均首次失败后按规定标准参数重试一次；均报 bootstrap_check_in MachPortRendezvousServer Permission denied (1100)。保留flow.mmd/model.mmd；HTML使用DIAGRAM PENDING LOCAL RENDER。未使用远程服务，未伪造图形。\n')
print('built',len(html.encode()),'bytes')
