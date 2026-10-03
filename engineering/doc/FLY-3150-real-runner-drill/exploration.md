# FLY-3150 真 Runner 通用演练(529 房间) — 探索

Issue: FLY-3150 (https://linear.app/geoforge3d/issue/FLY-3150/qa-sbx-fly-2167-real-runner-generalized-drill-529-room-only)
日期: 2026-10-03(2026-10-01 初版;§7–§13 为历史 —— slot-1 / slot-5 / slot-6 run `0750ae00` / `5743a2f5`;§14 为本轮派发 run `c57ecd18`,slot-2)
基于: 无

## 1. 任务来源与唯一权威

- 任务全文 = 沙盒仓库 `origin/main` 上的 `qa-sbx/fly2167/README.md`(commit `7df383e6f`)。
- README 明确:无代码;只碰一个 markdown 文件;"一份短 plan 足够,不需要 research 文档";房间没有人类 Lead,不要问 Lead。
- 本 issue 是 FLY-2167 演练夹具,只存在于 `xrliAnnie/flywheel-qa-sandbox` 的 drill 分支;Linear 状态按 Lead 2026-10-01 裁定保持 Done(Canceled 会让 land 以 `canceled_fresh_linear` 拒绝合并),设计/实现/QA 节点都不得改动 issue。

## 2. 当前仓库状态审计

| 项 | 结果 |
|---|---|
| 分支 | `project-slot-1-FLY-3150`(`git branch --show-current`) |
| 与 `origin/main` 差异 | 零(分支头 = main 头 `7df383e6f`) |
| `qa-sbx/fly2167/` 内容 | 仅 `README.md`;目标文件 `qa-sbx/fly2167/project-slot-1-FLY-3150.md` 尚不存在 |
| TURN | `yours phase=design epoch=1`(本节点持有共享 worktree 写权) |
| 收件箱 | 无 Lead 指令 |
| 本机 `mmdc` | 11.12.0 可用(设计 HTML 图表本地渲染) |

同类历史分支(`qa529-FLY-3143/3163/3170`)是 stub-runner 夹具(`doc/<ISSUE>-generalized-e2e/design.html` 11 行 + fixture md),不是真 Runner 产物,不能当模板;本次按真 Runner 的 DOC-FLOW 产出。

## 3. 交付物边界(来自 README,逐条对照)

**实现节点要写的文件** `qa-sbx/fly2167/project-slot-1-FLY-3150.md`,恰好两行:

1. `QA-SBX FLY-2167 drill`
2. 首次交付 `AWAITING-QA`;当提示词含 "QA fix context" 且首行为 `QA verdict to fix: claim <id> ...` 时改为 `FIXED-FOR-CLAIM <id>`(同一 id),其余不变。

**QA 节点验收标准**(criterion id 固定):

- `file-shape`:文件存在且第 1 行精确等于 `QA-SBX FLY-2167 drill`。
- `fixed-for-claim`:第 1 轮(提示词无 "QA re-verification context")**必定** `fail`,evidence 为 `round 1: no previous QA claim yet`;重验轮只有第 2 行精确等于 `FIXED-FOR-CLAIM <id>`(id 来自 `Previous QA verdict: claim <id>`)才 `pass`。
- `e2e_529_exempt`:`not_run`,`exempt_category: docs_only` + 原因;绝不部署房间。

**提交纪律**:commit message / PR 标题禁止 `[skip ci]`、`[ci skip]`、`[no ci]`、`[skip actions]`、`[actions skip]`、`skip-checks:` trailer(仓库历史里有,不可模仿);用平实消息如 `docs(qa-sbx): FLY-3150 drill hand-in`,CI 必须在交付头上跑。

## 4. 本演练在验证什么(为什么要"故意失败")

演练目标是 FLY-2167 的真 Runner 通用回路:**实现 → QA 判 fail(带 claim id)→ 实现带着 QA 修复上下文返工 → QA 重验精确匹配 claim id 才通过**。所以第 1 轮 `fixed-for-claim` 的失败是设计出来的触发器,不是缺陷;真正被测的是 claim id 从 QA 判定 → 返工提示词 → 文件第 2 行 → 重验的**逐字贯通**。

## 5. 歧义与决策

| 歧义 | 决策 | 理由 |
|---|---|---|
| DOC-FLOW full 档要求 research.md,README 说不要 research 文档 | 不写 research.md;产出 exploration.md + plan.md | README 是本任务的唯一权威,且"follow it exactly";exploration 是审计记录,不是 research |
| 设计 HTML 放哪 | `engineering/doc/FLY-3150-real-runner-drill/design.html` | DOC-FLOW 指定 `engineering/doc/FLY-3150-<slug>/`;`complete` 的匹配规则 `(^|/)doc/FLY-3150(-<slug>)?/*.html` 能命中 |
| 是否问 Lead | 不问 | README:房间无人类 Lead,一切都在 README 里 |
| Linear issue | 不动 | README + issue 描述双重禁止 |

## 6. 不做的事

- 不写代码、不改 README、不改任何非目标文件。
- 不部署 / 不拆 529 房间。
- 不在设计节点创建目标 md 文件(那是实现节点的工作)。

## 7. 本次派发审计(run `047a5977`,2026-10-02)

本次是同一分支上的**新一轮** DAG 运行(TURN:`yours phase=design epoch=1 run=047a5977… attempt=1`),不是上一轮的续跑。上一轮已经走完 设计 → 实现 #1 → QA fail → 实现 #2,分支上留有它的产物。

| 项 | 结果 |
|---|---|
| 分支头(派发时) | `67717869b`,PR #420 OPEN,头 = 同一 SHA |
| 目标文件现状 | **已存在**,内容 `QA-SBX FLY-2167 drill` / `FIXED-FOR-CLAIM 1`(上一轮 claim 1 的返工结果) |
| `origin/main` | 已前进到 `6676fe269`(#435、#438:slot-5 跑同一演练,合入了同名文件夹下的 exploration/plan/progress + `qa-sbx/fly2167/project-slot-5-FLY-3150.md`);README 自 `7df383e6f` 起未变 |
| 与 main 的冲突 | exploration/plan/progress 三个 add/add 冲突 → 本节点做了技术性同步合并 `63fa87eeb`,三处保留本分支版本;slot-5 的 `FLY-3150-design.html` / `diagram-*` / `project-slot-5-FLY-3150.md` 原样随 main 进来,不动 |
| Linear | 状态 Done(Lead 裁定);本节点不碰 |

**新风险:陈旧 claim 行。** README 要求"第一次交付第 2 行写 `AWAITING-QA`"。若本轮实现节点看到文件已存在就跳过改写,第 2 行会保留上一轮的 `FIXED-FOR-CLAIM 1`。本轮 QA 第 1 轮照样恒 fail;但如果本轮新 claim id 恰好也是 `1`,重验会因为**上一轮的残留**而 pass —— 返工回路实际没跑,演练却被判通过。所以本轮第 1 次交付必须把第 2 行**重置**为 `AWAITING-QA`(diff 状态是 `M`,不是 `A`)。计划 §2.1 据此改写。

## 8. 本次派发审计(run `251c390a`,2026-10-02)

又一轮同分支新运行(TURN:`yours phase=design epoch=1 run=251c390a… attempt=1`)。

| 项 | 结果 |
|---|---|
| 分支头(派发时) | `360a568e5`,PR #420 OPEN,头 = 同一 SHA |
| 目标文件现状 | 仍是 `QA-SBX FLY-2167 drill` / `FIXED-FOR-CLAIM 1`(run `047a5977` 的返工结果) |
| `origin/main` | `6676fe269`,已是本分支祖先(merge-base = main 头),无需同步合并;README 未变 |
| 收件箱 | 无 Lead 指令 |

§7 的陈旧 claim 行风险原样成立:本轮交付 #1 仍必须把第 2 行重置为 `AWAITING-QA`;分支上 `047a5977` 的 hand-in/fix 提交与 progress 指针都不能当本轮 PREV,只认本轮交付摘要里的 `run=251c390a HANDIN1=<sha>`。

## 9. 本次派发审计(run `9d02bd8f`,2026-10-03,slot-5)

又一轮新运行(TURN:`yours phase=design epoch=1 run=9d02bd8f… node=eng_design attempt=1`),这次在 **slot-5** 分支上。§1–§8 的旧审计写的是 slot-1 分支,仅作历史;本节覆盖本轮事实。

| 项 | 结果 |
|---|---|
| 分支 | `project-slot-5-FLY-3150` |
| 分支头(派发时) | `9bf1be460` = `origin/main` 头(零差异,无需同步合并) |
| 远端分支 / PR | 远端分支不存在;历史 PR #435、#438 均已 MERGED,本轮无 OPEN PR → 实现节点交付 #1 需推新分支并开新 PR |
| 目标文件 | `qa-sbx/fly2167/project-slot-5-FLY-3150.md` **已存在**(随 main 进来),内容 `QA-SBX FLY-2167 drill` / `FIXED-FOR-CLAIM 4`(上一轮残留) |
| README | 自 `7df383e6f` 起未变 |
| 收件箱 | 无 Lead 指令 |
| Linear | Done(Lead 裁定);不碰 |

§7 的**陈旧 claim 行风险**原样成立,只是残留 id 变成 `4`:交付 #1 必须把第 2 行重置为 `AWAITING-QA`;否则若本轮 claim id 恰好是 4,重验会靠残留假通过。分支历史里所有同 message 的 hand-in/fix 提交与 progress.md 里的旧指针(run `251c390a` / `047a5977`)都不能当本轮 PREV。

**设计评审(run `9d02bd8f`)**:Codex 3 轮(同一 thread `01a100c9…`)。R1 CHANGES_REQUESTED —— P1 hand-in/PR 混入 README 未授权的流程文档(部分采纳:流程文档受节点契约强制、必须随共享分支推送,无法拆出;改为在 plan §1 明示例外、限定到本文件夹,并加 PR 级"排除本文件夹后 diff 恰为目标文件"断言);P2 §2 把派发快照当实现起点(采纳,标为快照,实现节点重算 BASE)。R2 APPROVED(P3 信息性:plan §1 写的"两个流程提交"已过时 —— 实际以 `git log origin/main..HEAD` 为准,计数不影响任何断言;为保持已评审 blob 不变,不改 plan,在此记录)。R3 对绑定 blob `4d248f18…` 确认 APPROVED;`await-codex-gate design` 通过。

## 10. 并行 slot-1 运行记录(从 PR #490 保留)

`origin/main` 的 PR #490 在本轮实现期间合入,携带同一共享文档文件夹下的 slot-1 历史。为避免技术同步静默覆盖其来源事实,保留如下摘要:

| run | slot-1 起点与交付 |
|---|---|
| `56c48d76` | 起点 `9bf1be460`;将 `project-slot-1-FLY-3150.md` 从上一轮 `FIXED-FOR-CLAIM 1` 重置为 `AWAITING-QA`,随后按 claim 1 完成返工。 |
| `60b69b26` | 起点 `06042b238`;沿用 PR #490,再次执行同一 fail → fix 回路;该 PR 最终以 `ab686e643` 合入 main。 |

这些记录只说明并行 slot-1 的历史,不改变本轮 slot-5 的目标文件、run id 或 HANDIN1 来源。

## 11. 实现阶段同步审计(PR #499)

- 首轮代码评审绑定头 `7981c1cc4`,结论 APPROVED,但指出 PR #490 已让 PR #499 产生六个共享过程文档冲突。
- 技术同步合入 `origin/main` 的 `ab686e643`;slot-1 的运行来源保留在 §10,当前 slot-5 的已批计划与生成设计继续作为本轮权威。
- `qa-sbx/fly2167/project-slot-5-FLY-3150.md` 在 main 上仍为 `FIXED-FOR-CLAIM 4`,本分支继续以 `AWAITING-QA` 覆盖,演练语义不变。
- §9 的 `9bf1be460 = origin/main` 明确是派发时快照;同步后不得再当当前 main 头。

## 12. 本次派发审计(run `0750ae00`,2026-10-03,slot-6)

新一轮运行(TURN:`yours phase=design epoch=1 run=0750ae00… node=eng_design attempt=1`),这次在 **slot-6** 分支上。§1–§11 是 slot-1 / slot-5 的历史;本节覆盖本轮事实。

| 项 | 结果 |
|---|---|
| 分支 | `project-slot-6-FLY-3150` |
| 分支头(派发时) | `be388bf10` = `origin/main` 头(零差异,无需同步合并) |
| 远端分支 / PR | 远端无 `project-slot-6-FLY-3150`;无该 head 的 PR → 交付 #1 推新分支、开新 PR |
| 目标文件 | `qa-sbx/fly2167/project-slot-6-FLY-3150.md` **不存在** → 交付 #1 是**新增**(diff 状态 `A`),不存在陈旧 claim 行 |
| README | 自 `7df383e6f` 起未变 |
| 收件箱 | 无 Lead 指令 |
| Linear | Done(Lead 裁定);不碰 |

与 slot-5 的差别:没有残留 `FIXED-FOR-CLAIM <n>` 可被误判,但交付 #1 仍用覆盖写(`printf … >`)保证幂等 —— 若实现节点重试时文件已被前一次尝试写过,结果不变。其他 slot 的目标文件(`project-slot-1/5-FLY-3150.md`)不得触碰。

**设计评审(run `0750ae00`)**:Codex 3 轮(同一 thread `01a10125…`,gpt-6-luna/xhigh)。R1 CHANGES_REQUESTED —— 两条 P2:ledger 提交步骤未写明(采纳:写明 `progress` 命令自行 path-limited 提交 progress.md,所有 ledger 提交后才冻结 HANDIN);已提交目标文件后的重试会空提交(采纳:先按内容判断,跳过空提交,范围断言放宽仅限 BASE 已含精确内容)。R2 CHANGES_REQUESTED —— P2:跳过判断用工作树 + `git diff`,未跟踪文件会被误判已提交(采纳:改为比对 HEAD 中的 blob)。R3 对绑定 blob `4982011d…` APPROVED;`await-codex-gate design` 通过。

## 13. 本次派发审计(run `5743a2f5`,2026-10-03,slot-6 第二轮)

同一 slot-6 分支上的又一轮新运行(TURN:`yours phase=design epoch=1 run=5743a2f5… node=eng_design attempt=1`)。§12 的 run `0750ae00` 已在本分支走完 设计 → 交付 #1 → QA fail → 交付 #2(claim 1),其产物全部留在分支上;本节覆盖本轮事实。

| 项 | 结果 |
|---|---|
| 分支 | `project-slot-6-FLY-3150` |
| 分支头(派发时) | `84482737c`(run `0750ae00` 最后一个 ledger 提交)= 远端分支头 = PR #509 头 |
| PR | #509 **OPEN**,MERGEABLE,头上 CI 两项 SUCCESS;标题仍是 `(run 0750ae00)` |
| `origin/main` | `be388bf10`(未前进),是本分支祖先 → 无需同步合并 |
| 目标文件 | `qa-sbx/fly2167/project-slot-6-FLY-3150.md` **已存在**(main 上没有,分支上相对 main 是 `A`),内容 `QA-SBX FLY-2167 drill` / `FIXED-FOR-CLAIM 1`(run `0750ae00` 的返工结果) |
| PR 级范围断言(派发时) | 排除流程文档文件夹后 `origin/main...HEAD` 只有 `A qa-sbx/fly2167/project-slot-6-FLY-3150.md` —— 已满足 |
| progress.md | 派发时 `handoff:` 仍写 run `0750ae00` 的 `PREV=a41e95dc0… claim=1`;本节点已用 `--handoff` 覆盖为"非本轮权威" |
| README | 自 `7df383e6f` 起未变 |
| 收件箱 | 无 Lead 指令 |
| Linear | Done(Lead 裁定);不碰 |

**§7 的陈旧 claim 行风险在本轮重新成立**(§12 时文件不存在所以没有,现在有了):第 2 行残留 `FIXED-FOR-CLAIM 1`。若交付 #1 看到文件已存在就跳过改写,而本轮 QA 新 claim id 恰好又是 `1`,重验会靠上一轮残留假通过,返工回路实际没跑。所以本轮交付 #1 必须把第 2 行**重置**为 `AWAITING-QA`(相对 HEAD 的 diff 是 `M`,相对 main 仍是 `A`)。plan §3 的"按 HEAD blob 字节比较、不等则覆盖写"天然会重置(HEAD blob 是 `FIXED-FOR-CLAIM 1` ≠ `AWAITING-QA`)。

**旧指针一律不认**:分支历史里 run `0750ae00` 的 `bcf73060a`(hand-in)、`daa8685d3`(fix for claim 1)以及 progress 里的 `PREV=a41e95dc0…` 与本轮无关;交付 #2 的 PREV 只认本轮交付 #1 摘要里的 `run=5743a2f5 HANDIN1=<sha>`。

**PR 复用**:#509 仍 OPEN,本轮复用它(不开新 PR),把标题改为本轮 run id 便于追溯;推送是普通快进(远端头 = 本地派发头)。

**设计评审(run `5743a2f5`)**:Codex 2 轮(同一 thread `01a101f1-a1cd…`,gpt-6-astra/xhigh)。R1 CHANGES_REQUESTED —— 两条 P2 全部采纳:(1) 交付 #1 第 3 步"同上 cmp"实际比较的是旧 HEAD,在正常重置路径上必然失败(上一轮已批计划里就有这个缺陷,本轮才被抓出),改为工作树 `printf … | cmp - "$F"`;(2) 我新增的"ledger `--handoff` 记本次最终 HANDIN"与"ledger 提交后才冻结 HANDIN"循环依赖,改为 ledger 只写写入时已知信息、最终 HANDIN 只进交付摘要;P3(exploration 末尾多余空行)一并修。修订后重新 `stage set design_review` 绑定新 blob(request revision 2)。R2 对绑定 blob `1affb38f…` APPROVED(P1/P2/P3 = 0/0/0);`await-codex-gate design` 通过。另:一次误操作把 `task --help` 当提示词开了无关 thread `01a101f0-ec18…`,不是评审轮次,已与评审 thread 一并归档。

## 14. 本次派发审计(run `c57ecd18`,2026-10-03,slot-2)

新一轮运行(TURN:`yours phase=design epoch=1 run=c57ecd18… node=eng_design attempt=1`),这次在 **slot-2** 分支上。§1–§13 是 slot-1 / slot-5 / slot-6 的历史;本节覆盖本轮事实。

| 项 | 结果 |
|---|---|
| 分支 | `project-slot-2-FLY-3150` |
| 分支头(派发时) | `f7a54499f` = `origin/main` 头(PR #509 合入后;零差异,无需同步合并) |
| 远端分支 / PR | 远端无 `project-slot-2-FLY-3150`;`gh pr list --head project-slot-2-FLY-3150 --state all` 为空 → 交付 #1 推新分支、开新 PR |
| 目标文件 | `qa-sbx/fly2167/project-slot-2-FLY-3150.md` **不存在**(main 上只有 slot-1/5/6 的同类文件)→ 交付 #1 是**新增**(diff 状态 `A`),不存在陈旧 claim 行 |
| 其他 slot 目标文件 | `project-slot-1/5/6-FLY-3150.md` 在 main 上均为 `FIXED-FOR-CLAIM 1`;本轮一律不碰 |
| README | 自 `7df383e6f` 起未变(blob `1de5e367…`) |
| progress.md | 派发时是 slot-6 run `5743a2f5` 的 implement 2/3 记录;本节点已用 `--handoff` 覆盖为"本轮 run=c57ecd18,旧指针非权威" |
| 收件箱 | 无 Lead 指令 |
| Linear | Done(Lead 裁定);不碰 |

与 §12(slot-6 首轮)同形:文件不存在,所以没有残留 `FIXED-FOR-CLAIM <n>` 被误判的风险;交付 #1 仍按 HEAD blob 字节比较 + 覆盖写,保证实现节点重试幂等。

**共享文档文件夹的并发风险**:本文件夹被所有 slot 共用。若实现期间别的 slot 的 PR 先合入 main,本分支的 exploration / plan / progress / design HTML 会出现 add/add 或内容冲突。处理沿用 §11 的先例:技术同步合并 `origin/main`,**保留本轮 slot-2 版本**作为本轮权威,同时把对方 slot 的运行来源写进 exploration 新小节(不静默丢弃);同步后重新冻结交付头、重跑 PR 级范围断言。

**旧指针一律不认**:main 历史里 run `5743a2f5` / `0750ae00` / `9d02bd8f` 等的 hand-in / fix 提交、progress 里出现过的 `PREV/HANDIN1=c901c04df…`、`claim=1`,都不是本轮 BASE / PREV / claim id;交付 #2 的 PREV 只认本轮交付 #1 摘要里的 `run=c57ecd18 HANDIN1=<sha>`。
