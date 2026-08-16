# FLY-1782 · 执行单可直接分批的形状(95 条,每条带固化值)

**日期**: 2026-08-15
**任务来源**: HL —— 「把 94 条那两组整理成执行单可以直接分批的形状,每条带『固化成哪个值』」
**硬门(Tadashi)**: **写不出固化值的不许进单**
**状态**: **没有建执行单,没有做页面**

---

## 0. 硬门自检结果

| 检查 | 结果 |
|---|---|
| 条目总数 | **95**(原 94 + `qa_auto`,它已从 ② 挪进 ①,见 pile1-judgment §7) |
| **写不出固化值的** | **0** ✅ 全部可进单 |

唯一一条差点卡住的是 `lead_chrome_enabled`(逐 Lead,值来自各自 manifest)——
查清了:**15 个 Lead 全部为 false**,取值一致 ⇒ 固化值 = **关**。
(如果它们不一致,按硬门就该退出批量;这里是一致的,所以可以进。)

---

## 1. 为什么这 95 条的固化值是「机械的」,不是判断

这 95 条的共同事实:**当前生效值 == 真默认值**。
⇒ 「冻结在现值」和「落回默认」**指向同一个值** ⇒ **不存在方向选择,也就没有选错的余地。**

**这正是它们能批量走、而 ② 那 10 条不能的原因。**
(② 两值不同 ⇒ 删的方向是个必须有人做的选择 ⇒ 逐条摆给她。)

⚠️ 但按 pile1-judgment §7.2 的教训,仍有一条前置:
**执行前逐条核「registry 的 default」与「解析器的真缺省」是否一致** ——
`qa_auto` 就是被这一步抓出来的(registry 写 false,解析器实际是 ON)。
**我只把 7 条逐项目 flag 对着解析器查清了,117 条 env flag 没做同等复查。**

---

## 2. 急停开关批(49 条)

> HL 硬要求:**即使落在 ①,也要单独走,不混进功能类批量。**

| 开关 | 类型 | 处置 | **固化成** |
|---|---|---|---|
| `liveness_alerts` | bool | 删+固化 | **开** |
| `mailbox_queue` | bool | 删+固化 | **开** |
| `prune_park_guard` | bool | 删+固化 | **开** |
| `readopt_parked_roles` | bool | 删+固化 | **开** |
| `tmux_keepalive` | bool | 删+固化 | **开** |
| `converge_cmux_symlink` | bool | 删+固化 | **开** |
| `cmux_wal_quarantine` | bool | 删+固化 | **开** |
| `cmux_roster` | bool | 删+固化 | **开** |
| `cmux_view_invariant` | bool | 删+固化 | **开** |
| `cmux_strict_view` | bool | 删+固化 | **开** |
| `codex_gate_wait` | bool | 删+固化 | **开** |
| `lead_dual_active_scan` | bool | 删+固化 | **开** |
| `quota_degraded_switch` | bool | 删+固化 | **开** |
| `quota_daemon_wake` | bool | 删+固化 | **开** |
| `auto_qa_killswitch` | bool | 删+固化 | **开** |
| `review_severity_policy_killswitch` | bool | 删+固化 | **开** |
| `progress_resume_killswitch` | bool | 删+固化 | **开** |
| `cmux_close_request_killswitch` | bool | 删+固化 | **开** |
| `founder_review_gate_exclude` | bool | 删+固化 | **开** |
| `founder_auto_approve` | bool | 删+固化 | **开** |
| `stale_ship_rewake` | bool | 删+固化 | **开** |
| `auto_linear_done` | bool | 删+固化 | **开** |
| `founder_reply_unreachable` | bool | 删+固化 | **开** |
| `ask_hygiene` | bool | 删+固化 | **开** |
| `founder_milestone_notify` | bool | 删+固化 | **开** |
| `engine_dead_exec_sweep` | bool | 删+固化 | **开** |
| `workflow_rework_reentry` | bool | 删+固化 | **开** |
| `engine_unlaunched_tripwire` | bool | 删+固化 | **开** |
| `remote_reports` | bool | 删+固化 | **开** |
| `fleet_console` | bool | 删+固化 | **开** |
| `commdb_residue_harvest` | bool | 删+固化 | **开** |
| `terminal_commdb_sync` | bool | 删+固化 | **开** |
| `cron_stale_guard` | bool | 删+固化 | **开** |
| `ship_gate_rebind` | bool | 删+固化 | **开** |
| `external_merge_reconcile` | bool | 删+固化 | **开** |
| `ship_gate_retire` | bool | 删+固化 | **开** |
| `ship_gate_card` | bool | 删+固化 | **开** |
| `tier2_prefix_norm` | bool | 删+固化 | **开** |
| `viewer_session_reaper` | bool | 删+固化 | **开** |
| `chrome_session_reaper` | bool | 删+固化 | **开** |
| `fleet_sensor_tmux_killswitch` | bool | 删+固化 | **开** |
| `done_thread_reconcile` | bool | 删+固化 | **开** |
| `land_node` | bool | 删+固化 | **开** |
| `workflow_vendor_at_dispatch` | bool | 删+固化 | **开** |
| `commdb_protection` | bool | 删+固化 | **开** |
| `continuity_preflight` | bool | 删+固化 | **开** |
| `push_guard` | bool | 删+固化 | **开** |
| `instruction_path_check` | bool | 删+固化 | **开** |
| `doa_backoff` | bool | 删+固化 | **开** |

---

## 3. 功能类批(46 条)

| 开关 | 类型 | 处置 | **固化成** |
|---|---|---|---|
| `liveness_activity_window_ms` | value | 焊死(数值) | **600000** |
| `cmux_autostart_exec` | bool | 删+固化 | **关** |
| `claude_account_identity_check` | bool | 删+固化 | **关** |
| `boot_sha_check` | bool | 删+固化 | **开** |
| `gatepoller_circuit` | bool | 删+固化 | **开** |
| `founder_thread_notify` | bool | 删+固化 | **开** |
| `ship_ready_notify` | bool | 删+固化 | **开** |
| `ship_ready_remind_ms` | value | 焊死(数值) | **1800000** |
| `founder_reply_deliver` | bool | 删+固化 | **开** |
| `deferred_founder_approval` | bool | 删+固化 | **开** |
| `held_declined_reply` | bool | 删+固化 | **开** |
| `deferred_approval_ttl_ms` | value | 焊死(数值) | **2700000** |
| `founder_notify_retry_max` | value | 焊死(数值) | **5** |
| `founder_reply_retry_max` | value | 焊死(数值) | **10** |
| `founder_reply_deadletter_age_ms` | value | 焊死(数值) | **1800000** |
| `heartbeat_readopt` | bool | 删+固化 | **开** |
| `liveness_pane_dead` | bool | 删+固化 | **开** |
| `worktree_autoclean` | bool | 删+固化 | **开** |
| `bridge_loop_guard` | bool | 删+固化 | **开** |
| `issue_status_emoji` | bool | 删+固化 | **开** |
| `issue_status_word` | bool | 删+固化 | **开** |
| `issue_attach_pin` | bool | 删+固化 | **开** |
| `issue_display_refresh` | bool | 删+固化 | **开** |
| `issue_display_sweep_ticks` | value | 焊死(数值) | **60** |
| `crash_reaper` | bool | 删+固化 | **开** |
| `stale_terminal_close` | bool | 删+固化 | **开** |
| `commdb_fsm_reconcile` | bool | 删+固化 | **开** |
| `ship_gate_grace_ms` | value | 焊死(数值) | **15000** |
| `merge_reconcile_window_days` | value | 焊死(数值) | **7** |
| `ship_gate_card_grace_ms` | value | 焊死(数值) | **15000** |
| `codex_lead_typing` | bool | 删+固化 | **开** |
| `roundtable_thread_autocontinue` | bool | 删+固化 | **开** |
| `lead_chrome_enabled` | bool | 删+固化 | **关(15 个 Lead 全部 false)** |
| `roundtable_thread_own_bot` | bool | 删+固化 | **关** |
| `lead_dry_run` | bool | 删+固化 | **关** |
| `reports_ttl_days` | value | 焊死(数值) | **7** |
| `ghost_guard_wait_ms` | value | 焊死(数值) | **90000** |
| `runner_autocontinue` | bool | 删+固化 | **关** |
| `done_thread_reconcile_interval_min` | value | 焊死(数值) | **360** |
| `done_thread_reconcile_dryrun` | bool | 删+固化 | **关** |
| `done_thread_reconcile_max_per_run` | value | 焊死(数值) | **25** |
| `delivery_secret_path` | value | **搬**(配置数据,不是删) | **~/.flywheel/delivery-secret** |
| `zombie_reconcile` | bool | 删+固化 | **开** |
| `terminal_thread_archive` | bool | 删+固化 | **开** |
| `disposition_receipt` | bool | 删+固化 | **开** |
| `qa_auto` | bool | 删+固化 | **开(六项目实际全开;真默认=ON)** |

---

## 4. 不在这 95 条里的(按 HL 裁决另行处置)

| 组 | 条数 | 处置 |
|---|---|---|
| ② 删了会改变行为 | **10** | 逐条人话稿已写(pile2-and-d3.md),要她拍方向 |
| **守 ship 路的急停开关** | **6** | **单独成组,既不进「建议删」也不进「建议留」** —— 标成「等她加不加第三条判据」(HL 已去问) |
| ③ 真要留的 | 见 pile1-judgment §2 | 名单以 HL 19:37 那条的逐条答复为准 |
| 机器判不了的 | 2 | `lead_core_mention_gated` 单独列;`ponytail` 见下 |

### 4.1 两条按 HL 新给的事实更正

- **`ponytail`** —— HL 补的事实:**Annie 之前明确说过「不要开 ponytail」(FLY-615)。**
  ⇒ 它不是「不知道要不要」,是「**她说了不开**」。按冻结在现值删 = 保持不开 = 符合她已表达的意思。
  **但删不删仍由她拍**,照旧列出、不替她决定。
- **`founder_consent_decision_mode`** —— 更正我的措辞:它**不是「停在第 0 阶段」**,
  生产实际值是 `audit_only`(HL 核过 `~/.flywheel/.env` 第 150 行),是三段里的**第 1 阶**。
  已在 pile2-and-d3.md 与 pile1-judgment.md 同步改掉。

---

## 5. 我没做的

- **没建执行单**(HL:不要建)
- **没做页面、没发布、没生成新链接**
- **没有替她决定第三条判据**(那 6 条守 ship 路的仍在等她)
- **没有自己开 `proofshot`**,也没写成已决 —— HL 正在问她要不要连浏览器能力一起开
