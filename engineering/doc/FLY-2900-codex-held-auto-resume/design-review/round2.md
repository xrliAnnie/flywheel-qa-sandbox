# Design Review — plan.md (Round 2)
Date: 2026-09-25 / Author: Codex / Status: CHANGES REQUESTED

## Summary

v2 对 R1 的修订大多是实质性的：真 Codex 预实验给出了同 thread 跨进程、跨账号恢复的正证据；fallback 改成 prepare/commit/revert 后不再提前杀死原 execution；重放先查 canonical demand；Claude 池满判定从 FLY-2465 选号器解耦；generation provenance、全局 `signal_seq`、NUL-safe Git/index 恢复也都比 v1 稳健。

但计划目前仍有 4 个 BLOCKER 和 4 个 HIGH。最关键的是：permit-scoped claim 没有一条可实现的端到端传递路径穿过现有所有启动闸，且 `isExecutionPaused=false` 并不能绕过后续 root pause；runner 又在异步 continue 回合仅“已接受”时就关闭 standby，无法兑现 §10 对 reasoning replay failure 的自动兜底。WIP checkpoint 与 operator release 之间仍有跨 SQLite/Git 的最终 TOCTOU；自动切号关闭时当前代码不会登记 binding，使计划明确要求的 B2 路径从一开始就是 unbound、无法生成 source-reinstated permit。

本轮为设计与源码静态核验；未运行实现测试。预实验原始 JSONL 与脚本和 §0 的结论一致，且对未覆盖的 A 侧 reasoning replay 限制陈述准确。

## What's Good (Keep)

- 保留 §0 的隔离实验及其边界表述。证据确实显示：A 号得到 `usageLimited` 后，新 app-server 在 B 号上可以 `thread/resume` 同一 id、`goal/set active`，并完成后续回合；脚本也有 lease、canonical 账号拒绝和 slot 字节不变检查。
- 保留 §5.2 的两阶段 fallback。把旧 execution 的 teardown、delivery/attachment 迁移和 target 结算推迟到新 launch 的 durable commit，是 v2 最重要的正确性提升。
- 保留 demand 的 canonical replay-first 查询，以及 dispatch/admission/precommit refusal 的显式 revert 方向。
- 保留独立 resume loop 和直接读取 readings store 的 Claude pool-exhaustion 纯函数；撤回对 FLY-2465 selector canonical observation 的扩大修改是合适的 scope cut。
- 保留 WIP 的 porcelain-v2/NUL-safe 预检、临时 index 作用域、真实 index 同步和半同步 crash recovery。这些解决了 R1 #9 的 Git 正确性问题。
- 保留追加式 audit、额度页/STEP 2 可见性、失败才找 Lead，以及对历史 held execution 不自动复活的边界。

## Issues & Recommendations

1. **BLOCKER — permit-scoped launch authorization 仍未形成可执行的端到端合同。**

   **Issue:** §4.1 只规定在 `CodexQuotaStore.isExecutionPaused(executionId)` 顶部遇到有效授权时返回 `false`，但当前 `StateStore.isCodexQuotaLaunchPaused` 在该结果为 false 后还会继续检查 `hasRootSafetyGuard` 和 `isPaused(root)`（`StateStore.ts:3278-3292`）。因此 execution 级 false 不是 root 级 bypass。更重要的是，现有 choke point 都拿不到 claim：`AdapterExecutionContext.beforeCodexDaemonStart` 只有 `(home, executionId)`（`packages/core/src/adapter-types.ts:149-156`）；`RetryDispatcher.codexQuotaAdmission` 只有 project/execution（`bridge/run-dispatcher.ts:570-575`）；`admitGeneralizedWorkflowExecution` 的输入没有 quota-resume claim（`StateStore.ts:46485-46522`）；`fencedCommitWorkflowLaunch` 和 delivery repair 也没有 claim，却会再次调用 pause predicate（`StateStore.ts:42322-42330, 42410-42427`）。当前 runtime wiring 甚至丢弃 admission callback 的 input，固定用 `launchPaused("quota-admission")`（`codex-quota/runtime.ts:661-666`）。

   **Why it matters:** 同 exec resume 即便通过前置 claim，也会在 admission、binder 的二次检查或 launch commit 被旧 casualty/root pause 拦下。若改成仅凭 execution 上存在 resuming 行做 ambient bypass，又会让没有正确 claim 的普通 launch 越权穿闸。

   **Suggested fix:** 定义一个显式的 `QuotaResumeLaunchAuthorization { executionId, claimId, entrySeq }`，从 `StartRequest.processLifecycle` 贯穿 RunDispatcher admission、StateStore admission/launch-owner commit、`beforeCodexDaemonStart`、runtime 和 launch binder。把判定做成单一的 tri-state/decision（例如 `authorized | paused | clear`），在有效授权时于 `isCodexQuotaLaunchPaused` 顶层同时跳过 execution casualty、root safety guard 和 root pause；每次 yield 后重验 claim/lease/permit。禁止任何 seam 用常量 execution id。C5 应逐一覆盖 admission、binder 前后、launch-owner commit/repair，以及无 claim/错 claim 的普通启动。

2. **BLOCKER — `onQuotaResumeContinued` 仍在 continue 回合真正成功之前结算。**

   **Issue:** §6 在 `activateGoal()` 与 `startTurn()` RPC 都返回后就调用 callback、关闭 standby、恢复 target 并发送成功通知（plan §6.4、runner 分支）。但源码明确说明 `turn/start` “returns quickly”，回合异步运行，结果由通知到达（`codex-daemon-client.ts:629-655`）；现有 `startInitialTurn` 也只取得 turn id、完成 start barrier，并不等待 `turn/completed`（同文件 `1460-1487`）。

   **Why it matters:** B 号可能接受 `turn/start`，随后才因 reasoning replay/decryption 或模型执行错误发出 failed completion。此时 standby 已 closed、target 已 recovered、issue 已收到“续上”通知，§10 承诺的 `reasoning_replay_rejected` → Codex fallback 不再可达。预实验恰好把这一情形列为尚未证明，因此不能把 RPC receipt 当成成功。

   **Suggested fix:** 用确定的 `clientUserMessageId`/返回的 turn id 关联 quota-continue turn，只在该 turn 的 terminal notification 为成功时执行唯一 success settlement；异步 failed completion 必须走本次 attempt 的 cleanup/fallback。若不愿等待完整工作回合，应先设计一个有界、无副作用的 validation turn，再启动正式 continuation。等待期间需要续 lease，并把有活进程的 validating/resuming 体计入并发容量。新增“`turn/start` 已返回、随后 turn failed”的 RED 测试和 Bridge 重启恢复测试。

3. **BLOCKER — checkpoint 的第二次 DB 重验仍未与 operator release 线性化。**

   **Issue:** §5.3 的时序可以是：checkpoint 在锁内完成第二次 DB 重验；operator 随即在独立 SQLite 事务把 standby 置 released；checkpoint 接着执行 `git update-ref`。`checkpoint_claim_id` 只是事实记录，§4.3 的 operator writer 不等待、拒绝或接管该 claim；worktree lock 也不被 operator 路径获取。

   **Why it matters:** operator 已经成功关闭/hold 后分支仍可能被 WIP commit 推进，R1 #4 要求的“operator 胜出后不再改 Git”仍存在不可消除的 check/use 窗口。C6 当前的“update-ref 前 operator 关闭”测试若只把关闭放在第二次重验前，也捕获不到这个窗口。

   **Suggested fix:** 给两个 writer 一个共同的线性化点：可在持有 SQLite write transaction 时完成最终 fence + `update-ref` + checkpoint 记录（依靠现有 trailer 恢复跨崩溃窗口），或让 operator 与 checkpoint 共用同一跨资源 mutex/claim protocol，operator 对 active claim 写 `release_requested` 并等待/接管，checkpoint 在不可再被 operator 插入的临界区内更新 ref。增加精确 barrier 测试：operator 在“最终 DB 查询已返回、`update-ref` 尚未调用”时进入，断言只能有一个顺序获胜。

4. **BLOCKER — 自动切号关闭时不会登记 quota binding，B2 的显式验收路径不可达。**

   **Issue:** v2 把 permit/resumer 移出 auto-switch runtime 是对的，但当前 `initializeCodexQuotaRuntime` 在 flag off 时返回 `undefined`（`codex-quota/runtime.ts:584-595`）；`wireCodexQuotaDispatcher` 在 disabled 分支仅检查 pause 后返回 `null`，不会调用 binder（`runtime.ts:630-645`）。唯一生产 binding 的 `createCodexQuotaLaunchBinder` 由 runtime 调用（`runtime.ts:522-530`）。因此从 flag-off 启动的原 execution 首次撞墙就是 unbound。当前 `recordSignal` 对 unbound signal 不建 incident/target（`bridge/codex-quota-store.ts:1518-1529`），而 §3.2 的 source-reinstated 又要求“当前代存在额度信号”。同时 §3.3 让任何较新的 unbound signal 失效已有 permit，而 `(root,generation,kind)` 唯一 permit 没有再发机制。

   **Why it matters:** B2 明确要求 auto-switch 关闭时原号回血仍能续跑；按现有 wiring，它没有 root/generation 信号可生成 permit。即便偶然靠历史 binding 完成一次 resume，新的物理进程在 flag off 下仍不登记新代 binding，下一次撞墙会落入同一死区。

   **Suggested fix:** 将“只读身份核验 + registerBinding”从 probe/install/rotate runtime 拆出，所有 Codex 物理启动（包括 flag off 的普通 launch 与 quota resume）都必须经过 binder；flag 只禁止 probe/install/rotate。另为历史/异常 unbound signal 定义明确的重新证明路径（例如基于当前 canonical root 的新 reading epoch 发行新的 covers-signal permit），而不是永久毒化唯一 permit。B2 应从 flag-off 冷启动开始，并增加“续跑后再次撞墙”的绑定/归因测试及 unbound-only 恢复测试。

5. **HIGH — readings 与撞墙信号的先后仍由墙钟判断，与 §2.1 的因果承诺矛盾。**

   **Issue:** §2.1 说所有因果顺序只用 `signal_seq`，但 source-reinstated 仍要求 `reading.observedAt >= 最后一条信号的服务端时刻`（§3.2）。这是在证明“读数发生于撞墙后”，不是单纯 freshness。相同毫秒的撞墙前读数可因 `>=` 通过；reader/Bridge 时钟偏移也可错误接受旧读数或拒绝新读数。C4 同时声称同毫秒/时钟回拨不影响资格，按当前合同无法成立。

   **Why it matters:** 撞墙前仍显示有额度的读数可能立即发 permit，把 execution 拉回同一已满账号；反方向则会让真实回血永久等待。

   **Suggested fix:** readings ingestion 也分配 Bridge 单调 `reading_seq`/revision。进入 standby 时冻结当时最新 reading revision，source-reinstated 必须看到严格更大的 revision，`observedAt` 仅用于 5 分钟 freshness。若暂不改 store schema，至少冻结并比较不可碰撞的 reading digest/version，不能用 wall clock 充当 causal fence。

6. **HIGH — generation provenance 对初始 root 没有定义，B2 要么 fail-closed 卡死、要么绕过 provenance。**

   **Issue:** §2.3 只在 `commitGeneration`、`reconcileExternalRoot`、source-reinstated 和 migration 回填写 provenance，没有覆盖初始 generation。现有 `initializeRoot` 只插 `codex_quota_root`（`bridge/codex-quota-store.ts:326-345`）。§3.2 又要求 source-reinstated 的当前 provenance 不为 `legacy_unknown`。

   **Why it matters:** 对新库的 generation 1，若“缺 row”按 fail closed 处理，唯一账号回血的 B2 永远拿不到第一个 permit；若用 `undefined !== 'legacy_unknown'` 放行，则 provenance 的 fail-closed 目的被空值绕过。升级库中没有 installation material 的当前代也有同样歧义。

   **Suggested fix:** 增加明确的 `initialized_canonical`（或等价）provenance，在 `initializeRoot` 完成 canonical identity/readiness 核验后与 root 同事务写入；或者明确移除 source-reinstated 的 provenance 前提并说明为何 root/auth/reading identity 已足够。缺 row 必须有唯一、测试锁定的语义。补 fresh DB generation 1 与 upgraded legacy DB 两组 B2 测试。

7. **HIGH — reverted demand 的 UNIQUE 键让第二次 fallback attempt 不可达。**

   **Issue:** demand 对 `(source_execution_id, entry_seq)` 唯一；prepare 第一步遇到任何既有 row（包括 `reverted`）都“如实返回”（§5.2.1）。第一次 launch refusal 后 row 变 reverted，下一次 prepare 既不能插新 row，也不会把旧 row重新 armed。因此 `fallback_attempts` 不可能通过第二次 fallback refusal 达到计划所说的上限 2。

   **Why it matters:** 第一次瞬时 dispatch/admission/precommit 拒绝就永久关闭该 entry 的自动 fallback，和风险表、Lead 诊断及 retry budget 不一致；反过来若实现者随意复用 row，可能复活已 abandoned 的 launch ledger。

   **Suggested fix:** 把 `fallback_attempt` 纳入 demand 的 durable identity/`source_demand_id`，并保持“同一 attempt replay 返回 canonical exec”；或完整定义 `reverted -> prepared` 重用同一 new execution/ledger 的安全 CAS。加入 attempt 1 revert、attempt 2 prepare/commit（及各自响应丢失重放）测试。

8. **HIGH — dispatch demand 只对 Claude 生效，Codex fallback 的 vendor/model/reason 并不受冻结事实约束。**

   **Issue:** §5.2 声称 demand 冻结 vendor/model/effort，但 §5.4 只在 `vendor='claude'` 时读取 demand。现有 `resolveNodeDispatchAtLaunch` 会重新读 live template，并对 Codex implement 调 `applyImplementQuotaDegradation`，该函数可以改派为 Claude（`workflow-dispatch-resolution.ts:36-78, 175-230`）。

   **Why it matters:** “两次同 exec 恢复失败 → 新 Codex 体”的 fallback 可能在配置漂移或旧 degradation 下实际启动 Claude，审计仍记 `resume_attempts_exhausted`/Codex，且绕过本计划对 Claude pool evidence、same-vendor 和评分排除的条件。

   **Suggested fix:** `resolveNodeDispatchAtLaunch(executionId)` 对所有 `state='prepared'` demand 都先返回冻结 dispatch，并跳过 generic degradation；Codex demand 同样冻结并校验 vendor/model/effort，返回明确的 quota-fallback reason。增加 prepare 后修改 live template、以及旧 `applyImplementQuotaDegradation` 条件为真的两组测试，断言 Codex demand 仍解析为预定 Codex dispatch。

## Verdict

**CHANGES REQUESTED**

v2 已解决 R1 的大部分结构性问题，方向可以保留；但上述 4 个 BLOCKER 会分别导致授权恢复启动仍被旧闸拦截、异步失败被误报成功、operator 之后仍改写分支，以及 auto-switch-off 的回血验收不可达。先把跨层 claim 合同、turn terminal settlement、SQLite/Git 线性化和 always-on binding 写成明确可测的设计，再进入实现。
