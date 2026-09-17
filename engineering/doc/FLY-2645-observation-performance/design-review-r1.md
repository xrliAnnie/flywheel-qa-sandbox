# FLY-2645 observation performance CI 随机红 — 设计评审 R1
Issue: FLY-2645 (https://linear.app/geoforge3d/issue/FLY-2645/cimain-红-observation-performance-计时预算测试在-main-上连红93ms214ms-vs-50ms)
日期: 2026-09-16
基于: plan.md

## 结果

- question: `d3c1670a-c4eb-4b00-bf2e-4d63a3ba6e86`
- request: `1d89d26b-1b16-401b-8086-70636c6aaf64`
- effective verdict: `CHANGES_REQUESTED`
- blocking finding: `misdiagnosed-wal-checkpoint-stall`

## 处置

接受 HIGH。失败 tail 窗口的 voluntary context switches 和 CPU/wall 分离指向 SQLite WAL auto-checkpoint 的同步 I/O，而不是纯 runner 调度抢占。research/plan 已改为在 backlog、tail、modeTick 三组测量前显式 checkpoint、成本单列、原 50/100ms CI 硬门不变。

非阻塞 findings 也随方案收敛：

- 明确引用并保留 FLY-2563 的 CI 性能合同与治理裁定；
- 删除 env policy/helper、report-only 与 invisible warning 方案；
- TDD 改为先要求三条 checkpoint receipts 的确定性红侧；
- package gate 继续执行同一个硬门，不加 `CI` bypass；
- 三次 CI 证据必须记录 checkpoint receipts 与实际 max，未分配 runner 的记录不计。

修改 plan 后必须重新绑定 `design_review` 并开新 gate/request；R1 不作为批准。
