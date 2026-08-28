interface FlagExemptionBase {
	name: string;
	reason: string;
	owner: string;
	issue?: string;
}

/** A real gate that is intentionally kept outside FEATURE_FLAGS. */
export type FlagExemption = FlagExemptionBase &
	(
		| {
				kind: "env";
				persistentEnvAllowed: boolean;
		  }
		| {
				kind: "config_key";
		  }
	);

export interface FounderAuthorizedFlagExemptionReclassification {
	authority: "founder";
	registryName: string;
	exemption: FlagExemption & { issue: string };
}

const QA_AND_INVOCATION_SEAMS = [
	"FLYWHEEL_ALLOW_LICENSE_KEY_ENV",
	"FLYWHEEL_BUDDY_ALLOW_ANSWER_INJECTION",
	"FLYWHEEL_BUDDY_DEMO",
	"FLYWHEEL_BUDDY_PREVIEW_DRY_RUN",
	"FLYWHEEL_BUDDY_PREVIEW_LIVE",
	"FLYWHEEL_CLAUDE_FRESHNESS_BYPASS",
	"FLYWHEEL_CLAUDE_QUOTA_BYPASS",
	"FLYWHEEL_CMUX_DRY_RUN",
	"FLYWHEEL_CMUX_INSTALL_SKIP_LAUNCHCTL",
	"FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE",
	"FLYWHEEL_CMUX_TEST_ALLOW_MODERN_BASH",
	"FLYWHEEL_CMUX_TEST_SYNC_FUNCTIONS",
	"FLYWHEEL_DISCORD_CUTOVER_TEST_SEAMS",
	"FLYWHEEL_LEAD_V2_DRY_RUN",
	"FLYWHEEL_LEAD_V2_TEST_MODE",
	"FLYWHEEL_PROFILE_IDENTITY_BYPASS",
	"FLYWHEEL_QUOTA_E2E_KEEP",
	"FLYWHEEL_SKIP_AGENT_TEAM_PREFLIGHT",
] as const;

const SAFETY_AND_REPAIR_SEAMS = [
	"FLYWHEEL_CMUX_ORPHAN_REAPER",
	"FLYWHEEL_CMUX_REOPEN_SWEEP",
	"FLYWHEEL_CMUX_RESTORED_ADOPTION",
	"FLYWHEEL_CMUX_STOCK_ADOPTION",
	"FLYWHEEL_CODEX_HEALTH_GUARD",
	"FLYWHEEL_CONVERGE_ALLOW_TEMP_ROOT",
	"FLYWHEEL_DAEMON_SKIP_PS_SELF_PROBE",
	"FLYWHEEL_DISABLE_MAILBOX_SENTINEL",
	"FLYWHEEL_FOUNDER_APPROVAL_ACK",
	"FLYWHEEL_LEAD_CTX_RESUME_GATE",
	"FLYWHEEL_MERGED_GATE_GUARD",
	"FLYWHEEL_TURN_BELT_MERGED_RECLAIM",
] as const;

const AUXILIARY_RUNTIME_SEAMS = [
	"FLYWHEEL_ELEVEN_AUTOSTART",
	"FLYWHEEL_GEMINI_AGENT",
	"FLYWHEEL_GEMINI_AUTOSTART",
	"FLYWHEEL_HEADPHONE_INCLUDE_ROUNDTABLE",
	"FLYWHEEL_HUDDLE_EARCON",
	"FLYWHEEL_HUDDLE_FILLER",
	"FLYWHEEL_RUNNER_SLIM_MCP",
	"FLYWHEEL_TUI_WINDOW_ALERT",
	"FLYWHEEL_VOICE_APPROVAL",
	"FLYWHEEL_VOICE_EDGE_TTS",
] as const;

/** Exact FLY-1981 exemption ceiling before any founder reclassification. */
export const FLY1981_FLAG_EXEMPTION_BASELINE = Object.freeze([
	"env:FLYWHEEL_LEAD_DRY_RUN",
	"env:FLYWHEEL_DONE_THREAD_RECONCILE",
	"env:FLYWHEEL_CHROME_REAPER_MIGRATE_UNATTRIBUTED",
	"env:FLYWHEEL_QUOTA_QA_INJECTION",
	"env:FLYWHEEL_SYNC_BIN_ALLOW_TEMP_ROOT",
	"env:FLYWHEEL_ALLOW_LICENSE_KEY_ENV",
	"env:FLYWHEEL_BUDDY_ALLOW_ANSWER_INJECTION",
	"env:FLYWHEEL_BUDDY_DEMO",
	"env:FLYWHEEL_BUDDY_PREVIEW_DRY_RUN",
	"env:FLYWHEEL_BUDDY_PREVIEW_LIVE",
	"env:FLYWHEEL_CLAUDE_FRESHNESS_BYPASS",
	"env:FLYWHEEL_CLAUDE_QUOTA_BYPASS",
	"env:FLYWHEEL_CMUX_DRY_RUN",
	"env:FLYWHEEL_CMUX_INSTALL_SKIP_LAUNCHCTL",
	"env:FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE",
	"env:FLYWHEEL_CMUX_TEST_ALLOW_MODERN_BASH",
	"env:FLYWHEEL_CMUX_TEST_SYNC_FUNCTIONS",
	"env:FLYWHEEL_DISCORD_CUTOVER_TEST_SEAMS",
	"env:FLYWHEEL_LEAD_V2_DRY_RUN",
	"env:FLYWHEEL_LEAD_V2_TEST_MODE",
	"env:FLYWHEEL_PROFILE_IDENTITY_BYPASS",
	"env:FLYWHEEL_QUOTA_E2E_KEEP",
	"env:FLYWHEEL_SKIP_AGENT_TEAM_PREFLIGHT",
	"env:FLYWHEEL_CMUX_ORPHAN_REAPER",
	"env:FLYWHEEL_CMUX_REOPEN_SWEEP",
	"env:FLYWHEEL_CMUX_RESTORED_ADOPTION",
	"env:FLYWHEEL_CMUX_STOCK_ADOPTION",
	"env:FLYWHEEL_CODEX_HEALTH_GUARD",
	"env:FLYWHEEL_CONVERGE_ALLOW_TEMP_ROOT",
	"env:FLYWHEEL_DAEMON_SKIP_PS_SELF_PROBE",
	"env:FLYWHEEL_DISABLE_MAILBOX_SENTINEL",
	"env:FLYWHEEL_FOUNDER_APPROVAL_ACK",
	"env:FLYWHEEL_LEAD_CTX_RESUME_GATE",
	"env:FLYWHEEL_MERGED_GATE_GUARD",
	"env:FLYWHEEL_TURN_BELT_MERGED_RECLAIM",
	"env:FLYWHEEL_ELEVEN_AUTOSTART",
	"env:FLYWHEEL_GEMINI_AGENT",
	"env:FLYWHEEL_GEMINI_AUTOSTART",
	"env:FLYWHEEL_HEADPHONE_INCLUDE_ROUNDTABLE",
	"env:FLYWHEEL_HUDDLE_EARCON",
	"env:FLYWHEEL_HUDDLE_FILLER",
	"env:FLYWHEEL_RUNNER_SLIM_MCP",
	"env:FLYWHEEL_TUI_WINDOW_ALERT",
	"env:FLYWHEEL_VOICE_APPROVAL",
	"env:FLYWHEEL_VOICE_EDGE_TTS",
] as const);

/**
 * The only route that may widen the FLY-1981 ceiling: a founder ruling tied to
 * a concrete issue and to the exact previously registered product-flag identity.
 * Baseline and exemption rows below are both materialized from this record so
 * their name, reason, owner, issue, and mechanical guard change atomically.
 */
export const FOUNDER_AUTHORIZED_FLAG_EXEMPTION_RECLASSIFICATIONS =
	Object.freeze([
		{
			authority: "founder",
			registryName: "voice_qa_presence_override",
			exemption: {
				name: "FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE",
				kind: "env",
				persistentEnvAllowed: false,
				reason:
					"FLY-1353 headless voice E2E presence QA seam; allowed only for the loopback staged Bridge and forbidden in persistent production environments",
				owner: "flywheel-eng-lead",
				issue: "FLY-2102",
			},
		},
	] as const satisfies readonly FounderAuthorizedFlagExemptionReclassification[]);

/**
 * FLY-1981 maximum plus explicit founder-authorized reclassifications. It is
 * never derived from FLAG_EXEMPTIONS: arbitrary exemption rows and synthetic
 * production reads therefore cannot widen the mechanical ceiling.
 */
export const LEGACY_FLAG_EXEMPTION_BASELINE = Object.freeze([
	...FLY1981_FLAG_EXEMPTION_BASELINE,
	...FOUNDER_AUTHORIZED_FLAG_EXEMPTION_RECLASSIFICATIONS.map(
		({ exemption }) => `${exemption.kind}:${exemption.name}`,
	),
] as const);

export const FLAG_EXEMPTIONS: readonly FlagExemption[] = [
	{
		name: "FLYWHEEL_LEAD_DRY_RUN",
		kind: "env",
		persistentEnvAllowed: false,
		reason:
			"one-invocation preview seam; it suppresses side effects for tests and operator inspection rather than rolling out runtime behavior",
		owner: "flywheel-eng-lead",
		issue: "FLY-1808",
	},
	{
		name: "FLYWHEEL_DONE_THREAD_RECONCILE",
		kind: "env",
		persistentEnvAllowed: false,
		reason:
			"QA isolation seam; production behavior stays enabled while test-deploy may disable reconciliation for an isolated slot",
		owner: "flywheel-eng-lead",
		issue: "FLY-1808",
	},
	...FOUNDER_AUTHORIZED_FLAG_EXEMPTION_RECLASSIFICATIONS.map(
		({ exemption }) => exemption,
	),
	...[
		"FLYWHEEL_CHROME_REAPER_MIGRATE_UNATTRIBUTED",
		"FLYWHEEL_QUOTA_QA_INJECTION",
		"FLYWHEEL_SYNC_BIN_ALLOW_TEMP_ROOT",
	].map((name) => ({
		name,
		kind: "env" as const,
		persistentEnvAllowed: false,
		reason:
			"bounded safety/QA invocation seam; accepted only for the explicit process invocation and forbidden in persistent runtime environments",
		owner: "flywheel-eng-lead",
		issue: "FLY-1831",
	})),
	...QA_AND_INVOCATION_SEAMS.map((name) => ({
		name,
		kind: "env" as const,
		persistentEnvAllowed: false,
		reason:
			"QA/fault-injection or one-invocation seam; intentionally not exposed as a persistent runtime flag",
		owner: "flywheel-eng-lead",
		issue: "FLY-1455",
	})),
	...SAFETY_AND_REPAIR_SEAMS.map((name) => ({
		name,
		kind: "env" as const,
		persistentEnvAllowed: true,
		reason:
			"low-level safety/recovery seam remains outside the conversational flag surface",
		owner: "flywheel-eng-lead",
		issue: "FLY-1455",
	})),
	...AUXILIARY_RUNTIME_SEAMS.map((name) => ({
		name,
		kind: "env" as const,
		persistentEnvAllowed: true,
		reason:
			"auxiliary process owns this gate, so the Bridge runtime registry cannot safely toggle it",
		owner: "flywheel-eng-lead",
		issue: "FLY-1455",
	})),
];
