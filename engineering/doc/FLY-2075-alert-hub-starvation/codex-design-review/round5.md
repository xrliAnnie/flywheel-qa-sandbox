# Design Review — plan.md (Round 5)

Date: 2026-08-26
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 5 已关闭上一轮的六个实质性架构问题：根消息与账本都强制从 `NEW` 开始，真实 queue replay、C1–C8 founder 门、2076 deploy gate、真实 Discord thread 负向证据和 enqueue/reconcile 两类 `needs_human` 合同均可在现架构内实现。剩余问题集中在测试与接口合同：R9 仍不能证明 plugin 的一次性副作用，R1/R2/R3 仍含现有 runner 无法执行的断言，且 `AlertTicketContext.status` 在计划实施后会成为被误述的死字段；因此尚不宜直接进入实现。

## What's Good (Keep)

- 已核 plan blob 为 `9b4505e55b42c6810e14062d11888eef84d0f3c6`，worktree 干净；本轮只复核 Round 4 的六项 ledger 及其相邻接缝，没有重开 founder 已定的 channel-only 方向。
- T5/T7e 把状态信任边界放在正确位置：`LeadAlertNotifier` 首发根消息固定 `NEW`，Hub 新账本也固定 `NEW`，后续状态只通过根消息 edit 与 StateStore 更新；R10 的磁盘 JSON → `drainQueue()` → `attachDeliveredAlertLifecycles()` 路径可用现有 fixture 搭建，并能真实抓住旧 `ESCALATED` payload 回放。
- G0 已明确要求接受 C1–C8；无 Hub 的逐事件 dead-letter/desktop blast、QA 房变化、FLY-2076 deploy evidence/no-reader waiver，以及高副作用 rollback 授权都已进入机械门控。
- R8 现在会同时记录 `postToThread` 参数并逐 thread 回读 Discord 消息，隔离 founder snowflake 后检查正文、`mentions` 和根消息状态，足以形成可附 PR 的负向证据。
- 验收 E 已用 `ticket_status IS NOT NULL` 排除未绑定 issue-progress 行，并固定 SQLite UTC 时间格式；cap-owner 也已定案为纯 owner handoff，不再承诺 T2 或写 `ESCALATED`。
- retry refusal 会消耗 attempt budget，null/非法 `first_seen_at` fail closed；保留的 ARC、queue/rate-limit replay、三个定向 `enqueueInfraAlert` 消费者与 RETIRED_FLAGS 治理边界仍清楚。
- 本轮聚焦执行中，config `flag-truth` 28/28 通过；teamlead 相关基线 159/161 通过，另两项现有 replay-freshness 失败来自受限环境无法打开默认 episode DB 后增加的 logger 调用，与本计划路由改动无关。

## Issues & Recommendations

1. **MEDIUM — R9 只测试纯函数返回值，仍不能锁住“plugin 每 boot 只打印/通知一次”的副作用合同。** 当前 `plugin.ts:9903-9912` 已有一个直接 `console.error` + `metaAlertNotifier.notify()` 的 missing-repair-chain 分支；T7d/T7f 再接入 helper 时，如果实现者保留旧分支并新增一次 helper 输出，R9 仍会全绿，但同一 boot 会走两次发送调用并打印两条红灯（第二次桌面提示可能仅被 `MetaAlertNotifier` debounce 掩盖）。**修复：**T7f 明写“替换并删除 `plugin.ts:9903-9912` 的旧 effect branch，不得并存”，并让 R9 覆盖 effect seam（注入 logger/notifier spies，正常配置均为 0，任一缺失均各恰 1）；或增加等价的 plugin wiring test。只验证 `{ redLight, metaAlert }` 的形状不足以证明 once-per-boot。

2. **MEDIUM — renderer/TDD 表仍有不可执行或自测自身的断言，R1 不是所描述的真实根消息测试。** R1-⑤ 的 Hub fixture 使用 notifier stub；stub 只接收 `AlertPayload` 并返回 `AlertResult`，无法观察文件私有的 `LeadAlertNotifier.formatContent()`，除非它自己伪造渲染逻辑，这会变成测试自写字符串。仓内已有真正的 live renderer seam：`LeadAlertNotifier.test.ts:1069-1077` 当前给 `ticket.status="ACK"` 并断言根消息显示 ACK，T7e 后该用例必须改成先写 RED、期望 `NEW`，但 plan 没有枚举它。**修复：**从 R1 删除“stub 捕获根正文”断言，R1 只锁 Router→Hub、账本和 thread；把上述现有 notifier 用例列入 RED 并改期望 `NEW`，R10 继续负责真实磁盘回放全链。

3. **MEDIUM — 撤回类型 RED 没有传播到 R2/R3。** plan 已正确说明 `packages/teamlead/tsconfig.json` 排除 `**/*.test.ts`、Vitest 不 typecheck，但 R2 仍写“给已删除的 `escalateToIssueThread` / `onTicketEscalated` 即 TS 错”，R3 仍写“类型上不存在 `escalate`”；放在这些 test 文件里的类型断言同样没有 runner 会执行。**修复：**删除这两处类型 RED 宣称，依赖现有行为 RED 和 production `pnpm -r build`（plugin 的旧接线会真实编译失败）；若一定要锁 public type shape，则新增明确纳入 `tsc` 的 type-test fixture/命令。

4. **LOW — T7e 保留的 `AlertTicketContext.status` 与计划描述不符，实施后它没有任何运行时读者。** 今天的两个生产读点正是 `LeadAlertNotifier.formatContent()` 与 `AlertChannelHub.openAlertThread()`；T7e/T5 都改为忽略它，而 `updateRootTicketStatus(channelId, messageId, status)` 接收独立参数，根本不会“供 Hub 编辑时使用”。继续把该字段设为 required、让 `enrich()` 恒写 `NEW`，会留下一个看似可控制初态但实际被完全忽略的 API。**修复：**优先删除该字段和 Router 预置（旧 queue JSON 的额外字段仍可被忽略）；若为兼容暂留，则改成 optional/deprecated，并准确写成“legacy input, ignored since FLY-2075”，不要声称 Hub 会使用。同时把 `AlertChannelHub.ts:106-110` 中“needs_human opts into founder ping”的旧注释改成 cap-owner/显式 owner handoff，补齐 T11 的注释清理。

## Verdict

CHANGES REQUESTED — address items above
