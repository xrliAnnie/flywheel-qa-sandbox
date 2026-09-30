# FLY-2127 Codex runner 原生唤醒 — 实施计划
Issue: FLY-2127 (https://linear.app/geoforge3d/issue/FLY-2127/病根同类合并-7-张-codex-runner-叫不醒-停着空转唤醒和停驻一族-原引擎的-rework-wake-打不醒-goal)
日期: 2026-09-30
基于: research.md

**Version**: v1.56.0（ship 取空号）
**Status**: draft（R3：按 Codex R1 12 项 + R2 11 项修订）

## 1. 目标

Lead / 引擎发给 Codex runner 的每条消息都通过 runner 自己的 `codex app-server` 控制 socket 投递并得到
runner 侧逐消息回执；停驻（paused / blocked / complete）的 Codex 体收到消息后自动续跑；投递失败有限升级到
Lead 可见的告警 + 有审计、至多一次的 tmux 兜底；本版**保留**旧 JSON inbox 实现作为按执行固定的回滚模式，下版删除；
Claude runner 收信路径零改动。

## 2. 架构

```mermaid
sequenceDiagram
    participant L as Lead (flywheel-comm send)
    participant DB as CommDB (messages + runner_phase_wakes)
    participant N as CodexNativeDeliveryLane (队列/退避/回执/升级)
    participant C as GoalControl (goal loop 内的串行控制边界)
    participant D as codex app-server (runner socket)

    L->>DB: 一个事务: insertInstruction + enqueue(pending, message_id)
    loop 每 1s, 仅 deliveryReady 时
        N->>DB: 取最早非 finished/非 exhausted 行; 未到期则等待
        N->>DB: claimAttempt(attempts+1, started)
        N->>C: deliver({messageId, text, generation})
        C->>D: goal/get (只读 preflight)
        alt turn 进行中
            C->>D: turn/steer
        else 空闲 / paused / blocked / complete
            C->>D: thread/queue/add
            C->>D: thread/goal/set active
        end
        C-->>N: {input: accepted|not_sent|unknown, activation: done|required|n/a}
        N->>DB: recordAttemptOutcome (accepted_at / activated_at / activation_required)
    end
    D-->>C: item/started(userMessage "[fw-msg id] …", threadId)
    C-->>N: receipt(messageId, threadId, generation)
    N->>DB: receipt_at; 若激活也完成 → finished + messages.read_at (同一事务)
    Note over N: attempts≥3 → exhausted_at + escalation_state 状态机 (告警重试 + 至多一次兜底)
```

五个层次，权威不下沉：

1. **写点（入口）**：`send` / `wakeRunnerMailbox` 按**目标 execution 持久化的 delivery mode** 路由（§3.6）；codex+native → 只入 CommDB 队列。
2. **Lane（队列）**：`CodexNativeDeliveryLane`（新文件 `packages/claude-runner/src/codex-native-delivery-lane.ts`）管队列、尝试计数、退避、回执落库、升级状态机；不直接发 RPC。
3. **GoalControl（控制边界）**：`runGoalToTerminal` 内的串行控制对象，把 pause / activate / deliver / terminal generation / 预算恢复 / shutdown 准入放在同一把异步锁后面。
4. **回执（观察）**：goal loop 通知处理里识别 `item/started(userMessage)`，绑定 threadId + generation + 精确 message id 后交给 lane 落库。
5. **升级（兜底）**：耗尽 → 行隔离 + 持久 `escalation_state` 驱动「事件 → 告警（可重试）→ 至多一次 tmux 兜底（仅原输入确证未发出）」。

## 3. 改动清单

### 3.1 `CodexDaemonClient`（`codex-daemon-client.ts`）

```ts
async queueAdd(threadId: string, text: string, timeoutMs?: number): Promise<void>
async steerTurn(threadId: string, turnId: string, text: string, timeoutMs?: number): Promise<void>
```

形状照 `startTurn`（`:468-480`）；名称 / 参数以 M0 探针回填。
**错误分类不改 `kind`**（`isTransportDeath` 依赖 `kind==="closed"`，`codex-daemon-goal-runtime.ts:171-177` 原样）；`CodexDaemonError` 新增只读字段
`phase: "pre_send" | "post_send"`（`request()` 在 `this.t.send` 之前抛 → pre_send，之后 → post_send；RPC error 响应 → post_send 且带 `rpcError`）。
投递结果（disposition）由 GoalControl 在**操作层**判定（§3.2），不由错误 kind 直接映射。

### 3.2 runtime 就绪态与 `GoalControl`（`codex-daemon-goal-runtime.ts` + `codex-daemon-client.ts`）

```ts
interface DeliveryReadiness { generation: number; threadId: string; control: GoalControl }
class CodexDaemonGoalRuntime { deliveryReadiness(): DeliveryReadiness | null }
```

- `generation` 每次 `startSession` +1；readiness 只在 socket 所有权 + thread start/resume + 监听器 + 本轮 goal preflight（非 hold：active + 初始 kick 已提交；hold：`ensurePhasePaused` 已确认）后由 goal loop 经 `input.onDeliveryReady(control)` 发布；`stop()` / transport closed / restart 立即撤销并清空 turn 状态。未就绪时 lane 只等待，不计尝试。

```ts
type InputDisposition = "accepted" | "not_sent" | "unknown";
interface DeliverResult {
  input: InputDisposition; reason?: string; via?: "steer" | "queue";
  /** "n/a": steer 或 goal 已 active；"done": set active 成功；"required": queue 已接受但 set active 失败 */
  activation: "n/a" | "done" | "required";
}
interface GoalControl {
  generation: number;
  deliver(input: { messageId: string; text: string }): Promise<DeliverResult>;
  activate(): Promise<{ ok: boolean; reason?: string }>;      // 只补 goal/set active，绝不重投正文
  turnState(): { turnId: string | null };
}
```

`deliver` 的判定表（锁内执行）：

| 阶段 | 失败形态 | input | activation |
|---|---|---|---|
| 只读 preflight `goal/get` | 任何错误 / null / objective 非本 run（外来 goal） | `not_sent`（正文未提交，不计尝试；外来 goal 交给既有 `goal_replaced` 守卫） | — |
| 输入 RPC（steer / queue） | `phase==="pre_send"` 或 RPC 明确拒绝（error 响应，含 steer 对过期 turn 的拒绝） | `not_sent` | — |
| 输入 RPC | timeout / post_send closed | `unknown` | `required`（若 goal 非 active） |
| 输入 RPC 成功，`set active` 失败 | — | `accepted` | `required` |
| 全部成功 | — | `accepted` | `done` / `n/a` |

`set active` 用 goal loop 权威的 `input.objective` / `input.tokenBudget`（`GoalNotification.goal` 无 tokenBudget）。

### 3.3 terminal / hold 与投递的顺序（`runGoalToTerminal` 循环）

- `terminalSeen` 改为 `{status, atGeneration, atSeq}`；`deliver()` 在锁内把它清零并记 `lastAcceptedSeq`；循环的 terminal 分支在锁内重读，`lastAcceptedSeq > terminalSeen.atSeq` → 不进 hold。
- **hold 完成信号与投递查询分离**（R2 #1）：`enterPhaseHold` 时 `phaseHold` 持久化新增 `episodeSeq`（每次进 hold +1）与 `wakeMessageId: null`；
  lane 首次对该 hold 期间的行取得 `accepted` 时把 `phaseHold.wakeMessageId = message_id` 写入 session.json（锁内，一次）。
  hold 循环不扫队列，只查 `db.getRunnerWakeControlState(execId, wakeMessageId)`：`receipt_at` 非空 **且**（`activation_required=0` 或 `activated_at` 非空）→ 锁内 `leaveHold()`：清 `held` / `terminalSeen`、按 `phaseHold` 恢复两条预算钟一次（`state:"reactivating"` 已有，幂等）、清 `wakeMessageId`。
  同一 hold 期间后续行照常由 lane 投递（goal 已 active，走 steer/queue），不影响 hold 完成判定。
- `enterPhaseHold` 锁内先检查 shutdown 未请求且无 `accepted` 且 `activation=required` 的未决行，再 `set paused`。
- `reactivateWake` 的 `startTurn` 投递被 `control.deliver` 取代；`onBudgetRestored` 逻辑迁到 `leaveHold`。
- shutdown：`observe()` 返回 shutdown 后置 `deliveryRevoked=true`，后续 `deliver` 返回 `not_sent reason=shutdown`（不计尝试）；lane `stop()` 在 `runtime.drained()` 之前。

### 3.4 `blocked` 进 hold（仅 phase keep-alive）

```ts
if (terminalSeen && phase && (terminalSeen.status === "complete" || terminalSeen.status === "blocked")) { await enterPhaseHold(); continue; }
```

非 phase 路径字节不变；`classifyGoalOutcome` 不改。进 hold 时 `input.onHeld?.({status, episodeSeq})` → adapter 发 `codex_goal_held` 告警，
eventId `goal-held-<execId>-<episodeSeq>`（同一 episode 重复调用去重；恢复后再次 blocked 是新 episodeSeq → 新告警，R2 #10）。
FLY-2861 注释改为：「0.159 下 blocked 重连也弹 Resume paused goal?；菜单只挡键盘，RPC 不受影响」。

### 3.5 消息身份与回执

- **wire message id** = `runner_phase_wakes.message_id`，入队边界决定：写点带 `metadata.flywheelId` → 用它；否则 `randomUUID()`；恢复门铃用 `nudge:<fingerprint>`。
  入队时校验 `^[A-Za-z0-9_.:-]{1,128}$`，不符合直接拒绝入队（loud error）。`source_instruction_id` = 有 instruction 行时的 instruction id，否则 NULL。
- 投递时 `control.deliver` 在正文前加 `[fw-msg <message_id>]`（写点不加）；`send.ts` 现有 `[lead-instruction <id>]` 保留给 Claude 路径与审计。
- 回执匹配：`item/started`，`params.threadId === readiness.threadId`，`item.type==="userMessage"`，正则 `\[fw-msg ([A-Za-z0-9_.:-]{1,128})\]` 抽出后**在库中精确匹配**该 execId 的行，且 `generation === readiness.generation`。
  早到：行已 `started`，`receipt_at` 可写；重复 / 迟到：幂等、不降级；DB 写失败：内存 `pendingReceipts` 下一 tick 重放。
- **回执 ≠ 完成**（R2 #2）：`receipt_at` 只记「daemon 已读到输入」；行 `finished` 的条件 = `receipt_at` 非空 **且** (`activation_required=0` 或 `activated_at` 非空)，在同一事务里补 `messages.read_at`。
- **没有弱回执**。M0 若证明 `item/started(userMessage)` 不可观察 → 改用可按 message id 对账的读回 RPC（M0 一并探）；两者都不可得 → 架构停在 M0，`flywheel-comm ask` 报 Lead。

### 3.6 写点、路由与模式持久化

- CommDB `sessions` 加列 `delivery_mode TEXT`（`native` | `legacy`；幂等 ALTER）。`CodexTmuxAdapter.execute()` 开头读 `FLYWHEEL_CODEX_NATIVE_DELIVERY`（默认 `1`）一次，
  写入本 execution 的 session 行；此后**整次执行固定**。发送方（任何进程）只按目标 session 的 `delivery_mode` 路由，**不看自己的 env**（R2 #6）；`delivery_mode` NULL（旧行 / 未注册）→ legacy。

| 文件 | 改法 |
|---|---|
| `flywheel-comm/src/wake.ts` | backend 解析：`args.backend ?? sessionVendor(execId)`；显式 backend 与 vendor 冲突 → `{ok:false,error:"backend_conflict"}`；vendor NULL 且无 backend → 现有 `fromEnv()`。`backend==="codex" && delivery_mode==="native"` → `db.enqueueRunnerNativeDelivery(...)`，返回 `{ok:true}`；`claude-code` 与 legacy 分支字节不变。 |
| `flywheel-comm/src/commands/send.ts` | 先解析目标 vendor + mode；codex+native → **一个事务** `db.insertInstructionWithNativeDelivery(from,to,content)`（messages 行 + 队列行，`source_instruction_id` 绑定，`read_at` 不动），不再调 `wakeRunnerMailbox`，`delivered_at` 语义「已入 runner 队列」；其他情况现有流程字节不变（R2 #9）。 |
| `flywheel-comm/src/commands/inbox.ts` | 目标 codex+native：`getUnreadInstructions(execId,{excludeNativeOwned:true})` 排除有队列行绑定的 instruction；因入队与插入同事务，不存在窗口。其他模式不变。 |
| `teamlead/src/bridge/runner-wake.ts`、`actions.ts:465`、`respond.ts:95`、`plugin.ts wakePhaseRunner` | 代码不改；靠 wake.ts 路由（新增集成用例：无 marker 的 approval / feedback / gate_answered / fix / retest 到 codex-native 目标 → 入队且不写任何 inbox 文件）。 |
| `agent-team-transport/src/codex/CodexAdapter.ts` | 本版不删，接口不变。 |
| `claude-runner/src/codex-phase-lifecycle.ts` | native：`watcher` null；`observe()` 不再扫队列，改查 hold 绑定行（§3.3）。legacy：现状 + `finishRunnerPhaseWake` 补写绑定 instruction 的 `read_at`（唯一 legacy 改动，R2 #6）。 |
| `claude-runner/src/CodexTmuxAdapter.ts` | native：写 `delivery_mode`；`runtime` 建好后建 lane（不要求 phaseKeepAlive）；`finally` 里 `await lane.stop()` 先于 `runtime.drained()`；hooks 由构造注入（§3.8）。legacy：现状。 |

**模式切换合同**：运行中的 execution 不支持切换；改 env 只影响之后启动的 execute。OFF 下重新 execute 一个曾是 native 的 execution 时，adapter 先做**接管对账**：
`pending` 且从未 `accepted` / `unknown` 的行 → 交 legacy 循环；`accepted` / `unknown` / `exhausted` 行 → 标 `finished` + `takeover_note`，并发一条 `codex_goal_held` 同级告警说明「N 条已提交或不确定的消息未重投」；绝不重投正文。

### 3.7 CommDB 迁移与队列语义（`flywheel-comm/src/db.ts`）

幂等加列（沿用 `delivered_at` 的 race-tolerant `ALTER TABLE`；`state` CHECK 不动）：
`attempts INTEGER NOT NULL DEFAULT 0`、`last_attempt_at`、`next_attempt_at`、`accepted_at`、`receipt_at`、`activation_required INTEGER NOT NULL DEFAULT 0`、`activated_at`、
`last_outcome TEXT`、`last_error TEXT`、`exhausted_at`、`escalation_state TEXT`（`pending|alerted|fallback_claimed|done`）、`fallback_claimed_at`、`fallback_result TEXT`、`takeover_note TEXT`、`kind TEXT`（`message|recovery`）。

| helper | 语义 |
|---|---|
| `enqueueRunnerNativeDelivery(execId, {message_id, content, metadata, source_instruction_id, kind}, now)` | 同表同唯一键；校验 id 字符集；**不**动 `messages.read_at`；重复 → `duplicate` |
| `insertInstructionWithNativeDelivery(from, to, content)` | 一个事务：messages 行 + 队列行 |
| `headRunnerWake(execId)` | **最早**的 `state!='finished' AND exhausted_at IS NULL` 行（不看到期时间；R2 #8） |
| `claimRunnerWakeAttempt(execId, id, now)` | 原子：仅当 `next_attempt_at IS NULL OR <= now` 且未 exhausted：`state='started', attempts+1, last_attempt_at=now`；`changes===1` 才继续 |
| `recordRunnerWakeAttemptOutcome(execId, id, {input, activation, error?, nextAttemptAt})` | 写 `last_outcome`、`accepted_at`（首次 accepted）、`activation_required`、`activated_at`、`last_error`、`next_attempt_at` |
| `recordRunnerWakeReceipt(execId, id, now)` | `receipt_at=COALESCE(receipt_at, now)`；若完成条件成立 → `finished` + `messages.read_at`（同事务） |
| `markRunnerWakeExhausted(execId, id, now)` | `exhausted_at=now, escalation_state='pending'` |
| `advanceRunnerWakeEscalation(execId, id, from, to)` | CAS 状态机 |
| `claimRunnerWakeFallback(execId, id, now)` | CAS：仅当 `last_outcome='not_sent' AND accepted_at IS NULL AND fallback_claimed_at IS NULL AND kind='message'` → `fallback_claimed_at=now`；失败 → 不许按键 |
| `getRunnerWakeControlState(execId, id)` | hold 完成判定用 |

Lane 每 tick（串行）：`head = headRunnerWake`；无 → 空转；`head.next_attempt_at > now` → **等待，不越过**（保序）；否则按 `last_outcome` 决定动作：

| head 状态 | 动作 | next_attempt_at |
|---|---|---|
| 从未尝试 / `not_sent` | `claimAttempt` → `control.deliver` | 失败：now + backoff[attempts-1]（2s/8s/30s） |
| `accepted` 且 `activation_required=1` 且无 `activated_at` | `control.activate()`（不重投） | 失败：now + backoff；成功：写 `activated_at` |
| `accepted` 且激活完成/不需要，无 `receipt_at` | 只等回执；60s 无回执 → `attempts+1`（不重投、不激活） | now + 60s |
| `unknown` | M0 有读回 RPC → 对账归为 accepted / not_sent；否则视为 accepted（只按上两行处理） | 同上 |
| attempts ≥ 3 | `markRunnerWakeExhausted` → 升级状态机（§3.8） | — |

exhausted 行被隔离，后续行照常。`kind='recovery'` 行耗尽只告警、**不派生**任何恢复（R2 #5）。

### 3.8 升级状态机、告警与注入（Bridge 侧）

- alert kinds：`runner_wake_exhausted`（severity `severe`）、`codex_goal_held`（severity `warning`）；均加入 `ALERT_EVENT_TYPES` 与 `KIND_CONTRACTS`，
  `owner: "claude"`（现有值，经 `resolveTicketOwner` 默认路由到 Claude infra bot；不新增 owner 类型，R2 #11）、`arc: "human_by_design"`。
- `LeadAlertNotifier.alert({leadId, projectName, eventId, eventType, title, body, severity, sessionKey})`；eventId：`wake-exhausted-<execId>-<messageId>`、`goal-held-<execId>-<episodeSeq>`。
- 升级状态机（lane 每 tick 推进，持久、可重试，R2 #10）：
  1. `pending` → 写 StateStore 事件 `runner_wake_exhausted`（幂等 event_id 同 eventId，可重复写不重复插）→ 调 `alert()`；返回 accepted 或 `duplicate` 才 CAS 到 `alerted`；抛错则保持 `pending`，下 tick 重试（eventId 稳定，notifier 端持久去重）。
  2. `alerted` → 仅当 `kind='message'` 且 `claimRunnerWakeFallback` CAS 成功 → `fallback_claimed`，调用 `attemptRunnerRecoveryNudge({actor:"native-lane-final", mode:"final", messageId})`（§3.9，final 模式不入队）；结果写 `fallback_result` → `done`。CAS 失败（accepted / unknown / recovery 行）→ 直接 `done`，告警正文已含「输入可能已提交，未兜底」证据。
- 注入：`run-infra.ts:349-361` 的 `codex-tmux` 工厂给 `CodexTmuxAdapter` 构造注入 `nativeDeliveryHooks: { alert, insertEvent, recoveryNudgeFinal, registry }`；单一写者是 adapter hooks；`NativeDeliveryRegistry`（`claude-runner`，Map<executionId,{runtime,lane}>）供 §3.9 外部门铃查找。
- 工厂组合测试断言：最终告警 payload 的 `eventType/severity/eventId` 与 `resolveTicketOwner` 解析出的接收者（Claude infra bot），不只断言 `.alert()` 被调用。

### 3.9 恢复门铃（`runner-recovery-nudge.ts`）

两种模式（R2 #4/#5）：

- **`mode:"rpc-first"`**（Lead HTTP 路由 / auto-repair，codex-tmux 且 registry 命中）：
  1. 闸 0-3；**`attempt` 审计移到这里**（源文件 `:234-248` 的审计块前移到闸 3 之后、任何动作之前，明确改动；失败 → 拒绝，零动作）；
  2. `enqueueRunnerNativeDelivery(message_id="nudge:<fingerprint>", kind="recovery")`（重复 → duplicate，复用同一行）+ `lane.kick()`；
  3. 等待 ≤10s 读该行：`accepted` → 审计 `sent via=rpc` + `handled_remanaged`，200；`unknown` / 超时 → 审计 `unknown`，202 `{nudged:false,pending:true}`，**不**按键；
     `not_sent` → `claimRunnerWakeFallback` CAS（撤销该行后续 native 重投：CAS 内同时置 `exhausted_at`）→ 成功才过闸 4/5（重新 capture + fingerprint + idle box + tmux target）→ 按键 → 审计 `sent via=tmux-fallback` + `fallback_result`；CAS 失败 → 409，不按键。
- **`mode:"final"`**（仅 lane 升级状态机调用，带 `messageId`）：闸 0-3 + 审计 + 闸 4/5 + 按键；**不入队、不派生**；调用前 lane 已持有 fallback claim。
- Claude 路径（registry 未命中）字节不变（审计块前移对 Claude 同样生效——语义仍是「审计先于动作」，只是提前到闸 3 后；闸 4/5 拒绝仍写 `refused` 审计）。

### 3.10 旧文件迁移（一次性 shim）

native 模式 lane 启动时：用 `CodexAdapter.getInboxPath / readUnread / ack`（尊重 `FLYWHEEL_CODEX_TEAMS_DIR`）读未 ack 消息 →
`enqueueRunnerNativeDelivery(message_id = envelope.id 经字符集校验，不符则 `legacy:<sha1(id)>`; source_instruction_id = metadata.flywheelId ?? null)` → 入库成功后 `ack`。下版删 shim 与文件路径。

## 4. 里程碑与顺序

| M | 内容 | 验证 |
|---|---|---|
| M0 | 探针（research §3 P1–P7 + P8 按 message id 读回），回填 §3.1 名称与 §3.5 通知名；go/no-go | `qa/m0-native-delivery-probe.md` |
| M1 | 共同接口：§3.5 身份规则、§3.7 迁移 + helpers、§3.2 类型、§3.6 `delivery_mode` | db 测试：迁移幂等、旧库默认值、`headRunnerWake` 保序（A 退避时 B 不投；A exhausted 后 B 才投）、claim/fallback CAS、receipt 不删激活待办、同事务 insert+enqueue（两连接屏障用例） |
| M2 | §3.1 error phase + §3.2/§3.3 控制边界 + §3.4 blocked | `codex-daemon-client.test.ts`：complete→投递→不进 hold；paused→投递→ACK→leaveHold→再 complete/hold 且预算只恢复一次；ACK 先到/激活后失败 与 相反顺序；thread/resume 断连仍重启；goal/get 超时后正文仍可补投；steer 过期 turn 拒绝=not_sent；shutdown 撤销 |
| M3 | Lane + 升级状态机 | readiness 等待不计尝试；退避；accepted 只激活；已激活行 ACK 超时不重跑；exhausted 隔离；alert 抛错下 tick 重试且门铃至多一次；recovery 行不派生；generation 变更清 turnId；nudge id / 非 UUID flywheelId 回执 |
| M4 | §3.6 写点 / inbox / adapter / §3.10 shim | 改写 research §2.3 五个测试；发送方 env 与目标 mode 不一致按目标路由；无 marker approval/feedback/fix/retest 到 codex-native 入队且零 inbox 文件；backend_conflict；daemon 不可用 read_at NULL；custom teams dir 迁移；ON→OFF 接管对账（accepted/unknown 不重投、告警一条） |
| M5 | §3.8 告警 + §3.9 门铃 | 真实工厂组合 → `alert()` payload + owner 解析断言；kind-contract / echo-immunity fixture；nudge：审计失败零调用、accepted 不碰 tmux、not_sent→CAS→tmux 且 native 零重投、unknown 202、final 模式不入队、Claude 路径对照 |
| M6 | 529 真房 E2E | §6 |

M1 先行；M2 / M3 依赖 M1 且互相独立；M4 依赖 M2+M3；M5 依赖 M4。

## 5. 风险与回滚

| 风险 | 处置 |
|---|---|
| RPC 名称 / 回执通知与本机 codex 不符 | M0 go/no-go |
| 真 blocked 无限 hold | `codex_goal_held` 按 episode 去重直达 Lead；Lead 可 close-runner |
| goal loop 与 lane 竞争 | 全部经 `GoalControl` 单锁；hold 完成只看绑定行 |
| tmux 与 native 双投 | fallback CAS 撤销 native 重投；accepted/unknown 永不按键 |
| 回滚 | 按 execution 持久 `delivery_mode`；env 只影响新 execute；OFF 接管对账不重投已提交/不确定的输入 |
| Claude 回归 | wake.ts / runner-wake.ts 的 claude 分支零改动；审计前移对 Claude 只是更早审计 |

## 6. QA 判据（M6，529 真房）

| # | 场景 | 通过标准 |
|---|---|---|
| ① | 长 turn 中 Lead `send` | 同 turn 内 pane 出现 `[fw-msg …]`；行 `finished`、`messages.read_at` 非空；日志 `via=steer` |
| ② | paused / blocked / complete 各一次，「Resume paused goal?」挂着时 `send` | ≤5s 内 `turn/started`；goal active；hold 退出且预算只恢复一次；无人碰键盘 |
| ③ | land 冲突 → conflict-rework wake（fix / retest，无 questionId） | 目标 Codex 体自动起 turn；`runner_wake_exhausted` 0 条；两种 inbox 目录零新增文件 |
| ④ | Claude runner `send` | 与 QA@1 一致（沿用证据） |
| ⑤ | approval wake 无 marker 到 codex；发送方 env=legacy 而目标=native | 入队并送达；按目标路由 |
| ⑥ | 同一 daemon 内 blocked → 消息恢复 → 再 blocked | 两条 `codex_goal_held` 告警（不同 episodeSeq） |
| QA@2-① 部分 ACK | 单行串行 + 逐消息回执；结构上消失 |
| QA@2-② wait 已消费跳过激活 | `activation_required` 持久待办，回执不删它 |
| QA@2-③ 固定通知键去重 | 同 message_id 才去重 |
| QA@2-④ 指针键不一致 | lane 不读 TURN 指针 |
| QA@2-⑤ reconciler 孤儿行 | exhausted 行带 `exhausted_at` + `escalation_state=done`；follow-up |
| QA@2-⑥ 告警抛错丢失 | 状态机持久，alert 抛错下 tick 重试；门铃至多一次 |
| 断连 | kill daemon → readiness null 不计尝试 → 重启 resume 后补投 |
| 升级 | 错 socket 根目录制造 `not_sent` ×3 → `exhausted_at` + Discord 告警 + 恰一次审计门铃；后续 `send` 新行仍送达 |
| 审计 | 审计库只读 → 门铃 RPC/tmux 零调用，503 |

⛔ 本机只跑相关测试：`pnpm --filter flywheel-claude-runner test -- codex-`、`pnpm --filter flywheel-comm test -- wake|send|inbox|db`、`pnpm --filter flywheel-teamlead test -- recovery-nudge|runner-wake|kind-contract`。

## 7. 明确不做

- `instant_interrupt`（FLY-3066）；CI 完成自动唤醒写点（FLY-2953）；Bridge 进程 crash 后自动重建 adapter（FLY-1269 follow-up）；
- 运行中 execution 的 delivery mode 热切换；删除 JSON inbox 实现（下版）；
- Codex Lead backend（`lead-backends/codex`）任何改动。
