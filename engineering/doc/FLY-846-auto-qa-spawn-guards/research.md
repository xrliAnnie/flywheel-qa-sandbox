# FLY-846 auto-QA 误 spawn 三重 gate — 调研

Issue: FLY-846 (https://linear.app/geoforge3d/issue/FLY-846/infrap1-auto-qa-在-qa-issue-上又-spawn-qa-of-qa-guard-没生效潜在-runawayfly)
日期: 2026-07-04
基于: exploration.md

## 改动面（全部在 packages/teamlead）

| 文件 | 改动 |
|---|---|
| `src/bridge/auto-qa-coordinator.ts` | `onMainAwaitingReview` 内加三条 gate（唯一行为改动点） |
| `src/StateStore.ts` | 新增两个只读查询：`isAutoQaIssue()`、`listActiveAutoQaRecordsForIssue()`（不改 schema） |
| `src/bridge/__tests__/auto-qa-coordinator.test.ts` | 新 gate 场景测试 |
| `src/__tests__/StateStore*.test.ts` | 新查询单测 |

调用点（event-route.ts:1830、DirectEventSink.ts:629）**零改动** —— gate 收敛在 coordinator 内部，两侧自动生效。

## 关键代码事实（已核实）

### 现有 guard 链（onMainAwaitingReview, coordinator:233-318）

```
role!==main → return          (coordinator:237; 两调用点也各有同判)
policy off  → return          (:240)
sha 缺/坏   → Lead alert+return (:252, fail-closed)
owner record 存在:
  同 head → dedup no-op        (:271)
  新 head → driveRetest        (:282, FLY-752 fix-loop)
无 owner record:
  !freshTransition → return    (:288, 只挡重复发射)
  claim → spawnQa              (:298)
```

### Gate ② 的证据字段写入时序（两 sink 都先写后调,已核实）

- **HTTP /events**（event-route.ts）：`writeReviewBinding()`（:1047,写 `review_question_id` + `pr_head_sha`）与 `patchCompletionEvidence()`（:1059,写 `pr_number`）在完成处理主干（:1095-1180）执行；auto-QA 调用在 :1830,且 :1823 重新 `getSession` → coordinator 看到的是**已带证据**的 session row。
- **in-process**（DirectEventSink.ts）：`pr_number` 随 upsert 写入（:480/:512）；auto-QA 调用在 :629 且重新 `getSession`。该 sink **从不写 qid**（qid 只来自 runner CLI 的 HTTP payload）——但真完成若 runner 死于 complete 之前,landing signal（land-status.json）里的 `prNumber` 仍会进 evidence → `pr_number` 有值。
- `REVIEW_BINDING_UNBOUND = "unbound"`（StateStore.ts:550）：qid-less 的 HTTP needs_review 完成会写入该哨兵（event-route:1050 `?? REVIEW_BINDING_UNBOUND`）→ gate ② 必须视同缺失。

### 证据谓词的全量历史回测（生产 DB, 30 条 auto_qa_record × parent session）

`(qid 非空且≠unbound) || pr_number 非空`：

- 28 条合法 spawn：**全部通过**（含三段式 FLY-793 的 parent `9826ae47`——role=main、qid 有值；含 LEARN 项目 qid-less 但带 pr_number 的形态）。
- 2 条坏 spawn（FLY-842 parent `e6235910`、FLY-845 parent `4b25f8b6`）：**全部拦截**（双缺）。
- 误伤率 0/28,漏拦率 0/2。

### Gate ① 的 QA issue 判定

- 生成侧格式固定：`auto-qa-effects.ts:533` → `const title = "QA · " + ident + titleSuffix`。正则 `/^\s*QA\s*·/` 同时覆盖 Lead 手建 QA issue（生产惯例同款前缀,如 FLY-389/390）。
- 本地权威判定：`auto_qa_record.qa_issue_id / qa_issue_identifier` 两列（FLY-643 起持久化）。**存量数据 issue 键形态混杂**（`sessions.issue_id` 有 UUID 也有 identifier;record 的 `issue_id` 同样混杂）→ 查询必须同时拿 session 的 `issue_id` 和 `issue_identifier` 两个键去撞 record 的两列。
- session 侧字段：`session_role`（已有 guard）、`issue_title`、`issue_identifier` 均在 sessions 表（事故 session 的 issue_title 均有值,形如 "QA · FLY-793 — …"）。

### Gate ③ 的语义（Lead 已拍板）

- 活 record = status ∈ {running, awaiting_retest, stuck}（`passed`=已完成不挡、`failed`=legacy 终态不挡、`superseded`=moot）。
- 排除本 parent execution（同 parent 的 record 由上方 owner 分支处理,走到 claim 前时命中的必为**他人**的 record）。
- 对方 parent 仍 `awaiting_review` → skip + `alertLeadPipelineError`（真异常）。
- 对方 parent 已终态/不存在 → **supersede 旧 record + best-effort closeQaRunner(旧 QA 若还活着) + 放行新 spawn**——与 `reconcileOnStartup` 的 running-sweep（coordinator:776-792,parent 走掉 → superseded）语义一致,只是事件驱动、不等重启。复用现有 `setAutoQaStatus(..., "superseded")` 与 `effects.closeQaRunner`。

### 测试基建（已核实兼容）

- `auto-qa-coordinator.test.ts` 用真 in-memory StateStore + fake effects;现有 `awaitingMain()` helper 已设 `pr_number: 42` + `setReviewBinding(qid)` → **gate ② 不破坏存量测试**,新增用例只需显式造「无证据」session。
- StateStore 为 sql.js 风格（prepare/bind/step/free）,新查询照抄 `listAutoQaRecordsByStatus` 模式。

## 风险清单

| 风险 | 结论 |
|---|---|
| gate ② 误伤三段式 pipeline | 不会——implement phase 的 parent session 带 qid（生产 `9826ae47` 实证） |
| gate ② 误伤 FLY-752 retest | 不会——re-request 协议带新 qid;qid-less 重发被 protectedBinding 保留旧 qid,字段仍有值 |
| dual-sink 先后序打乱证据可见性 | 不会——runner CLI 的 HTTP 完成先于 in-process EdgeWorker 完成;且两 sink 各自先写证据再调 coordinator |
| gate ③ supersede 误杀活 QA | 只在对方 parent 已终态时 supersede;活 parent 走 skip+alert 分支 |
| skip 后 parent 卡死 | 不会——不 claim 即无 held record,`auto-qa-held` 抑制不生效,founder 走普通 review 通知（pre-FLY-579 行为） |
| 新查询性能 | auto_qa_record 全表 <100 行,`status` 已有索引,忽略 |

## 不改的东西

event-route / DirectEventSink 调用点、auto-qa-policy、auto-qa-effects、auto-qa-held、phase-orchestrator、FSM、schema、founder ship gate、reconcileOnStartup（其 supersede 逻辑保留,作为 gate ③ 的兜底）。
