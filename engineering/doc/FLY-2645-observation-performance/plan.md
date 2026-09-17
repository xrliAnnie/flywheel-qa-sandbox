# FLY-2645 observation performance CI 随机红 — 实施计划
Issue: FLY-2645 (https://linear.app/geoforge3d/issue/FLY-2645/cimain-红-observation-performance-计时预算测试在-main-上连红93ms214ms-vs-50ms)
日期: 2026-09-16
基于: research.md

## 目标

消除 `observation-performance.test.ts` 因 WAL auto-checkpoint 随机落入 tail 计时窗口造成的 CI 红，同时保留：

- 170 万事件、500 holders 的真实 SQLite 规模路径；
- drain、25,000 outcomes、page stats、零 `onError` 等功能硬断言；
- 每类 wall time、CPU time、GC、context switches 的机器可读性能报告；
- CI 与本地一致的 50ms（observer）/100ms（modeTick）性能硬门；
- checkpoint I/O 的独立性能收据。

## 锁定范围

只改 `observation-performance.test.ts` 的 fixture 测量边界。production `outcomes.ts`、`runtime.ts`、`observation-cursor.ts`、`StateStore.ts` 和 `.github/workflows/ci.yml` 不改。不会用更大的阈值、稳健统计或 report-only 替换 50/100ms，也不会关闭 SQLite auto-checkpoint 或降低功能/规模断言。FLY-2563 的原 CI 性能验收合同保持有效。

## TDD 步骤

### 1. 先写 checkpoint receipt 不变量（红）

在现有性能测试中新增 `checkpoints` 收据数组与末尾硬断言，要求 phase 顺序严格为：

1. `before_backlog`；
2. `before_tail`；
3. `before_mode_tick`。

每条还要求单连接 fixture 的 checkpoint `busy=0`、WAL after bytes 为 0。先不增加 checkpoint 调用，运行现有性能文件，确认因收据为空而确定性失败；不依赖碰巧出现 50ms 尖峰作为红侧。

### 2. 最小 checkpoint 记录器（绿）

在同一测试文件内增加局部 `checkpoint(phase)`：测量 wall/CPU/resource deltas，记录 `${path}-wal` 的 before/after bytes，执行 `db.pragma("wal_checkpoint(TRUNCATE)")` 并保存 SQLite receipt。不设 checkpoint 时间预算，不吞 `busy`/异常。

把原来 fixture 准备后的直接 checkpoint 改为 `checkpoint("before_backlog")`；drain/outcome 数量断言之后、第一条 tail event 之前调用 `checkpoint("before_tail")`；五个 tail 样本之后、构造 mode runtimes 之前调用 `checkpoint("before_mode_tick")`。

### 3. 保持原性能门与报告

- 保持现有采样、功能断言和 console JSON；
- 在同一个 JSON 中加入 `checkpoints` 收据；
- backlog/steady/tail 仍逐类 max `<50ms`；两个 modeTick 模式仍 max `<100ms`；
- checkpoint 耗时不混入这些样本，也不拿本地快盘阈值约束 hosted runner fsync。

不以 CPU time 替换 wall-clock 门；CPU/context-switch 只用于诊断。production 中 auto-checkpoint 的同步事件循环成本是独立 follow-up，不在本单改 StateStore 或 runtime。

### 4. 聚焦验证

运行：

```bash
pnpm --filter flywheel-teamlead exec vitest run src/ship-judgment/__tests__/observation-performance.test.ts
node --test scripts/__tests__/teamlead-shards.test.mjs
bash scripts/__tests__/ci-matrix-coverage.test.sh
bash scripts/__tests__/ci-structure.test.sh
```

性能文件红/绿两次的原始输出作为 TDD 收据；绿侧 JSON 必须含三条 checkpoint receipt、每条 after bytes 0，且原 50/100ms assertions 实际执行。三条结构测试证明专用 perf job 仍在 CI、仍从普通 shard 排除且命令未降级。

### 5. 全仓门

运行 `pnpm lint`、`pnpm -r build`、`pnpm test:packages:run` 以及相关的 `scripts/__tests__/*.test.sh`。package gate 仍会在本机执行硬门；不得用 `CI=true` 或 override 绕开。如 aggregate 仅出现已允许的 onTaskUpdate RPC 环境错误，按 PACKAGE_GATE_RECEIPT 分项记录；其它断言失败必须修复或如实报告。

### 6. 评审、PR 与 CI

- 请求 effective code review；blocking finding 修复后重新评审。
- commit/push feature branch，开 PR，不 merge、不 dispatch QA。
- milestone `engineering/doc/milestones/FLY-2645.md` 必须是 literal last commit。
- 在同一最终 head 上取得 3 次 CI green 证据，逐次记录 run URL、三条 checkpoint receipt、各类 max 与 aggregate 结论；未实际执行的 `runner_id=0` 记录不计数。
- 通过 `complete --route needs_review --pr <number>` 交接。

## 回滚

回滚性能测试内的 checkpoint 收据/调用即可；production 字节不受影响。回滚会恢复已证实的 WAL 相位随机红，因此只应在替代的测量隔离方案已验证后进行。
