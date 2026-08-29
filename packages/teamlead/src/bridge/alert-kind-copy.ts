/** Shared copy and stable event-id contract for every alert kind. */

import { createHash } from "node:crypto";
import type { AlertEventType, AlertPayload } from "../LeadAlertNotifier.js";

export function computeEventId(
	projectName: string,
	leadId: string,
	kind: AlertEventType,
	signature: string,
): string {
	return createHash("sha1")
		.update(`${projectName}|${leadId}|${kind}|${signature}`)
		.digest("hex");
}
export function titleFor(kind: AlertEventType): string {
	switch (kind) {
		case "rate_limit":
			return "Lead hit rate limit";
		case "usage_limit":
			return "Lead hit usage limit";
		case "login_expired":
			return "Lead login expired";
		case "permission_blocked":
			return "Lead waiting on permission prompt";
		case "crash_loop":
			return "Lead crash-looping";
		case "pane_hash_stuck":
			// Legacy display-only kind; nothing in-process emits it after FLY-1570.
			return "Lead pane has been frozen";
		// FLY-1048 (A4): multi-frame veto 1 — a known error signature frozen in
		// an otherwise idle-looking live region.
		case "pane_error_stalled":
			return "Lead pane error-stalled";
		// Legacy display-only kinds retained for persisted alert rows.
		case "detection_fleet_aggregate":
			return "Fleet-scale detection incident";
		case "detection_page_undeliverable":
			return "Detection founder-page undeliverable";
		case "delivery_dead_letter":
			return "Lead delivery dead-lettered";
		case "inbox_loop_stalled":
			return "Lead inbox consume loop stalled";
		case "orphan_pane":
			return "Runner pane has no owner";
		case "mailbox_dead_letter":
			return "Mailbox messages exhausted their acknowledgement lease";
		case "legacy_row_quarantined":
			return "Legacy inbox row quarantined during cutover";
		// FLY-1402: emitted only by the Claude launcher through lead-alert.sh.
		case "rules_bundle_legacy":
			return "Lead rules bundle legacy mode";
		case "workflow_route_input_rejected":
			return "Work-kind dispatch input rejected";
		case "stale_approved_ship_dead":
			return "Approved ship runner is dead";
		case "runner_pane_loss":
			return "Runner pane/body ownership lost";
		case "ship_attempt_failed":
			return "Founder-approved ship attempt failed";
		case "complete_marker_held":
			return "Workflow completion marker held";
		// FLY-195: never routed through this table (the stuck-runner detector owns
		// it and builds its own title); case exists for switch exhaustiveness.
		case "runner_stuck_unhandled":
			return "Runner stuck unhandled";
		// FLY-579: retained historical kind with dedicated caller copy
		// title); case exists for switch exhaustiveness.
		case "auto_qa_stuck":
			return "Review or ship authorization held";
		// FLY-793: never routed through this table (the workflow engine builds its
		// own title); case exists for switch exhaustiveness.
		case "three_stage_stuck":
			return "DAG workflow stuck";
		case "three_stage_takeover_failed":
			return "DAG workflow worktree takeover failed";
		case "workflow_engine_escalation":
			return "Workflow engine recovery escalated";
		case "workflow_engine_issue_alert":
			return "Workflow dead-execution safety alert";
		// FLY-637-ext: never routed through this table (the lead-pending escalation
		// builds its own title); case exists for switch exhaustiveness.
		case "runner_lead_pending_unhandled":
			return "Runner waiting — Lead unresponsive";
		// The founder-gate fallback builds its own title; this case keeps the shared
		// switch exhaustive for other delivery surfaces.
		case "founder_gate_delivery_failed":
			return "Founder gate ping undelivered";
		// FLY-827: never routed through this table (CodexReviewEffects builds its own
		// title); case exists for switch exhaustiveness.
		case "codex_gate_blocked":
			return "Codex code review not passed";
		// FLY-1278: emitted by the review coordinator, not this table.
		case "review_advisory_pass":
			return "Review passed with non-blocking advisories";
		case "review_ruling_recorded":
			return "Lead review ruling recorded";
		case "review_ruling_disputed":
			return "Reviewer disputed a Lead ruling";
		case "review_ruling_notify_failed":
			return "Review ruling audit post failed";
		// FLY-871 R2/C8: never routed through this table (the runner auth scan owns
		// it and builds its own title); case exists for switch exhaustiveness.
		case "runner_login_expired":
			return "Runner logged out";
		// FLY-871 §12 W2: never routed through this table (the windowed-TUI runtime
		// guard fires it directly via scripts/lead-alert.sh with its own title);
		// case exists for switch exhaustiveness.
		case "tui_window_lost":
			return "Infra Bot TUI window not visible";
		// FLY-913: never routed through this table (the restart-guard hook fires it
		// directly via scripts/lead-alert.sh --strict-delivery with its own
		// title); case exists for switch exhaustiveness.
		case "restart_guard_bypass":
			return "Restart-guard BYPASS used";
		// FLY-1501: shell/Python gate supplies the concrete title; this keeps the
		// shared union switch readable if a queued record is rendered later.
		case "restart_storm_hold":
			return "Service restart storm held";
		// FLY-939 (G-D): never routed through this table (boot-sha-check builds its
		// own title); case exists for switch exhaustiveness.
		case "bridge_boot_stale_checkout":
			return "Bridge running a STALE checkout";
		// FLY-927 (D4): never routed through this table (the bridge wrapper fires it
		// via scripts/lead-alert.sh with its own title); case exists for switch
		// exhaustiveness.
		case "bridge_wrapper_fail":
			return "Bridge wrapper fail-loud";
		// Legacy persisted event kind; retained for rendering old queued rows.
		case "runner_throttle_stalled":
			return "Runner stalled after throttle";
		// FLY-954: never routed through this table (converge-flywheel-bin.sh fires
		// it via lead-alert.sh with its own title); case exists for switch
		// exhaustiveness.
		case "bin_integrity_drift":
			return "bin runtime script drift";
		// FLY-1676: emitted by the launcher / deploy guard through
		// lead-alert.sh. This case keeps the shared alert-kind union exhaustive.
		case "discord_plugin_integrity_failed":
			return "Discord plugin fork integrity failed";
		// FLY-945: never routed through this table (the external-merge reconcile
		// pass builds its own title); case exists for switch exhaustiveness.
		case "external_merge_suspect":
			return "Unverified external merge";
		// FLY-929: never routed through this table (the notify-digest expect tick /
		// token-usage-daily.sh build their own titles); case exists for switch
		// exhaustiveness.
		case "notify_digest_failed":
			return "Daily token report not delivered";
		// FLY-1099: never routed through this table (the founder-reply unreachable reconcile /
		// action-ledger drain build their own titles); cases exist for switch
		// exhaustiveness.
		case "founder_reply_pass_dead":
			return "Founder-reply ingest pass DEAD";
		case "founder_reply_pinned":
			return "Founder reply stuck (cursor pinned)";
		case "founder_reply_dead_letter":
			return "Founder reply dead-lettered";
		case "founder_notify_dead_letter":
			return "Founder notify dead-lettered";
		case "founder_reply_unreachable_runner":
			return "Runner unreachable for founder replies";
		case "commdb_finalize_stuck":
			return "CommDB finalization stuck";
		case "merged_gate_guard_unavailable":
			return "Merged gate guard unavailable";
		// FLY-1081: never routed through this table (restart-services.sh /
		// update-flywheel.sh fire these via scripts/lead-alert.sh with their own
		// titles); cases exist for switch exhaustiveness.
		case "deploy_failed":
			return "Flywheel deploy failed";
		case "deploy_degraded":
			return "Flywheel deploy degraded";
		// FLY-1256: never routed through this table; the external quota monitor
		// supplies its own title. Cases keep the shared union exhaustive.
		case "account_switched":
			return "Claude account switched";
		case "account_switch_degraded":
			return "Claude account switched with degraded verification";
		case "machine_account_conflict":
			return "Claude account identity conflict";
		case "model_config":
			return "Lead model policy fallback";
		case "model_cap_switched":
			return "Claude model-cap account switched";
		case "model_cap_unknown":
			return "Claude model cap temporarily ambiguous";
		case "model_cap_persistent_unknown":
			return "Claude model cap persistently ambiguous";
		case "model_bench_malformed":
			return "Claude model bench state malformed";
		case "quota_choice":
			return "Claude requires a manual model choice";
		case "quota_switch_confirmation":
			return "Claude quota switch recovery confirmation";
		case "quota_no_target":
			return "No Claude account has quota";
		case "quota_blocked_recovered":
			return "Claude quota block recovered";
		case "quota_read_blind":
			return "Claude quota monitor is blind";
		case "account_switch_failed":
			return "Claude account switch failed";
		case "account_identity_mismatch":
			return "Claude account identity mismatch";
		case "quota_revive_stuck":
			return "Claude pane revive stuck";
		case "quota_monitor_down":
			return "Claude quota monitor down";
		case "quota_guard_bypassed":
			return "Claude quota guard BYPASSED manually";
		// FLY-1082: fleet kinds — never routed through this table (the fleet
		// sensors / server-loss coordinator / boot self-check build their own
		// titles); cases exist for switch exhaustiveness.
		case "swap_pressure_high":
			return "Swap pressure high (OOM early warning)";
		case "tmux_server_lost":
			return "tmux server lost (fleet-level)";
		case "tmux_hold":
			return "tmux safety hold";
		case "tmux_split_brain":
			return "tmux split brain";
		case "bridge_abnormal_exit":
			return "Bridge died without a clean shutdown";
		case "infra_bot_down":
			return "Infra bot down";
		case "zombie_session_backlog":
			return "Cross-Lead zombie session backlog";
		case "lead_dual_active":
			return "Multiple active Lead processes share one identity";
		case "lead_dual_active_sensor_degraded":
			return "Lead identity process sensor degraded";
		case "lead_lease_store_broken":
			return "Lead identity lease store unavailable";
		case "lead_lease_bypass_used":
			return "Lead identity lease bypass used";
		case "lead_lease_would_block":
			return "Lead identity lease would block a write";
		case "lead_lease_control_broken":
			return "Lead identity lease control plane broken";
		case "lead_identity_source_broken":
			return "Canonical Lead identity source broken";
		case "lead_backend_drift":
			return "Lead carrier/backend identity drift";
		case "cmux_cleanup":
			return "cmux cleanup needs operator review";
		case "cmux_watcher_stalled":
			return "cmux watcher is stalled or unsupervised";
		case "flag_scan_failed":
			return "Weekly flag scan failed closed";
		case "flag_scan_handoff":
			return "Weekly flag scan founder handoff";
		case "flag_scan_no_clock":
			return "Weekly flag scan has no trustworthy clock";
		case "tmux_rescue_hold":
			return "tmux rescue lock held too long";
		case "host_voucher_incident":
			return "Host IPC-voucher incident (kernel panic risk)";
	}
}

export function severityFor(kind: AlertEventType): AlertPayload["severity"] {
	if (
		kind === "crash_loop" ||
		kind === "login_expired" ||
		kind === "runner_login_expired" ||
		kind === "cmux_watcher_stalled"
	)
		return "severe";
	if (kind === "permission_blocked") return "warning";
	return "warning";
}

/**
 * Fix 5: per-kind alert body with concrete remediation. We deliberately do
 * NOT include raw pane content — Lead panes can contain customer prompts,
 * memory excerpts, internal IDs, or partial secrets. The kind + actionable
 * suggestion is enough for Annie to decide what to do; she can always open
 * the tmux pane for full context.
 */
export function bodyFor(kind: AlertEventType, _pane: string): string {
	switch (kind) {
		case "rate_limit":
			return "Anthropic API rate limit reached. Wait ~1 hr for reset, or check whether the Lead is in a tight loop.";
		case "usage_limit":
			return "Claude Code usage limit hit. Top up Anthropic billing (https://console.anthropic.com/settings/billing) and re-run.";
		case "login_expired":
			return "Claude CLI login expired. Re-run `claude login` on the Lead host, then restart the Lead.";
		case "permission_blocked":
			return "Lead is waiting on a permission prompt that cannot be auto-confirmed. Approve / deny it in the Lead's tmux pane.";
		case "crash_loop":
			return "Lead has crashed repeatedly. Check its launchd and startup logs under ~/.flywheel/logs/ — likely Claude CLI / config issue.";
		case "pane_hash_stuck":
			// Legacy display-only kind; nothing in-process emits it after FLY-1570.
			return "Lead pane has been frozen for several poll cycles with no recognizable blocked-prompt pattern. Open the tmux pane to investigate.";
		// FLY-1048 (A4): deliberately does NOT echo the matched error line
		// (FLY-220 echo immunity) — kind + suggested action only.
		case "pane_error_stalled":
			return "A known error is frozen in the Lead's live pane (error visible above an idle input box across multiple polls). The Lead likely errored and stopped; open the tmux pane and nudge or recover it.";
		// Legacy display-only kinds retained for persisted alert rows.
		case "detection_fleet_aggregate":
			return "Several detection episodes of the same kind went unhandled at once — a fleet-scale incident. The founder was NOT paged per-episode; investigate the shared cause (Bridge, transport, or a fleet-wide runner condition).";
		case "detection_page_undeliverable":
			return "A detection founder page could not be addressed or posted (no session, no thread binding, or the POST failed). The episode stays LEAD_NOTIFIED and keeps retrying; fix the thread binding / bot token / routing.";
		case "delivery_dead_letter":
			return "A Lead-directed event exhausted bounded transport or acknowledgement retries. The founder was paged because the owning Lead path did not consume it.";
		case "inbox_loop_stalled":
			return "A Lead inbox consume loop stopped completing or has queue-native deadlines overdue. Inspect that Lead's loop heartbeat and pending comm.db rows.";
		case "orphan_pane":
			return "A canonical Runner pane is absent from every active owner index. Inspect the project comm.db registration and either restore ownership or remove the stale pane.";
		case "mailbox_dead_letter":
			return "Mailbox messages exhausted their acknowledgement leases or could not be routed to an owning Lead. Inspect the dead-letter summaries and decide replay, discard, or reassignment.";
		case "legacy_row_quarantined":
			return "The boot cutover refused a deterministically-bad legacy lead_event row and skipped it so the rest of the fleet could recover. The row was NOT delivered. Inspect legacy_cutover_quarantine for the seq and reason, then decide replay or discard.";
		// FLY-1402: the launcher supplies generation-specific evidence in the
		// real shell alert body; this keeps the shared kind switch exhaustive.
		case "rules_bundle_legacy":
			return "A Claude Lead launched with the emergency legacy last-one-wins rule-loading path. Restore bundle mode and restart the Lead after investigating the compatibility override.";
		case "workflow_route_input_rejected":
			return "A fresh work-kind dispatch was rejected because an explicit category, tier, routing override, or template override was invalid. Correct the request and dispatch again; the dedup key in the notice identifies retries of the same input.";
		case "stale_approved_ship_dead":
			return "An approved_to_ship runner was proven dead through its exact tmux target. Resume the execution through the durable recovery path; this alert path never self-ships.";
		case "runner_pane_loss":
			return "A runner's recorded tmux body is missing. Follow the issue-thread recovery proposal; Flywheel does not automatically redispatch this session.";
		case "ship_attempt_failed":
			return "A founder-approved ship attempt failed or could not be tracked to completion. The approval remains valid; inspect the workflow and explicitly wake the runner before retrying.";
		case "complete_marker_held":
			return "A durable completion marker is retained while the Bridge retries with bounded backoff. Repair the named workflow invariant if present; do not delete the marker.";
		// FLY-195: never routed through this table (see titleFor).
		case "runner_stuck_unhandled":
			return "A stuck Runner episode received no Lead disposition within the grace window. Check the owning Lead, then the runner tmux window.";
		// FLY-579: retained historical kind with dedicated caller copy.
		case "auto_qa_stuck":
			return "A review or ship authorization invariant prevented unsafe progress. Inspect the alert body, cancel unsafe state if needed, then use the DAG recovery and redispatch path.";
		// FLY-793: never routed through this table (the workflow engine builds its own body).
		case "three_stage_stuck":
			return "A DAG workflow handoff (Design→Implement→QA) could not proceed (head-SHA capture failed, the previous phase runner would not close, or the next phase dispatch threw). The next phase was NOT started; investigate the phase Runner.";
		case "three_stage_takeover_failed":
			return "A shared branch-B worktree was dirty or at an unexpected HEAD, so Flywheel refused the in-place phase takeover. Inspect and preserve the parked phase's work before retrying.";
		case "workflow_engine_escalation":
			return "A workflow execution died without a completion receipt. The engine either held the run after a non-retryable/exhausted failure or used the approved design Fable→GPT-5.6 fallback. Inspect the run audit and use the quiescence-gated hold/terminate endpoints.";
		case "workflow_engine_issue_alert":
			return "A replaced execution showed later activity, or the same workflow node was repeatedly classified dead. Inspect the issue thread and both execution identities immediately; the Lead escalation copy was emitted separately.";
		// FLY-637-ext: never routed through this table (the lead-pending escalation builds its own body).
		case "runner_lead_pending_unhandled":
			return "A runner has been blocked waiting on the Lead to answer its question, and the Lead did not respond after several reminders. Poke the Lead — the runner itself is fine.";
		// FLY-725: never routed through this table (the founder-thread delivery path builds its own body).
		case "founder_gate_delivery_failed":
			return "The Bridge could not deliver a founder gate ping to its issue thread. The founder was NOT pinged; check the thread / bot token / owner config.";
		// FLY-827: never routed through this table (CodexReviewEffects builds its own body).
		case "codex_gate_blocked":
			return "A PR reached awaiting_review but Codex code review is not APPROVED for the current head. The hard gate blocked merge and held the founder; the runner was re-sent the /codex-code-review instruction.";
		// FLY-1278: never routed through this table (the review coordinator builds
		// request/ruling-specific bodies and deterministic event ids).
		case "review_advisory_pass":
			return "Cross-family review approved the head with non-blocking MEDIUM/LOW advisories. The hard review gate is satisfied; triage advisories into follow-up work as appropriate.";
		case "review_ruling_recorded":
			return "A Lead recorded a supervised governance ruling for an already-delivered review finding. The durable ruling and issue-thread audit are the authority; gate prose is not.";
		case "review_ruling_disputed":
			return "A reviewer supplied new HIGH-severity evidence against a governance-settled finding. The ruling still prevents a mechanical review loop; the Lead must reassess or revoke it.";
		case "review_ruling_notify_failed":
			return "A durable Lead review ruling is active, but its issue-thread audit post failed. Bridge boot redrive will retry; investigate Discord thread/token routing.";
		// FLY-871 R2/C8: never routed through this table (the runner auth scan builds its own body).
		case "runner_login_expired":
			return "A Runner appears logged out (auth/login expired). Rescue restarts it in place so it re-reads the fresh Keychain; if that fails once, the founder is paged.";
		// FLY-871 §12 W2: never routed through this table (the windowed-TUI runtime guard builds its own body).
		case "tui_window_lost":
			return "A windowed Codex Lead's founder-facing cmux pane could not be (re)created for several minutes. Check the launchd job + tmux window (verify-windowed-lead.sh).";
		// FLY-913: never routed through this table (the restart-guard PreToolUse hook builds its own body via lead-alert.sh).
		case "restart_guard_bypass":
			return "An agent used the restart-guard bypass to run a manual Flywheel service restart. The command + reason are in ~/.flywheel/logs/restart-guard.log — review whether it was justified.";
		case "restart_storm_hold":
			return "An OS-supervised Flywheel service reached its durable restart ceiling, so the wrapper stopped launching it. Inspect the service logs and cause, then explicitly resume that child with restart-storm-gate.py.";
		// FLY-939 (G-D): never routed through this table (boot-sha-check builds its own body).
		case "bridge_boot_stale_checkout":
			return "The Bridge booted on a checkout whose HEAD is behind origin/main — merged work is NOT live. Pull + restart the Bridge to deploy.";
		// FLY-927 (D4): never routed through this table (the bridge wrapper builds its own body via lead-alert.sh).
		case "bridge_wrapper_fail":
			return "The Bridge launchd wrapper hit a fail-loud condition (port stuck / preflight failure) while the Bridge is down. Check ~/.flywheel/logs and the wrapper output.";
		// Legacy persisted event kind; retained for rendering old queued rows.
		case "runner_throttle_stalled":
			return "A legacy runner throttle-stall alert was queued before automated stuck detection was removed. Review it manually.";
		// FLY-954: never routed through this table (converge-flywheel-bin.sh builds its own body via lead-alert.sh).
		case "bin_integrity_drift":
			return "A ~/.flywheel/bin runtime script drifted from its repo source. This kind is emitted by scripts/converge-flywheel-bin.sh via lead-alert.sh (shell path) — this table never raises it; see the shell alert body for file + sha details (FLY-954).";
		// FLY-1676: shell callers include concrete SHA/root evidence in the live
		// alert body; this fallback keeps queued rendering actionable.
		case "discord_plugin_integrity_failed":
			return "A Lead could not prove the configured Discord plugin came from the Flywheel fork at the expected remote SHA. Keep that Lead stopped, repair the pointer install, then rerun the integrity check before restarting it.";
		// FLY-945: never routed through this table (the external-merge reconcile pass builds its own body).
		case "external_merge_suspect":
			return "The external-merge reconcile pass found a merged PR it cannot verify (missing founder-attributed approval, or the merged head differs from the approved head). The session was NOT finalized/archived — review the merge.";
		// FLY-929: never routed through this table (the notify-digest expect tick /
		// token-usage-daily.sh build their own bodies via lead-alert.sh).
		case "notify_digest_failed":
			return "The daily token report was not delivered (no receipt / pipeline step failed). Check launchd com.flywheel.token-usage-daily, Bridge /api/reports delivery, and /tmp/flywheel-token-usage-daily.err.";
		// FLY-1099: never routed through this table (the founder-reply unreachable reconcile /
		// action-ledger drain build their own bodies).
		case "founder_reply_pass_dead":
			return "The founder-reply deliver pass has not completed successfully past the stall threshold — founder replies (incl. ship approvals) are NOT being ingested. Check the Bridge log.";
		case "founder_reply_pinned":
			return "A founder message has been pinning its thread's ingest cursor past the threshold — every later founder reply in that thread is blocked behind it.";
		case "founder_reply_dead_letter":
			return "A founder message exhausted its bounded retries and was dead-lettered. It will NOT be auto-processed — a human must act on it (durable audit: founder_reply_dead_letter).";
		case "founder_notify_dead_letter":
			return "A founder-facing ledger action (held notice / rebound notice / codex nudge / feedback wake) failed terminally after bounded retries — the target never received it.";
		case "founder_reply_unreachable_runner":
			return "A LIVE session's CommDB registration row is gone (FLY-1049 shape) — founder replies to its gate cannot be wake-delivered and will dead-letter. Re-register or close the session.";
		case "commdb_finalize_stuck":
			return "A physically gone runner still has unresolved gates or a CommDB session because atomic finalization keeps failing. Issue closeout remains fail-closed; inspect comm.db and retry cleanup.";
		case "merged_gate_guard_unavailable":
			return "The Bridge could not establish the bound PR's merge state after bounded checks, so it suppressed founder-facing recovery copy. Verify GitHub and retire or re-drive the gate manually.";
		// FLY-1081: never routed through this table (restart-services.sh /
		// update-flywheel.sh build their own bodies via lead-alert.sh).
		case "deploy_failed":
			return "A Flywheel deploy failed (restart / rollback / self-update). Shell-only kind via lead-alert.sh — see the shell alert body for specifics; check /tmp/flywheel-bridge.log, ~/.flywheel/state/bridge-startup.log, ~/.flywheel/state/bridge-log-rotation-error.json, and ~/.flywheel/deployed-sha.";
		case "deploy_degraded":
			return "A Flywheel deploy completed degraded (skipped/failed leads, plugin update problem, or idle-wait timeout). Shell-only kind via lead-alert.sh — see the shell alert body for specifics.";
		// FLY-1256: never routed through this table. The external daemon supplies
		// account/quota/reset evidence in the real alert body.
		case "account_switched":
			return "The external quota monitor switched Claude accounts after verifying the target account had fresh quota.";
		case "account_switch_degraded":
			return "The external quota monitor switched Claude accounts using the controlled degraded-verification fallback; inspect the supplied panorama evidence.";
		case "machine_account_conflict":
			return "The external quota monitor found conflicting active-account witnesses and refused all quota actions.";
		case "model_config":
			return "The Lead launcher rejected or could not resolve its configured model and used the built-in Fable fallback. Inspect projects.json, models.json, and the launcher log before the next restart.";
		case "model_cap_switched":
			return "The external quota monitor switched accounts for a verified model-specific cap and recorded the affected panes.";
		case "model_cap_unknown":
			return "A managed Claude pane may show a model cap, but its live state is still ambiguous; no keys were sent.";
		case "model_cap_persistent_unknown":
			return "A managed Claude pane remained ambiguous across repeated model-cap scans; no keys were sent and a human should inspect it.";
		case "model_bench_malformed":
			return "The external quota monitor found malformed per-model bench state and excluded that account fail-closed.";
		case "quota_choice":
			return "Claude is asking for a paid-model choice. The monitor will not choose or send keys; a human must decide.";
		case "quota_switch_confirmation":
			return "The external quota monitor rechecked every recorded affected pane after the switch and reported the five-state recovery result.";
		case "quota_no_target":
			return "The external quota monitor found no fresh, usable target account under the configured thresholds.";
		case "quota_blocked_recovered":
			return "A persistent Claude quota-blocked episode recovered after usage normalized or an account switch succeeded.";
		case "quota_read_blind":
			return "The external quota monitor could not obtain trustworthy quota data; automatic switching is fail-closed.";
		case "account_switch_failed":
			return "The external quota monitor selected a verified target but the credential switch failed.";
		case "account_identity_mismatch":
			return "A live Claude credential resolved to a different account than its trusted pool label; automatic mutation is fail-closed until the mapping is repaired.";
		case "quota_revive_stuck":
			return "A Claude pane remained quota-stuck after the external monitor exhausted its audited revive budget.";
		case "quota_monitor_down":
			return "The launchd quota monitor stopped producing healthy polling evidence; inspect its run marker and logs.";
		case "quota_guard_bypassed":
			return "A human manually bypassed live 5h/7d quota verification before a Claude account switch. Review the target account and the shell alert audit details.";
		// FLY-1082: fleet kinds — never routed through this table (their sensors
		// build their own bodies); cases exist for switch exhaustiveness.
		case "swap_pressure_high":
			return "Machine swap usage crossed the high watermark — OOM early warning. The auto-repair bot places a reversible dispatch pressure-hold and notifies Leads to shed load; the ticket resolves when swap falls below the low watermark.";
		case "tmux_server_lost":
			return "The tmux server hosting the runners is gone while sessions were still running. The server-loss coordinator migrates affected runners to their terminal state and notifies each Lead with its casualty list + resume pointers.";
		case "tmux_hold":
			return "The Bridge cannot positively prove a safe tmux recovery action. Affected runners remain held until target reconciliation succeeds; follow the FLY-1285 recovery runbook if this persists.";
		case "tmux_split_brain":
			return "Multiple tmux server generations appear to reference the canonical socket. The system will not choose or signal one automatically; a human must establish the authoritative generation.";
		case "bridge_abnormal_exit":
			return "The Bridge process exited without a clean shutdown (fatal exit / kill). launchd respawns it; the revived Bridge opens this ticket, runs boot reconcile, and resolves quietly when the self-check passes.";
		case "infra_bot_down":
			return "An infra bot (claude/codex windowed Lead) is down. The OTHER side's bot owns this ticket (nobody rescues their own side); the auto-repair action is launchctl kickstart -k of the dead job.";
		case "zombie_session_backlog":
			return "Cross-Lead zombie sessions (CommDB↔StateStore drift) reached the backlog threshold. No auto-reaping by design (FLY-1066 owns the reaper) — the ticket escalates directly with the sample list.";
		case "lead_dual_active":
			return "Two live Lead processes claim the same canonical identity. The newer process is not authorized to issue runner instructions or answer gates; establish the authoritative generation before recovery.";
		case "lead_dual_active_sensor_degraded":
			return "The Bridge could not obtain trustworthy process evidence for Lead identity uniqueness across repeated scans. Lease enforcement remains fail-closed; restore the process sensor before declaring the incident recovered.";
		case "lead_lease_store_broken":
			return "The durable Lead identity lease store is unavailable or corrupt. Mutating Lead actions are fail-closed until the store is repaired and the carrier generation is revalidated.";
		case "lead_lease_bypass_used":
			return "An explicit emergency bypass performed a Lead mutation without a normal lease grant. Review the audit provenance and restore ordinary lease enforcement immediately.";
		case "lead_lease_would_block":
			return "Observe-mode lease enforcement detected a Lead mutation that would have been rejected. Reconcile the active holder and backend before enabling enforcement.";
		case "lead_lease_control_broken":
			return "Lead lease policy or control state could not be validated. Mutating actions are fail-closed until the control plane is restored.";
		case "lead_identity_source_broken":
			return "The canonical Lead identity could not be resolved unambiguously from configured evidence. Repair the identity mapping before allowing Lead mutations.";
		case "lead_backend_drift":
			return "The configured Lead backend and the live carrier evidence disagree. The conflicting process is not authoritative; reconcile the carrier generation before restoring write authority.";
		case "cmux_cleanup":
			return "cmux-sync refused an unsafe cleanup or found authority state requiring manual review. Inspect the supplied generation, ref, and lease evidence; no foreign workspace was closed.";
		case "cmux_watcher_stalled":
			return "The resident cmux watcher failed its launchd, owner, heartbeat, or event-backlog health contract. Review the supplied branch and canonical recovery outcome; uncertainty branches intentionally did not signal a process.";
		case "flag_scan_failed":
			return "The weekly flag scan failed closed before publishing governance output. Repair the named source or provenance failure; no flag was deleted.";
		case "flag_scan_handoff":
			return "The weekly flag scan report is ready in the Flywheel core Discord thread. Answer founder questions there and record any cleanup verdict through the guarded verdict + preflight path.";
		case "flag_scan_no_clock":
			return "One or more flags lack two trustworthy effective-value samples. The scan withheld them from Annie rather than guessing; repair the named read or keep-binding gap.";
		case "tmux_rescue_hold":
			return "A tmux rescue operation held its per-socket kernel lock beyond the warning threshold. Inspect the supplied socket, verb, caller, and acquisition audit evidence.";
		// FLY-1929: the shell voucher guard builds the real body (it carries the
		// measured zone counts and the episode identity); this keeps the shared
		// kind switch exhaustive.
		case "host_voucher_incident":
			return "Host IPC-voucher occupancy climbed toward IVAC_ENTRIES_MAX, or a new voucher kernel-panic report appeared. The known holder is macOS ecosystemanalyticsd, not a Flywheel process; the containment action is root- and founder-gated. See the FLY-1929 runbook.";
	}
}
