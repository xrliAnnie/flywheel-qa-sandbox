# FLY-1987 GitHub Actions 省钱普查 — 调研

Issue: FLY-1987 (https://linear.app/geoforge3d/issue/FLY-1987/成本research-github-actions-省钱普查用量画像-优化方案缓存裁剪并发自托管-runner-可行性-founder)
日期: 2026-08-22
基于: exploration.md

---

## 0. 数据来源与成色(先说清楚哪些是量出来的、哪些是估的)

| 项 | 来源 | 成色 |
|---|---|---|
| run 清单(90 天 6,215 次) | `GET /actions/workflows/{id}/runs`,按周切窗规避 1000 条上限 | ✅ 实测,逐周与 `total_count` 对上 |
| job 起止时间(30 天 18,354 条) | `GET /actions/runs/{id}/jobs` | ✅ 实测,覆盖 2,612/2,658 run(98.3%) |
| 步骤级耗时 | 同上,14 次绿色全量 run 的 3,014 条 step | ✅ 实测 |
| **计费分钟** | **我算的**:每 job `ceil((completed-started)/60)`,skipped 记 0,全部 `ubuntu-latest`(实测无其他 label) | ⚠️ **估算** |
| 真实美元账单 | 旧的 `…/settings/billing/actions` 已于 2025-09-26 关停;现为 `…/settings/billing/usage` | ❌ **拿不到**(见 §6) |

复现命令见 §附录 A。

### 0.1 三个必须挑明的窟窿

1. **账单 API 没查成**。当前 `gh` token 缺 `user` scope。刷新 token 权限会改动 founder 自己的凭据,
   属于「会改变她环境的动作」,**我没有擅自做**。本文所有美元数字 = 我算的分钟 × 公开单价,不是账单。
   对账方法见 §6。
2. **GitHub 自己的 `/timing` 接口在这个仓库返回全 0**(实测 6 个 run,`billable.UBUNTU.total_ms` 全 `0`,
   而同 run 的 `run_duration_ms` 正常)。所以**我没能用 GitHub 自己的数字交叉验证我的估算**。
   这不是「验证通过」,是「验证做不了」。
3. **「本 PR 最终文件清单」被用来近似「每次 run 的 merge-base diff」**(§4 的 P0 分档依赖它)。
   对全程只碰文档路径的分支(FLY-1911 / FLY-1846)这个近似很稳;对结构变过的分支会偏。

### 0.1.0 我第一批数据是**采集方法本身有缺陷**采来的(R4 抓出)

Design review R4 拿 API 重放了全部 614 个 run,发现我入库的台账**复现不出来**。追下去是两个独立问题:

1. **并发追加损坏。** 我最初用 `xargs -P 6` 让 6 个进程同时 `>>` 追加到同一个 jobs 文件。
   超过 `PIPE_BUF` 的写入会交错,少数 run 的 job 记录因此残缺。
   → 现在改成**每个 run 落一个独立文件**再合并,并对每个文件校验
   `total_count <= 100 且 jobs.length == total_count`;614/614 全部通过。
   ⚠️ 我最初写的判据是 `jobs.length == min(total_count, 100)` —— **那是个假守卫**:
   `total_count=101` 而只拿到第一页 100 条时它返回真(R11 抓出)。附录 A.2 用的是修正后的判据。
2. **重跑的计费被漏掉了。** `/jobs` 默认只返回**最新一次尝试**,而 GitHub
   **每一次尝试都计费**。→ 现在统一用 `?filter=all`。

修正后窗口总额从 **12,180 → 12,768 分钟**(+4.8%),17 个 run 的分钟数变了
(最大的一个 58 → 115,就是一次重跑)。**上一版所有绝对数字都偏低。**

**R5 又在同一层抓到三处**(见 §0.1.3),所以这条教训要写得更狠一点:
**「我算的」这层本身也需要被验证,而验证它的办法是让别人拿原始数据重放** ——
这也是为什么整份原始快照入库了,以及为什么校验器现在**不再检查标签之间是否自洽,
而是直接从原始数据重算一遍逐字段比对**(附录 A.1)。

### 0.1.3 R5 抓到的三处「口径本身写错」

| # | 我原来的写法 | 错在哪 | 修正后 |
|---|---|---|---|
| 1 | 「payload job 被 skip」= 走了快车道 | payload 挂着 `needs: [classify]`,**classify 自己失败/取消时它同样会 skip** —— 那不是 `no_code=true` 的决定。快照里有 20 个这样的假阳性 | 必须**同一次尝试内 classify 成功 且 payload skipped**。命中率从 39.4% 降到 **34.7%** |
| 2 | 一个 run 一行、一个 bucket | 但 GitHub **按尝试计费**,而重跑的两次尝试分类可能不同(快照里有 6 个 run 两次尝试判定相反)。一行装不下 | 台账改成 **按 `(run, run_attempt)` 一行**,计费/分类/构建证据/分档全部按尝试算。614 个 run → **630 个尝试行** |
| 3 | 「真正跑起来的、会 build 的 job 数」当作重复构建量 | 那只是「job 起来了」的**代理指标**,不是「Build 步骤真的跑了」。有 35 个 run 的 build-capable job 时长为 0 或负 | 改成**直接读 `Build` 步骤的真实秒数**(快照里本来就有,是我之前归一化时丢掉的),留一份构建、其余算重复。P3 从 $208 降到 **$164** |

### 0.1.1 一个曾经的「覆盖缺口」,已查实为零

上一版我写「job 数据覆盖 2,612/2,658 run(98.3%),缺的 46 个均匀分布、不影响比例结论」。
**「均匀分布」是我推的,不是量的。** Design review R2 指出这是无依据推断。

**我的处理顺序也要如实记**:R2 之后我先只抽查了 8 个就写成「逐个查了 46 个」——
**那一版仍然是把抽样说成了全量**,R3 又抓了一次。现在是真的**逐个查完 46 个**:

> **46/46 全部 `total_count: 0` —— 它们在任何 job 启动前就被 concurrency 取消了,计费真 0。**
> 本文窗口内的 18 个同理(18/18 已验)。

所以那不是覆盖缺口,是真零。两个必须分清的口径:

- **job 记录覆盖率 98.3%**(2,612/2,658)—— 这是「有没有 job 明细」;
- **计费分钟覆盖率 100%** —— 缺的那些真值就是 0,已按 `billed_min=0` 在册,不是被丢掉。

另有一个细节(**现行台账口径**):窗口内 **19 个零计费的 CI run** 里,**17 个**是「零 job」,
另外 **2 个**有 job 记录但每个 job 时长为 0。两类都是 0,但成因不同,合并数数时要留意。
另有 **1 次零-job 的重跑尝试**(`32423175984#2`)属于一个首次尝试计费 3 分钟的 run
—— 那是**一次尝试**,不是又一个零计费 run,别重复计。

### 0.1.4 R6 又在同一层抓到三处(这是第三轮「口径本身写错」)

| # | 我原来的写法 | 错在哪 | 修正后 |
|---|---|---|---|
| 1 | 每个 attempt 的每条 job 记录都当成一次新执行来计费 | GitHub 的「只重跑失败的 job」会把**已经成功的 job 原样带进新 attempt**,生成新的 `job_id` 但**沿用原来的起止时间戳**。那不是新执行,也不会再计费。快照里 **85 条这样的记录、506 分钟、4,927 构建秒**,分布在 7 个 run | 按**物理执行**计费:同一个 run 内 `(name, started_at, completed_at)` 相同的记录只在**首次出现的 attempt** 计一次。总额 12,768 → **12,262**(−4.0%) |
| 2 | 每个 attempt 行的 `conclusion` 抄 run 级结论 | `runs.jsonl` 只存**最新**一次的结论。于是「先失败后重跑成功」的第一次 attempt 被标成 success | 改用 `GET /runs/{id}/attempts/{n}` 的**权威 per-attempt 结论**(已入库 `attempts.jsonl`)。§1.4 的三档因此从 5,261/5,162/2,345 变成 **4,326/5,141/2,795** |
| 3 | `fullGreen` 用**去重后的名字集合**判断 | 集合会吞掉重数:同一个 attempt 里再塞一条**失败的** `Unit (heavy)`,名字集合没变,照样判绿 | 改成**数记录**:8 个重 job 每个必须**恰好出现一次且 success**,`CI OK` 恰好一条 success,classify / Quick Gate 各恰好一条 |

另外补了两处:`run_attempt` 声明了 2 但 API 只返回 attempt-1 job 的 run,现在也会生成一个零成本的
attempt-2 行(**631 个尝试行**);attempt 的排序改用权威的 `run_started_at`,
不再用被带进来的旧时间戳。

### 0.1.2 测量窗口必须是半开区间(上一版这里算错了)

上一版用「08-20 起 3 天」并按 ×10 折月。但数据抓取止于 `2026-08-22T16:11Z`,
那是 **2 天 + 16 小时**,不是 3 天 —— 拿一个不满的窗口按满窗折算,**折出来的月量是偏低的**。
Design review 抓出了这个;它推断的截止时刻不对(它以为止于 07:17Z,那其实是零-job run 造成的计数巧合),
但**分母错了这件事本身是对的**。

本文改用**半开区间** `[2026-08-20T00:00:00Z, 2026-08-22T00:00:00Z)` = **恰好 48 小时**,
折月系数 **×15**,两个端点写进每张表的口径和复现命令里。

### 0.2 一个必须先讲清楚的时间线陷阱

`classify` 这个机制在 4 天里换过两个实现:

| 版本 | commit | 落 main 时间(UTC) | 规则 |
|---|---|---|---|
| v1 | `d839a92fa` (FLY-1861) | 2026-08-18T19:07Z | 调 runs API 找「最近一次完成的 PR run」做增量基线 |
| **v2(现行)** | `fe9e3de86` (FLY-1877) | 2026-08-19T18:15Z | 纯 merge-base 全量 diff,不调 API |

**所以「8/18 之后」不是一个统一的现状窗口,而是两套算法的混合。**
本文所有「现状」表统一用 §0.1.2 的半开区间 **`[2026-08-20T00:00Z, 2026-08-22T00:00Z)`(48h,×15 折月)**
—— v2 落地后的完整 48 小时。

**两处残留近似,都朝同一个方向**:
- PR 分支携带的是各自 head 上的 `ci.yml`,尚未同步 main 的分支在这 48 小时里仍可能跑 v1;
- 下表按**落 main 时刻**切队列,所以严格讲是 **post-v1-landing / post-v2-landing 两个时间队列**,
  不是「按 classifier blob 精确归属的两组」。

| 时间队列 | 快车道命中率(**分母 = CI run,不含 Ship / Beta**) |
|---|---|
| post-v1-landing(08-18T19:07Z ~ 08-19T18:15Z) | **11.3%**(9/80) |
| post-v2-landing(08-19T18:15Z 起) | **43.4%**(283/652) |
| 本文半开区间窗口(08-20 ~ 08-22) | **34.7%**(194/559 尝试)† |

† 只有这一行用了 R5 修正后的严格判据(**classify 成功 且 payload skipped**,按尝试算)。
上面两行是旧判据(只看 payload skipped)算的,**系统性偏高**,留着只为看趋势方向。

⚠️ **这三行是相关,不是因果。** 两个队列的工作负载构成(哪些分支在推、推的是什么)并没有被控制,
所以它只能说「v2 期间命中率高得多」,不能说「全部改进由 v2 造成」。要证因果得拿同一批 PR 回放两版规则。
但**v2 不是退步**这个结论是稳的。

## 1. 用量画像

**窗口口径**:以下 §1.2~§1.5 全部基于半开区间 `[2026-08-20T00:00Z, 2026-08-22T00:00Z)`,
恰好 48 小时,**614 个 run / 631 个尝试行**(CI 占 559 个),**12,262 计费分钟**(CI 占 12,225),折月系数 ×15。
台账按 `(run, run_attempt)` 计行,但**只对物理执行计费** —— 重跑失败 job 时被原样带进新 attempt 的
那 **506 分钟**记在 `carried_min` 列里、**不计费**(§0.1.4)。
**每张表都标了自己的分母** —— 全 workflow 的表用 12,262,只看 CI 的表用 12,225。
这些表都可以用 `data/ledger.csv` + `data/aggregate.mjs` 复算;§1.1 的 7/14/29 天行与 §1.6 的 30 天表**不在**入库数据里(见附录 A.1)。

### 1.1 总量与趋势 —— 只能给这个窗口的情景值,给不出区间

| 统计窗口 | 日均分钟 | 折合 30 天 | ≈ $/月 |
|---|---|---|---|
| 半开区间 48h(现行 classifier) | 6,131 | **183,930** | **$1,104** |
| 最近 7 完整天 † | 4,365 | 130,963 | $786 |
| 最近 14 完整天 † | 3,278 | 98,334 | $590 |
| 最近 29 完整天 † | 2,433 | 72,986 | $438 |

† 这三行来自**旧的采集方式**(未计重跑尝试、且有 §0.1.0 的并发损坏),
所以相对 48h 那行是**系统性偏低**的。它们只用来看趋势方向,不要拿来算钱。

> **我的采样撑得住的说法只有一句**:把这个(异常繁忙的)48 小时窗口按**现行口径**折算成 30 天,
> 约 **183,930 分钟/月 ≈ $1,104/月**。
>
> ⚠️ **我给不出一个站得住的「当前区间」。** 下表 7/14/29 天那三行出自**已知有缺陷的旧采集器**
> (漏计重跑 + 并发写损坏,系统性偏低),我在 §0.1.0 里已经说过**它们不能用来算钱**
> —— 那就不能反过来拿它们当区间的下沿。**要给区间,得先用现行采集器重跑一个更长的窗口。**

**必须一起说的采样偏置**:那个 48 小时半开区间**恰好罩住了近两周最忙的两天**
(现行台账口径:08-20 = **6,037** 分钟、08-21 = **6,225** 分钟)。
⚠️ 「比平常高多少」只能定性说 —— 用来对比的更长窗口数据出自已知有缺陷的旧采集器(见脚注 †)。
所以 $1,104 是**繁忙窗口的折算值**,不是典型月份。我之所以仍用它做 §4 台账的分母,是因为
**台账要的是比例和逐 run 归属,而不是绝对总量**;比例在各窗口间是稳的,总量不是。

按 GitHub 2026 现行单价 Linux 2-core **$0.006/分钟**(2026-01-01 起降价约 40%,平台费已并入)。
方案内含的 2,000(Free)/ 3,000(Pro/Team)分钟在这个量级上是噪声(约 $12~18),不影响任何结论。

CI 每周 run 数也在爬:5 月底 51 → 7 月初 827 → 8 月初 191 → **最近一周 931**。

### 1.2 钱花在哪个 workflow

| workflow | 分钟 | 占比 |
|---|---|---|
| CI (`ci.yml`) | 12,225 | **99.7%** |
| Ship on :cool: Comment | 22 | 0.2% |
| Payload Beta Release(每 6h) | 15 | 0.1% |

**探索阶段的第一个猜测被推翻了。** 我原本怀疑 `ship-on-comment` 是隐形大头(它 `timeout-minutes: 30`,
设计上要等最长 25 分钟的 CI 判决,等待期计费)。实测 30 天占 2.5%、本窗口占 0.2%。
原因:400/532 次触发是非 `:cool:` 评论,`if` 不成立、整 run 秒级 skip、0 计费。
**这条猜测作废,不要往这里投优化。**

### 1.3 钱花在哪个事件源

| 事件 | 分钟 | 占比 |
|---|---|---|
| `pull_request` | 11,055 | 90.2% |
| `push`(即 main) | 1,170 | 9.5% |
| `issue_comment` | 22 | 0.2% |
| `schedule` | 15 | 0.1% |

### 1.3.1 钱花在哪个 job(issue 明确要的那一拆)

| job | 分钟 | 占比 | 折月 ≈$ |
|---|---|---|---|
| Script Tests 1/2 — cmux/session | 1,949 | 15.9% | $175 |
| Script Tests 2/2 — fleet/setup/packaging | 1,822 | 14.9% | $164 |
| Quick Gate (build + typecheck + lint) | 1,466 | 12.0% | $132 |
| Unit (heavy) | 1,317 | 10.7% | $119 |
| Unit (teamlead 2 of 3) | 1,270 | 10.4% | $114 |
| Unit (teamlead 3 of 3) | 1,247 | 10.2% | $112 |
| Unit (teamlead 1 of 3) | 1,231 | 10.0% | $111 |
| Unit (light) | 840 | 6.9% | $76 |
| Classify CI scope | 529 | 4.3% | $48 |
| NPM payload distribution | 305 | 2.5% | $27 |
| CI OK | 249 | 2.0% | $22 |
| Ship / Beta 两个 workflow 的 job | 37 | 0.3% | $3 |

这张表是 **job 维度**、只统计**物理执行**(带进新 attempt 的记录不重复计)。
`aggregate.mjs` **现在会打印并校验它**(R6 finding 6):它从同一份 `data/raw` 重算,
并断言 job 维度合计 == 台账合计,同时拒绝任何不在已知 job 名单里的名字
——因为一个没见过的 job 名意味着「CI 的 job 图已经不是本文描述的那张」,不能悄悄照原样再印一遍。

### 1.4 钱花在什么**结果**上(按**尝试**的权威结论,不是 run 级结论)

| **尝试**的结局 | 分钟 | 占比 |
|---|---|---|
| **cancelled** | 5,141 | **41.9%** |
| success | 4,326 | 35.3% |
| **failure** | 2,795 | 22.8% |

**64.7% 的分钟没换来一个绿色判决。**
这里用的是每次**尝试**自己的权威结论(`GET /runs/{id}/attempts/{n}`),不是 run 级的最新结论
—— 后者会把「先失败、后重跑成功」的第一次也标成 success(§0.1.4 第 2 条)。
被取消的尝试平均烧掉 **16.2 分钟**(318 次全部取消尝试的均值;只算真正计过费的 297 次则是 **17.3 分钟**)才被后一次 push 顶掉。
(注:另有 **18 个零-job 尝试**在任何 job 启动前就被取消,计费真 0 —— 其中 17 个是整 run、1 个是重跑尝试,见 §0.1.1。)

### 1.5 钱花在什么**提交**上 ← 本次最重要的一张表

**先说清楚这张表量的是什么**:它按 **head commit 的 message 前缀标签**分组。
`docs(...)` 是**提交约定标签,不是文件内容的证明**。下面先给测量到的原话,再给能站住的推论。

**分母 = CI 的 12,225 分钟**(不是全 workflow 的 12,262)。

| head commit 标签 | 分钟 | 占比 |
|---|---|---|
| `docs(...)` | 6,407 | **52.4%** |
| `feat/fix/perf/refactor` | 2,359 | 19.3% |
| `chore(progress)` | 1,723 | **14.1%** |
| 其他 | 1,475 | 12.1% |
| `test/chore/ci` | 261 | 2.1% |

**测量到的原话**(可直接引用):
> **66.5%** 的 CI 分钟(8,130 / 12,225),花在 head commit 被标为 `docs(...)` 或 `chore(progress)` 的尝试上;
> 标为 `feat/fix/perf/refactor` 的只占 19.3%。

**能站住的第二句(基于文件事实,不是标签)**:
这些 `docs`/`chore(progress)` 的 run 里,凡是**跑了全量**的,`classify` 本身就证明了
它们的**累计 PR diff 不是全惰性**(否则会走快车道)—— 换句话说,那个 PR 里有非惰性内容,
通常是**同一 PR 里更早提交的代码**。
⚠️ 严格讲这是「不是全惰性 **或** classifier fail-closed 了」二选一,fail-closed 的比例我没有单独量。

**不能说的**:不能说「66.5% 的钱花在没有代码的改动上」。我没有逐 run 核对文件 diff,
而 `classify` 恰恰告诉我们这些 PR 的累计 diff **含有**非惰性内容。
正确的表述是**「花在以文档提交为 head 的 run 上」**,以及**「这些 run 之所以跑全量,
多半是因为同一个 PR 早先已经有过代码」**。

其中 14.1% 是 Flywheel **自己的进度账本** —— runner 每走一步就 `flywheel-comm progress`
提交 `progress.md` 推到 PR 分支。**这是我们自己的编排器在给自己刷账单。**

### 1.6 分支维度(30 天)

244 个 PR 分支、1,768 次 PR CI run,**平均每分支 7.2 次**。头部极不均匀:

| 分支 | run | 其中被取消 | 分钟 |
|---|---|---|---|
| `flywheel-FLY-1911`(语音原型证据) | 206 | 174 | 6,074 |
| `docs/FLY-1846-global-chief-of-staff` | 69 | 57 | 1,943 |
| `flywheel-FLY-1586` | 53 | 35 | 1,790 |
| `flywheel-FLY-1782` | 56 | 46 | 1,440 |

## 2. 现有省钱机制:哪些真在起作用(先查,别重复造)

### 2.1 并发去重 —— ✅ 已生效,不用再做

`concurrency: ci-${{ github.ref }}` + `cancel-in-progress: true` 已全覆盖。
**41.9% 的 cancelled 分钟不是「漏了并发去重」,恰恰是它在止损的证据**;
真正的浪费是取消前已经烧掉的分钟(全部取消尝试均值 16.2 分钟 / 只算计过费的 17.3 分钟),那只能靠**少推几次**来省(§4),
再加一层 concurrency 没有用。

### 2.2 pnpm 缓存 —— ✅ 健康,不是杠杆

步骤级实测:`Install dependencies` 每 job 只要 **4~7 秒**,全 run 8 个 job 合计 **0.83 分钟(1.4%)**。
**在这里优化最多省 1%,不要碰。**

### 2.3 `classify` 快车道 —— ✅ 真在生效(本文窗口 **34.7%**),但漏得多

现行 v2(`scripts/ci-classify.sh`,FLY-1877)的规则,实读源码确认:

- 取 `merge-base(base, head)` 到 head 的**整个 PR 全量 diff**,**不是本次 push 的增量**;
- 每个文件必须**同时**满足前缀白名单(`doc/`、`product/doc/`、`engineering/doc/`、`content/doc/`)
  **和**后缀白名单(`.md .markdown .mmd .html .htm .svg .png .jpg .jpeg .gif .webp .avif .pdf`);
- 拒绝 symlink(`120000`)与 submodule(`160000`);
- 任何不确定一律 `fail_closed` → 跑全量。

由此推出两条漏点:

1. **一个 PR 只要曾经改过一行代码,它此后每一次文档提交都会跑全量。**
   这是 `chore(progress)` 花掉 14.1% 的直接原因。
2. **目录对了但后缀不在表里,整个 PR 终身进不了快车道。**

两个实测样本:

- **PR #874**(`docs/FLY-1846`):9 个文件全在 `product/doc/` 下,5 个 `.md` + 2 个 `.png` +
  1 个 `.html` + **1 个 `.txt`**。就这一个 `.txt` 让这条纯文档 PR 的 68 次 run 只有 2 次进快车道,
  **烧掉约 1,880 分钟**。
- **PR #896**(`flywheel-FLY-1911`,语音原型):文件全在 `product/doc/` 下,但含
  `.jsonl(98) .json(80) .mjs(61) .mp3(28) .wav(23) .sh(15) .py(12)`。
  `.mjs/.sh/.py` 是真可执行文件,**fail-closed 拒绝是正确的**;代价是这条分支 206 次 run / 6,074 分钟。

### 2.4 🔴 现行 classifier 有一个**已经生效的安全漏洞**(本次调研的意外发现)

这不是省钱问题,是**正确性问题**,而且现在就在生产上。

`ci.yml` 里 Script Tests 2/2 跑 `scripts/__tests__/launchd-units-manifest.test.sh`(第 367 行)。
该脚本第 836 行把 **`doc/engineer/implementation/FLY-222-a0-a10-runbook.md`** 列进
`stale_reference_files`,并 grep 它是否残留 pre-consolidation 的 plist 路径,命中就 `FAIL`。

而 `doc/` 前缀 + `.md` 后缀**正好在快车道白名单里**。于是:

> **一个只改这份 runbook.md 的 PR → `no_code=true` → Script Tests 2/2 被 skip
> → `CI OK` 判绿(它显式接受 `no_code=true` 时的 `skipped`)→ 合并。
> 那条本该拦住它的守卫从头到尾没有运行过。**

同类第二例(目前不触发,但把「doc 路径都是惰性」这个前提证伪了):
`scripts/__tests__/test-fly1609-design-compare.test.sh`(`ci.yml` 第 475 行)会
`python3 engineering/doc/FLY-1458-abc-prompt-three-arm-analysis/scripts/design_compare.py --self-test`。
`.py` 不在后缀白名单里,所以今天不会漏;但它说明 **CI 确实会执行 doc 前缀下的文件**。

**结论:「doc 前缀下的一切都是惰性」这个假设,今天就是错的。**

> 📌 **这个洞已由 Tadashi 立成独立 bug 单:FLY-1996。**
> 本单只负责发现和描述,修复由 FLY-1996 执行(它的验收里已经写明要阳性/阴性双对照,
> 以及要扫全部测试对 doc 路径的其它断言引用,不只修这一个文件)。
所以后面 §4 里那条「放宽成 doc 前缀一律惰性」的候选,**本文明确否决**,不再作为待评估项。
真正该做的是先把这个洞堵上(见 plan §2 的 P-1)。

### 2.5 `paths-ignore` —— ❌ 被分支保护结构性堵死(留个记号,别再想)

实测 `main` 分支保护:required check 只有 **`CI OK`**,`strict: false`。
给 workflow 加 `paths-ignore` → 纯文档 push 不触发 workflow → `CI OK` **永不汇报** → PR 永久卡住。
所以「文档改动直接不跑 CI」在本仓**不可行**,只能走「跑一个几秒的守门 job、让重 job skip」这种形态。
FLY-1861/1877 选这个形态是对的。

### 2.6 runner 规格 —— ✅ 没有超配

30 天全部 18,354 条 job 记录,**runner label 100% 是 `ubuntu-latest`**,无 larger runner /
macOS / Windows。**这条候选查完是空的。**

---

## 3. 每一次全量绿色 CI 的钱花在哪(14 次抽样,步骤级)

单次全量绿色 run:计费约 **55~62 分钟**,墙钟约 17 分钟(9 个 job 并行)。

| 类别 | 分钟/run | 占比 |
|---|---|---|
| 真正的测试 / 检查 | 44.9 | 76.6% |
| **`Build`(每个 job 各建一次)** | **9.7** | **16.6%** |
| toolchain setup | 1.4 | 2.4% |
| checkout | 1.0 | 1.7% |
| `pnpm install`(缓存命中) | 0.8 | 1.4% |
| 原生依赖预置 | 0.4 | 0.8% |
| runner 固定开销 | 0.3 | 0.5% |

`pnpm build` 在 4 处 job 定义里出现,**加上 5 路 Unit 矩阵实际执行 8 次**,每次约 73 秒,
合计 **9.7 分钟纯重复劳动**。`ci.yml` 里 **完全没有** `actions/cache` 或
`upload-artifact` / `download-artifact`,构建产物零跨 job 复用。

最慢的测试步骤(每 run 平均秒):

| 秒 | 步骤 |
|---|---|
| 389 | Script Tests 1/2 :: `Test — FLY-1364 cmux sync repair` |
| 304 | Unit (heavy) :: `Run matrix tests` |
| 278 / 275 / 233 | Unit (teamlead 2/3, 3/3, 1/3) :: `Run matrix tests` |
| 135 | Script Tests 2/2 :: `Test — FLY-1434 unified restart + quota caller` |
| 116 | Script Tests 1/2 :: `Test — FLY-1929 voucher watch contracts` |
| 104 | Script Tests 2/2 :: `Test — FLY-1501 restart brake + heartbeat guard` |
| 96 / 89 | Script Tests 1/2 :: `FLY-1663 launchd lifecycle` / `FLY-1814 launchd fleet` |

单个 `FLY-1364 cmux sync repair` 步骤就占 Script Tests 1/2 这个 job 的 45%。

### 3.1 一个反直觉的发现:FLY-1870 的拆片让账单变贵了

| | 墙钟 | 计费 |
|---|---|---|
| 拆片前(单 job) | 17.2 min | 17.2 min |
| 拆片后(两 job) | 12.2 min(最长片) | **12.2 + 10.9 = 23.1 min** |

**拆片把墙钟砍了 29%,把账单加了 34%。**
这不是说 FLY-1870 做错了——它当时解的是 20 分钟超时悬崖,是对的。
但**它是一笔用钱买延迟的交易**,以前没人把这笔账记下来。以后再提「拆片加速」都要把这行一起报。

---

## 4. 可省多少:逐**尝试**反事实台账(每个尝试只计一次,且区分毛额与净省)

**方法**:取半开区间窗口(48h)的 **559 个 CI 尝试行**(另 72 个 Ship / Beta 尝试进不了 classifier,
归 `non_ci`,不参与分档)。**按尝试不按 run** —— 重跑也计费,而两次尝试的分类可能不同。
按固定顺序归到**唯一**一档:
① 已走快车道 → ② P0 能救 → ③ P1 能救 → ④ 谁都救不了。**②③④ 互斥。**

⚠️ **②③ 只对 `event == pull_request` 的 run 开放。** 上一版这里漏了这道闸,把一个
`push: main` 的 run 错分进了 ③(design review R3 抓出)。P0/P1 都是 PR 作用域的机制,
而 research §8 明确 main 的 push CI 必须永远跑全量 —— 这道闸现在既写进 `derive.mjs` 的判据,
也写进 `aggregate.mjs` 的断言:**任何 ②③ 行的 event 不是 `pull_request` 就直接报错退出。**

**上一版这里有个错**(design review 抓出):我把每档的**当前花费**直接标成「可省」。
不对 —— 一个改走快车道的 run **仍然要付** Classify + Quick Gate + `CI OK` 的钱。
本版按三列给:

- **毛额** = 这档 run 现在实际花掉的分钟;
- **反事实** = 同一批 run 若走快车道会花的分钟,按 `min(实际, 快车道成本模型)` 算
  ——「取 min」是为了**不给「还没跑到快车道成本就被取消」的 run 虚记节省**;
- **净省** = 毛额 − 反事实。

快车道成本模型 = 完成态快车道 run 的计费分钟中位数 = **6 分钟**。

| 档 | 尝试行 | 毛额 | 反事实 | **额度** | 折 30 天 | ≈$/月 | 这个「额度」是什么 |
|---|---|---|---|---|---|---|---|
| ① 已走快车道(非杠杆) | 194 | 880 | 876 | 4 | 60 | $0 | 净省(毛额−反事实) |
| ② **P0** 后缀白名单 | **0** | 0 | 0 | **0** | 0 | **$0** | 净省;本窗口零样本 |
| ③ **P1** 增量判据 | 28 | 1,452 | 160 | **1,292** | 19,380 | **$116** | **净省的上限**(毛额−反事实;两条前提未验) |
| ④ 谁都救不了,必须跑全量 | 337 | 9,893 | 1,698 | — | — | — | — |
| ⑤ **P3** 构建复用(只作用在④) | — | — | — | 1,882 | 28,230 | **$169** | **不是净省、也不是上限**:是**毛的**建模计费分钟差,**未减**新增生产者 job 开销与 artifact 传输(§4.3) |

自洽校验:① + ② + ③ + ④ = 12,225 = CI 全部分钟;加非-CI 的 37 分钟 = 12,262 = 窗口总额。✅

**这个窗口下的情景残值** = 12,262 − 1,292(P1)− 1,882(P3) = **9,088 分钟/48h
≈ 136,320 分钟/月 ≈ $818/月**。
⚠️ 它是**这个窗口的情景值,不是账单下界** —— 见 §7。

以上每个数字都由 `node data/aggregate.mjs` 直接打印,并附结构不变量校验(§附录 A.1)。

### 4.0 R4 把这张表改了一遍,而且改的方向对我不利 —— 必须照实说

上一版这张表写的是 P0 $0(38 个 run)、P1 $389(147 个 run)、P3 $96、残值 $612。
Design review R4 重放 API 后指出我的**两个判据本身写错了**,两个都让杠杆看起来比实际大:

| 判据 | 上一版的写法 | 错在哪 | 修正后 |
|---|---|---|---|
| **P1 合格基线** | 「重 job 全 success」 | ① 只要有**任意非空子集**的重 job 成功就算;② **完全没检查 `CI OK`**。结果 147 条 P1 里有 124 条把 **`CI OK=failure` 的失败 run** 当成了「之前绿过」 | 必须**恰好** 5 个 Unit + 2 个 Script Tests + 1 个 payload 全 success、**且 `CI OK` success**、且只有 CI/`pull_request` 的 run 能当基线。窗口内真正合格的全绿 run 只有 **51 个** |
| **P0 可救** | 「所有文件都落在 现有∪P0 后缀里」 | 那只是「P0 之后仍然合法」,**不是「靠 P0 才被救」**。一个文件全在**现有**白名单里的 PR 根本不需要 P0 | 追加一条:**至少有一个文件用的是 P0 新增后缀**。加上这条之后,**P0 档从 38 个变成 0 个** —— 那 38 个全是 `.md`/`.html`,P0 对它们毫无作用 |

**结论跟着变**:P1 从 $389 一路掉到 **$116**(R4 后 $137,R5 按尝试重算 $135,R6 去掉重复计费 $116);P0 从「$0 但偶发有额度」变成「在这个窗口里连一个样本都没有」;
P3 从 $96 涨到 $208,R5 换成真实 Build 步骤证据回落到 $164,**R6 改成按 job 整分钟建模后是 $169**(见 §4.3)。

**这不是数字微调,是排序反转**:上一版我把 P1 排在第一位,现在 P3 排在前面。
⚠️ **但排序的理由不是「P3 的数更大」** —— $169 是 P3 的**毛**建模值、$116 是 P1 的**净省上限**,
两者口径不同**不能比大小**(§7)。排序只靠 blast radius 和 P1 未解决的可行性前提。

### 4.1 P0 在这个窗口**一个样本都没有**,必须照实说

修正判据后 ②档 = **0 个 run**。窗口内没有任何一个 PR 是「因为用了 `.txt`/`.jsonl` 这类后缀才没进快车道」。
上一版那 38 个是判据写错捞进来的(§4.0)。

那 P0 还做不做?**做**,但理由必须换成能站住的那个,而且要**明说它现在没有实测额度**:

- 它的额度是**偶发**的,而且证据来自窗口**之外**:PR #874(`docs/FLY-1846`)9 个文件里
  只有 1 个 `.txt` 不在白名单,却让这条纯文档 PR 的 68 次 run 里只有 2 次进快车道,毛额 1,880 分钟。
  **那条 PR 已经合并,所以它不在本文窗口里 —— 这也正是 ②档为 0 的原因。**
- 它**改一行白名单、可一行回滚**。
- **但它不是零风险**(见 §4.4)。

**结论:P0 的正当理由是「成本极低 + 偶发时额度不小」,不是任何一个实测数字 —— 本窗口的实测就是 0。**

### 4.2 P1 的 $116 是**上限**,不是可兑现额

③的判定条件是两条:该分支此前出现过一次**合格全绿**(§4.0 修正后的严格定义),
且本次 head commit 标签是 docs/progress。
我**没有**验证:
- 自基线以来的增量 diff 是否真的全惰性;
- 基线时的 base SHA / `ci.yml` 是否与现在一致。

两条都只会让额度**变小**。而且 P1 还有一个**可实现性前提尚未解决**(见 plan P1 与 §4.5):
真实值必然低于 $116。**别把它当承诺。**

### 4.3 P3 的 $169:**构建秒数是量的,省下的钱是推的**——而且它**不是上限**

这条数字被改过三次,每次都是因为我在**用一个方便的量冒充要证明的量**:

| 版本 | 算法 | 问题 | 值 |
|---|---|---|---|
| R3 前 | ④档 run 数 × 7 分钟 | 给没花过这笔钱的 run 也记账 | $96 |
| R4 | `(build-capable job 数 − 1) × 1.22` | 「job 起来了」**不等于** `Build` 真跑了 | $208 |
| R5 | 真实 `Build` 步骤秒数 ÷ 60 | 秒数是真的,但**除以 60 不是计费口径** | $164 |
| **R6(现行)** | 逐 job 的**计费分钟差**:`ceil(时长/60) − ceil((时长−构建秒)/60)`,留最长的一份构建作生产者 | —— | **$169** |

**R5 那版为什么错**:GitHub **按 job 向上取整到整分钟**。从一个 61 秒的 job 里去掉 2 秒构建,
省的是**整整 1 分钟**,远大于 `2/60`。所以「秒数 ÷ 60」既不是上限也不是下限,方向都不定。
我上一版还写着「按 job 取整只会让它更小」——**那句话是错的,已删**。

**成色必须分开标**:
- **`dup_build_sec`(重复构建秒数)= MEASURED** —— 直接读 `Build` 步骤的真实起止;
- **`p3_billed_min`(省下的计费分钟)= INFERRED** —— 是**建模结果,不是上限**:
  它**没有**减去新增生产者 job 自己的 checkout / setup / install 和 artifact 上传下载
  (这两项把真实收益**往下拉**),而按 job 取整可能让它**往上或往下**都走。
  它还**随 P3 选哪套设计变**(Quick Gate 保留本地 build vs 拆独立常开 job),必须各自单算。

**所以 P3 开工第一步仍然是「先量」**:量 `dist` 体积、量一次上传 + 七次下载的真实耗时、
量新 build job 自己的开销。量完不划算就地放弃。

### 4.4 「只有 P1 会造成假绿」——这句话上一版写错了

上一版称 P1 是唯一可能造成假绿的改动。**不对**,§2.4 那个洞正好证明了反例:

- **P0** 放宽后缀白名单,如果 sweep 漏掉某个后缀的唯一 CI 消费者,就会跳过那条守卫 ——
  **和 §2.4 一模一样的失败形状**。风险低但**不是零**,由 P-1 的清单和守卫兜。
- **P3** 如果 artifact 身份/内容错了,会测到不是这次的代码 —— 这正是它要加树摘要指纹的原因。
- **P1** 仍然是三者中**最高**的分类器风险,但不是唯一的。

### 4.5 一个新发现:P1 的基线信息**拿不到**(实测)

P1 要求「基线时的 base SHA 与 `ci.yml` 与现在一致」。我实测了能不能从 API 事后恢复这些:

对 open PR #922 的历史 run 逐条查:
- 顶层 `head_sha` **是历史值**(每个 run 不同)✅ 可用;
- 但 `pull_requests[0].head.sha` 和 `.base.sha` 在**每一个历史 run 上都已经变成 PR 的当前值** ❌

也就是说 **run 里内嵌的 PR 关联对象是一个活指针,不是当时的快照**。
⇒ **P1 不能靠事后查 API 恢复运行时的 base 环境,必须在全绿那一刻自己写下一个持久标记。**
这把 plan 里原来「或者用持久标记」的可选项变成了**必选项**,细节见 plan P1。

### 4.6 一眼看上去能省、实测不能省的

| 候选 | 实测结论 |
|---|---|
| pnpm / 依赖缓存命中率 | 已经很好,占 1.4%,**没有可省空间** |
| 并发去重覆盖 | 已全覆盖并在生效,**不需要改** |
| runner 超配 | 100% `ubuntu-latest`,**不存在超配** |
| `ship-on-comment` 长等待 | 占 0.2%,**猜错了,不要投入** |
| `CI OK`(每 run 起一台机器跑 6 秒 jq) | 分支保护要求的唯一 check,**不能删** |
| 「doc 前缀下一律惰性」 | **已否决**,见 §2.4 —— 前提被两个真实反例证伪 |

## 5. 自托管 runner:可行性判断

### 5.1 先纠正我自己在上一版里写错的价格

上一版我写「自托管从 2026-03-01 起按 $0.002/分钟收费」。**这是错的。**

GitHub 2025-12-16 的公告确实宣布过这件事,但**该公告顶部有一条后续更新把它推迟了**:
> "We're postponing the announced billing change for self-hosted GitHub Actions to take time
> to re-evaluate our approach."

我上一版读到了公告正文和 2025-12-17 的社区讨论,**漏了置顶的那条更新**——
典型的「结论靠惯性活着」:找到一个支持性来源就停了,没有回头核它有没有被后续覆盖。
感谢 Codex design review 逐条查证抓出来。

**现状:自托管 runner 目前仍然免费。** 但「推迟」不是「取消」,GitHub 明说了要
re-evaluate,所以**任何建立在「自托管永远免费」上的规划都带一个不受我们控制的风险**。

修正后的账:自托管可以规避掉几乎全部托管 runner 分钟 —— 按 §1.1 的现行口径情景值是 **≈$1,104/月**
(不是区间,§1.1 说明了为什么给不出区间),比上一版说的 $450 大得多。这让「不做」这个结论更需要站得住脚。

### 5.2 结论:**现在不要做**,理由是信任边界,不是我上一版写的那个

我上一版写「Script Tests 里的 FLY-1364 / 1663 / 1814 / 1929 直接操作生产 tmux / launchd /
`~/.flywheel`」。**这条我查错了,现予撤回。** 实读 `scripts/test-cmux-sync.sh`:
它用 `mktemp -d` 起私有 socket(`tmux -S "$TMUX_INT_SOCKET"`),不碰默认 server;
`launchd-units-manifest.test.sh` 是静态清单合同测试,根本不调 `launchctl`。
**这些测试是按 hermetic 设计的。**

真正站得住的理由有两条,而且都是无条件成立的:

1. **信任边界**。自托管 runner 在一台**非一次性**的机器上执行**仓库/PR 里的任意代码**,
   而这台机器上有生产凭据(`~/.flywheel/.env`、Discord bot token、Codex/Claude 凭据)和
   16 个在跑的 Lead。GitHub 官方明确警告自托管 runner 可被 workflow 代码持久化攻陷,
   **私有仓也一样**(<https://docs.github.com/en/actions/reference/security/secure-use>)。
   「只跑 Unit 矩阵」**不解决这条**——build 和 unit test 同样是仓库里的任意代码。
2. **资源争抢——是个取舍,不是绝对**。维持今天的反馈速度需要**最多 9 个并发 runner 槽**。
   这台机器是 Mac17,8 / 18 核 / 48 GB,当前 `load average 5.93 / 6.40 / 7.25`、**57 个 tmux 会话**,
   而 FLY-1986 还要在同一台机器上做压测(issue 已点出这个负载预算冲突),且机器有过卡死事故(FLY-1887)。
   把自托管并发**上限压到 9 以下**可以缓解争抢,但代价是排队和更长的反馈——
   **省钱和反馈速度在这里是直接对冲的**,不能两个都要。

另外保留一条**明确标记为弱**的旁证(不作为主论据):ambient 命名空间和宿主级协调很容易做错。
FLY-1482 是 QA teardown 与生产 cmux watcher 抢 lease,FLY-1681 是生产 terminal MCP 继承了 `TMUX`
打到错的 server。
⚠️ **这两起都不是「CI 测试从自己的 hermetic 沙箱里逃出来」,所以它们证明不了当前这批 CI 套件会逃逸。**
主论据(信任边界)不依赖这条,这条只是提醒这类边界历史上确实漏过。

| 方案 | 省 | 风险 | 判断 |
|---|---|---|---|
| 在 founder 的生产机上跑自托管(任何子集) | ≈ $1,104/月(§1.1 的情景值) | **高**:PR 代码 + 生产凭据同机 | ❌ 不做 |
| 专用的一次性/短命 runner(独立机器或容器,不放凭据) | ≈ $1,104/月 − 机器成本 | 低 | ⏸ 只有在 §4 那几刀砍完还嫌贵时才评估,且必须等 FLY-1986 定完负载预算 |

**顺序建议**:§4 的 P0/P1/P3 不需要动任何生产机器,先做它们。

---

## 6. 怎么跟真实账单对账(这一步必须有人做,我做不了)

1. 打开 <https://github.com/settings/billing> → Usage,看 **Actions minutes** 的本月数。
2. 与 §1.1 的**情景值**(约 183,930 分钟/月)比 —— 注意那是**繁忙窗口**的折算,
   真实月份低于它是正常的。无论差多少,§1.2~§1.5 的**比例**拆分都可直接用
   ——它们是同一把尺子量出来的相对值,不受总量标定影响。
3. 若真实值明显**高于**这个折算值,先怀疑我的取整规则(§0),再怀疑拆分;**低于**它是正常的。

⚠️ **上一版我在这里给了过时的建议**:我写「给 token 加 `user` scope 就能调
`GET /users/{u}/settings/billing/actions`」。GitHub 已于 2025-09-26 **关停了按产品分的
billing API**,换成合并后的用量端点(`/users/{username}/settings/billing/usage`),
且受 enhanced billing 可用性与 Plan 读权限限制。
**所以不要因为这条去让 founder 放宽 token** —— 先确认账户层级、enhanced billing 是否可用、
以及最小需要什么权限。**上面第 1 步的手动 Billing → Usage 页面始终有效,那才是当前推荐路径。**

---

## 7. 汇总

**现状**:半开区间窗口(48h,现行口径)折月 **183,930 分钟 ≈ $1,104/月**。
⚠️ 这是**繁忙窗口的情景值,不是区间也不是典型月**;§1.1 说明了为什么给不出区间。

| # | 动作 | 建模额度(分钟/30天) | ≈$/月 | **这个数是什么** | 风险 | 前置 |
|---|---|---|---|---|---|---|
| **P-1 = FLY-1996** | 堵 §2.4 的快车道安全洞 | **0(不是省钱单)** | — | — | 低 | **最先做** |
| P3 | 构建一次,artifact 跨 job 复用 | 28,230 | **$169** | **毛的**建模计费分钟差 —— **既不是净省也不是上限**,未减新增生产者 job 开销与 artifact 传输(§4.3) | 中(假绿) | 先量 |
| P1 | classify 增量判据(严格版) | ≤ 19,380 | **≤ $116** | **净省的上限**(毛额−反事实),两条前提未验 | 中—高 | P-1 + 基线标记可行性(§4.5) |
| P0 | classify 后缀白名单补惰性类型 | 本窗口 **0 样本** | **无实测额度** | 偶发;证据来自窗口外的 PR #874 | 低但非零 | P-1 |
| — | 自托管 runner | ~183,930 | ~$1,104 | — | **高**(信任边界) | ❌ 不在生产机上做 |
| — | doc 前缀一律惰性 | — | — | — | — | ❌ **已否决**(§2.4) |

### 7.0 P3 排在 P1 前面 —— 理由**不是**「数更大」

🔴 **$169 和 $116 不能比大小。** $169 是 P3 的**毛**建模计费分钟差(**未减**新增生产者 job 自己的
checkout/setup/install 与 artifact 上传下载);$116 是 P1 的**净省上限**(毛额 − 反事实)。
**两个不同口径的数放在一起比,是我在 R12/R13 被抓出来的错误。**
在 P3 的开销真正量出来之前,**P3 的净值完全可能低于 P1**。

排序只靠两条**与金额无关**的理由:

1. **P3 不碰分类器语义。** 它的失败形状是「artifact 陈旧 → 测到的不是这次的代码」,
   可以用一个**树摘要指纹**钉死(用之前重算比对,不符即 fail-closed)。
   P1 改的是「**什么可以不跑**」,它的失败形状是**静默漏测** —— 测试没跑、CI 还是绿的,
   正是 §2.4 那个洞的形状,也是最难被发现的一类。
2. **P1 还有一个未解决的可行性前提**(P1-a 基线标记 spike,§4.5):
   运行时的 base 环境事后**拿不回来**,必须在全绿那一刻自己写下持久标记。
   **在 spike 出结论前,P1 根本不可实施**;而 P3 现在就能开工(第一步是量)。

### 7.1 「砍完还剩多少」这句话该怎么说 —— 上一版说错了

上一版我写「最好情况下账单不会低于 $850/月,真实值只会更高」。**那是错的**,R6 指出两点:

1. **它是拿「最忙的 48 小时」折月得到的上沿再去减**,所以它是**这个窗口的情景值**,
   不是任何月份的下界。**Actions 的花费直接随工作量走**:窗口内两天分别是 6,037 / 6,225 分钟
   (现行台账口径),而这两天是**近两周的高位** —— **工作量回落本身就能把账单压到建模残值以下,
   不需要任何优化**。
   ⚠️ **这一点只能定性说,不能给幅度**:§1.1 里 7/14/29 天那几行出自已知有缺陷的旧采集器
   (漏计重跑 + 并发写损坏),**系统性偏低、不是账单估计**;拿它们去量化「能低多少」
   等于用坏尺子量好尺子的结果。要给幅度,得先用现行采集器重跑一个更长的窗口。
2. **P3 那条不是上限**(§4.3),所以「真实值只会更高」这个方向断言也不成立。

**能站住的说法只有这一句**:

> 把这个异常繁忙的 48 小时窗口折算成 30 天,**并且**假设 P1、P3 两个乐观情景都完全兑现,
> 建模出的残值约 **$818/月**。**它既不是账单下界,也不是预测。**

真实账单主要由**工作量**决定,而工作量在这两天处于近两周的高位。

**另一个不好听但重要的观察**:即便在这个高位窗口里,两条杠杆加起来也只把建模残值从
$1,104 拉到 $818。剩下的大头在④档(337 个尝试、毛额 9,893 分钟),而**那一档不全是
不可压缩的测试成本** —— 它同时含着取消、失败、setup 等开销。
如果 founder 要的是数量级下降,**这几条优化给不了**;那要回到「这些测试是不是每次 push
都必须跑」,而那个问题的答案见 §8 第 4 条,现在**没有证据支持去砍它**。

## 8. 明确「不该省」的

1. **`push: main` 的那一轮全量 CI(30 天 9,058 分钟)。**
   分支保护 `strict: false` —— PR 不需要与最新 main 同步就能合并。
   **这轮 main CI 是唯一能抓到语义合并冲突的地方**,砍掉等于把「合并后才炸」留给生产。
2. **`Quick Gate` 常开(不挂 `needs`)。**
   它里面有 `ci-structure.test.sh` 等治理守卫——改 CI job 图和 skip 语义的合同就靠它。
   把它挂到别的 job 后面,等于让「改 classify 规则」可以绕过自己的守卫。
   本文窗口实测 **1,466 分钟/48h ⇒ 折月 21,990 分钟 ≈ $132/月**
   (来自窗口 job 快照的**物理执行**;台账是**尝试**维度、没有 job 维度,所以这个数由 `aggregate.mjs` 从同一份 raw 聚合打印)。
   **这笔钱是买保险,该花。**
3. **`CI OK`。** 分支保护要求的唯一 check,不能动。
4. **那批慢的真机测试(FLY-1364 / 1663 / 1814 / 1929 / 1434 / 1501)。**
   它们是最贵的一块,也是最不该按路径裁的一块:记忆里反复出现的教训是
   「跨层接缝的故障不在被改的那层」(FLY-1482 / 1596 / 1672 都是这样被抓到的)。
   按路径触发的前提是「改 A 不会影响 B」,而这批测试存在的理由恰恰是那个前提不成立。
   **要砍,先要有证据说明哪些接缝已被别的手段覆盖;没有证据就不砍。**
   §2.4 那个洞正是「按路径裁」出问题时的样子:测试没跑,CI 还是绿的。
5. **`ship-on-comment` 的等待。** 只占 0.2%,换来的是 ship 前的 exact-head CI 判决。

---

## 9. 本文的保质期(哪些结论会先失效)

| 结论 | as-of | 什么会让它失效 | 怎么重核 |
|---|---|---|---|
| 现状窗口 = 半开区间 `[08-20T00Z, 08-22T00Z)`(v2 classifier) | 2026-08-22 | 再改 `ci-classify.sh` 或 `ci.yml` job 图 | `git log --follow scripts/ci-classify.sh` 取新分界,重跑附录 A.2 → A.1 |
| 用量情景值 183,930 分钟/月(**不是区间**) | 2026-08-22 | 用量在加速,且 48h 窗口罩住了最忙两天 | 重跑附录 A.2,换更长窗口交叉看 |
| 快车道命中率 **34.7%**(窗口,严格判据) | 2026-08-22 | 改白名单;**P-1 落地后应当下降一点(那是对的)** | `node data/aggregate.mjs` |
| §2.4 安全洞存在 | 2026-08-22 | P-1 落地后应消失 | `grep -n 'FLY-222-a0-a10-runbook' scripts/__tests__/launchd-units-manifest.test.sh` + 查白名单 |
| §4.5 PR 关联元数据是活指针 | 2026-08-22 | GitHub 改 runs API 语义 | 附录 A.4 的对比查询 |
| 单价 $0.006/min | 2026-08-22 | GitHub 再调价 | docs.github.com/en/billing/reference/actions-runner-pricing |
| **自托管目前免费(收费被推迟)** | 2026-08-22 | GitHub 结束 re-evaluate 后重新启用 | 重读 2025-12-16 changelog **顶部的更新条** |
| `ci.yml` 里 classify 步骤名/注释仍说「latest green baseline」 | 2026-08-22 | v2 实际是 merge-base 全量 diff,**注释是陈旧叙述**;P-1 或 P1 应顺手改正 | `sed -n '27,50p' .github/workflows/ci.yml` |
| §8 里 Quick Gate 的 $132/月 | 2026-08-22 | 窗口变、job 构成变 | 用附录 A.2 的 `jobs.jsonl` 按 job 名重新求和(台账无 job 维度) |
| FLY-1911 / FLY-1846 是头部消耗方 | 2026-08-22 | 两条分支合并后自然消失 | 重跑 §1.6(需 30 天快照) |
| 生产宿主 load 5.9~7.3 / 57 会话 | 2026-08-22 | 舰队规模变化、FLY-1986 压测开跑 | `uptime` + `tmux ls` |

---

## 附录 A — 复现

### A.1 已随本单入库的产物

| 文件 | 是什么 |
|---|---|
| `data/raw/runs.jsonl` | **原始快照**:窗口内 614 个 run(含 `run_attempt`、head commit 首行) |
| `data/raw/jobs.jsonl` | **原始快照**:5,019 条 job 记录,来自 `?filter=all`;每条带 `job_id`、`run_attempt`、`build_step_sec`(名为 `Build` 的步骤真实秒数)。⚠️ 其中 85 条是**被带进新 attempt 的旧执行**(新 `job_id`、旧时间戳),按物理执行去重后不计费(§0.1.4) |
| `data/raw/attempts.jsonl` | **原始快照**:15 个多-attempt run 的 32 个权威 per-attempt 对象(`GET /runs/{id}/attempts/{n}`),提供 per-attempt 的 `conclusion` 与 `run_started_at` |
| `data/raw/prfiles.tsv` | **原始快照**:各分支 PR 的文件清单(P0 分档的输入) |
| `data/raw/SHA256SUMS` | 上面四份 + 三个脚本 + `ledger.csv` 的校验和(路径相对**本 issue 文件夹**) |
| `data/derive-lib.mjs` | **唯一的推导实现**。计费公式、快车道判定、合格全绿、P0/P1 谓词、PR-only 闸、重复构建量 —— 全在这里 |
| `data/derive.mjs` | 薄壳:`raw → ledger.csv` |
| `data/ledger.csv` | 派生台账,**按 `(run, run_attempt)` 一行**,631 行(含 API 未返回 job 的那次 attempt) |
| `data/aggregate.mjs` | **验证 + 聚合** |

```bash
cd engineering/doc/FLY-1987-actions-cost-audit
shasum -a 256 -c data/raw/SHA256SUMS         # 快照与脚本未被改动
node data/derive.mjs data/raw /tmp/re.csv    # 从入库快照重新派生
diff /tmp/re.csv data/ledger.csv             # 期望:无差异(实测逐字节相同)
node data/aggregate.mjs                      # 验证并打印 §1.2~§1.5 与 §4
```

#### A.1.1 校验器为什么不是「加法器」——它重算,不是对标签

上一版的 `aggregate.mjs` 检查的是**标签之间是否自洽**(bucket 与 event 对不对得上、
基线引用解不解析得开)。R5 证明这挡不住**编造**:四个一格突变
——把一行的 `commit_label` 从 `docs` 改成 `code`、把一行改成 `2_P0`、
`billed_min += 100`、把 `is_full_green` 从 `false` 翻成 `true`——
**全部 exit 0 并打印「all structural invariants passed」**,同时把头条数字挪动了。

现在的做法是:**`aggregate.mjs` 拿 `derive-lib.mjs` 把 `data/raw` 整个重算一遍,
与台账逐行逐字段比对,不等就退出。** 产出台账的实现和校验台账的实现是**同一份代码**,
不存在第二份会漂移的「检查用副本」。任何一格不是从原始数据推出来的,都会被结构性拒绝。

**突变实测**(2026-08-22,全部 `exit 1`;未改动台账 `exit 0`):

*台账侧(一格改动)*

| 突变 | 报出的第一条 |
|---|---|
| `billed_min += 100` | `billed_min="106" but re-derivation gives "6"` |
| `commit_label` docs→code | `commit_label="code" but re-derivation gives "docs"` |
| `conclusion` success→failure | `conclusion="failure" but re-derivation gives "success"` |
| `carried_min` 清零 | `carried_min="0" but re-derivation gives …` |
| 抬高 `p3_billed_min` | `p3_billed_min="99" but re-derivation gives "0"` |
| `4_must_run_full` → `3_P1_upper` / `2_P0` | `bucket=… but re-derivation gives "4_must_run_full"` |
| 翻转 `fast_path` / `is_full_green` | `… but re-derivation gives …` |
| 伪造 `workflow` / `event` | 同上 |

*原始数据侧*

| 突变 | 结果 |
|---|---|
| 在一个合格全绿 attempt 里**再加一条同名但失败的 `Unit (heavy)`** | `exit 1`(R6 finding 3:旧版本用名字集合会吞掉重数,照样判绿) |
| 把一个 `Quick Gate` job **改名** | `exit 1` —— 已知 job 名单闸拦住(R6 finding 6:改名会挪动 §1.3.1/§8 却不动任何台账字段) |

把某个合格全绿尝试里的 `Script Tests 1/2 — cmux/session (shell suites)` 改名成
`Script Tests forged substitute`,合格全绿数从 **51 → 50**,那一个尝试被正确拒绝。

**一个不可能变红的检查不是检查。**

#### A.1.1.1 这套机制**证明什么、不证明什么**(R6 finding 6)

| 机制 | 证明的 | **不**证明的 |
|---|---|---|
| Git commit(冻结 head) | 评审看到的字节此后没被改过 | 这些字节一开始是不是真的 |
| `SHA256SUMS` | 快照/脚本/台账没有被就地改动 | **它不自证** —— 同时更新原始数据、台账和这份清单,三者依然全部通过 |
| `aggregate.mjs` 重算比对 | 台账的每一格都**从选定的这份原始快照**推得出来 | 这份原始快照**来自 GitHub** |
| 已知 job 名单闸 | 快照里没有本文没见过的 job 名 | 时间戳/结论层面的伪造 |

**合起来的边界一句话:Git + 校验和管「冻结后没被改」,重算比对管「台账与原始数据内部一致」,
两者都不认证「原始数据来自 GitHub」。** 要认证来源,只能拿附录 A.2 重新抓一次再 diff。
这不是缺陷,是**必须写清楚的边界** —— 否则「10 条突变全红」会被读成比它实际更强的保证。

#### A.1.2 入库产物**复现不了**什么(诚实边界,别照抄成「全部可复现」)

| 本文内容 | 能否复现 | 为什么 |
|---|---|---|
| §1.2 / §1.3 / §1.4 / §1.5 各表、§4 台账、命中率、成本模型 | ✅ | 就是 `aggregate.mjs` 的输出 |
| §1.3.1 的 job 表、§8 的 Quick Gate $132/月 | ⚠️ `aggregate.mjs` **会打印**,但它是**聚合**不是重算 | 没有任何台账字段依赖 job 名,所以互换两个**已知**名字(如 `Unit (heavy)`↔`Unit (light)`)动得了这张表却动不了台账。跑默认 `data/raw` 时会**先核已提交的校验和**再打印;指定别的 raw 目录时表下会印一行「未经清单核验」 |
| §1.1 的 7 / 14 / 29 天行 | ❌ | 需要 30 天快照;且它们来自旧采集方式,系统性偏低(§1.1 脚注 †) |
| §1.6 的 30 天分支表 | ❌ | 同上 |
| §3 步骤级构成(14 次抽样) | ❌ | 那是另一批 run 的 `.steps[]` 抽样,不在本快照里 |
| §0.2 的 v1/v2 命中率两行 | ❌ | 旧判据、旧窗口算的,只用于看方向 |
| **P0 分档是否正确** | ⚠️ 部分 | 依赖 PR **最终**文件清单(§0.1 第 3 条),且 `prfiles.tsv` **只有路径没有 mode** —— 真 classifier 还会拒 symlink/gitlink,所以 P0 判定是**又一层上限近似**。本窗口该档为 0,影响为零 |
| **P1 分档是否正确** | ⚠️ 只到上限 | 基线引用会被重算校验,但**增量 diff 惰性**与 **base SHA / `ci.yml` 未变**这两条仍**没有验证**,所以按定义是上限(§4.2) |
| **P3 金额是否是净省** | ⚠️ 既不是上限也不是下限 | 重复 `Build` 秒数是真量的;省下的计费分钟是**按 job 整分钟建模**出来的(§4.3),**没有减去**新增生产者 job 自身开销与 artifact 传输,且随所选设计变 |

台账不含敏感内容:无 commit message 原文、无 token、无 URL。
`commit_label` 是从 message 首行前缀归类后的枚举值 —— 这正是 §1.5 强调「量的是标签不是文件」的原因。

### A.2 从 GitHub 重新生成原始快照

需要 `gh` 已登录且有 `repo` scope。runs API 的 `created=` 只到日期粒度,
所以**先按日期宽取、再由 `derive.mjs` 按精确时间戳裁到半开区间**。

```bash
set -euo pipefail          # 不加这行,任何一步抓失败都会被后面的步骤当成「数据就是这样」继续算下去
REPO=xrliAnnie/flywheel
RAW=./raw ; mkdir -p "$RAW/j"

# GitHub 的时间戳可能带毫秒,也可能带 ±HH:MM 偏移;`fromdateiso8601` 两种都不吃。
# ⚠️ **不能**把偏移直接换成 Z —— 那是把同一个墙钟时间重新当成 UTC,不是换算。
#    实测反例:2026-03-08T01:59:00.000-08:00 → 03:01:00.000-07:00 真实跨度 120 秒,
#    "换成 Z" 的写法会算成 3,720 秒,而这个数会喂进 build_step_sec 再喂进 P3。
# 必须**语义换算**:先剥小数秒,带偏移的减去偏移秒数。
TT='def tt:
  sub("\\.[0-9]+";"") as $t
  | if ($t | test("[+-][0-9][0-9]:[0-9][0-9]$"))
    then ($t | capture("^(?<b>.*)(?<sg>[+-])(?<h>[0-9]{2}):(?<m>[0-9]{2})$"))
         | (((.b + "Z") | fromdateiso8601)
            - ((if .sg == "+" then 1 else -1 end) * ((.h|tonumber) * 3600 + (.m|tonumber) * 60)))
    else ($t | fromdateiso8601)
    end;'
# 自检(跨偏移 120 / 纯 Z 60 / 毫秒 90 / 同一瞬间 0):
jq -n "$TT (\"2026-03-08T03:01:00.000-07:00\"|tt) - (\"2026-03-08T01:59:00.000-08:00\"|tt)" \
  | grep -qx 120 || { echo "aborting: tt 时间换算不正确"; exit 1; }

# A2-1 workflow id(本仓当前 5 个)
gh api /repos/$REPO/actions/workflows --jq '.workflows[] | "\(.id)\t\(.name)"'
#   247217367 CI / 254044724 Ship on :cool: Comment / 311485865 Payload Beta Release
#   311485866 Payload Promote (prepare) / 315672678 Payload Distribution Activation

# A2-2 run 清单。必须带 run_attempt(台账按尝试计行)。
for wf in 247217367 254044724 311485865 311485866 315672678; do
  gh api --paginate \
    "/repos/$REPO/actions/workflows/$wf/runs?created=2026-08-19..2026-08-23&per_page=100" \
    --jq '.workflow_runs[] | {id: (.id|tostring), name, event, head_branch, conclusion,
                              run_attempt, created_at,
                              subj: (.head_commit.message | split("\n")[0])}'
done > "$RAW/runs_wide.jsonl"
# ⚠️ 不要写 `run_attempt: (.run_attempt // 1)`。那个 `// 1` 会在校验器看到之前就**抹掉证据**:
#    一旦被盖成 1,后面分不清「API 真给了 1」和「我自己编了个 1」,一次真重跑就被塌回 attempt 1。
#    缺就停,不要补默认值。
jq -e -s 'all(.[]; (.run_attempt|type=="number"))' "$RAW/runs_wide.jsonl" >/dev/null \
  || { echo "aborting: 有 run 没有 run_attempt,不能默认成 1"; exit 1; }
# 裁到半开区间 —— 入库快照恰好是这 614 条,不裁就对不上
jq -c 'select(.created_at >= "2026-08-20T00:00:00Z" and .created_at < "2026-08-22T00:00:00Z")' \
   "$RAW/runs_wide.jsonl" | sort -u > "$RAW/runs.jsonl"

# A2-3 job 级。三个坑都必须照做(§0.1.0 / §0.1.3 就是踩了这三个):
#   ① filter=all —— 默认只给最新一次尝试,而 GitHub 每次重跑都计费;
#   ② 每个 run 落一个独立文件再合并 —— 多进程并发 >> 同一个文件会交错损坏;
#   ③ 不要丢 .steps[] —— P3 要读名为 `Build` 的步骤的真实秒数。
#   ④ **绝不给 job 的 run_attempt 补 `// 1`**(同上:补了就分不清真假)。
#      多-attempt 的 run 改用**按尝试**的端点,attempt 号从**请求路径**盖上去,不靠响应体:
#         GET /repos/{o}/{r}/actions/runs/{id}/attempts/{n}/jobs
#      单-attempt 的 run 才可以用 ?filter=all 的全量端点。
jq -r .id "$RAW/runs.jsonl" | sort -u | while read -r id; do
  [ -s "$RAW/j/$id.json" ] && continue
  gh api "/repos/$REPO/actions/runs/$id/jobs?per_page=100&filter=all" > "$RAW/j/$id.json.tmp" \
    && mv "$RAW/j/$id.json.tmp" "$RAW/j/$id.json"
done
# 完整性自检:jobs 条数必须等于 min(total_count,100);>100 说明需要翻页。
# fail-closed —— 不完整就停,不要继续往下算(R6 finding 7)。
# ⚠️ 判据必须是 total_count<=100 且 jobs.length==total_count。
#    写成 length == min(total_count,100) 是**假的守卫**:total_count=101、只拿到 100 条时它返回真。
incomplete=0
for f in "$RAW"/j/*.json; do
  jq -e '.total_count <= 100 and (.jobs|length) == .total_count' "$f" >/dev/null \
    || { echo "INCOMPLETE(需要翻页) $f"; incomplete=1; }
done
[ "$incomplete" -eq 0 ] || { echo "aborting: incomplete job pagination"; exit 1; }

# A2-3b 权威 per-attempt run 对象(只有 run_attempt>1 的 run 需要)。
#   runs.jsonl 只存最新一次的结论,拿它当每个 attempt 的结论是错的(§0.1.4 第 2 条)。
mkdir -p "$RAW/att"
jq -r 'select(.run_attempt > 1) | "\(.id) \(.run_attempt)"' "$RAW/runs.jsonl" |
while read -r id n; do
  for a in $(seq 1 "$n"); do
    [ -s "$RAW/att/${id}_${a}.json" ] && continue
    gh api "/repos/$REPO/actions/runs/$id/attempts/$a" \
      --jq '{id:(.id|tostring), run_attempt:.run_attempt, conclusion:.conclusion,
             status:.status, run_started_at:.run_started_at}' > "$RAW/att/${id}_${a}.json"
  done
done
jq -c '{run_id:.id, run_attempt, conclusion, run_started_at}' "$RAW"/att/*.json | sort \
  > "$RAW/attempts.jsonl"
# fail-closed:attempts 必须恰好是 {多-attempt run} × {1..run_attempt},且每条都有 conclusion
want=$(jq -r 'select(.run_attempt > 1) | .id as $i | .run_attempt as $n
              | [range(1; $n+1)] | .[] | "\($i)#\(.)"' "$RAW/runs.jsonl" | sort)
got=$(jq -r '"\(.run_id)#\(.run_attempt)"' "$RAW/attempts.jsonl" | sort)
[ "$want" = "$got" ] || { echo "aborting: attempts.jsonl 与所需集合不符"; exit 1; }
# ⚠️ 用**肯定式** all(...) 断言。写成 `select(bad) | halt_error(1) … || true` 是**死断言**:
#    「没有选中任何行」和 halt_error 都是非零,而尾部的 || true 把两者一起吞掉。
jq -e -s 'all(.[]; (.conclusion|type=="string") and (.run_started_at|type=="string"))' \
   "$RAW/attempts.jsonl" >/dev/null || { echo "aborting: attempts 缺字段"; exit 1; }
# 归一化:保留 run_attempt,并把 `Build` 步骤的秒数抽成 build_step_sec
# 多-attempt run:逐 attempt 抓,attempt 号来自路径(不信响应体)
jq -r 'select(.run_attempt > 1) | "\(.id) \(.run_attempt)"' "$RAW/runs.jsonl" |
while read -r id n; do
  for a in $(seq 1 "$n"); do
    # ⚠️ 这个端点同样分页(每页最多 100)。只取第一页会静默少 job —— 实测漏掉一个 7 分钟的 job,
    #    整条链照样 exit 0,总量从 12,262 掉到 12,255。所以先断言不需要翻页。
    gh api "/repos/$REPO/actions/runs/$id/attempts/$a/jobs?per_page=100" > "$RAW/att_jobs.json"
    jq -e '.total_count <= 100 and (.jobs|length) == .total_count' "$RAW/att_jobs.json" >/dev/null \
      || { echo "aborting: run $id attempt $a 的 jobs 需要翻页"; exit 1; }
    # ⚠️ `jq -c "$TT" '<prog>'` 是错的:jq 会把第二个字符串当成**输入文件**,报
    #    "Top-level program not given"。TT 必须和主表达式拼成**同一个** program 字符串。
    jq -c "$TT"' .jobs[] | {run_id:$rid, job_id:(.id|tostring),
          run_attempt:$a, name, conclusion, started_at, completed_at,
          build_step_sec: ([ .steps[]? | select(.name=="Build")
                             | select(.started_at != null and .completed_at != null)
                             | ((.completed_at|tt) - (.started_at|tt)) ]
                           | map(select(. > 0)) | max // 0 | floor)}' \
      --arg rid "$id" --argjson a "$a" "$RAW/att_jobs.json"
  done
done > "$RAW/jobs_multi.jsonl"

jq -c "$TT"' (input_filename|split("/")|last|rtrimstr(".json")) as $rid
       | .jobs[]
       | { run_id: $rid, job_id: (.id|tostring), run_attempt, name, conclusion,
           started_at, completed_at,
           build_step_sec: ([ .steps[]? | select(.name=="Build")
                              | select(.started_at != null and .completed_at != null)
                              | ((.completed_at|tt) - (.started_at|tt)) ]
                            | map(select(. > 0)) | max // 0 | floor) }' \
   "$RAW"/j/*.json \
  | jq -c --slurpfile multi "$RAW/jobs_multi.jsonl" \
        'select([.run_id] | inside([$multi[].run_id]) | not)' \
  | cat - "$RAW/jobs_multi.jsonl" > "$RAW/jobs.jsonl"
# 单-attempt run 用全量端点的结果,多-attempt run 用按尝试端点的结果 —— 后者的 attempt 号来自路径
#   total_count==0 的 run 是「任何 job 启动前就被 concurrency 取消」,计费真 0;
#   derive.mjs 会给它保留一行 billed_min=0,不要在这一步丢掉(§0.1.1)。

# A2-4 PR 文件清单(P0 分档用;§0.1 第 3 条那个近似的来源)
jq -r 'select(.event=="pull_request") | .head_branch' "$RAW/runs.jsonl" | sort -u |
while read -r b; do
  pr=$(gh pr list --repo $REPO --state all --head "$b" --json number --jq '.[0].number')
  [ -n "$pr" ] || continue
  gh api "/repos/$REPO/pulls/$pr/files?per_page=100" --paginate --jq '.[].filename' |
    sed "s#^#$b\t#"
done > "$RAW/prfiles.tsv"

# 注意第二个参数:不传的话 aggregate 会去比对**入库的** data/raw,而不是你刚抓的这份
node data/derive.mjs "$RAW" /tmp/new-ledger.csv && node data/aggregate.mjs /tmp/new-ledger.csv "$RAW"
```

### A.3 口径定义(`derive-lib.mjs` 里逐条对应)

```
物理执行 = 同一个 run 内 (name, started_at, completed_at) 的首次出现
   ⚠️ 「只重跑失败的 job」会把已成功的 job 原样带进新 attempt:**新 job_id、旧时间戳**。
      那不是新执行也不再计费。job_id 无法区分(本快照 5,019 条 id 全不同)。

billable(job) = (conclusion == "skipped") ? 0
                                          : ceil((completed_at - started_at) / 60s)
billable(尝试) = Σ billable(该尝试的**物理执行**)    # 带进来的记录进 carried_min,不计费
                                                     # 无 job 的 attempt 保留一行 = 0
attempt 的 conclusion / 起始时刻 = attempts.jsonl 的权威值(多-attempt run);
                                   单-attempt run 用 run 级值
折月           = 窗口分钟 × (720h / 窗口小时数)      # 本文窗口 48h ⇒ ×15
美元           = 折月分钟 × $0.006                    # Linux 2-core,2026 现价

fast_path(尝试) ⟺ 同一尝试内 `Classify CI scope` 成功
                 ∧ `NPM payload distribution (endpoint + release pipeline)` 被 skipped
   ⚠️ 只看 payload 被 skip 是错的:payload 挂 `needs: [classify]`,classify 自己失败时
      它同样 skip,那不是 no_code 决定(R5 finding 1;快照里 20 个假阳性)。
   ⚠️ 也不能改用 Unit 矩阵判:矩阵被 skip 时会塌缩成一条 `Unit (${{ matrix.name }})`。

full_green(尝试) ⟺ run 是 CI / pull_request
                  ∧ 8 个重 job 的**精确名字各恰好出现一条记录**且全部 success
                    (**数记录不数名字**:去重的名字集合会吞掉「同名再来一条失败记录」,R6 finding 3)
                  ∧ `CI OK` 恰好一条 success,`Classify CI scope` / `Quick Gate` 各恰好一条
                    (5 个 Unit shard + `Script Tests 1/2 — cmux/session (shell suites)`
                     + `Script Tests 2/2 — fleet/setup/packaging (shell suites)`
                     + `NPM payload distribution (endpoint + release pipeline)`)
                  ∧ 不存在名字像重 job 但不在这 8 个里的 job(防伪造名字,R5 finding 6)
                  ∧ 不存在 `Unit (${{ matrix.name }})` 塌缩哨兵
                  ∧ `CI OK` success
   ⚠️ 少了 `CI OK` 那一条,失败的 run 会被当绿基线(R4);
      用 startsWith 数个数,伪造的 job 名照样过(R5)。

dup_build_sec(尝试) = Σ(物理执行的 `Build` 步骤秒数) − 最大的那一份    # MEASURED,留一份作生产者
p3_billed_min(尝试) = min(billed_min,
                          Σ_{除生产者外的每个 job} [ ceil(时长/60) − ceil((时长−构建秒)/60) ])
   ⚠️ INFERRED,**不是上限**:GitHub 按 job 向上取整,去掉 2 秒可能省下整整 1 分钟,
      所以「秒数 ÷ 60」方向都不定(R6 finding 4)。且未减生产者 job 自身开销与 artifact 传输。

分档顺序(互斥,每个尝试只落一档):
   workflow != CI                                    -> non_ci
   fast_path                                         -> 1_already_fast
   event != pull_request                             -> 4_must_run_full   ← PR-only 闸
   PR 文件全在 doc 前缀 且 现有∪P0 后缀
       **且至少一个文件用 P0 新增后缀**              -> 2_P0
       (少了后半条就是「P0 之后仍合法」而非「靠 P0 才被救」—— R4 finding 2)
   分支已有 full_green 且 head 标签是 docs/progress  -> 3_P1_upper(上限谓词)
   其余                                              -> 4_must_run_full

反事实(档) = Σ min(billed_min, 快车道成本模型)
   快车道成本模型 = 完成态快车道尝试的 billed_min 中位数(本窗口 = 6 分钟)
净省          = 毛额 − 反事实
```

### A.4 其它一次性事实的复核命令

```bash
REPO=xrliAnnie/flywheel

# classifier 版本分界(§0.2)
git log --follow --format='%h %cI %s' -- scripts/ci-classify.sh

# 分支保护(§2.5 / §8 依赖它)
gh api /repos/$REPO/branches/main/protection --jq '.required_status_checks'

# §2.4 安全洞(已立 FLY-1996)
grep -n 'FLY-222-a0-a10-runbook' scripts/__tests__/launchd-units-manifest.test.sh
grep -n 'launchd-units-manifest.test.sh' .github/workflows/ci.yml
grep -n 'design_compare.py' scripts/__tests__/test-fly1609-design-compare.test.sh

# §4.5 PR 关联元数据是活指针
OPEN_PR=$(gh pr list --repo $REPO --state open --json number --jq '.[0].number')
gh api "/repos/$REPO/actions/workflows/247217367/runs?per_page=100" \
  --jq ".workflow_runs[] | select(.pull_requests[0].number == $OPEN_PR)
        | {run_head: .head_sha, embedded_head: .pull_requests[0].head.sha}"
#   期望:run_head 各不相同(历史值);embedded_head 全部相同(= PR 当前 head)
```
