# FLY-1238 自动消息身份与 gate 守卫 — 探索
Issue: FLY-1238 (https://linear.app/geoforge3d/issue/FLY-1238/bug-founder-facing-自动消息冒用-lead-身份-僵尸-gate-恢复流程对已-merge-pr-发错话-annie)
日期: 2026-07-14
基于: 无

## Context

2026-07-14 03:02:59，FLY-1224 已经 merge（92430e45a）后，Annie 在 issue thread
说“批准”。Founder reply ingest 把这句话配到 QA runner 2ed82858 留下的僵尸 gate
7be85b5c；该 session 带 merge_block，系统随后用 Lead bot 身份发出：

> 这个 PR 之前被合并挡下了(merge block),走的是另一条恢复流程——需要你对当前
> head 重新批准(恢复流程会把新的确认发给你),这条消息我没法直接绑。

这段话不是 Lead 写的，但在 Annie 视角和 Lead 本人消息完全同源。事故同时暴露三条
独立失守：

1. **Identity**：发送 token 被错误地当成作者身份；自动流程借用了 Lead 的人格。
2. **Freshness**：恢复文案只看本地 gate/session 状态，没有在发言前确认 PR 的真实状态。
3. **Lifecycle**：runner 已死以后，CommDB session 与它创建的未回答 checkpoint gate
   没有作为一个生命周期单元收尾。

这不是措辞问题，而是 authority 与 provenance 边界问题。修复必须让消息来源、
外部事实和 gate 生命周期都变成机器可验证的契约。

## Goals

- 所有非 Lead 亲笔、且可能出现在 founder 视野中的 Discord 文本，以统一的
  **🤖[自动] ** 开头；多 chunk 消息的每一个 Discord message 都带标识。
- 真正的 Lead outbound 保持原样，不能因为共用 bot token 被误打机器标。
- 任何 gate 恢复、重绑、重新批准或延迟通知在发送前 fresh 查询绑定 PR；证明
  **MERGED** 时禁声并作废 gate 及其待发动作。
- PR 状态无法确认时 fail-silent：bounded retry 期间不发、不改写事实；missing binding
  或重试耗尽后终止当前自动动作并给 Lead durable alert，不无限挂住 founder input。
- runner/session 收尾时，未回答 checkpoint gate 的作废与 CommDB session 删除在
  同一 SQLite transaction 中完成；事务失败则两者都保留、上层重试。
- 用回归测试证明：runner 死亡后不存在还能被 founder reply 恢复匹配的 gate。

## Non-goals

- 不改变 Lead 的人格、语气或实际人工回复文本。
- 不重做 FLY-1198 的自然语言审批识别，也不展开 FLY-1211 的完整审批 PRD。
- 不把 GitHub 查询结果当成 ship authority；本修复只用 MERGED 事实来抑制过时发言
  和清理僵尸 gate。
- 不在本 issue 中统一所有 Discord SDK/REST transport；只建立明确的消息来源契约，
  并迁移现有自动文本出口。
- 不试图跨 StateStore 与 CommDB 做不可能的单库 ACID transaction。CommDB 内的
  gate+session 收尾必须原子；跨库 artifact 清理靠“先禁声、再幂等收敛”保证安全。

## Constraints

- **Founder trust first**：不确定时宁可延迟一条自动提醒，也不能冒发一条假装是 Lead
  的过时事实。
- **Semantic origin, not token origin**：同一个 token 同时承载 Lead 亲笔和系统自动话，
  所以不能在 token resolver 或最底层 HTTP client 无条件加前缀。
- **History preserving**：已有 response 的 gate 是审批历史，不能被 cleanup 改写；
  只退休仍未回答的 checkpoint question。
- **Fresh external fact**：本地 merge_block、session status 或 landing marker 都不足以
  证明 PR 当前状态；副作用前使用 ≤15 秒 freshness 的 bounded gh pr view/cache，
  MERGED proof 单调。
- **No new timer**：守卫嵌入现有 GatePoller、deferred rebind、action drain 与 lifecycle
  cadence。
- **Design phase only**：本阶段只交付探索、调研和 TDD 实施计划，不写实现代码。

## Current Incident Path

当前事故路径可以还原为：

1. FLY-1224 已 merge，但 QA runner 自触发重启后死亡。
2. CommDB 里 approve_to_ship question 仍是 pending；StateStore 仍有能关联该 question
   的 session/review binding。
3. Founder reply deliverer 读取 Annie 的“批准”，进入
   **tryFounderShipApproval**。
4. **reviewHoldReason** 返回 merge_block。
5. **makeDeferralSupport.queueHeldNotice** 生成 held_reply action，文本来自
   **mergeBlockPointerText**。
6. **drainFounderActionLedger** 不检查 PR，GatePoller 的 postNotice 用 Lead bot token
   直接发到 founder thread。

任何只改第 5 步文案的方案都不能阻止同类事故：TTL、head drift、rebound、ship-gate
rebind 或旧 gate card 都可能在 PR 已 merge 后继续说话。

## Approach Options

### Option A — Token-level global prefix

在 Discord bot token resolver 或原始 POST helper 上无条件加 🤖[自动]。

优点：

- 改动集中，漏标概率看起来低。

缺点：

- **错误**：Lead 的实际回复也使用同一 token，会被标成机器话。
- 无法表达“谁生成内容”，只表达“谁负责发送”。
- 某些路径直接 fetch，仍会绕开共享 helper。

结论：拒绝。它会以另一种方式继续破坏 Annie 对身份的判断。

### Option B — 文案函数逐条手写前缀

在 heldReplyText、gate card、watchdog 文案等 formatter 里各自拼前缀。

优点：

- 单点改动小，容易先修事故文本。

缺点：

- 新出口默认不安全，靠 code review 记忆防漏。
- split 后只有第一 chunk 可能带标识。
- edit/repost 路径容易重复或丢失前缀。
- 无法自动证明 Lead 亲笔路径没有被误标。

结论：只可作为局部实现手段，不能作为系统契约。

### Option C — Typed semantic origin + inventory contract（推荐）

建立一个纯 provenance primitive：

- **DiscordMessageOrigin = lead_authored | automation**
- **AUTOMATED_MESSAGE_PREFIX = "🤖[自动] "**
- **markAutomatedDiscordText** 幂等地加前缀。
- 共享 post helper 要求调用者显式传 origin，并在 split 后对每个 chunk 应用标识。
- 自动 edit、multipart、特殊 mention、直接 fetch 路径在各自发送边界调用同一 primitive。
- 一份 source inventory contract test 扫描所有生产 Discord message POST/PATCH；
  每个出口必须显式归类为 automation 或少数 allowlisted lead_authored。

优点：

- 来源由内容生产者声明，不由 token 猜测。
- 新出口漏分类会在测试中失败。
- Lead 亲笔路径成为显式、可审计的例外。
- 可以统一处理 chunk、edit 和 idempotence。

代价：

- 需要迁移多个直接 REST 出口；改动面比单点文案大。

结论：采用。P0 的本质是建立 provenance contract，而不是修一条话。

## Merged Guard Options

### Option A — 只守 mergeBlockPointerText

在 queueHeldNotice 前查 PR。

问题：已经排队的 action、TTL/head-drift/rebound、reaction approval、旧 ship card 和
ship-gate rebind 仍可越过检查。只能修复一次症状。

### Option B — 依赖 external-merge-reconcile sweeper

复用现有 FLY-945 sweeper，等它把 merged session 收敛。

问题：该 sweeper 是 30 分钟 stale TTL + patrol cadence 的 backstop；founder reply 与
action drain 可以先到。它不是 last-mile safety barrier。

### Option C — Shared last-mile guard（推荐）

新增 **merged-gate-guard.ts**，把 fresh PR 查询、禁声判定和幂等 cleanup 组合成统一
接口，并接到每个恢复/重批出口：

- text approval 与 reaction approval 写 gate 前；
- deferred rebind 产生 TTL/head-drift/rebound notice 或写 response 前；
- founder action ledger 真正 POST notice 前；
- approve_to_ship founder card 真正 POST 前；
- ship-gate rebound follow-up 真正 POST 前。

状态表：

| PR result | 当前行为 |
|---|---|
| MERGED | 当前调用立即 suppress；guarded retire 未回答 gate；invalidate deferred/actions；写 audit；不发 Discord |
| OPEN | 继续既有流程 |
| CLOSED 未 merge | 继续既有拒绝/人工处理语义，本 issue 不扩大规则 |
| UNKNOWN | 当前调用 fail-silent；按 bounded backoff 重试，不生成事实性文案 |
| 无有效绑定 / UNKNOWN 耗尽 | 终止当前自动动作并生成一次 durable Lead alert；仍不向 founder 发状态话术 |

“发言前 fresh 查”定义为可度量的 **≤15 秒 freshness SLA**，而不是每个 3 秒 tick 都起
子进程。shared guard 按 project+PR 做 single-flight，并采用：MERGED 单调缓存、
OPEN/CLOSED 最长 15 秒 TTL、UNKNOWN 30s/60s/120s/240s 后封顶 5 分钟 backoff，
每 project 最多 6 次 fresh gh probe/分钟。founder last-mile probe 的 subprocess timeout
≤2.5 秒；既有 external reconciliation 保持 10 秒默认。guard 只在即将产生恢复副作用时
调用，避免 idle scan 触发查询风暴。

UNKNOWN 不是无限等待状态。StateStore 维护 `(questionId, source)` durable failure ledger；
第一次 guard invocation 在 cache/budget/backoff 判断前写 first_seen；只有真正执行的
fresh UNKNOWN probe 增加 attempts。达到 5 次实际 UNKNOWN 或 15 分钟
wall clock 后进入 terminal_unavailable；缺 binding 立即 terminal_unavailable。terminal
会取消/终止当前自动动作，并幂等排入一次 routed Lead alert，避免 founder action 永久
pending 且无人知情。OPEN/CLOSED/MERGED 会 resolve failure row。

## Zombie Gate Options

### Option A — 假设 FLY-1185 已覆盖

代码事实否定该假设。FLY-1185 合并提交 1b94701ae 的 closeout 会杀 runner、归档 thread、
同步 Linear 等；但 **deleteCommDbSession** 只调用 **CommDB.deleteSession**，从不退休
该 execution 创建的 checkpoint question。

### Option B — 先退休 gate，再单独删除 session

两个独立 write 之间 crash 会留下半完成状态：

- gate 已退、session 留下；或
- session 已删、gate 留下——正是本次僵尸形态。

结论：拒绝。

### Option C — CommDB finalizeSession transaction（推荐）

在 CommDB 增加一个 transaction：

1. guarded UPDATE execution 创建的全部未回答 checkpoint question：
   resolved_at/read_at/expires_at = now；
2. DELETE 同 execution 的 sessions row；
3. 返回 retired question count 与 deleted session count。

where 条件必须同时满足：

- type = question；
- from_agent = executionId；
- checkpoint IS NOT NULL；
- 不存在 response child。

已有回答的历史和 checkpoint=NULL 的普通 runner question 均保留。SQLite 任一步失败会
rollback，保证 gate 与 session 不出现半收尾。

所有 runner teardown 类别——closeRunner、post-merge、crash reaper、stale-blocker、
terminate action、terminal-session boot prune，以及 **commdb-fsm-reconcile.ts** 的
“CommDB 仍 running、Bridge FSM 已 terminal”清理——都改用该 transaction。后者正是
runner 死亡而未正常 close 的恢复入口，不能继续直接 deleteSession。任何注入 callback
都返回结构化结果，不允许 `void` 吞掉事务失败。closeRunner 把 **commDbFinalized**
作为结构化结果上报；FLY-1185 lifecycle-closeout 只有在 runner 确认已死且 CommDB
finalize 成功后，才把 node 当作 teardown done 并继续 archive/Linear。若事务失败，
issue closeout 保持 partial/blocked，下一轮重试。

finalization failure 也不能静默无限重试。StateStore 增加 durable failure ledger：所有
teardown path 记录成功/失败；3 次失败或 15 分钟后通过既有 Heartbeat/GatePoller cadence
排一次 `commdb_finalize_stuck` routed Lead alert，真实 receipt 后才置 alerted。告警后仍
fail-closed 并继续重试；成功后 resolve ledger。

## Proposed Design

### 1. Message provenance boundary

共享 helper 负责：

- origin 必填；
- automation 在 split 后逐 chunk 加前缀；
- mark 函数幂等，已有前缀不重复；
- edit 与特殊 transport 复用同一 marker；
- allowed_mentions 与 reply reference 行为不变。

明确保留为 **lead_authored** 的路径只有四个：

- packages/teamlead/src/lead-backends/codex/leadDiscordSend.ts
- packages/teamlead/src/bridge/tools.ts 的 /api/chat-threads/send
- packages/teamlead/src/lead-backends/codex/DirectDiscordOutboundSender.ts
- packages/teamlead/src/lead-backends/codex/discord-send-core.ts

其余 Bridge 生成的文本均为 automation。若未来新增真实人工出口，必须在 inventory
测试中附理由显式登记。inventory 不能只 grep call expression；用 TypeScript compiler
AST/symbol reference 找 direct call、别名与 `postText ?? postDiscordMessageToChannel` 等
injected default，再用 raw REST endpoint snapshot 覆盖直接 fetch。

### 2. Merged guard safety boundary

guard 收到 executionId、questionId、projectName、projectRoot、prNumber 与 source：

1. 在即将产生恢复副作用前，经 shared cache/budget bounded 调用
   **checkPrMergeViaGh**；founder guard timeout ≤2.5 秒；
2. UNKNOWN 返回 retry_later，不发消息、不声称状态；按 durable ledger 有限重试；
3. OPEN/CLOSED 返回 continue；
4. MERGED 先确定 suppress（cleanup 失败也不能放行发言）；
5. CommDB guarded retire 未回答 gate；
6. StateStore 单事务 invalidate 对应 active deferred row，事务内读取候选 action、
   JSON.parse payload 后按 questionId 精确匹配并 supersede/cancel pending notice，
   同时写 **merged_gate_suppressed** audit。StateStore 的 better-sqlite3 可用 JSON1，但这里
   选择显式 JS-side 精确比较以便审计；禁止模糊 LIKE；
7. missing binding 或 UNKNOWN budget/time 耗尽返回 terminal_unavailable，终止当前自动
   动作并 durable alert；
8. 任一 cleanup 失败只影响收敛状态，下一 pass 重试；绝不把已证明 merged 的消息放行。

merged guard 默认启用；`FLYWHEEL_MERGED_GATE_GUARD=0` 是唯一紧急 bypass，只跳过
network guard 并在 boot/audit 发出醒目警告。P0 marker 永远不受该开关控制，因此即使
临时退回 legacy 行为，自动话也不会继续冒充 Lead。

CommDB 与 StateStore 无法共享 ACID transaction，所以安全性质定义为：

> MERGED proof 一旦得到，本次发言无条件禁声；每个 store 内 cleanup 原子且幂等，
> 跨 store 由现有 cadence 最终收敛。

### 3. Lifecycle finalization boundary

**CommDB.finalizeSession** 是 runner 通讯生命周期的唯一终点。旧
**deleteSession** 可以保留给低层测试/迁移，但所有 production teardown 路径不再直接
调用它：live close、post-merge、crash reaper、stale-blocker、terminate action、boot
prune 与 CommDB↔FSM reconcile 都必须使用结构化 finalizer。

closeRunner 的结果扩展为：

- closed/alreadyGone：物理 runner 结果；
- commDbFinalized：必填 boolean，通讯记录是否原子收尾；
- retiredGateCount：审计信息；
- error：失败原因。

finalize 必须在物理 runner 已确认消失后、任何 closeRunner 内 thread archive 之前运行；
失败时 direct close 也不得先 archive。FLY-1185 的 NodeClosureReport 增加
**communicationsFinalized**，不把它混入 confirmedGone（后者继续只陈述物理事实）。
node 只有两项都成功才是 teardown done：

- physicalGone = true；
- communicationsFinalized/commDbFinalized = true。

这样 runner 已死但 CommDB 暂时锁住时不会让 issue-level archive/Linear 抢跑，也不会
删除 session 后遗留可被恢复流程读取的 gate。

## Automated Exit Inventory

P0 inventoried surfaces（均应标 automation）：

| Surface | Production path | Message class |
|---|---|---|
| Gate/recovery notices | gate-poller.ts + founder-action-drain.ts | held/TTL/head-drift/rebound |
| Founder gate cards | founder-thread-notifier.ts | brainstorm / approve_to_ship / stuck / milestone |
| QA and rebound | auto-qa-effects.ts | QA status, phase line, ship ready, head rebind |
| Watchdog/alerts | LeadAlertNotifier.ts + AlertChannelHub.ts + plugin.ts alert posts | root alert, DM, repair, recovery, overflow |
| Thread lifecycle | ChatThreadCreator.ts + legacy-phase-thread-sweep.ts | root, reuse pointer, attach pin, migration pointer |
| Runner lifecycle | runner-ready-to-close-notifier.ts | close-ready notice |
| Scheduled report | standup-service.ts | daily standup |
| Founder report delivery | reports-route.ts | generated report content |
| Infra digest | infra-notify.ts | Annie-facing automatic digest |
| Privileged approval | publish-broker/wire.ts + gateway-main.ts | publish/lifecycle confirmation cards |
| Coordination seed | roundtable/RoundtableThreadManager.ts | generated topic seed |
| Report attachment | discord-post-file.ts | Bridge-generated artifact delivery |

Excluded from marker:

| Surface | Path | Reason |
|---|---|---|
| Codex Lead outbound | lead-backends/codex/leadDiscordSend.ts | model/Lead 本轮实际回复 |
| Lead chat-thread send API | bridge/tools.ts | Lead 显式提交的人工/agent-authored text |
| Direct Codex outbound | lead-backends/codex/DirectDiscordOutboundSender.ts | Codex Lead 默认 direct reply |
| Proactive Lead send | lead-backends/codex/discord-send-core.ts | Lead action/gateway 主动发言 |
| Reactions / typing / thread metadata | founder-ack.ts, discord-utils.ts, thread utils | 没有 founder-facing 文本 |
| Relayed user/Lead original text | inbound/roundtable relay paths | 内容作者不是 Bridge 自动流程，不应篡改原文 |

## Invariants

1. **Identity invariant**：任一自动 Discord message 的 content[0..] =
   “🤖[自动] ”；任一 lead_authored send 不被自动改写。
2. **Chunk invariant**：自动长消息的每个实际 POST chunk 都带一次前缀。
3. **Merged silence invariant**：fresh PR state = MERGED 后，任何恢复/重批路径的
   Discord POST count = 0。
4. **History invariant**：已有 response 的 gate 永不被 retire/finalize 改写。
5. **Atomic CommDB invariant**：finalizeSession 结束后只可能是：
   - session gone + all unanswered checkpoint gates retired；或
   - session present + gates unchanged。
6. **Lifecycle invariant**：FLY-1185 只有在 physicalGone ∧ commDbFinalized 时继续
   issue-level archive/Linear。
7. **Uncertainty invariant**：GitHub UNKNOWN 不能产生任何“需要重批”“已恢复”或
   “已合并”等事实性 founder 文案；也不能无限静默重试，耗尽后必须 terminal + Lead
   alert。
8. **Bounded-query invariant**：founder guard 的 open/closed freshness ≤15 秒、subprocess
   timeout ≤2.5 秒、每 project fresh probe ≤6/min；MERGED proof 单调缓存。
9. **Visible-finalization invariant**：CommDB finalization 连续 3 次失败或持续 15 分钟
   必须有 durable routed alert，同时 lifecycle 继续 fail-closed。

## Risks and Mitigations

- **Prefix 破坏 mention/echo parsing**：标识放在 content 最前，allowed_mentions 白名单
  不变；LeadWatchdog 当前 echo anchor 非行首匹配。加 formatter 与 echo regression。
- **gh transient 导致 gate card 延迟**：按 durable backoff 有限重试；真实 UNKNOWN 达到
  5 次或 15 分钟后终止该自动动作并告警，不允许无限 pending。
- **3 秒 poller 触发 gh 风暴**：15 秒 cache、singleflight、6/min project budget 与 2.5 秒
  timeout 共同限流；只在副作用前调用。
- **cleanup 与 response race**：CommDB retire 使用“不存在 response child”的 guarded
  UPDATE；真实 response 先赢时保留历史，guard 仍因 MERGED 禁声并交给 reconcile。
- **遗漏 injected default/direct fetch**：TypeScript AST/symbol inventory 覆盖 helper 的
  direct/aliased/default references；raw REST snapshot 单独覆盖 production POST/PATCH。
- **事务失败后 runner 已物理死亡**：保留 CommDB session 作为可重试锚点；所有 teardown
  path 调同一 finalizer，并由 durable ledger 在 3 次/15 分钟后告警。
- **重复前缀**：marker 幂等；edit/retry/requeue 不会叠加。

## Acceptance

- Annie 能仅凭消息开头区分机器话与 Lead 本人话。
- 以已 merge PR + pending zombie gate 构造事故夹具时，text 与 reaction 均不绑定、
  不发任何恢复文案，gate 自动退休。
- 已排队的 held_reply 即使跨重启恢复，drain last-mile 仍在 POST 前抑制。
- runner teardown 成功后，CommDB 查询不到其 session，也查询不到它创建的未回答
  checkpoint gate。
- 人为让 session DELETE 抛错时，gate UPDATE 一并 rollback，lifecycle 不 archive、
  不写 Linear Done，并在下一 pass 可恢复；若持续失败，会产生一次可确认的 Lead alert。
- 缺 binding 或持续 GitHub UNKNOWN 不会无限挂住 founder action；bounded 终止后有 routed
  Lead alert，且 founder-facing 自动错误话术仍为 0。

## Decision

Lead 在 brainstorm gate **9979da9f-3b4d-4d4d-aa4c-347617b76570** 明确批准 Option C
三件套：semantic-origin sender、last-mile merged guard、CommDB transactional
finalize。后续 plan 以此为不可降级的设计基线。
