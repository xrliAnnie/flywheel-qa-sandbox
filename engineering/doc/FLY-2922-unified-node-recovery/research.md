# FLY-2922 沙箱基线与镜像分支核对 — 调研
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-27
基于: exploration.md

全部为 2026-09-27 本机静态核对结果（`git`、`gh`、`sqlite3`、flywheel-comm dist 源码阅读）；未运行任何实现测试，未改动生产或沙箱数据库。

## 1. 沙箱基线

| 项 | 核对命令 | 结果 |
|---|---|---|
| 工作分支与起点 | `git rev-list --count origin/main..HEAD` | 0（`project-slot-2-FLY-2922` = `origin/main@1855f7a1a`，未漂移） |
| 沙箱 main 有无 hold/recovery 子系统 | `git grep -c 'redispatch_current\|resumeWorkflowHold\|workflow_side_effect_ledger' origin/main` | 0 命中 |
| 沙箱 PR | `gh pr list --state all --search FLY-2922`、`--head flywheel-FLY-2922`、`--head project-slot-2-FLY-2922` | 全部 `[]`，沙箱没有任何 FLY-2922 PR |
| 镜像分支头 | `git rev-parse origin/flywheel-FLY-2922` | `2dd29e0276617cf21e31ce4bfe2a4df792d8cf0a` |
| 生产 checkout 头 | `git -C /Users/xiaorongli/Dev/flywheel-FLY-2922 rev-parse HEAD` | 同上（分支 `flywheel-FLY-2922`） |
| 镜像分支能否合进沙箱 main | `git merge-tree --write-tree origin/main origin/flywheel-FLY-2922` | exit 1（冲突；`diff --stat` 16546 文件），两棵不同的树 |
| run 行 | `sqlite3 teamlead.db "select … from workflow_run where run_id='5928c374-…'"` | `template_id=tpl_code`，`current_node_id=eng_design`，`status=active`，`engine_owned=1`；resolved nodes = eng_design/implement/qa/founder_gate/land |
| TURN | `flywheel-comm turn` | `yours phase=design epoch=1` |
| mmdc | `mmdc --version` + 试渲 `recovery-flow.mmd` | 11.12.0，本机可渲染（exit 0，输出 SVG）；生产那轮的 MachPort 权限故障在本沙箱不存在 |
| Codex | `codex login status` | Logged in（companion `~/.claude/plugins/cache/openai-codex/codex/1.0.0/scripts/codex-companion.mjs`） |

## 2. 镜像分支上已批准设计与实现的证据

分支 `origin/flywheel-FLY-2922` 的 `engineering/doc/FLY-2922-unified-node-recovery/` 含 exploration / research / plan / design-correction / review-result / implementation-evidence / delivery-evidence / watch-consumer-sweep / founder-report.html / 两张 `.mmd`；`engineering/doc/milestones/FLY-2922.md` 记录 PR #1374 与 QA@2/@3 返工链。关键 ID（均来自这些文件与 Lead 交接原文，本轮无法访问生产 comm DB 复核）：

- 设计 gate `d9ab4f85-f464-4fee-9c09-7af6295b0c9a` / request `16c59728-…` APPROVED，计划提交 `c4d40fbed`；FLY-2921 合同补充 scoped gate `0f29f815-…` / request `b5e92e5c-…` APPROVED。
- 同头代码复审 `92e28887` APPROVED（2026-09-27 12:09:19Z，Lead 交接）。
- 分支最近提交：`2dd29e027 docs(FLY-2922): record review boundary fixes` ← `8c3e77445 fix(teamlead): close recovery review boundaries` ← `b3b7df787 Merge origin/flywheel-FLY-2921`（FLY-2921 候选头 `5357dd5ce` 已合入）。

Lead 裁定的 4 条 MEDIUM advisory 在分支代码里的落点（`git grep` 于 `origin/flywheel-FLY-2922`，行号为该头）：

| Advisory | 分支落点 | 状态 |
|---|---|---|
| preadmission-producer-rework-carveout | `StateStore.ts:65075` `rework_delivery_owned` 拒绝；`:46300/:70224` 失败事件 failureKind 同名；1 个测试文件覆盖 | 已落实 |
| merge-order-dependency-unstated | `milestones/FLY-2922.md`：「FLY-2921 必须先合；本分支先合入其 `e9a72127f`…后合方保留 pending + new preferred actor」，且已合入 `5357dd5ce` | 已写明；PR 正文由 implement 节点交卷报告复述 |
| shared-materializer-preconditions | `StateStore.ts:66707 materializeWorkflowNodeReplacementTx`（调用点 63099 / 66648）；`45656/46140/50090 replacement_budget_exhausted`；`interpreted_by='engine:operator_recovery'` 入口 44380/47228/62970 | 已落实（held CAS / budget / writer proof 在方法内校验） |
| rework-replacement-context-not-preflighted | 无独立 `rework_replacement_context_unlaunchable` 409 码；分支把 `engine_rework_replacement_context_invalid` 列入 pre-admission producer 的永久错误集（`StateStore.ts:65139`）→ 一次登记回到统一入口，dispatcher `:2833/:2839/:3016` 仍是消费端硬拒 | 部分：以「一次登记、不循环」替代 stage 预检；作为 PR Follow-up 明示 |

`cascadeRunTerminationOnCarrierClose` 在分支上 0 命中（已删除）；`commitEnrolledFailure` 在 `StateStore.ts:70266` 与 `bridge/workflow-failure-completion.ts` 存在。

## 3. 交卷命令的真实语义（flywheel-comm dist 源码）

- `complete --route needs_review`：`--pr` 可选；给了 `--pr` 才写 `evidence.landingStatus={status:'ready_to_merge',prNumber}`；`--target-repo <path>` 需与 `--pr` 同给，证据（HEAD、diff、commit 数）改从该路径收集（`resolveEvidenceRepo`）；缺 `--question-id` 只 warn 不拒。`FLYWHEEL_FOUNDER_REVIEW_REQUIRED=1` 时会再校验（本 slot env 未设）。
- `complete --route phase_design_complete`：要求 `merge-base(HEAD, origin/main)..HEAD` 范围内存在已提交 `.html`，路径匹配 `(^|/)doc/FLY-2922(?:-[^/]+)?/` —— `engineering/doc/FLY-2922-unified-node-recovery/*.html` 满足。
- `progress` 只接受 `--phase/--cursor/--next/--handoff/--set-chunk/--pointer`，会 path-limited commit progress.md。
- `stage set` 只有 set；design 节点停在 brainstorm/research/plan 档跑 `progress --phase design` 可过（记忆 ⑩）。

## 4. 对 implement / qa 节点的直接含义

- implement 节点没有代码工作：核验对象是「镜像头 = 生产 checkout 头 = `2dd29e027…`」且两处树净；交卷证据按 Lead 原文引用复审 `92e28887`。
- 沙箱开不出一个能合进沙箱 main 的 PR；若 Lead 无答复，PR 证据用生产 PR #1374 并以 `--target-repo` 指向生产 checkout，让 `landingStatus.targetRepoPath` 明示证据来源。
- QA 判据来自 Lead 原文：新精确头 full CI 绿；按 FLY-2921 先合的顺序可落地（`merge-tree` 无冲突）；529 N-to-N 真 runner 由 Lead 宿主侧起房代跑。沙箱 QA 节点自身对 `ci-full ensure --pr 1374` 的结果要如实记录，不能拿沙箱空 CI 冒充。
