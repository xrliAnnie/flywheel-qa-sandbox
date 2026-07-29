# Design Review — FLY-1520 plan.md (Round 1)

Date: 2026-07-28
Author: Codex
Status: CHANGES REQUESTED

## Summary

计划对已锁定方向的总体拆分是合理的：事务外做 Git/GitHub/process observation，事务内只做 kernel CAS，并正确承接了 DAG-only eligibility、节点完成合同和 agent-first actions。基于当前 `9539c263`（相关 v2 包与 `origin/main@9455a2b8` 一致）逐项核对后，T1–T6 仍有数个会使实现无法落到现有 DDL/API、或在 crash/race 下失去授权与活性的映射缺口，因此本轮不能批准。

## What's Good (Keep)

- 范围纪律清楚：零迁移、不改 `packages/v2-engine` / `packages/v2-scheduler`、生产常驻接线留给 FLY-1502，并显式记录了 Route A 相对设计 §8 的偏离和以后列提升路径。
- `Kernel.write` / `WriteTx.cas` / `runRecordedAction.prepare(tx)` / `enqueue` 自开事务的判断与现码一致；新建 `appendMailboxTx` 来满足“业务事实 + durable mailbox 同事务”是正确接缝。
- T2 的 SQL 列名和基本谓词与现有 DDL 一致：`task_dependencies(task_id, blocked_by_task_id)`、`tasks.state`、`attempts.desired_state` 以及 `attempts_one_active_per_task` 都能承接该查询。
- manifest、HEAD、merge-base、GitHub merge、spawn 全放事务外，短事务内只验证 immutable observation/version，符合 kernel 的同步 `BEGIN IMMEDIATE` 约束。
- 对 FLY-1500 已合 actions 形状的方向修正是对的：使用 `intended|succeeded|failed`、显式 supersedes 链、actor-generation outcome fence，而没有继续实现旧 dispatcher/executor。
- 测试意图覆盖了 topology、partial-unique 竞态、旧世代迟到写、crash replay、静态节点名围栏和 `attempts.observed_*` 禁用；这些验收项都应保留。

## Issues & Recommendations

1. **[BLOCKER] Route A 的 admission 数据合同既不足以派发，也尚未形成“合同字段唯一写点”。**

   当前 `tasks` INSERT 至少必须提供 `id/project_id/kind/state/lineage_root_id/created_at`（`packages/v2-kernel/src/migrations/0001-base-schema.ts:2-15`），但 T1 没有逐列说明 `kind` 与 `lineage_root_id` 的兼容值。更关键的是，payload 被限定为恰好 `contract/writes_repo/worktree_id` 三键，admission 输入中的 `vendor/model`（以及真正需要的 logical agent id、authenticated vendor family、effort/capability）没有任何持久落点；T2 commit 后进程重启时无法重新构造 SpawnPort 请求，T3 也无法权威得到 `open_attempt.family`。同样缺失的还有 task-contract-invalid/reviewer-exhausted/founder mailbox 的收件人、gate emitter 的 agent identity，以及 ship 的 canonical `{repo, pr}` target；当前 `ship_gate` 只留了 `emitter_task_id`，却在 approval 时要求选择 emitter agent。

   此外，“admission API 是 tasks.payload 唯一写点”的静态结论目前不成立：`v2-engine` 公开的 `Effect.kind="task"` 接受任意 payload（`packages/v2-engine/src/types.ts:103-119`），并由 `settlement.ts:103-112` 经 `sql.ts:64-66` 直接 INSERT `tasks.payload`。字符串 grep 看不到运行时 payload 中的 `contract` 键，不能证明单写点；FLY-1518 当前描述也只迁 command effect，并不自动关闭这个入口。

   **建议修复：**在计划中给出完整 canonical admission descriptor 和现有 tasks 每列映射；把 runner/agent/family 配置、supervisor/founder recipient、ship target 和 authenticated emitter 置于明确的 payload/meta 权威位置，仍然禁止从 task kind/name 推断。dispatch 还应要求 task 属于一条 exact `dag_admitted` membership receipt。最后必须在 FLY-1518（或另一个明确前置）中移除/约束 generic task effect，或取得允许改 engine 的范围裁定；在此之前不能把静态测试 c 声称为已关闭的单写点。

2. **[BLOCKER] meta 的统一 CAS 形状与计划自己的 value schema 不兼容，gate 还引入了现有表不能表示的第五态。**

   §2.2 声称所有 UPDATE 都用 `json_extract(value,'$.revision')`，但 `writer_chain` 只有 `version`，`canonical_worktree` 没有 revision；表格中的三个 worktree key 也都没有列出后文宣称“所有值必带”的 `cutover_epoch`。因此 writer slot acquire/release 和 path CAS 按文实现都会 0-row CAS。meta 中现有 `cutover_epoch` 本身还是 plain numeric string，不可被通用对象 parser 误读。

   T5 又把 `ship_gate.state` 改成 `shipped`，而实际 `gates.state` CHECK 只允许 `open|approved|rejected|expired`（`0001-base-schema.ts:116-126`）；这与 §2.3“每次 gate 状态迁移都 INSERT 同步 state 的 audit row”直接冲突。另一个未定义分支是：同一 issue 已有 expired/rejected meta row 后如何重新开门；“gate-open 只 INSERT 且禁止 ON CONFLICT”只能覆盖第一次。

   **建议修复：**为每种 meta value 写出 exact keys，全部加入 `cutover_epoch` 和统一 `revision`，或者明确 `writer_chain.version` / canonical full-old-value 的独立 CAS SQL，不能称为一个统一 UPDATE。定义 first insert、expire/reopen、graph/tip change 的 revision 序列。ship 事实应由 action + `ship_completed` event 表达并让 gate 保持 approved/转 expired，或明确 `shipped` 仅是 meta-only 状态且不生成 gates row；两种方案选一并补 raw-schema tests。

3. **[BLOCKER] T2 的 observation→dispatch 竞态和 T4 的换装后启动/状态收口没有闭合。**

   T2 必须先读候选再在事务外读 HEAD，因此每个 write transaction 内需要按 task id **重跑完整 eligibility**（state、全部 incoming deps、无 active attempt）并同时核对 pre-observed writer version/head。只依赖早先候选列表与最后的 `ready→running` CAS，会在“上游 rework 成 ready、下游仍是 stale ready candidate”的交错里错误派发。

   T4 则在同事务给被打回 task 创建 active attempt/activation，但没有明确 commit 后调用 SpawnPort；若依赖普通 `dispatchOnce`，它会因已存在 active attempt 永远跳过。它也只把“下游 done task”改为 ready：被 supersede 的 active downstream task 原状态是 running，若不同时改为 ready 并清 `terminal_at`，会永久不可派发。当前 T4 的单个 HEAD/version observation 也不足以收尾依赖闭包内可能跨多个 worktree 的 active writers。

   **建议修复：**抽取一个 `prepareDispatchTx`，由 T2 与 T4 共用并返回 durable spawn request；T4 commit 后必须走与 T2 相同的 spawn/harvest 路径。rework 先为闭包内每个 active writer 收集独立 observation packet，release 全部 active suite，把所有受影响 task（done 或 running）重算为 ready、清 terminal marker；只有直接被打回 task 变 running 并预建新 suite。增加 `dispatch vs rework`、多 worktree closure、T4 commit→spawn crash 三组测试，并逐列写明 activation 的必填 `generation`。

4. **[BLOCKER] T3 尚无可由当前库证明的 agent/family/evidence 绑定，completion replay 也未定义。**

   `agents` 当前只有 `{agent_id, kind, generation, last_poll_at, state}`（`0005-agents-config-mailbox-rebuild.ts:3-9`）；`registerAgentTx` 对 runner 只验证 activation 存在且 active（`registration.ts:140-146`），不会证明该 activation 属于 proposal 的 attempt/task，也没有持久的 instance/family 绑定。计划所写的 `requireIdentity` 不能补洞：0005 已删除 `consumer_registry:*` meta，现行 engine 的 current-agent check 直接读 agents。与此同时，计划没有给 verdict/review/artifact evidence event 的 exact schema、author/reviewer family 的认证来源、`review_capable_families` 的现有码落点，或 `writes_repo=false` verdict 所绑定的 exact head。仅凭 caller 提交的 `EvidenceRef`/family 会重新开放自报证据。

   `completionUid` 也只出现在入参，没有规定 replay fast path。若第一次已 commit，第二次先检查 task=running/activation=active 会失败，不能满足 C3 的幂等收敛。最后，`maybeRefreshShipGateTx(issue)` 要判断 canonical HEAD 是否等于 span_tip，却未接收事务外 observation map；非写 task 又完全跳过 manifest/HEAD，可能错误开门或无法产生 `unconsumed_span_blocks_gate`。

   **建议修复：**写出 completion 的全部 DB 谓词：current agents generation、activation→attempt、attempt generation→task、admission execution descriptor→authenticated family，并定义可验证的 evidence row/subject digest 结构和 review-capable configuration authority。函数进入事务后先按 `completionUid` 查 exact canonical payload/result，同 payload replay 返回首次结果，异 payload conflict，再做 active-state 校验。所有会触发 gate refresh 的调用点先在事务外取得 issue 相关 canonical worktree observation map；tip 仍只从事务内 span_tip 选择，但 observation 用于 freshness tripwire。增加 forged activation/family、wrong subject、non-write concurrent HEAD、commit 后 replay 反例。

5. **[BLOCKER] capability 的 bearer、subject 和 crash-safe delivery 没有接到现有 `FENCE.capabilityConsume`。**

   现有 FENCE SQL（`packages/v2-kernel/src/fence.ts:188-194`）只核 `id/time/action/audience/task_id/attempt_generation`，不核 `token_hash` 或 `subject_digest`。计划 mint 一个随机 token、只存 hash、执行时却只写“调用 FENCE”，没有任何 presented token/hash/subject 比对；`task_id=NULL` 的 ship capability 仍必须显式绑定 `taskId:null`、`attemptGeneration:null` 参数。capability subject 中的 `logical_key` 还依赖 `recordActionIntent` 私有的 canonical/hash 算法，计划没有合同测试防止两份实现漂移。

   更严重的是，明文 token “只经返回值交给调用方、不落库”，但 approval 同事务只写给另一个 actor 的 durable mailbox。若 token 不在 mailbox，actor 收不到；若 approval commit 后响应丢失，重放又无法从 hash 恢复 token，capability 会被永久烧死。这与 C4 crash replay 不相容。

   **建议修复：**明确 bearer 模型和可恢复交付。若保留 token，executeShip 必须接收 token，事务前算 hash，并在同一 prepare transaction 内先验证 exact `{id, token_hash, subject_digest, issuer}`，再以完整 null bindings 调 FENCE CAS；还要定义 token 如何以 audience-only、crash-recoverable 的方式到达 actor。若选择随机 capability id 本身作为可信边界内 bearer，则删掉“另有一次性 token”的语义并说明 token_hash 的用途。approvalRef 也必须有 exact replay/conflict 合同。无论哪种，都为 capability subject 与 kernel logical key derivation 加 shim-contract 测试。

6. **[BLOCKER] T5/T6 的 actions 映射与当前 `runRecordedAction` / supersedes 语义不一致。**

   有四个具体冲突：

   - `runRecordedAction` 在 perform 抛错时自己开启独立 failure outcome 事务，成功也自己开启独立 outcome 事务（`packages/v2-actions/src/index.ts:31-67`），没有 outcome prepare hook。因此“failed 与 next_retry_at/第 6 次 gate expire + founder mailbox 同一事务”按当前 API 做不到；catch 后补小事务还存在 crash gap，计划也没有 level-triggered repair 规则。
   - due retry 时 reconciler 不能先 INSERT supersede action。新 actor 随后用同一 `invocationUid=capability_id` 调 `runRecordedAction` 会命中 replay，在 prepare 和 perform 之前短路，merge 永远不会重呼。reconciler 应只 mint capability + durable mailbox；真正的 successor intent 必须由 actor 在消费 capability 的 intent transaction 内创建。
   - 0006 的 supersedes trigger 本身不比较 actor（`0006-actions-black-box.ts:113-126`），所以 raw SQL 在 logical key 相同的前提下允许不同 actor。但 `recordActionIntent` 对 `taskId=null` 的 action 把 `actorAgentId` 纳入 logical key（`actions.ts:368-383`）。本计划的 ship 是 unbound action，因此**只有同一 logical agent 的新 generation**能建立 successor；不同 actor id 会得到新 logical key并被 trigger 拒绝。只有 task-bound action 才能由不同 actor通过，而 ship 明确不是 task。T6 必须把 observational settlement 固定为原 `actor_agent_id` 的 current generation，不能写成泛化的“当前 actor”。
   - fresh approval 若在同一 `{repo,pr,head}` 上产生新 gate_id，当前 `logicalEffectId` 不变但 payload digest 因 gate_id 改变；它既撞 one-root-per-logical，也不能 supersede 旧链。expired/rejected gate 的同-head reopen identity 尚未定义。

   **建议修复：**先做一个 actions contract milestone，再写 ship 业务：明确 root/reopen identity、同一 actor-agent 跨 generation 的接班规则、merged 与 definite-failure 两种 stale-generation observational successor、以及只有 failed tail 才可继续 retry。reconciler 只授权并通知，actor intent 才建 successor。对于第 6 次失败原子结算，必须在两种可实现方案中取得明确裁定：允许给 v2-actions 增加通用 outcome transaction hook，或由 `v2-dag` 直接编排公开的 `recordActionIntent/recordActionOutcome`；当前“只在新包写代码 + 必须用现有 runRecordedAction + 同事务 expire”三项不能同时成立。

7. **[HIGH] writer-gap/lost-open 的授权与幂等恢复在计划中消失了。**

   T1 看到 HEAD 领先 anchor 后要求“立即走 adoptWriterGap”，但 admission 入参没有 attribution family/capability，未说明 adoption 与 admission 是同一事务 helper 还是第二个事务，也没有第二事务 crash 前可 level-triggered 重放的 durable pending fact。T6 的 lost-open 也没有设计要求的 exact capability consume。§2.4 的“mint 恰两点”实际上只能限定 `github_merge` capability；不能排除 `adopt_writer_gap` / `lost_open_attempt` 的独立 break-glass capability。

   **建议修复：**把 github_merge 的两个 mint 点与 writer-adoption capability 分开命名。为 admission gap 写 exact `{worktree, from, to, attribution_family}` subject、签发来源、consume 和 event；若不能与 admission 同事务完成，就在 admission commit 中写 stable `writer_gap_detected` fact，让 recovery level-triggered 收敛且 dispatch 持续 fail closed。lost-open 同样补齐设计要求的 process-absence、worktree/ref 双失、writer version/start/resolution head/family/reason 全绑定和一次性消费。

8. **[HIGH] ports、里程碑和预算验收还不足以证明 T6 与上线边界。**

   `ports.ts` 清单没有 T6 所需的 ProcessAbsence/WorktreeRef probe，attempt/activation 也没有记录可供该 probe 权威定位的 process handle；计划验收提到 resume=新 activation+generation，但六个事务里没有 resume/cutover API。`GitHubProbePort` 又同时被用于 `.merge`，会把只读 reconciler 与持 merge credential 的 effect port 混为一体，违反已锁定的 authority boundary。

   **建议修复：**拆成只读 `GitHubObservationPort` 与 agent-only `GitHubMergePort`，加入 process/session absence 与 exact ref observation port，并补 resume 原子 cutover/harvest 合同。里程碑前增加 M0：用真实 0001..0007 建库编译并跑“admission 一行、register/activation binding、capability consume、same-agent/new-generation successor、different-actor rejection、failed outcome/retry”最小 vertical spike；这些问题不能等到 M5 才发现。最后在默认 1s budget 下实测并固定 200/500-task admission 上限或 fail-closed size limit；`Kernel.open({txBudgetMs})` 可参数化（`kernel.ts:267-303`）不等于可以无界提高生产写锁预算。

## Verdict

CHANGES REQUESTED — address items above
