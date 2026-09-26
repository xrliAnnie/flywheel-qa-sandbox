# FLY-2903 已结束的 Codex 体真正关掉 — 实施计划
Issue: FLY-2903 (https://linear.app/geoforge3d/issue/FLY-2903/codex收尸-已结束的-codex-runner-必须真正关掉daemon-app-server-关闭可验证goal-runtime)
日期: 2026-09-25
基于: exploration.md, research.md

状态：draft R2（R1 同族评审 c213b7f3 CHANGES_REQUESTED 1 HIGH + 3 MEDIUM + 6 LOW，全部采纳，逐条见 §12）。源码基线 `6523b997c`（已含 FLY-2830 软链探针修复）。

## 0. 一句话

Bridge 要关一个 Codex 体时，先请进程内的 goal runtime 自己停下（它就不会把被杀当成崩溃去复活），再杀进程组兜底；并新增一个每 5 分钟的「终态体巡检」，给每个已终态的 Codex 执行体一个经两次采样确认的关闭结论，发现仍活着或终态后仍在涨 token 就收掉并告警，额度页挂横幅。

## 1. 交付切片

| # | 切片 | 对应要求 | 主要文件 |
|---|------|---------|---------|
| W1 | 所有权登记加「请停」通道 | 2 | `claude-runner/src/codex-execution-ownership.ts` |
| W2 | adapter 响应请停 + runtime 重启闸门 | 2 | `claude-runner/src/CodexTmuxAdapter.ts`、`claude-runner/src/codex-daemon-goal-runtime.ts` |
| W3 | Bridge 终态路径「先停 owner 再 reap」+ 关闭探测 | 1、2 | `teamlead/src/bridge/codex-daemon-teardown.ts`、`actions.ts`（terminate）、`close-runner.ts`、`plugin.ts`（close-tmux 接线） |
| W4 | 终态收尸账本（新表） | 1、3 | `teamlead/src/StateStore.ts`、新 `teamlead/src/bridge/codex-terminal-close-ledger.ts`、`scripts/lib/fly-2006-retention-tables/teamlead/codex_terminal_close.json` |
| W5 | 终态体巡检（维护 tick） | 1、3 | 新 `teamlead/src/bridge/codex-terminal-sweep.ts`、新 `teamlead/src/bridge/codex-rollout-token-watch.ts`、`plugin.ts`（接到 `:10660` 心跳回调） |
| W6 | 告警 kind + 额度页横幅 + kill switch flag | 3、4 | `LeadAlertNotifier.ts`、`bridge/kind-contract.ts`、`bridge/alert-kind-copy.ts`、`bridge/infra-event-router.ts`、`bridge/account-quota-view.ts`、`bridge/account-quota-page.ts`、flag 注册处（`flag-store-runtime.ts` 同族） |

每个切片先写失败测试（RED），再实现（GREEN）。本机只跑与改动文件直接相关的测试文件，整包交给 CI。**跑任何含 `startBridge` 的 teamlead vitest 前必须 `export FLYWHEEL_CODEX_HOMES_ROOT=<scratchpad 隔离根>`**；排除 `**/tmux-viewer.macos.test.ts`；本单不跑真 Codex（Codex 服务恢复后由 QA 演练）。

## 2. W1 — 所有权登记加「请停」通道

`CodexExecutionOwnershipRegistry` 新增（纯内存、同步状态，无外部 I/O）：

```ts
claim(executionId, kind, opts?: { onStopRequested?: (reason: CodexStopReason) => void }): Lease | undefined
// Lease 新增只读字段 stopRequested: CodexStopReason | null（挂在 lease 对象上，不依赖有界 Map）
requestStop(executionId, reason: CodexStopReason, opts?: { timeoutMs?: number /* 默认 25_000 */ }):
  Promise<"not_owned" | "reserved_fenced" | "stopped" | "timeout">
isStopRequested(executionId): boolean
ownershipState(executionId): "none" | "reserved" | "active"
type CodexStopReason = "terminate" | "close_runner" | "process_retirement" | "close_tmux" | "terminal_sweep"
```

- `requestStop`：
  - 总是先把 executionId 记入 `stopRequested`（有界 Map，上限 2048，按插入序淘汰最旧；executionId 全局唯一，不会复用）。
  - 状态 `active` → 先把 `lease.stopRequested` 置为 reason（同步），若有 `onStopRequested` 再同步调用回调（回调抛错被吞并记日志）；这一段是**同步完成**的「已触发停止」。然后有界等待该 lease 被 release（登记表内部 waiter）：release → `"stopped"`；超时 → `"timeout"`（调用方照常继续 reap；runtime 已被标记，闸门不会放行复活）。
  - 状态 `reserved`（已预留、adapter 尚未 claim）→ 立即返回 `"reserved_fenced"`。
  - 未登记 → `"not_owned"`。
  - **统一规则**：`stopRequested` Map 命中的 executionId，之后任何 `claim` 一律拒绝（返回 undefined），adapter 走现有 `owner_admission_failed` 失败结果，reason 细化为 `termination_requested`。Map 只服务「claim 之前」这段短窗口，淘汰不影响已 claim 的 lease（它们读 `lease.stopRequested`）。
  - 等待上限：HTTP 处理器路径（terminate、close-tmux）与 closeRunner 用默认 25s；巡检用 5s。
  - 多次调用幂等：同一 exec 的后续调用只再等 release，不重复触发回调。
- `release()` 行为不变（token 绑定）；另外唤醒该 exec 的 waiter。
- `isExecutionOwned` 语义不变。

**测试**（`codex-execution-ownership.test.ts`）：active + 回调 → `lease.stopRequested` 同步置位、回调被调一次、release 后 resolve `stopped`；超时 → `timeout`；reserved → `reserved_fenced` 且之后 `claim` 失败；未登记 → `not_owned`、`isStopRequested` 为真、之后 `claim` 失败；`ownershipState` 三态；Map 淘汰后已 claim lease 的 `stopRequested` 仍为真；回调抛错不影响等待；重复 `requestStop` 不重复回调；淘汰上限；旧 lease 的迟到 release 不唤醒后继（token 绑定）。

## 3. W2 — adapter 响应请停 + runtime 重启闸门

### 3.1 runtime（`codex-daemon-goal-runtime.ts`）

- `RunGoalInput` 新增 `mayRestartAfterTransportDeath?: () => boolean` 与 `onRestartDecision?: (d: { restarts: number; allowed: boolean; reason: "allowed" | "refused_by_owner" | "predicate_threw" }) => void`。
- catch 分支（`:787`）在现有 `isTransportDeath && restarts < maxRestarts && !this.stopped` 为真之后再问谓词：
  - 未注入 → 视为 allowed（兼容既有调用方与测试）。
  - 返回 `true` → allowed；返回其他值或抛错 → **refused**（fail-closed）：记日志 `daemon died mid-goal — restart refused (<reason>) thread <id>`，调 `onRestartDecision`（吞掉其异常），`throw err`（让本次执行按失败收尾）。
  - allowed 时同样调 `onRestartDecision`，并把陈旧日志文案 `(rotating account)` 改为 `(same home; credential re-read)`（与 `:277` 的「自动切号已退役」一致）。
- 其余逻辑（drain、maxRestarts、stop 语义）不变。

### 3.2 adapter（`CodexTmuxAdapter.ts`）

- `runWithOwnership`（`:924`）claim 时传 `onStopRequested`：resolve 一个本次执行私有的 `terminationRequested` promise（记下 reason）。**promise 在 claim 时就创建**，覆盖 claim 之后的整段预检窗口。
- 预检窗口（claim 之后、主 race 组装之前：home 供给、TUI 窗口、daemon spawn / `runGoal` 启动）：在每个会起进程的步骤**之前**调 `throwIfTerminationRequested()`（读 `lease.stopRequested`），命中则不起 TUI、不起 daemon，直接走 termination 收尾（与 retirement 同样的结果形状）。runtime 已创建时 `runtime.stop()` 保证 `startSession` 抛 `runtime stopped`、不再 spawn。
- 主 race（`:2245` 附近，现有 `shutdown / retirement / goal`）多一路 `{ kind: "termination" }`：命中 → `runtime.stop()`，等 `settledGoal`，结果按现有 `retirement` 分支的方式收尾（不把它算成新的失败类型）；finally 里的 drain 与 lease release 路径不变 —— release 发生在 drain 之后（`:985`），所以 `requestStop` 的 `"stopped"` 意味着 runtime 已 drain。
- `mayRestartAfterTransportDeath` 注入为：
  ```ts
  () => lease.stopRequested === null
        && !(ctx.processLifecycle?.retirementApproved?.() ?? false)
  ```
  （`retirementApproved` 抛错 → 整个谓词抛错 → runtime fail-closed 拒绝重启。）
- `onRestartDecision` → 记一行结构化日志 `[CodexTmuxAdapter] daemon_restart_decision exec=<id> restarts=<n> allowed=<bool> reason=<r>`；refused 时额外经现有 transport-death 取证钩子（`onTransportClose` 同一 sink，`plugin.ts:8423 recordCodexTransportDeathSnapshot`）记一条带 `restartRefused:true` 的快照。不新增事件表。

**测试**
- `codex-daemon-goal-runtime.test.ts`（现有假 daemon 夹具）：
  - RED（FLY-2814 反例）：transport death + 谓词返回 false → 不重启、`runGoal` 抛出原错误、`startSession` 只被调一次、`onRestartDecision` 收到 `refused_by_owner`。
  - 谓词抛错 → 不重启、`predicate_threw`。
  - 谓词 true → 行为与今天一致（现有 352/371/414/590 等用例不改即绿）。
  - 未注入谓词 → 与今天一致。
  - 谓词在第 2 次死亡时才变 false → 恰好重启 1 次后停止。
- `CodexTmuxAdapter.test.ts`：
  - RED：goal 运行中外部 `registry.requestStop(exec,"terminate")` → `runtime.stop()` 被调、执行结束、lease release、`requestStop` resolve `stopped`。
  - RED（复现 FLY-2814）：注入的假 runtime 在 `requestStop` 之后收到 transport death → 谓词为 false → 不重启（断言假 runtime 的重启计数 0）。
  - 退役已批准 + transport death → 不重启（修掉退役竞态）。
  - 未请求停止 + transport death → 仍按原逻辑重启（真崩溃仍被救）。
  - `requestStop` 发生在 `startSession` 进行中 → 不产生第二个 daemon。
  - `requestStop` 发生在 claim 之后、TUI/daemon spawn 之前 → 零 spawn（断言 spawn 桩调用 0 次），执行按 termination 收尾。

## 4. W3 — Bridge 终态路径「先停 owner 再 reap」+ 关闭探测

### 4.1 wrapper（`codex-daemon-teardown.ts`）

`CodexDaemonTeardownDeps` 新增：

```ts
stopOwner?: { registry: Pick<CodexExecutionOwnershipRegistry, "requestStop">; reason: CodexStopReason; timeoutMs?: number };
closeLedger?: CodexTerminalCloseLedgerWriter;   // W4
```

顺序：
1. `adapter_type !== "codex-tmux"` → `not_codex`（不变）。
2. 若给了 `stopOwner` → `await registry.requestStop(exec, reason, {timeoutMs})`，结果记入返回值 `ownerStop`。`timeout` 不阻断后续（runtime 已被标记请停，闸门会拒绝复活）。
3. 现有 reap（不变，含 `gracefulOnly/beforeSignal`）。
4. 若给了 `closeLedger` → 只记账、**不做快照探测**（避免每次关闭多跑 3 次 `ps`）：`observeClose(exec, { source, ownerStop, reap: outcome })`，状态 `close_attempted`（`residual/unverifiable` 则直接 `alive_residual/alive_unverifiable`）。关闭结论一律由巡检两次采样给出。
5. 返回值增加 `ownerStop?` 字段；现有调用方不看返回值的行为不变（它们仍继续杀 tmux / 终结 CommDB）。

### 4.2 接线（终态调用方）

| 调用方 | 改动 |
|--------|------|
| `actions.ts:1641` terminate | 传 `stopOwner{reason:"terminate"}` + `closeLedger` |
| `close-runner.ts:837` 非 resident closeRunner（含引擎退役 `workflowProcessCleanup`） | 传 `stopOwner{reason: workflowProcessCleanup ? "process_retirement" : "close_runner"}` + `closeLedger` |
| `close-runner.ts:787` resident phase | 已先受控关停；只加 `closeLedger` |
| `plugin.ts:4057` close-tmux | 传 `stopOwner{reason:"close_tmux"}` + `closeLedger`；`decideCloseTmuxCommDbFinalize` 不变 |
| `plugin.ts:8195` FLY-2555 终态收割 | 不变（它本就拒绝 owned 执行体） |
| `plugin.ts:10214` recovery reap | 不变（不是终态路径） |

registry 与 ledger writer 经各调用方现有 deps 对象注入（`plugin.ts:8285` 的 `codexExecutionOwners` 已在作用域内）；deps 缺省时（旧测试、未接线调用方）行为与今天逐字节一致。

**测试**（`codex-daemon-teardown.test.ts`、`actions` terminate 用例、`close-runner` 用例）：
- 顺序：`requestStop` 在 reap 之前被调用（调用序断言）；`timeout` 时 reap 仍执行；未给 `stopOwner` 时不调用。
- 退役路径传 `process_retirement`，普通 close 传 `close_runner`。
- ledger：reap `reaped/absent` → `close_attempted`；reap `unverifiable` → `alive_unverifiable`；wrapper 不调用快照探测（断言 `captureCodexProcessSnapshot` 零调用）。
- 现有 `exec_host_processes_*` / `lead_close_runner_failed` 事件不变。

## 5. W4 — 终态收尸账本

### 5.1 表（StateStore，teamlead db）

```sql
CREATE TABLE IF NOT EXISTS codex_terminal_close (
  execution_id        TEXT PRIMARY KEY,
  project_name        TEXT,
  issue_identifier    TEXT,
  session_status      TEXT NOT NULL,              -- 观察时的会话状态
  terminal_at         TEXT,
  state               TEXT NOT NULL CHECK (state IN (
                        'close_attempted','pending_confirm','closed',
                        'owned_seen','stop_requested',
                        'alive_reaped_pending','alive_unverifiable','alive_residual',
                        'probe_unknown')),
  owned_streak        INTEGER NOT NULL DEFAULT 0,
  attempts            INTEGER NOT NULL DEFAULT 0,
  rollout_path        TEXT,
  rollout_offset      INTEGER,
  tokens_at_terminal  INTEGER,
  tokens_after_terminal INTEGER,
  confirm_tokens      INTEGER,                    -- pending_confirm 时的累计值
  last_evidence       TEXT NOT NULL,              -- JSON，≤2 KiB，受限字段
  first_seen_at       TEXT NOT NULL,
  last_checked_at     TEXT NOT NULL,
  closed_at           TEXT,
  alerted_key         TEXT                        -- 已告警的 state:tokensBucket，防重复
);
CREATE INDEX IF NOT EXISTS idx_codex_terminal_close_state ON codex_terminal_close(state);
```

- 参数化语句读写（sql.js prepared statement），不拼 SQL。
- `last_evidence` 只写受限字段：`{source, ownerStop, reap, liveness, ledger, socketLive, groupState, holders:{status,count}, ownedInProcess}`，枚举值与计数，不含路径、argv、env、堆栈。
- 保留分类：`scripts/lib/fly-2006-retention-tables/teamlead/codex_terminal_close.json` = `protectedCurrentOrReference`（审计参照，本单不引入删除策略；量级约每天几十行）。

### 5.2 writer（`codex-terminal-close-ledger.ts`，唯一写者模块）

- `observeClose(exec, observation)`：按下表迁移状态，同一事务内 upsert 行 + 状态**变化**时写一条 `session_events`：`event_type = codex_terminal_close_<state>`，`event_id = codex-terminal-close:<exec>:<state>:<attempts>`（确定性，重放去重），`source` = 调用方来源，payload = `last_evidence` + token 字段。
- `closed` 是吸收态：只有 rollout token 在 `closed` 之后又增长才会被重新打开为 `probe_unknown`（并告警）—— 正常情况下 closed 之后巡检不再看它（§6.1 候选排除）。

**测试**（`codex-terminal-close-ledger.test.ts`，真 sql.js 临时库）：往返；非法 state 被 CHECK 拒；evidence 超长/含非法字段被拒（写入前校验）；事件只在状态变化时写一次；同一 observation 重放不产生重复事件。

## 6. W5 — 终态体巡检

### 6.1 接线与候选

- 挂在 `plugin.ts:10660` 心跳维护回调（默认 300s，零新定时器），每 tick 一次；单飞（上一轮未完成则跳过本轮并记 `sweep_skipped_inflight`）。
- 候选（去重，按 `terminal_at` 升序，**每 tick 上限 25**，30s 软预算用尽即停、余下留到下一 tick）：
  1. StateStore：`adapter_type='codex-tmux' AND status IN ('completed','failed','terminated','blocked') AND terminal_at >= now-48h AND terminal_at <= now-3min`，且账本里没有 `closed` 行；
  2. 本 tick 的一次 FLY-2877 进程快照（`captureCodexProcessSnapshot`，经 `parseCodexProcessSnapshot` 解析）里 `executionId` 非空的 codex 进程，其会话（按 execution_id 查 StateStore）在上面的状态集合里 —— **不限 terminal_at 年龄**（抓 FLY-2766 这种长命泄漏）；即使账本已 `closed` 也重新打开，且按 §6.2 必然判为 `alive` 或 `unverifiable_process`，绝不回到 closed。
- 候选只按 `sessions.status` 过滤：`running`、`ship_parked` 等非终态值不是候选。另外，若该执行体的 workflow process body（`body.state`，StateStore process body 表，与 `sessions.status` 是两个字段）处于 `standby / resuming / retiring`，本 tick 跳过（它们由 FLY-2808 进程体生命周期负责）。

### 6.2 单次探测 `probeCodexExecutionClosed(exec, snapshot)`（纯组合，已有零件）

- `ownership = registry.ownershipState(exec)`（`none | reserved | active`）
- `evidence = probeCodexDaemonEvidence(exec)`（已导出；含 liveness / ledger / socketLive / groupState；软链按 FLY-2830 解析）
- `procs`：本 tick 快照经 `parseCodexProcessSnapshot`（已从包根导出）得到的 codex 记录里 **`executionId === exec` 的全部进程，不按 CODEX_HOME 过滤**。理由：adapter 收尾会 `rmSync(codexSessionStateDir)`，之后 `resolveExecutionCodexHome` 只能退回 `legacy` 猜测，而 FLY-2877 之后 daemon 实际跑在 keyed agent home，按 home 过滤会把活进程数成 0。快照解析抛错（`process_authority_invalid`）或存在 `unattributed` 进程 → `procs = unknown`。
- 判定（按顺序，先命中者为准）：
  1. `active` ⇔ `ownership==="active"`
  2. `procs===unknown` → `unknown`
  3. `alive` ⇔ `liveness==="alive"`（ledger pgid 持有 socket，身份已证实）
  4. `unverifiable_process` ⇔ `procs.length > 0` 但 ledger 绑不上（liveness 非 alive）—— **有该执行体的活 codex 进程就绝不落 closed**
  5. `closed` ⇔ `procs.length === 0` ∧ (`liveness==="absent"` ∨ (ledger 缺失 ∧ `!socketLive`))
  6. 其余 → `unknown`
- `reserved`（预留残留、未 claim）不算「仍在运行」：巡检先 `registry.requestStop(exec,"terminal_sweep")` 把它围起来（之后任何 claim 被拒，消除「刚要 claim」的竞态），然后按 `none` 继续判定；不告「仍在运行」。

### 6.3 每个候选的处置（flag `codex_terminal_reap_enabled` 关时只做记账 + 告警，不做括号里的动作）

| 探测 | 账本前态 | 动作 | 新态 |
|------|---------|------|------|
| closed | 无 / `close_attempted` / 其他非 pending | 读 token（§6.4）记 `confirm_tokens` | `pending_confirm` |
| closed | `pending_confirm` 且 token 未涨（或 token unknown 且两次 `procs` 都为 0） | best-effort unlink 自己的 socket 路径（不跟随软链） | **`closed`**，写 `closed_at` |
| closed | `pending_confirm` 但 token 涨了 | 告警 | `probe_unknown` |
| active | streak 0 | streak=1 | `owned_seen` |
| active | streak ≥1（连续第二个 tick） | （`registry.requestStop(exec,"terminal_sweep",{timeoutMs:5000})`，结果写 evidence） | `stop_requested`，告警 |
| alive（无 active owner，身份已证实） | 任意 | （`reapCodexDaemonForSession(... source:"bridge.codex-terminal-sweep", beforeSignal)`，默认 SIGTERM→SIGKILL）；`beforeSignal` 同步复查：会话仍在终态集合、`ownershipState !== "active"`、`getResidentHold` 非 resident/woken | `reaped/absent` → `alive_reaped_pending`（下 tick 再探测走 closed 两步）；`residual` → `alive_residual` + 告警；`unverifiable` → `alive_unverifiable` + 告警 |
| unverifiable_process | 任意 | 不发信号 | `alive_unverifiable` + 告警 |
| unknown | 任意 | 不发信号 | `probe_unknown`；连续 3 次 → 告警 |

- 任何一步抛错：该候选记 `probe_unknown`（evidence 写受限错误码），不影响其他候选。
- 不新增杀进程路径：唯一发信号的是既有 `reapCodexDaemonForExecution`（ledger pgid ↔ socket 持有者证实、拒绝 Bridge 自身进程组、`auditedSignal`）；`requestStop` 只让进程内 runtime 自己停。

### 6.4 rollout token 观察（`codex-rollout-token-watch.ts`）

- 首次解析 rollout 路径，按序取第一个有效者，结果缓存进 `rollout_path`（此后不再遍历目录树）：
  1. **scorecard 游标**（主来源，持久、不依赖 `session.json`）：`workflow_scorecard_cursor` 中 `vendor='codex' AND execution_id=?` 的 `source_locator`（生产实测为 rollout 绝对路径，如 `~/.flywheel/codex-homes/agents/flywheel/qa/sessions/2026/09/25/rollout-…-<threadId>.jsonl`），多行取 `updated_at` 最新；
  2. 本 tick 快照里该执行体进程的 `CODEX_HOME` + `session.json.threadId`（仍存在时，O_NOFOLLOW 读）→ `findCodexRolloutPath(home, threadId, ["sessions","archived_sessions"])`（当前**未**从包根导出，本单在 `claude-runner/src/index.ts` 加导出并补包根导出测试，不做深层 import）；
  3. 都没有 → null。**不**使用 `resolveExecutionCodexHome` 在 `session.json` 被删后的 legacy 推测。
  - 有效性：绝对路径、`lstat` 为普通文件（非软链）、父链含 `/sessions/` 或 `/archived_sessions/`、位于 `~/.flywheel/codex-homes*` 之下、文件名包含该执行体的 threadId / 游标的 `native_session_id`。任一不满足视为无。
  - 游标行存在但文件已被 Codex 归档移走 → 用游标的 `native_session_id` 在同一 home 的 `archived_sessions/` 下重找一次。
- 首次读：流式逐行，`parseCodexUsageLine` 取 `timestamp ≤ terminal_at + 2min` 的最后一个 `totalTokens` → `tokens_at_terminal`；之后的行累加进 `tokens_after_terminal`（累计计数器取差分，回落按新段从 0 计，同 FLY-2893 `usage.py`）；记 `rollout_offset` = 已消费字节（只算完整行）。
- 之后每次：从 `rollout_offset` 增量读到 EOF，单次上限 8 MiB（超出记 `rollout_read_truncated`、下 tick 继续）。
- threadId / rollout 缺失 → token 字段为 null，状态机按「token unknown」分支。
- 文件被截短（size < offset）→ 从 0 重扫一次并记 evidence `rollout_rewound`。

**测试**（`codex-terminal-sweep.test.ts`、`codex-rollout-token-watch.test.ts`；全部注入探测/快照/时钟，无真进程）：
- RED（验收 1）：终态会话 + 活 daemon（alive、无 owner）→ 第一 tick reap 被调、`beforeSignal` 复查通过 → `alive_reaped_pending`；第二 tick 探测 closed → `pending_confirm`；第三 tick token 未涨 → `closed`；三步各有事件。默认 5 分钟节奏下 ≤15 分钟闭环。
- RED（FLY-2766 形状）：终态 + owned → 第一 tick 只记 `owned_seen`、不请停；第二 tick `requestStop("terminal_sweep")` + 告警。
- 一次 tick 里 owned、下一 tick 不 owned → streak 归零，不请停。
- `beforeSignal` 复查时会话变回非终态 / 被 claim → 不发信号（reap 返回 unverifiable → `alive_unverifiable`，但不算误杀）。
- unverifiable → 不发信号 + 告警；连续 unknown 3 次才告警。
- `pending_confirm` 后 token 增长 → `probe_unknown` + 告警（假成功反例）。
- 进程快照命中 72h 前终态的执行体 → 仍成为候选；账本已 closed 也重新打开。
- RED（R1 HIGH 回归）：`session.json` 已删、daemon 跑在 keyed agent home、ledger 缺失、socket 路径已被 unlink，但快照里有 `FLYWHEEL_EXEC_ID=<exec>` 的 codex 进程 → 判 `unverifiable_process` → `alive_unverifiable` + 告警，**绝不** `closed`；同形状但进程在另一个 CODEX_HOME 下 → 结果相同（不按 home 过滤）。
- 快照含 unattributed codex 进程 → `unknown`，不落 closed。
- 终态 + 仅 `reserved` → 巡检先 `requestStop` 围栏，不记 `owned_seen`、不告「仍在运行」，之后按无 owner 判定。
- `ship_parked`、`running` 会话 → 不是候选（零探测）；process body `standby` → 本 tick 跳过。
- Claude 会话 → 不是候选。
- 候选超 25 / 预算用尽 → 剩余留到下一 tick；单飞跳过。
- flag 关 → 零 `requestStop`、零 reap，只记账与告警。
- token watch：scorecard 游标优先于 `session.json`；`session.json` 已删 + 游标存在 → 仍能读；游标文件已归档 → 在 `archived_sessions/` 找到；首次读切点正确；增量读只读新字节；计数器回落分段；截短重扫；超 8 MiB 截断续读；rollout 路径是软链 / 不在 codex-homes 下 / 文件名不含 threadId → null。

## 7. W6 — 告警、额度页、flag

### 7.1 告警 kind `codex_terminal_body_alive`

- 登记四处（同样板 `codex_lead_residency_stalled`）：`LeadAlertNotifier.ts` `ALERT_EVENT_TYPES`、`bridge/kind-contract.ts`、`bridge/alert-kind-copy.ts`（中文标题「终态 Codex 体仍在运行 / 仍在用额度」、severity `severe`、描述）、`bridge/infra-event-router.ts`。**不**登记 `ticket-owner-map.ts`、不入 `CROSS_PROVIDER_KINDS`：未登记 kind 默认派给 Claude infra bot（`ticket-owner-map.ts:129`），这是有意的 —— 出问题的是 Codex 体，由 Claude 侧处置。
- 发出点：巡检（§6.3 标「告警」的格）。`eventId = codex_terminal_body_alive:<exec>:<state>:<hash24(exec,state,tokensBucket)>`，`tokensBucket = floor(log10(tokens_after_terminal+1))`（token 每涨一个数量级再告一次，其余去重），项目 `FLEET_ALERT_PROJECT`。账本 `alerted_key` 记最后一次，重启后不重复。
- body（纯文本，受限）：`issue=<FLY-xxxx> exec=<8位> status=<s> terminalAt=<ISO> state=<state> tokensAfterTerminal=<n|unknown> action=<requestStop:stopped|timeout / reap:<outcome> / none>`。

### 7.2 额度页横幅

- `buildAccountQuotaView` 新增只读输入 `terminalBodies`：账本里 `state IN ('owned_seen','stop_requested','alive_reaped_pending','alive_unverifiable','alive_residual','probe_unknown')` 或 `tokens_after_terminal > 0`，且 `terminal_at` 在 24h 内的行（上限 10 行）。路由处 best-effort 读（任何错误 → 空列表 + 日志，页面照常）。
- `account-quota-page.ts` 在切号横幅旁渲染「⚠ 终态 Codex 体仍在用额度（N）」：每行 单号 · 执行体 8 位 · 终态时刻 · 终态后 token（千分位，unknown 显示「读不到」）· 处置结果中文。所有派生文本经现有 `escapeHtml`。空列表不渲染横幅。
- 只在额度页路由侧渲染（路由有 StateStore）；**不**改 tick 文本（`hook-payload.ts` 的 `buildAccountQuotaView(capacity)` 只吃 CapacitySnapshot，拿不到账本；不为此扩 CapacitySnapshot）。

### 7.3 flag `codex_terminal_reap_enabled`

- bridge_global 布尔，默认 `true`，照现有 flag 注册族（`flag-store-runtime.ts`、codec、`feature-flag-render.ts`）接入。只控制巡检的 `requestStop` 与 reap 两个动作；W1–W3（终态路径先停 owner、重启闸门）不受它控制。

**测试**：kind 四处登记的既有一致性测试（kind-contract / alert-kind-copy 覆盖测试）随之通过；页面：有行 → 横幅 + 转义（`<script>` 形状的 issue 字段被转义）；无行 → 无横幅；读账本抛错 → 页面正常无横幅；tick 文本不变；flag codec 往返与默认值。

## 8. 验收映射

| 验收 | 证据 | 谁验 |
|------|------|------|
| 构造终态体 + 活 daemon，N 分钟内被收掉，有审计 | W5 RED 用例（注入）；QA 用隔离 `FLYWHEEL_CODEX_SESSION_DIR` 与隔离 CODEX_HOME 起**真 codex binary 的 app-server**（零额度台架：不登录、不发请求，只占 socket，`ucomm=codex`、env 带 `FLYWHEEL_EXEC_ID`，见既有 QA 配方「零额度真 codex 进程台架」）并写真 ledger；binary 不可用时退回「把 node 可执行文件拷成名为 `codex` 的文件运行一个 listen 脚本」（`ucomm=codex`，`setsid` 自成进程组）—— 不得用 `sleep` 冒充（`ucomm` 不是 codex，快照判据测不到）。在本机驱动巡检三 tick，断言进程组消失、socket 不再监听、账本 `closed`、三条 `codex_terminal_close_*` 事件。N = 3 个维护 tick（默认 ≤15 分钟），测试里用注入时钟压缩 | implement（单测）+ QA（本机进程级台架） |
| 被终结的体不再被复活（FLY-2814 反例） | W2 两层 RED：runtime 谓词拒绝重启；adapter 在 `requestStop` 后 transport death 零重启；W3 terminate 调用序 `requestStop → reap` | implement；真 Codex 演练待 Codex 服务恢复后由 QA 做 |
| 周期收割 + 告警 | W5 + W6 用例 | implement |
| 额度页 / 巡检可见 | W6 页面用例；QA 截图额度页横幅（台架账本行） | implement + QA |

## 9. 边界（诚实说明）

- **做**：终态路径先停进程内 owner；runtime 被请停/退役后不复活；每个近 48h 终态的 Codex 执行体都得到经两次采样确认的关闭结论；证实身份的活 daemon 被收掉；证不出身份或终态后 token 增长会告警；额度页可见。
- **不做**：
  - 不按进程 env 归属给进程发信号（证不出 ledger 身份的只告警，由 Lead/claw 处置）。
  - 不改 FLY-2169 孤儿收割器与 FLY-2555 终态收割的规则。
  - 不改巡检快照 shell 脚本。
  - 不回溯 48h 以前、且当前没有活进程的历史执行体（它们既没活进程也不再烧额度）。
  - Bridge 进程崩溃瞬间正在跑的 runtime：随进程消失，daemon 成孤儿，由本巡检在下一个 tick 起收（会话若仍 `running` 则由既有 reown 流程处理，不属本单）。
  - TUI 客户端 `codex resume --remote` 不单独收；daemon 死后它自行断开，founder 窗口由既有 `killFounderWindow` 关。
  - 不宣称生产已闭环：真 Codex 演练与生产效果由 QA / 部署后验证。

## 10. 回滚

- flag `codex_terminal_reap_enabled=false`：巡检退化为只观测 + 记账 + 告警。
- 整单 revert：新表保留无害（`CREATE TABLE IF NOT EXISTS`，无消费者）；registry 新方法与 runtime 谓词均为可选注入，revert 后回到今天行为。
- 无 schema 迁移改动既有表；不改 CLI 子命令（无 FLY-1914 消费者 sweep 需求）。

## 11. 门禁

- 本机：改动文件对应的测试文件（claude-runner：ownership / goal-runtime / adapter；teamlead：teardown / terminate / close-runner / ledger / sweep / token-watch / quota page / alert kind 一致性 / flag）；`pnpm lint`；`pnpm -r build`。
- 新 StateStore 表的保留分类 fragment 已加。
- 新增 kill 相关代码只在既有 `reapCodexDaemonForExecution` 之内调用，不新增 `process.kill` / spawn —— 若实现中确需新增，必须按四本清册守卫登记（shell 枚举 · child-process census · kill-path inventory · required 禁宿主耗时断言）。
- 整包测试与精确头 CI 交给 PR。

## 12. 评审记录

### R1（Bridge 同族评审，request c213b7f3，gate 8d4d98d2，CHANGES_REQUESTED）

| findingKey | 级别 | 处置 |
|------------|------|------|
| closed-verdict-holders-home-bound | HIGH | §6.2 改为快照里 `executionId===exec` 的全部 codex 进程、不按 home 过滤；`unattributed`/解析失败 → unknown；有进程但 ledger 绑不上 → `unverifiable_process` → `alive_unverifiable` + 告警，绝不 closed。§6.4 rollout 主来源改为 scorecard 游标 `source_locator`（生产实测为绝对路径），次选快照进程的 CODEX_HOME + threadId，不再用 `session.json` 删除后的 legacy 推测。§8 QA 台架改为 `ucomm=codex` 的真 codex app-server（零额度）或改名 node，禁止 `sleep` 冒充。补 R1 回归用例 |
| requeststop-blocks-http-actions-90s | MEDIUM | 默认等待 90s → 25s；「已触发停止」（置 `lease.stopRequested` + 回调 → `runtime.stop()` 同步 SIGTERM）同步完成，只有 drain 等待有界；超时照常 reap |
| reserved-lease-counts-as-owned-in-sweep | MEDIUM | registry 暴露 `ownershipState`；巡检只把 `active` 当运行中；`reserved` 先 `requestStop` 围栏再按无 owner 判定，不告「仍在运行」；`beforeSignal` 复查改为 `ownershipState !== "active"` |
| termination-race-armed-late | MEDIUM | `terminationRequested` 在 claim 时创建；预检窗口每个起进程步骤前 `throwIfTerminationRequested()`；补「claim 后 spawn 前请停 → 零 spawn」用例 |
| tick-line-needs-ledger-plumbing | LOW | 删除 tick 文本那一行，只在路由侧渲染横幅 |
| alert-kind-registration-count | LOW | 改为登记四处；不登记 ticket-owner-map，默认派 Claude infra bot，写明理由 |
| status-list-mixes-body-states | LOW | §6.1 区分 `sessions.status` 与 process `body.state`；body 处于 standby/resuming/retiring 时本 tick 跳过 |
| w3-probe-signature-and-snapshot-cost | LOW | W3 不做快照探测，只记 `ownerStop + reap` → 新状态 `close_attempted`，结论交给巡检 |
| rollout-archived-sessions | LOW | rollout 根改为 `["sessions","archived_sessions"]`，游标文件被归档时在 `archived_sessions/` 重找 |
| stop-requested-claim-semantics | LOW | 统一「stopRequested 命中即拒 claim」；active lease 的请停标记挂在 lease 对象上，重启闸门读 lease 而不读有界 Map |
