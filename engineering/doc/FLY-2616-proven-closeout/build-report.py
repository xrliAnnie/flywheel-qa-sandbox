from pathlib import Path
from html import escape
p = Path(__file__).resolve().parent

def diagram(name):
    svg = p / (name + '.svg')
    if svg.exists():
        return '<div class="diagram">' + svg.read_text() + '</div>'
    return '<div class="pending"><strong>DIAGRAM PENDING LOCAL RENDER</strong><p>本机沙箱拒绝启动渲染器，标准参数重试仍失败。图的源文件已保存；当前不展示未验证的图像。</p></div><details><summary>查看 Mermaid 源图（文字）</summary><pre>' + escape((p / (name + '.mmd')).read_text()) + '</pre></details>'

def card(id, title, content, cls=''):
    return f'<section class="card {cls}" data-section="{escape(title, quote=True)}"><h2>{escape(title)}</h2>{content}<label for="comment-{id}">这一节的意见</label><textarea id="comment-{id}" data-comment="{id}" placeholder="写下意见，会保存在这台设备的浏览器中"></textarea></section>'

cards = [
card('flow', '01 · 先证明每个体都消失，再归档', diagram('flow') + '<p>会话行被清掉，也不能漏掉这个执行体。系统会从历史执行记录找回身份，再检查窗口、进程和心跳。<strong>有一个活体反证，就不能说它已消失。</strong></p>'),
card('proof', '02 · 什么才算“已消失”', '''<table><thead><tr><th>看到什么</th><th>如何处理</th></tr></thead><tbody><tr><td>会话行缺失、窗口不存在、进程消失或心跳超时</td><td>作为消失线索，继续检查其它活体证据。</td></tr><tr><td>仍有真实窗口中的执行体、进程或新鲜心跳</td><td>判断仍活着；请求它关闭，之后重新检查。</td></tr><tr><td>探针出错、身份不明、可能正在启动</td><td>判断未知；保留待收尾，给出缺失证据。</td></tr><tr><td>检查完整，有消失线索且没有活体反证</td><td>记录依据，确认这个执行体已消失。</td></tr></tbody></table><p>心跳是控制器定期发出的存活信号。停驻声明只是“我准备等待”，不能替代心跳或真实检查。确认死亡后再清理 CommDB——这是保存会话、问答和唤醒记录的通信数据库。</p>'''),
card('model', '03 · 每一步都有可追溯记录', diagram('model') + '<p>执行编号回答“是哪一个体”；启动代次区分同一任务的不同启动；证据有效期避免用旧观察处理新进程。每次记录清理完成后留下回执，中途重启可以接着做。目录目标在合入前单独保存，不随会话行一起删除；旧记录确实丢失依据时明确报告待补证，不凭猜测归档。</p>'),
card('directory', '04 · 目录已经没有了，就记录“已清理”', '<p>工作目录是这个任务单独使用的代码副本。确认指定目录确实不存在后，收尾记录 <strong>absent（已缺失）</strong>，不再尝试读取不存在目录的分支。</p><p>读不到目录、没有权限、指向其它地方、目录被重新创建，都不算“已缺失”。目录缺失也不能授权删除代码分支，更不能代替执行体死亡证明。</p>'),
card('lane', '05 · 持有者死亡，不再空占车道一小时', '<p>land 车道用于串行安排合入作业。租约是带有效期的占用权，由持有者自己定期续期。</p><p><strong>目标：持有进程被确认消失后，下一作业在一个心跳周期（10 秒）内接手。</strong>独立检查器不等待旧作业结束；回收时同时废除旧操作代次。旧进程即使恢复，也不能继续清理、归档或写入。</p><p>已发出的远端请求无法撤回，接手者先核对原有回执再行动。检查器不可用时明确报告失败，不假称满足时限。</p>'),
card('recovery', '06 · 达到上限，Lead 能知道，也能继续处理', '<p>保留现有第九次重试后暂停的规则。暂停状态 <strong>held</strong> 表示系统停下来等待处理；同时必须留下可重投的升级报告，说明哪个体、哪份证据、哪个清理动作尚未完成。</p><p>沿用正式恢复入口，增加“只重新收尾”。Lead——负责此任务的工程负责人——可在身份和原合入回执都通过校验后重试；不会再次合入代码，也不会重发已成功的消息。</p>'),
card('cases', '07 · 四实例如何验收', '''<table><thead><tr><th>实例</th><th>回归重点</th></tr></thead><tbody><tr><td>FLY-2391</td><td>执行体已死、通信行已删，不再等待它签收。</td></tr><tr><td>FLY-2588</td><td>没有 session 行的执行身份，仍纳入完整收尾集合。</td></tr><tr><td>FLY-2413</td><td>停驻声明不能保留真实已死的体；清掉对应通信记录。</td></tr><tr><td>FLY-2602</td><td>工作目录已不存在，按缺失记录；已完成的重放不重复动作。</td></tr></tbody></table><p>Lead 更新：2602 已于 03:50Z 自行完成，仍保留失败前形状作为回归。四例均要求隔离副本与沙盒外部服务验证：收尾完成、讨论串归档、Linear Done。另测归档失败重试和租约死亡接手。</p>'''),
card('choices', '08 · 为什么选择这条路', '<p><strong>采用：统一探活结论，补强现有收尾与恢复入口。</strong>它能解释每个体为何被判定消失，并让中途失败可继续。</p><p>“先归档再慢慢清”违反已定原则；只增加重试次数也无法让死体签收。代价是多保存一份带身份和时间的证据，并在真正行动前重新核对。</p>'),
card('boundary', '09 · 本次交付的边界', '<p>本页是工程设计。探索、调研和实施计划已提交正式审阅；<span id="review-status">第4轮有效审阅已通过；两项非阻塞建议已记录并交工程负责人选择后续处理</span>。</p><p><strong>尚未实现，也未执行生产清理。</strong>三类红绿回归、四实例沙盒收敛、精确提交版本的 CI（自动检查）、正式 ship report（交付报告）仍由后续实施与 QA 验证。设计审阅通过不等于生产故障已修复。</p><p>页面批注仅保存在当前浏览器；需要复制汇总发回后才进入沟通流程。“页面意见汇总”表示修改意见，不是通过信号。</p>', 'boundary'),
card('summary', '10 · 页面意见汇总', '<p>下面实时汇总各节意见。长意见会拆成每段约 1800 字以内，每段都带任务标记。</p><div id="chunks"></div><button id="copy-all" type="button">复制全部意见</button><span id="copy-status" role="status" aria-live="polite"></span>')
]
style = '''*{box-sizing:border-box}body{margin:0;background:#f5f5f7;color:#1d1d1f;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.7}main{max-width:1000px;margin:auto;padding:48px 22px 80px}header{padding:10px 4px 28px}.eyebrow{color:#0071e3;font-weight:650;letter-spacing:.08em}h1{font-size:clamp(29px,5vw,46px);line-height:1.2;margin:14px 0}header p{font-size:20px;max-width:820px}.meta{font-size:14px;color:#6e6e73}.card{background:white;border:1px solid #e9e9ed;border-radius:20px;padding:28px;margin:20px 0;box-shadow:0 3px 12px #00000004}h2{font-size:23px;margin:0 0 18px}p{margin:12px 0}table{width:100%;border-collapse:collapse;font-size:15px}th,td{text-align:left;padding:13px 10px;border-bottom:1px solid #e8e8ed;vertical-align:top}th{background:#f5f5f7}label{display:block;border-top:1px solid #e8e8ed;margin-top:22px;padding-top:16px;color:#6e6e73;font-size:14px}textarea{display:block;width:100%;min-height:78px;border:1px solid #d2d2d7;border-radius:10px;padding:12px;margin-top:7px;font:inherit;resize:vertical}textarea:focus{outline:2px solid #0071e3;outline-offset:2px}.pending{background:#fff8eb;border:1px solid #edcf93;border-radius:12px;padding:20px;color:#755000}.pending p{font-size:14px}.boundary{border-left:5px solid #0071e3}.diagram svg{max-width:100%;height:auto}.diagram{overflow-x:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f5f7;padding:16px;border-radius:10px;font-size:13px}button{background:#0071e3;color:white;border:0;border-radius:9px;padding:11px 16px;font:inherit;cursor:pointer;margin:8px 10px 8px 0}#copy-status{font-size:14px;color:#6e6e73}details{margin:16px 0}summary{cursor:pointer;color:#0071e3}@media(max-width:600px){main{padding:26px 12px 50px}.card{padding:20px 16px;border-radius:15px}h2{font-size:20px}th,td{padding:10px 6px}}'''
script = r'''
(() => {
  const marker = '【页面意见汇总】FLY-2616';
  const prefix = 'FLY-2616:comments:' + location.pathname + ':';
  const inputs = Array.from(document.querySelectorAll('[data-comment]'));
  const target = document.getElementById('chunks');
  const status = document.getElementById('copy-status');
  let chunks = [];
  function fallback(text) {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed'; field.style.left = '-10000px';
    document.body.appendChild(field); field.select();
    let ok = false;
    try { ok = document.execCommand('copy'); }
    finally { field.remove(); }
    if (!ok) throw new Error('copy_failed');
  }
  async function copy(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try { await navigator.clipboard.writeText(text); }
        catch (_) { fallback(text); }
      } else { fallback(text); }
      status.textContent = '已复制';
    } catch (_) { status.textContent = '复制失败，请选中下方文字手动复制。'; }
  }
  function render() {
    const entries = inputs.filter(el => el.value.trim()).map(el =>
      '[' + el.closest('[data-section]').dataset.section + ']\n' + el.value.trim());
    const content = entries.join('\n\n');
    const chars = Array.from(content);
    const capacity = 1800 - Array.from(marker).length - 1;
    chunks = [];
    for (let i = 0; i < chars.length; i += capacity) {
      chunks.push(marker + '\n' + chars.slice(i, i + capacity).join(''));
    }
    if (!chunks.length) chunks = [marker + '\n（暂无意见）'];
    target.replaceChildren();
    chunks.forEach((text, i) => {
      const pre = document.createElement('pre'); pre.textContent = text;
      const button = document.createElement('button'); button.type = 'button';
      button.textContent = '复制第 ' + (i + 1) + ' 段';
      button.addEventListener('click', () => copy(text));
      target.appendChild(pre); target.appendChild(button);
    });
  }
  inputs.forEach(el => {
    try { el.value = localStorage.getItem(prefix + el.dataset.comment) || ''; }
    catch (_) { /* Browser may disallow local storage; comments still work. */ }
    el.addEventListener('input', () => {
      try { localStorage.setItem(prefix + el.dataset.comment, el.value); } catch (_) {}
      render();
    });
  });
  document.getElementById('copy-all').addEventListener('click', () => copy(chunks.join('\n\n')));
  render();
})();
'''
# Raw Python string above intentionally holds JS escape sequences.
script = script.replace('\\\\n', '\\n')
html = '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FLY-2616 · 证明消失，再完成收尾</title><style>' + style + '</style></head><body><main><header><div class="eyebrow">FLY-2616 · 工程设计</div><h1>证明消失，再完成收尾</h1><p>让已经消失的执行体可以完成收尾；每一个仍活着或无法确认的体，都留在可见的处理链里。</p><div class="meta">依据 founder 2026-09-16 03:34Z 决定 · 设计交付 · 未进行生产变更</div></header>' + ''.join(cards) + '</main><script nonce="__CSP_NONCE__">' + script + '</script></body></html>'
assert html.count('<script') == 1
assert html.count('__CSP_NONCE__') == 1
assert 'Content-Security-Policy' not in html
assert len(html.encode()) <= 512*1024
(p / 'founder-design.html').write_text(html)
(p / 'evidence' / 'comments-script.js').write_text(script)
print('Built founder-design.html:', len(html.encode()), 'bytes')
