# FLY-1604 Codex config.toml TOML-aware 合并 — 调研

Issue: FLY-1604 (https://linear.app/geoforge3d/issue/FLY-1604/阻塞p0-codex-implement-节点全部起不来-rendercodexhomeconfig-撞上-codex-自己写的-shell)
日期: 2026-08-02
基于: exploration.md

## 1. 调研方法

所有结论来自**实证 spike**（`smol-toml@1.6.1`，与 monorepo 锁定版本一致，13 项检查全部按预期），不是凭 TOML 规范记忆。spike 直接在**当前真实的** `~/.codex/config.toml`（906 行、含 Codex 自写三键）上跑。

## 2. smol-toml 能力面

| 事实 | 实测结果 |
|---|---|
| parse 真实全局 config | ✅ 成功；`shell_environment_policy.set` 解析出 Codex 三键 |
| 重复表定义 | ❌ throw `trying to redefine an already defined table or value` —— 这正是现在 append 产坏文件、需要守卫的原因 |
| 同表重复键 | ❌ 同上 throw —— parse 验证能兜住"注入了已存在的键" |
| inline table 后再开子表头 | ❌ throw —— inline 定义 immutable，实证 |
| 包格式 | 1.6.1 同时导出 import 与 require（含 `dist/index.cjs`）；spike 初次 MODULE_NOT_FOUND 是 worktree 未安装依赖所致，非 ESM-only（Codex R1 更正）。claude-runner 为 ESM，用 named import |
| stringify | 有但**不用** —— 全文件 round-trip 丢注释/重排格式，违反 "base preserved verbatim" |

版本决策：`claude-runner` 新增 dep `"smol-toml": "^1.6.1"`（与 teamlead 对齐，lockfile 已有 1.6.1，零新增安装体积）。

## 3. TOML 规则实证（决定处置矩阵的依据）

| # | 形态 | 实测 | 含义 |
|---|---|---|---|
| 1 | `[shell_environment_policy.set]` 表头后**紧插键行**（A1 形态，真实 config 上跑） | ✅ 合法；GH_TOKEN + Codex 三键同表共存 | **选定的合并形态成立** |
| 2 | base 只有父表 `[shell_environment_policy]`，append `[shell_environment_policy.set]` 完整块 | ✅ 合法 | 父表形态可走**现状 append 路径**，无需手术 |
| 3 | `shell_environment_policy = {…}` inline 后 append `[.set]` | ❌ throw | inline 形态必须 fail loud |
| 4 | `[[skills.config]]` 在 base 出现后再 append `[[skills.config]]` | ✅ 合法（array-of-tables 追加元素） | skills 现守卫**过度保守**，此形态可放行 |
| 5 | `[skills]` 表 + append `[[skills.config]]` | ✅ 合法 | 同上可放行 |
| 6 | `[skills.config]` **单表** + append `[[skills.config]]` | ❌ throw | 真冲突，守卫保留 |
| 7 | `skills = {…}` inline + append `[[skills.config]]` | ❌ throw | 真冲突，守卫保留 |
| 8 | 空格表头 `[ shell_environment_policy . set ]` | ✅ 合法 parse | 锚点 regex 需容忍空白 |
| 9 | quoted 表头 `["shell_environment_policy".set]` | ✅ parse 到同一命名空间 | 字面锚点 regex 找不到它 → "parse 说已定义但锚点数≠1" → fail loud（保守正确） |
| 10 | 真实 config 中字面 `[shell_environment_policy…]` 表头计数 | 恰好 1 | 生产形态命中手术路径的唯一分支 |

## 4. 现状代码影响面

- **改动点**：`packages/claude-runner/src/codex-home.ts` 的 `renderCodexHomeConfig`（:425-486）及其两条守卫（:445-457 sep、:458-467 skills）。`provisionCodexHome` 不动（它只调 render）。
- **sentinel strip 复用**：`stripManagedBlock`（:390-397）的 regex 剥 `MANAGED_BEGIN…MANAGED_END` 之间任意内容 —— 对"无表头的 sentinel 键行块"（A1 形态）**原样适用**，幂等/scrub 语义零改动。
- **调用链**：render 的调用方只有 `provisionCodexHome`（生产）+ 测试。产物 config.toml 每次 provision 从全局重新 seed（`codex-home.ts:571-574`），不回读产物 —— 但 render 的幂等契约（render(render(x)) 稳定）已有测试，必须保持。
- **现有测试**（`test/codex-home.test.ts`）：
  - `:135` "fails loudly …" 用 5 种冲突形态断言 throw —— 其中 `[shell_environment_policy.set]` 表头形态和 `[shell_environment_policy]` 父表形态将从 throw 变为**合并成功**，测试要改写为断言合并产物；dotted / inline / 已有 GH_TOKEN 形态仍断言 throw。
  - `:183` byte-identical 断言：fixture 无冲突 → 走现状 append 路径 → **必须继续字节不变**（回归锚）。
  - `:189` skills fail-loud 测试：`[[skills.config]]` / `[skills]` 形态改为断言 append 成功 + parse 验证；inline / dotted / `[skills.config]` 单表形态仍 throw。

## 5. 边界形态处置矩阵（设计输入）

> 注（Codex design review R1 后）：本矩阵是调研时的初版。终版决策树以 plan.md §3 为准 —— parse 结果为语义权威、regex 只做锚点定位（root-aware 修正：其他表下的相对同名键、兄弟子表等形态放行）、结构验证全程占位 token、异常消息脱敏。

GH_TOKEN 路径（`ghToken` 存在时，对 strip 后的 base）：

| base 形态（parse + 字面锚点双重判定） | 动作 |
|---|---|
| 无 `shell_environment_policy` 声明 | 现状：append 完整 sentinel block（**字节不变**） |
| 恰 1 个字面 `[shell_environment_policy.set]` 表头，parse 无 `set.GH_TOKEN` | **A1 手术**：表头行紧后插 sentinel 键行块 |
| 恰 1 个字面 `[shell_environment_policy]` 父表头，无 `.set` 定义 | append 完整 sentinel block（实测合法，规则 #2） |
| parse 显示 `set.GH_TOKEN` 已存在 | fail loud（不覆盖非 flywheel 管理的凭据键） |
| dotted（`shell_environment_policy.set.X = …`）/ inline（`= {…}`） | fail loud（规则 #3） |
| parse 说命名空间已定义但字面锚点数 ≠ 1（quoted / 多处 / 奇形） | fail loud（规则 #9） |
| base 本身 parse 失败（非法 TOML） | fail loud（无法安全合并；Codex 读它也会挂，在 provision 处早失败更清晰） |

skills 路径（`skillDisableNames` 非空时）：

| base 形态 | 动作 |
|---|---|
| 无 `skills` 声明 | 现状 append（字节不变） |
| `[[skills.config]]` / `[skills]` / `[skills.<x>]` 表头形态 | **放行 append**（规则 #4/#5）+ 产物 parse 验证 |
| `[skills.config]` 单表 / inline / dotted | fail loud（规则 #6/#7） |

两条路径共同的**产物验证**（仅在有注入内容时）：parse 产物必须成功，且断言 ① `shell_environment_policy.set.GH_TOKEN === ghToken`；② base 原有的 `set` 键值逐个保留；③ skills 注入时 `skills.config` 数组含全部 disable 项。验证失败 → throw，不写盘（`provisionCodexHome` 在 render throw 时不会碰 config 文件）。

## 6. 风险与遗留

- **Codex 并发改写全局 config**：provision 读 seed 与 Codex 写全局文件存在理论竞态（读到半写状态）。base parse 失败即 fail loud，session 显式 failed 可重试 —— 与现状故障模式一致，不新增风险。
- **Codex 未来写出新形态**（quoted 表头、dotted 等）：矩阵中全部落入 fail loud + 错误信息带上实际形态描述，是下一单的清晰信号，不会静默产坏文件。
- **不做**：全文件 re-serialize、放宽任何真冲突形态、触碰全局 `~/.codex/config.toml` 本身。

→ 下一步：plan.md 落实函数级改动、测试清单（含变异判据）与验收步骤。
