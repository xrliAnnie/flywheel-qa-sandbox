# Design Review — FLY-1455 plan.md (Round 1)

Date: 2026-08-16
Author: Codex
Status: CHANGES REQUESTED

## Summary

总体方向正确：B0a/B0b 分层、B2′ 只保留登记强制、显式 backfill 与负向 fixture 都符合上游裁决，且没有触碰 Annie 的五条红线。但当前计划还不是 implementation-ready：账本语义自相矛盾，reverse 基线已经失真，AST/shell 扫描仍保留可直接绕过的常见写法，豁免防腐又被延后到 PR-2；因此它目前无法兑现“没有第三种存在方式”的核心不变量。

## What's Good (Keep)

- B0a（目录/shell）与 B0b（AST/schema/reverse）保持分离，PR-1 → PR-2 → B2′ 收口的总体顺序合理；B2′ 折进 PR-2 尾部也比另起一张小 PR 更简单。
- 关键规模大体可复现：当前确有 21 个 `packages/*/src`、现守卫只扫 4 个；`payload-endpoint/src` 全是 `.mjs`；按现有四个正则扩到 21 个 package 后新增正好 13 个名字，其中 11 个既未登记也未 allowlist；按计划的直接 shell 布尔比较启发式约命中 42 个名字。
- `typescript@^5.3.3` 确实是 `packages/config` 的 devDependency；`flywheel-config` 由 `.github/workflows/ci.yml` 的 light unit matrix 执行，因此不需要新增 CI job。
- 首跑逐名裁决、提交 `backfill-ledger.md`、不确定项必须点名给 Lead，以及错误消息给出合法修复路径，这些都能控制首次扩网噪声。
- 红线处理正确：没有创建时 `longTermKeep` 强制、自动 follow-up、退役 scaffolding、`question` 行为改动或重复实现 FLY-1779。现有三份定向测试在当前 head 为 60/60 通过。

## Issues & Recommendations

1. **[BLOCKER] config 普通布尔被放进了错误的账本，计划自己的语义合同互相冲突。** `plan.md:141` 要求 `skills.enabled`、`checkpoints.*.enabled` 等“普通配置、不是 rollout gate”的键进入 `kind: "config_key"` 的 exemption；但 `plan.md:154-164` 又把 `FLAG_EXEMPTIONS` 明确定义为“这是真 gate，只是刻意不登记”，并强调不能和 `NON_FLAG_ALLOWLIST` 的“这不是 flag”分类混在一起。这样 backfill 后账面事实会说谎。**建议：**为非 flag 的 config key 增加独立的带理由分类账（例如 `NON_FLAG_CONFIG_KEY_ALLOWLIST`，或把现有 non-flag 账改成带 `kind` 的判别联合）；`FLAG_EXEMPTIONS` 只收真实 gate。B2′ 分别检查 registry、non-flag 分类账和真实 exemption，禁止跨账重叠。

2. **[BLOCKER] reverse migration 基线已经过期，照计划实施会修改不存在的 registry 行。** 在当前 head `8ce9388bf` 上，逐个检查所有 env flag/readSite，只有 `codex_hard_gate_killswitch` 的 `auto-qa-held.ts` 一个 site 不含 env 字面量；`FLYWHEEL_ASK_HYGIENE` 已在 `truth.ts:450` 被 FLY-1807 退役，registry 中没有 `ask_hygiene`。因此 `plan.md:178/213` 的“4 个现存 site”与 migration fixture 不成立。另一个数字口径也需改正：264 可复现的是根目录顶层 `scripts/*.sh`，不是 `plan.md:98` 的完整递归 root + package scripts 扫描面；完整排除 `__tests__` 后约为 195 个 shell 文件、438 个 distinct `FLYWHEEL_*` 名字（布尔锚定命中量仍约 42）。**建议：**在 plan 中记录当前 head 的动态 census，fixture 17 改为当前唯一 delegated site，并增加 `ask_hygiene` 只能留在 tombstone、不得复活的回归；backfill 数量由实现时 scanner 输出生成，不把 264 描述成全扫描面。

3. **[BLOCKER] B0b 明知 `.mjs` 是关键缺口，却故意不让 AST 扫它，语法绕过会原样留在 `payload-endpoint`。** `createSourceFile(..., ScriptKind.JS)` 能解析 `.mjs`，无需 Program/type-check；`plan.md:134` 让 `.mjs` 继续只走旧正则，意味着 `.mjs` 中的解构、注入参数、truthy/helper 仍可野建。扫描面还遗漏了生产 `scripts/**/*.ts`；当前这些文件已有 17 个 distinct `FLYWHEEL_*` 读点。fixture 9 的 `if (process.env.FLYWHEEL_FAKE)` 又早已被 B0a 的 broad `process.env.X` 正则抓到，不能证明 AST 增加了任何覆盖。**建议：**同一语法 scanner 覆盖 `.ts` 与 `.mjs`（分别用 TS/JS ScriptKind），并把根/包级生产 scripts 的 `.ts/.mjs` 纳入；用 `cfg.FLYWHEEL_FAKE && ...`、重命名解构、wrapper/string-key helper 等真正会绕过旧正则的 fixture 证明 B0b。若 root `.ts` 明确不做，必须从“不许野建”的闭网承诺中排除并写入诚实边界。

4. **[BLOCKER] shell boolean-anchor 集合不足以支撑“覆盖当前全部实际写法”的断言。** 计划只认与 `0|1|true|false` 的直接比较/相邻 `case`，但当前生产脚本已有常见 presence gate，例如 `codex-lead-tui-home.sh` 的 `-z "${FLYWHEEL_TUI_HOME_REEXEC:-}"`、`codex-lead.sh` 的 `-z "${FLYWHEEL_LEAD_CORE_MENTION_GATED:-}"`，以及先赋给局部变量再比较的 `FLYWHEEL_CMUX_DRY_RUN`。这些不是 §9 所列的 `eval`/拼接/`printenv` 难例，新 flag 可以照抄后直接绕过；原始文本正则还可能把注释中的示例当命中并让 stale exemption 假存活。**建议：**至少覆盖直接 `-n/-z` presence gate、明确处理当前 alias-then-compare 形态，并忽略 full-line comments；若为了降噪决定不覆盖，必须把这些具体形态列为 residual、收窄核心不变量。为表中每种左右值/引号/default/`case` 形态、presence、alias、注释正反例各加 fixture，不能只测当前 fixture 4 的一种写法。

5. **[BLOCKER] pattern-aware reverse 的 metadata 不足以证明“canonical resolver”，且 direct 规则会误伤当前唯一 canonical resolver。** `resolverSymbol` 放在 `FeatureFlagSpec` 顶层只证明某个同名标识符被 import/call，不能证明 import 来自哪个模块，也不能表达不同 site 的 resolver；本地同名函数或错误模块可假通过。与此同时 `codex-gate.ts:20/58` 实际用 `const HARD_GATE_ENV = "FLYWHEEL_CODEX_HARD_GATE"; env[HARD_GATE_ENV]`，不属于 `plan.md:175` 所写的 envVar 字面属性/解构，canonical direct site 自己会红。`config`/`dynamic` “维持宽松”也没有定义 `every` 时最低检查，可能让缺文件/陈旧 site 自动通过。**建议：**把 resolver 身份放到每个 delegated readSite（至少 canonical module path + exported symbol），验证 named import（含 alias）确实解析到该模块且被调用；direct scanner 支持同文件 `const` 字符串键并加 fixture；`config` 至少验证声明的 config path 在该文件的真实属性访问，`dynamic` 至少要求文件存在、稳定 symbol/理由存在，不能无条件 true。

6. **[BLOCKER] exemption 在 PR-1 已成为实际放行口，但防腐到 PR-2 才上线。** `plan.md:224-225` 让 B0a backfill 在 PR-1 使用 exemption skeleton，却把空白/stale/互斥检查全部延后；这会形成一个可合入的中间状态，允许预埋、重复或矛盾豁免。现有四条本身也少了 whitespace、重复 `(kind,name)`、与 `NON_FLAG_ALLOWLIST`/tombstone 的互斥，以及 registry 对比必须使用外部身份 `envVar/configKey` 而不是内部 `spec.name`。**建议：**骨架前置是对的，但 PR-1 必须同时交付其当时可判定的最小防腐：trim 后非空 reason/owner、键唯一、与 registry envVar/configKey、non-flag 账及 tombstone 互斥、env stale 检查；PR-2 再扩展 config-key stale。对应增加 whitespace、duplicate、cross-ledger overlap 和预埋豁免负向 fixture。

7. **[HIGH] config-schema 枚举与测试合同还不足以防部分静默漏扫。** 当前 `FlywheelConfig` 可达闭包能枚举出 14 个 boolean path，方向可行；但其中有 `Record<string, CheckpointConfig>`、数组元素和多层 type reference，单文件手写遍历很容易只漏一支，而“非空且含 `qa.auto`”仍会绿。`ConfigLoader.ts` 又是独立手写 runtime 校验，计划没有定义两者漂移时谁报警。**建议：**优先用 TypeScript Program/TypeChecker 从 `FlywheelConfig` 展开类型（这不影响普通源码 read-site scanner 继续使用单文件 AST），或至少用 fixture 覆盖 optional boolean、type alias、Record wildcard、array element、嵌套 interface，并固定当前 14-path census 的集合级验收；补一条 types/ConfigLoader runtime 合同的明确残余或 parity 测试。

8. **[MEDIUM] `typescript` 只是 devDependency，scanner 的生产可达性必须写死。** `drift-scan.ts` 被放在 `src/feature-flags` 并 runtime-import `typescript`；如果顺手从 `feature-flags/index.ts` 导出，生产-only 安装会加载一个不存在的 dependency。**建议：**明确该模块只供测试、不得从 package/public index 导出（或移到 test helper 位置）；若确需生产导出，则 `typescript` 必须成为 runtime dependency。增加 package public-import/build smoke，防止未来误导出。

## Verdict

CHANGES REQUESTED — address items above
