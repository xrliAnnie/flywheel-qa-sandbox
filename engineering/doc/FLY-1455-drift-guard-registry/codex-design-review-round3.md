# Design Review — FLY-1455 plan.md (Round 3)

Date: 2026-08-16
Author: Codex
Status: CHANGES REQUESTED

## Summary

v3 在设计意图上关闭了 Round 2 的五项问题：保住 broad direct coverage、把 direct AST 与 code-only anti-rot 前移到 PR-1、补齐 ledger reason 合同，并显著收紧 reverse validation。当前仍有三处实现合同与现有 registry/扫描流水线不相容；按计划直接实现会让 PR-2 的迁移 fixture 无法通过，或重新允许注释/字符串保活豁免，因此尚不能批准。

## What's Good (Keep)

- 保留 `broad direct regex ∪ AST` 的覆盖目标，并用 fixture 7b 固定 `const raw = process.env.FLYWHEEL_FAKE; parseBool(raw)` 必须命中，正确解决了 Round 2 的 direct-form coverage regression。
- direct-form AST 与 env-kind stale check 一起进入 PR-1，且 fixtures 7c/14 明确把 comment-only、string-only 排除在 code hit 与 exemption 保活依据之外，方向正确。
- `NON_FLAG_CONFIG_KEYS` 空 skeleton、`NON_FLAG_ALLOWLIST`/exemption 的 trimmed non-empty reason、四账互斥及分阶段 stale checks 已形成一致的 PR-1/PR-2 合同。
- dynamic 描述串迁移与 `configAccess` 的 exact-chain + symbol-subtree 约束，比当前 `.includes(symbol)`/leaf-only 验证强得多；新增的 16b/16c negative fixtures 是必要的非真空证明。
- PR-1 → PR-2 的拆分仍符合 B0a/B0b/B2′ 边界；没有引入 creation-time retirement condition、自动 cleanup issue、retirement-declaration scaffolding、`question` 行为变更或 `longTermKeep` 实现，符合所有 scope red lines。

## Issues & Recommendations

1. **BLOCKER — `pattern: "config"` 的现存迁移仍无法满足新的 symbol-subtree 合同。** `doc_flow` 目前把 `symbol` 写成不存在于源码的描述串 `doc-flow injection`；`skill_framework_split_participation` 虽写成 identifier `skillFrameworkParticipation`，但 `packages/edge-worker/src/Blueprint.ts` 中它只是被调用的注入回调，`skill_framework.split` 的真实读取位于 `packages/teamlead/src/bridge/skill-framework-participation.ts` 的 `makeSkillFrameworkParticipationReader` 内。仅按 §5.4 所述“逐行补 `configAccess`”无法证明 exact chain 在声明 symbol 的 AST 子树内。建议在计划中列出精确迁移映射：把 `doc_flow` 锚到包含 `this.docFlowConfig?.enabled` 的真实方法；把 split participation 的 config readSite 移到 canonical reader（如 `makeSkillFrameworkParticipationReader` + `skillFramework.split`），并决定 Blueprint consumer 是否删除或改为明确的 delegated site。另请定义 `ConfigLoader.validate` 这类 class-method symbol 的解析语法，以及 optional chaining/type assertion 后的 access-chain 规范化；fixture 17 应断言这些具体映射，而不只是“所有 config 行通过”。

2. **BLOCKER — dynamic reverse 合同错误地把现有 shell site 当成 TS/JS AST identifier。** 六个 dynamic site 之一是 `scripts/converge-flywheel-bin.sh` 的 shell 变量 `converge_cmux_symlink`（赋值在第 296 行、比较在第 318 行），不是可由 TypeScript AST 找到的 declaration/call；因此 §5.4 所称“两个已是真 identifier、不动”与实现机制矛盾，六站点 migration fixture 必然红。建议按文件类型分派：`.ts`/`.mjs` 使用 identifier declaration/call AST；`.sh` 使用 shell scanner 验证锚定赋值和实际 gate 引用，或新增明确的 `shell` pattern 并迁移该行。补一对 shell dynamic 正/负 fixture，防止仅靠同名注释或无关变量通过。

3. **BLOCKER — `regex ∪ AST`、code-only 与 ledger 过滤的集合合同仍自相矛盾。** 当前 broad regex 对原始源码运行，会命中 comment/string；若最终命中集真是 raw regex 与 AST 的并集，fixture 7c/14 要求的 non-hit 就不可能成立。与此同时，§5.1 把“无锚定注入读是否报告”依赖四账 membership；若在 scanner 层直接过滤，合法 exemption 的读取会从 stale check 的证据中消失，反而被判 stale。建议在计划中明确三层数据流：`regexCandidates` 仅作覆盖交叉检查；`rawCodeHits` 由 AST（shell 则由 comment-aware scanner）产生、完全不依赖 ledger；`unhandledHits` 才在四账分类后得到。PR-1 env stale 与 PR-2 config stale 必须消费 `rawCodeHits`。对可解析 TS/MJS，comment/string regex candidate 必须丢弃；解析失败应 fail closed，并把 regex 仅作为诊断，不得用它保活 exemption。这样 fixture 7b、7c、9d、14 才能同时成立。

## Verdict

CHANGES REQUESTED — address items above
