#!/usr/bin/env python3
"""FLY-1774 QA — build the founder ship report from the repo template.

Fills every {{PLACEHOLDER}}, swaps the template's three sample SVGs for the
mmdc-rendered diagrams in this folder, and replaces the 529 figure placeholder
with the real-machine timeline (this change has no Discord surface, so there is
no 529 room run — the report says so explicitly instead of leaving a stub).

    python3 build-ship-report.py [out.html]
"""
import html
import pathlib
import re
import sys

QA = pathlib.Path(__file__).resolve().parent
REPO = QA.parents[3]
TPL = REPO / ".flywheel/templates/ship-report-template.html"
OUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/fly1774-ship-report.html")


def E(t):
    return html.escape(t, quote=False)


def svg_body(name):
    raw = (QA / name).read_text()
    body = re.search(r"<svg\b.*</svg>", raw, re.S).group(0)
    body = re.sub(r'\swidth="[^"]*"', ' width="100%"', body, count=1)
    body = re.sub(r'\sheight="[^"]*"', "", body, count=1)
    return body.replace("<svg ", '<svg role="img" ', 1)


s = TPL.read_text()

samples = re.findall(
    r"<!-- QA: replace this sample with mmdc-generated inline SVG\. -->\s*<svg.*?</svg>", s, re.S
)
assert len(samples) == 3, f"expected 3 sample svgs, found {len(samples)}"
for sample, f in zip(samples, ["d1-root-cause.svg", "d2-new-path.svg", "d3-data-flow.svg"]):
    s = s.replace(sample, f'<div class="diagram-scroll" style="overflow-x:auto">{svg_body(f)}</div>', 1)

# 05 · this change has no Discord surface: retitle the section and tell the truth.
s = s.replace("05 · E2E / 529 N-to-N", "05 · 真机 E2E")
old_link = re.search(
    r"<h3>529 thread link</h3>.*?<p><strong>结果：</strong> \{\{QA_529_RESULT\}\}</p>", s, re.S
).group(0)
s = s.replace(
    old_link,
    "<h3>真机跑的是什么</h3>"
    "<p>这次改动<strong>不碰任何 Discord 界面</strong>（不改发送、转达、卡片渲染、founder 交互、圆桌），"
    "所以没有开 529 Discord 房——这一点写在这里，不是悄悄跳过。</p>"
    "<p>真机验证换成了更贴题的形式：起一个<strong>真的 Codex 守护进程</strong>，让它真的把一个目标做完、"
    "真的停驻，然后用<strong>真的 Lead 发信命令</strong>叫它。全程没有人碰终端一下。</p>"
    "<p><strong>结果：</strong> 两次独立跑，停驻的 Codex 分别在 <strong>1.5 秒</strong>和 <strong>3.4 秒</strong>后"
    "自己醒来，自己去信箱把信读了，把 Lead 要的事做完，然后自己签收。"
    "把同一套流程里的那一个改动文件换回改动前的版本，同样的 Codex 停驻后等满 90 秒——一动不动。</p>",
)

old_img = re.search(r"<!-- QA: replace this data URI placeholder.*?-->\s*<img[^>]*>", s, re.S).group(0)
LINES = [
    ("02:14:56", "Codex 完成目标 → 停驻(paused)", "n"),
    ("02:14:57", "空信箱观察 45 秒 → 0 次打扰", "g"),
    ("02:15:42", "Lead 发信 (flywheel-comm send)", "n"),
    ("02:15:44", "Codex 自己醒来 ← 门铃 (+3.4s)", "g"),
    ("02:15:49", "runner 读完信、做完事、自己签收", "g"),
    ("——", "改动前的同一场景：等 90 秒，0 次唤醒", "b"),
]
rows, y = [], 74
for t, txt, kind in LINES:
    fill = {"g": "#e6f7ec", "b": "#ffe5e2", "n": "#ffffff"}[kind]
    stroke = {"g": "#34c759", "b": "#ff3b30", "n": "#d2d2d7"}[kind]
    rows.append(
        f'<rect x="40" y="{y}" width="880" height="58" rx="12" fill="{fill}" stroke="{stroke}"/>'
        f'<text x="66" y="{y + 35}" font-family="ui-monospace,Menlo,monospace" font-size="19" fill="#6e6e73">{E(t)}</text>'
        f'<text x="196" y="{y + 35}" font-family="-apple-system,system-ui,sans-serif" font-size="20" fill="#1d1d1f">{E(txt)}</text>'
    )
    y += 68
s = s.replace(
    old_img,
    '<svg viewBox="0 0 960 500" role="img" aria-label="真机跑的关键时间线" style="width:100%;height:auto">'
    '<rect width="960" height="500" rx="20" fill="#f5f5f7"/>'
    '<text x="40" y="46" font-family="-apple-system,system-ui,sans-serif" font-size="21" font-weight="700" fill="#1d1d1f">'
    "真机跑的关键时间线（真 Codex 守护进程，终端原始输出）</text>" + "".join(rows) + "</svg>",
)

VALS = {
    "ISSUE_IDENTIFIER": "FLY-1774",
    "ISSUE_TITLE": "停驻的 Codex 助手，现在会自己醒来干活",
    "ONE_SENTENCE_OUTCOME": "以前你得跑去终端手动戳一下才叫得动它；现在 Lead 一发话，它 1～4 秒内自己醒来，自己把活干了。",
    "TEST_SCOPE_BADGE": "单测 + 集成 + 真机",
    "E2E_SCOPE_BADGE": "真 Codex 守护进程 E2E · 有改动前对照",
    "PR_LINK_OR_NUMBER": "PR #844",
    "VERIFIED_HEAD": "ae36e034（产品代码）+ 一条纯 QA 文档 commit",
    "QA_DATE": "2026-08-15",
    "QA_RUNNER": "QA Runner（独立验证节点）",
    "FOUNDER_SUMMARY": "修好了。8 月 14 号一天里踩了两次的那个毛病——Codex 助手把手上的目标做完、进入待命之后就再也不看信箱了，"
    "Lead 发的话它收不到，只能有人跑去它的终端窗口手动敲一句才叫得醒——现在没有了。我在真的 Codex 上跑了两遍："
    "让它真的做完一个目标、真的进入待命，然后用真的发信命令叫它。两次它都自己醒了，1.5 秒和 3.4 秒，"
    "醒来之后自己去信箱把信读完、把事做完、自己标记收到。全程没有人碰过终端。",
    "BEFORE_BEHAVIOR": "Codex 助手做完手上的目标就进入待命，从那一刻起它不再看信箱。Lead 发的指令安安静静躺在信箱里，"
    "没有任何东西去叫它。唯一的办法是有人打开它的终端窗口，手动敲一句指针把它戳醒。"
    "8 月 14 号这一天就为此人工兜了两次（一次 rebase 指令，一次返工指令）。",
    "AFTER_BEHAVIOR": "信一进信箱，两条独立的腿都会去给它按门铃：一条在信件投递时按，一条在它每轮说完话时兜底再按一次。"
    "门铃是一条待办记录，Codex 的待命循环每轮都会看一眼，看到就当成新一轮任务醒过来。"
    "如果门铃因为什么原因丢了，信件的租约到期会原地重投，整条链再走一遍——不需要人。",
    "QA_JUDGMENT": "PASS。验收判据（真机、零人工输入、N 秒内醒来）达成，实测 1.5s / 3.4s，预算是 60 秒。"
    "更重要的是我做了改动前的对照：同一套流程把那一个文件换回旧版本，Codex 等满 90 秒纹丝不动——"
    "所以「醒了」确实是这次改动带来的，不是碰巧。",
    "ROOT_CAUSE_IN_FOUNDER_LANGUAGE": "不是「忘了写唤醒功能」。唤醒这条链路本来就有，是链路上有两处断了，加上少了一条兜底，"
    "三件事凑在一起，结果就是待命的 Codex 谁也叫不醒。",
    "ROOT_CAUSE_DETAIL": "断点一：系统把「做完了、在等审阅」这个状态当成了「这个助手已经结束了」，于是 Lead 发给它的信"
    "在投递那一刻就被判定为送不到、直接作废。断点二：信件是按批次投递的，但接收端拿到批次编号后"
    "去按「单封信件」的编号查库，查不到就报错，然后每秒重试一次、永远重试——门铃从来没响过。"
    "缺的那条腿：Codex 每轮说完话时，没有任何人回头看一眼「信箱里还有没有没读的」。",
    "FIX_PRINCIPLE": "门铃只负责响，绝不替 Codex 签收。这是这次修复最关键的一条自律：按门铃的那条腿一个字都不碰信件状态，"
    "信永远只能由 Codex 自己读、自己签收。这样即使门铃按错了、按重了，也只是让它多查一次空信箱，"
    "绝不会出现「系统以为送到了、其实它根本没看过」这种最坏情况。同时每个助手同时最多只有一个门铃在响，"
    "所以它不会被按个不停。",
    "FIX_ITEM_1": "把「做完了、在等审阅」重新算作活人：Lead 的信正常投递，不再一到就作废。真的已经结束的八种状态"
    "（完成 / 批准 / 阻塞 / 失败 / 驳回 / 延后 / 搁置 / 终止）照旧当场作废并退信给 Lead——这条我逐个状态验过，没有松动。",
    "FIX_ITEM_2": "给批次投递配一条专用的按门铃通道：它按批次的身份去查库（不再拿批次编号当单封信件查），"
    "并且完全不碰信件状态。旧的单封信件通道一个字节没改。",
    "FIX_ITEM_3": "补上兜底那条腿：Codex 每轮说完话时顺手扫一眼信箱，有没读的就按一次门铃。"
    "没有未读就完全静默——这一点我专门跑了 45 秒的对照，一次都没打扰它。Claude 助手那一侧完全不走这条腿。",
    "DIAGRAM_1_CAPTION": "图 1：信到了、人在，但中间没有任何东西负责去敲门——只能靠人跑一趟。",
    "DIAGRAM_2_CAPTION": "图 2：绿色是这次新增的三处。注意门铃只写「去查信箱」，信件正文和签收权始终在 Codex 自己手里。",
    "DIAGRAM_3_CAPTION": "图 3：一条指令从 Lead 出发到被执行完的完整路径；虚线是没人接时的自动重投兜底。",
    "UNIT_TEST_COUNT": "228",
    "INTEGRATION_TEST_COUNT": "62",
    "E2E_SCENARIO_COUNT": "9",
    "AUTOMATED_TEST_DETAIL": "针对性单测 228 个全过（新机制 13 个 + 信箱库 100 个 + Codex 适配器 69 个 + 待命生命周期 15 个 + "
    "投递闸状态矩阵 + 部署脚本同步 26 个），加 shell 侧 23 个。信箱与钩子相关的 10 个测试文件 113 个全过。"
    "另外我不只跑测试：真的拿生产信箱数据库（523MB）的在线备份副本跑了一遍升级——43 毫秒完成，"
    "30 个会话、24304 封信一行不少，全部默认关闭，完整性检查通过。PR 的 CI 9 项全绿。",
    "REAL_MACHINE_DETAIL": "真的起了一个 Codex 守护进程，真的给它一个目标、真的让它做完并停驻，然后用真的 Lead 发信命令叫它。"
    "9 个场景全过，包括阴性对照（没信的时候 45 秒零打扰）、唤醒速度（1.5s / 3.4s）、"
    "醒来后真的读信真的干活（生成了约定的文件）、以及签收确实是它自己完成的（不是系统替它签的）。"
    "此外我把按门铃的命令当成真正的命令行程序跑了 40 个场景（含三个进程同时抢——只产生一个门铃），"
    "以及把钩子脚本原样跑了 11 个场景。",
    "FULL_GATE_RESULT": "PASS · 全仓构建通过 · lint 0 错误 · PR CI 9/9 全绿。ship 门上的那条 commit 只多了这份报告和 QA 脚本，产品代码与被测版本逐字节相同。",
    "UNTESTED_SCOPE": "① 没有起一个真的 Bridge 主进程走完「投递腿」那条链，我用的是构成它的真实组件逐段验证。"
    "② 没有开 529 Discord 房——这次改动不碰任何 Discord 界面。"
    "③ 租约到期后自动重投这条兜底腿，只有单元测试覆盖，真机上我没有把 30 分钟的租约等完。"
    "④ 部署那一刻已经在跑的 Codex 助手，仍然是老样子。",
    "UNTESTED_REASON": "① 投递腿的产品代码除了状态判定那一处外一个字节没改，而状态判定我在真的组件上把 11 种状态全部穷举验过了；"
    "并且验收场景本身由另一条腿（已在真守护进程上跑通）独立覆盖——这是设计里故意留的双保险。"
    "② 这次改的是信箱和唤醒，不产生任何 Discord 消息、卡片或转达；唯一沾边的是退信通知的时机变了，"
    "而发这条通知的代码没动。③ 等一个完整租约周期需要 30 分钟真机空转，收益低于成本。"
    "④ 这是实现方案里明确选的边：不给老会话补写能力标记，避免给没有强保证的旧注册补数据。",
    "RISK_AND_FOLLOWUP": "风险都是有界的。①②③ 万一有问题，最坏结果是回到今天的样子（有人手动戳一下），不会更糟，"
    "也不会出现「以为送到了其实没送到」——因为按门铃的腿一个字都不碰信件状态。"
    "④ 是确定会发生的：这次改动要生效需要重启一次 Bridge，重启前已经在跑的那些 Codex 助手"
    "仍然要人工兜；从下一批新开的助手起全部自动。建议 ship 后观察一周：如果还有人需要手动戳，"
    "看一眼那个助手是不是重启前就在跑的老会话。",
}
for k, v in VALS.items():
    s = s.replace("{{%s}}" % k, E(v))

left = sorted(set(re.findall(r"\{\{[A-Z0-9_]+\}\}", s)))
assert not left, f"unfilled placeholders remain: {left}"
assert "QA: replace this" not in s, "template sample markers still present"
assert "529 GIF / keyframes" not in s, "529 placeholder image still present"

OUT.write_text(s)
print("written", OUT, len(s), "bytes")
