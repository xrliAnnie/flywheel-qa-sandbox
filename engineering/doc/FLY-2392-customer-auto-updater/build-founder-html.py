"""Build the self-contained founder design artifact for FLY-2392; zero network requests.

Usage: python3 build-founder-html.py  (run from any cwd; writes founder-design.html beside this file)
Diagrams are pre-rendered SVGs in ./diagrams (mmdc, --svgId FLY-2392-d<N>); a missing SVG
degrades to a clearly labeled "DIAGRAM PENDING LOCAL RENDER" block with the Mermaid source.
"""
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ISSUE = "FLY-2392"

controller = r"""(() => {
  const marker = '【页面意见汇总】FLY-2392';
  const prefix = 'flywheel-comments:' + location.pathname + ':';
  const fields = Array.from(document.querySelectorAll('[data-comment]'));
  const summary = document.getElementById('summary-text');
  const chunksNode = document.getElementById('chunks');
  const status = document.getElementById('copy-status');
  const allButton = document.getElementById('copy-all');
  let chunks = [];
  function fallbackCopy(text) {
    const field = document.createElement('textarea');
    field.value = text;
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    field.remove();
    return ok;
  }
  async function copy(text) {
    let ok = false;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try { await navigator.clipboard.writeText(text); ok = true; } catch { ok = false; }
    }
    if (!ok) ok = fallbackCopy(text);
    status.textContent = ok ? '已复制。粘贴发回即可；本页不会自动发送。' : '自动复制失败，请手动选择汇总文字复制。';
  }
  function render() {
    chunks = [];
    let current = marker;
    for (const field of fields) {
      const value = field.value.trim();
      if (!value) continue;
      const label = '\n\n【' + field.dataset.title + '】\n';
      const pieces = [];
      let piece = '';
      for (const char of value) {
        if (piece.length + char.length > 1550) { pieces.push(piece); piece = ''; }
        piece += char;
      }
      if (piece) pieces.push(piece);
      for (const part of pieces) {
        if ((current + label + part).length > 1800) { chunks.push(current); current = marker; }
        current += label + part;
      }
    }
    if (current !== marker) chunks.push(current);
    summary.textContent = chunks.length ? chunks.join('\n\n') : '尚无意见。';
    allButton.disabled = chunks.length === 0;
    chunksNode.replaceChildren();
    if (chunks.length > 1) chunks.forEach((part, index) => {
      const box = document.createElement('div');
      box.className = 'chunk';
      const pre = document.createElement('pre');
      pre.textContent = part;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '复制第 ' + (index + 1) + '/' + chunks.length + ' 段';
      button.addEventListener('click', () => copy(part));
      box.append(pre, button);
      chunksNode.appendChild(box);
    });
  }
  for (const field of fields) {
    try { field.value = localStorage.getItem(prefix + field.dataset.comment) || ''; }
    catch { status.textContent = '浏览器未允许本地保存，仍可填写并复制。'; }
    field.addEventListener('input', () => {
      try { localStorage.setItem(prefix + field.dataset.comment, field.value); }
      catch { status.textContent = '本地保存不可用，请及时复制意见。'; }
      render();
    });
  }
  allButton.addEventListener('click', () => copy(chunks.join('\n\n')));
  render();
})();"""

css = """*{box-sizing:border-box}body{margin:0;background:#f5f5f7;color:#1d1d1f;font:16px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC",system-ui,sans-serif}main{max-width:1000px;margin:auto;padding:44px 20px 72px}h1{font-size:clamp(29px,5vw,46px);line-height:1.3;letter-spacing:-.8px;margin:14px 0 30px}h2{font-size:24px;line-height:1.4;margin:0 0 16px}h3{font-size:17px;margin:20px 0 8px}p{margin:12px 0}ul{padding-left:22px}li{margin:6px 0}.eyebrow{font-size:13px;color:#65656d;letter-spacing:.7px}.card{background:#fff;border:1px solid #e3e3e8;border-left:4px solid #007aff;border-radius:16px;padding:28px;margin:22px 0;box-shadow:0 1px 3px rgba(0,0,0,.06)}.card.green{border-left-color:#34c759}.card.amber{border-left-color:#ff9500}.card.purple{border-left-color:#af52de}.card.red{border-left-color:#ff3b30}.card.gray{border-left-color:#86868b}.lead{font-size:22px;line-height:1.6}.note{font-size:14px;color:#62626a}.term{font-weight:600}.pending{border:1px dashed #bd8a36;background:#fff9ee;padding:20px;border-radius:8px;margin:20px 0;color:#795218}.pending strong{display:block;font-size:15px}.status{display:inline-block;font-size:13px;color:#175899;background:#edf5ff;border:1px solid #d4e6fa;padding:4px 12px;border-radius:20px;margin-right:8px}details{margin:12px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 ui-monospace,"SF Mono",monospace}table{border-collapse:collapse;width:100%;font-size:15px}th,td{padding:12px 10px;border-bottom:1px solid #e9e9ee;text-align:left;vertical-align:top}th{background:#fafafa}.tablewrap{overflow-x:auto}.comment{border-top:1px solid #eee;margin-top:24px;padding-top:16px}label{display:block;font-size:13px;color:#65656d;margin-bottom:6px}textarea{width:100%;min-height:80px;padding:12px;font:inherit;font-size:15px;border:1px solid #c9c9d0;border-radius:8px;background:#fdfdff;resize:vertical}textarea:focus{outline:2px solid #0071e366;border-color:#0071e3}button{font:inherit;font-size:14px;padding:10px 16px;border:0;border-radius:8px;background:#0071e3;color:#fff;cursor:pointer;margin:10px 8px 0 0}button:disabled{opacity:.4;cursor:default}#summary-text{background:#f5f5f7;padding:16px;border-radius:8px;min-height:64px;font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere}#copy-status{min-height:1.5em;color:#62626a;font-size:14px}.chunk{background:#fafafa;border-radius:8px;padding:14px;margin-top:12px}.chunk pre{font:14px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;margin:0}a{color:#0071e3}.diagram{margin:18px 0;overflow-x:auto}.diagram svg{max-width:100%;height:auto}@media(max-width:600px){main{padding:22px 12px 44px}.card{padding:20px 16px;border-radius:12px}h2{font-size:21px}td,th{padding:9px 5px;font-size:12px}.lead{font-size:19px}}"""


def diagram(name, label):
    svg = ROOT / "diagrams" / (name + ".svg")
    if svg.exists():
        return '<div class="diagram" role="img" aria-label="' + escape(label) + '">' + svg.read_text() + "</div>"
    source = escape((ROOT / "diagrams" / (name + ".mmd")).read_text())
    return ('<div class="pending" role="note"><strong>DIAGRAM PENDING LOCAL RENDER</strong>本机图形渲染两次尝试均失败；图源已保留，本页暂不能展示渲染图。</div>'
            '<details><summary>' + escape(label) + '（Mermaid 图源）</summary><pre>' + source + '</pre></details>')


def comment(key, title):
    return ('<div class="comment"><label for="comment-' + escape(key) + '">对「' + escape(title) + '」的意见</label>'
            '<textarea id="comment-' + escape(key) + '" data-comment="' + escape(key) + '" data-title="' + escape(title) +
            '" placeholder="写在这里，自动保存在本页的浏览器中"></textarea></div>')


def section(key, title, body, tone="blue"):
    return ('<section class="card ' + escape(tone) + '" data-section="' + escape(key) + '"><h2>' + escape(title) + '</h2>' +
            body + comment(key, title) + '</section>')


cards = []
cards.append(section("summary", "一句话", """
<p class="lead">客户机每天在凌晨低活动时段自动检查并安装新版本，装不上就自动退回上一个能用的版本；如果我们发现某个版本有问题，可以在中央一键把它撤下来，所有客户机会在下次检查时自动换回好版本，并且记住「这版别再装」。</p>
<p><span class="term">发布清单（manifest）</span>是服务器上的一份 JSON 文件，记录每个版本的校验值和「当前对外版本」指针，客户机只信它。<span class="term">撤版（withdraw / quarantine）</span>是把坏版本从指针上摘掉并标记为隔离，让它不再可下载。<span class="term">上一个可用版本（previous-good）</span>是客户机本地仍保留、且上次通过过启动检查的那个版本目录。</p>
<p class="note">范围只到 PRD §8 的三件事：自动更新器、中央撤版 + 客户端黑名单、本地回滚/指定版本安装。不改发布清单的格式，不改客户端读取协议，不碰「静默自动对外发布」（B4）。</p>
""", "green"))

cards.append(section("flow", "核心流程：一次自动检查会发生什么", """
<p>每天四个整点（默认 03:00 起每 6 小时）系统定时器唤醒更新程序。只有落在「安装时窗」（默认 03:00 起两小时）的那一次才会真正安装普通升级；其余几次只是查一查、记下待装版本。唯一例外是<span class="term">被撤回的版本</span>：一旦发现自己正在跑的版本已被发布方撤下，不等时窗，立刻换回好版本——止血优先于不打扰。</p>
""" + diagram("d1-tick", "一次自动检查的流程图") + """
<p><span class="term">内核独占锁</span>：向操作系统申请「这个文件只能我一个进程打开」，进程一退出（包括被强杀）锁自动消失，所以永远不会出现「上次更新崩了、锁卡死」的情况。这保证同一时刻只有一个更新在动系统（PRD 要求的「单飞」）。</p>
<p><span class="term">90 秒健康检查</span>沿用现有的安装包重启脚本：重启服务后轮询 Bridge 的健康接口最多 90 秒，不通过就算失败。</p>
<p class="note">人工在终端运行 <code>update</code> 不受时窗限制；<code>rollback</code> 秒回上一个可用版本；<code>install &lt;版本号&gt;</code> 明确指定版本（只允许仍在保留期内、未被撤回的版本）；<code>auto-update on|off|status</code> 是总开关和状态查询。</p>
""", "blue"))

cards.append(section("model", "数据模型：本机靠什么记住「好版本」和「坏版本」", """
<p>客户机上只增加一份小账本 <code>update-ledger.json</code>。它<b>不</b>重复记录「当前是哪个版本」——那由指针文件说了算；它只记三件事：哪些版本通过过健康检查、哪些版本进了黑名单、有没有一次做到一半的更新。</p>
""" + diagram("d2-ledger", "账本与磁盘事实的关系图") + """
<div class="tablewrap"><table><thead><tr><th>黑名单原因</th><th>什么时候写入</th><th>什么时候解除</th></tr></thead><tbody>
<tr><td>启动检查失败</td><td>新版本重启后 90 秒内没健康，<b>先写黑名单再回退</b></td><td>允许再试一次；两次都失败就等发布方换新版本，或用户明确 <code>install</code> 这一版</td></tr>
<tr><td>用户手动退回</td><td><code>rollback</code> 成功后，和「成功」同一笔写入</td><td>发布方换新版本，或用户明确 <code>install</code> 这一版</td></tr>
<tr><td>发布方已撤回</td><td>检查时发现自己跑的版本在服务器上已不可见</td><td>不需要解除（版本号永不复用）</td></tr>
</tbody></table></div>
<p><span class="term">中途被杀的更新</span>：账本在动手之前就写下「我要做什么、装哪版、从哪版来、到了哪一步」。程序若在任何一步被杀（断电、强杀），下一次启动先看这条记录和指针的实际指向，按固定规则收尾：先把黑名单补上，再验证当前跑的版本是否健康，最后清掉记录。设计文档为每一个可能的崩溃点各写了一条测试。</p>
<p class="note">账本损坏时所有会改动系统的命令直接停下并提示联系我们，绝不猜。</p>
""", "purple"))

cards.append(section("withdraw", "中央止血：撤回一个坏版本时发生什么", """
<p>现在的撤版命令要求运营手工填「退回哪一版」，而且没有可退的版本时直接失败。本设计让它自动挑<span class="term">最近一个仍在保留期内的上一版</span>；如果确实没有可退的版本（比如第一个对外版本就坏了，或者上一版已过了 28 天保留期），可以显式进入「暂停发布」状态：老客户保持原版本继续用，新客户安装时得到诚实、可重试的提示，而不是一个坏掉的指针。</p>
""" + diagram("d3-withdraw", "撤版决策流程图") + """
<p><span class="term">服务器时间是唯一权威</span>：判断「上一版有没有过期」只用发布服务器返回的时间，不用运营电脑或 CI 机器的时钟；如果在读取和写入之间恰好跨过了过期线，服务器会拒绝写入，脚本最多重读重算三次。</p>
<p>PRD 要求覆盖的三种情况都在这张图里：有上一版 → 回指；上一版已过期 → 暂停并把过期版标记清楚；首个版本就坏 → 暂停。</p>
""", "red"))

cards.append(section("tradeoffs", "关键取舍与被拒方案", """
<div class="tablewrap"><table><thead><tr><th>决定</th><th>选了什么</th><th>没选什么，为什么</th></tr></thead><tbody>
<tr><td>定时器跑哪份更新程序</td><td>安装/更新时把更新程序复制一份固定在本机，定时器只跑这份副本</td><td>不用每次从 npm 现拉：离线或 npm 抖动会让定时任务不确定；也不把更新逻辑塞进被更新的软件包本身，坏包不该能弄坏自己的更新器</td></tr>
<tr><td>怎样知道版本被撤回</td><td>从「服务器上看不见自己这版了」推断，并记入黑名单</td><td>不给客户端协议加「隔离」字段：客户端读取协议已冻结（B0 合同），加字段要开新版本协议，留作后续</td></tr>
<tr><td>怎样保证同时只有一个更新</td><td>macOS 内核独占锁（进程死亡自动释放）</td><td>评审四轮证明：用文件夹/文件做锁，无论怎么加「回收」和「核验」，在极端并发下都有漏洞；改用操作系统提供的锁后这些概念全部消失</td></tr>
<tr><td>什么时候安装</td><td>每天检查四次，只在凌晨时窗安装；被撤回的版本例外，立刻换</td><td>不判断 Bridge 是否正忙（Lead 裁定 v1 接受盲重启，记为已知缺口）</td></tr>
<tr><td>没有上一版时撤版怎么办</td><td>需要运营显式加「允许暂停」才会把指针置空</td><td>不自动暂停：暂停会让新客户装不上，应当是有意识的决定</td></tr>
<tr><td>失败版本还要不要再试</td><td>允许第二次，第三次起不再自动装</td><td>不永久拉黑：偶发的机器状况不该让一个版本永远进不了这台机器；也不无限重试：每次都是真重启</td></tr>
</tbody></table></div>
""", "amber"))

cards.append(section("boundary", "诚实边界：这个设计做了什么、没做什么", """
<h3>做了</h3>
<ul>
<li>客户机定时自动更新、失败即时回滚、单飞锁、本地黑名单、被撤版立刻换回。</li>
<li>中央撤版自动挑上一版；没有可退版本时可显式暂停；三种情况各有一条真链路的端到端验收。</li>
<li>客户本地 <code>rollback</code> / <code>install &lt;版本&gt;</code> / <code>auto-update on|off|status</code>。</li>
<li>服务端两处小改：撤版时允许把已过期的旧版标记为过期；管理接口返回服务器时间。</li>
</ul>
<h3>没做，而且明说</h3>
<ul>
<li>更新前不判断 Bridge 是否正忙，凌晨时窗内会直接重启（Lead 裁定 v1 接受；后续议题）。</li>
<li>客户机发现撤版的最长延迟 = 下一次检查（默认最多 6 小时），没有推送。</li>
<li>电脑夜里关机会错过凌晨时窗，普通升级顺延到下一天；被撤回的版本仍是开机后第一次检查就换。</li>
<li>首次安装本身仍没有启动健康检查（现状），「首版即坏」在客户机上的表现是更新失败 + 明确的降级提示 + 黑名单。</li>
<li>当前正在跑的版本目录若已损坏，<code>install</code> 只会停下提示，不自动修复。</li>
<li>Linux 客户机不在 v1 承诺内：那里的锁不会自动回收，崩溃后需要人工处理。</li>
<li>真实 Cloudflare R2 的激活证据仍属上游 FLY-2389 的未完成清单；本 issue 的验收在本地真端点上跑。</li>
</ul>
""", "gray"))

review = ROOT / "review-result.json"
status_text = "工程设计 · Codex 评审五轮，等待收口"
try:
    import json
    r = json.loads(review.read_text())
    if r.get("effectiveVerdict") == "APPROVED":
        status_text = "工程设计已通过有效评审（Codex 五轮 + Lead 验收）· 尚未实施"
except Exception:
    pass

cards.append(section("review", "评审与裁定记录", """
<div class="tablewrap"><table><thead><tr><th>轮次</th><th>结果</th><th>主要改动</th></tr></thead><tbody>
<tr><td>Lead 问答</td><td>5 条裁定</td><td>6 小时可配；盲重启但默认凌晨 03:00 时窗；撤版可把过期旧版标 expired；开关命令进 v1；「已撤回」用推断标签</td></tr>
<tr><td>Codex 第 1 轮</td><td>7 高 3 中，全部采纳</td><td>撤版只认服务器时间；账本损坏不当空账本；崩溃收尾表；保住第一次更新后的回滚槽；复用目录不误删；锁与撤版幂等语义</td></tr>
<tr><td>Codex 第 2 轮</td><td>6 高 1 中，全部采纳</td><td>读写之间跨过期线的重算；切换前先落盘意图；回滚与黑名单同一笔写；所有改系统的命令统一前置检查；开关先装好更新程序副本</td></tr>
<tr><td>Codex 第 3 轮</td><td>4 高 1 中，全部采纳；触发安全阀，Lead 授权第 4 轮</td><td>账本记下每次更新的完整意图；崩溃收尾一律先补黑名单再复验旧版；<code>install</code> 对黑名单版本不再直接跳过；换授权码命令也走前置检查</td></tr>
<tr><td>Codex 第 4 轮</td><td>2 条残留 + 1 条新发现（用户态锁核验不原子）</td><td>换成操作系统内核锁（本机实测：第二进程立即被拒、进程被强杀自动释放）；失败次数按「这一次更新」计数不重复；损坏的当前目录只停下不动</td></tr>
<tr><td>Codex 第 5 轮</td><td>内核锁、失败计数两项确认闭合；剩 1 条阻断 + 1 条措辞建议</td><td>阻断已修：黑名单版本「原地重装」失败时，任何崩溃恢复路径都不动当前指针；措辞收窄：锁文件不能在更新期间被删。按 Lead 裁定以 Lead 验收收口，不再开第 6 轮</td></tr>
</tbody></table></div>
<p class="note">每一轮的条目与处置都逐条写在 plan.md §11；本页发布时的状态见顶部标签。</p>
""", "blue"))

summary_card = ('<section class="card" data-section="summary-box"><h2>页面意见汇总</h2>'
                '<p class="note">意见只保存在当前浏览器，不会自动发送。复制后发回即可；这是修改反馈，不代表批准。</p>' +
                comment("overall", "整体意见") +
                '<div id="summary-text" aria-live="polite"></div><button id="copy-all" type="button" disabled>复制全部意见</button>'
                '<div id="chunks"></div><p id="copy-status" role="status"></p></section>')

html = ('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        '<title>FLY-2392 · 客户自动更新器与止血</title><style>' + css + '</style></head><body><main>'
        '<div class="eyebrow">FLY-2392 · PRD 1098 §8 / B5 · 工程设计 · 2026-09-13</div>'
        '<h1>客户机自己更新，<br>出了问题一键止血。</h1>'
        '<span class="status">' + escape(status_text) + '</span>' +
        "".join(cards) + summary_card + '</main><script nonce="__CSP_NONCE__">' + controller + '</script></body></html>')

(ROOT / "founder-design.html").write_text(html)
print("generated founder-design.html", len(html.encode()), "bytes")
