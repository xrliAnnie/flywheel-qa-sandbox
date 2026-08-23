# FLY-2006 14 天全表保留窗清扫 — 调研
Issue: FLY-2006 (https://linear.app/geoforge3d/issue/FLY-2006/数据库清理二期-30-天保留窗全表清扫1995-结案解除保护按-1998-纪律清-session-events-等大头)
日期: 2026-08-23
基于: exploration.md

## 1. 权威输入与可复用资产

本调研以 production schema/reader、FLY-1998 已合入脚本与测试、FLY-1995 结案事实，以及
Founder 经 Tadashi 回传的最新 14 天裁定为权威。Issue 标题中的 30 天是历史输入，不再是实现常量。
Lead instruction `19dab58b-dd1e-489c-98f3-4d80da352214` 引用的 Linear comment
`df407e3e-66b8-4484-80f4-597a1f97c50e` 另行裁定一个精确、不可扩面的 age exception：
`comm.mailbox.from_agent='voice-honeylemon-fly1911' AND relay_state='terminal_disposed'`。
production sealed FLY-1998 manifest 的 42 个 `fly1995.mailbox.baselineIds` 与当前 exception id set 完全
相等。该 baseline 在一期 inventory 时仍 open；1995 结案后这些行已全部 terminal disposed，因此与
session-events cohort 一并解除保护。closed v1 evidence 的 reader 只验证固定 legacy script digest、
manifest/receipt seal 与 complete binding，不重新对 live DB 执行 `assertFly1995State`。

FLY-1998 已经实现并应保留的安全原语：

- canonical DB path、loopback health、0700 evidence dir 与 0600 evidence file；
- readonly inventory、statement hash、frozen ordered PK manifest；
- system `sqlite3 .mode insert` snapshot、scratch restore 与 sealed JSON/sidecar；
- script/schema/trigger/DB dev+inode binding；
- `BEGIN IMMEDIATE`、每批 CAS、no-delete trigger 同事务撤销/恢复、commit 后 batch receipt；
- partial resume、missing-without-receipt 拒绝、health samples、敏感 payload 不出 stdout。

一期脚本本来就是 14 天，但只允许 `workflow_run_event` 四个 narrative kind，且把
`session_events`、`sessions`、CommDB 整库硬编码为 forbidden。FLY-2006 保持 cutoff 常量，升级
manifest schema 与 target registry，不引入第二套平行 CLI。

FLY-1995 的 exact cohort 为：

```sql
event_type = 'issue_thread_infra_notify_skipped'
AND source = 'bridge.founder-thread-notifier'
AND ts >= '2026-08-01 22:00:00'
AND ts <  '2026-08-05 04:00:00'
```

共 2,638,046 行。它在当前 14 天 cutoff 下全部自然超龄，并且保护理由已随 FLY-1995 结案；实现
仍通过普通 `session_events` policy 命中它，不写 issue-id/cohort 特例。

## 2. SQLite 与 runtime 约束

| 项目 | teamlead.db | comm.db |
|---|---:|---:|
| business tables | 157 | 25 |
| main file | 约 1.59 GiB | 约 481 MiB |
| journal mode | WAL | WAL |
| auto_vacuum | 0 | 0 |
| quick_check | ok | ok |
| FK baseline | 7 个历史 orphan | 0 |

系统 SQLite 为 3.51.0。活 WAL 库不能裸 `cp`；隔离彩排使用 SQLite backup API。`auto_vacuum=0`
意味着物理瘦身必须显式 `VACUUM`。运行时 production connection 常用 `foreign_keys=0`，因此工具
需要冻结 `PRAGMA foreign_key_check` 的 canonical digest；只允许“不变”，不能要求历史基线为零。

active authority 直接复用 reader 的语义：

- `CMUX_LIVE_SESSION_STATUSES`：`pending|running|ship_parked|awaiting_review|design_done|approved_to_ship`；
- `workflow_run.status IN ('active','held')`；
- active/held run 的全部 `workflow_run_node.execution_id`，即使 node 自身已 done；
- `comm.sessions.status='running'`；
- 上述 execution/run 的 issue id，以及 normalized message/source relation。

JSON payload 只用 `json_valid` + `json_tree` 做 exact scalar membership，不用 substring `LIKE`。
apply 时 active set 允许增长；manifest candidate 只要变成 active 就停止。

## 3. 时间合同

- retention 常量：`14 * 24 * 60 * 60 * 1000`；manifest 字段名为 `cutoff14`；
- TEXT/DATETIME 通过 `julianday(column)`；integer 大于 `100000000000` 按毫秒，否则按秒；
- `NULL`、invalid、恰等 cutoff 全部不是 old；只有严格 `< cutoff14` 才进入 terminal/policy 判定；
- 唯一例外是上述 HL exact orphan predicate：它先进入 target-specific terminal/family 安全核验，不以
  age 决定候选；registry 不提供通用 `ignoreAge` 开关；
- mutable root 用最后活动/terminal time，不拿最早 `created_at` 代替；
- child 有 recent timestamp 时，包含它的 family/unit 整体保留，禁止留下孤儿或删掉最近 receipt。

## 4. Registry 分类

registry 是 compile-time allowlist，不根据表名或列名猜测。每项包含 database、table、logical key、
age expression、terminal/value predicate、active guard、delete order、trigger policy 和 snapshot
projection。当前 157+25 个名字逐字固化；实际 schema 多一个或少一个都拒绝 inventory。

### 4.1 本期 delete-target

TeamLead direct-history：

```text
alert_repair_attempts alert_threads chat_threads deployment_events
detection_escalations founder_page_ledger lead_event_delivery_attempts lead_events
legacy_cutover_quarantine legacy_render_fallback legacy_stock_suppressed
phase_chat_threads quiet_wake_notified roundtable_topic_threads session_events
ticket_escalations tmux_hold workflow_run_event
```

CommDB terminal-history：

```text
content_ref_gc_outbox mailbox mailbox_log receipt_alert_outbox
runner_phase_wakes runner_shutdown_controls
runner_wake_failure_episode
```

这些名字只是 table-level mutation surface；每张表仍须通过正向 row policy：

| family | 正向候选 |
|---|---|
| `session_events` | `ts < cutoff14`，事件值在 narrative allowlist，execution/issue 不 active |
| `lead_events` | `created_at < cutoff14`，事件值在 narrative/monitoring allowlist，已 delivered；ACK-exempt settled，或 ACK-required 已 acked/retired，或 dead-letter 且 ingress disposed；delivery attempt 随 parent |
| `workflow_run_event` | `at < cutoff14`、parent run terminal、kind 在 narrative allowlist、run/execution/issue 不 active；不删除 run/root/authority child |
| thread/alert/escalation | archived/resolved/cleared terminal time `< cutoff14`，issue/execution 不 active；attempt 随 parent |
| `mailbox` ordinary retention | family 全部 terminal 且 terminal time `< cutoff14`，无 checkpoint；`type` 不属于 `question|response|instruction|founder_reply`，`kind != 'report'`；通过 `archiveFamily` 四步事务归档，不裸 DELETE |
| `mailbox` HL exact orphan exception | 仅 `from_agent='voice-honeylemon-fly1911' AND relay_state='terminal_disposed'`；不受 age/type/kind 限制，但仍要求整 family terminal、无 lease/checkpoint/active relation，且走同一 `archiveFamily` 四步事务；若出现 content-ref 则沿用 GC intent 路径 |
| `mailbox_log` | old narrative `migrated_history|migration_snapshot`，或非 authority 的 settled `processed|disposed`；`row_json` 中的人类问答、Founder reply、review/ship/gate/ruling values 全部保护 |
| receipt/runner outbox | delivered/canceled/finished/expired/closed 且 terminal time `< cutoff14`；queued/leased/pending/started/open 一律保留 |

`session_events`、`lead_events`、`workflow_run_event` 和 `mailbox` 都是混合日志。registry 必须逐字列出
当前允许删除与明确保护的 enum；新 enum 进入 `oldProtectedUnknown`，不会因字符串模式而被删。

### 4.2 永久排除：审批、凭证、裁定与 authority

根据 Founder/Tadashi 的边界，以下 **TeamLead 表名明确不进入 delete target**：

```text
codex_review_job codex_review_record design_review_manifest review_finding_ruling
ship_approval_requests founder_deferred_approval founder_review_card_binding
founder_decision_convergence founder_action_ledger disposition_receipts
issue_disposition_intents stuck_dispositions land_cool_adjudication_receipt
land_cool_attempt workflow_claims workflow_claim_revocation
workflow_decision_capability workflow_gate_holder workflow_gate_holder_evidence
workflow_gate_holder_carryover_evidence workflow_gate_carrier_rebind_receipt
workflow_head_carryover_receipt workflow_carryover_pr_binding
workflow_submission_credential workflow_output_credential
workflow_ship_target_binding workflow_source_event workflow_source_receipt
workflow_start_reservation workflow_start_response workflow_start_stage
workflow_turn_divergence_episode turn_source_history receipt_root_lineage
session_receipt_lineage delivery_secret_state
```

以下 workflow/root/current-state 表也按 authority/reference 保护，不随历史日志删除：

```text
sessions workflow_run workflow_run_node workflow_actor workflow_activation_turn
workflow_carrier_delivery workflow_carryover_activation workflow_declared_pr
workflow_engine_park workflow_engine_park_cursor workflow_execution_binding
workflow_execution_runtime workflow_launch_cancellation workflow_launch_owner
workflow_materialization_receipt workflow_node_completion workflow_node_output_current
workflow_node_outputs workflow_node_pr_binding workflow_operator_close_intent
workflow_pr_finalization workflow_pr_manifest workflow_resume_admission
workflow_resume_attachment workflow_resume_attachment_state workflow_resume_probe
workflow_resume_response workflow_rework_delivery workflow_rework_request
workflow_rework_route_revision workflow_rework_verification_path workflow_route_decision
workflow_run_collect_alias workflow_run_collect_receipt workflow_side_effect_ledger
workflow_source_cursor workflow_source_deadletter workflow_template
workflow_template_audit workflow_template_publication workflow_template_revision
workflow_wake_send_claim
```

CommDB 中以下表也明确排除。`mailbox_identity` 即使 `archived_at` 非空仍参与
`mailbox-queue.ts` 的重复投递判断，而且 schema 的 no-delete trigger 明写 permanent，因此不允许
cleanup 工具撤销该 trigger：

```text
lead_inbox_fenced_root lead_inbox_freeze_install lead_inbox_sanitation_audit
loop_heartbeat loop_owner mailbox_identity mailbox_migration_meta
runner_declared_states session_receipt_lineage sessions
three_stage_turn turn_source_history turn_wait_ledger turn_wake_outbox
workflow_engine_park workflow_engine_park_cursor workflow_source_event
```

这份名单是 mutation exclusion，不代表不 inventory；所有表仍记录 count/schema/classification。

### 4.3 混合日志中的 protected values

即使位于 delete-target 表，以下当前已知 authority values 也必须明确保护：

- `session_events`：`founder_ack_*`、`founder_ship_attribution`、`ship_gate_msg_binding`、
  `codex_review_result`、`stuck_disposition_set`、`workflow_decision`、`gate_timed_out`、
  `founder_approval_*`、`founder_deferral_*`、`founder_review_gate_superseded`、
  `review_gate_superseded`、`founder_reply_delivered|dead_letter`；实现中展开为 exact strings；
- `lead_events`：`gate_question`、`founder_reply*`、`action_executed`、`review_advisory_pass`、
  `founder_action_needed`、`workflow_ship_ready`、`workflow_route_input_rejected`；
- `workflow_run_event`：`turn_granted`、`activation_turn_granted`、`claim_written|revoked`、
  `gate_opened|gate_holder_created`、`runner_ship_approved`、`runner_ship_merged_*`、
  `founder_feedback_kickback`、operator/run completion/termination/decision transitions；
- `mailbox`：任何 non-null checkpoint，特别是
  `approve_to_ship|review_code|review_design|founder_review|question`；消息 class 看
  `type IN ('question','response','instruction','founder_reply')`，只有报告标记看 `kind='report'`。
  当前 production 的 `kind` 只有 `NULL|report`；测试必须覆盖 `kind IS NULL AND type='question'`。
  唯一 override 是 §4.1 两字段同时 exact-match 的 HL orphan；任一字段 near-miss 仍按本条保护；
- `mailbox_log.row_json`：上述 mailbox values，以及 `type/event_type` 为 `founder_reply*`、
  `gate_question`、`action_executed`、`review_advisory_pass`、`workflow_ship_ready`、
  `workflow_route_input_rejected`；`event='processed'` 时的 `lead_ack|response_observed|`
  `discord_explicit_reply|ship_gate_bound|deferred_founder_decision|gate_retired_merged`。

代码中不使用这里的 `*`；测试断言 registry 展开后的 exact set。未知 value 永久 fail-safe，只有后续
有 reader 证明并通过代码评审才可加入 delete allowlist。

### 4.4 182 张表的完整 classification

以下三组是 2026-08-23 production schema 的完整、互斥、穷尽合同。代码 registry 与这些 exact
names 双向比较；不是“未列出的都算 reference”。

TeamLead `delete-target`（18）：

```text
alert_repair_attempts alert_threads chat_threads deployment_events
detection_escalations founder_page_ledger lead_event_delivery_attempts lead_events
legacy_cutover_quarantine legacy_render_fallback legacy_stock_suppressed
phase_chat_threads quiet_wake_notified roundtable_topic_threads session_events
ticket_escalations tmux_hold workflow_run_event
```

TeamLead `protected-authority`（36）：

```text
codex_review_job codex_review_record delivery_secret_state design_review_manifest
disposition_receipts founder_action_ledger founder_decision_convergence
founder_deferred_approval founder_review_card_binding issue_disposition_intents
land_cool_adjudication_receipt land_cool_attempt receipt_root_lineage
review_finding_ruling session_receipt_lineage ship_approval_requests
stuck_dispositions turn_source_history workflow_carryover_pr_binding
workflow_claim_revocation workflow_claims workflow_decision_capability
workflow_gate_carrier_rebind_receipt workflow_gate_holder
workflow_gate_holder_carryover_evidence workflow_gate_holder_evidence
workflow_head_carryover_receipt workflow_output_credential
workflow_ship_target_binding workflow_source_event workflow_source_receipt
workflow_start_reservation workflow_start_response workflow_start_stage
workflow_submission_credential workflow_turn_divergence_episode
```

TeamLead `protected-current-or-reference`（103）：

```text
admission_pause alert_delivery_receipts auto_qa_record cleanup_ref_observations
commdb_finalize_failures dead_letter_alerts doa_backoff doa_backoff_participants
doa_backoff_reset_receipts flag_departures flag_keep_anchor flag_provenance
flag_scan_failure_alert_intents flag_scan_run_items flag_scan_run_legs flag_scan_runs
flag_scan_state flag_store_meta flag_value_changelog flag_values fleet_pressure_hold
founder_reply_retry land_alert_outbox land_operation land_operation_step
land_recovery_episode land_repo_admission lead_inbox lead_pending_escalation
lifecycle_apply_claims lifecycle_launch_claims linear_state_observations
loop_heartbeat loop_owner merged_gate_guard_failure messages
receipt_activation_episodes receipt_alert_outbox receipt_exemption_audit
receipt_handle_requests receipt_resend_deliveries retry_dispatch_intents runbook_issues
runner_declared_states runner_phase_wakes runner_shutdown_controls
runner_wake_failure_episode runner_workflow_activation server_loss_episode sessions
ship_relevant_diff_snapshot state_store_migration three_stage_turn
workflow_activation_turn workflow_actor workflow_alert_outbox
workflow_binding_cutover_claim workflow_carrier_delivery
workflow_carrier_redrive_receipt workflow_carryover_activation
workflow_category_binding workflow_dead_execution_watch workflow_declared_pr
workflow_divergence_check workflow_engine_park workflow_engine_park_cursor
workflow_engine_park_outbox workflow_execution_binding workflow_execution_runtime
workflow_launch_cancellation workflow_launch_owner workflow_loop_reentry_request
workflow_materialization_receipt workflow_node_completion workflow_node_output_current
workflow_node_outputs workflow_node_pr_binding workflow_operator_close_intent
workflow_pr_finalization workflow_pr_manifest workflow_resume_admission
workflow_resume_attachment workflow_resume_attachment_state workflow_resume_probe
workflow_resume_response workflow_rework_delivery workflow_rework_request
workflow_rework_route_revision workflow_rework_verification_path
workflow_route_decision workflow_route_reminder_outbox workflow_run
workflow_run_collect_alias workflow_run_collect_receipt workflow_run_node
workflow_side_effect_ledger workflow_source_cursor workflow_source_deadletter
workflow_template workflow_template_audit workflow_template_publication
workflow_template_revision workflow_wake_send_claim
```

CommDB `delete-target`（7）：

```text
content_ref_gc_outbox mailbox mailbox_log receipt_alert_outbox runner_phase_wakes
runner_shutdown_controls runner_wake_failure_episode
```

CommDB `protected-current-or-authority`（18）：

```text
lead_inbox_fenced_root lead_inbox_freeze_install lead_inbox_sanitation_audit
loop_heartbeat loop_owner mailbox_identity mailbox_migration_meta
runner_declared_states runner_workflow_activation session_receipt_lineage sessions
three_stage_turn turn_source_history turn_wait_ledger turn_wake_outbox
workflow_engine_park workflow_engine_park_cursor workflow_source_event
```

总数断言：TeamLead `18+36+103=157`，CommDB `7+18=25`。

### 4.5 Reader/anti-join consumer audit

表级 classification 仍不够；日志 row 可能是负向 authority。实现前必须生成并测试
`fly-2006-retention-consumer-gate`：扫描 production reader 中每个 delete-target table 的 SQL 引用，
每个引用必须具名映射到 `protect-value|backed-narrative|current-only|archive-family`。新 consumer、未映射
的 `NOT EXISTS`、`COUNT(*)`、`event_id`/payload lookup 都使 gate 失败。

R1 已确认并直接写入保护集的三条 authority：

- `lead_events.event_type='session_zombie_detected'` 是
  `getZombieAlertBacklog` 的 anti-join 哨兵；删除会重新发 Founder alert；
- `session_events.event_type='founder_thread_notified'` 是 workflow gate materialization anti-join 哨兵；
- `session_events.event_type='post_ship_finalization_completed'` 与 `workflow_run_event.execution_id` 是
  attributed finalization fallback；对应 rows 保护。

`mailbox_log.event='archived'` 是 `getIdentityDisposition/getIdentityCarrier` 的唯一历史 row source，永久
保护。`processed|disposed|migration_snapshot` 只有在 matching live `mailbox` 不存在、`row_json` 不含
authority value、且 consumer gate 证明不会翻转 anti-join 时才可删除。

## 5. Manifest、快照与 apply 语义

### 5.1 有界 cohort representation

FLY-1998 的 exact-key JSON + 每 200 rows receipt 只适合小 cohort。FLY-2006 定义两个模式：

- `exact-keys`：candidate `<= 20,000`，manifest 保存 logical key tuples，batch `<=200`；
- `range-digest`：integer monotonic PK 且 candidate `>20,000`。inventory 按最多 50,000 candidate rows
  形成有序 shard；每 shard 只保存 `minPk|maxPk|rowCount|sha256(canonical CAS rows)`，不把数百万 PK
  写进 JSON。apply 在同一 PK bounds 内重跑完整 predicate，流式重算 count/digest 后才 DELETE。

`session_events` 必须使用 `range-digest`。以 as-of 现盘 2,779,792 个 raw-old 上限计算，最多 56 shards、112 个
receipt/digest files，而不是约 13,900 batches/27,800 files。50,000 只是设计 ceiling；隔离副本基准
若任一 shard transaction 接近 5 秒预算，就降低 ceiling 并重新 inventory，绝不现场改变 frozen shard。

### 5.2 SQLite table snapshot

高基数 target 不输出 as-of 现盘 2,779,792 条裸 `.mode insert`。每个 target 生成独立 0600 SQLite snapshot DB：

1. destination 建原 table DDL；source readonly `.iterate()`，destination 单事务批量 insert candidate rows；
2. 保存 candidate count、streaming canonical digest、snapshot file digest 和 source table schema digest；
3. 用 SQLite backup API 把 snapshot DB 恢复到 scratch，再校验 `quick_check`、DDL、count/digest；
4. apply 只复核 sealed snapshot file/digest，不再第二次逐行 restore。

小 cohort 也走同一 snapshot DB，避免两种恢复格式。零候选 target 记录零值且不创建假 snapshot。

### 5.3 Apply 与 mailbox archive

两库无法跨文件原子提交，因此 apply 以“单库单 shard 事务 + commit 后 receipt”提供可恢复性。每批
重跑完整 CAS；已有 receipt 且 cohort 已消失才允许幂等 resume。

`mailbox` 不是 generic DELETE target。sweep 不直接调用 TypeScript `MailboxQueue.archiveFamily`；它在
现有 apply connection 内实现 `archiveMailboxFamily`，逐项复制相同的 family discovery、terminal/
question-root/content-ref/max-bytes/live CAS gates 与 `BEGIN IMMEDIATE` 四步事务：写
`mailbox_log(event='archived')` snapshot、按需写 content-ref GC intent、将每个
`mailbox_identity.archived_at` 从 NULL CAS 为 archive time、最后 DELETE mailbox member。普通 14 天
cohort 传 `retentionMs=RETENTION_MS`；HL exact exception 明确传 `retentionMs=0`，否则当前仅 ACK 约
7.6 小时的 42 条会被原合同的 72 小时 default 返回 `not_due`。family 中任一 active/leased/authority
member 仍保护整个 family；ordinary recent 由 14 天门槛保护，只有 exact exception 绕过 age。
为防两份实现日后漂移，FLY-2006 suite 用同一 family fixture 分别驱动 sweep replica 与
`MailboxQueue.archiveFamily`，比较 deterministic `archived:<id>` event id、root subject id、`gc:<id>`
intent、canonical `row_json`/content-ref archive、identity CAS 及最终 live/log/outbox 状态；任一差异即
失败，而不只比较 deleted count。

HL exception 的 production read-only census（2026-08-23）恰为 42 条，created_at 在
`2026-08-21T20:35:34.179Z..2026-08-22T00:54:55.205Z`，因此 42 条都在 14 天窗内。它们全是
`ACKED + terminal_disposed + type=question + kind=report`，没有 checkpoint、lease、content_ref、
`ref_id` 或指向它们的 inbound ref；42 个 identity 均存在且 `archived_at IS NULL`，故当前是 42 个
单成员 family。inventory 仍以实时 exact predicate 重算和冻结，不把“42”写成删除上限；若 family、
identity 或 terminal invariant 漂移即 fail closed。相同 sender/open、其他 sender/terminal_disposed、
字段 prefix/LIKE 都是 protected near-miss。

no-delete trigger 只允许两个逐名例外：

- `workflow_run_event_no_delete`：仅 FLY-1998 已证明、且 backing row 已 terminal 的四个 narrative kind；
- `mailbox_log_no_delete`：仅 `event != 'archived'`、matching live mailbox 不存在、consumer gate 已证明
  非 anti-join/authority 的 frozen rows。

`mailbox_identity_no_delete` 永不撤销；其他 trigger 不允许 registry 自行声明 bypass。apply complete
的必要条件：

- 各 target frozen candidate count 与 committed rows 逐字一致；
- frozen recent/protected sentinel 全部仍在；
- schema/trigger 与 FK baseline fingerprint 不漂移；
- 两库 `quick_check` 与 `integrity_check` 唯一返回 `ok`；
- manifest、Founder gate audit 和 receipt digest 互相绑定。

### 5.4 Evidence/legacy compatibility

新 inventory 写 `~/.flywheel/maintenance/fly-2006/<run-id>`、`issue='FLY-2006'`、manifest v2。脚本同时
保留 exact known FLY-1998 v1 script digest 的只读兼容：既有 v1 manifest/complete receipt 可以验证和
读取，但不得用新代码继续未完成的 legacy apply。FLY-1998 的 production receipt 和 receipts dir
不迁移、不重写；v1 regression 明确断言 closed evidence readable，v2 tests 断言新 root/path guard。

### 5.5 VACUUM preconditions

`VACUUM` 一次只处理一库，并要求操作员在排定窗口签发一次性 `--quiescence-ack <token>`；形态参考
`FLYWHEEL_FORCE_PUSH_ACK`，工具验证非空/单次使用并把 token digest 写进 receipt，不把调用方自填值
描述成 cryptographic proof。本工具不 stop/start/restart Bridge；执行时仍复核 loopback health、WAL
checkpoint 与 writer-lock acquisition。

另要求 `availableBytes >= 2 * mainDbBytes + 1 GiB`。Tadashi 经问题
`086fc0a6-ad23-49fd-acca-5cf801bc26a1` 转述：2026-08-23 约 13:15Z 外部操作员在生产在线状态对
teamlead 做过一次 VACUUM（转述 duration 10.02 秒、integrity ok），comm 首次 busy 后重试成功。
时间与 duration 均无 receipt、未独立核实；这些操作不属于本 runner，且没有 FLY-2006 evidence
dir/ack/started marker/receipt，因此只能作为外部历史观察，不能充当本单 rehearsal、授权或验收证据。

删除 as-of 现盘的 2,779,792 个 old `session_events` 后工作量不同；production max-duration 是必填
operator input，同时绑定 quiescence ack 与 sealed Task 8 post-delete rehearsal summary digest。工具核对
input 不小于 summary 的实测 duration；不能从上述 pre-delete 外部观察外推。实际 duration 与 WAL
before/after bytes 写 receipt；超预算即使 SQLite 已成功也发 degraded result。tests 覆盖
budget-summary binding、space/ack/busy 拒绝路径。

## 6. 当前数字的正确解释

14 天 raw-old census 说明预计能回收 GB 级空间，主要来自 2,638,046 行 FLY-1995 cohort 和其他
141,746 行老 `session_events`，以及 107,838 行老 `mailbox_log`。但 raw-old 不是 dry-run candidate；
最终 Founder 卡片只能使用实现完成后 production inventory 生成的逐 target exact counts。

inventory 时所有 live TeamLead session、active/held run 的全部 execution、CommDB running session、未结算
ACK/outbox/wake，以及所有审批/凭证/裁定表均进入保护集。最初“本 runner 不执行 production mutation”
边界随后被 Founder 原始消息「删」与 Lead 明确执行指令取代；实际 FLY-2006 production evidence 见 §7。
上述更早外部 operator VACUUM 仍单独披露，不计入本单 receipt。

## 7. R4 过审后的 production execution evidence

Codex code review R4 在 exact HEAD `79c71a46a18f4dfe49afb5ae7a27d73d2c5e4787` APPROVED。
blocking thread-identity finding 已收口：`chat_threads`、`phase_chat_threads`、
`roundtable_topic_threads` 只有 `discord_missing_at IS NOT NULL` 才能进入候选，canonical Discord anchor
永久留存；测试直接执行三条 production policy SQL。

最终 isolated rehearsal summary SHA-256 为
`7d20b68d903694a725f20cadbcf89521bda26dfc107114fde6403387018d1a8f`：2,892,153 candidates 与
2,892,153 deleted 逐表一致，16 个非零 target 全 restore-verified，两库 integrity `ok`；VACUUM 实测
teamlead 1,707,577,344→277,471,232 bytes / 1,406ms，comm 509,276,160→292,765,696 bytes /
1,384ms。receipt JSON 706 个，其中 `sessionEvents` 56、`mailbox` 446。

最终 production manifest SHA-256 为
`5742fe9a5439b0e6f069eca83ec8bcba7744cf1a5aecc48e24bec08dc1b5eeb2`，cutoff
`2026-08-09T17:41:18.664Z`，候选 2,892,154；相对 Founder 已批 2,893,062 少 908 行（−0.0314%），
低于 Lead 裁定的 ±1% 且 target table family 不变。16 个非零 snapshot 全 restore-verified，TeamLead
157 表与 CommDB 25 表完整分类，两库 quick-check `ok`；HL exact exception 为 42，thread candidates 为
`chat=14 / phase=0 / roundtable=0`，只含已确认 Discord missing 的 anchors。

apply receipt SHA-256 为
`37d4c503e1164bf94c66e1a7293b4f00416145d932408380662d43d0fd9c86cb`：2,892,154 candidates =
2,892,154 deleted，逐表 mismatch 为空；两库 `quick_check` 与 `integrity_check` 均为 `ok`、FK fingerprint
不漂移。receipt 原样记录 Founder Discord provenance，engine 只证明 provenance 未漂移，不宣称独立
验证 Discord。相同参数 replay 返回同一 complete receipt，不产生第二次删除。

teamlead production VACUUM receipt SHA-256 为
`9d4785477b60b03b080539c91650bef8b66401c4c942c6a94a131de68cf8bd06`：main file
1,707,659,264→277,483,520 bytes，WAL 305,522,752→4,152 bytes，1,358ms，integrity `ok`，
freelist 346,686→0。ack 最初由 Lead 写成 operator JSON；执行者保留原件后用工具同一
`writeSealedJson` primitive 封存 internal/outer seal，payload/token 不变且未输出 token。

comm 首次四次都在 started marker 前以 `vacuum_writer_busy` fail-closed，token 未消费。Lead 要求等待
12:00 PT 例行 updater 窗；执行者从 11:58 PT 起以约 1 秒 cadence 观察所有 `comm.db` holders，数量
8→最低 5→8，始终未到 0。updater 实际顺序为先恢复 Bridge，再逐个 kickstart/bootout Lead，因此没有
形成 fleet-wide quiescence；12:06:37 updater 完成，Bridge 与 16/16 Lead 恢复健康。执行者未运行
checkpoint/VACUUM，comm ack 未消费、无 `vacuum-comm-started.json`、无 comm mutation，并通过 question
gate `6bd21e62-1764-4d2e-acaf-5d1adf6f1a29` 请求 Lead 安排真正的全 holder 静默窗。

Lead 最终裁定先独立尝试有界 `wal_checkpoint(TRUNCATE)`，VACUUM 则作为 PR `pending-op`，由其向
Founder 另提约 2 分钟舰队全停维护窗（与 launchd bootout、bridge log rotation 打包；时间由 Founder
决定）。checkpoint 首次尝试 34ms、busy=0，WAL 510,908,872→0 bytes；sealed checkpoint receipt
SHA-256 为 `11f4f4382329a0fc0984eba8c954556829639406501a5fc9cb22b2043f8898ad`，绑定同一 production
manifest/apply。服务继续运行后 WAL 仅回长约 428KB，comm main file 保持 509,288,448 bytes，
`quick_check`/`integrity_check` 都为 `ok`、Bridge healthy。最终边界：没有 comm VACUUM receipt；ack
仍未消费、无 started marker，也没有 stop/restart。不能把 WAL 回收写成 main-file VACUUM 成功。
