# FLY-2662 收尾恢复 — 实施证据
Issue: FLY-2662 (https://linear.app/geoforge3d/issue/FLY-2662/land收尾死结-已合入的卡收尾永远停在半路thread-不归档linear-不-doneworktree-不清window)
日期: 2026-09-17
基于: plan.md

## `:pending` 部署前遗留形状 RED

- 夹具来源：对部署中的 `teamlead.db` 与 `comm.db` 做只读查询；不是受管 snapshot，未复制或写入生产数据库。
- 脱敏策略：替换 execution / operation / run / issue / PR / path / branch / commit 身份；保留字段、NULL、状态、retry、resume generation 与跨表关系。
- 夹具：`packages/teamlead/src/bridge/__tests__/fixtures/fly2662-predeploy/held-closeout.json`。
- 命令：`pnpm --filter flywheel-teamlead exec vitest run src/__tests__/close-runner.test.ts -t 'FLY-2662'`。
- 修复前结果：2 个新增测试均失败。StateStore 已 `completed`、CommDB 仍 `running` 且 `tmux_window='runner-flywheel:pending'` 时，`probeRunExecutionLiveness` 调用次数为 0；即使测试缝返回 `dead`，结果仍为 `physicalGone=false`、`commDbFinalized=false`。
- 活进程反例同样证明旧代码没有进入 execution-wide 探针。修复后的锁定目标是：只有 `dead` 可终结；`alive` 或 `unknown` 必须继续 fail-closed。
