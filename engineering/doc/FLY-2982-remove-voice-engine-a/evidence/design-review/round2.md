# Design Review — plan.md (Round 2)

Date: 2026-09-27 / Author: Codex / Status: APPROVED

## Summary

Round 1 的两项 HIGH 均已在 v2 设计中闭合，未发现本轮修改引入新的 BLOCKER/HIGH。允许按修订后的计划进入实施。

评审固定于 `c3314487c5f056c1915b2e6003a6ab36f4233a93`，`plan.md` blob 为 `c397470fffc9dd97cb6aed8d45c7752c9612c220`。已完整重读计划，并核对相对 Round 1 HEAD `93945882462f3989ebffa6d1e5a1eb8a815e41d1` 的变更、research 对应段落及相关扫描器源码。该增量仅修改文档并归档 R1 反馈，没有实现改动。

## What's Good (Keep)

- T6 保留完整残留扫描范围，以精确路径、整行正则、限定类别和文件范围约束例外，没有豁免整个测试目录或混合文件。
- 自测覆盖原样通过、在已放行文件内注入 A 构造/旧字段读取失败、在非白名单文件内注入失败；陈旧白名单条目同样失败。
- `OPENAI_API_KEY` 证据清单明确扫描范围，并为安装测试占位加入 `fixture-placeholder`，与 T5 的保留决定一致。
- 旗标登记删除与脚本最后读取点同 commit，且在该 commit 上运行 config 漂移检查；T1 消费者放松、T3 Bridge 停发字段的顺序保持不变。

## Issues & Recommendations

1. **R1 #1 [原 HIGH] — CLOSED。**

   依据：`plan.md:93–108`。`legacy-strip` 明确覆盖 ProjectConfig 和 host configure 的旧键删除；`negative-test` 覆盖 N1、N3–N9 所需的具体测试文件及输入/断言行。必要残留有了合法归类，同时整行匹配和 `:105` 的注入自测仍能拒绝同文件里的 A 调用。`plan.md:16,106,154` 与 `research.md:65,76` 均统一为“零未允许命中”。原先“不可能同时保留负向守卫并通过残留门”的矛盾已消除。

2. **R1 #2 [原 HIGH] — CLOSED。**

   依据：`plan.md:74–89`。T4 仅保留指引，实际登记删除在 T5 第 10 项，与 wrapper、fly2655、fly2799 收口处于 commit 4。已用固定提交的 `git grep` 复核所有 `FLYWHEEL_VOICE_BACKEND` 引用：生产侧位于 config 登记、voice-codex config、wrapper 和两个 QA 脚本，均有对应删除步骤。

   漂移扫描器 `packages/config/src/__tests__/drift-scan/index.ts:67–120` 排除 `__tests__` 和测试文件，`:609–620` 才对生产读取做登记审计。因此 N1/N7 保留旧环境值的负向夹具不会重新要求登记，也不再存在先删登记、后删 QA 读取的中间提交失败。

无新增 BLOCKER/HIGH；无需重新讨论已批准的 E1/E2 或生产不可用窗口。

## Verdict

APPROVED

本轮执行了固定 SHA 的 diff、全文读取、符号引用搜索及扫描器规则核对；未修改仓库文件。由于本轮只有文档修订，未重复运行 Round 1 已执行的基线测试，也未运行 build、tsc、Vitest、full CI 或尚未实现的 residue-check/self-test。本结论是设计批准；实际白名单、删除后的构建及测试结果仍由实施阶段按计划验收。
