# FLY-3025 formatDuration 工具函数 — 调研
Issue: FLY-3025 (https://linear.app/geoforge3d/issue/FLY-3025/qa-sbx-fly-2913-c3a724b8-claude-design-role-v1)
日期: 2026-09-28
基于: exploration.md

## 1. 落点与约定（已核仓库）

- 包：`packages/core`（`flywheel-core`，ESM，`"type": "module"`）。
- 源文件约定：kebab-case 单文件，如 `src/tmux-naming.ts`、`src/terminal-view-identity.ts`。
- 导出约定：`src/index.ts` 用 `export { name } from "./file.js";`（带 `.js` 后缀）。
- 测试约定：`src/__tests__/*.test.ts`，vitest 3，`globals: true`，但现有测试仍显式 `import { describe, expect, it } from "vitest"`，沿用显式 import。
- 运行：`pnpm --filter flywheel-core exec vitest run src/__tests__/format-duration.test.ts`；类型检查 `pnpm --filter flywheel-core typecheck`；lint 走仓库根 biome。

## 2. JS 数值边界（node 实测）

| 探针 | 结果 | 设计含义 |
|---|---|---|
| `-0 < 0` | `false` | `-0` 不会被负数检查拒绝 → 视为 0 |
| `Math.floor(-0 / 1000)` | `-0`，但 `` `${-0}` `` 为 `"0"`，且 `-0 === 0` | 用 `totalSeconds === 0` 短路返回 `"0s"`，输出不会出现 `-0s` |
| `Math.floor(1999.9 / 1000)` | `1` | 小数毫秒向下取整到秒，符合「丢弃亚秒」 |
| `Number.isFinite("5")` | `false` | 字符串被 `Number.isFinite` 拒绝，无隐式转换 |
| `typeof 1n` | `"bigint"` | BigInt 不是 number → 拒绝（TypeError） |
| `Number.MAX_SAFE_INTEGER / 1000` | `9007199254740.99` | 超过安全整数后除法/取模不再精确 |

结论：
- 类型闸：`typeof ms !== "number"` → `TypeError`（运行时防 JS 调用方 / `any`）。
- 值闸：`!Number.isFinite(ms) || ms < 0 || ms > Number.MAX_SAFE_INTEGER` → `RangeError`。上限约 28.5 万年，任何真实时长都远低于它；设上限是为了让「输出精确」成为契约而不是「大概」。

## 3. 同类实现对照

| 实现 | 格式 | 负数 | 为何不直接用 |
|---|---|---|---|
| 仓内 `formatDurationMs`（FLY-159） | ≥1h 丢秒，`"1h 2m"` | `"—"` | 有损、吞错；契约不同（见 exploration §2） |
| `pretty-ms`（npm） | 默认 `"1h 2m 3.4s"`，带亚秒/毫秒 | 输出带 `-` | 新依赖 + 需关闭亚秒；负数不拒绝 |
| `humanize-duration`（npm） | `"1 hour, 2 minutes, 3 seconds"` | 取绝对值 | 冗长格式，与需求不符 |

## 4. 算法（纯整数分解）

```
totalSeconds = Math.floor(ms / 1000)
if totalSeconds === 0 → "0s"
h = floor(totalSeconds / 3600); m = floor((totalSeconds % 3600) / 60); s = totalSeconds % 60
parts = [h>0 && `${h}h`, m>0 && `${m}m`, s>0 && `${s}s`].filter(Boolean)
return parts.join(" ")
```

不变量：输出非空；各部分按 h→m→s 降序；无前导零（`"1h 5s"` 而非 `"1h 0m 5s"`）；单空格分隔；`m, s ∈ [0,59]`，`h` 无上限（不进位到天）。
