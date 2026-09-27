# Design Review — plan.md (Round 4)

Date: 2026-09-27
Author: Codex
Status: APPROVED

## Summary

已复核计划提交 `347554621f2faa6119b8102b06ff59bfb2cc37bb`，只读对照源码基线 `d52df7841cb7f7844ee83e37159987840a4c50ac`。C2 的准入守卫已收窄为精确取消身份或明确 `abandoned`，并保留正常 wake、land 返工及合法幂等重放，R3 #1 可以关闭；此前已关闭的事务原子性及冻结旁路问题没有回退。本轮未发现需要修改的设计问题；这是设计批准，未修改主仓、未运行测试，也未审核后续实现头。

## What's Good (Keep)

- 准入守卫依据明确的取消/放弃事实拒绝，不再把 `started` 或没有新 dispatch intent 当作放弃。这与基线 `packages/teamlead/src/bridge/workflow-rework-coordinator.ts:895-907` 的 wake 准入，以及 `packages/teamlead/src/StateStore.ts:86978-86987` 的启动历史语义一致。
- 保留新返工 attempt 首次创建 binding 和合法幂等重放。基线 `packages/teamlead/src/StateStore.ts:52677-52681,52780-52786` 为 land 返工创建新 attempt 的节点预留；`47177-47182` 按 execution/run/node/attempt 查绑定，`47221-47227` 返回合法幂等成功。§8.2 的真实 StateStore 正向对照已覆盖这些区别。
- 放弃旧意图、取消围栏、撤凭据及换体继续在同一事务中完成，双向竞争和中途崩溃测试保留。基线 `packages/teamlead/src/StateStore.ts:41724-41732,42807-42809` 的既有取消检查可拒绝旧替身的 launch acquire / commit。
- §8.2 同时要求正常活体到达 `wake_sent` 和已取消旧替身在三个入口被拒，兼顾可恢复性与旧身份隔离；C4.7 及其真实 watch 回归保持不变。

## Issues & Recommendations

无新增 BLOCKER、MAJOR 或 MINOR。R3 #1 已关闭，本线程 R1–R3 提出的设计问题均已在计划中处理。

实现验收按 §8.2 验证这些合同；本次批准不代表所列测试已经执行或后续实现已经符合计划。

## Verdict

APPROVED — ready to implement
