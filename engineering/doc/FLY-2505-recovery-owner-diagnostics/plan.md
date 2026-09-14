# FLY-2505 恢复失败留因与分类重试 — 实施计划
Issue: FLY-2505 (https://linear.app/geoforge3d/issue/FLY-2505/病根-重启后-reown-的-recovery-owner-在-commit-前失败且不留原因resulttext-空-只剩通用文案两次即)
日期: 2026-09-10
基于: research.md

状态: APPROVED（R2 有效 reviewVerdict，2026-09-10；gate 0bf3e2f9-1a20-4387-97d8-dc710e9d3419）。设计基线 `d964e9fca`；分支 `flywheel-FLY-2505`。本计划描述后续实现，不代表修复或真机验证已完成。

## 1. Founder 概览

让每次认回原任务的失败都说明“在哪一步、因何失败、是否扣次数”，并给明确的启动准备错误一个有限的重试机会。

恢复负责人（recovery owner）是重启后接手原任务的执行器。提交（commit）是系统确认它已接手的那一刻。恢复轮次（episode）是一段连续认回过程；普通错误最多两次，启动准备错误有独立的次数和时间上限。

流程见 `flow.mmd`，数据关系见 `model.mmd`，最终页面 `design.html`。核心顺序：验证原身份与权限 → 暂占一次失败额度并生成唯一启动编号 → 启动并等待接管回执 → 成功提交，或先保存诊断再结算额度。只有确定的启动准备失败且已确认排空本轮进程才退回额度；其他失败保留扣数。

Lead 已批准 readiness 最多 3 次失败（含首次，因此最多再启动两次）/15 分钟，到任一上限明确收口并告警，不新增人工停驻态。依据：问题 `0eee842b-eb25-429d-8c67-293e0aa629e2` 的答复；所有新边界都必须持久化。

### 交付判断

| 可见行为 | 必须具备的证据 |
|---|---|
| 失败可解释 | reown_revive_failed 中非空 reason、稳定 code、stage、episode/启动编号、是否扣数 |
| 瞬态重试不误伤两次预算 | readiness 失败后 chargedAttempts 不增加，新 reservation 仍能轮换凭据 |
| 重启不洗掉预算 | 关闭/重开隔离 SQLite 后计数、重试时间和诊断完全一致 |
| 等待间隙不被 generic zombie 抢先判死 | 有界恢复保护的 Heartbeat 集成测试 |
| 耗尽可定位 | 终态、Lead 告警带耗尽类型、最后原因及诊断事件身份 |
| 原体确实恢复 | 后续隔离 slot 复现，execution/thread 保持，接管回执提交，后续原任务正常动作；单纯文案改善不算 |

## 2. 单一错误合同

创建 `packages/core/src/codex-recovery-failure.ts` 并从 `src/index.ts` 导出类型、校验/归一化、固定文案及策略常量。`adapter-types.ts` 的 `AdapterExecutionResult` 增加可选 `recoveryFailure?: CodexRecoveryFailureV1`。已有 `failure: TerminalFailureInfo` 不改枚举与 quota/blocked 语义。

```ts
type RecoveryStage = "preflight" | "context" | "daemon_spawn" |
  "socket_connect" | "owner_admission" | "commit" | "teardown" | "unknown";
type RecoveryCode = "daemon_socket_not_ready" | "daemon_connect_not_ready" |
  "launch_snapshot_mismatch" | "capability_mismatch" | "permission_denied" |
  "daemon_start_failed" | "owner_admission_failed" | "commit_refused" |
  "owner_result_missing" | "owner_failed_unknown" | "cleanup_unconfirmed";
interface CodexRecoveryFailureV1 {
  version: 1;
  code: RecoveryCode;
  stage: RecoveryStage;
  summary: string; // 1..500 Unicode code points，清洗后的可显示文字
  cleanup: "not_started" | "confirmed_absent" | "unconfirmed";
  systemCode?: "ENOENT" | "ECONNREFUSED" | "EACCES" | "EPERM";
  mismatchFields?: Array<"cwd" | "model" | "effort" | "skillFrameworkMode" |
    "phaseRole" | "loopTargetNodeId" | "capabilityDigest" | "sandboxWritableRoots">;
  secondaryCode?: "cleanup_unconfirmed";
}
```

`isReadinessFailure` 唯一策略：`(code,stage)` 必须为 `(daemon_socket_not_ready,daemon_spawn)` 或 `(daemon_connect_not_ready,socket_connect)`，cleanup 必须 `confirmed_absent`；连接错误还须系统 code 为 ENOENT/ECONNREFUSED。不读取自由文案决定预算。不开放 runner CLI/API 上报免计字段；只接受进程内 adapter/runtime 的诊断，持久化 JSON 读取时仍校验 version/enum/size。

固定常量：`MAX_CHARGED_ATTEMPTS=2`、`MAX_READINESS_FAILURES=3`、`READINESS_WINDOW_MS=900000`、`READINESS_RETRY_DELAY_MS=30000`。定时维护仍由当前周期驱动，30 秒是最早可重试时间，不新增每体 timer；到期收口发生于下一维护 tick，不承诺恰好 15 分钟执行。 新增 RECOVERY_PRECOMMIT_OBSERVATION_MS=300000，仅供有限监控保护，不延长 60s mutation lease。3 次与 15 分钟是两个独立上限，先到即止；不保证一定提供三次机会，维护跳 tick 或 Bridge 停机可能使实际只尝试一到两次。这遵守 Lead 对固定时间窗的裁定，不按繁忙情况自动延期。耗尽事件新增 exhaustionTrigger=charged_count|readiness_count|readiness_deadline，连同实际次数如实说明哪个上限先到。

### 2.1 错误来源表（产生点标记，不能根据文本猜）

| 来源 | code/stage | 是否可免计 |
|---|---|---|
| `spawnCodexDaemon` socket deadline；child 与 socket 清理确认完成 | daemon_socket_not_ready / daemon_spawn | 是 |
| `startSession` 的 connectTransport 明确 ENOENT/ECONNREFUSED；failClose 排空成功 | daemon_connect_not_ready / socket_connect | 是 |
| daemon executable 不存在、早退、未知 spawn error | daemon_start_failed / daemon_spawn | 否；ENOENT executable 不等于 socket 未就绪 |
| EACCES/EPERM、pre-auth 拒绝 | permission_denied 或 owner_admission_failed / 对应阶段 | 否 |
| immutable launch snapshot 比较失败 | launch_snapshot_mismatch / context，附 mismatchFields | 否 |
| buildCodexRecoveryContext 两个权限布尔漂移 | capability_mismatch / context | 否 |
| goal/admission/通用 timeout/未知 throw | owner_admission_failed 或 owner_failed_unknown | 否 |
| commit 被 fence 拒绝 | commit_refused / commit | 否；保持既有 fence 事件 |
| owner 成功返回但没有接管回执；claim 过期而无结算 | owner_result_missing / owner_admission | 否 |
| 任何排空未确认 | 原 code + secondaryCode=cleanup_unconfirmed、cleanup=unconfirmed；无首因则 cleanup_unconfirmed/teardown | 否 |

内部 typed Error 将上述数据带过 runtime throw；不得在底层提前声明 confirmed_absent。`cleanupAndThrow` 的 child+socket 双确认以及 `failClose` 的 drain 结果才产生该证明。若 cleanup 覆盖原异常，保留 primary code/stage，并附 secondaryCode，禁止把先发生的失败抹掉。

### 2.2 返回值与可见诊断

- `CodexTmuxAdapter.executeOwned` 失败统一返回非空 `resultText`：优先新诊断 summary；兼容旧结果时先 `failure.failureReason.trim()`，再 `cls.failureReason.trim()`，最后有内容的 `cls.resultText.trim()`，均经过清洗。无证据时固定为“恢复负责人在 <stage> 失败；未提供可识别错误（owner_failed_unknown）”。成功路径的 resultText 不变。
- ownershipFailureResult、resumeExistingExecution 前置 throw、executeOwned 主 catch、runtime spawn/connect catch、finally/retireOnce reject 都接入诊断；回收失败不能覆盖 primary cause。生产 caller 与测试 fake 返回 undefined/空白/非 Error 均被覆盖。
- reown 边界必须再次 normalize：typed recoveryFailure → 已有 failure.failureReason → resultText；任何 legacy/free-text 只作清洗后的兼容展示，类别一律 owner_failed_unknown，不获免计。
- 不把错误原始 JSON、stack、env、prompt、snapshot、credential、完整路径写进 event。已知错误用固定文案和白名单字段；legacy 说明先剥 ANSI/control/提及，再屏蔽凭据键值、Bearer/JWT/已知 token、绝对路径和 URL userinfo，最多 500 code points。无法安全识别的原始文本只保留固定 unknown 摘要和安全 error name/code，不向 Lead 回显原字符串。
- 可显示中文标签只从 core 的 code→label 映射生成；分类器/数据库只用 code。路径/label/sessionId 不是预算或授权 identity。公开 HTML 插值全部 escape，运行期仅 textContent/value。

## 3. 持久化、预算和幂等

### 3.1 recovery_claim additive 列

| 新列 | 默认 / 约束 | 用途 |
|---|---|---|
| `recovery_policy_version` | INTEGER NOT NULL DEFAULT 0 | 0=历史状态；新 claim 启用 1 |
| `reservation_seq` | INTEGER NOT NULL DEFAULT 0, 非负 | 每个 execution 全生命周期单调；永不退款/重置 |
| `lease_purpose` | NULL / recovery / mutation | 区分恢复负责人和 TURN 写者的真实锁 |
| pending_reservation_until_ms | INTEGER NULL | claim 时写 now+300000；未结算 reservation 的固定监控宽限，跨重启保留，不是 mutation authority |
| `episode_lifecycle_revision` | INTEGER NULL | 独立于 abort 会清掉的 lease revision |
| `readiness_failures` | INTEGER NOT NULL DEFAULT 0 | 本 episode 已证实的 readiness 失败数 |
| `first_readiness_at_ms` | INTEGER NULL | 第一条 readiness 结算时间 |
| `readiness_deadline_ms` | INTEGER NULL | first+15min，后续失败不延期 |
| `next_retry_at_ms` | INTEGER NULL | 最近可重试时间，清锁后仍存在 |
| `last_failure_json` | TEXT NULL | 有界已校验诊断+事件 id+序号+budgetDecision |
| `exhaustion_kind` | NULL / charged / readiness | 持久化待终态收口原因，防 callback 丢失 |

既有 `episode_attempts` 继续表示已经扣除或本轮暂占的失败额度，范围 0..2；代码/新事件显示为 chargedAttempts。每次 claim 先暂占一格，success commit 清零；只有原子结算证明 readiness 或既有 mutation 前 fence abort 才退还。claim 自己崩溃不会免费。

`CodexRecoveryClaimResult` 成功增加 reservationSeq；失败增加 `retry_not_due`（附 retryAtMs）和 `readiness_retry_exhausted`（附最后诊断、episodeId），保留其他既有返回。所有数字为 safe integer，nowMs 非负、顺序单调检查；异常时间字段 fail closed 为 charged unknown，不给永久 hold。

### 3.2 claim / prepare / settle 状态规则

1. claim 先保留现有 session status、revision、successor、真实 lease 校验。policy=1 的 open episode 先处理持久化 exhaustion，再处理 deadline，再查 chargedAttempts>=2，最后 cooldown；不得在 cooldown 时 reap/spawn/rotate。
2. 新 claim：reservation_seq+1，episode_attempts+1，purpose=recovery，episode_revision=本次 revision。episodeId 按现有 open/closed 规则复用或新建。deadline 不因 claim、Bridge 重启或重复 tick 改写。 同时固定 pending_reservation_until_ms=now+300000；同一次 reservation 的观察宽限不续期。settle/commit/成功 TURN writer commit 清该字段，新的 reservation 才可获得新的界限。
3. 过期但仍有未结算 recovery token：先在同事务把旧 reservation 记为 owner_result_missing（保留暂占费用；不重复增数），再决定是否准许新 claim；为旧序号生成唯一失败事件，不把无回执当 transient。
4. `prepareCodexRecoveryCapabilities` 新 UID：`codex_recovery_capabilities_prepared:v1:<execution>:<episode>:<reservationSeq>`。JSON `recoveryAttempt` 改为 reservationSeq，并新增 `reservationSeq`/`chargedAttempts`；**workflow payload.attempt 仍为 workflow activation attempt**。旧 UID 不删除/重写。每个新 reservation 独立旋转凭据，plaintext 仍只返一次；同 reservation 第二次 prepare 仍拒绝。
5. 新 settleCodexRecoveryFailure(executionId, claimToken, expectedRevision, reservationSeq, failure, nowMs)。用 IMMEDIATE 事务复读 token、purpose=recovery、episodeId、reservationSeq、expectedRevision、episode revision、session eligible status、successor=NULL 和 open state。结算不要求 lease 未到期：仅结算仍唯一匹配且未被任何 recovery/mutation writer 接管的 token，即使 now 已超过 expires_at_ms 仍可写诊断/退款；这里不 reap/spawn、不授予新权限、不延长 lease。若新 owner 先取得 token、成功 commit 或 episode/revision 已变化，则旧回调不能改预算；迟到诊断可另写非账务观察事件，注明 stale，不覆盖当前 last_failure。下一次 claim 与 settle 的事务串行：谁先改变 token 谁获胜；claim 先胜时按第 3 条记 owner_result_missing，settle 先胜时保留真实诊断与正确退款。重复相同结算按第 6 条读取固定事件幂等返回。


claim/commit 的 60s 权限期限保持不变；只有失败后的记账结算按 token 唯一性决定。
6. 成功结算在一个事务里写 `reown_revive_failed` 事件、更新 last_failure_json、清 lease，并计算退款/上限。事件 id 固定 `reown_revive_failed:v1:<execution>:<episode>:<reservationSeq>`；先查 id，重复调用返回已结算结果，不能二次退款。事件插入与状态更新任一失败整事务回滚。所有 SQL 用参数绑定。
7. readiness：episode_attempts 减一（非负断言），readiness_failures+1；第一条设 first/deadline；未达 3 且 now<deadline 设 nextRetry=min(now+30s,deadline)。第 3 条或到 deadline 设置 exhaustion_kind=readiness，不再启动；最后一次也退回 charged 额度，不能伪造“2 次失败已耗尽”。未知/永久失败保留暂占额度，达到 2 则 exhaustion_kind=charged。
8. 既有 mutation 前 fence abort 继续 releaseAttempt 并清锁，不算 readiness；不写伪造失败。prepared/spawn 之后 fence 丢失保留当前保守计数，不给 transient 分类。
9. 成功 commit 仍必须通过 expiry/revision/TURN/successor CAS，清 episode_attempts/readiness/延时/exhaustion，close episode；保留 reservation_seq 和历史事件，不改 execution/thread/immutable snapshot。
10. 引入 `precommitSettled` 与共享 `isRecoveryCommitted()` 只读 hook：协调器在 DB commit 成功后立即置 committed=true，runtime wrapper 和 adapter 都读取这一事实。reconcile 后续抛错属于 postCommit；不得回退预算。receipt 开始前以及每个 await 后检查 precommitSettled；已失败的 receipt 不可再 commit。commit 与 settle 事务互斥，只有一方胜出。
11. terminal resolve success=true 但 committed=false 必须按 owner_result_missing 结算；所有 sync throw、promise reject、false result 共用同一结算入口。

### 3.3 与 TURN mutation lease 的边界

`claimExecutionMutationLease` 继续只看真实未过期 lease，不读取 readiness cooldown。写 lease_purpose=mutation，但不改 reservation_seq。其 commit 按原合同 close episode/reset budget，并同时清所有 readiness/deferred 字段，避免 TURN 已改变后留下过期保护；这代表显式 TURN 写者完成的新边界，不是重启时自动洗账。失败不提前放锁，保持 TTL。普通 reown tick 不调用该 writer 来清预算；只有既有 TURN 操作/恢复后 reconcile 才走原路径。测试覆盖同 holder 无实际 TURN 更新时不能由新代码额外调用 writer。writer commit 后清空 policy/episode revision/readiness 状态；reservation_seq 与历史诊断保留。

### 3.4 事件、耗尽和终态

新失败 payload 保留 `reason`（非空摘要）、`episodeId`、`attempt`（新 policy 下为 reservationSeq）、eventId/source；增加 `diagnosticVersion:1`、`failure`、`reservationSeq`、`chargedAttempts`、`readinessFailures`、`budgetDecision: charged|refunded`、`nextRetryAtMs`、`readinessDeadlineMs`。postCommit=true 事件绝不携带退款结算。

耗尽原因分别为既有 `reason=episode_exhausted` 和新增 `reason=readiness_retry_exhausted`，都附 episodeId、计数、lastFailureEventId、lastFailure。固定耗尽事件 id `reown_exhausted:v1:<execution>:<episode>`，数据库插入幂等；不得丢最后原因只留总次数。

扩展 `onRecoveryExhausted` / `CodexRecoveryRuntime.failExhausted` 输入为结构化 exhaustion 对象，统一组装 `failureKind:reown_exhausted`、`failureCode`（上述原因）、`failureReason`（耗尽类型+最后 code/stage/summary+event id）。保留现有 DirectEventSink 终态路径；在 emitFailed 前复查 session/revision/successor/当前 binding，不覆盖其他终态。每次 tick 对持久化 exhaustion 重试 sink/Lead 告警投递，直到现有 lifecycle 确认终态；失败不得清 pending exhaustion。本任务的 generalized workflow 耗尽在同一 StateStore 事务里调用既有 enqueueWorkflowEngineAlertTx（StateStore.ts:47923）写 workflow_alert_outbox，固定 escalationUid=reown-exhausted:<execution>:<episode>；payload 首次冻结，正文和 metadata 含结构化摘要与实际 Lead identity。outbox 由既有 dispatcher 重试，session 终态后仍会投递，不依赖 reown candidate 列表；不得用当前仅写桌面/文件且按通用 reason debounce 的 MetaAlertNotifier 冒充 Lead 告警。为结算方法从 plugin 传入已解析的 WorkflowEngineAlertIdentity，并在事务内核对 execution→run 绑定。无 workflow 绑定的 legacy session 保留原 meta-alert 路由并明确记录兼容限制，本单不重建其通知体系。利用既有终态免疫/通知去重，不新增第二个 sessions writer。postCommit failure 保留原 quota/blocked failure 优先级与 DirectEventSink 行为。 R1 补充：在相同事务内先 SELECT workflow_alert_outbox WHERE escalation_uid=?。若命中，验证 run_id 及已存 metadata 的 executionId/episodeId 与本次持久化身份相同，直接复用原 row，不重新构造/序列化/enqueue；路由配置变化、文案变化或再次 tick 不触碰原 payload。若未命中，仅用本次结算即将持久化的 exhaustion/last_failure、已解析 identity 和固定文案构造一次，再 enqueue；原子事务保证失败结算与首次告警一起落盘。投递重试仅由既有 outbox dispatcher 处理；finalizeDueExhaustion 不重新 enqueue 已有 uid。禁止把 now/当前 session 标签等可变量加入重试 payload。

## 4. Generic zombie 竞争的有限保护

StateStore 增加只读 `getCodexRecoveryDeferral(executionId, nowMs)`，返回 false 或 `{episodeId, untilMs, reason}`。它联合 fresh sessions，要求 backend=codex-tmux、status=running、retry_successor=NULL、open episode/policy=1、episode_lifecycle_revision=current revision、无 exhaustion。

允许两种证据：purpose=recovery、同 episode/序号且尚未结算的 reservation，且 now<pending_reservation_until_ms（until=该固定界限，与 lease 是否过期无关）；或已经持久化 readiness 退款、next_retry_at 非空、readinessFailures<3、now<固定 deadline（until=deadline）。第一种还需当前 claim_token 未被替换、未 commit；不能仅凭 open episode 就保护。due retry 仍保护到 deadline，不能因 nextRetry 已到而在 maintenance 取锁前被判死。closed/legacy、mutation lease、损坏字段、terminal/superseded/revision 变化一律不保护。实际 TURN/当前 activation 与 60s lease 校验仍由 reowner 在新 claim/提交前执行；监控宽限不授予 worktree 或 spawn 权限。现有 adapter onHeartbeat 和默认 60 分钟 orphan 阈值保持原样，本设计不以它们证明该宽限正确。

`HeartbeatService` 三个接点使用同一谓词：dead 分支（清 dead streak，加入本 pass ctx.held）；declareZombie 的异步取证与探活之后、同步 transition 之前重新检查；reapOrphans 的最终同步写入前独立检查。不得只检查旧 snapshot/set。

不把 deferral 接进全局 isMonitorSuppressed；完成 marker、quarantine、确认 dead_pin/crash reaper、人工 stop/close、终态免疫保留。新增保护不给 heartbeat 刷时间、不报告 alive、不延长 claim。观察宽限结束即不再掩护未结算 owner。

到 readiness deadline 的收口接缝为 HeartbeatService.setCodexRecoveryExhaustionHandler(handler)，plugin 注册到 reowner.finalizeDueExhaustion(executionId)。getCodexRecoveryDeferral 可返回 expired_readiness（仅表示已到界）。declareZombie 把 handler await 放在慢取证之前；无论 handler 返回/抛错，随后都必须重新完成原 INV-9 全套 re-proof：fresh session（status+revision）、fresh CommDB target/pane probe、邻接 tmux server-up 检查，之后同步读取 deferral、准备通知、CAS transition，中间零 await。禁止在完整 re-proof 与同步 transition 之间再 await handler。

reapOrphans 同样先执行 handler，之后重新取得 fresh session、重新计算 heartbeat aging 并检查最新 suppression/recovery predicate；同步判定到写入之间零 await，不能沿用 await 前的 candidate 或分钟数。handler 事务设置 exhaustion_kind、固定事件/outbox，再走现有 failExhausted；若已终态自然退出。handler 错误/缺失只允许从固定 readiness deadline 起最多 5 分钟让渡，不滚动延长；过后 generic 原路径可收口，但 last_error 和其告警/event 必须附已存 readiness_retry_exhausted 与诊断引用。人工停止路径不接该 handler。

## 5. 迁移与回滚

- 用现有 addColumnIfMissing/迁移机制添加列；只对目标新增列迁移错误做显式错误处理，不吞任意 DB 错误。历史 open episode 保留已花 episode_attempts，policy0 不获得 readiness 保护；首次新 claim 原子升 policy1，reservation_seq 至少为旧 attempts。v1 UID 自带 namespace，保证不会撞旧事件；旧事件、凭据、session.json 无变更。
- 历史 closed 行保持 closed；新序号此后全 execution 单调。未知 legacy cause 不回填虚构诊断，lastFailure 保留 NULL 或合成明确的 legacy_owner_result_missing 摘要（code=owner_result_missing），不退款。
- schema rollout 与消费端同一版本发布；合并与部署分离，独立 updater 按窗口部署。设计节点不重启服务。
- 回滚仅回退代码，保留 additive 列和审计事件。旧程序会恢复旧“2 次预算”、忽略 readiness/新诊断、可能因旧 UID 或额外运行而提前失败，因此是保守失败行为回退，不保证在途 readiness 继续。回滚前由运维记录 open episode；不得 DROP 表、清次数或手改凭据来掩盖。不新增临时 feature flag。

## 6. 消费者改动清单

| 文件 | 具体改动 |
|---|---|
| core `codex-recovery-failure.ts`（新）/`adapter-types.ts`/`index.ts` | 唯一 code/stage/summary/parse/policy 合同 |
| runner `codex-daemon-runtime.ts`/`codex-daemon-goal-runtime.ts` | typed readiness 产生点、系统 code、排空事实；保留安全 kill/lock 规则 |
| runner `CodexTmuxAdapter.ts`/`codex-daemon-adapter-helpers.ts` | snapshot mismatch 字段名、所有失败非空 resultText、primary/secondary 原因、共享 commit 事实 |
| teamlead `StateStore.ts` | additive schema，claim/prepare/settle/commit，mutation-purpose、readonly deferral、typed exhaustion |
| teamlead `bridge/codex-session-reown.ts` | 归一化、原子结算、迟到回调/无回执、retry cooldown、统一 committed、exhaustion 路由 |
| teamlead `bridge/run-infra.ts`/`bridge/plugin.ts` | hooks 透传、结构化终态与 Lead 告警、维护让渡接缝、类型更新 |
| teamlead `HeartbeatService.ts` | 仅 generic zombie/orphan 的有限 deferral 与最后原因引用 |
| scripts `lib/qa-fly-2456-observe.mjs` | 旧 classifier 分支保留；新 v1 按 episode/reservation/charged/readiness 判断，不能因多次瞬态或新 episodeId 变 other |
| scripts `lib/qa-fly-2456-evidence.mjs` | 新 claim 字段投影白名单，排除 token/raw 信息 |
| scripts `lib/qa-fly-2456-report-fields.mjs` | 只公开 code/stage/计数/耗尽类型/事件引用，不发布完整自由诊断 |

其他 kill 路径、权限模型、工作流 replacement 规则和已失败历史 session 不改。不能让本单顺带变成引擎 replacement 重设计。

## 7. 顺序实施与 TDD

每个任务按“写失败用例 → 运行确认红 → 最小实现 → 运行绿 → 提交”执行，不能先改代码后用镜像测试证明自己。测试要走实际生产组合，不仅检查字串。

| 任务 | 精确测试位置与步骤 / 红点 | 完成条件 |
|---|---|---|
| T1 留因合同 | 新 core `src/__tests__/codex-recovery-failure.test.ts`；runner `test/CodexTmuxAdapter.test.ts` 注入 Error、空 resultText、snapshot mismatch、cleanup reject | 原实现 failed result 缺文本；改后 code/stage/resultText 非空，既有 quota/blocked 信息不丢，成功文字不变 |
| T2 readiness 证明 | `test/codex-daemon-runtime.test.ts` fake socket deadline+fake child退出；child或socket存活对照；`test/codex-daemon-goal-runtime.test.ts` connect ENOENT/ECONNREFUSED 与 executable ENOENT/EACCES、通用 GoalRunError timeout 对照 | 仅两种 readiness+confirmed_absent 免计；清理失败保留首因且不免费；所有 kill 使用 fake 注入 |
| T3 SQLite 结算与迁移 | `StateStore.codex-recovery.test.ts` fresh/legacy schema；prepare→settle transient→claim→prepare；关闭再打开临时 DB；重复结算、旧 token、过期 lease、revision/successor/commit 竞争 | 退款仅一次；新 UID/凭据生效，workflow attempt 不变；3次/15min 不重置；2 unknown 耗尽；事务事件失败无部分退款 新增生产时长参数的 fake-time 序列：claim@0、socket deadline@30s、child+socket cleanup 各10s、其他收尾20s、settle@70s（TTL=60s）仍退款并留真实诊断；先发生 takeover/commit/revision 变化的对照不退款。使用模拟时间运行实际组合函数，不以实睡或更短测试常量绕开。维护节拍用300s，跳一个/两个tick仍按实际次数与 deadline trigger 如实耗尽。 |
| T4 共享锁 | `bridge/__tests__/execution-mutation-lease.test.ts` cooldown 期间 writer 成功、活 recovery lease 时拒绝、writer commit 清 stale deferral、throw 留锁 TTL | 不阻塞合法 TURN，也不洗掉单调序号；新增代码不额外调用 writer 清预算 |
| T5 协调器集成 | `bridge/__tests__/codex-session-reown.test.ts` typed result、legacy result、reject、success-no-receipt、late receipt、commit后reconcile throw、deadline/cap | 一个结算事件；无回执必失败；commit后不退款；precommit 不写 sessions failed |
| T6 runtime/告警接缝 | `bridge/__tests__/run-infra-codex-recovery.test.ts` 与 `codex-session-reown-wiring.structure.test.ts`；真实 fake sink 校验 failed reason/code；失败通知重试/去重 | precommit 不发终态；commit后失败发一次；exhaustion 带最后事件和原因，sink/alert失败不丢 pending 同 uid 二次 finalize 时故意更换 Lead 路由和文案，必须复用冻结 outbox，不抛冲突、不回滚退款；无关联身份的 UID 冲突则失败并保留异常证据。 |
| T7 Heartbeat 竞争 | `src/__tests__/HeartbeatService.zombie-reconcile.test.ts`、`HeartbeatService.test.ts` fake clock+probe+deferred forensics；直接 reapOrphans；deadline 让渡与维护失效对照 | active lease/readiness gap不被判死；到期走明确exhaustion；超过一次维护让渡有界退出；不刷 heartbeat；非Codex/terminal/successor/marker/quarantine/dead_pin不受影响 覆盖60s lease过期→70s settle之间仍受 pending reservation 固定宽限保护，300s未结算不再保护；handler await 期间恢复成功但status仍running，随后完整pane/server/revision re-proof必须阻止判死；直接reapOrphans也重新算fresh heartbeat。 |
| T8 演练消费 | `scripts/__tests__/qa-fly-2456-observe.test.mjs`/`qa-fly-2456-verdict.test.mjs`/`qa-fly-2456-report-pair.test.mjs` 添加 v1 多瞬态再成功、两次 charged、readiness到界、缺episode证据 | legacy R1/R2 fixtures 标签不变；不能用后续 episode 修补前一 episode 缺证；公开输出无秘密 |

### 定向验证命令

```sh
pnpm install --frozen-lockfile
pnpm -r --filter 'flywheel-teamlead^...' build
pnpm --filter flywheel-core exec vitest run src/__tests__/codex-recovery-failure.test.ts
pnpm --filter flywheel-claude-runner exec vitest run test/CodexTmuxAdapter.test.ts test/codex-daemon-adapter-helpers.test.ts test/codex-daemon-runtime.test.ts test/codex-daemon-goal-runtime.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/StateStore.codex-recovery.test.ts src/bridge/__tests__/execution-mutation-lease.test.ts src/bridge/__tests__/codex-session-reown.test.ts src/bridge/__tests__/codex-session-reown-wiring.structure.test.ts src/bridge/__tests__/codex-recovery-context.test.ts src/bridge/__tests__/run-infra-codex-recovery.test.ts src/__tests__/HeartbeatService.zombie-reconcile.test.ts src/__tests__/HeartbeatService.test.ts src/__tests__/crash-reaper.test.ts
node --test scripts/__tests__/qa-fly-2456-observe.test.mjs scripts/__tests__/qa-fly-2456-report-pair.test.mjs scripts/__tests__/qa-fly-2456-verdict.test.mjs
pnpm --filter flywheel-core typecheck
pnpm --filter flywheel-claude-runner typecheck
pnpm --filter flywheel-teamlead typecheck
```

以上是实现期验收命令；当前设计期实际运行另记 validation.md。不跑 root pnpm test，不触达 tmux-viewer.macos.test.ts。

## 8. 真机复现与修复闭环

后续 QA 使用现有 FLY-2456 工具/host-runbook，在其隔离和授权前置检查通过后运行；本节点不占用真实 slot。保留测试 SHA、run/execution/thread、episode/新序号、前后 StateStore events、CommDB TURN、清洗后的诊断/归档 hash；拆房前确认这些证据已入 issue doc，不能重演 R2 的日志丢失。

场景至少：有 rework 历史的 parked holder、普通 running/gate holder、非 holder 阴性对照；注入明确 socket readiness 后移除条件，应在原 execution/thread 接管成功且 charged budget 无增量；跨一次 Bridge restart 不延长窗口；两次永久/未知错误和 readiness到界都明确失败并通知 Lead；无 replacement 时如实标 failed_exhausted_no_replacement。

若自然复现再次报 launch_snapshot_mismatch，使用新增 mismatchFields 找到具体生产/消费差异，再写 `root-cause.md`，提交增量设计评审后修复被证明的原因；禁止删除 digest/roots/phase/权限校验以换绿。仅诊断+分类单测通过仍不能宣告“重启后原体恢复完成”；最终 issue 验收必须包括上述同体真实行为或明确保留未完成项。

## 9. 设计交付

本目录所有过程文档/源图/SVG/最终 HTML commit+push；运行正式 gate review_design→request-review→check，按有效 reviewVerdict 循环。APPROVED 后发布 HTML 并校验 hosted nonce/CSP/评论层，再 `ask --report DESIGN-HTML ready`。更新 progress，`complete --route phase_design_complete` 后 park；不派 implement/QA、不合并、不部署、不等 founder 页面反馈。

## 10. Follow-ups（Lead 要求留档，不在本轮修复）

Lead instruction eebc5b21-1d74-4600-a2f9-109cc6455249：本轮只修 R1 的 HIGH 与四项 MEDIUM；下列 LOW advisory 留档、不修、不开新单。最多进行到 R3，若 R3 再打回，不开 R4，向 Lead 原文报告 findings。评审在跑期间不推新提交。

| findingKey | 已知局限与留档处置 |
|---|---|
| alert-disposition-union-not-extended | 计划尚未补全 WorkflowEngineAlertPayload.metadata.workflowEngine.disposition 闭合联合的新值；已知为实现接缝类型清单缺项，本轮不扩张修订 |
| settle-signature-missing-alert-identity | §3.2 的示意形参表与 §3.4 要求的 WorkflowEngineAlertIdentity 尚未统一为 input 对象；作为接口草图缺项留档，本轮不新增形参对象设计 |
| observe-attempt2-proof-reads-workflow-attempt | legacy attempt2PreparedProof 已知误读 workflow activation attempt；本轮不修历史分类算法或原始存档。v1 分支仍按本计划读取 reservationSeq/chargedAttempts。legacy回归标签不能当成恢复次数真实正确性的证据 |

这些记录不是 active review-ruling；本轮是否通过仍以新 gate 的有效 reviewVerdict 为准。

### R2 非阻塞建议（仅留档）

R2 effective APPROVED；按 Lead 指令不在本节点修复以下建议，不开新单、不再启动 R3。批准内容位于 9e184e8fd，本次只追加回执/建议记录。

- pending-window-not-cleared-on-abort（MEDIUM）：新增的 pending_reservation_until_ms 清除者清单漏了 fence abort，配合 §4 含糊的「claim_token 未被替换」可能给已放弃的 reservation 最多 300s 通用判死豁免
- alert-payload-has-no-episodeid-field（LOW）：§3.4 的 R1 复用校验要求比对「已存 metadata 的 executionId/episodeId」，但 WorkflowEngineAlertPayload 根本没有 episodeId 字段
- stale-observation-event-id-unspecified（LOW）：§3.2.5 新增的「非账务观察事件」没有规定事件 id，与同节其他事件的固定幂等 id 约定不一致

### Code review R1 follow-ups（仅追加留档，不修改设计基线）

Lead instruction 1c24bd8e-3df0-4880-843a-a164ccdaa13b 要求下列建议只归档，不独立扩展本轮修复。

- reown-pass-aborts-on-poison-row（MEDIUM）：runPassOwned has no per-candidate isolation while the new StateStore paths add several DB-state-driven throws。
- dispatch-retire-failure-semantics-change（LOW）：runWithOwnership now converts a credential-retire failure into a soft failed result for the dispatch lane。
- lock-retention-warning-removed（LOW）：cleanupAndThrow no longer logs that it is holding the lock and leaving a possibly-live daemon's socket。
- adapter-isRecoveryCommitted-unused（LOW）：CodexRecoveryCommitHooks.isRecoveryCommitted is declared and threaded through but never read by the adapter。
- exhaustion-event-typed-as-revive-failed（LOW）：The reown_exhausted:v1 event is inserted with event_type='reown_revive_failed'。
- corrupt-clock-burns-charged-attempt（LOW）：A backwards wall-clock adjustment during a readiness cooldown consumes a charged attempt and wipes readiness accounting。

其中 adapter-isRecoveryCommitted-unused 所指读取接缝用于必修 resultText 提交边界，随该修复自然接通；未扩展其它建议的行为。

### R2 LOW follow-up（仅留档）

Lead instruction 7eca0f29-6ed8-4d9f-b633-be04c3c82654：finalize-exhaustion-write-txn-per-candidate（LOW）暂不做每候选写事务优化；R2 五条 MEDIUM 转必修，按 28b43e75 裁定保持原子性。此处只追加治理回执，不改已批准设计基线。
