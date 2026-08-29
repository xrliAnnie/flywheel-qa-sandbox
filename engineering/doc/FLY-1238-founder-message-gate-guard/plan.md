# FLY-1238 自动消息身份与 gate 守卫 — 实施计划
Issue: FLY-1238 (https://linear.app/geoforge3d/issue/FLY-1238/bug-founder-facing-自动消息冒用-lead-身份-僵尸-gate-恢复流程对已-merge-pr-发错话-annie)
日期: 2026-07-14
基于: research.md

## Objective

在不改变 Lead 真正 outbound 文本、不改变 ship authority 的前提下，完成三项交付：

1. 自动 founder-facing Discord 文本统一带 **🤖[自动] **，且每个出口显式声明
   semantic origin。
2. gate 恢复/重批路径在发言或写 response 前 fresh 查询 PR；MERGED 时禁声并清理，
   UNKNOWN 时 fail-silent bounded 重试，耗尽后终止自动动作并 durable alert。
3. runner teardown 将未回答 checkpoint gate 作废与 CommDB session 删除合并为一个
   SQLite transaction，并让 FLY-1185 closeout 对事务失败 fail-closed。

实现必须按 RED → GREEN → REFACTOR 推进。禁止先改生产代码再补测试。

## Scope

### New files

- packages/teamlead/src/bridge/automated-message.ts
- packages/teamlead/src/bridge/merged-gate-guard.ts
- packages/teamlead/src/bridge/__tests__/automated-message.test.ts
- packages/teamlead/src/bridge/__tests__/automated-message-inventory.test.ts
- packages/teamlead/src/bridge/__tests__/merged-gate-guard.test.ts
- packages/flywheel-comm/src/__tests__/db.fly1238.test.ts

### Modified files: provenance

- packages/teamlead/src/bridge/discord-utils.ts
- packages/teamlead/src/bridge/gate-poller.ts
- packages/teamlead/src/bridge/auto-qa-effects.ts
- packages/teamlead/src/bridge/founder-thread-notifier.ts
- packages/teamlead/src/LeadAlertNotifier.ts
- packages/teamlead/src/bridge/AlertChannelHub.ts
- packages/teamlead/src/bridge/ChatThreadCreator.ts
- packages/teamlead/src/bridge/legacy-phase-thread-sweep.ts
- packages/teamlead/src/bridge/runner-ready-to-close-notifier.ts
- packages/teamlead/src/bridge/standup-service.ts
- packages/teamlead/src/bridge/reports-route.ts
- packages/teamlead/src/bridge/infra-notify.ts
- packages/teamlead/src/bridge/publish-broker/wire.ts
- packages/teamlead/src/lead-backends/codex/gateway/gateway-main.ts
- packages/teamlead/src/bridge/roundtable/RoundtableThreadManager.ts
- packages/teamlead/src/bridge/discord-post-file.ts
- packages/teamlead/src/lead-backends/codex/leadDiscordSend.ts
- packages/teamlead/src/lead-backends/codex/DirectDiscordOutboundSender.ts
- packages/teamlead/src/lead-backends/codex/discord-send-core.ts
- packages/teamlead/src/bridge/tools.ts

### Modified files: merged guard

- packages/teamlead/src/StateStore.ts
- packages/teamlead/src/bridge/approval-signal/founder-ship-approval-handler.ts
- packages/teamlead/src/bridge/approval-signal/founder-reaction-approval-handler.ts
- packages/teamlead/src/bridge/approval-signal/deferred-approval.ts
- packages/teamlead/src/bridge/founder-action-drain.ts
- packages/teamlead/src/bridge/gate-poller.ts
- packages/teamlead/src/bridge/auto-qa-effects.ts
- packages/teamlead/src/bridge/external-merge-reconcile.ts
- packages/teamlead/src/bridge/plugin.ts

### Modified files: lifecycle finalization

- packages/flywheel-comm/src/db.ts
- packages/teamlead/src/bridge/commdb-session-prune.ts
- packages/teamlead/src/bridge/commdb-fsm-reconcile.ts
- packages/teamlead/src/bridge/close-runner.ts
- packages/teamlead/src/bridge/lifecycle-closeout.ts
- packages/teamlead/src/bridge/post-merge.ts
- packages/teamlead/src/bridge/crash-reaper.ts
- packages/teamlead/src/bridge/stale-blocker-guard.ts
- packages/teamlead/src/bridge/actions.ts
- packages/teamlead/src/StateStore.ts
- packages/teamlead/src/LeadAlertNotifier.ts
- packages/teamlead/src/bridge/kind-contract.ts

相关既有测试文件按以下任务逐项扩展。

## Safety Contracts

实现过程中以下断言不可降级：

1. automation marker 在每个实际 Discord message 的最前面且只出现一次。
2. lead_authored 文本字节不变；不能用 bot token 推断 origin。
3. MERGED proof 一旦得到，本次调用无条件禁止 POST/response write，即使 cleanup 失败。
4. UNKNOWN 不发事实性提示、不退休 gate、不 consume founder input。
   重试必须 bounded，terminal 后当前动作退出并 durable alert。
5. retire/finalize 永不覆盖已有 response。
6. CommDB finalize 事务只允许“gate+session 全完成”或“全部 rollback”。
7. FLY-1185 issue-level archive/Linear 必须等待 physicalGone 和 commDbFinalized 同时成立。
8. `commDbFinalized` 是 required boolean；任何 undefined 都是类型错误，不是隐式失败。
9. merged guard 的 marker 永远启用；network guard 只有显式 kill switch 可 bypass。

## Task 1 — RED: Message provenance primitive

### Files

- Create: packages/teamlead/src/bridge/__tests__/automated-message.test.ts
- Create: packages/teamlead/src/bridge/automated-message.ts
- Modify: packages/teamlead/src/bridge/discord-utils.ts
- Modify: packages/teamlead/src/bridge/__tests__/discord-utils.test.ts

### Step 1.1 — Write failing pure marker tests

测试精确断言：

- markAutomatedDiscordText("hello") === "🤖[自动] hello"
- 已有前缀输入不重复；
- 空字符串得到 "🤖[自动] "；
- mention 与 phase tag 输入仍排在 marker 后。

运行：

    pnpm --filter flywheel-teamlead test -- src/bridge/__tests__/automated-message.test.ts

Expected RED：模块/导出不存在。

### Step 1.2 — Write failing shared transport tests

在 discord-utils.test.ts 增加：

- PostDiscordOptions.origin 为 automation 时，单 chunk body 加前缀；
- 超长文本拆成两 chunk 时，两次 POST content 都以 marker 开头；
- origin=lead_authored 时 content 与现状字节相同；
- replyTo 仍只在第一 chunk；
- allowed_mentions 仍为 parse:[]。

Expected RED：origin contract/marker 行为不存在。

### Step 1.3 — Minimal implementation

在 automated-message.ts 增加：

    export const AUTOMATED_MESSAGE_PREFIX = "🤖[自动] ";
    export type DiscordMessageOrigin = "lead_authored" | "automation";
    export function markAutomatedDiscordText(text: string): string;

在 discord-utils.ts：

- PostDiscordOptions.origin 改为必填；
- 先 split 原始 text；
- 每个 chunk POST 前按 origin 调 marker；
- buildRemainingText 与错误 envelope 继续基于最终 chunk list；
- edit helper 增加显式 origin options，automation 时应用 marker。

### Step 1.4 — GREEN and refactor

运行两个测试文件，确认 RED 用例 GREEN。marker 保持纯函数，不引入 Discord 或 env 依赖。

### Step 1.5 — Commit checkpoint

    git add packages/teamlead/src/bridge/automated-message.ts packages/teamlead/src/bridge/discord-utils.ts packages/teamlead/src/bridge/__tests__/automated-message.test.ts packages/teamlead/src/bridge/__tests__/discord-utils.test.ts
    git commit -m "feat(FLY-1238): add explicit Discord message provenance"

## Task 2 — RED: Protect real Lead-authored sends and core founder automation

### Files

- Modify: packages/teamlead/src/lead-backends/codex/leadDiscordSend.ts
- Modify: packages/teamlead/src/lead-backends/codex/DirectDiscordOutboundSender.ts
- Modify: packages/teamlead/src/lead-backends/codex/discord-send-core.ts
- Modify: packages/teamlead/src/bridge/tools.ts
- Modify: packages/teamlead/src/bridge/gate-poller.ts
- Modify: packages/teamlead/src/bridge/auto-qa-effects.ts
- Modify: packages/teamlead/src/bridge/founder-thread-notifier.ts
- Modify tests:
  - packages/teamlead/src/lead-backends/codex/__tests__/leadDiscordSend.test.ts
  - packages/teamlead/src/lead-backends/codex/__tests__/DirectDiscordOutboundSender.test.ts
  - packages/teamlead/src/lead-backends/codex/__tests__/discord-send-core.test.ts
  - packages/teamlead/src/bridge/__tests__/chat-thread-routes.test.ts
  - packages/teamlead/src/bridge/__tests__/auto-qa-effects.test.ts
  - packages/teamlead/src/bridge/__tests__/founder-thread-notifier.test.ts
  - packages/teamlead/src/bridge/__tests__/gate-poller-founder-reply.test.ts

### Step 2.1 — RED: Authored path preservation

为四个真实 authored exit 增加 body assertion：leadDiscordSend、
DirectDiscordOutboundSender、discord-send-core 与 /api/chat-threads/send：

- text 不带 🤖[自动]；
- long message 每 chunk 都保持 authored 原文；
- 四个调用点必须显式传 origin=lead_authored。

### Step 2.2 — RED: Core automated surfaces

新增/扩展 tests：

- founder action held_reply POST 以 marker 开头；
- QA broadcast、phase status POST/PATCH、ship-ready、gate rebound 均有 marker；
- founder brainstorm/ship gate card content 以 marker 开头；
- edit 后不会双 marker。

### Step 2.3 — Minimal migration

- leadDiscordSend.ts、DirectDiscordOutboundSender.ts、discord-send-core.ts、tools.ts：传
  origin=lead_authored。
- gate-poller.ts、auto-qa-effects.ts：传 origin=automation。
- founder-thread-notifier.ts：在统一 postFounderThreadCore 发送边界使用 marker，
  不在每个文案 formatter 重复拼接。

### Step 2.4 — GREEN

运行上述测试。确认四个 Lead authored exits bytes 未变，自动消息标识统一。

### Step 2.5 — Commit checkpoint

    git add packages/teamlead/src/lead-backends/codex/leadDiscordSend.ts packages/teamlead/src/lead-backends/codex/DirectDiscordOutboundSender.ts packages/teamlead/src/lead-backends/codex/discord-send-core.ts packages/teamlead/src/bridge/tools.ts packages/teamlead/src/bridge/gate-poller.ts packages/teamlead/src/bridge/auto-qa-effects.ts packages/teamlead/src/bridge/founder-thread-notifier.ts packages/teamlead/src/lead-backends/codex/__tests__/leadDiscordSend.test.ts packages/teamlead/src/lead-backends/codex/__tests__/DirectDiscordOutboundSender.test.ts packages/teamlead/src/lead-backends/codex/__tests__/discord-send-core.test.ts packages/teamlead/src/bridge/__tests__/chat-thread-routes.test.ts packages/teamlead/src/bridge/__tests__/auto-qa-effects.test.ts packages/teamlead/src/bridge/__tests__/founder-thread-notifier.test.ts packages/teamlead/src/bridge/__tests__/gate-poller-founder-reply.test.ts
    git commit -m "fix(FLY-1238): mark core founder automation without relabeling Lead speech"

提交前用 git diff --cached --stat 确认只包含本任务文件；不要依赖宽泛 git add 的结果。

## Task 3 — RED: Complete automated exit inventory

### Files

- Create: packages/teamlead/src/bridge/__tests__/automated-message-inventory.test.ts
- Modify all remaining provenance paths listed in Scope。
- Modify their existing tests：
  - packages/teamlead/src/__tests__/AlertChannelHub.test.ts
  - packages/teamlead/src/__tests__/standup-service.test.ts
  - packages/teamlead/src/__tests__/ChatThreadCreator.test.ts
  - packages/teamlead/src/__tests__/ChatThreadCreator.attach-pin.test.ts
  - packages/teamlead/src/__tests__/discord-post-file.test.ts
  - packages/teamlead/src/__tests__/reports-route.test.ts
  - packages/teamlead/src/bridge/__tests__/infra-notify.test.ts
  - packages/teamlead/src/bridge/roundtable/__tests__/RoundtableThreadManager.test.ts
  - packages/teamlead/src/bridge/__tests__/auto-qa-effects.test.ts
  - 相应 notifier/sweep/gateway 既有 suite

### Step 3.1 — RED: Source inventory contract

test 用 TypeScript compiler AST/symbol references 从 packages/teamlead/src production TS
文件中找：

- postDiscordMessageToChannel 的 direct call、alias、作为值传递与
  `opts.postText ?? postDiscordMessageToChannel` injected default；
- DiscordOps.postToThread/editMessage 的生成路径；
- 另用 raw source snapshot 查 Discord /channels/{id}/messages POST/PATCH。

断言每个文本出口属于以下之一：

- 含显式 origin=automation 或调用 markAutomatedDiscordText；
- allowlist 中的 lead_authored 出口（恰好四项：leadDiscordSend、tools send、
  DirectDiscordOutboundSender、discord-send-core）；
- 无文本 metadata operation（thread create/reaction/typing/delete），有明确注释/allowlist。

同时 snapshot 排序后的 symbol sender 与 raw REST 文件集合。新增 direct sender 或 injected
default 会先使测试 RED，迫使作者分类；regex 只做人工复核，不承担完整性证明。

### Step 3.2 — RED: Representative payload tests

每个集中 seam 至少钉一个 payload：

- LeadAlertNotifier root alert/DM/overflow；
- AlertChannelHub thread ack/repair/recovery/edit；
- ChatThreadCreator root/reuse pointer/attach pin post+edit；
- legacy phase pointer；
- runner ready-to-close；
- standup；
- reports-route generated report；
- infra-notify Annie digest；
- publish approval card；
- gateway lifecycle confirmation post+edit；
- roundtable seed；
- multipart report attachment。

所有自动 content 的第一个 token 必须是 marker。

### Step 3.3 — Minimal migration

- 共享 helper 可传 origin 的路径使用 origin=automation。
- custom REST path 在真正 POST/PATCH body 形成处调用 marker。
- createDiscordOps 内对 postToThread/editMessage 统一 marker，覆盖 plugin.ts 的 alert
  wiring；createThread/archive/get 不改。
- LeadAlertNotifier 在 formatContent 与 overflow summary 的最终边界 marker，保留 mention
  allowlist 与 echo anchor。
- multipart 只改 content，不改 attachment/allowed_mentions。
- reports-route/infra-notify 保持 injected `PostTextFn` 三参数 seam；默认 wrapper 显式调用
  shared helper `{origin:"automation"}`，避免扩大所有 mock。

### Step 3.4 — GREEN and manual audit

运行 inventory test 和所有改动 suite。再执行：

    rg -n "channels/.+messages|postDiscordMessageToChannel|postToThread|editMessage" packages/teamlead/src --glob '!**/__tests__/**' --glob '!**/*.test.ts'

逐项与 inventory snapshot 对齐；不能仅信 regex 自动发现。

### Step 3.5 — Commit checkpoint

    git commit -m "fix(FLY-1238): label every automated Discord text exit"

## Task 4 — RED: Shared merged-gate guard and StateStore cleanup

### Files

- Create: packages/teamlead/src/bridge/merged-gate-guard.ts
- Create: packages/teamlead/src/bridge/__tests__/merged-gate-guard.test.ts
- Modify: packages/teamlead/src/StateStore.ts
- Modify: packages/teamlead/src/bridge/external-merge-reconcile.ts
- Modify: packages/teamlead/src/__tests__/StateStore.fly1238-merged-gate.test.ts
  （新建专项文件，避免扩大 FLY-1185 大 suite）

### Step 4.1 — RED: Guard state table

用 injected checkPrMerge 覆盖：

- open → kind=continue，零 cleanup；
- closed → kind=continue，零 cleanup；
- transient unknown → retry_later，零 cleanup；
- missing projectRoot/prNumber → terminal_unavailable + durable alert intent；
- fresh UNKNOWN 仅在实际 probe 时增加 attempts；cache/backoff/budget 不增加；
- 第一次 `(questionId, source)` guard invocation 在任何 cache/budget/backoff 判断前创建
  ledger row 并写 first_seen，确保即使一直被 budget defer，15 分钟 deadline 仍已启动；
- 第 5 次实际 UNKNOWN 或 firstSeen+15m → terminal_unavailable + one-shot alert；
- merged → suppress_merged；CommDB retire 与 StateStore cleanup 各调用一次；
- cleanup throw →仍 suppress_merged，cleanupComplete=false；
- 同 project+PR 并发调用只触发一次 gh single-flight；
- MERGED cache 单调；OPEN/CLOSED 15 秒内不重复 probe；15 秒后下一次 side effect fresh probe；
- UNKNOWN backoff 30s/60s/120s/240s、封顶 5m；per-project fresh budget 6/min；
- guard 的 gh timeout ≤2.5 秒，existing reconciler 默认仍是 10 秒；
- kill switch=0 时 bypass network guard + loud boot/audit warning，marker 仍生效。

### Step 4.2 — RED: StateStore aggregate cleanup

构造同 questionId 的：

- active deferred approval；
- pending held_reply/head_drift/rebound；
- delivered action；
- 另一个 question 的 pending action。

调用 invalidateMergedGateArtifacts 后断言：

- active row reason=pr_merged；
- 本 question pending notices superseded/cancelled；
- delivered 与其他 question 不变；
- merged_gate_suppressed audit 只有一条；
- 重跑幂等。

另建 guard failure ledger 夹具，断言：

- key 为 questionId+source；首次 invocation 先持久化 first_seen，再做 cache/budget/backoff；
  row 同时持久化 attempts/next_retry/last_error/terminal；
- OPEN/CLOSED/MERGED resolve row；
- terminal 只排一次稳定 event id 的 `emit_alert` action；receipt 后 alerted；
- binding 修复后可 resolve terminal row，不写永久 founder done marker。

### Step 4.3 — Minimal implementation

merged-gate-guard.ts：

- 底层默认调用 external-merge-reconcile.ts::checkPrMergeViaGh；
- 给 checkPrMergeViaGh 增加可选 timeout 参数：existing caller 10s default，guard 2.5s；
- composition root 持有 shared monotonic/TTL cache、singleflight、backoff 与 project budget；
- merged verdict 在 cleanup 前锁定 suppress；
- CommDB 使用 retireShipGate 或等价 guarded callback；
- StateStore cleanup 失败只反映 cleanupComplete，不改 verdict；
- logger/audit 不包含 token。
- default-on env gate 只包 network merged guard；marker 不受 flag 控制。

StateStore.ts：

- 新增 invalidateMergedGateArtifacts；
- 在一个 StateStore transaction 内更新 deferred/action/audit；
- 在同一 transaction 内枚举 execution 的 pending notice kinds，JSON.parse payload，
  精确比较 questionId，再按 exact action_key 更新。StateStore 当前是 better-sqlite3 且可用
  JSON1；这里选择 JS-side comparison 是为了显式可审计，不是引擎限制。不能用不加边界的
  LIKE 误伤相似 qid。

### Step 4.4 — GREEN

运行：

    pnpm --filter flywheel-teamlead test -- src/bridge/__tests__/merged-gate-guard.test.ts src/__tests__/StateStore.fly1238-merged-gate.test.ts src/bridge/__tests__/external-merge-reconcile.test.ts

### Step 4.5 — Commit checkpoint

    git commit -m "feat(FLY-1238): add fail-silent merged gate guard"

## Task 5 — RED: Guard every recovery/reapproval entry

### Files

- Modify:
  - packages/teamlead/src/bridge/approval-signal/founder-ship-approval-handler.ts
  - packages/teamlead/src/bridge/approval-signal/founder-reaction-approval-handler.ts
  - packages/teamlead/src/bridge/approval-signal/deferred-approval.ts
  - packages/teamlead/src/bridge/founder-action-drain.ts
  - packages/teamlead/src/bridge/gate-poller.ts
  - packages/teamlead/src/bridge/auto-qa-effects.ts
  - packages/teamlead/src/bridge/plugin.ts
- Modify existing tests:
  - founder-ship-approval-handler.test.ts
  - founder-reaction-approval-handler.test.ts
  - deferred-approval.test.ts
  - founder-action-drain.test.ts
  - gate-poller-founder-fallback.test.ts
  - gate-poller-ship-grace.test.ts
  - auto-qa-effects.test.ts

### Step 5.1 — RED: Exact incident regression

在 founder-ship handler test 构造：

- awaiting_review session；
- review_question_id 与 pending gate 相同；
- merge_block_reason；
- valid pr_number/pr_head_sha；
- founder text “批准”；
- guard returns suppress_merged。

断言：

- queueHeldNotice 未调用；
- mergeBlockPointerText 未进入 action ledger；
- writeGateResponse 未调用；
- outcome 不让 deliverer consume 为 bound。

transient UNKNOWN case 断言 retry=true，让 cursor 保持重试，而不是 WAKE-only 丢失；
terminal_unavailable 断言 deliverer dead-letter/clear 当前 input 且 durable alert 已排入。

### Step 5.2 — RED: Reaction and queued-action regressions

- reaction source：MERGED 不写 response、不 ACK、不消费为成功；UNKNOWN 重试。
- action drain：已存在 held_reply，MERGED 时 cancel 且 POST=0；UNKNOWN 时 row 保持
  pending；只有 fresh UNKNOWN 增加 guard ledger attempts，budget/backoff 不增加 action
  attempts。terminal 时 action cancel/fail，不再无限 pending，并有 alert。
- deferred rebind：MERGED 静默 invalidate，不生成 TTL/head/rebound notice；
  transient UNKNOWN keep active；terminal invalidate 并 alert。

### Step 5.3 — RED: Card and rebound regressions

- GatePoller approve_to_ship fallback 在 POST 前 guard；MERGED retire + POST=0，
  transient UNKNOWN 不写 founderNotifyDone marker；terminal 也不写永久 done marker，禁声并
  alert，使 binding 修复后可恢复。
- notifyShipGateRebound 在生成新 anchor 前 guard；MERGED 禁声/无 anchor，
  transient UNKNOWN 返回 retryable failure；terminal 无 anchor并 alert。

### Step 5.4 — Minimal wiring

- plugin.ts 在 composition root 创建一个 shared guard，注入 projectRoot resolver、
  CommDB opener、StateStore、checkPrMerge。
- text handler：merge_block 只在即将 queue held notice 前 guard；普通信号在 classification
  后、write 前 guard。reaction 在 binding narrow 后、write 前 guard。
- rebind 只在即将发 TTL/head/rebound notice 或 write response 前 guard，不在 idle row scan
  时查 gh。
- drain 将 guard 放在 notice executeAction 的实际 POST 之前。
- fallback/rebound 将 guard 放在 dedup/grace 后、HTTP POST 前。
- 非 approve/recovery action 不增加 gh query。
- 所有 transient/terminal 分支消费统一 GuardResult，不允许 caller 自行无限 retry。

### Step 5.5 — GREEN and race assertions

运行全部七个 suite。再补并发 response 先赢：

- retire 返回 false；
- 已有 response 不变；
- founder message 仍禁声；
- audit 记录 cleanup race，不伪造成功绑定。

再断言 query budget：同 project 多 gate 在 1 分钟内最多 6 次 fresh probe，15 秒
OPEN/CLOSED cache 内的 side effect 复用结果，2.5 秒 timeout 不阻塞 3 秒 poll cadence。

### Step 5.6 — Commit checkpoint

    git commit -m "fix(FLY-1238): silence merged PR recovery and reapproval flows"

## Task 6 — RED: Atomic CommDB session finalization

### Files

- Modify: packages/flywheel-comm/src/db.ts
- Create: packages/flywheel-comm/src/__tests__/db.fly1238.test.ts

### Step 6.1 — RED: Happy-path transaction

建立 execution A：

- sessions row；
- unanswered approve_to_ship；
- unanswered brainstorm/question checkpoint；
- checkpoint=NULL runner question；
- answered approve_to_ship；
- execution B 的 pending gate。

调用 finalizeSession(A) 后断言：

- A session 删除；
- A 两个未回答 checkpoint expires_at/resolved_at/read_at 收尾；
- runner question 不变；
- answered gate/response 不变；
- B 不变；
- 返回 retiredQuestionCount=2、deletedSessionCount=1。

### Step 6.2 — RED: Rollback proof

在测试 SQLite 建 BEFORE DELETE ON sessions trigger，RAISE(ABORT)：

- 调 finalizeSession 抛错；
- session A 仍存在；
- pending gate 的三个时间字段完全保持调用前值。

该测试是“原子”的真实证明，不能只 mock transaction。

### Step 6.3 — Minimal implementation

在 CommDB class 中用 better-sqlite3 transaction 包裹：

1. guarded bulk UPDATE messages；
2. DELETE sessions；
3. 返回两个 changes count。

不要 catch；让调用层决定重试与日志。

### Step 6.4 — GREEN

    pnpm --filter flywheel-comm test -- src/__tests__/db.fly1238.test.ts
    pnpm --filter flywheel-comm typecheck

### Step 6.5 — Commit checkpoint

    git commit -m "fix(FLY-1238): finalize CommDB gates and sessions atomically"

## Task 7 — RED: Make every teardown path fail closed and visible

### Files

- Modify: packages/teamlead/src/bridge/commdb-session-prune.ts
- Modify: packages/teamlead/src/bridge/commdb-fsm-reconcile.ts
- Modify: packages/teamlead/src/bridge/close-runner.ts
- Modify: packages/teamlead/src/bridge/lifecycle-closeout.ts
- Modify: packages/teamlead/src/bridge/post-merge.ts
- Modify: packages/teamlead/src/bridge/crash-reaper.ts
- Modify: packages/teamlead/src/bridge/stale-blocker-guard.ts
- Modify: packages/teamlead/src/bridge/actions.ts
- Modify: packages/teamlead/src/StateStore.ts
- Modify: packages/teamlead/src/LeadAlertNotifier.ts
- Modify: packages/teamlead/src/bridge/kind-contract.ts
- Modify: packages/teamlead/src/bridge/plugin.ts
- Modify:
  - packages/teamlead/src/__tests__/commdb-session-prune.test.ts
  - packages/teamlead/src/__tests__/commdb-fsm-reconcile.test.ts
  - packages/teamlead/src/__tests__/close-runner.test.ts
  - packages/teamlead/src/bridge/__tests__/lifecycle-closeout.test.ts
  - packages/teamlead/src/__tests__/post-merge.test.ts
  - packages/teamlead/src/__tests__/crash-reaper.test.ts
  - packages/teamlead/src/bridge/__tests__/stale-blocker-guard.test.ts
  - packages/teamlead/src/__tests__/actions.terminate.test.ts

### Step 7.1 — RED: live and boot finalizer

commdb-session-prune tests：

- live finalizer 调 CommDB.finalizeSession，返回 counts；
- missing DB 是明确 no_db/noop，不伪装 transaction failure；
- transaction failure 返回 ok=false/error；
- boot prune 对 proven-dead terminal row 调 finalizeSession；
- alive/indeterminate 仍不碰 session/gate。

commdb-fsm-reconcile tests：

- CommDB=running、Bridge FSM=completed/terminated、tmux=dead 时调用 finalizeSession，
  session 删除且 pending checkpoint gate retired；
- transaction failure 时 reconciled 不增加，session 与 gate 都保留；
- failed/blocked preserve、non-terminal FSM、alive/indeterminate target 的既有不删除契约
  保持。

其余 teardown path tests：

- post-merge 将 finalize failure 放入 cleanup errors，后续 issue closeout 不把通讯收尾视为
  完成；
- crash-reaper 两个 session cleanup 分支失败时不 archive/不计完整 recovered；
- stale-blocker 两个 cleanup 分支失败时不 archive/不丢可重试锚点；
- terminate action 返回 cleanupPending 与 audit，而不是吞掉 finalizer error；
- 所有 plugin injected callback 的返回类型为 structured result，typecheck 能阻止 `void`
  丢失败。

### Step 7.2 — RED: closeRunner propagation

两个 physical success 形态都测：

- target already gone；
- killTmuxWindow 成功。

finalizer 成功时：

- closed/alreadyGone 保持；
- commDbFinalized=true；
- retiredGateCount 透传。

finalizer 失败时：

- physical truth 仍是 closed/alreadyGone；
- commDbFinalized=false；
- error 含 commdb finalize context；
- audit 写 finalization pending/failed。
- closeRunner 自己的 archive callback 调用次数为 0。

`CloseRunnerResult.commDbFinalized` 必须是 required boolean：所有 success、failure、
already-gone return 与所有 test double 都显式设置。用 type-level fixture 证明缺字段不能编译。

### Step 7.3 — RED: lifecycle DAG gate

lifecycle-closeout tests 注入 closeRunnerFn：

- closed=true, commDbFinalized=false；
- 断言 node.teardown=failed/blocked、communicationsFinalized=false；
- fresh probe 仍可如实得到 confirmedGone=true，但 issue-level prerequisite 必须要求
  confirmedGone AND communicationsFinalized，不能只看物理消失；
- openPrDisposal=0、archiveThreads=0、linearConsistency=0；
- report outcome=partial/blocked。

第二 pass 返回 commDbFinalized=true 后，才允许 issue-level items按既有顺序执行。

### Step 7.4 — Minimal implementation

- commdb-session-prune.ts 新建结构化 FinalizeCommDbResult，并替换/重命名旧 delete helper；
  不保留 `void` compatibility shim。
- commdb-fsm-reconcile.ts 将直接 db.deleteSession 改为 db.finalizeSession，只有事务
  成功才增加 reconciled。
- post-merge/crash-reaper/stale-blocker/actions terminate 全部 await 同一 finalizer 并消费
  `{ok, retiredGateCount, deletedSessionCount, error}`；每个 path 都记录 outcome。
- closeRunner 两个成功分支在 physical gone 后立即 await/call finalizer 并填充结果；
  optional maybeArchiveThreadOnClose 必须移动到 finalizer 成功之后，失败时跳过。
- lifecycle-closeout closeRes 判定：

      physicalSuccess = closeRes.closed || closeRes.alreadyGone
      teardownDone = physicalSuccess && closeRes.commDbFinalized === true

  `CloseRunnerResult.commDbFinalized` 定义为 required boolean；所有 production return 与
  test double 一次性补齐。禁止用 optional/undefined 过渡，因为它会让遗漏绕过编译器。
- NodeClosureReport 增加 communicationsFinalized；confirmedGone 保持物理 liveness
  原义。issue-level item 的 all-node prerequisite 改为每个 node 同时满足
  confirmedGone && communicationsFinalized，避免 anyFailed=true 但 archive/Linear
  仍因 !anyBlocked 而抢跑。
- issue-level DAG 顺序保持 PR disposal → archive → Linear；只是增加前置 gate。

### Step 7.5 — RED: Durable failure escalation

在 StateStore 增加 `commdb_finalize_failures` 测试：

- key=executionId；failure 增加 attempts 并保留 first/last/error；success 标 resolved；
- 第 3 次失败或 firstFailure+15m 产生稳定 event id 的 `commdb_finalize_stuck` alert；
- skipped/发送失败不置 alerted，下一 cadence 重试；真实 receipt 后只发一次；
- 告警后 finalizer 仍继续重试、lifecycle 仍 fail-closed；无新 timer。

实现时所有 teardown path 调 `recordCommDbFinalizeOutcome`。boot prune/FSM reconcile 通过
plugin 注入 recorder；既有 Heartbeat/GatePoller cadence drain alerts。扩展
LeadAlertNotifier/kind-contract 接受 `commdb_finalize_stuck` 与
`merged_gate_guard_unavailable`，禁止复用 Founder-facing 恢复话术。

### Step 7.6 — End-to-end runner-death regression

用真实临时 CommDB 复刻非正常 runner death：

- 注册 status=running 的 CommDB runner session；
- Bridge FSM lookup 返回 completed；
- 插入 pending checkpoint gate；
- tmux probe 返回 dead；
- 执行 reconcileCommDbRunningAgainstFsm；
- 重新打开 DB，断言 session gone 且 gate 不再 pending。

另保留 terminal-session boot prune 的同类断言。两条共同证明正常/非正常收尾都不
留下可被恢复流程匹配的 gate。

### Step 7.7 — GREEN

    pnpm --filter flywheel-teamlead test -- src/__tests__/commdb-session-prune.test.ts src/__tests__/commdb-fsm-reconcile.test.ts src/__tests__/close-runner.test.ts src/bridge/__tests__/lifecycle-closeout.test.ts src/__tests__/post-merge.test.ts src/__tests__/crash-reaper.test.ts src/bridge/__tests__/stale-blocker-guard.test.ts src/__tests__/actions.terminate.test.ts
    pnpm --filter flywheel-teamlead typecheck

### Step 7.8 — Commit checkpoint

    git commit -m "fix(FLY-1238): fail all runner teardown on gate finalization"

## Task 8 — Full regression and audit

### Step 8.1 — Targeted suites

运行 research.md 中列出的全部 targeted tests。任何 flaky/环境失败先隔离复跑并记录；
不能把 AssertionError 当环境噪声。

### Step 8.2 — Package suites

    pnpm --filter flywheel-comm test
    pnpm --filter flywheel-teamlead test
    pnpm --filter flywheel-comm typecheck
    pnpm --filter flywheel-teamlead typecheck

若全 teamlead suite 受机器并发资源影响，至少用单文件/单 fork 复验所有失败文件，并在
PR 描述列出原始命令、失败签名和隔离结果。

### Step 8.3 — Static provenance audit

运行：

    rg -n "channels/.+messages|postDiscordMessageToChannel|postToThread|editMessage" packages/teamlead/src --glob '!**/__tests__/**' --glob '!**/*.test.ts'

逐项确认：

- text POST/PATCH 全部显式 origin；
- lead_authored allowlist 恰好四个已验证路径；
- AST/symbol scan 覆盖 DirectDiscordOutboundSender、discord-send-core、reports-route 与
  infra-notify 的 injected default；
- 无 direct fetch 漏 marker；
- reaction/typing/metadata operation 未误标。

### Step 8.4 — Diff safety audit

    git diff origin/main...HEAD --stat
    git diff origin/main...HEAD -- packages/flywheel-comm/src/db.ts packages/teamlead/src/bridge/merged-gate-guard.ts packages/teamlead/src/bridge/close-runner.ts packages/teamlead/src/bridge/lifecycle-closeout.ts

重点检查：

- 无 token logging；
- MERGED monotonic cache、OPEN/CLOSED ≤15 秒 TTL、UNKNOWN bounded backoff 配置准确；
- fresh probe ≤6/project/min，guard subprocess timeout ≤2.5 秒；
- 无 unguarded response overwrite；
- 无跨库 atomicity 误称；
- no new timer；`FLYWHEEL_MERGED_GATE_GUARD=0` 只 bypass network guard，marker 始终启用；
- Lead authored body 保持原样。

### Step 8.5 — Final implementation commit if needed

只提交格式化、测试或文档收尾；不要 squash 掉 RED/GREEN 证据所需的逻辑分界，除非项目
PR 习惯要求。

## Test Matrix

| Contract | Unit | Integration |
|---|---|---|
| marker once | automated-message.test | every sender representative suite |
| every chunk marked | discord-utils.test | inventory contract |
| Lead text untouched | four authored-path tests | AST inventory allowlist |
| MERGED silent | merged-gate-guard.test | handler/reaction/drain/fallback/rebound |
| UNKNOWN bounded | merged-gate-guard.test | transient pending; 5 probes/15m terminal + alert |
| query budget | merged-gate-guard + external merge tests | cache/singleflight/6-min/2.5s timeout |
| response history preserved | CommDB + guard tests | concurrent response race |
| gate+session atomic | db.fly1238.test | rollback trigger |
| dead runner no gate | all seven teardown suites | real temp CommDB, normal + abnormal death |
| FLY-1185 fail-closed | closeRunner test | lifecycle closeout DAG |
| finalizer visible failure | StateStore/alert tests | 3 attempts/15m one-shot routed alert |

## Rollout

marker 不增加 feature flag，merge 即生效；merged network guard default-on，但提供紧急
`FLYWHEEL_MERGED_GATE_GUARD=0` kill switch。理由：

- marker 是 founder trust P0，不能保留默认关闭的事故路径；
- merged guard 在 UNKNOWN 时 fail-silent bounded retry，不会以不确定状态做破坏性 cleanup；
- CommDB finalize 比旧 delete 更保守，事务失败会 rollback；
- 所有 cleanup 幂等，可由现有 cadence 重试。

kill switch 只恢复 legacy recovery flow，并在 boot/audit 发醒目告警；它不能关闭
`🤖[自动]` marker。这样紧急情况下可以隔离 gh/query 风险，但不会重新制造身份冒用。

观察信号：

- **merged_gate_suppressed** event count/source；
- CommDB finalize failure audit；
- merged guard unavailable / commdb_finalize_stuck routed alert receipt；
- guard probe latency、cache hit、budget drop、terminal counts；
- founder action cancelled reason=pr_merged；
- LeadAlert dead-letter/Discord failure不应因 marker 增长；
- inventory test 防止后续回归。

## Definition of Done

- 所有 automated sender inventory tests green。
- incident fixture 的 Discord POST count 为 0。
- text、reaction、queued ledger、rebind、gate card、head rebound 六个入口都受 guard。
- missing binding 与 persistent UNKNOWN 不会无限 pending；terminal 后一次 Lead alert。
- CommDB rollback trigger 证明 transaction 原子。
- real temp DB 证明 dead runner 不残留 pending checkpoint gate。
- lifecycle finalizer failure 时 archive/Linear 调用为 0。
- closeRunner、post-merge、crash-reaper、stale-blocker、terminate、boot prune、FSM reconcile
  七类 teardown 都消费结构化 finalizer 结果。
- flywheel-comm 与 teamlead typecheck green。
- PR code review 与独立 QA 都在最终 head 通过。

## Design Review History

Round 1（question **b21fca41-c3da-4fba-bba8-85930e4f8785**）返回
CHANGES_REQUESTED。本版已逐项处理：

1. authored allowlist 扩为四个真实出口，并以 AST/symbol inventory 覆盖 injected default；
2. finalizer 覆盖 closeRunner、post-merge、crash-reaper、stale-blocker、terminate、boot
   prune、FSM reconcile 全部生产 teardown 类别；
3. missing binding / persistent UNKNOWN 改为 bounded terminal + durable Lead alert；
4. merged probe 增加 15 秒 freshness cache、singleflight、6/min budget、2.5 秒 timeout；
5. `commDbFinalized` 改为 required boolean；
6. finalization failure 增加 3 次/15 分钟 durable escalation；
7. merged network guard 增加 default-on kill switch，marker 永远不可关闭。

Round 2（question **7828ca90-6ad6-431f-ae95-27f91e9ad31b**，request
**3989d383-8307-4d6d-b422-cf1c1a740008**）verdict：**APPROVED**。三个 LOW 文档意见已
同步修正：first_seen 在首次 invocation 预先落盘、better-sqlite3/JSON1 描述更正、
reports-route test path 与 Task 2 exact git-add 清单修正。未改变已批准的架构或安全契约。

## Handoff

本 plan 供 Implement phase 直接执行。Design phase 不运行 Task 1–8 的代码步骤；只在
cross-family design review APPROVED 后提交本文件与 exploration.md、research.md、
progress.md。
