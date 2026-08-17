# Design Review — FLY-1455 plan.md (Round 4)

Date: 2026-08-16
Author: Codex
Status: CHANGES REQUESTED

## Summary

v4 正确解决了 shell dynamic reverse，并在 §4.1 给出了可实现的三层扫描数据流；scope、PR 顺序及 Annie 的五条红线也都保持正确。但 config migration 表仍不是完整的逐行映射，且多个现行章节继续把 raw regex 写成命中权威，直接冲突于 v4 的核心安全合同，因此计划仍未达到 implement-ready。

## What's Good (Keep)

- `regexCandidates → rawCodeHits → unhandledHits` 的职责拆分方向正确；scanner 不读取 ledger、stale 只消费 code-only evidence、parse failure fail-closed，能够同时满足 fixtures 7b/7c/9d/14/21/22。
- `.sh` dynamic reverse 现在按文件类型原生验证 anchored assignment 与真实 gate reference，和 `scripts/converge-flywheel-bin.sh` 的现状一致；fixture 16d 给出了必要的正负对照。
- config reverse 新增 `configAccess`、`ClassName.methodName` 解析及 optional-chain/assertion normalization，技术上可用单文件 AST 实现，不需要新增依赖或 Program。
- `skill_framework_split_participation` 的真实 config read 已识别到 canonical reader，不再把 Blueprint 的注入回调伪装成配置读取证据。
- PR-1/PR-2/B2′ 的边界仍合理；没有引入 creation-time retirement condition、自动 cleanup issue、retirement-declaration scaffolding、`question` 行为变更或 `longTermKeep` 实现。

## Issues & Recommendations

1. **BLOCKER — 所谓“逐行 config migration mapping”实际仍只具体处理了 7 行中的 2 行，而且关键值仍留到实现时猜。** §5.4 的 `doc_flow` 行没有写出已经可从源码确定的 symbol `Blueprint.runInner`；`skill_framework_split_participation` 仍以条件分支描述 Blueprint consumer，但当前源码已明确：Blueprint 不 import canonical reader，故旧 consumer 行应删除（真实 import-and-call 在 `run-infra.ts`，是否另列 delegated site 应显式决定）。其余 5 行仍被合并为“实现时以 AST 证据定”，与“fixture 17 按具体映射断言”不相容。建议把当前 7 行完整钉死为：`qa_auto → resolveAutoQaPolicy / cfg.auto`；`doc_flow → Blueprint.runInner / this.docFlowConfig.enabled`；`skill_framework_split_participation → makeSkillFrameworkParticipationReader / skillFramework.split` 且删除旧 Blueprint config row；`proofshot → ConfigLoader.validate / ps.enabled`；`xiaohongshu_learning → ConfigLoader.validate / xhs.enabled`；`ponytail → ConfigLoader.validate / ponytail.enabled`；`founder_ux_gate → ConfigLoader.validate / founderUxGate.mode`。fixture 17 逐项断言 file、symbol、pattern、configAccess 四元组。

2. **BLOCKER — 旧的 `regex ∪ AST` 权威语义仍散落在当前合同中，会重新打开 comment/string 保活漏洞。** §3 图仍标注“命中集=∪”并让 `REGEX` 直接进入 `VERDICT`；§5.1 又写“命中集恒为 broad direct 正则 ∪ AST”；§5.3 stale 行仍说走 `AST∪正则`；§8 PR-1 也保留“code-only 命中,∪ broad 正则”。这些不是历史 revision note，而是实现章节，与 §4.1 的“regexCandidates 永远不是命中权威”互斥。建议全局统一为：regex 只进入 cross-check/diagnostics，只有 `rawCodeHits` 与 schema enumeration 进入 classification/verdict；stale 明写仅查 `rawCodeHits`；fixture 7b 改称“AST authority + regex cross-check”而非并集合同；PR-1 描述同步改正。验收清单也应从 fixture 1–21 更新为 1–22。

3. **HIGH — cross-check 需要 occurrence-level identity，当前 `{ name, file, form }` 输出不足以证明“每个 regexCandidate”都被 AST 覆盖。** 同一文件若已有另一个同名 AST hit，仅按 file/name/form 对集合可能让漏解析的 candidate 被遮住，fixture 22 的单例也抓不到。建议 `regexCandidate` 与内部 AST hit 都携带 source span（至少 `start/end` 或 line/column），按重叠/对应节点逐 occurrence 校验；最终面向 ledger 的去重结果仍可保持 `{name,file,form}`。fixture 22 增加“同文件同名两次：一处已覆盖、一处故意缺 raw hit”的负例，证明 cross-check 不会被旁边的合法 hit 假通过。

## Verdict

CHANGES REQUESTED — address items above
