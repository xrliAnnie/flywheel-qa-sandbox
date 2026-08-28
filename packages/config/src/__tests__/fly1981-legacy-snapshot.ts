import type { FlagExemption } from "../feature-flags/exemptions.js";
import type { FeatureFlagSpec } from "../feature-flags/registry.js";

export interface HistoricalLegacySpec {
	name: string;
	source: "env" | "project_config";
	sourceKey: string;
}

/** Exact FLY-1981 landing snapshot; current ledgers may shrink from this set. */
export const FLY1981_LEGACY_SNAPSHOT = Object.freeze([
	{ name: "flag_store", source: "env", sourceKey: "FLYWHEEL_FLAG_STORE" },
	{
		name: "founder_review_orphan_monitor",
		source: "env",
		sourceKey: "FLYWHEEL_FOUNDER_REVIEW_ORPHAN_MONITOR",
	},
	{ name: "mailbox_queue", source: "env", sourceKey: "FLYWHEEL_MAILBOX_QUEUE" },
	{
		name: "liveness_activity_window_ms",
		source: "env",
		sourceKey: "FLYWHEEL_LIVENESS_ACTIVITY_WINDOW_MS",
	},
	{
		name: "converge_cmux_symlink",
		source: "env",
		sourceKey: "FLYWHEEL_CONVERGE_CMUX_SYMLINK",
	},
	{
		name: "cmux_view_helper",
		source: "env",
		sourceKey: "FLYWHEEL_CMUX_VIEW_HELPER",
	},
	{
		name: "cmux_node_presence",
		source: "env",
		sourceKey: "FLYWHEEL_CMUX_NODE_PRESENCE",
	},
	{
		name: "voice_qa_presence_override",
		source: "env",
		sourceKey: "FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE",
	},
	{
		name: "merge_approval_gate_killswitch",
		source: "env",
		sourceKey: "FLYWHEEL_MERGE_APPROVAL_GATE",
	},
	{
		name: "issue_gate_supersede_mode",
		source: "env",
		sourceKey: "FLYWHEEL_ISSUE_GATE_SUPERSEDE",
	},
	{
		name: "deferred_approval_ttl_ms",
		source: "env",
		sourceKey: "FLYWHEEL_DEFERRED_APPROVAL_TTL_MS",
	},
	{
		name: "founder_reply_deadletter_age_ms",
		source: "env",
		sourceKey: "FLYWHEEL_FOUNDER_REPLY_DEADLETTER_AGE_MS",
	},
	{
		name: "issue_display_sweep_ticks",
		source: "env",
		sourceKey: "FLYWHEEL_ISSUE_DISPLAY_SWEEP_TICKS",
	},
	{
		name: "ship_gate_grace_ms",
		source: "env",
		sourceKey: "FLYWHEEL_SHIP_GATE_GRACE_MS",
	},
	{
		name: "external_merge_reconcile",
		source: "env",
		sourceKey: "FLYWHEEL_EXTERNAL_MERGE_RECONCILE",
	},
	{
		name: "merge_reconcile_window_days",
		source: "env",
		sourceKey: "FLYWHEEL_MERGE_RECONCILE_WINDOW_DAYS",
	},
	{
		name: "ship_gate_card_grace_ms",
		source: "env",
		sourceKey: "FLYWHEEL_SHIP_GATE_CARD_GRACE_MS",
	},
	{
		name: "ghost_guard_wait_ms",
		source: "env",
		sourceKey: "FLYWHEEL_GHOST_GUARD_WAIT_MS",
	},
	{
		name: "lead_lease_bypass",
		source: "env",
		sourceKey: "FLYWHEEL_LEAD_LEASE_BYPASS",
	},
	{
		name: "checkpoint_enabled",
		source: "project_config",
		sourceKey: "checkpoints.*.enabled",
	},
	{ name: "pipeline_dag", source: "project_config", sourceKey: "pipeline.dag" },
	{
		name: "pipeline_work_kind",
		source: "project_config",
		sourceKey: "pipeline.work_kind",
	},
	{
		name: "xiaohongshu_auto_create",
		source: "project_config",
		sourceKey: "xiaohongshu_learning.collections[].auto_create",
	},
	{ name: "doc_flow", source: "project_config", sourceKey: "doc_flow.enabled" },
	{
		name: "skill_framework_split_participation",
		source: "project_config",
		sourceKey: "skill_framework.split",
	},
	{
		name: "proofshot",
		source: "project_config",
		sourceKey: "skills.proofshot.enabled",
	},
	{
		name: "xiaohongshu_learning",
		source: "project_config",
		sourceKey: "xiaohongshu_learning.enabled",
	},
	{ name: "ponytail", source: "project_config", sourceKey: "ponytail.enabled" },
	{
		name: "done_thread_reconcile_interval_min",
		source: "env",
		sourceKey: "FLYWHEEL_DONE_THREAD_RECONCILE_INTERVAL_MIN",
	},
	{
		name: "done_thread_reconcile_max_per_run",
		source: "env",
		sourceKey: "FLYWHEEL_DONE_THREAD_RECONCILE_MAX_PER_RUN",
	},
	{
		name: "publish_broker",
		source: "env",
		sourceKey: "FLYWHEEL_PUBLISH_BROKER",
	},
] as const satisfies readonly HistoricalLegacySpec[]);

function specSourceKey(spec: FeatureFlagSpec): string | undefined {
	return spec.source === "env" ? spec.envVar : spec.configKey;
}

export function auditFly1981LegacyLedger(args: {
	baseline: readonly string[];
	flags: readonly FeatureFlagSpec[];
	storeManagedFlags: ReadonlySet<string>;
	retiredFlags: readonly { envVar: string }[];
	retiredConfigPaths: readonly { path: string }[];
	exemptions: readonly FlagExemption[];
}): string[] {
	const issues: string[] = [];
	const snapshotByName = new Map(
		FLY1981_LEGACY_SNAPSHOT.map((entry) => [entry.name, entry]),
	);
	const baseline = new Set(args.baseline);

	for (const name of baseline) {
		const historical = snapshotByName.get(name);
		const current = args.flags.find((spec) => spec.name === name);
		if (!historical) issues.push(`${name}: absent from FLY-1981 snapshot`);
		if (!current)
			issues.push(`${name}: baseline entry has no current registry spec`);
		if (
			historical &&
			current &&
			(current.source !== historical.source ||
				specSourceKey(current) !== historical.sourceKey)
		) {
			issues.push(`${name}: source identity drifted from FLY-1981 snapshot`);
		}
	}

	for (const historical of FLY1981_LEGACY_SNAPSHOT) {
		if (baseline.has(historical.name)) continue;
		const current = args.flags.find((spec) => spec.name === historical.name);
		const migrated =
			current !== undefined &&
			args.storeManagedFlags.has(current.name) &&
			current.source === historical.source &&
			specSourceKey(current) === historical.sourceKey;
		const retired =
			historical.source === "env"
				? args.retiredFlags.some(
						(entry) => entry.envVar === historical.sourceKey,
					) ||
					args.exemptions.some(
						(exemption) =>
							exemption.kind === "env" &&
							exemption.name === historical.sourceKey,
					)
				: args.retiredConfigPaths.some(
						(entry) => entry.path === historical.sourceKey,
					) ||
					args.exemptions.some(
						(exemption) =>
							exemption.kind === "config_key" &&
							exemption.name === historical.sourceKey,
					);
		if (!migrated && !retired) {
			issues.push(
				`${historical.name}: removed baseline source ${historical.sourceKey} has no managed, retired, or exempt destination`,
			);
		}
	}

	return issues;
}
