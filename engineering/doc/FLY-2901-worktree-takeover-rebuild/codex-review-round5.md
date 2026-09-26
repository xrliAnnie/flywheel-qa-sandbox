# Design Review — plan.md (Round 5, scoped to v4→v5 delta)
Date: 2026-09-25 / Author: Codex (companion, xhigh, read-only) / Status: APPROVED

> 范围：Lead 2026-09-26 01:1xZ 指示，实现开头补一轮 Codex 复核，只限 v5 那一处改动（commit `5001da36c`）。以下为 Codex 输出原文。

# Summary

本轮严格只复审 v4→v5 delta（commit `5001da36c`）。核验 head 为 `473969aa77c8436f95b1b9621fbd6ae723ed01df`，plan blob 为 `8dece7c798b3c9c6a2dd93a360fdec2462e432e6`，与 prompt 指定值一致。

v5 已关闭 R4 #1 和 #2：

- manifest 不再包含自身 SHA；SHA-256 覆盖最终落盘的确切字节，digest 只保存在 checked event。
- `generationBefore` 明确为 `string | null`，且仅非 null 时比较。
- 全文已无 `nestedRepos[]`，统一为 `nestedMoves[]`。
- 原始字节先验 SHA、再 parse 和逐字段交叉核对，足以让新进程对同一份持久化 manifest/event 得出相同校验结果。
- 未发现新的破坏性或数据丢失回归。

存在一个非阻断的 replay 确定性缺口：`nestedMoves[]` 没有规定稳定顺序。它不影响已经持久化的 manifest 重入校验，但可能影响同 UID 的 checked-event 重放。

只读复审；未修改文件，未运行实现测试。

# What's Good

- 自引用 digest 已彻底消除。plan `:149-150` 明确 manifest 不含自身哈希，writer 对 key-sorted JSON 加结尾换行后的最终字节计算 SHA；reader 则先对原始字节验 SHA，再解析和交叉核对身份字段。任何字节变化都会先于破坏阶段失败，新增验收行 `:250` 覆盖了该合同。
- `temp+rename` 与“对确切字节算 SHA”的顺序可直接实现：构造一次 UTF-8 byte buffer，以该 buffer 写临时文件、rename，并对同一 buffer 计算 SHA。结尾换行已经明确；JSON 的字符串转义和数字表示也有标准编码，不存在额外歧义。
- 仓内已有可复用的 `canonicalJsonString()`，它递归排序 object keys、使用 JSON primitive encoding，并明确保留数组顺序（`packages/config/src/canonical-json.ts:3-25`）。
- `appendWorkflowRunEventChecked()` 确实按全部 immutable fields 和 canonical payload digest 判断同 UID 是否幂等；object insertion order不会造成冲突（`packages/teamlead/src/StateStore.ts:68819-68884`）。
- `generationBefore: null` 的合法范围和比较规则清楚：仅“未登记且不在”为 null，只有非 null 才检查 generation。该规则也消除了用空串或虚构 generation 表示缺失的空间。
- 对指定 blob 的全文检索结果为 `nestedRepos` 0 处、`nestedMoves` 2 处，R4 的命名 advisory 已关闭。

# Issues

1. **[MEDIUM] `nestedMoves[]` 缺少规范顺序，checked-event 的同 UID 重放可能把等价集合判成冲突。**

   plan `:173` 已规定 `rescues[]` 按 `kind` 排序，但没有为 `nestedMoves[]` 指定顺序。仓内 canonical JSON 只递归排序 object keys，明确把 array order 当作数据；`appendWorkflowRunEventChecked()` 因此也会保留数组顺序参与 payload digest。若一次重试或新进程按不同的目录枚举顺序重建同一组 nested moves，相同 event UID 的 payload、manifest SHA 都可能不同，checked replay 会抛出 `workflow_event_uid_conflict`。

   这不会导致数据丢失：冲突会 fail closed，且已持久化 manifest 的正常重入仍按原始字节稳定通过。因此不升为 HIGH。

   **最小修复：**在 §4.5 加一句：构造 manifest/event 共用的 identity 对象前，`nestedMoves[]` 按规范化的 repo-relative source path 排序（必要时以 destination path 作 tie-break）；manifest bytes 使用仓内 `canonicalJsonString(identity/fullManifest) + "\n"`。同一已排序数组同时写入 manifest 和 event。顺带明确这里的“键排序”是递归排序即可。

# Verdict

R4 的 blocking 和 advisory 均已关闭。上述 MEDIUM 是 fail-closed 的重放确定性加固，不会使原始字节重入合同不可实现，也没有引入破坏性回归；按本轮判定规则批准。

VERDICT: APPROVED
