# FLY-2561 待批标题 — 实施计划
Issue: FLY-2561 (https://linear.app/geoforge3d/issue/FLY-2561/thread标题-dag-流程下-ship-卡开着时-thread-标题不变待批仍显示-qaissue-display-只在-session)
日期: 2026-09-14
基于: research.md

状态：Lead 裁决 dd53344f-8d83-471b-b695-716b795a6969 已批准精确修复范围；旧 review d0eb6762-daf3-475d-a89f-8a79d7a93b6d 方案作废，不据其裁决编码。

1. TDD：在 gate-materializer/issue-display-refresher 回归中，真实内存 StateStore + 临时 CommDB materialize 完成后 enqueue 现有 refresher；只排空一次刷新，不调用 runSweep，断言 QA→🔔 ⏳待批。失败与 replay 路径测试。
2. gate-materializer.ts 暴露可选 issue refresh callback，在成功物化及成功重放后触发。plugin.ts 注入现有 enqueueIssueDisplayRefresh。
3. founder-approval-projector.ts 在成功投影 founder_approval / founder_feedback 后按已验证 run 解析 issue 并通知刷新，覆盖 approve/kickback。workflow-gate-card-lifecycle.ts 处理 durable superseded holder 时通知刷新，覆盖 void。plugin 注入同一 enqueue。回调失败不得改变 gate 审批/游标/卡片投递语义，记录失败；无新增 timer、schema 或持久化 consumer。
4. 保持 issue-display.ts、issue-display-refresher.ts 的 derive 与 layer-2 cadence 不变。保留既有 legacy/批准/完成/hold 测试；负例覆盖错误 owner、不成功的 projection、无关 source event。
5. focused tests、pnpm lint、pnpm -r build、pnpm test:packages:run；按注入的 aggregate receipt 规则判定。报告经 publish-report 验证 HTTP 200，禁止真实频道测试。
6. progress、commit/push、effective code review；最后提交 milestone，PR 附延迟测量与精确头 CI。ask --report 和 complete --route needs_review --pr 后 park；不 dispatch QA、不 ship。

回滚只撤销显示刷新补丁，无数据迁移。

## R2 接线和失败边界（supersedes §2/§3 的未明确部分）

- 先将 plugin.ts 现有三项声明作为原样代码块上移：issueDisplayRefreshHolder、pendingIssueDisplayRefreshes、enqueueIssueDisplayRefresh，置于 startWorkflowSourceProjector 构造之前。注意 chatThreadCreator 在更后位置定义（6609），因此将 enqueue 的 else if (chatThreadCreator) 改为 else if (config.chatThreadsEnabled)。config 是 setupBridge 的已初始化参数，不引用尚未创建的 ChatThreadCreator；实例创建位置保持不变。projector 构造时同步 drain 可能调用回调，因此禁止仅用懒箭头引用后声明的 const；禁止丢弃启动期通知。refresher 绑定后的原有 pending Set drain 保持原样。三处注入均传 onIssueDisplayRefresh: enqueueIssueDisplayRefresh。
- 在 workflow-gate-card-lifecycle-wiring.test.ts 增加源接线合同：初始化块在 projector 前；projector、materializer、void 三处均注入；保留 late binding 后 pending drain。projector 测试覆盖 startWorkflowSourceProjector 即时 drain 的回调，防止仅测试手动 drain。
- materializer：成功完成/成功 replay 触发；markWorkflowGateCardPostOutcome('ambiguous') 持久化后也触发，避免卡实际上已贴出而标题等60s。已有 ambiguous/reconcile_wait 且本次没有状态转移的调用不触发；只有新写 ambiguous outcome 或最终物化成功触发。重启漏掉通知仍由既有 sweep 兜底，不新增跨调用缓存。origin preflight 拒绝且无历史投递事实不触发。无新增 timer、存储或审批推断。
- void：listWorkflowGateHoldersForCardVoid 返回的是已经 durable superseded 的 holder。每次 sweep 解析到 run 后立即 enqueue，位于 resolveDelivery/editCard 之前，因此缺 token/thread、网络 transient/永久失败都不会阻挡标题恢复；同一 sweep 用局部 Set 按 issue 去重，不跨 sweep 留状态。后续已有重试 tick 可重复 enqueue，交给既有 coalesce/zero-churn writer。run 不存在时不猜 issue、不刷新。
- 三处回调均单独 try/catch（含错误日志），不把显示错误送进 projector poison/游标判定或卡投递状态机。回调为同步 fire-and-forget enqueue，绝不 await Discord。增加 materializer/void throwing-callback 用例和 void 缺 delivery/transient、ambiguous POST 用例；projector保留已提交的失败/无关source/owner mismatch负例。

本轮唯一 blocking finding projector-refresh-wiring-tdz 以初始化顺序和启动缓冲明确解决；其余建议仅用于覆盖同一开关门刷新范围。

R3 校正：启动缓冲函数只能引用已初始化 config/holder/pending Set；接线测试验证其分支使用 config.chatThreadsEnabled，不引用 chatThreadCreator。用 TypeScript AST 解析三个调用对象的 onIssueDisplayRefresh 属性，替代700字符窗口。
