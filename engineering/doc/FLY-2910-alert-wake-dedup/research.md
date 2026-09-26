# FLY-2910 告警叫醒去重 — 调研
Issue: FLY-2910 (https://linear.app/geoforge3d/issue/FLY-2910/token3-告警去重同一-lead-6-小时内同一标题的告警只累加计数不再叫醒状况升级照常叫醒info-级只进摘要)
日期: 2026-09-25
基于: exploration.md

## 1. 卡口选择：为什么放在 `LeadInboxLoop` 的 revalidate 钩子

`LeadInboxLoop.tick`（`packages/teamlead/src/bridge/lead-inbox-loop.ts:333-399`）的流程是：领一个批次，对每一行调用 `revalidateModel(row)`（在 `lead-inbox-runtime.ts:514` 接线，目前是 `QuestionAdmission.revalidate`）。每行的判定结果有三种：
- `{deliver:true}`：照投；
- `{deliver:false, disposition, retry?}`：退回重试或标记死信；
- `{deliver:false, disposition:"audit_only", auditDecision}`：`MailboxQueue.releaseClaimForAudit`（`packages/flywheel-comm/src/mailbox-queue.ts:1144`）把行改成 audit_only，并写一条 `mailbox_log`。

批次里所有行都没投时，这次就不叫醒 Lead。

放在这里的理由：
1. **两种载体都经过这里。** A 类 `[infra_alert]` 信，以及 B 类 dispatcher 在 Discord 发的帖（不论出自 Bridge、`lead-alert.sh` 还是队列重放）都写进同一个 per-project 的 mailbox。生产端没有同样的单点：B 类至少分散在 `LeadAlertNotifier.alert`、`lead-alert.sh` 和队列 drain 三处。
2. **只动 Lead 的叫醒，不动告警本身。** Discord 帖、工单线程、`alert_mailbox_ledger` 的 `fire_count`、founder 的 @ 全部照旧。founder 看到的不变，「只累加计数、记账」天然成立。
3. **偏向安全。** 钩子只对 `retry_count=0` 的新批次调用（`:352-363`），重投永远照投；判定抛错会走现有的 tick 失败路径，然后重试。
4. **有现成的审计列。** FLY-2749 的 `delivery_disposition` 和 `notification_policy_version/reason/proof_ref/decided_at`（`mailbox-schema.ts:228-233`）可以直接复用，每次合并都能逐条查到。

## 2. 生产者与标题形状（去重键的依据）

所有 Bridge 生产者都构造 `AlertPayload`（`packages/teamlead/src/LeadAlertNotifier.ts:608`），字段有 `title`、`body`、`severity: "info"|"warning"|"severe"`（`:432`）、`eventType`、`sessionKey?`。A 类信由 `formatInfraAlertMailboxContent`（`bridge/infra-alert-mailbox.ts:5-16`）渲染，B 类帖由 `LeadAlertNotifier.formatContent`（`:2092-2123`）或 `lead-alert.sh:1346-1370` 渲染。

有代表性的生产者（完整清单来自子代理盘点，共约 60 处）：

| 生产者 | kind | 标题模板 | 级别 | 标题里的变量 |
|---|---|---|---|---|
| `review-request-coordinator.ts:1982` → `review-governance-effects.ts:29-61` | review_job_failed / review_advisory_pass / review_ruling_* | `Cross-family review job failed` / `Review passed with non-blocking advisories` 等 | failed/disputed/notify_failed 为 warning，其余为 info | 无（对象在 `session=` 与正文 Review id） |
| `fleet-sensors.ts:691` | zombie_session_backlog | `跨 Lead 僵尸 session 积压（${n} 个）` | warning | 数量 |
| `plugin.ts:12743` | cmux_watcher_stalled | `cmux watcher unhealthy (${branch})` | severe | 分支名（固定词表） |
| `StateStore.ts:60006` 等约 40 处 workflow outbox | workflow_engine_escalation | `${issueId} delivery contract stalled`、`Workflow land cleanup needs attention for ${id}`、`Rework retry budget exhausted for ${id}` | warning/severe | issue id |
| `workflow-engine-dispatcher.ts:463` | workflow_engine_escalation | `Runner admission pause has remained active for ${n} minutes` | severe | 数量（分钟） |
| `server-loss.ts:525` | tmux_server_lost | `tmux server 丢失 — ${n} 个 runner 阵亡` | severe | 数量 |
| `flag-retirement-production.ts:604` | flag_scan_handoff | `Weekly flag scan is ready for founder questions` | **info，但带待办** | 无 |
| `codex-quota/outbox.ts:292/405`、`account-heal/*` | quota_switch_confirmation、codex_quota_automation_disabled 等 | 额度 / 切号通知 | info | 无 |

没有标题带时间戳、exec id 或 PR 号。

## 3. 字段来源（两种载体各从哪里取）

| 字段 | A 类 `[infra_alert]` 信 | B 类 dispatcher 帖 |
|---|---|---|
| 认定 | `source_kind='infra_alert'` 且正文以 `[infra_alert] ` 开头（排除同 source_kind 的 `[alert_handoff]`） | `type='discord_chat'` 且信封 `authorId` = 运行时 `alertDutyDispatcherBotUserId`；解析不到 id 时不认 |
| kind | 末行 `event=` | 首行 `(<lead> / <kind>)` |
| 标题 | 首行去掉前缀 | 首行 `**…**` 之间 |
| 级别 | 末行 `severity=` | 首行 emoji：🚨 为 severe，⚠️ 为 warning，ℹ️ 为 info |
| 对象 | 末行 `session=`；缺省时依次取标题里的 issue id、正文里的 issue id、正文第一个 UUID | 标题里的 issue id → 正文 issue id → 正文第一个 UUID |
| 动作签名 | 正文各行规范化后取集合，再做哈希 | 同左（去掉 `🎫` 工单头一行） |
| 数量指标 | 规范化前的标题里，去掉 issue id / UUID / hex 之后的第一个整数 | 同左 |

解析失败（格式对不上）时一律不认：照常叫醒，并记一条计数日志。

## 4. 复用 FLY-2749 audit_only 的缺口

`releaseClaimForAudit` 把行改回 QUEUED、audit_only，并把 `next_retry_at` 设成 9999 年。对 question 行，后续由 `markQuestionTerminalDisposed`（`packages/flywheel-comm/src/db.ts:2596`）改成 ACKED。告警信没有后续结算：直接复用的话，行会永远停在 QUEUED，归档用的 `mailbox_archive_acked` 索引（按 `acked_at`）永远扫不到它。

现网实测：audit_only 行目前 267 条 ACKED（question）、9 条 QUEUED。

所以需要新增一个带 fence 的 `MailboxQueue.settleClaimAsAudit`：校验条件与 `releaseClaimForAudit` 完全相同，但把行直接结算为 `state='ACKED'`，设置 `acked_at=decidedAt`、`resolved_via='alert_wake_dedup'`、audit_only 和四个 notification 列，并写 `mailbox_log`。这样行会按现有的 ACKED 保留期正常归档。

这里的 ACKED 表示「机器结算、无需模型消费」，与 FLY-2749 对 question 的 terminal-disposed 语义一致。它**不是** Lead 的回执。

## 5. 窗口状态放哪里

对比两种做法：
- **从 mailbox 行实时推导**：每次判定都要扫该 Lead 近 6 小时的所有行，重新解析 Discord 信封。现有索引不覆盖 `(to_agent, created_at)`；ACKED 行被归档的时机也不受本功能控制。脆弱。
- **新表 `alert_wake_windows`（teamlead.db，推荐）**：每个 `(lead_id, dedup_key)` 一行，保存窗口锚点（最近一次叫醒的时间和 delivery_id）、已通知的最高级别、数量指标、对象集合、动作签名集合、出现次数、合并次数、摘要待报数。

这张表是派生缓存：每封合并信在 mailbox 里都有 audit 行作为权威记录。表丢失或读取失败时按「没有窗口」处理，照常叫醒，是安全方向。行数有上界（约 67 种标题 × 几个 Lead），留存分类按 `protectedCurrentOrReference` 登记（`scripts/lib/fly-2006-retention-tables/teamlead/alert_wake_windows.json`）。

窗口锚点必须真的「已通知」：判定时回查锚点的 delivery_id。锚点行是 DEAD 或已不存在（没有投递成功的证据）时，视为未通知，照常叫醒，并重新立锚。这一条挡住「第一封投递失败，后面的重复全被合并」的吞待办路径。

## 6. 摘要通道

- 现有定时通道不普适：`patrol_tick`（`bridge/patrol-tick.ts`，默认 60 分钟）只发给有 roster 的 Lead，9-25 只有工程 Lead 收到；`summary_due` 是 FLY-2382 的进展汇总义务，与告警无关。claw 两个都收不到。
- 现有固定页：`GET /duty/alert-board` 和 `/duty/alert-tickets/outstanding`（`bridge/alert-duty-router.ts:269/332`）、CLI `flywheel-comm alert-ticket`，读 `alert_mailbox_ledger` 与 `alert_threads`，里面已经有 `fire_count`。
- 结论：「摘要」做成**搭车**：该 Lead 下一次因告警被叫醒时，在那封信的 `delivery_content` 前面加一段「上次叫醒以来未叫醒的告警」，最多 10 行，每行 `标题 ×次数（info / 重复）`，超出部分指向固定页。「固定页」在 `/duty/alert-board` 的 JSON 里加一个 `wakeDedup` 小节，列出近 24 小时的窗口与合并数。不新建 timer 或 daemon。
- 取舍：Lead 如果长时间没有被告警叫醒，摘要会一直挂着；但那段时间也就没有需要它处理的告警。全量随时可以从固定页和 mailbox audit 行查。

## 7. 开关

照抄 `lead_token_savings`（`packages/config/src/feature-flags/registry.ts:725-763`）的写法：

| 项 | 值 |
|---|---|
| name | `lead_alert_wake_dedup` |
| configKey | `lead.alert_wake_dedup_enabled` |
| source / scope | `project_config` / `project` |
| polarity / default | `default_on` / `true` |
| toggleable | `conversational` |

读取器 `storeLeadAlertWakeDedupEnabled(runtime, projectName)` 写在 `bridge/flag-store-runtime.ts`，读失败时返回 false，也就是照常逐条叫醒。登记项跟着改：
- `feature-flags-drift.test.ts` 的 readSite 元组；
- `feature-flags-registry.test.ts` 的 `EXPECTED_WHEN_ON`；
- store-policy 测试；
- `doc/engineer/implementation/flag-authoring-runbook.md` 中要求的项。

## 8. 前例教训

- FLY-1193 debounce：五轮 review 才收敛，教训是别为极窄的崩溃边缘加 durable outbox。本单的摘要按「至多一次」处理，并如实标注。
- FLY-2749：audit 行在分类之前，必须先保证原有业务副作用已经完成。本单只改变叫醒，告警的生命周期（工单、账本、Discord）在入队之前已全部完成。
- memory「给出不回也行的默认值时，承接它的机制也必须允许沉默」：发给 Lead 的两条口径问题都是非阻塞的，按推荐推进。
