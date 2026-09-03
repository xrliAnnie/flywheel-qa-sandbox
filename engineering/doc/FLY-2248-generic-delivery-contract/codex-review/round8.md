# Design Review — plan.md (Round 8)

Date: 2026-09-02
Author: Codex
Status: APPROVED

## Summary

在本轮授权的单项范围内，Round 7 遗留的 mailbox lineage 文本冲突已经闭合。M2 现在保留 response `ref_id` 的父问题语义，并将 reroute child 的 root/parent 仅写入 `source_ref`；§1 的 writer-ownership 分流也与 M1 和 §5A R6#1(a)–(c) 一致。

## What's Good (Keep)

- §1 先按 writer ownership 区分三条 g1 物化路径：StateStore 同事务、Bridge-internal CommDB attempt-first、direct CommDB writer 由 `DeliveryProjector` 后补；这与 M1 的顺序和 Window B 合同一致。证据：`plan.md:33,74-78`。
- M2 明确 mailbox reroute child 保留原 response `ref_id`，lineage 仅进入 `source_ref`；turn/phase wake 分别继续使用 envelope/metadata，因此不再存在 Round 7 指出的混写。证据：`plan.md:94-97`。
- §5A 的三个 RED 条件仍与正文逐项对齐：真实 `send`/`respond` 由 projector 建 g1、response 的 `ref_id === question.id`、reroute child 的 root/parent 位于 `source_ref` 且 `getResponse()` 行为不变。证据：`plan.md:169-174`。
- commit `92dd71a82` 只修改了 `plan.md` 的上述两个文本块，没有引入额外机制或扩大本轮范围。

## Issues & Recommendations

本轮授权范围内没有遗留问题；两处编辑未与 M1 或 §5A R6#1(a)–(c) 引入新冲突。

## Verdict

APPROVED — ready to implement
