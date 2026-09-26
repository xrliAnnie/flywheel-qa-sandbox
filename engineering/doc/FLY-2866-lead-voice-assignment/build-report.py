"""Build the founder report page for FLY-2866 (self-contained HTML, audio embedded as data URIs).

Usage: python3 build-report.py <clips-dir> <summary.json> <out.html> [--attachments]

--attachments: the hosted report gateway serves pages under CSP `default-src 'none'` with no
media-src, so embedded audio cannot play there. This mode replaces each player with the name of
the mp3 the Lead attaches to the Discord message instead.
"""

import base64
import html
import json
import pathlib
import sys

clips = pathlib.Path(sys.argv[1])
summary = json.loads(pathlib.Path(sys.argv[2]).read_text())
out = pathlib.Path(sys.argv[3])
ATTACH = "--attachments" in sys.argv[4:]
ATTACH_NAMES = {
    "R-verse": "verse-1-8月原样本.mp3", "L-verse": "verse-2-老模型今天.mp3",
    "B-verse": "verse-3-Codex实时2.1.mp3", "A-verse": "verse-4-GPT-Live.mp3",
    "R-alloy": "alloy-1-8月原样本.mp3", "A-alloy": "alloy-4-GPT-Live.mp3",
}


def audio(name: str) -> str:
    if ATTACH:
        n = ATTACH_NAMES.get(name)
        return f'<span class="att">🎧 附件 {n}</span>' if n else '<span class="dim">见仓库版</span>'
    p = clips / f"{name}.m4a"
    if not p.exists():
        return '<span class="dim">—</span>'
    b64 = base64.b64encode(p.read_bytes()).decode()
    return f'<audio controls preload="none" src="data:audio/mp4;base64,{b64}"></audio>'


# founder 2026-08-21 verbatim descriptions (FLY-1850 prd.md:2443-2452)
DESC = {
    "alloy": ("低沉冷静的女声", "女"),
    "ash": ("憨厚的男声", "男"),
    "ballad": ("听起来有点奸诈和油腻的男声", "男"),
    "cedar": ("听起来很 beta 的男声", "男"),
    "coral": ("乡土气息、发音不标准的女声，淳朴中年人感", "女"),
    "echo": ("像戴眼镜的 gay 的男声，低沉，淡淡憋着的感觉", "男"),
    "marin": ("听起来靠谱的中年女声", "女"),
    "sage": ("有点像神婆的中老年女声", "女"),
    "shimmer": ("非常冷静、靠谱、不好接近的女声", "女"),
    "verse": ("有活力的中年男声", "男"),
}
ASSIGNED = {"alloy": "Honey Lemon", "marin": "Raya（主管 Lead）", "verse": "Tadashi"}

LEADS = [
    # (project, agentId, persona, persona note, PRD voice, source, proposal, flag)
    ("flywheel", "flywheel-eng-lead", "Tadashi", "", "verse", "prd.md:2452 · :2074", "verse", "verse"),
    ("flywheel", "flywheel-product-lead", "Honey Lemon", "", "alloy", "prd.md:2443 · :2073", "alloy", ""),
    ("raya", "raya", "Raya", "耳机模式主管 Lead（你 9-24 确认）", "marin", "prd.md:2449 · :2075", "marin（不变）", ""),
    ("flywheel", "flywheel-cos-lead", "Aunt Cass", "原型为女性角色", "", "", "marin（不变）", ""),
    ("flywheel", "codex-infra-bot-lead", "Codex Infra Bot", "无人设名", "", "", "marin（不变）", ""),
    ("flywheel", "claude-infra-bot-lead", "Claw", "人设未写性别", "", "", "marin（不变）", ""),
    ("geoforge3d", "cos-lead", "Simba", "原型为男性角色（狮子王）", "", "", "marin（不变）", "male"),
    ("geoforge3d", "product-lead", "Peter", "人设未写性别", "", "", "marin（不变）", ""),
    ("geoforge3d", "ops-lead", "Oliver", "人设未写性别", "", "", "marin（不变）", ""),
    ("joycon-typeless", "joycon-lead", "Hiro", "原型为男性角色（超能陆战队）", "", "", "marin（不变）", "male"),
    ("personal-assistant", "belle-lead", "Belle", "原型为女性角色", "", "", "marin（不变）", ""),
    ("growth", "mufasa-lead", "Mufasa", "原型为男性角色（狮子王）", "", "", "marin（不变）", "male"),
    ("growth", "rafiki-lead", "Rafiki", "原型为男性角色（狮子王）", "", "", "marin（不变）", "male"),
    ("growth", "reflection-lead", "（未命名）", "人设名待你定", "", "", "marin（不变）", ""),
    ("tidal-echo", "tidal-echo-cos-lead", "Triton", "原型为男性角色（小美人鱼）", "", "", "marin（不变）", "male"),
    ("tidal-echo", "tidal-echo-content-lead", "Ariel", "原型为女性角色", "", "", "marin（不变）", ""),
    ("tidal-echo", "sub-lead", "Asha", "原型为女性角色", "", "", "marin（不变）", ""),
]


def hz(v):
    return "—" if v is None else f"{round(v)}"


def f0_list(xs):
    return " / ".join(str(round(x)) for x in xs) if xs else "—"


lead_rows = []
for proj, aid, persona, note, prd, src, prop, flag in LEADS:
    prd_cell = f'<b>{prd}</b><div class="src">{src}</div>' if prd else '<span class="dim">PRD 没写</span>'
    cls = "row-change" if prop in ("verse", "alloy") else ""
    badge = ""
    if flag == "verse":
        badge = '<span class="badge amber">要你听一下</span>'
    elif flag == "male":
        badge = '<span class="badge purple">男性人设 · 现为女声</span>'
    change = f'marin → <b>{prop}</b>' if prop in ("verse", "alloy") else html.escape(prop)
    lead_rows.append(
        f'<tr class="{cls}"><td><b>{html.escape(persona)}</b><div class="src">{aid} · {proj}</div></td>'
        f'<td>{html.escape(note) or "<span class=dim>—</span>"}</td><td>{prd_cell}</td><td>{change} {badge}</td></tr>'
    )

voice_rows = []
for v, (desc, g) in DESC.items():
    s = summary[v]
    who = ASSIGNED.get(v, '<span class="dim">未选</span>')
    voice_rows.append(
        f'<tr><td><b class="mono">{v}</b><div class="src">你的原话：{html.escape(desc)}</div><div class="src">分给：{who}</div></td>'
        f'<td class="c">✅</td><td class="c">✅</td>'
        f'<td>{audio("A-" + v)}<div class="src">音高 {f0_list(s["A"]["f0"])} Hz · {s["A"]["rate"] or "—"} 字/秒</div></td>'
        f'<td>{audio("B-" + v)}<div class="src">音高 {f0_list(s["B21"]["f0"])} Hz · {s["B21"]["rate"] or "—"} 字/秒</div></td>'
        f'<td class="c">{hz(s["ref"])}</td></tr>'
    )


def cmp_block(v, title):
    s = summary[v]
    return f"""
<div class="card {'amber' if v == 'verse' else 'blue'}">
 <div class="card-title">{title}</div>
 <table class="cmp">
  <tr><th>哪一段</th><th>试听</th><th>音高</th></tr>
  <tr><td>① 你 8-21 听过的原样本<div class="src">FLY-1911 voices/{v}.mp3，Codex 实时 V2 通道</div></td><td>{audio("R-" + v)}</td><td>{hz(s["ref"])} Hz</td></tr>
  <tr><td>② 同一个老模型，今天重录<div class="src">gpt-realtime-1.5（今天生产在用的也是它）</div></td><td>{audio("L-" + v)}</td><td>{f0_list(s["B15"]["f0"])} Hz</td></tr>
  <tr><td>③ Codex 实时语音新模型<div class="src">引擎 B · gpt-realtime-2.1</div></td><td>{audio("B-" + v)}</td><td>{f0_list(s["B21"]["f0"])} Hz</td></tr>
  <tr><td>④ GPT Live<div class="src">引擎 A · gpt-live-1</div></td><td>{audio("A-" + v)}</td><td>{f0_list(s["A"]["f0"])} Hz</td></tr>
 </table>
</div>"""


page = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lead 声线实测</title>
<style>
:root{{--bg:#f5f5f7;--card:#fff;--ink:#1d1d1f;--dim:#86868b;--red:#ff3b30;--amber:#ff9500;--blue:#007aff;--green:#34c759;--purple:#af52de;--navy:#1a365d;--line:#e5e5ea}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,system-ui,sans-serif}}
.wrap{{max-width:960px;margin:0 auto;padding:24px 16px 64px}}
h1{{font-size:24px;margin:0 0 4px;color:var(--navy)}}
.sub{{color:var(--dim);font-size:13px;margin-bottom:20px}}
.section{{margin:28px 0 12px}}
.section-title{{font-size:18px;font-weight:600;margin-bottom:10px}}
.card{{background:var(--card);border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:16px 18px;margin:12px 0;border-left:4px solid var(--line)}}
.card.red{{border-left-color:var(--red)}}.card.amber{{border-left-color:var(--amber)}}.card.blue{{border-left-color:var(--blue)}}.card.green{{border-left-color:var(--green)}}.card.purple{{border-left-color:var(--purple)}}
.card-title{{font-weight:600;font-size:16px;margin-bottom:6px}}
.ask{{font-size:15px}} .ask li{{margin:6px 0}}
table{{width:100%;border-collapse:collapse;font-size:14px}}
th{{text-align:left;color:var(--dim);font-weight:500;font-size:12px;border-bottom:1px solid var(--line);padding:6px 6px}}
td{{border-bottom:1px solid var(--line);padding:8px 6px;vertical-align:top}}
td.c{{text-align:center}}
.src{{color:var(--dim);font-size:12px}}
.dim{{color:var(--dim)}}
.mono{{font-family:'SF Mono',ui-monospace,monospace}}
.badge{{display:inline-block;font-size:11px;padding:1px 7px;border-radius:10px;color:#fff;margin-left:4px;white-space:nowrap}}
.badge.amber{{background:var(--amber)}}.badge.purple{{background:var(--purple)}}.badge.green{{background:var(--green)}}
tr.row-change td{{background:#fff8ec}}
audio{{width:100%;min-width:190px;max-width:230px;height:32px}}
.cmp td:nth-child(2){{min-width:200px}}
.scroll{{overflow-x:auto}}
.att{{font-size:12px;background:#eef5ff;color:var(--blue);padding:2px 8px;border-radius:8px;white-space:nowrap}}
.kpi{{display:flex;gap:10px;flex-wrap:wrap}}
.kpi div{{flex:1 1 200px;background:var(--card);border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:12px 14px}}
.kpi b{{display:block;font-size:20px;color:var(--navy)}}
.note{{font-size:13px;color:#3a3a3c}}
@media (max-width:640px){{.hide-sm{{display:none}} td,th{{padding:6px 4px}}}}
</style></head><body><div class="wrap">
<h1>Lead 声线：实测结果，写配置前请你定两件事</h1>
<div class="sub">FLY-2866 · 2026-09-24 · 同一句「Annie 你好，我是 Tadashi，现在有两件事要你看。」，每个声线都录了</div>

<div class="card red">
 <div class="card-title">你要做的（两件事，每件回一句就行）</div>
 <ol class="ask">
  <li><b>听一下 verse 的对比（下面第一块）。它还给 Tadashi 吗？</b><br>
  新模型上的 verse 音调比你 8 月听的那段<b>高了一截</b>（你听的是 138 Hz，GPT Live 上是 156–188 Hz）。你当时说它是「有活力的中年男声」，现在可能更年轻、更亮。回「照旧 verse」或者换成另一个男声都可以。</li>
  <li><b>另外 14 位 Lead 先都保持 marin，可以吗？</b><br>
  PRD 只给 3 位定了声线。其余 14 位按这张单子的要求先不动，还是 marin（女声）。但你定过一条规则：<b>男性 Lead 用男声</b>。Simba、Hiro、Mufasa、Rafiki、Triton 这 5 位原型都是男性角色，现在都是女声。<br>
  回「先保持」，我就只改 Tadashi 和 Honey Lemon 两个人。回「按规则配」，我按你那张性格表给这 5 位各挑一个男声，发你确认后再写。</li>
 </ol>
 <div class="note">你回复之前，配置一个字都不改。</div>
</div>

<div class="section"><div class="section-title">结论</div>
<div class="kpi">
 <div><b>10 / 10</b>PRD 里的 10 个声线在 GPT Live 和 Codex 实时语音上都能用</div>
 <div><b>2 位要改</b>Tadashi → verse，Honey Lemon → alloy；Raya 本来就是 marin，不用动</div>
 <div><b>要等部署</b>Bridge 只在启动时读一次声线，改完要等定时部署（00:00 / 12:00）才生效，不会为这个单独重启</div>
</div>
<div class="card blue" style="margin-top:12px">
 <div class="card-title">你问：「当时是不是用 Realtime 的声线测的？」</div>
 是的。你 8-21 听的 10 段样本，是 Codex 实时语音 V2 通道录的（FLY-1911 <span class="mono">voices/</span>）。我今天用同一个老模型 <span class="mono">gpt-realtime-1.5</span> 把 10 个声线重录了一遍，音高都跟当时对得上（比如 verse 138 → 133 Hz，alloy 145 → 151 Hz）。<br>
 换到新模型以后：<b>alloy、marin 基本没变</b>。alloy 本来就低，125–152 Hz，你当时说它是「低沉」的女声，这次也在那个范围里。<b>verse、echo、ballad 在新模型上都高了 20–40 Hz</b>，其余几个差得不多。verse 是分给 Tadashi 的，所以请你重点听它。
</div>
</div>

<div class="section"><div class="section-title">verse 和 alloy：新旧对比（请戴耳机听）</div>
{'<div class="note">这个网页放不了音频，试听片段在同一条 Discord 消息的附件里，文件名和下表一一对应。</div>' if ATTACH else ''}
{cmp_block("verse", "verse · Tadashi 的声线（新模型上音调偏高，请对比 ① 和 ④）")}
{cmp_block("alloy", "alloy · Honey Lemon 的声线（跟当时差不多）")}
</div>

<div class="section"><div class="section-title">17 位 Lead 的声线清单 <span class="dim">（写配置时只改「声线」这一项）</span></div>
<div class="card"><div class="scroll"><table>
<tr><th>Lead</th><th>人设</th><th>PRD 定的声线 <span class="dim">(FLY-1850)</span></th><th>打算写成</th></tr>
{''.join(lead_rows)}
</table></div>
<div class="note" style="margin-top:8px">现在 17 位全是 marin。出处都在 <span class="mono">product/doc/FLY-1850-headphone-voice-relay/prd.md</span>：分配表在 2441–2458 行，「男性 Lead 用男声」这条规则在 2063–2076 行。「人设」一栏是从各 Lead 的 agent 定义里查的。</div>
</div></div>

<div class="section"><div class="section-title">10 个声线逐个试听</div>
<div class="card"><div class="scroll"><table>
<tr><th>声线</th><th class="c">GPT Live<br>能用</th><th class="c">Codex 实时<br>能用</th><th>GPT Live（引擎 A）</th><th>Codex 实时 2.1（引擎 B）</th><th class="c">你当时那段<br>音高 Hz</th></tr>
{''.join(voice_rows)}
</table></div>
<div class="note" style="margin-top:8px">音高：男声一般在 85–155 Hz，女声一般在 165–255 Hz，数越低听起来越沉。字/秒：普通话聊天大约是 4–5 字/秒。一个声线录了几次就有几个数。</div>
</div></div>

<div class="section"><div class="section-title">写之前你该知道的三件事</div>
<div class="card amber"><div class="card-title">① GPT Live（引擎 A）目前不按 Lead 分声线</div>
FLY-2798 分支上的 GPT Live 只用一个统一声线（默认 marin），不读这份配置。所以这次配置写进去以后，<b>今天在跑的旧语音链路</b>会按 Lead 换声线，但切到 GPT Live 之后要等 FLY-2863 / 2797 把这份配置接上，才会分开。</div>
<div class="card amber"><div class="card-title">② GPT Live 偶尔会出问题，跟声线无关</div>
GPT Live 一共录了 31 次，其中 1 次整段没出声（ballad）。第一轮我在它静音 3 秒后就断开，有 2 次句尾被截掉（coral、echo）。看起来是它说到一半停顿超过 3 秒，被我断早了；改成等 6 秒以后，21 次都没再截。Codex 实时语音一共录了 23 次，都完整。这两点会写进交付记录，给 FLY-2798 参考。</div>
<div class="card"><div class="card-title">③ 这页的「听感」怎么来的</div>
<div class="note">说男声还是女声，我是拿各声线的音高跟你当时亲耳听的 10 段比出来的。「中文念得对不对」是用另一个语音识别模型把录音转回文字，只核对中文部分：两个引擎基本都一字不差。「Annie」「Tadashi」两个名字识别出来五花八门（安妮、田中……），这是识别模型的问题，所以不算错。我也试过让 AI 直接「听」每段录音描述声音，但它把 marin、coral、sage、shimmer 这些明显的女声都判成了男声，结果不能用，已经作废。最终<b>好不好听、像不像这个人</b>，还是要你来判断。</div></div>
</div>

<div class="sub" style="margin-top:28px">实测脚本和原始记录：<span class="mono">engineering/doc/FLY-2866-lead-voice-assignment/</span>。实测只是合成语音，没有接真实房间。配置写入和测试房验证在你回复之后做。</div>
</div></body></html>
"""
out.write_text(page)
print(out, len(page.encode()) // 1024, "KB")
