# FLY-1456 62 flag 逐条定值执行 — 执行台账

Issue: FLY-1456 (https://linear.app/geoforge3d/issue/FLY-1456/flag治理清存量eng-62-flag-逐条定值执行-按-hl-盘点圈选-删固化动态化承接-fly-1413)
日期: 2026-07-24
基于: plan.md

## 1. 取数与填写规则

- 唯一裁决源:`67b35748:product/doc/FLY-1413-flag-audit-increment/tab-decisions.js`。
- 固定名单源:`67b35748:product/doc/FLY-1413-flag-audit-increment/snapshot.json` 的 `newSinceBaseline`；实现中途不得改用活 registry 重算。
- implement dispatch 裁决(`ask b6af3621-938e-4b03-9d11-9badb686ad71`):本次收敛为一个 PR；原 PR-1…PR-4 是同一 PR 的 G1…G4 commit group，原 PR-5 是 G5 docs closeout。
- 单 PR 已创建为 #695，G5 已回填全部 62 行；`merge_sha` 在 founder-gated merge 前保持 `pending`，不得伪造。
- `1405_candidate=yes` 表示幸存 flag 交给 FLY-1405 做 call-time / 动态源迁移评估；`no` 表示已有其他 owner 或 RESERVED；`n/a(deleted)` 表示本单删除后不再迁移。

## 2. 62 条执行记录

| flag | 来源桶 | 裁决 | action | owner / 去向 | PR# | merge_sha | 1405_candidate | reason |
|---|---|---|---|---|---|---|---|---|
| watchdog_liveness | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| watchdog_loop_heartbeat | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| watchdog_blocked | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| receipt_foundation | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| receipt_activation_dry_run | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| park_biased_handoff | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| prune_park_guard | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| readopt_parked_roles | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| liveness_activity_window_ms | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| codex_gate_wait | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| lead_dual_active_scan | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| quota_degraded_switch | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| claude_account_identity_check | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| voice_qa_presence_override | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| quota_daemon_wake | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| review_severity_policy_killswitch | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| design_html_gate | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| issue_gate_supersede_mode | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| founder_review_gate_exclude | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| retest_head_delta_guard | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| ship_ci_guard | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| ship_ready_notify | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| ship_ready_remind_ms | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| ask_hygiene | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| engine_dead_exec_sweep | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| workflow_rework_reentry | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| engine_unlaunched_tripwire | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| stuck_pane_confirm | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| commdb_residue_harvest | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| terminal_commdb_sync | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| ghost_guard_wait_ms | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| lead_lease_bypass | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| skill_framework_split_participation | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| land_node | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| workflow_vendor_at_dispatch | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| commdb_protection | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| delivery_secret_path | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| zombie_reconcile | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| terminal_thread_archive | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| disposition_receipt | default_only | 跑默认值 | no-code | FLY-1405 | #695 | pending | yes | 生产实况复核未见异常；幸存者进入动态化评估 |
| checkpoint_watchdog | explicit_dead | 同意删 | delete | FLY-1456 PR-3 | #695 | pending | n/a(deleted) | 显式设过但 runtime-hard-off；Tadashi 同意删除 |
| park_watch | dead_only | 确认可删 | delete | FLY-1456 PR-1 | #695 | pending | n/a(deleted) | retired watchdog lane 恒 false |
| park_watch_cadence | dead_only | 确认可删 | delete | FLY-1456 PR-1 | #695 | pending | n/a(deleted) | 仅喂给未接线的 park-watch tick |
| park_watch_n1_ms | dead_only | 确认可删 | delete | FLY-1456 PR-1 | #695 | pending | n/a(deleted) | 仅服务恒 off park-watch lane |
| park_watch_n2_ms | dead_only | 确认可删 | delete | FLY-1456 PR-1 | #695 | pending | n/a(deleted) | 仅服务恒 off legacy detection/park lane |
| park_watch_qa_n3_ms | dead_only | 确认可删 | delete | FLY-1456 PR-1 | #695 | pending | n/a(deleted) | 仅服务恒 off park-watch lane |
| delivery_ack | dead_only | 确认可删 | delete | FLY-1456 PR-2 | #695 | pending | n/a(deleted) | 所有读点与恒 false 总闸相与；现行 CommDB authority 不读 |
| delivery_unconsumed_v2 | dead_only | 确认可删 | delete | FLY-1456 PR-2 | #695 | pending | n/a(deleted) | gap-scan tick 从未接线；现行 CommDB authority 不读 |
| delivery_ack_timeout_ms | dead_only | 确认可删 | delete | FLY-1456 PR-2 | #695 | pending | n/a(deleted) | 只服务 disabled legacy coordinator |
| delivery_max_redeliver | dead_only | 确认可删 | delete | FLY-1456 PR-2 | #695 | pending | n/a(deleted) | 只服务 disabled legacy coordinator |
| delivery_max_transport_failures | dead_only | 确认可删 | delete | FLY-1456 PR-2 | #695 | pending | n/a(deleted) | 只服务 disabled legacy coordinator |
| ack_late_window_ms | dead_only | 确认可删 | delete | FLY-1456 PR-2 | #695 | pending | n/a(deleted) | 只服务 disabled legacy coordinator |
| legacy_delivery_watchdogs | dead_only | 确认可删 | delete | FLY-1456 PR-3 | #695 | pending | n/a(deleted) | env 参数从不读取；retired lane 返回类型恒 false |
| cmux_linked_view | explicit_unknown_resolved | frozen@0 | no-code | FLY-1446 | #695 | pending | no | 急停已拉且有活不一致线索；由 FLY-1446 收编 |
| quota_daemon_cutover | explicit_unknown_resolved | keep@1，固化候选 | solidify-delete | FLY-1456 PR-4 | #695 | pending | n/a(deleted) | 关会复活旧 account-switch 路由；终态写死 retired |
| three_stage_codex_design_toggle | explicit_other | 保持关 | no-code | FLY-1405 | #695 | pending | yes | per-dispatch designBackend 已接管；幸存者进入动态化评估 |
| skill_framework_mode | explicit_other | 保持 split | no-code | FLY-1405 | #695 | pending | yes | 现行 shipped 形态；幸存者进入动态化评估 |
| workflow_claims_write | explicit_other | 保持在用 | no-code | FLY-1405 | #695 | pending | yes | 现行 claims 写路径；幸存者进入动态化评估 |
| workflow_claims_read | explicit_other | 保持在用 | no-code | FLY-1405 | #695 | pending | yes | 现行 claims 读路径；幸存者进入动态化评估 |
| cmux_view_invariant | explicit_other | 保持 | no-code | FLY-1405 | #695 | pending | yes | FLY-1364 护栏；幸存者进入动态化评估 |
| workflow_template_dispatch | explicit_other | RESERVED，保持不许动 | no-code | FLY-1436 | #695 | pending | no | work-kind cutover 急停杆；Annie 红线 |
| workflow_generalized_templates | owned_elsewhere | RESERVED，不碰 | no-code | FLY-1436 | #695 | pending | no | work-kind cutover 由 FLY-1436 独占 |

## 3. 初始自检

| 检查 | 结果 |
|---|---|
| 唯一 flag 行数 | 62 |
| `default_only` | 40 |
| `explicit_dead` | 1 |
| `dead_only` | 12 |
| `explicit_unknown_resolved` | 2 |
| `explicit_other` | 6 |
| `owned_elsewhere` | 1 |
| 分桶等式 | 40 + 1 + 12 + 2 + 6 + 1 = 62 |
| 代码动作 | delete 13 + solidify-delete 1 = 14 |
| 零代码动作 | 46 |
| RESERVED | 2；`workflow_template_dispatch` + `workflow_generalized_templates` |

复核方式:

1. `snapshot.json.newSinceBaseline` 与本表 `flag` 列集合相等。
2. `tab-decisions.js` 的 `EXPLICIT_RULINGS`、`DEAD_SPLIT`、`OWNED_ELSEWHERE` 与本表对应裁决逐字一致。
3. `PR-1..PR-4` 的目标共 14 条，全部为 `1405_candidate=n/a(deleted)`；其余幸存者按 FLY-1405 / FLY-1446 / FLY-1436 owner 分流。
