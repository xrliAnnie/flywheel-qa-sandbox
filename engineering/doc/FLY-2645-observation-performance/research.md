# FLY-2645 observation performance CI 随机红 — 调研
Issue: FLY-2645 (https://linear.app/geoforge3d/issue/FLY-2645/cimain-红-observation-performance-计时预算测试在-main-上连红93ms214ms-vs-50ms)
日期: 2026-09-16
基于: exploration.md

## 结论

这不是 #1219/#1221 引入的 observation/modeTick 回归。失败窗口的 voluntary context switches、CPU/wall 分离和测试相位共同指向一个可控机制：drain 阶段留下的 WAL 在 tail 写事务中随机跨过 SQLite 默认 1000-page auto-checkpoint，Linux runner 的同步 checkpoint I/O 被算进 50ms observer 预算。修法是在每组测量前显式 `wal_checkpoint(TRUNCATE)`，把 checkpoint 成本单列报告，再继续用原有 50/100ms CI 硬门测 observer/modeTick；不放宽、不 report-only。

## 被测字节核对

以下七个头的四个被测关键 blob 完全相同：

| 文件 | Git blob |
| --- | --- |
| `observation-performance.test.ts` | `65dae1c220f30cccb65805a7c3364d15ee6b0d0b` |
| `outcomes.ts` | `ecee2e7406d84b1a4ada3b746bfb77e9188c3267` |
| `runtime.ts` | `1ac794bc858d0188da12c1f85dd1a370c0e43068` |
| `observation-cursor.ts` | `3dad19c87e81157af3ed303eff4a99739dad189e` |

核过的 heads：`bd8a1f7b9`、`b2f0c3e61`、`009eeb517`、`b765d2735`、`1de148104`、`eead9e67d`、`f678d2419`。因此 #1219/#1221 没有改变 observer、runtime 或性能 fixture 的执行字节。

## 同型 runner 分布

所有数据来自 CI 的独立 `ubuntu-latest` job，日志均证明 `availableParallelism()=2`、Vitest 单 fork。表中 wall/CPU 是失败窗口本身，不是整项测试。

| Head / run | 结果 | backlog max | tail max | 异常 tail CPU | context switches | 证据 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `bd8a1f7b9` / 35120905715 | PASS | 27.81ms | 8.83ms | — | — | [run](https://github.com/xrliAnnie/flywheel/actions/runs/35120905715/job/104878704131) |
| `b2f0c3e61` / 35122819904 | FAIL | 14.84ms | 93.50ms | 8.04ms | 3 involuntary, 20 voluntary | [run](https://github.com/xrliAnnie/flywheel/actions/runs/35122819904/job/104884976872) |
| `009eeb517` / 35140191455 | FAIL | 22.23ms | 54.82ms | 8.78ms | 0 involuntary, 26 voluntary | [run](https://github.com/xrliAnnie/flywheel/actions/runs/35140191455/job/104942605663) |
| `b765d2735` / 35140038566 attempt 1 | FAIL | 12.22ms | 213.87ms | 10.64ms | 0 involuntary, 16 voluntary | [run](https://github.com/xrliAnnie/flywheel/actions/runs/35140038566/attempts/1) |
| `b765d2735` / 35140038566 attempt 2 | FAIL | 12.49ms | 64.75ms | 10.43ms | 0 involuntary, 11 voluntary | [run](https://github.com/xrliAnnie/flywheel/actions/runs/35140038566/attempts/2) |
| `1de148104` / 35125461411 | PASS | 13.49ms | 6.09ms | — | — | [run](https://github.com/xrliAnnie/flywheel/actions/runs/35125461411/job/104893437391) |
| `eead9e67d` / 35134814067 attempt 2 | PASS | 14.86ms | 7.92ms | — | — | [run](https://github.com/xrliAnnie/flywheel/actions/runs/35134814067/job/104930869132) |
| `f678d2419` / 35140007235 | PASS | 22.02ms | 9.64ms | — | — | [run](https://github.com/xrliAnnie/flywheel/actions/runs/35140007235/job/104941977924) |

失败样本的 wall/CPU 比分别约 11.6x、6.2x、20.1x、6.2x；同一窗口没有 GC 交叠，CPU 仍处在健康样本量级。关键修正是：这些异常窗口有 11–26 次 voluntary context switches，而健康 tail 窗口通常为 0；这不是纯调度抢占的形状，而是同步 I/O 等待。`b2f0c3e61` 的 backlog、steady、modeTick 没有整体变慢，只有单个 tail 写事务膨胀，排除了 #1219/#1221 的持续算法回归。

`StateStore` 使用 WAL、`synchronous=NORMAL`，没有改写 SQLite 默认 `wal_autocheckpoint=1000`。性能测试只在 170 万行准备结束后、backlog 测量前做了一次 `wal_checkpoint(TRUNCATE)`；因此 backlog 稳定。随后 drain 产生大量写事务，进入 tail 前却没有重置 WAL 相位。tail 每轮又先 `insertEvent()` 再在 `observeCancellations()` 的 transaction 中写 cursor/outcome，随机某一轮 commit 会内联 auto-checkpoint。设计评审的只读本地探针也观察到：60 个 tail 窗口中恰好 4 个发生主库 checkpoint，且恰好是仅有的 voluntary-switch 窗口。

FLY-2563 的批准合同明确要求固定单 worker CI 保持 `<50ms`/`<100ms` 阻塞门；其 implementation 还记录了 `flaky-wallclock-perf-job-in-required-ci` finding 已被治理裁定 overruled。FLY-2645 不推翻该合同，只修正 fixture 的 WAL 相位污染，并把 checkpoint 自身作为独立性能收据保留。

## 精确头补跑说明

按交付要求启动了 `bd8a1f7b9` 与 `b2f0c3e61` 的历史 job replay。并行和后续串行 replay 的目标 perf job 都在分配 runner 前失败：`runner_id=0`、无测试日志，GitHub annotation 为账户计费/额度准入；这些记录不是性能样本，全部排除，不能伪报成 3 次分布。七个头的关键 blob 相同、同日已有 4 个失败与 4 个通过的真实同型 runner 样本；失败只出现在带 voluntary wait 的单次 tail transaction，足以把下一步收敛到 WAL checkpoint 隔离。最终修复仍必须在新 exact head 上取得 3 次真实 CI 绿。

## 方案比较

### 放宽绝对预算

把 50ms 改成 250ms 会掩盖 observer 真回归，也违反 FLY-2563 已批准合同。否决。

### 相对基线

同进程构造额外基线会增加 fixture 时间与模型假设；已定位的机制可以直接隔离，不需要替换验收尺度。否决。

### CI 非阻塞报告

这会推翻 FLY-2563 治理裁定，并让真实回归只藏在绿色 job 日志中。否决。

### 测量前显式 checkpoint，成本单列

采用。保持 SQLite 默认 auto-checkpoint 与 production 代码不变；仅在 fixture 的 backlog、tail、modeTick 三组测量前显式 `wal_checkpoint(TRUNCATE)`。每次记录 wall/CPU/context switches、WAL bytes before/after 与 SQLite `{busy,log,checkpointed}`，证明 checkpoint 没有混入被测窗口。50/100ms 断言在本地和 CI 都继续阻塞。

## 验证要求

- TDD 红侧先要求三个 checkpoint receipt，在没有调用时确定性失败；绿侧再加入最小 checkpoint 函数与三处调用。
- 性能 JSON 包含三个 checkpoint 的独立成本与 WAL before/after；单连接 fixture 中 `busy=0` 且 after bytes 为 0。
- 本地和 CI 都继续执行原 50/100ms 断言；不增加 env bypass。
- focused tests、`pnpm lint`、`pnpm -r build`、`pnpm test:packages:run`、相关 shell CI 结构测试均通过。
- 当前 PR 最终 exact head 连续取得 3 次真实 CI green；逐次记录 perf job URL、checkpoint receipts 与各类 max，`runner_id=0` 不计。
