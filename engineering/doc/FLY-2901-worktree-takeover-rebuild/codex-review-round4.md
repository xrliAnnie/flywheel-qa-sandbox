# Design Review — plan.md (Round 4)
Date: 2026-09-25 / Author: Codex / Status: CHANGES REQUESTED

## Summary

按本轮限定范围核验，v4 已关闭 R3 的两个原始 blocker 和两个 advisory：missing rebuild 会在 `L != R` 时无条件保全 `L`；pending rescue 有 Bridge-local 读取能力并在入口矩阵/kill switch 前执行；nested repo 使用独立命名空间；§2.3 也明确了 exclude 写入例外。对应的失败注入与真实 StateStore + DirectEventSink 重启测试均已进入验收表。

但 v4 的 manifest identity 修改直接引入了 1 个 blocking：规范要求 manifest 自身包含 `manifestSha256`，同时又要求读取该 manifest 后重算完整文件 SHA 与该值相等。若未定义“计算时排除该字段”的精确投影，这就是自引用哈希，无法按字面实现。除此之外没有发现会重新打开 R3 问题的回归。

评审基于提交 `0c4b865d8cc10473050e4db9c95dc73a0766ba10`，只读核对 v3→v4 delta 及直接相关源码合同；未运行测试，未修改仓库文件。

## What's Good (Keep)

- R3 #1 已关闭。只要 missing 类的 `L` 不等于本轮 `ls-remote` 验证的 `R`，即使 `L == target` 也先推送并复核 `-head` rescue（plan `:66-72`）。这覆盖了当前 `create()` 在 post-add 失败后调用 rollback、最终 `branch -D` 的真实路径（`packages/edge-worker/src/WorktreeManager.ts:1234-1327`, `:1498-1537`）。新增测试也分别注入 exclude、hook config、generation write 失败并要求远端 named ref 仍可达（plan `:247`）。
- R3 #2 的能力接线方向已关闭。`loadPendingTakeoverRescue({runId, canonicalPath})` 在同一 repo lock 内、入口矩阵与 kill switch 之前执行；只允许 DirectEventSink 通过 `StateStore.listWorkflowRunEvents()` 配对 rescue 与 `cleaned:<uid>`，HTTP/NoOp fail closed（plan `:101-108`, `:151-157`）。当前 StateStore 已提供所需的有序事件读取 API（`packages/teamlead/src/StateStore.ts:68940-68954`），因此该接线可实现。真实 Store/Sink 重启测试覆盖 event 后、prune 后与 cleaned 写失败（plan `:249`）。
- 重入身份已补齐 canonical path、branch、generation、manifest locator、target、fingerprint 与 move/rescue 集合，并要求在任何破坏动作前验证 digest（plan `:147-157`）。这足以阻止 pending rescue 掉入 legacy new-generation 路径。
- R3 #3/#4 已关闭。nested 内容移到 `<stamp>/nested/<relpath>`，不再与根目录的 `manifest.json` 冲突，并有大小写变体测试（plan `:129-135`, `:248`）；§2.3 则明确只有幂等 exclude 可在通用前置拒绝前写入（`:76-78`）。

## Issues & Recommendations

1. **[blocking] `manifestSha256` 被要求写进它所哈希的 manifest，形成未定义且按字面不可实现的自引用 digest。**

   v4 规定 event payload **和 manifest 都必须带** `manifestSha256`，随后“按 `manifestPath` 读 manifest、重算 sha256”并与 event 值比较（plan `:147-150`）。如果 SHA 覆盖最终落盘的 manifest 字节，那么把 digest 写回 JSON 会改变这些字节；新 digest 又会改变字段值，无法得到普通可计算的稳定结果。若实现者各自假定“忽略该字段”或“先置空再算”，JSON key 顺序、空值表示和序列化方式又会成为未定义的跨重启合同，checked replay 可能永久拒绝本来有效的 rescue。

   **建议：**最小改法是让 canonical manifest **不含** `manifestSha256`：先用确定性序列化写出最终 bytes，计算这些 exact bytes 的 SHA，只把 `{manifestPath, manifestSha256}` 放进 checked event payload；重入时先读 bytes、核对 event digest，再 parse 并逐字段交叉验证。若必须在 manifest 内展示 digest，则把它放进不参与哈希的 sidecar/envelope，并明确其规范化算法。补一条 byte-tamper 测试：原文件 round-trip 成功，任意一字节变化必须在破坏阶段前得到 `rescue_resume_mismatch`。

2. **[advisory] `generationBefore` 应显式允许 `null`，并统一 `nestedMoves[]` / `nestedRepos[]` 的字段名。**

   identity 清单要求所有 event/manifest 都带 `generationBefore` 与 `nestedMoves[]`（plan `:147-148`），而 evidence 字段表仍写 `nestedRepos[]`（`:170-172`）；未登记且目录不存在但需救援 branch 的合法路径也没有旧 generation。建议把 schema 定成 `generationBefore: string | null`（只有 registered missing/present 执行 generation 比较），并选定一个 nested 字段名供 manifest、event 和 checked replay 共用，避免实现时用空串或字段映射差异制造假冲突。

## Verdict

**CHANGES REQUESTED**

R3 的两个 blocker 与两个 advisory 均可视为关闭。只需消除 manifest digest 的自引用并明确上述 schema 小项；下一轮不必重新审查 takeover 机制或 FLY-2122 裁决。
