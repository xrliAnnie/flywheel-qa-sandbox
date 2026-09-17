# FLY-2645 observation performance CI 随机红 — 探索
Issue: FLY-2645 (https://linear.app/geoforge3d/issue/FLY-2645/cimain-红-observation-performance-计时预算测试在-main-上连红93ms214ms-vs-50ms)
日期: 2026-09-16
基于: 无

## 问题边界

`observation-performance.test.ts` 在独立的 GitHub Actions `ubuntu-latest` job 中构造 170 万条事件与 500 个 holder，随后对 backlog、steady、tail 的 5 个真实壁钟样本逐类断言最大值 `< 50ms`。同一测试既承担功能/规模回归验证，又把共享 runner 的单次 wall-clock 尾值作为 land 硬门。

本单只处理这条硬门的随机红：先验证 #1219/#1221 是否改变被测路径，再用同一 runner 类型对 `bd8a1f7b9` 与 `b2f0c3e61` 各取得 3 次分布。不会改 production observer 的数据语义、分页预算或 mode 行为，也不会借机清理其它 CI。

## 已知事实

- `bd8a1f7b9` 的原始 2 CPU、单 fork job 通过：backlog max 27.81ms、tail max 8.83ms。
- `b2f0c3e61` 的同型 job 因 50ms 硬门失败；`b765d2735` 两次分别出现约 93ms 与 214ms，`009eeb517` 也失败。
- `bd8a1f7b9..b2f0c3e61` 对 `packages/teamlead/src/ship-judgment/` 的实现、fixture 与性能测试没有 diff。
- #1219 只在 teamlead 侧加入 voice/StateStore 变更并重排其它 script-test shard；#1221 只改 Bridge thread mailbox。两者没有进入 `observeCancellations()`/`modeTick()` 的执行路径。
- 测试日志已经记录每个窗口的 wall time、CPU time、context switches 与 GC，足以区分算法耗时和 runner 抢占，不需要新增 production instrumentation。

## 假设与判定

1. 若 `b2f0c3e61` 的 3 次样本整体、持续高于 `bd8a1f7b9`，继续定位间接启动/注册回归并修 production 路径。
2. 若两头分布重叠或同头自身跨度很大，判定绝对 wall-clock 最大值不适合作为 CI 硬门；保留测试输出作为 CI perf 报告，并保留可显式启用的本地 perf 门。
3. 功能规模断言（170 万事件、500 holders、drain 完成、25,000 outcomes、零 onError）继续硬失败，不能因去除 CI wall-clock 门而降级。

## 不在范围

- 不重新设计 observation 算法。
- 不改 production 的 12.5/25ms 工作预算。
- 不改其它 CI job 的并发、容量或超时。
- 不 merge、部署或 dispatch QA。
