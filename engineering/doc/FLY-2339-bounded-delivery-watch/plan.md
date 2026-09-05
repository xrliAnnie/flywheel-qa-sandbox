# FLY-2339 有界投递监看 — 实施计划

Issue: FLY-2339 (https://linear.app/geoforge3d/issue/FLY-2339/引擎urgent-2331-之后-eventloopguard-第二层凶手维护-tick-里同步跑的-delivery)
日期: 2026-09-04
基于: research.md

## 0. 目标与锁定边界

目标是删除 maintenance tick 中任何一次可随 delivery 历史无界增长的同步工作块，使 projector/watch/operations 的每个 marker chunk 最多处理 64 个业务对象，并在 chunk 间把控制权交还事件循环。急性根因 `COUNT(DISTINCT batch_id)` 同时获得按 recipient 的匹配索引。

不改 loop guard 阈值、不新增告警层、不改变 FLY-2248/FLY-2278 状态机语义、不增加依赖、不部署。生产日志的 post-deploy 观察属于后续 QA/发布节点。

## 1. 先写 RED：有界页与错误 query plan

新建 `packages/teamlead/src/__tests__/fly2339-bounded-delivery-maintenance.test.ts`，单包 Vitest、fork pool 1/1：

1. 构造超过 64 条 mailbox source，断言 projector 第一次调用最多 examined 64 且返回 continuation；逐 continuation drain 后全部 source 都投影，证明分片不丢语义。
2. 构造超过 64 条 live attempts，断言 watch 单页 observed ≤64；drain 后所有 attempts 均被观察，且 watch 不调用全量 CommDB projection list。
3. 用真实 StateStore 构造超过 64 条 open episodes，断言 operations 单页最多处理 64、continuation 后无饥饿；同样覆盖 pending hold-resume。
4. 用注入 scheduler 验证页间发生 yield；负控为相同页不 yield 时 timer 不前进，并断言 cursor 不前进或超过硬页数时立即中断。
5. 在 CommDB schema/query-plan 测试中断言 `mailbox_runner_inflight_by_recipient` 存在，生产实际 point projection SQL 的 inflight 子查询使用它且不再选择 `mailbox_batch_lookup`；同时断言 mailbox page 使用 `seq` 主键 watermark 与 `LIMIT`。
6. 在 StateStore query-plan 测试中断言 live attempt、open episode 与 pending operation 的分页 SQL 继续使用各自的 live-only partial index，而不是历史表主键。

先在当前实现运行新测试并保存预期 RED：无 continuation、单 pass 超过 64，且 planner 选错 `mailbox_batch_lookup`。

## 2. CommDB：一条索引 + 可选分页

修改：

- `packages/flywheel-comm/src/mailbox-schema.ts`
- `packages/flywheel-comm/src/mailbox-queue.ts`
- `packages/flywheel-comm/src/db.ts`

最小改动：

- schema 与既有连接升级各加入同一 partial covering index：`(to_agent, claim_expires_at, batch_id, delivered_at)`，谓词严格匹配 runner/inbox/LEASED/非空 delivery+batch。
- 三个 projection list 接受可选的 `{ after..., limit }`；未传时保持现有 API/顺序。分页时把 watermark 谓词落到单调主键并 `ORDER BY ... LIMIT ?`。
- projection row 类型补 cursor 所需的 `seq` / `queue_seq`。
- `getRunnerDeliveryProjectionRow(id, now)` 补回 watch 所需的 `inflight_batch_count` 与 `oldest_inflight_delivered_at`，由新 index 保证相关聚合是一次 recipient 范围查，不再全表/全索引扫。

不引入新表或持久 cursor。continuation 只活在一次 maintenance invocation 内；若进程中途退出，下次从第一页幂等重放，不会永久跳过对象。

## 3. StateStore：现有 list 的可选 watermark/limit

修改 `packages/teamlead/src/StateStore.ts`：

- `listLiveWorkflowDeliveryAttempts` / `listUnsettledWorkflowDeliveryAttempts` 增加可选 `afterRootId`、`limit` 与（watch 用）projectName 范围过滤；watermark 与 `ORDER BY root_id` 保持 `idx_wda_live_by_root` 可用，不传 options 时 SQL 与返回保持兼容。
- `listPendingWorkflowHoldResumeOperations` 使用 `operation_id` watermark/同序排序，并增加 pending-only partial index；`listOpenUndeliverableDeliveryEpisodes` 使用 `(root_id, family)` 复合 watermark/同序排序，并增加 open-undeliverable-only partial index。两者均由真 StateStore 的 >64 行 drain 测试证明不跳读。
- `alertStalledWorkflowDeliveryOperations` 每次最多 64 条尚未发过 stalled alert 的 operation；SQL 用 `NOT EXISTS` 排除已有 escalation，避免固定前 64 条饥饿后续对象。

所有参数保持 parameterized，limit 在 TypeScript 边界固定为内部常量，不接受外部输入。

## 4. 三段改为 64-object page

修改：

- `packages/teamlead/src/bridge/delivery-contract/projector.ts`
- `packages/teamlead/src/bridge/delivery-contract/watch.ts`
- `packages/teamlead/src/bridge/delivery-operations.ts`

共用 `DELIVERY_MAINTENANCE_PAGE_SIZE = 64`。

- projector continuation 是带 lane 的 discriminated union（mailbox → phase wake → turn wake → unsettled attempt）。每次总 processed 最多 64；若当前 lane 少于剩余预算，同一页可继续下一 lane，保留现有小 fixture 一次 `runPass` 完成的行为。
- watch continuation 使用 live partial index 的 `root_id`。单页先取本项目最多 64 个 live attempts；mailbox/turn/phase source 只按这批 contract PK 点查，不再构造全 CommDB projection map。点查保留现有 72h terminal cutoff，避免扩大 source 可见性。
- projector continuation 跨页携带 `activeSources`，直到 unsettled lane 完成，保持既有 source-active 判据。
- operations continuation 在 pending hold-resume 与 open undeliverable episode 两 lane 间推进；正常 drain 的最终页执行 capped stalled-operation alert scan；若前置 lane 抛错，plugin 的 abort 路径仍强制执行一次 capped stalled scan。
- continuation 仅在确有后续页时作为可选 `nextCursor` 加到返回值；小型现有测试的 exact result object 不变。

逐 attempt 的 try/catch、fail-closed 行为、状态转换和告警文案不改。

## 5. Plugin：marker 每页包裹，页间 yield

修改：

- `packages/teamlead/src/bridge/event-loop-yield.ts`
- `packages/teamlead/src/bridge/plugin.ts`

加入一个小型 stdlib-style helper：反复调用同步 page callback，拿 `nextCursor`，每页后调用既有 `yieldToEventLoop()`。helper 用 cursor 的稳定序列化值断言每页严格前进，并以 10,000 页为硬上限；违约时抛错，由 plugin 现有 fail-closed warning 路径终止本轮，而不是永久占住 `maintenanceInFlight`。plugin 对 projector/watch/operations 依次 drain；`withSyncOpMarker("delivery-contract:...")` 只包一页，而不是包整个历史扫描。

仍保持三个段的既有顺序，仍复用同一个按项目打开的 CommDB 连接，finally 仍关闭连接。不会用 `setImmediate` 假装让单个无界 SQL 异步；真正同步工作已先由 SQL watermark + 64 行上限切开。

## 6. GREEN、回归与生产快照对比

按 TDD 顺序跑：

```bash
pnpm --filter flywheel-teamlead exec vitest run --pool=forks --poolOptions.forks.maxForks=1 --poolOptions.forks.minForks=1 packages/teamlead/src/__tests__/fly2339-bounded-delivery-maintenance.test.ts
pnpm --filter flywheel-comm exec vitest run --pool=forks --poolOptions.forks.maxForks=1 --poolOptions.forks.minForks=1 packages/flywheel-comm/src/__tests__/<touched-test>.test.ts
```

路径需按各包工作目录修正为 `src/...`。随后跑所有触及的 delivery-contract / event-loop / CommDB query-plan 测试，同样固定 fork 1/1。

从在线库重新取得 fresh backup，在新代码上记录：

- watch 第一页、最大页、完整 drain 的 elapsed 与 observed；
- projector/operations 最大页与完整 drain；
- 原完整 inflight projection SQL 的新 EQP/elapsed；
- 前值：SQL 82.75s、watch 32.543s、projector 5.446s、operations 214ms。

单页上限由确定性 row-count 测试证明；墙钟只做生产快照验收证据。

## 7. 全仓门、审查与 PR

实现完成后依次：

1. `pnpm lint`
2. `pnpm -r build`
3. `pnpm test:packages:run`（按项目红线排除会打开 macOS Terminal 的真实 GUI 测试；若顶层命令无法排除则先确认脚本本身已有 capability gate）
4. 每个新增/触及的 `scripts/__tests__/*.test.sh`（预期本单无新增）
5. 通过 `codex:rescue` 发起 code review；按 codex-author 协议注册 `review_code` gate，CHANGES 必须修后开新 gate。
6. 早开 PR；进入审查后冻结 head。PR 建好后把 `engineering/doc/milestones/FLY-2339.md` 作为字面最后一个 commit，不改 `CLAUDE.md`。
7. 写 implement runner memory closeout（若无可复用新判断则明确 unchanged），通过唯一 report channel 汇报，再 `complete --route needs_review --pr <NUMBER>`。

## 8. 验收矩阵

| 要求 | 证明 |
|---|---|
| 找到真实耗时/行数/表与 query | `research.md` 的生产快照计数、EQP、拆分计时、prepare 计数 |
| 不调 guard 阈值 | diff 中无 loop-guard/config threshold 改动 |
| 三段同步工作有界 | 每页 ≤64 的结构测试 + plugin 页间 yield 测试 |
| 分页本身不扫历史 | StateStore EQP 使用 live/open/pending partial index |
| drain 不会静默自旋 | cursor 严格前进 + 10,000 页硬上限的负向测试 |
| watch 不再全量扫描 CommDB | spy 断言无 full-list；按 contract PK 点查 |
| 急性 62s 查询拆除 | production snapshot EQP 使用 recipient index，前后 elapsed |
| 语义不丢 | continuation drain 后投影/观察/operation 全部收敛 |
| 部署后不再命中 marker | 后续 QA/发布观察 loop-guard 新增行；本 PR 不伪称已证明 |
