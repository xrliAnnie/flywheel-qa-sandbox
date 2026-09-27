# Design Review — plan.md (Round 3)
Date: 2026-09-25 / Author: Codex / Status: CHANGES REQUESTED

## Summary

v3 继续取得了实质进展。R2 #3（SQLite/Git 线性化）、#6（删除 generation provenance）、#7（fallback attempt 进入 durable identity）和 #8（两种 vendor 都走冻结 dispatch）已闭环；#1 的三态顶层 bypass、#2 把成功点推迟到首个模型产出、#4 的可重发 permit、#5 的全局因果序方向也都正确。

但源码对照后仍有 5 个 BLOCKER 和 2 个 HIGH。三个最直接的阻断是：same-exec resume 的真实 `StartRequest` 不经过 `admitGeneralizedWorkflowExecution`，所以计划唯一声明的 `codex_quota_resume_launch` writer 不会执行；第二次 claim 把 `attempts_for_permit` 加到 2 后又用 `<2` 验证授权，导致第二次物理拉起必被拒；延迟到首个输出才结算后，Bridge crash 与 notification-before-RPC-response 没有 exactly-once/reconciliation 合同，可能重复发 continue 或把已成功的回合误判失败。

此外，reading permit 把请求发出之后才出现的信号也写进 `covers_signal_seq`，会错误声明旧读数覆盖新撞墙；而在 auto-switch OFF 的通用物理启动路径调用 binder/reconcile，直接冲突于 FLY-2465 design-correction 的绑定裁定“OFF means the quota system is OUT of the launch path entirely”。

本轮为增量设计与源码静态复审；未运行实现测试，也未修改仓库文件。

## What's Good (Keep)

- 保留 `codexQuotaLaunchDecision → authorized | paused | clear`，以及 valid authorization 在顶层同时跳过 execution casualty、root safety guard 和 root pause；invalid supplied authorization 必须 fail closed。
- 保留成功结算不再依赖 `turn/start` receipt，并保留 resuming 续租、活进程计入 runner capacity 的修订。
- 保留 §5.3 的同步 StateStore transaction 作为最终 fence、`update-ref` 和 `checkpoint_commit` 的线性化点。在本项目声明的单 Bridge 进程/单线程 writer 前提下，R2 的 operator/update-ref TOCTOU 已被关闭；trailer recovery 也覆盖了 Git 已改而 SQLite 回滚的窗口。
- 保留 `reading_confirmed` 取代 provenance 分类。canonical/root/reading 三方身份一致，加上 post-wall capacity reading，是比推断“这一代怎么来的”更小、更稳的授权依据。
- 保留 `(source_execution_id, entry_seq, fallback_attempt)`、attempt-specific `source_demand_id` 以及 reverted → next attempt 的合同；R2 的不可达第二次 fallback 已修复。
- 保留任意 prepared demand 都优先返回冻结 dispatch、跳过 live template 与 `applyImplementQuotaDegradation`。Codex fallback 从源 execution runtime 冻结值是正确的。
- 保留“拉起中再撞墙要刷新 `trigger_signal_seq` 并立即使旧 permit 失效”的方向，但其失败分类需按 Issue 7 调整。

## Issues & Recommendations

1. **BLOCKER — `codex_quota_resume_launch` 的唯一计划写入点不在真实 same-exec resume 路径上。**

   **Issue:** §2.5/§4.1 规定由 `admitGeneralizedWorkflowExecution` 在 authorized admission 中写授权绑定，后续 binder 二次检查和 context-less seams 再从该行重建。但现有 `buildStandbyResumeStartRequest` 只设置 `successorExecutionId`、`processLifecycle` 和 `previousSession`，不设置 `generalizedExecution`（`bridge/workflow-resume-identity.ts:49-115`）；`resumeStandbyActor` 直接把这个请求交给 `startDispatcher.start`（`bridge/plugin.ts:14614-14688`）。`RunDispatcher` 不会调用 `admitGeneralizedWorkflowExecution`；该 admission 是 workflow engine 在构造普通 generalized launch 之前调用的（例如 `workflow-engine-dispatcher.ts:2839`）。§6 的新 resumer 仍沿用这条 exact-session request，没有新增 dedicated StateStore admission。

   **Why it matters:** 显式 authorization 可以通过 RunDispatcher 的第一个 gate，但授权绑定行从未产生。计划要求从该行重建授权的 binder 二次检查随后只能按“无授权”执行，旧 casualty/root pause 会再次拒绝启动。对 same-exec resume 来说，计划列出的 launch-owner commit/delivery-repair seams 很可能根本不在这条物理 relaunch 路径上，增加它们并不能补上缺失 writer。

   **Suggested fix:** 先把 exact-session resume 的真实调用图定死。若确需持久授权行，应在 standby claim 事务中写入，或在 RunDispatcher 增加专用的 `admitCodexQuotaResumeLaunch` StateStore seam，并在任何 context-less check 之前执行；不要依赖 generalized admission。若 binder 全程已有显式 authorization，就直接把它传给 binder 的前后检查，删除不在该路径上消费的复杂度。C5 必须用 `buildStandbyResumeStartRequest` 的真实形状跑通，而不是只单测手工调用的 generalized admission，并断言授权行在 binder 二次检查前已经存在。

2. **BLOCKER — 第二次允许的 resume claim 会因 `<2` 条件立即失去授权。**

   **Issue:** §3.3 把 `attempts_for_permit < 2` 定义为 permit 资格；§6.2 claim 时先重验，然后执行 `attempts_for_permit + 1`；§4.1 又要求 active authorization 的 permit“仍满足 §3.3”。第一次 claim 后计数为 1，可以启动；第二次 claim 在旧值 1 时通过预检，但 CAS 后计数变 2，随后的每一个 launch gate 都判定 `<2` 为 false，因此返回 `paused`。

   **Why it matters:** 设计表面上允许同一 permit 两次真实拉起，实际只允许一次；第二次一定在 admission/binder/commit 被自身授权规则拦截，然后可能被误计为第二次失败并直接 fallback。

   **Suggested fix:** 分开两个谓词：`eligibleToClaim` 在 claim 前检查 `attempts_for_permit < 2`；`validateActiveAuthorization` 对已持有的精确 claim 检查持久化的 `resume_attempt ∈ {1,2}`、permit/lease/signal fences，但不再套用 pre-claim budget。最好把本次 attempt number 放入 authorization 和 standby 行。增加“attempt 1 真实失败 → attempt 2 穿过表中每个 gate → 成功”的端到端 RED 测试。

3. **BLOCKER — delayed-success 协议没有 crash-safe exactly-once/reconciliation，且未处理输出早于 `turn/start` response 的乱序。**

   **Issue:** `continue_client_message_id` 包含随机 claim。§6.6 规定 Bridge 重启后对任何旧 owner 的 resuming 行直接计一次失败，再用新 claim 发起下一次 continue。若服务端已接受第一次 `turn/start`、甚至已经产生输出，但 Bridge 在 callback 持久化前崩溃，杀本地 app-server 并不能证明远端 turn 没继续或没写入 thread；新 claim 产生不同 client message id，会再发一回合。另一个同进程窗口是 notification 可能早于 `turn/start` RPC response：现有 `pendingTurnDispatch` 只缓存 `turn/started`/`turn/completed`，明确忽略 `item/completed`（`codex-daemon-client.ts:947-1018`）。即使扩展缓存，若在 `onQuotaContinueStarted` 把 DB phase 置为 `continuing` 之前就 drain，第一个输出 callback 仍会因 phase 不匹配而丢失。

   **Why it matters:** 这既可能重复工具调用/工作，也可能让一个已经成功的 continue 等 10 分钟后被杀并计失败。R2 #2 把成功点推迟后，这个窗口从一个 RPC receipt 窗口扩大为最长 10 分钟，不能用“Bridge 与 adapter 同进程”消除远端 turn 的不确定性。

   **Suggested fix:** 引入独立于 owner claim 的 durable `continue_attempt_id/clientUserMessageId`，在没有得到该 attempt 的确定 terminal/first-output 证据前不得生成新 id。重启时先用持久 turnId 或 client message id 重接/查询该 turn：已有首输出则补结算，仍在跑则继续观察，首输出前确定失败才消费 attempt；无法证明时保持待命并诊断，不能盲发第二回合。runner 必须从 `startTurn` 前开始缓存该 thread 的 started/item/completed 通知，拿到 turnId 后先持久化 `continuing`，再按顺序 drain 匹配事件。测试至少覆盖：RPC 已被服务端接受但 response 前崩溃、response 后/onStarted 前崩溃、首个 item 到达但 success CAS 前崩溃、item 早于 RPC response；每种均断言最多一个 continue turn。

4. **BLOCKER — `reading_confirmed` permit 会把证据请求之后出现的信号错误标为已覆盖。**

   **Issue:** v3 正确地在请求前分配 `requestSeq`，但 §2.3 又把 `covers_signal_seq` 定义为 permit 发放时“全局已分配的最大 signal_seq”。时序可以是：wall signal=10；reading requestSeq=11 发出；另一个 relevant root/unbound signal=12 在 HTTP 飞行中出现，但它没有进入“待放行 standby 行”的 max（例如 review/legacy/未满足进入条件的 signal）；reading 返回有额度；permit 被写成 `covers_signal_seq=12`。§3.3 随后认为 signal 12 已被该 reading 覆盖，尽管请求在它之前发出。

   **Why it matters:** 新撞墙本应立即作废旧容量证据，却会被 permit 的 covers 值吞掉，系统可在一个更新、更强的 usage-limit 事实之后仍启动 Codex。

   **Suggested fix:** reading-backed permit 的覆盖边界必须来自 evidence，而不是 issuance time：在 permit transaction 中要求不存在 relevant signal `signal_seq >= reading.requestSeq`，并把 `covers_signal_seq` 设为该 request 之前可证明覆盖的最大 relevant signal（必然 `< requestSeq`）。之后到达的任意 relevant signal保持 `> covers` 并失效 permit；下一次 requestSeq 更大的 reading 才能发新证据。为 `request allocated → new bound/unbound signal → response → permit evaluation` 加精确 interleaving 测试。`switch_committed` 可继续以 switch transaction 的序列位置为边界。

5. **BLOCKER — 在 auto-switch OFF 的通用启动路径调用 binder/reconcile 违反绑定的 FLY-2465 OFF 裁定。**

   **Issue:** §3.2 要求 `wireCodexQuotaDispatcher` disabled branch 也 await `reconcileCodexCanonicalRoot` 和 `createCodexQuotaLaunchBinder`，即使失败会 fail-open。这仍把 quota 的文件读取、身份判断和 StateStore 写入放回每个物理 Codex launch。`FLY-2465-codex-fleet-rotation/design-correction.md` 的绑定文字是：“OFF means the quota system is OUT of the launch path entirely — no admission fence, no pause fence, for every launch”，中文正文也明确是“完全退出每条启动准入及物理启动路径”。Fail-open 只解决拒绝语义，不能把一个 awaited quota hook 变成“退出路径”。

   **Why it matters:** 这是 Lead 已裁定的开关合同，不是实现偏好。它还扩大了 OFF 状态的启动延迟与数据库副作用，并改变已经上线的 rollback 语义。

   **Suggested fix:** 普通 launch 在 auto-switch OFF 时维持立即退出 quota hook。B2 应使用 v3 已设计好的 unbound-safe 路径：flag-off 冷启动的首次撞墙可以没有 binding，`reading_confirmed` 仍凭 current canonical/root/reading identity 放行。若 quota-standby resumer 在自己的独立 feature flag 下需要为新物理进程登记新代 binding，可在该显式 resume flow 内完成，而不是改变所有 OFF launch；或者在 terminal-signal/后台观察点做不参与启动的归属记录。把 C4 的 cold-start 断言从“有 binding”改为“无 binding 也能恢复”，并加一条 OFF 时 binder/reconcile 调用数为 0 的 design-correction 回归测试。

6. **HIGH — `requestSeq` 放在 reading scheduler 层无法覆盖真实的共享 refresh 入口，也没有定义 carried reading 的字段级因果 provenance。**

   **Issue:** 当前 `createCodexReadingScheduler` 只看到一个整轮 `refresh(): Promise<unknown>`，不知道每个账号的实际请求时刻（`reading-scheduler.ts`）；同一个 `refreshCodexReadings` 又被 scheduler、额度页和 post-switch refresh 共享（`bridge/account-quota-refresh.ts:88-110, 220+` 与 `plugin.ts:9107+`）。若只按 C1 所写修改 scheduler，其他入口会覆盖 `codex-accounts.json` 而没有 requestSeq。更危险的是 observer 的 `carried()` 会在读失败/identity uncertainty 时保留上一轮的 `observedAt`、fiveH、weekly（`codex-accounts-observer.ts:81-112`）；若一轮级别的新 requestSeq 被附到整个结果，旧容量值会伪装成 post-wall reading。源码还显示只有 `inUse===true` 才走 readonly WHAM，idle slot 走 `readSlot` app-server/refresh-token 路径；standby 时原进程已退出，不能假定 canonical 一定仍被 occupancy 判 in-use。

   **Why it matters:** 可能出现旧读数获新序号、有效证据被页面 refresh 擦掉，或 permit 路径实际执行了计划明确排除的 exec/token refresh。B2 的 ≤5 分钟和 research §3H 的只读边界都不稳定。

   **Suggested fix:** 把序号分配放到所有入口共用的“实际账号读取”层，而不是 scheduler wrapper；每个成功的新 quota observation 记录自己的 requestSeq，失败时 carried fields 必须保留旧 requestSeq，绝不能盖新号。对 permit 的 canonical 读数建议使用独立的 readonly-WHAM path，紧邻 fetch 前取序号，成功后原子 merge 到 store；不依赖 occupancy。测试 scheduler/page/post-switch 三个入口、部分账号失败、carried stale reading、standby canonical idle 四种情况。

7. **HIGH — resuming 中再次 usageLimited 不应触发机械 resume-failure fallback，且新 incident targets 的结算未定义。**

   **Issue:** §3.1 把新 usageLimited 更新为新的 `trigger_signal_seq`，同时“按本次拉起失败”走 §6.5；若这恰好是第二次 attempt，§6.5 会进入 Codex fallback。可是这条 signal 已经使当前 permit 失效，证明失败原因是容量证据过期，而不是 thread/process relaunch 机械失败。此时新 Codex execution 仍会拿当前 canonical 账号，除非另一个 permit/switch 已发生。`recordSignal` 还会为新的 bound signal 建新的 incident/target，而 standby 行仍保留原 entry/source event；§6 success 只写“target（若有）recovered”，没有说明要结算本 entry 期间新增的所有 waiting targets。

   **Why it matters:** 系统可能在刚确认新号也撞墙后立即换体，重现本单要消除的盲换；或者留下第二个 FLY-2465 target 永久 waiting，后续 recovery coordinator 与可见性持续卡住。

   **Suggested fix:** 为 `goal_usage_limited` 定义独立的 `capacity_rejected` settlement：清理本次进程、回到 standby、刷新 trigger 并等待下一张 permit；它可以消费本次 physical attempt，但不得以 stale permit 立即触发 `resume_attempts_exhausted` fallback。只有 thread/identity/goal activation/process/progress 等非额度恢复失败累计到 2 才走 Codex 新体。standby entry 应显式关联或按 signal_seq 范围结算其期间产生的所有 quota targets。增加“attempt 2 再撞墙 → fallback launch=0 → 新 permit 后续跑”和“两个 incident target 全 recovered/abandoned”的测试。

## Verdict

**CHANGES REQUESTED**

v3 已关闭 R2 的四项，并把另外四项推进到更接近可实现的状态；但 same-exec 授权 writer、第二次 attempt、continue 的 crash/乱序语义、reading coverage 以及 auto-switch OFF 合同仍会阻断或破坏主线。修正这些边界后，主体架构无需再改。
