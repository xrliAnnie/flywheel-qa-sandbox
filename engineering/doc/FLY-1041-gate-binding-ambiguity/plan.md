# FLY-1041 Founder 批准绑定故障 — 实施计划

Issue: FLY-1041 (https://linear.app/geoforge3d/issue/FLY-1041/founder-approval-binding-glitch-thread-reply-wont-bind-to-gate-under)
日期: 2026-07-08
基于: research.md

## 0. 目标与不变量

**目标**:founder 一个动作(短语 / 回复 gate 卡 / 点 ✅)可靠绑定到唯一的 ship gate,且绑没绑上有即时可见回执;re-fire 不再留下可绑的僵尸 gate;runner 汇报不再污染绑定候选集。

**硬不变量(Lead brainstorm gate 加固点,违反任意一条 = 设计失败)**:

1. `verify-approval.ts` / `respond.ts` FLY-175 拒写 / `write-gate-response.ts` 的 expectedCurrentReviewQuestionId 校验 / WorkflowFSM 边集 —— **一个字节不动**。所有新通道只影响「founder 意图认到哪个 gate」,批准效力仍走 verify-approval 全链(founder 归因 + pr_head_sha + codex hard gate)。
2. retire 只 expire 不删行(审计事件持久在 session_events);**绝不误杀当前活跃 gate**(主路径只 retire rebind 前快照的确切旧 qid;sweeper 严格 created_at 晚于比较、同秒不动)。
3. reply-to-card / ✅ / tier2 归一化不新增任何绕过 verify-approval 的批准路径。
4. 全部新行为默认 ON + 独立 env kill-switch;kill-switch 置 0 时字节兼容现状。

**范围外**:FLY-1035(FSM terminal 复活)、Discord button/组件、非 ship checkpoint 的通知节奏、classifier retry 机制。

## 1. 交付物总览

| Chunk | Fix | 内容 | 主要文件 |
|---|---|---|---|
| 1 | A | retire-on-rebind(主路径) | event-route.ts, db.ts(flywheel-comm) |
| 2 | A | superseded-gate sweeper(兜底) | gate-poller.ts |
| 3 | C | tier2 语气前缀归一化 | tier2-allowlist.ts |
| 4 | C | 归因全链审计事件 | founder-ship-approval-handler.ts, text-approval-source.ts, founder-reply-deliverer.ts |
| 5 | B | 归因与 review-hold 对齐(held 不写批准) | founder-ship-approval-factory.ts, plugin.ts |
| 6 | B | ship gate 卡转正(15s 级 grace) | gate-poller.ts, founder-thread-notifier.ts |
| 7 | B | reply-to-card 确定性绑定 + tier3 上下文 | founder-reply-deliverer.ts, founder-ship-approval-handler.ts, founder-ship-approval-classifier.ts, plugin.ts |
| 8 | C | founder 回执 reaction(✅/❓) | founder-reply-deliverer.ts(或新 founder-ack.ts), plugin.ts |
| 9 | D | `ask --report` + 候选集排除 + 协议文本 | ask.ts, db.ts, index.ts(flywheel-comm), gate-poller.ts, Blueprint.ts |
| 10 | — | 回归矩阵收口 + lint + 全仓测试 | __tests__/* |

依赖序:1→2(共享判据常量);3、4 独立可先行;5 依赖 4(held_declined 审计);6 独立;7 依赖 4、6(卡绑定 + 审计);8 依赖 4(outcome 判定);9 独立;10 最后。建议实现顺序即表序。

## 2. Env 开关一览(全部默认 ON,`=0` 关闭回字节兼容)

| 开关 | 覆盖 | 关闭后行为 |
|---|---|---|
| `FLYWHEEL_SHIP_GATE_RETIRE` | Chunk 1+2 | 不 retire、不 sweep(现状) |
| `FLYWHEEL_SHIP_GATE_CARD` | Chunk 6 | 卡回到 10min 兜底 grace(现状) |
| `FLYWHEEL_REPLY_TO_CARD` | Chunk 7 | 忽略 message_reference(现状) |
| `FLYWHEEL_FOUNDER_APPROVAL_ACK` | Chunk 8 | 不点回执(现状) |
| `FLYWHEEL_ATTRIBUTION_HOLD_ALIGN` | Chunk 5(text + reaction + voice 全部写入源共用一个开关) | held 期间仍可写批准(现状) |
| `FLYWHEEL_TIER2_PREFIX_NORM` | Chunk 3 | 不剥离语气前缀,「嗯ship」降级 Tier-3(现状;Codex R1 #2:确定性批准语义扩张必须有独立回滚) |
| (无开关) | Chunk 4 审计、Chunk 9 `--report` | 纯加法:审计只写事件;`--report` 不传 = 现状 |

读取方式沿用项目惯例:`process.env.X !== "0"`(GatePoller/factory 内 per-call 读,免重启翻转)。

## 3. 分块设计(TDD:每块先写失败测试)

### Chunk 1 — retire-on-rebind(Fix A 主路径)

**CommDB 新助手**(`packages/flywheel-comm/src/db.ts`):

```ts
/** FLY-1041: retire a superseded approve_to_ship gate — expire NOW (drops out
 * of getPendingQuestions), keep the row for forensics until prune. */
retireShipGate(questionId: string): boolean {
  // resolveGate(qid, 0) 语义,但收窄到 approve_to_ship 且无 response,防误伤:
  // UPDATE messages SET resolved_at=datetime('now'), read_at=COALESCE(...),
  //   expires_at=datetime('now')
  // WHERE id=? AND type='question' AND checkpoint='approve_to_ship'
  //   AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.parent_id=messages.id AND r.type='response')
  // 返回 changes>0。
}
```

关键点:WHERE 带 `checkpoint='approve_to_ship'` + 无 response 双保险 —— 已答复的 gate(合法批准)永远不会被 retire 改写。

**event-route.ts 挂点**(`handleSessionCompleted` 内,两个 rebind 分支共用):

- 位置:`writeReviewBinding()` 成功路径之后(isReReview 的非 protectedBinding 分支 + FLY-945 Fix C approved_to_ship→awaiting_review 后的 applyTransition 成功分支)。
- 快照:`const supersededQid = existingSession?.review_question_id`(rebind **前**读取,event-route.ts:850 的 pre-transition snapshot 已有)。
- 条件:`retireEnabled() && supersededQid && supersededQid !== REVIEW_BINDING_UNBOUND && reviewQuestionId && supersededQid !== reviewQuestionId`。
- 动作:`commDbPathForProject(...)` 开写连接 → `db.retireShipGate(supersededQid)` → 成功则 `store.insertEvent({event_id: "ship-gate-superseded-<supersededQid>", event_type: "ship_gate_superseded", payload: {supersededQid, newQid: reviewQuestionId, by: "event-route"}})`;失败只 `console.warn`(R2:sweeper 幂等补刀)。
- 顺序:先 rebind(权威,已有代码)后 retire —— 崩在中间 = 旧 gate 多活一会儿,sweeper 收。

**测试(先红)**:`event-route` 测试套加:
1. re-review 携新 qid → 旧 qid 被 retire(CommDB pending 里消失)+ `ship_gate_superseded` 事件落档;
2. 同 qid 重发(dual-sink 去重)→ 不 retire;
3. qid-less 完成(protectedBinding)→ 不 retire;
4. `FLYWHEEL_SHIP_GATE_RETIRE=0` → 不 retire(字节兼容 sentinel);
5. retire 抛错 → 完成流程不受影响(warn 后继续)。

### Chunk 2 — superseded-gate sweeper(Fix A 兜底)

**gate-poller.ts**,relay 循环内(既有 eviction 机制旁,`question.checkpoint != null` 分支):

- 判据函数(纯函数,便于单测):

```ts
export function isSupersededShipGate(q: {id, checkpoint, created_at},
  session: {review_question_id?}, boundQuestion: {created_at} | undefined): boolean {
  return q.checkpoint === "approve_to_ship"
    && !!session.review_question_id
    && session.review_question_id !== "unbound"
    && session.review_question_id !== q.id
    && !!boundQuestion
    && parseSqliteUtcMs(boundQuestion.created_at)! > parseSqliteUtcMs(q.created_at)!; // 严格晚于;同秒/解析失败 → false
}
```

- 命中 → 复用 Chunk 1 的 `retireShipGate` + 同款审计事件(`by: "gate-poller-sweeper"`,event_id 同前缀 → insertEvent UNIQUE 天然去重)+ 本 tick `continue`(不 relay、不发卡)。
- boundQuestion 读取:同一 CommDB 只读连接 `getMessageById(session.review_question_id)`(relay 循环已持有 dbPath)。
- 零新 timer(内联既有循环,项目惯例)。
- **接受的保守 tradeoff(Codex R1 #5,写入代码注释)**:sweeper 是保守兜底,不是完备保证 —— 同秒 re-fire 且主路径 retire 失败的交叠场景下,旧 gate 会 pending 到 TTL(安全侧:宁可多噪音,绝不误杀)。主路径(Chunk 1)按确切 qid retire,不受同秒影响,覆盖正常 re-fire 全部场景。**禁止**把判据放宽到 `>=`。

**测试**:判据表驱动(同秒不 retire / 绑定行缺失不 retire / 新 gate 未 rebind 窗口不 retire / 正常 supersede retire / created_at 解析失败不 retire);集成:pending 两个 ship gate + session 绑新 → 旧被 sweep + 不再 relay。

### Chunk 3 — tier2 语气前缀归一化(Fix C)

**tier2-allowlist.ts**:

```ts
/** 纯语气前缀(仅小写归一后整 token / CJK 粘连前缀剥离)。 */
export const TIER2_AFFIRMATION_PREFIXES: readonly string[] =
  ["嗯嗯", "嗯", "好的", "好", "哦", "行", "okk", "ok", "yes"];
```

`matchTier2Approval` 增可选参数 `opts?: { prefixNorm?: boolean }`(纯模块不读 env;调用方 `evaluateTextSource` per-call 读 `FLYWHEEL_TIER2_PREFIX_NORM !== "0"` 传入 —— Codex R1 #2:确定性批准语义扩张必须有独立 kill-switch,关闭即字节兼容现状)。顺序敏感:

1. 结构复杂度检查(不动,在最前);
2. deny token 检查(不动,剥离**前**跑一遍);
3. 新增(prefixNorm 时):循环剥离前导语气前缀(每次剥一个、按最长优先;CJK 无空格粘连也剥,如 "嗯ship"→"ship"、"好 ship"→"ship");
4. deny token 检查**再跑一遍**(剥离后残句可能暴露 hedge);
5. 引用校验 + 整句 allowlist(不动)。

**测试(表驱动追加)**:`嗯ship`→approve;`嗯嗯 可以`→approve;`好ship`→approve;`嗯 先别ship`→downgrade(deny);`嗯?ship`→downgrade(结构);`okk`(剥完为空)→downgrade;`嗯ship FLY-999`(错引用)→downgrade;**`FLYWHEEL_TIER2_PREFIX_NORM=0` 时 `嗯ship`→downgrade(reverse-compat sentinel)**;既有全部用例不回归。

### Chunk 4 — 归因全链审计(Fix C 观测底座)

- `evaluateTextSource` 返回值扩展:`ApprovalSignal` 增可选 `evidence: {stage, reason?}`(tier2_approve / tier2_downgrade→tier3_* / tier3_runner_failed(带 runner reason));classifier 的 `{ok:false, reason}` 不再折叠丢弃,上浮到 evidence。类型为加法,既有消费者不破。
- `founder-ship-approval-handler`:新增可选 dep `auditSink?: (eventType, payload) => void`;在 narrowing(narrow_zero / narrow_multi,含各 gate 的 status/binding 快照)、信号评估(用上条 evidence)、写入结果(written/refused)各落一条 `founder_ship_attribution` 事件。
- `founder-reply-deliverer` / plugin.ts 组合根:把 `audit(store, ctx, execId, ...)` 包装成 auditSink 传入(deliverer 已有 audit helper;factory 透传)。
- 事件形态见 research.md §3.6;event_id 含 msgId+stage 保证幂等。

**测试**:handler 单测断言每条路径(narrow 0/1/N、tier2 命中、tier3 各 verdict、runner_failed)落对应事件;deliverer 集成测事件写到 store。

### Chunk 5 — 归因与 review-hold 对齐(Fix B 一致性;Codex R1 #1 Critical:覆盖**全部** founder 批准写入源)

审计发现能调用 `writeGateResponseAndRunPostWrite` 写 `{approved:true}` 的 founder 侧入口有 **3 个**:文本归因(founder-ship-approval-handler)、✅ reaction(founder-reaction-approval-handler,gate-poller.ts:2411-2488 的 reaction pass 无 hold 检查)、voice 批准(voice-routes.ts:419-431)。hold 对齐必须三处同覆盖,否则 text 挡住了、✅/voice 仍可推进 held session(与 `isReviewHeld` 的 merge_block「所有 founder surface 全 hold」契约冲突)。

- **共享守卫**(放 `auto-qa-held.ts`,不动 write-gate-response.ts 红线):

```ts
/** FLY-1041: shared pre-write hold guard for EVERY founder approval source. */
export function founderApprovalHoldGuard(
  store: AutoQaHeldStore & CodexGateStore,
  session: QaHeldSession | undefined,
  env = process.env,
): boolean {  // true = decline (held)
  if (env.FLYWHEEL_ATTRIBUTION_HOLD_ALIGN === "0") return false;
  return isReviewHeld(store, session, env);
}
```

- **3 个调用点**(各自在评估/写入前调用,拒绝时落 `held_declined` 审计 + 各自的现状 fallback):
  1. `founder-ship-approval-handler`:A-2 收窄得唯一 gate 后、评估信号**前** → decline 时 return null(WAKE-only;Chunk 8 点 ❓)。**明确语义(Codex R2 注记 3,刻意保守)**:held 期间 founder 文本的 approve **和 reject/feedback 都**不落 response、统一 WAKE-only,直到 hold 解除 —— 测试钉住这一点;
  2. `founder-reaction-approval-handler` **内部**(Codex R2 注记 2:守卫放在「reaction source 检测到 founder ✅ 之后、写 response 之前」,不放 gate-poller 预调用侧 —— 否则无 ✅ 也会刷 held_declined 噪音):✅ 命中且 held → 不写、审计;**测试:held + 无 ✅ → 零 held_declined 事件;held + ✅ → 恰一条 held_declined 且无 response**;
  3. `voice-routes.ts` 批准分支:held → 拒绝写入、返回明确错误文案(voice 通道自身回执)。
- `plugin.ts` 组合根:统一注入 `isHeld = (id) => founderApprovalHoldGuard(store, store.getSession(id))`。
- 效果:codex/QA 未绿时 founder 批准不再被任何通道静默写入(910 的 05:47:41 翻转即此类);text/reply 通道她收 ❓ + 卡文案解释,hold 释放后卡重新到位(Chunk 6)。
- 单一 kill-switch `FLYWHEEL_ATTRIBUTION_HOLD_ALIGN=0` 整组回现状(Codex R1 #1 建议)。

**测试**(×3 写入源 ×3 hold 形态 = 矩阵):held(codex pending / QA running / merge_block)+ founder 批准(text、✅、voice)→ 全部不写 response、落 held_declined;un-held → 三源照常写入;kill-switch=0 → held 也写入(现状 sentinel)。

### Chunk 6 — ship gate 卡转正(Fix B 载体及时性)

- `gate-poller.ts maybeEmitFounderThreadFallback`:grace 按 checkpoint 分流 —— `approve_to_ship` 用新 `shipGateCardGraceMs()`(env `FLYWHEEL_SHIP_GATE_CARD_GRACE_MS` > config > 默认 15_000;`FLYWHEEL_SHIP_GATE_CARD=0` 时回 10min 现状),`brainstorm` 维持 `founderThreadGraceMs()` 不动。
- hold 语义不动:relay 循环的 `isReviewHeld` skip 在 fallback 之前,held 期间照旧不发卡;hold 释放后的第一个 tick 自动发卡(现有循环结构,零新 timer)。
- `founder-thread-notifier` approve_to_ship 文案追加一行:「直接**回复这条消息**或点 ✅ 即批准;其它回复不会被当成批准。批准绑定后我会在你的消息上点 ✅ 确认。」
- 既有 durable 去重 marker / retry 预算 / gateMessageId 绑定(A-0b)全部复用不动。

**测试**:un-held ship gate 15s 后即发卡(brainstorm 仍 10min);held 不发;`FLYWHEEL_SHIP_GATE_CARD=0` 回 10min;卡文案 fixture 断言含指引句。

### Chunk 7 — reply-to-card 确定性绑定(Fix B 核心)

- `founder-reply-deliverer.ts`:`RawDiscordMessage` 增可选 `type?: number` 与 `message_reference?: { type?: number; message_id?: string; channel_id?: string }`(批量 GET 返回已含,research §2.3)。
- **Reply 判定(Codex R1 #3:必须区分真 Discord reply 与其它 reference 形态)**:仅当 `msg.type === 19`(REPLY)且 `message_reference.type` 为 0/缺省(DEFAULT,排除 forward 等)且 `message_reference.channel_id === ctx.threadId` 时才视为 reply-to-card 候选 —— pin/crosspost/forward 携带的 reference 一律走现状路径。
- `processFounderMessage` ship 分支前:若 `replyToCardEnabled && 上述 reply 判定通过`,对每个 matching ship gate 用注入的 `readCurrentBinding(executionId, questionId, session.pr_head_sha)`(复用 ✅ reaction 的 reader,plugin.ts 已有装配形态)查 current binding;`binding.gateMessageId === message_reference.message_id` 命中者 → **只对该 gate** 走归因(shipGates 收窄为 [命中 gate],A-2 收窄自然通过),并给 tier3 传 `replyToCard: true`。
- `founder-ship-approval-classifier.buildPrompt`:输入增可选 `replyToCard?: boolean`,为真时 prompt 增一行:"This message is a DIRECT Discord reply to the ship-approval card for this exact gate — treat short affirmations (ok / okk / 嗯 / 好) as approval of THIS gate unless hedged or negative."(reject/unclear 规则不放松)。
- 命中卡但文本判 reject → 照现有 reject 路径写 feedback;判 unclear → WAKE-only + Chunk 8 ❓。
- 对**非 ship** question 的 reply-to-card:不做(卡只为 ship gate 存在)。
- `message_reference` 指向非卡消息(如引用别人聊天)→ 无 binding 命中 → 完全走现状路径(字节兼容)。

**测试**:reply-to-card + "okk" → tier3 收到 replyToCard 上下文(mock classifier 断言 prompt)→ approve → response 写入;reply 指向无关消息 → 现状路径;binding 缺失/head 不匹配 → 现状路径;**负向(Codex R1 #3)**:`type !== 19` 但 reference.message_id 恰好等于卡 id(forward 形态)→ 现状路径;`reference.channel_id` ≠ thread → 现状路径;kill-switch=0 → 忽略 reference。

### Chunk 8 — founder 回执 reaction(Fix C,Annie 痛点核心)

- 新模块 `packages/teamlead/src/bridge/approval-signal/founder-ack.ts`:

```ts
export async function reactToFounderMessage(args: {
  botToken, channelId /* thread id */, messageId,
  emoji: "✅" | "❓", fetchImpl?, }): Promise<{ok: boolean; status?: number}>
// PUT /channels/{cid}/messages/{mid}/reactions/{encodeURIComponent(emoji)}/@me, 5s timeout
```

- 触发点(`processFounderMessage` ship 分支收尾,单一决策位,保证每条 founder 消息至多一个回执):
  - 归因写入成功(approve 或 reject 落了 response)→ ✅;
  - ship gate 在 matching 中但结局是 unclear / runner_failed / held_declined / narrow_multi → ❓;
  - matching 无 ship gate → 不回执(闲聊零打扰)。
- 幂等:session_events 标记 `founder-ack-<msgId>`(insertEvent UNIQUE);PUT 失败 → `founder_ack_failed` 审计,best-effort 不阻断、不重试(下条消息自然重新走流程)。
- 权限:bot 需 ADD_REACTIONS;QA 步骤含真机验证,若权限缺失 → `founder_ack_failed(status=403)` 可观测,功能其余部分不受影响。
- kill-switch `FLYWHEEL_FOUNDER_APPROVAL_ACK=0`。

**测试**:approve→✅、unclear→❓、无 ship gate→无调用、PUT 403→审计+不抛、幂等标记防重、kill-switch。

### Chunk 9 — `ask --report`(Fix D 降噪)

- `db.ts`:幂等 `ALTER TABLE messages ADD COLUMN kind TEXT`(沿 L148 先例吞 duplicate column);`insertQuestion(from, to, content, opts?)` 增 `opts.kind?: "report"`。
- `types.ts`(Codex R1 #4:补上类型面):`Message` 与 `PendingQuestion` 均加 `kind?: string | null`(getPendingQuestions 返回整行,漏了会逼出 any cast)。
- `ask.ts` + `index.ts` CLI:`--report` flag → kind='report';返回值/marker 行为不变(Bridge `runner_question` relay 事件照发 —— Lead 仍收到汇报)。
- **排除范围明确声明(Codex R1 #4)**:`kind='report'` **只**从 founder 回复候选集(`gate-poller.ts founderReplyDeliverPass` 组装 thread questions 时 `if (q.kind === "report") continue;`)排除;`relayToLead`、lead-pending nudge(checkpoint==='question' 才触发,汇报无 checkpoint)、`pending` CLI、liveness/stuck 巡检等一切 pending-question 语义**刻意不变** —— 汇报在传输层仍是 question,只是 founder 永远不会被绑到它上。
- `Blueprint.ts:1344` LEAD REPORT-BACK 文本:DONE 汇报命令加 `--report`(同 PR 落地;旧 dist + 旧提示词自洽,同 FLY-217 生效模型:merge + 生产 git pull)。
- 旧数据:存量无 kind 的 DONE questions 不受影响(72h 自然过期);不做回填。

**测试**:ask --report 落 kind;deliverer 排除 report(founder 消息不再绑到它/不再计入 ambiguous 分母);GatePoller 仍 relay report 给 Lead;无 flag 行为字节不变;并发迁移吞错。

### Chunk 10 — 回归矩阵收口(Lead 加固点 3)

Lead 点名的 5 类,映射到测试(①-④ 在各 chunk 已建,此处集成串联 + 补负向):

| # | 场景 | 测试 |
|---|---|---|
| ① | re-fire → 旧 gate retire → 单一干净 gate → 绑上 | event-route + deliverer 集成:两次 needs_review 后 founder "ship" → 只有新 qid 有 response |
| ② | "嗯ship" 语气前缀 → tier2 确定性命中 | tier2 表驱动(Chunk 3) |
| ③ | reply-to-card → 绑上 | Chunk 7 集成 |
| ④ | --report 汇报 → 排除出候选集 | Chunk 9 集成 |
| ⑤ 负向 | 非 founder id 发 approve → 拒(handler 身份闸 + evaluateTextSource 身份闸,既有测试保持绿);旧批准对新 head → verify-approval `pr_head_sha_mismatch` 照旧(verify-approval 既有测试全绿 = 未动的直接证据);retire 绝不动已答复 gate(Chunk 1 WHERE 双保险测试);sweeper 同秒/窗口期不误杀(Chunk 2);held session 下 text/✅/voice 三源批准全被拒 + 审计(Chunk 5 矩阵);forward 形态 reference 不当 reply(Chunk 7) | 各处 |

收口:`pnpm lint` 全仓 + 受影响包全测 + reverse-compat sentinel(所有 kill-switch=0 时关键路径行为与 main 一致的对照测试,项目惯例)。

## 4. 真机 QA 方案(Lead 加固点 4,529 Room)

独立 QA session(不是本 runner 自验),529 Room 真 Discord:

1. **场景 A(核心复现)**:真 runner 走到 approve_to_ship gate → 模拟 re-fire(第二次 gate + complete --route needs_review)→ 断言 comm.db 旧 gate 立即出 pending + `ship_gate_superseded` 事件 → founder(测试号,QA room 的 canonicalFounderId)thread 里发「嗯ship」→ 绑上(response 落新 qid)+ 她消息被点 ✅ → `verify-approval` 对新 head 返回 approved:true(QA room codex gate 按其 .env 配置)。
2. **场景 B(卡 + 回复卡 + ✅)**:un-held gate 15s 内出卡 → 分别验证 (a) 回复卡「okk」绑上、(b) 点卡 ✅ 绑上;held(伪造 codex record pending)→ 不出卡、founder「ship」→ 不写批准 + ❓ 回执 + held_declined 审计,**且点 ✅ 同样不写批准**(Chunk 5 全源覆盖)。
3. **场景 C(降噪)**:runner 发 3 条 `ask --report` 汇报 + 1 个 ship gate → founder 短语批准 → 直接绑 gate,零 `founder_reply_ambiguous`。
4. **场景 D(非法路径照拦)**:非 founder 账号发「ship」→ 无 response、无 ✅;head 漂移后旧批准 → verify-approval mismatch 拒。
5. 证据按项目 QA 惯例留全(pane 抓屏 + DB 快照 + 事件账本),QA 报告绑 PR head。

## 5. 文件级改动清单

| 文件 | 改动 |
|---|---|
| `packages/flywheel-comm/src/db.ts` | `kind` 列迁移;`insertQuestion` opts.kind;`retireShipGate()` |
| `packages/flywheel-comm/src/types.ts` | `Message` / `PendingQuestion` 加 `kind?`(Codex R1 #4) |
| `packages/flywheel-comm/src/commands/ask.ts` + `src/index.ts` | `--report` flag |
| `packages/teamlead/src/bridge/event-route.ts` | rebind 后 retire 旧 gate + 审计 |
| `packages/teamlead/src/bridge/gate-poller.ts` | sweeper(relay 循环内);ship 卡 grace 分流;deliver pass 排除 report |
| `packages/teamlead/src/bridge/founder-reply-deliverer.ts` | message_reference 字段;reply-to-card 收窄;回执触发点;report 排除(类型层) |
| `packages/teamlead/src/bridge/approval-signal/tier2-allowlist.ts` | 语气前缀归一化 |
| `packages/teamlead/src/bridge/approval-signal/text-approval-source.ts` | evidence 上浮(stage/reason) |
| `packages/teamlead/src/bridge/approval-signal/founder-ship-approval-handler.ts` | auditSink;isHeld 对齐;reply-to-card 单 gate 收窄入参 |
| `packages/teamlead/src/bridge/approval-signal/founder-ship-approval-factory.ts` | isHeld / auditSink 透传;hold-align kill-switch |
| `packages/teamlead/src/bridge/approval-signal/founder-reaction-approval-handler.ts`(或其 gate-poller 调用侧) | ✅ 路径接共享 hold 守卫(Codex R1 #1) |
| `packages/teamlead/src/bridge/voice-routes.ts` | voice 批准分支接共享 hold 守卫(Codex R1 #1) |
| `packages/teamlead/src/bridge/auto-qa-held.ts` | `founderApprovalHoldGuard()` 共享守卫 |
| `packages/teamlead/src/bridge/approval-signal/founder-ship-approval-classifier.ts` | replyToCard prompt 上下文 |
| `packages/teamlead/src/bridge/approval-signal/founder-ack.ts`(新) | 回执 PUT |
| `packages/teamlead/src/bridge/founder-thread-notifier.ts` | 卡文案指引句 |
| `packages/teamlead/src/bridge/plugin.ts` | 组合根装配(isHeld、auditSink、readCurrentBinding 复用、ack 依赖) |
| `packages/edge-worker/src/Blueprint.ts` | REPORT-BACK 文本加 `--report` |
| 各对应 `__tests__` | Chunk 1-10 测试 |

**不动**:`verify-approval.ts`、`respond.ts`、`write-gate-response.ts`(hold 守卫放调用侧,不进这个红线文件)、`workflow-fsm.ts`、`DirectEventSink.ts`(rebind 不经它,R4 契约)。

## 6. 部署与回滚

- Bridge 侧改动(teamlead 包)需 **一次 Bridge 重启**生效 —— 按惯例与其它待 ship PR 攒批(feedback_coordinate_bridge_restarts / 多 PR 一次重启)。
- flywheel-comm CLI + Blueprint 文本:merge + 生产 `git pull` 即对新 spawn 的 runner 生效(FLY-217 同型),已在跑的 runner 用旧提示词+旧 CLI 自洽。
- 回滚:任一子行为可用对应 kill-switch 即时关闭(免重启,per-call 读 env);整体回滚 = revert PR + Bridge 重启。
- `kind` 列迁移只加列,回滚后旧代码忽略该列,无破坏。

## 7. 风险对照(research §4 → 计划位置)

R1→Chunk 1 WHERE 双保险 + Chunk 2 判据 + kill-switch;R2→先 rebind 后 retire + sweeper 幂等;R3→只动 approve_to_ship + 去重 marker;R4→held_declined ❓ 回执可观测(hold 卡死本体归 FLY-863/827);R5→前后双 deny 检查 + 表驱动;R6→吞 duplicate column 先例;R7→回执语义写进卡文案。

## 8. 验收标准(implement 阶段完成定义)

1. Chunk 1-10 全绿(新测试 + 既有套件 + `pnpm lint` 全仓);
2. reverse-compat sentinel:全部 kill-switch=0 → 与 main 行为一致;
3. `verify-approval.ts` / `respond.ts` / `write-gate-response.ts` / `workflow-fsm.ts` diff 为零(CI 可 grep 断言);
4. Codex code review APPROVED;
5. 独立真机 QA(§4 场景 A-D)FINAL PASS;
6. founder 视角验收口径:re-fire 过的 issue 上,一句「嗯ship」→ ≤90s 内她的消息被点 ✅ 且 verify-approval 通过。
