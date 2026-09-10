from pathlib import Path
import html

ROOT = Path(__file__).resolve().parent

def esc(value):
    return html.escape(value, quote=True)

def diagram(name):
    p = ROOT / (name + '.svg')
    if p.exists():
        svg = p.read_text()
        return '<div class="diagram">' + svg[svg.index('<svg'):] + '</div>'
    return '<div class="pending"><strong>DIAGRAM PENDING LOCAL RENDER</strong><p>本机绘图浏览器启动被权限限制，标准参数重试仍失败。Mermaid 是用文字描述关系、再生成图形的语言。图源已随设计保存，本文下面保留完整文字说明。</p><details><summary>查看图源</summary><pre>' + esc((ROOT / (name + '.mmd')).read_text()) + '</pre></details></div>'

cards = [
 ('promise', '自动恢复，不再空等', '<p class="hero">一个 Codex 账号额度用完，系统自己选号、验证、切换并恢复停下来的任务；三个登记账号都满了才通知你。</p><div class="metrics"><div><b>10 分钟</b><span>六个任务台架的恢复目标</span></div><div><b>3 个账号</b><span>school / personal / business</span></div><div><b>0 次介入</b><span>有可用号时无需 founder 操作</span></div></div><p class="note">这是待实施的技术设计。下面描述的是目标行为，尚未证明生产恢复已通过。</p>'),
 ('flow', '从额度耗尽到任务重新工作', '<p><strong>Lead</strong> 是负责这些任务的工程负责人。<strong>Bridge</strong> 是记录任务状态、协调恢复的本机服务。</p>' + diagram('flow') + '<ol><li>系统收到明确的额度耗尽信号，给这轮事故编号，并暂停无效换体。</li><li>同一轮停下来的任务合并记录，只产生一次额度事件。</li><li>检查三个账号，优先用最早重置且还有余额的账号；时间相同，选余额更多的。</li><li>在独立临时目录里发送一次真实请求。返回 ok 且账号正确，才安装新凭据。</li><li>逐个结束已死亡的旧运行、启动新运行，确认工作后向 Lead 汇报。</li></ol>'),
 ('selection', '按什么顺序用账号', '<p>优先使用即将重置的可用额度，让剩余额度有机会被用上。不是先挑余额最多的，也不把仍然限额的号当候选。</p><div class="table-wrap"><table><thead><tr><th>账号示例</th><th>下次重置</th><th>剩余</th><th>选择</th></tr></thead><tbody><tr><td>school</td><td>今天 20:00</td><td>35%</td><td>优先</td></tr><tr><td>personal</td><td>明天 09:00</td><td>80%</td><td>备用</td></tr><tr><td>business</td><td>后天</td><td>0%</td><td>暂时跳过</td></tr></tbody></table></div><p class="note">仅为排序示例，不是实时账号状态。旧 personal1 / personal2 不恢复使用。登录信息的刷新时间不代表额度重置时间。</p>'),
 ('safety', '验证失败时会发生什么', '<p><strong>探针</strong> 是一条用候选账号发送的真实请求，用来确认它确实能工作。探针只使用独立临时目录，不改在飞任务的凭据。</p><div class="table-wrap"><table><thead><tr><th>结果</th><th>系统动作</th><th>通知谁</th></tr></thead><tbody><tr><td>验证通过</td><td>切号、记录、恢复受影响任务</td><td>Lead 收到恢复汇总</td></tr><tr><td>超时、错误、账号不符</td><td>保留原账号，不重起，不盲换体</td><td>Lead 一条诊断</td></tr><tr><td>三个号都确认用满</td><td>等待最早可恢复时间后再检查</td><td>founder 一条告警</td></tr><tr><td>网络或登录状态不明</td><td>暂缓切换并继续核查</td><td>Lead 一条诊断</td></tr></tbody></table></div><p>后续必须先获得新的可用证据，才重新尝试。普通请求拥挤不会被直接当成账号用满。</p>'),
 ('model', '系统记住哪些事', diagram('model') + '<p><strong>生成号</strong> 是系统给当前账号使用轮次的编号，用来防止同一次故障被处理多遍。换号后迟到的旧报错仍归原来的轮次，不会误伤新账号。</p><ul><li>账号：稳定身份、额度重置时间、剩余额度和登录健康状态。</li><li>事故：原账号、本轮编号、验证结果和是否真正切成。</li><li>任务：原运行、所在阶段、恢复进度和新运行编号。</li><li>回执：通知是否发过、切换审计是否记下。</li></ul><p><strong>审计行</strong> 是每次尝试留下的一条简短记录，写明从哪个号到哪个号、原因和验证结果，供巡检读取；不记录登录密钥。</p>'),
 ('tradeoffs', '为什么这样设计', '<div class="table-wrap"><table><thead><tr><th>决定</th><th>得到什么</th><th>接受的代价</th></tr></thead><tbody><tr><td>由 Bridge 统一协调</td><td>多任务同时故障也只切一次</td><td>需要持久保存事故和恢复进度</td></tr><tr><td>先隔离验证，再安装凭据</td><td>失败验证不会扰动在飞任务</td><td>多一次真实请求和短暂等待</td></tr><tr><td>沿用结束旧运行、启动新运行的接口</td><td>保留现有身份、工作树和启动检查</td><td>新进程依靠保存的进度继续</td></tr></tbody></table></div><p>没有选择“每个进程自己遇错就切号”，因为多个进程会抢写凭据；也没有把 Codex 塞进 Claude 的切号流程，以免改变 Claude 已有行为。</p><p>自动切号不把旧登录文件覆盖回账号池，防止一份失效凭据毁掉最后可用的存档。代价是已失效的存档需要走既有登录维护流程补充，不能被当成“额度用满”。</p>'),
 ('boundary', '能保证什么，哪些仍需验收', '<p>目标是自动恢复本次额度事故造成的停工，保留已有工作树和持久化进度。健康任务不重启，人工暂停、取消、已经完成的任务不自动复活；不自动购买或兑换额度。</p><p><strong>共享凭据</strong> 是让受管运行目录指向同一份登录文件，避免多个副本刷新时互相作废。当前旧目录仍有副本；上线前必须完成既有迁移并逐个验证。未就绪时暂停恢复、通知 Lead，不能宣称自动化已交付。</p><p>后续台架要证明：六个受影响任务在 10 分钟内恢复、一次成功探针后才重起、全池满只通知一次、失败时零切换零重起，以及 Claude 行为不变。纯模拟返回 ok 不能算真实探针通过。还须证明旧目录安全迁移后，六个新进程跨过登录信息刷新时点仍能工作。</p><p>合并和上线分开，由独立更新服务在部署窗口发布。设计节点只交付方案和评审材料。</p><p class="note">第二轮工程设计评审已批准，另有三项中优先级建议交 Lead 处理。实施、迁移和运行验证仍待后续完成。图表渲染状态见各图区。</p>'),
]

css = '''*{box-sizing:border-box}body{margin:0;background:#f5f5f7;color:#1d1d1f;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;line-height:1.65}main{max-width:960px;margin:0 auto;padding:34px 20px 70px}header{padding:0 2px 18px}.eyebrow{font-size:13px;color:#526174;letter-spacing:.05em}h1{font-size:clamp(28px,5vw,42px);line-height:1.18;letter-spacing:-.03em;margin:8px 0 12px}h2{font-size:23px;line-height:1.3;margin:0 0 16px}p{margin:10px 0}.card{background:#fff;border-radius:12px;border-left:4px solid #007aff;padding:25px;margin:20px 0;box-shadow:0 1px 3px #0000000f}.card:first-of-type{border-left-color:#34c759}.hero{font-size:23px;line-height:1.5}.note{color:#646469;font-size:14px}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin:24px 0}.metrics b{display:block;font-size:28px;color:#1a365d}.metrics span{display:block;font-size:13px;color:#626267}.comment{margin-top:24px;padding-top:15px;border-top:1px solid #e8e8ed}.comment label{display:block;font-size:14px;font-weight:600;margin-bottom:7px}textarea{width:100%;font:inherit;font-size:15px;min-height:84px;resize:vertical;padding:10px 12px;border:1px solid #c9c9d0;border-radius:8px;background:#fdfdfe}textarea:focus{outline:2px solid #007aff;outline-offset:2px}button{border:0;border-radius:9px;background:#007aff;color:white;padding:10px 16px;font:inherit;font-size:14px;cursor:pointer;margin:6px 8px 6px 0}button:focus-visible{outline:3px solid #ff9500;outline-offset:2px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 ui-monospace,monospace;background:#f5f5f7;border-radius:8px;padding:14px}table{border-collapse:collapse;width:100%;font-size:15px}th,td{text-align:left;vertical-align:top;padding:12px;border-bottom:1px solid #e8e8ed}th{color:#526174;background:#f7f8fa}.table-wrap{overflow-x:auto}.pending{background:#fff8ed;border:1px dashed #d5a562;border-radius:8px;padding:16px;font-size:14px}.pending strong{color:#875a0b;letter-spacing:.03em}.diagram svg{display:block;width:100%;height:auto;max-height:none}li{margin:8px 0}#status{min-height:26px;color:#526174;font-size:14px}footer{font-size:13px;color:#86868b}a{color:#006bd6}@media(max-width:600px){main{padding:22px 12px 45px}.card{padding:19px 15px}.hero{font-size:20px}.metrics{gap:10px}.metrics b{font-size:23px}th,td{padding:9px;min-width:92px}h2{font-size:21px}}'''

script = r'''(() => {
'use strict';
const marker = '【页面意见汇总】FLY-2465';
const prefix = 'flywheel-review:' + location.pathname + ':FLY-2465:';
const inputs = Array.from(document.querySelectorAll('textarea[data-section]'));
const status = document.getElementById('status');
const output = document.getElementById('summary');
const chunksRoot = document.getElementById('chunks');
let chunks = [];
function splitBody(body) {
  const chars = Array.from(body);
  const result = [];
  while (chars.length) result.push(marker + '\n' + chars.splice(0, 1700).join(''));
  return result.length ? result : [marker];
}
async function copy(text) {
  try {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('unavailable');
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const temp = document.createElement('textarea');
    temp.value = text;
    temp.setAttribute('aria-label', '复制内容');
    temp.style.position = 'fixed';
    temp.style.left = '-10000px';
    document.body.appendChild(temp);
    temp.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) {}
    temp.remove();
    if (!ok) { status.textContent = '自动复制不可用，请选中下方文字手动复制。'; return; }
  }
  status.textContent = '已复制。把意见发给 Lead 即可；意见汇总不是批准信号。';
}
function refresh() {
  const body = inputs.filter(input => input.value.trim()).map(input => '【' + input.dataset.title + '】\n' + input.value.trim()).join('\n\n');
  chunks = splitBody(body);
  output.textContent = body ? chunks.join('\n\n') : marker + '\n尚无意见。';
  chunksRoot.replaceChildren();
  if (body && chunks.length > 1) chunks.forEach((chunk, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '复制第 ' + (index + 1) + '/' + chunks.length + ' 段';
    button.addEventListener('click', () => copy(chunk));
    chunksRoot.appendChild(button);
  });
}
inputs.forEach(input => {
  try { input.value = localStorage.getItem(prefix + input.dataset.section) || ''; }
  catch (_) { status.textContent = '浏览器未开放本地保存；本页仍可填写和复制意见。'; }
  input.addEventListener('input', () => {
    try { localStorage.setItem(prefix + input.dataset.section, input.value); }
    catch (_) { status.textContent = '未能保存到浏览器，请复制意见保留。'; }
    refresh();
  });
});
document.getElementById('copy-all').addEventListener('click', () => copy(chunks.join('\n\n')));
refresh();
})();'''

# The script is static: no issue/user/tool data is interpolated into executable text.
parts = ['<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FLY-2465 · Codex 自动切号设计</title><style>' + css + '</style></head><body><main><header><div class="eyebrow">FLY-2465 · 工程设计 · 2026-09-09</div><h1>额度用完，工作继续</h1><p>Codex 舰队自动切号与任务恢复</p></header>']
for key, title, content in cards:
    parts.append('<section class="card" aria-labelledby="title-' + esc(key) + '"><h2 id="title-' + esc(key) + '">' + esc(title) + '</h2>' + content + '<div class="comment"><label for="comment-' + esc(key) + '">对这一节的意见</label><textarea id="comment-' + esc(key) + '" data-section="' + esc(key) + '" data-title="' + esc(title) + '" placeholder="你的意见会自动保存在当前浏览器"></textarea></div></section>')
parts.append('<section class="card" aria-labelledby="title-summary"><h2 id="title-summary">把意见一起交给 Lead</h2><p>每节意见自动汇总在这里；长意见会拆成可单独复制的段落。提交意见不是批准实施或上线。</p><div class="comment"><label for="comment-overall">对整份设计或意见汇总的补充</label><textarea id="comment-overall" data-section="overall" data-title="整体补充"></textarea></div><button id="copy-all" type="button">复制全部意见</button><div id="chunks"></div><p id="status" role="status" aria-live="polite"></p><pre id="summary"></pre></section><footer>意见只保存在当前浏览器，不会自动发送。发布版本如有变化，请以 Lead 提供的最新链接为准。</footer></main><script nonce="__CSP_NONCE__">' + script + '</script></body></html>')
(ROOT / 'design.html').write_text('\n'.join(parts))
print('Wrote design.html', (ROOT / 'design.html').stat().st_size, 'bytes')
