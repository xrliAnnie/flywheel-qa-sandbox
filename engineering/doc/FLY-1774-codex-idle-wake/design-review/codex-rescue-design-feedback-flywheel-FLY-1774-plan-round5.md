# Design Review — FLY-1774 plan.md (Round 5)

Date: 2026-08-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

R4-1 已闭合，且把 capability 移入 CommDB 是更简单、正确的方向：它删除了跨包文件寻址，并使 capability、session liveness 与 doorbell mutation 可以共享 SQLite 写锁。当前仍有三个 implement-blocking contract 未定死：phase capability 注册仍可能静默失败/被后续注册降级，terminal fence 尚未覆盖全部生产 writer 和 started wake，sessions migration 也没有对现有 table-rebuild seam 给出安全顺序。

## What's Good (Keep)

- `coveredDoorbellAttemptIds` 现在是耐久 attempt coverage，而不只是 member/response coverage；主 `message_id` 与所有 finished/non-finished doorbell metadata 一起判重，补齐了 A 承载 B、A finished 后同一 B 重现时的永久幂等。
- Coverage 写入、pointer merge、查重和 INSERT 都在同一个 immediate transaction；“A pending → B reuse → A finished → B again”及 concurrent duplicate B 测试准确覆盖 Round 4 的反例。
- CommDB `sessions.phase_keep_alive` 让 sweep 使用现有 `FLYWHEEL_COMM_DB` 即可获得 capability，完整删除 session.json field/path、`FLYWHEEL_CODEX_SESSION_DIR` 传播和反向 package dependency 问题；不新增 env/config 渲染是可信的。
- Capability 与 `sessions.status` 在 doorbell helper 的同一事务检查、terminalization 同事务关 fence 并清 doorbell，是正确的两向竞态模型；active capability runner 仍无需依赖易失的 declared-park marker。
- Schema 变化已被诚实承认，`runner_phase_wakes` 仍无需改表；Fix A、零 mailbox settlement、legacy queue-OFF 例外、typed stale-envelope convergence、mixed snapshot 总函数、Fix D 和真实 lease QA 的既有结论继续成立。

## Issues & Recommendations

1. **Capability producer 仍不是 fail-loud、write-once authority；现注册 seam 可在 flag 未落库时继续启动 phase consumer。** `CodexTmuxAdapter.execute()` 先调用 `registerCommDbSession()`，之后才创建 runtime/controller（`packages/claude-runner/src/CodexTmuxAdapter.ts:462-540`），但该注册函数当前吞掉所有异常并返回 false（`:1513-1539`）。计划只是把 `ctx.phaseKeepAlive` 传到这个 seam，没有要求改变失败语义；一旦 DB open/migration/register 短暂失败，phase controller 仍启动，而 batch callback 与 sweep 都因新 fence no-op，自动唤醒会静默全失效。另需防重注册降级：`registerSession()` 有 dispatcher pre-register、Claude/Codex adapter 和 CLI 多个 caller，现 ON CONFLICT 会覆盖 caller 提供的字段（`packages/flywheel-comm/src/db.ts:4864-4907`）；capability 既然“每 execution 静态”，后来的 absent/false caller 不能把 1 写回 0。请定死 producer contract：非-phase 注册继续 best-effort；`ctx.phaseKeepAlive` 时 register/open/migration 必须 fail-loud，并在 controller start 前断言同一行 `phase_keep_alive=1 AND status='running'`。ON CONFLICT 用 monotonic `MAX(existing, excluded)`（或等价 immutable mismatch guard），所有旧 caller 默认 0。补注册故障时 runtime/controller 均未启动、pre-register 0→adapter 1、后续 0 不降级、terminal row 不得带着 live controller 启动的测试。

2. **“单一 terminalization helper”尚未覆盖真实 terminal writer，且现有 dispose API 不能收走 started doorbell。** 除 adapter 的 `updateSessionStatusIfRunning()` 外，Bridge 的 `terminal-commdb-sync.ts:175` 会直接调用 `markSessionTerminalStatus()`；它是 StateStore failed/blocked 的生产投影（`packages/flywheel-comm/src/db.ts:5055-5063`）。若该 writer 先把 status 标 terminal 而不清理已有 wake，后续 sweep 虽被 fence 拒绝，已有 non-finished doorbell 仍成为 orphan。并且现 `disposeRunnerPhaseWakeForTerminal()` 的 SQL 只接受 `state='pending'`（`:2988-3004`），直接复用/循环调用它无法兑现计划的“全部 non-finished”，started row 会残留。请把所有生产 status-terminal writer 至少收口到同一个内部事务 primitive：adapter 的 guarded status update 与 `markSessionTerminalStatus` 保留各自 CAS/覆盖语义，但都在同一 transaction bulk-finish `message_id LIKE 'doorbell:%' AND state IN ('pending','started')`，写 terminal disposal reason 并清 claims；`status` eligibility 也精确写成闭集 `status='running'`。审计 `finalizeSession`/delete paths 已有的 wake prune，避免旁路。补 terminal-commdb-sync 先赢、pending/started 各一条、adapter 后续重复 terminalize，以及 `finishWake()` 对已 terminal-finished row 幂等的测试。

3. **Migration 落点和顺序仍不足以保证旧 DB 安全；`ensureMailboxQueueSchema` 不是 sessions 的实际升级 seam。** 该函数只检查/ALTER `mailbox`（`packages/flywheel-comm/src/mailbox-queue.ts:240-295`）。`sessions` 的真实升级位于 `CommDB.applyMigrations()`；其中 FLY-1066 会重建整张 sessions 表并显式列出复制列（`packages/flywheel-comm/src/db.ts:898-953`）。若 implement 先 ADD `phase_keep_alive` 再走未更新的 rebuild，新列会被丢掉；若只改 ALTER 而不改 fresh `SCHEMA`/rebuild，则不同起点得到不同定义。计划应指定精确 DDL（建议 `INTEGER NOT NULL DEFAULT 0 CHECK(phase_keep_alive IN (0,1))`）及顺序：更新 fresh schema；让 FLY-1066 rebuild create/copy 保留该列，或明确在所有 rebuild 完成后才做幂等 ADD；保留 duplicate-column race tolerance并验证最终 column 存在。测试至少从当前 schema、缺 vendor/缺 failed-check 的古老 fixture、已有 session rows 三种起点升级，断言旧行=0、新 phase 注册=1、重复/并发 open 幂等，且 Tmux/CLI/dispatcher 注册仍为 0。

4. **发布说明对 legacy in-flight session 的影响自相矛盾。** Fix B 明确说 batch callback 和 sweep 共用同一个 capability fence（plan `:82`），所以 `phase_keep_alive` 未置位时两条腿都会 no-op；但 §7 `:158` 又说只有 sweep 延后、主链 Fix A/B 不受影响。请选择并写实：要么把部署前/Bridge restart 的 phase session re-registration 定为 rollout precondition并验证所有在途 controller 都被回填为 1；要么承认存量未回填 execution 的 batch 与 sweep doorbell 都不可用，fallback 仍是人工 nudge；若要给 batch callback 加 watcher-owned legacy 例外，则必须另写其 terminal fence和测试，不能继续声称“共享同一 helper hence same fence”。

## Verdict

CHANGES REQUESTED — address items above
