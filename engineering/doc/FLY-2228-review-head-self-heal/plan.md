# FLY-2228 评审头移动自愈 — 实施计划
Issue: FLY-2228 (https://linear.app/geoforge3d/issue/FLY-2228/审查自愈-review-job-因-head-moved-报废后自动在新头重排不再需要-lead-手工救报废通知发给-lead-而不是吓)
日期: 2026-08-31
基于: research.md

## 目标

当 code review job 因可信 HEAD 在审查期间移动而报废时，Bridge 自动、durable 地以当前头铸新 requestId，复用原 questionId 重排 reviewer；最多自动重排 2 次。原 runner 继续轮询同一 gate 并直接收到最终判决。每个非 benign `review_job_failed` 事件只进 owning Lead inbox，founder issue thread 零告警；FLY-2194 的 benign revision supersede 继续静默。

## 不变量

- 旧 frozen HEAD 上的 verdict 永不产生 authority 或 gate response。
- requestId 继续代表不可变完整 binding；新头必须新 requestId。
- `head_moved` parent row 保留 failed 审计，successor 是独立 row。
- 只有服务端派生的 current HEAD 可成为 successor frozen HEAD。
- successor 与 parent 同 execution、question、review type、target repo；code-only。
- 每条 parent 只有一个自动 child；整条链最多两个 child，Bridge 重启不重置预算。
- alert routing 不能把 mailbox 故障变成静默丢失；fallback 可进 durable infra ticket，但不得回 founder thread。
- 不更改 FLY-2177 quota same-request retry、不更改 review verdict policy、founder approval 或 ship gate。

## 测试 seam

验收已锁定两个公开 seam：

1. `ReviewRequestCoordinator.accept()` → durable `codex_review_job` → 原 CommDB question response；
2. `buildInfraAlertRouting()` → owning Lead inbox sink / founder-thread fetch / durable fallback sink。

StateStore transaction 另用公开 store 方法测试原子性、幂等与 file-backed reopen。测试不调用 coordinator 私有 helper，不断言随机 UUID 的字面值，只断言新旧不同与 lineage/binding。

## Slice 1 — durable head-move successor（StateStore）

### RED 1A

在 `packages/teamlead/src/__tests__/StateStore.codex-review.test.ts` 写测试：

- 插入并 claim 一个 code job；
- 调拟新增的 `failAndRequeueCodexReviewJobForHeadMove`；
- 期望 parent=`failed/head_moved`，child requestId 不同，复制 authority binding，`round=parent+1`、`frozen_head_sha=current`、parent pointer 正确、retry count=1；
- 对同一 parent 重放方法只返回同一个 child，不增加 failure generation、不产生第二行；
- 由 retry=2 的 parent 再调用返回 exhausted 且无 child。

先运行该单文件并确认因 API/字段不存在 RED。

### GREEN 1A

修改 `packages/teamlead/src/StateStore.ts`：

- `CodexReviewJob` 增 `head_move_parent_request_id?`、`head_move_retry_count`；
- fresh schema 与缺列 migration 添加两列；建立 `head_move_parent_request_id IS NOT NULL` 的 unique partial index；
- row mapper 与 `insertCodexReviewJob` 覆盖字段（runner 入口不给 parent 字段，只有内部 transaction 可写）；
- 新增窄事务方法，`BEGIN IMMEDIATE` 内 CAS parent + insert successor，异常 rollback；save 只在 commit 后；上限常量=2。

跑聚焦 spec 到 GREEN。

### RED/GREEN 1B — migration + restart

在同 spec 增 file-backed legacy DB 测试：去掉/缺少新增列的已有 `codex_review_job` 经新 StateStore reopen 后默认 0/null；插 successor 后 close/reopen，lineage 与预算仍在。证明 additive rollback compatibility（旧字段与既有 API 不变）及新版本重启恢复输入完整。

提交小批次：`test/fix(review): persist bounded head-move successors`。

## Slice 2 — coordinator 自动重排并回答原 gate

### RED 2A — 一次移动的主验收

在 `packages/teamlead/src/bridge/__tests__/review-request-coordinator.test.ts` 把现有“head moved → failed/no response”场景升级为 deferred 双轮行为：

1. `accept(r1,q1)` 后 reviewer 仍运行；
2. 推进 harness HEAD，旧 reviewer返回 APPROVED；
3. 断言 r1 failed，同时自动出现 child r2（字面 UUID 不固定），冻结新头并启动第二轮；
4. 第二轮返回当前头 APPROVED；
5. 原 `q1` 得到 APPROVED，authority 绑定新头；
6. 只有一个 `review_job_failed` structured event，message 指出已自动重排的 successor。

当前实现会停在 r1 failed/no response，确认 RED。

### GREEN 2A

修改 `packages/teamlead/src/bridge/review-request-coordinator.ts`：

- 新增统一 `handleHeadMoved(job,currentHead?)`；只接受可信 40-char current HEAD；生成 server UUID，调用 StateStore 原子方法；
- requeued 时 emit parent failure event并把 child 接到现有 per-execution chain；exhausted 时 emit 明确预算耗尽 recovery；无 current 时保留普通 fail-close；
- 将 verdict-time、lost-session fallback、scheduled retry 三个现有 `head_moved` 分支全部改走该 helper，避免只修一个写点；
- `reviewFailureRecovery` 能区分 successor 已排与预算耗尽，不再告诉 Lead 手工 POST；
- 不改最终 `respond`、outbox、authority 顺序。

运行 coordinator spec 到 GREEN。

### RED/GREEN 2B — 快速 preflight 与预算负例

逐条 vertical slice：

- child 入库后、spawn 前 HEAD 再移动 → reviewer 不被调用，直接生成下一个 child；
- 连续第三次移动 → job 总数固定 3（root+2 child），原 gate无错误 authority，Lead event写 exhausted；
- HEAD derive 返回失败 → 零 child；
- design job、answered/superseded gate → 零 child；
- quota scheduled retry到点时 HEAD moved → 生成新 request而非同 request复活；
- boot redrive pending child → 最终回答原 q1，retry count保持。

为此在 `runJob()` gate/session/worktree确认后、reviewer spawn前增加 code HEAD recheck。每条先见 RED 再写最小实现。

提交小批次：`fix(review): requeue moved-head reviews on the current head`。

## Slice 3 — 通知反转到 owning Lead inbox

### RED 3A — route 分类

修改 `packages/teamlead/src/bridge/__tests__/infra-event-router.test.ts` 与 `infra-alert-wiring.test.ts`：

- session 有真实 bound issue thread；
- 发 `review_job_failed`；
- 期望 founder Discord fetch=0、raw sink=0、fixed infra ticket=0、`leadInboxSink` 恰收一次原 payload；
- sink failure 时 founder fetch仍为0，durable ticket fallback恰一次；
- union sweep 把 `review_job_failed` 归入新 `LEAD_INBOX_KINDS`，三类集合互斥；其他 progress/ticket/escalation行为不变。

当前会调用 founder thread fetch，确认 RED。

### GREEN 3A

修改：

- `packages/teamlead/src/bridge/infra-event-router.ts`：新增 `lead_inbox` route、`LEAD_INBOX_KINDS` 与 `leadInboxSink`；此类不解析 thread，异常只 fallback ticket；
- `packages/teamlead/src/bridge/infra-alert-wiring.ts`：透传 sink，ticket enrichment 跳过 lead-inbox 类；
- `packages/teamlead/src/bridge/plugin.ts`：生产 sink 调 `leadInboxRuntime.enqueueInfraAlert(payload.leadId,payload)`；
- `review_job_failed` 从 `ISSUE_PROGRESS_KINDS` 移出。

运行 router/wiring spec 到 GREEN。

### RED/GREEN 3B — owner contract

在 `kind-contract.test.ts`、`ticket-owner-map.test.ts` 先断言：

- contract owner=`owning_lead`；
- owner resolver带 affected lead id 时返回 `{kind:"lead",leadId}`；
- 全 union contract↔owner sweep覆盖新 case；无 lead id时 fail-safe `none`，不能误分给 infra bot。

再最小修改 `kind-contract.ts` 与 `ticket-owner-map.ts`。`arc` 保持 `human_by_design`（机器只修 head move；其他真实 reviewer failure仍由 Lead处理）。

### RED/GREEN 3C — emitter 集成

`review-governance-effects.test.ts` 证明 payload里的 `leadId` 来自 session labels对应的 owning Lead，并通过 route进入该 Lead sink；raw reviewer evidence仍不进 body。保留 FLY-2194 coordinator测试：`superseded_by_revision` 零 structured event，保证 benign 不产生 mailbox噪音。

提交小批次：`fix(review): send review failures to the owning Lead inbox`。

## Refactor / 审计

仅在全部 slice 绿后：

- 去重 head-move分支与 route集合判断；
- `rg '\[DEBUG-'` 确认无临时 instrumentation；
- `git diff --check`；
- 审计新增字段所有读写点、三个原 head_moved写点、plugin生产 sink接线；
- 明确不删除仍可达的旧代码；若发现新 dead code只记录，不擅自扩大清理。

## 聚焦与全仓验证

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/StateStore.codex-review.test.ts
pnpm --filter flywheel-teamlead exec vitest run \
  src/bridge/__tests__/review-request-coordinator.test.ts \
  src/bridge/__tests__/infra-event-router.test.ts \
  src/bridge/__tests__/infra-alert-wiring.test.ts \
  src/bridge/__tests__/review-governance-effects.test.ts \
  src/bridge/__tests__/kind-contract.test.ts \
  src/bridge/__tests__/ticket-owner-map.test.ts
pnpm --filter flywheel-teamlead typecheck
pnpm --filter flywheel-teamlead build
pnpm --filter flywheel-teamlead test:run
pnpm lint
pnpm -r build
pnpm test:packages:run
for t in scripts/__tests__/*.test.sh; do bash "$t"; done
git diff origin/main...HEAD --check
```

其中 shell tests 按“每个新 `scripts/__tests__/*.test.sh`”要求全跑；本单预计不新增 shell test。任何基线失败需保留原始命令、失败测试名与隔离复跑证据，不把未运行报成通过。

## Review 与交付

1. 所有实现/docs commit并 push当前分支；立刻查 Lead inbox。
2. `stage set code_review`，开全新 `review_code` gate并 `request-review --type code`；等待 structured `reviewVerdict`。
3. `CHANGES_REQUESTED`：只修 blocking finding，写回测试，push新头，开新 gate/request；`APPROVED` advisories按 contract报告 Lead。
4. code review通过且 exact head验证完成后，创建 `engineering/doc/milestones/FLY-2228.md` 作为 literal last commit；之后不再推进 HEAD。
5. push，创建 PR，报告 Lead；不得 dispatch QA、merge或ship。
6. `complete --route needs_review --pr <NUMBER>` 结束 implement phase。
