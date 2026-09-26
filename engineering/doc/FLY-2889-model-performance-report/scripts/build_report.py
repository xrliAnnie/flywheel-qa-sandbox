#!/usr/bin/env python3
"""FLY-2889: render ../report.html from ../data/metrics.json.

Every number in a table comes from metrics.json (or data/*.csv); the prose
around the tables only restates those numbers. Comment boxes + "copy all
comments" follow the founder-design pattern used in earlier FLY docs.
"""
import csv
import datetime as dt
import html
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
OUT = os.path.join(HERE, "..", "report.html")
PDT = dt.timezone(dt.timedelta(hours=-7))

M = json.load(open(os.path.join(DATA, "metrics.json")))
QUOTA = list(csv.DictReader(open(os.path.join(DATA, "quota_status.csv"))))

LABEL = {
    "codex/gpt-6-astra/xhigh": "GPT-6 Astra · xhigh",
    "codex/gpt-6-astra/high": "GPT-6 Astra · high",
    "codex/gpt-6-astra/medium": "GPT-6 Astra · medium",
    "codex/gpt-5.6-sol/xhigh": "GPT-5.6 Sol · xhigh",
    "codex/gpt-5.6-sol/high": "GPT-5.6 Sol · high",
    "claude/claude-fable-5-1/high": "Fable 5.1 · high",
    "claude/claude-opus-5-5/high": "Opus 5.5 · high",
    "claude/claude-opus-5-5/xhigh": "Opus 5.5 · xhigh",
    "claude/claude-opus-5/high": "Opus 5 · high",
    "mixed": "混合（同一片段换过模型）",
}
ORDER = {
    "eng_design": ["codex/gpt-6-astra/xhigh", "codex/gpt-6-astra/high", "claude/claude-fable-5-1/high",
                   "claude/claude-opus-5-5/high"],
    "implement": ["codex/gpt-5.6-sol/xhigh", "codex/gpt-6-astra/medium", "claude/claude-opus-5-5/xhigh",
                  "claude/claude-fable-5-1/high", "claude/claude-opus-5/high"],
    "qa": ["claude/claude-opus-5/high", "claude/claude-opus-5-5/high", "codex/gpt-5.6-sol/high"],
    "general": ["claude/claude-opus-5/high", "claude/claude-opus-5-5/high"],
}
E = html.escape


def lab(m):
    return LABEL.get(m, m)


def pdt(iso):
    t = dt.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return t.astimezone(PDT).strftime("%m-%d %H:%M PDT")


def ratio(r):
    if not r or r.get("den") in (None, 0):
        return '<span class="na">无样本</span>'
    s = f'{r["num"]}/{r["den"]}'
    iss = f'，{r["issues"]} 张单' if r.get("issues") is not None and r["issues"] != r["den"] else ""
    if r.get("too_few"):
        return f'{s}<span class="few">样本太少{iss}</span>'
    return f'<b>{round(100 * r["num"] / r["den"])}%</b> <span class="dim">({s}{iss})</span>'


def hours(d):
    if not d or not d.get("n"):
        return '<span class="na">无样本</span>'
    if d.get("too_few"):
        vals = "、".join(f"{v:.1f}" for v in d.get("values", []))
        return f'<span class="few">样本太少</span> <span class="dim">{vals} h</span>'
    return f'<b>{d["median"]:.1f} h</b> <span class="dim">P90 {d["p90"]:.1f} · n={d["n"]}</span>'


def mtok(d):
    if not d or not d.get("n"):
        return '<span class="na">无样本</span>'
    if d.get("too_few"):
        vals = "、".join(f"{v / 1e6:.0f}M" for v in d.get("values", []))
        return f'<span class="few">样本太少</span> <span class="dim">{vals}</span>'
    return f'<b>{d["median"] / 1e6:.0f}M</b> <span class="dim">P90 {d["p90"] / 1e6:.0f}M · n={d["n"]}</span>'


def pct_range(pair):
    if not pair or not pair[0].get("n"):
        return '<span class="na">—</span>'
    lo, hi = pair[0], pair[1]
    if lo.get("too_few"):
        return '<span class="few">样本太少</span>'
    return f'{lo["median"]:.1f}–{hi["median"]:.1f}%'


def get(seg, node, model):
    return M.get(seg, {}).get(node, {}).get(model, {})


def speed(node, model, key="first_attempt_net_h_first_run"):
    return M["speed_O"].get(node, {}).get(model, {}).get(key)


def cbox(key, title):
    return (f'<div class="cbox"><label>对这一节的意见</label><textarea data-key="{key}" '
            f'data-title="{E(title)}" placeholder="写在这里，自动保存在本机浏览器"></textarea></div>')


def table(head, rows, cls="tbl"):
    h = "".join(f"<th>{c}</th>" for c in head)
    body = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows)
    return f'<div class="scroll"><table class="{cls}"><thead><tr>{h}</tr></thead><tbody>{body}</tbody></table></div>'


def section(num, key, title, inner, color="navy"):
    return (f'<section class="card {color}" id="{key}"><h2><span class="num">{num}</span>{E(title)}</h2>'
            f'{inner}{cbox(key, title)}</section>')


# ------------------------------------------------------------------ data bits
fr = M["freeze"]
quota = M["quota"]
val = quota["validation"]
eff = M["effective_routing_since_new_rule"]


def eff_counts(node):
    auto, manual, none_ = {}, 0, 0
    for k, v in eff.get(node, {}).items():
        route, model = [x.strip() for x in k.split("|")]
        if route == "auto_arm":
            auto[model] = auto.get(model, 0) + v
        elif route == "lead_menu_override":
            manual += v
        else:
            none_ += v
    return auto, manual, none_


def eff_line(node):
    auto, manual, none_ = eff_counts(node)
    total = sum(auto.values()) + manual + none_
    per_model = {}
    for k, v in eff.get(node, {}).items():
        model = k.split("|")[1].strip()
        per_model[model] = per_model.get(model, 0) + v
    mix = "、".join(f"{lab(m)} {v}" for m, v in sorted(per_model.items(), key=lambda kv: -kv[1]))
    autos = "、".join(f"{lab(m)} {v}" for m, v in auto.items())
    return total, mix, autos, manual, none_


# ------------------------------------------------------------------ sections
parts = []

# 0. TL;DR + decision
t_impl = eff_line("implement")
t_qa = eff_line("qa")
t_des = eff_line("eng_design")
per = M["implement_qa_first_pass_by_period"]
p3 = per.get("09-21~09-25", {})
p1 = per.get("09-08~09-15", {})

decision_rows = [
    ["设计", "Astra / Opus 5.5 / Fable 各 1/3",
     f"{t_des[0]} 个片段：{t_des[1]}（其中 Lead 手动指定 {t_des[3]}）",
     "<b>不调</b>，保持各 1/3",
     "三者正确度拿不到可比数据（评审路径不同）；下游结果在准随机的奇偶分流期互有胜负；Astra 最快、作者 token 最少，但它的设计由 Claude 审，挪过去会把评审负担转到同样紧的 Claude 池。"],
    ["实现", "Opus 5.5 50% / Sol 5.6 50%",
     f"{t_impl[0]} 个片段：{t_impl[1]}（按分组自动跑的只有 {sum(eff_counts('implement')[0].values())} 个；Lead 手动指定 {t_impl[3]}，run 没有新路由快照 {t_impl[4]}）",
     "<b>Opus 5.5 60% / Sol 5.6 40%</b>",
     f"同一时段（09-21~25）QA 首过：Opus 5.5 {ratio(p3.get('claude/claude-opus-5-5/xhigh'))}，Sol {ratio(p3.get('codex/gpt-5.6-sol/xhigh'))}；Sol 片段被系统判死/换体的比例高得多。差距不够大、两边样本都是条件样本，所以只挪 10 个点，并保留 Sol 继续积累数据。"],
    ["QA", "Sol 5.6 75% / Opus 5.5 25%",
     f"{t_qa[0]} 个片段：{t_qa[1]}（按分组自动跑的 {sum(eff_counts('qa')[0].values())} 个；Lead 手动 {t_qa[3]}，无新路由快照 {t_qa[4]}）",
     "<b>Opus 5.5 50% / Sol 5.6 50%</b>",
     "Sol 做 QA 至今只有 4 个片段、3 个判决，而且 4 个全撞上系统故障——没有证据支持它占 75%；Codex 池这几天只剩 school，先让给实现。50% 保证下周每天仍有足够的 Sol QA 样本可评。"],
    ["general", "不在分流里，固定 Opus 5.5", "—", "不调", "无正确度事实可评（没有评审/QA 环节）。"],
]

qa_by = {(r["vendor"], r["account"]): r for r in QUOTA}
cl_personal = qa_by.get(("claude", "personal"), {}).get("weekly_used_pct", "?")
cl_business = qa_by.get(("claude", "business"), {}).get("weekly_used_pct", "?")
cx_school = qa_by.get(("codex", "school"), {}).get("weekly_used_pct", "?")
op55_des = get("O_all", "eng_design", "claude/claude-opus-5-5/high").get("tokens_total", {})
op55_des_txt = ("、".join(f"{v / 1e6:.0f}M" for v in op55_des.get("values", []))
                if op55_des.get("too_few") else f"{op55_des.get('median', 0) / 1e6:.0f}M")

# ---------------------------------------------------------------- grading
GRADE_TAG = {"best": "▲ 最好", "mid": "● 中间", "worst": "▼ 最差", "tie": "＝ 持平", "na": "— 不参与比较"}
LEGEND = ('<div class="legend">颜色：<span class="g best">▲ 最好</span>同一列最好 '
          '<span class="g mid">● 中间</span> '
          '<span class="g worst">▼ 最差</span>同一列最差 '
          '<span class="g tie">＝ 持平</span>差距太小（比率差 ≤5 个百分点、时长/次数差 ≤10%） '
          '<span class="g na">— 不参与比较</span>样本太少或没有可比对象。没有颜色的列不做比较，原因写在表下。</div>')


def C(h, v=None, ok=False):
    """A table cell: html, numeric value for grading, and whether it may be graded."""
    return {"h": h, "v": v, "ok": ok}


def rc(r):
    if not r or not r.get("den"):
        return C('<span class="na">拿不到</span>')
    return C(ratio(r), r["num"] / r["den"], not r.get("too_few"))


def hc(d):
    if not d or not d.get("n"):
        return C('<span class="na">无样本</span>')
    return C(hours(d), d.get("median"), not d.get("too_few"))


def graded_table(head, rows, spec, groups=None, legend=True):
    """spec: {col: (direction, mode, tol)}; direction "hi" = higher is better.
    Values within tol of the best (worst) count as best (worst); spread within tol = tie.
    groups: optional group key per row; grading happens inside each group only."""
    groups = groups or [0] * len(rows)
    for col, (direction, mode, tol) in spec.items():
        for gk in set(groups):
            members = [r for r, g in zip(rows, groups) if g == gk]
            vals = [r[col]["v"] for r in members if r[col]["ok"] and r[col]["v"] is not None]
            if not vals:
                for r in members:
                    if r[col]["v"] is not None:
                        r[col]["g"] = "na"
                continue
            best = max(vals) if direction == "hi" else min(vals)
            worst = min(vals) if direction == "hi" else max(vals)

            def close(x, y):
                return abs(x - y) <= (tol if mode == "abs" else tol * max(abs(y), 1e-9))
            for r in members:
                cell = r[col]
                if cell["v"] is None:
                    continue
                if not cell["ok"] or len(vals) < 2:
                    cell["g"] = "na"
                elif close(best, worst):
                    cell["g"] = "tie"
                elif close(cell["v"], best):
                    cell["g"] = "best"
                elif close(cell["v"], worst):
                    cell["g"] = "worst"
                else:
                    cell["g"] = "mid"
    h = "".join(f"<th>{c}</th>" for c in head)
    body = ""
    for r in rows:
        tds = ""
        for cell in r:
            g = cell.get("g")
            if g:
                tds += f'<td class="c-{g}">{cell["h"]}<span class="g {g}">{GRADE_TAG[g]}</span></td>'
            else:
                tds += f'<td>{cell["h"]}</td>'
        body += f"<tr>{tds}</tr>"
    return ((LEGEND if legend else "") + f'<div class="scroll"><table class="tbl"><thead><tr>{h}</tr></thead>'
            f'<tbody>{body}</tbody></table></div>')


RATE = ("hi", "abs", 0.05)      # rates: within 5 percentage points = same
RATE_LO = ("lo", "abs", 0.05)
TIME = ("lo", "rel", 0.10)      # hours / rounds / per-episode counts: within 10% = same


# ---------------------------------------------------------------- 0. per model
def v_(node, m):
    return get("O_all", node, m)


A_X, A_H, A_M = "codex/gpt-6-astra/xhigh", "codex/gpt-6-astra/high", "codex/gpt-6-astra/medium"
SOL_I, SOL_Q = "codex/gpt-5.6-sol/xhigh", "codex/gpt-5.6-sol/high"
O55_D, O55_I, O55_Q = "claude/claude-opus-5-5/high", "claude/claude-opus-5-5/xhigh", "claude/claude-opus-5-5/high"
FAB = "claude/claude-fable-5-1/high"
O5 = "claude/claude-opus-5/high"


def runs_txt(pairs):
    return "<br>".join(f"{name} <b>{v_(node, m).get('episodes', 0)}</b> 次"
                       f"<span class='dim'>（{v_(node, m).get('issues', 0)} 张单）</span>"
                       for name, node, m in pairs if v_(node, m))


def spd(node, m):
    d = speed(node, m)
    if not d or not d.get("n"):
        return "无样本"
    if d.get("too_few"):
        return "样本太少"
    return f"{d['median']:.1f} h"


def tok(node, m):
    d = v_(node, m).get("tokens_total") or {}
    if not d.get("n"):
        return "无样本"
    if d.get("too_few"):
        return "样本太少"
    return f"{d['median'] / 1e6:.0f}M token"


def rt(r):
    if not r or not r.get("den"):
        return "拿不到"
    if r.get("too_few"):
        return f"{r['num']}/{r['den']}（样本太少）"
    return f"{round(100 * r['num'] / r['den'])}%（{r['num']}/{r['den']}）"


def dfa(m):
    return v_("eng_design", m).get("design_first_approved[codex_author/cross_family]")


MODEL_ROWS = [
    {"name": "GPT-6 Astra", "state": ("good", "速度、花费最好；质量证据有分歧"),
     "runs": runs_txt([("设计 xhigh", "eng_design", A_X), ("设计 high", "eng_design", A_H),
                       ("实现 medium", "implement", A_M)]),
     "correct": f"设计评审首轮通过：xhigh {rt(dfa(A_X))}、high {rt(dfa(A_H))}，中位 2 轮（由 Claude 审）<br>"
                f"实现 QA 首过 {rt(v_('implement', A_M).get('qa_first_pass'))}——比 Sol、Opus 5.5 都高，但只跑在 09-09~16（Fable 8/9 更高，但只有 9 个）",
     "speed": f"设计 {spd('eng_design', A_X)}（xhigh）/ {spd('eng_design', A_H)}（high），最快<br>实现 {spd('implement', A_M)}",
     "cost": f"设计 {tok('eng_design', A_H)} ≈ pro 号周额度 {pct_range(v_('eng_design', A_H).get('codex_pct_scenario_by_total'))}<br>"
             f"实现 {tok('implement', A_M)} ≈ {pct_range(v_('implement', A_M).get('codex_pct_scenario_by_total'))}",
     "ratio": "设计 33% → <b>33%（不调）</b><br>实现 / QA：不在当前分流里"},
    {"name": "GPT-5.6 Sol", "state": ("bad", "实现偏弱、系统故障最多；做 QA 没有证据"),
     "runs": runs_txt([("实现 xhigh", "implement", SOL_I), ("QA high", "qa", SOL_Q)]),
     "correct": f"实现 QA 首过 {rt(v_('implement', SOL_I).get('qa_first_pass'))}；同时段（09-21~25）"
                f"{rt(p3.get(SOL_I))}，四个模型里最低<br>QA：只有 {v_('qa', SOL_Q).get('verdicts', {}).get('pass', 0) + v_('qa', SOL_Q).get('verdicts', {}).get('fail', 0)} 个判决，全撞上系统故障",
     "speed": f"实现 {spd('implement', SOL_I)}，最慢<br>QA {spd('qa', SOL_Q)}",
     "cost": f"实现 {tok('implement', SOL_I)} ≈ pro 号周额度 {pct_range(v_('implement', SOL_I).get('codex_pct_scenario_by_total'))}<br>"
             f"实现片段 {v_('implement', SOL_I).get('noisy_episodes')}/{v_('implement', SOL_I).get('episodes')} 撞上判死 / 换体",
     "ratio": "实现 50% → <b>40%</b><br>QA 75% → <b>50%</b>"},
    {"name": "Opus 5.5", "state": ("mid", "中等、稳定；实现同时段比 Sol 好一些"),
     "runs": runs_txt([("设计 high", "eng_design", O55_D), ("实现 xhigh", "implement", O55_I),
                       ("QA high", "qa", O55_Q), ("general high", "general", O55_Q)]),
     "correct": f"实现 QA 首过 {rt(v_('implement', O55_I).get('qa_first_pass'))}（同时段 Sol 为 {rt(p3.get(SOL_I))}）<br>"
                f"QA 通过后同一 commit 被你打回 {rt(v_('qa', O55_Q).get('pass_then_founder_rework_same_head'))}<br>设计评审轮数拿不到",
     "speed": f"设计 {spd('eng_design', O55_D)}<br>实现 {spd('implement', O55_I)}<br>QA {spd('qa', O55_Q)}",
     "cost": f"实现 {tok('implement', O55_I)}，QA {tok('qa', O55_Q)}（Claude token）<br>占周额度百分比拿不到",
     "ratio": "设计 33% → <b>33%</b><br>实现 50% → <b>60%</b><br>QA 25% → <b>50%</b>"},
    {"name": "Fable 5.1", "state": ("mid", "设计最慢；实现样本少但结果好"),
     "runs": runs_txt([("设计 high", "eng_design", FAB), ("实现 high", "implement", FAB)]),
     "correct": f"设计评审轮数拿不到；奇偶分流期下游 QA 首过 "
                f"{rt(M['downstream_by_design_model'].get('L:fly2403-v1(50/50)', {}).get(FAB, {}).get('qa_first_pass'))}<br>"
                f"实现 QA 首过 {rt(v_('implement', FAB).get('qa_first_pass'))}（只在 09-21~25）",
     "speed": f"设计 {spd('eng_design', FAB)}，最慢<br>实现 {spd('implement', FAB)}",
     "cost": f"设计 {tok('eng_design', FAB)}（Claude token）<br>占周额度百分比拿不到",
     "ratio": "设计 33% → <b>33%（不调）</b><br>实现：不在当前分流里"},
    {"name": "Opus 5（已换代，参考）", "state": ("na", "历史基准，已由 Opus 5.5 取代"),
     "runs": runs_txt([("QA high", "qa", O5), ("实现 high", "implement", O5), ("general high", "general", O5)]),
     "correct": f"QA 通过后同一 commit 被你打回 {rt(v_('qa', O5).get('pass_then_founder_rework_same_head'))}<br>"
                f"不通过后被 Lead 改判 {rt(v_('qa', O5).get('fail_then_lead_override'))}",
     "speed": f"QA {spd('qa', O5)}<br>general {spd('general', O5)}",
     "cost": f"QA {tok('qa', O5)}（Claude token）",
     "ratio": "已不参与分配"},
]
STATE_TAG = {"good": "▲", "mid": "●", "bad": "▼", "na": "—"}

mhead = ["模型 · 整体状态", "各节点跑了几次", "正确度", "速度（中位，首个 run）", "花费（作者，中位）", "建议比例（现 → 改）"]
mrows = ""
mcards = ""
for r in MODEL_ROWS:
    st, stxt = r["state"]
    badge = f'<span class="g {"best" if st == "good" else "worst" if st == "bad" else st}">{STATE_TAG[st]} {stxt}</span>'
    mrows += (f'<tr><td><b>{r["name"]}</b><div class="stbadge">{badge}</div></td><td>{r["runs"]}</td>'
              f'<td>{r["correct"]}</td><td>{r["speed"]}</td><td>{r["cost"]}</td><td>{r["ratio"]}</td></tr>')
    mcards += (f'<div class="mcard"><div class="mhead"><b>{r["name"]}</b> {badge}</div><ul>'
               f'<li><b>跑了几次</b>：{r["runs"].replace("<br>", "；")}</li>'
               f'<li><b>正确度</b>：{r["correct"].replace("<br>", "；")}</li>'
               f'<li><b>速度</b>：{r["speed"].replace("<br>", "；")}</li>'
               f'<li><b>花费</b>：{r["cost"].replace("<br>", "；")}</li>'
               f'<li><b>建议比例</b>：{r["ratio"].replace("<br>", "；")}</li></ul></div>')
model_table = (f'<div class="desk"><div class="scroll"><table class="tbl mtbl"><thead><tr>'
               + "".join(f"<th>{c}</th>" for c in mhead) + f'</tr></thead><tbody>{mrows}</tbody></table></div></div>'
               f'<div class="mob">{mcards}</div>')

tldr = f"""
<div class="tldr">
<p class="big">一句话：<b>没有哪个模型好到值得大调</b>。要处理的是两件事：① 过去 21 小时实际跑的比例和配置不一样（实现 {t_impl[0]} 个片段里 {sum(v for k, v in eff.get('implement', {}).items() if 'opus-5-5' in k)} 个、QA {t_qa[0]} 个里 {sum(v for k, v in eff.get('qa', {}).items() if 'opus-5-5' in k)} 个跑在 Opus 5.5 上）；② 两个额度池都很紧（{pdt(fr['t1'])}：Claude 只剩 personal，{cl_personal}% 已用；Codex 只剩 school，{cx_school}% 已用）。</p>
</div>
<h3>按模型看</h3>
<p class="note">「跑了几次」= 单 × 节点 × run 的片段数。速度扣掉了等你 / 等 Lead 的阻塞提问和重启空窗。Claude 与 Codex 的 token 不能直接比。整体状态：<span class="g best">▲ 好</span> <span class="g mid">● 中等</span> <span class="g worst">▼ 偏弱 / 有问题</span> <span class="g na">— 仅参考</span></p>
{model_table}
<h3>按角色看：配置 → 建议</h3>
{table(["角色", "现在的配置", "过去 21 小时实际跑的", "建议", "为什么"], decision_rows)}
<p class="note">你要做的只有一件事：回一句「按建议改」或「改成 X」。Lead 改 <code>~/.flywheel/models.json</code> 里对应节点的 weight（一行一个数），不重启、下一张新单生效；已开始的单保留原分组。随时可以改回。<br>另外建议：分流期间尽量<b>不要用手动指定替代自动分组</b>；如果是因为 Codex 号池打满，走 FLY-2788 已有的「号池权威耗尽 → 实现自动降级」通道，降级样本会被单独记账，统计才不会被污染。<br>过去 21 小时实际跑的比例里，按分组自动跑的只有 {sum(eff_counts('implement')[0].values())} / {sum(eff_counts('qa')[0].values())} 个（实现 / QA），其余是 Lead 通过菜单手动指定（{t_impl[3]} / {t_qa[3]}）或 run 根本没有新路由快照（{t_impl[4]} / {t_qa[4]}，多为同一张单的重派 run，原因待查）。</p>
"""
parts.append(section(0, "s0", "结论与建议比例", tldr, "green"))

# 1. what the data can / cannot say
seg = M["segment_counts"]
honest = f"""
<ul>
<li><b>窗口</b>：{pdt(fr['w0'])}（第一条设计分组记录）到 {pdt(fr['t1'])}；全部 workflow 单的 eng_design / implement / qa / general 节点，共 {M['counts']['episodes']} 个「单 × 节点 × run」片段、{M['counts']['runs']} 个 run。</li>
<li><b>三层数据，不能相加、不能互相印证</b>：
 <ul>
 <li><b>新分流层</b>（09-24 16:15 PDT 起，按单号+节点稳定哈希分组）：只有 {seg.get('R_new', 0)} 个片段。这是唯一按设计分组的一层，太少，不下结论。</li>
 <li><b>旧设计分流层</b>（只管设计节点，Astra vs Fable）：奇偶 50/50 期 {seg.get('L:fly2403-v1(50/50)', 0)} 个片段，Astra 75% 期 {seg.get('L:fly2570-v1(astra=75%)', 0)} 个，其余 100%/0% 期是确定性分配，只作观察。</li>
 <li><b>观察层</b>（全部片段按实际模型）：实现/QA 的模型是按日期整体切换的（例：09-09~16 实现几乎全是 Astra medium，09-16 以后是 Sol，09-24 以后大多是 Opus 5.5），和当时的单子难度、系统故障期混在一起。</li>
 </ul></li>
<li><b>评审路径不对称</b>：Codex 写的（Astra 设计、Sol/Astra 实现）由 Claude 审，每轮 verdict 在库里；Claude 写的设计由 runner 自己调 Codex 审，轮数只在已清理的 worktree 里，所以<b>拿不到</b>。Claude 写的实现，本窗大多是 Claude 同家族应急审。所以「首轮通过率」是流程结果，不是作者模型的固有正确率，跨评审家族不排名。</li>
<li><b>「QA 通过后被 founder 打回」</b>只按同一个 commit 关联（QA 判的 head = founder 判 rework 的 head）。它包含你改需求的情况，也可能漏掉你没发现的问题，<b>不能解释为 QA 错误率</b>。</li>
<li><b>样本门槛</b>按独立单数：少于 5 张单标「样本太少」，只列原值不排序。同一张单被重派多次只算一张单。</li>
</ul>
"""
parts.append(section(1, "s1", "先说清楚：这些数字能说明什么、不能说明什么", honest, "amber"))

# 2. design
rows = []
for m in ORDER["eng_design"]:
    v = get("O_all", "eng_design", m)
    if not v:
        continue
    st = "codex_author/cross_family"
    fa = v.get(f"design_first_approved[{st}]")
    rd = v.get(f"design_rounds_to_approve[{st}]")
    rows.append([C(lab(m)), C(f'{v["episodes"]} / {v["issues"]}'),
                 rc(fa),
                 (C(f'{rd["median"]:.0f} 轮 <span class="dim">P90 {rd["p90"]:.0f}</span>', rd["median"], not rd.get("too_few"))
                  if rd and rd.get("n") else C('<span class="na">拿不到</span>')),
                 hc(speed("eng_design", m)), C(mtok(v.get("tokens_total"))),
                 C(pct_range(v.get("codex_pct_scenario_by_total")) if m.startswith("codex") else '<span class="na">拿不到</span>')])
design_tbl = graded_table(["模型", "片段 / 单", "设计评审首轮 APPROVED", "到通过的轮数（中位）",
                           "速度 首个 run（中位）", "作者 token（中位）", "≈ pro 号周额度（假设）"],
                          rows, {2: RATE, 3: TIME, 4: TIME})
down = M["downstream_by_design_model"].get("L:fly2403-v1(50/50)", {})
drows = []
for m in ("codex/gpt-6-astra/xhigh", "claude/claude-fable-5-1/high"):
    v = down.get(m)
    if v:
        drows.append([C(lab(m)), C(str(v["implement_episodes"])), rc(v["qa_first_pass"]),
                      rc(v["code_first_approved_bridge"])])
design = f"""
<p>设计评审的逐轮记录只有 Astra 有（Claude 审）。Fable / Opus 5.5 的设计由 runner 自己调 Codex 审，轮数写在 worktree 回执里，worktree 大多已清理，<b>拿不到</b>（设计评审 manifest 的版本号不是轮数：实测版本 1 里跑了 7 轮）。</p>
{design_tbl}
<p class="note">不着色的列：作者 token（Claude 与 Codex 不可比）、≈ 周额度（假设值，不用于排序）。</p>
<h3>下游结果（旧奇偶分流期：设计模型按单号奇偶分，和当天用哪个实现模型无关）</h3>
{graded_table(["设计模型", "下游实现片段", "实现的 QA 首过", "实现的代码复审首轮通过"], drows, {2: RATE, 3: RATE})}
<p class="note">读法：Fable 设计的单，下游 QA 首过更高；Astra 设计的单，下游代码复审首轮通过更高。两个方向相反、样本各二十来张，<b>不足以判断谁的设计更好</b>。</p>
<p class="note">速度：Astra 明显更快（设计节点约 0.7–0.8 h vs Fable 1.4 h）。花费：Astra 作者约 1,500 万 token，Fable 约 2,700 万、Opus 5.5 样本太少（{op55_des_txt}）；Claude 与 Codex 的 token 不能直接比。评审方的用量不在作者文件里，没算进去。</p>
"""
parts.append(section(2, "s2", "设计节点", design))

# 3. implement
rows = []
for m in ORDER["implement"]:
    v = get("O_all", "implement", m)
    if not v:
        continue
    cr = []
    for key, name in (("codex_author/cross_family", "Claude 审"), ("claude_author/same_family", "Claude 同家族审")):
        r = v.get(f"code_first_approved[{key}]")
        if r:
            cr.append(f"{ratio(r)} <span class='dim'>{name}</span>")
    sr = [k for k in v if k.startswith("code_self_reported_rounds")]
    if sr:
        d = v[sr[0]]
        cr.append(f"<span class='dim'>自报轮数中位 {d['median']:.0f}（n={d['n']}，Codex 审）</span>")
    clean = get("O_clean", "implement", m).get("qa_first_pass")
    qfp = v.get("qa_first_pass") or {}
    per_ep = (v.get("qa_fail_total", 0) / qfp["den"]) if qfp.get("den") else None
    nz = v["noisy_episodes"] / v["episodes"] if v["episodes"] else None
    rows.append([C(lab(m)), C(f'{v["episodes"]} / {v["issues"]}'), C("<br>".join(cr) or '<span class="na">—</span>'),
                 rc(qfp), rc(clean) if clean else C("—"),
                 C(f'{v.get("qa_fail_total", 0)} 次 <span class="dim">平均 {per_ep:.2f} 次/片段</span>' if per_ep is not None else "—",
                   per_ep, per_ep is not None and v["issues"] >= 5),
                 C(f'{v["noisy_episodes"]}/{v["episodes"]} <span class="dim">({round(100 * nz)}%)</span>', nz, v["issues"] >= 5),
                 hc(speed("implement", m)), C(mtok(v.get("tokens_total"))),
                 C(pct_range(v.get("codex_pct_scenario_by_total")) if m.startswith("codex") else '<span class="na">拿不到</span>')])
impl_tbl = graded_table(["模型", "片段 / 单", "代码复审首轮通过", "QA 首过（全部）", "QA 首过（剔除噪声）",
                         "被 QA 打回", "系统噪声片段", "速度 首个 run", "作者 token（中位）", "≈ pro 号周额度（假设）"],
                        rows, {3: RATE, 4: RATE, 5: TIME, 6: RATE_LO, 7: TIME})
prow = []
for label, v in per.items():
    for m in ORDER["implement"]:
        if m in v:
            prow.append((label, [C(label), C(lab(m)), rc(v[m])]))
# one table, graded within each period only
ptables = graded_table(["时段", "实现模型", "QA 首过"], [r for _, r in prow], {2: RATE},
                       groups=[l for l, _ in prow])
impl = f"""
{impl_tbl}
<p class="note">不着色的列：代码复审首轮通过（Codex 写的由 Claude 审、Claude 写的多为 Claude 同家族审，评审方不同不排名）、作者 token（跨厂商不可比）、≈ 周额度（假设值）。「被 QA 打回」按每个已到 QA 的片段平均次数比较。</p>
<h3>同一时段内比较（把时间混杂压小一点；颜色只在同一时段内比）</h3>
{ptables}
<p class="note">读法：09-21~25 这一段四个模型同时在跑，Sol 的 QA 首过最低；但 Sol 在这段有大量同单重派（53 个片段只来自 21 张单），且系统故障集中在 Codex 会话上。09-08~15 的 Astra medium 首过率最高，可它只跑在那一周，那周的单子和 QA 口径都不同。</p>
<p class="note">速度用「每张单该节点的首个 run」：重派的 run 往往接着前一个 run 的分支干，很快就完，会把重派多的模型显得很快（Opus 5.5 全部 attempt 中位 0.4 h，首个 run 中位 3.5 h）。花费里 Codex 实现一次约 5,000–6,000 万 token，98% 左右是缓存读。</p>
"""
parts.append(section(3, "s3", "实现节点", impl))

# 4. QA
rows = []
for m in ORDER["qa"]:
    v = get("O_all", "qa", m)
    if not v:
        continue
    vd = v.get("verdicts", {})
    pf = rc(v.get("pass_then_founder_rework_same_head"))
    pf["h"] += f'<br><span class="dim">另 {v.get("pass_not_yet_founder_judged", 0)} 个通过还没到你手上</span>'
    rows.append([C(lab(m)), C(f'{v["episodes"]} / {v["issues"]}'),
                 C(f'<span style="white-space:nowrap">{vd.get("pass", 0)} / {vd.get("fail", 0)}</span>'),
                 pf, rc(v.get("pass_then_land_rework")), rc(v.get("fail_then_lead_override")),
                 hc(speed("qa", m)), C(mtok(v.get("tokens_total"))),
                 C(pct_range(v.get("codex_pct_scenario_by_total")) if m.startswith("codex") else '<span class="na">拿不到</span>')])
qa = f"""
{graded_table(["模型", "片段 / 单", "通过 / 不通过", "通过后同一 commit 被 founder 打回", "通过后合并/CI 被引擎打回（参考）", "不通过后被 Lead 改判", "速度 首个 run", "作者 token（中位）", "≈ pro 号周额度（假设）"], rows, {3: RATE_LO, 4: RATE_LO, 5: RATE_LO, 6: TIME})}
<p class="note">不着色的列：作者 token（跨厂商不可比）、≈ 周额度（假设值）。「被 founder 打回」越低越好，但它含改需求，不能当 QA 错误率。</p>
<p class="note">读法：Opus 5 做 QA 的历史最长，通过的单约 17% 在同一个 commit 上被你打回（含改需求）；Opus 5.5 是 4/17。Sol 5.6 做 QA 只有 4 个片段、3 个判决，而且 4 个片段都遇到了执行被判死 / 换体——<b>对 Sol 做 QA 的能力目前没有任何可用证据</b>。「不通过被 Lead 改判」几乎没有发生（1 次）。</p>
"""
parts.append(section(4, "s4", "QA 节点", qa))

# 5. general
rows = []
for m in ORDER["general"]:
    v = get("O_all", "general", m)
    if v:
        rows.append([lab(m), f'{v["episodes"]} / {v["issues"]}', '<span class="na">无适用正确度事实</span>',
                     hours(speed("general", m)), mtok(v.get("tokens_total"))])
parts.append(section(5, "s5", "general 节点（不在分流里）",
                     table(["模型", "片段 / 单", "正确度", "速度 首个 run", "作者 token（中位）"], rows)))

# 6. quota
qrows = []
for r in sorted(QUOTA, key=lambda r: (r["vendor"], r["account"])):
    if r["vendor"] == "claude" and r["account"] == "personal1":
        continue  # stale reading (last observed 09-08)
    reset = pdt(r["weekly_reset_at"].replace("+00:00", "Z")) if r["weekly_reset_at"] else "—"
    qrows.append([r["vendor"].capitalize(), r["account"] + (" <span class='badge'>在用</span>" if r["active"] == "True" else ""),
                  r["plan"] or "—", f'{r["weekly_used_pct"]}%', reset, pdt(r["observed_at"])])
fps = quota["codex_fingerprints_used"]
frows = [[f["account"], f["plan"], pdt(f["first"]), pdt(f["last"]), f'{float(f["delta_pct"]):.0f}',
          f'{int(f["tokens_total"]) / 1e8:.1f} 亿', f'{100 / float(f["pct_per_100M_total_tokens"]):.0f}M',
          f'{1 / float(f["pct_per_1M_uncached_plus_output"]):.2f}M'] for f in fps]
quota_html = f"""
{table(["池", "账号", "档位", "周已用", "周重置", "读数时间"], qrows)}
<p class="note">Claude 的 personal1 读数停在 09-08，未列。Claude 这边每张单占百分之几<b>拿不到</b>：执行记录里没有「跑在哪个号」，而且你自己的交互和网页端用量不可见。</p>
<h3>Codex：「每 1% 周额度 ≈ 多少 token」——假设系数，账号归属未验证，不用于排序</h3>
{table(["假设账号", "档位", "起", "止", "Δ百分点", "同期 rollout token", "每 1% ≈ 总 token", "每 1% ≈ 非缓存+输出"], frows)}
<p class="note">做法：Codex 每条用量事件带当时的周用量百分比和重置时间；按重置时间分桶，桶内从起点到第一次到达最高读数，除以同期全部 rollout 的 token 增量。当前账号表里恰有一个号的重置时间与桶吻合，只作旁证。偏差：看不到该号在本机 rollout 之外的用量，百分比是整数。<br>
按这个系数，上面表里的「≈ pro 号周额度」= 作者 token × 系数，取三个 pro 桶的最小–最大。<b>一个 pro 号在满负荷下 20–31 小时就从 0 用到 100%</b>。</p>
<p class="note">本单的 Codex 设计评审（4 轮，gpt-6-astra，按 Lead 要求中档 effort）用了约 {1932566 / 1e6:.1f}M token（其中 181 万是缓存读），按上表系数约为 school 周额度的 0.1–0.3%；评审期间 school 读数从 31% 走到 32%（同期全系统都在用）。</p>
"""
parts.append(section(6, "s6", "额度现状与换算", quota_html, "purple"))

# 7. noise
nrows = []
for node in ("eng_design", "implement", "qa"):
    for m in ORDER[node]:
        v = get("O_all", node, m)
        if not v:
            continue
        reasons = v.get("noise_reasons", {})
        top = "、".join(f"{k} {n}" for k, n in list(reasons.items())[:3]) or "—"
        nrows.append([{"eng_design": "设计", "implement": "实现", "qa": "QA"}[node], lab(m),
                      f'{v["noisy_episodes"]}/{v["episodes"]}', top])
spd = M["speed_O"]
noise = f"""
<p>片段只要出现过：执行被判死回滚、resume 失败、换体、同节点多个执行、启动后回滚，就记为「系统噪声样本」。主表用全部样本，「剔除噪声」只作对照（剔掉的正是某些模型更容易撞上的故障，剔完反而可能美化它）。</p>
{table(["节点", "模型", "噪声片段", "主要原因（片段数）"], nrows)}
<p class="note">实现节点的 Codex 会话被判死 / 换体特别多（Sol 约 60%、Astra medium 约 62% 的片段），Claude 实现明显少。这更像是运行设施的问题（Codex 会话被重启误杀、换体），而不是模型本身写得差；但它确实让 Codex 实现更慢、更费。<br>
速度扣除：阻塞提问等待共扣 {sum(v['deducted_question_h'] for n in spd.values() for v in n.values()):.0f} 小时，重启空窗共扣 {sum(v['deducted_restart_gap_h'] for n in spd.values() for v in n.values()):.0f} 小时。额度暂停：库里的两张暂停表都是 0 行，无已记录的可扣暂停（不代表没有过额度等待）。进程死掉到被发现之间的时间扣不掉，所以噪声片段仍偏慢。</p>
"""
parts.append(section(7, "s7", "噪声：系统故障样本", noise, "red"))

# 8. delivery
drows = []
for m, v in sorted(M["delivery_by_impl_model"].items(), key=lambda kv: -kv[1]["runs"]):
    drows.append([lab(m) if m != "no_implement" else "无实现节点（general / PRD 等）", v["runs"], hours(v["net_h"]),
                  hours(v["net_h_clean"]), hours(v["wall_h"]), hours(v["founder_gate_h"])])
deliv = f"""
{table(["实现模型", "成功 run", "净时长（扣你审批+阻塞等待+重启空窗）", "净时长（剔除噪声）", "原始墙钟", "在你那里等审批"], drows)}
<p class="note">只统计截至 T1 已走完的 run（run 创建 → 合并完成），按 run 计，不含同一张单之前失败的 run，所以是「成功者的条件描述」，不是每张单的真实总投入。「在你那里等审批」的结束点用你的正式判决时间；没有判决时间的等待段不扣（本窗 {M['delivery_gate_segments_not_deducted']} 段）。</p>
"""
parts.append(section(8, "s8", "每次成功交付的总时长", deliv))

# 9. method
method = f"""
<ul>
<li>数据全部只读取自生产 teamlead.db（单个只读快照）、各项目 CommDB、Claude transcript 与 Codex rollout；T1 = {pdt(fr['t1'])}。没有改任何配置、没有跑测试。</li>
<li>速度：每个 attempt 从它的第一次激活到它的完成；只扣该 attempt 内发起的阻塞提问（等你 / 等 Lead）和「被判死 → 换体上岗」的空窗。评审往复不扣（两家族都有）。中位数 + P90。</li>
<li>花费：逐个执行定位它自己的 transcript / rollout（Claude {quota['locate_counts'].get('claude:prompt_snapshot', 0)} 个按启动快照精确匹配、{quota['locate_counts'].get('claude:early_loose', 0)} 个早期文件只算候选；Codex {quota['locate_counts'].get('codex:state_thread', 0)} 个按线程 id 匹配，{quota['locate_counts'].get('codex:missing:no_state', 0)} 个找不到文件——多数是启动一分钟内就失败的）。只称「已观测作者用量（主会话）」，不是执行总成本；子代理与评审方用量另算、未计入。</li>
<li>方法校验：和 FLY-2789 计分表（它从同一批文件导入）逐执行比对 {val['executions_compared']} 个，{val['exact_equal']} 个完全相等。</li>
<li>方法经 Codex 设计评审 4 轮通过（gpt-6-astra），主要收窄：累计计数必须差分、文件定位≠用量完整、重置时间匹配≠账号已验证、gate 结束时间只用正式判决时间、QA 信号不叫「判决被推翻」。</li>
<li>原始脚本与导出数据：<code>engineering/doc/FLY-2889-model-performance-report/scripts/</code>、<code>data/</code>（只含 id、模型、时间、计数，不含消息正文和凭据）。</li>
</ul>
<h3>还不知道的</h3>
<ul>
<li>Claude 每单占周额度的百分比；评审方（reviewer）的用量；Fable / Opus 设计的评审轮数。</li>
<li>新分流层的真实优劣：需要让自动分组不被手动覆盖，跑满约一周、每组 ≥20 张单再看。</li>
<li>为什么新分流生效后有 {eff_counts('implement')[2]} 个实现片段、{eff_counts('qa')[2]} 个 QA 片段所在的 run 根本没有新路由快照（多为同一张单的重派 run）：值得单独查一下是不是重派入口绕过了分流。</li>
</ul>
"""
parts.append(section(9, "s9", "方法、出处与不确定性", method, "blue"))

# ------------------------------------------------------------------ page
CSS = """
:root{--bg:#f5f5f7;--card:#fff;--text:#1d1d1f;--dim:#86868b;--line:#e5e5ea;--red:#ff3b30;--amber:#ff9500;--blue:#007aff;--green:#34c759;--purple:#af52de;--navy:#1a365d}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.65 -apple-system,system-ui,"PingFang SC","Hiragino Sans GB",sans-serif}
.wrap{max-width:960px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:24px;line-height:1.3;margin:0 0 6px;color:var(--navy)}
h2{font-size:19px;margin:0 0 10px;color:var(--navy)}
h3{font-size:15px;margin:16px 0 6px;color:var(--navy)}
.sub{color:var(--dim);font-size:13px}
.card{background:var(--card);border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:16px;margin:16px 0;border-left:4px solid var(--line)}
.card.red{border-left-color:var(--red)}.card.amber{border-left-color:var(--amber)}.card.blue{border-left-color:var(--blue)}.card.green{border-left-color:var(--green)}.card.purple{border-left-color:var(--purple)}.card.navy{border-left-color:var(--navy)}
.num{display:inline-block;min-width:26px;height:26px;border-radius:13px;background:var(--navy);color:#fff;font-size:13px;text-align:center;line-height:26px;margin-right:8px;vertical-align:2px}
.tldr p.big{font-size:16px;margin:4px 0 8px}
.tldr li{margin:4px 0}
ul{padding-left:20px;margin:6px 0}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:8px 0}
.tbl{width:100%;border-collapse:collapse;font-size:13.5px}
.tbl th,.tbl td{text-align:left;vertical-align:top;padding:7px 6px;border-top:1px solid var(--line)}
.tbl th{font-size:12px;color:var(--dim);font-weight:600;border-top:none;white-space:nowrap}
.tbl td:first-child{white-space:nowrap;font-weight:600}
.dim{color:var(--dim);font-size:12px}
.few{display:inline-block;background:#fff7e8;color:#a35a00;font-size:11.5px;font-weight:600;padding:1px 6px;border-radius:8px;margin-left:4px}
.na{color:var(--dim)}
.note{color:#3a3a3c;font-size:13.5px;margin:8px 0}
.badge{display:inline-block;font-size:11px;padding:1px 6px;border-radius:8px;background:var(--navy);color:#fff;vertical-align:1px}
code{font-family:"SF Mono",ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all}
.cbox{margin-top:14px;padding-top:12px;border-top:1px dashed var(--line)}
.cbox label{display:block;font-size:12px;color:var(--dim);margin-bottom:4px}
.cbox textarea{width:100%;min-height:60px;border:1px solid #d2d2d7;border-radius:8px;padding:8px 10px;font:inherit;font-size:14px;resize:vertical;background:#fbfbfd}
.cbox textarea:focus{outline:none;border-color:var(--blue);background:#fff}
.summary-box{white-space:pre-wrap;font-family:"SF Mono",Menlo,monospace;font-size:12.5px;background:#f2f2f5;border-radius:8px;padding:12px;min-height:60px;max-height:360px;overflow:auto}
.btn{display:inline-block;background:var(--blue);color:#fff;border:none;border-radius:8px;padding:8px 14px;font:inherit;font-size:14px;cursor:pointer;margin:6px 8px 6px 0}
.btn.sec{background:#e5e5ea;color:#1d1d1f}
.status{font-size:13px;color:#1d7a3d;min-height:20px}
@media (max-width:640px){.tbl{font-size:12.5px}h1{font-size:21px}}
.legend{font-size:12px;color:var(--dim);margin:6px 0 2px;line-height:2}
.g{display:inline-block;font-size:11.5px;font-weight:600;padding:1px 7px;border-radius:8px;margin:0 4px 0 6px;white-space:nowrap;vertical-align:1px}
.g.best{background:#e3f6e8;color:#1e7d32}.g.mid{background:#fff3dd;color:#a35a00}.g.worst{background:#ffe5e3;color:#c4271d}.g.na,.g.tie{background:#eeeef1;color:#5a5a5e}
td.c-best{background:#f3fbf5}td.c-mid{background:#fffaf0}td.c-worst{background:#fff5f4}
.mtbl td{font-size:13px}.mtbl td:first-child{white-space:normal;min-width:130px}.mtbl td:nth-child(2){min-width:120px}.mtbl td:nth-child(3){min-width:230px}.mtbl td:nth-child(4){min-width:110px}.mtbl td:nth-child(5){min-width:150px}.mtbl td:nth-child(6){min-width:110px}.stbadge{margin-top:6px}.stbadge .g{margin-left:0;white-space:normal}
.mob{display:none}
.mcard{border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:10px 0}
.mcard ul{margin:6px 0 0}.mcard li{margin:3px 0;font-size:13.5px}
@media (max-width:640px){.desk{display:none}.mob{display:block}}

"""

script = open(os.path.join(HERE, "comment_script.js")).read()
page = f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>模型表现报告</title>
<style>{CSS}</style>
</head>
<body>
<div class="wrap">
<h1>模型表现报告：设计 / 实现 / QA 各模型的正确度、速度、花费</h1>
<div class="sub">FLY-2889 · 数据截至 {pdt(fr['t1'])} · 只读分析，没有改任何配置 · 每节下面可以写意见，最底下一键复制全部</div>
{''.join(parts)}
<section class="card green">
<h2>意见汇总（复制后贴回给我）</h2>
<p class="note">下面实时汇总上面每一节里写的意见，首行固定是标记 <code>【页面意见汇总】FLY-2889</code>。超过约 1800 字会自动分段，每段都带标记。</p>
<button class="btn" id="copy-all" type="button">复制全部评论</button>
<button class="btn sec" id="clear-all" type="button">清空本机保存的意见</button>
<div class="status" id="copy-status"></div>
<div id="summary-chunks"></div>
</section>
</div>
<script nonce="__CSP_NONCE__">
{script}
</script>
</body>
</html>
"""
with open(OUT, "w") as fh:
    fh.write(page)
print(f"wrote {OUT} ({len(page)} bytes)")
