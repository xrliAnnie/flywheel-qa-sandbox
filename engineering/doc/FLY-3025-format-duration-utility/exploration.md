# FLY-3025 formatDuration 工具函数 — 探索
Issue: FLY-3025 (https://linear.app/geoforge3d/issue/FLY-3025/qa-sbx-fly-2913-c3a724b8-claude-design-role-v1)
日期: 2026-09-28
基于: 无

## 1. 需求（逐字转述任务）

设计一个极小的 `formatDuration(ms)` 工具：把毫秒数渲染成人类可读字符串，例如 `1h 2m 3s`。

- 省略为零的单位；
- 输入为 0 时输出 `0s`；
- 拒绝负数输入；
- 本节点只做设计（API、边界、测试清单），**不实现**。

## 2. 仓库审计

| 发现 | 位置 | 对本设计的影响 |
|---|---|---|
| 已存在 `formatDurationMs(ms)` | `packages/teamlead/src/bridge/hook-payload.ts:160` | 语义与新需求**不同**，见下 |
| 它的测试 | `packages/teamlead/src/__tests__/hook-payload.test.ts:22` | 锁定了现有行为，不能改 |
| 消费方 | `mailbox-lead-runtime.ts:257`、`commdb-lead-runtime.ts:124`（gate_timed_out 文案 "waited 48h"） | 改它 = 改生产告警文案 |
| 共享包 `flywheel-core` | `packages/core/src/`，测试在 `src/__tests__/`，vitest `globals: true`，`index.ts` 以 `export { … } from "./x.js"` 汇出 | 新工具的自然落点 |

现有 `formatDurationMs` 与新需求的差异：

| 输入 | 现有 `formatDurationMs` | 新 `formatDuration` 需求 |
|---|---|---|
| `3_723_000`（1h 2m 3s） | `"1h 2m"`（≥1h 丢秒，**有损**） | `"1h 2m 3s"`（**精确**） |
| `-1` | `"—"`（静默吞掉） | **拒绝**（抛错） |
| `NaN` / `undefined` | `"—"` | 拒绝 |
| `0` | `"0s"` | `"0s"`（一致） |

结论：两者是**不同契约**（一个是「告警里读个大概」的有损展示，一个是「精确分解」），不能合并成一个函数而不改变其中一方的行为。

## 3. 候选方案

- **A. 在 `flywheel-core` 新增独立 `formatDuration`（推荐）** — 纯函数、零依赖、零消费方改动；现有 `formatDurationMs` 原封不动。
- **B. 改写现有 `formatDurationMs` 满足新需求** — 会把 gate_timed_out 告警从 "waited 1h 30m" 变成可能带秒的精确串，且负数从 "—" 变成抛错，会让告警渲染路径崩；破坏 FLY-159 锁定测试。否决。
- **C. 让 `formatDurationMs` 委托给新函数** — 需要给新函数加「最多 N 个单位 / 容错模式」开关，为一个沙箱小工具引入配置面。超出范围，记为可选 follow-up。
- **D. 引入第三方库（`pretty-ms` / `humanize-duration`）** — 为 10 行逻辑加依赖，且其默认格式（`1h 2m 3s` vs `1 hour, 2 minutes`、是否带 `ms`）要额外配置。否决。

## 4. 待定假设（显式列出，未向 Lead 阻塞提问 —— 均有合理默认）

1. 单位只到 `h`（不引入天 `d`）：`25h` 渲染为 `"25h"`。任务示例只给了 h/m/s。
2. 不足 1 秒的部分向下取整丢弃：`999 → "0s"`、`1500 → "1s"`。
3. 「拒绝」= 抛 `RangeError`（而不是返回占位符），因为调用方传负数是编程错误，应该响亮失败。
4. `NaN`、`±Infinity`、非 number 同样拒绝（「负数」的自然延伸：非有效时长）。
5. `-0` 视为 0，输出 `"0s"`（`-0 < 0` 为 false，与 JS 数值语义一致）。
