# FLY-2557 Epic 自动入口 — 调研
Issue: FLY-2557 (https://linear.app/geoforge3d/issue/FLY-2557/epic-流程intake-epic-进-in-progress-自动触发拆解bridge-监听-linear-epic无)
日期: 2026-09-14
基于: exploration.md

## 结论
选择既有 GatePoller 3 秒时钟上的每项目约 30 秒 intake 检查，使用 Epic 页共用查询/生成管线。Bridge 没有可用 Linear webhook 绑定，不跨接另进程 EdgeWorker。状态身份来自 `Issue.stateHistory` 的连续 started 段起点；不是本机首次观察时间，也不是 issue 顶层 startedAt。空 Epic 进入页面，但不能冒充 ready 子单。

调研采用 research 技能的定位、约束、消费者并行只读审计及本节点数据流核验。任务已明确授权设计范围；按注入的设计评审 gate 收口，不增加技能默认的人类批准停点。没有产品代码修改。

## 当前事实与证据
基线 `f31b75af9`；2026-09-14 只读 Linear API 确认 FLY-2557 正文与任务相同，FLY-2553 仍 In Progress。

| 面 | 位置与事实 | 设计影响 |
|---|---|---|
| Bridge Linear | `packages/teamlead/src/bridge/plugin.ts:3892` 起为 API proxy，没有 Linear webhook | 不把 `/events` 的 runner ingest token 当 intake 来源授权 |
| 另一进程入站 | `packages/edge-worker/src/EdgeWorker.ts:575`; `packages/linear-event-transport/src/LinearEventTransport.ts:134` | 未与 Bridge 组合；异步 EventEmitter 未等待持久化，不能声称现成可靠入站 |
| 时钟 | `bridge/gate-poller.ts:125,784`; `packages/config/src/patrol-config.ts:9` | 3s 主时钟、约60s rider、默认60分钟 Lead grid 是三个不同量 |
| 现有扫描 | `bridge/patrol-tick.ts:198,278,376` | 扫描懒加载位于 Lead suppression 后；当前不能满足60s intake |
| 共用生成器 | `bridge/plugin.ts:6512`; `bridge/epic-residual-scan.ts:150` | scan/event/manual 已共用 runEpicPageAttempt → materializeEpicPage → generateAttentionEpicPage |
| 页面刷新 | `bridge/epic-page-refresher.ts:22,187,247` | 5s debounce，但 dirty 只在内存；intake 要有持久化重试凭据 |
| 根查询 | `bridge/linear-epic-query.ts:186,278` | children>0 + 日常标题前置条件都排斥单独新建的空 Epic |
| 根快照 | 同文件 `:41,424` | 不含 root labels、UUID消费位置与状态历史；需要扩展边界数据 |
| 生成来源声明 | `epic-page/generate.ts:495,528` | 当前来源声称 children!=null，移除过滤时必须改 provenance，不能留假声明 |
| 严格模型 | `epic-page/model.ts:970,996` | scope.v2 强制日常；root 额外字段只许 lead_note；新增 scope.v3 兼容路径及 intake cell |
| 页面隐藏 | `epic-page/founder-view.ts:243` | 专门排除 childless roots，需要 intake visibility 例外 |
| ready.v1 | `epic-page/residual.ts:243`; `epic-page/rules.ts:32` | remaining/ready 守恒只对子单；新增独立 pending intake 读数 |
| 消费者唤醒 | `bridge/patrol-tick.ts:376`; `bridge/hook-payload.ts:614` | 无 Runner且 remainingForLead=0 时当前不发 tick；要纳入待处理 intake |
| 依赖授权 | `bridge/dependency-route.ts:812,1435` | descendantIds 是写权限范围，不能把根加进去 |
| 证据遍历 | `epic-page/receipt.ts:229,255` | roots Cell 内只递归 lead_note，intake Cell 必须显式遍历和计入 digest |
| 稳定事件 | `StateStore.ts:20401,20409,6657` | journal 唯一键(lead_id,event_id)，append 返回旧 seq 也非0；需独立全局 intake UID 锁定 owner |
| 事务 | `StateStore.ts:689,4305` | 已是 better-sqlite3 WAL；save 是兼容 no-op；状态和事件同库事务 |
| 新 ACK | `StateStore.ts:20445`; `bridge/lead-inbox-loop.ts:497` | 新事件 ack_required=0；delivered_at 是适配器收据，不是 Lead ACK |
| 队列身份 | `bridge/lead-event-queue.ts:8`; `legacy-lead-event-reconciler.ts:19` | canonical delivery id=lead_event:<leadId>:<eventId>，重试从原 journal row恢复 |
| 跨库恢复 | `StateStore.ts:20816`; `bridge/lead-inbox-runtime.ts:374` | active redrive allowlist 只有两类 workflow event，必须加 epic_intake |
| ACK 真凭据 | `packages/flywheel-comm/src/mailbox-queue.ts:1759` | batch owner校验后原子ACKED/acked_at，重复ACK幂等 |
| 路由 | `ProjectConfig.ts:1245`; `bridge/department-registry.ts:76,163` | 默认resolver会退到首位CoS；intake用DepartmentRegistry严格 one-match，不用general fallback |
| Bundle | `scripts/lead-rules-bundle.sh:350`; `lead-rules-base/runner-patrol-rules.md:924` | §0.9/0.10/7现成；§0.11追加同一来源，Claude/Codex都走bundle |

## 外部接口核验
2026-09-14 用现有 LINEAR_API_KEY 仅作 GraphQL issue/schema 查询，无 mutation，无 key 输出。

- `Issue.stateHistory(before, after, first, last)` 返回 `IssueStateSpanConnection`。
- span 包含 `id:ID!`, `stateId:ID!`, `startedAt:DateTime!`, `endedAt:DateTime`, `state:WorkflowState`；state可为空，缺状态类型必须判不可读。
- FLY-2557 createdAt=`2026-09-14T19:25:47.346Z`；Backlog span结束、started span开始均为 `2026-09-14T19:26:19.203Z`，即创建后32秒的转换被记录。
- 同一issue顶层 startedAt=`2026-09-14T19:26:19.174Z`，比span早29ms；两个字段不可混用为同一UID。
- 安装的SDK 60.0.0未提供stateHistory类型时，可用项目已有的参数化raw GraphQL request，验证返回结构，不升级整个SDK。
- 普通 `Issue.history` 不适合作为状态流：Linear说明创建后最初3分钟修改可能不进activity log。此次实测证明stateHistory记录了一次早期转换，但不把这一例声称所有快速往返已测试。

来源：[Linear GraphQL官方说明](https://linear.app/developers/graphql)、[Linear webhook官方说明](https://linear.app/developers/webhooks)、本次live schema introspection。GraphQL HTTP200仍须检查errors、分页、非空字段；webhook需公开HTTPS与原始字节签名，不能从代码存在推断生产订阅存在。

## Lead 裁定（已读取并回执）
问题 `e817bcdf-a903-4427-acea-c51da93abbcd` 的完整有效答复：

> (1) No production webhook binding is available to Bridge; do not cross-wire EdgeWorker. Reuse the GatePoller 3s clock with a ~30s per-project intake check placed before the Lead suppression, no new timer, and leave the 60-minute patrol gate untouched for everything else. (2) Stable uid = start of the contiguous started segment from stateHistory, as you propose. (3) First rollout scope: emit one intake per Epic currently in started (its last segment) flagged backfill=true; later segments emit normally; Done/Canceled history never emits. Lead rule treats backfill=true as: verify dependency ledger + one thread line, no re-decomposition. Proceed with the design.

DONE report receipt: `fcc5f2e8-40db-4036-9df0-939c05654bc4`。

## 数据流与持久化边界
1. GatePoller调用轻量due检查，发起单项目single-flight共用Epic扫描；不等待网络而阻塞gate轮询。
2. 查询当前started根、窗口内变化的候选根以及未完成intake对应UUID；取得完整stateHistory，按时间相邻合并started类型。
3. 严格路由一个项目、一个department Lead。事务写intake episode + 原lead_event + 扫描进度；新事件入CommDB发生在提交后。
4. mailbox重驱恢复append→enqueue间崩溃。Lead ACKed是收件完成；业务pending状态继续进入后续patrol。
5. 现有生成器读intake cell，刷新固定页；已提交但未发布的dirty状态随现有时钟重试。
6. Lead读正文和子单、补账本并回帖、记录业务结果，才结束这一episode的pending工作；其后仍按§0.9容量推进。

## 兼容与风险
- FLY-2553远程分支 `5f2308e73` 未包含在当前基线；设计只在其 `<details class="epic">` 摘要中加待拆解态，禁止重造老五段。实施时若已合main先技术同步；未合则保持窄差异并在集成后重验。
- 新项目没有「日常」Epic也必须能收件和显示；采用scope.v3，保留旧scope.v2读兼容，不创建真实日常Epic当测试前置。
- 首次backfill空Epic按Lead裁定不自动重拆；保持待拆解可见、thread一行并由Lead判断下一步，不自动制造founder问题。
- `remainingForLead`与`readyForLead`不加根，单独pending字段防止根成为runner目标。
- 标题、label、正文都只是外部数据；参数化查询、严格路由，HTML转义，日志无凭据。
- 60秒是隔离端到端验收目标；网络超时/限流/Lead不可用须报实际延迟，不能把journal写入当ACK，不能把静态fixture当实机证明。

## 实施验收锚点
- Query: linear-epic-query.test.ts（零子单、无日常、完整分页、重复/乱序span、快速往返、边界过滤）。
- Journal/queue: StateStore新intake测试、lead-event-queue、lead-inbox-runtime（每个崩溃切点、归档后重放、owner冲突）。
- Page: model/generate/materialize/receipt/founder-view/founder-empty/render/render-markdown，旧scope.v2兼容，新scope.v3零子单。
- Patrol: gate-poller-patrol-tick、patrol-tick、patrol-tick-render、epic-residual-scan，pending不改变ready守恒与60分钟grid。
- Rules: lead-rules-bundle、FLY-2557新增规则测试，实际组装Claude/Codexdept bundle。
- Live: 专用测试项目/Lead/频道/Epic及隔离StateStore、CommDB、固定页registry；记录source span→event→mailbox ACK→thread→页时间线。由实现/QA节点执行，设计节点不执行。

## 已收到的有效修订
Lead问题 `cde17197-6e08-4136-9aa0-03058c2e5b98` 初答后，`[lead-instruction da084518-89ac-4ddc-a8ba-231d67cad46e]` 明确替代其第四条件：

> An issue qualifies as an Epic when it has no parent, carries the department label, is in started, AND at least one of: (a) it has one or more child issues, or (b) it has no Flywheel dispatch record in this project (no sessions row / no workflow_run row for that issue id). So: roots with children are Epics regardless of runner history; zero-child roots are Epics only if never dispatched. Everything else in the earlier ruling stands (no Epic label, backfill=true first pass, zero-child backfill = one thread line + Lead decision). Write this into the plan, fix the HIGH, open one new review.

已落实到plan.md §3.4，并同步查询、原子准入、页面、pending失效及测试矩阵。九条advisory按Lead指令只保留Follow-ups，不扩修。此修订是范围裁定；正式review gate仍需新一轮有效APPROVED，不把Lead消息当评审通过。
