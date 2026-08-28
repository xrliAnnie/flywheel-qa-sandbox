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

/**
 * FLY-1981: immutable maximum ledger for registry-external flag exemptions.
 * This list is deliberately literal rather than derived from FLAG_EXEMPTIONS:
 * existing entries may be deleted, but a new `kind:name` must fail governance.
 */
export const LEGACY_FLAG_EXEMPTION_BASELINE = Object.freeze([
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
	// FLY-2102 founder ruling: registry retirement keeps this bounded QA seam accounted.
	"env:FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE",
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
	{
		name: "FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE",
		kind: "env",
		persistentEnvAllowed: false,
		reason:
			"FLY-1353 headless voice E2E presence QA seam; allowed only for the loopback staged Bridge and forbidden in persistent production environments",
		owner: "flywheel-eng-lead",
		issue: "FLY-2102",
	},
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
