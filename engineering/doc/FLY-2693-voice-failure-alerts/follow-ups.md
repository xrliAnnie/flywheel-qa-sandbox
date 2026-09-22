# FLY-2693 语音健康与失败告警 — 调研
Issue: FLY-2693 (https://linear.app/geoforge3d/issue/FLY-2693)
日期: 2026-09-17
基于: plan.md

- 非阻断 MEDIUM `no-repage-policy-for-long-running-episode`：当前一故障一次工程频道消息，固定页持续显示；消息可能被淹没。Flywheel Engineering Lead通过现有固定页巡检持续处理；未来老化再提醒的频次和预算由Lead决定，本单不新增调度器。已在plan明确限制，保留建议，非未修复HIGH。
- FLY-2701：founder硬要求按需模式；继承plan §7/附录A，依赖2693+2655。不得重新宣称recover可自动重连。
- 本地两图各两次mmdc均被MachPort沙箱拒绝；保留Mermaid图稿与明确占位。可用环境后本地渲染，不使用远程服务。

## R2 有效APPROVED附带的非阻断建议

以下是实现后的逐项处置；不将批准重新降级或重开设计。

- **已处理** MEDIUM `demand-digest-field-scope-undefined`：snapshot digest 只绑定 trigger 实际观察的 `state`、`reason`、`cancel_requested_at`、`ending_started_at`、`ended_at`（另含稳定 session identity），无关字段更新不改变 revision/digest；trigger 合同摘要变化会轮换 source 并重装已知旧合同。
- **部分处理，保留 follow-up** MEDIUM `bootstrap-spool-path-escapes-isolation-contract`：同一 spool 的多个 Bridge 进程以 OS 释放的 flock 串行 claim，helper 确认前不删原件，成功后原子归档；崩溃、并发读取、unsafe path 与容量边界均有回归。固定 HOME spool 在不同 state-root Bridge incarnation 间仍无独立 namespace，后续 isolation-boundary 工作不得把本单的锁当成跨 root 归属证明。
- **已处理** LOW `wal-autocheckpoint-not-disabled`：helper 明确设置 `wal_autocheckpoint=0`；事务 commit 后才做有界 `PASSIVE` checkpoint，checkpoint 争用不把已提交记录回报成失败。
- **部分处理，保留 follow-up** LOW `unrecoverable-manual-episodes-accumulate-in-active-area`：本单拒绝用相邻时间或同项目猜测恢复，杜绝假恢复；manual demand 没有显式 retry 链时的老化/预算仍未实现，固定页活动区累积风险保留给 FLY-2701/后续 retention 设计。
- **按批准限制保留 follow-up** MEDIUM `no-repage-policy-for-long-running-episode`：同一 episode 不周期刷频道；固定页持续显示，可信恢复后熄灭，再次故障生成新 episode。老化再提醒的频次与预算仍由 Lead 后续决定。

## Code review R3 非阻断建议

- **保留 follow-up** MEDIUM `startup-spool-lock-500ms-budget`：startup spool 的 Python process-lock ready budget 仍为 500 ms；高负载下的更宽预算或有限重试须与 projector cadence 一起校准。
- **保留 follow-up** MEDIUM `projector-cursor-conflict-from-wallclock-change-rows`：evaluate/claim/delivery change 的 wall-clock `changed_at` 尚未回写 health row；后续需让相同 cursor 的投影完全确定。
- **保留 follow-up** MEDIUM `demand-source-degradation-never-reaches-health-source`：trigger-invalid/change-gap/overflow 的 StateStore 降级尚未全部传入 health helper；本单已覆盖 snapshot digest mismatch，但不能把它宣称为全部 demand-source degradation 覆盖。
- **保留 follow-up** MEDIUM `voice-health-store-has-no-retention`：ledger 与 change history 尚无 retention/compaction；需同时保证 active intent 不被历史窗口挤出。
- **保留 follow-up** MEDIUM `pause-abort-listener-leak`：daemon pause 的正常 timer 路径尚未移除长寿命 AbortSignal listener。
- **保留 follow-up** MEDIUM `config-error-intent-retries-forever`：永久 route config error 尚无 attempt cap / dead-letter 终点。
- **已处理** MEDIUM `heartbeat-stale-never-produced`：`heartbeat_stale` 已由 `evaluate_health` 按真实 `lastIterationSuccessAt`（idle）/ `lastProgressAt`（active）的 60 秒边界生产（见里程碑「Lead 裁定必修两项」段）。
- **已处理** LOW `idle-http-timeout-registered-bounded-but-unbounded`：allowlist 说明改为真实的 positive-integer tuning，不再声称存在未实现的上界。
- **保留 follow-up** LOW `voice-health-alert-route-module-unused`：TypeScript route helper 当前不是生产 sender 路径；后续应接线或删除，避免两份 digest 合同漂移。

## Code review R5 逐项处置（Lead 裁定：5 HIGH 全修；MEDIUM/LOW 进 Follow-ups）

复审 request `d4608668`（同家族 Claude 复审，头 `6a33134ca`）。完整原文见 `review-r5.json`。

- **已处理** HIGH `stale-gate-uses-frozen-data-clock`（`packages/teamlead/src/StateStore.ts:3812`）：getVoiceDemandSnapshot.observedAt is a frozen data timestamp, never an observation clock, so the 90s stale gate permanently wins。 runtime 用 Bridge 观察时钟盖 record-demand 的 observedAt（`9fb1ecac8`）
- **已处理** HIGH `render-stale-branch-drops-active-incidents`（`packages/teamlead/src/epic-page/render-html.ts:618`）：The unknown/stale/unavailable early-return precedes the unhealthy branch, so HTML and Markdown silently drop every active incident the JSON still carries。 HTML/Markdown 在 unavailable/stale/unknown 下保留活动故障并加 caveat（`9fb1ecac8`）
- **已处理** HIGH `fail-closed-demand-never-reaches-helper`（`packages/teamlead/src/bridge/voice-health-demand-recorder.ts:47`）：trigger_invalid / change_gap / demand_overflow snapshots are discarded in the Bridge, so a dropped trigger renders as dormant instead of unknown。 fail-closed 快照透传 helper 并发布 unknown/unavailable（`9fb1ecac8`）
- **已处理** HIGH `warming-lease-suppresses-startup-guard`（`packages/teamlead/src/bridge/voice-health-projector.ts:807`）：A claimed/warming session with a renewing lease is excluded from the 60s startup_not_ready guard forever and is rendered healthy。 按 plan §3 加 createdAt+60s+60s grace 上限（`9fb1ecac8`，R4 排除被 R5 按 plan §3 收回）
- **已处理** HIGH `progress-clears-unverified-failure-window`（`scripts/lib/voice-health.py:2587`）：A lease-renew progress zeroes failure_streak AND re-anchors first_failure_at, defeating both alert thresholds。 progress 不再清零 failure_streak / first_failure_at（`9fb1ecac8`）
- **保留 follow-up** MEDIUM `stray-file-in-spool-dir-permanently-disables-reporter`（`packages/voice-codex/src/health.ts:1092`）：One unexpected file in the pending spool directory permanently disables the entire daemon-side health reporter across every restart。
- **保留 follow-up** MEDIUM `transient-demand-failure-suppresses-startup-episode`（`scripts/lib/voice-health.py:1799`）：record_startup opens an episode only if demand_state is 'required' at that instant, and the duplicate short-circuit prevents re-evaluation。
- **保留 follow-up** MEDIUM `no-action-burns-producer-event-key`（`scripts/lib/voice-health.py:2389`）：no_action() inserts the producer_events row, so a recovery observation is consumed permanently and its incident can never be cleared。
- **保留 follow-up** MEDIUM `session-ended-fabricates-poll-success`（`scripts/lib/voice-health.py:2769`）：A session_ended event writes last_iteration_success_at and success_count, the poll-scope success markers。
- **保留 follow-up** MEDIUM `evaluate-missing-stale-branch-for-terminal-phases`（`scripts/lib/voice-health.py:1908`）：evaluate_health has no staleness branch for starting / session_ended / session_failed / dormant / stopped。
- **保留 follow-up** MEDIUM `no-retention-and-20s-noop-change-rows`（`scripts/lib/voice-health.py:1321`）：No retention anywhere in the source store, and the 20s demand refresh appends a no-op change row plus triggers an Epic-page refresh every 60s。
- **保留 follow-up** MEDIUM `curl-transport-failure-becomes-terminal-delivery-unknown`（`scripts/lead-alert.sh:1083`）：A curl transport failure (exit 6/7, provably nothing sent) is collapsed to delivery_unknown, which is never retried and never re-minted。
- **保留 follow-up** MEDIUM `startup-spool-import-gated-on-single-identity`（`packages/teamlead/src/bridge/voice-health-projector.ts:754`）：Bootstrap startup-spool events are imported only when there is exactly one demand identity。
- **保留 follow-up** MEDIUM `startup-spool-reader-home-anchored-not-state-root`（`packages/teamlead/src/bridge/plugin.ts:7227`）：createVoiceHealthStartupSpoolReader() is constructed with no root while every sibling in the same call gets FLYWHEEL_STATE_DIR, so an isolated Bridge reads and can consume the host's production spool。
- **保留 follow-up** MEDIUM `null-current-projection-rejected-as-record`（`packages/teamlead/src/bridge/voice-health-projector.ts:196`）：validateExport's `currentProjection === undefined` guard does not catch the helper's JSON null, so a source with no health row fails every tick。
- **已处理** MEDIUM `truncated-renders-identical-to-complete`（`packages/teamlead/src/epic-page/render-html.ts:630`）：sourceStatus 'truncated' renders byte-identical to 'complete'; dropped episodes get no warning。 truncated 在两种渲染面加「活动故障列表已截断」caveat（`9fb1ecac8`）
- **已处理** MEDIUM `result-write-erases-demand-source-unavailable`（`scripts/lib/voice-health.py:2456`）：Every record_result branch writes source_status='available', erasing record_demand's fail-closed demand_source_unavailable marker。 record_result / evaluate 通过 `_restore_demand_marker` 保留 demand_source_unavailable 标记（`9fb1ecac8`）
- **保留 follow-up** MEDIUM `pause-abort-listener-leak`（`packages/voice-codex/src/cli.ts:51`）：pause() never detaches its abort listener on the timer path, and this PR newly feeds it a long-lived AbortSignal on every idle poll。
- **保留 follow-up** MEDIUM `lease-ttl-unvalidated-nan-deadline`（`packages/voice-codex/src/bridge-client.ts:306`）：claim/renew install the lease from an unvalidated body.leaseTtlMs, so a malformed 2xx produces a NaN deadline that never fences plus a 1ms timer spin。
- **保留 follow-up** MEDIUM `record-delivery-no-post-timeout-idempotency`（`scripts/lib/voice-health.py:3100`）：record_delivery has no post-timeout idempotency key, so a worker cannot confirm its own committed write。
- **保留 follow-up** MEDIUM `demand-events-never-pruned-replayed-from-zero`（`packages/teamlead/src/bridge/voice-session-runtime.ts:32`）：voice_health_demand_events is retention-protected forever while the consuming cursor is in-memory, so Bridge restarts replay the whole history。
- **保留 follow-up** MEDIUM `demand-event-drops-cancel-and-previous-state`（`packages/teamlead/src/bridge/voice-health-demand-recorder.ts:30`）：demandEvent() drops cancelRequested / endingStarted / previousState, so the helper cannot tell a cancelled demand from a dependency failure。
- **保留 follow-up** MEDIUM `claim-path-failures-classified-as-poll-dependency`（`packages/voice-codex/src/daemon.ts:698`）：claim/setState/outbound/receipt failures propagate to the poll path and are recorded as poll_dependency, which a later idle_success closes。
- **保留 follow-up** MEDIUM `terminal-setstate-failure-unobserved`（`packages/voice-codex/src/daemon.ts:650`）：A failure to report the terminal session state to the Bridge is swallowed with no health observation。
- **保留 follow-up** MEDIUM `realtime-heartbeat-test-wallclock-flake`（`packages/voice-codex/src/__tests__/health-heartbeat-realtime.test.ts:70`）：A 135s real-wall-clock test whose iteration-count assertion tolerates only one lost iteration。
- **保留 follow-up** MEDIUM `config-error-alert-retry-unbounded`（`packages/voice-codex/src/health-alert.ts:101`）：config_error and invalid receipts retry every 30s forever with no cap, no backoff and no dead-letter transition。
- **保留 follow-up** LOW `bridge-startup-blocked-by-voice-health-tick`（`packages/teamlead/src/bridge/plugin.ts:13414`）：The voice-health tick is the only projector awaited ahead of gatePoller.start(); bounded, but an unnecessary boot dependency。
- **保留 follow-up** LOW `voice-health-alert-route-module-unused`（`packages/teamlead/src/bridge/voice-health-alert-route.ts:24`）：The new TypeScript route/bindingDigest module has zero production importers。
- **已记录** LOW `helper-blocks-on-inherited-stdin`（`scripts/lib/voice-health.py:3437`）：main() reads stdin unconditionally for every subcommand, so any caller that does not close stdin hangs forever with no deadline。 macOS 本地跑 helper 套件需 `</dev/null`；CI stdin 已关闭。加 stdin 截止时间留 follow-up
- **已处理** LOW `follow-ups-claims-heartbeat-stale-has-no-producer`（`engineering/doc/FLY-2693-voice-failure-alerts/follow-ups.md:28`）：A shipped follow-ups entry asserts heartbeat_stale has no producer; it does。 本文件 R3 条目已更正——`heartbeat_stale` 已由 evaluate_health 按真实 lastIterationSuccessAt / lastProgressAt 生产
- **保留 follow-up** LOW `fatal-startup-error-detail-dropped`（`packages/voice-codex/src/startup-alert.ts:46`）：reportFatalStartupFailure discards the error entirely, leaving zero diagnostic for a daemon that will not start。
- **保留 follow-up** LOW `bridge-url-hard-loopback-only`（`packages/voice-codex/src/config.ts:45`）：validateVoiceBridgeUrl hard-fails any non-loopback BRIDGE_URL with no allowlist。
- **保留 follow-up** LOW `shuttle-permission-fixture-inherited-by-voice`（`scripts/lead-alert.sh:633`）：The voice alert lane silently inherits SHUTTLE_ROUTE_PERMISSION_FIXTURE as a permission-preflight override。
- **保留 follow-up** LOW `openedat-regex-not-anchored`（`scripts/lead-alert.sh:761`）：The frozen-payload openedAt gate is prefix-only while every sibling field is fully anchored。
- **保留 follow-up** LOW `demand-digest-omits-identity-columns`（`packages/teamlead/src/StateStore.ts:3794`）：The demand digest omits project_name and meeting_id, and neither column is in the trigger's UPDATE OF list。
- **保留 follow-up** LOW `ci-step-seconds-comment-understated`（`.github/workflows/ci.yml:1408`）：The FLY-2693 step documents '~10 locally' but the three suites take 31-35s。

## Code review R6 逐项处置（APPROVED；Lead review-ruling 收口）

复审 request `4e773e4c`（同家族 Claude 复审，头 `d40241c45`）返回 APPROVED，无 HIGH；19 MEDIUM + 10 LOW 中 27 项与 R5 同 key，沿用上文 R5 处置。完整原文见 `review-r6.json`。新增三项：

- **已处理** MEDIUM `realtime-heartbeat-test-wallclock-flake`：复审在负载机上复现 135 秒窗口只出 1 条 heartbeat（20 秒聚合定时器漂移）。按 Lead 裁定改为按测试自己提交的观测跨度推导期望下限 floor((span − 20s − 10s)/60s) 且 ≥1，运行 165 秒以保住 R3 的「≥2 条」要求；间隔断言不变。test-only。
- **保留 follow-up** LOW `leased-startup-grace-shorter-than-presence-grace`：持租约的 claimed/warming 会话 60s+60s 上限比 daemon 从 claim 起算的 120 秒 presence grace 紧 5–25 秒，founder 在行创建后 >~110 秒才入频道时会收到一次自愈的 startup_not_ready 告警；上限已是 plan §3 60 秒边界的两倍。后续可改为按 presenceGraceMs 推导或锚定 desired→claimed。
- **保留 follow-up** LOW `demand-marker-restore-drops-reason-class`：`_restore_demand_marker` 恢复 source_status / demand_state（页面判定正确），但 idle_success 仍把 reason_class 置空，丢失「为何不可用」的诊断字段；后续一并恢复 reason_class。
