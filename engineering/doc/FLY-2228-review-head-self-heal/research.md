# FLY-2228 评审头移动自愈 — 调研
Issue: FLY-2228 (https://linear.app/geoforge3d/issue/FLY-2228/审查自愈-review-job-因-head-moved-报废后自动在新头重排不再需要-lead-手工救报废通知发给-lead-而不是吓)
日期: 2026-08-31
基于: exploration.md

## 1. 当前故障的精确写路径

`ReviewRequestCoordinator.accept()` 按以下顺序建立 code review：

1. 从 StateStore 取 session 与 immutable worktree binding；
2. 验证 payload、target repo 与 open `review_code` gate；
3. 服务端 `rev-parse HEAD` 得到 `frozen_head_sha`；
4. 以 runner 提供的 `requestId` 插入 `codex_review_job`；
5. `enqueue()` 在同 execution 串行调用 `runJob()`；
6. reviewer 返回后，再次派生 current HEAD；current != frozen 时 `failReviewJob(requestId, "head_moved")`，不回答 gate。

fail-close 本身正确。缺陷是最后一步没有机器恢复边：`head_moved` 明明同时携带旧 frozen 与可信 current，却只产生 terminal failed row。FLY-2177 的 `retry_at/auto_retry_count` 只能重跑同一 durable request，不能用于这里，因为同一 request 的冻结头不可改变。

## 2. successor 必须是新 durable request

### 2.1 不能修改旧行

把旧 job 的 `frozen_head_sha` 原地改成新头会抹掉失败证据，也会让 requestId 的幂等语义从“同一完整 binding”退化为“随时间漂移的槽位”。这会破坏 review authority 审计，因此排除。

### 2.2 不能只靠内存 enqueue

只生成内存任务而不先写 StateStore，Bridge 在失败与 enqueue 之间崩溃后仍会留下无人恢复的旧 failed row。成功标准要求 restart/replay 后仍收敛，所以 successor 必须先 durable，再进入现有 per-execution chain。

### 2.3 选定的持久字段

在 `codex_review_job` 添加两个 additive 列：

- `head_move_parent_request_id TEXT`：仅自动 successor 使用，指向直接父 job；建 partial unique index，保证一个父 job 最多铸一个 successor。
- `head_move_retry_count INTEGER NOT NULL DEFAULT 0`：根请求为 0，successor = parent + 1；上限固定 2。

两个字段同时解决：

- 新 requestId 每次变化仍能继承同一自动链预算；
- boot redrive 可从 pending successor 继续，不靠内存计数；
- 重复进入同一 head-move 收口时可查到既有 child，避免双排；
- 旧 row 仍保持 `failed / head_moved`，child 单独冻结新 HEAD。

schema 是 additive，旧二进制回滚时会忽略新增列；新二进制启动旧 DB 时通过现有 `PRAGMA table_info` 缺列迁移补齐。测试要覆盖旧表 reopen 与新字段默认值，证明升级/回滚兼容面。

## 3. 原子失败 + 重排

StateStore 新增一个窄事务方法，输入 parent requestId、服务端生成的 successor requestId 与可信 current HEAD；在一个 `BEGIN IMMEDIATE` 中：

1. 重新读取 parent；
2. 若已有 `head_move_parent_request_id=parent` 的 child，返回既有 child（幂等）；
3. 将 parent CAS 为 `failed / head_moved`，递增一次 failure generation；
4. 若 `head_move_retry_count < 2`，插入 child：复制 execution/issue/project/type/question/target repo，`round+1`、冻结 current HEAD、继承 reviewer session UUID，retry count +1；
5. commit 后统一 `save()`。

若预算已耗尽，只执行第 3 步并返回 exhausted；若 current HEAD 不可派生或 frozen 缺失，不铸 child，保留普通 fail-close。coordinator 在事务成功后才 emit 旧 job failure event；child 再通过既有 `enqueue()` 执行。

HEAD 还可能在 successor 入库与 reviewer 启动之间移动。为避免为已过期头消耗整轮 reviewer，`runJob()` 在 reviewer spawn 前对 code job增加一次 HEAD preflight；漂移时复用同一原子 helper 直接失败并重排。reviewer 返回后的现有 recheck 继续保留，形成 spawn 前后双重保护。

## 4. runner 无感的条件

successor 复用原 `questionId`，因为 `head_moved` 分支没有写 response，gate 仍 open。最终成功 child 沿用既有：

- `insertReviewResponseIfGateOpen` 原子占有 gate；
- `delivery_nonce` 防 runner 伪造 Bridge response；
- outbox 先落 terminal verdict，再回答 gate；
- `markGateAnswered` 唤醒 resident goal；
- APPROVED 时只为 child 的新 frozen HEAD 写 authority。

因此 runner 始终轮询最初 question，不需要知道 successor requestId。若连续移动超过两次，本单保持最新 job failed 且 Lead 收到明确“自动预算耗尽”的 mailbox 事件；可选的 `check` terminal payload 暂不扩展，因为它需要给 failed job另建 durable response outbox，不能用一次性 best-effort 回答冒充可靠修复。

## 5. 通知为什么走错

`createReviewAlertEmitter()` 已从 session labels 解析 owning Lead，并生成：

```text
leadId=<owning Lead>
eventType=review_job_failed
sessionKey=<execution>
```

错误发生在下一层：`review_job_failed ∈ ISSUE_PROGRESS_KINDS`，`createInfraAlertSink()` 只要解析到 bound thread 就调用 `founder-thread-notifier`。没有 thread 时才退到固定 `claude-infra-bot-lead` mailbox，所以 owning Lead 两种情况下都不是稳定收件人。

## 6. 选定的投递结构

给 alert router 增加第三种明确 route：`lead_inbox`。

- `LEAD_INBOX_KINDS = { review_job_failed }`；它与 `TICKET_KINDS`、`ISSUE_PROGRESS_KINDS` 互斥。
- `classifyInfraEvent(review_job_failed, thread)` 恒为 `lead_inbox`，完全不查/写 founder thread。
- router deps 增 `leadInboxSink`；生产 wiring 调 `leadInboxRuntime.enqueueInfraAlert(payload.leadId, payload)`，收件人正是 emitter 已解析的 owning Lead。
- sink 抛错时 fail-safe 到既有 durable infra ticket sink并记录日志，不静默丢失。
- `KindOwner` 增 `owning_lead`，`KIND_CONTRACTS.review_job_failed` 改为该 owner；owner-map 接受 affected lead id 并返回 `{kind:"lead", leadId}`，防 contract 与 route 再次漂移。
- benign `superseded_by_revision` 仍在 coordinator 内 emit 前 return，所以不会进入任何 sink。

这比在 `createReviewAlertEmitter()` 内绕过 router 更好：分类、kill switch、fallback 与全 union sweep 仍只有一个入口；也比把事件改成普通 ticket 更准确，因为普通 ticket 的生产收件人固定是 infra bot，不是 issue owner。

## 7. 可执行验证矩阵

| 场景 | 预期证据 |
|---|---|
| 一次 head move | old job=`failed/head_moved`；child requestId 不同、parent 指针正确、retry=1、frozen=current；child APPROVED 后原 question 有 response |
| 连续两次 head move | 两个 successor，retry=1/2；第三个 reviewer 可在稳定头完成 |
| 第三次 head move | 不生成第四个 job；最新失败事件 recovery 明确 exhausted |
| Bridge 在 child 入库后重启 | pending/running child 由 `redriveOnBoot()` 重排；budget 不归零；原 question 最终被回答 |
| current HEAD 无法派生 | 无 child；普通 failed + owning Lead event；无伪造 HEAD |
| gate 已 supersede/answered | 既有 gate 分类优先，零 head successor |
| benign revision supersede | 零 `review_job_failed` event |
| review failure + bound founder thread | Discord fetch=0；owning Lead inbox sink=1；raw/fixed infra ticket=0 |
| owning Lead inbox sink 抛错 | founder thread=0；durable ticket fallback=1 |
| 其他 issue-progress kind | 仍按原行为走 bound issue thread |

聚焦反馈环命令：

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/bridge/__tests__/review-request-coordinator.test.ts \
  src/bridge/__tests__/infra-event-router.test.ts \
  src/bridge/__tests__/infra-alert-wiring.test.ts \
  src/bridge/__tests__/kind-contract.test.ts \
  src/bridge/__tests__/ticket-owner-map.test.ts
```

先写一次 head-move end-to-end coordinator test 与 owning Lead route integration test并确认 RED，再逐 slice 变绿；StateStore migration/restart与预算负例随后各自 red-green。
