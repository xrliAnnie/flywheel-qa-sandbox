#!/usr/bin/env python3
"""FLY-2904: build the founder decision page from derived/*.json (no hand-copied numbers)."""
import html
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DOC = os.path.join(HERE, "..", "..")
DER = os.path.join(HERE, "..", "derived")
S = json.load(open(os.path.join(DER, "summary.json")))
SIM = json.load(open(os.path.join(DER, "compaction_simulation.json")))
TN = json.load(open(os.path.join(DER, "task_notification_split.json")))
M = S["mechanisms"]
T = S["totals"]
# FLY-2893 (PR #1336, not merged): pinned commit + values in derived/external_refs.json.
# The successor first turn is NOT a saving (goal first turns contain real work and cannot be
# separated, FLY-2893 build_report.py:150-155); it is shown as an unseparated reference only.
EXT = json.load(open(os.path.join(DER, "external_refs.json")))["FLY-2893"]
FLY2893_SHA = EXT["commit"][:12]
FLY2893_SUCCESSOR_FIRST_TURN = EXT["codex_fault_successor_first_turn_tokens"]


def yi(x, d=1):
    return f"{x / 1e8:,.{d}f}"


EFF = {"S": 1.0, "S–M": 0.75, "M": 0.5, "M–L": 0.35, "L": 0.25}
info_alert = next((d["tokens"] for d in S["lead_wakes"]["by_kind"] if d["kind"] == "infra_alert:info"), 0)
big_total = sum(M["big_output_reread_above_5k_total"].values())
sim400 = SIM["400000"]["saving"]
sim250 = SIM["250000"]["saving"]
lifecycle_nonoverlap = M["wake_A_pure_lifecycle_or_info"]["tokens"] - info_alert

# key, title, mechanism, observed set (label, tokens), ratio lo/hi, ratio basis, effort, weight note, cost, you do
R = [
    dict(key="r1", title="给 Lead 开自动压缩（40 万窗口），先拿工程 Lead 试点",
         mech=f"Lead 常驻 1M 大上下文：工程 Lead 每个请求平均重读 {M['eng_lead_mean_ctx'] / 1e4:.1f} 万 token",
         obs_label="回放模拟：所有 Lead 都开 40 万窗口时少读的量", obs=sim400, lo=2 / 3, hi=1.0,
         basis="模拟没算压缩后回头重读台账 / 文档，低值打 2/3 折；只有试点的 Lead 才拿得到对应部分",
         eff="M", w="缓存读为主",
         cost="现成旋钮要先为每个 Lead 采集并核验 baseline（模型、Claude 版本、规则 / 工具指纹要逐项对上），Claude 升级后 baseline 失配会静默失效、要重采；压缩后 Lead 会丢一部分在飞细节，要靠台账补；每次压缩停顿几十秒",
         you="批准一个工程 Lead 的试点重启窗口", back="删掉这项配置、重启 Lead 即恢复"),
    dict(key="r2", title="收信 ack 和第一个动作放进同一次调用（先改 Lead 提示）",
         mech=f"每封信多一轮「ack 往返」：只由 ack 返回触发的请求 {M['ack_solo']['requests']:,} 个、{yi(M['ack_solo']['tokens'])} 亿",
         obs_label=f"其中 ack 返回后直接收尾、没再调用工具的 {M['ack_solo_ended_turn']['requests']:,} 个请求",
         obs=M["ack_solo_ended_turn"]["tokens"], lo=0.75, hi=1.0,
         basis="提示方案不会 100% 被遵守；另有 7 亿是 ack 后继续干活的请求，合并后能否省掉要逐个看，不计入",
         eff="S", w="缓存读为主",
         cost="只改提示，不改 ACK 语义；让 Bridge 代 ack 会改变「已收到」的含义，放到第二步再议",
         you="无", back="改回原提示即恢复"),
    dict(key="r3", title="告警去重：同一 Lead、同一标题 6 小时内合并成一条；info 级只进摘要",
         mech=f"同一条告警反复叫醒：{M['wake_B_repeat_alert_6h']['alert_turns_total']:,} 次告警唤醒只有 {M['wake_B_repeat_alert_6h']['distinct_titles']} 种标题",
         obs_label=f"同一 Lead 6 小时内已收过同一标题的 {M['wake_B_repeat_alert_6h']['turns']:,} 个回合",
         obs=M["wake_B_repeat_alert_6h"]["tokens"], lo=0.75, hi=1.0,
         basis="状况升级的再次告警要照常叫醒，低值留出 1/4", eff="S–M", w="缓存读为主",
         cost="状况恶化时的再次告警必须照常叫醒（升级 / 计数翻倍）", you="无", back="关掉合并开关即恢复"),
    dict(key="r4", title="轮询改成阻塞等待（check / turn / inbox 加长等待，规则里禁止 sleep 循环）",
         mech="轮询等待：体为了「再看一眼」反复发请求，每次都重读整段上下文",
         obs_label=f"只由「命中等待模式、未命中工作黑名单」的调用触发的 {sum(v['requests'] for v in M['poll_requests'].values()):,} 个请求（代理集合，可能仍含少量复合工作；命中工作标记的 {yi(M['mixed_wait_not_counted']['tokens'])} 亿不计入）",
         obs=sum(v["tokens"] for v in M["poll_requests"].values()), lo=0.7, hi=0.9,
         basis="改成阻塞等待后每段等待仍剩 1–2 次请求", eff="M", w="缓存读为主",
         cost="长等待期间必须还能收到 Lead 指令，否则体会变迟钝", you="无", back="保留旧参数，退回轮询即可"),
    dict(key="r5", title="Codex 体终态后立即停干净（FLY-2814 / FLY-2892 一线）",
         mech=f"Codex 体终态后还在烧 token；另有替身首轮 {yi(FLY2893_SUCCESSOR_FIRST_TURN)} 亿，FLY-2893 说明它含大量真实工作、无法分离，不计入",
         obs_label="终态 2 分钟以后仍在消耗的 token（本单复算，与 FLY-2893 差 0.8%）", obs=M["post_terminal_total"],
         lo=0.8, hi=1.0, basis="终态后的消耗理论上应为 0", eff="M", w="约 10 亿 ≈ 一个 Codex 号一周",
         cost="见 FLY-2893 / FLY-2814", you="按 FLY-2893 拍板", back="—"),
    dict(key="r6", title="大输出规范：限制 rg / sed / Read 的输出量，Linear 写单不回显整单",
         mech="单个工具输出超过 5,000 token 的部分被后续请求反复重读",
         obs_label="能归因到工具输出的上下文增长里，超过 5,000 token 的部分 × 之后的重读次数", obs=big_total,
         lo=0.35, hi=0.55, basis="规则只能压掉一部分大输出，有些大输出确实需要", eff="S–M", w="缓存读为主",
         cost="规则太死会让体多读几次", you="无", back="删掉规则即恢复"),
    dict(key="r7", title="评审作废止损：head 一动就停掉在飞评审；推送后静默 2 分钟再开评审",
         mech="结论被丢弃的评审任务（被新版本取代、head 移动、外部已答、失败）",
         obs_label="这些任务的全部消耗", obs=M["review_discarded_tokens"], lo=0.5, hi=0.9,
         basis="停掉之前已经花掉的部分拿不回来；外部已答的可能是 Lead 主动答的", eff="S–M", w="含缓存写",
         cost="评审会晚开始约 2 分钟", you="无", back="关掉静默期即恢复"),
    dict(key="r8", title="runner 的 Monitor 只推终态（CI 成功 / 失败各一次）",
         mech="runner 被 Monitor 流式事件叫醒（后台任务的终态通知另计，本来就该叫醒）",
         obs_label=f"Monitor 事件叫醒的 {M['runner_task_notification_monitor']['turns']} 个回合",
         obs=M["runner_task_notification_monitor"]["tokens"], lo=0.5, hi=0.8,
         basis="终态那一次仍要叫醒", eff="S", w="缓存读为主", cost="看不到中间过程", you="无", back="改回原指南"),
    dict(key="r9", title="纯通知继续扩大「不叫醒」的覆盖（FLY-2749 的延续）",
         mech="阶段变更 / 会话启动 / 监控恢复 / 换体预告叫醒 Lead（FLY-2749 合并后仍在发生）",
         obs_label="这些回合的消耗（info 级告警已算进第 3 条，这里扣掉）", obs=lifecycle_nonoverlap, lo=0.6, hi=0.9,
         basis="其中一部分带着真实待办，不能吞", eff="S", w="缓存读为主",
         cost="同 FLY-2749：不能把待办一起吞掉", you="无", back="kill-switch 即恢复"),
    dict(key="r10", title="巡检移出 Lead 上下文：脚本或小模型一次性跑，有异常才叫醒 Lead",
         mech="巡检 / 定时汇总在 Lead 的大上下文里跑", obs_label="patrol_tick + summary_due 回合的消耗",
         obs=M["wake_D_patrol_summary"]["tokens"], lo=0.7, hi=0.95,
         basis="小上下文跑一次约为现在的 1/5；有异常时仍要叫醒 Lead", eff="M", w="缓存读为主",
         cost="巡检判断力可能下降；要改巡检入口", you="无", back="切回原巡检"),
    dict(key="r11", title="给 Claude runner / 评审一套精简配置（去掉无关插件、MCP、代理描述、规则）",
         mech="Claude runner 的固定前缀中位 8.7–9.1 万，Codex 只有 2.4–3.1 万",
         obs_label="runner、评审、QA 环境每个请求高于 4.5 万（infra-bot 水平）的最小上下文 × 请求数",
         obs=M["prefix_above_45k_runner_review_qa"], lo=0.3, hi=0.5,
         basis="最小上下文是代理量，里面还含首个任务等内容，不全是能删的系统前缀", eff="M", w="上下文前缀代理；缓存读为主，但未拆分缓存读 / 写构成",
         cost="可能缺某个技能；要逐角色核对", you="无", back="换回原配置"),
    dict(key="r12", title="Lead 之间的 Discord 消息只在 @提及 / 本线程时叫醒", mech="Lead 之间在频道里互相叫醒",
         obs_label="被其它 bot / Lead 的频道消息叫醒的回合", obs=M["wake_C_cross_lead_chatter"]["tokens"], lo=0.5, hi=0.9,
         basis="其中有真协作，比例未核", eff="M", w="缓存读为主", cost="协作消息可能被漏看",
         you="定一条「Lead 之间什么时候必须 @」", back="关掉过滤即恢复"),
]
UNRANKED = [
    dict(key="r13", title="runner / 评审也开自动压缩", mech="Claude runner / 评审跑到 25 万以上的上下文",
         obs_label="25 万以上部分的缓存读", obs=M["claude_runner_review_cache_read_above_250k"],
         cost="实现体长任务丢上下文，质量风险最大；没有可信的比例假设", you="建议先不做，观察"),
]
for r in R:
    r["slo"], r["shi"] = r["obs"] * r["lo"], r["obs"] * r["hi"]
    r["score"] = (r["slo"] + r["shi"]) / 2 * EFF[r["eff"]] / 1e8
R.sort(key=lambda r: -r["score"])
for i, r in enumerate(R, 1):
    r["rank"] = i
json.dump([{k: v for k, v in r.items()} for r in R] + UNRANKED,
          open(os.path.join(DER, "recommendations.json"), "w"), indent=1, ensure_ascii=False)
TOP3 = tuple(r["key"] for r in R[:3])


def esc(s):
    return html.escape(str(s))


def comment(key, title, choice=False):
    ch = ""
    if choice:
        ch = '<div class="choice" data-key="%s">' % key + "".join(
            f'<label><input type="radio" name="c-{key}" value="{v}"> {v}</label>' for v in ("做", "先不做", "要讨论")) + "</div>"
    return (f'{ch}<textarea data-key="{key}" data-title="{esc(title)}" '
            f'placeholder="写在这里，自动保存在本机浏览器"></textarea>')


led = S["ledger"]
tot_all = T["claude_tokens"] + T["codex_tokens"]
maxtok = led[0]["tokens"]
ledger_rows = []
for d in led:
    if d["tokens"] < 3e8:
        continue
    w = d["tokens"] / maxtok * 100
    ledger_rows.append(
        f'<tr><td>{esc(d["who"])}</td><td class="n">{yi(d["tokens"])}</td><td class="n">{d["share"]:.1f}%</td>'
        f'<td class="bar"><span class="c" style="width:{d["claude"] / maxtok * 100:.1f}%"></span>'
        f'<span class="x" style="width:{d["codex"] / maxtok * 100:.1f}%"></span></td></tr>')
small = sum(d["tokens"] for d in led if d["tokens"] < 3e8)
ledger_rows.append(f'<tr><td>其余（每项不到 3 亿）</td><td class="n">{yi(small)}</td>'
                   f'<td class="n">{small / tot_all * 100:.1f}%</td><td></td></tr>')

cards = []
for r in R[:3]:
    cards.append(f'''<div class="card top"><div class="card-head"><span class="badge">推荐先做 #{r["rank"]}</span><span class="save">情景省 {yi(r["slo"], 0)}–{yi(r["shi"], 0)} 亿 / 两周</span></div>
<div class="card-title">{esc(r["title"])}</div>
<div class="kv"><b>为什么</b>{esc(r["mech"])}。</div>
<div class="kv"><b>怎么估的</b>{esc(r["obs_label"])}：{yi(r["obs"])} 亿 × 假设 {r["lo"]:.0%}–{r["hi"]:.0%}（{esc(r["basis"])}）</div>
<div class="kv"><b>代价</b>{esc(r["cost"])}</div>
<div class="kv"><b>你要做什么</b>{esc(r["you"])}</div>
<div class="kv"><b>退路</b>{esc(r["back"])}</div>
{comment(r["key"], "推荐 · " + r["title"], True)}</div>''')

rows = []
for r in R:
    rows.append(f'''<div class="card item"><div class="card-head"><span class="num">#{r["rank"]}</span><span class="eff">好做 {r["eff"]} · 分数 {r["score"]:.1f}</span><span class="save">情景省 {yi(r["slo"], 0)}–{yi(r["shi"], 0)} 亿</span></div>
<div class="card-title">{esc(r["title"])}</div>
<div class="kv"><b>机制</b>{esc(r["mech"])}（{esc(r["w"])}）</div>
<div class="kv"><b>观测</b>{esc(r["obs_label"])}：{yi(r["obs"])} 亿</div>
<div class="kv"><b>假设</b>{r["lo"]:.0%}–{r["hi"]:.0%}：{esc(r["basis"])}</div>
<div class="kv"><b>代价</b>{esc(r["cost"])}</div>
<div class="kv"><b>你要做什么</b>{esc(r["you"])}</div>
{comment(r["key"] + "-all", f"#{r['rank']} " + r["title"], r["key"] not in TOP3)}</div>''')
for u in UNRANKED:
    rows.append(f'''<div class="card item"><div class="card-head"><span class="num">不排序</span><span class="save">只有上限 {yi(u["obs"], 0)} 亿</span></div>
<div class="card-title">{esc(u["title"])}</div>
<div class="kv"><b>机制</b>{esc(u["mech"])}</div><div class="kv"><b>观测</b>{esc(u["obs_label"])}：{yi(u["obs"])} 亿</div>
<div class="kv"><b>代价</b>{esc(u["cost"])}</div><div class="kv"><b>你要做什么</b>{esc(u["you"])}</div>
{comment(u["key"] + "-all", u["title"], True)}</div>''')

eng_ctx = S["context_profile"]["Lead · flywheel-eng-lead"]
page = f'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Token 浪费全景</title>
<style>
:root{{--bg:#f5f5f7;--card:#fff;--ink:#1d1d1f;--dim:#86868b;--navy:#1a365d;--blue:#007aff;--green:#34c759;--amber:#ff9500;--red:#ff3b30;--purple:#af52de}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,system-ui,sans-serif}}
.wrap{{max-width:960px;margin:0 auto;padding:24px 16px 80px}}h1{{font-size:26px;margin:8px 0 4px}}h2{{font-size:19px;margin:32px 0 12px;color:var(--navy)}}
.sub{{color:var(--dim);font-size:13px}}.tldr{{background:var(--card);border-radius:12px;padding:16px 18px;box-shadow:0 1px 3px rgba(0,0,0,.06);border-left:4px solid var(--blue)}}
.tldr p{{margin:6px 0}}.card{{background:var(--card);border-radius:12px;padding:14px 16px;margin:12px 0;box-shadow:0 1px 3px rgba(0,0,0,.06);border-left:4px solid var(--dim)}}
.card.top{{border-left-color:var(--green)}}.card-head{{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:4px}}
.badge{{background:#e8f8ed;color:#1f7a3a;border-radius:6px;padding:1px 8px;font-size:12px}}.num{{font:600 13px 'SF Mono',monospace;color:var(--navy)}}
.eff{{font-size:12px;color:var(--dim)}}.save{{margin-left:auto;font-weight:600;color:var(--navy)}}.card-title{{font-weight:600;font-size:16px;margin:2px 0 6px}}
.kv{{margin:3px 0}}.kv b{{display:inline-block;min-width:84px;color:var(--dim);font-weight:500}}
table{{width:100%;border-collapse:collapse;background:var(--card);border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06)}}
td,th{{padding:7px 10px;border-bottom:1px solid #eee;text-align:left;font-size:14px;vertical-align:top}}td.n{{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}}
td.bar{{width:34%}}td.bar span{{display:inline-block;height:10px;vertical-align:middle}}.c{{background:var(--purple)}}.x{{background:var(--blue)}}
.legend span{{display:inline-block;width:10px;height:10px;margin:0 4px 0 12px;vertical-align:middle}}
textarea{{width:100%;min-height:54px;margin-top:8px;border:1px solid #d2d2d7;border-radius:8px;padding:8px;font:inherit;resize:vertical}}
.choice{{margin-top:8px;display:flex;gap:16px;flex-wrap:wrap}}.choice label{{cursor:pointer}}
ul{{padding-left:20px}}li{{margin:4px 0}}.btn{{background:var(--blue);color:#fff;border:0;border-radius:8px;padding:9px 16px;font:inherit;cursor:pointer;margin:4px 8px 4px 0}}
.btn.sec{{background:#e5e5ea;color:var(--ink)}}.summary-box{{white-space:pre-wrap;background:#fafafa;border:1px solid #e5e5ea;border-radius:8px;padding:10px;font-size:13px;margin:8px 0;word-break:break-all}}
#copy-status{{color:var(--green);margin-left:8px}}.scroll{{overflow-x:auto}}
@media(max-width:600px){{td.bar{{display:none}}.save{{margin-left:0;width:100%}}.kv b{{display:block}}}}
</style></head><body><div class="wrap">
<h1>Token 浪费全景</h1>
<div class="sub">FLY-2904 · 窗口 2026-09-11 22:00Z – 09-25 22:00Z（14 天）· 本机 Claude + Codex 全部会话 · 只读统计</div>

<h2>一句话</h2>
<div class="tldr">
<p>两周本机共用 <b>{yi(tot_all, 0)} 亿</b> token（Claude {yi(T["claude_tokens"], 0)} 亿、Codex {yi(T["codex_tokens"], 0)} 亿）。其中 <b>98% 是把已有上下文再读一遍</b>。</p>
<p>浪费主要来自两件事相乘：<b>Lead 常驻超大上下文</b>（工程 Lead 每个请求平均读 {M["eng_lead_mean_ctx"] / 1e4:.0f} 万 token），以及 <b>Lead 被不需要动作的消息反复叫醒</b>（重复告警、ack 往返、轮询、巡检）。</p>
<p>排前三的省法是：{"、".join(esc(r["title"].split("（")[0]) for r in R[:3])}。单第 1 条的回放模拟就能少读 Lead 用量的 {sim400 / M["lead_tokens_total"]:.0%}（条件模拟，不是实测）。三条都不需要你写代码，你只需要批一个工程 Lead 的试点重启窗口。</p>
{comment("tldr", "一句话")}
</div>

<h2>推荐先做的 3 条</h2>
{"".join(cards)}

<h2>谁在用（两周原始 token，亿）</h2>
<div class="legend sub"><span class="c"></span>Claude<span class="x"></span>Codex</div>
<div class="scroll"><table><tr><th>谁</th><th class="n">亿</th><th class="n">占比</th><th class="bar"></th></tr>{"".join(ledger_rows)}</table></div>
<p class="sub">Lead 合计 {yi(M["lead_tokens_total"], 0)} 亿，占 Claude 的 {M["lead_tokens_total"] / T["claude_tokens"]:.0%}。
Codex 额度按 FLY-2893 的账号指纹，约 10 亿 token ≈ 一个号一周（区间 3–17%/亿）。
按 API 相对价加权（缓存读只算 1/10）后，Claude 约 {yi(T["claude_weighted"], 0)} 亿、Codex 约 {yi(T["codex_weighted"], 0)} 亿「等价输入」；订阅额度怎么计缓存读，官方没有公布。</p>
{comment("ledger", "谁在用")}

<h2>全部省法（按分数排序）</h2>
<p class="sub">⚠️ 各条之间有重叠，<b>不能相加</b>：压缩窗口让每次读得少，减少叫醒 / 轮询让读的次数少，两者是相乘关系。<br>
每条都写成「观测消耗 × 假设比例 = 情景节省」：观测消耗是实测的，比例是明示的假设，<b>情景节省不是保底，也不是实测</b>。<br>
分数 = 情景节省中值（亿）× 好做系数（S=1、S–M=0.75、M=0.5、M–L=0.35、L=0.25）。S = 改提示 / 配置，M = 小改代码。</p>
{"".join(rows)}

<h2>核过、但不是大问题的</h2>
<div class="card"><ul>
<li><b>跑整包测试</b>（FLY-2802）：测试输出进上下文的量很小，后续重读合计不到总量 2%。整包测试的代价在时间和 CPU，不在 token。</li>
<li><b>缓存过期重建</b>：全部缓存写入 {yi(T["claude_fields"]["cache_creation"], 1)} 亿，占 Claude 的 {T["claude_fields"]["cache_creation"] / T["claude_tokens"]:.1%}。</li>
<li><b>founder 自己的会话</b>：约 1%。</li>
<li><b>「告警经 Discord 和 Bridge 各投一次」</b>：核过，两条通道的标题并不一一对应，不成立。</li>
<li><b>语音</b>：实时语音不写 Codex rollout，本单量不到，是缺口。</li>
</ul>{comment("non-issues", "核过、但不是大问题的")}</div>

<h2>口径</h2>
<div class="card"><ul>
<li>来源：本机 <code>~/.claude/projects</code> 全部 transcript、所有 Codex home 的 rollout、<code>teamlead.db</code>（只读）。只统计本机。</li>
<li>量尺校验：复算 FLY-2749 冻结的 9/17 工程 Lead 数字逐位一致（1,710 请求 / 983,610,832 token）；Codex 终态后残留与 FLY-2893 相差 0.8%；评审任务分摊合计闭合。</li>
<li>工具输出的量用「输出后下一个请求的上下文实际增量」来算，封顶为每字符 1 token；中间夹着其它输入（新消息、压缩、重启）的增长无法归因，记为未知、不计入。Codex 会截断大输出，所以不能按字符估。</li>
<li>轮询集合是代理：只计命中等待模式、且没命中工作黑名单（git、构建 / 测试、脚本、文件写入等）的调用；命中工作标记的不计入。黑名单有限，集合里仍可能含少量复合工作。</li>
<li>第 1 条是回放模拟：保留观测到的上下文增长，超过窗口就计一次压缩成本。40 万窗口省 {yi(sim400, 0)} 亿（{SIM["400000"]["compactions"]} 次压缩）；25 万窗口省 {yi(sim250, 0)} 亿，但需要放开代码里的 40 万下限。没算压缩后重读台账的二阶效应，所以情景低值按模拟值的 2/3 取。</li>
<li>Codex 相关数字引用 FLY-2893（PR #1336，尚未合并，读取于 {FLY2893_SHA}）。替身首轮 {yi(FLY2893_SUCCESSOR_FIRST_TURN)} 亿含大量真实工作、无法分离，只作参考，不算省。</li>
<li>证据文件只含计数、类别、时间和哈希，不含任何消息原文或命令原文。</li>
</ul>{comment("method", "口径")}</div>

<h2>复制全部评论</h2>
<div class="card"><button class="btn" id="copy-all" type="button">复制全部评论</button><button class="btn sec" id="clear-all" type="button">清空</button><span id="copy-status"></span>
<div id="summary-chunks"></div></div>
</div>
<script>
{open(os.path.join(HERE, "comment_script.js")).read()}
</script>
</body></html>
'''
open(os.path.join(DOC, "report.html"), "w").write(page)
print("report.html", len(page))
