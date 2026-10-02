#!/usr/bin/env python3
"""Build founder-design.html for FLY-3131 (round 2).

Inlines the pre-rendered Mermaid SVGs from diagrams/ (render first with
`mmdc -i dN-*.mmd -o dN-*.svg -w 1000 -b white --svgId FLY-3131-dN`).
All page text is authored here; there is no runtime data interpolation.
"""
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
DIAG = HERE / "diagrams"


def svg(name: str) -> str:
    raw = (DIAG / f"{name}.svg").read_text(encoding="utf-8")
    raw = re.sub(r"^<\?xml[^>]*>\s*", "", raw)
    return f'<div class="diagram">{raw}</div><div class="diagram-hint">图可左右滑动查看</div>'


def comment(sec_id: str, title: str) -> str:
    return (
        f'<div class="cmt"><label for="c-{sec_id}">你对「{title}」的意见(可不写)</label>'
        f'<textarea id="c-{sec_id}" data-sec="{sec_id}" data-title="{title}" rows="3" '
        f'placeholder="写在这里,自动保存在这台浏览器"></textarea></div>'
    )


def choice(qid: str, title: str, options: list[tuple[str, str, str, bool]]) -> str:
    """options: (value, label, note, recommended)"""
    rows = []
    for value, label, note, rec in options:
        badge = '<span class="badge rec">建议</span>' if rec else ""
        rows.append(
            f'<label class="opt"><input type="radio" name="{qid}" value="{value}" '
            f'data-q="{qid}" data-title="{title}" data-label="{label}">'
            f'<span class="opt-body"><span class="opt-label">{label} {badge}</span>'
            f'<span class="opt-note">{note}</span></span></label>'
        )
    return (
        f'<div class="choice" data-qid="{qid}"><div class="choice-title">要你定:{title}</div>'
        + "".join(rows)
        + "</div>"
    )


SECTIONS: list[tuple[str, str, str, str]] = []  # (id, title, color, body)


def section(sec_id: str, title: str, color: str, body: str) -> None:
    SECTIONS.append((sec_id, title, color, body))


# ---------------------------------------------------------------- content
section("s0", "这一版要你定什么", "blue", f"""
<p class="lead">一句话:<b>Linear 一有变化,只更新本机的一份「Linear 拷贝」,不挑单;等真空出位子(或者有空位时拷贝变了),才在拷贝上挑出下一张,
发出前再向 Linear 核一次,投进 Lead 收件箱;另外定时和 Linear 对账,补上漏掉的变化。拷贝不够新时,宁可不发,也不发过时的建议。</b></p>
<p>你上一版选了 <b>1A 2B 4A 5A</b>,第 3 题待定,并留了 4 条意见。这一版逐条回答,把要你定的 4 件事做成了选择:</p>
<table>
<tr><th>#</th><th>要你定的事</th><th>我的建议</th><th>在哪一节</th></tr>
<tr><td>①</td><td>什么时候算「下一张派谁」</td><td>变化只记账,有空位才挑,再加对账兜底</td><td>第 1 节</td></tr>
<tr><td>②</td><td>第 3 题:待派的单存在哪</td><td>C:只存 Linear 拷贝,有空位时当场挑——<b>这要改 PRD 第 3 节第 2 条</b>,需要你同意</td><td>第 2 节</td></tr>
<tr><td>③</td><td>第 1 题:补单在哪个后台线程跑(你选了 A,这里讲清 A/B)</td><td>A,等 3147 后台线程好了再上</td><td>第 3 节</td></tr>
<tr><td>④</td><td>第 2 题:Linear 的变化怎么推过来(你选了 B)</td><td>Cloudflare Worker + Queue,不用买域名</td><td>第 4 节</td></tr>
</table>
<p class="dim">每节下面有留言框;选择和留言自动存在这台浏览器。看完点最下面「复制全部」,贴回 FLY-3131 的 thread。
本页出处里,<span class="tag doc">官方</span> = 官方文档 / 官方设计文档 / 上游源码;<span class="tag inf">推断</span> = 我根据资料推出来的。
这一版的工程底稿经过 Codex 设计审查 4 轮通过(前三轮共挑出 22 处问题,全部改掉,本页已按最终版更新)。</p>
""")

section("s1", "第 1 节 · 每 5 分钟都要算一遍吗?什么时候算", "amber", f"""
<p><b>你说得对:第一版写的「每 5 分钟拉一次 Linear 改过的单」容易变成每 5 分钟都算一遍,位子满的时候全是白算。</b>
这一版改成:<b>变化来了只「记账」,真有空位才「挑」</b>。</p>
<p class="term">名词:<b>Linear 拷贝</b> = Bridge 自己存的一份 Linear 数据(进行中的 Epic、它们的子单、谁挡着谁),只是缓存,随时能删掉从 Linear 重建,不是第二份真相。
<b>对账</b> = 定时把拷贝和 Linear 比一遍,补上漏掉的变化。<b>评估意图</b> = 「这个 Lead 该看看能不能补单了」的一条记录,写在数据库里,程序崩了重启也还在。</p>
{svg("d1-trigger")}
<table>
<tr><th>做法</th><th>好处</th><th>坏处</th><th>成熟系统里谁这么做</th></tr>
<tr><td>⓪ 定时轮询重算(第一版)</td><td>最简单,天然兜底</td><td>位子满时白算;最多晚一个周期</td><td>Prefect 每 15 秒、Dagster 每 5 秒 <span class="tag doc">官方</span>(它们每次算都很便宜)</td></tr>
<tr><td>① 有空位时当场算(你的候选 ①)</td><td>不白算;挑出来的是那一刻最新的</td><td>只靠它:位子空着、当时又没单可派,要有别的事叫醒它</td><td>Buildkite 空出位子才放下一个;Temporal 有空槽才去拉 <span class="tag doc">官方</span></td></tr>
<tr><td>② Linear 一变就重算整张图(你的候选 ②)</td><td>队列永远是新的</td><td>位子满时几乎都白算;而且 <b>Linear 根本不推送「谁挡着谁」的变化</b>(第 4 节),只靠它会漏</td><td>Argo:每个事件把整个工作流重新判一遍 <span class="tag doc">官方</span></td></tr>
<tr class="hl"><td><b>组合(建议)</b>:变化只更新拷贝;位子释放、或「有空位时拷贝变了」才挑;定时对账;另有 5 分钟一次的兜底巡查</td><td>位子满(最常见)时不挑单;漏的事件由对账补;程序崩了也不会让空位一直闲着</td><td>多两个定时器(对账、兜底巡查),都只读本机或少量读 Linear</td><td><b>Kubernetes 调度器同型</b>:事件只把「可能帮得上」的任务放回队列,另有每 30 秒的定时兜底 <span class="tag doc">官方</span></td></tr>
</table>
<p>你记得的「真正要干活时当场算」:Prefect、Buildkite、Temporal 是这个路子(有空才拉、拉的那一刻算);Airflow 文档里也写了「只有排队的比空位多时,优先级才起作用」。
不过 Airflow 本身是一个不停转的循环,不是只在要干活时算 <span class="tag inf">推断</span>。</p>
<p><b>「空出位子」怎么认定</b>:位子按<b>单</b>算,不按 runner 算——一张单从第一次派出起占位,中间换阶段、重试、等你按卡都还占着;
只有<b>这张单这次要合的 PR 全部合入</b>(一张单可能有好几个 PR,合了一个不算)、单子在 Linear 被取消、Lead 明确放弃时才释放。今天代码里这几条路各走各的,新设计会把它们统一成一条「释放」记录。
这些证据都在本机产生,不需要等任何外部推送。</p>
{choice("q1", "什么时候算下一张", [
    ("combo", "组合:变化只记账,有空位才挑,定时对账 + 兜底巡查", "位子满时不挑;漏的由对账补;崩溃也不会让空位闲着", True),
    ("capacity", "只在位子释放时挑", "最省;但「空位等单」要等下一次合入才会想起", False),
    ("onchange", "Linear 每变一次就重算", "最勤;位子满时白算,依赖变化照样要对账", False),
])}
""")

section("s2", "第 2 节 · 第 3 题深度调研:成熟的派单系统怎么做", "purple", f"""
<p>第 3 题问的是:<b>待派的单要不要存成一份「排好序、随变化更新」的队列</b>,还是需要时当场挑。我查了 8 个成熟系统。</p>
<table class="small">
<tr><th>系统</th><th>什么时候算「能跑的」</th><th>怎么限同时跑几个</th><th>存不存队列 / 谁是真相</th><th>漏了事件怎么办</th></tr>
<tr><td><b>Kubernetes 调度器</b><br><span class="dim">最像我们</span></td><td>有新任务就排;排不上的停着,<b>集群有相关变化才放回去重试</b>,还会先判断「这个变化帮不帮得上」<span class="tag doc">官方</span></td><td>节点资源;队列按优先级排 <span class="tag doc">官方</span></td><td><b>维护一个内存优先队列</b>(像我们的 A),不落盘;真相在中心数据库,重启从真相重建 <span class="tag doc">官方</span>/<span class="tag inf">推断</span></td><td>每 30 秒定时把等久了的放回;设计文档明说「只靠事件,漏一个就卡住」<span class="tag doc">官方</span></td></tr>
<tr><td><b>Apache Airflow</b></td><td>一个不停的循环,每轮从数据库重新查能跑的 <span class="tag doc">官方</span></td><td>总并发、每个 DAG 并发、资源池;挑任务时锁住池子防超额 <span class="tag doc">官方</span></td><td><b>不另存队列</b>(像我们的 C):数据库里一列状态(待调度 → 已排队 → 运行中)就是全部 <span class="tag doc">官方</span></td><td>每 5 分钟找回「主人死了」的任务 <span class="tag doc">官方</span></td></tr>
<tr><td><b>Temporal</b></td><td>完全事件驱动:一步完成,<b>同一个数据库事务</b>里写下「下一步该做」<span class="tag doc">官方</span></td><td>每个 worker 有槽位,有空槽才去拉 <span class="tag doc">官方</span></td><td>存队列,但队列和状态同一事务写,不会不同步 <span class="tag doc">官方</span>/<span class="tag inf">推断</span></td><td>定期记录「处理到哪」,重启后重放 <span class="tag doc">官方</span></td></tr>
<tr><td><b>Argo Workflows</b></td><td>任何变化 → 把整个工作流重新判一遍 <span class="tag doc">官方</span></td><td>多级并行上限 + 信号量,只有队头能拿到位子 <span class="tag doc">官方</span></td><td>真相是工作流对象;排队者在内存,启动时重建 <span class="tag doc">官方</span></td><td>每 20 分钟把所有没做完的重新过一遍 <span class="tag doc">官方</span></td></tr>
<tr><td><b>Prefect</b></td><td>worker 每 15 秒来拉一次,拉的那一刻算 <span class="tag doc">官方</span></td><td>工作池 / 队列 / 标签上限;没位子就 30 秒后再试 <span class="tag doc">官方</span></td><td>不另存(像 C):数据库里「待运行」状态,查询时当场筛 <span class="tag doc">官方</span>/<span class="tag inf">推断</span></td><td>位子是「租」的(默认 5 分钟),主人死了自动还 <span class="tag doc">官方</span></td></tr>
<tr><td><b>GitHub Actions</b></td><td>前置作业成功后放行;机器 50 秒长轮询来拉 <span class="tag doc">官方</span></td><td>concurrency 组,最多排 100 个,先来先走但不保证 <span class="tag doc">官方</span></td><td>托管服务,内部没公开 <span class="tag inf">推断</span></td><td>没公开</td></tr>
<tr><td><b>Buildkite</b></td><td>依赖完成后立刻可跑;机器轮询来拉 <span class="tag doc">官方</span></td><td>并发组;等着的处于「受限」状态,<b>空出一个位子时</b>按时间或优先级放行一个 <span class="tag doc">官方</span></td><td>状态在服务端;内部没公开 <span class="tag inf">推断</span></td><td>没公开</td></tr>
<tr><td><b>Dagster</b></td><td>运行写成「排队中」,后台每 5 秒出队一次 <span class="tag doc">官方</span></td><td>最大并发、标签上限、优先级 <span class="tag doc">官方</span></td><td>数据库状态 + 轮询,同 Airflow <span class="tag inf">推断</span></td><td>循环本身兜底 <span class="tag inf">推断</span></td></tr>
</table>
<p class="dim">出处:
<a href="https://github.com/kubernetes/community/blob/master/contributors/devel/sig-scheduling/scheduler_queues.md">K8s 调度队列</a> ·
<a href="https://github.com/kubernetes/enhancements/blob/master/keps/sig-scheduling/4247-queueinghint/README.md">K8s KEP-4247</a> ·
<a href="https://github.com/kubernetes/community/blob/master/contributors/devel/sig-api-machinery/controllers.md">K8s 控制器原则</a> ·
<a href="https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/scheduler.html">Airflow 调度器</a> ·
<a href="https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/tasks.html">Airflow 任务状态</a> ·
<a href="https://github.com/temporalio/temporal/blob/main/docs/architecture/history-service.md">Temporal History</a> ·
<a href="https://docs.temporal.io/task-queue">Temporal 任务队列</a> ·
<a href="https://argo-workflows.readthedocs.io/en/latest/architecture/">Argo 架构</a> ·
<a href="https://argo-workflows.readthedocs.io/en/latest/synchronization/">Argo 同步</a> ·
<a href="https://docs.prefect.io/v3/concepts/workers">Prefect workers</a> ·
<a href="https://docs.prefect.io/v3/concepts/global-concurrency-limits">Prefect 并发租约</a> ·
<a href="https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency">GitHub concurrency</a> ·
<a href="https://buildkite.com/docs/pipelines/configure/workflows/controlling-concurrency">Buildkite 并发</a> ·
<a href="https://docs.dagster.io/guides/operate/managing-concurrency">Dagster 并发</a>。完整对照与源码出处见同目录 research.md §1。</p>

<h3>它们的共同做法</h3>
<ol>
<li><b>真相永远是一份持久的状态;队列(如果有)只是从它推出来的,丢了能重建。</b>没有一家把派生队列当真相 <span class="tag inf">推断</span>。</li>
<li><b>两种挑法都有人用</b>:维护一个派生队列(Kubernetes),或者挑的那一刻从数据库查(Airflow、Prefect)。</li>
<li><b>事件求快,定时对账求稳。</b>每家都有一个不看事件、把全部重查一遍的定时器。</li>
<li><b>在「有空位」那一刻、加着锁挑下一个。</b>位子满时排序没意义(Airflow 原话的意思)。占着位子要有「还活着」的凭据。</li>
</ol>

<h3>放回我们这里:A 和 C 都要先有同一份 Linear 拷贝</h3>
<p>要做到「随变化增量更新」,先得在本机有一份 Linear 拷贝,否则连「这个变化影响哪几张单」都不知道。所以第一版的 A 其实也隐含了这份拷贝。
<b>A 和 C 的区别只在:要不要在拷贝之上,再多维护一份「排好序的待派队列」。</b></p>
<table>
<tr><th>选项</th><th>做法</th><th>好处</th><th>代价</th></tr>
<tr><td>A(PRD 字面)</td><td>拷贝 + 一份排好序的待派队列;拷贝一变,算出哪些单进出队列;有空位取队头</td><td>和 PRD 第 3 节第 2 条字面一致;单子极多时挑单最省</td><td>多一层要和拷贝保持一致的数据:每种变化(依赖、Epic 进出、优先级、归属哪个 Lead)都要写「影响哪些单」的规则,写漏一种就出错;对账时队列也要一起重建</td></tr>
<tr><td>B(第一版)</td><td>不存,每次去 Linear 现拉现算</td><td>代码最少</td><td>就是今天「还剩什么」坏掉的读法:20 秒超时、200 次里 43 次超时、1.5 MB 超限</td></tr>
<tr class="hl"><td><b>C(建议)</b></td><td>只维护拷贝;有空位时在拷贝上查一次,挑排前面的</td><td>少一层容易对不上的数据;拷贝坏了删掉重建即可</td><td>每次挑单要在本机把候选筛一遍、排一遍序(几百张,预计毫秒级,<b>还没实测</b>);<b>字面上不是「取队头」</b></td></tr>
</table>
<p><b>请你特别注意:</b>C 不完全符合 PRD 第 3 节第 2 条。你要的是「输入一变只增量更新、有空位直接取队头、不全量重排」。
C 做到了「增量更新的是拷贝、不去 Linear 全量拉、位子满时不挑」,但<b>有空位时会在本机把候选重新筛一遍、排一遍</b>。
所以选 C 等于同意把那一条改成「增量同步事实,有空位时在本机按需重算候选」。你不同意就做 A,拷贝那一层完全一样,不影响别的。</p>
<p class="term">两种都要存的几张表(给工程看):Linear 拷贝(按 Epic 存完整快照、谁挡谁)、占位(按单计)、评估意图和每次的结论、提醒(状态机)、待投递消息、webhook 收件记录。
A 再多一张「排好序的待派队列」。</p>
{svg("d6-data-model")}
{choice("q3", "第 3 题:待派的单存在哪", [
    ("C", "C:只存 Linear 拷贝,有空位时当场挑(同意改 PRD 第 3 节第 2 条)", "少一层容易对不上的数据;挑单耗时待实测", True),
    ("A", "A:拷贝 + 排好序的待派队列(PRD 字面)", "不用改 PRD;多一层要保持一致的数据", False),
    ("B", "B:不存,每次去 Linear 现拉", "代码最少;就是今天坏掉的那种读法", False),
])}
""")

section("s3", "第 3 节 · 第 1 题讲清楚:补单在哪个后台线程跑(A / B)", "green", f"""
<p class="term">名词:<b>线程</b> = 同一个程序里的另一条「干活的流水线」。Bridge 今天只有一条主流水线,接请求、收 Discord、发消息全在上面,
某个巡检慢了大家一起等(这就是「Bridge 卡顿」)。<b>FLY-3147</b> 是已经设计好(设计审了 3 轮通过)、还没写代码的方案:在 Bridge 里加<b>一条</b>常驻后台流水线,
把巡检类的活搬过去。它规定:后台线程不能直接给 Lead 发消息,要「请主线程代发」(下图的 effect port)。</p>
<p>A、B 的补单逻辑一模一样,区别只是<b>跑在哪条流水线上、谁来照看这条流水线</b>。两者都还在同一个 Bridge 程序里:
程序整个崩溃、内存耗尽、数据库太忙,A 和 B 都挡不住——线程只能隔开「普通的慢和普通的报错」。</p>
<h3>A:作为 3147 后台线程里的一组任务(你上一版选的)</h3>
{svg("d2-option-a")}
<table class="pc">
<tr><th>好处</th><th>坏处</th></tr>
<tr><td>只有一套后台线程框架:启动、出错重启、连续出错熔断、锁、开关全复用</td><td>补单要等 3147 写完(3147 又在等 3146 合入);3147 现在只有设计</td></tr>
<tr><td>3147 已审过 3 轮,「后台线程能做什么、不能做什么」的边界已经想清楚</td><td>和其他巡检挤同一条线程:别的巡检卡住时(3147 文档里 land 最长 460 秒)可能拖慢补单提醒,要靠 3147 的「每个任务各自排、等网络时让出来」</td></tr>
<tr><td>以后别的 Lead 的队列也在同一框架下,不会冒出第二套</td><td>3147 的接口中途改,补单要跟着改;出问题时要懂 3147 的框架才好查</td></tr>
</table>
<h3>B:补单自己先起一条线程,以后再和 3147 合</h3>
{svg("d3-option-b")}
<table class="pc">
<tr><th>好处</th><th>坏处</th></tr>
<tr><td>不等 3147 / 3146,可以先开工</td><td>两套后台线程框架(启动 / 重启 / 熔断 / 消息格式 / 锁),3147 已设计的那套这里再造一遍</td></tr>
<tr><td>补单的普通报错和慢操作不占其他巡检的线程,查问题范围小</td><td>同一个程序:整体崩溃、内存耗尽、数据库太忙照样互相影响;多一条常驻线程多占一份内存(几十 MB 量级)<span class="tag inf">推断</span></td></tr>
<tr><td></td><td>以后合进 3147 是一次额外搬家,或者永远两套;「谁能给 Lead 发消息 / 谁能动 runner」的规矩要再写一遍、再审一遍</td></tr>
</table>
<h3>两种做法都一样的那一段:一次补单从头到尾</h3>
{svg("d4-sequence")}
<p><b>我的建议:按你选的 A,等 3147 好了再上。</b>还有一个我<b>不推荐</b>、但你可能会问的做法:3147 好之前先让补单在主线程跑。
这违反 PRD 第 3 节第 1 条(「算派单放到独立的后台 worker,不挡主线」),所以只能作为你另外批准的临时变更;
风险是读 Linear 的大返回、查数据库都会直接占主线程(设个超时告警只能事后知道,拦不住),「每次只要几毫秒」也还没实测。</p>
{choice("q2", "第 1 题:补单在哪跑", [
    ("A-strict", "A:等 3147 后台线程好了再上", "符合 PRD「不挡主线」;补单上线时间跟着 3147", True),
    ("A-interim", "A,但 3147 好之前先在主线程跑(临时改 PRD 第 3 节第 1 条)", "补单更早上线;要先实测耗时,会占主线程", False),
    ("B", "改选 B:补单自己起一条线程", "不等 3147;代价是两套框架", False),
])}
""")

section("s4", "第 4 节 · 第 2 题:Linear 的变化怎么推过来(用 Cloudflare)", "blue", f"""
<p class="term">名词:<b>webhook</b> = Linear 那边一有变化,就主动往我们给的网址发一条通知(「推」);对应的是我们定时去问(「拉」/ 轮询)。
<b>Cloudflare Worker</b> = 放在 Cloudflare 网上的一小段程序,有固定网址;<b>Cloudflare Queue</b> = Cloudflare 上的「信箱」,消息先存着等人来取。
<b>签名</b> = Linear 用只有双方知道的密钥给每条通知算一个校验码,我们核对它就知道是不是 Linear 发的、有没有被改过。</p>
<h3>Linear 自带的 webhook <span class="tag doc">官方</span></h3>
<ul>
<li>能推:单子(状态、优先级、完成、父单)、评论、标签、项目、周期等 14 类。</li>
<li><b>不能推:「谁挡着谁」(依赖关系)</b>——官方列表和数据结构里都没有。所以<b>不管用不用 webhook,都必须定时对账</b>,在 Linear 界面上手改的依赖只有对账能发现。
(Flywheel 自己通过依赖账本改的依赖,本机直接知道。)</li>
<li>签名:对原始内容做 HMAC-SHA256;通知里带一个被签名保护的时间,要在 1 分钟内,防止别人把旧通知重发一遍。</li>
<li>重试:我们 5 秒内没回「收到」就算失败,最多重试 3 次(1 分钟、1 小时、6 小时后);一直收不到可能被 Linear 停用,要手动重开。顺序不保证。</li>
<li>只有 Linear 工作区管理员能建 webhook。</li>
</ul>
<h3>本机没有对外的门,怎么收?三种 Cloudflare 做法</h3>
<table>
<tr><th>做法</th><th>本机关机 / 断网时</th><th>要什么</th><th>评价</th></tr>
<tr class="hl"><td><b>Worker + Queue(建议)</b>:Worker 收通知、核签名、<b>放进 Queue 成功后才回「收到」</b>;Bridge 每 30 秒去 Queue 取,先在本机记下再确认取走</td><td>消息在 Queue 里存着:免费版 24 小时,付费版(每月 5 美元)最多 14 天;本机关机不会让 Linear 停用 webhook</td><td>Cloudflare 账号;本机放一把钥匙(官方做法下是<b>整个 Cloudflare 账号的 Queue 读写权限</b>,所以建议给它单独一个只放这条队列的账号);<b>不用买域名、本机不开门</b></td><td>不受 FLY-3102 远程控制台「隧道还是 Tailscale」那个决定影响</td></tr>
<tr><td>Tunnel(隧道):本机跑 cloudflared,Linear 直接推到本机</td><td>只靠 Linear 那 3 次重试(最晚 6 小时),再久就丢,还可能被停用</td><td><b>要买一个挂在 Cloudflare 上的域名</b>(临时隧道每次换网址,只能测试)</td><td>最快(1 秒内),但要等 FLY-3102 的域名决定</td></tr>
<tr><td>Worker + 云端数据库日志:Worker 把通知写成带编号的记录,本机按编号来取</td><td>想存多久存多久</td><td>编号、鉴权、清理都要自己写</td><td>比 Queue 多写代码,我们用不上它的好处</td></tr>
</table>
{svg("d5-linear-intake")}
<h3>漏了、乱了、Linear 限流了怎么办</h3>
<ol>
<li>通知只当「某张单变了」的提醒:收到后回 Linear 重新拿这张单的最新状态,不信通知内容本身——乱序、迟到都无害 <span class="tag inf">推断</span>。</li>
<li>本机先记下「收到了第几号」,和拷贝的改动一起记「处理完」;中途崩了,重启后没处理完的会重做。</li>
<li>两个更新撞车时(比如一次慢的整份对账,和中途刚改的依赖),以后到的新改动为准:整份对账发布前先核对「期间有没有人改过」,改过就作废重来。</li>
<li>每 10 分钟对账(改过的单 + 受影响 Epic 的完整快照),每天一次全量。<b>一个 Epic 的快照只有整份读全了才换上</b>,读到一半失败就继续用上一份,并标「不新鲜」。</li>
<li>Linear 限流有两种返回(429,和 400 里带 RATELIMITED),都要退避等待 <span class="tag doc">官方</span>。估算每小时约 300 次请求以内,上限 2,500 次(待实测)。</li>
<li>健康检查分三种:最近没人改 Linear = 正常,不告警;对账看到了变化但通知没来、或取 Queue 失败 = 「推送断了」,告警;读 Linear 失败 = 「读数坏了」,告警并暂停发建议。</li>
</ol>
<p><b>诚实的一句</b>:webhook 让拷贝更快跟上 Linear(从最多 10 分钟缩到约 1 分钟),补单和「暂停 / 撤单 / 改优先级」都更及时。
两次对账之间,在 Linear 里手改的依赖不会马上进拷贝;所以每条建议发出前会再向 Linear 核一次这张单,但 Lead 看到时它仍可能刚好过时——这正是第一版保留「Lead 看一眼」的原因。
用量:每天几百条变化,在 Cloudflare 免费额度内(每天 1 万次操作,一条通知约 3 次)<span class="tag doc">官方</span>。</p>
<p class="dim">出处:<a href="https://linear.app/developers/webhooks">Linear webhooks</a> ·
<a href="https://linear.app/developers/rate-limiting">Linear 限流</a> ·
<a href="https://developers.cloudflare.com/queues/configuration/pull-consumers/">Cloudflare Queue 拉取</a> ·
<a href="https://developers.cloudflare.com/queues/configuration/javascript-apis/">Cloudflare Queue 写入</a> ·
<a href="https://developers.cloudflare.com/queues/platform/pricing/">Cloudflare Queue 价格</a> ·
<a href="https://developers.cloudflare.com/tunnel/setup/">Cloudflare Tunnel</a> ·
<a href="https://developers.cloudflare.com/workers/platform/pricing/">Workers 价格</a></p>
<p>开工前要的两样东西:<b>用哪个 Cloudflare 账号</b>(FLY-3102 也在等这个)、<b>Linear 管理员建一次 webhook</b>。</p>
{choice("q4", "Linear 变化怎么推过来", [
    ("worker-queue", "Cloudflare Worker + Queue", "不用域名、本机不开门、关机也不丢(24 小时内)", True),
    ("tunnel", "Cloudflare Tunnel 直推本机", "最快;要买域名,等 FLY-3102 决定", False),
    ("poll-first", "先只靠对账(每 3–10 分钟),webhook 以后再加", "最省事;拷贝最多晚 10 分钟", False),
])}
""")

section("s5", "第 5 节 · 拆单和开工顺序(按全选建议)", "amber", """
<table>
<tr><th>子单</th><th>做什么</th><th>什么时候能开</th></tr>
<tr><td>1</td><td>Linear 拷贝:按 Epic 存完整快照、增量更新、对账、新鲜度、限流退避;读数坏了告警(手上没 runner 的 Lead 也收得到);先在真 Linear 上实测三件事;取代 FLY-2971 的读法</td><td>你过完设计就能开;<b>不受第 3 题影响</b>(A、C 都需要它)</td></tr>
<tr><td>2</td><td>占位(按单计)+ 统一的「位子释放」记录 + 评估器 + 提醒状态机(30 分钟再提醒一次、60 分钟到期)+ 稳定投递 + 上限 12 / 项目开关 + 在单子 thread 留一句为什么 + 每次合入的「为什么没补」</td><td>1 之后;线程按第 1 题,挑法按第 3 题</td></tr>
<tr><td>3</td><td>Cloudflare Worker + Queue + Bridge 取信 + 推送健康检查</td><td>1 之后;要 Cloudflare 账号和 Linear 管理员</td></tr>
<tr><td>4</td><td>测试房演练 + 上线一周看数</td><td>2 之后(3 可以后补)</td></tr>
</table>
<p>另外不用开单、由 Lead 做:列一张「建议放进 In Progress 的 Epic」清单给你点头;台账型 Epic(FLY-2072)按你定的不进调度。
上线时把今天在飞的单一次性写进占位表,给 Lead 看一眼对不对。</p>
""")

section("s6", "第 6 节 · 诚实边界", "red", """
<table class="pc">
<tr><th>这个设计做到</th><th>这个设计不做 / 做不到</th></tr>
<tr><td>合入后很快给 Lead「可以做 X」;程序崩了重启也会接着补</td><td>不自动派单(仍然 Lead 看一眼,PRD 定的第一版)</td></tr>
<tr><td>位子满时不做无用功</td><td>不选模型、不看额度(另一份 PRD)</td></tr>
<tr><td>漏了通知,最多晚一个对账周期(10 分钟)补上</td><td>Linear 不推送依赖变化,手改依赖最多晚 10 分钟才进拷贝</td></tr>
<tr><td>拷贝不新鲜时不发建议、并告警;每条建议发出前再核一次</td><td>建议发出后、Lead 看到前,单子仍可能刚好被改——需要 Lead 看一眼</td></tr>
<tr><td>读数坏了一定有声音</td><td>Cloudflare 免费版:本机关机超过 24 小时,队列里的通知会过期(对账仍会补上)</td></tr>
<tr><td>Linear 拷贝坏了能整个删掉从 Linear 重建</td><td>还没实测:改父单的通知长什么样、改依赖会不会刷新修改时间、删掉的依赖还查不查得到;挑单耗时;Cloudflare 钥匙的实际权限范围;请求量估算</td></tr>
</table>
<p class="dim">本页是设计,不改代码、不动 Bridge。工程底稿:同目录 exploration.md / research.md / plan.md(经 Codex 设计审查)。</p>
""")

# ---------------------------------------------------------------- page shell
CSS = """
:root{--bg:#f5f5f7;--fg:#1d1d1f;--card:#fff;--dim:#86868b;--navy:#1a365d;--blue:#007aff;--green:#34c759;--amber:#ff9500;--red:#ff3b30;--purple:#af52de}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.65 -apple-system,system-ui,sans-serif;padding-bottom:64px}
.wrap{max-width:960px;margin:0 auto;padding:24px 16px}
h1{font-size:26px;margin:0 0 4px;color:var(--navy)}
.meta{color:var(--dim);font-size:13px;margin-bottom:20px}
.meta code{font-family:'SF Mono',monospace}
.card{background:var(--card);border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:20px 22px;margin:0 0 18px;border-left:4px solid var(--blue)}
.card.amber{border-left-color:var(--amber)}.card.green{border-left-color:var(--green)}.card.purple{border-left-color:var(--purple)}.card.red{border-left-color:var(--red)}
.card h2{font-size:19px;margin:0 0 10px;color:var(--navy)}
.card h3{font-size:16px;margin:18px 0 6px}
.lead{font-size:16px}
.dim{color:var(--dim);font-size:13px}
.term{background:#f2f7ff;border-radius:8px;padding:8px 12px;font-size:14px}
table{border-collapse:collapse;width:100%;margin:10px 0;font-size:14px}
th,td{border:1px solid #e5e5ea;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#fafafc}
tr.hl td{background:#f0faf3}
table.small{font-size:13px}
.table-scroll{overflow-x:auto}
.tag{display:inline-block;font-size:11px;border-radius:4px;padding:0 5px;margin-left:2px;white-space:nowrap}
.tag.doc{background:#e8f2ff;color:#0060c0}.tag.inf{background:#f3e8fb;color:#8a2fb8}
.badge{display:inline-block;font-size:11px;border-radius:10px;padding:0 8px;margin-left:4px}
.badge.rec{background:#e3f7e8;color:#1f8a3b}
.diagram{background:#fff;border:1px solid #ececf0;border-radius:10px;padding:8px;margin:12px 0;overflow-x:auto}
.diagram svg{max-width:100%;height:auto}
.choice{margin:14px 0 4px;border:1px solid #d9e6fb;background:#f8fbff;border-radius:10px;padding:12px 14px}
.choice-title{font-weight:600;margin-bottom:6px;color:var(--navy)}
.opt{display:flex;gap:10px;align-items:flex-start;padding:6px 4px;cursor:pointer;border-radius:6px}
.opt:hover{background:#eef4ff}
.opt input{margin-top:5px}
.opt-body{display:flex;flex-direction:column}
.opt-label{font-weight:500}
.opt-note{color:var(--dim);font-size:13px}
.cmt{margin-top:14px}
.cmt label{display:block;font-size:13px;color:var(--dim);margin-bottom:4px}
.cmt textarea{width:100%;border:1px solid #d2d2d7;border-radius:8px;padding:8px 10px;font:14px/1.5 -apple-system,system-ui,sans-serif;resize:vertical}
details.summary{background:var(--card);border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:14px 20px;border-left:4px solid var(--navy)}
details.summary summary{cursor:pointer;font-weight:600;color:var(--navy)}
.chunk{margin-top:12px}
.chunk pre{white-space:pre-wrap;word-break:break-word;background:#fafafc;border:1px solid #e5e5ea;border-radius:8px;padding:10px;font:13px/1.5 'SF Mono',monospace;margin:6px 0}
.bar{position:fixed;left:0;right:0;bottom:0;height:52px;background:rgba(255,255,255,.96);border-top:1px solid #e5e5ea;display:flex;align-items:center;justify-content:center;gap:14px;padding:0 16px;z-index:10}
.bar .count{font-size:13px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
button{background:var(--blue);color:#fff;border:0;border-radius:8px;padding:7px 16px;font-size:14px;cursor:pointer}
button.ghost{background:#e8f2ff;color:#0060c0;padding:4px 10px;font-size:13px}
a{color:var(--blue)}
@media (max-width:640px){.card{padding:16px 14px}table{font-size:13px}.diagram svg{min-width:760px;max-width:none}}
.diagram-hint{display:none}@media (max-width:640px){.diagram-hint{display:block;font-size:12px;color:var(--dim)}}
"""

SCRIPT = r"""
(function(){
  var PREFIX = 'fly3131-r2:' + location.pathname + ':';
  var MARKER = '【页面意见汇总】FLY-3131';
  var LIMIT = 1800;
  function load(k){ try { return localStorage.getItem(PREFIX + k); } catch (e) { return null; } }
  function save(k, v){ try { if (v) { localStorage.setItem(PREFIX + k, v); } else { localStorage.removeItem(PREFIX + k); } } catch (e) {} }

  var areas = Array.prototype.slice.call(document.querySelectorAll('textarea[data-sec]'));
  var radios = Array.prototype.slice.call(document.querySelectorAll('input[type=radio][data-q]'));
  var qids = [];
  radios.forEach(function(r){ if (qids.indexOf(r.name) < 0) { qids.push(r.name); } });

  areas.forEach(function(a){
    var v = load('c:' + a.dataset.sec); if (v) { a.value = v; }
    a.addEventListener('input', function(){ save('c:' + a.dataset.sec, a.value); render(); });
  });
  radios.forEach(function(r){
    if (load('q:' + r.name) === r.value) { r.checked = true; }
    r.addEventListener('change', function(){ if (r.checked) { save('q:' + r.name, r.value); render(); } });
  });

  function buildLines(){
    var lines = [];
    qids.forEach(function(q){
      var sel = document.querySelector('input[name="' + q + '"]:checked');
      var first = document.querySelector('input[name="' + q + '"]');
      if (sel) { lines.push('【选择】' + first.dataset.title + ':' + sel.dataset.label); }
    });
    areas.forEach(function(a){
      var t = a.value.trim();
      if (t) { lines.push('【' + a.dataset.title + '】' + t); }
    });
    return lines;
  }
  function chunks(raw){
    var maxLine = LIMIT - MARKER.length - 40;
    var lines = [];
    raw.forEach(function(l){
      while (l.length > maxLine) { lines.push(l.slice(0, maxLine)); l = '(续)' + l.slice(maxLine); }
      lines.push(l);
    });
    var out = []; var cur = MARKER;
    lines.forEach(function(l){
      if ((cur + '\n' + l).length > LIMIT - 16 && cur !== MARKER) { out.push(cur); cur = MARKER; }
      cur += '\n' + l;
    });
    if (cur !== MARKER) { out.push(cur); }
    if (out.length > 1) { out = out.map(function(c, i){ return c.replace(MARKER, MARKER + '\n(第 ' + (i + 1) + '/' + out.length + ' 段)'); }); }
    return out;
  }
  function copyText(text, btn){
    function done(ok){ var old = btn.textContent; btn.textContent = ok ? '已复制' : '复制失败,请手动选中'; setTimeout(function(){ btn.textContent = old; }, 1600); }
    function fallback(){
      try {
        var ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', '');
        ta.style.position = 'fixed'; ta.style.top = '-1000px'; document.body.appendChild(ta); ta.select();
        var ok = document.execCommand('copy'); document.body.removeChild(ta); done(ok);
      } catch (e) { done(false); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function(){ done(true); }, fallback);
    } else { fallback(); }
  }

  var countEl = document.getElementById('bar-count');
  var listEl = document.getElementById('summary-chunks');
  var copyAll = document.getElementById('copy-all');
  var current = [];
  function render(){
    var lines = buildLines();
    current = chunks(lines);
    var picked = qids.filter(function(q){ return document.querySelector('input[name="' + q + '"]:checked'); }).length;
    var notes = areas.filter(function(a){ return a.value.trim(); }).length;
    countEl.textContent = '已选 ' + picked + '/' + qids.length + ' · 留言 ' + notes + ' 条' + (current.length > 1 ? ' · 分 ' + current.length + ' 段' : '');
    while (listEl.firstChild) { listEl.removeChild(listEl.firstChild); }
    if (!current.length) {
      var p = document.createElement('p'); p.className = 'dim'; p.textContent = '还没有选择或留言。'; listEl.appendChild(p); return;
    }
    current.forEach(function(c, i){
      var box = document.createElement('div'); box.className = 'chunk';
      var b = document.createElement('button'); b.className = 'ghost'; b.type = 'button';
      b.textContent = current.length > 1 ? '复制第 ' + (i + 1) + ' 段' : '复制';
      b.addEventListener('click', function(){ copyText(c, b); });
      var pre = document.createElement('pre'); pre.textContent = c;
      box.appendChild(b); box.appendChild(pre); listEl.appendChild(box);
    });
  }
  copyAll.addEventListener('click', function(){
    if (!current.length) { copyText(MARKER + '\n(没有选择或留言)', copyAll); return; }
    copyText(current.join('\n\n'), copyAll);
  });
  render();
})();
"""


def build() -> str:
    cards = []
    for sec_id, title, color, body in SECTIONS:
        body = re.sub(r"(<table(?: class=\"[^\"]*\")?>.*?</table>)", r'<div class="table-scroll">\1</div>', body, flags=re.S)
        cards.append(
            f'<section class="card {color}" id="{sec_id}"><h2>{title}</h2>{body}{comment(sec_id, title)}</section>'
        )
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>自动补单设计第二版</title>
<style>{CSS}</style>
</head>
<body>
<div class="wrap">
<h1>自动补单设计 · 第二版</h1>
<div class="meta"><code>FLY-3131</code> · 2026-10-01 · 回答你在第一版(5 道题)上的意见 · 只做调研和设计,不改代码 · 按 PRD FLY-3103 v2.1</div>
{''.join(cards)}
<details class="summary" id="summary"><summary>预览「复制全部」会复制的内容(点开)</summary>
<p class="dim">第一行固定是「【页面意见汇总】FLY-3131」;太长会自动分段,每段都带这个开头,可以分段复制。这只是意见汇总,不代表通过。</p>
<div id="summary-chunks"></div>
</details>
</div>
<div class="bar"><button id="copy-all" type="button">复制全部</button><span class="count" id="bar-count"></span></div>
<script nonce="__CSP_NONCE__">{SCRIPT}</script>
</body>
</html>
"""


if __name__ == "__main__":
    out = HERE / "founder-design.html"
    out.write_text(build(), encoding="utf-8")
    print(out, out.stat().st_size)
