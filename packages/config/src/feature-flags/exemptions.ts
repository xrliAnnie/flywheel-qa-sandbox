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

export const FLAG_EXEMPTIONS: readonly FlagExemption[] = [
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
