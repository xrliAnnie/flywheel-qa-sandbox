# FLY-2645 observation performance CI 随机红 — 实现记录
Issue: FLY-2645 (https://linear.app/geoforge3d/issue/FLY-2645/cimain-红-observation-performance-计时预算测试在-main-上连红93ms214ms-vs-50ms)
日期: 2026-09-16
基于: plan.md

## 实现结果

只修改 `observation-performance.test.ts` 的 fixture 测量边界。新增局部
`checkpoint(phase)`，在 backlog、tail、modeTick 三组被测窗口之前分别执行
`wal_checkpoint(TRUNCATE)`；每次单独记录 wall/CPU、context switches、WAL
before/after bytes 与 SQLite `{busy,log,checkpointed}` 收据。原有 50ms observer、
100ms modeTick CI 硬门、170 万事件/500 holders 规模及全部功能断言均未放宽。

production `StateStore`、observer/runtime 路径和 CI workflow 没有改动。修复的是
fixture 中 WAL auto-checkpoint 随机落入 tail 写事务的相位污染，不是用更大的预算
遮住抖动，也没有把性能门降成 report-only。

## TDD 收据

### 红

先加入要求 `before_backlog`、`before_tail`、`before_mode_tick` 三条 receipt 的硬断言，
但不增加调用。真实 170 万事件性能测试确定性失败：实际 receipts 为 `[]`，期望为
上述三个 phase；该次原 wall-time 预算碰巧通过，因此红侧不依赖随机复现尖峰。

### 绿

加入最小 checkpoint 记录器及三处调用后，同一测试 1/1 通过。该次 checkpoint 收据：

- `before_backlog`: 约 45.5ms，WAL 约 419MB → 0；
- `before_tail`: 约 13.1ms，WAL 约 4.24MB → 0；
- `before_mode_tick`: 约 14.8ms，WAL 约 1.25MB → 0。

每条均 `busy=0`，且原预算断言实际执行；该次 tail max 26.31ms、modeTick max
5.10ms。checkpoint 耗时只进入独立诊断收据，不混入 observer/modeTick 样本。

替身接手后在 `61b271f51` 再跑同一目标文件，1/1 通过：三条 checkpoint 均
`busy=0`、WAL after bytes 为 0；backlog max 27.49ms、steady max 1.13ms、tail
max 10.83ms、auto-merge modeTick max 6.28ms、dry-run modeTick max 17.86ms。

技术同步当前 `origin/main` 后在 merge head `817ee33c7` 再跑，1/1 通过；三条
checkpoint 仍均 `busy=0`、WAL after bytes 为 0，backlog/steady/tail max 分别为
23.22/0.45/10.08ms，两个 modeTick max 分别为 10.66/19.26ms。main 在分叉点后
没有改动目标测试，合并也没有改变本单锁定范围。

## 本地验证

- `pnpm --filter flywheel-teamlead exec vitest run src/ship-judgment/__tests__/observation-performance.test.ts`: 1/1 通过；
- `pnpm --filter flywheel-teamlead typecheck`: 通过；
- `node --test scripts/__tests__/teamlead-shards.test.mjs`: 9/9 通过；
- `bash scripts/__tests__/ci-matrix-coverage.test.sh`: 23/23 通过；
- `bash scripts/__tests__/ci-structure.test.sh`: 通过；
- `pnpm lint`: exit 0；仅仓库既有 warnings，无 lint error；
- `pnpm -r build`: exit 0；
- `pnpm test:packages:run`: 前一实现体启动后没有留下可验证的终态收据；接手指令与
  QA 判据明确禁止在并发宿主重跑全量套件，因此不把它声称为 green，也不重跑。
  当前头的 aggregate 权威证据由 GitHub exact-head CI 提供。

## 评审与 CI

设计评审第二轮 effective verdict 为 APPROVED。评审保留的非阻塞建议是：未来可增加
更直接的 in-window WAL frame invariant，并另行评估 production auto-checkpoint 的同步
事件循环成本；两者都不扩入本单测试边界修复。

最终 exact-head code review、PR 与三次真实 GitHub CI green 尚待执行；三次 run 的链接、
perf job checkpoint receipts 与各类 max 将追加到 PR 证据，不改动冻结代码头。历史 replay
在 runner 分配前因账户计费准入失败（`runner_id=0`），不计性能样本，也不冒充本单的
三次 CI 证据。

## 边界

本节点不 deploy、不 restart、不改 production 数据、不 dispatch QA、不请求 ship approval、
不 merge。回滚只需撤回性能测试中的 checkpoint 收据和调用；production 字节不受影响。
