# Design Review — plan.md (FLY-1066) (Round 3)

Date: 2026-07-16
Author: Codex
Status: CHANGES REQUESTED

## Summary

`plan.md` 的四项 Round 2 技术问题均已实质闭环：revival 契约、逐候选 TOCTOU 重验、terminated archive 的真实接线，以及 M2 三类 timestamp 负例都已明确到可实现、可反证的程度；主设计现在具备实施可行性和足够的 fail-closed 安全性。剩余问题仅在被声明为实现依据的 supporting docs：research 仍有两句直接反转主计划契约，exploration 流程图也没有把 global tail 接到 full-harvest 入口，因此在这些锚点同步前仍不建议开工。

## What's Good (Keep)

- M3 revival 已从开放问题变成明确契约：`residue_harvest` 与 `recovery` 同属 machine-proven clear，二者均允许更晚 episode 复活；`lead` 保持不复活。计划正确引用了三列主键、`INSERT OR IGNORE` 和 same-ID replay，测试也覆盖 NEW 复活及 notify/ack/page/clearing/attempts 全量重置。
- global presence index 现在只承担 first-pass filter；每个候选 UPDATE 前同步重读 StateStore 并逐库重查全部 configured-project CommDB，presence/read error 一律 keep。注入“index 后同 ID 注册”的 race test 能直接证明该保护不是 vacuous green。
- M2 已精确指向 `archiveIssueThreadIfNoOtherActive(..., { allowStatuses: ["terminated"] })` 的 production closure，并明确禁止误用 completed-only 的 `maybeArchiveThreadOnClose`；production-wiring sentinel 能覆盖“spy 被调用但真实 helper no-op”的缺口。
- M2 的 missing/invalid/future `started_at` 三个负例已经逐项写入里程碑测试，和 §2、M1 及汇总验收一致。
- 其余 Round 1 决策仍成立：仅 proven-dead 才删除/终态化，alive/indeterminate 与 founder-owned live review session 永远 keep；24h/30min age guard、FLY-817 修订、flag matrix、既有 maintenance seam 和 mandatory preflight 均保持正确。
- M1→M6 的顺序和现有架构匹配；M4 同 commit 注册/read flag、M5 再做组合回归，能保持每个提交独立全绿。

## Issues & Recommendations

1. **[MEDIUM] `research.md` 仍保留两条与已批准主计划相反的实现指令。** `research.md:79` 仍写“RESOLVED fingerprint 不复活”并把新 token/方法留作 `implement 定`，但真实现行代码只让 `recovery` 复活，而新版计划要求把 `residue_harvest` 加入同一 predicate；实现者若按该锚点会重新造成永久静音。`research.md:93` 又写“若经 applyTransition 通用路径则不额外触发” QA-loss，和同文件 `:91-92` 及 `plan.md:53-78` 的正确结论冲突：`applyTransition` 不带 QA-loss，M2 成功后必须显式调用注入 hook。**建议：**把 §3.4 改成三列 PK + `INSERT OR IGNORE` + `recovery|residue_harvest` 可复活、`lead` 不复活的最终契约；把 §5 最后一条改成“M2 必须显式调用 `onQaPhaseTerminated`，后续是否 respawn 由 FLY-1050 守卫链决定”，删除“不额外触发”。这是 supporting-doc correctness，不是主计划重设计。

2. **[LOW] `exploration.md` 的 Mermaid 仍未真正表达 global-once tail 的调用关系。** `exploration.md:90-95` 让 boot、heartbeat 和 targeted 都指向 `H[harvestResidue 每 project]`，但新增的 `A2[全量 pass 尾部,全局一次]` 是一个没有入边的孤立节点；它既没有显示 M3 在所有 per-project M1/M2 完成后运行，也会让 targeted 看起来进入 full per-project harvester，而主计划实际只调用 `ghostReconcileOne`。**建议：**画出 boot/heartbeat → full-harvest orchestrator → per-project M1+M2 → global M3 tail，并让 scheduled-run 单独指向 single-row M2 targeted path；不要把 targeted 接进 full pass。

## Verdict

CHANGES REQUESTED — address items above
