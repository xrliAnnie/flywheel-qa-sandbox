# FLY-3131 在飞空位自动补单 — 探索
Issue: FLY-3131 (https://linear.app/geoforge3d/issue/FLY-3131/epic在飞空位自动补单-按-fly-3103-prd-做开工前先和-annie-过设计)
日期: 2026-10-01
基于: 无(上游产品文档 = product/doc/FLY-3103-auto-refill-slots/prd.md v2.1 与同目录 exploration.md)

> 本文是第二版设计页的现状核实,只读代码 / 文档,不改产品代码。代码引用基于 Flywheel 主仓 main `9fcbdebb1`
> (2026-10-01 只读审计);FLY-3147 引用基于分支 `flywheel-FLY-3147` 上的 design 文档。
> 第一版选择题页:https://fw-reports-6da062.vercel.app/r/d42d6e5d3a63d27c704f7bd57fa1109f/
> founder 结果:**1A 2B 3待定 4A 5A**,附留言(见 §1)。

## 1. 这一轮要回答什么(founder 10-01 留言)

| # | founder 原话要点 | 本轮要交 |
|---|---|---|
| 整体 | 「每 5 分钟只拉 Linear 改过的单」是不是每 5 分钟都算一遍能开工的单?有 capacity 时再算不是更对?两种:① 有 capacity 时算;② 每次 Linear 变化时重算 DAG。怎么读 Linear 变化?Cloudflare 可能能加 webhook | 触发时机对比 + 推荐 |
| 第 1 题(选 A) | 把 A、B 讲清楚:各一张更技术的架构图 / UML 图,各自 pros/cons | A、B 架构图 + 逐条 pros/cons |
| 第 2 题(选 B) | 可以用 Cloudflare 的东西,研究一下 | Linear webhook + Cloudflare 接收方案 |
| 第 3 题(待定) | 需要 deep research:成熟的类似派单系统怎么处理 | ≥5 个成熟系统调研 |
| 4A / 5A | 已定 | 沿用 |

## 2. 现状(和设计直接相关的事实)

### 2.1 Bridge 进程与定时器
- Bridge 在 `packages/teamlead`,`startBridge`(`src/bridge/plugin.ts:6627`),只听本机回环地址(`src/config.ts:56-60`),端口 9876。
- **GatePoller** 是一个 3 秒的 `setInterval`(`gate-poller.ts:555`;`plugin.ts:14474-14488`);后台维护活多数每 20 tick(约 60 秒)搭车跑(`gate-poller.ts:351`)。
- **巡检闹钟**默认 60 分钟(`packages/config/src/patrol-config.ts:9-11`),每个 Lead 用 sha256 偏移分时(`patrol-tick.ts:103-121`);
  投递 = `appendLeadEvent(..."patrol_tick")` 写 `lead_events`(`patrol-tick.ts:449-459`)→ comm.db 邮箱队列(`lead-event-queue.ts:8-55`)→ 唤醒 Lead(`lead-inbox-runtime.ts:705-721`)。
  ⇒ 第 4 题 A「走巡检同一条路投 Lead 收件箱」有现成管道。

### 2.2 「还剩什么」(ready.v1)今天怎么算、为什么坏
- 每次现场从 Linear 全量拉:`epic-residual-scan.ts:189-231` → `fetchLinearActiveScopeSnapshot`(`linear-epic-query.ts:554`),
  先在内存里把整张「项目 Epic 页」建出来,再派生名单。子单查询带每张单的 `description` 和 `inverseRelations`(`:144-165`)。
- 规则 `computeReady`(`epic-page/rules.ts:35-55`):非 Backlog、未终态、挡它的单都完成;按优先级 → 单号;每 Lead 最多 5 张(`residual.ts:393`)。
- 页面上限 `EPIC_PAGE_MAX_DOCUMENT_BYTES = 1_507_328`(`model.ts:20`),超了 422(`epic-page-route.ts:137-142`);
  一次全量拉有 20 秒截止、最多 500 条(`linear-epic-query.ts:560-563`)。FLY-3103 探索记录 Linear 超时 43/200。
- ⇒ 这就是「不存、每次现从 Linear 算」的真实失败样子:**慢、会超时、会超大小**。第 5 题 A 已定「不再依赖那张页,增量算」。

### 2.3 Linear 接入现状
- **生产没有任何 Linear webhook 接收**。`packages/linear-event-transport` 是 Cyrus 时代的 Fastify `POST /webhook`,
  只被旧 `EdgeWorker` 用,teamlead 不构造它;而且它用 `JSON.stringify(request.body)` 验签,不是原始 body(`LinearEventTransport.ts:118-127`)——**不能直接复用**。
- `packages/dag-resolver` 源码已在 `4555e82bc`(FLY-2144)删除,只剩旧 dist。
- 现有轮询:Epic intake 每 30 秒按项目扫「顶层 Epic」,`updatedAt >= 上次 - 120s`(`epic-intake.ts:292-337`;`linear-epic-query.ts:344-357`)——只看顶层,不看子单。
- 没有 429 / 退避处理,只有截止时间。
- **依赖边** = Linear 原生 `blocks` relation(FLY-2142 依赖账本,`dependency-route.ts:669`),理由写在带前缀的评论里;
  Flywheel 自己加/删依赖走 `/api/dependency`(`plugin.ts:5978`)——**这是本地能直接发事件的一类变化**。

### 2.4 「合入 → 空出位子」在代码里的位置
- 合入确认:land executor 发 `:cool:` 后轮询 `gh pr view`(`land-executor.ts:3596-3614`),确认后 `finalize`;
  兜底:runner 自报 `merged`、`external-merge-reconcile.ts` 扫。没有 GitHub webhook。
- 收尾 `runPostShipFinalization`(`post-ship-finalization.ts:949`)从 5 个入口调用(`DirectEventSink.ts:1655`、`event-route.ts:4128`、
  `merge-ship-gate.ts:554`、`external-merge-reconcile.ts:472`、`plugin.ts:9174`)。
- 已有钩子 `notifyEpicChanged(project, "session_completed")`(`event-route.ts:1048`、`:3982`;`DirectEventSink.ts:1472`),但它在 session 状态变化时触发,**早于**收尾,
  不代表合入;补救路径 `merge-ship-gate.ts:579-582`、`external-merge-reconcile.ts:503-506` 用的是 `linear_done` 回调;land 走可恢复 finalizer(`plugin.ts:9198`)。
  ⇒ **今天没有统一的「位子释放」事件**,但所有合入证据都在本地产生,不需要外部推送;新设计要按入口矩阵统一(plan.md §2.2)。

### 2.5 在飞上限
- 代码里**没有数量上限**:`maxConcurrentRunners` 已退役(`runner-admission.ts:1-17`),`/api/runs/active` 返回 `max: null`;
  唯一刹车是机器压力 429。「12 / 14」只在 PRD 和总控页里。

### 2.6 存储
- StateStore = better-sqlite3,WAL,`busy_timeout=5000`(`StateStore.ts:8067-8081`),`~/.flywheel/teamlead.db`。
- 迁移 = `migrate()` 里幂等 `CREATE TABLE IF NOT EXISTS` + `addColumnIfMissing`,无版本号。
- 可照抄的现成模式:游标表 `epic_intake_scan`、outbox `workflow_alert_outbox`、快照 `epic_page`、日志 `lead_events`。

### 2.7 FLY-3147(Bridge 卡顿第 2 步:后台线程)
- **只有设计,没有代码**:分支 `flywheel-FLY-3147`,`engineering/doc/FLY-3147-patrol-worker/plan.md`,design review 第 3 轮 APPROVED。
- 方案:同一 Bridge 进程里**一个常驻 `worker_threads` 巡检线程**;主线程保留 HTTP、Discord、活体 runtime 动作。
  统一任务目录 `bridge/patrol-worker/task-registry.ts`(稳定 taskId / group / cadence / 资源互斥 / effect ports)、主线程唯一 `LockBroker`、
  worker 自己的 SQLite 连接 + 短事务、supervisor 监测并重启、每组独立开关默认主线程、连续启动失败熔断。
- 依赖 FLY-3146(第 1 步,PR #1435,QA 中)。
- 主仓 main 上已有的线程只有 FLY-2920 卡顿观测线程(`BridgeEventLoopGuard.ts`)。

### 2.8 公网入口与 Cloudflare
- **今天没有任何公网入口进本机**。`cloudflared`、`ngrok` 二进制装了,但没有进程、没有 LaunchAgent。
- FLY-3102(Cloudflare 提案第 4 版,Annie 9-30 批):F2 远程控制台在「Cloudflare 隧道(要买自己的域名)还是 Tailscale」之间**还没定**;
  **F7「Linear / GitHub 有变化就主动通知我们」按她 13:02 决定不单开,记到 FLY-3131**,由本单按需去做;
  「用哪个 Cloudflare 账号」也还是待定前提。`payload-endpoint` 是安装包分发用的 Cloudflare Worker,和本单无关。

## 3. 从现状直接推出的设计约束

1. **「空出位子」的证据都在本地**(合入确认 / 收尾 / linear_done),补单的主触发不需要外部推送;但现有钩子没统一,要新做一个按单计的占位与释放记录。
2. **Linear 变化的推送用于缩短拷贝的陈旧窗口**:既让「位子空着、在等能开始的单」更快补上(依赖刚解开、Epic 刚放进 In Progress),也让暂停 / 撤单 / 改优先级更快进拷贝;正确性还要靠对账 + 发送前复核。
3. **Linear 不推送依赖关系的变化**(见 research.md §3.1),所以无论选不选 webhook,都必须保留低频对账轮询。
4. 不能沿用今天「每次从 Linear 全量现拉」的读法(慢 / 超时 / 超大小),必须有本地增量副本。
5. FLY-3147 还没有代码;第 1 题选 A 意味着补单的后台部分排在 3147 骨架之后。
6. 依赖边由 Flywheel 自己的 `/api/dependency` 写入时,可以直接发本地事件,不必等 Linear 回推。

## 4. 未核实 / 要真机验证

- Linear MCP 401,没在真 workspace 上验证:改父单是否带 `updatedFrom.parentId`、改依赖是否刷新 `updatedAt`、删掉的 relation 能否用 `includeArchived` 查到。
- 每个 Epic 的真实子单数没数(同上原因)。
