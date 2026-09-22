from pathlib import Path
from html import escape
p=Path(__file__).parent
sections=[
('summary','先让健康有证据','每一次完整成功都留下时间与结果；有会话需求时，连续三次失败或六十秒未取得进展，进入工程频道和固定页，真正恢复后自动熄灭。'),
('flow','失败怎样变成可见的告警','daemon 是独立语音进程。它把每圈结果交给持久记录，再由现有告警通道通知工程频道；固定页读同一份状态。'),
('evidence','我们已经纠正了什么','原来的“零次成功”结论已撤回：旧代码只记录失败。现场有二十五次连接失败、五十次超时；同配置只读探针已完成一次空转，但原进程最近一圈仍未验证。历史日志不足以逐条判定原因。'),
('model','一份事实，三个视角','健康记录保存最近成功与连续失败；故障历史保存开始、原因和恢复证据；通知记录保存工程频道与真实送达回执。进程还在不等于工作成功，通知排队也不等于送达。'),
('threshold','什么时候报警，什么时候熄灭','有需求时，连续三次完整迭代失败，或首次失败后六十秒没有有效进展，建立一个故障事件。正常调度、默认超时下第三次约二十一秒内触发；主机休眠不能保证实时提醒。完整空转成功只清空转故障；进房失败必须由对应需求真正进入通话并续约，或明确取消，才能结束，不能被下一次空转成功抹掉。'),
('startup','启动失败也走同一条路','原有启动提醒主要是本机文件与桌面通知，而且没有覆盖循环失败。本单让配置、自检及初始化故障进入同一告警记录。Bridge 是本机协调服务；它不可用时也先保存通知并尝试独立发送。网络不通时明确显示“待投递”或“送达未确认”。'),
('tradeoffs','为什么暂时不拉长所有超时','lease 是有截止时间的通话使用许可，过期后必须停止。通话请求的两秒超时保持不变；空转请求单独配置，但默认也保留两秒。只有关联了请求延迟、失败阶段与主机延迟的样本，才提议调整空转超时，不能靠延长等待掩盖原因。'),
('ondemand','按需启动，已拆到 FLY-2701','founder 已明确不采用常驻模式。Lead 创建 FLY-2701，承接耳机模式或会议到点才启动、空闲两分钟后退出。它需要解决已保存的会话如何可靠唤醒、退出瞬间的新会话如何不漏、安装与巡检如何接受休眠。完整候选与风险已附在技术计划中。'),
('boundary','这个设计承诺到哪里','没有会话需求且没有进程，是正常休眠；有需求但没有启动或不能进房，才要报警。最近成功时间在退出后仍可读。本单实现健康可见和失败告警，依赖 FLY-2669 告警基础先合入。按需启动由 FLY-2701 处理，解密由 FLY-2655 处理。现有崩溃恢复只会安全收尾旧会话，不会自动接回；短暂 Bridge 中断可在许可窗口内维持，长中断必须安全停会。'),
('qa','什么才算验收通过','真实运行进程留下成功心跳；限定断开依赖后，阈值内出现工程频道消息与同一固定页故障；恢复后成功一圈，计数清零、页面熄灭。还要注入每圈抛错的假客户端，证明告警测试确实能抓住漏报。与 FLY-2655 都过后，先自己完成至少六十秒真实通话，才说“可以试”。')]
def diagram(name):
 f=p/(name+'.svg')
 if f.exists():return f.read_text()
 return '<div class="pending"><strong>DIAGRAM PENDING LOCAL RENDER</strong><p>本机图形渲染被沙箱拒绝；已按标准参数重试。保留 Mermaid 图稿，未使用远程渲染。</p></div>'
def comment(k,title):return f'<label for="c-{k}">对「{escape(title)}」的意见</label><textarea id="c-{k}" data-comment="{k}" data-title="{escape(title,quote=True)}" placeholder="写下意见，本机自动保存"></textarea>'
cards=[]
for k,title,body in sections:
 extra=diagram('flow') if k=='flow' else diagram('model') if k=='model' else ''
 cards.append(f'<section id="{k}"><h2>{escape(title)}</h2><p>{escape(body)}</p>{extra}{comment(k,title)}</section>')
cards.append('<section id="comments"><h2>页面意见汇总</h2><p>意见只保存在当前浏览器；复制后发给 Lead。此标记是修改意见，不是审批通过。</p>'+comment('general','整体意见')+'<div id="chunks"></div><button id="copy-all" type="button">复制全部意见</button><p id="copy-status" role="status" aria-live="polite"></p></section>')
script=r'''
(() => {
  const marker = '【页面意见汇总】FLY-2693';
  const prefix = 'flywheel-comments:' + location.pathname + ':';
  const inputs = Array.from(document.querySelectorAll('[data-comment]'));
  const chunkRoot = document.getElementById('chunks');
  const status = document.getElementById('copy-status');
  let currentChunks = [];
  function fallback(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('aria-label', '复制临时文本');
    document.body.appendChild(area);area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } finally { area.remove(); }
    if (!ok) throw new Error('copy_failed');
  }
  async function copy(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try { await navigator.clipboard.writeText(text); }
        catch (_) { fallback(text); }
      } else { fallback(text); }
      status.textContent = '已复制';
    } catch (_) { status.textContent = '复制失败，请选中下面的文本手动复制。'; }
  }
  function aggregate() {
    const entries = inputs.filter(x => x.value.trim()).map(x => '【' + x.dataset.title + '】\n' + x.value.trim());
    const body = entries.join('\n\n');
    currentChunks = [];
    const capacity = 1700 - marker.length - 1;
    let part = '';
    for (const char of body) {
      if (part.length + char.length > capacity) { currentChunks.push(marker + '\n' + part); part = ''; }
      part += char;
    }
    if (part) currentChunks.push(marker + '\n' + part);
    if (!currentChunks.length) currentChunks.push(marker + '\n（暂无意见）');
    chunkRoot.replaceChildren();
    currentChunks.forEach((chunk, index) => {
      const area = document.createElement('textarea');area.readOnly = true;area.value = chunk;
      area.setAttribute('aria-label', '意见汇总第' + (index + 1) + '段');
      const button = document.createElement('button');button.type = 'button';button.textContent = '复制第' + (index + 1) + '段';
      button.addEventListener('click', () => copy(chunk));
      chunkRoot.append(area, button);
    });
  }
  inputs.forEach(input => {
    try { input.value = localStorage.getItem(prefix + input.dataset.comment) || ''; } catch (_) {}
    input.addEventListener('input', () => {
      try { localStorage.setItem(prefix + input.dataset.comment, input.value); }
      catch (_) { status.textContent = '本机保存不可用；请复制意见以免丢失。'; }
      aggregate();
    });
  });
  document.getElementById('copy-all').addEventListener('click', () => copy(currentChunks.join('\n\n')));
  aggregate();
})();
'''
html='''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FLY-2693 · 语音健康要有证据</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f5f7;color:#1d1d1f;font:16px/1.75 -apple-system,system-ui,sans-serif}main{max-width:960px;margin:auto;padding:40px 20px 70px}header{padding:12px 0 28px}h1{font-size:clamp(30px,5vw,44px);line-height:1.2;letter-spacing:-1px}h2{font-size:23px;line-height:1.4;margin:0 0 15px}.eyebrow{color:#1a365d;font-size:13px;letter-spacing:2px}section{background:white;border-radius:12px;border-left:4px solid #007aff;padding:26px;margin:20px 0;box-shadow:0 1px 3px rgba(0,0,0,.06)}#evidence,#boundary{border-left-color:#ff9500}#qa{border-left-color:#34c759}p{margin:12px 0}label{display:block;margin-top:24px;color:#6e6e73;font-size:14px}textarea{display:block;width:100%;min-height:86px;resize:vertical;border:1px solid #d2d2d7;border-radius:8px;padding:12px;font:15px/1.6 -apple-system,system-ui,sans-serif;background:#fafafa;color:#1d1d1f}textarea:focus{outline:2px solid #007aff;outline-offset:2px}button{background:#007aff;border:0;color:white;border-radius:8px;padding:10px 16px;font:inherit;margin-top:10px;cursor:pointer}.pending{border:1px dashed #ff9500;background:#fff9ed;border-radius:8px;padding:18px;color:#775000;font-size:14px}svg{max-width:100%;height:auto}#chunks textarea{min-height:140px;margin-top:18px}small{color:#6e6e73}@media(max-width:600px){main{padding:24px 14px}section{padding:20px}h2{font-size:21px}}
</style></head><body><main><header><p class="eyebrow">FLY-2693 · 设计交接 · 2026-09-17 · 图表本地渲染 2026-09-20</p><h1>语音健康，必须有成功的证据</h1><p>失败要出声，恢复要有据；按需启动由 FLY-2701 接续。</p><small>这是设计说明，不是生产修复或通话验收报告。</small></header>'''+''.join(cards)+'</main><script nonce="__CSP_NONCE__">'+script+'</script></body></html>'
(p/'founder-design.html').write_text(html)
import json
rendered=[n for n in ('flow','model') if (p/(n+'.svg')).exists()]
(p/'diagram-render.json').write_text(json.dumps({"renderer":"local mmdc 11.12.0","command":"mmdc -i <name>.mmd -o <name>.svg -w 1000 -b white --svgId FLY-2693-d<N>","rendered":rendered,"svgIds":{"flow":"FLY-2693-d1","model":"FLY-2693-d2"},"result":"RENDERED" if len(rendered)==2 else "DIAGRAM PENDING LOCAL RENDER","renderedAt":"2026-09-20","priorFailure":"2026-09-17/18/19 MachPortRendezvousServer bootstrap_check_in Permission denied (1100)","remoteRender":False},ensure_ascii=False)+'\n')
