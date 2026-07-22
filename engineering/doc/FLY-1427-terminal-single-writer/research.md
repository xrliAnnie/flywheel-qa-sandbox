# FLY-1427 终态单写入者 + 覆盖保护 — 调研

Issue: FLY-1427 (https://linear.app/geoforge3d/issue/FLY-1427/enginebug5-dag-收尾第二写入者覆盖-terminate-终态completed-骗写-终态单写入者-覆盖保护)
日期: 2026-07-22
基于: exploration.md

## 1. sessions.status 写入者全量盘点（代码级审计）

| # | 写入者 | 载体 | 现有守卫 | 结论 |
|---|--------|------|----------|------|
| 1 | `persistTransition`（经 `applyTransition`，applyTransition.ts:42） | 所有 FSM 动作（terminate/approve/retry/…） | `WORKFLOW_TRANSITIONS` 转移表，`terminated: []` 无出边 | ✅ 正门 |
| 2 | `DirectEventSink.emitCompleted/emitFailed` 非-enrolled 分支（DirectEventSink.ts:842/1181） | 进程内 Blueprint 收尾 | FLY-228 Finding K：前置状态无出边 → 整个 completion 忽略（DirectEventSink.ts:776） | ✅ |
| 3 | **`recordEnrolledTerminalSignal`**（StateStore.ts:16284） | 进程内（DirectEventSink.ts:530/1145 enrolled 早退）+ HTTP `/events` 非-flywheel-comm 源（event-route.ts:719/748） | **无** — 读了 previousStatus 只用于 terminal_at/revision | ❌ **事故写入者** |
| 4 | **`commitEnrolledCompletion` → `projectGeneralizedCompletionTx`**（StateStore.ts:17727） | HTTP `/events` source=flywheel-comm（event-route.ts:668） | **无** — 无条件 `SET status='completed'` | ❌ 同类洞 |
| 5 | `forceStatus`（deprecated，StateStore.ts:3601） | HeartbeatService.ts:1425/2674、plugin.ts:10072、actions.ts:577/1480、complete-marker-reconciler.ts:808 | 全部是 `applyTransition` 优先的 legacy fallback（生产 wires transitionOpts），marker-reconciler 另有 `status !== 'running'` 显式守卫 | ✅ |
| 6 | `finalizeRecoveredMerge` upsertSession（merge-ship-gate.ts:517，自述「第四完成写入路径」） | 恢复路径 | merge_block marker 存在 + head 绑定 + ship-eligible 三重前置（隐含 parked awaiting_review） | ✅（相邻面，不动） |
| 7 | event-route.ts:1672/1917 upsertSession | HTTP | `if (transitionOpts)` 的 else 分支 = legacy test seam，生产走 applyTransition | ✅ |
| 8 | retry 专用 SQL（StateStore.ts:5022-5110 等） | retry 流 | 各自 WHERE 条件 | ✅ |
| 9 | `observeEnrolledTeardown`（StateStore.ts:17909，也调 projectGeneralizedCompletionTx） | 仅测试引用，无生产调用方 | — | 随 #4 的守卫一并被覆盖 |

**结论：全库只有 #3、#4 两个写入者绕过 FSM 终态语义**，且都专属 generalized（DAG）路径——与生产证据（5/5 被覆盖全是 DAG、300/300 非-DAG 记对）严格互证。

## 2. 事故触发链（代码指针）

terminate 动作（actions.ts:551）→ `applyTransition` 写 terminated（正确）→ close-runner 杀 tmux → runner CLI 退出 → EdgeWorker `Blueprint.emitTerminal`（Blueprint.ts:2733）照常收尾 → `ExecutionEventEmitter.emitCompleted` → `DirectEventSink.emitCompleted` → **第 530 行 enrolled 早退**（位于第 776 行 Finding K 守卫之前）→ `recordEnrolledTerminalSignal` 无条件覆盖。生产事件时序（06:57:04 terminate → 06:57:06 覆盖）与 payload 指纹 `{failureKind, lastError}` 均已比对吻合。

## 3. 关键机制事实（决定守卫放哪、长什么样）

### 3.1 终态集合的单一事实来源
- FSM 无出边集合 = `{approved, completed, shelved, terminated}`（workflow-fsm.ts:120-184，`transitions[s].length === 0`）。FLY-228 守卫用的正是这个判据。
- 现存的 `ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES`（StateStore.ts:282）是 zombie 清扫语义，**含有出边状态**（failed/blocked/rejected/deferred），不能拿来做覆盖免疫——否则 running→failed 之后合法的 shelve/terminate 语义会被搅浑。免疫集必须取 FSM 无出边集合。
- flywheel-core 已是 teamlead 的 workspace 依赖（package.json:39）；StateStore 目前不 import flywheel-core，新增一个 import 即可。

### 3.2 事务原子性
StateStore 已迁 better-sqlite3（StateStore.ts:11），`db.transaction()` 同步单进程执行——**事务内读 previousStatus + 条件写就是 CAS**，无 TOCTOU，不需要 DB trigger。

### 3.3 teardown fact 必须照常落地
`recordEnrolledTerminalSignal` 除 session 状态外还写两笔账：session_events 生命周期审计 + `generalized_teardown_recorded` fact（`hasWorkflowExecutionTeardownFact` 的数据源，run 收尾/清扫依赖它知道进程确实死了）。守卫**只能压掉 sessions.status 投影**，审计与 teardown fact 必须照写——否则 run 级收尾账不平。

### 3.4 拒绝 vs 保留的语义分叉
- **`recordEnrolledTerminalSignal`（信号是「进程死了」）**：状态被保留、事实照记 → 返回 `ok:true + statusPreserved:true`。调用方影响：
  - `DirectEventSink.emitFailed`（1161 行）用 `recorded.status` 决定 CommDB enqueue（failed/blocked）——statusPreserved 时必须跳过（terminated 的 session 不能给 CommDB 造 failed 假账）；
  - `DirectEventSink.emitCompleted`（538 行）只 log；
  - event-route 719/748 返回 200 `held_recorded`，加 `statusPreserved` 字段即可。
- **`commitEnrolledCompletion`（信号是「我的产出请入账」）**：被 terminate 的执行产出**不算数**——整单拒绝（不落 completion receipt、`commitWorkflowTransitionTx` 不跑、引擎不推进），返回 `ok:false, reason:'terminal_status_immune'`。节点命运交还既有 dead-exec 机制（FLY-1385/FLY-1417）。

### 3.5 CLI 侧不能被 409 打进 marker 死循环
`flywheel-comm complete` 对任何非-2xx 重试 N 次后 FAIL-CLOSE 写 marker（complete.ts:263-309），marker 会被 complete-marker-reconciler 反复replay。已有先例：`stale_execution_superseded` 在 event-route 里映射为 **200 + settled**（event-route.ts:679-684），CLI 当场成功退出、零 marker。`terminal_status_immune` 必须走同一形态：200 + `settled:"terminal_status_immune"`——信号已送达且结论永定（你被 terminate 了，产出不入账），重试不可能改变结果。旧 marker（修复前写下的）replay 时同样命中 settled → reconciler 验证 session 已终态后删 marker，自然收敛。

### 3.6 replay 腐蚀窗口（守卫要下沉到 projectGeneralizedCompletionTx 的原因）
`commitEnrolledCompletion` 的幂等 replay 腿和 `observeEnrolledTeardown` 都直接调 `projectGeneralizedCompletionTx`。存在真实 crash 窗口：receipt 落库后、投影前崩溃 → session 停在 running → 人 terminate → 之后 replay 会再次投影 completed 覆盖 terminated。所以守卫必须同时下沉到 `projectGeneralizedCompletionTx` 内部（跳过 sessions 写、保留 workflow_run_node 的 done 记账——节点确实完成过，run 账要平；session 终态语义是「这个执行被人叫停」，两本账各记各的）。

## 4. 存量 5 行的修复语义

- `terminal_at`：terminate 时已由 `applyTerminalTimestamp` 正确落stamp，覆盖写因「已终态→终态」no-op 保留了原 stamp（StateStore.ts:3289 `isTerminal && !wasTerminal` 才写）——**无需修**。
- `lifecycle_revision`：覆盖时被 bump 过一次；修正回 terminated 需再 bump（保持单调，FLY-245 freshness 合同）。
- `session_stage='started'`：诚实状态（stage 确实没推进过），**不动**。
- 下游副作用核查：done-thread-archiver 已在覆盖前归档过 FLY-1414 的 thread（事件账可见），改回 terminated 不触发任何 FSM 转移事件（直接 UPDATE，非 applyTransition），终态→终态对 reconciler 家族（crash-reaper/zombie-scan 等已有 FLY-228/229 terminal-immunity）零刺激。
- 三个 run（held, engine_owned=1）与 5 个 node（state=running）**不在本单动**：node 命运归 dead-exec sweep 既有机制。

## 5. 备选方案与否决理由

| 方案 | 否决理由 |
|------|----------|
| A. 把 enrolled 写入改道 `applyTransition`（字面「复用 FSM」） | applyTransition 在 bridge 层、依赖 fsm+opts 注入；recordEnrolledTerminalSignal 是 events+session+teardown 三表单事务，改道会拆散原子性或要把 FSM 机器塞进 StateStore。取其语义（转移表）不取其机器。 |
| B. 完整 FSM 边校验（`canTransition(prev, next)` 才准写） | 比免疫集更严：会连 pending→completed / failed→completed 这类「非无出边但也非法」的写一并拒掉，可能卡死 never-started 执行的 teardown 收敛路径。证据只支持无出边覆盖这一类事故（5/5），过宽守卫引入新 stuck 风险。作为后续观察项。 |
| C. `upsertSession` 通用层加守卫（真·单咽喉） | 11 个非测试调用方，全部有各自守卫且生产证据（300/300）证明干净；通用层改动波及 started/re-review/merge-recovery 多族语义，违反 scope discipline。 |
| D. SQLite trigger 硬约束 | 仓里零 trigger 先例；错误面从「返回值可编程处理」变成「SQL 异常穿透所有调用方」；且 forceStatus 修复口径也会被堵死。 |
| E. 存量修复用语义谓词全量自愈（每次 boot 扫描） | 写入者修好后谓词恒空；若未来再有新写入者破洞，静默自愈会**掩盖 bug**。改用显式 5 个 execution_id 定点修正（有界、可审计、幂等），语义谓词只进验收查询。 |

## 6. 风险面

1. **statusPreserved 的调用方遗漏**：`recorded.status` 的读点只有 emitFailed 的 CommDB enqueue 一处会造假账，已列入改动；event-route 只透传。测试覆盖两个 sink。
2. **`terminal_status_immune` 映射错成 409**：会造成 CLI 写 marker + reconciler 循环撞墙（见 §3.5），必须走 settled 200 形态并配回归测试。
3. **修存量与 Bridge 运行时并发**：backfill 放 StateStore 构造迁移区（boot 时单线程执行，先于任何写入者），无并发窗口。
4. **QA 隔离库/测试库误伤**：定点 execution_id 谓词在非生产库恒空，天然无害。
