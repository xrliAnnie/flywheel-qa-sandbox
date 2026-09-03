# Design Review — plan.md (Round 7)

Date: 2026-09-02
Author: Codex
Status: CHANGES REQUESTED

## Summary

在本轮限定的四项范围内，R6#2、R6#3、R6#4 已在 plan/research 正文和 §5A 的命名 RED 测试中闭合，R6#1 的 direct-writer/projector 与 mailbox `ref_id` 保留原则也已写入主要落点。不过，M2 的 reroute 实施步骤仍要求 mailbox child 用 `ref_id` 携带 root，与同版新增的 `source_ref` 合同及 RED 测试直接冲突；因此四项尚未全部闭合。

## What's Good (Keep)

- R6#1 已区分 Bridge-internal attempt-first 与直接写 CommDB 的 `send/respond`，后者由 `DeliveryProjector` 补 g1；`mailbox.ref_id` 保留 response→question 语义，真实 CLI 路径和 `getResponse()` 行为均有 RED 测试。
- R6#2 已规定 CommDB source 由 attempt 驱动并 LEFT JOIN 物理 IOU，Window A orphan 可在 minted 超时后被 watch 枚举；Window B 的 `minted_at`、family、project/issue、`contract_ref_json` 来源和二次投影零变更均已明确。
- R6#3 已把 incident #4 拆成父单投影/时钟/episode 半边和 FLY-2268 receiver re-arm 半边；父单 generality 文件集合不再包含 supervisor。
- R6#4 已统一 episode id 注释、launch `consumed_at` 的 attempt 归属、settlement owner，以及“父单实现两种 operation kind、DDL 仅预留第三种”的表述。
- §5A 为四项分别绑定了真实 writer、crash window、incident split 和文档一致性的命名 RED 验收，没有增加表、列或告警面。

## Issues & Recommendations

1. **[BLOCKER] R6#1 在同一版 plan 内仍有互斥的 mailbox lineage 写法。** 新的稳定合同、M1 顺序段和 §5A 都规定 `ref_id` 不承载 root、reroute child 将 root/parent 写入 `source_ref`；但 M2 reroute 步骤仍写成“mailbox / phase_wake / turn_wake 新行的 `ref_id`/envelope 带 `root_id` 与 `parent_attempt_id`”。实现者若按 M2 执行，正好破坏本轮要保护的 response parent reference，并使 §5A R6#1(c) 必然失败。同一稳定标识行前半还声称 mailbox/turn/phase id “都在 Bridge 侧 INSERT 之前生成”且所有 CommDB 家族先写 StateStore，后半才声明直接 `send/respond` 是例外，也应一并改成按 writer ownership 分述。建议只做两处文字修正，不新增机制：(a) M2 明写 mailbox child 保留原 response `ref_id`，root/parent 仅进 `source_ref`；turn/phase 继续进 envelope/metadata；(b) §1 的总规则先声明 Bridge-internal pre-generated/attempt-first，direct CommDB writer 则由 projector 后补。证据：`engineering/doc/FLY-2248-generic-delivery-contract/plan.md:33,75,96,173`。

## Verdict

CHANGES REQUESTED — address item above
