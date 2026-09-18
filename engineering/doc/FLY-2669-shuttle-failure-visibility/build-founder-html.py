from pathlib import Path
from html import escape
p=Path(__file__).parent
sections=[
('每一项都有结果','主仓更新成功，不能遮住另一个仓或 Lead 的失败。每班逐项记录，异常立即尝试发到 Flywheel 工程频道；项目自己明确认领接收人时，再抄送一份；固定页从同一份机器记录显示。'),
('核心流程',None),
('什么时候提醒你','第一班异常就发告警，并在固定页留下状态。同一单元、同一原因、同一异常期间，每个 UTC 日（按世界统一时间划分的一天）最多发一次。连续两个定时班仍异常，升级为「需要你知道，Lead 处理中」。验证恢复后自动熄灭；当天再次失败可以再提醒。'),
('一份状态，两处可见',None),
('三种容易误读的情况','规则允许本班不执行：既不算新失败，也不算恢复，也不清零失败计数。原因换了：仍是同一次未恢复事件。消息排队或送达不明：页面明确显示，不会说已经通知你。落后提交数或时间无法确认时显示「未知」，不填零。'),
('为什么这样做','沿用现有告警发送、去重、排队和回执，不新增调度器。把结果直接从执行分支写入机器状态，不靠读日志猜测。主告警统一交给能修班车的 Flywheel 工程；副告警由项目自愿认领。固定页不等 Lead 手写，也不把「需要你知道」变成审批任务。'),
('边界与并行工作','本设计不修复预检、不授予部署权限、不改变部署、回滚或重启规则。FLY-2654 调整 Raya 的急班执行范围；本单只记录届时实际执行结果，后合入的一方解决冲突并重跑双方测试。设计评审已通过，尚未实现或验证生产效果。实施仍需核对实际发件权限、群体故障消息数量，以及告警不会启动自动修复；这些建议已保留交接。'),
('如何验收','在隔离夹具中：预检失败 → 一条捕获告警与页面状态；同日再一班失败 → 不重复发，页面升级；修复成功 → 熄灭；再次失败 → 新告警。回放 9 月 17 日「Raya 预检失败、整轮仍报成功」形状，证明新整轮结果是部分失败。测试不制造生产失败，不向真实 founder 频道发告警。')]

def diagram(name):
    svg=p/(name+'.svg')
    if svg.exists(): return svg.read_text()
    return '<div class="pending"><strong>DIAGRAM PENDING LOCAL RENDER</strong><p>本地绘图进程两次被系统权限拒绝；未使用远程绘图。Mermaid 绘图源码已保留。</p></div><details><summary>查看绘图源码</summary><pre>'+escape((p/(name+'.mmd')).read_text())+'</pre></details>'

cards=[]
for i,(title,body) in enumerate(sections):
    if i==1: content=diagram('flow')
    elif i==3:
        content=diagram('model')+'<p>班次记录「这一班」；单元记录「哪个仓或 Lead」；结果记录「发生了什么」；异常事件记录「何时开始、何时恢复」；投递记录「有没有送达」。名称可改，机器身份不随名称改变。</p><p>固定页按项目读取相同的记录。第一次异常显示状态，连续两班异常进入「待你看」。</p>'
    else: content='<p>'+escape(body)+'</p>'
    cards.append('<section class="card" data-title="'+escape(title,quote=True)+'"><h2>'+escape(title)+'</h2>'+content+'<label for="c'+str(i)+'">这一节的意见</label><textarea id="c'+str(i)+'" data-comment="'+str(i)+'" placeholder="写下意见，自动保存在这台设备"></textarea></section>')
script=r'''
(() => {
  const marker = '【页面意见汇总】FLY-2669';
  const prefix = 'founder-comments:' + location.pathname + ':';
  const fields = [...document.querySelectorAll('[data-comment]')];
  const chunksNode = document.getElementById('chunks');
  const status = document.getElementById('copy-status');
  let chunks = [];
  function text() {
    return fields.map(field => {
      const value = field.value.trim();
      return value ? field.closest('[data-title]').dataset.title + '\n' + value : '';
    }).filter(Boolean).join('\n\n');
  }
  async function copy(value) {
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(value);
      status.textContent = '已复制';
    } catch (_) {
      const area = document.createElement('textarea');
      area.value = value; area.className = 'copy-helper';
      document.body.appendChild(area); area.focus(); area.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) {}
      area.remove();
      status.textContent = ok ? '已复制' : '自动复制失败，请选中下方文字复制';
    }
  }
  function refresh() {
    const value = text();
    chunks = [];
    const points = Array.from(value);
    const budget = 1800 - marker.length - 1;
    if (!points.length) chunks.push(marker + '\n（暂无意见）');
    while (points.length) chunks.push(marker + '\n' + points.splice(0, budget).join(''));
    chunksNode.replaceChildren();
    chunks.forEach((chunk, index) => {
      const block = document.createElement('div');
      const area = document.createElement('textarea'); area.readOnly = true;
      area.value = chunk; area.setAttribute('aria-label', '意见汇总第 ' + (index + 1) + ' 段');
      const button = document.createElement('button'); button.type = 'button';
      button.textContent = '复制第 ' + (index + 1) + ' 段';
      button.addEventListener('click', () => copy(chunk));
      block.append(area, button); chunksNode.appendChild(block);
    });
  }
  fields.forEach(field => {
    try { field.value = localStorage.getItem(prefix + field.dataset.comment) || ''; } catch (_) {}
    field.addEventListener('input', () => {
      try { localStorage.setItem(prefix + field.dataset.comment, field.value); } catch (_) {}
      refresh();
    });
  });
  document.getElementById('copy-all').addEventListener('click', () => copy(chunks.join('\n\n')));
  refresh();
})();
'''
html='''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>FLY-2669 · 班车失败当场可见</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f5f7;color:#1d1d1f;font:16px/1.7 -apple-system,system-ui,sans-serif}main{max-width:960px;margin:auto;padding:36px 20px 64px}header{padding:8px 4px 24px}h1{font-size:34px;line-height:1.2;letter-spacing:-1px}h2{font-size:22px;margin:0 0 12px}p{margin:10px 0 16px}.eyebrow{color:#007aff;font-weight:600}.muted{color:#65656a}.card{background:white;border-radius:12px;padding:24px;margin:18px 0;box-shadow:0 1px 3px #0000000f;border-left:4px solid #007aff}.pending{padding:20px;background:#fff7e9;border-radius:8px;color:#704700}label{display:block;font-size:14px;color:#65656a;margin-top:22px}textarea{display:block;width:100%;min-height:90px;border:1px solid #d1d1d6;border-radius:8px;padding:12px;font:inherit;margin:8px 0 12px;resize:vertical}textarea:focus,button:focus{outline:2px solid #007aff;outline-offset:2px}button{border:0;border-radius:8px;padding:10px 16px;background:#007aff;color:white;font:inherit;cursor:pointer}pre{overflow:auto;font:13px/1.5 ui-monospace,monospace;background:#f5f5f7;padding:14px}svg{max-width:100%;height:auto}.copy-helper{position:fixed;left:-9999px;top:0}#copy-status{margin-left:10px}.summary{border-left-color:#af52de}@media(max-width:600px){main{padding:20px 12px 40px}.card{padding:18px}h1{font-size:29px}}
</style></head><body><main><header><div class="eyebrow">FLY-2669 · 设计说明 · 2026-09-17</div><h1>班车里有一项没更新，<br>当场让你看见。</h1><p class="muted">逐项结果 · 工程频道告警 · 固定页自动亮灭</p></header>'''+''.join(cards)+'''<section class="card summary"><h2>页面意见汇总</h2><p>意见自动汇总在这里；复制后发给 Lead。页面意见用于修改设计，不代表批准。</p><button type="button" id="copy-all">复制全部意见</button><span id="copy-status" role="status"></span><div id="chunks"></div></section><footer class="muted">设计阶段交付。Mermaid 图尚待本地渲染；未声称浏览器视觉验收或生产验证。</footer></main><script nonce="__CSP_NONCE__">'''+script+'''</script></body></html>'''
(p/'founder-design.html').write_text(html)
print('wrote founder-design.html',len(html.encode()),'bytes')
