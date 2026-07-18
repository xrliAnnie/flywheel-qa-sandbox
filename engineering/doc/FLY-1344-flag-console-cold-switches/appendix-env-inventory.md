# FLY-1344 冷开关盘点 — 调研附录
Issue: FLY-1344
日期: 2026-07-17
基于: research.md

## Scope

本附录只记录 key 名、代码语义与建议处置，**没有读取或落盘任何生产值**。本 PR 只执行五根 DAG 杆的收编与两条 ship gate timing 修正；下列 24 个未注册 key 的注册/allowlist 变更全部留给 follow-up，避免把盘点变成无界 scope。

设计稿记录「47 readonly」。implement 时对设计 head `eb25b6035` 直接执行注册表复核，实际得到 **48 个 readonly（46 env + 2 project_config）**。这是设计测量计数漂移，不影响本 PR 的五杆结论；下表按可复现的 48 行基线列全，避免为了匹配旧数字漏项。

## Unregistered env keys (24)

| Key | 建议处置 | 理由 / 安全边界 |
|---|---|---|
| `FLYWHEEL_ACCOUNT_SELF_HEAL` | allowlist 后删除生产残留 | 代码已固化 default-on / retired；不应重新注册成可操作 flag。 |
| `FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN` | allowlist (`secret`) | 凭据，严禁进入 registry DTO / console。 |
| `FLYWHEEL_ALERT_RATE_PER_MIN` | allowlist (`numeric config`) | 速率参数，不是 bool flag；后续进入 typed config。 |
| `FLYWHEEL_ALERT_THREADS` | 注册 `readonly`，先标 restart-required | bool 冷开关；先可见，待逐 consumer 证明 call-time 后再评估 direct。 |
| `FLYWHEEL_AUTO_REPAIR` | 注册 `readonly`，先标 restart-required | 自动修复机制开关；有副作用，需单独 TDD/授权审查后才能 direct。 |
| `FLYWHEEL_CLAUDE_INFRA_BOT_USER_ID` | allowlist (`identity config`) | Discord identity，不是 feature flag。 |
| `FLYWHEEL_DETECTION_GAP_SCAN` | 注册 `readonly`，先标 restart-required | 扫描器机制开关；composition/wiring 读点需 follow-up 精确枚举。 |
| `FLYWHEEL_INFRA_BOT_CHAT_CHANNEL_ID` | allowlist (`routing config`) | Discord routing id，不是 flag。 |
| `FLYWHEEL_NOTIFY_CHANNEL` | allowlist (`routing config`) | 通知目的地，不是 bool flag。 |
| `FLYWHEEL_NOTIFY_DIGEST_EXPECT` | allowlist 后删除生产残留 | 已 retired / default-on；保留只会制造假控制面。 |
| `FLYWHEEL_PANE_MULTIFRAME` | 注册 `readonly`，先标 restart-required | bool UI/runtime 开关；需验证 pane consumer 是否逐调用读取。 |
| `FLYWHEEL_ROUNDTABLE_BOT_TOKEN_ENV` | allowlist (`secret locator`) | 只保存 token 的 env-var 名，仍属于凭据供给链，不进 console。 |
| `FLYWHEEL_ROUNDTABLE_BOT_USER_ID` | allowlist (`identity config`) | Discord identity。 |
| `FLYWHEEL_ROUNDTABLE_CHANNEL_ID` | allowlist (`routing config`) | channel 本身已是 de facto enable gate；不是独立 bool flag。 |
| `FLYWHEEL_ROUNDTABLE_ENABLED` | allowlist 后删除生产残留 | 代码明确 retired；channel presence 才是现行门。 |
| `FLYWHEEL_ROUNDTABLE_GUILD_ID` | allowlist (`routing config`) | Discord guild identity。 |
| `FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD` | 注册 `readonly` 或迁 typed config | bool 行为偏好；非紧急控制，先保持只读。 |
| `FLYWHEEL_ROUNDTABLE_TRIGGER_MODE` | allowlist (`enum config`) | enum，不是方向明确的 bool flag；应 typed config。 |
| `FLYWHEEL_RUNNER_BACKEND` | allowlist (`legacy selector`) | 值型 backend 选择；已有 roles/runner SSOT，不应做 bool toggle。 |
| `FLYWHEEL_SANDBOX_REMOTE_URL` | allowlist (`endpoint config`) | endpoint plumbing，可能含基础设施信息；不进 flag DTO。 |
| `FLYWHEEL_STUCK_ERRORSIG` | 注册 `readonly`，先标 restart-required | bool 检测策略开关；需独立验证错误签名缓存/构造时机。 |
| `FLYWHEEL_SWAP_PRESSURE_HIGH_PCT` | allowlist (`numeric config`) | 数值阈值，迁 typed config。 |
| `FLYWHEEL_SWAP_PRESSURE_LOW_PCT` | allowlist (`numeric config`) | 数值阈值，迁 typed config；与 HIGH 成对校验。 |
| `FLYWHEEL_XHS_REVIEW` | 注册 `readonly`, restart-required | route mount 属 boot wiring；可见但不能假装热切。 |

### Follow-up batches

1. Secrets/config allowlist：token、identity、routing、URL、numeric/enum 共 15 项，附结构化理由并补 drift positive control。
2. Retired cleanup：`ACCOUNT_SELF_HEAL`、`NOTIFY_DIGEST_EXPECT`、`ROUNDTABLE_ENABLED` 共 3 项，从生产 `.env` 删除前走独立变更审查。
3. Bool visibility：`ALERT_THREADS`、`AUTO_REPAIR`、`DETECTION_GAP_SCAN`、`PANE_MULTIFRAME`、`STUCK_ERRORSIG`、`XHS_REVIEW` 共 6 项，先 readonly 可见；逐 consumer TDD 后再决定 direct。
4. Roundtable preference：`ROUNDTABLE_REPLY_IN_THREAD` 可与 Roundtable typed-config 清理合并；上表 24 行的批次统计将其归 config migration，不归 direct flag。

## Readonly baseline correction table

`baseline timing` 来自设计 head 的注册表；`FLY-1344 处置` 是本 PR 的差异或明确不动结论。`dotenv_live` 表示独立 CLI 每次从共享 `.env` 读取，不等于 runner 继承的启动快照。

| Name | Source | Baseline timing | FLY-1344 处置 |
|---|---|---|---|
| `lead_dual_active_scan` | env | object_construction + call_time | 保持 readonly；mixed 冷路径。 |
| `quota_daemon_cutover` | env | object_construction | 保持 readonly / restart-required。 |
| `merge_approval_gate_killswitch` | env | call_time | **修正为 call_time + dotenv_live**；授权应急阀仍 readonly。 |
| `qa_done_gate_killswitch` | env | call_time | **修正为 call_time + dotenv_live**；授权应急阀仍 readonly。 |
| `three_stage_killswitch` | env | call_time | 保持 readonly；项目 config 是主控制。 |
| `three_stage_keepalive_killswitch` | env | call_time | 保持 readonly。 |
| `three_stage_qa_respawn_killswitch` | env | call_time | 保持 readonly。 |
| `three_stage_codex_implement_killswitch` | env | call_time | 保持 readonly。 |
| `three_stage_codex_design_toggle` | env | call_time | 保持 readonly。 |
| `boot_sha_check` | env | call_time | 保持 readonly。 |
| `progress_resume_killswitch` | env | call_time | 保持 readonly。 |
| `cmux_close_request_killswitch` | env | call_time | 保持 readonly。 |
| `founder_auto_approve` | env | call_time | 保持 readonly；授权相关。 |
| `stale_ship_rewake` | env | call_time | 保持 readonly。 |
| `auto_linear_done` | env | call_time | 保持 readonly。 |
| `deferred_founder_approval` | env | call_time | 保持 readonly；授权相关。 |
| `held_declined_reply` | env | call_time | 保持 readonly。 |
| `deferred_approval_ttl_ms` | env | call_time | 值型参数，保持 readonly。 |
| `founder_notify_retry_max` | env | call_time | 值型参数，保持 readonly。 |
| `codex_hold_nudge` | env | call_time | 保持 readonly。 |
| `codex_hold_nudge_ms` | env | call_time | 值型参数，保持 readonly。 |
| `founder_reply_retry_max` | env | call_time | 值型参数，保持 readonly。 |
| `founder_reply_deadletter_age_ms` | env | call_time | 值型参数，保持 readonly。 |
| `founder_reply_watchdog` | env | call_time | 保持 readonly。 |
| `zombie_gate_resolve` | env | call_time | 保持 readonly。 |
| `lead_cross_dept_channel_ids` | env | object_construction | 值型 routing config，restart-required。 |
| `reports_ttl_days` | env | object_construction | 值型参数，restart-required。 |
| `founder_consent_decision_mode` | env | call_time | 保持 governance-readonly。 |
| `founder_attribution_gate` | env | cli_invocation | 保持 governance-readonly。 |
| `comm_bypass_bridge` | env | cli_invocation | 保持 governance-readonly。 |
| `lead_lease_bypass` | env | cli_invocation | 保持 governance-readonly。 |
| `ponytail` | project_config | call_time | 保持 dormant readonly；非 env 冷开关。 |
| `founder_ux_gate` | project_config | call_time | 保持 governance-readonly；非 env 冷开关。 |
| `founder_ux_gate_killswitch` | env | call_time | 保持 governance-readonly。 |
| `runner_autocontinue` | env | bridge_boot + call_time | 保持 readonly；mixed 冷路径。 |
| `stuck_founder_page_killswitch` | env | call_time | 保持 readonly。 |
| `fleet_sensor_tmux_killswitch` | env | object_construction | 保持 readonly / restart-required。 |
| `done_thread_reconcile_interval_min` | env | call_time | 值型参数，保持 readonly。 |
| `done_thread_reconcile_dryrun` | env | call_time | 保持 readonly；非本单控制面。 |
| `done_thread_reconcile_max_per_run` | env | call_time | 值型参数，保持 readonly。 |
| `publish_broker` | env | bridge_boot | 保持 readonly / restart-required。 |
| `workflow_template_dispatch` | env | call_time | **移出 readonly → feature/direct**；精确 consumer proof 已进测试。 |
| `workflow_generalized_templates` | env | call_time | **移出 readonly → feature/direct**。 |
| `workflow_claims_write` | env | call_time + bridge_boot | **移出 readonly → feature/direct**；删除 boot capture，改 start-scope hot runtime + reQA use-time。 |
| `workflow_claims_read` | env | call_time + cli_invocation | **移出 readonly → feature/direct**；修正为 call_time + dotenv_live + verify-approval live reader。 |
| `workflow_force_legacy` | env | cli_invocation | **移出 readonly → kill_switch/direct**；修正为 call_time + dotenv_live，仍不进入 dispatch 谓词。 |
| `delivery_secret_path` | env | object_construction | secret path，保持 readonly / restart-required。 |
| `terminal_thread_archive` | env | bridge_boot | 保持 readonly / restart-required。 |

## Reproducibility

- 设计基线 readonly：从 `git show eb25b6035:packages/config/src/feature-flags/registry.ts` transpile 后过滤 `toggleable === "readonly"`。
- 未注册 key：只提取生产 `.env` 的 key 名，与 registry envVar + drift allowlist 做集合差；没有输出 value。
- 本 PR 结束时预期：48 baseline readonly − 5 DAG direct = 43 total readonly（41 env + 2 project_config）；merge/QA 两杆仍在 readonly，只改 timing。
