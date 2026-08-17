# Design Review — FLY-1455 plan.md (Round 2)

Date: 2026-08-16
Author: Codex
Status: CHANGES REQUESTED

## Summary

v2 已实质修正 Round 1 的大多数问题：基线与 census 可信，账本语义拆开，`.mjs`/生产 scripts、shell 五形态、TypeChecker 枚举和 test-only scanner 都可落地，且没有触碰任何 scope 红线。但计划仍有几处会让实现后的门漏扫或在当前 registry 上直接失败的合同缺口，尤其是 AST 切换、PR-1 exemption 防腐和 reverse metadata，因此还不能批准开工。

## What's Good (Keep)

- B0a → B0b → B2′ 的边界与顺序继续符合上游终版；没有创建时退役条件、自动 cleanup issue、retirement scaffolding、`question` 行为或重复实现 `longTermKeep`。
- 当前基线已校正：head 为 `8ce9388bf`；唯一 delegated consumer 是 `codex_hard_gate_killswitch` 的 `auto-qa-held.ts`；`FLYWHEEL_ASK_HYGIENE` 已是 FLY-1807 tombstone。fixture 17/19b 的拆分正确。
- 规模数字可复现：21 个 package `src/`、payload-endpoint 的 8 个源码全为 `.mjs`、递归 shell 面 195 文件/438 个 distinct 名、扩现有四正则新增 13 个名且 11 个未处理、生产 scripts 的 `.ts` 有 17 个 distinct 名。
- config 枚举方案可行：真 `Program + TypeChecker` 可从当前 `FlywheelConfig` 得到计划列出的精确 14-path 集合，覆盖 optional、`Record` 通配、数组元素和嵌套类型；集合级 census 比只测 `qa.auto` 强很多。
- `.ts`/`.mjs` 单文件 `createSourceFile` 在当前计划扫描面 1,031 个文件上均可解析；`typescript` 确为 config devDependency，config 测试也确实进入 CI light matrix。
- shell 新增 presence/alias/comment fixture、exemption 的 whitespace/duplicate/stale fixture，以及 scanner 移入 `src/__tests__/drift-scan/` 并禁止 public export，都是合适的降风险措施。
- 当前相关基线测试保持 60/60 通过（drift 4、registry 35、truth 21）。

## Issues & Recommendations

1. **[BLOCKER] PR-2 把 AST 设为 `.ts`/`.mjs` 的唯一判定主体，却没有保留 B0a 的 direct env 读法，会产生覆盖回退。** `plan.md:145-155` 列出的 AST 形态没有无条件识别 `process.env.FLYWHEEL_X`、literal bracket read，或“先读取/作为 helper 参数、之后再解析”的用法；同时第 155 行明确旧正则只在 AST 解析失败时兜底。现守卫的 broad direct regex（`feature-flags-drift.test.ts:57-89`）会抓到这些形态，当前生产也有 `liveness-evidence.ts:24`、`check-flag-truth.ts:21` 等直接读取。照计划实现后，`const raw = process.env.FLYWHEEL_NEW; return parseBool(raw)` 可从已覆盖变为漏网，且与上游明确要求覆盖 helper/parseBool 相冲突。**建议：**AST 无条件发出 `process.env.X`、`process.env["X"]`、同文件 const-key 和 destructuring 命中；最简单安全的做法是让 B0b 结果为“现有 direct regex 命中 ∪ AST 新增命中”，而不是替换。对注入对象再单独保留 boolean-context 降噪，并增加 `parseBool(cfg.FLYWHEEL_FAKE)`/assignment-to-helper fixture。

2. **[BLOCKER] PR-1 的 env exemption stale 检查仍可被 TS/JS 注释或字符串假保活，所谓“无不受约束中间态”尚未成立。** PR-1 保留原四正则（`plan.md:110`），只为 shell 去 full-line comment（第 116 行），却在同一 PR 宣称 `kind: "env"` 的 stale 防腐已完整上线（第 198/275 行）。当前 scanner 对原始源码跑 regex；一行 `// process.env.FLYWHEEL_PREPLANTED` 或字符串示例即可让预埋 exemption 看起来“有读点”，直到 PR-2 AST 才会被纠正。fixture 14 只测“完全无命中”，没有覆盖这个真实假阳性。**建议：**PR-1 就使用忽略 trivia/string literal 的 TS/JS lexical/AST direct scanner，或至少让 stale 判定使用结构化 code-only 命中；fixture 14 增加 comment-only 与 string-only 两个预埋样本。shell 的 heredoc/inline-comment 限制若不处理，也应列入诚实边界。

3. **[BLOCKER] “带理由入账”只对 `FLAG_EXEMPTIONS` 做了机器校验，两本 non-flag 分类账仍可用空白理由绕过。** §3/§5.2 声明 `NON_FLAG_ALLOWLIST` 与 `NON_FLAG_CONFIG_KEYS` 都必须有 reason，但 §5.3 的 `reason.trim()` 条款只适用于 `FlagExemption`；§6 也只写 membership/overlap。`Record<string, string>` 不会阻止 `"   "`，因此新 env/config gate 仍能通过一个无理由分类项放行。当前 171 条 `NON_FLAG_ALLOWLIST` 理由均非空，补断言无需存量清理。**建议：**PR-1 对全部 `NON_FLAG_ALLOWLIST` reason 做 trim 非空断言，PR-2 对 `NON_FLAG_CONFIG_KEYS` 做同样断言并保留 stale-subset 检查；各加 whitespace 负向 fixture。另请消除批次矛盾：§5.3 要求 PR-1 与 `NON_FLAG_CONFIG_KEYS` 互斥，但 §8 到 PR-2 才创建该账；可在 PR-1 落空 ledger skeleton，或把这一项明确标成 PR-2。

4. **[BLOCKER] `dynamic` reverse 的“现有 symbol 锚点”在当前 registry 上不可执行，计划漏了必要 migration。** 当前共有 6 个 dynamic readSite；只有 `resolveLiveMailboxQueueEnabled` 与 `converge_cmux_symlink` 的 `symbol` 原文存在。另 4 个是描述串而非源码 identifier：两个 `resolveDefaultOnGate live dotenv CLI fallback (...)`、`resolveDefaultOffGate live dotenv CLI fallback`、`verifyApprovalWithBridgeHead workflow dotenv read`，在声明文件中均无该字面文本。若按 `plan.md:222` 精确验证，PR-2 会立即红；若实现者自行模糊拆词，合同又不确定且注释可假通过。**建议：**为 dynamic site 增加机器字段（如 `anchorSymbol`）或把现有 `symbol` 迁成真实声明 identifier，并用 AST 证明该 declaration/call 存在；在计划和 migration fixture 中点名全部 6 个 dynamic site，而不只迁 delegated site。

5. **[HIGH] config reverse 只验证 dot-path 末段属性名，不能证明声明的 configKey 被读取。** `plan.md:221` 会让任意 `does_not_exist.enabled` 在 `ConfigLoader.ts` 通过，因为该文件的同一个 `ConfigLoader.validate` 内已有多处无关 `.enabled`（proofshot、checkpoints、doc_flow、milestone、ponytail、xiaohongshu）。这正是 reverse 想阻止的“登记了一个看似合法但 readSite 不真”的假证据。**建议：**把证据约束到声明的 symbol AST 子树，并做 path-specific 验证；可用局部 const alias 追踪重建 `c.skills → skills.proofshot → ps.enabled`，或在 readSite 增加明确的 `configAccess` 锚点并逐项迁移。增加负向 fixture：同文件存在无关 `.enabled`，但目标 `foo.enabled` 不存在时必须红。

## Verdict

CHANGES REQUESTED — address items above
