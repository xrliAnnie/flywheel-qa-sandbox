# FLY-1586 Lead 收件循环全舰队停摆 — 调研

Issue: FLY-1586 (https://linear.app/geoforge3d/issue/FLY-1586/p0承接-1579-修复-lead-收件循环全舰队停摆-毒行隔离-截断修复-存量冻结只投新增)
日期: 2026-07-31
基于: exploration.md

> 时间戳一律 UTC。

---

## 1. 调研目标

exploration 已经把根因钉死。本文只回答「怎么修才不会再犯」，逐条落到具体文件行号，并把每个方案的代价写清楚。

四个问题：

1. 止血点应该放在哪一层？（cutover / enqueue / 铸毒点）
2. 补扫怎么做才是安全的？
3. 不变量检查器挂在哪，才能既零新开销又真的会响？
4. 怎么验收才不会重蹈编号 742 的覆辙（守卫喊了但没人听见）？

---

## 2. 代码地形

### 2.1 卡死链上的四个文件

| 文件 | 行 | 角色 |
|------|-----|------|
| `packages/flywheel-comm/src/db.ts` | 4931 | **铸毒点** — `.slice(0, 500)` |
| `packages/flywheel-comm/src/lead-inbox-queue.ts` | 554-602 | **引爆点** — insert-then-verify 逐字段比对 |
| `packages/teamlead/src/bridge/legacy-lead-event-reconciler.ts` | 106-165 | **传播点** — `run()` 无 per-row 隔离，一行抛整个 run 死 |
| `packages/teamlead/src/bridge/lead-inbox-loop.ts` | 173 | **放大点** — `admit()` 在 tick 最前面 |
| `packages/teamlead/src/bridge/lead-inbox-runtime.ts` | 109-113, 206-268 | **共享点** — `ensureCutover` 是全 runtime 一个 promise |

### 2.2 `enqueue` 的全部调用方（决定净化点放哪）

```
packages/flywheel-comm/src/lead-inbox-queue.ts:664      内部 reconcileEnqueueConsumed
packages/flywheel-comm/src/commands/chat-receipt.ts:184 Discord 收据
packages/teamlead/src/lead-backends/codex/ExternalReceiptSaga.ts:45
packages/teamlead/src/bridge/legacy-lead-event-reconciler.ts:162   ← 当前引爆处
packages/teamlead/src/bridge/lead-inbox-runtime.ts:116             protocol 隔离告警
packages/teamlead/src/bridge/protocol-ingress.ts:63
packages/teamlead/src/bridge/question-admission.ts:153             ← question 入列
packages/teamlead/src/bridge/lead-event-queue.ts:22                ← live push 路径
```

**8 个调用方，全部经过同一个 `LeadInboxQueue.enqueue`。** 这是一个天然的收口点 —— 净化放这里，一处覆盖全部；放调用方就要改 8 处且以后每加一个调用方都可能漏。

> ⚠️ 关键：`lead-event-queue.ts:22`（live push 路径）与 `legacy-lead-event-reconciler.ts:162`（boot cutover）**用同一个 `canonicalLeadEventDeliveryId`、同一个 `renderEnvelope`、同一个 `enqueue`**。也就是说今天再来一条 emoji 被切断的 escalation，**live 路径同样会抛**。只修 cutover 的 fail-soft 不足以拔源。

### 2.3 已有的同类先例（不是新发明，是补齐）

仓里已经有两处认真处理过这个问题，说明这个坑被踩过、共识已存在：

- `packages/claude-runner/src/codex-daemon-adapter-helpers.ts:99-113`
  ```ts
  // …never a `slice(0, N)` that can split a UTF-16 surrogate pair
  const safeId = Array.from(issueId).slice(0, 80).join("") || "runner task";
  ```
  `Array.from(s)` 按**码点**迭代，天然不会切开代理对。

- `packages/teamlead/src/__tests__/workflow-docs-output.test.ts:95`
  ```
  "rejects unpaired UTF-16 surrogates instead of silently replacing non-UTF-8 content"
  ```
  **明确选择「拒绝」而不是「静默替换」** —— 这个取向对本单同样适用，但要分层（见 §3.3）。

- Node v25.6.1 已支持 `String.prototype.toWellFormed()` / `isWellFormed()`（ES2024）。实测 `typeof ''.toWellFormed === 'function'`。不需要手写扫描器。

---

## 3. 方案评估

### 3.1 止血：cutover 的 per-row 隔离

**问题本质**：`LegacyLeadEventReconciler.run()` 是一个裸 `for` 循环，任何一行抛出就整个 `run()` 死，后面几千行也全部不处理。

```ts
async run(): Promise<void> {
  for (const row of this.opts.store.listUndeliveredLeadEvents()) {
    ...
    queue.enqueue(queueInput);   // ← 抛在这里，整个 run 结束
  }
}
```

| 方案 | 评价 |
|------|------|
| A. per-row try/catch，失败即跳过 | ❌ 静默吞错。这正是 FLY-1579 这类 bug 的温床 |
| B. per-row try/catch + 隔离到 dead-letter + 告警 | ✅ **选它**。一行坏数据不能拖死全场，但也绝不静默 |
| C. 只在 boot 时把毒行 `markLeadEventDelivered` 掉 | ❌ 伪造投递证据。这条通路的全部价值就是「投递过没有」的真实性 |
| D. 不改 cutover，只修铸毒点 | ❌ 存量毒行还在库里，Bridge 一重启还是死 |

**B 的实现要点**：既有的 `onProtocolQuarantine` 已经是这个形状（`lead-inbox-runtime.ts:115-127`）—— 隔离一行 + 往队列里塞一条告警行。cutover 应该复用同一个语义，而不是发明新的。

`ensureCutover` 的失败重试语义也要一并收紧：**区分「瞬时失败」（owner lease 抢不到 → 该重试）和「这一行永远不可能成功」（→ 隔离，不该无限重试）**。当前代码一律清缓存重试，把确定性故障放大成了死循环。

### 3.2 拔源：`db.ts:4931` 改成码点安全截断

```ts
// 现在
contentSummary: root.content.replaceAll(/\s+/g, " ").slice(0, 500),
// 改成（与 codex-daemon-adapter-helpers.ts:110 同款惯用法）
contentSummary: Array.from(root.content.replaceAll(/\s+/g, " ")).slice(0, 500).join(""),
```

代价：`Array.from` 对 500 字符量级的字符串开销可忽略。语义变化：截断长度从「500 个 UTF-16 码元」变成「500 个码点」，对含 emoji 的串会略长（字节数上限仍然有界），**这是想要的行为**。

⚠️ **必须确认这不是唯一的铸毒点**。`slice(` 在 payload 构造路径上还有多少处？这是实施第一步要 grep 清的（见 plan §2 步骤 0）。只修一处、下周换个地方再铸一颗，等于没修。

### 3.3 净化边界：`LeadInboxQueue.enqueue` 收口

分层取向 —— **拒绝 vs 清洗，要按「谁是权威」分**：

| 字段 | 取向 | 理由 |
|------|------|------|
| `id` / `to_lead` / `source` / `type` | **拒绝**（抛） | 这些是路由权威，被 U+FFFD 污染意味着路由本身已经不可信 |
| `content` | **清洗**（`toWellFormed()`）+ 记一条审计 | content 是给人看的正文。为了一个半截 emoji 丢掉整条 Lead 通知，代价远大于收益 |

这样做之后，`enqueue` 的 insert-then-verify 比对**天然恒等**（写进去的就是已经 well-formed 的串，读回来一定相等），根因从「读回不等」层面被消除，而不是靠下游兜。

> ⚠️ 反向验证要点：清洗**必须发生在写入之前**，且比对用的 `expected` 必须是清洗**之后**的值。如果只清洗写入值而 `expected` 还用原值，异常照抛，等于没修 —— 这是这个改动最容易写错的地方，必须有针对性测试。

### 3.4 补扫

`QuestionAdmission.materializePending()` 本身就是一个幂等的重扫：`getPendingQuestions(leadId)` 拉出所有「未回答且未终态」的 question，`isLeadEventDelivered` 去重。**通路一恢复，仍然 open 的 question 会自动被捞回来 —— 不需要写新逻辑。**

实测可救量（07-29T12:39:30 之后，无 `lead_inbox` 行）：

```
项目          漏掉   仍可救（未回答 且 relay_state != terminal_disposed）
flywheel      17     4
tidal-echo     3     3
合计          20     7
```

剩下 13 条已经 `terminal_disposed` 或已被 Tadashi 手工回答，**结构上不可能再投递**（`getPendingQuestions` 的谓词把它们排除，这是正确行为，不该绕过）。

⇒ 补扫命令的职责是两件事，不是一件：
1. **捞回**仍可救的（其实靠 admission 自愈即可，命令负责**证明**它被捞回来了）
2. **出清单**：把不可救的那 13 条列出来，人肉决定要不要重开

> ⚠️ `getPendingQuestions` 的 pending 谓词受 `FLYWHEEL_COMMDB_PROTECTION` 控制（`db.ts:299`，默认 ON = `relay_state != 'terminal_disposed'`；OFF = `expires_at > now`）。补扫命令**不得**自己重写这个谓词 —— 必须复用 `getPendingQuestions`，否则两边对「什么叫 pending」的理解会漂移。

### 3.5 不变量检查器

**挂点**：`GatePoller` 的既有 piggyback 模式（`gate-poller.ts:784`）：

```ts
(this.tickCount - 1) % 20 === 0
```

仓里已有 5 处用这个模式（FLY-208 A2 巡检、FLY-513 drift 探针、FLY-1048 reconcile、FLY-907 display sweep…）。**零新 timer、零新进程**，与既有运维形态一致。

**检查什么** —— 分两层，缺一不可：

| 层 | 断言 | 为什么必须有 |
|----|------|-------------|
| L1 业务不变量 | `type=question` 且 `to_agent` 是 Lead、创建超过 N 分钟、仍 pending、无 `lead_inbox` 行 → 告警 | issue 明确要求 |
| L2 通路活性 | `loop_heartbeat.last_success_at` 落后 `last_started_at` 超过 N 分钟 → 告警 | **这才是本次能提前 60+ 小时发现的那个指标** |

**L2 是本次事故最重要的教训**：L1 只在有人提问时才会响；L2 在通路一死就会响，不依赖有没有流量。这次检测其实开火了（见 exploration §8），但发送结果无持久化，所以 60+ 小时无人知晓。

⚠️ **class-aware 硬约束**（issue 明确要求，必须写进实现注释）：L1 的断言只对 `question` 类成立。正对照：07-29 当天 38/47 的 question 有对应 `lead_inbox` 行，最后一条 `question:flywheel-eng-lead:8af841ba-…` 带完整 `consumed_at` + `disposition=delivered`。**对 `instruction` / `response` 类这个推论不成立**（它们走别的通路，`lead_inbox` 里本来就没有），检查器必须显式只扫 `question`，不能泛化成「所有 message 都该有 inbox 行」。

---

## 4. 验收怎么设计才有效

issue 给的判据是硬的：

> 如果一条验收能在「接收方不存在」的情况下通过，那这条验收是无效的。

对照编号 742 的教训（守卫开火 16 次、16/16 卡在同一处、17 天无人知晓，因为当年验的是「守卫会不会喊」而不是「喊了有没有人听见」），本单的验收必须落在**接收方那一侧**：

| 验收 | ❌ 无效形态 | ✅ 有效形态 |
|------|-----------|-----------|
| 端到端 | 「admission 被调用了」/「没报错」 | 真 runner 发 question → `lead_inbox` 查到 `ref_message_id` 匹配的行 → **且该行 `consumed_at` 非空、`disposition=delivered`** → Lead 侧确认看到 |
| 前后对比 | 「代码看起来对」 | 修复后新 question 进入率回到 90%+，且 `loop_heartbeat.last_success_at` 追上 `last_started_at` |
| 检查器 | 「检查器跑起来了」 | **人为造一条进不去的 question → 检查器真的告警**；再造一条正常的 → 检查器**不**告警（阴性对照，防止它对什么都喊） |
| 反向验证 | — | 把 admission 弄坏 → **必须失败且可观测**，不允许静默通过 |
| 回归护栏 | — | 把毒行 payload 做成 fixture → 跑 cutover → **必须完成且隔离该行**，不允许整个 run 死 |

> ⚠️ 额外一条，针对本次故障的特殊性质：**`lead_inbox` 里查不到某行 ≠ 那行没被写过**。本次毒行就是「写了又被事务回滚」，表里查不到，唯一证据在 Bridge 日志。任何验收脚本如果只查表不查日志，会漏掉这一整类失败。

---

## 5. 风险与边界

| 风险 | 说明 | 处置 |
|------|------|------|
| `slice(` 不止一处 | 只修 4931 可能漏 | 实施前先全量 grep payload 构造路径（plan 步骤 0） |
| 清洗改变 content 字节 | 已入库的老行 content 含 U+FFFD，与重新渲染的不等 | 清洗必须发生在比对之前，两侧同源；需专门测试 |
| cutover 隔离掉真正该投的行 | 隔离 ≠ 丢弃 | 必须进 dead-letter + 告警，且可人工重放 |
| 生效需要重启 Bridge | 本修复在 Bridge 侧 | 重启会销毁现场基线 —— **重启前必须先把 `loop_heartbeat` / 积压计数 / 日志取证留档**（见 memory: 销毁性动作前抓基线） |
| 本单不碰的 | 消息层重构（总纲 FLY-1569）、`lead_inbox` schema、新 feature flag | issue 明确划在 scope 外 |

---

## 6. 结论

- 止血 = cutover per-row 隔离 + dead-letter + 告警（**方案 B**）
- 拔源 = `db.ts:4931` 码点安全截断（+ 先 grep 清同类点）
- 收口 = `LeadInboxQueue.enqueue` 分层净化（路由字段拒绝 / content 清洗）
- 补扫 = 复用 `getPendingQuestions` + `materializePending`，命令只负责**证明**和**出清单**
- 检查器 = GatePoller piggyback，**L1 业务不变量 + L2 通路活性双层**，class-aware 只扫 question

四件事互相独立，可分别验收。其中 **L2 通路活性告警** 是唯一一个能让下次同类故障在 60+ 小时之前被发现的东西 —— 优先级不低于修复本身。
