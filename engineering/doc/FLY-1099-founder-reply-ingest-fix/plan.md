# FLY-1099 founder-reply 摄取死掉 — 实施计划

Issue: FLY-1099 (https://linear.app/geoforge3d/issue/FLY-1099/fix-founder-reply-摄取discordcommdb死掉-founder-批准静默不绑-gatep1)
日期: 2026-07-09
基于: research.md（同文件夹 exploration.md / research.md）

> **Codex design review: APPROVED（6 轮，2026-07-09，thread 019f4a61-a91b-7c43-913c-e32fc3fbe2ed）**
> findings 收敛 7→6→5→4→1→0；R5 最后一项（conflict 判定前移到生产 hook 之前的 guarded
> wrapper）已折入 §4.3。R1-R5 逐项采纳记录见下。

## 0. 决策记录

**brainstorm gate（Tadashi 已拍板）**：

- **Q1 僵尸 pending gate**：自动 resolve（写审计），不是只跳过；terminal 判定保守。
- **Q2 hold 期间的 founder 批准**：做「暂存 + hold 清绿后自动补绑」，护栏：(a) TTL 有界
  （30-60min）；(b) 同一 gate + head 未漂移才补绑，head 一动即作废并要求重新批准。
- **Q3**：一个 PR，QA 一次真机验。
- **硬要求**：① held_declined 升级为 thread 明文回复 = 最高优先；② 告警走
  #flywheel-alerts + FLY-220「报一次就停」；③ 真机 QA 复现今晚场景。

**Codex design review R1 采纳记录**（7 项全采纳）：

1. deliverer/handler 合同升级为显式 disposition（deferred ≠ WAKE-only；dead-letter 尊重
  FLY-945 waterline）。
2. hold-reason 分流：仅 codex_pending / qa_not_green 可暂存；merge_block 走既有
  same-head recovery，绝不进补绑等待；「已存着」回复只在 durable 落盘后发。
3. deferred 表改 (question_id, msg_id) 历史键 + 单活跃行唯一索引；同 msg 重扫严格
  no-op（不刷新 TTL）；存 author + canonical founder 身份并在补绑时复核；写入结果按
  reason 状态机处理。
4. founder 明文/zombie/dead-letter 全部改「durable intent → 执行 → outcome」三段式，
  拒绝 claim-当-送达；通知走 result-bearing 的 notify ledger。
5. watchdog eventId 加 episode salt（claims.db 永久去重下才能跨 episode 再报）；
  deliverer 返回结构化 outcome；hang 检测放 tick 外层；补 ALERT_EVENT_TYPES 等注册面。
6. zombie 判定显式两分支（terminal→retire；active-but-unreachable 如 FLY-1049 →
  dead-letter+专属告警，不 resolve）；非-ship resolve 用带守卫的新原语。
7. nudge effects 升级为可判定 outcome + ledger 化重试；实现顺序按依赖排。

**Codex design review R2 采纳记录**（6 项全采纳）：

1. 「bound 完成」重定义为**可验证 postcondition**（response 同向 + session 状态已翻），
  `written:true` 本身不算数（生产 post-write hook 返回 void、FSM 失败只 log）；实时
  handler 的 written:false→handled 错误映射一并修正。
2. action ledger 补因果/资格/取消语义：per-kind 唯一键（-queue/-wake 后缀）、drain 执行时
  重验资格、`cancelled|superseded` 终态、wake 依赖 queue delivered、冲突通知补 cancel；
  索引 IF NOT EXISTS。
3. 告警必达：dead-letter/ledger-failed 的 alert 以 durable `emit_alert` intent 与终态同
  transaction 落盘；notifier 的 duplicate ≠ 送达 receipt；watchdog 数据源明确含 action
  ledger。
4. Z1 intent 重入按重读结果分类（answered / already_retired / purged / retry），不伪称
  answered；terminal 集合不跨 DB 复用，新导出 `isStateStoreIrreversibleTerminalForZombie`
  逐值列明；kill-switch 在写 intent 前短路。
5. deferred × held-reply 双开关写全 2×2 真值表，OFF/ON 组合仍发解释文案（硬要求①不因
  关暂存而回到静默）。
6. retry 行清理条件 = waterline 安全跨过该 msg（含 irrelevant/already-answered）；pin
  episode salt 含 retry 行 first_seen；pass-dead salt 用 firstFailMs；pass 级告警指定
  infra owner 路由。

**Codex design review R3 采纳记录**（5 项全采纳）：

1. 完成状态机按 decision 拆开：approve 要求同向 response + session 已翻
  approved_to_ship；**reject 的预期终态 = 完整 feedback 成为唯一 response +
  feedback_wake intent 落盘，session 保持 awaiting_review**（生产 hook 只对 approve
  transition）。reject feedback 存完整原文，excerpt 只用于审计。
2. 分类（含 Tier-3 await + 重试）之后、调 writer 之前**紧邻重验** hold/head/binding
  （TOCTOU 关闭），实时与补绑两路同用。
3. ledger 不承诺 exactly-once：Codex instruction sink 以 action_key 做 durable 去重
  （INSERT OR IGNORE 等价）；依赖终态传播（父 failed/cancelled/superseded → 子
  cancelled）；emit_alert 自身失败落有界终态不递归增殖；founder POST 明示 at-least-once
  （crash 窗口可能重复）。
4. retry/dl/fail 的 episode salt 用新列 `first_seen_ms INTEGER`（Date.now() 写入，与
  终态同 transaction），不依赖秒级 datetime 重算。
5. 显式父开关矩阵：`FLYWHEEL_FOUNDER_REPLY_DELIVER=0` 下 emit_alert drain 与已提交
  ledger 投递仍收敛、watchdog pass-dead 静默（有意关闭≠故障）；nudge 层新增 enable
  flag；§8 的回滚承诺改为诚实边界（行为层可 flag 回滚，底层加固不 flag）。

**Codex design review R4 采纳记录**（4 项全采纳）：

1. outcome 合同 decision-aware（bound/deferred 携带 decision）；✅ 保持 Chunk 8 生产
  语义（approve/reject 皆=「决定已绑定」）；reject 通知措辞改「已记录，正在通知 runner」
  与 (b') 的 intent-committed 语义对齐；feedback_wake 进 kind 枚举/dispatcher/文件清单。
2. 新 `conflicting_prior_feedback` 终态：canonical 同向 reject 但 feedback 不同 →
  invalidate + 双 excerpt 审计，不重跑到 TTL、不冒称已写、不重复 wake。
3. emit_alert 防递归收口：只有非 emit_alert 行 failed 才生 emit_alert（同 transaction
  写 `failed_at_ms` 作 salt）；watchdog 的 dead-letter 探测器排除 emit_alert-kind
  failed 行；删除「告警的告警也必达」矛盾句。
4. R3/R4 全部点名回归测试逐项列入 §9 对应 S 段 + 新增 reject 全链集成测试。

## 1. 目标与不变量

**目标**：founder 自然语言批准重新可靠入库绑 gate；摄取链任何一环卡死在阈值内告警；
不再有任何 founder 消息静默消失。

**总不变量（账本诚实性）**：每一条成熟的 founder 消息，终态必属于且仅属于：
①成功处理（绑定 / 暂存 / respond / handoff / wake+marker）②有界重试中（cursor 钉住，
retry 表可观测）③dead-letter（审计事件 + durable 告警队列留痕）。不存在「静默消失」。

**安全不变量（零改动）**：hold 期间绝不写 approve（FLY-1041 Chunk 5 保留）；
verify-approval / respond.ts / write-gate-response 授权链路字节不变；wake 永远非授权；
补绑只发生在 hold 清除后、经过与实时绑定完全相同的 write 路径、全部前置校验重跑。

## 2. 变更总览与实现顺序（Codex R1 #7）

按依赖顺序实现，先合同后消费者：

| 步 | Part | 内容 | 主要文件 |
|----|------|------|----------|
| S1 | 基座 | StateStore 三张新表 + notify/nudge ledger + outcome-bearing effects API + deliverer disposition/retry 合同 | `StateStore.ts`、`founder-reply-deliverer.ts`、`auto-qa-effects.ts` |
| S2 | 3 | handler 暂存 + 补绑 pass | `founder-ship-approval-handler.ts`、新 `approval-signal/deferred-approval.ts`、`gate-poller.ts` |
| S3 | 2a | held 明文回复（经 notify ledger） | `founder-ship-approval-factory.ts`、`auto-qa-held.ts`、`plugin.ts` |
| S4 | 1 | 僵尸 gate 卫生（intent→mutation→outcome） | `gate-poller.ts`、`flywheel-comm/db.ts` |
| S5 | 2b | codex-hold nudge（ledger 化） | `auto-qa-coordinator.ts`、`auto-qa-effects.ts`、`codex-instruction.ts` |
| S6 | 4 | 有界重试 + dead-letter | `founder-reply-deliverer.ts`、`StateStore.ts` |
| S7 | 5 | watchdog + 告警注册面 | 新 `founder-reply-watchdog.ts`、`gate-poller.ts`、`plugin.ts`、`LeadAlertNotifier` 注册面（ALERT_EVENT_TYPES / title-body map / routing） |
| S8 | 6 | Tier-3 分类器加固 | `subscription-claude-classifier-runner.ts`、handler |

## 3. S1 基座：数据模型与合同

### 3.1 StateStore 新表（幂等迁移，既有 ADD-TABLE 风格）

```sql
-- 暂存凭证：历史键,永不 UPDATE created/expires;同 gate 单活跃行由 partial index 保证
CREATE TABLE founder_deferred_approval (
  question_id     TEXT NOT NULL,
  msg_id          TEXT NOT NULL,           -- founder 消息 snowflake
  execution_id    TEXT NOT NULL,
  issue_id        TEXT NOT NULL,
  project_name    TEXT NOT NULL,
  pr_head_sha     TEXT NOT NULL,           -- 捕获时 head(护栏 b 锚)
  thread_id       TEXT NOT NULL,
  decision        TEXT NOT NULL CHECK(decision IN ('approve','reject')),
  content         TEXT NOT NULL,           -- 完整原文(R3 #1:reject 的 feedback 必须全量给
                                           -- runner;审计/告警只用截断 excerpt)
  author_user_id  TEXT NOT NULL,           -- 捕获时消息作者
  founder_id_at_capture TEXT NOT NULL,     -- 捕获时 canonical founder id(R1 #3)
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT NOT NULL,
  consumed_at     TEXT,
  invalidated_at  TEXT,
  invalidated_reason TEXT,  -- head_drift|ttl_expired|gate_gone|replaced|founder_identity_changed
  PRIMARY KEY (question_id, msg_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_deferred_active ON founder_deferred_approval(question_id)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;   -- R2 #2: IF NOT EXISTS,幂等迁移二次启动不炸

-- founder 面通知 / 再驱动动作 / 必达告警的 result-bearing ledger(R1 #4/#7 + R2 #2/#3):
-- durable intent → (drain 时重验资格) → 执行 → outcome,重启可收敛
CREATE TABLE founder_action_ledger (
  action_key   TEXT PRIMARY KEY,           -- per-kind 唯一幂等键,如 held-reply-<qid>-<msgId> /
                                           -- codex-nudge-<exec>-<head>-queue / ...-wake(R2 #2:后缀区分,
                                           -- 单列主键下两行才都插得进去)
  kind         TEXT NOT NULL,              -- held_reply|ttl_expired_notice|head_drift_notice|rebound_notice|
                                           -- feedback_wake|codex_nudge_queue|codex_nudge_wake|emit_alert
  execution_id TEXT NOT NULL,
  issue_id     TEXT NOT NULL,
  project_name TEXT NOT NULL,
  thread_id    TEXT,
  payload      TEXT NOT NULL,              -- 文本/参数 JSON(含 drain 时资格重验所需的 expected head/qid)
  depends_on   TEXT,                       -- 前置 action_key:未 delivered 前本行不执行(R2 #2,wake 依赖 queue)
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK(status IN ('pending','delivered','failed','cancelled','superseded')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT,
  failed_at_ms INTEGER                     -- 标 failed 的同一 transaction 写入(Date.now());
                                           -- failed→emit_alert 的 episode salt 唯一来源,
                                           -- 重启只读不重算(R4 #3)
);

-- 有界重试账本(Part 4;也是 watchdog 钉死检测的 durable 数据源)
CREATE TABLE founder_reply_retry (
  thread_id   TEXT NOT NULL,
  msg_id      TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  first_seen_ms INTEGER NOT NULL,          -- Date.now() 毫秒(R3 #4:episode salt 的 durable
                                           -- 来源;datetime('now') 只有秒级,同秒两 episode 会
                                           -- 撞 claims.db 永久去重)
  last_stage  TEXT,                        -- 最近失败阶段(wake_no_session_lead|tier3_runner_failed|handoff_failed|respond_failed|read_failed)
  last_error  TEXT,
  dead_lettered_at TEXT,
  dead_lettered_ms INTEGER,                -- 同 transaction 写入,alert salt 用它,不重启重算
  PRIMARY KEY (thread_id, msg_id)
);
```

### 3.2 handler 返回合同升级（R1 #1）

`tryFounderShipApproval` 返回类型改为：

```ts
type ShipApprovalOutcome = {
  /** bound: 对应 decision 的 postcondition 已达成(R4 #1:decision-aware,
   *  deliverer 才能区分 approve/reject 的 receipt 与文案) */
  bound: Array<{ questionId: string; decision: "approve" | "reject" }>;
  /** deferred: 已 durable 暂存 — 消息已妥善处置,跳过 WAKE,cursor 可前进 */
  deferred: Array<{ questionId: string; decision: "approve" | "reject" }>;
  /** retry: transient infra 失败(tier3_runner_failed / 暂存落盘失败) — 钉 cursor 有界重试 */
  retry: boolean;
  /** stage/reason 透传给 retry ledger 与审计 */
  stage?: string; reason?: string;
} | null;   // null = 未归因(非 founder / narrow 失败 / unclear) → WAKE-only 现状
```

**receipt 语义（R4 #1）**：✅ 沿用 FLY-1041 Chunk 8 的生产语义 =「她的 decision 已绑定
（approve **或** reject）」——live bound 与补绑完成都升 ✅（字节兼容今日 reject 也 ✅ 的
行为）；🕒 = 已暂存未绑定；文案按 decision 区分（§4.3）。`feedback_wake` 加入
`founder_action_ledger.kind` 列举、drain dispatcher 与 S1 文件清单。

deliverer ship 分支消费规则：

- `bound` ∪ `deferred` 里的 qid → 跳过 WAKE。
- `deferred` 非空 → receipt 用 🕒（新 outcome，一次性 marker 语义与 ❓/✅ 同构；✅ 只在
  真正 bound / 补绑成功时出现）。
- `retry === true` → `allOk=false`（钉 cursor，进 Part 4 有界重试）。
- 其余照旧 WAKE-only + ❓。

kill-switch off（`FLYWHEEL_DEFERRED_FOUNDER_APPROVAL=0`）→ handler 回到 held 提前
decline（现行字节路径），deliverer 对 null 的处理不变 → 全链字节兼容。

### 3.3 effects 升级为 result-bearing（R1 #4/#7）

- `AutoQaEffects.postThread` 增加结果化变体 `postThreadResult(args): Promise<{ok:boolean,
  status?:number, messageId?:string}>`（旧 void 签名保留，内部同一实现，避免大改现有调用点）。
- `queueCodexInstruction` → 返回 `{queued: boolean, error?: string}`；底层
  `queueCodexCodeReviewInstruction` 不再吞 DB 错误（向上传布尔/异常）。
- ledger 驱动循环：GatePoller founder-reply 子节奏里跑 `drainFounderActionLedger()`：
  取 `status='pending'` 且 `attempts < FLYWHEEL_FOUNDER_NOTIFY_RETRY_MAX`（default 5）
  的行，按序执行。**每行执行前（R2 #2 + R3 #3）**：
  1. **依赖终态传播**：`depends_on` 指向的父行 pending → 本轮跳过（wake 永远排在 queue
     delivered 之后）；父行 delivered → 可执行；父行 failed / cancelled / superseded →
     子行标 `cancelled`（不永久 pending，R3 #3）。
  2. **资格重验**：按 payload 里的 expected 上下文重查（nudge 类：session 仍
     awaiting_review 且 head 未漂移；notice 类：不与更新的终态通知冲突，见下）——不满足
     → 标 `cancelled`（审计 reason），绝不投旧动作。
  3. 执行（postThreadResult / queueCodexInstruction / wake / LeadAlertNotifier）→ 成功标
     delivered；失败 attempts+1；达上限标 failed + 插 `emit_alert` intent（必达告警，见
     §7.1）。
- **投递语义 = at-least-once，副作用去重下沉到 sink（R3 #3）**：外部副作用成功、进程在标
  delivered 前 crash → 重启会重投。因此：Codex instruction sink 以 `action_key` 为稳定
  instruction id 做 durable 去重（`insertInstruction` 增加显式 id + INSERT OR IGNORE
  等价路径——现实现每次随机 UUID，重投=重复排 /codex-code-review，会放大 review 负载）；
  founder thread POST 无幂等键可用 → **明示 at-least-once**（crash 窗口可能重复一条
  thread 明文，可接受，不承诺 exactly-once）；wake 天然幂等（旧 wake 只是提示）。
- **emit_alert 自身失败有界（R3 #3）**：emit_alert 行重试耗尽 → 标 failed + 审计
  `founder_alert_emit_exhausted`（console.error 兜底），**不**再生成新的 emit_alert
  行——告警链不递归增殖。
- **supersede 语义（R2 #2）**：补绑成功 / head_drift / ttl_expired 落盘时，同一
  transaction 内把该 gate 尚 pending 的 `held_reply` 行标 `superseded`——旧「暂时绑不上」
  绝不排在「已生效」之后送出；最终 notice 自包含。
- 写 ledger 行（intent）与执行解耦 = claim ≠ 送达，崩溃后 pending 行自动续投。单
  Bridge 进程 + 单子节奏串行 drain，无双 drainer，不需要 lease。

### 3.4 deliverer 结构化 outcome（R1 #5）

`emitFounderReplyDeliveryForThread` 返回 `ThreadScanOutcome`：
`{threadId, result: "advanced"|"pinned"|"read_failed"|"process_failed"|"noop",
pinnedMsgId?, stage?, reason?}`；GatePoller 聚合进 watchdog 健康账本。Discord GET 失败
不再是纯审计——它成为 outcome（连续 read_failed 也能告警）。

## 4. S2/S3 — 暂存 + 补绑 + held 明文回复

### 4.1 hold-reason 分流（R1 #2）

新只读 helper（`auto-qa-held.ts`）：
`reviewHoldReason(store, session, env): "merge_block" | "codex_pending" | "qa_not_green" | null`
（与 `isReviewHeld` 同一判定顺序，纯读，两者共享内部实现防漂移）。

- **可暂存**：`codex_pending`、`qa_not_green`。
- **merge_block**：**不暂存**（它只能被 same-head approval 清除，等 hold 清=死循环，
  R1 #2）。明文回复改为指路：「这个 PR 之前被合并挡下了，走的是另一条恢复流程
  （需要你对当前 head 重新批准）」——即现有 FLY-869 same-head recovery surface，本 PR
  不改它的语义。

### 4.2 handler held 分支改造（S2）

held 且 reason 可暂存 且 flag ON：

1. 继续跑 Tier-2/Tier-3 分类（只读，fail-closed 语义不变）。
2. approve/reject → **一个 StateStore transaction**：invalidate 旧活跃行（reason
   `replaced`，仅当 msg_id 不同；同 (question_id,msg_id) 已存在 → **严格 no-op**，不刷新
   TTL，R1 #3）+ 插入新行（expires = now + TTL）+ 插 `held_reply` ledger 行（intent）。
   审计 `founder_approval_deferred`。返回 `{bound:[], deferred:[qid], retry:false}`。
3. 暂存 transaction 失败 → `{bound:[], deferred:[], retry:true}`（transient，钉 cursor）。
4. 分类 unclear → 现状（null → WAKE-only + ❓，**不发**「已存着」——R1 #2 撒谎时序修正）。
   分类 infra 失败 → `retry:true`（Part 6）。
5. held 且 reason=merge_block → 不分类不暂存，插 merge_block 指路明文的 ledger 行
   （幂等键 held-reply-<qid>-<msgId>），返回 null（WAKE-only 照旧）。

明文文案（founder 面人话，approve/reject 措辞区分，R1 #2）：

- approve 暂存：「收到你的批准 🕒 —— 这个 gate 现在卡在 <codex review 还没过 / QA 还没绿>，
  暂时绑不上。你的批准我先存着（<N> 分钟内有效）：卡点一清会自动生效；要是过期了或代码
  更新了，我会再来找你重新确认。」
- reject 暂存：「收到你的意见 🕒 —— 卡点清了之后会作为你的反馈生效（<N> 分钟内有效）。」
- merge_block：见 4.1。

### 4.4 双开关 2×2 真值表（R2 #5 —— 每个 kill-switch 独立回滚，绝不暗中互关）

| `FLYWHEEL_DEFERRED_FOUNDER_APPROVAL` | `FLYWHEEL_HELD_DECLINED_REPLY` | held + 可暂存 reason 时的行为 |
|---|---|---|
| ON | ON | 分类 → 暂存 + 🕒 + 「已存着」thread 明文（ledger） |
| ON | OFF | 分类 → 暂存 + 🕒，**不发** thread 明文 |
| OFF | ON | **不暂存**（held 提前 decline，today 路径）+ 发解释明文：「你的批准现在绑不上（<原因>），卡点清了之后请再说一次」——硬要求①不因关暂存而回到静默 |
| OFF | OFF | 今日字节路径（❓ + WAKE-only，全静默） |

merge_block 永不暂存（与 deferred flag 无关）；其指路明文仅在 reply flag ON 时发。
此表逐格进单测（§9 S3）。

### 4.3 补绑 pass（S2，`gate-poller.ts` 新私有方法，同子节奏零新 timer）

对每条活跃暂存（未 consumed / 未 invalidated），按序校验：

1. **TTL**：过期 → invalidate `ttl_expired` + `ttl_expired_notice` ledger 行 + 审计。
2. **founder 身份**：当前 canonical founder id ≠ `founder_id_at_capture` → invalidate
   `founder_identity_changed`（仅审计，不打扰，R1 #3）。
3. **gate 有效性**：CommDB question 仍 pending 且 StateStore session `awaiting_review`
   且 `review_question_id === question_id`；否则 invalidate `gate_gone`（仅审计——gate
   已被别的路径答掉/移动，founder 无需打扰）。
4. **head 护栏**：session 当前 `pr_head_sha ≠ 暂存 head` → invalidate `head_drift` +
   `head_drift_notice` ledger 行（「代码更新过，你之前的批准作废，需要重新确认」）。
5. **hold 复查**：`isReviewHeld` 仍 true → 本轮跳过（TTL 兜底）。
6. **写入**：与实时路径完全相同的 `writeGateResponseAndRunPostWrite`（actor =
   canonicalFounderId，`expectedCurrentReviewQuestionId` 同实时）。

   **写入前的紧邻重验（R3 #2，实时与补绑两路同用）**：分类含 Tier-3 `await` 外部 CLI
   （+2s 重试），是一个 TOCTOU 窗口——signal 得出后、调用 writer 之前必须**重新读取**
   session 状态、`review_question_id`、`pr_head_sha` 与 `reviewHoldReason`：hold 再现 →
   按当时 reason 走 deferred/declined disposition（绝不写）；head/binding 漂移 →
   fail-closed 不写旧 gate。竞态测试：fake Tier-3 promise 等待期间翻 codex/QA/head →
   断言零 response、零 ✅。

   **「完成」= 可验证 postcondition，不是 `written:true`（R2 #1），且按 decision 拆开
   （R3 #1——生产 hook 只对 structured approve 做 FSM transition；reject/feedback 只
   wake，session 保持 awaiting_review 是预期状态）**：

   - **approve 完成**：(a) 该 question 的唯一 response 存在、actor 是当前 canonical
     founder、内容为 approve；且 (b) StateStore session 已离开 `awaiting_review` 进入
     `approved_to_ship`（如实现时确认存在合法 recovered 终态，逐值列明并给出专属证据）。
   - **reject 完成**：(a') 该 question 的唯一 response 存在、actor 是当前 canonical
     founder、内容为**完整 feedback payload**（与暂存的完整原文一致）；且 (b') 携带
     feedback 的 `feedback_wake` action-ledger intent 已与 consumed 同 transaction 落盘
     （wake 投递本身 at-least-once 续投）。session 保持 `awaiting_review` 是预期，
     **不**要求翻状态。
   - deferred 表的 `content` 存**完整原文**（不截断——runner 要收全量修改意见）；审计/
     告警只用截断 excerpt（R3 #1）。

   wake 是非授权副作用：不阻塞授权落账，也不冒充 flip 成功——wake 失败只进 action ledger
   续投。

   **按复查结果的状态机（逐 reason，实现时以 write-gate-response 源码枚举为准）**：
   - 对应 decision 的 postcondition 达成（approve=(a)+(b)；reject=(a')+(b')）→ 标
     consumed + 审计 `founder_approval_rebound` + `rebound_notice` ledger 行（approve:
     「你 <HH:MM> 的批准已自动生效 ✅」；reject:「你 <HH:MM> 的反馈已记录，正在通知
     runner」——措辞诚实于 (b') 只保证 wake intent 落盘、投递 at-least-once 在途，R4 #1）
     + ❓/🕒→✅ 一次性升级 marker（✅=decision 已绑定，approve/reject 皆升，同今日生产
     语义）。**「已生效/已记录」只在此处发**。
   - approve 的 (a) 成立但 (b) 未成立（response 写了、FSM 没翻——hook 静默失败）→
     **保持 deferred 活跃**，下一轮经 already-answered 路径重跑 hook
     （write-gate-response 对 already_answered 的 `written:false, retrySafe:true` 语义
     正是为重跑 hook 存在的），直到 (b) 达成或 TTL 兜底。不发「已生效」。
   - 已有 response 但 actor 非 canonical founder 或方向不一致（含 UNIQUE race 他人先赢）
     → invalidate `gate_gone`（审计含实情），不发「已生效」。
   - **conflicting_prior_feedback（R4 #2 + R5 #1 执行顺序前移）**：已有 response 是
     canonical founder 的**同向 reject 但 feedback 内容不同**（共享 writer 的
     same-decision 判定只比 isApproval 布尔，会把两条不同 feedback 当 identical，并且
     在返回 already_answered **之前**就先 `runHook`——生产 hook 对 reject 会用**新**
     feedback `sendRunnerWake`）→ 判定必须发生在 hook 执行**之前**：
     **guarded `onResponseWritten` wrapper**（shared writer 字节不动——founder 两条路径
     （实时 + 补绑）都给 writer 传入包装过的 `onResponseWritten`：调用生产 hook 之前
     重读该 question 的唯一 response，要求 (i) actor = 当前 canonical founder，且
     (ii) approve → response 是合法 structured approval / reject → response 与本次
     payload **逐字一致**；不匹配 → 返回 `{ok:false}` 且**绝不调用**原 hook（零 hook、
     零 wake、零 FSM transition），随后 caller 落 `conflicting_prior_feedback`（同向异文）
     或 `gate_gone`（异 actor/异向）终态：invalidate + stored/requested 双 excerpt 审计，
     不重跑到 TTL。exact-match 的 canonical retry 照常调用原 hook（重跑收敛语义不变）。
     唯一 response 永远保持先写入的那条。
     测试要求（R5 #1）：用**真** `writeGateResponseAndRunPostWrite` + spy 生产 hook
     （不许只 fake already_answered 结果），断言异文/异 actor 两情形零 hook 零 wake 零
     transition；exact retry 仍重跑 hook 收敛。
   - guard 拒绝（review question 已移动 / hold 复现等）→ 保持活跃，下轮再试（TTL 兜底）。
   - 其余错误 → 保持活跃 + last_error 审计，连续失败由 TTL 收敛。

   **实时 handler 同一映射（R2 #1）**：现源码在 `written:false, retrySafe:true` 的 guard
   refusal 上仍把 qid 归入 handled（跳过 WAKE）——改为只有 postcondition 达成才归
   `bound`；guard refusal → null 语义（WAKE-only 现状），already-answered → 同上重读
   分类。三个点名测试进 §9：fresh response 写成功但 FSM 失败、prior 同向 response +
   首次 hook 失败后重试成功、UNIQUE race 的 prior actor 非 founder——三者都不得错误
   consumed / 发 ✅。

## 5. S4 — 僵尸 gate 卫生（R1 #6 两分支）

**分支 Z1（resolve）**：StateStore session **不存在**，或状态命中**新导出谓词**
`isStateStoreIrreversibleTerminalForZombie(status)`（R2 #4：**不**与 commdb-session-prune
跨 DB 复用集合——CommDB 终态词表是 completed|timeout，StateStore 状态域更大且其内部单调性
TERMINAL_STATUSES 含 awaiting_review，语义完全不同。新谓词逐值列明 StateStore 的不可逆
终态（实现时以 FSM 词表为准，形如 completed/failed/…），绝不含 awaiting_review 等中间态，
每个允许值有单测），**且** CommDB `sessions` 行已不存在 → 三段式：

1. **intent**：StateStore 审计 `founder_gate_zombie_resolve_intent`（幂等 event_id 含
   questionId；boot/每轮扫 intent-without-outcome 可重入续做）。kill-switch
   `FLYWHEEL_ZOMBIE_GATE_RESOLVE=0` 在**写 intent 之前**短路（R2 #4：全关=零新副作用，
   与 §8 回滚声明一致），仅保留候选集过滤为纯内存行为也一并短路——OFF 即今日字节路径。
2. **guarded mutation**：`approve_to_ship` → 既有 `retireShipGate(q.id)`（已答不碰）；
   其它 question → **新原语** `retireQuestionGuarded(questionId, {expectedFromAgent,
   requireUnanswered: true})`（flywheel-comm db.ts，镜像 retireShipGate 的 WHERE 守卫：
   id + from_agent + 无 response child + 未过期；并发 response 先赢 → 返回 false 不改历史）。
3. **outcome（R2 #4：mutation 返回 false 不等于并发已答——重入/过期 purge 都返回 false，
   必须重读分类）**：
   - question 有 response child → `skipped_answered`；
   - question 仍在但已 resolved / 已 expired → `already_retired`（上一轮 mutation 已成功，
     本轮补 outcome 完成三段式）；
   - question 行已不存在（writable 打开时被 purge）→ `purged_after_retire`（不伪称
     answered）；
   - question 仍 pending 且未改行 → 视作 transient，intent 保留下轮重试。
   审计 `founder_gate_zombie_resolved` 的 issue_id 取 StateStore session；session 不存在
   → 字面 `unknown`，payload 带 questionId/from_agent 供取证。

**分支 Z2（active-but-unreachable，今晚 FLY-1049 形态）**：StateStore session 非终态
（如 awaiting_review）但 CommDB `sessions` 行缺失 → **不 resolve**（gate 是活的）；该
thread 的 founder 消息交给 Part 4 有界重试→dead-letter，且 watchdog 发**专属告警**
`founder-reply-unreachable-runner`（「active session 的 CommDB 注册行丢失，wake 路由断，
需人工 re-register 或关闭」）。重建 CommDB 注册行属另案（out of scope §9）。

kill-switch `FLYWHEEL_ZOMBIE_GATE_RESOLVE`（default ON）只控 Z1 的 mutation；过滤候选集
（resolve 成功后自然消失）不需要额外逻辑。

**QA 预期修正（R1 #6）**：部署后 FLY-977/980/1041 三条走 Z1 解钉；FLY-1049 走 Z2
（dead-letter + unreachable 告警解钉）。四条 thread 全部恢复摄取，但机制不同。

## 6. S5 — codex-hold nudge（R1 #7 ledger 化）

- `reconcileStuckCodexHolds()` 的既有语义（3h 告警 + postThread）不变，追加：claim 成功后
  插两条 ledger 行 `codex_nudge_queue`（重排 /codex-code-review 指令）与
  `codex_nudge_wake`（唤醒 runner 的非授权提示文本）。执行与重试由 §3.3 的 ledger drain
  统一负责（queueCodexInstruction 结果化后 queued=false 会留 pending 续投，R1 #7 的
  「claim 后失败永不重试」消除）。
- 新「nudge 层」：pending 超 `FLYWHEEL_CODEX_HOLD_NUDGE_MS`（default 30min）且未收敛 →
  仅插同样两条 ledger 行（不发 thread/alert；幂等键 `codex-nudge-<exec>-<head>-queue` 与
  `...-wake` 两条独立行，wake 行 `depends_on` 指向 queue 行——R2 #2），比 3h stuck 层早
  再驱动。drain 执行时重验 awaiting_review + head 未漂移（§3.3 资格重验），moved-on →
  cancelled，不投旧 instruction/wake。**范围**：与既有 reconcile 相同，只处理 `awaiting_review` 且 head
  未漂移的 session（terminal / moved-on 的 session 不 nudge 不 wake——它们的 gate 是
  Part 1 的事；此语义写进测试，R1 #7 的不一致澄清）。
- wake 走既有 `wakeRunnerMailbox`（writable CommDB per-project 路径与 deliverer 相同；
  backend 取 unanswered-gate marker 的 transport 字段，与 FLY-123 现行调用点同源）。
  wake 失败留 pending 有界续投，不重复插 queue 指令（两行独立）。

## 7. S6/S7/S8 — 有界重试、watchdog、分类器

### 7.1 有界重试 + dead-letter（S6）

- deliverer 注入 `retryLedger`（StateStore 实现 §3.1 表）。transient 失败（`retry`
  disposition / wake 失败 / handoff 失败 / respond 失败）→ attempts+1 记 stage/error。
- 触发 dead-letter：attempts ≥ `FLYWHEEL_FOUNDER_REPLY_RETRY_MAX`（default 10）或
  first_seen 超 `FLYWHEEL_FOUNDER_REPLY_DEADLETTER_AGE_MS`（default 30min）。
- dead-letter 三段式（R1 #4 + R2 #3 必达）：**一个 StateStore transaction** 内：标
  `dead_lettered_at` + 写审计 `founder_reply_dead_letter`（threadId/msgId/issueId/stage/
  内容截断）+ 插 `emit_alert` 的 action-ledger intent 行。告警投递由 ledger drain 执行：
  只有 LeadAlertNotifier 返回真实 outcome（sent / queued / deadLettered）才标 delivered
  ——notifier 的 `skipped:"duplicate"` **不算送达 receipt**（它只证明 claim 写过，不证明
  POST/queue 发生过；此时按 payload 里带的 episode salt 换新 eventId 重投）。「DB commit
  后、alert 前 crash」与「notifier claim 后、POST 前 crash」两个恢复场景进 §9 测试。
  **非 emit_alert** 的 ledger 行 failed（重试耗尽）→ 在标 failed 的**同一 transaction**
  写 `failed_at_ms` 并插一条 `emit_alert` intent（salt 即 failed_at_ms）；**emit_alert
  自身 failed 绝不再生 emit_alert**（§3.3 的 bounded terminal 是唯一规则，R4 #3——此处
  与 watchdog 都不得把 emit_alert-kind 的 failed 行再当告警输入）。
- **cursor 语义（R1 #1 waterline）**：dead-letter 的消息视作已处置——但
  `advanceableUpTo` 仍遵守既有 `cursorPinned` 规则：若本轮更早的消息因 immature/transient
  钉住了 waterline，dead-letter 消息**不**把 cursor 拽过去；只有它自己是最早未决消息时
  才推进。已 dead-letter 的 msgId 再被扫到 → 直接跳过（视作不匹配）。
- 成功处理 → 删除 retry 行。

### 7.2 watchdog（S7，新 `founder-reply-watchdog.ts`）

数据源（R2 #3：durable 源显式列全）：deliverer 的 `ThreadScanOutcome`（§3.4）+
`founder_reply_retry` 表 + **`founder_action_ledger`（pending 超龄 / failed / emit_alert
intent）** + pass 成功时间戳（内存）。

| 探测器 | 触发 | eventId（R1 #5 + R2 #6：episode salt 进 id，claims.db 永久去重下跨 episode 可再报） |
|--------|------|------------------------------------------------------------------------|
| pass 死亡 | 连续失败 ≥5 或距上次成功 >15min | `founder-reply-pass-dead-<firstFailMs>`（毫秒级/单调 generation，同分钟两 episode 不碰撞） |
| cursor 钉死 | retry 表某行 first_seen 超 10min 未解 | `founder-reply-pin-<threadId>-<msgId>-<firstSeenMs>`（同 msg 因 cursor-save/restart 形成的第二 retry episode 有新 first_seen → 新 id） |
| dead-letter | 每次 dead-letter / **非 emit_alert** ledger 行 failed（emit_alert 自身 failed 从告警输入集合排除——R4 #3 防递归；salt 分别取 durable 的 dead_lettered_ms / failed_at_ms） | `founder-reply-dl-<msgId>-<dlMs>` / `founder-notify-dl-<actionKey>-<failMs>` |
| unreachable runner | Z2 检出 | `founder-reply-unreachable-<execId>-<firstSeenMs>` |

- 内存 episode latch 只负责**同 episode 静音**；恢复（pass 成功 / pin 解除）清 latch，
  下一 episode 新 salt → 新 eventId → 可再报（FLY-220 范式 + R1 #5 修正）。
- **retry 行清理条件（R2 #6）**：不只在 process 成功时删——**只要 processed-through
  waterline 安全跨过该 msg 就删**（含 gate 被实时 reaction/Lead 路径答掉后 matching 变空、
  消息按 irrelevant 前进的情形）。deliverer 在保存 cursor 时把「已跨过的 msgId 区间」
  回调给 retryLedger 清理。测试：failure → 外部答掉 gate → cursor 前进 → retry 行删除、
  watchdog 不误报。
- **pass 级告警 owner（R2 #6）**：pass-dead / notify-dl 这类无 per-thread lead 的全局
  告警，LeadAlertNotifier 对 resolve 不了的 lead 会直接 dead-letter——统一路由到
  **infra owner**（FLY-368/871 的 unified #flywheel-alerts owner 映射，projectName 取
  flywheel、lead 取该项目 alert owner 配置）；per-thread 告警（pin / dl / unreachable）
  用该 thread 所属 (projectName, leadId)。实现时按 notifier 的 routing 合同接线并测
  「无法 resolve 的 lead 不静默丢」。
- **hang 检测位置**：GatePoller interval tick 的**最外层**（`polling` 短路 return 之前）
  做廉价 last-success 时钟检查——正在 hang 的 pass 令 polling 恒 true，恰好被外层观察到
  （零新 timer，R1 #5）。
- 注册面：新增 alert event types 到 `ALERT_EVENT_TYPES`、LeadWatchdog/notifier 的
  title/body map、infra routing/owner map、feature-flag registry read-site——文件清单
  以实现时 notifier 合同为准（R1 #5 点名的编译必需面全覆盖）。
- kill-switch `FLYWHEEL_FOUNDER_REPLY_WATCHDOG`（default ON）。

### 7.3 Tier-3 分类器加固（S8）

1. execFile 改手动 Promise 包装（保留注入 seam），拿到 child 立即 `child.stdin?.end()`
   （消掉 claude CLI 的 3s stdin 等待）。
2. exec 失败（非 ENOENT）等 2s 重试一次；仍失败 → fail-closed 原语义。
3. handler：`tier3_runner_failed` → `{retry:true}`（§3.2）→ 有界重试后 dead-letter；
   模型语义 unclear 照旧（WAKE-only，cursor 前进——语义不清重试不会变清）。

## 8. env flags（全部登记 feature-flags registry）

| flag | default | 作用 |
|------|---------|------|
| `FLYWHEEL_ZOMBIE_GATE_RESOLVE` | ON | Z1 自动 retire（OFF 连 intent 都不写） |
| `FLYWHEEL_HELD_DECLINED_REPLY` | ON | held 明文回复 |
| `FLYWHEEL_DEFERRED_FOUNDER_APPROVAL` | ON | 暂存+补绑 |
| `FLYWHEEL_DEFERRED_APPROVAL_TTL_MS` | 2700000 (45min) | 暂存 TTL |
| `FLYWHEEL_FOUNDER_NOTIFY_RETRY_MAX` | 5 | ledger 投递重试上限 |
| `FLYWHEEL_CODEX_HOLD_NUDGE` | ON | nudge 层开关（R3 #5 新增 enable） |
| `FLYWHEEL_CODEX_HOLD_NUDGE_MS` | 1800000 (30min) | nudge 阈值 |
| `FLYWHEEL_FOUNDER_REPLY_RETRY_MAX` | 10 | 消息重试上限 |
| `FLYWHEEL_FOUNDER_REPLY_DEADLETTER_AGE_MS` | 1800000 (30min) | 消息超龄上限 |
| `FLYWHEEL_FOUNDER_REPLY_WATCHDOG` | ON | watchdog |

**父开关矩阵（R3 #5 —— 与既有 `FLYWHEEL_FOUNDER_REPLY_DELIVER` 的组合语义显式定义）**：

| 组件 | `FLYWHEEL_FOUNDER_REPLY_DELIVER=0`（运营关 ingest）时 |
|------|------------------------------------------------|
| founder-reply 摄取 + 补绑 pass + 暂存 | **暂停**（现状语义：不读 thread、不产生新动作） |
| ledger drain（已提交的 held notice / nudge / feedback_wake / **emit_alert**） | **继续**——must-deliver 动作独立于 ingest 开关，已承诺的告警与通知不因关 ingest 而丢（drain 调用点放在 ingest 条件之外） |
| watchdog | pin/dl 探测继续（durable 表驱动）；**pass-dead 探测静默**——有意关闭 ≠ 故障，不误发（进 §9 测试） |
| nudge 检测（新 intent 产生） | 继续（挂 reconcileStuckCodexHolds 节奏，本就不属于 founder-reply pass） |

**诚实回滚边界（R3 #5，替代原「全关=字节行为」承诺）**：上表行为层 flag 全 OFF =
founder 可见行为回到今日（held 静默 decline、无暂存、无自动 retire、无新告警）；但
**底层加固不 flag**：Tier-3 stdin 关闭与单次重试（纯健壮性修复）、effects 结果化签名、
`tier3_runner_failed` 的 transient 语义（依赖 retry 框架，随 deliverer 新合同走）、
新表 schema。这些不改变 founder 可见行为，不提供字节级回滚。

## 9. 测试计划（TDD：先红后绿）

### 单元（vitest，就地 __tests__）

- **S1 合同**：disposition 四态 × deliverer 消费矩阵；deferred + wake=no_session_lead
  仍前进（R1 #1 点名）；前 immature 后 dead-letter 时 cursor 停在前者之前（waterline，
  R1 #1 点名）；ThreadScanOutcome 各 result。
- **S2**：同 (qid,msgId) 重扫严格 no-op 不刷 TTL；新 msg 替换 = 单 transaction
  invalidate+insert；补绑逐步失败路径（ttl/identity/gate_gone/head_drift/still-held/
  写入结果状态机逐枚举）；**bound postcondition 三连（R2 #1 点名）**：fresh response 写
  成功但 FSM 未翻 → 保持 deferred 不发 ✅；prior 同向 response + 首次 hook 失败 → 重跑
  hook 至 (b) 达成才 consumed；UNIQUE race prior actor 非 founder → gate_gone 不发 ✅。
  实时 handler guard-refusal 不再归 bound（R2 #1）；live ✅-reaction 与 deferred 并发 →
  恰一条 response、无错误 consumed/通知（R1 #3 点名）；kill-switch off 字节兼容。
  **R3/R4 点名补充**：TOCTOU 竞态——fake Tier-3 promise 等待期间翻 codex/QA/head →
  零 response 零 ✅（R3 #2）；fresh reject 完成 =(a')+(b')；prior 同向不同 feedback →
  conflicting_prior_feedback 终态、唯一 response 保持先者、不重复 wake 新内容（R4 #2）；
  live reject 的 decision-aware receipt（✅=decision 已绑、文案区分）；reject 的
  rebound_notice 措辞「已记录，正在通知 runner」不早于 intent commit（R4 #1）。
- **S3**：明文只在 durable upsert 后入 ledger；unclear 绝不发「已存着」；approve/reject/
  merge_block 三种文案分支；**双开关 2×2 真值表逐格（R2 #5，含 OFF/ON 的解释文案）**；
  ledger drain：pending→delivered / 失败续投 / 上限 failed+emit_alert；**因果三连
  （R2 #2 点名）**：queue 失败时 wake 不先完成（depends_on）；drain 前 session/head
  漂移 → cancelled；held 明文多次失败后补绑成功 → 旧行 superseded 不再投。
  **R3/R4 点名补充**：父行 failed/cancelled/superseded → 子 wake 标 cancelled 不永久
  pending（R3 #3）；emit_alert 自身连续失败 → bounded terminal、不增殖新 emit_alert、
  watchdog 不再报（R3 #3 + R4 #3）；feedback_wake kind 走 drain dispatcher 全路径。
- **S4**：Z1/Z2 判定矩阵（`isStateStoreIrreversibleTerminalForZombie` 逐允许值 ×
  CommDB 行有无，含 FLY-1049 形态归 Z2、awaiting_review 永不归 Z1）；**intent 重入
  outcome 分类四态（R2 #4 点名：answered / already_retired / purged_after_retire /
  transient 重试）**；retireQuestionGuarded 并发 response 先赢返回 false 不改历史（R1 #6
  点名）；retireShipGate 已答不碰；kill-switch off 连 intent 都不写。
- **S5**：nudge 只处理 awaiting_review+同 head；两行独立重试 + 依赖序；
  queueCodexInstruction 错误上传不吞；**sink 去重（R3 #3 点名）**：queue 副作用成功后、
  标 delivered 前 crash → 重投被 action_key 稳定 id 去重，不重复排 /codex-code-review。
- **S6**：上限/超龄两种 dead-letter；transaction 原子性（状态+审计+emit_alert intent 同
  生共死）；已 DL 跳过；**crash 恢复两连（R2 #3 点名）**：DB commit 后 alert 前 crash →
  重启后 emit_alert intent 续投；notifier claim 后 POST 前 crash → duplicate 不当
  receipt、换 salt 重投。
- **S7**：episode salt——第一 episode 报→恢复→第二 episode 换 id 可再报（claims.db 永久
  去重模拟，R1 #5 点名）；同 episode 静音；hang 检测在 polling=true 时仍触发；**retry 行
  waterline 清理（R2 #6 点名）**：failure → 外部答掉 → cursor 前进 → 行删、不误报；
  pass 级告警路由 infra owner、resolve 不了的 lead 不静默丢。**R3/R4 点名补充**：fake
  clock 下同一秒两个 retry episode（first_seen_ms 不同）eventId 不撞（R3 #4）；
  `FLYWHEEL_FOUNDER_REPLY_DELIVER=0` 时 drain 继续投已提交动作、pass-dead 静音不误报
  （R3 #5）；emit_alert-kind failed 行不进 dead-letter 探测器（R4 #3）。
- **S8**：stdin 立即关闭；重试一次；ENOENT 不重试；runner_failed→retry 贯通。

### 集成（真 CommDB + 真 StateStore 临时文件 + fake Discord fetch）

1. **今晚场景镜像（硬要求③代码级）**：awaiting_review + codex record pending + ship
   gate → founder "ship" → flags off = held_declined 静默（基线）；flags on = 🕒 + 明文
   ledger + 暂存 → 翻 record approved → 补绑写 `{"approved": true}` → gate 有 child →
   post-write hook 触发 → ✅ 升级。
2. 僵尸场景：Z1 三段式全程 + cursor 解钉 + 后续消息正常；Z2 场景 dead-letter + 专属告警。
3. head 漂移：暂存后 head 更新 → head_drift 明文 + 不写库。
4. tier3 infra 失败：exec 失败 → 钉住 → 第二轮成功绑定；持续失败 → dead-letter + 告警。
5. 反刷屏：同 episode 恰一条告警；跨 episode 可再报。
6. merge_block：不暂存、指路明文、绝不进补绑。
7. **reject 全链（R4 #4 点名）**：held 期间 founder 发修改意见 → 暂存(reject) → hold 清
   → 补绑写完整 feedback response + feedback_wake ledger → drain 投 wake → runner 收到
   全量 feedback；receipt/通知措辞全程与 approve 区分。

### 真机 QA（三段式 QA phase，独立 session，529 Room / test-slot 隔离）

- 硬要求③真 Discord 走一遍：真 thread 发 "ship" → 截图 held 明文回复（🕒）→ 翻 codex
  record approved → 观察补绑 ✅ + verify-approval `"approved": true`。
- 生产部署后观察：FLY-977/980/1041 出现 `founder_gate_zombie_resolved`、FLY-1049 出现
  unreachable 告警 + dead-letter，四条 thread `founder_ship_reply_wake_skipped` 停止刷、
  cursor 推进（§5 QA 预期修正后的口径）。

## 10. 交付与部署

- 单 PR（Q3），含本文件夹 docs；commit 按 S1→S8 分层；全仓 lint + 既有 founder-reply /
  gate-poller / auto-qa / write-gate-response 套件全绿。
- 纯 Bridge 侧 → 生效 = 单次 Bridge 重启（批量重启窗口协调）；不动 Lead / Runner /
  plugin fork。
- 回滚：§8 全 flag 独立可关。

## 11. 明确不做（out of scope）

- Discord Gateway push 化摄取（exploration 方向三）。
- sql.js StateStore 引擎更换（FLY-663 家族）——本 PR 只加可见性。
- narrow_multi 归因增强（FLY-1041 家族续集）。
- Z2 的 CommDB 注册行自动重建（本 PR 只告警 + dead-letter；重建另案）。
- merge_block 恢复流程语义改动（沿用 FLY-869 same-head recovery）。
