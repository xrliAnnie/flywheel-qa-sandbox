# FLY-2563 Bridge 响应与连接寿命 — 探索
Issue: FLY-2563 (https://linear.app/geoforge3d/issue/FLY-2563/bridge-ship-judgment-modetick-每-3s-同步跑)
日期: 2026-09-14
基于: 无

## 问题与目标

Bridge 是全舰队的请求入口。周期性查账占住主线程、数据库连接未及时关闭，各自都能使请求失去响应。本单同时修这两个必要条件；不把原先误归因的冷归档扫描当成主因。

事件循环是 Node 接收请求和执行回调的主线程；同步 SQLite 调用完成前它无法接待下一位请求。fd（文件描述符）是进程持有文件或网络连接的系统名额；数据库未关闭也会占名额。

## 权威来源与观察边界

- 用户更正后的事故描述是事件时间线来源：3 秒 modeTick / 约 3 秒 observeCancellations；生产临时索引约降至 0.34 秒；启动软限 256；长期连接增长。
- 本次基线：branch `flywheel-FLY-2563`，代码基于 `6af2b8990`，design TURN epoch=1。无既有 FLY-2563 产物。
- 本地只读检查指定事故备份，未打开生产数据库、未更改开关、未重启。备份包含 1,687,121 条 session_events、536 个 holder、2,729 条 closeout_report；`MAX(id)=8016867` 是身份上界，不能冒充行数。
- 备份**已经**包含 `idx_session_events_closeout_canceled`，并非无索引的原始事故状态。旧 SELECT 空结果仍为 350.41ms；计划为 holder → run → canceled index → outcome，带排序临时树。见 `snapshot-probe.json`。这不是修复后的性能结果。
- 当前 `/health` 能返回 `event_loop.p99_ms/max_ms/episodes`；不意味着已满足连续 15 分钟验收。此次未测生产 fd、两小时稳态或部署后的行为。

## 已定位的代码

| 位置 | 已确认事实 | 后果 |
|---|---|---|
| ship-judgment/runtime.ts:71–137 | 3 秒 setInterval；同步读 verdict、closeout、clarification，然后 await 网络 sweep | async 函数本身不能让同步 SQL 让出线程 |
| ship-judgment/outcomes.ts:123 | 从历史 holder/event 联表，过滤 JSON，最后 LIMIT 50 | LIMIT 只限制结果，不能限制扫描量 |
| outcomes.ts:402 附近 | verdict 以未产生 outcome 的 anti-join 寻找历史记录 | 未找到关联的历史行可能每次重试；无持久化输入水位 |
| bridge/plugin.ts:13539 | notifyLeadInstruction 临时 new CommDB 后丢失对象，无 close | 每次通知可能残留连接，等待 GC 不算寿命管理 |
| bridge/plugin.ts:13575 | scanZombiesWired 每项目 new CommDB.listSessions，无 close | 周期调用累计；确定的泄漏路径，不再仅猜测 HTTP 路由 |
| bridge/gate-poller.ts | 部分句柄在 finally 关闭，但跨 await 网络/唤醒存活 | 必须测试挂起与异常，不能用“有 finally”代替有界寿命 |
| bridge/commdb-lead-runtime.ts:48 | legacy runtime 每 Lead 常驻一连接，shutdown 才关闭 | 可关闭但可能超出按项目计的稳态指标；改为同步操作作用域 |
| bridge/event-loop-attribution.ts | 已有 30 秒窗口 lag 与事件记录 | 扩展现有指标，不新建同名采样系统 |
| terminal-row-archive.ts | 时间 keyset 与页预算存在；昂贵资格/JSON 判断仍在 LIMIT 前，游标 WeakMap | 次要风险：先限候选行，再过滤；持久化进度 |

完整发现清单：`commdb-open-sites.txt`（104 处 Bridge 文本命中；含 factory，不等于 104 个泄漏）、`timer-sites.txt`。实施时按真实 ownership 和数据库入口逐项归类，不能把文本命中当作运行证据。

## 三种方案

1. **仅索引 + 提高 fd 上限**：部署最小；备份约 350ms 仍超过 50ms，而且泄漏继续增长。拒绝作为最终修复。
2. **持久化水位 + 有界源事件页 + 及时 close + 资源监测（选择）**：不改变审批语义；工作量跟新事件及一个有界页相关，重启可续跑。需要处理事件一对多、时间乱序和失败原子性。
3. **所有 SQLite 迁到 worker / 新数据库服务**：隔离更彻底，但重写事务、连接和授权读取边界，超出本单；仅当实测证明页内处理仍不能达到预算时，另行设计，不能用调大测试阈值替代。

## 已解决的歧义

Lead question `90054f86-ebf0-4256-ab41-9b1d37213565` 回复：终态证据**不得排除**；新事件按精确身份处理一次，例行 holder reconciliation 只查非终态，重放无副作用。确认两处漏 close 纳入第 7 条；保留 holder 表和 swap 阈值，第 10/11 条可暂缓。

这里“消费一次”指持久化效果一次；崩溃可能使一页再次执行，由已有唯一 outcome 身份和事务保证重放不增记。终态证据的首次补读不是终态卡全量复扫。

## 成功标准与不变量

- A：指定备份的隔离工作副本，修复后 observeCancellations 一次 <50ms；包含候选获取、验证与事务写入，不能仅测空查询。
- B：Bridge 启动后连续 15 分钟 health p99<300ms，event-loop lag<100ms。
- C：3 秒 tick 不全表复扫；水位、候选数、页预算与重启连续性有证据。
- D：回归与必要类型检查 CI 通过。夹具 ≥1.7M session_events +500 holder；modeTick 一次 <100ms。
- E：运行 2 小时，按同一 PID 采样 comm.db 的**数字 fd**，无单调增长，两次可比采样差≤6；稳态≤3×项目数×2。
- F：health 返回 fd.used/fd.limit，生产启动 limit≥8192；>80% warn + unified alert。
- 次要归档：单次 <200ms；≥100k 大 payload 回归；真实大库连续 20 次有进展；重启游标不回零；所有旧保护/还原语义不变。
- 审批、founder identity、冻结 head、取消归因、原有 outcome 身份均不变；不改自动审批 mode，不删历史 holder。
- 本节点只交文档、评审与 HTML；性能验证/迁移执行/部署属于后续阶段。
