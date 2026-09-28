# FLY-3026 parseBool 文本转布尔工具 — 探索
Issue: FLY-3026 (https://linear.app/geoforge3d/issue/FLY-3026/qa-sbx-fly-2913-c3a724b8-claude-design-role-v1-rev3)
日期: 2026-09-28
基于: 无

> QA 沙箱合成设计任务（FLY-2913 c3a724b8 Claude design role-v1 rev3）。本节点只产出设计，不实现。

## 1. 需求原文

设计一个极小的 `parseBool(text)`：把 `true/yes/1` 与 `false/no/0`（大小写不敏感、先去首尾空白）映射成布尔值，其余一律拒绝。

## 2. 仓库现状审计（2026-09-28，HEAD `1855f7a1a`，与 `origin/main` 齐平）

| 检查 | 结果 |
|------|------|
| 现有 `parseBool` / `parseBoolean` / `toBool` / `isTruthy` / `envFlag` 函数 | **0 个**（`grep -rnE "(function\|const) +(parseBool\|parseBoolean\|toBool\|isTruthy\|parseBooleanEnv\|envFlag\|parseFlag)\b" packages --include='*.ts'` 无命中） |
| 生产代码里临时的 `process.env.X === "1"/"true"/"0"` 判断 | **30 处**（排除 `__tests__`），例如 `packages/edge-worker/src/EdgeWorker.ts:1924` 的 `process.env.CYRUS_WEBHOOK_DEBUG === "true"` |
| 放置候选 | `packages/core`（`flywheel-core`，零运行时依赖的纯函数/类型集中地；已有 `Semaphore.ts`、`tmux-naming.ts` 这类小工具 + `src/__tests__/*.test.ts` vitest 布局） |

结论：没有可复用的单一真相；新增一个纯函数即可，不存在"两套词表并存"的冲突。

## 3. 需要拍板的开放问题（都有安全默认，均不阻塞）

1. **拒绝方式**：抛异常 vs 返回 `undefined`/Result。→ 默认**抛 `TypeError`**（"rejects" 最直接的读法；调用方想要默认值可自己 try/catch）。
2. **非字符串输入**（JS 调用方传 `true`、`1`、`null`）：→ **一律拒绝**（`TypeError`），不做隐式转换，保持 API 只收文本。
3. **"trim" 的范围**：→ 用标准 `String.prototype.trim()`（含 NBSP、全角空格、`\t\n\r`）。
4. **是否顺手迁移那 30 处临时判断**：→ **不做**。它们语义各异（有的只认 `"1"`），迁移会改变行为，属另立 issue 的范围。

## 4. 候选方案

| 方案 | 说明 | 取舍 |
|------|------|------|
| A. 冻结词表 `Map` + `trim().toLowerCase()` 查表，未命中抛 `TypeError` | 一处词表=单一真相；O(1) | **推荐** |
| B. 正则 `/^(true\|yes\|1)$/i` + `/^(false\|no\|0)$/i` | 同样短 | 两个正则=两份词表，易漂移；`i` 标志对 Unicode 行为需额外推敲 |
| C. 引入第三方库（如 `yn`、`boolean`） | 现成 | 词表更宽（`on/off/y/n`），与需求"其余一律拒绝"冲突；新增依赖不值 |
