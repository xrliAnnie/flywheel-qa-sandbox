interface FlagExemptionBase {
	name: string;
	reason: string;
	owner: string;
	issue?: string;
	seam: "qa_isolation" | "dry_run" | "one_time_migration";
	retireWhen: string;
}

/** A bounded invocation seam that is intentionally kept outside FEATURE_FLAGS. */
export type FlagExemption = FlagExemptionBase &
	(
		| {
				kind: "env";
				persistentEnvAllowed: false;
		  }
		| {
				kind: "config_key";
		  }
	);

/** Closed: no historical exemption may justify a new entry. */
export const LEGACY_FLAG_EXEMPTION_BASELINE = Object.freeze([] as const);

type EnvExemptionRow = readonly [
	name: string,
	issue: string,
	seam: FlagExemption["seam"],
	reason: string,
	retireWhen: string,
];

const ENV_EXEMPTIONS = [
	[
		"FLYWHEEL_LEAD_DRY_RUN",
		"FLY-1808",
		"dry_run",
		"one-invocation Lead preview that suppresses external side effects",
		"the Lead preview accepts an explicit dry-run option",
	],
	[
		"FLYWHEEL_DONE_THREAD_RECONCILE",
		"FLY-1808",
		"qa_isolation",
		"isolated deploy QA seam for disabling done-thread reconciliation",
		"the reconciliation harness accepts an injected policy",
	],
	[
		"FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE",
		"FLY-2102",
		"qa_isolation",
		"headless staged voice E2E presence override",
		"the staged voice rig supplies presence through its test adapter",
	],
	[
		"FLYWHEEL_CHROME_REAPER_MIGRATE_UNATTRIBUTED",
		"FLY-1831",
		"one_time_migration",
		"one-shot repair for unattributed legacy Chrome processes",
		"the unattributed-process migration has completed on all hosts",
	],
	[
		"FLYWHEEL_QUOTA_QA_INJECTION",
		"FLY-1831",
		"qa_isolation",
		"quota fault injection for deterministic QA",
		"quota tests inject their clock and provider response directly",
	],
	[
		"FLYWHEEL_SYNC_BIN_ALLOW_TEMP_ROOT",
		"FLY-1831",
		"qa_isolation",
		"temporary-root isolation for sync-bin tests",
		"sync-bin accepts an explicit test root argument",
	],
	[
		"FLYWHEEL_ALLOW_LICENSE_KEY_ENV",
		"FLY-1455",
		"qa_isolation",
		"license bootstrap seam for isolated test processes",
		"license tests inject credentials through a test-only adapter",
	],
	[
		"FLYWHEEL_BUDDY_ALLOW_ANSWER_INJECTION",
		"FLY-1455",
		"qa_isolation",
		"Buddy answer injection for deterministic integration tests",
		"Buddy tests pass answers through an explicit fixture interface",
	],
	[
		"FLYWHEEL_BUDDY_DEMO",
		"FLY-1455",
		"qa_isolation",
		"bounded Buddy demo invocation used by the staged rig",
		"the demo launcher exposes a dedicated command or fixture",
	],
	[
		"FLYWHEEL_BUDDY_PREVIEW_DRY_RUN",
		"FLY-1455",
		"dry_run",
		"one-invocation Buddy preview without external side effects",
		"the preview command accepts an explicit dry-run option",
	],
	[
		"FLYWHEEL_BUDDY_PREVIEW_LIVE",
		"FLY-1455",
		"qa_isolation",
		"staged Buddy preview live-path exercise",
		"the staged preview command exposes an explicit live option",
	],
	[
		"FLYWHEEL_CLAUDE_FRESHNESS_BYPASS",
		"FLY-1455",
		"qa_isolation",
		"Claude freshness fault injection for deterministic QA",
		"freshness tests inject the clock directly",
	],
	[
		"FLYWHEEL_CLAUDE_QUOTA_BYPASS",
		"FLY-1455",
		"qa_isolation",
		"Claude quota bypass for isolated failure-path tests",
		"quota tests inject provider state directly",
	],
	[
		"FLYWHEEL_CMUX_DRY_RUN",
		"FLY-1455",
		"dry_run",
		"one-invocation cmux reconciliation preview",
		"the cmux command accepts an explicit dry-run option",
	],
	[
		"FLYWHEEL_CMUX_INSTALL_SKIP_LAUNCHCTL",
		"FLY-1455",
		"qa_isolation",
		"launch-agent installation isolation for tests",
		"the installer accepts an explicit launchctl adapter",
	],
	[
		"FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE",
		"FLY-1455",
		"qa_isolation",
		"process-incarnation injection for cmux race tests",
		"cmux tests inject process metadata directly",
	],
	[
		"FLYWHEEL_CMUX_TEST_ALLOW_MODERN_BASH",
		"FLY-1455",
		"qa_isolation",
		"shell-version isolation for cmux tests",
		"the shell harness provisions its interpreter explicitly",
	],
	[
		"FLYWHEEL_CMUX_TEST_SYNC_FUNCTIONS",
		"FLY-1455",
		"qa_isolation",
		"cmux function-level test harness selector",
		"the harness imports a dedicated test module",
	],
	[
		"FLYWHEEL_DISCORD_CUTOVER_TEST_SEAMS",
		"FLY-1455",
		"qa_isolation",
		"Discord cutover fault injection for staged QA",
		"cutover tests inject their transport and clock directly",
	],
	[
		"FLYWHEEL_LEAD_V2_DRY_RUN",
		"FLY-1455",
		"dry_run",
		"one-invocation Lead v2 preview without side effects",
		"the Lead v2 command accepts an explicit dry-run option",
	],
	[
		"FLYWHEEL_LEAD_V2_TEST_MODE",
		"FLY-1455",
		"qa_isolation",
		"Lead v2 deterministic integration-test mode",
		"Lead v2 dependencies are supplied through a test harness",
	],
	[
		"FLYWHEEL_PROFILE_IDENTITY_BYPASS",
		"FLY-1455",
		"qa_isolation",
		"profile identity failure-path injection for QA",
		"identity tests inject an explicit verifier",
	],
	[
		"FLYWHEEL_QUOTA_E2E_KEEP",
		"FLY-1455",
		"qa_isolation",
		"quota E2E fixture retention for post-run assertions",
		"the E2E runner exposes fixture retention as a test option",
	],
	[
		"FLYWHEEL_SKIP_AGENT_TEAM_PREFLIGHT",
		"FLY-1455",
		"qa_isolation",
		"agent-team preflight failure-path isolation for tests",
		"the test launcher injects a preflight implementation",
	],
	[
		"FLYWHEEL_CONVERGE_ALLOW_TEMP_ROOT",
		"FLY-1455",
		"qa_isolation",
		"temporary repository root for converger tests",
		"the converger accepts an explicit injected repository root",
	],
	[
		"FLYWHEEL_DAEMON_SKIP_PS_SELF_PROBE",
		"FLY-1455",
		"qa_isolation",
		"process-list probe isolation for daemon tests",
		"daemon census accepts an injected process lister",
	],
	[
		"FLYWHEEL_DISABLE_MAILBOX_SENTINEL",
		"FLY-1455",
		"one_time_migration",
		"rollback seam while legacy mailbox sentinels are drained",
		"CommDB rollback is removed and stale sentinel cleanup is complete",
	],
	[
		"FLYWHEEL_ELEVEN_AUTOSTART",
		"FLY-1455",
		"qa_isolation",
		"Eleven staged-rig autostart for voice QA",
		"the staged rig has an authenticated command invocation",
	],
	[
		"FLYWHEEL_GEMINI_AUTOSTART",
		"FLY-1455",
		"qa_isolation",
		"Gemini staged-rig autostart for voice QA",
		"the staged rig has an authenticated command invocation",
	],
] as const satisfies readonly EnvExemptionRow[];

export const FLAG_EXEMPTIONS: readonly FlagExemption[] = Object.freeze(
	ENV_EXEMPTIONS.map(([name, issue, seam, reason, retireWhen]) => ({
		name,
		kind: "env" as const,
		persistentEnvAllowed: false as const,
		reason,
		owner: "flywheel-eng-lead",
		issue,
		seam,
		retireWhen,
	})),
);
