# Design Review — plan.md (Round 5)
Date: 2026-09-25 / Author: Codex / Status: APPROVED

## Summary

本轮严格只复核 R3 #1 在 R4 #1 中剩余的“CAS 失败仍可能写 AccountStore”问题，以及 v6 这项修复直接引入的风险；未复核 F1/F2 或其它已关闭事项。本轮为计划与现有源码的静态核对，未运行测试。

**R3 #1：RESOLVED。** v6 §5.4 第 8 步现在明确要求：拿 accounts lock 后，先用锁内读取的当前状态完成 generation、active account、target credential digest 三项联合 CAS；只有三项全部通过，才投影 observation、清理 cooldown，并进行一次 AccountStore 写入。任一 CAS 失败均不得调用任何 AccountStore writer。现有“当前 generation 必须等于 expectedGeneration”的切号成功证明也继续保留。

未发现该特定修复直接引入的新缺陷。

## What's Good (Keep)

- v6 消除了 v5 的矛盾顺序：不再在联合 CAS 前调用会自行 `writeStore()` 的 `recordObservationInStore()`。现有实现中该 helper 确实在 `account-store.ts:797` 写 store，因此正文对它的显式禁用是必要且准确的。
- 锁内变体具有直接可行的实现基础：现有 `applyObservation()` 是纯投影函数，而 `writeStore()` 的契约本就要求调用方持有 accounts lock；实现可基于锁内读到的 store 组合 observation 与 cooldown 变更，再只写一次。
- §6 已覆盖 generation、active account、targetDigest 三种 CAS 失败，并要求整个序列化 AccountStore 字节完全不变。这能同时捕获 cooldown 与 observed/reset 等字段的意外写入，比只检查 cooldown 完整。
- CAS 成功后的 AccountStore 写入与 proposal `switching` 写入之间仍可能崩溃，但没有形成此次修复的新缺陷：proposal 会停留在 `redeem_confirmed` 或 `recovered_without_proven_redeem`，现有恢复表会重新进入第 8 步；此前写入是在有效 CAS 后发生，重复投影/清理是幂等的，而新的 CAS 若失败也不会再次改写 store。

## Issues & Recommendations

无。本轮限定范围内没有 BLOCKING、HIGH、MEDIUM 或 LOW finding。

## Verdict

APPROVED

R3 #1 已完整解决；v6 的 CAS-first、single-write 方案与现有 AccountStore 锁和纯投影模式相容，且没有发现该修复直接产生的新安全性、并发或崩溃恢复缺陷。
