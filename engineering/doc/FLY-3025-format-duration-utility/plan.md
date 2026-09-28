# FLY-3025 formatDuration 工具函数 — 实施计划
Issue: FLY-3025 (https://linear.app/geoforge3d/issue/FLY-3025/qa-sbx-fly-2913-c3a724b8-claude-design-role-v1)
日期: 2026-09-28
基于: research.md

## 0. 目标与范围

在 `flywheel-core` 新增纯函数 `formatDuration(ms)`，把毫秒数渲染成 `1h 2m 3s` 形式；省略零单位、0 输出 `0s`、拒绝负数与非法输入。

**范围内**：1 个源文件、1 个测试文件、`index.ts` 一行导出。
**范围外（刻意不做）**：不改现有 `formatDurationMs`（`packages/teamlead/src/bridge/hook-payload.ts:160`，FLY-159 告警文案契约）及其消费方；不引入天 `d` 单位；不引入依赖；不做本地化 / 多格式选项。

## 1. API 契约

```ts
/**
 * Render a millisecond count as "1h 2m 3s": units h/m/s, zero units omitted,
 * sub-second remainder floored away, "0s" for anything under one second.
 * @throws TypeError  if `ms` is not of type number (e.g. string, bigint, undefined)
 * @throws RangeError if `ms` is NaN, ±Infinity, negative, or > Number.MAX_SAFE_INTEGER
 */
export function formatDuration(ms: number): string;
```

| 规则 | 行为 |
|---|---|
| 单位 | 仅 `h` / `m` / `s`；小时不进位到天（`90_000_000 → "25h"`） |
| 零单位 | 省略（`3_605_000 → "1h 5s"`，不是 `"1h 0m 5s"`） |
| 零 / 亚秒 | `0`、`-0`、`999`、`0.5` → `"0s"` |
| 取整 | `Math.floor(ms / 1000)`，小数毫秒与亚秒余数丢弃（`1999.9 → "1s"`） |
| 分隔 | 单个 ASCII 空格；顺序恒为 h → m → s |
| 非 number | `TypeError`，message 含 `formatDuration` 与 `typeof` 结果 |
| 负数 / 非有限 / 超安全整数 | `RangeError`，message 含 `formatDuration` 与原值 |

错误 message 形态（测试只断言错误类型 + 包含 `formatDuration`，不逐字锁定文案）：
- `formatDuration: expected a number, got <typeof>`
- `formatDuration: expected a finite, non-negative ms value ≤ Number.MAX_SAFE_INTEGER, got <String(ms)>`

## 2. 文件改动

| 文件 | 改动 |
|---|---|
| `packages/core/src/format-duration.ts` | 新增，导出 `formatDuration`（算法见 research.md §4，≈20 行） |
| `packages/core/src/__tests__/format-duration.test.ts` | 新增，表驱动测试（见 §3） |
| `packages/core/src/index.ts` | 新增 `// Duration formatting (FLY-3025)` 注释 + `export { formatDuration } from "./format-duration.js";`，位置按 biome 排序 |

## 3. 测试清单（TDD：先写全红，再实现转绿）

`describe("formatDuration (FLY-3025)")`，用 `it.each` 表驱动：

**T1 零与亚秒** → `"0s"`：`0`、`-0`、`1`、`999`、`0.5`
**T2 单一单位**：`1_000 → "1s"`、`59_000 → "59s"`、`60_000 → "1m"`、`3_600_000 → "1h"`
**T3 省略零单位（每种缺位组合）**：
- `3_723_000 → "1h 2m 3s"`（任务示例）
- `3_720_000 → "1h 2m"`（缺 s）
- `3_603_000 → "1h 3s"`（缺 m，关键：不能出现 `0m`）
- `123_000 → "2m 3s"`（缺 h）
**T4 进位边界**：`59_999 → "59s"`、`60_000 → "1m"`、`3_599_999 → "59m 59s"`、`3_600_000 → "1h"`
**T5 取整**：`1_999 → "1s"`、`1_999.9 → "1s"`、`61_500 → "1m 1s"`
**T6 大值不进位到天**：`86_400_000 → "24h"`、`90_061_000 → "25h 1m 1s"`、`Number.MAX_SAFE_INTEGER → "2501999792h 59m"`（上限本身合法；秒位恰为 0，顺带验证省略）
**T7 RangeError**：`-1`、`-0.5`、`-3_600_000`、`NaN`、`Infinity`、`-Infinity`、`Number.MAX_SAFE_INTEGER + 2`
**T8 TypeError**（经 `as unknown as number` 绕过 TS）：`"1000"`、`1000n`、`undefined`、`null`、`{}`
**T9 错误信息**：任一 T7/T8 用例的 message 包含 `"formatDuration"`
**T10 导出面**：`import { formatDuration } from "../index.js"` 可用且与直接导入为同一函数（防 index 漏导出）
**T11 输出不变量（固定样本循环，无新依赖）**：对 `[1_000, 61_000, 3_603_000, 3_723_000, 90_061_000]` 断言 `out.split(" ")` 每段匹配 `/^[1-9]\d*[hms]$/`（无零段、无前导零、无多余空格），且单位字母序列是 `"hms"` 的严格递增子序列（无重复、无乱序）；另断言 `0` 与 `999` 恰为 `"0s"`（唯一允许 `0` 的形态）

## 4. 实施步骤

0. 环境准备：`pnpm install --frozen-lockfile`（本 worktree 尚无 node_modules）。安装失败单独记为环境阻塞，**不得**当作红灯证据。
1. 写 `format-duration.test.ts`（T1–T11）→ 跑，确认红灯原因是目标模块 `../format-duration.js` 不存在（而不是 vitest 缺失）。
2. 写 `format-duration.ts` 最小实现 → T1–T9、T11 绿。
3. 加 `index.ts` 导出 → T10 绿。
4. 验证：
   ```bash
   pnpm --filter flywheel-core exec vitest run src/__tests__/format-duration.test.ts
   pnpm --filter flywheel-core typecheck
   pnpm exec biome check packages/core/src/format-duration.ts packages/core/src/__tests__/format-duration.test.ts packages/core/src/index.ts
   ```
5. 回归护栏：`git diff --stat origin/main -- packages/teamlead` 必须为空（证明未碰 `formatDurationMs`）。

## 5. 验收标准

- 上述 3 条验证命令 exit 0；T1–T11 全绿。
- `packages/teamlead/**` 零 diff。
- 新文件无运行时依赖（仅 vitest 用于测试）。

## 6. 回滚

纯新增：回滚 = revert 该提交（删两个新文件 + 一行导出）。无数据、无配置、无消费方，零迁移。

## 7. 风险

| 风险 | 缓解 |
|---|---|
| 与 `formatDurationMs` 名字相近被误用 | JSDoc 写清两者区别；两者分属不同包、签名不同（新函数不接受 `null`） |
| 调用方期望容错（如告警渲染）却拿到抛错 | 契约明确「编程错误响亮失败」；需要容错的场景继续用 `formatDurationMs` |
| 将来要统一两者 | 记为可选 follow-up（让 `formatDurationMs` 委托新函数需要「最多 N 单位」选项），本期不做 |
