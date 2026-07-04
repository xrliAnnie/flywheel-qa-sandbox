# FLY-846 auto-QA 误 spawn 三重 gate — 探索

Issue: FLY-846 (https://linear.app/geoforge3d/issue/FLY-846/infrap1-auto-qa-在-qa-issue-上又-spawn-qa-of-qa-guard-没生效潜在-runawayfly)
日期: 2026-07-04
基于: 无

## 问题

FLY-579 auto-QA 在 main session 进 `awaiting_review` 时自动 spawn 独立 QA。生产中反复出现三类误 spawn（FLY-828/842/845/852），每次都占 runner + slot + 搅乱 cmux，且误 spawn 的 QA 完成时又进 `awaiting_review` → 潜在 runaway 级联。Lead 一直手动砍，不是解法。

## 生产 DB 取证（~/.flywheel/teamlead.db 只读）

### ① QA-of-QA：session_role guard 挡不住「QA issue 上的 main session」

现有 guard 只有 `session.session_role === "main"`（event-route.ts:1834 + DirectEventSink.ts:623 + coordinator:237）。但事故 session 是：

| execution | issue | issue_title | role | 结果 |
|---|---|---|---|---|
| `40f6e931` | FLY-824 | "QA · FLY-793 — …" | **main** | 进 awaiting_review → spawn FLY-828 = QA·(QA·FLY-793) |
| `4b25f8b6` | FLY-839 | "QA · FLY-818 — …" | **main** | 同上 → spawn FLY-845 = QA·(QA·FLY-818) |

也就是说：**QA issue（`QA · FLY-XX`）本身被当普通 issue 派了 main-role runner**（Lead 手动 dispatch / 修复轮），它完成时 role=main、按流程进 awaiting_review，coordinator 对「issue 本身是不是 QA issue」零感知 → QA-of-QA。FLY-828 note 里写的修法（跳过 QA issue）归了 FLY-579/827 但从没实现。

### ② 过早 spawn：瞬时/未完成的 awaiting_review 也 spawn

FLY-842 的 parent `e6235910`（FLY-696 main）事件序列：

```
onboard → brainstorm → research → plan → design_review → implement
→ session_completed（空 payload）→ awaiting_review   ← 还在 implement 阶段!
→ spawn FLY-842
→ terminate（Lead 砍）
```

它从未到 pr_created / code_review，没有 PR、没有 review gate 绑定——是 body-kill/异常完成引发的瞬时 awaiting_review。现有 `freshTransition` guard 只挡「重复发射/parked」，挡不住「第一次就是假的」。

**可靠信号**（全量 30 条 auto_qa_record 对照 parent session）：
- 所有合法 spawn 的 parent：`review_question_id`（approve gate 绑定,FLY-191 Phase 2）或 `pr_number` **至少有其一**；
- 两条坏 spawn（FLY-842/845 的 parent）：**双缺**（只有 cwd HEAD 的 pr_head_sha）。
- 三段式 pipeline（FLY-793）的 implement parent `9826ae47`：role=main 且带 qid → 不受影响。
- 注意 `review_question_id` 有 `"unbound"` 哨兵（REVIEW_BINDING_UNBOUND,qid-less HTTP 完成写入）→ 须视同缺失。

### ③ 重复 spawn：dedup 键是 execution 级,不是 issue 级

`claimAutoQaRecord` 以 `(parent_execution_id, sha)` 为键。FLY-696 有两个 main execution（`e6235910` 后被 terminate、`5037e84f` 真完成），各自 claim 各自的 record → FLY-842 + FLY-852 两个 QA issue 同时存在。旧 record 只在 **Bridge 重启的 reconcileOnStartup** 里才会被 supersede——运行期没有 issue 级互斥。

## 修法（三条 gate,全部收敛在 AutoQaCoordinator.onMainAwaitingReview 单一咽喉）

两个调用点（event-route + DirectEventSink）都进 coordinator,在 coordinator 内部加 gate = 一处修、两侧生效、单元可测。

**Gate ①（QA issue 永不再 QA）**——role 检查后立即判定,任一命中即 skip（log-only,不 alert;普通 review 流程照走,Lead 会看到）:
- `issue_title` 匹配 `/^\s*QA\s*·/`（auto-qa-effects:533 的生成格式,也覆盖 Lead 手建的 QA issue）;
- StateStore 新查询 `isAutoQaIssue()`：issue_id/issue_identifier 命中任何 auto_qa_record 的 qa_issue_id/qa_issue_identifier（本地等价于「有 qa_of 链接」,不打 Linear API;注意 issue_id 存量数据 UUID/identifier 混形,两个键都查）。

**Gate ②（只在真完成 spawn）**——policy + sha 检查后、owner-record 分支前:
- `hasReviewEvidence = (review_question_id 非空且 ≠ "unbound") || pr_number 非空`;
- 双缺 → log + return（不 claim、不 alert;parent 走普通 review 路径,degraded-but-safe,绝不 wedge）。
- 时序已核实:两个 sink 都在调 coordinator **之前**写完 review binding + pr_number（event-route: writeReviewBinding/patchCompletionEvidence 在 :1047-1180,coordinator 调用在 :1830;DirectEventSink: upsert 在 :480,调用在 :629）。
- retest 路径同样过 gate ②:fix-loop 的 re-request 协议本就带新 qid（protectedBinding 情形保留旧 qid,同样有值）,不破 FLY-752。

**Gate ③（一 issue 一 QA）**——claim 之前,StateStore 新查询 `listActiveAutoQaRecordsForIssue()`（status ∈ {running, awaiting_retest, stuck},排除本 parent execution）:
- 命中且对方 parent 仍 `awaiting_review`（活的）→ **skip + alertLeadPipelineError**（一 issue 两个活 main 挂着 QA = 真异常,Lead 处理）;
- 命中但对方 parent 已终态（terminated/failed/…）→ **事件驱动地做 reconcile 同款清理**：旧 record 置 superseded + best-effort close 旧 QA runner,然后放行新 spawn（FLY-696 案例里这正是人工最终做的事;不然合法新完成会被死人挡住,或者要等下次 Bridge 重启）。

## 边界与不做的事

- 不改 schema（只加 StateStore 查询）;不加 feature flag（现行为就是 bug,gate 是纯安全收紧;三条 gate 的 skip 都退化为 pre-FLY-579 的普通 review 路径,不会 wedge）。
- 不动 founder ship gate / verify-approval / FSM / 三段式 phase-orchestrator。
- 手动 QA（Lead 自建 QA issue + qa-role runner,无 auto_qa_record）不在 ③ 的检测范围——runaway 源是 auto 管线,①的 title 前缀已把手建 QA issue 挡在「被再 QA」之外。
- 不回收生产里现存的坏 record（FLY-842/845/828 已是 superseded/blocked;FLY-852 由 Lead 决定去留）。

## 预期结果

- QA issue 上任何 session 进 awaiting_review → 永不 spawn QA-of-QA（FLY-828/845 型绝迹）。
- implement 半路被杀/瞬时完成 → 不 spawn（FLY-842 型绝迹）;真完成（qid 或 PR 证据）照常 spawn。
- 同 issue 并发/接力 execution → 最多一个活 QA;死 parent 的旧 QA 被事件驱动清理(不再等重启)。
