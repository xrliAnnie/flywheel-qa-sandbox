# FLY-2170 探活轴 / 视图自愈 交接(WS-A / WS-B / WS-C)— 交接
Issue: FLY-2170 (https://linear.app/geoforge3d/issue/FLY-2170/病根-codex-实现体的-tui-pane-出生后秒死fly-1239-race注册停-pending窗口消失app-server-却活着)
日期: 2026-09-03
基于: plan.md(rev 2,commit ce72f2cc5)、research.md
承接单: FLY-2303「[引擎·探活] Codex 体探针轴统一」(Lead 2026-09-03 开单,[lead-instruction 8ffe1b19-7d2e-4d4e-97d4-4c1371f957ea];下列 16 条评审原文已原样写入该单描述)

## 0. 为什么有这份文件

Lead 2026-09-03 裁定(question 8ff0b4ec):FLY-2170 只做 WS-D「一个 runner 一个窗口」;WS-A(视图自愈)、WS-B(进程真相接缝)、WS-C(`:pending` 收窄)另开一单承接。本文件把 Codex R1/R2 里属于 WS-A/B/C 的条目**原样**收录,并附 rev 2 的三节设计稿,作为新单的起点。**本单不实现这里的任何内容。**

Lead 硬约束(2026-09-03 原句,随交接一起走):
> daemon 探不到**永远不得**直接翻译成「窗口死了、删注册行」——终态只能由接缝给,删行必须走既有 cleanup 并验证 target 真的消失,任何绕过都算越权。

## 1. 搬走的评审条目(原文)

### Codex R1(2026-09-03,thread 01a06907-4656-76a0-b563-b153d35a71d1)
1. [HIGH] The cost model for the canonical Codex probe is factually wrong and makes the proposed fan-out unsafe. The plan says at most two asynchronous child processes with 3 s bounds, but the current ownership inspection runs synchronous `execFileSync("lsof")` and then as many as ten sequential synchronous `execFileSync("ps")` calls. Migrating heartbeat and fleet consumers to this path can block the Bridge event loop for seconds per runner; measuring p99 only after rollout is not an adequate safety boundary. Make the non-destructive ownership probe genuinely asynchronous before migrating consumers, use one aggregate deadline and bounded/aggregate process inspection, and add a test proving a delayed `lsof`/`ps` does not block the event loop or exceed the fan-out bound. Evidence: `plan.md:93-95`; `packages/claude-runner/src/codex-daemon-runtime.ts:197-203,215-219,1081-1094,1104-1119`.

2. [HIGH] WS-B does not yet define the single fail-loud seam promised by the hard constraint. The plan introduces both `probeRunnerLivenessForTarget` and a second “same-shape” `probeWindowLivenessForTarget`; the shown function lets daemon exceptions escape, while the prose says exceptions are converted/logged. It also promises `socketLive/groupState` details that the public daemon probe discards, and a health counter that is private to `HeartbeatService` and absent from the health-manifest type. Define one canonical vendor-dispatch function returning a detailed existing-style result; catch and log daemon failures there exactly once, return `indeterminate`, and let window consumers apply a pure vocabulary mapping to that result rather than dispatching again. Reuse the existing `probe_unclear` counter unless a concrete observer/wiring change is specified; also make the `executionId` optionality consistent in the type and fallback contract. Evidence: `plan.md:49,53-71,170`; `packages/claude-runner/src/codex-daemon-runtime.ts:154-219`; `packages/teamlead/src/HeartbeatService.ts:183-194,444-451,564-594`; `packages/teamlead/src/bridge/liveness-manifest.ts:11-16`.

3. [HIGH] The consumer inventory is inaccurate at the exact boundary this change is meant to centralize. `plugin.ts:7277` is the crash-reaper injection, and `plugin.ts:7798/7847` feed done-thread reconciliation, not the lifecycle/worktree consumers claimed in the table. `scanZombies` currently passes only a window string and drops `vendor`, and the adjacent workflow-rework path has an unclassified `probePersisted`. Other destructive or terminal guards use aliased defaults and therefore need an explicit `migrate` or `keep:<view-specific reason>` decision; a grep-based test of only three direct call spellings is easy to bypass. Replace §3.2 with an exact production call-site inventory after following injected aliases, update each consumer's real input type, and make the structural test enforce that allowlist/wrapper rather than merely matching names. Evidence: `plan.md:73-91`; `packages/teamlead/src/bridge/plugin.ts:7263-7278,7785-7848,10311-10320,10441-10452,11345-11372`; `packages/teamlead/src/bridge/zombie-scan.ts:28-45`; `packages/teamlead/src/bridge/terminal-thread-archive.ts:192-213`; `packages/teamlead/src/bridge/post-merge.ts:91-104`; `packages/teamlead/src/bridge/shipped-husk-escalation.ts:198-213`; `packages/teamlead/src/bridge/codex-phase-shutdown.ts:123-132`.

6. [HIGH] The self-heal monitor lacks a single-flight/generation fence and can write stale state after restart or teardown. The same synchronous heartbeat callback is invoked by both the periodic timer and every daemon notification; simply starting an async check from it permits overlap. A probe of old `@N` can finish after `onThreadReady` has armed a new lifecycle or after `finally` has set `runEnded`, then increment the wrong streak or pin CommDB back to `:pending`; `cancelReopen` does not cancel an already-running probe. Add one in-flight monitor latch/abort handle, capture a window/restart generation, stamp the throttle when the probe starts, and re-check `runEnded`, `tuiOpening`, `founderWindowId`, and generation after every await before changing counters or state. Cancel and bounded-join it in teardown. The shared probe must return `present | absent | indeterminate` so timeout/permission/IPC failure cannot be treated as a miss. Test concurrent timer+notification, teardown during probe, daemon restart during probe, and timeout/EACCES. Evidence: `plan.md:125-146`; `packages/claude-runner/src/CodexTmuxAdapter.ts:1260-1272,1277-1297,1393-1403,1437-1463`; `packages/claude-runner/src/codex-runner-tui-window.ts:999-1025`.

7. [HIGH] Mapping daemon `absent` directly to `TmuxWindowProbe.dead` is unsound for the CommDB deletion consumers. Both FSM reconcile and terminal-row prune explicitly require proof that the tmux target is gone so deletion cannot strand a live/preserved window and lose its teardown pointer. Daemon absence proves runner-process death, not instantaneous view disappearance; a stale or remain-on-exit window can still exist. Keep the canonical seam as runner truth, but do not relabel process absence as window absence: after a terminal Codex verdict, tear down the exact registered view via the existing cleanup path and verify the target is gone before finalizing the row; uncertainty keeps the row. Add the control `daemon absent + target still present => no delete until verified cleanup`. Evidence: `plan.md:67,81-82`; `packages/teamlead/src/bridge/commdb-fsm-reconcile.ts:16-28,199-255`; `packages/teamlead/src/bridge/commdb-session-prune.ts:139-146,187-252`.

8. [MEDIUM] The stated rollout and independent rollback boundaries do not honor the one-seam invariant. Until WS-C lands, Codex `:pending` still bypasses the seam through patrol discovery/`pgrep` and crash-reaper suppression; conversely, reverting WS-B while WS-A remains deployed restores pane-based death decisions during a self-heal pending interval. Fold the Codex pending-path deletions into WS-B so the truth cutover is atomic, deploy `B+C -> D -> A`, and document reverse-order rollback `A -> D -> B+C`. Each commit should build and test standalone, but arbitrary-order reverts are not safe. Evidence: `plan.md:19,79-80,153-165,187-192`; `packages/teamlead/src/bridge/patrol-process-liveness.ts:37-60`; `packages/teamlead/src/bridge/crash-reaper.ts:185-219`.

10. [MEDIUM] Two acceptance assertions are not mechanically correct. `tmux list-windows -a` emits the same global window once per linked cmux session, so “exactly one row” will fail even for one physical `@id`; count distinct `window_id` for the execution marker, then separately assert one base owner and one intended cmux linked workspace. Also, two 60 s miss observations only bound detection; reopening can then consume the existing open-chain deadline (currently 480 s), so “reopened within two heartbeats” conflates detection and recovery. Define separate SLAs for trigger (`<= 2` recheck observations) and successful reopen (existing open deadline), with fake-clock unit coverage and wall-clock real-tmux evidence. Evidence: `plan.md:125-139,176-185`; `packages/teamlead/src/bridge/tmux-lookup.ts:101-103`; `packages/claude-runner/src/CodexTmuxAdapter.ts:120-123`. (后半:触发/重开 SLA 拆分归本文件;前半 distinct window_id 留 FLY-2170)


### Codex R2(2026-09-03,同 thread)
1. [HIGH] The §3.1 prerequisite cannot leave destructive reap untouched with the proposed dependency change. `inspectCodexDaemonOwnership` is not a probe-only helper: `reapCodexDaemonForExecution` calls it before signalling and repeatedly while proving exit, then passes the same synchronous `processGroupOf` dependency into `createDefaultKillGroup`. Changing `CodexDaemonOwnershipDeps.socketHolderPids/processGroupOf` to Promise-returning functions while claiming the injection shape and reap path stay unchanged will not type-check and would alter kill authorization. Split the contracts explicitly: either add a separate async `CodexDaemonProbeDeps`/non-destructive inspector while retaining the existing synchronous reap evidence path, or deliberately thread async ownership evidence through reap while preserving a separate synchronous self-PGID guard. In either case, state which code remains byte-identical, inject below the helpers at the `execFile` runner so the event-loop/fan-out tests exercise the real implementation shape, and rerun the existing reap safety suite. Evidence: `plan.md:42-49,228`; `packages/claude-runner/src/codex-daemon-runtime.ts:99-110,154-219,226-275,997-1029,1081-1119`.

2. [HIGH] The rebuilt inventory is still neither complete nor accurate, so it cannot establish the one-seam invariant. `plugin.ts:7798` feeds `done-thread-reconcile.ts`, while only `:7847` feeds `terminal-thread-archive.ts`; the table merges them. It omits production defaults/callers including `done-thread-reconcile`, `done-thread-archiver`, `lifecycle-closeout`, the complete-marker terminal fallback, and the gateway's distinct `runnerPresent` postcondition. It also marks `run-quiescence` as keep even though that module contains its own `adapter_type === "codex-tmux"` vendor dispatch and direct daemon probe—a second dispatch seam by definition. Re-run the inventory now and put the corrected table in the plan, not only the future PR body. Split mixed call sites (`tmuxPresent` remains view-specific; `runnerPresent` migrates), migrate `run-quiescence` through the canonical seam or remove its vendor branch, and add explicit keep reasons for read-only/view cleanup callers such as stale-terminal tab visibility. Evidence: `plan.md:80-106`; `packages/teamlead/src/bridge/plugin.ts:7797-7848,10163-10172`; `packages/teamlead/src/bridge/done-thread-reconcile.ts:304-348,941-958`; `packages/teamlead/src/bridge/done-thread-archiver.ts:145-186`; `packages/teamlead/src/bridge/lifecycle-closeout.ts:1171-1185,1450-1467`; `packages/teamlead/src/bridge/complete-marker-reconciler.ts:1409-1434`; `packages/teamlead/src/lead-backends/codex/gateway/gateway-main.ts:664-678`; `packages/teamlead/src/bridge/run-quiescence.ts:17-43`; `packages/teamlead/src/HeartbeatService.ts:1548-1566`.

3. [HIGH] The canonical seam still cannot serve Codex decisions made without a found CommDB target. Its input requires `tmuxWindow` and dispatches only on `TmuxTarget.vendor`, but `WorkflowActorSession` has no vendor; `probePersisted` is specifically used after registration evidence is absent, and the plan explicitly retains the old `tmux_session` pane path when TURN-holder lookup is not found. Those are replacement/takeover authorities and can again call a live Codex daemon dead when its view is gone. Define the seam input as a discriminated runner identity: known Codex requires `executionId` and may omit a window; non-Codex/unknown vendor requires a window. Derive known vendor from the existing `adapter_type`/transport mapping when CommDB is gone, then call the same canonical function—never a local vendor branch plus old pane probe. Add controls for `CommDB gone + adapter_type codex-tmux + pane absent + daemon alive` in `probePersisted`, actor fallback, and TURN-holder takeover. Evidence: `plan.md:55-78,92-94,189`; `packages/teamlead/src/bridge/workflow-actor-session.ts:8-24`; `packages/teamlead/src/bridge/phase-actor-reentry.ts:24-66`; `packages/teamlead/src/bridge/plugin.ts:8468-8470,10311-10320,10441-10452`.

5. [HIGH] The proposed `present | absent | indeterminate` window probe cannot implement its claimed error classification with the current async child wrapper. `spawnCommandAsync` fixes stderr to `ignore`, its result contains no stderr, and `defaultExecOutAsync` collapses every non-zero exit or exception to `undefined`. A missing exact window is reported on stderr just like the messages used by the existing fail-closed classifier; without that evidence the new probe must either classify all non-zero results as indeterminate and never self-heal, or incorrectly treat EACCES/IPC failures as absence. Extend the subprocess result to capture stderr for this probe (without changing unrelated call-site behavior), classify only the established tmux absence messages as `absent`, classify timeout/abort/spawn/permission/unknown non-zero as `indeterminate`, and define successful-but-mismatched identity/dead-pane output explicitly as unhealthy. Test each error class against the real low-level runner, not only a preclassified probe seam. Evidence: `plan.md:152-159`; `packages/claude-runner/src/codex-runner-tui-window.ts:171-176,408-424,475-502,560-609,999-1025`; `packages/teamlead/src/bridge/tmux-lookup.ts:397-411`.

6. [HIGH] §3.4 adds a destructive kill without proving that the registered `@N` belongs to the row's execution or that the target is unchanged at finalization. An immutable window id proves which window will be killed, not who owns it; a stale/cross-wired CommDB pointer plus daemon absence for execution X could kill execution Y's live window. After asynchronous cleanup, the current generic finalizer only guards TURN ownership, so a concurrently changed `tmux_window` can also be deleted based on evidence for the old target. Before killing, verify `@flywheel_exec_id === row.execution_id` on the exact target and fail closed on mismatch/uncertainty; re-read authority immediately before each destructive step. After kill plus `probeTmuxWindowLiveness === dead`, finalize with the existing target-CAS transaction (`finalizePaneLossResidue` or a renamed shared equivalent) for all such Codex rows, preserving the TURN guard. Add `cross-wired marker => no kill/no delete` and `target changes during cleanup => no finalize` tests. Evidence: `plan.md:108-112`; `packages/teamlead/src/bridge/post-merge.ts:91-178`; `packages/teamlead/src/bridge/tmux-lookup.ts:889-953`; `packages/flywheel-comm/src/db.ts:6980-7040`; `packages/teamlead/src/bridge/commdb-fsm-reconcile.ts:247-255,291-323`; `packages/teamlead/src/bridge/commdb-session-prune.ts:199-252`.

7. [HIGH] The suppressed/exhausted states contradict both the CommDB pointer invariant and the acceptance query, and the sixth-loss alert will be suppressed by the current emitter unless ordering changes. Recovery registers `:pending`; a suppressed founder window never opens, so that row can remain pending indefinitely. On the sixth confirmed post-pin loss, leaving the old `@N` violates “only verified targets,” while truthfully writing `:pending` creates another intentionally long-lived pending row. Both contradict “pending >10 min = 0 / running Codex rows have `@N` 100%.” In addition, `emitTuiLost` currently returns while `tuiOpened` is true, so calling it directly on the sixth detected loss is a no-op. Specify the terminal visibility-loss transition: pin `:pending`, clear the stale window latch/id, bump generation, then emit exactly once and disable checks. Define `:pending` as “no routable founder view” rather than only “not yet ready,” and change the operational invariant to zero **unalerted** long-lived pending rows (with existing `label-unavailable`/`reopen-exhausted` alert evidence as the only exceptions), or provide another existing-state representation. Test CommDB state and callback count for both suppression and exhaustion. Evidence: `plan.md:29-38,134-136,161-170,189-191,211-215`; `packages/claude-runner/src/CodexTmuxAdapter.ts:797-814,1029-1045,1059-1069,2211-2233`. (reopen-exhausted 半边归本文件;label-unavailable 半边留 FLY-2170)

8. [MEDIUM] The alert schema/copy is not updated for the new visibility-loss meanings. The evidence field is named `trigger`, not `reason`, and currently accepts only `deadline-exhausted | permanent | run-ended`; the routed alert text always says the pane “never acquired” an immutable id, which is false for `reopen-exhausted` after a previously pinned view and incomplete for `label-unavailable`. Expand the `trigger` union, keep `lastFailure.reason` for ensure-chain failures, and branch or generalize the founder-facing copy so each trigger reports the actual condition and recovery posture. Add copy/event-id assertions for both new triggers. Evidence: `plan.md:38,136,167`; `packages/claude-runner/src/CodexTmuxAdapter.ts:127-135,1029-1045`; `packages/teamlead/src/bridge/plugin.ts:9808-9822`. (reopen-exhausted 文案归本文件;label-unavailable 文案留 FLY-2170)

9. [MEDIUM] The declared self-heal latch cannot satisfy the teardown join as typed. `windowCheckInFlight` is specified with only `{generation, abort}`, but `finally` needs the actual Promise to bounded-join it; a separate untracked Promise would recreate the stale-completion risk this revision is fixing. Store `{generation, abort, promise}` (or an equivalent single handle), clear it in `finally` only if it is still the same handle, and have teardown abort then race that Promise against the 2 s bound. Include a test where an aborted old probe settles after a new generation to prove it cannot clear or overwrite the newer handle. Evidence: `plan.md:152-158,169-171`; `packages/claude-runner/src/CodexTmuxAdapter.ts:806-807,1437-1468`.

10. [MEDIUM] WS-D promotes `@flywheel_exec_id` to the window's unique authority, but WS-A's continuing health proof checks only id/name/pane state. If the marker is missing or drifts after pin (including a pre-revision window whose current best-effort publication failed), the monitor still reports `present`, leaving CommDB pointed at a window that re-own and exec-id purge cannot attribute. Include the marker in `probeRunnerTuiWindowAsync` and require it to equal `spec.executionId`; a proven identity mismatch should enter the same bounded self-heal path, while an operationally unverifiable read remains indeterminate. Add marker-loss/drift tests. Evidence: `plan.md:32-38,137,157`; `packages/claude-runner/src/CodexTmuxAdapter.ts:1059-1069,2265-2289`; `packages/claude-runner/src/codex-runner-tui-window.ts:999-1014`.


## 2. rev 2 设计稿(WS-B+C、WS-A 三节,原样)

以下摘自 plan.md rev 2(commit ce72f2cc5),含 R1 已吸收、R2 尚未吸收的状态;新单以 §1 的 R2 条目为修订清单。

## 3. WS-B+C 进程真相接缝(先上,原子)

### 3.1 前置:非破坏性 daemon 探针异步化(Codex R1 H1)

现状:`inspectCodexDaemonOwnership`(codex-daemon-runtime.ts:154-203)调用 `defaultSocketHolderPids` = `execFileSync("lsof")`(:1104-1119)与最多 10 次串行 `defaultProcessGroupOf` = `execFileSync("ps")`(:1081-1094)。把它扇出到 heartbeat 会按 runner 数阻塞事件循环数秒。

改动(只动非破坏性路径,`reapCodexDaemonForExecution` 的破坏性路径保持原样并沿用其既有异步 helper):
- `socketHolderPids` / `processGroupOf` 改为 `Promise` 版本,`execFile` 异步、每次 3 s 超时;holder 的 pgid 查询用**一次** `ps -o pid=,pgid= -p <p1,p2,…>` 聚合调用替代最多 10 次串行;整个 inspect 加一个聚合 deadline(常量 `CODEX_DAEMON_PROBE_DEADLINE_MS = 5_000`),超时 → `unknown`。
- 依赖注入形状保持(测试 seam 不变,只是返回 Promise)。
- 测试:注入 3 s 延迟的 lsof/ps,断言 (a) 事件循环在探针期间可推进(用 `setImmediate` 计数器证明),(b) 单次探针子进程数 ≤ 2,(c) 超时返回 `unknown` 而非抛错。

### 3.2 唯一接缝(Codex R1 H2)

`packages/teamlead/src/bridge/tmux-lookup.ts`:

1. `TmuxTarget` 增加 `executionId: string`(必填,lookup 时已知)与 `vendor: string | null`(comm 行原值)。`lookupTmuxTarget` 从已读出的行填入,零查询成本。`discoverTmuxTargetByExecutionId` 的 `found` 分支带 `executionId`,`vendor: null`。
2. **一个** canonical 函数,返回既有详细结果形状:

```ts
export async function probeRunnerLivenessForTarget(
  target: Pick<TmuxTarget, "tmuxWindow" | "executionId" | "vendor">,
  deps: { probeDaemon?: typeof probeCodexDaemonLiveness; probePane?: typeof probeRunnerProcessLivenessDetailed } = {},
): Promise<RunnerLivenessProbeResult> {
  if (target.vendor !== "codex") return (deps.probePane ?? probeRunnerProcessLivenessDetailed)(target.tmuxWindow);
  try {
    const d = await (deps.probeDaemon ?? probeCodexDaemonLiveness)(target.executionId);
    if (d === "alive") return { liveness: "alive" };
    if (d === "absent") return { liveness: "absent" };
    return { liveness: "indeterminate", failure: { stage: "daemon-unverifiable", errorType: "CodexDaemonUnknown", message: `codex daemon probe unverifiable exec=${target.executionId}`, timedOut: false, durationMs } };
  } catch (err) {
    return { liveness: "indeterminate", failure: { stage: "daemon-throw", errorType: errorType(err), message, timedOut: isTimeoutError(err, message), durationMs } };
  }
}
```

- `RunnerLivenessProbeFailure.stage` 联合类型增加 `"daemon-unverifiable" | "daemon-throw"`。异常**只在此处**捕获一次并 `console.error` 一条 `[liveness] codex daemon probe …`(fail-loud);消费者看到的是 `indeterminate` + failure,沿用 FLY-1282/FLY-720 的 suppress/defer 处置。
- HeartbeatService 的 forensics 复用既有 `probe_unclear` 计数(`failure.stage` 以 `daemon-` 开头时归入),**不新增** health 计数或 manifest 字段。
- 窗口词表消费者(`TmuxWindowProbe`)**不再自己分派**:用纯函数 `toWindowProbe(result)`:`alive→alive`,`indeterminate→indeterminate`,`absent→dead`,`dead_pin→dead`。但 §3.4 规定删行类消费者对 codex 体不得把 `absent` 直接当「窗已消失」。
- codex 分支完全不看 pane:`:pending` 与 `@N` 同路,`dead_pin` 对 codex 永不产生。`probeCodexDaemonLiveness` 的 `absent` 语义(socket 死 **且** 进程组消失)不放宽。

### 3.3 消费者清单(Codex R1 H3:按注入别名追踪)

清单方法:对 `probeRunnerProcessLiveness` / `probeRunnerProcessLivenessDetailed` / `probeTmuxWindowLiveness` / `isTmuxWindowAlive` 四个导出,**先追踪 plugin.ts 的注入别名**(`probeLiveness` / `probe` / `targetAlive` / `probeActorAlive` / `probeRegistered` / `probePersisted` / `probeTurnHolderLiveness` / `targetGone`)与各模块 `deps.X ?? probeRunnerProcessLiveness` 的默认回落,再列生产调用点。研究阶段核出的清单(实现节点以同一方法重跑并把结果表写进 PR body,以它为准):

| # | 生产调用点(plugin.ts 注入 → 模块默认回落) | 决策类型 | 处置 |
|---|---|---|---|
| 1 | HeartbeatService.ts:975 `probeSessionLiveness` → zombie 链 :913-935 | 终态(declareZombie) | migrate |
| 2 | HeartbeatService.ts:1904 `probePhaseLiveness` | phase hold 判死 | migrate |
| 3 | patrol-process-liveness.ts:37-60(patrol_tick) | 巡逻判死 | migrate;codex 体删 `:pending → discover → pgrep` 分支(WS-C) |
| 4 | plugin.ts:7277 `probeLiveness` → crash-reaper.ts:207 | 收割 | migrate;codex 体删 :197 `:pending` suppress(WS-C) |
| 5 | plugin.ts:5943 `probe` → commdb-fsm-reconcile.ts:168;commdb-session-prune.ts:172 | **删 comm 行** | migrate,但按 §3.4 的「视图已拆」二次证明 |
| 6 | plugin.ts:7798 / 7847 `probeLiveness` → terminal-thread-archive.ts:167/206(done-thread 归档,含 targeted 路径) | 归档决策 | migrate |
| 7 | plugin.ts:10316 `probeActorAlive`;:10447 `probeRegistered`;:10449 `probePersisted` | phase-actor reentry / coordinator | migrate(三处) |
| 8 | plugin.ts:8470 `probeTurnHolderLiveness` | TURN 抢占 | migrate:先 `lookupTmuxTarget`,found 走接缝;否则维持 `tmux_session` 旧路径 |
| 9 | plugin.ts:11367 `scanZombies.targetAlive` → zombie-scan.ts:28-45 | 巡逻 zombie finding | migrate;`CommRunningRow` 增加 `vendor`,`targetAlive(row)` 收整行 |
| 10 | plugin.ts:11413 `ServerLossCoordinator.targetGone` | tmux server 丢失迁移 | migrate:codex 体 daemon 活 → `false`(不迁移),即 FLY-2211 期望 |
| 11 | post-merge.ts:94 `deps.probe ?? probeRunnerProcessLiveness` | 合并后收尾 | migrate |
| 12 | shipped-husk-escalation.ts:206 | ship 后空壳升级 | migrate |
| 13 | codex-phase-shutdown.ts:131 | codex phase 关停 | migrate(本就只对 codex 体) |
| 14 | lifecycle-sweep.ts:552;worktree-reconciler.ts:156 | 归档/清 worktree | migrate |
| 15 | gate-poller.ts:3027-3045 | 已按 `isAutoMigratableClaudeTmux` 对非 claude 返回 `indeterminate` | keep:view-specific,保守 |
| 16 | pane-loss-reconcile.ts:157-195 | 已对 `codex-tmux` 只 advisory | keep:view-specific(WS-A 的外部对照信号) |
| 17 | started-evidence.ts:54-72;generalized-launch-recovery.ts:77-89 | `:pending → pending_only` | keep:view-specific,保守 |
| 18 | patrol-orphan-sweeper.ts:74-85 | 过滤 `:pending` | keep:view-specific(pane 归属,不是存活) |
| 19 | run-quiescence.ts:33 | 已用 daemon 探针 | keep:reference impl |

结构测试(替换原「grep 三个名字」):新增 `scripts/__tests__/liveness-probe-inventory.test.sh`,扫描 `packages/teamlead/src` 中对上述四个导出的**所有**引用(含 `deps.X ?? probe…` 默认回落与 plugin.ts 注入闭包),每处必须出现在 `scripts/liveness-probe-inventory.json` 白名单里并标 `migrated | keep:<reason>`;新增未登记引用 → 红。四个旧导出保留给 `keep` 项与接缝内部,不再被 `migrated` 项直接调用。

### 3.4 删行类消费者的二次证明(Codex R1 H7)

commdb-fsm-reconcile(:16-28, :199-255)与 commdb-session-prune(:139-146, :187-252)删 comm 行的前提是「tmux target 已消失」,否则会丢掉活窗/留窗的 teardown 指针。daemon `absent` 证明的是进程死,不是视图消失。改法:
- 对 `vendor === "codex"` 的行,接缝给出 `absent` 只决定「终态」;删行前调用**既有** cleanup 路径拆掉注册的视图(按 `@N` 精确 kill,同 FLY-2168 teardown 规则),再用 `probeTmuxWindowLiveness(@N)` 验证 `dead` 才 finalize;`indeterminate` 保留行。
- 对照测试:`daemon absent + target 仍存在 ⇒ 不删行,直到 cleanup 验证通过`;`daemon absent + target 已消失 ⇒ 删`;claude 体路径逐字不变。

### 3.5 WS-C 并入本段(Codex R1 M8)

同一 commit 内删除:patrol-process-liveness.ts:37-52 对 codex 体的 `:pending → discover → pgrep -f execId` 猜测;crash-reaper.ts:197 对 codex 体的 `:pending` suppress。claude 体两处保留(它没有 daemon 真相)。sendKeys / kill / nudge / attach 对 `:pending` 的拒绝保持。

### 3.6 成本

§3.1 之后每次 codex 探针 ≤ 2 个异步子进程、聚合 deadline 5 s;7 个 codex 体 × heartbeat 节拍可承受。实现节点用 health 端点 `event_loop.p99_ms` 前后对照作为观测(不是安全边界,安全边界是 §3.1 的测试)。

## 4. WS-A 视图自愈(adapter,最后上)

### 4.1 触发与判定
在既有 heartbeat 回调(:546-552 定时器;:1394 通知触发)里追加 `scheduleFounderWindowCheck()`,节流常量 `TUI_WINDOW_RECHECK_MS = 60_000`,**节流时间戳在探针启动时打**(Codex R1 H6)。

- 单飞闩:`windowCheckInFlight: { generation, abort } | undefined`;有在飞则直接返回。
- generation:`tuiGeneration` 计数器,在 `onThreadReady`(每次,含 restarts)与每次 `wireCreated` 递增;探针启动时快照。
- 前置:`tuiOpened && founderWindowId && !runEnded && !tuiOpening && !reopenExhausted`。
- 探针:共享异步函数 `probeRunnerTuiWindowAsync(spec, windowId, signal)` = settle 期同一条 `display-message -p -t =<session>:<@id> '#{window_id} #{window_name} #{pane_dead}'`,10 s 超时,返回三态 `present | absent | indeterminate`(超时 / EACCES / IPC 抛错 → `indeterminate`,不计 miss)。
- **每个 await 之后重核** `runEnded / tuiOpening / founderWindowId === 快照 / tuiGeneration === 快照`,任一不成立 → 丢弃结果,不改任何计数或状态。
- `absent` → `missStreak++`;`present` → 清零;连续 2 次 `absent` 才触发。

### 4.2 重开
1. 日志 `runner-tui-window: founder TUI VANISHED after pin (@N) — reopening (k/5)`。
2. `pinCommDbSessionWindow(ctx, "<session>:pending")` —— 先说真话。
3. 复用 `restarts > 0` 分支的再武装(:1290-1295)+ 重置 `tuiAttemptCount / tuiOpenDeadline`,`tuiGeneration++`,`startOpenChain()`。同一条链、同一个 `windowName`,不新起镜像路径(Lead ②)。
4. 成功 → ensure 链(含标记前置)→ `wireCreated` pin 新 `@M` → 既有 `restored` 事件。

上限 `TUI_REOPEN_MAX_PER_RUN = 5`;第 6 次触发 → `emitTuiLost("reopen-exhausted")` 恰一次,`reopenExhausted = true`。`restarts > 0` 重置计数与 `reopenExhausted`。

### 4.3 负向守卫
- teardown:`finally` 最前 `runEnded = true`,随后 `windowCheckInFlight?.abort()` 并有界 join(≤ `tuiJoinTimeoutMs = 2000`,与既有 TUI join 同值);`cancelReopen` 照旧。
- 与在飞开窗互斥(`tuiOpening`);与 re-own / daemon restart 互斥(generation)。
- daemon 死:run 经既有 transport-close 路径结束,`runEnded` 挡住重开;adapter 内不再引入 daemon 探针。
- 全异步、全 unref;禁止同步 `execOut` 路径。

### 4.4 删除面
- `isRunnerTuiWindowAlive`(codex-runner-tui-window.ts:1057-1075)与 index.ts:145 导出(生产零调用者、同步 execOut);测试改用 `probeRunnerTuiWindowAsync`。

## 5. 时序与 SLA(Codex R1 M10)

| 量 | 定义 | 上界 |
|---|---|---|
| 触发 | 从窗口消失到第 2 次 `absent` 观察 | ≤ 2 个 recheck 周期(~120 s) |
| 重开 | 从触发到新 `@M` pin | 既有开窗 deadline(2·tmuxEnsureDeadlineMs + 60 s = 480 s),实测单次 ~45 s |

单测用 fake clock 覆盖两段;真 tmux 用例记录 wall-clock。


## 3. 与 FLY-2170(WS-D)的接口

- WS-D 把 `@flywheel_exec_id` 升为窗口归属唯一权威并在 ensure 链内保证;新单的探活轴与删行守卫可直接依赖它(R2-H6、R2-M10)。
- WS-D 引入 `listTmuxWindowsByExecutionId`(`ok | indeterminate`)与 `CodexRecoveryExecution.founderWindow`;新单的自愈与探针不需要它们,但清单结构测试要把它们登记为 keep。
- WS-D 的 `label-unavailable` 会留下**已告警**的长期 `:pending` 行;新单定义 `:pending` 语义时以「无可路由 founder 视图」为准,验收用「零未告警的长期 pending」。
