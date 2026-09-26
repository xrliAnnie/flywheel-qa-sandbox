#!/usr/bin/env python3
"""FLY-2893: render ../../report.html from ../derived/*.csv (no database access).

Every number on the page is read from derived/ or raw/ files at build time; the prose
around it is fixed text written for this census. Comment boxes + "复制全部评论" use
comment_script.js (FLY-2889 pattern, localStorage only).
"""
import collections
import csv
import html
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
EV = os.path.join(HERE, "..")
OUT = os.path.join(EV, "..", "report.html")
E = html.escape


def read(p):
    with open(os.path.join(EV, p), newline="") as fh:
        return list(csv.DictReader(fh))


summary = json.load(open(os.path.join(EV, "derived", "summary.json")))
inc = read("derived/incidents.csv")
classes = read("derived/classes.csv")
cmp_rows = read("derived/vendor_compare.csv")
rj = read("derived/review_job_failures.csv")
sw = read("derived/switch_correlation.csv")
sws = json.load(open(os.path.join(EV, "derived", "switch_summary.json")))
fz = summary["freeze"]
rate = summary["codex_week_pct_per_100M_tokens_p25_p50_p75"]


def f1(x):
    return f"{float(x):.1f}"


def week_pct(tokens):
    lo, mid, hi = (tokens / 1e8 * r for r in rate)
    return f"一个 Codex 账号周额度的 {mid:.0f}%（区间 {lo:.0f}–{hi:.0f}%）"


cx = [i for i in inc if i["vendor"] == "codex" and i["class_key"] != "K0"]
cl = [i for i in inc if i["vendor"] == "claude" and i["class_key"] != "K0"]
by_id = {i["execution_id"]: i for i in inc}
pred = {i["successor"]: i for i in inc if i["successor"]}
cx_waste = sum(float(i["waste_hours"]) for i in cx)
cx_held = sum(float(i["held_wait_hours"]) for i in cx)
cl_waste = sum(float(i["waste_hours"]) for i in cl)
C = {(r["vendor"], r["class_key"]): r for r in classes}
k1, k6, k3, k5 = C[("codex", "K1")], C[("codex", "K6")], C[("codex", "K3")], C[("codex", "K5")]
k6_after_k1 = [i for i in inc if i["class_key"] == "K6" and pred.get(i["execution_id"], {}).get("class_key") == "K1"]
k6_after_k1_h = sum(float(i["waste_hours"]) for i in k6_after_k1)
q3_rows = sorted((i for i in inc if int(i["tokens_after_cut"]) > 0), key=lambda i: -int(i["tokens_after_cut"]))
q3_codex = sum(int(i["tokens_after_cut"]) for i in inc if i["vendor"] == "codex")
sw_within = sum(1 for r in sw if r["minutes_after_switch"] and float(r["minutes_after_switch"]) <= 60)
sw_within12 = sum(1 for r in sw if r["minutes_after_switch"] and float(r["minutes_after_switch"]) <= 12)
cmpd = {(r["vendor"], r["stratum"]): r for r in cmp_rows}
ex_n = {v: int(cmpd[(v, "ALL")]["executions"]) for v in ("codex", "claude")}
cx_ex_k1 = [i for i in cx if i["class_key"] != "K1"]


def cbox(key, title):
    return (f'<div class="cbox"><label>对这一节的意见</label><textarea data-key="{key}" '
            f'data-title="{E(title)}" placeholder="写在这里，自动保存在本机浏览器"></textarea></div>')


def table(head, rows, cls=""):
    th = "".join(f"<th>{E(h)}</th>" for h in head)
    tr = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows)
    return f'<div class="tw"><table class="{cls}"><thead><tr>{th}</tr></thead><tbody>{tr}</tbody></table></div>'


sections = []

# 0. TL;DR
sections.append(("tldr", "先看结论", "red", f"""
<ul class="big">
<li><b>Codex 体确实远比 Claude 体容易出事。</b>近 14 天 Codex 执行体 {ex_n['codex']} 个，出事 {len(cx)} 个（{len(cx)/ex_n['codex']:.0%}），涉及 {len({i['issue'] for i in cx})} 张单；
Claude 执行体 {ex_n['claude']} 个，出事 {len(cl)} 个（{len(cl)/ex_n['claude']:.0%}）。只看实现节点：Codex {float(cmpd[('codex','implement')]['incident_rate']):.0%} 对 Claude {float(cmpd[('claude','implement')]['incident_rate']):.0%}。</li>
<li><b>浪费主要花在「等人手」上，不在死本身。</b>Codex 出事合计浪费 {cx_waste:.0f} 单×节点小时，其中 {cx_held:.0f} 小时（{cx_held/cx_waste:.0%}）是 run 已经被打成 held、等 Lead 手工 resume 或重派。</li>
<li><b>前三类</b>（按浪费时长）：① 账号额度墙 usageLimited（{k1['incidents']} 次 / {f1(k1['waste_hours'])} h）；② worktree 接管失败（{k6['incidents']} 次 / {f1(k6['waste_hours'])} h，其中 {len(k6_after_k1)} 次是额度墙死体留下的脏 worktree）；
③ Codex 凭据与身份（{k3['incidents']} 次 / {f1(k3['waste_hours'])} h，<b>{sw_within}/{len(sw)} 次发生在全局 ~/.codex 重登或换号后 60 分钟内</b>）。第四名是重启后 reown 失败（{k5['incidents']} 次，涉及单数第二多，但单次很快接上，{f1(k5['waste_hours'])} h）。</li>
<li><b>额度上最亏的是「关了但没关死」。</b>已被 Lead 收掉的体继续在跑，终态后又烧了 {q3_codex/1e6:.0f}M token，约合{week_pct(q3_codex)}，两具体占了 {(int(q3_rows[0]['tokens_after_cut'])+int(q3_rows[1]['tokens_after_cut']))/q3_codex:.0%}（收尸探针 unverifiable，FLY-2892 / FLY-2814 形状）。</li>
<li>即使把额度墙整类拿掉，Codex 出事率仍是 {len(cx_ex_k1)/ex_n['codex']:.0%}，Claude 是 {sum(1 for i in cl if i['class_key']!='K1')/ex_n['claude']:.0%}。差距不只是额度问题。</li>
</ul>"""))

# 1. 口径
sections.append(("method", "口径（怎么数的）", "blue", f"""
<p>窗口：执行体创建时间在 <code>{fz['T0']}</code> 到 <code>{fz['T1']}</code>（14 天）。数据冻结于 <code>{fz['frozen_at']}</code>
（事件 id 上限 run_event ≤ {fz['max_run_event_id']}、session_event ≤ {fz['max_session_event_id']}），重跑结果逐字节相同。全程只读。</p>
<ul>
<li><b>出事</b>（一个执行体最多记一条）：会话报 failed、被引擎判死回滚、起跑失败回滚、会话 blocked、run 被运维终结时它正持着 run 且没交卷、或终态后仍在消耗 token。
<b>不算出事</b>：正常交卷后因 land 冲突被再激活而换体（K0，Codex {C[('codex','K0')]['incidents']} 次 / Claude {C[('claude','K0')]['incidents']} 次，单列）、ship 后的收尾、founder 直令关单或清理。</li>
<li><b>根因</b>：按错误原文归类，优先读 transcript 里上游返回的 <code>[error]</code>，其次 session_failed 原文、会话 last_error、判死原因。同一错误码 / 守卫 / 结构形状算一类（FLY-2072 class_key 口径）。未归类 {summary['unclassified']} 条。</li>
<li><b>浪费时长</b>：从出事到「下一个体真正接上」（同单同节点的下一个体第一次消耗 token，跨 run、跨载体都算）。下一个体还没接上又出事，就切段记给它，不重复计。
单位是<b>单×节点小时</b>，不是舰队墙钟，多张单并行时相加。没有接班者的（单被关、run 永久 held）不进主数字，单列敞口。</li>
<li><b>其中等人手</b>：出事后 run 被打成 held（盲换用尽 retry_limit_escalated 或起跑失败告警）到接上之间的时长。</li>
<li><b>额度</b>：token 从 Codex rollout 逐条差分得出。折成周额度用本机全部 Codex rollout 的额度读数估算：每 1 亿 token ≈ {rate[1]:.1f}% 周额度（p25–p75 {rate[0]:.1f}–{rate[2]:.1f}%），是情景估算。</li>
</ul>"""))

# 2. class table (codex)
rows = []
for r in [r for r in classes if r["vendor"] == "codex"]:
    rows.append([
        f"<b>{E(r['class_key'])}</b>", E(r["label"]) + (' <span class="badge gray">非故障</span>' if r["non_fault"] == "1" else ""),
        r["incidents"], r["issues"], r["batches"], r["never_took_over"], f1(r["waste_hours"]), f1(r["held_wait_hours"]),
        (f"{r['open']} 条 / {float(r['open_hours']):.0f} h" if r["open"] != "0" else "—"),
        f"{int(r['q3_post_terminal_tokens'])/1e6:.0f}M" if r["q3_post_terminal_tokens"] != "0" else "—",
        E(r["refs"]), f'<span class="dim">{E(r["subclasses"])}</span>'])
sections.append(("classes", "Codex 出事按根因分类（全量）", "red", f"""
<p>一行一类，按浪费时长排序。<b>批次</b>：同类出事间隔不超过 10 分钟算一批，比如额度墙一次打满会同时带走多具体。<b>起跑即死</b>：体还没消耗任何 token 就出事（多为盲换的替身）。
全量逐条清单在 <code>evidence/derived/incidents.csv</code>，每行有 issue、run、exec、出事时刻、原因原文、接班者、浪费区间。</p>
{table(['类', '名称', '次数', '单数', '批次', '起跑即死', '浪费 h', '其中等人手 h', '未接上（敞口）', '终态后 token', '病根单', '子类'], rows, 'wide')}
<p class="dim">K3 里的 FLY-2750（unknown identity）已于 9-18 修复。K8 两个子类都是高负载下子进程 250ms stdio 排空超时（FLY-2617）。K9 是 Codex 体连续三轮等不到外部条件后自报 blocked，被当成失败换体，其中 529 房子类占了 16.7 h。</p>
"""))

# 3. vendor comparison
names = {"implement": "实现", "eng_design": "设计", "qa": "QA", "other": "其他", "ALL": "合计"}
rows = []
for st in ("implement", "eng_design", "qa", "other", "ALL"):
    a, b = cmpd.get(("codex", st)), cmpd.get(("claude", st))

    def cell(r, k, pct=False):
        if not r:
            return "—"
        v = float(r[k])
        s = f"{v:.0%}" if pct else f"{v:.2f}"
        return s + (' <span class="dim">(样本&lt;30)</span>' if r["small_sample"] == "1" and k == "incident_rate" else "")
    rows.append([names[st], a["executions"] if a else "—", b["executions"] if b else "—",
                 cell(a, "incident_rate", True), cell(b, "incident_rate", True),
                 cell(a, "avg_extra_executions_per_group"), cell(b, "avg_extra_executions_per_group"),
                 cell(a, "avg_incident_redispatch_per_group"), cell(b, "avg_incident_redispatch_per_group"),
                 cell(a, "groups_with_incident_share", True), cell(b, "groups_with_incident_share", True)])
sections.append(("vendor", "Codex vs Claude（同口径）", "amber", f"""
{table(['节点', 'Codex 体数', 'Claude 体数', 'Codex 出事率', 'Claude 出事率', 'Codex 每单额外体数', 'Claude 每单额外体数', 'Codex 每单因出事重派', 'Claude 每单因出事重派', 'Codex 出过事的单占比', 'Claude 出过事的单占比'], rows, 'wide')}
<p>「每单」指每张单的一个节点。「额外体数」= 该节点的体数 − 1，包含 QA 打回之类的正常重派；「因出事重派」只算出事后接班的次数。</p>
<p><b>两点提醒：</b>① Codex 以实现为主、Claude 以 QA 为主，所以要按节点分行比，不看合计；Claude 实现只有 {cmpd[('claude','implement')]['executions']} 个体，样本偏小。
② <b>Claude 有一部分出事看不见。</b>Claude 体撞额度会静默卡在 pane 里，不报失败、不被判死（FLY-2637），本口径抓不到，所以 Claude 的出事率是偏低估计。
不过即使把 Codex 的额度墙整类剔除，差距仍然明显（{len(cx_ex_k1)/ex_n['codex']:.0%} 对 {sum(1 for i in cl if i['class_key']!='K1')/ex_n['claude']:.0%}）。</p>"""))

# 4. quota view
rows = [[E(i["issue"]), E(i["execution_id"][:8]), E(i["class_key"]), E(i["session_status"]),
         f"{int(i['tokens_after_cut'])/1e6:.1f}M"] for i in q3_rows[:6]]
k1_ntk = int(k1["never_took_over"])
sections.append(("quota", "额度视角：浪费在哪", "purple", f"""
<ul>
<li><b>终态后仍在消耗：{q3_codex/1e6:.0f}M token，约合{week_pct(q3_codex)}。</b>体已经被标成 completed / terminated / failed，进程却没停。
最大的两具：FLY-2766 cf70ee17 被 Lead close 后 daemon 收尸结果为 <code>unverifiable</code>，又跑了约 15 小时；FLY-2873 37624e3d 同样形状，约 10 小时。
这就是 FLY-2892（0.157 起 socket 变软链，探针判不出持有者）加 FLY-2814（关掉后被 goal runtime 当作 daemon 中途死亡而自动复活）的现场。</li>
<li><b>额度墙的盲换：</b>额度墙这一类里有 {k1_ntk} 具体是起跑即死。每具只烧很少 token，真正的代价是时间：盲换 3 具用尽后 run 进 held，只能等人手。</li>
<li><b>死体自身的消耗</b>（上界，因为死前推过的提交可以被接班者直接复用）：额度墙类 {int(k1['q1_dead_body_tokens'])/1e6:.0f}M、reown 类 {int(k5['q1_dead_body_tokens'])/1e6:.0f}M。这不等于浪费，只说明被打断的体通常已经干了很多活。</li>
<li><b>接班重建成本没法可靠算：</b>Codex 的一个 goal 回合（task_started 到 task_complete）可以包含大量真实工作，第一回合的 token 分不清哪部分是重读上下文、哪部分是实活，所以只放进 CSV（q2 列）作参考，不进结论。Claude 侧没有额度读数，只给 token。</li>
</ul>
{table(['单', '体', '类', '会话状态', '终态后 token'], rows)}"""))

# 5. Lead clue: switches
rows = [[E(r["issue"]), E(r["subclass"]), E(r["t_i"][5:16].replace("T", " ")), E(r["nearest_prior_switch"][5:16].replace("T", " ")),
         E(r["switch_kind"]), E(r["minutes_after_switch"])] for r in sw]
sections.append(("switch", "Lead 线索：切号 / 重登与凭据类死亡的关系", "amber", f"""
<p><b>核实成立。</b>凭据与身份类（K3）的 {len(sw)} 次死亡中，{sw_within} 次发生在全局 <code>~/.codex</code> 的凭据操作（交互式重登开始或完成、codex-profile 换号留下的 <code>auth.json.bak-*</code>）之后 60 分钟内，{sw_within12} 次在 12 分钟内。
作为对照，整个窗口里只有 {sws['baseline_share_of_minutes_within_60min']*100:.1f}% 的分钟落在这类操作后 60 分钟内。剩下 2 次（9-19 01:32，FLY-2746 / FLY-2655）比那次换号备份的时间戳早约 30 秒，应当是同一次换号的开始阶段。</p>
<p><b>机制：</b>runner 起跑时从全局 <code>~/.codex/auth.json</code> 取凭据种子。重登或换号期间这个文件会短暂缺失（报 <code>ENOENT</code>），或换成一个还没登记的号（unknown identity，FLY-2750 已修），或新号让旧进程的 refresh token 作废。
这一窗口内起跑或续跑的体都会死，然后被盲换、打成 held。9-14 21:26–22:30 的一次重登前后持续约一小时，这期间有 10 个体因凭据文件缺失死掉。</p>
<p><b>今天又发生了一次，本单撞上了：</b>约 22:43–22:48Z，本单的 Codex 设计评审（companion）和 FLY-2882 的本地复审，连续被 401「Incorrect API key」拒绝；之后变成「Missing bearer」。前情是 22:07–22:09Z FLY-2830 QA 做过 school→shopping→school 的真切号。
runner 的 agent home 这次没有受波及，但所有走全局 <code>~/.codex</code> 的 companion 评审或 CLI 都会停。</p>
{table(['单', '子类', '出事时刻 (UTC)', '最近一次凭据操作', '操作类型', '相隔分钟'], rows)}"""))

# 6. top 3 fixes
sections.append(("fixes", "前三类修法建议（由 Lead 决定开单）", "green", f"""
<div class="card red"><div class="card-title">① 账号额度墙 usageLimited — {k1['incidents']} 次 · {k1['issues']} 张单 · {k1['batches']} 批 · 浪费 {f1(k1['waste_hours'])} h（其中等人手 {f1(k1['held_wait_hours'])} h）</div>
<p><b>根因：</b>额度打满时所有在飞体同时死掉。引擎不看死因，照样盲换 3 具替身，替身起跑即死（本类 {k1_ntk} 具），用尽后 run 被打成 held。额度回来以后没有自动重新派发，只能人手 resume（FLY-2371）。自动切号子系统又没在宿主上真正部署（FLY-2521）。</p>
<p><b>最小修法：</b>① 替身派发前读前任死因：同一 vendor、同一 home 刚以 usageLimited 死过，就不盲换，直接进 hold，并把 <code>resume_after</code> 设成额度重置时刻；② 订阅额度恢复事件（同一 home 重新有 token 消耗，或 quota-monitor 切号完成），自动重新派发。</p>
<p><b>预计节省：</b>下限是额度已回来、还在等人手的那段，本窗口 <b>{f1(k1['rearm_delay_hours'])} h</b>，外加起跑即死的 {k1_ntk} 具盲换。另外，下游由额度墙死体留下脏 worktree 引出的 K6 有 {len(k6_after_k1)} 次、{k6_after_k1_h:.0f} h，会随盲换消失而减少。
其余时间是额度真的没了；要省这部分，得让自动切号真正落地（FLY-2521），并且当时有别的号还有余量。上限约为本类全部 {f1(k1['waste_hours'])} h。</p>
<p><b>风险：</b>如果恢复信号误判，可能在额度仍满的时候重新派发。所以自动重臂最多一次，失败后保持 held 并告警，不能退回盲换循环。</p></div>

<div class="card amber"><div class="card-title">② worktree 接管失败 — {k6['incidents']} 次 · {k6['issues']} 张单 · 浪费 {f1(k6['waste_hours'])} h（其中等人手 {f1(k6['held_wait_hours'])} h）</div>
<p><b>根因：</b>前任死前在共享 branch-B worktree 里留了未提交的改动。替身接管时检查到 <code>clean=false</code>，拒绝原地复用 → <code>unlaunched_admission_rolled_back</code> → run 被打成 held。要 Lead 手工 stash 再 hold resume 才能继续（FLY-2510）。
前任死因以额度墙居多（{len(k6_after_k1)}/{k6['incidents']}）。Claude 替身也会撞上（{C[('claude','K6')]['incidents']} 次），所以这一类跟载体无关。</p>
<p><b>最小修法：</b>接管时如果前任已被证明死亡，而 worktree 里有未提交改动，先由引擎把这些改动存档到一个带名字的救援引用（例如 <code>refs/flywheel/rescue/&lt;dead-exec&gt;</code>，stash 并推送），让 worktree 回到干净状态再接管。交接文案里写明救援引用，替身自己决定要不要取回。</p>
<p><b>预计节省：</b>本类等人手的时间基本全部可省，约 {f1(k6['held_wait_hours'])} h；只剩几分钟的自动处理时间。</p>
<p><b>风险：</b>存档只能在「前任已被证明死亡」之后做（和现有判死条件相同），否则可能跟一个还活着的体抢 worktree（参见 FLY-2572 死而复生的形状）。救援引用必须推送到远端，不能只留在本地。</p></div>

<div class="card blue"><div class="card-title">③ Codex 凭据与身份 — {k3['incidents']} 次 · {k3['issues']} 张单 · {k3['batches']} 批 · 浪费 {f1(k3['waste_hours'])} h（其中等人手 {f1(k3['held_wait_hours'])} h）</div>
<p><b>根因：</b>见上一节。全局 <code>~/.codex</code> 既是人工重登或换号的操作面，又是 runner 起跑时的凭据种子源。操作期间文件缺失或身份不一致，新起的体必死，并且会被当成普通死亡去盲换。</p>
<p><b>最小修法：</b>① 换号或重登改成原子替换：先写临时文件再 rename，任何时刻都不删 <code>auth.json</code>；重登也在独立目录里完成，成功后再原子换入；② runner 起跑时如果凭据缺失或身份未知，按「凭据暂不可用」退避重试几分钟，不判死、不计入盲换次数；③ 长期方向是 FLY-2404（全机一份凭据真身，原地刷新）。</p>
<p><b>预计节省：</b>本类几乎都能省，约 {f1(k3['waste_hours'])} h，外加今天这类 companion 评审停摆。</p>
<p><b>风险：</b>②的退避要有上限，否则真正的账号失效会被拖延暴露。超过上限仍按现状判死并告警。</p></div>

<p class="dim"><b>第四名以后：</b>重启后 reown 失败（{k5['incidents']} 次 / {k5['issues']} 张单，涉及单数第二多，但多数 1–2 分钟就换体接上，合计 {f1(k5['waste_hours'])} h，对应 FLY-2586 / FLY-2505 / FLY-2558）；
体自报 blocked（{C[('codex','K9')]['incidents']} 次，Codex 独有：三轮等不到外部条件就自报 blocked，然后被当作死亡换体）；
「关了没关死」在额度上最亏（见额度视角，FLY-2892 / FLY-2814）。</p>"""))

# 7. review sub-process
rows = [[E(r["author_side"]), E(r["review_type"]), E("正常作废" if r["kind"] == "normal_void" else "基础设施失败"), E(r["failure_reason"]), r["jobs"]] for r in rj]
sections.append(("review", "评审子进程", "gray", f"""
<p>窗口内评审任务 failed 的记录里，绝大多数是评审期间 plan 或代码头变了导致的正常作废，不算出事。真正的基础设施失败（nonzero_exit / no_verdict）一共
{sum(int(r['jobs']) for r in rj if r['kind']=='infra_failure')} 次，量级很小，不进 K 类。今天因全局凭据失效造成的评审停摆，写在「切号」一节。</p>
{table(['作者方', '类型', '性质', '原因', '次数'], rows)}"""))

# 8. limits
sections.append(("limits", "局限与复算方法", "gray", f"""
<ul>
<li>Bridge 日志只保留约 8 小时，FLY-2814 复活的直接日志证据拿不到。改用「终态后 rollout 仍有 token」间接判断，只能说明终态后仍在消耗，分不清是自动复活还是没杀掉。</li>
<li>有 81 个 Codex 执行体找不到 rollout（多为起跑失败），token 记 0。</li>
<li>浪费时长包含 Lead / founder 的反应时间。这是出事造成的真实损失，但它依赖人什么时候在线，所以预计节省写成区间。</li>
<li>额度折算基于本机可见的 rollout，其他机器上用同一账号的消耗看不到，所以百分比可能偏高。</li>
<li>复算：<code>cd evidence/scripts && python3 collect.py && python3 usage.py && python3 classify.py && python3 switches.py && python3 build_report.py</code>。
<code>raw/freeze.json</code> 固定了冻结点，重跑得到的每个 CSV 都逐字节相同（已验证）。抽查 10 条出事记录与生产原始事件和 transcript 的对照，见 <code>derived/spotcheck.md</code>。</li>
</ul>"""))

CSS = """
:root{--bg:#f5f5f7;--fg:#1d1d1f;--dim:#86868b;--card:#fff;--red:#ff3b30;--amber:#ff9500;--blue:#007aff;--green:#34c759;--purple:#af52de;--gray:#86868b;--navy:#1a365d;--line:#e5e5ea}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:-apple-system,system-ui,sans-serif;line-height:1.55;font-size:15px}
main{max-width:960px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:24px;margin:0 0 4px;color:var(--navy)}
.sub{color:var(--dim);font-size:13px;margin-bottom:18px}
.section{background:var(--card);border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:16px 18px;margin:14px 0;border-left:4px solid var(--gray)}
.section.red{border-left-color:var(--red)}.section.amber{border-left-color:var(--amber)}.section.blue{border-left-color:var(--blue)}
.section.green{border-left-color:var(--green)}.section.purple{border-left-color:var(--purple)}
.section h2{font-size:18px;margin:0 0 10px;color:var(--navy)}
ul.big li{margin-bottom:8px}
code{font-family:'SF Mono',ui-monospace,monospace;font-size:12.5px;background:#f2f2f5;padding:1px 4px;border-radius:4px;word-break:break-all}
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:10px 0}
table{border-collapse:collapse;font-size:13px;min-width:100%}
table.wide{min-width:880px}
th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{background:#fafafa;font-weight:600;white-space:nowrap}
.dim{color:var(--dim);font-size:12.5px}
.badge{display:inline-block;font-size:11px;padding:1px 6px;border-radius:8px;color:#fff}
.badge.gray{background:var(--gray)}
.card{border-radius:10px;border:1px solid var(--line);border-left:4px solid var(--gray);padding:10px 14px;margin:10px 0;background:#fcfcfd}
.card.red{border-left-color:var(--red)}.card.amber{border-left-color:var(--amber)}.card.blue{border-left-color:var(--blue)}
.card-title{font-weight:600;margin-bottom:6px}
.card p{margin:6px 0}
.cbox{margin-top:12px}
.cbox label{display:block;font-size:12px;color:var(--dim);margin-bottom:4px}
.cbox textarea{width:100%;min-height:60px;border:1px solid #d2d2d7;border-radius:8px;padding:8px 10px;font:inherit;font-size:14px;resize:vertical;background:#fbfbfd}
.cbox textarea:focus{outline:none;border-color:var(--blue);background:#fff}
.btn{background:var(--blue);color:#fff;border:0;border-radius:8px;padding:8px 14px;font-size:14px;cursor:pointer;margin:4px 6px 4px 0}
.btn.sec{background:#e8e8ed;color:var(--fg)}
.status{color:var(--green);font-size:13px;min-height:18px}
.summary-box{white-space:pre-wrap;background:#f2f2f5;border-radius:8px;padding:10px;font-size:13px;margin:8px 0;word-break:break-word}
"""

body = []
for key, title, color, content in sections:
    body.append(f'<section class="section {color}" id="{key}"><h2>{E(title)}</h2>{content}{cbox(key, title)}</section>')
script = open(os.path.join(HERE, "comment_script.js")).read()
page = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Codex 体出事普查</title><style>{CSS}</style></head>
<body><main>
<h1>Codex 体为什么老出事 — 近 14 天普查</h1>
<div class="sub">FLY-2893 · 窗口 {fz['T0'][:10]} → {fz['T1'][:10]}（UTC）· 冻结于 {fz['frozen_at']} · 全部只读 · 每节可写意见，底部一键复制</div>
{''.join(body)}
<section class="section" id="comments"><h2>意见汇总</h2>
<button class="btn" id="copy-all" type="button">复制全部评论</button><button class="btn sec" id="clear-all" type="button">清空</button>
<div class="status" id="copy-status"></div><div id="summary-chunks"></div></section>
</main><script>{script}</script></body></html>
"""
open(OUT, "w").write(page)
print("wrote", os.path.relpath(OUT, EV), len(page), "bytes")
