# Design Review — plan.md (Round 1)
Date: 2026-09-28
Author: Codex
Status: APPROVED

## Summary

设计可行，API、取整、零单位省略及错误类型的定义相互一致；未发现阻塞性的正确性、兼容性或范围问题。存在 1 项低优先级的实施顺序问题，见下文。此结论仅针对设计，不表示已经实现或通过项目测试。

审查基线：HEAD `5ad37a922e94685f0f9ce20da450756abf988bf8`；磁盘上的 `engineering/doc/FLY-3025-format-duration-utility/plan.md` 与提交版本一致，blob 为 `faaf3ea8ff77f2f803c41ad38ad05763302510fd`。已读取根目录 `CLAUDE.md`、`packages/CLAUDE.md`、`README.md`、项目体验规范，以及本任务的 `exploration.md`、`research.md` 和完整 `plan.md`。

已完成的核验：

- `packages/core/src/index.ts` 和 `packages/core/src/__tests__/` 均存在；计划新增的源文件和测试文件尚不存在。`packages/core/package.json:2` 确认包名为 `flywheel-core`，第 5 行声明 ESM，第 17 行提供 `typecheck`，第 28 行声明 Vitest 3。
- `packages/core/src/index.ts:248` 附近已有带注释、使用 `.js` 路径的命名导出；`packages/core/src/__tests__/WorkflowFSM.test.ts:1` 显式导入 Vitest，第 64 行使用 `it.each`。计划与这些约定一致。已核对根 `biome.json` 和 `packages/core/vitest.config.ts:3`：Node 环境、globals 开启、watch 关闭，无须新增配置。
- `packages/teamlead/src/bridge/hook-payload.ts:160` 的现有函数接受 null/undefined，非法值返回 `—`，达到小时后省略秒；现有测试在 `packages/teamlead/src/__tests__/hook-payload.test.ts:22`。调用方确为 `mailbox-lead-runtime.ts:257` 和 `commdb-lead-runtime.ts:124`。本次执行 `git diff --quiet origin/main -- packages/teamlead` 返回 0。
- 使用 Python Decimal/整数运算独立核算计划的所有数值期望，并用 Node 复核 JS 的负零、小数取整和最大安全整数语义，共完成 33 项数值检查，全部相符。T7 的 7 个输入均违反值域，T8 的 5 个输入均不是 number；错误类型符合计划中的前置校验顺序。`MAX_SAFE_INTEGER + 2` 在 JS 中实际舍入成 `9007199254740992`，仍高于上限，因此该拒绝用例有效。

数值核算明细（保留重复边界用例）：

| 分组 | 已核算的输入 → 期望 |
|---|---|
| T1 | `0`、`-0`、`1`、`999`、`0.5` 均为 `0s` |
| T2 | `1000 → 1s`；`59000 → 59s`；`60000 → 1m`；`3600000 → 1h` |
| T3 | `3723000 → 1h 2m 3s`；`3720000 → 1h 2m`；`3603000 → 1h 3s`；`123000 → 2m 3s` |
| T4 | `59999 → 59s`；`60000 → 1m`；`3599999 → 59m 59s`；`3600000 → 1h` |
| T5 | `1999 → 1s`；`1999.9 → 1s`；`61500 → 1m 1s` |
| T6 | `86400000 → 24h`；`90061000 → 25h 1m 1s`；`9007199254740991 → 2501999792h 59m` |
| T11 | `1000 → 1s`；`61000 → 1m 1s`；`3603000 → 1h 3s`；`3723000 → 1h 2m 3s`；`90061000 → 25h 1m 1s`；`0`、`999 → 0s` |
| API 示例 | `90000000 → 25h`；`3605000 → 1h 5s`；`1999.9 → 1s` |

尤其是上限：`9007199254740991 = 2501999792 × 3600000 + 59 × 60000 + 991`，丢弃最后 991ms 后秒位为 0，T6 没有算术错误。

未安装依赖，未实现函数，未运行 Vitest、typecheck 或 Biome；以上是来源审查、路径与配置核验、独立算术检查，不是 T1–T11 的项目执行结果。`packages/core/tsconfig.json:10` 排除测试文件，因此计划中的 typecheck 验证生产源码，测试行为由目标 Vitest 命令验证。

## What's Good (Keep)

- 单个纯函数、两个新文件和一个命名导出，范围与微型工具相称；没有新增库、格式选项、天单位或迁移机制，未发现实质性过度设计。
- 运行时先判类型、再判值域，允许非负小数和负零，拒绝负数、非有限数和超上限值；`Math.floor(ms / 1000)` 及后续整数分解可以直接落实。
- 保留 `formatDurationMs` 及其告警调用方，避免改变已有占位符、容错及小时级文案契约。新 API 的严格行为由独立名称和文档说明。
- T1–T8 覆盖主要输入类别、七种非空单位组合、进位、取整和上限；T9 避免逐字锁定错误文案，T10 检查公共导出，T11 仅用固定样本，无需属性测试依赖。
- 验证命令限定到目标测试和三个相关文件；纯新增且无消费方的变更可通过 revert 回滚，没有数据或配置迁移风险。

## Issues & Recommendations

1. [low] 依赖安装应放在首次红灯验证之前。

   **位置：** `engineering/doc/FLY-3025-format-duration-utility/plan.md:69`、`:74`。

   **场景与证据：** 第 1 步要求运行测试并确认因目标模块不存在而失败，但安装依赖安排在第 4 步。当前根目录和 `packages/core` 都没有 `node_modules`，两处 `.bin/vitest` 均不存在，PATH 中也没有 Vitest。按现有顺序无法保证先进入测试收集阶段，工具或依赖不可用不能作为目标模块缺失的红灯证据。

   **建议：** 将 `pnpm install --frozen-lockfile` 移至第 1 步之前，作为实施阶段的环境准备；确认依赖可用后再记录预期红灯。安装失败应单独记录为环境阻塞。无需增加依赖、配置或额外测试；这是非阻塞的步骤编排修正。

## Verdict

APPROVED

critical=0,high=0,medium=0,low=1

设计满足本轮 API、边界和测试清单的审查要求。唯一意见是将安装依赖前置；本轮交付保持设计审查范围，不包含实现。
