# FLY-2922 沙箱基线与镜像分支核对 — 调研
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-27
基于: exploration.md

全部为 2026-09-27 本机静态核对结果（`git`、`gh`、`sqlite3`、flywheel-comm dist 源码阅读）；未运行任何实现测试，未改动生产或沙箱数据库。R1 评审纠正处以「R1」标出。

## 1. 沙箱基线

| 项 | 核对命令 | 结果 |
|---|---|---|
| 工作分支与起点 | `git rev-list --count origin/main..HEAD`（写文档前） | 0（`project-slot-2-FLY-2922` = `origin/main@1855f7a1a`，未漂移） |
| 沙箱 main 有无本次 hold/recovery API | `git grep -n -E 'redispatch_current\|resumeWorkflowHold' origin/main -- packages` | exit 1、零命中。R1：沙箱 `StateStore.ts:11743` 等已有旧 `workflow_side_effect_ledger` 基础设施，所以结论收窄为「缺少本次统一恢复 API」，不是「没有账本」；不影响「不在沙箱重做实现」 |
| 沙箱 PR | `gh pr list --state all --search FLY-2922`、`--head flywheel-FLY-2922`、`--head project-slot-2-FLY-2922` | 全部 `[]`（Codex 沙箱内 gh 返回空 stdout，标 unverifiable；以本机结果为准） |
| 镜像分支头 | `git rev-parse origin/flywheel-FLY-2922` | `2dd29e0276617cf21e31ce4bfe2a4df792d8cf0a` |
| 生产 checkout 头 | `git -C /Users/xiaorongli/Dev/flywheel-FLY-2922 rev-parse HEAD` / `branch --show-current` / `status --porcelain` | 同上 / `flywheel-FLY-2922` / 空 |
| 生产 GitHub 远端头 | `git -C <prod> ls-remote --exit-code origin refs/heads/flywheel-FLY-2922` | 同上（只读，不改 remote-tracking ref） |
| 生产 PR | `gh pr view 1374 --repo xrliAnnie/flywheel --json state,headRefOid,body` | OPEN，head = 同上，正文 21004 字；含「FLY-2921 must land first」、四条 advisory disposition、两段 Follow-ups；**缺** `92e28887` |
| 镜像分支能否合进沙箱 main | `git merge-tree --write-tree origin/main origin/flywheel-FLY-2922` | exit 1，990 条 `CONFLICT`（`diff --stat` 16546 文件），两棵不同的树。R1：该命令会写 object database，不算零写入 |
| run 行 | `sqlite3 teamlead.db "select … from workflow_run where run_id='5928c374-…'"` | `template_id=tpl_code`，`current_node_id=eng_design`，`status=active`，`engine_owned=1`；resolved nodes = eng_design/implement/qa/founder_gate/land |
| TURN | `flywheel-comm turn` | `yours phase=design epoch=1` |
| mmdc | `mmdc --version` + 渲染三张图 | 11.12.0，本机可渲染（生产那轮的 MachPort 权限故障在本沙箱不存在） |
| Codex | `codex login status` | Logged in；companion `~/.claude/plugins/cache/openai-codex/codex/1.0.0/scripts/codex-companion.mjs` |

## 2. 镜像分支上已批准设计与实现的证据

分支 `origin/flywheel-FLY-2922` 的 `engineering/doc/FLY-2922-unified-node-recovery/` 含 exploration / research / plan / design-correction / review-result / implementation-evidence / delivery-evidence / watch-consumer-sweep / founder-report.html / 两张 `.mmd`；`engineering/doc/milestones/FLY-2922.md`（该头最后一次改动它的提交就是 `2dd29e027`）记录 PR #1374 与 QA@2/@3 返工链。关键 ID（来自这些文件与 Lead 交接原文；生产 comm DB 本轮不可访问，未复核）：

- 设计 gate `d9ab4f85-f464-4fee-9c09-7af6295b0c9a` / request `16c59728-…` APPROVED，计划提交 `c4d40fbed`；FLY-2921 合同补充 scoped gate `0f29f815-…` / request `b5e92e5c-…` APPROVED。
- 同头代码复审 `92e28887` APPROVED（2026-09-27 12:09:19Z，Lead 交接）。
- 最近提交：`2dd29e027 docs(FLY-2922): record review boundary fixes` ← `8c3e77445 fix(teamlead): close recovery review boundaries` ← `b3b7df787 Merge origin/flywheel-FLY-2921`（`git merge-base --is-ancestor 5357dd5ce origin/flywheel-FLY-2922` exit 0）。

Lead 裁定的 4 条 MEDIUM advisory 在实现头的落点（行号为 `2dd29e027`；R1 纠正了第 3、4 条）：

| Advisory | 分支落点 | 状态 |
|---|---|---|
| preadmission-producer-rework-carveout | `StateStore.ts:65063–65076` 对 rework delivery owner 提前返回 `rework_delivery_owned`（在 `:65135–65141` permanent-error 集合判断之前）；`:46300/:70224` 失败事件 failureKind 同名；1 个测试文件 | landed |
| merge-order-dependency-unstated | milestone 与 PR body「FLY-2921 merge dependency」：FLY-2921 先合、`5357dd5ce` 已合入、后合方保留 `pending + new preferred actor` | stated |
| shared-materializer-preconditions | rework 恢复路径 `StateStore.ts:63086 → materializeWorkflowReworkRecoveryTx:62919 → materializeReworkReplacementCoreTx:45593`；内核 `:45625–45656` 校验事务存在、run 状态、route/delivery/node/actor tuple、materialized writer、owner/generation、替身预算（`replacement_budget_exhausted`）。`:63099 materializeWorkflowNodeReplacementTx` 是**非** rework 分支 | landed |
| rework-replacement-context-not-preflighted | `bridge/workflow-node-recovery.ts:243–246` 调用 `getWorkflowReworkReplacementContextPreflight`，失败即抛；失败 `throw new Error(context.reason)`，上下文无效即 `engine_rework_replacement_context_invalid`（`StateStore.ts:44217–44225`）；`bridge/runs-route.ts` stage `:535–542` / apply `:671–677` 对 Error 返回 HTTP 409 并保留该具体 reason（`recovery_preflight_failed` 只是非 Error 的兜底值）；`StateStore.ts:62704–62725` 事务内复查 preflight digest，变化即 `recovery_preflight_required` 回滚。建议的错误码字符串 `rework_replacement_context_unlaunchable` 只出现在历史 review-result.md，运行时无此名字**不等于**无预检 | landed |

`cascadeRunTerminationOnCarrierClose` 在分支 `packages/` 下 0 命中（已删除）；`commitEnrolledFailure` 在 `StateStore.ts:70266` 与 `bridge/workflow-failure-completion.ts`。

## 3. 交卷命令的真实语义（flywheel-comm dist 源码）

- `complete --route needs_review`：`--pr` 可选（强制 PR 只对 `pr_handoff`，`complete.js:114–131`）；给了 `--pr` 才写 `evidence.landingStatus={status:'ready_to_merge',prNumber}`（`:211–217`）；缺 `--question-id` 只 warn（`:322`）。`FLYWHEEL_FOUNDER_REVIEW_REQUIRED=1` 时再校验（本 slot env 未设）。
- **R1 HIGH**：`--target-repo` 与 `--declare-pr` 都经 `resolveEvidenceRepo`（`:800–834`）：绝对路径 / `~` / `..` 直接 `exit 1`（`:807–812`），相对路径必须 realpath 严格位于当前 worktree 之下（`:815–821`）且是嵌套仓库根（`:823–828`）。生产 checkout `/Users/xiaorongli/Dev/flywheel-FLY-2922` 任何写法都不可能通过。故 completion 证据（`collectEvidence :709–754`）只能来自沙箱 worktree，`evidence.headSha` = 沙箱 HEAD。
- `complete --route phase_design_complete`：要求 `merge-base(HEAD, origin/main)..HEAD` 范围内存在已提交 `.html`（`:636–655`），路径匹配 `(^|/)doc/FLY-2922(?:-[^/]+)?/`（`design-html-evidence.js:15–16`）—— `engineering/doc/FLY-2922-unified-node-recovery/*.html` 满足。「engine-owned gate」提示只在 `completionDisposition === 'engine_gate_handoff'` 时打印（`:367–379`）。
- `ask --report`：fire-and-forget 报告（`dist/index.js:655–657`），不是待答问题（`dist/db.js:6743–6752`）；等回复要用普通 `ask` + `check`。
- `ci-full ensure`：用 `process.cwd()` 的仓库跑 `gh pr view <pr>`（`ci-full.js:186–195, 549`），不带 repo 参数；从沙箱根执行只会查沙箱仓。
- `progress` 只接受 `--phase/--cursor/--next/--handoff/--set-chunk/--pointer`，会 path-limited commit progress.md（`progress.js:81–104`）。
- `stage set` 只有 set；design 节点停在 brainstorm/research/plan 档跑 `progress --phase design` 可过。

## 4. 对 implement / qa 节点的直接含义

- implement 节点没有代码工作：核验对象是「镜像头 = 生产 checkout 头 = GitHub 远端头 = `2dd29e027…`」且两处树净、生产 PR 指向同一头；交卷证据按 Lead 原文引用复审 `92e28887`。
- 交卷不能把生产 checkout 绑进 completion 证据；默认 Lane A 不传 `--pr`，报告分列沙箱 docs HEAD 与已核验实现头 + 生产仓身份 + PR #1374。`--pr 1374` 不带 repo 会让后端在沙箱仓找不存在的 PR，不用。
- 生产 PR #1374 正文已含合入顺序、四条 advisory 处置、LOW follow-ups；只缺 `92e28887`。沙箱 runner 不编辑生产 PR，缺项由 Lead 宿主侧补。
- QA 判据来自 Lead 原文：新精确头 full CI 绿（须在生产仓上下文取证）；按 FLY-2921 先合的顺序可落地（`merge-tree` 无冲突）；529 N-to-N 真 runner 由 Lead 宿主侧起房代跑。
