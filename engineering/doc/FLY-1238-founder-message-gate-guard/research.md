# FLY-1238 自动消息身份与 gate 守卫 — 调研
Issue: FLY-1238 (https://linear.app/geoforge3d/issue/FLY-1238/bug-founder-facing-自动消息冒用-lead-身份-僵尸-gate-恢复流程对已-merge-pr-发错话-annie)
日期: 2026-07-14
基于: exploration.md

## Summary

调研确认三个修点都不是假设：

1. 事故原话在 **approval-signal/deferred-approval.ts** 中逐字存在，并经
   **founder_action_ledger → GatePoller.postNotice → Lead bot token** 发出。
2. 这条链上没有 GitHub PR state 查询；已有 external merge reconcile 是延迟 backstop，
   不能充当发言前守卫。
3. FLY-1185 已 merge 的统一 closeout 最后只调用 **CommDB.deleteSession**，没有退休
   execution 创建的 pending checkpoint gate；runner death 可以留下可匹配僵尸 gate。

建议实现不新增 timer：复用现有 GatePoller/rebind/drain/lifecycle cadence；新建两个
小而明确的 SSOT：

- **automated-message.ts**：消息 provenance 与统一标识；
- **merged-gate-guard.ts**：fresh PR proof、禁声与幂等 cleanup。

并在 **flywheel-comm CommDB** 增加事务性 **finalizeSession**。

## Evidence: Exact Incident

### Source text

**packages/teamlead/src/bridge/approval-signal/deferred-approval.ts**

- **mergeBlockPointerText()** 返回事故中 Annie 看到的完整过时文案。
- **makeDeferralSupport.queueHeldNotice()** 在 kind=merge_block 时将该文本写入
  FounderActionIntent，kind=held_reply。
- action key 为 **held-reply-{questionId}-{msgId}**，因此跨进程重启仍会被 drain。

### Attribution path

**packages/teamlead/src/bridge/approval-signal/founder-ship-approval-handler.ts**

- 先按 session.status=awaiting_review 且 review_question_id 精确匹配做 narrow。
- **heldState()** 读取 reviewHoldReason。
- merge_block 分支不 defer decision，但调用 queueHeldNotice。
- 该分支不读取 session.pr_number 的 GitHub 状态。

### Delivery path

**packages/teamlead/src/bridge/founder-action-drain.ts**

- NOTICE_KINDS 包含 held_reply、ttl_expired_notice、head_drift_notice、
  rebound_notice。
- **verifyEligibility()** 只对 codex nudge 与 feedback wake 检查 session；
  notice 默认直接通过。
- **executeAction()** 调 deps.postNotice，没有 PR state guard。

**packages/teamlead/src/bridge/gate-poller.ts**

- founderActionDrainPass 的 postNotice 解析 Lead bot token。
- 然后调用 **postDiscordMessageToChannel(threadId, text, token)**。
- 这里既没有消息来源标识，也没有 merged guard。

结论：事故是当前设计的确定性结果，不是偶发模型误判。

## Evidence: Deferred and Recovery Surfaces

| Surface | Current function | Founder-facing effect | Current freshness |
|---|---|---|---|
| merge_block reply | queueHeldNotice | 要求重新批准 | 无 PR query |
| deferral captured | heldReplyText | 声称“我先存着” | 只看 hold |
| deferral TTL | ttlExpiredText | 要求再说一次 | 只看本地 expires_at |
| head drift | headDriftText | 要求新版本确认 | 只比 StateStore head |
| rebound | reboundNoticeText | 声称批准已自动生效 | 只看 gate/session postcondition |
| gate card | maybeEmitFounderThreadFallback | Ship gate 等你批准 | pending question + grace |
| gate head rebind | notifyShipGateRebound | 要求在新消息批准 | 本地 QA/rebind result |
| reaction approval | tryFounderReactionApproval | 写 gate response | 只看 binding/hold/head |

这些 surface 都必须调用同一个 guard；只在 handler 或文案层加判断会被 action ledger
中的历史 intent 绕过。

## Evidence: Existing PR Truth Probe

**packages/teamlead/src/bridge/external-merge-reconcile.ts**

- **checkPrMergeViaGh(projectRoot, prNumber)** 已有 10 秒 bounded gh pr view；本设计为它
  增加可选 timeout 参数，external reconciler 保持 10 秒默认，founder guard 使用 ≤2.5 秒。
- 查询 state、mergedAt、mergeCommit、headRefOid。
- 输出 merged | closed | open | unknown；异常统一 unknown。
- 适合作为 merged guard 的底层 truth probe，避免再造 GitHub parser。

**packages/teamlead/src/bridge/plugin.ts** 另有较老的 **checkPrStateViaGh**，只查
state/mergedAt。实现阶段应让新 guard 复用 richer helper；不应复制第三份查询。

**createExternalMergeReconciler** 不能直接承担本 issue 的同步守卫：

- parked path 默认先等 stale TTL（30 分钟）；
- 按 patrol cadence、每 project 有 gh budget；
- 目标是 post-ship convergence，不是 founder message last-mile；
- founder reply/action drain 可在 sweeper 之前完成 POST。

## Evidence: Gate Retirement Primitives

**packages/flywheel-comm/src/db.ts**

- **retireShipGate(questionId)**：
  - 只处理 checkpoint=approve_to_ship；
  - 只处理未过期；
  - NOT EXISTS response child；
  - 设置 resolved_at/read_at/expires_at=now；
  - 已回答 gate 保留。
- **retireQuestionGuarded(questionId, expectedFromAgent)**：
  - 同样保护未回答历史；
  - 可用于非 ship zombie gate。
- **deleteSession(executionId)**：
  - 只有单条 DELETE sessions；
  - 与 messages 表没有 transaction。

retire predicate 已经证明项目接受“guarded expiration，不删除历史”的做法。
**finalizeSession** 应复用相同 predicate 语义，但以 executionId 批量处理全部 checkpoint
question，并与 session DELETE 包在同一 transaction。

## Evidence: FLY-1185 Coverage Gap

FLY-1185 合并提交：

- commit **1b94701aecc56f4e27af3080e5174f29a266fffd**
- PR #564
- 主题：统一 lifecycle closeout，收 runner/cmux/thread/Linear/worktree/branch。

实际调用链：

1. **lifecycle-closeout.ts::closeoutOneNode** 调 **closeRunner**。
2. closeRunner 确认 tmux already gone 或 kill 成功。
3. 两个 success 分支都调用
   **commdb-session-prune.ts::deleteCommDbSession**。
4. deleteCommDbSession 打开 CommDB，只执行 **db.deleteSession(executionId)**。
5. lifecycle-closeout 只看 closeRes.closed/alreadyGone，将 teardown 标为 done。
6. 所有 node gone 后继续 open PR disposal、thread archive、Linear consistency。

缺失：

- 未退休 messages 表里的 pending checkpoint question；
- 未把 CommDB finalization 成败暴露给 closeRunner/lifecycle；
- deleteCommDbSession 是 best-effort swallow，失败不阻止 archive/Linear；
- boot prune 也直接 deleteSession，会复制同一 gap。

另一个更直接的 runner-death 入口是
**packages/teamlead/src/bridge/commdb-fsm-reconcile.ts**：

- 它专门处理 CommDB status=running、Bridge FSM 已进入 non-preserve terminal 且 tmux
  proven dead 的行；
- 当前成功分支直接调用 **db.deleteSession(executionId)**；
- 这会删除恢复锚点却保留该 execution 的 checkpoint question，能够制造本案同类
  zombie gate。

因此 FLY-1185 目前没有覆盖“issue 完结时原子作废未关 gate”。本 issue 必须补。

## Message Origin Audit

### Shared transport with mixed authorship

**packages/teamlead/src/bridge/discord-utils.ts::postDiscordMessageToChannel**
同时被两类调用者使用：

- 真正 Lead-authored：
  - **lead-backends/codex/leadDiscordSend.ts**
  - **bridge/tools.ts** 的 /api/chat-threads/send
  - **lead-backends/codex/DirectDiscordOutboundSender.ts**：Codex runtime 默认 direct
    outbound
  - **lead-backends/codex/discord-send-core.ts**：Lead action/gateway proactive send
- automation：
  - **gate-poller.ts** founder notice
  - **auto-qa-effects.ts** status/ship/rebind
  - **reports-route.ts** founder report delivery
  - **infra-notify.ts** Annie-facing infra digest

所以共享 helper 不能靠 token 或函数名默认判断作者。origin 必须由调用点显式传入。

### Automated production exits

| Category | Path | Central marking seam |
|---|---|---|
| Recovery ledger | gate-poller.ts | postDiscordMessageToChannel origin=automation |
| Gate cards/reminders | founder-thread-notifier.ts | postFounderThreadCore 的 content |
| Auto QA | auto-qa-effects.ts | shared post/edit helper |
| Root watchdog alert/DM | LeadAlertNotifier.ts | formatContent + overflow formatter |
| Alert repair thread/edit | AlertChannelHub.ts | createDiscordOps postToThread/editMessage |
| Alert wiring details | plugin.ts | 复用 createDiscordOps，随上项覆盖 |
| Issue thread creation/pins | ChatThreadCreator.ts | 每个 generated content POST/PATCH |
| Legacy phase pointer | legacy-phase-thread-sweep.ts | pointer content |
| Runner close-ready | runner-ready-to-close-notifier.ts | body |
| Standup | standup-service.ts | deliver chunk |
| Founder report delivery | reports-route.ts | default postText wrapper origin=automation |
| Infra digest | infra-notify.ts | default postText wrapper origin=automation |
| Publish approval | publish-broker/wire.ts | card post |
| Lifecycle confirmation | lead-backends/codex/gateway/gateway-main.ts | sendConfirmation/editMessage |
| Roundtable seed | roundtable/RoundtableThreadManager.ts | seed content |
| File report | discord-post-file.ts | multipart content |

### Non-message Discord operations

以下不需要 marker：

- typing indicator；
- reaction ACK；
- thread create/archive/member/pin metadata；
- GET/fetch reaction；
- DELETE message。

### Actual-author exclusions

以下明确保持原文：

- Codex Lead 的 outbound send；
- /api/chat-threads/send 中 Lead 提交的 text；
- DirectDiscordOutboundSender 的 Codex Lead direct reply；
- discord-send-core 的 Lead proactive send；
- inbound user/Lead 原文 relay。

inventory test 把这四个 authored exits 固化为小 allowlist。发现机制使用 TypeScript
compiler AST/symbol reference，覆盖 direct call、alias 与
`postText ?? postDiscordMessageToChannel` 等 injected default；raw Discord REST
POST/PATCH 另做排序 snapshot。任何新 production sender 若没有 automation marker 或
lead-authored 声明，测试立即失败，不能只依赖 regex call-expression 扫描。

## Proposed Provenance API

建议在 **packages/teamlead/src/bridge/automated-message.ts** 定义：

    export const AUTOMATED_MESSAGE_PREFIX = "🤖[自动] ";
    export type DiscordMessageOrigin = "lead_authored" | "automation";
    export function markAutomatedDiscordText(text: string): string;

行为：

- 空文本仍返回 marker，避免发送无身份 message；
- 已带 marker 时原样返回；
- marker 始终在最前面，mention/phase tag 跟在其后；
- 不做中文/英文内容推断。

**postDiscordMessageToChannel** 的 options 中 origin 改为必填；先 split 原始文本，再对
每个 chunk 应用 origin。这样每个实际 Discord message 都可独立识别。

edit、multipart 和直接 fetch 使用同一 pure marker；不强迫所有 transport 立刻合并。
reports-route/infra-notify 保持测试注入的三参数 `PostTextFn`，仅默认 wrapper 在调用 shared
helper 时补 `{ origin: "automation" }`，避免无意义扩大 mock API。

## Proposed Merged Guard API

建议在 **packages/teamlead/src/bridge/merged-gate-guard.ts** 定义结构化结果：

    type GuardResult =
      | { kind: "continue"; prState: "open" | "closed" }
      | { kind: "suppress_merged"; cleanupComplete: boolean }
      | { kind: "retry_later"; reason: "backoff" | "budget" | "unknown" }
      | { kind: "terminal_unavailable"; reason: "missing_binding" | "unknown_exhausted" };

输入：

- executionId / questionId / source；
- projectName / projectRoot；
- prNumber；
- StateStore cleanup face；
- CommDB opener；
- checkPrMerge seam。

执行顺序：

1. 验证 prNumber/projectRoot；缺失即 terminal_unavailable，并 durable alert。
2. 查询 shared cache：MERGED 单调缓存；OPEN/CLOSED cache 最长 15 秒。
3. cache miss 时做 per-project 6/min budget + project/PR singleflight；founder guard 使用
   ≤2.5 秒 timeout 的 checkPrMergeViaGh。
4. fresh unknown 记录 durable failure；30s/60s/120s/240s、封顶 5m backoff。未到 probe
   时间或 budget 不足返回 retry_later 且不增加 attempts。
5. 5 次实际 UNKNOWN 或 15 分钟后 terminal_unavailable；排一次稳定 event id 的 routed
   Lead alert，并终止当前自动动作。
6. open/closed 即 continue，并 resolve failure row。
7. merged 即先确定 suppress，并单调缓存。
8. CommDB guarded retire question。
9. StateStore **invalidateMergedGateArtifacts** 单事务：
   - active deferred approval → invalidated(reason=pr_merged)；
   - pending founder action payload.questionId 相同 → superseded/cancelled；
   - 写 merged_gate_suppressed audit（稳定 event id，幂等）。
10. cleanup 任一失败返回 cleanupComplete=false；调用者仍 suppress，下一 cadence 再试。

不能让 cleanup success 成为禁声前提；否则 DB lock 会把已证明过时的话重新放行。

`FLYWHEEL_MERGED_GATE_GUARD=0` 是 default-on guard 的紧急 kill switch：只 bypass network
guard、恢复 legacy workflow，并在 boot/audit 发醒目警告。marker 不受开关控制。

StateStore 增加 `(question_id, source)` guard failure ledger：attempts、first_seen_ms、
next_retry_ms、last_error、terminal、alerted/resolved。只有 fresh UNKNOWN 增加 attempts；
首次 guard invocation 在 cache/budget/backoff 判断前创建 row 并写 first_seen，保证即使
从未拿到 probe budget，15 分钟 deadline 仍会触发。missing binding 立即 terminal。
terminal alert 复用 founder action ledger 的 durable
`emit_alert` intent，收到真实 receipt 后才置 alerted。

## Integration Matrix

| Entry | Guard position | MERGED | UNKNOWN |
|---|---|---|---|
| Text approval | merge_block notice 前；普通信号 classification 后/write 前 | retire + silent null | transient pin；terminal dead-letter + alert |
| Reaction approval | binding narrow 后、writer 前 | retire + no response | transient 不 consume；terminal clear/dead-letter + alert |
| Deferred rebind | 即将生成 TTL/head/rebound 或 write 前 | invalidate silent | transient keep active；terminal invalidate + alert |
| Action drain notice | execute POST 之前 | cancel row, no POST | transient pending；terminal cancel/fail + alert |
| Founder ship card | grace/dedup 后、POST 前 | retire + durable done marker | transient no done；terminal silent + alert |
| Ship-gate rebound | coordinator/effect POST 前 | retire, no new anchor | transient retry；terminal no anchor + alert |

guard 只在 approve/recovery 语义且即将产生副作用时调用，不给 idle scan 或普通 Lead chat
增加 gh 依赖。terminal 后若 binding 被修复，guard 可 resolve ledger 并继续，不写永久
founderNotifyDone marker。

## StateStore Cleanup Transaction

现有可复用方法：

- **invalidateDeferredApproval**：能把单个 deferral invalidated，并原子 supersede
  部分 pending held_reply。
- **cancelFounderAction**：能取消单个 action。

本 issue 需要按 questionId 的聚合方法，避免调用者枚举时出现 race：

    invalidateMergedGateArtifacts({
      executionId,
      questionId,
      prNumber,
      source,
      observedMergeCommitOid
    })

同一 StateStore transaction 内：

- invalidate 对应 active deferral；
- 在 transaction 内枚举 execution 的 pending notice kinds，JSON.parse payload 后用
  questionId 字符串精确比较，再按 exact action_key 设为 superseded；不依赖 sql.js
  引擎假设——StateStore 已运行在 better-sqlite3 且 JSON1 可用；选择 JS-side comparison
  是为了显式可审计。也不使用带通配符歧义的 LIKE；
- 插入幂等 audit event；
- 返回 affected counts。

StateStore 与 CommDB 是两个物理 SQLite DB，不能宣称跨库 ACID。安全由 caller 的
MERGED suppress latch 保证，cleanup 通过重复调用收敛。

## CommDB Transaction Detail

建议方法：

    finalizeSession(executionId): {
      retiredQuestionCount: number;
      deletedSessionCount: number;
    }

transaction SQL 语义：

    UPDATE messages AS q
       SET resolved_at = datetime('now'),
           read_at = COALESCE(read_at, datetime('now')),
           expires_at = datetime('now')
     WHERE q.type = 'question'
       AND q.from_agent = ?
       AND q.checkpoint IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM messages r
          WHERE r.parent_id = q.id AND r.type = 'response'
       );

    DELETE FROM sessions WHERE execution_id = ?;

关键点：

- 不要求 question 当前未过期；所有尚未回答 checkpoint 都被明确收尾。
- 不删 question row，保留审计。
- 普通 runner_questions 的 checkpoint=NULL，不受影响。
- 已有 response child 时不更新，保留真实审批历史。
- transaction throw 原样向上，让 commdb-session-prune 生成结构化失败。

## Lifecycle Propagation

**commdb-session-prune.ts**

- 将 deleteCommDbSession 替换/升级为 **finalizeCommDbSession**；
- live 与 boot prune 都调用同一 CommDB.finalizeSession；
- 不再 swallow 成简单 false，而返回 ok/error/counts。

其余 production teardown 路径同样必须迁移：

- **post-merge.ts**：finalizer error 加入 cleanup errors，阻止后续 closeout 把通讯收尾
  当完成；
- **crash-reaper.ts**：两个删除分支都 await 结构化结果，失败时不 archive/不计完整成功；
- **stale-blocker-guard.ts**：两个删除分支都 fail-closed，保留可重试锚点；
- **actions.ts terminate**：finalize 失败返回 cleanupPending/audit，不伪装完整终止；
- plugin 中注入 callback 的类型从 `void` 改为 structured result，任何调用者都不能丢弃
  error。

**commdb-fsm-reconcile.ts**

- proven-dead + terminal FSM 的清理从 deleteSession 改为 finalizeSession；
- transaction failure 不增加 reconciled，保留 CommDB running row 供下次 pass 重试；
- 这是“runner 非正常死亡后 gate 不残留”的主回归入口。

**close-runner.ts**

- 两个 physical success 分支都调用 finalizer，且顺序必须是：
  physical gone → CommDB finalize → optional thread archive；
- CloseRunnerResult 增加必填 `commDbFinalized: boolean`、retiredGateCount；所有 production
  return 与 test double 都显式填值，非成功路径为 false；
- runner 已死但 finalizer 失败：closed/alreadyGone 仍陈述物理事实，
  commDbFinalized=false 明确陈述通讯收尾未完成；closeRunner 自己的 archive seam 也
  必须跳过。

**lifecycle-closeout.ts**

- NodeClosureReport 增加 communicationsFinalized，confirmedGone 继续只表示物理 liveness；
- teardown done 与 issue-level prerequisite 改为
  confirmedGone AND communicationsFinalized；
- finalizer failure → node teardown failed/partial；
- issue-level PR disposal、archive、Linear 不运行；
- 下一 lifecycle pass 以仍保留的 CommDB session 为锚点重试。

非 lifecycle 的直接 close 仍能返回 physical close 成功，但必须记录/告警 finalizer 失败；
boot prune 是第二恢复路径。

finalization failure 的可见性由 StateStore `commdb_finalize_failures` durable ledger 保证：

- key=executionId，记录 attempts、first/last failure、last_error、alerted/resolved；
- 每个 teardown path 调 `recordCommDbFinalizeOutcome`；boot prune/reconcile 通过 plugin 注入
  同一 recorder；
- 3 次失败或 15 分钟后，既有 Heartbeat/GatePoller cadence 发送一次
  `commdb_finalize_stuck` routed Lead alert；仅真实 receipt 后置 alerted，skipped/失败可重试；
- 成功 resolve ledger；告警后 lifecycle 仍 fail-closed 并继续重试，无新 timer。

## Test Evidence Required

### Provenance

- automation 单 chunk：prefix exactly once；
- automation multi chunk：每个 POST body 都有 prefix；
- automation edit/retry：不重复；
- lead_authored single/multi：字节不变；
- mention 与 phase tag 在 marker 后，allowed_mentions 不变；
- AST/symbol inventory 覆盖 direct/aliased/injected-default shared sender；raw REST snapshot
  覆盖所有 production message POST/PATCH；authored allowlist 恰好四项。

### Merged guard

- open → continue，零 cleanup；
- closed-unmerged → continue；
- transient unknown/backoff/budget → retry_later，零 POST/response/retire；
- missing binding 或 5 次/15 分钟 unknown → terminal_unavailable，当前动作终止、durable
  Lead alert 恰好一次；
- MERGED monotonic cache、OPEN/CLOSED ≤15s cache、6/min budget、singleflight、2.5s timeout；
- `FLYWHEEL_MERGED_GATE_GUARD=0` bypass network guard 但 marker 仍生效，并有 boot warning；
- merged → no POST，retire unanswered gate，cancel notices，audit once；
- cleanup throw →仍 suppress，下次可重试；
- concurrent response 先赢 → response 历史保留。

### Incident regression

夹具：

- session awaiting_review + review_question_id=7be85b5c shape；
- merge_block_reason set；
- PR probe returns merged；
- founder text “批准”；
- pending held_reply 或 queue attempt。

断言：

- mergeBlockPointerText 不被 POST；
- gate 不再 pending；
- response 未写；
- deferred/action artifacts invalidated；
- audit 记录 pr_merged。

同样覆盖 reaction 和已经入 ledger、Bridge restart 后 drain 的情况。

### FLY-1185 regression

- runner/session 有 pending checkpoint gate + 普通 runner question + answered gate；
- close/finalize 后：
  - session gone；
  - pending checkpoint retired；
  - runner question untouched；
  - answered gate untouched。
- SQLite trigger 让 DELETE sessions abort：
  - finalize throws；
  - session 仍在；
  - checkpoint gate 仍是原状态（UPDATE rollback）。
- lifecycle closeout 在 finalize failure 时：
  - node 非 done；
  - archiveThreads=0；
  - linearConsistency=0；
  - 下一 pass 成功后才继续。
- boot prune 对 proven-dead terminal runner 也退休 gate。
- CommDB=running、Bridge FSM=terminal、tmux=dead 的 reconcile 也原子退休 gate；
  transaction failure 时 session 与 gate 都保留。
- closeRunner、post-merge、crash-reaper、stale-blocker、terminate、boot prune、FSM reconcile
  七类入口都消费结构化 finalizer result；失败不 archive/不计完整成功。
- finalizer 连续 3 次或 15 分钟失败时 durable Lead alert；成功后 ledger resolved。

## Verification Commands

实现阶段最小验证集：

    pnpm --filter flywheel-comm test -- src/__tests__/db.fly1238.test.ts
    pnpm --filter flywheel-teamlead test -- src/bridge/__tests__/automated-message.test.ts src/bridge/__tests__/automated-message-inventory.test.ts
    pnpm --filter flywheel-teamlead test -- src/lead-backends/codex/__tests__/DirectDiscordOutboundSender.test.ts src/lead-backends/codex/__tests__/discord-send-core.test.ts
    pnpm --filter flywheel-teamlead test -- src/__tests__/reports-route.test.ts src/bridge/__tests__/infra-notify.test.ts
    pnpm --filter flywheel-teamlead test -- src/bridge/__tests__/merged-gate-guard.test.ts src/bridge/__tests__/external-merge-reconcile.test.ts
    pnpm --filter flywheel-teamlead test -- src/__tests__/StateStore.fly1238-merged-gate.test.ts
    pnpm --filter flywheel-teamlead test -- src/bridge/__tests__/founder-ship-approval-handler.test.ts
    pnpm --filter flywheel-teamlead test -- src/bridge/__tests__/founder-reaction-approval-handler.test.ts
    pnpm --filter flywheel-teamlead test -- src/bridge/__tests__/founder-action-drain.test.ts
    pnpm --filter flywheel-teamlead test -- src/bridge/__tests__/deferred-approval.test.ts
    pnpm --filter flywheel-teamlead test -- src/bridge/__tests__/auto-qa-effects.test.ts
    pnpm --filter flywheel-teamlead test -- src/__tests__/commdb-session-prune.test.ts
    pnpm --filter flywheel-teamlead test -- src/__tests__/commdb-fsm-reconcile.test.ts
    pnpm --filter flywheel-teamlead test -- src/__tests__/close-runner.test.ts
    pnpm --filter flywheel-teamlead test -- src/bridge/__tests__/lifecycle-closeout.test.ts
    pnpm --filter flywheel-teamlead test -- src/__tests__/post-merge.test.ts src/__tests__/crash-reaper.test.ts src/bridge/__tests__/stale-blocker-guard.test.ts src/__tests__/actions.terminate.test.ts
    pnpm --filter flywheel-comm typecheck
    pnpm --filter flywheel-teamlead typecheck

实现者应先确认每个新增 regression 在改生产代码前 RED，再做最小 GREEN，最后 refactor。

## Open Questions Resolved

- **UNKNOWN 是否发提示？** 不发。Lead 已批准 fail-silent + retry。
- **UNKNOWN 是否可无限 retry？** 不可。5 次实际 probe 或 15 分钟 terminal，并 durable
  alert；missing binding 立即 terminal。
- **marker 是否由 token 决定？** 否。Lead 已批准 automation-origin。
- **FLY-1185 是否已覆盖 gate？** 否，代码路径证明只删 session。
- **跨两 DB 是否原子？** 不宣称。CommDB gate+session 原子；StateStore cleanup 单独原子，
  跨库由 suppress latch + 幂等 cadence 收敛。
- **是否在本 design 阶段写 code？** 否。

## Approved Direction

Brainstorm gate **9979da9f-3b4d-4d4d-aa4c-347617b76570** verdict：

> APPROVED——三件套确认：automation-origin formatter/sender 出口层收口；
> last-mile PR 守卫；1185 清理升级为事务。

plan.md 按该结论拆成 RED → GREEN → REFACTOR 的执行任务。
