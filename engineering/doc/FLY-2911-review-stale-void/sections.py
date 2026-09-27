"""Section content for the FLY-2911 founder design HTML (imported by build-html.py)."""


def build(svg):
    return [
        (
            "summary",
            "一句话",
            """<p class="lead">评审的结论一旦注定要被丢弃，就立刻停下来：运行中每 30 秒复查一次，代码评审登记后先静默 2 分钟，撞额度的重试到点先核版本，同一条线来了新请求就作废旧任务——每次作废都落库留痕，不叫醒 Lead，也不改任何评审判决。</p>
<p>几个词先说清楚：<b>评审任务</b> = Bridge（中控服务）替 Codex 写的代码派出去的一次 Claude 审查；<b>gate</b> = runner 挂起来等评审结论的「门」，结论写进去门就开；<b>head</b> = 这次要审的那个 git 提交的编号。结论只对「当时那道门、当时那个 head」有效，门换了或 head 变了，结论就会被系统丢掉。</p>
<div class="kpis">
<div class="kpi"><div class="n">16.1 亿</div><div class="l">14 天里结论被丢弃的评审<br>消耗的 token（FLY-2904）</div></div>
<div class="kpi"><div class="n">44%</div><div class="l">「被新版本取代」那一类里<br>门已换掉后还在跑的时长</div></div>
<div class="kpi"><div class="n">38%</div><div class="l">「head 变了」那一类里<br>新提交出现后还在跑的时长</div></div>
<div class="kpi"><div class="n">≈4.7 亿</div><div class="l">两类合计的情景估算<br>（假设 token 与运行时长成正比）</div></div>
</div>""",
        ),
        (
            "flow",
            "核心流程：四个止损点",
            """<p>下图从 runner 登记评审开始。四个菱形就是本单新加的四个检查点，对应 issue 的四条：①「同一条线」有旧任务就作废；②静默期；③运行中的<b>看门狗</b>（= 一个每 30 秒醒一次、只做检查的小定时器）；④撞额度重试到点先核版本。</p>
<div class="diagram">""" + svg("d1-flow") + """</div>
<p class="dim">「同一条线」= 同一个 issue、同一种评审（设计或代码）、同一个目标仓库。这和系统里已经存在的「同一 issue 只保留最新一道门」规则一致，所以不会作废那条规则本来不会作废的任务。</p>
<p class="dim">「新旧」按<b>门</b>的创建先后判断，而不是按请求到达 Bridge 的先后：旧门的请求哪怕晚到，也不能作废新门的评审，否则新门会没人评。这是 Codex 第 1 轮评审指出并已改掉的漏洞。</p>""",
        ),
        (
            "model",
            "数据与状态模型",
            """<p>每个评审任务在数据库里是一行。下图是一行任务能经历的状态；<code>voided</code>（作废）在库里仍记为「失败」，另加一个作废时间，这样所有现有的读取方（巡检、重启恢复、统计）都不用改就能正确处理。</p>
<div class="diagram">""" + svg("d2-state") + """</div>
<table>
<tr><th>新增字段</th><th>用途</th></tr>
<tr><td><code>accept_seq</code></td><td>受理序号：请求被真正受理的先后（1、2、3…）。绑错门被拒绝的请求也会留一行审计记录，它没有序号，所以<b>不能</b>去作废别人（9-25 的 b94193db 就是这种）；上线前的旧记录统一记 0，表示「先后未知」，不拿来互相作废</td></tr>
<tr><td><code>voided_at</code></td><td>作废时间。有值就永远不再跑，同一个请求编号再提交也会被拒</td></tr>
<tr><td><code>superseded_by_request_id</code></td><td>被哪个新请求取代</td></tr>
<tr><td><code>quiet_until</code></td><td>静默期截止时间；Bridge 重启后照样生效</td></tr>
</table>
<p>每次作废另写一条审计事件 <code>review_job_voided</code>：原因、触发点（登记 / 看门狗 / 重试到点）、原状态、冻结的 head、看到的新 head、取代者。它和「改状态」在同一个<b>事务</b>里（= 要么两件事都写进去，要么都不写），不会出现改了状态却没留痕。</p>""",
        ),
        (
            "replay",
            "用 9 月 25 日晚的真实任务说明",
            """<div class="diagram">""" + svg("d3-replay") + """</div>
<p><b>如实更正一点：</b>issue 里说 fc72a8e4 会在 21:01「自动重跑同一个已作废的门」。我在 21:01 实地看了 Bridge 日志——它<b>没有</b>重跑，现有的到点复查发现门已被取代，就把它退役了。真正的浪费是它以「待重试」的样子挂了 2 小时 10 分钟（巡检里看起来像「旧任务还在」），以及另一条真会重跑的分支：到点时门还开着但 head 变了，现有代码会在新 head 上立刻再跑一遍，哪怕已经有人提了更新的请求。改后这两处都堵上。</p>
<p>49b16a5c 是反例：它是这条线上最新的请求、门开着、head 没变，所以到点<b>照常重跑</b>——这正是验收要求的负向用例。</p>""",
        ),
        (
            "tradeoffs",
            "取舍与否决的方案",
            """<div class="card green"><div class="card-title">采用：每 30 秒复查一次 head 和门，连续两次不符才停</div><div class="card-reason">和评审开跑前、交结论时用的是同一个判断，只是提前了。读一次 head 只要几毫秒。连续两次才停，避免 rebase（改写提交历史）的中间状态误杀。</div></div>
<div class="card red"><div class="card-title">否决：在 runner 的仓库里装 git 钩子，推送时通知</div><div class="card-reason">规则禁止改 runner 的钩子配置；Codex runner 的仓库也不归 Bridge 管。</div></div>
<div class="card red"><div class="card-title">否决：接 GitHub 的推送通知</div><div class="card-reason">Bridge 没有公网入口；而且评审读的是本地代码，本地提交早于推送。</div></div>
<div class="card green"><div class="card-title">采用：静默期内 head 变了，就在原任务上换成新 head 并重新计时</div><div class="card-reason">任务还没开跑，没花任何钱；不占用「head 变了自动续评」的 2 次额度。每次换都写审计。</div></div>
<div class="card amber"><div class="card-title">取舍：撞额度重试到点时 head 变了，旧 head 不重跑，但门还开着就在新 head 上续评</div><div class="card-reason">issue 原话是「直接作废」。如果门还开着、又没有更新的请求，runner 正在等这道门，纯作废会让它永远卡住。续评评的是新版本，不是重跑旧版本。已向 Lead 说明，未反对则按此执行。</div></div>
<div class="card amber"><div class="card-title">取舍：作废不叫醒 Lead</div><div class="card-reason">FLY-2904 发现同类告警反复叫醒 Lead 本身就是一大笔浪费；作废是预期内的止损，查审计即可。</div></div>""",
        ),
        (
            "boundary",
            "诚实的边界：做什么、不做什么",
            """<table>
<tr><th>会做</th><th>不会做</th></tr>
<tr><td>Bridge 派的 Claude 评审（Codex 写的代码）四个止损点 + 审计</td><td>不动 Claude 写代码、Codex 评审那条线（在 runner 本地跑，不经 Bridge）</td></tr>
<tr><td>把几处「谁最后写谁赢」的写入改成「状态没变才写」，杜绝作废后又被迟到的结论覆盖</td><td>不改评审判决规则、提示词、授权记录；不跳过任何评审</td></tr>
<tr><td>静默期只用于代码评审</td><td>设计评审不静默，它的更新由「同一条线只留最新」覆盖</td></tr>
<tr><td>巡检里不再把「被更新请求取代」报成需要处理的失败</td><td>不做跨执行复用已完成的结论（49b16a5c 这类照常重跑）</td></tr>
<tr><td>开关：一个环境变量关掉全部新逻辑，一个把静默期设为 0</td><td>「门被外部回答」那一类只能靠看门狗截停，省多少估不出来（回答时刻只查到 4/21）</td></tr>
</table>
<p class="dim">未实测的风险：被杀掉的评审会话，下一轮续用（resume）时能否正常接上。已有「找不到会话就换新会话」的兜底；实现阶段可选做一次本地小实验确认。</p>""",
        ),
        (
            "qa",
            "怎么验收",
            """<table>
<tr><th>#</th><th>判据</th><th>证据</th></tr>
<tr><td>1</td><td>运行中 head 变了（连续两次）就停；只变一次后又变回来不停</td><td>协调器单测（假时钟）</td></tr>
<tr><td>2</td><td>静默期内不开跑；head 变了重新计时；Bridge 重启不丢静默期</td><td>协调器单测</td></tr>
<tr><td>3</td><td>重试到点：门关 / 有更新请求 → 作废不跑；门开 + head 未变 + 最新 → 照常重跑</td><td>协调器单测（两种重试来源都测）</td></tr>
<tr><td>4</td><td>新请求登记 → 旧的在跑 / 静默中 / 待重试任务全部作废；绑错门的请求不作废任何东西</td><td>协调器单测 + 数据库单测</td></tr>
<tr><td>5</td><td>每种作废恰好一条审计；作废后迟到的结论不回答门、不写授权</td><td>数据库单测 + 竞态单测</td></tr>
<tr><td>6</td><td>9-25 真实序列回放结果与上图一致</td><td>回放夹具单测</td></tr>
</table>""",
        ),
    ]
