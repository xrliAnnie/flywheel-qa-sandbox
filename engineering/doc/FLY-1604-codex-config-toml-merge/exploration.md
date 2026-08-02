# FLY-1604 Codex config.toml TOML-aware 合并 — 探索

Issue: FLY-1604 (https://linear.app/geoforge3d/issue/FLY-1604/阻塞p0-codex-implement-节点全部起不来-rendercodexhomeconfig-撞上-codex-自己写的-shell)
日期: 2026-08-02
基于: 无

## 1. 问题重述

`renderCodexHomeConfig`（`packages/claude-runner/src/codex-home.ts:425`）给每个 Codex runner 渲染 per-runner `config.toml` = 全局 `~/.codex/config.toml` 原样 + flywheel-managed GH_TOKEN block。它是一个**刻意最小化的字符串拼接 writer**：GH_TOKEN 以完整的

```toml
# >>> flywheel-managed credential (FLY-123) — do not edit >>>
[shell_environment_policy.set]
GH_TOKEN = "…"
# <<< flywheel-managed credential (FLY-123) <<<
```

block 追加在文件末尾。TOML 禁止重复定义同一个表，所以 writer 带一条守卫（`codex-home.ts:445-457`）：base 只要声明过 `shell_environment_policy` 命名空间就 fail loud。守卫成立的前提写在注释里："the global config is verified not to declare it"。

**这个前提在 2026-08-01 16:05 被 Codex 自己打破了**：Codex CLI 在 `~/.codex/config.toml:906` 写入了自己的

```toml
[shell_environment_policy.set]
BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab"
NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S = "41e1151f…,6d25aa76…"
NODE_REPL_TRUSTED_CODE_PATHS = "/Users/xiaorongli/.codex"
```

（全文件仅此一处；无 flywheel managed 标记 —— 已实际核对。）于是每次 provision 走到守卫必然 throw，**所有 Codex implement 节点起不来**（FLY-1603 session e70e3640 实证失败；三段式 implement 固定是 Codex，故 FLY-1602 及后续所有单都会撞墙）。

守卫本身行为正确 —— 它守的假设过期了。要修的是给 writer 一条**合法的合并路径**：GH_TOKEN 并进**已存在的** `[shell_environment_policy.set]` 表，而不是另起表头。

## 2. 约束（来自 issue + 现有合同）

1. Codex 写的三个键**不许删不许改**（那是 Codex 的运行配置）。
2. 幂等：重复渲染不产生重复键；现有 managed block 剥离逻辑（sentinel 注释）照旧。
3. **不放宽守卫**：无法安全合并的形态仍要 fail loud —— 只是新增一条合法合并路径。
4. WS-C 合同："base config preserved verbatim"（保留 model / sandbox_mode / trust levels，以及注释和格式 —— base 是 Codex 自己的活文件的副本）。
5. 现有测试有 byte-identical 断言（`test/codex-home.test.ts:183`）：**无冲突路径的输出必须字节不变**。
6. `skills` 命名空间那条同形守卫（`codex-home.ts:458-467`）是同一个病的另一半，一并评估。

## 3. 候选方案

### 方案 A：TOML-aware 合并（issue 指定的方向）

用 TOML parser 理解 base 的结构，把 GH_TOKEN 并进已有的表。内部又分两条路线：

**A1 — 键级手术注入 + parse 验证（选定）**
base 文本保持逐字不动，只在已有的 `[shell_environment_policy.set]` 表头行**紧后面**插入一个 *无表头* 的 sentinel-wrapped 键行：

```toml
[shell_environment_policy.set]          ← base 原有行，不动
# >>> flywheel-managed credential (FLY-123) — do not edit >>>
GH_TOKEN = "…"
# <<< flywheel-managed credential (FLY-123) <<<
BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab"   ← base 原有行，不动
…
```

TOML 语义上紧跟表头的键行属于该表，键序无语义 → GH_TOKEN 与 Codex 三键同表共存。插在表头**紧后**而非表体末尾，是因为表头行是唯一可靠锚点 —— 不需要计算"表体到哪结束"。

关键优雅点：**现有 `stripManagedBlock` 的 sentinel regex 对这个无表头形态原样适用** —— 幂等 strip、scrub（无 token 重渲染时移除凭据）语义零改动。

TOML parser（`smol-toml`，monorepo 已有）只做两件事：
- **合并前**：parse base，确认结构可安全手术（`shell_environment_policy.set` 是标准表头形态、唯一、且表内没有已存在的 `GH_TOKEN` 键）；
- **合并后**：parse 产物，断言合法 TOML + GH_TOKEN 注入成功 + Codex 原有键值逐个保留。

任何不可手术的形态（dotted-key / inline table / quoted 表头 / 同表已有 GH_TOKEN / base 本身非法 TOML）→ 维持 fail loud。**不用 stringify**，避免整文件 round-trip。

**A2 — 全量 parse + 程序化 merge + re-stringify（否决）**
parse 整个 base → 对象上 merge → `smol-toml` stringify 重排整个文件。缺点：注释全丢、格式重排，违反 "base preserved verbatim"；906 行生产 config 走 round-trip，serializer 的任何边角（datetime、特殊字符、表排序）都会成为新的故障面；byte-identical 合同破坏。收益只是省一段定位 regex，不成比例。

### 方案 B：换注入通道（否决）

绕开 config.toml：GH_TOKEN 回到 `-c shell_environment_policy.set.GH_TOKEN=…` argv，或直接放 spawn env 靠 inherit 传播。否决理由：argv 注入正是 WS-C 特意消灭的（`ps` 可见泄露凭据）；env inherit 路线改变凭据传播的安全模型且依赖 Codex 的 inherit 行为，改动半径远超本单。issue 已明确 scope 是 TOML-aware 合并。

### 方案 C：清理全局 config 里 Codex 写的键（否决）

治标：Codex 会再写回；且 issue 明令"不许删不许改"。

## 4. skills 守卫（:458-467）评估

同一个病：假设全局 config 不声明 `skills` 命名空间。当前真实 config **没有** skills 声明（已核对），所以此刻不炸 —— 但 Codex 哪天写入 skills 配置（它管理 skill enable/disable，完全可能），就是下一个 FLY-1604。

结构上有个重要差别：我们 append 的是 `[[skills.config]]` **array-of-tables 元素**。TOML 允许 `[[skills.config]]` 多次出现（每次追加数组元素），也允许 base 先有 `[skills]` 再出现 `[[skills.config]]`。也就是说 skills 侧多数"冲突"形态其实**根本不是冲突**，现守卫过度保守。真冲突只有：`skills` / `skills.config` 以 inline 或 dotted 赋值形态定义（inline 定义后不可扩展），或 `[skills.config]` 被定义为**单表**（不能再变数组）。

⇒ skills 侧不需要键级合并手术（没有要并进已有表的键），只需要：**守卫细化**（只拦真冲突形态）+ **产物 parse 验证**兜底（奇形怪状最终由"产物必须是合法 TOML 且断言成立"抓住）。

## 5. 结论

选 **A1**：键级手术注入（sentinel-wrapped 无表头键行插到已有表头紧后）+ smol-toml parse 前置检查与产物验证；skills 守卫细化 + 同一套产物验证；所有不可手术形态维持 fail loud。无冲突路径字节不变。

→ 下一步：research.md 落实 TOML 规则细节、smol-toml 能力面、以及全部边界形态的处置矩阵。
