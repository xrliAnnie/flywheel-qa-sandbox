#!/usr/bin/env python3
"""Build founder-design.html for FLY-3133: inline locally rendered Mermaid SVGs,
escape all text, single nonced script. Run from this diagrams/ directory."""
import html
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE.parent / "founder-design.html"
REVIEW_STATUS = sys.argv[1] if len(sys.argv) > 1 else "设计评审进行中"


def svg(name: str) -> str:
    raw = (HERE / f"{name}.svg").read_text(encoding="utf-8")
    raw = re.sub(r"<\?xml[^>]*\?>", "", raw)
    return f'<div class="diagram">{raw}</div>'


def e(text: str) -> str:
    return html.escape(text, quote=True)


SECTIONS = []


def section(key: str, title: str, body: str, color: str = "blue") -> None:
    SECTIONS.append((key, title, body, color))


def p(text: str) -> str:
    return f"<p>{e(text)}</p>"


def ul(items) -> str:
    return "<ul>" + "".join(f"<li>{e(i)}</li>" for i in items) + "</ul>"


def table(head, rows) -> str:
    h = "".join(f"<th>{e(c)}</th>" for c in head)
    b = "".join("<tr>" + "".join(f"<td>{e(c)}</td>" for c in r) + "</tr>" for r in rows)
    return f'<div class="tw"><table><thead><tr>{h}</tr></thead><tbody>{b}</tbody></table></div>'


def term(word: str, meaning: str) -> str:
    return f'<p class="term"><strong>{e(word)}</strong>：{e(meaning)}</p>'


section("summary", "一句话结论", p(
    "把 Cloudflare 这个 Epic 拆成 7 张子单并定好每张的技术路线；第一张先做「页面保留期」（F1a，不需要 Cloudflare）："
    "以后你跟 Lead 说一句「这页永久 / 留 28 天 / 2 天就行」，那一页就按你说的来，Lead 回你确切的失效时间。")
    + p("本页只是设计：还没写代码、没开 Linear 子单、没碰 Cloudflare 账号。")
    + term("Epic", "一组相关子单的总单，这里是 FLY-3133。")
    + term("子单", "Epic 下面一张张能单独做完、单独验收的工作。"), "green")

section("order", "子单怎么排", svg("d1-epic-order")
    + table(["子单", "要你先定什么", "做完你能看到的变化"], [
        ["F1a 保留期", "不用", "单页可设永久 / N 天，有清单可查"],
        ["F2 手机看控制台（只读）", "①账号（走 Cloudflare 时）②走哪条路", "在外面用手机登录后看到控制台，但不能改"],
        ["F8 Runner 只读钥匙", "①账号 ④钥匙风险", "Cloudflare 出问题时 Runner 能自己查状态"],
        ["F1b 页面搬到 Cloudflare", "①账号 ③6 个 Gmail", "打开页面先用 Google 登录；单页可分享给朋友"],
        ["F3 手机试原型", "②走哪条路", "评审卡里的原型手机上能直接点着试"],
        ["F6 云截图", "①账号", "本机不再为发页面开 Chrome，截图照旧"],
        ["F5 改用 cf", "等 cf 正式版", "你看不到变化，挂起"],
    ])
    + p("要你定的 4 件事（做到对应子单前 Lead 会再问你）：")
    + ul([
        "① 用哪个 Cloudflare 账号：安装包分发现在用的那个，还是新开一个（建议同一个，用不同钥匙隔开用途）。",
        "② 控制台走 Cloudflare（要买一个域名，手机不用装东西）还是 Tailscale（手机装 App，不用买域名）。",
        "③ 你的 6 个 Gmail 清单。",
        "④ 钥匙风险：Runner 和 Bridge 在同一台电脑、同一个系统用户下运行，放钥匙的文件对它们都读得到（今天其它钥匙也是这样）。"
        "可以先接受这个风险，也可以要求更强的隔离（工作量大）。",
    ])
    + term("Runner", "替我们干活的 AI 工作进程。")
    + term("Bridge", "你电脑上统管 Lead 和 Runner 的后台程序，控制台就是它的网页。"))

section("f1a-flow", "F1a 怎么工作：设置一页的保留期", svg("d2-f1a-flow")
    + p("每一页在存储里都有自己的文件夹。设了保留期的页，文件夹里多一个很小的「策略文件」，写着这页是默认、永久，还是到某个时刻失效。"
        "网关每次打开页面都先看这个小文件，没到期才把页面给出去。")
    + p("「2 天就行」会被换算成一个确切的失效时刻写进去，所以以后搬家、重新部署都不会把时间算错。")
    + p("只有在存储确认已经写好之后，Lead 才会回你「设好了」；如果网络卡住、结果不确定，Lead 会说「结果未知，请再说一次」，不会假装成功。")
    + term("网关", "有人点开页面链接时，负责去存储里取页面、判断能不能给看的那段程序。")
    + term("托管存储", "放页面文件的云上仓库，现在用的是 Vercel 的存储。")
    + term("版本号（ETag）", "存储给每个文件的一个指纹；只有指纹没变时才允许覆盖，这样两次修改不会互相盖掉。")
    + term("登记簿（registry）", "Bridge 本机记录「发过哪些页面」的文件；这里只用来给你列清单，不决定删不删页面。"), "green")

section("model", "数据怎么存", svg("d4-model")
    + ul([
        "生效的只有每页自己的策略小文件；它和页面放在一起，页面在它就在。",
        "默认 14 天只写在一个地方（DEFAULT_REPORT_RETENTION_DAYS），以后改默认值只改这一处。",
        "Epic 固定页只能设「默认」或「永久」：它每次更新都会重新计时，「留 N 天」对它说不清。",
        "到期页面的清理分三步：先在策略小文件上打「正在删除」标记，并记下要删哪几个文件（之后任何卡在半路的旧修改都会失效，打开链接立即 404）；再只删记下的那几个文件；最后把标记改成「已退役」并永久留着（每个约 200 字节），保证这页以后不会被晚到的旧修改「复活」。中途断电也能下次接着做完。",
        "只有一页里所有文件都到期了才整页清理；页面还有效时一个文件都不删。",
        "同一页的「设置 / 更新 / 清理」一次只能进行一个（每页一把锁），每一步先在本机记一笔再动手；网络卡住、程序崩溃后照着记录接着做，不会把永久页悄悄改回默认，也不会误伤刚更新好的 Epic 页。",
        "过期页面的字节最多晚一天被清掉，但到期那一刻链接就已经打不开了。",
    ]))

section("f2", "F2 手机看控制台：为什么另开一个只读入口", svg("d3-f2-console")
    + p("审代码时发现：现有控制台（本机 9876 端口）的首页、实时推送、甚至「批准 / 终止」按钮背后的接口，靠的都是「只有本机能连上」。"
        "隧道一接上，外面来的请求在 Bridge 看来也是本机来的，这把锁就失效了。")
    + p("所以设计是：9876 永远不接隧道；另开一个只放「看」的入口，里面根本没有「改」的功能，再在前面挂登录门，并核对登录的是不是你。")
    + term("隧道", "从你电脑往外连的一条通道，让外面能访问电脑上的某个网页，而电脑本身不用开放端口。")
    + term("登录门（Cloudflare Access）", "挡在网页前面的一道门，只放名单上的邮箱登录。")
    + term("Tailscale", "把你的手机和电脑连成一个私人小网络的 App，外人看不到这个网络。"), "purple")

section("tradeoffs", "关键取舍与否掉的方案", table(["问题", "选了", "否掉的做法和原因"], [
    ["保留期存在哪", "每页一个策略小文件", "一份「全部页面的总清单」：评审发现删页、重发、搬家、网络超时时会和登记簿对不上，可能让 2 天的页又能打开"],
    ["两次修改撞车", "按版本号有条件地写", "「写完回读一下」：卡住的旧请求可能晚到，把后来成功的修改盖掉"],
    ["清理和修改撞车", "清理前先打「正在删除」标记", "「到期后等 1 小时再删」：卡住的旧修改理论上可能比 1 小时还晚到"],
    ["网关怎么读", "先读策略、再读页面", "同时读两样：删页面和读策略交错时，已过期的页可能被按默认 14 天打开"],
    ["F1b 页面放哪", "存储桶 + 一个网关小程序", "每发一页就重新部署一次网站：会撞部署次数上限（以前在 Vercel 上撞过）"],
    ["F2 远程入口", "另开只读入口", "把现有 9876 直接接隧道：外面能点到「批准 / 终止」"],
    ["F6 截图在哪做", "Bridge 这边调用云浏览器", "让 Runner 直接拿截图钥匙：钥匙会离 Runner 更近"],
    ["F8 钥匙放哪", "单独一个只放只读钥匙的文件", "加进 Runner 的环境变量：每个 Runner 都会自动带着它"],
]))

section("boundary", "诚实边界：这次做什么、不做什么", "<h3>F1a 会做</h3>" + ul([
    "单页设置永久 / N 天（1–365 天）/ 改回默认；发布后随时能改。",
    "清单：哪些页不是默认、各到什么时候。",
    "Claude 类型的 Lead 能替任何页面设置；Codex 类型的 Lead 只能改它自己发的页面（其它页面请 Claude Lead 代办）。",
    "网关升级后先在线上做一次「金丝雀」检查（放一张故意已到期的测试页，确认新网关会拦下来），检查通过才允许设非默认。",
]) + "<h3>F1a 不做</h3>" + ul([
    "不搬 Cloudflare、不改链接样子、不做分享（F1b 做）。",
    "已经过期的页面不能救回来。",
    "设了非默认的页面存在时，代码不能直接退回旧版本（旧版本会按 14 天删掉永久页）；只能先关掉设置功能、再往前修。",
    "不修今天就有的一个小问题：默认页在「换托管账号 + 重新部署」之后，失效时间可能从搬家那天重新算。",
]) + "<h3>整个 Epic 不做</h3>" + ul([
    "不把 Runner 搬到 Cloudflare 云上跑；不做多机（FLY-555）和外部推送入口（FLY-3131）。",
    "不把 cf 公测版放进每天都在用的流程；超出免费额度前先问你。",
]) + term("金丝雀", "专门用来试探的测试页，用它的结果判断新网关是不是真的在按保留期办事。"), "amber")

section("review", "评审情况", p(REVIEW_STATUS) + p(
    "设计文件：engineering/doc/FLY-3133-cloudflare-remote-access/ 下的 exploration.md、research.md、plan.md。"
    "生产代码只读审计，基于 main 9fcbdebb1。"))

COLORS = {"blue": "#007aff", "green": "#34c759", "purple": "#af52de", "amber": "#ff9500"}

cards = []
for key, title, body, color in SECTIONS:
    cards.append(
        f'<section style="border-left-color:{COLORS[color]}" data-section="{e(key)}">'
        f"<h2>{e(title)}</h2>{body}"
        f'<label for="comment-{e(key)}">对本节的意见（自动保存在本机浏览器）</label>'
        f'<textarea id="comment-{e(key)}" data-comment="{e(key)}" data-title="{e(title)}"></textarea></section>'
    )

feedback = (
    '<section data-section="feedback" style="border-left-color:#86868b"><h2>页面意见汇总</h2>'
    "<p>写完各节意见后点「复制全部意见」，贴回本单的 thread。这里汇总的是修改意见，不代表批准。</p>"
    '<label for="comment-feedback">补充意见</label>'
    '<textarea id="comment-feedback" data-comment="feedback" data-title="补充意见"></textarea>'
    '<pre id="summary"></pre><button id="copy-all" type="button">复制全部意见</button>'
    '<div id="chunks"></div><p id="copy-status" aria-live="polite"></p></section>'
)

SCRIPT = r"""
'use strict';
const marker = '【页面意见汇总】FLY-3133';
const prefix = 'founder-review:' + location.pathname + ':FLY-3133:';
const fields = Array.from(document.querySelectorAll('[data-comment]'));
const summary = document.getElementById('summary');
const chunksHost = document.getElementById('chunks');
const status = document.getElementById('copy-status');
let currentText = marker;
function fallbackCopy(text) {
  const tmp = document.createElement('textarea');
  tmp.value = text; tmp.setAttribute('readonly', ''); tmp.style.position = 'fixed'; tmp.style.opacity = '0';
  document.body.appendChild(tmp); tmp.select();
  let ok = false; try { ok = document.execCommand('copy'); } finally { tmp.remove(); }
  if (!ok) throw new Error('copy unavailable');
}
async function copy(text) {
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(text);
  } catch (_) {
    try { fallbackCopy(text); } catch (_) { status.textContent = '自动复制失败，请手动选中汇总文字复制。'; return; }
  }
  status.textContent = '已复制意见；这是修改意见，不是批准。';
}
function update() {
  const entries = fields.filter(f => f.value.trim()).map(f => '[' + f.dataset.title + ']\n' + f.value.trim());
  currentText = marker + (entries.length ? '\n\n' + entries.join('\n\n') : '\n\n（还没有写意见）');
  summary.textContent = currentText;
  chunksHost.replaceChildren();
  if (currentText.length <= 1800) return;
  const chars = Array.from(currentText.slice(marker.length + 2));
  const cap = 1750 - marker.length - 2;
  for (let i = 0; i < chars.length; i += cap) {
    const text = marker + '\n\n' + chars.slice(i, i + cap).join('');
    const div = document.createElement('div'); div.className = 'chunk';
    const pre = document.createElement('pre'); pre.textContent = text;
    const button = document.createElement('button'); button.type = 'button';
    button.textContent = '复制分段 ' + (Math.floor(i / cap) + 1);
    button.addEventListener('click', () => copy(text));
    div.append(pre, button); chunksHost.appendChild(div);
  }
}
for (const field of fields) {
  try { field.value = localStorage.getItem(prefix + field.dataset.comment) || ''; } catch (_) {}
  field.addEventListener('input', () => {
    try { localStorage.setItem(prefix + field.dataset.comment, field.value); } catch (_) {}
    update();
  });
}
document.getElementById('copy-all').addEventListener('click', () => copy(currentText));
update();
"""

CSS = """*{box-sizing:border-box}body{margin:0;background:#f5f5f7;color:#1d1d1f;font-family:-apple-system,system-ui,sans-serif;line-height:1.65}
main{max-width:960px;margin:auto;padding:28px 16px 60px;overflow-wrap:anywhere}h1{font-size:30px;letter-spacing:-.5px;line-height:1.25;margin:6px 0}
h2{font-size:21px;margin:0 0 12px}h3{font-size:16px;margin:16px 0 4px}.muted,small{color:#86868b}
section{background:#fff;padding:22px;border-radius:12px;margin:18px 0;border-left:4px solid #007aff;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.diagram{overflow-x:auto;margin:10px 0;background:#fff;border:1px solid #eee;border-radius:8px;padding:8px}.diagram svg{display:block;max-width:100%;height:auto}
.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px;margin:8px 0}th,td{border-bottom:1px solid #e5e5ea;padding:8px;text-align:left;vertical-align:top}th{color:#1a365d}
.term{font-size:14px;background:#f5f5f7;border-radius:8px;padding:6px 10px;margin:6px 0}
textarea{display:block;width:100%;min-height:80px;margin:6px 0 0;padding:10px;border:1px solid #c7c7cc;border-radius:8px;font:inherit;resize:vertical}
label{display:block;margin-top:16px;font-size:13px;color:#86868b}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;background:#f5f5f7;padding:14px;border-radius:8px}
button{border:0;background:#007aff;color:#fff;padding:10px 16px;border-radius:8px;font:inherit;cursor:pointer;margin:8px 8px 0 0}.chunk{border-top:1px solid #ddd;margin-top:14px;padding-top:8px}
.id{font-family:'SF Mono',monospace;color:#1a365d}@media(max-width:600px){section{padding:16px}h1{font-size:25px}}"""

page = (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    '<meta name="viewport" content="width=device-width,initial-scale=1">'
    "<title>FLY-3133 · Cloudflare 外用能力设计</title>"
    f"<style>{CSS}</style></head><body><main>"
    '<small><span class="id">FLY-3133</span> · 工程设计 · 2026-10-01</small>'
    "<h1>用 Cloudflare 让 Flywheel「在外面也能用」：拆单与第一步「页面保留期」</h1>"
    f'<p class="muted">{e(REVIEW_STATUS)} · 尚未实施</p>'
    + "".join(cards) + feedback
    + f'<script nonce="__CSP_NONCE__">{SCRIPT}</script></main></body></html>'
)
OUT.write_text(page, encoding="utf-8")
print(OUT)
