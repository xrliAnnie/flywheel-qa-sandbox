# FLY-2339 有界投递维护 — 验证

Issue: FLY-2339 (https://linear.app/geoforge3d/issue/FLY-2339/引擎urgent-2331-之后-eventloopguard-第二层凶手维护-tick-里同步跑的-delivery)
日期: 2026-09-04
基于: design-correction.md

## 1. 生产快照

修复后重新从在线 `teamlead.db` / `comm.db` 取得一致性副本，只在副本上打开新版 schema 并运行三段 maintenance。该批副本约含：

- `workflow_delivery_attempt` 4,330 行，其中 live 112 行；
- `mailbox` 20,521 行；
- projector 候选 3,662 行；
- open undeliverable episode 约 88 行、pending hold operation 6 行。

首次打开副本并创建新索引分别约 0.5–0.9 秒；后续重开为几十毫秒。副本运行中未出现 `SQLITE_BUSY`。这只证明离线快照升级路径；在线部署观察仍由后续节点执行。

## 2. 前后耗时

| 段 | 修复前 | 修复后处理量 | 修复后最大同步页 | 修复后完整异步 drain |
|---|---:|---:|---:|---:|
| projector | loop guard 64.303s / 63.041s；临时补 acute index 后仍 5.446s | 3,662 行 / 59 页 | 181.625ms | 2,509.019ms |
| watch | 32.543s / 110 observed | 112 observed / 2 页 | 97.680ms | 159.730ms |
| operations | 214ms | 38 examined / 1 页 | 201.320ms | 201.330ms |

projector 的完整 drain 仍超过 `<1s` 优化目标，但它已被拆成 59 个最多 64 对象的同步 marker，并在每页后 `setImmediate` yield，单次阻塞上限实测 181.625ms。最长连续同步阻塞相对 64.303s 事故值下降超过 350 倍。Lead 已裁定整轮 wall time 不阻塞本单；最大同步页、页间真 yield、cursor 严格前进和页数硬上限四项均通过，因此本项 verification 为 PASS。

### drain 期间 HTTP 响应

另一次同族生产快照副本实测用 Node 标准库启动本地 HTTP server，并由独立 worker 在线程外持续请求 `/health`。projector 在主线程处理 3,660 行/59 页、完整 drain 2.133s（最大同步页 148.781ms）期间，52 个探针全部收到响应：p95 119.245ms、最大 137.965ms。探针延迟与单页耗时同量级，证明 `setImmediate` 页间 yield 确实让 HTTP 事件得到调度，而不是只把同一无界同步块包成 Promise。

### 增长与硬上限

页数随本轮候选对象数 `N` 约按 `ceil(N / 64)` 增长；lane 切换会利用当前页剩余预算，边界上最多增加常数量级。当前 3,662 行跨四个 lane 得到 59 页。`drainSynchronousPages` 对 cursor 做严格前进检查，并在 10,000 页后 fail closed，因此单轮最多处理 640,000 个对象，不会因持续增长变成无限同步循环。

## 3. Query 与扫描边界

62 秒急性根因位于 `comm.db.mailbox`：`listRunnerDeliveryProjectionRows` 中按每个候选 recipient 计算 `COUNT(DISTINCT active.batch_id)` 的相关子查询。原 planner 使用 `mailbox_batch_lookup`，单这条聚合在生产快照强制消费即 57.44 秒；完整 projection SQL 为 82.75 秒。

新版：

- 使用 partial covering index `mailbox_runner_inflight_by_recipient(to_agent, claim_expires_at, batch_id, delivered_at)`；实际 point projection SQL 的两个相关子查询均命中该 index；
- projector 的 mailbox list 不需要 inflight 字段，因此直接投影常量，不再执行两个相关聚合；
- watch 不再物化整张 CommDB projection，而是对本页最多 64 个 live attempts 做 PK point lookup；
- StateStore 的 live attempt、open episode、pending operation 分别使用 `idx_wda_live_by_root`、`idx_wdce_open_undeliverable_by_root`、`idx_wdo_pending_hold_by_id`；episode EQP 明确为 `SEARCH`，并拒绝 `SCAN`。

## 4. 可执行回归

单包 fork 1/1 定向结果：

- teamlead：3 个触及测试文件，24 tests passed；
- flywheel-comm：2 个触及测试文件，12 tests passed；
- `pnpm --filter flywheel-teamlead build` passed；
- `pnpm --filter flywheel-comm build` passed。

回归固定：每页最多 64、超页 drain 不漏读、cursor 不前进和 10,000 页上限会 fail closed、三段逐页 yield、operations 异常仍执行 capped stalled scan、真实 SQL 使用目标索引、新 drain 不继承上一轮 projector active-source 缓存。

## 5. Base-refresh rework（epoch 3）

引擎以 QA 头 `e1b179ecbc8d5f96fa873aaabca7500d34e9476b` 和 base
`c638ee33fc0ab0b923b71a3e612272c521bf868c` 签发 rework。实现节点把最新
`origin/main=c03d312ca0c9ddca04378642d096b3ff2a436b8f` 以普通 merge 合入；merge commit
`2ac1e767f` 保留 FLY-2339 的三段分页 drain，同时保留 main 新增的 resident-expiry 状态机与
plugin 接线，没有 force-push。PR #1089 在随后 progress 头
`fd12c1e7e5a152cd234705663d50b11770c108c2` 为 `CLEAN`。

定向 Vitest 均为单包 forks 1/1：

```sh
pnpm --filter flywheel-comm exec vitest run \
  src/__tests__/db.fly2248-delivery-reroute.test.ts \
  src/__tests__/mailbox-query-plans.fly2139.test.ts \
  src/__tests__/db.fly2268.test.ts \
  --pool=forks --poolOptions.forks.maxForks=1 --poolOptions.forks.minForks=1
# 3 files / 31 tests passed

pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/fly2339-bounded-delivery-maintenance.test.ts \
  src/__tests__/event-loop-yield.test.ts \
  src/__tests__/fly2248-mechanism-guards.test.ts \
  src/__tests__/fly2248-migration-contract.test.ts \
  src/__tests__/fly-2006-database-retention-sweep.test.ts \
  src/__tests__/fly2139-query-plans.test.ts \
  src/__tests__/bridge-child-process-census.test.ts \
  src/__tests__/fly2268-mechanism-guards.test.ts \
  src/__tests__/fly2268-resident-expiry.test.ts \
  --pool=forks --poolOptions.forks.maxForks=1 --poolOptions.forks.minForks=1
# 9 files / 59 tests passed
```

首次只跑 teamlead 时，两个 FLY-2268 文件因 workspace 仍加载 merge 前的
`flywheel-comm/dist` 出现 3 个预期红灯（新方法/列不存在）；先执行
`pnpm --filter flywheel-comm build` 后相同两文件 7/7 转绿，证明原因是陈旧依赖产物，不是用补丁
绕过。最终 `pnpm -r build` 与 `pnpm lint` 退出 0（lint 仅 14 条 main 既有 warning）。精确头
`fd12c1e7e` 的 GitHub Actions run `33930695668` 13/13 checks 全绿。

## 6. 部署后判据

本节点不部署或重启 Bridge。发布后必须观察 `~/.flywheel/bridge-loop-guard.log`，确认新 build 之后不再新增 `last_sync_op=delivery-contract:projector|watch|operations`；当前文档不声称这项已经完成。
