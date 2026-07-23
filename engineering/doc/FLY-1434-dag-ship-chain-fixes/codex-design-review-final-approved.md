# Design Review — FLY-1434 plan.md (Round 16)

Date: 2026-07-23
Author: Codex
Status: APPROVED

## Summary

v16 已实质关闭 Round 15 的两个剩余问题：terminal-authority fence 让 manual closeout 的 authority 集在 terminate 事务两侧都可线性化，runbook 也在正常、lost-response recovery 与最终复核路径上统一重跑关键门并精确绑定 termination event。对照当前 StateStore、run-management route、engine transition 与 land 入口后，方案可按现有单写者 SQLite 架构实现，未发现新的阻塞性正确性、范围或部署顺序问题。

## What's Good (Keep)

- plan.md:211 把 manifest open/seal/reopen、current revision、node PR binding 新 attempt、ship-target binding supersede/new-current 统一纳入 run-status fence；`active|held` 才可变更，`terminated|completed` 固定返回 `RUN_TERMINAL_AUTHORITY_FROZEN`。
- “完全相同历史 payload 先判幂等 no-op，再做 terminal fence”的规则保住了重放兼容性；当前 `commitWorkflowTransitionTx` 已采用先查 immutable receipt、后校验 run active 的同类结构（StateStore.ts:21174-21242），实现上无需新并发模型。
- 双向竞态契约完整：authority-write-first 由 terminate 事务内 digest 重算拒绝，terminate-first 由写端同事务 status fence 拒绝；single→manifest、declared reopen、late ship-binding supersede 和两种提交顺序均有明确测试。
- PR-1→PR-2→PR-3 顺序仍成立：fence 随 PR-2 补齐后，PR-3 才开放 diagnostic/runbook 执行，不会在缺少冻结语义的中间版本宣称人工 closeout 可用。
- runbook 的 `validate_snapshot()` 同时用于 held preflight、terminated recovery 和 post-terminate recheck，统一检查 schema、权威 hold reason、land/finalization absence、out-of-set、declared 全集或唯一 single target。
- recovery 从持久化 termination event 恢复 `EXPECTED_DIGEST`/`EXPECTED_CRID`，正常路径从 preflight digest 派生；最终复核逐字节核对 `closeout_kind + client_request_id + closeout_invariant_digest` 后才打印 Linear Done 提示。
- post-terminate manifest drift、late out-of-set receipt、错误 schema version 均被明确列入不得到达 Done prompt 的 QA；这与 append-only ledger、fail-closed 诊断面和人工收尾边界一致。
- 本轮重新提取 runbook bash block 执行 `bash -n` 与 `shellcheck -s bash -`，两者均通过。
- ①-⑩ 的既定范围、nested review-only scope cut、四个 PR 的所有权、consent 语义、exact-head authority 与多 PR finalization guard 均未被本轮修订破坏。

## Issues & Recommendations

1. **无阻塞问题。** 实现时应把 terminal fence 做成 StateStore 的 tx-local 共用守卫，并保持“exact historical replay 判定在前、run-status mutation fence 在后”的顺序，避免各写入口复制出细微差异；计划现有固定原因码与竞态测试足以验收这一点。
2. **非阻塞加固建议：**可将 runbook 当前 held 分支单独执行的 `.quiescence.quiescent == true` 断言也收进 `validate_snapshot()`，使“recovery 只放宽 run.status”的注释在代码结构上完全字面成立。现设计的安全性已由 terminate 事务内 30 秒 quiescence 重验、terminal admission/fence 与最终关键集合复核覆盖，因此不影响本轮批准。

## Verdict

APPROVED — ready to implement
