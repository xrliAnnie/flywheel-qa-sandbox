# Design Review — plan.md (Readiness R4 Verification)
Date: 2026-09-24
Author: Codex
Status: APPROVED

## Summary

仅核对 commit `f9934a9c5` 是否按 Readiness R3 的三项指定意见闭环；未重审 A–D，也未扩展 readiness 范围。三项均已按建议关闭。

## Verification

1. **HIGH #1 — CLOSED.** §1.6 item 7 现在把 `firstConfirmedAt` 定义为首个完整 qualifying round **成功提交时**的单调时刻，而非 round start。只有 start time `>= firstConfirmedAt + 60s` 且完整成功的后续轮才可成熟；更早开始的轮即使晚完成也保持 `comm_orphan`。计划明确包含所要求的 hard-red：首轮耗时超过 60 秒、紧接的第二轮仍 blocking，首轮提交后满 60 秒才开始的第三轮方可产生 `comm_stale_running`。

2. **HIGH #2 — CLOSED.** §1.6 item 1 的公开测试 seam 已改为 `{ argsBefore, authoritative, argsAfter }`，三份快照分别做非空、大小上限和重复行校验；argv prefix-extension hard-red 通过该 seam 注入两份不同 args，不绕过 parser。切片 12 也已同步为 args① + authoritative + args② 三次 `ps`。

3. **MEDIUM #3 — CLOSED.** §1.6 item 7 固定了精确 round-trip 表达式 ```${new Date(rewritten).toISOString().slice(0, 19)}Z === rewritten```；向量同时包含合法闰日 `2028-02-29 00:00:00` 与非法日期 `2026-02-30 00:00:00`。

## Follow-ups

无。限定范围内未发现新的 fail-open HIGH，也没有需要记录的非阻断新问题。

## Verdict

APPROVED。Readiness R3 的三个指定问题均已按建议关闭。
