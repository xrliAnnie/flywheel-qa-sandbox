# FLY-3150 真 Runner 通用演练(529 房间) — 探索

Issue: FLY-3150 (https://linear.app/geoforge3d/issue/FLY-3150/qa-sbx-fly-2167-real-runner-generalized-drill-529-room-only)
日期: 2026-10-05(2026-10-01 初版;§7–§21 为历史 —— slot-1 / slot-5 / slot-6 / slot-2 / slot-4 各轮;§22 为历史;§23–§25 为历史;§26–§27 为历史;§28 为历史;§29 为历史;§30 为历史;§31–§36 为历史;§37 为本轮 run `a40703e6`,slot-1)
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

**共享文档文件夹的并发风险**:本文件夹被所有 slot 共用。若实现期间别的 slot 的 PR 先合入 main,本分支的 exploration / plan / progress / design HTML 会出现 add/add 或内容冲突。处理沿用 §11 的先例:技术同步合并 `origin/main`,**保留本轮 slot-2 版本**作为本轮权威,同时把对方 slot 的运行来源写进 exploration 新小节(不静默丢弃);同步后的触发条件、冲突边界与替代核验见 plan §3.1(Codex R1 指出旧的全树双点范围限制在同步后必然不过)。

**旧指针一律不认**:main 历史里 run `5743a2f5` / `0750ae00` / `9d02bd8f` 等的 hand-in / fix 提交、progress 里出现过的 `PREV/HANDIN1=c901c04df…`、`claim=1`,都不是本轮 BASE / PREV / claim id;交付 #2 的 PREV 只认本轮交付 #1 摘要里的 `run=c57ecd18 HANDIN1=<sha>`。

**设计评审(run `c57ecd18`)**:Codex 2 轮(同一 thread `01a10232-e8e4…`,gpt-6-astra/xhigh)。R1 CHANGES_REQUESTED —— 一条 P2:plan 要求同步 main 时追加 exploration 记录,但两次交付的全树双点范围断言只允许目标文件 + progress.md,合法同步后必然不过(slot-5 的 §7 曾有替代断言,slot-6 版本删掉了)。采纳:新增 plan §3.1 —— 只在 PR 冲突或契约要求时同步;冲突仅限流程文档文件夹(保留本轮版本,目录外冲突 abort);交付区间含 merge 提交时改用 PR 级范围断言 + 目标 blob 精确比较 + 返工 patch 精确比较,PREV 仍是真实 HANDIN1。修订后重新 `stage set design_review` 绑定新 blob(request `6e8ab627…`)。R2 对绑定 blob `07659135…` APPROVED(P1/P2/P3 = 0/0/0);`await-codex-gate design` 通过;thread 已归档。

## 15. 本次派发审计(run `2eae0ffd`,2026-10-03,slot-4)

新一轮运行(TURN:`yours phase=design epoch=1 run=2eae0ffd… node=eng_design attempt=1`),这次在 **slot-4** 分支上。§1–§14 是 slot-1 / slot-5 / slot-6 / slot-2 的历史;本节覆盖本轮事实。

| 项 | 结果 |
|---|---|
| 分支 | `project-slot-4-FLY-3150` |
| 分支头(派发时) | `f7a54499f`;`origin/main` 已前进到 `d92cf9042`(slot-2 PR #522 合入)。本分支派发时没有自己的提交,本节点做了**快进**同步(`git merge --ff-only origin/main`,无 merge 提交、无冲突) |
| 远端分支 / PR | 远端无 `project-slot-4-FLY-3150`;`gh pr list --head project-slot-4-FLY-3150 --state all` 为空 → 交付 #1 推新分支、开新 PR |
| 目标文件 | `qa-sbx/fly2167/project-slot-4-FLY-3150.md` **不存在**(main 上只有 slot-1/2/5/6 的同类文件)→ 交付 #1 是**新增**(diff 状态 `A`),不存在陈旧 claim 行 |
| 其他 slot 目标文件 | `project-slot-1/2/5/6-FLY-3150.md` 在 main 上均为 `FIXED-FOR-CLAIM 1`;本轮一律不碰 |
| README | 自 `7df383e6f` 起未变(blob `1de5e367…`) |
| progress.md | 派发时是 slot-2 run `c57ecd18` 的 implement 4/4 记录(指针 PR #522、`HANDIN1=d9a5d6ab…`、claim 1);本节点已用 `--handoff` 覆盖为"本轮 run=2eae0ffd,旧指针非权威",`pr` 指针置 `none` |
| 收件箱 | 无 Lead 指令 |
| onboard skill | 本项目不存在 → 按前导规则直接 `stage set brainstorm` |
| Linear | Done(Lead 裁定);不碰 |

与 §12 / §14(文件不存在的首轮)同形:没有残留 `FIXED-FOR-CLAIM <n>` 可被误判;交付 #1 仍按 HEAD blob 字节比较 + 覆盖写,保证实现节点重试幂等。§14 记录的共享文档文件夹并发风险与 plan §3.1 的同步处理原样适用。

**旧指针一律不认**:main 历史里 run `c57ecd18` / `5743a2f5` / `0750ae00` 等的 hand-in / fix 提交、progress 里出现过的 `PREV/HANDIN1=d9a5d6ab…`、`claim=1`、`pr` 指针 `#522`(已合入的 slot-2 PR),都不是本轮 BASE / PREV / claim id / PR;交付 #2 的 PREV 只认本轮交付 #1 摘要里的 `run=2eae0ffd HANDIN1=<sha>`。

**设计评审(run `2eae0ffd`)**:Codex 1 轮(thread `01a1027c-eae4…`,gpt-6-astra/xhigh,request `19b8522c…`)。R1 对绑定 blob `0ee6b0d8…` 直接 APPROVED(P1/P2/P3 = 0/0/0)。评审者在仓库外的临时 git 夹具里分别用 zsh / bash 实跑了交付 #1、两种重试、交付 #2、两次交付中的 main 冲突同步、目录外冲突 abort,全部符合 plan §3 / §3.1;并实查 reflog 确认 §2 的快进同步无 merge 提交、远端无 slot-4 分支与 PR。评审者声明的边界:未真推送、未真开 PR、未触发 CI(由实现节点在真实交付时核验)。`await-codex-gate design` 通过;thread 已归档。founder 设计 HTML 覆盖写 `design.html` / `d1-core-flow.*` / `d2-data-model.*` 为本轮 slot-4 版本(旧 slot-2 版本在 main 历史 `d92cf9042` 中可追溯)。

## 16. 本次派发审计(run `f461016e`,2026-10-03,slot-4 再派发)

TURN:`yours phase=design epoch=1 run=f461016e… node=eng_design attempt=1`。分支连续性:继续 `origin/project-slot-4-FLY-3150@2f94020e3`(OPEN PR #524)。§15 是同分支上一轮 run `2eae0ffd` 的历史。

| 项 | 结果 |
|---|---|
| 分支头(派发时) | `2f94020e3`(上一轮交付 #1 冻结头,实现 3/4,已有代码评审 APPROVED + exact-head CI) |
| 目标文件 | `qa-sbx/fly2167/project-slot-4-FLY-3150.md` 已在分支上,HEAD blob 逐字节 = `QA-SBX FLY-2167 drill` / `AWAITING-QA`(提交 `c179f8875`);main 上没有 → PR 级 diff 中为 `A` |
| `origin/main` | 已前进到 `15c97916b`:slot-3 run `e1a786ce`(PR #529)、run `1525e2e2`(PR #526)的 FLY-3150 文档,以及 FLY-3224–3228 夹具 README / FLY-3228 文档 |
| 冲突 | `git merge origin/main` 在 `engineering/doc/FLY-3150-real-runner-drill/` 内 8 个文件内容冲突(d1/d2 mmd+svg、design.html、exploration、plan、progress),另 `FLY-3150-design.html` 自动合并;全部恢复为本分支 slot-4 版本(`git checkout HEAD -- <folder>`)。目录外无冲突。合并提交 `679732054` |
| 对方来源(不静默丢弃) | main 上被覆盖的版本来自 run `e1a786ce`(slot-3,PR #529)与 run `1525e2e2`(PR #526),在 main 历史 `15c97916b` / `237429a88` 中可追溯 |
| 同步后 PR 级断言 | 排除流程文档文件夹后恰好一行 `qa-sbx/fly2167/project-slot-4-FLY-3150.md` |
| 其他 slot 目标文件 | `project-slot-1/2/3/5/6-FLY-3150.md` 一律不碰 |
| README | 未变 |
| 收件箱 | 无 Lead 指令 |
| onboard skill | 不存在 → 直接 `stage set brainstorm` |
| Linear | Done;不碰 |

**结论**:本轮交付 #1 走 plan §3 第 2 步幂等分支(不提交目标文件),复用 PR #524 并改写正文为本轮证据;上一轮 `HANDIN1=2f94020e3`、代码评审 `8eaee298…`、CI run `37136172147` 都**不是**本轮证据。合并提交在实现节点 BASE 之前,不进入交付区间。

**设计评审(run `f461016e`)**:Codex 3 轮(thread `01a103bc-ad9b…`,gpt-6-luna/xhigh)。R1 CHANGES_REQUESTED(P2):`BASE..HANDIN1` 把 ledger 自提交与目标文件交付混在一起,幂等分支下区间只有 progress.md → 改为冻结 `IMPL1`,实现范围与账本范围分开验(交付 #2 同理 `BASE2`/`IMPL2`)。R2 CHANGES_REQUESTED(P2):交付 #2 在"修复已提交、ledger 前中断"后重试时,`PREV..BASE2` 前置检查必然失败 → 按 BASE2 blob 分初始态 / 已修复态核验,其他内容 fail closed。R3 对绑定 blob `43977ec3…`(request `2b1e2088…`)APPROVED(0/0/0);`await-codex-gate design` 通过;thread 已归档。founder HTML `design.html` 与 `d1-core-flow.*` / `d2-data-model.*` 已覆盖为本轮再派发版本(旧版本在本分支历史 `a66d6514a` 可追溯)。

## 17. 并行 slot-5 运行记录(run `a6eb9810`,从 PR #517 保留)

本节由 slot-5 run `417f5fe4` 的设计节点在技术同步 `origin/main`(`02d12bdec`)时补入:本分支原 §12 记录的是 run `a6eb9810`,与 main 上 §12–§16(其他 slot)编号冲突,故改号保留,不静默丢弃。

| 项 | 值 |
|---|---|
| 分支 / 起点 | `project-slot-5-FLY-3150`,派发时 `be388bf10` = 当时 `origin/main`(PR #499 已合入) |
| 目标文件起点 | `qa-sbx/fly2167/project-slot-5-FLY-3150.md` 已存在,残留 `FIXED-FOR-CLAIM 1` |
| 交付 #1 | `9e16f93d8`:第 2 行重置为 `AWAITING-QA`,开 PR #517 |
| QA 第 1 轮 | planted fail,claim `1` |
| 交付 #2 | `187d68521`:第 2 行 `FIXED-FOR-CLAIM 1` |
| 代码评审 | 冻结头 `a5d4243ea` APPROVED;exact-head CI 两项 SUCCESS |
| 结果 | PR #517 未合入即被新一轮派发;main 前进(#509/#522/#526/#529/#524 等)后变为 CONFLICTING |

这些是 run `a6eb9810` 的历史证据,**不是**后续任何一轮的 BASE / PREV / HANDIN / claim id。

## 18. 本次派发审计(run `417f5fe4`,2026-10-03,slot-5 再派发)

TURN:`yours phase=design epoch=1 run=417f5fe4… node=eng_design attempt=1`。分支连续性:继续 `origin/project-slot-5-FLY-3150@a5d4243ea`(OPEN PR #517)。§17 是同分支上一轮 run `a6eb9810` 的历史。

| 项 | 结果 |
|---|---|
| 分支头(派发时) | `a5d4243ea`(上一轮交付 #2 后的 ledger 头,已有代码评审 APPROVED + exact-head CI SUCCESS)= 远端分支头 = PR #517 头 |
| PR | #517 OPEN,`CONFLICTING` / `DIRTY`;标题仍是 `(run a6eb9810)` |
| 目标文件 | `qa-sbx/fly2167/project-slot-5-FLY-3150.md` HEAD blob = `QA-SBX FLY-2167 drill` / `FIXED-FOR-CLAIM 1`;`origin/main` 上同一路径字节相同 |
| `origin/main` | 已前进到 `02d12bdec`(slot-2/3/4/6 的 FLY-3150 PR #509/#522/#526/#529/#524 与 FLY-3224–3228 夹具);README 未变(blob `1de5e367…`) |
| 冲突与同步 | `git merge origin/main` 在本文件夹内 8 个文件冲突(d1/d2 mmd+svg、design.html、exploration、plan、progress),目录外无冲突。plan / progress / design HTML / 图保留 slot-5 版本;exploration 取 main 版本(含 §12–§16 其他 slot 历史),本分支原 §12 改号为 §17 保留。合并提交 `2bb23f05a` |
| 同步后 PR 级演练 diff | 排除本文件夹后**为空**(目标文件与 main 字节相同) |
| 其他 slot 目标文件 | `project-slot-1/2/3/4/6-FLY-3150.md` 一律不碰 |
| 收件箱 | 无 Lead 指令 |
| onboard skill | 本项目不存在 → 直接 `stage set brainstorm` |
| Linear | Done(Lead 裁定);不碰 |

**结论**:
1. 陈旧 claim 行风险成立(残留 id `1`):交付 #1 必须把第 2 行重置为 `AWAITING-QA`,不能走幂等跳过分支。
2. **新发现的边界**:main 上的 slot-5 目标文件已是 `FIXED-FOR-CLAIM 1`。若本轮 QA claim id 又是 `1`,交付 #2 后 PR 级演练净 diff 为空 —— 旧计划里"恰好一行目标文件"的 PR 级断言会误判失败(run `a6eb9810` 的 PR 正文已注意到这一现象)。plan §1 把断言改为"只能为空或恰好目标文件 + HEAD blob 精确 + 为空仅当合并基已含期望字节",返工真实发生由区间 patch(plan §3 交付 #2 第 6(b) 步)证明。
3. 上一轮的 HANDIN1 `9e16f93d8…`、HANDIN2 `187d68521…`、claim `1`、代码评审与 CI 都**不是**本轮证据;PR #517 复用并改标题/正文为本轮 run id。

**设计评审(run `417f5fe4`)**:Codex 1 轮(thread `01a10467-859a…`,turn `01a10467-8b4d…`,gpt-6-astra/xhigh,request `5ded3a1a…`)。R1 对绑定 blob `aacd0896…` 直接 APPROVED(P1/P2/P3 = 0/0/0)。评审者在仓库外临时 git 夹具里用 `/bin/bash`、Homebrew bash、`/bin/zsh` 实跑:交付 #1 重置与重试、交付间 ledger、返工提交后及 ledger 后重试、claim `1` 的空 PR 级 diff、claim `2` 的单文件 PR 级 diff、两次交付中的 main 冲突同步、目录外冲突 abort、未跟踪目标拒绝,全部符合 plan §1 / §3 / §3.1;并用独立对象库重算 `2bb23f05a` 的两父合并,确认恰 8 个冲突且全在本文件夹。评审者声明的边界:未推送、未改 PR、未触发 CI(由实现节点核验远端/PR/CI 头)。`review-round design` 记录 match=yes;`await-codex-gate design` 通过;thread 已归档。另:预检时误把 `task --help` 当提示词开了无关 thread `01a10466-c7ec…`,不是评审轮次,已归档。

## 19. 本次派发审计(run `b98e6529`,2026-10-03,slot-4)

TURN:`yours phase=design epoch=1 run=b98e6529… node=eng_design attempt=1`。§15 / §16 是 slot-4 分支更早两轮(run `2eae0ffd` / `f461016e`)的历史,其 PR #524 已合入 main。

| 项 | 结果 |
|---|---|
| 分支头(派发时) | `4f21e53a1` = `origin/main`(slot-5 PR #517 已合入);本分支没有自己的提交,无需同步 |
| 远端分支 / PR | 远端无 `project-slot-4-FLY-3150`;`gh pr list --head project-slot-4-FLY-3150 --state all` 只有已合入的 #524 → 交付 #1 推新分支、开**新** PR |
| 目标文件 | `qa-sbx/fly2167/project-slot-4-FLY-3150.md` 在 HEAD / main 上逐字节 = `QA-SBX FLY-2167 drill` / `FIXED-FOR-CLAIM 1`(PR #524 留下) |
| 其他 slot 目标文件 | `project-slot-1/2/3/5/6-FLY-3150.md` 在 main 上均为 `FIXED-FOR-CLAIM 1`;本轮一律不碰 |
| README | 自 `7df383e6f` 起未变(blob `1de5e367…`) |
| progress.md | 派发时是 slot-5 run `417f5fe4` 的 implement 3/4 记录;本节点已用 `--handoff` 覆盖为本轮 run,`pr` 指针置 `none` |
| 收件箱 | 无 Lead 指令 |
| onboard skill | 本项目不存在 → 直接 `stage set brainstorm` |
| Linear | Done(Lead 裁定);不碰 |

**结论**:与 §18 同形 —— 陈旧 claim 行风险成立(残留 id `1`),交付 #1 必须把第 2 行重置为 `AWAITING-QA`;若本轮 claim id 又是 `1`,交付 #2 后 PR 级演练净 diff 为空,返工由区间 patch 证明(plan §1 / §3)。差别:本轮分支 = main、无冲突、无 OPEN PR,所以不复用旧 PR、不需要技术同步。旧指针(PR #524 / #517、任何旧 HANDIN、claim `1`、旧评审与 CI)都**不是**本轮证据。

**设计评审(run `b98e6529`)**:Codex 1 轮(thread `01a104bc-8b09…`,turn `01a104bc-924c…`,gpt-6-astra/xhigh,request `6ff6b569…`)。R1 对绑定 blob `cf9860af…` 直接 APPROVED(P1/P2/P3 = 0/0/0)。评审者在仓库外临时 git 夹具里用 `/bin/bash` 3.2 与 `/bin/zsh` 5.9 实跑:陈旧 `FIXED-FOR-CLAIM 1` → `AWAITING-QA` 重置与重试、claim `1` / `2` 两次交付、交付间 ledger、返工提交后及 ledger 后重试、claim `1` 的空 PR 级 diff(返工 patch 仍在)、未跟踪目标拒绝、错误 claim 拒绝、两次交付中的 main 同步与目录外冲突 abort,全部符合 plan §1 / §3 / §3.1;并核对 `progress` 的 `git commit --only` 自提交、`.github/workflows/ci.yml` 对 main 的 PR 无 docs 路径过滤。评审者声明的边界:未推送、未写 PR、未触发 CI(由实现节点在真实交付头核验)。`review-round design` 记录 match=yes;`await-codex-gate design` 通过;thread 已归档。

## 20. 本次派发审计(run `ebfb0035`,2026-10-03,slot-1)

TURN:`yours phase=design epoch=1 run=ebfb0035… node=eng_design attempt=1`(exec `cd924a30`)。§7 / §8 / §10 是 slot-1 分支更早几轮(run `047a5977` / `251c390a` / `56c48d76` / `60b69b26`)的历史,其 PR #420 / #490 已合入 main;§19 是刚合入的 slot-4 run `b98e6529`(PR #537)。

| 项 | 结果 |
|---|---|
| 分支头(派发时) | `aedb97bf4` = `origin/main`(slot-4 PR #537 已合入);本分支没有自己的提交,无需同步 |
| 远端分支 / PR | 远端无 `project-slot-1-FLY-3150`;`gh pr list --head project-slot-1-FLY-3150 --state all` 只有已合入的 #490 / #420 和已关闭的 #413 → 交付 #1 推新分支、开**新** PR |
| 目标文件 | `qa-sbx/fly2167/project-slot-1-FLY-3150.md` 在 HEAD / main 上逐字节 = `QA-SBX FLY-2167 drill` / `FIXED-FOR-CLAIM 1`(PR #490 留下) |
| 其他 slot 目标文件 | `project-slot-2/3/4/5/6-FLY-3150.md` 在 main 上均为 `FIXED-FOR-CLAIM 1`;本轮一律不碰 |
| README | 自 `7df383e6f` 起未变(blob `1de5e367…`) |
| progress.md | 派发时是 slot-4 run `b98e6529` 的 implement 3/4 记录;本节点已用 `--handoff` 覆盖为本轮 run,`pr` 指针置 `none` |
| CI | `.github/workflows/*.yml` 无 `paths` / `paths-ignore` 过滤 → 纯 markdown 交付头也会跑 CI |
| 收件箱 | 无 Lead 指令 |
| onboard skill | 本项目不存在 → 直接 `stage set brainstorm` |
| Linear | Done(Lead 裁定);不碰 |

**结论**:与 §19 同形 —— 陈旧 claim 行风险成立(残留 id `1`),交付 #1 必须把第 2 行重置为 `AWAITING-QA`;若本轮 claim id 又是 `1`,交付 #2 后 PR 级演练净 diff 为空,返工由区间 patch 证明(plan §1 / §3)。差别只在 slot:目标文件与分支名换成 slot-1,plan 里的命令全部从 `git branch --show-current` 现算,不硬编码。旧指针(PR #537 / #490 / #420、任何旧 HANDIN、claim `1`、旧评审与 CI)都**不是**本轮证据。

**设计评审(run `ebfb0035`)**:Codex 1 轮(thread `01a105a0-59ed…`,turn `01a105a0-6130…`,gpt-6-astra/xhigh,request `ee58543d…`)。R1 对绑定 blob `4facbba0…`(commit `7ce8651a2`)直接 APPROVED(P1/P2/P3 = 0/0/0)。评审者在仓库外临时 git 夹具里用 `/bin/bash` 3.2 与 `/bin/zsh` 5.9 各跑 19 个情形(共 38 PASS),并调用真实 `progress` CLI(独立 SQLite):陈旧 `FIXED-FOR-CLAIM 1` 重置与重试、claim `1` / `23` 两次交付、修复后账本前中断、账本后重试、错误 claim 与未跟踪目标拒绝、claim `1` 的空 PR 级净 diff(返工 patch 仍在)、两次交付中的 main 同步、目录外冲突 abort、改其他 slot 被范围守卫拒绝,全部符合 plan §1 / §3 / §3.1;`## 查询与索引` 的「不适用」成立。评审附注(非问题):`.github/workflows/ci.yml` 对 main 的 PR 触发、无 paths 过滤,job 检出的是 PR merge commit,所以「CI 在 HANDIN 上」按 run/check 的 `head_sha` 核对。评审期间 origin/main 前进到 `e0099630e`(FLY-3226 另一演练,PR #539),只动 `engineering/doc/FLY-3226-*/` 与 `qa-sbx/fly3226/`,与本分支无冲突,本节点不同步。`review-round design` 记录 match=yes。

## 21. 本次派发审计(run `4793ff8b`,2026-10-04,slot-1)

TURN:`yours phase=design epoch=1 run=4793ff8b… node=eng_design attempt=1`(exec `1460c887`)。§20 是本分支上一轮 run `ebfb0035`(exec `cd924a30`),其 PR #540 已于 2026-10-04 07:54Z 合入 main;§7 / §8 / §10 是更早几轮。

| 项 | 结果 |
|---|---|
| 分支头(派发时) | `3f2041e5f` = `origin/main`(PR #540 合入);本分支没有自己的提交,无需同步 |
| 远端分支 / PR | 远端无 `project-slot-1-FLY-3150`;`gh pr list --head project-slot-1-FLY-3150 --state all` 只有已合入的 #540 / #490 / #420 和已关闭的 #413 / #407 → 交付 #1 推新分支、开**新** PR |
| 目标文件 | `qa-sbx/fly2167/project-slot-1-FLY-3150.md` 在 HEAD / main 上逐字节 = `QA-SBX FLY-2167 drill` / `FIXED-FOR-CLAIM 1`(PR #540 留下) |
| 其他 slot 目标文件 | `project-slot-2/3/4/5/6-FLY-3150.md` 在 main 上均为 `FIXED-FOR-CLAIM 1`;本轮一律不碰 |
| README | 自 `7df383e6f` 起未变(blob `1de5e367…`) |
| progress.md | 派发时是本分支上一轮 run `ebfb0035` 的 implement 4/5 记录(含旧 `PREV` / `IMPL2` / 旧评审 id);本节点已用 `--handoff` 覆盖为本轮 run,`pr` 指针置 `none` |
| CI | `.github/workflows/ci.yml` 对 main 的 push / PR 触发,无 `paths` / `paths-ignore` 过滤 → 纯 markdown 交付头也会跑 CI |
| 收件箱 | 无 Lead 指令 |
| onboard skill | 本项目不存在(只有 `onboarding` 命令,不是 `onboard` skill)→ 直接 `stage set brainstorm` |
| Linear | Done(Lead 裁定);不碰 |

**结论**:与 §20 同形 —— 陈旧 claim 行风险成立(残留 id `1`),交付 #1 必须把第 2 行重置为 `AWAITING-QA`;若本轮 claim id 又是 `1`,交付 #2 后 PR 级演练净 diff 为空,返工由区间 patch 证明(plan §1 / §3)。plan 结构沿用已评审版本,只换 run id 与派发快照;命令全部从 `git branch --show-current` 现算。上一轮 ledger 里的 `PREV=75d8a44e…` / `IMPL2=2e2221d6…` / 评审 question / request id 属于 run `ebfb0035`,**不是**本轮证据;旧指针(PR #540 / #537 / #490 / #420、任何旧 HANDIN、claim `1`、旧评审与 CI)同样不认。

**设计评审(run `4793ff8b`)**:Codex 1 轮(thread `01a1060a-3329…`,turn `01a1060a-3bae…`,gpt-6-astra/xhigh,request `6d4fee59…`)。R1 对绑定 blob `4449bedd…`(commit `8a725822b`)直接 APPROVED(P1/P2/P3 = 0/0/0)。评审者在仓库外临时 git 夹具里用 `/bin/bash` 3.2.57 与 `/bin/zsh` 5.9 各跑 22 项(共 44 PASS),并调用真实 `progress` CLI(独立 SQLite / `FLYWHEEL_COMM_DB`):陈旧 `FIXED-FOR-CLAIM 1` 重置、两次交付、实现提交后与 ledger 后重试、claim `1` / `23`、错误 claim、缺失上下文、未跟踪目标、缺末尾 LF、已暂存其他文件、改其他 slot / 相似前缀目录越界、双点 / 三点范围、两次交付中的 main 同步、修复后同步、目录外冲突 `merge --abort`,全部符合 plan §1 / §3 / §3.1;`## 查询与索引` 的「不适用」成立。评审附注(非问题):`ci.yml` 只对 main 的 push 与指向 main 的 PR 触发,feature 分支单独 push 不触发,所以「交付头 CI」要在开 PR 之后核对;评审未推送、未建 PR、未触发 CI。`review-round design` 记录 match=yes。

## 22. 本次派发审计(run `571849e4`,2026-10-04,slot-1)

TURN:`yours phase=design epoch=1 run=571849e4… node=eng_design attempt=1`(exec `8d111835`)。§21 是本分支上一轮 run `4793ff8b`(设计 exec `1460c887`),其 PR #543 已于 2026-10-04 09:31Z 合入 main(合并提交 `7ed21ce86`);§20 / §10 / §8 / §7 是更早几轮。

| 项 | 结果 |
|---|---|
| 分支头(派发时) | `caabb83da` = `origin/main`(PR #543 之后又合入 FLY-3226/3227/3228 的其他夹具,不在本文件夹);本分支没有自己的提交,无需同步 |
| 远端分支 / PR | 远端无 `project-slot-1-FLY-3150`;`gh pr list --head project-slot-1-FLY-3150 --state all` 只有已合入的 #543 / #540 / #490 / #420 和已关闭的 #413 / #407 → 交付 #1 推新分支、开**新** PR |
| 目标文件 | `qa-sbx/fly2167/project-slot-1-FLY-3150.md` 在 HEAD / main 上逐字节 = `QA-SBX FLY-2167 drill` / `FIXED-FOR-CLAIM 1`(PR #543 留下) |
| 其他 slot 目标文件 | `project-slot-2/3/4/5/6-FLY-3150.md` 在 main 上均为 `FIXED-FOR-CLAIM 1`;本轮一律不碰 |
| README | 自 `7df383e6f` 起未变(blob `1de5e367…`) |
| progress.md | 派发时是上一轮 run `4793ff8b` 的 implement 5/6 记录(含旧 `PREV=HANDIN1=7b0b2ae0…` / `IMPL2=2eb48520…` / 旧评审 question / 旧 Lead 指令 id);本节点已用 `--handoff` 覆盖为本轮 run(提交 `3793ad963`),`pr` 指针置 `none` |
| CI | `.github/workflows/ci.yml` 只对 main 的 push 与指向 main 的 PR 触发,无 `paths` 过滤 → 交付头 CI 要在开 PR 之后核对 |
| 收件箱 | 无 Lead 指令 |
| onboard skill | 本项目不存在(只有 `onboarding` 命令,不是 `onboard` skill)→ 直接 `stage set brainstorm` |
| Linear | Done(Lead 裁定);不碰 |

**结论**:与 §21 同形 —— 陈旧 claim 行风险成立(残留 id `1`),交付 #1 必须把第 2 行重置为 `AWAITING-QA`;若本轮 claim id 又是 `1`,交付 #2 后 PR 级演练净 diff 为空,返工由区间 patch 证明(plan §1 / §3)。plan 结构沿用已评审版本,只换 run id 与派发快照;命令全部从 `git branch --show-current` 现算。上一轮 ledger 里的 `PREV` / `IMPL2` / 评审 question / Lead 指令 id 属于 run `4793ff8b`,**不是**本轮证据;旧指针(PR #543 / #540 / #537 / #490 / #420、任何旧 HANDIN、claim `1`、旧评审与 CI)同样不认。

**设计评审(run `571849e4`)**:Codex 1 轮(thread `01a107df-c649…`,turn `01a107df-cfd5…`,gpt-6-astra/xhigh,request `614c0ac4…`)。R1 对绑定 blob `e238fa94…`(commit `f1319582e`)直接 APPROVED(P1/P2/P3 = 0/0/0)。评审者重新核对 README blob、HEAD 与 main 上 slot-1…6 目标文件(12 次逐字节检查,均为 40 字节 `FIXED-FOR-CLAIM 1`,blob `07bc88bb…`)、PR 列表与 `ci.yml` 触发条件,并在仓库外临时 git 夹具里用 `/bin/bash` 3.2.57 与 `/bin/zsh` 5.9 实跑:陈旧 claim 重置、实现 / 账本分段范围与重试、修复提交后 ledger 前中断的重试、claim `1` 的空 PR 级 diff 与非空返工 patch、错误 claim / 未跟踪目标 / 缺末尾 LF / 非祖先 PREV / 改其他 slot 的拒绝、主干同步冲突按 ours 解决,全部符合 plan §1 / §3 / §3.1;`## 查询与索引` 的「不适用」成立。评审声明的边界:`progress` CLI 只做源码静态核对(`git add` + `git commit --only` 自提交),未在夹具里真跑;未推送、未建 PR、未触发 CI。`review-round design` 记录 match=yes;`await-codex-gate design` 通过;thread 已归档。founder HTML `design.html` 与 `d1-core-flow.*` 已更新为本轮 run id(`d2-data-model.*` 内容不含 run id,未变)。

## 23. 本次派发审计(run `76a1d8a2`,2026-10-04,slot-1)

TURN:`yours phase=design epoch=1 run=76a1d8a2… node=eng_design attempt=1`(exec `94cd7a36`)。§22 是本分支上一轮 run `571849e4`(设计 exec `8d111835`),其 PR #555 已于 2026-10-04 18:20Z 合入 main(合并提交 `2067445f2`);§21 / §20 / §10 / §8 / §7 是更早几轮。

| 项 | 结果 |
|---|---|
| 分支头(派发时) | `baace76a5` = `origin/main`(PR #555 之后又合入 FLY-3224/3225/3226 的其他夹具,不在本文件夹);本分支没有自己的提交,无需同步 |
| 远端分支 / PR | 远端无 `project-slot-1-FLY-3150`;`gh pr list --head project-slot-1-FLY-3150 --state all` 只有已合入的 #555 / #543 / #540 / #490 / #420 和已关闭的 #413 / #407 → 交付 #1 推新分支、开**新** PR |
| 目标文件 | `qa-sbx/fly2167/project-slot-1-FLY-3150.md` 在 HEAD / main 上逐字节 = `QA-SBX FLY-2167 drill` / `FIXED-FOR-CLAIM 1`(PR #555 留下) |
| 其他 slot 目标文件 | `project-slot-2/3/4/5/6-FLY-3150.md` 在 main 上均为 `FIXED-FOR-CLAIM 1`;本轮一律不碰 |
| README | 自 `7df383e6f` 起未变(blob `1de5e367…`) |
| progress.md | 派发时是上一轮 run `571849e4` 的 implement 4/5 记录(含旧 `PREV=HANDIN1=9121dd0c…` / `IMPL2=0b201bf1…` / 旧评审 gate / 旧 Lead 指令 id);本节点已用 `--handoff` 覆盖为本轮 run(提交 `1b7e3ef9d`),`pr` 指针置 `none` |
| CI | `.github/workflows/ci.yml` 只对 main 的 push 与指向 main 的 PR 触发 → 交付头 CI 要在开 PR 之后核对 |
| 收件箱 | 无 Lead 指令 |
| onboard skill | 本项目不存在 → 直接 `stage set brainstorm` |
| Linear | Done(Lead 裁定);不碰 |

**结论**:与 §22 同形 —— 陈旧 claim 行风险成立(残留 id `1`),交付 #1 必须把第 2 行重置为 `AWAITING-QA`;若本轮 claim id 又是 `1`,交付 #2 后 PR 级演练净 diff 为空,返工由区间 patch 证明(plan §1 / §3)。plan 结构沿用已评审版本,只换 run id 与派发快照。上一轮 ledger 里的 `PREV` / `IMPL2` / 评审 gate / Lead 指令 id 属于 run `571849e4`,**不是**本轮证据;旧指针(PR #555 / #543 / #540 / #490 / #420、任何旧 HANDIN、claim `1`、旧评审与 CI)同样不认。

## 24. 本次派发审计(run `0c3b88f3`,2026-10-04,slot-1)

TURN:`yours phase=design epoch=1 run=0c3b88f3… node=eng_design attempt=1`(exec `88efd5e0`)。§23 是 run `76a1d8a2`(PR #559 已合入);其后 run `f9254495` 的 PR #562 于 2026-10-04 22:00Z **关闭未合入**,它的文档 / ledger 提交不在 main 上,本轮不继承。

| 项 | 结果 |
|---|---|
| 分支头(派发时) | `e6513c9b6`,落后 `origin/main` 一个提交(`581cc2d52`,FLY-3226 夹具,只动 `engineering/doc/FLY-3226-real-runner-drill/`);本分支没有自己的提交 → `git merge --ff-only`,无合并提交 |
| 远端分支 / PR | 远端无 `project-slot-1-FLY-3150`;PR 只有已合入 #559 / #555 / #543 / #540 / #490 / #420 与已关闭 #562 / #413 / #407 → 交付 #1 推新分支、开**新** PR |
| 目标文件 | HEAD / main 上逐字节 = `QA-SBX FLY-2167 drill` / `FIXED-FOR-CLAIM 1`(PR #559 留下) |
| README | blob `1de5e367…`,未变 |
| progress.md | 派发时是 run `76a1d8a2` 的 implement 3/4 记录(旧 `PREV=7ac10013…` / `IMPL2=12aa4c4c8`);本节点已用 `--handoff` 覆盖为本轮 run(提交 `a5307c222`),`pr` 置 `none` |
| 收件箱 | 无 Lead 指令 |
| onboard skill | 不存在 → 直接 `stage set brainstorm` |
| Linear | Done(Lead 裁定);不碰 |

**结论**:与 §23 同形 —— 交付 #1 必须把第 2 行从残留的 `FIXED-FOR-CLAIM 1` 重置为 `AWAITING-QA`;plan 结构沿用已评审版本,只换 run id 与派发快照。PR #562 / #559 及任何旧 HANDIN、claim id、评审、CI 都不是本轮证据。

**设计评审(run `0c3b88f3`)**:Codex(gpt-6-luna/xhigh,thread `01a108f0-7b64…`,request `a662156f…`)对绑定 blob `eb25a54e…`(commit `c8b67dd94`)第 1 轮即 APPROVED(P1/P2/P3 = 0/0/0):核对 README、HEAD/main 上目标文件字节、PR 列表(#562 关闭 / #559 合入)、远端无本分支、`ci.yml` 触发条件,确认陈旧 `FIXED-FOR-CLAIM 1` 重置、交付区间核验与 `## 查询与索引` 的「不适用」成立。第 1 轮回合以 "completion inferred" 结束,故在同一 thread 追加一个不改 plan 的确认回合(turn `01a108f5…`,同样 APPROVED);`review-round` 把该回合记为 r1,`await-codex-gate design` 通过;thread 已归档。

## 25. 本次派发审计(run `6f9cf806`,2026-10-04,slot-1)

TURN:`yours phase=design epoch=1 run=6f9cf806… node=eng_design attempt=1`(exec `246e1090`)。§24 是 run `0c3b88f3`,它的交付 #1 已推送并开 PR #565(仍 OPEN,头 `9429bb968`);本轮是同一分支上的**新 run**,继续在其上工作,不 force-push。

| 项 | 结果 |
|---|---|
| 分支头(派发时) | `9429bb968` = `origin/project-slot-1-FLY-3150` = PR #565 头;落后 `origin/main` 一个提交(`39754a419`,FLY-3224 夹具,只动 `engineering/doc/FLY-3224-real-runner-drill/`)→ 普通 `git merge origin/main`,合并提交 `1bf3a8aaa`,无冲突 |
| 远端分支 / PR | 远端有本分支;PR #565 OPEN(run `0c3b88f3`)→ 本轮交付 #1 复用 #565(`gh pr edit` 改标题 / 正文为 run `6f9cf806`);其余同名 PR 已合入或关闭 |
| 目标文件 | HEAD 上已逐字节 = `QA-SBX FLY-2167 drill` / `AWAITING-QA`(run `0c3b88f3` 的 `a896ba8e5`);main 上仍是 `FIXED-FOR-CLAIM 1` → 交付 #1 走跳过分支,`IMPL1=BASE`,PR 级净 diff 恰好一行目标文件 |
| README | blob `1de5e367…`,未变 |
| progress.md | 派发时是 run `0c3b88f3` 的 implement 2/4;本节点已用 `--handoff` 覆盖为本轮 run(提交 `6d252b484`),`pr` 指针 = `565` |
| 收件箱 | 无 Lead 指令 |
| onboard skill | 不存在 → 直接 `stage set brainstorm` |
| Linear | Done(Lead 裁定);不碰 |

**结论**:与 §24 不同形 —— 陈旧 `FIXED-FOR-CLAIM 1` 已在分支上被上一轮重置,本轮交付 #1 无需再提交目标文件(plan §3 第 2 步跳过分支),但 PR 级断言、账本范围核验与 `run=6f9cf806 HANDIN1=<sha>` 照常。PR #565 上一轮的 HANDIN1、代码评审、CI、QA 结论与任何 claim id 都不是本轮证据。

**设计评审(run `6f9cf806`)**:Codex(gpt-6-luna/xhigh,thread `01a10922-91a5…`,turn `01a10922-9686…`,request `a8851c79…`)对绑定 blob `76a48d2e…`(commit `23a698600`)第 1 轮即 APPROVED(P1/P2/P3 = 0/0/0),回合正常 `Turn completed`;核对 README blob、HEAD(`AWAITING-QA`)与 main(`FIXED-FOR-CLAIM 1`)上目标文件字节、合并提交 `1bf3a8aaa` 祖先关系、旧指针排除与 `## 查询与索引` 的「不适用」。边界:评审时 `gh pr view 565` 因网络失败未能实时确认 PR 状态,由实现节点交付时重查。`review-round` 记 r1,`await-codex-gate design` 通过。

## 26. 本次派发审计(run `46163449`,2026-10-04,slot-1)

TURN:`yours phase=design epoch=1 run=46163449… node=eng_design attempt=1`(exec `7d3952ba`)。§25 是 run `6f9cf806`,它已走完 交付 #1(跳过分支)→ QA 第 1 轮 claim `1` → 交付 #2(`ca7cccf28`,`FIXED-FOR-CLAIM 1`),分支停在其 implement 3/4 ledger 头 `0cf6941a3`;本轮是同一分支上的**新 run**,继续在其上工作,不 force-push。

| 项 | 结果 |
|---|---|
| 分支头(派发时) | `0cf6941a3` = `origin/project-slot-1-FLY-3150` = PR #565 头 |
| `origin/main` | `39754a419`,已是本分支祖先 → 无需同步合并 |
| 远端分支 / PR | PR #565 OPEN / MERGEABLE(标题仍是 run `6f9cf806`)→ 本轮交付 #1 复用 #565(`gh pr edit` 改标题 / 正文);其余同名 PR 已合入或关闭 |
| 目标文件 | HEAD 上 = `QA-SBX FLY-2167 drill` / `FIXED-FOR-CLAIM 1`(陈旧,blob `07bc88bb…`);main 上字节相同 → 交付 #1 走**正常分支**重置为 `AWAITING-QA` |
| README | blob `1de5e367…`,未变 |
| progress.md | 派发时是 run `6f9cf806` 的 implement 3/4(旧 `PREV=27069dae0` / `IMPL2=ca7cccf28`);本节点已用 `--handoff` 覆盖为本轮 run(提交 `fe77f1363`),`pr` 指针仍 `565` |
| 收件箱 | 无 Lead 指令 |
| onboard skill | 不存在 → 直接 `stage set brainstorm` |
| Linear | Done(Lead 裁定);不碰 |

**结论**:与 §24 同形(陈旧 `FIXED-FOR-CLAIM 1` 必须在交付 #1 重置),差别只是复用 OPEN PR #565 而不是开新 PR。PR #565 上一轮的任何 HANDIN、claim id、评审、CI、QA 结论都不是本轮证据。

**设计评审(run `46163449`)**:Codex(gpt-6-luna/xhigh,thread `01a10956-e383…`,request `81d9af24…`)。R1(turn `01a10956-eaaa…`,blob `916135ad…`)CHANGES_REQUESTED,1 个 P2:§3.1 只用 `rev-list --merges` 判定是否同步,若 `git merge origin/main` 以快进完成就没有合并提交,核验会走错分支 → plan 改为 `git merge --no-ff origin/main`,并在 main 已是祖先时不同步(提交 `5ec2493b2`)。R2(turn `01a1095c-6d87…`,blob `e5b3b38a…`)APPROVED(P1/P2/P3 = 0/0/0),确认仅一行改动、无回归。两轮均记 `review-round`;`await-codex-gate design` 通过。边界:评审时 GitHub API 不可达,PR #565 实时状态由实现节点交付时重查。founder HTML `design.html` 与 `d1-core-flow.*` 已覆盖为本轮版本。

## 27. 本次派发审计(run `93c1c760`,2026-10-04,slot-1)

TURN:`yours phase=design epoch=1 run=93c1c760… node=eng_design attempt=1`(exec `2b2014f0`)。§26 是 run `46163449`,它已走完 交付 #1(`233bfe607`,重置为 `AWAITING-QA`)→ QA 第 1 轮 claim `1` → 交付 #2(`766d3b43f`,`FIXED-FOR-CLAIM 1`),分支停在其 implement 2/4 ledger 头 `4f590fc40`;本轮是同一分支上的**新 run**,继续在其上工作,不 force-push。

| 项 | 结果 |
|---|---|
| 分支头(派发时) | `4f590fc40` = PR #565 头 |
| `origin/main` | `39754a419`,已是本分支祖先 → 无需同步合并 |
| 远端分支 / PR | PR #565 OPEN(标题仍是上一轮)→ 本轮交付 #1 复用 #565(`gh pr edit`) |
| 目标文件 | HEAD 上 = `QA-SBX FLY-2167 drill` / `FIXED-FOR-CLAIM 1`(陈旧);main 上字节相同 → 交付 #1 走**正常分支**重置为 `AWAITING-QA` |
| README | 未变(两行文件 + 三条验收) |
| progress.md | 派发时是 run `46163449` 的 implement 2/4(旧 `PREV=6748deaae` / `IMPL2=766d3b43f`);本节点已用 `--handoff` 覆盖为本轮 run(提交 `b8083ff13`) |
| 收件箱 | 无 Lead 指令 |
| onboard skill | 不存在 → 直接 `stage set brainstorm` |
| Linear | Done(Lead 裁定);不碰 |

**结论**:与 §26 完全同形;plan 只更新 run / exec 标识与 §2 起点快照。上一轮任何 HANDIN、claim id、评审、CI、QA 结论都不是本轮证据。

## 28. 本次派发审计(run `a5651dbc`,2026-10-04,slot-1)

TURN:`yours phase=design epoch=1 run=a5651dbc… node=eng_design attempt=1`(exec `cb8f15f2`)。§27 是 run `93c1c760`,它已走完 交付 #1(`fc479f191`,重置为 `AWAITING-QA`)→ QA 第 1 轮 claim `1` → 交付 #2(`4f15aa6a8`,`FIXED-FOR-CLAIM 1`),分支停在其 implement 4/4 ledger 头 `9459875d3`;本轮是同一分支上的**新 run**,继续在其上工作,不 force-push。

| 项 | 结果 |
|---|---|
| 分支头(派发时) | `9459875d3` = PR #565 头 |
| `origin/main` | `39754a419`,已是本分支祖先 → 无需同步合并 |
| 远端分支 / PR | PR #565 OPEN(标题仍是上一轮)→ 本轮交付 #1 复用 #565(`gh pr edit`) |
| 目标文件 | HEAD 上 = `QA-SBX FLY-2167 drill` / `FIXED-FOR-CLAIM 1`(陈旧);main 上字节相同 → 交付 #1 走**正常分支**重置为 `AWAITING-QA` |
| README | 未变(两行文件 + 三条验收) |
| progress.md | 派发时是 run `93c1c760` 的 implement 4/4(旧 `PREV=b1887ae49` / `IMPL2=4f15aa6a8`);本节点已用 `--handoff` 覆盖为本轮 run(提交 `bfbfc28e5`) |
| 收件箱 | 无 Lead 指令 |
| onboard skill | 不存在 → 直接 `stage set brainstorm` |
| Linear | Done(Lead 裁定);不碰 |

**结论**:与 §26 / §27 完全同形;plan 只更新 run / exec 标识与 §2 起点快照。上一轮任何 HANDIN、claim id、评审、CI、QA 结论都不是本轮证据。

## 29. 本次派发审计(run `d1cedf09`,2026-10-04,slot-1)

TURN:`yours phase=design epoch=1 run=d1cedf09… node=eng_design attempt=1`(exec `649dd9dc`)。§28 是 run `a5651dbc`,它只走到交付 #1(`e1e80f7a7`,把陈旧的 `FIXED-FOR-CLAIM 1` 重置为 `AWAITING-QA`)+ implement 1/4 ledger(`6002aab7e`),没有返工;本轮是同一分支上的**新 run**,继续在其上工作,不 force-push。

| 项 | 结果 |
|---|---|
| 分支头(派发时) | `6002aab7e` = PR #565 头(OPEN,标题仍是 run `a5651dbc`) |
| `origin/main` | `62a604d44`,**领先 4 个提交**(FLY-3224 / 3225 / 3226 / 3228 演练),只改它们各自的 `engineering/doc/FLY-322x-*` 文件夹,不碰本 issue 文件夹与 `"$F"` → 路径不相交,无冲突;按 §3.1 不同步(既非 `CONFLICTING`,也无契约要求) |
| 目标文件 | HEAD 上 = `QA-SBX FLY-2167 drill` / `AWAITING-QA`(上一轮交付 #1 写入);main 上仍是 `FIXED-FOR-CLAIM 1` → 本轮交付 #1 走**跳过分支**(`IMPL1=BASE`),PR 级净 diff 恰为 `-FIXED-FOR-CLAIM 1` / `+AWAITING-QA` |
| README | 未变(blob `1de5e367…`) |
| progress.md | 派发时是 run `a5651dbc` 的 implement 1/4;本节点用 `--handoff` 覆盖为本轮 run |
| 收件箱 | 无 Lead 指令 |
| onboard skill | 不存在 → 直接 `stage set brainstorm` |
| Linear | Done(Lead 裁定);不碰 |

**结论**:与 run `6f9cf806`(目标已是 `AWAITING-QA`、走跳过分支)同形,区别只是 main 领先但路径不相交。跳过分支没有"残留 claim 假通过"风险:HEAD 上没有任何 `FIXED-FOR-CLAIM`。上一轮的 HANDIN `e1e80f7a7`、评审、CI 都不是本轮证据。

## 30. 本次派发审计(run `1e45bf82`,2026-10-05,slot-1)

TURN:`yours phase=design epoch=1 run=1e45bf82… node=eng_design attempt=1`(exec `335c1962`)。§29 是 run `d1cedf09`,它已走完 交付 #1(跳过分支)→ QA 第 1 轮 claim `1` → 交付 #2(`aefacd838`,`FIXED-FOR-CLAIM 1`),分支停在其 implement 3/4 ledger 头 `bab87a3d6`;本轮是同一分支上的**新 run**,继续在其上工作,不 force-push。

| 项 | 结果 |
|---|---|
| 分支头(派发时) | `bab87a3d6` = `origin/project-slot-1-FLY-3150` = PR #565 头(OPEN / MERGEABLE,标题仍是 run `d1cedf09`) |
| `origin/main` | `62a604d44`,领先 4 个提交(FLY-3224 / 3225 / 3226 / 3228 演练),只改各自 `engineering/doc/FLY-322x-*` 文件夹,与本 issue 文件夹和 `"$F"` 不相交 → 按 §3.1 不同步 |
| 目标文件 | HEAD 上 = `QA-SBX FLY-2167 drill` / `FIXED-FOR-CLAIM 1`(陈旧,上一轮交付 #2 写入);main 上字节相同 → 交付 #1 走**正常分支**重置为 `AWAITING-QA` |
| README | blob `1de5e367…`,未变 |
| progress.md | 派发时是 run `d1cedf09` 的 implement 3/4(旧 `PREV=a6880474e`);本节点用 `--handoff` 覆盖为本轮 run |
| 收件箱 | 无 Lead 指令 |
| onboard skill | 不存在 → 直接 `stage set brainstorm` |
| Linear | Done(Lead 裁定);不碰 |

**结论**:与 §26 / §27 同形(陈旧 `FIXED-FOR-CLAIM 1` 必须在交付 #1 重置,复用 OPEN PR #565),差别只是 main 领先但路径不相交。若本轮 claim id 恰好又是 `1`,正因交付 #1 先重置成 `AWAITING-QA`,返工区间 `$PREV..$HANDIN2` 的 patch 才能证明返工真的发生。PR #565 上一轮的任何 HANDIN、claim id、评审、CI、QA 结论都不是本轮证据。

**设计评审(run `1e45bf82`)**:Codex(gpt-6-luna/xhigh,profile `school`,thread `01a10b00-4f5e…`)。R1(turn `01a10b00-5642…`,blob `c4a2d268…`)CHANGES_REQUESTED,P2:区间最终差异不能证明只有一个实现提交 → §3 第 6(a) 加 `git rev-list --count` 断言(正常 / 初始态 1,跳过 / 已修复态 0)。R2(turn `01a10b05-6694…`,blob `3164acfa…`)CHANGES_REQUESTED,P2:同步分支计数会算进 main 带入的提交 → §3.1 计数加 `^origin/main`。R3(turn `01a10b06-fc20…`,blob `3adff3d2…`,request `8e71f128…`)APPROVED(0/0/0)。三轮均记 `review-round`;`await-codex-gate design` 通过。founder HTML `design.html` 与 `d1-core-flow.*` 已覆盖为本轮版本。

## 31. 本次派发审计(run `4dea7fe2`,2026-10-05,slot-1)

TURN:`yours phase=design epoch=1 run=4dea7fe2… node=eng_design attempt=1`(exec `5c2e402e`)。§30 是 run `1e45bf82`,它只走到交付 #1(`9a0fe6d17`,把陈旧的 `FIXED-FOR-CLAIM 1` 重置为 `AWAITING-QA`)+ implement 1/4 ledger(`57c364636`),没有返工;本轮是同一分支上的**新 run**,继续在其上工作,不 force-push。

| 项 | 结果 |
|---|---|
| 分支头(派发时) | `57c364636` = `origin/project-slot-1-FLY-3150` = PR #565 头(OPEN / MERGEABLE,标题仍是旧 run) |
| `origin/main` | `62a604d44`,领先 4 个提交(FLY-3224 / 3225 / 3226 / 3228 演练),`git diff --name-only HEAD...origin/main` 不含本 issue 文件夹与 `"$F"` → 路径不相交;按 §3.1 不同步 |
| 目标文件 | HEAD 上 = `QA-SBX FLY-2167 drill` / `AWAITING-QA`(上一轮交付 #1 写入);main 上仍是 `FIXED-FOR-CLAIM 1` → 本轮交付 #1 走**跳过分支**(`IMPL1=BASE`),PR 级净 diff 恰为 `-FIXED-FOR-CLAIM 1` / `+AWAITING-QA` |
| README | blob `1de5e367…`,未变 |
| progress.md | 派发时是 run `1e45bf82` 的 implement 1/4(旧 `IMPL1=9a0fe6d17`);本节点用 `--handoff` 覆盖为本轮 run |
| 收件箱 | 无 Lead 指令 |
| onboard skill | 不存在 → 直接 `stage set brainstorm` |
| Linear | Done(Lead 裁定);不碰 |

**结论**:与 §29(run `d1cedf09`)完全同形 —— 目标已是 `AWAITING-QA`,交付 #1 走跳过分支,复用 OPEN PR #565。跳过分支没有"残留 claim 假通过"风险:HEAD 上没有任何 `FIXED-FOR-CLAIM`。上一轮的 HANDIN、`IMPL1=9a0fe6d17`、评审、CI 都不是本轮证据。

**设计评审(run `4dea7fe2`)**:Codex(gpt-6-luna/xhigh,profile `school`,thread `01a10b30-4d5e…`)。R1(turn `01a10b30-55b7…`,blob `6f39d185…`,request `e366e934…`)APPROVED,零发现;因 companion 报 "completion inferred",追加一个 `--resume-last` 复述回合(turn `01a10b37-35a5…`)仍 APPROVED,`review-round --round 1` 绑定该回合;design-review.json rounds=2 / finalRound=1,`await-codex-gate design` 通过。founder HTML `design.html` 与 `d1-core-flow.*` 已覆盖为本轮版本。

## 32. 本次派发审计(run `c56b5f01`,2026-10-05,slot-1)

| 项 | 结果 |
|---|---|
| 分支头(派发时) | `dd3353e11` = `origin/project-slot-1-FLY-3150` = PR #565 头(OPEN / MERGEABLE,标题是 run `4dea7fe2`) |
| `origin/main` | `31975977e`,领先 6 个提交(FLY-3224 / 3225 / 3226 / 3227 / 3228 演练),`git diff --name-only $(merge-base)..origin/main` 不含本 issue 文件夹与 `"$F"` → 路径不相交;按 §3.1 不同步 |
| 目标文件 | HEAD 上 = `QA-SBX FLY-2167 drill` / `AWAITING-QA`;main 上仍是 `FIXED-FOR-CLAIM 1` → 本轮交付 #1 走**跳过分支**(`IMPL1=BASE`) |
| README | 未变(与 §31 同一份规则) |
| progress.md | 派发时是 run `4dea7fe2` 的 implement 2/4(`IMPL1=BASE=7b15f485…`);本节点用 `--handoff` 覆盖为本轮 run |
| onboard skill | 不存在 → 直接 `stage set brainstorm` |
| Linear | Done(Lead 裁定);不碰 |

**结论**:与 §31(run `4dea7fe2`)同形 —— 目标已是 `AWAITING-QA`,交付 #1 走跳过分支,复用 OPEN PR #565。上一轮的 HANDIN、`IMPL1=7b15f485…`、评审、CI 都不是本轮证据。

**设计评审(run `c56b5f01`)**:Codex(gpt-6-luna/xhigh,profile `school`,thread `01a10b6a-5d6e…`)。R1(turn `01a10b6a-63d3…`)CHANGES_REQUESTED:HIGH = ledger 提交落进 `BASE..HANDIN` 交付区间;P2 = `gh pr list --jq '.[0].number'` 空结果为 `null`。修复 = 「账本先行」(ledger 在冻结 `BASE` 之前,`HANDIN` = 实现提交,跳过分支 `HANDIN=BASE`,冻结后再写 ledger 即重新交付)+ `// empty`。R2(turn `01a10b72-af0b…`,blob `c5b889a8…`,request `d92d5a8c…`)APPROVED,"Turn completed";design-review.json rounds=2 / finalRound=2,`await-codex-gate design` 通过。founder HTML `design.html` 与 `d1-core-flow.*` 已覆盖为本轮版本。

## 33. 本次派发审计(run `5dbe2353`,2026-10-05,slot-1)

- 派发:exec `2f164e6d`,TURN `yours phase=design epoch=7`,inbox 无指令。README(`origin/main:qa-sbx/fly2167/README.md`)与上一轮一致,重读无变化。
- **新形态**:本地分支被重建在 `origin/main` `ab48f1517` 上(本地 = main,`"$F"` 也是 main 上的 `FIXED-FOR-CLAIM 1`),而 `origin/project-slot-1-FLY-3150` / OPEN PR #565 头是 run `c56b5f01` 的返工交付 `d6f34eb29`,领先 main 73、落后 8。直接从本地推送会是 non-fast-forward。处理:`git reset --hard origin/project-slot-1-FLY-3150`(本地无独有提交,无损)→ `git merge --no-ff origin/main`(`83d64747a`,`git merge-tree` 预检无冲突;main 的 8 个提交只碰 FLY-3224…3228 文件夹与 milestones)。
- 起点:`HEAD:"$F"` = `FIXED-FOR-CLAIM 1` → 交付 #1 走正常重置分支(1 个实现提交,patch `-FIXED-FOR-CLAIM 1` / `+AWAITING-QA`)。合并后 `origin/main` 是 HEAD 祖先,实现节点不再同步。
- 旧 progress.md handoff 指向 run `76a1d8a2`,是更早残留,不作 PREV。

## 34. 本次派发审计(run `bd3915a0`,2026-10-05,slot-1)

- 派发:exec `1fefc9d4`,TURN `yours phase=design epoch=1`,inbox 无指令。README(`origin/main:qa-sbx/fly2167/README.md`)重读无变化。onboard skill 不存在 → 直接 `stage set brainstorm`。
- 分支头 = `origin/project-slot-1-FLY-3150` = OPEN PR #565 头 `a8cc57c11`(MERGEABLE / CLEAN),即 run `5dbe2353` 实现第 3 次尝试(Lead 返工反馈给出 claim 4)的交付;`"$F"` = 陈旧 `FIXED-FOR-CLAIM 4`。
- `origin/main` `0c0793178` 领先 4 个提交(FLY-3224 / 3225 / 3226 / 3228),路径不相交 → 按 §3.1 不同步。
- 起点:交付 #1 走正常重置分支(1 个实现提交,patch `-FIXED-FOR-CLAIM 4` / `+AWAITING-QA`)。旧 progress.md handoff(`run=5dbe2353 … PREV=HANDIN1=394eb6304…`)与 claim 1 / 3 / 4 都不是本轮证据。
- **设计评审(run `bd3915a0`)**:Codex(gpt-6-luna/xhigh,profile `school`,thread `01a10be5-f07f…`,turn `01a10be5-f744…`,blob `d6a8a36c…`,request `eada6a81…`)R1 零发现 APPROVED,"Turn completed";design-review.json rounds=1 / finalRound=1,`await-codex-gate design` 通过。founder HTML `design.html` 与 `d1-core-flow.*` 已覆盖为本轮版本。

## 35. 本次派发审计(run `fc930bd2`,2026-10-05,slot-1)

- 派发:exec `5dcb2d33`,TURN `yours phase=design epoch=1 attempt=1`,inbox 无指令。README(`origin/main:qa-sbx/fly2167/README.md`)重读无变化。onboard skill 不存在 → 直接 `stage set brainstorm`。
- run `bd3915a0` 的 PR #565 已合入、远端分支已删;本地分支 = `origin/main` = `4c125c50a` → 不同步,首次推送新建远端分支并新开 PR。
- 起点:`"$F"` = main 上残留的 `FIXED-FOR-CLAIM 1` → 交付 #1 走正常重置分支(1 个实现提交,patch `-FIXED-FOR-CLAIM 1` / `+AWAITING-QA`)。旧 progress.md handoff(`run=bd3915a0 attempt=2; QA claim=1; PREV=18ba43d4…`)不是本轮证据。
- **设计评审(run `fc930bd2`)**:Codex(gpt-6-luna/xhigh,profile `school`,thread `01a10c50-8b37…`)。R1(turn `01a10c50-916d…`)CHANGES_REQUESTED:HIGH = §1 PR 断言整目录排除流程文档文件夹,看不到该目录内的额外改动(且 README 只授权一个文件)。修复 = §1 断言 4 文件夹白名单 + 断言 5 写明节点契约优先、演练内容仍单文件。R2(turn `01a10c54-7e1e…`,blob `3313ffdd…`,request `1daf82e9…`)零发现 APPROVED("inferred",但 `review-round --turn` + design-review.json rounds=2 / finalRound=2 直接过 `await-codex-gate design`)。founder HTML `design.html` 与 `d1-core-flow.*` 已覆盖为本轮版本。

## 36. 本次派发审计(run `dd21313e`,2026-10-05,slot-1)

- 派发:exec `9d174ddb`,TURN `yours phase=design epoch=1 attempt=1`,inbox 无指令。README(`origin/main:qa-sbx/fly2167/README.md`)重读无变化。onboard skill 不存在 → 直接 `stage set brainstorm`。
- run `fc930bd2` 的 PR #594 已合入、远端分支已删;本地分支 = `origin/main` = `e63535617` → 不同步,首次推送新建远端分支并新开 PR。
- 起点:`"$F"` = main 上残留的 `FIXED-FOR-CLAIM 1` → 交付 #1 走正常重置分支(1 个实现提交,patch `-FIXED-FOR-CLAIM 1` / `+AWAITING-QA`)。旧 progress.md handoff(`run=fc930bd2 attempt=2; QA claim=1; PREV=1b286ca2…`)不是本轮证据。
- 与 §35 同形,plan 沿用 §35 已评审(含 Codex r1 HIGH 修复后的文件夹白名单)结构,只更新本轮起点与 run id。
- **设计评审(run `dd21313e`)**:Codex(gpt-6-luna/xhigh,profile `business`,thread `01a10cf2-ff6d…`)。R1(turn `01a10cf3-05b6…`)CHANGES_REQUESTED:HIGH = README 只授权一个文件,计划放行文档文件夹。处置 = plan §1 断言 6:写明运行时节点契约(DOC-FLOW / 进度账本 / 设计 HTML)优先于仓库 README、不可删除,演练内容仍单文件,白名单封闭,交付摘要与 PR 正文显式披露。R2(turn `01a10cf8-0457…`,blob `a86c97a5…`,request `e01617ba…`)零发现 APPROVED,"Turn completed"。

## 37. 本次派发审计(run `a40703e6`,2026-10-05,slot-1)

- 派发:exec `9bf999e1`,TURN `yours phase=design epoch=1 attempt=1`,inbox 无指令。README(`origin/main:qa-sbx/fly2167/README.md`,blob `1de5e367…`)重读无变化。onboard skill 不存在 → 直接 `stage set brainstorm`。
- run `dd21313e` 的 PR #599 已合入、远端分支已删;本地分支 = `origin/main` = `3c3cbd5f8`(#599 之后 main 只多了 FLY-3227 演练交付 #598,只碰 `engineering/doc/FLY-3227-real-runner-drill/` 与 `engineering/doc/milestones/FLY-3227.md`,与本 issue 路径不相交)→ 不同步,首次推送新建远端分支并新开 PR。
- 起点:`"$F"` = main 上残留的 `FIXED-FOR-CLAIM 1` → 交付 #1 走正常重置分支(1 个实现提交,patch `-FIXED-FOR-CLAIM 1` / `+AWAITING-QA`)。旧 progress.md handoff(`run=dd21313e attempt=2; QA claim=1; PREV=599d81f2…`)不是本轮证据。
- 与 §36 同形,plan 沿用 §36 已评审结构(含 §1 断言 4 白名单 + 断言 6 指令优先级),只更新本轮起点与 run id。
