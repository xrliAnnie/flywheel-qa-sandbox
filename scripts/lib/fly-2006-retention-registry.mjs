export const RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;

function words(value) {
	return Object.freeze(value.trim().split(/\s+/));
}

export const TEAMLEAD_TABLE_CLASSIFICATION = Object.freeze({
	deleteTarget: words(`
		alert_repair_attempts alert_threads chat_threads deployment_events
		detection_escalations lead_event_delivery_attempts lead_events
		legacy_cutover_quarantine legacy_render_fallback legacy_stock_suppressed
		phase_chat_threads quiet_wake_notified roundtable_topic_threads session_events
		tmux_hold workflow_run_event
	`),
	retiredOptional: words(`
		founder_page_ledger runbook_issues ticket_escalations
	`),
	protectedAuthority: words(`
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
	`),
	protectedCurrentOrReference: words(`
		admission_pause alert_delivery_receipts auto_qa_record cleanup_ref_observations
		commdb_finalize_failures dead_letter_alerts doa_backoff doa_backoff_participants
		doa_backoff_reset_receipts flag_departures flag_keep_anchor flag_provenance
		flag_scan_failure_alert_intents flag_scan_run_items flag_scan_run_legs flag_scan_runs
		flag_scan_scope_state flag_scan_state flag_store_meta flag_value_changelog flag_values fleet_pressure_hold
		founder_reply_retry land_alert_outbox land_operation land_operation_step
		land_recovery_episode land_repo_admission lead_inbox lead_pending_escalation
		lifecycle_apply_claims lifecycle_launch_claims linear_state_observations
		loop_heartbeat loop_owner merged_gate_guard_failure messages
		node_dwell_review patrol_orphan_watch
		receipt_activation_episodes receipt_alert_outbox receipt_exemption_audit
		receipt_handle_requests receipt_resend_deliveries retry_dispatch_intents
		recovery_claim
		runner_declared_states runner_phase_wakes runner_shutdown_controls
		runner_wake_failure_episode runner_workflow_activation server_loss_episode sessions
		ship_relevant_diff_snapshot state_store_migration three_stage_turn
		workflow_activation_turn workflow_actor workflow_alert_outbox
		workflow_binding_cutover_claim workflow_carrier_delivery
		workflow_catalog_migration_audit
		workflow_carrier_redrive_receipt workflow_carryover_activation
		workflow_category_binding workflow_dead_execution_watch workflow_declared_pr
		workflow_delivery_attempt workflow_delivery_contract_episode
		workflow_delivery_operation
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
	`),
});

export const COMM_TABLE_CLASSIFICATION = Object.freeze({
	deleteTarget: words(`
		content_ref_gc_outbox mailbox mailbox_log receipt_alert_outbox runner_phase_wakes
		runner_shutdown_controls runner_wake_failure_episode
	`),
	protectedCurrentOrAuthority: words(`
		lead_inbox_fenced_root lead_inbox_freeze_install lead_inbox_sanitation_audit
		loop_heartbeat loop_owner mailbox_archive mailbox_identity mailbox_migration_meta
		runner_declared_states runner_stop_declarations runner_workflow_activation session_receipt_lineage sessions
		three_stage_turn turn_source_history turn_wait_ledger turn_wake_outbox
		workflow_engine_park workflow_engine_park_cursor workflow_source_event
	`),
});

const REGISTRIES = Object.freeze({
	teamlead: TEAMLEAD_TABLE_CLASSIFICATION,
	comm: COMM_TABLE_CLASSIFICATION,
});

function registryNames(database) {
	const registry = REGISTRIES[database];
	if (!registry) throw new Error(`unknown_retention_database:${database}`);
	const names = Object.values(registry).flat();
	const unique = new Set(names);
	if (unique.size !== names.length)
		throw new Error(`schema_registry_overlap:${database}`);
	return { registry, names, unique };
}

export function assertClassifiedSchema(database, actualNames) {
	const { registry, names } = registryNames(database);
	const actual = new Set(actualNames);
	assertNoUnclassifiedSchema(database, actualNames);
	const retiredOptional = new Set(registry.retiredOptional ?? []);
	const missing = names
		.filter((name) => !retiredOptional.has(name) && !actual.has(name))
		.sort();
	if (missing.length > 0)
		throw new Error(`schema_missing:${database}:${missing.join(",")}`);
	return {
		database,
		total: actual.size,
		counts: Object.fromEntries(
			Object.entries(registry).map(([classification, values]) => [
				classification,
				values.length,
			]),
		),
	};
}

export function assertNoUnclassifiedSchema(database, actualNames) {
	const { unique } = registryNames(database);
	const actual = new Set(actualNames);
	const unknown = [...actual].filter((name) => !unique.has(name)).sort();
	if (unknown.length > 0)
		throw new Error(`schema_unclassified:${database}:${unknown.join(",")}`);
	return { database, total: actual.size };
}

function timestampMs(value) {
	if (value === null || value === undefined) return null;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return null;
		return Math.abs(value) > 100_000_000_000 ? value : value * 1_000;
	}
	if (typeof value !== "string" || value.trim() === "") return null;
	const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(
		value,
	)
		? `${value.replace(" ", "T")}Z`
		: value;
	const parsed = Date.parse(normalized);
	return Number.isFinite(parsed) ? parsed : null;
}

export function classifyRetentionTime(value, cutoff) {
	const cutoffMs = timestampMs(cutoff);
	if (cutoffMs === null) throw new Error("retention_cutoff_invalid");
	const valueMs = timestampMs(value);
	if (valueMs === null) return "invalidTime";
	return valueMs < cutoffMs ? "old" : "recent";
}

export const MAILBOX_LEAD_EXCEPTION = Object.freeze({
	fromAgent: "voice-honeylemon-fly1911",
	relayState: "terminal_disposed",
});

const MAILBOX_AUTHORITY_TYPES = new Set([
	"action_executed",
	"founder_reply",
	"instruction",
	"question",
	"response",
	"review_advisory_pass",
	"session_zombie_detected",
]);

const MAILBOX_NARRATIVE_TYPES = new Set([
	"ack_batch",
	"bridge_abnormal_exit",
	"bridge_boot_stale_checkout",
	"dead_letter_notice",
	"discord_chat",
	"external_delivery",
	"external_merge_suspect",
	"inbox_loop_stalled",
	"patrol_tick",
	"runner_idle_detected",
	"runner_login_expired",
	"session_monitoring_lost",
	"session_monitoring_reestablished",
	"session_orphaned",
	"session_stale_completed",
	"session_started",
	"stage_changed",
	"swap_pressure_high",
	"tui_window_lost",
	"workflow_engine_escalation",
	"zombie_session_backlog",
]);

export function classifyMailboxRow(row, cutoff14) {
	if (
		row.from_agent === MAILBOX_LEAD_EXCEPTION.fromAgent &&
		row.relay_state === MAILBOX_LEAD_EXCEPTION.relayState
	) {
		return "leadExactExceptionCandidate";
	}
	const terminalAt = row.state === "DEAD" ? row.dead_at : row.acked_at;
	const age = classifyRetentionTime(terminalAt, cutoff14);
	if (age !== "old") return age;
	if (
		row.checkpoint !== null &&
		row.checkpoint !== undefined &&
		row.checkpoint !== ""
	)
		return "oldProtectedAuthority";
	if (row.kind === "report" || MAILBOX_AUTHORITY_TYPES.has(row.type))
		return "oldProtectedAuthority";
	if (!MAILBOX_NARRATIVE_TYPES.has(row.type)) return "oldProtectedUnknown";
	if (
		!new Set(["ACKED", "DEAD"]).has(row.state) ||
		row.relay_state !== "terminal_disposed"
	)
		return "activeProtected";
	return "candidate";
}
