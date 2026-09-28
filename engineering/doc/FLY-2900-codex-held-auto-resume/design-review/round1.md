# Design Review — plan.md (Round 1)
Date: 2026-09-25 / Author: Codex / Status: CHANGES REQUESTED

## Summary

方向符合 research.md §0 的绑定裁定：额度待命是主线、默认允许满足六项条件后的 Claude fallback、且 fallback dispatch 进入 `resolveNodeDispatchAtLaunch`。不过，按当前计划直接实施，主路径会被现有 FLY-2465 pause 挡住；resume identity 的持久化握手也未闭合。此外，fallback、operator close 与 Git checkpoint 之间存在会留下半状态或越过 operator 意图的崩溃/竞态窗口。

本轮为设计与源码只读核验，未修改仓库、未运行实现测试。结论基于当前 HEAD `9b7d8624ae7e16acfc974dc5c34afc7d7ea1e577` 的真实调用链，而非仅基于计划文字。

## What's Good (Keep)

- 保留同 execution、同 thread 的续跑为第一选择，只有明确失败或满足全池耗尽条件才换体；这与 Lead 裁定一致，也避免把普通 quota reset 误做成盲换。
- standby、permit、audit 三层职责拆分清楚；`isCodexQuotaStandby` 作为消费者唯一谓词、retention 登记、追加式审计和 bounded reason code 都应保留。
- 对 permit 的身份、新鲜度、双窗口额度、当前 generation 和“permit 后又撞墙”约束是正确的 fail-closed 方向。
- fallback 明确保留 same-vendor review、排除正常模型评分样本，并把 Claude 选择放在 `resolveNodeDispatchAtLaunch`，符合 FLY-2895 的后续接管边界。
- 测试计划覆盖 replay、Bridge restart、lease、并发上限、真实 Git 临时仓、开关对照和端到端协议路径，整体证据结构是好的。

## Issues & Recommendations

1. **BLOCKER — 现有 FLY-2465 casualty pause 会阻断计划中的同-exec relaunch。**

   **Issue:** 计划保留旧 `codex_quota_target` 为 waiting，直到续跑成功才置 `recovered`。但 `CodexQuotaStore.isExecutionPaused()` 对任何未 `recovered/abandoned` 的 runner target 直接返回 true（`packages/teamlead/src/bridge/codex-quota-store.ts:2014-2022`）。这个判断又被 `isCodexQuotaLaunchPaused`、`beforeCodexDaemonStart` 和 `createCodexQuotaLaunchBinder` 在真正 daemon launch 前反复执行（`runtime.ts:612-645`；`launch-binding.ts:29-45`）。因此 resumer 即使拿到 permit，也会被自己保留的 target 拒绝。C7 只给 `run-recovery.ts` 加守卫，未覆盖这些 launch chokepoint。

   **Why it matters:** B1/B2/B3 的核心验收路径无法到达 `thread/resume`；两次尝试会被错误记为启动失败并进入 fallback。

   **Suggested fix:** 设计一个窄化且持久化的 quota-resume launch authorization，至少绑定 `execution_id + entry_seq + permit_id + root_key/current generation + owner claim`。只有该 authorization 能在 `RunDispatcher.codexQuotaAdmission`、StateStore admission、`beforeCodexDaemonStart` 和 launch binder 中绕过旧 casualty pause；普通 launch 仍必须被挡住。authorization 在 identity/goal handoff 失败、lease 失效或 operator release 时撤销。补充 stale permit、错误 entry、Bridge restart、普通 launch 仍被拒绝的测试。

2. **BLOCKER — §6 没有定义当前 adapter 强制要求的 resume identity 双向握手，且成功条件与 adapter 顺序可能互锁。**

   **Issue:** `CodexTmuxAdapter` 对 `processLifecycle.mode === 'resume'` 强制要求 `onIdentityVerified` 和 `resumeVerificationStatus`，缺失时启动立即报错（`CodexTmuxAdapter.ts:1217-1222`）。线程身份出现后，adapter 调 callback，然后原地轮询 durable status，只有 `accepted` 才继续（`:1972-1993`）。现有 `resumeStandbyActor` 为此显式提供 Promise callback，并用 process-body `active` 作为 accepted（`plugin.ts:14645-14659`）。新计划只写了 `buildStandbyResumeStartRequest(...)` 后等待“identity + session_started”再关闭 standby，没有说明 callback 如何把 evidence 持久化、`resumeVerificationStatus` 何时返回 accepted，也没有说明 `goal/set active`/`startTurn` 成功如何回执。若等 adapter 后续事件才 accepted，会卡在轮询；若 identity 一出现就 closed/target recovered，随后 goal activation 失败又会过早宣告成功。

   **Why it matters:** literal implementation要么在 launch 前失败，要么在 180 秒后超时；更危险的是 identity 已通过但 continue turn 未启动时误结算 target 和通知成功。

   **Suggested fix:** 明确两阶段 handshake：identity callback 以 claim/generation CAS 写 `resume_identity_verified`（或等价中间态），`resumeVerificationStatus` 据此放 adapter 继续；runner 在 `activateGoal + startTurn(QUOTA_CONTINUE_TEXT)` 成功后再发一个持久化 acknowledgement，届时才将 standby 置 `closed`、target 置 `recovered` 并发 notice。任何第二阶段失败都调用 bounded cleanup 并回到 standby/第二次 fallback。加入“identity callback 后 Bridge 崩溃”“accepted 后 adapter 尚未观察”“goal/set 失败”“startTurn 失败”的恢复测试。

3. **BLOCKER — fallback 先终态化旧 execution，launch-time resolution/admission 仍可拒绝，预检不能消除死角。**

   **Issue:** §5.2 的一个事务先把 standby 置 `fallback_allocated`、旧 session 置 failed、target abandoned、节点指向新 exec；真正的 `resolveNodeDispatchAtLaunch` 和 `admitGeneralizedWorkflowExecution` 则随后由 workflow dispatcher 执行（当前入口见 `workflow-engine-dispatcher.ts:2824-2849`）。same-vendor 事实、模型注册表、模板和通用 admission 都可能在事务外变化或以计划未覆盖的原因拒绝。§5.3 说“standby 行不会已被关闭”，但 `fallback_allocated` 已不满足唯一 standby 谓词，旧 execution 也已终态，实际仍是不可自动恢复的死角。

   **Why it matters:** 一次 config/template/producer-state 漂移或其他 admission failure 就能让节点永久 pending，同时原会话已失去恢复资格；这正是预检声称要避免的事故形态。

   **Suggested fix:** 使用两阶段 fallback。第一阶段只创建 `fallback_prepared`/launch receipt，冻结 exact vendor/model/effort、same-vendor 证据、pool evidence 和 source demand，旧 standby 仍可恢复；新 execution 完成 authoritative dispatch resolution、StateStore admission 和 durable launch commit 后，第二阶段才终态化旧 execution、迁移 delivery/attachment、abandon target。若不采用两阶段，至少要让任意 post-allocation refusal 可幂等 CAS 回 standby，并证明没有新体副作用。测试每个 resolution/admission/launch seam 的拒绝与 Bridge crash。

4. **BLOCKER — operator release 目前只是状态图/台架期望，没有落到现有写路径；它还会与 resumer 和 WIP ref 更新竞态。**

   **Issue:** C1-C8 没有一个 chunk 明确修改 operator close/hold/cancel/ship 的权威 writer。当前 close-runner 先写 `workflow_operator_close_intent(prepared)`，然后在事务外关闭 runner，最后才 committed（`close-runner.ts:422-463`）；run-level hold/terminate 只 CAS `workflow_run.status` 和写 event（`StateStore.ts:51822-51905`）。计划的 resumer 前检没有重查 prepared close intent；WIP checkpoint 在 DB fallback 事务之前，只凭一次 dead + standby 检查就可更新 branch ref。因此 operator 已开始 close 后仍可能被重新拉起，或者 operator hold/terminate 已胜出但 branch 仍被 checkpoint 改写；standby 行也可能永远停在 `standby/resuming`，阻止安全降级旧 binary。

   **Why it matters:** 违反“operator 动作后不再自动”的核心安全合同，并可能在取消/ship 后产生新进程或新提交。

   **Suggested fix:** 增加明确的 `releaseCodexQuotaStandbyTx`/release-request fence，并逐一接入 `prepareWorkflowOperatorCloseIntent`、run hold/terminate、cancel、ship closeout 和 Lead 手动动作。prepared intent 必须立即阻止新 claim；committed action 幂等转 `released`、撤销 lease/authorization、结算 target，并由单一 owner 清理可能已启动的进程。Git mutation 前先持久化 checkpoint claim，持 worktree lock 时在 `update-ref` 前后重验该 claim 与 close/run/node/TURN fences；失权不得更新 ref或分配 fallback。测试在每个 async/Git/DB seam 注入 operator 动作和重启。

5. **HIGH — `allocateCodexQuotaFallback` 的书面步骤不满足它承诺的 response-loss replay。**

   **Issue:** 计划先 CAS `standby/resuming → fallback_allocated`，之后才依 `source_demand_id` 分配 launch，并称重放返回原 execution。若首次事务已提交但调用方丢失响应，重放会先因 state 已是 `fallback_allocated` 而返回 `fallback_fence_changed`。现有被引用的 `allocateWorkflowResumeFallback` 恰好先查已存在的 ledger，再做新分配（`StateStore.ts:48365-48386`）。

   **Why it matters:** Bridge 在最普通的 commit/response 崩溃窗后无法重新取得 new execution id，后续 launch 与通知无法可靠续跑。

   **Suggested fix:** 在 fresh CAS 前先按完整 source demand 查现有 allocation，核对 source execution、entry、vendor、reason 等 immutable payload 后返回原结果；只有不存在时才进入 CAS + insert。不同 `new_execution_id` 的 replay 也必须返回 canonical 原值或明确 conflict，不能创建第二个。覆盖 commit 后抛错、进程重启、不同参数 replay。

6. **HIGH — permit 资格依赖毫秒 ISO 时间的严格大小关系，不是可靠的 happens-before fence。**

   **Issue:** §3.3 用 `permit.created_at > standby.entered_at`，并用“quota signal 晚于 permit.created_at”判失效。JS ISO 时间只有毫秒精度；两个串行事务可得到相同时间，系统时钟也可能回拨。相等会永久漏放合法 permit，回拨则可能错误接受旧证据。B1 的假时钟若固定在同一 tick，正好会暴露该问题。

   **Why it matters:** 自动切号明明成功却不续跑，或新一轮撞墙后仍消费旧 permit；两者都破坏 generation/entry 的安全边界。

   **Suggested fix:** 为 quota signal/standby/permit 使用同一 root-scoped 单调序号或明确的 event-key 因果引用，不用 wall clock 建立顺序。standby 记录触发 signal sequence，permit 记录其证明越过的 sequence，新的 signal sequence 直接使 permit 失效；时间只用于可见性/SLO。加入同毫秒、时钟回拨和跨重启测试。

7. **HIGH — “auto switch 关闭但 permit/resumer 继续”与当前 coordinator/runtime 的两道总开关冲突，计划尚未给出重构 seam。**

   **Issue:** 当前 `CodexQuotaCoordinator.run()` 在 `autoEnabled === false` 时整轮立即返回（`coordinator.ts:49-52`）；`CodexQuotaRuntime.readiness()` 也把该 flag 直接解释为 false（`runtime.ts:159-164`）。计划 §8 却要求 `source_reinstated`、`manual_adopted` permit 与已有 standby 续跑不依赖 `codex_quota_auto_switch`。仅把 `evaluateCapacityPermit` 和 resumer“由 coordinator 每 tick 调用”不足以越过这两个 gate。

   **Why it matters:** operator 关闭自动切号后，原号回血和人工切号都不会唤醒已有待命，违反明确的 feature-flag 合同。

   **Suggested fix:** 把 tick 拆成始终运行的 readonly capacity/permit/resumer phase 与仅在 auto-switch 开启时运行的 probe/install/rotate phase；permit readiness 调 `readinessResult`/host readiness，不调用含 auto flag 的 `runtime.readiness()`。增加 flag off + source reset、flag off + manual generation、进程重启后继续 resume 的集成断言，并证明没有 probe/install/rotate 调用。

8. **HIGH — `manual_adopted` 所需的 generation provenance 在当前 schema 中不存在，迁移/旧数据语义未定义。**

   **Issue:** 计划要求查询 `codex_quota_external_generation.reason` 来区分人工切号与 `source_reinstated`。当前表只有 `root_key,generation,account_key,profile,auth_digest,observed_at`（`codex-quota-store.ts:198`），`reconcileExternalRoot` 也是六列裸 insert（`:382-393`），getter 不返回 reason。计划的新表清单和 C4 没有说明如何迁移既有 external generation 行，§11 的“纯增量 schema”也未定义旧行应被当作 manual、unknown 还是 reinstated。

   **Why it matters:** 升级后可能错误把旧/未知 generation 当成人工授权并 settle `identity_uncertain`，或使真实人工切号永远拿不到 permit。

   **Suggested fix:** 增加受 CHECK 约束的 generation provenance（可为新 append-only 表，或显式迁移列），取值至少 `manual | source_reinstated | legacy_unknown`；仅有 generation-keyed、可核验的既有 manual-switch 证据才能回填 manual，其余 fail closed 为 unknown。修改 insert/getter/retention fixture，并用旧数据库 fixture 覆盖升级、重放与 unknown 不发 permit。

9. **HIGH — WIP checkpoint 的 index 与上限协议还不足以证明“HEAD 更新后工作树 clean 且未越界”。**

   **Issue:** §5.2 把一串命令都描述在临时 `GIT_INDEX_FILE` 下；若最后的 `read-tree <new>` 仍带该环境变量，它只更新临时 index，真实 worktree index 仍基于旧 HEAD。计划也未要求在 `git add -A` 写 object 前完成 2000 文件/64MB 预检，未定义 staged+unstaged 同路径、unmerged index、submodule、symlink/executable mode 的处理。单测只断言一个普通 dirty tree 变 clean，不足以锁住这些语义。

   **Why it matters:** fallback 可留下假 dirty/错误 tree，绕过声称的体积上限，或在冲突/submodule 场景提交不可接管的 checkpoint。

   **Suggested fix:** 写清协议：在任何 `add/hash-object` 前用 NUL-safe porcelain/index 枚举做 count/byte/type/unmerged/submodule 预检；临时 index 的初始化与环境作用域显式化；ref CAS 成功后清除 `GIT_INDEX_FILE`，在同一 worktree lock 下更新真实 index并以 `git status --porcelain=v2 -z` 为空作为成功条件。失败时保留可诊断、可重试状态。增加 staged+unstaged、delete/rename、mode/symlink、unmerged、submodule、超限且 object 未写入、真实 index 同步测试。

## Verdict

CHANGES REQUESTED

主方向可保留，但以上四个 BLOCKER 必须先在计划层面闭合：permit-scoped pause bypass、两阶段 resume handshake、两阶段 fallback commit、以及 operator/release/checkpoint authority。其余 HIGH 项应一并写入 schema、sequencing 和 RED 测试合同后再进入实现。
