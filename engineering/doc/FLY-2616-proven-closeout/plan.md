# FLY-2616 证明消失再收尾 — 实施计划
Issue: FLY-2616 (https://linear.app/geoforge3d/issue/FLY-2616/land收尾-合入后收尾必须能证明每个体已消失session-行缺失窗口不存在心跳超时goneworktree)
日期: 2026-09-15
基于: research.md

状态：Round 3 修订完成，最终有效审阅以 evidence/design-review-log.md 为准。设计阶段交付，不含实现/生产验证。

## 1. 目标、范围与不变量
将每个 issue 的收尾建成可重放的证明链：完整执行身份集合 → 每体 gone 证据 → CommDB 原子清理 → worktree removed/absent → 终结通知 → thread archive → Linear Done/disposition → land/run completed。保留现有外部写入幂等收据、取消/重开保护、独立 updater 部署边界。

1. 没有证明每个执行体 gone，绝不归档；missing row、缺窗口、PID 消失、心跳超时是候选负证据，任何新鲜活体证据均否决。探针失败不是无活体。
2. inventory 不依赖易被清理的 session 行，不漏历史 attempt；不把虚拟 engine 节点当已启动 runner。
3. parked 只是意向；真实存活保留/授权关闭，真实死亡清记录。不能通过改 status 或伪造 ACK 制造死亡。
4. ENOENT 只证明已绑定的那个目录 absent；不能借此删除 branch，也不说明执行体已死。
5. 第九次耗尽仍可 held，但事务性登记 Lead escalation，并有已鉴权的 closeout-only 重试门。
6. lane holder 消失后下一作业 ≤一个 owner heartbeat 周期拿到车道；旧 worker 永远不能复活其旧 claim。无法探测和 Bridge 停机不伪装满足 SLA。
7. 本单覆盖 FLY-2613/2614/2466 形状及追加租约问题；不另行实现它们、不重做通用调度 admission、不新增自动 merge/ship 授权。

## 2. 单一执行证据模型
新建 `packages/teamlead/src/bridge/execution-closeout-evidence.ts`；复用 tmux-lookup、generalized-launch-recovery、run-quiescence、Codex daemon evidence 和 runner-shutdown-evidence 的低层探针。不要更改通用 `probeRunExecutionLiveness` 的全部消费者语义；现有 API 用显式 adapter 包装。新 verdict 仅用于本单 closeout/parked/land delivery。

```ts
type Observation = {
  state: 'present' | 'live' | 'absent' | 'stale' | 'not_applicable' | 'unknown';
  observedAt: string; source: string; identity: string; reason: string;
};
type CloseoutEvidence = {
  version: 1; evidenceId: string;
  project: string; issueUuid: string; runId: string | null;
  executionId: string; activationId: string | null;
  operationId: string; operationGeneration: number;
  lifecycleRevision: number | null; attributionDigest: string;
  commIdentityRevision: number | null;
  windowIdentity: string | null; controllerGeneration: string | null;
  adapter: 'codex-tmux' | 'claude-tmux' | 'engine' | 'unknown';
  observedAt: string; expiresAt: string;
  observations: Record<'stateSession' | 'commSession' | 'window' |
    'hostProcess' | 'daemon' | 'heartbeat' | 'launch', Observation>;
  negativeReasons: string[]; liveVetoes: string[]; unknownReasons: string[];
  verdict: 'gone' | 'alive' | 'unknown';
};
```

数据库行存在仅记 `present`，不能参与 live veto；只有 execution-bound 物理存活与有效心跳可记 `live`。`evidenceId` 由 Bridge 新生成，只能内部 probe 写入；HTTP/CLI 不接受调用者 `gone:true`、`runnerDeathProven` 或 arbitrary evidence JSON。显示名称不参与身份；所有写操作用完整 project/issue UUID/run/exec/activation/代次。CommDB 没有稳定 identity revision 时，additive 增加 `identity_revision`，注册/rebind/宣告/heartbeat/shutdown/TURN 相关写入均推进，CAS 还比较精确 target、声明 generation、wake/TURN；不得用不稳定标签代替。

### 2.1 完整 inventory 和出生保护
在 issue mutex 下收集 canonical aliases 的 sessions ∪ QA ∪ open launch claims ∪ issue 所属 workflow runs 的 `listRunAttributedExecutions` ∪ workflow activation actor/binding（包含 retired attempts），按完整 exec 去重。记录来源集合、排序摘要；不存在 session 仍保留身份。run-node land 引用 engine dispatch 而从未产生 runner 时，凭 pinned workflow node type、dispatch receipt、无 starting/active spawn、无 runner/daemon/host/window 痕迹分类 `adapter=engine`；不能只因 session 缺失就作此分类。
启动中 claim、spawn lock、pending revive/replacement、current active activation 都是出生/复活风险。cleanup reservation 是当前 land claim 的临时子状态，不是新的 founder-park tombstone：在 land_operation additive 增加 `closeout_reservation_epoch`、`closeout_inventory_digest`、`closeout_reserved_at`，有效期直接用 claim 的 lease_expires_at。仅当前 owner 在 issue mutex 内设置；所有 launch/revive admission 查询同一 current operation 及 claim epoch，不能缓存布尔值。接线 `assertIssueNotLifecycleClosed`、plugin.ts 的 lifecycleAdmission/commitLaunch/activateLaunch、run-dispatcher.ts 的 start/retry，以及 generalized launch recovery/Codex re-adopt 的 launch guard；旁路发起者没有可核验 admission 就 fail-closed。
reservation 生命周期：正常完成、release 到 partial/held、abort 都在同一 transaction 清除有效 reservation；失权/expiry 立即逻辑失效，不需要旧进程响应；supersede/reopen/cancel/founder park 先增加 operation generation 使旧动作失权，再清除本 reservation，保留其 audit。只有现有独立 founder-park tombstone 继续按其既有 unpark 规则阻止启动。重试须重新 claim/重新创建 reservation/重新 inventory+probe；旧证据不可跨 epoch 复用。completed 不保留本单新增的永久启动禁令。reopen admission 与 closeout mutation 共用 issue mutex，并检查 revision，避免一边重新启动一边归档。每次 mutation 和 archive 前重读 inventory digest/claim/activation；变化丢弃证据重算。不能把此前缺行证明应用到后来出生的体。

### 2.2 判定矩阵
| 观测 | 结果 |
|---|---|
| 任一 execution-bound 活 runner pane、进程/PGID、daemon socket、未过期 controller heartbeat | alive，负证据不能覆盖 |
| 无活体；任一必要探针 unknown、身份不明、出生可能 | unknown，保持未完成并列明缺项 |
| 必要探针成功；有 session_row_absent/window_absent/process_absent/heartbeat_expired 任一负证据；无活体/出生风险 | gone，保存每项依据 |
| 只有 completed/parked/ACK/lease 文本，没有真实探测 | unknown |
| 缺 session + 已知 Codex daemon 仍 live | alive |
| stale window 名，execution marker 在另一窗口发现 | alive；冲突 identity 返回 unknown，不误杀 |

负证据只需一项，**反证覆盖必须完整**：StateStore/CommDB 成功查询；execution marker 全窗口发现；host process execution attribution；Codex 的 socket/group/spawn-lock。adapter 丢失时从持久 dispatch/activation 恢复，否则同时跑 generic 和 Codex 探针；不能默认 Claude。只有 pinned adapter/never-started receipt 能让不适用项成为 not_applicable。live window 指有精确 execution marker 的活 pane；dead forensic pane 不是活 runner，但被如实记录。
心跳采用既有 controller lease 的 producer/generation/到期语义（runner-shutdown-evidence）；不拿日志活跃时间、park 声明时间、模型输出当心跳。没有该 adapter 的 heartbeat capability 为 not_applicable；读不到应有记录为 unknown/absence observation，绝不凭空造过期时间。时间倒退/未来时间 unknown。每项 observation 独立以完成时刻计最大年龄 30 秒，禁止仅用整个集合最后完成时间掩盖旧项。单 exec 探针有界并发、每项≤5秒、单 exec 总预算≤10秒；超时是 unknown，一轮只重探过期项，不无穷全量重算。跨 exec 默认并发宽度4，及时提交逐体清理 receipt；每exec最坏10秒时，N≤8 的两批在20秒内完成并留10秒提交余量，N>8 不承诺在满timeout条件下整轮成功（需独立测量快探针实际时延，预算不够时明确 probe_budget_exceeded→升级，绝不降低死亡证明），archive 前全体更新 freshness；批次无法在窗口内完整结束则记录 probe_budget_exceeded 并退避/升级，不紧循环。慢 await 后重探过期项；心跳超时不能杀仍可见的活进程。

### 2.3 证据持久化与通信清理
StateStore 新表 `closeout_execution_evidence`：主键 evidence_id，唯一 `(operation_id,operation_generation,execution_id,probe_sequence)`；含 version、identity/digest、观测开始/结束/过期时间、结构化 JSON、verdict。所有 SQL 参数化。append-only，不以旧 event 文本充权威。
StateStore 写下上述 current-claim exact-identity cleanup reservation 后，CommDB 既有 `finalizeSessionCommunications(executionId, expectedTmuxWindow, deleteSessionIdentity, authoritativeTerminalStatus)` 保留公开签名和 legacy 默认行为。把其 transaction guard 提取为一个私有 `finalizeSessionCommunicationsTx`，旧入口和新的 internal `finalizeProvenGoneSession` wrapper 共用该函数；后者仅增加 trusted reservation/evidence 参数与 absent-row 支持，不复制一套 TURN/park/wake 政策。两条入口在 IMMEDIATE transaction 内复核：project/exec/expected row revision 或 expected absent、window、controller generation、snapshot heartbeat 值、证据未过期、TURN、founder wake。legacy entry 不带 trusted context 时仍 veto parked；trusted gone entry 先通过同一 guard 才能 disposition parked，测试证明此差异来自输入证据而不是调用先后。再把已死亡的 parked declaration 标记 expired_by_closeout，原子 retire session/gates/asks 并返回 receipt。现有 parked-preserving 方法不全局放宽。
跨库不是原子提交：reservation 已落但 CommDB 未完成 → partial；CommDB 完成而 StateStore receipt 未落 → 重试以同 evidence/reservation 检索幂等 finalization receipt 补账。CommDB 增加 `closeout_finalization_receipt` 唯一 reservation ID，存 expected identity、删除数、disposed gate/ask IDs 和 finalizedAt。缺行仍走此路，清孤儿 ledger，不能无条件调用裸 finalizeSession。
TURN 仍保护活执行体；terminal closeout 的 owner 在证据 gone 且 exact TURN epoch/holder 未变时，先记录并 CAS retire 属于该 run 的旧 TURN，再允许清理。无此 authority 或新的 TURN 则返回 conflict。未读 founder wake 默认 veto；由已有 issue-terminal disposal 记录 exact wake 的处置原因/receipt 后才可继续，绝不伪造 consumption。StateStore 状态迁移失败零 teardown；failed/blocked 保留法证 status。
`NodeClosureReport` 增加 evidenceId/verdict/reasons，confirmedGone 只从 fresh accepted evidence 映射；communicationsFinalized 单独验证，不混为一位。

### 2.4 cleanup 投递和停滞活体
`land-cleanup-opportunity.ts` 用完整 inventory + evidence：gone 不入请求/等待集合，写 skip_gone(evidenceId)；unknown 不投给不明目标，进入可解释的待解决项；alive 仍通过现有 `enqueueRunnerInstructionIfDeliverable`。不能让 completed/no-window 体产生永远等待的 cleanup。
活 parked 且可投递 → 现有 deterministic shutdown request + 30 秒 grace；ACK 只缩短等待，之后仍实探。alive 但 mailbox terminal/不可投递 → 记录 undeliverable_live，进入既有 issue-terminal closeRunner/forceShippedHusks 授权路径；补充该路径的请求 intent，使不可投递不成为强制关闭永远缺 request 的循环。依旧需要 merged proof、当前 land claim、run attribution、精确 marker、进程身份、超时、重复 closeout 故障；每次 kill 前复核，杀后收新证据。不要因无 ACK 改判 gone，也不要因心跳 stale 直接杀不匹配 PID。

### 2.5 没有 source session 的 finalization 入口（Round 1 HIGH）
修改 `bridge/land-source-session.ts`，保留 legacy `resolveLandSourceSession`，新增 `resolveLandFinalizationContext(store, operation)`：返回严格联合 `{kind:'session',session}` 或 `{kind:'operation',operationId,runId,issueUuid,project,sourceExecutionId:string|null,issueIdentifier?:string,worktreeBinding?:binding,mergeReceiptId}`，或者明确 unresolved reason。sourceExecutionId 优先从精确 gate-entry PR owner 的 durable attribution 取得，即使该 ID 的 session 行不存在；没有这条归属时留 null，不任选其它 session，不生成虚假 Session，不把 `sessionStatus` 伪造为 completed。issueIdentifier 从 canonical issue alias 得到，缺失可省略；issueUuid/project/PR/head/merge tuple 由当前 operation 和 immutable merge receipt 校验。
plugin.ts:7501 的 finalize closure 必须使用此 resolver。operation 分支直接进入 `runResumablePostShipFinalization` 的新增 discriminated context；不因 `resolveLandSourceSession` 返回 undefined 而输出 source_session_unavailable。保留 legacy session 路径；新 operation 路径不传 sessionStatus，session-scoped transition/postMergeTmuxCleanup/labels 查询不运行，改由 §2.1 全 inventory 收尾每个真实 execution。event/notification 幂等键以 operationId 为 anchor，不能用随机替代 executionId；可空 source ID 只用于 attribution，绝不驱动虚构 status transition。operation-scoped 审计明确存入既有 `land_operation_step`：step=`aux:closeout_audit:<reservationEpoch>:<evidenceId>:<eventKind>`，receipt 包含 operation/run/nullable sourceExecutionId 和事实；通过现有 recordLandOperationStep 的 claim fence 写入。StateStore.getLandOperationRetryEpoch 已排除 aux:%，这些诊断不伪装真实进展、不得重置九次预算。`session_events.execution_id NOT NULL` 不改；仅真实 execution 的节点事件使用 insertEvent。`WorktreeCleanupInput` 增加 discriminated operation context，audit callback 在 operation 模式统一写 aux receipt，legacy execution 模式保持 insertEvent。缺 sourceExecutionId 也能写 operation audit；禁止把 operationId 塞入 execution_id。
worktree 的独立持久来源必须新增，不能再称 `getWorktreeBinding` 在删 session 后仍存在：它实际读取 sessions 的 path/branch/generation 列，workflow_execution_binding 也没有目录字段。在 land_operation additive 增加 `closeout_targets_json`、`closeout_targets_digest`、`closeout_targets_version`。该 JSON 是完整 issue 收尾目标集合，按 canonical path/generation 去重：每项 `{kind:'bound_worktree',path,branch,generation,projectRoot,parentIdentity,sourceExecutionIds,sourceRunId,sourceReceipt}` 或 per-execution 的 `{kind:'worktree_not_applicable',executionId,reason,nodeType,dispatchReceipt}`；禁止可有可无的 binding ID。
**新 operation**：新增异步 provider `prepareLandIntent`，在 issue+repo lock 内从仍存的 session bindings、current git registration/generation 与 run attribution 验证全部目标。明确分层：所有 git/文件 await 在 provider 中完成；`StateStore.ensureLandOperation` 保持同步 SQLite transaction，签名新增必填 `verifiedTargets:{json,digest,version,attributionDigest,observedAt}` 参数，事务内重验 canonical identity/attribution revision、schema/version/digest，再把完整 JSON 与 intent 一起 INSERT；不能在 SQLite transaction 中 await，也不能先创建可运行 intent 再异步补证。
provider 返回 `Promise<{ok:true,operation:LandOperationRow}|{ok:false,reason:'land_target_snapshot_unavailable',missing:string[],retryable:boolean}>`；probe 超时/权限/缺来源均为 typed refusal，不以 bare throw 逃出到 log-only catch。接线所有生产创建方：workflow-engine-dispatcher.ts:2269 改 await provider；plugin.ts:8494/8537 的 DAG/legacy createIntent 也 await provider；LifecycleRoutesDeps.land.createIntent 改 Promise<该联合结果>，lifecycle-routes.ts:219 的 POST /land handler 改 async 且必须 await 后再 makeRunnable/kick（不能将 Promise 当 row）。known existing operation 同样不绕过 metadata validation。
拒绝的落点：engine `consume` 必须 `return holdLandRun('land_target_snapshot_unavailable')`，走现有 `store.holdWorkflowLandNode` 并强制传 resolveRunAlertIdentity，原子写 held run/node event + workflow alert outbox；测试要求有 durable outbox，不满足时不得把内存计数 result.held 当成功。无operation的预捕获拒绝去重键必须在现有 land_held identity 上加入 recoveryEpisode（该run最近一次已接受 `workflow_run_event.kind=hold_resumed` 的 event_uid，初次为 initial）；同episode幂等，Lead恢复后再次失败必须新持久hold+alert，不能因旧event存在而只返回idempotent却让run保持active。已有operation仍用resume_generation。缺项/来源摘要入 event 和 Lead 文案。无 operation 时恢复入口明确用现有 registry 的 `land_held_without_operation` / `resume_land_without_operation`：`flywheel-comm hold list --run <full-run-id>` → `flywheel-comm hold resume --run <full-run-id> --shape land_held_without_operation --hold-event <uid> --decision retry --reason <text>`，重新执行同一个 pinned land intent provider，必须重新验证；不拼一个不存在的 /land/:operationId/resume。operator POST intent 则返回 HTTP409 `{error:'land_target_snapshot_unavailable',missing,retryable,retryVia:'POST /api/lifecycle/land'}`，零 kick/零 ship；调用者修复 probe/source 后从同一 authenticated create-intent 正门重试。已有 operation 的失败继续走 §5 的 operation-keyed held/partial escalation/reclose。
INSERT OR IGNORE 的再入语义：existing row 的 current targets version+digest 相同才返回 idempotent success；NULL/旧version进入 verified backfill CAS，predicates 绑定 operation identity+prior targets version/digest+run authority，成功后重读 row；若 snapshot 与当前 attribution 变化，按下一段增版并失效旧 evidence，绝不静默返回未捕获的 existing row。operation 获取执行时重读 inventory：新增 attribution/target 要在开始 teardown 前 CAS 重建 version+digest，并使旧 cleanup evidence/reservation 失效。snapshot 只证明原目标身份，不代替删除时的现状/分支/generation/进程检查；删除 sessions 不再删除该 JSON。
**旧 operation 迁移**：列默认 NULL，禁止空集合/猜路径回填。首个进入 closeout 的 claim（普通 land 与 closeout_only reclose 两条路径都包括），以及任何 ensureLandOperation 再入发现 NULL/旧 targets version 时，必须在发送 cleanup request、关闭 phase 或删除任何 session 前，通过唯一 exact run/PR owner 与同 issue 各现存 session binding、git registration/generation 生成完整目标集合并 CAS 存入；现有 session 即使 completed 仍是可用来源。已经全部缺行的旧 operation，只有既有可信 cleanup attestation 或经受管快照保存的完整旧 session-binding 原记录（含 full exec/run/project/PR关系）能恢复该集合；这些是 provenance recovery，须逐项核对来源摘要、operation merge tuple、当前路径范围和父目录身份，不接受模型填入路径。对**已经丢失所有目录来源**的旧 operation，返回 `worktree_target_unresolved` 并输出具体待补证项和正式 reclose 门，不能凭信息不存在声称清理完成。四实例 replay 的 manifest 必须标明每案从哪些幸存行/旧回执恢复；确无证据就把该案例验收标为未通过，交 Lead 补真实证据，禁止伪造通过。
**worktree_not_applicable**：只给 pinned manifest 中 executionType=engine/明确不创建 worktree 的节点，且关联 dispatch 没有 runner launch side effect、没有 starting/active launch claim、没有 binding/marker/process 痕迹；或 Bridge 的可信 pre-adapter receipt 明确证明 worktree allocation 从未发生，并且 launch claim 已 closed。仅 session 缺行不够。land@1 虚拟 engine 可以记本体 N/A，但绝不让整个 issue 的 design/implement/QA 目录 N/A：集合必须覆盖所有 attributed executions，所有真实 bound_worktree 仍逐个 removed/absent。只有集合每项均 settled（removed/absent/可信N/A）且 inventory 未变，worktreeComplete 才 true。Lead/channel/thread 通过已绑定 workflow alert identity、issue thread registry 与项目配置解析，禁止依赖消失 session 的 labels。缺 routing 记录则升级；不能为完成而跳过归档。
RED 必须从 **plugin 的真实 finalize wiring** 启动：先按新 intent 的强制写入路径持久化 closeout_targets_json，再删除所有 StateStore/CommDB session 行，保留 operation/run/attribution/merge receipt 和 operation 自带 targets snapshot；旧 wiring 得到 source_session_unavailable，新 wiring 到达 inventory→CommDB→worktree→archive→Done→completed。另测只丢 land engine session、仅丢 PR owner session 和无关 sibling session 尚存；不得错误 fallback 到 sibling。Lead 的实际 2588/2413 材料仅证明指定 body 无行，不证明所有 source 行都无；这个 all-rows-absent 是额外边界回归，不能冒充原始生产事实。
`codex-phase-shutdown.ts` 的 earlier ACK/heartbeat gate 同步接入已验 current claim 的 fresh evidence：gone 可返回 evidence_gone 而无需 ACK；alive/unknown 保留原守卫。lookup.kind=gone 与 ACK 单独都不得进入 evidence_gone；detached daemon live 是负例。禁止全局放宽 phase shutdown，缺 trusted context 的旧调用行为不变。

## 3. worktree 的 absent 语义
`worktree-cleanup.ts` 在关闭确认、project root、路径 allowlist、durable binding 所有权与无新 generation 后，在 repo lock 内 `lstat` 精确目标路径；先 `lstat(dirname(boundPath))` 确认直接父目录存在且为预期项目 worktree parent（与 WorktreeManager.expectedWorktree 得到的 parent canonical identity/device 一致），祖先链不含 symlink、挂载设备与可信 project root 匹配；父目录不存在/迁移/卷未挂载为 parent_unavailable。只有父目录已成功验证且 **leaf** lstat ENOENT 才为 absent；不能沿用“向上寻找首个存在祖先”的 canonicalizer 来放行。EACCES/EIO/ENOTDIR、symlink、损坏 parent、读不到管理数据均不是 absent。防 ancestor symlink/路径漂移：canonicalize existing parent、禁止 repo root/其他项目路径，比较持久 binding 与本 operation 的归属。legacy 无 binding 只可使用可信 session 或 §2.5 强制 operation target snapshot 中的精确原路径；不能猜 issue slug 然后把猜测路径缺失当成功。
返回兼容扩展：`cleanupState: 'removed'|'absent'|'blocked'`，`removed:false,bindingVerified:false,absentEvidence:{path,observedAt,bindingGeneration,operationId}`。缺目录但有 stale git registration 仍 absent；记录 stale registration 待既有维护，不执行广域 prune。现存但 not_registered 返回 blocked。所有现存目录保留 branch/clean/generation/process guard。
`post-ship-finalization.ts` 逐真实目录只接受 removed 或确证 absent，不再以 not_registered 等于 removed。operation 集合级使用 §2.5 的 worktreeComplete：可信 worktree_not_applicable 是没有产生目录的节点处置，不是 absent attestation；现有 worktreeRemoved 对外兼容投影只能由完整 targets 集合 settled 派生。consumer 同步包括远端 branch CAS、通知、finalization postcondition 测试。absent 不提供 HEAD/branch attestation；远端/本地 branch 删除跳过或独立用已有精确 SHA CAS，不能伪造 bindingVerified。每个新的 cleanup attempt 在锁内重查；若目录被新 generation 重建，旧 absent 不能删除它或通过新一轮检查。

## 4. land owner 活性、续约与双重隔离
新增 `bridge/land-owner-liveness.ts`，集成 `land-executor.ts`、`StateStore.ts`、`plugin.ts`。

### 4.1 数据和时间
operation additive nullable columns：`owner_instance_id`（random UUID）、`owner_pid`、`owner_process_start`、`owner_host_boot_id`、`owner_heartbeat_at`。沿用 `lease_expires_at` 为唯一 liveness deadline；不要再建第二份 lane 心跳。lane admission tuple 持续绑定 operation ID + operation generation + owner instance；添加缺少的 instance FK/字段，ownerId 显示文字仍兼容。
owner 自己每 H=10 秒 heartbeat 一次，deadline=lastBeat+20 秒。独立 watchdog 最多每 2 秒检查本机 lane（不受普通 sweep running flag 阻塞），单次本机 probe 超时≤2 秒，事务+下一 queued 作业 claim 预算≤2 秒；健康 Bridge 下 OS 确认 holder 死亡到后继 claim 应≤10秒。测试从实际 kill 时间测量，不从观察时间偷换起点。heartbeat-only 超时在 deadline 后≤一个 watchdog 周期回收；这是 fallback，不能宣称从任意实际死亡时刻都立即知道。deadline 到期即失去授权，即便 PID 尚存在；这是 lease fencing，不是 runner gone 证明。`land-retry-policy.ts` 增加非故障类别 `lease_lost`：assertEffectAuthority/recordStep 的 stale claim 映射到此类；失权旧 worker 仅本地退出，不能 release/计数/写 successor。watchdog 用 CAS 留下 lease_lost audit，使旧 op partial 且 next_attempt_at≤now+2秒，保留 retry_count/retry_epoch。若新 owner 接手时发现 predecessor 失权，只算 lease recovery，不消耗九次 closeout fault budget；真实 closeout 故障仍按原预算。连续 lease_lost 另用去重的 owner_health escalation，不伪装业务失败、不无限静默忙转。
watchdog 必须直接 kick 待办 admission，不等待 30 秒常规 sweep。使用 fake clock 检验上界，另用本机隔离 child process 死亡测试量实际时延；调度饥饿/DB 不可用时输出 over-budget 失败和升级，不声称满足 SLA。

### 4.2 原子续约/回收
```text
renew(claim, now):
  require current operation tuple AND exact admission tuple AND now < deadline
  require current process instance equals this process (never renew another PID)
  update operation heartbeat/deadline AND admission expiry within one transaction
reclaim(observedTuple, evidence, now):
  re-read same owner instance/generation/heartbeat/deadline in transaction
  require positive local process absence/start mismatch OR deadline expired
  invalidate old operation owner + increment generation; preserve all step receipts
  delete admission WHERE exact old tuple; write land_owner_reclaimed audit
  make unfinished old op partial/reconcilable; preserve merged proof
  next contender may claim in same watchdog cycle; old op also remains eligible
```
PID reused 是旧 incarnation 消失，不是新 PID 可杀。EACCES/探针超时不能作为 PID absent；deadline 到期仍能逻辑 fence，但不能在不明 remote effect 前盲重发。CAS 失败说明状态更新，重读而不是删除新 owner。
`isCurrentLandOperationClaim` 必须同时验 admission tuple 与未过期 deadline；renew、recordStep、release、resume 都遵守。终态完成释放 lane 的动作也精确 CAS；不能清掉 successor 的 lane。每个 async callback 之后、每个 kill/remove/archive/Linear/ship effect 前传入并执行 `assertEffectAuthority()`。`runPostShipFinalization` 与嵌套 closeout 逐 effect 接线，不能只在整个 await 前后校验。
已发出的外部请求无法撤回：保留 prepared/sent/ambiguous 收据，接手者先查询远端状态/既有 receipt 再继续。新旧 owner 都不得对同一 effect 重发。未合入旧 op 有 in-flight ship 请求时允许别的队列作业准备，但其冲突 lane 效果必须等 reconcile disposition；测试覆盖“请求已发，响应回来前 owner 死亡”。不承诺 fence 可以撤销已发请求。

### 4.3 迁移与回滚
新写入一律完整 instance identity；旧 `land-engine:PID` 行不伪造 start time/heartbeat。PID 确认不存在可立即按 legacy_absent 审计回收；存在/不明则保留原 expiry，不能借缺字段杀活 owner。对于旧一小时 deadline 且确实活着的旧二进制，不自动采用新心跳；告警升级，由正常 release 或升级窗口退出。没有全库自动 held 重置。
additive migration + 版本检查。新 lease generation 数据不能交给不懂 fencing 的旧 writer 混跑；启动时 process/DB protocol version guard 拒绝混版本 land writer。回滚先 quiesce lane owners、确认无 in-flight effects，再停用新 writer，保持表/审计不删；只回滚代码不自动恢复失效旧 claims。恢复旧二进制前由受控迁移把空 lane 标记兼容；否则 fail-closed，不延长死租约。

## 5. 耗尽升级与只重试收尾的正门
复用现有 workflow_engine escalation / legacy land alert outbox；不得只加 console log 或 best-effort thread 消息。held transition 同一 StateStore transaction 写/验证一个持久 escalation。dedupe key `(operationId,resumeGeneration,retryEpoch,held)`；fields：issue/run/op/full exec IDs、merge tuple、attempt数、最后真实进度时间、每体 verdict/缺项、CommDB/worktree/archive 状态、可执行 resume 请求、actor 归属。投递失败不标 delivered，重启继续；已 delivered 幂等。workflow-backed op 与 legacy null-run 两条路分别验收，无注册 Lead 时记录 routing failure 并进入既有项目 escalation，不能丢掉工单。

扩展既有 `POST /api/lifecycle/land/:operationId/resume`，新增显式 body `mode:"closeout_only", expectedResumeGeneration, expectedApprovedHead, reason, requestId`。原默认 full resume 契约不改。提供 Lead CLI `flywheel-comm land reclose --operation <full-id> --expected-generation <n> --expected-head <sha> --reason <text> --request-id <uuid>`，仅调用该已鉴权路由；绑定 authenticated Lead identity，actor 不可只靠 body 自报。runner credential 403、跨项目 Lead 403、无 token 503，输入 schema/长度/UUID/head 格式严验，错误不回显 token。
closeout_only 要求 immutable stored repo/project/issue/run/op/PR/approved_head/merge commit tuple，远端只读核验 merge receipt；在 issue mutex 下确认 current non-superseded operation、当前 run land node/dispatch 和未被 canceled/reopened/parked。支持 held 与 partial：分别 current held 或 active land run；completed 同 request/tuple 返回 already_completed（零副作用）；其它状态拒绝。无需把消失的 gate session/当前 branch head 当必要的生存条件，但必须保留当时有效的 merge authority receipt；查不到它就拒绝。此模式禁止 ensureShip/merge/re-approval 路径，executor 从 merged finalization 恢复。
StateStore 单事务 CAS expected resume generation、release旧 claim+lane fencing、increment resume generation、重置本次 closeout retry budget、append actor/reason/requestId receipt、把相应 held workflow/run/terminal-node 恢复到现有可执行状态（不生成 runner/successor，不改 pinned snapshot 或尝试身份）。重复 requestId 相同 tuple 返回原 receipt，不重复重置预算；不同内容冲突 409。active holder 存在时 409 不窃取；watchdog 先按证据回收。
对 2244 archive_failed：归档超时保留 ambiguous/pending，read-after-write 检查远端 archived 状态再决定重试；不能完成 run 时忽略未归档，也不能重复终结消息。沿用现有 Discord receipt，不造新通知系统。

## 6. 实施顺序（每块先红测试、最小实现、绿、独立提交）
实现节点必须逐项勾选；本设计不勾为完成。以下文件均为 repo-relative。

### A. 证据判定与 inventory
文件：修改 `packages/teamlead/src/bridge/land-source-session.ts`，新增 `bridge/land-intent-targets.ts` 实现 prepareLandIntent；修改 `workflow-engine-dispatcher.ts`、`lifecycle-routes.ts` async createIntent、`plugin.ts` intent provider 与 finalize wiring、`post-ship-finalization.ts` context 与 source-session/wiring 测试；新增 `packages/teamlead/src/bridge/execution-closeout-evidence.ts` 和 `bridge/__tests__/execution-closeout-evidence.test.ts`；修改 `StateStore.ts`、`lifecycle-closeout.ts`、`run-quiescence.ts` 的显式 adapter 接口、相关 collector 测试。
- [ ] 按 §2.5 先写真实 plugin wiring 的 all-source-rows-absent RED：先调用 ensureLandOperation 捕获真实 binding snapshot，再删行；不得保留一份实际上随 session 删除的 getWorktreeBinding mock，也不得只 mock finalizer 绕过入口。operation context 的缺 merge tuple/错 project/歧义 target 都拒绝。补 legacy NULL targets 的幸存行 backfill、可信旧回执恢复、证据全失明确升级三个测试。engine N/A+真实 implement worktree 混合集合仍必须完成真实目录清理；不允许一项N/A掩盖其它目标。
- [ ] provider probe failure 的 engine RED：持久 run=held、land_held event、alert outbox、hold list/resume 真可重入；不能只有日志/内存计数；hold resume后同原因再次拒绝必须产生新episode held+alert，不能被旧dedupe吞掉。operator路径409 typed refusal、零kick；async createIntent必须await。existing INSERT OR IGNORE NULL/stale version 的再入和普通升级后land（无reclose）均在cleanup前完成backfill或进入有告警的拒绝。
- [ ] reservation 的 completed/partial/held/abort/expiry/supersede/reopen/cancel 清除与旧 epoch 零动作 race 测试；覆盖 admission、commitLaunch、activateLaunch/recovery 的接线。
- [ ] 测试构造缺行但仍有 binding/activation，expect inventory 包含该完整 exec；单负证据覆盖表每种各一例。
- [ ] 写事实矩阵驱动测试：
```ts
for (const negative of ['stateSession','commSession','window','hostProcess','heartbeat']) {
  expect(decideEvidence(allCovered({[negative]: 'absent'}))).toBe('gone');
  expect(decideEvidence(allCovered({[negative]: 'absent', daemon: 'live'}))).toBe('alive');
  expect(decideEvidence(allCovered({[negative]: 'absent', hostProcess: 'unknown'}))).toBe('unknown');
}
```
`allCovered` 是本测试 fixture builder，默认 window/process/daemon absent、heartbeats not_applicable、launch settled；heartbeat 分支实际用 stale；hostProcess 的 unknown 用另一个探针作为否定来源。显式补 completed-only、missing adapter/live daemon、spawn race、retired attempt/engine never-launched fixture。
- [ ] 运行聚焦测试看到旧路径 fail；实现 §2 采集、判定和证据写入；green 后提交。

### B. parked 与通信 finalization
文件：`packages/flywheel-comm/src/db.ts` 及其 db tests、`packages/teamlead/src/bridge/commdb-session-prune.ts`、`close-runner.ts`、`lifecycle-closeout.ts`、`land-cleanup-opportunity.ts`、`shipped-husk-escalation.ts`、`codex-phase-shutdown.ts` 和对应测试。
- [ ] RED：parked terminal + dead window/process + stale heartbeat → finalized/无 CommDB 行；旧代码返回 kept_parked。
- [ ] RED：2391 形状 no CommDB row/no window → gone + communicationsFinalized，不等待 ACK；2588 land engine 无 session → inventory 有结论，不挂漏项。
- [ ] 实现 §2.3 receipt/CAS；race tests 在 probe 后插入新 heartbeat/target/TURN/founder wake/activation → 零错误删除；两库每个 crash gap 重放都恢复。
- [ ] alive parked + fresh heartbeat 保留；停滞 alive 到 bounded shutdown 后才 teardown；未授权 PID/unknown 不触发 signal；reprobe 证明才 gone。
- [ ] 测 legacy/trusted 两 wrapper 共享 guard，缺行支持和 physical gone bypass ACK；legacy 无证据仍保留。补 terminal state、founder wake、TURN、park 的每个 guard 原子性用例。
- [ ] 新增 `scripts/lib/fly-2006-retention-tables/teamlead/closeout_execution_evidence.json` 与 `scripts/lib/fly-2006-retention-tables/comm/closeout_finalization_receipt.json`，classification 均为 `protectedCurrentOrReference`（仍可被恢复/审计引用，当前不自动清除）；更新 schema fixture/hard-count/fragment closure 测试。land_operation additive 字段沿用其 existing protected fragment，不新增镜像表。跑 FLY-2006/2413/2563/customer-release-store 套件。
- [ ] sentinel 和 legacy finalizer 回归通过后提交。

### C. absent worktree
文件：`bridge/worktree-cleanup.ts`、`bridge/post-ship-finalization.ts`、对应测试；全仓 `rg 'WorktreeCleanupAttestation|not_registered|bindingVerified' packages` 检查 consumers。
- [ ] RED：bound worktree 目录已删除但 git registration 残留 → cleanupState absent → finalization 可继续；旧实现 branch/clean probe 失败。
- [ ] 实现 §3；existing unregistered、dirty、wrong generation/branch、EACCES、symlink、父目录缺失/改名/未挂载、recreated path 全为 blocked，无 remove/branch delete。
- [ ] null sourceExecutionId 的 operation audit 写 aux receipt 成功，session_events 不出现 NULL/operation-as-exec，诊断不推动 retry epoch；archive hook 断言 all nodes gone+communicationsFinalized+完整targets settled 后才被调用；green 提交。

### D. lease renewal/reclamation
文件：`StateStore.ts`、`bridge/land-owner-liveness.ts`、`land-executor.ts`、`land-retry-policy.ts`、`plugin.ts`、`post-ship-finalization.ts` 与 nested effects；测试 `__tests__/StateStore.land-lifecycle.test.ts`、`bridge/__tests__/land-executor.test.ts`、新 owner-liveness tests。
- [ ] RED：expiry 剩59分钟，owner child 被 kill，queued contender 在10秒内持有 lane；旧代码仍 busy。
- [ ] 实现 §4 双 CAS、self heartbeat、independent watchdog、effect fencing。
- [ ] fake-clock race：renew vs reclaim；旧 worker 恢复不能 renew/step/release/kill/archive/Linear/merge；不能清 successor lane。
- [ ] 长 await 活 owner 续约、PID reuse、OS unknown、heartbeat expiry、Bridge restart、混版本/legacy 和 remote ambiguity case；25秒 event-loop pause 后 lease_lost 不增加 retry_count、不让旧 worker release 新 lane，独立 health escalation 可见。
- [ ] CI 用 fake clock 验≤10秒算法上界；真实 child-kill wall-clock 测量作为独立受控 QA 门（主机负载、计时、process identity 一起留证），不放进 contended parallel unit shard。独立 QA 实测超10秒则验收失败，不能扩大门槛或宣称 SLA 通过；另以串行隔离执行复核原因。
- [ ] green 提交，不在生产 kill/restart 服务。

### E. upgrade outbox + reclose door
文件：`StateStore.ts`、`bridge/land-executor.ts`、`bridge/lifecycle-routes.ts`、`bridge/workflow-engine-dispatcher.ts`、新增 `packages/flywheel-comm/src/commands/land.ts` 与 `index.ts` 命令注册/测试。
- [ ] RED：workflow 与 legacy 第九次 held 必有 pending escalation receipt；发送失败+重启后 delivered，单一 dedupe episode。
- [ ] 实现 §5；auth/project/merge tuple/run state/expected generation/requestId 正反测试；partial 和 held 都只进 finalization，merge/ensureShip spy 调用数恒0。
- [ ] 现有 full resume 精确 head/审批拒绝测试不变；archive_failed 的重试 read-after-write、终结消息不重复；green 提交。

### F. 四实例隔离回放、精确头 CI、交付
- [ ] 使用主 checkout 受管 `node scripts/flywheel-snapshot-control.mjs runner --source <configured-db-path> --kind teamlead`，CommDB 加 `--kind comm --project flywheel`。源码 worktree helper 若缺 dist，使用 main checkout 已构建 helper，禁止 cp live DB。路径由 helper 返回，必须位于 `/tmp/flywheel-snapshots/<exec>/`、总预算≤2GB；完成关闭所有 handle 并 release。
- [ ] 从一致快照提取最小关系闭包，完整 run/op/exec/activation/claims/bindings/CommDB controls+declarations/merge+step receipts；记录 source digest/time 与每个字段映射。Lead 短前缀仅定位，必须 resolve exactly one 或拒绝。若失败前状态已被修复，根据事故材料明确生成 derived fixture 并保留原始副本映射；不可声称 derived fixture 是原始事故快照。
- [ ] 新建 `scripts/qa-fly2616-closeout-replay.mjs`（建议入口）与 `engineering/doc/FLY-2616-proven-closeout/evidence/replay-manifest.json`。使用独立临时 StateStore/CommDB、临时 bare Git+worktree、sandbox Discord thread/Linear issue allowlist；credential 仅 sandbox，拒绝生产 IDs/domains/endpoints，生产 DB 只允许受管 snapshot 入口读取。先运行零网络 local doubles，再在沙盒真实 API 测 readback；doubles 绿不能替代 sandbox receipts。
- [ ] 每案记录 old-head failure → new-head terminal chain；2391 gone 无 ACK，2588 无行 engine 身份，2413 dead parked 清 CommDB，2602 absent worktree（加 already-completed replay 幂等）。所有案最终 `land_operation=completed, workflow_run=completed, thread.archived=true, Linear state.type=completed`；断言通知次数/step receipt 无重复。2244 archive failure 作为第五控制形状。
- [ ] 注入任一活体/unknown 后 archive 和 Linear finalization 调用为0；这是“不改变耦合”的反证测试。租约单独旧逻辑卡住→新逻辑≤10秒、旧 owner effect denied。
- [ ] 运行下面命令；保存 RED/GREEN 输出、exit code、head、fixture hash 和 sandbox readback；精确 pushed head CI 全绿（旧 head 不算），QA 独立复核。
```sh
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/execution-closeout-evidence.test.ts src/bridge/__tests__/land-source-session.test.ts src/bridge/__tests__/land-intent-targets.test.ts src/__tests__/workflow-engine-dispatcher.test.ts src/__tests__/StateStore.workflow-holds.test.ts src/bridge/__tests__/land-finalize-wiring.test.ts src/bridge/__tests__/land-owner-liveness.test.ts src/bridge/__tests__/lifecycle-closeout.test.ts src/__tests__/commdb-session-prune.test.ts src/bridge/__tests__/worktree-cleanup.test.ts src/__tests__/post-ship-finalization.test.ts src/__tests__/StateStore.land-lifecycle.test.ts src/bridge/__tests__/land-executor.test.ts src/bridge/__tests__/lifecycle-routes.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/codex-phase-shutdown.test.ts src/bridge/__tests__/commdb-session-prune.fly1329-parked-veto.test.ts src/bridge/__tests__/post-ship-finalization.fly1434.test.ts src/bridge/__tests__/post-ship-finalization.fly887.test.ts src/__tests__/close-runner.test.ts src/bridge/__tests__/ship-remote-branch.test.ts src/__tests__/fly-2006-database-retention-sweep.test.ts src/__tests__/fly-2413-retention-registry.test.ts src/__tests__/fly-2563-retention-protection.test.ts src/bridge/__tests__/customer-release-store.test.ts
pnpm --filter flywheel-teamlead test:stub-hygiene
pnpm --filter flywheel-teamlead typecheck
pnpm --filter flywheel-comm test
node scripts/qa-fly2616-closeout-replay.mjs --manifest engineering/doc/FLY-2616-proven-closeout/evidence/replay-manifest.json --sandbox-only
```
测试列表中的 land-source-session、land-intent-targets、land-finalize-wiring、land-owner-liveness、execution-closeout-evidence 测试文件要求实施按所列路径新建。最后一个入口为本计划要求新增，当前不存在；实施方必须实现参数/allowlist 校验，不可把示例命令当已运行记录。
- [ ] QA 验证实际 ship-report 正常发布的模板/隔离管线证据；生产 ship 后发布由授权 ship workflow 完成。design HTML 不是 ship report，merge 不是 deploy。本节点不申请 ship。

## 7. 验收证据矩阵
| 要求 | 必需证据 | 设计当前状态 |
|---|---|---|
| 三种死亡/目录形状红绿 | A/B/C 的 old/new head 对照日志 | 未执行，交实施/QA |
| 四实例 completed+archive+Done | F 的 full identity manifest + sandbox readback | 未执行，不以 Lead 故事代替 |
| 活体不归档 | A/C/F 的 live/unknown/launch race negative controls | 未执行 |
| lease death ≤1 heartbeat | D 实际 child kill 时钟与后继 claim receipt；旧 worker fence logs | 未执行 |
| held 不静默/Lead 正门 | E outbox failure/restart/dedupe + authenticated reclose receipts | 未执行 |
| 精确头 CI、ship report | push SHA CI + ship workflow publication receipt | 后续阶段 |
| 设计交接 | 三文档、effective reviewVerdict APPROVED、committed/pushed HTML、hosted fetch/CSP验证、Lead report、phase completion receipt | 本节点负责 |

## 8. 风险和 Follow-ups
存在调度/时间/OS可见性的不确定性就返回 unknown，升级报告写出缺失探针和下一条可执行动作。不能为了四案例绿放宽出生保护、取消/重开、receipt identity、worktree generation 或远端幂等。保留 FLY-2490 pre-adapter provenance 与 FLY-2498 多源缺席的保护精神，通过新矩阵显式回归，不把旧代码的字符串 gone 当证据。
当前没有独立的新 archive 病根证据；2244 仅纳入同一 retry/receipt 接口的控制用例，若出现权限/频道配置新问题交 Lead 分类。未在本设计扩大为全局数据库保留、所有历史 runner 清扫或通用平台监控。
