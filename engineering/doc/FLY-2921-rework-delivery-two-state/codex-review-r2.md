# Design Review — plan.md (Round 2)

Date: 2026-09-26 / Author: Codex / Status: CHANGES REQUESTED

## Summary

本轮仅复核 R1 十项及修法直接引入的问题。多数修订已闭合，但仍有 **1 BLOCKER、3 MAJOR**：2919 合入前使用的 classifier 仍能凭窗格判死；新增协作退出流程被现有授权条件拒绝；启动动作表遗漏准入前身份且遮住 Lead 重投分支；同一 wake 的复位原语不具备计划声称的跨推送幂等性。

Reviewed plan: `a429cccff`，blob `56c15f439fea9c7386006ca65325a2c0f08586f4`。当前 HEAD 为 `83f382f4e6311166556b0907250bff9d2d025fba`，其 plan blob 与指定提交一致；源码仍与基线 `d52df7841` 一致。未修改源码、未运行测试套件。本轮执行了内存 SQLite 验证，使用基线的 outbox DDL、reset/finish SQL 及原有分支条件，复现第 4 项；最终验证进程退出码 0。该验证不是新实现的测试结果。

下文 `plan.md` 为 `engineering/doc/FLY-2921-rework-delivery-two-state/plan.md`；`StateStore.ts` 为 `packages/teamlead/src/StateStore.ts`。源码行号均基于 `d52df7841`。

| R1 项 | 本轮结论 | 核验结果 |
|---|---|---|
| #1 终态/到期当死亡 | 部分解决 | 已撤掉直接短路并增加提交时复核；部署前置与退出授权仍有问题，见本轮 #1、#2 |
| #2 未启动升级冻 run | 已解决（设计层） | C4.2 同时覆盖调用方与事务，保留未知证据保护，并指定真实 tick 回归 |
| #3 启动中及 Lead 重投 | 部分解决 | 已覆盖 committed 后死亡与内容缺失优先，但身份与分支顺序仍不完整，见本轮 #3 |
| #4 resume fallback 半铸体 | 已解决（设计层） | C6.3 明确共用物化核心，覆盖 reason、验证路径、lineage/附件、退役、预算及 owner/generation CAS |
| #5 wake 版本与退役模型 | 原问题已解决 | 撤回每版本 wake，保留退役三元组；补上物化事件新旧 UID 读取。替代方案的原语假设见本轮 #4 |
| #6 旧版本 ACK 先写后判 | 已解决 | 同 actor、同 wake、同内容允许迟到签收；换 actor 仍由事务内现有身份比较拒绝 |
| #7 C7 降级不可达/TOCTOU | 已解决（原问题） | event-route 证据将 head 与 diff 结果分离，明确绑定捕获的不可变 commit，并删除虚假的二次观测承诺 |
| #8 两列 schema/重置 | 已解决 | 建表、跳过条件、各路由更新清理和两档告警 UID 均已明确 |
| #9 拒绝审计回滚 | 已解决 | 明确在回滚后通过拒绝记录路径持久化，并要求状态与审计共同断言 |
| #10 路径截断假零 | 已解决 | Git pathspec 先排除、NUL 分隔、首个合格路径即可证明变化，无法确定时 unverified |

## What's Good (Keep)

- 保留同一个 wake 是有效减法。源码 `packages/teamlead/src/bridge/workflow-rework-context.ts:19` 的上下文不含路由版本；Lead 重投保留目标及内容，因此无需为这次传输恢复扩张 TURN 或退役身份。
- C4.2 对未启动升级的修订直接补上 R1 指出的写点，不需要借助新的 run 状态。
- 共用物化核心、保持 fallback 的 purpose/source_demand_id、统一预算与认领，是恰当的实现边界。
- C7 的不可变 commit 语义、独立 diff 降级，以及三项 MINOR 修正均可保留。不要求重新审议五态设计或兄弟单职责划分。

## Issues & Recommendations

### 1. BLOCKER — 2919 前的 classifier.replace 仍不是所要求的死亡证明

**关联：** R1 #1 尚未完全解决。

**问题与证据：** `plan.md:113`、`:118` 允许 2919 尚未合入时直接使用现有 classifier。基线 `packages/teamlead/src/bridge/plugin.ts:14661` 的 registered/persisted 探针调用 `probeRunnerProcessLiveness`；`packages/teamlead/src/bridge/tmux-lookup.ts:797` 实际读取的是 `tmux list-panes ... #{pane_dead}`，`:807` 把窗格不存在记为 absent，`:835` 从 pane_dead 得到 dead_pin。`packages/teamlead/src/bridge/phase-actor-reentry.ts:40` 遇 registered dead_pin 立即返回 replace，`:63` 遇 persisted dead_pin/absent 也立即返回 replace；这些路径不调用 hasHostProcess。宿主进程检查仅在无 persisted tmux target 的另一条路径（`:46`）生效。

**为什么阻止批准：** 窗格消失而 detached daemon/controller 仍活时，该探针不是 unknown，而是明确返回 replace。因此“unknown 时 fail-closed”和 session lifecycle_revision CAS 挡不住它，计划新增的 controller 重启/终态活体负控不能由现有合同保证。这是 R1 已要求明确的先后部署问题，不是要求 2921 重做 2919 的探针。

**建议：** 明确自动物理换体依赖 2919 的受信进程证据能力就绪；2921 可以先合入，但能力未就绪时不能把基线的所有 replace 当成受信死亡。此时只开放已有精确、排除外部启动的未启动回滚证明等合法路径，其余等待/告警。另一选择是先部署 2919 再启用本功能。测试应走真实 probe wiring，构造 pane absent/dead_pin + worker/controller alive，而不是仅 stub classifier 返回 hold。同步删除 `plan.md:450` 仍写着“不可逆终态”可判死的旧表述。

### 2. MAJOR — 新增“核验后协作退出”无法关闭已经 running / wake_delivered 的目标

**关联：** R1 #1 修法带来的收尾缺口；也涉及 R1 #3 的授权范围。

**问题与证据：** `plan.md:115` 对终态、resident expired/closed 等核验后仍 alive/unknown 的目标，统一调用 closeActorForReworkSupersession。`plan.md:194` 明确现有授权条件不放宽，但这里只证明了尚未启动替身的内容缺失场景。实际 effect 在 `packages/teamlead/src/bridge/plugin.ts:15002` 调用 `checkWorkflowReworkSupersessionAuthority`；`StateStore.ts:44257` 只接受 pending/turn_granted delivery，`:44281` 只接受 pending/admitted 节点。

**触发与影响：** 一个已签收返工、节点 running、delivery wake_delivered 的体，后来出现逻辑终态但物理进程仍活。新流程正确地不直接换体，却在协作退出前必然得到 rework_supersession_delivery_changed；即使 delivery 仍为 turn_granted，只要节点已 running，也会得到 rework_supersession_target_changed。后续“等退出再证死”没有真正发起退出。仅补 pending/admitted 内容缺失用例不能证明该流程可用。

**建议：** 明确这些状态使用哪条受控收体入口。可以扩展既有授权检查，但必须要求精确的故障/退场理由，并继续核对 owner/generation、route、execution、当前 activation/TURN 与节点归属；不能为普通 alive/unknown 工作体无条件开放关闭。或明确交给 2919 的受控收尾，并证明它一定被请求且有可见失败结算。增加 running + wake_delivered + terminal-but-alive 的用例，断言退出实际获授权，迟到 owner 被拒，证死前零后继。

### 3. MAJOR — 替身动作表缺准入前分支，且 Lead 重投行被前面的通用行遮住

**关联：** R1 #3 部分解决；本项只修正新动作表。

**问题 A：** `plan.md:99` 将 replacement binding 作为识别替身的必要条件，但刚铸出的替身尚无此 binding。`StateStore.ts:44745` 分配 ledger、`:44765` 预留 pending 节点、随后插入 actor 和路由；execution binding 直到 `packages/teamlead/src/bridge/workflow-engine-dispatcher.ts:3190` 准入时才由 `StateStore.ts:47314` 插入。额度暂停和 admission 拒绝在 dispatcher `:3181`、`:3186` 就可以返回，发生在绑定之前。

**影响 A：** pending + intent_recorded + 尚未准入的合法替身不会进入动作表，可能被当作 session 缺失而提前计数，甚至在启动窗口落入普通 wake 路径。R1 建议的 binding 身份适用于已准入阶段，不能作为准入前替身的唯一入口。

**问题 B：** `plan.md:99` 明确“按顺序处理”，但 Lead 重投取消旧启动的行在 `:108`，排在 intent_recorded 的两个完整分支（`:105`、`:106`）和 launch_committed 分支（`:107`）之后。任何匹配该重投行的这两类 ledger，都会先被前面的等待/计数分支消费。

**影响 B：** 特别是已 committed 但使用旧版本 launch envelope 的活替身，会先命中“活着就等”，永远不执行计划为新路由安排的关闭换体，旧内容摘要的问题仍在。

**建议：** 准入前使用精确的返工 dispatch reason + run/node/attempt/execution + 当前目标归属识别 intent；准入后再校验 replacement binding，避免依赖当前没有的记录。将 Lead 重投旧启动、内容缺失等覆盖性动作放在通用 ledger 等待之前，或把各行写成互斥条件。补测“铸体后被额度/容量挡在 admission 前”和“hold_resume + launch_committed + alive + 旧 envelope”，要求实际走到正确 defer/取消/收体路径，不能只检查判定 helper 或 resume API。

### 4. MAJOR — resumeTurnWakeHold 不具备计划声称的跨 sent 状态幂等性

**关联：** R1 #5/#6 的原身份问题已关闭；这是替代方案新引入的原语假设问题。

**问题与证据：** `plan.md:139`、`:140` 宣称相同 receiptId 重放不重复复位，并由当前版本“尚未推送”的条件驱动。基线 `packages/flywheel-comm/src/db.ts:4213` 只在 `state === pending && cancel_reason === receiptId` 时返回 idempotentReplay；`:4221` 对 sent 也重新设置 push_count=0、清 claim 和推送结果。每次推送结束，无论成功失败，`:9044` 的 finishTurnWakePush 都把状态写成 sent。C1 的 wake_sent_at 则只在推送成功后写入（`plan.md:67`）。

**验证与影响：** 使用基线 SQL 和分支条件在内存中执行：同 receipt 首次 reset → 推送失败后 sent/push_count=1 → 再次调用同 receipt，结果仍是 reset，最终 pending/push_count=0。它不是计划承诺的幂等重放。失败后的正常重试，以及“推送完成、StateStore 尚未记 wake_sent_at 就崩溃”的重放，都可能再次清预算/结果；与独立 outbox patrol 并发时还可能清掉新的 claim。这破坏了保留每路由两次实际推送的预算说明，也可能漏掉原有第二次推送的 verified-write 行为。

**建议：** 保留同 wake 的简化方向，但明确一次 Lead 重投只复位一次的持久保证。可让既有原语对同一 receipt 在 pending/sent 转移后仍幂等，或利用既有 operation/receipt 机制记录已消费的重臂身份；不要仅靠 StateStore 的“成功发送时间为空”判定是否需要再次清零。规定与当前 claim、旧 owner 和 ACK 的竞争行为。回归必须包含 reset→失败 push→同 receipt 重放、成功 push 后崩溃重放，以及 patrol 已认领时的重放；断言不会重新清零/撤销后来的有效 claim。无需恢复 per-revision wakeId 或增加 TURN 行。

## Verdict

**CHANGES REQUESTED**

请修订本轮第 1–4 项及对应用例。R1 已关闭项保持关闭；本轮没有增加新的架构范围，也不要求重新批准兄弟单边界。
