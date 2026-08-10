# Design Review — plan.md (Round 4)
Date: 2026-08-10
Author: Codex
Status: CHANGES REQUESTED

## Summary

R4 已正确补齐 write-ahead intent、独立定时恢复、真实 xdept saga 收敛和所有已知接口细节；除标出的 Codex scope decision 外，计划已经可以实施。我不能接受用现有 “one runtime per Lead” 作为 read-only OFF check 的正确性前提，因为当前代码与 FLY-350 证据都没有提供 fail-closed singleton；在 founder 最高风险入站链路上，这会把明确的双 turn 竞态留在声称“恰好一次”的协议内。

## What's Good (Keep)

- Claude ingest intent 已改为首次 CLI 前 write-ahead，并与既有无 kind begin spool 分目录兼容；这真正关闭了 messageCreate 无 durable NACK 的崩溃窗口。
- 新 ingest worker 明确使用 persisted schedule、单一 unref timer、bounded pass、capped backoff 和 anti-spin 测试，符合 FLY-1646 后的恢复纪律。
- Codex xdept transition 已按 `begin → router.submit → complete` 重写，并保留 `onEntryCompleted → handle` 的 settlement 分工；journal-hit 未 complete 也会补 ACK。
- OFF replay 会读取既有 `chat:` inbox owner，解决了顺序发生的 ON commit→cursor 前崩溃→OFF 重放。
- lane JSON union、legacy-recovery 结构例外、winner-specific assertions、归档 settle 与 QA 判据均已具体到可测试接口。
- 将磁盘 intent 写失败明确为双持久层故障并给出人工重放告警，比静默假装 durable 更诚实。

## Issues & Recommendations

1. **[BLOCKER] 现有 “one runtime per Lead” 不是代码强制的互斥，不能为 Codex read-only TOCTOU 背书。** `CodexLeadInboxServer.listen()` 在 bind 前会无条件 `unlinkSync(existingSocketPath)`；第二个 TUI 可删除第一个 server 的 pathname 后重新 bind，而第一个仍监听已 unlink 的 inode，所以这不是 single-listen fence。headless `codex-lead-runtime.ts` 又直接 `gateway.start()`，根本不经过该 inbox socket。FLY-350 里切换时显式执行“拆 orphan `codex resume` 防 double-listen”，证明无 double-post 是一次运维结果，不是第二实例必然拒起的不变量。于是两个重叠 runtime 可同时完成“ON 读 journal/chat 均无→insert inbox”和“OFF 读 chat 均无→journal accept”，产生两个 turn。计划当前写的 Codex mixed test 也暴露了这一点：在 read-only OFF 方案下，顺序 OFF 胜后 ON 应命中 `legacy_codex_accepted`，不会得到 `legacy_external`；真正同时竞争时则可能两边都成功，并不存在可靠的 loser verdict。建议二选一后再批准：(A) 让 Codex OFF 在共享 `chat:` identity 中事务性取得 legacy owner，并定义 journal-based complete/recovery；或 (B) 保留 read-only 方案，但新增一个 TUI/headless 共用、在任何 REST poll 前取得的 fail-closed per-Lead runtime mutex，第二实例必须在注册 handler/拉 Discord 前退出。B 需覆盖 TUI-vs-TUI、TUI-vs-headless、活 holder 不得被 unlink、崩溃后 stale takeover 和双启动时零 poll 的测试/QA；当前 inbox socket 不能充当该 mutex。

2. **[LOW] 选择上述方案后同步修正文档的几处残留。** 0c 的 competition 断言应按最终机制写：若采用 hard singleton，应测第二 runtime 零 poll，并把顺序 OFF→ON 的结果写成 `legacy_codex_accepted`；若采用 transactional owner，才可断言 `legacy_external`。生产验收 4 也应像 Phase 5 一样注明 `legacy_xdept_pending` 是唯一 fenced ON recovery 例外。文件头仍标注 `R3`，清理清单只点名 0c 表 1/2 格，均应更新为 R4 和完整 legacy transition 集合。

## Verdict

CHANGES REQUESTED — address items above
