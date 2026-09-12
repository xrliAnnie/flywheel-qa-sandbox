# FLY-2498 设计体交接后 CommDB 注册行永不终结 — 调研

Issue: FLY-2498 (https://linear.app/geoforge3d/issue/FLY-2498/病根-eng-design-交接后-bridge-会话已-completedcommdb-sessions-行仍-statusrunning)
日期: 2026-09-11
基于: exploration.md

exploration.md 选定 A(close-tmux 杀窗成功后当场用精确目标 finalize 封行)+ B(FLY-817 running-face reconcile 的 parked 否决接受
「执行缺席」证据)。本文逐条核实两条路径依赖的事实,并把「证据、词表、原语、审计、测试缝」钉死。
(第一稿的 B′「清扫加盖戳相 + 新 CommDB 原语」在核出 FLY-817 日志后否决,见 exploration §3。)

## R1. FLY-817 reconcile 现状:每小时都到过这五具,倒在 parked 否决

`reconcileCommDbRunningAgainstFsm(projectName, fsmStatusOf, opts)`(`commdb-fsm-reconcile.ts:115-380`),生产接线两处
(`plugin.ts:6711` residue harvester 每小时 + boot;`plugin.ts:9363` 计划任务 fast path),`commDbFsmReconcileEnabled = true` 永久开启(`:6595`)。
循环体对每条 CommDB `running` 行:

| 步 | 判定 | 本案五具 |
|---|---|---|
| 1 | TURN 持有者 ⇒ `parkedVetoed`,keep | 不是(设计体交接后 TURN 在 implement) |
| 2 | `fsmStatusOf` = StateStore status;∈ `RECONCILE_DELETABLE_STATES`(completed/approved/rejected/deferred/shelved/terminated)才往下 | `completed` ✓ |
| 3 | `probeTmuxWindowLiveness(tmux_window)` 必须 `dead` | 窗口已被 close-tmux 杀 ⇒ `dead` ✓ |
| 4 | **FLY-1329 A4**:`getEffectiveDeclaredState(exec).kind === "parked"` ⇒ 只有 `parkedGenerationEvidence === "superseded"` 才放行,否则 `prune_skipped_parked_conflict` keep | 五具都自称 parked ⇒ **全部 keep**(日志 `:50279-50283`) |
| 5 | 放行:parked 走 `finalizePaneLossResidue`(精确目标 CAS),非 parked 走 `finalizeSessionUnlessTurnHolder`;`onFinalizeOutcome` 审计 `bridge.commdb-fsm-reconcile` | 未到 |

`parkedGenerationEvidence`(`plugin.ts:6695-6709`)只对 `isAutoMigratableClaudeTmux(adapter_type)` 的体比较 tmux server 代际;
Codex 体直接 `unavailable`。⇒ **对 Codex 停驻体,FLY-1329 否决没有任何可推翻的证据来源。** 这就是本单要补的那一个证据。

## R2. 为什么 FLY-1329 否决不能简单去掉,以及什么证据足以推翻它

FLY-1319 形状:一个**活着**的停驻体,CommDB 里的 `tmux_window` 名字过期(窗口被重命名/迁移),按名字探 `dead`,但进程还在。
否决保护的是「名字探针的 dead ≠ 进程死」。所以推翻证据必须**与注册窗口名无关**,直接问「这个 execution 在这台机器上还存在吗」:

| 证据 | 来源 | 对 FLY-1319 形状 |
|---|---|---|
| Codex daemon 存在 | `probeCodexDaemonLiveness(exec)`(socket + pgid,`codex-daemon-runtime.ts:216`)→ alive/absent/unknown | 活的 Codex 体 daemon 一定在 ⇒ `alive` ⇒ 不推翻 |
| 按执行标记发现窗口 | `discoverTmuxTargetByExecutionId(exec)`(`tmux-lookup.ts`,读窗口创建时发布的 execution marker,不看名字)→ found/missing/ambiguous/indeterminate | 窗口改名不改标记 ⇒ `found` ⇒ 探那个窗口 ⇒ alive ⇒ 不推翻 |
| 宿主进程 | `hasHostProcessByExecutionId(exec)`(`pgrep -f <exec>`,spawn 失败按「有」)| 活进程含 exec id ⇒ `unknown` ⇒ 不推翻 |

这三样正是引擎「严格静默门」判死体、回滚换体时用的证据(`run-quiescence.ts:26 probeRunExecutionLiveness` +
`generalized-launch-recovery.ts probeGeneralizedLaunchLiveness` 的 `lookup.kind === "gone"` 分支,`allowMissingTargetHostAbsence: true`)。
**注意**:直接调 `probeRunExecutionLiveness` 不够 —— 它先 `lookupTmuxTarget` 拿到注册名,`found` 时就按名字探,陈旧名字仍会得 `dead`。
所以要强制走 `gone` 分支:`probeGeneralizedLaunchLiveness(exec, project, { lookup: () => ({ kind: "gone" }), allowMissingTargetHostAbsence: true })`
(`GeneralizedLaunchProbeDeps.lookup` 可注入,`TmuxTargetLookup` 有 `{kind:"gone"}` 变体,`tmux-lookup.ts:365-367`)。Codex 体前置 daemon 探针。

新函数(放 `run-quiescence.ts`,与 `probeRunExecutionLiveness` 并列):
```ts
/** FLY-2498: absence proof that ignores the registered window name (FLY-1319-safe).
 *  Codex: daemon must be absent. All: no window carries this execution marker AND no host
 *  process references the execution id. alive/unknown never authorize anything. */
export async function probeExecutionAbsenceBeyondTarget(
  session: Pick<Session, "adapter_type"> | undefined, executionId: string, projectName: string,
  deps: RunExecutionLivenessDeps = {},
): Promise<GeneralizedLaunchLiveness>
```
返回 `"alive" | "dead" | "unknown"`(`generalized-launch-recovery.ts:12`)。只有 `dead` 推翻否决。

## R3. 推翻后走哪条删除原语

FLY-817 已有分支:`parkedSuperseded = true` ⇒ `finalizePaneLossResidue(db, exec, s.tmux_window)`(`db.ts:8386`):
同一 IMMEDIATE 事务里核 `tmux_window === expected`(目标漂移 ⇒ `target_changed` keep)、核非 TURN 持有者(⇒ `turn_holder` keep)、
再 `finalizeSession`(`finalizeSessionEffects(…, true)`:mailbox 问题/ask 以 `owner_closed` 退、删 `runner_shutdown_controls` /
`runner_stop_declarations` / `sessions`)。本单**复用这条分支**,只是让 `parkedSuperseded` 多一个成立条件。

`finalizeSessionEffects` **不**清 `runner_declared_states` 与 `runner_phase_wakes`(FLY-817 今天删非 parked 行时同样留着)——
残留的 parked 声明对已删 exec 的影响:FLY-1204 `declaredStateIsParked` 读到 `yes`,但该体 StateStore 已 completed 且探针 dead ⇒ 跳过;
`send --to <exec>` 找不到 sessions 行 ⇒ 早于声明就拒。与现状一致,不加机制(记 L6)。

## R4. close-tmux 路径:证据与原语

`plugin.ts:3226-3316` 杀窗前后手里已经有:
- `reapCodexDaemonForSession(store, session, "bridge.close-tmux")` → `{outcome:"not_codex"}` 或 `CodexDaemonReapResult.outcome ∈ reaped|absent|residual|unverifiable`
  (`codex-daemon-teardown.ts:12`,`codex-daemon-runtime.ts:113`);`residual/unverifiable` 已写 `exec_host_processes_residual` + `lead_close_runner_failed(cleanupPending)`。
  **现在返回值被丢弃**,要接住。
- `killTmuxWindow(target.tmuxWindow)` → `{killed, error?}`;`:pending` ⇒ `killed:false`;窗口本来不在 ⇒ `killed:true`(`tmux-lookup.ts:1040-1049` already dead = success)。

**死亡证明(close-tmux)** := `result.killed === true` ∧ daemon ∈ {`not_codex`,`reaped`,`absent`}。比 close-runner 的
`canDeleteSessionIdentity = res.killed || runnerDeathProven`(`close-runner.ts:951`)多要 daemon 结论,因为 close-tmux 自己先收了 daemon。
**状态门** := `RECONCILE_DELETABLE_STATES.has(session.status)`(与 FLY-817 同一份词表;`session` 是 handler 顶部读到的 StateStore 行,
FLY-44 守卫已保证它不是 running/ship_parked/awaiting_review/approved_to_ship)。failed/blocked 不删(CRASH_PRESERVE,交 FLY-1066 harvest 每小时收)。
**原语** := `db.finalizePaneLossResidue(executionId, target.tmuxWindow)`,通过 `commdb-session-prune.ts` 新增薄包装
`finalizeCommDbPaneLossResidue(executionId, projectName, expectedTmuxWindow, dbPath?) : FinalizeCommDbResult`
(与 `finalizeCommDbSessionCommunications` 同形:开库、调原语、映射 `target_changed`/`turn_holder` 为 `ok:false outcome`,异常吞成 `failed`,`finally close`)。
**审计** := `store.recordCommDbFinalizeOutcome({…, runnerDeathProven: true, audit: {source: "bridge.close-tmux"}})`(`StateStore.ts:22277`,已有;
它在成功时写 `commdb_ask_disposed`)。跳过时写一条 `session_events` `commdb_finalize_skipped {reason}`(`insertEvent` 无白名单)。
**响应**:`{closed, error}` 不变,**追加** `commDbFinalized?: boolean`(加字段不改字段;`founder-consent-integration.test.ts` 用 stub 路由,不受影响)。

## R5. 两条路径的相互作用与幂等

| 情形 | 先到者 | 后到者 |
|---|---|---|
| Lead close-tmux 杀窗封行 | A 删行 | 每小时 reconcile `listSessions(running)` 已无此行 |
| 体在 Bridge 重启/手工 kill 后死掉、没人 close-tmux | B 每小时 reconcile:FSM 终态 ∧ 名字探针 dead ∧ parked ∧ 缺席探针 dead ⇒ 删 | close-tmux 若再被调:`getTmuxTargetFromCommDb` 无目标 ⇒ `{closed:false, reason:"No tmux target found"}`(现状) |
| post-ship `closeRunner("DAG workflow ship finalization")` | 行已删 ⇒ `no_session_row_communications_finalized` / `alreadyGone`(FLY-2302 research §2.3 已核) | — |
| Codex 适配器受控关停(`updateSessionStatusIfRunning`) | 行已删 ⇒ `AND status='running'` 0 行 | — |
| 活着停驻的 Codex 设计体(阴性) | close-tmux 被 FLY-44 拦?否 —— StateStore completed 放行。但 close-tmux 本身就会杀窗 + 收 daemon ⇒ 体死 ⇒ 删行正确 | reconcile:daemon alive ⇒ 缺席探针 `alive` ⇒ 否决维持,行不动 |
| FLY-1319 形状(活的 Claude 停驻体,窗口名陈旧) | reconcile:名字探针 dead,parked,缺席探针按标记发现窗口 ⇒ alive ⇒ **否决维持**(FLY-1329 用例原样绿) | — |
| 2026-08 两条 `:pending` running 行 | `killTmuxWindow` 拒;reconcile 的 `probe(":pending")` 非 dead | 不在本单 |

## R6. 测试缝

- `commdb-fsm-reconcile.fly1329-parked-veto.test.ts`(真 comm.db,`seedRunning(exec, parked)` + 注入 `probe` / `parkedGenerationEvidence`):
  **不注入** `executionAbsence` ⇒ 现有 5 条原样绿(其中「KEEPS a parked runner's row even when FSM=completed and tmux probes dead」是本单的对照);
  新增 `describe("FLY-2498")`:注入 `executionAbsence: dead` ⇒ 删、`reconciled=1`、`parkedOverridden=1`、`parkedVetoed=0`;
  `alive` / `unknown` / 抛异常 ⇒ keep(`parkedVetoed=1`);`dead` 但 finalize 时目标漂移 ⇒ keep;非 parked 行不调缺席探针(`vi.fn` 0 次)。
- `run-quiescence` 新增 `probeExecutionAbsenceBeyondTarget` 单测(注入 `probeCodexDaemon` / `probeGeneric` deps):Codex daemon alive ⇒ alive 且不调 generic;
  daemon unknown ⇒ unknown;daemon absent + generic dead ⇒ dead;非 Codex ⇒ 直接 generic,且传给 generic 的 `lookup()` 返回 `{kind:"gone"}`。
- close-tmux:把「杀窗后的封行决定」抽成纯函数 `decideCloseTmuxCommDbFinalize({killed, daemon, stateStoreStatus})`
  → `{finalize:true} | {finalize:false, reason}`,单测 6 分支;端点接线由集成测试覆盖(新 `close-tmux.fly2498.test.ts`:
  真 StateStore(`:memory:`)+ 真 comm.db + 注入 kill/reap ⇒ 行删除、`commdb_ask_disposed` 事件、响应 `commDbFinalized:true`;
  daemon residual ⇒ 行仍在、`commdb_finalize_skipped`)。
- `commdb-session-prune.test.ts` 新增 `finalizeCommDbPaneLossResidue` 三条:finalized / target_changed / turn_holder。
- `bash scripts/__tests__/lead-patrol-snapshot.test.sh` 原样绿(不改脚本,只证没碰)。

## R7. 未核实项

- `close-tmux` 集成测试如何构造 express app:现有只有 stub 路由;实现方若发现真 handler 难以单独 mount,退一步只测纯函数 + 薄包装,并在 PR test plan 说明。
- `pgrep -f <exec>` 对 Claude 体是否总能命中(runner 进程 argv 是否含 exec id)未展开;本单主要形状是 Codex 体(daemon 探针是决定性证据),
  Claude 体由适配器自己写终态,一般不进 running-face。
