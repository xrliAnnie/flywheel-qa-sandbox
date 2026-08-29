import type { FlagExemption } from "../feature-flags/exemptions.js";
import type { FeatureFlagSpec } from "../feature-flags/registry.js";

export interface HistoricalLegacySpec {
	name: string;
	source: "env" | "project_config";
	sourceKey?: string;
	constantizedBy?: "FLY-2101";
}

/** Annotated historical snapshot; 13 entries were constantized by FLY-2101. */
export const FLY1981_LEGACY_SNAPSHOT = Object.freeze([
	{ name: "flag_store", source: "env", sourceKey: "FLYWHEEL_FLAG_STORE" },
	{
		name: "founder_review_orphan_monitor",
		source: "env",
		constantizedBy: "FLY-2101",
	},
	{ name: "mailbox_queue", source: "env", constantizedBy: "FLY-2101" },
	{
		name: "liveness_activity_window_ms",
		source: "env",
		constantizedBy: "FLY-2101",
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
		constantizedBy: "FLY-2101",
	},
	{
		name: "issue_gate_supersede_mode",
		source: "env",
		constantizedBy: "FLY-2101",
	},
	{
		name: "deferred_approval_ttl_ms",
		source: "env",
		constantizedBy: "FLY-2101",
	},
	{
		name: "founder_reply_deadletter_age_ms",
		source: "env",
		constantizedBy: "FLY-2101",
	},
	{
		name: "issue_display_sweep_ticks",
		source: "env",
		sourceKey: "FLYWHEEL_ISSUE_DISPLAY_SWEEP_TICKS",
	},
	{
		name: "ship_gate_grace_ms",
		source: "env",
		constantizedBy: "FLY-2101",
	},
	{
		name: "external_merge_reconcile",
		source: "env",
		constantizedBy: "FLY-2101",
	},
	{
		name: "merge_reconcile_window_days",
		source: "env",
		constantizedBy: "FLY-2101",
	},
	{
		name: "ship_gate_card_grace_ms",
		source: "env",
		constantizedBy: "FLY-2101",
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
		constantizedBy: "FLY-2101",
	},
	{
		name: "done_thread_reconcile_max_per_run",
		source: "env",
		constantizedBy: "FLY-2101",
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
	snapshot?: readonly HistoricalLegacySpec[];
}): string[] {
	const issues: string[] = [];
	const snapshot = args.snapshot ?? FLY1981_LEGACY_SNAPSHOT;
	const snapshotByName = new Map(snapshot.map((entry) => [entry.name, entry]));
	const baseline = new Set(args.baseline);
	for (const historical of snapshot) {
		if (
			historical.sourceKey === undefined &&
			historical.constantizedBy === undefined
		) {
			issues.push(`${historical.name}: historical source identity is missing`);
		}
	}

	for (const name of baseline) {
		const historical = snapshotByName.get(name);
		const current = args.flags.find((spec) => spec.name === name);
		if (!historical) issues.push(`${name}: absent from FLY-1981 snapshot`);
		if (historical?.sourceKey === undefined) {
			issues.push(
				`${name}: constantized snapshot entry returned to the baseline`,
			);
		}
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

	for (const historical of snapshot) {
		if (baseline.has(historical.name)) continue;
		const current = args.flags.find((spec) => spec.name === historical.name);
		if (historical.constantizedBy === "FLY-2101") {
			if (current !== undefined) {
				issues.push(
					`${historical.name}: FLY-2101 constantized control returned to the registry`,
				);
			}
			// FLY-2101 decision: constantized entries permanently skip retirement
			// and exemption checks. Their env keys no longer exist, so an exemption
			// keyed by the removed source identity cannot remain live.
			continue;
		}
		if (historical.sourceKey === undefined) continue;
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
