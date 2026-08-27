# Flywheel contact book

用途只有一个：拿到一类问题后，直接知道该找谁。当前先按真实组织状态写；绝大多数类别找 Tadashi（`flywheel-eng-lead`），不为未来可能出现的多人分工预建层级。

这张表覆盖当前代码、shell 发射面与全期告警账本里已知的 99 个唯一类别，规模不是最近 7 天窗口的子集。类别没有行或现场证据冲突时，统一找 Tadashi，并由实际处置者回填。

| 类别 | 找谁 | 这类问题是什么 |
|---|---|---|
| `bridge_abnormal_exit` | Tadashi | Bridge 非正常退出 |
| `bridge_wrapper_fail` | Tadashi | Bridge wrapper 启动失败 |
| `bridge_boot_stale_checkout` | Tadashi | Bridge 启动在过期 checkout |
| `restart_guard_bypass` | Tadashi | 重启保护被人工绕过 |
| `restart_storm_hold` | Tadashi | 重启风暴保护暂停了拉起 |
| `crash_loop` | Tadashi | 进程反复崩溃 |
| `deploy_failed` | Tadashi | 部署失败 |
| `deploy_degraded` | Tadashi | 部署完成但有降级项 |
| `bin_integrity_drift` | Tadashi | 运行脚本内容漂移 |
| `discord_plugin_integrity_failed` | Tadashi | Discord 插件来源或内容不可信 |
| `host_voucher_incident` | Tadashi | 主机 IPC voucher 压力异常 |
| `swap_pressure_high` | Tadashi | 主机 swap 水位过高 |
| `external_config_error` | Tadashi | shell 外部配置错误 |
| `companion_config_error` | Tadashi | companion 配置错误 |
| `pane_hash_stuck` | Tadashi | Lead pane 长时间没有变化 |
| `pane_error_stalled` | Tadashi | Lead pane 停在错误状态 |
| `tui_window_lost` | Tadashi | windowed Lead 的 TUI 窗口丢失 |
| `lead_dual_active` | Tadashi | 同一 Lead 出现两个活体 |
| `lead_dual_active_sensor_degraded` | Tadashi | Lead 双活传感器证据降级 |
| `lead_lease_store_broken` | Tadashi | Lead 租约库不可用 |
| `lead_lease_bypass_used` | Tadashi | Lead 租约保护被绕过 |
| `lead_lease_would_block` | Tadashi | Lead 租约会阻止启动 |
| `lead_lease_control_broken` | Tadashi | Lead 租约控制面故障 |
| `lead_identity_source_broken` | Tadashi | Lead 规范身份来源损坏 |
| `lead_backend_drift` | Tadashi | Lead carrier 与 backend 漂移 |
| `rules_bundle_legacy` | Tadashi | Lead 仍在使用旧规则路径 |
| `model_config` | Tadashi | Lead 模型配置异常 |
| `infra_bot_down` | Tadashi | 一个 Infra bot 下线 |
| `lead_body_adopted` | Tadashi | 历史 Lead body adoption 事件 |
| `receipt_foundation_off` | Tadashi | 历史 receipt foundation 关闭事件 |
| `runner_stuck_unhandled` | 从工单绑定取该 runner 所属 Lead | Runner 卡住且未被处置 |
| `runner_throttle_stalled` | 从工单绑定取该 runner 所属 Lead | Runner 限流后停止推进 |
| `runner_pane_loss` | 从工单绑定取该 runner 所属 Lead | 活跃 runner 的 pane 丢失 |
| `zombie_session_backlog` | Tadashi | 僵尸 session 积压 |
| `runner_lead_pending_unhandled` | 从工单绑定取该 runner 所属 Lead | Runner 的阻塞问题催问耗尽 |
| `complete_marker_held` | 从工单绑定取该 runner 所属 Lead | 完成信号被工作流不变量扣住 |
| `workflow_route_input_rejected` | 从工单绑定取该 runner 所属 Lead | 工作流节点输入被拒 |
| `three_stage_stuck` | 从 issue thread 绑定取项目 Lead | Design、Implement、QA 交接卡住 |
| `three_stage_takeover_failed` | 从 issue thread 绑定取项目 Lead | 共享分支接棒失败 |
| `workflow_engine_escalation` | Tadashi | 工作流引擎恢复预算耗尽 |
| `workflow_engine_issue_alert` | 从 issue thread 绑定取项目 Lead | 工作流引擎的 issue 级异常 |
| `auto_qa_stuck` | Tadashi | QA 或授权阶段停滞 |
| `commdb_finalize_stuck` | Tadashi | CommDB lifecycle closeout 卡住 |
| `codex_gate_blocked` | Tadashi | 当前 head 没有有效评审批准 |
| `review_advisory_pass` | Tadashi | 评审通过但带 advisory |
| `review_ruling_recorded` | Tadashi | Lead review ruling 已记录 |
| `review_ruling_disputed` | Tadashi | reviewer 对 ruling 有争议 |
| `review_ruling_notify_failed` | Tadashi | ruling 通知失败 |
| `merged_gate_guard_unavailable` | Tadashi | 已合并状态无法验证 gate |
| `external_merge_suspect` | Tadashi | 外部 merge 缺少可验证授权 |
| `ship_attempt_failed` | Tadashi | 已授权 ship 尝试失败 |
| `stale_approved_ship_dead` | Tadashi | 获批 ship 的 runner 已死亡 |
| `mailbox_dead_letter` | Tadashi | 信箱消息耗尽签收预算 |
| `delivery_dead_letter` | Tadashi | 必须签收的投递耗尽预算 |
| `inbox_loop_stalled` | Tadashi | Lead 信箱消费循环停滞 |
| `legacy_row_quarantined` | Tadashi | 旧消息行被隔离 |
| `founder_gate_delivery_failed` | 从 issue thread 绑定取项目 Lead | founder gate 提醒未送达 |
| `founder_reply_pass_dead` | Tadashi | founder reply ingest pass 停止推进 |
| `founder_reply_pinned` | Tadashi | founder 消息长期钉住 cursor |
| `founder_reply_dead_letter` | Tadashi | founder 消息进入 dead letter |
| `founder_notify_dead_letter` | Tadashi | founder-facing 通知投递耗尽 |
| `founder_reply_unreachable_runner` | Tadashi | founder 回复找不到活 runner |
| `detection_page_undeliverable` | Tadashi | 检测页无法投递 |
| `detection_fleet_aggregate` | Tadashi | fleet 检测聚合提示 |
| `notify_digest_failed` | Tadashi | 例行 digest 发送失败 |
| `founder_action_needed` | Tadashi | 历史 founder action 提醒 |
| `must_deliver_unrelayed` | Tadashi | 历史 must-deliver 未 relay |
| `founder_milestone_undelivered` | Tadashi | 历史 milestone 未投递 |
| `rate_limit` | Tadashi | Claude 或 Codex 侧触发速率限制 |
| `usage_limit` | Tadashi | Claude 或 Codex 侧用量耗尽 |
| `login_expired` | Tadashi | Claude 或 Codex 侧 Lead 登录失效 |
| `runner_login_expired` | Tadashi | Claude 或 Codex 侧 runner 登录失效 |
| `account_switched` | Tadashi | quota monitor 已切换账号 |
| `account_switch_degraded` | Tadashi | 账号切换降级 |
| `machine_account_conflict` | Tadashi | 机器当前账号与账本冲突 |
| `model_cap_switched` | Tadashi | 模型上限策略已切换 |
| `model_cap_unknown` | Tadashi | 模型上限暂时未知 |
| `model_cap_persistent_unknown` | Tadashi | 模型上限持续未知 |
| `model_bench_malformed` | Tadashi | 模型 benchmark 输出损坏 |
| `quota_switch_confirmation` | Tadashi | quota 切换等待确认 |
| `quota_no_target` | Tadashi | 没有可切换的 quota 目标 |
| `quota_blocked_recovered` | Tadashi | quota 阻塞已恢复 |
| `quota_read_blind` | Tadashi | quota monitor 无法读额度 |
| `account_switch_failed` | Tadashi | 账号切换失败 |
| `account_identity_mismatch` | Tadashi | 账号身份与预期不一致 |
| `quota_revive_stuck` | Tadashi | quota 恢复流程卡住 |
| `quota_monitor_down` | Tadashi | quota monitor 下线 |
| `quota_guard_bypassed` | Tadashi | 人工绕过 quota guard |
| `tmux_server_lost` | Tadashi | 承载 runner 的 tmux server 消失 |
| `tmux_hold` | Tadashi | tmux 安全检查无法证明可操作 |
| `tmux_split_brain` | Tadashi | 多个 tmux generation 争同一 socket |
| `tmux_rescue_hold` | Tadashi | tmux rescue 被安全保护扣住 |
| `cmux_cleanup` | Tadashi | cmux 工作区清理被拒或保留 |
| `cmux_watcher_stalled` | Tadashi | cmux watcher 停止推进 |
| `permission_blocked` | founder | 动作缺少权限 |
| `quota_choice` | founder | 需要在人类负责的 quota 方案间选择 |
| `flag_scan_failed` | Tadashi | 周期旗标扫描失败 |
| `flag_scan_no_clock` | Tadashi | 旗标扫描没有有效时钟 |
| `flag_scan_handoff` | Tadashi | 旗标扫描需要人工接棒 |
