# FLY-3026 parseBool 文本转布尔工具 — 实施计划
Issue: FLY-3026 (https://linear.app/geoforge3d/issue/FLY-3026/qa-sbx-fly-2913-c3a724b8-claude-design-role-v1-rev3)
日期: 2026-09-28
基于: exploration.md, research.md

> 本计划只描述设计；实现由后续 implement 节点按 TDD 执行。

## 1. 目标与非目标

**目标**：在 `flywheel-core` 新增纯函数 `parseBool(text)`，严格白名单把文本转布尔，其余一律抛错。

**非目标**：
- 不迁移现有 30 处 `process.env.X === "1"` 临时判断（语义各异，迁移会改行为；另立 issue）。
- 不提供宽松词表（`on/off/y/n`）、不提供非抛错变体（YAGNI；调用方可 try/catch）。
- 不改任何现有文件的行为；唯一对现有文件的改动是 `packages/core/src/index.ts` 追加一行导出。

## 2. API

```ts
// packages/core/src/parse-bool.ts
export function parseBool(text: string): boolean;
```

| 输入（`trim()` + `toLowerCase()` 之后） | 结果 |
|------|------|
| `"true"` `"yes"` `"1"` | `true` |
| `"false"` `"no"` `"0"` | `false` |
| 其他任何字符串（含 `""`） | 抛 `TypeError` |
| 非字符串（`undefined` `null` 数字 布尔 对象） | 抛 `TypeError` |

**单一真相**：一个模块内 `const` 冻结 `Map<string, boolean>`（6 个键），真值与假值都在同一张表里，不存在两份词表。

**错误信息契约**（测试钉住）：
- 字符串被拒：`parseBool: expected one of true/yes/1/false/no/0, got "<value>"`，其中 `<value>` = 原始输入（未 trim）按**码位**截断到 32 个码位（超出时追加 `…`）后 `JSON.stringify` —— 转义控制字符/引号，防日志注入与刷屏。
- 非字符串被拒：`parseBool: expected a string, got <typeof>`（`null` 报 `null`），**不回显值**。

**实现要点**（给 implement 节点）：
- 用 `toLowerCase()`，**禁止** `toLocaleLowerCase()`（土耳其语 locale 会让 `"TRUE"` 失败）。
- 先 `typeof text !== "string"` 守卫，再 `trim()`。
- 查表用 `Map.get` + `=== undefined` 判断未命中（不要用 `in`/对象字面量，避免 `"__proto__"`、`"constructor"` 之类原型键命中）。

## 3. 边界情况（每条都有对应测试）

| # | 输入 | 期望 | 理由 |
|---|------|------|------|
| E1 | `"TRUE"` `"Yes"` `"nO"` `"FaLsE"` | 对应布尔 | 大小写不敏感 |
| E2 | `"  true  "` `"\tno\n"` `"  1 　"` | 对应布尔 | 标准 `trim()` 含 NBSP/全角空格 |
| E3 | `""` `"   "` | 抛错 | 空不是布尔 |
| E4 | `"on"` `"off"` `"y"` `"n"` `"t"` `"f"` | 抛错 | 严格白名单 |
| E5 | `"2"` `"01"` `"00"` `"1.0"` `"+1"` `"-0"` `" 1 0 "` | 抛错 | 不做数值解析 |
| E6 | `"true!"` `"tr ue"` `"yes\u0000"` `"​true"` | 抛错 | 内部字符/零宽不被 trim |
| E7 | `"ＴＲＵＥ"`（全角）、`"Kes"`（含开尔文符号） | 抛错 | Unicode 折叠陷阱（research §1） |
| E8 | `"__proto__"` `"constructor"` `"toString"` | 抛错 | 原型键不得命中 |
| E9 | `undefined` `null` `1` `true` `{}` | 抛错，信息只含 typeof | 非字符串一律拒绝、不回显值 |
| E10 | 1000 字符的垃圾串、含 `"` 与 `\n` 的串 | 抛错；信息 ≤ 32 码位 + `…`，引号/换行被转义 | 日志安全 |

## 4. 测试计划（vitest，TDD 先红后绿）

文件：`packages/core/src/__tests__/parse-bool.test.ts`（沿用该包 `src/__tests__/*.test.ts` 布局与 `vitest run`）。

1. `it.each` 真值表：6 个规范词 × 大小写变体 × 空白变体 → 期望布尔（覆盖 E1/E2）。
2. `it.each` 拒绝表：E3–E8 全部输入 → `toThrow(TypeError)` 且 `toThrow(/expected one of true\/yes\/1\/false\/no\/0/)`。
3. 非字符串：E9 → `toThrow(TypeError)`，并断言 message 以 `got <typeof>` 结尾、**不含**值本身（例如 `{secret:"x"}` 的 `secret` 不出现）。
4. 错误信息安全：E10 → 截断长度、`…` 后缀、`\n`/`"` 已转义（`message` 不含裸换行）。
5. 导出：`import { parseBool } from "../index.js"` 可用（防漏导出）。
6. 纯函数性：同一输入多次调用结果一致；词表不可被外部修改（模块不导出词表）。

验收命令：`pnpm --filter flywheel-core test` 全绿、`pnpm --filter flywheel-core typecheck` 通过、`pnpm lint`（biome）对新文件无报错。覆盖率目标：新文件 100% 行/分支。

## 5. 改动清单与回滚

| 文件 | 动作 |
|------|------|
| `packages/core/src/parse-bool.ts` | 新增（~20 行） |
| `packages/core/src/__tests__/parse-bool.test.ts` | 新增 |
| `packages/core/src/index.ts` | 追加 1 行 `export { parseBool } from "./parse-bool.js";` |

无持久化、无迁移、无配置、无运行时调用方 → 回滚 = revert 该 PR，零副作用。

## 6. 执行步骤（implement 节点）

1. 写测试文件（§4），`pnpm --filter flywheel-core test` 确认**红**（模块不存在）。
2. 写 `parse-bool.ts` 最小实现 → 绿。
3. 加 `index.ts` 导出 → 导出测试绿。
4. typecheck + biome lint；自审错误信息契约。
5. 提交 `feat(FLY-3026): add parseBool strict boolean text parser`，开 PR。
