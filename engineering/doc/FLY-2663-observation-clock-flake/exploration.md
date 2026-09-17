# FLY-2663 observation 墙钟去 flake — 探索
Issue: FLY-2663 (https://linear.app/geoforge3d/issue/FLY-2663/ci去-flake-observation-performance-墙钟阈值断言50ms100ms在共享-runner)
日期: 2026-09-16
基于: 无

## 问题边界

`packages/teamlead/src/ship-judgment/__tests__/observation-performance.test.ts`
在 required CI 的独立 matrix row 中用真实 `performance.now()` 采样，再断言观察页
`<50ms`、`modeTick()<100ms`。这把宿主调度、GC、SQLite fsync/WAL checkpoint 和算法行为
绑定成同一个硬门。FLY-2645 把可识别的 WAL checkpoint 移出测量窗口，但没有消除共享 runner
的墙钟噪声；FLY-2601 的 docs-only head 仍因此被挡。

本 issue 只处理测试/CI 判据，不改变 `ShipJudgmentOutcomes`、`ShipJudgmentRuntime` 或 land
的运行时策略，也不处理 FLY-2098 的 `policy_blocked` 自愈。

## 已确认事实

- 目标测试是 `Unit (observation performance)` required matrix row，teamlead 普通四 shard 明确排除它。
- 生产观察器已经公开 `pageStats()`，包含 `sourceCandidates`、`holderCandidates`、`outcomes`、
  cursor 和 deferred 计数；观察页另有 `LIMIT 8/16/32` 与 holder 上限，可直接证明单页工作量。
- 现有 1.7M event / 500 holder fixture 已证明 backlog、steady、tail 与两种 mode 的功能结果，
  但最后的 max wall-clock 断言不能证明算法复杂度。
- 仓库还有真实 `Date.now()`/`performance.now()` 差值再与 `toBeLessThan(...)` 比较的 required
  tests；同时也有同文件误命中（时钟只用于 ID/业务时间，而 `<` 比较的是顺序或长度）。

## 假设与测试 seam

1. “required checks 清单里不再有绝对墙钟断言”指 required test sources 中的行为断言，
   不禁止产品代码记录 elapsed telemetry，也不禁止 test runner 自身的 hang timeout。
2. 对观察器，公共 seam 是 `observeCancellations()` / `pageStats()` 与 `modeTick()` 后可读的
   StateStore/spy 结果；不通过私有方法或 SQL side channel 重新计算同一个答案。
3. 对超时/死锁测试，公共 seam 是 timeout/abort/error/status/latch 等结果；测试框架的有限
   timeout 仅防永久挂死，不作为通过断言。
4. 对大数据测试，公共 seam 是候选数、分页数、cursor 前进、query plan 和完整输出数；这些
   是独立于 runner 调度的复杂度证据。
5. 上述 seam 由本文件与 `plan.md` 明示，并以 design review 的有效 verdict 作为确认。

## 方案比较

### A. 放宽为相对基线

同机基线能抵消部分宿主差异，但两段测量仍可能遭遇不同调度/GC/fsync，且比例在分母很小时
不稳定。它仍让 required gate 依赖真实毫秒，不选。

### B. 保留 real-time benchmark，改成 non-blocking job

可以保留趋势信号，但当前仓库没有这个指标的告警消费/基线治理；单独引入 non-blocking job
会扩大 CI surface。若删除真实计时后仍能由复杂度/功能 seam 覆盖，本 issue 不新增 benchmark。

### C. 假时钟 + 复杂度/状态断言（选择）

- 观察器固定 clock，让 deadline 分支确定；断言每页候选上限、cursor/结果与 steady no-op。
- timeout 类测试用 fake timers 或可观察的 abort/error/result，不比较宿主耗时。
- 大数据类测试保留规模夹具，改断言扫描/分页/query-plan 上限。
- 新增仓库级 required-test guard，静态列出仍把 wall-clock 值送入 `toBeLessThan` 的位置；
  先让 guard 在旧代码上红，再逐项消除到绿。

这条路径不削弱产品运行时的 25ms/timeout budgets，只去除 shared runner 作为判定依据。

## 范围外

- 不改生产 budget 数值、观察算法或 SQLite 配置。
- 不新增/迁移 non-blocking perf workflow，除非实现阶段发现复杂度 seam 无法覆盖。
- 不修 FLY-2098，不 merge、deploy、restart 或 dispatch QA。
