import { FLAG_EXEMPTIONS } from "./exemptions.js";
import { FEATURE_FLAGS } from "./registry.js";

// FLY-1455 first full-surface census. These are values/context/plumbing or
// per-invocation choices, not persistent on/off gates. Keeping the names
// explicit means a future env read still has to be classified in review.
const FLY1455_NON_FLAG_ENV = [
	"FLYWHEEL_AGENT_CLI_ORCHESTRATE",
	"FLYWHEEL_API_TOKEN",
	"FLYWHEEL_APPLY_REPORT_FILE",
	"FLYWHEEL_BASE_RULES_DIR",
	"FLYWHEEL_BRAIN_PORT_TOKEN",
	"FLYWHEEL_BRIDGE_MARKER",
	"FLYWHEEL_BRIDGE_SOURCE_SHA",
	"FLYWHEEL_BRIDGE_SYNCOP_DIR",
	"FLYWHEEL_BUDDY_NONINTERACTIVE",
	"FLYWHEEL_BUDDY_SOURCED",
	"FLYWHEEL_BUDDY_STEPS_SOURCED",
	"FLYWHEEL_BUDDY_STEPS_VERBOSE",
	"FLYWHEEL_CALLBACK_PORT",
	"FLYWHEEL_CALLBACK_TOKEN",
	"FLYWHEEL_CANONICAL_IDENTITY_RESOLVED",
	"FLYWHEEL_CLAUDE_INFRA_BOT_JOB",
	"FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN",
	"FLYWHEEL_CLAUDE_QUOTA_PREVERIFIED",
	"FLYWHEEL_CMUX_MAINTENANCE_POLL_SECONDS",
	"FLYWHEEL_CMUX_OPS_REPROBE_SECONDS",
	"FLYWHEEL_CMUX_PROBE_WAIT",
	"FLYWHEEL_CMUX_SUPERVISED",
	"FLYWHEEL_CMUX_TEST_NONCE",
	"FLYWHEEL_CMUX_TMUX_GENERATION",
	"FLYWHEEL_CODEX_BIN",
	"FLYWHEEL_CODEX_CLI_VERSION_ALLOWLIST",
	"FLYWHEEL_CODEX_DAEMON_EXIT_WAIT_MS",
	"FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT",
	"FLYWHEEL_CODEX_HOMES_ROOT",
	"FLYWHEEL_CODEX_INFRA_BOT_JOB",
	"FLYWHEEL_CODEX_INFRA_BOT_USER_ID",
	"FLYWHEEL_CODEX_LEAD_OUTBOUND",
	"FLYWHEEL_CODEX_LEAD_PROFILE",
	"FLYWHEEL_CODEX_LEAD_PROJECT_DIR",
	"FLYWHEEL_CODEX_LEAD_SANDBOX",
	"FLYWHEEL_CODEX_LEAD_STATE_DIR",
	"FLYWHEEL_CODEX_LEAD_SUBDIR",
	"FLYWHEEL_CODEX_LEAD_WORKSPACE",
	"FLYWHEEL_CODEX_PROFILES_DIR",
	"FLYWHEEL_CODEX_SESSION_DIR",
	"FLYWHEEL_CODEX_SOURCE_HOME",
	"FLYWHEEL_CODEX_TEAMS_DIR",
	"FLYWHEEL_CODEX_TUI_BIN",
	"FLYWHEEL_CODEX_TUI_CWD",
	"FLYWHEEL_COMM_CLI",
	"FLYWHEEL_CONFIG_DIST",
	"FLYWHEEL_CONFIG_LOCK_SOURCED",
	"FLYWHEEL_CONVERGE_PROD_STATE",
	"FLYWHEEL_DAEMON_POLL_INTERVAL",
	"FLYWHEEL_DAEMON_SOURCED",
	"FLYWHEEL_DISCORD_CUTOVER_AUTHORIZED",
	"FLYWHEEL_DISCORD_CUTOVER_BUILD_CMD",
	"FLYWHEEL_DISCORD_CUTOVER_CENSUS_CMD",
	"FLYWHEEL_DISCORD_CUTOVER_DEPLOY_CMD",
	"FLYWHEEL_DISCORD_CUTOVER_HEALTH_CMD",
	"FLYWHEEL_DISCORD_CUTOVER_PREFLIGHT_CMD",
	"FLYWHEEL_DISCORD_CUTOVER_ROOT_PROOF_CMD",
	"FLYWHEEL_DISCORD_PLUGIN_REPO",
	"FLYWHEEL_ENGINE_REWORK_ALERT_MS",
	"FLYWHEEL_ENGINE_REWORK_HOLD_MS",
	"FLYWHEEL_ENGINE_UNLAUNCHED_ALERT_MS",
	"FLYWHEEL_ENGINE_UNLAUNCHED_ROLLBACK_MS",
	"FLYWHEEL_ENV_FILE",
	"FLYWHEEL_EXTERNAL_MERGE_NEGATIVE_CACHE_MS",
	"FLYWHEEL_FLEET_SOURCED",
	"FLYWHEEL_FOUNDER_CONSENT_AUDIT_DB_PATH",
	"FLYWHEEL_FOUNDER_CONSENT_BYPASS_ISSUE_ID",
	"FLYWHEEL_FOUNDER_CONSENT_BYPASS_LABEL",
	"FLYWHEEL_FOUNDER_CONSENT_BYPASS_LABEL_FRESHNESS",
	"FLYWHEEL_FOUNDER_CONSENT_CACHE_TTL_SECS",
	"FLYWHEEL_FOUNDER_CONSENT_DEBUG_ENDPOINT_MAX_LIMIT",
	"FLYWHEEL_FOUNDER_CONSENT_FAIL_MODE",
	"FLYWHEEL_FOUNDER_CONSENT_FAIL_MODE_PER_ACTION",
	"FLYWHEEL_FOUNDER_CONSENT_LLM_MODEL",
	"FLYWHEEL_FOUNDER_CONSENT_MAX_MSGS",
	"FLYWHEEL_FOUNDER_CONSENT_THRESHOLD",
	"FLYWHEEL_FOUNDER_CONSENT_THRESHOLD_PER_ACTION",
	"FLYWHEEL_FOUNDER_CONSENT_WINDOW_HOURS",
	"FLYWHEEL_FOUNDER_CONSENT_WORKFLOW_REWORK_FAIL_MODE",
	"FLYWHEEL_FOUNDER_CONSENT_WORKFLOW_REWORK_THRESHOLD",
	"FLYWHEEL_FOUNDER_NAME",
	"FLYWHEEL_GATEWAY_BROKER_SOCKET",
	"FLYWHEEL_GATEWAY_COMM_DB",
	"FLYWHEEL_GATEWAY_CONFIRM_CHANNEL_ID",
	"FLYWHEEL_GATEWAY_CONFIRM_TTL_MS",
	"FLYWHEEL_GATEWAY_ENTRY",
	"FLYWHEEL_GATEWAY_GITHUB_TOKEN",
	"FLYWHEEL_GATEWAY_POLL_INTERVAL_MS",
	"FLYWHEEL_GATEWAY_PROJECT_REPO",
	"FLYWHEEL_GATEWAY_STATE_DB",
	"FLYWHEEL_GATEWAY_STATE_DIR",
	"FLYWHEEL_GEMINI_AGENT_AUDIT_DIR",
	"FLYWHEEL_GEMINI_AGENT_BRIDGE_TOKEN",
	"FLYWHEEL_GEMINI_AGENT_CONFIG",
	"FLYWHEEL_GEMINI_AGENT_DISCORD_TOKEN",
	"FLYWHEEL_GEMINI_AGENT_MAX_STEPS",
	"FLYWHEEL_GEMINI_AGENT_MODEL_TIER",
	"FLYWHEEL_GEMINI_AGENT_RESULT_CAP_CHARS",
	"FLYWHEEL_GEMINI_AGENT_SURFACE",
	"FLYWHEEL_GEMINI_AGENT_TOKEN_BUDGET_IN",
	"FLYWHEEL_GEMINI_AGENT_TOKEN_BUDGET_OUT",
	"FLYWHEEL_GEMINI_AGENT_TOOL_TIMEOUT_MS",
	"FLYWHEEL_GIT_PATH",
	"FLYWHEEL_HEADPHONE_CONFIG",
	"FLYWHEEL_HEADPHONE_STATE_FILE",
	"FLYWHEEL_HOME",
	"FLYWHEEL_HOST_CONFIG",
	"FLYWHEEL_HUDDLE_ALLOW_USER_IDS",
	"FLYWHEEL_HUDDLE_BACKCHANNEL_MS",
	"FLYWHEEL_HUDDLE_BARGE_HOLDOFF_MS",
	"FLYWHEEL_HUDDLE_BARGE_MIN_RMS",
	"FLYWHEEL_HUDDLE_BRAIN_TIMEOUT_MS",
	"FLYWHEEL_HUDDLE_GEMINI_MODEL",
	"FLYWHEEL_IDENTITY_FAILURE_DIR",
	"FLYWHEEL_INBOX_LOOP_STALL_MIN",
	"FLYWHEEL_INBOX_RETRY_WINDOW_SEC",
	"FLYWHEEL_INTERACTION_PORT",
	"FLYWHEEL_ISSUE_GATE_SUPERSEDE_MAX_MUTATIONS",
	"FLYWHEEL_KIMI_PREFLIGHT_TIMEOUT_MS",
	"FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES",
	"FLYWHEEL_LEAD_ACTIONS_ENTRY",
	"FLYWHEEL_LEAD_ACTIONS_IDEMPOTENCY_TTL_MS",
	"FLYWHEEL_LEAD_ACTIONS_MAIN_JS",
	"FLYWHEEL_LEAD_ACTIONS_NODE_BIN",
	"FLYWHEEL_LEAD_ACTIONS_RATE_MAX",
	"FLYWHEEL_LEAD_ACTIONS_RATE_WINDOW_MS",
	"FLYWHEEL_LEAD_ACTIONS_STATE_DIR",
	"FLYWHEEL_LEAD_ALERT_SH",
	"FLYWHEEL_LEAD_BODY_V2",
	"FLYWHEEL_LEAD_BOT_USER_ID",
	"FLYWHEEL_LEAD_CARRIER_ASSERTION_DIR",
	"FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE",
	"FLYWHEEL_LEAD_CARRIER_INSTANCE_ID",
	"FLYWHEEL_LEAD_CHAT_CHANNEL_ID",
	"FLYWHEEL_LEAD_COMPANION",
	"FLYWHEEL_LEAD_CORE_CHANNEL_ID",
	"FLYWHEEL_LEAD_CTX_RESUME_MAX",
	"FLYWHEEL_LEAD_EXTERNAL",
	"FLYWHEEL_LEAD_GENERATION",
	"FLYWHEEL_LEAD_IDENTITY_DIGEST",
	"FLYWHEEL_LEAD_KEY",
	"FLYWHEEL_LEAD_LEASE_AUDIT_LOG",
	"FLYWHEEL_LEAD_LEASE_KEY",
	"FLYWHEEL_LEAD_LEASE_MODE",
	"FLYWHEEL_LEAD_LEASE_MODE_FILE",
	"FLYWHEEL_LEAD_MENTION_PATTERNS",
	"FLYWHEEL_LEAD_RECEIPT_DIR",
	"FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES",
	"FLYWHEEL_MAILBOX_READ_KEEP",
	"FLYWHEEL_MAILBOX_READ_RETENTION_MS",
	"FLYWHEEL_MAILBOX_SIDECAR_KEEP",
	"FLYWHEEL_MAILBOX_SIDECAR_RETENTION_MS",
	"FLYWHEEL_MARKER_DIR",
	"FLYWHEEL_MEM_FREE_HIGH_PCT",
	"FLYWHEEL_MEM_FREE_LOW_PCT",
	"FLYWHEEL_MEM_PAGE_DEBOUNCE_SEC",
	"FLYWHEEL_MEM_SWAPOUT_MIN_PAGES",
	"FLYWHEEL_MODELS_CONFIG",
	"FLYWHEEL_NOTIFY_RECEIPTS_PATH",
	"FLYWHEEL_ONBOARD_NONINTERACTIVE",
	"FLYWHEEL_ONBOARD_SKIP_NET",
	"FLYWHEEL_PROGRESS_PATH",
	"FLYWHEEL_PROJECT_REPO",
	"FLYWHEEL_RESTART_FOREGROUND",
	"FLYWHEEL_RESTART_WAIT_IDLE",
	"FLYWHEEL_ROOT",
	"FLYWHEEL_ROUNDTABLE_INBOUND_CURSOR_PATH",
	"FLYWHEEL_ROUNDTABLE_LEAD_USER_IDS",
	"FLYWHEEL_ROUNDTABLE_MEMBER_USER_IDS",
	"FLYWHEEL_ROUNDTABLE_MIN_MENTIONS",
	"FLYWHEEL_ROUNDTABLE_POLL_INTERVAL_MS",
	"FLYWHEEL_ROUNDTABLE_REPLY_CAP",
	"FLYWHEEL_ROUNDTABLE_THREAD_BUDGET",
	"FLYWHEEL_ROUNDTABLE_TRIGGER_PREFIXES",
	"FLYWHEEL_RULES_TRUTH_GATE_CLI",
	"FLYWHEEL_RULES_TRUTH_MANIFEST_DIR",
	"FLYWHEEL_RULES_TRUTH_PS",
	"FLYWHEEL_RULES_TRUTH_STATE_DIR",
	"FLYWHEEL_RULES_TRUTH_TMUX",
	"FLYWHEEL_RUNBOOK_GAP_THRESHOLD",
	"FLYWHEEL_RUNNER_DEFAULT_MODEL",
	"FLYWHEEL_RUNNER_DISABLED_PLUGINS",
	"FLYWHEEL_RUNNER_LOAD_PER_CORE",
	"FLYWHEEL_RUNNER_MIN_FREE_MEM_MB",
	"FLYWHEEL_RUNNER_STATE_DIR",
	"FLYWHEEL_RUNNER_STATE_ROOT",
	"FLYWHEEL_SETUP_NO_DIGEST",
	"FLYWHEEL_SETUP_SOURCED",
	"FLYWHEEL_SETUP_STATE_DIR",
	"FLYWHEEL_SLACK_CHANNEL",
	"FLYWHEEL_STATE_DB_PATH",
	"FLYWHEEL_STUCK_COMM_ACTIVITY_MS",
	"FLYWHEEL_SUPERVISOR_BACKEND",
	"FLYWHEEL_SUPERVISOR_DARWIN_INSTALL",
	"FLYWHEEL_SWAP_PRESSURE_TIMEOUT_MIN",
	"FLYWHEEL_SWAP_SENSOR_CMD",
	"FLYWHEEL_SYSTEM_HEALTH_DIR",
	"FLYWHEEL_TEAMLEAD_DB",
	"FLYWHEEL_TMUX_AUDIT_ALLOWLIST",
	"FLYWHEEL_TMUX_ENSURE_ATTEMPT_TIMEOUT_MS",
	"FLYWHEEL_TMUX_ENSURE_DEADLINE_MS",
	"FLYWHEEL_TMUX_MASS_LOSS_MIN",
	"FLYWHEEL_TMUX_RESCUE_ALERT_COOLDOWN_SEC",
	"FLYWHEEL_TMUX_RESCUE_CLI",
	"FLYWHEEL_TMUX_SOCKET_OVERRIDE",
	"FLYWHEEL_TUI_HOME_REEXEC",
	"FLYWHEEL_TURN_BELT_MERGED_RECLAIM_AGE_MS",
	"FLYWHEEL_TURN_WAIT_ASK_MINUTES",
	"FLYWHEEL_VIEWER_BACKEND",
	"FLYWHEEL_VOICE_AFPLAY",
	"FLYWHEEL_VOICE_ANNOUNCE_BACKEND",
	"FLYWHEEL_VOICE_BRAIN_TIMEOUT_MS",
	"FLYWHEEL_VOICE_BRIDGE_HEALTH_PORT",
	"FLYWHEEL_VOICE_CLAUDE_BIN",
	"FLYWHEEL_VOICE_CONVERSE_BACKEND",
	"FLYWHEEL_VOICE_EDGE_TTS_ARGS",
	"FLYWHEEL_VOICE_EDGE_TTS_CMD",
	"FLYWHEEL_VOICE_FFMPEG",
	"FLYWHEEL_VOICE_FFPLAY",
	"FLYWHEEL_VOICE_GEMINI_KEY_ENV",
	"FLYWHEEL_VOICE_GEMINI_MODEL",
	"FLYWHEEL_VOICE_IDENTITY",
	"FLYWHEEL_VOICE_MIC_DEVICE",
	"FLYWHEEL_VOICE_TRANSCRIPT_DIR",
	"FLYWHEEL_VOICE_TTS_TIMEOUT_MS",
	"FLYWHEEL_VOICE_VOICE",
	"FLYWHEEL_XHS_STATE_DIR",
	"FLYWHEEL_ZOMBIE_BACKLOG_MIN",
] as const;

export const NON_FLAG_ALLOWLIST: Record<string, string> = {
	...Object.fromEntries(
		FLY1455_NON_FLAG_ENV.map((name) => [
			name,
			"FLY-1455 full-surface census: runtime value/context/plumbing or per-invocation choice, not a persistent on/off gate",
		]),
	),
	FLYWHEEL_AGENT_TEAM_ARGS:
		"plumbing: eval-safe shell array emitted by agent-team-transport, not an environment flag",
	FLYWHEEL_LEAD_CARRIER_START:
		"context: process start identity captured to validate the Lead carrier, not an on/off gate",
	FLYWHEEL_LICENSE_KEY:
		"secret value: onboarding license credential, never a feature toggle",
	FLYWHEEL_ONBOARD_ENDPOINT:
		"config value: onboarding service endpoint override, not an on/off gate",
	FLYWHEEL_PATROL_CONFIG:
		"path override for the hot-read patrol timing config (FLY-1687), not an on/off gate",
	// context / ids
	FLYWHEEL_EXEC_ID: "context: runner execution id",
	FLYWHEEL_ISSUE_ID: "context: linear issue id",
	FLYWHEEL_PROJECT_NAME: "context: project name",
	FLYWHEEL_PROJECT_DIR: "context: project dir",
	FLYWHEEL_TMUX_SESSION: "context: tmux session name",
	FLYWHEEL_RUNNER_BACKEND_ID: "context: runner backend id",
	FLYWHEEL_RUNNER_VENDOR_ID: "context: runner vendor id",
	FLYWHEEL_AGENT_BACKEND: "context: agent backend",
	FLYWHEEL_LEAD_ID: "context: owning Lead id",
	FLYWHEEL_RUNNER_START_POINT: "context: runner start point",
	FLYWHEEL_RUNNER_BACKEND: "config value: executor backend selector",
	FLYWHEEL_FOUNDER_REVIEW_REQUIRED:
		"context: sealed workflow node capability projected into the runner environment (FLY-1758), not an operator toggle",
	FLYWHEEL_FOUNDER_USER_ID: "context: founder discord id",
	FLYWHEEL_FOUNDER_DISCORD_USER_ID: "context: founder discord id (alt)",
	// plumbing / paths
	FLYWHEEL_BRIDGE_URL: "plumbing: bridge base URL",
	FLYWHEEL_BRIDGE_SOURCE_MODE:
		"plumbing: source-run build identity marker, not a rollout gate",
	FLYWHEEL_SANDBOX_REMOTE_URL: "plumbing: remote sandbox service URL",
	FLYWHEEL_COMM_DB: "plumbing: comm db path",
	FLYWHEEL_COMM_DIR: "plumbing: comm dir path",
	FLYWHEEL_COMM_ROOT: "plumbing: comm root path",
	FLYWHEEL_CLAIMS_DB: "plumbing: claims db path",
	FLYWHEEL_GATE_MARKER_DIR: "plumbing: gate marker dir",
	FLYWHEEL_CMUX_CLOSE_REQUEST_FILE:
		"plumbing: cmux close-request marker file path (FLY-685)",
	FLYWHEEL_CMUX_MAINTENANCE_MARKER:
		"plumbing: cmux watcher maintenance marker path override for isolated recovery QA (FLY-1944)",
	FLYWHEEL_CMUX_TIMEOUT_KILL_GRACE:
		"numeric tuning: bounded cmux process-tree TERM-to-KILL grace in seconds (FLY-1944)",
	FLYWHEEL_CMUX_WATCHER_EVENT_STALE_SECONDS:
		"numeric tuning: cmux watcher event-backlog stale threshold in seconds (FLY-1944)",
	FLYWHEEL_CMUX_WATCHER_HEARTBEAT:
		"plumbing: cmux watcher heartbeat file path override for isolated recovery QA (FLY-1944)",
	FLYWHEEL_CMUX_WATCHER_HEARTBEAT_STALE_SECONDS:
		"numeric tuning: cmux watcher heartbeat stale threshold in seconds (FLY-1944)",
	FLYWHEEL_CMUX_WATCHER_LOCK_DIR:
		"plumbing: cmux watcher owner-lock directory override for isolated recovery QA (FLY-1944)",
	FLYWHEEL_CMUX_WATCHER_PARK_TTL_SECONDS:
		"numeric tuning: cmux watcher maintenance-park alert threshold in seconds (FLY-1944)",
	FLYWHEEL_CMUX_WATCHER_STARTUP_GRACE_SECONDS:
		"numeric tuning: loaded-without-owner startup grace in seconds (FLY-1944)",
	FLYWHEEL_TMUX_3_7C_BIN:
		"plumbing: exact tmux 3.7c binary path required by the no-skip compatibility gate (FLY-1944)",
	FLYWHEEL_CMUX_VIEW_HELPER_BIN:
		"plumbing: absolute runner-view reconnect helper path (FLY-1884)",
	FLYWHEEL_CMUX_ATTACH_TMUX_BIN:
		"plumbing: absolute tmux executable pinned into persisted cmux commands (FLY-1884)",
	FLYWHEEL_CMUX_ATTACH_HEAL_STATE:
		"plumbing: durable bounded attach-recovery state path (FLY-1884)",
	FLYWHEEL_CMUX_ATTACH_RETRIES:
		"tuning knob: attach sends reserved before one native pane rebuild (FLY-1884)",
	FLYWHEEL_CMUX_NODE_STATUS_BIN:
		"plumbing: absolute windowless-node status helper path (FLY-1884)",
	FLYWHEEL_CMUX_NODE_STATUS_DIR:
		"plumbing: atomic status-file directory for windowless node surfaces (FLY-1884)",
	FLYWHEEL_CMUX_NODE_RECENT_HOURS:
		"tuning knob: recent operational-terminal roster lookback hours (FLY-1884)",
	FLYWHEEL_CMUX_NODE_SUMMARY_TTL_HOURS:
		"tuning knob: founder-visible terminal node summary retention (FLY-1884)",
	FLYWHEEL_CMUX_NODE_TABS_MAX:
		"tuning knob: terminal-summary-only cmux node tab cap (FLY-1884)",
	FLYWHEEL_CMUX_PREPARED_ABSENT_PASSES:
		"tuning knob: determinate absent passes before stale prepared receipt GC (FLY-1884)",
	FLYWHEEL_CMUX_PREPARED_DRIFT_PASSES:
		"tuning knob: determinate drift passes before stale prepared receipt release (FLY-1884)",
	FLYWHEEL_CMUX_PREPARED_MIN_AGE_SECONDS:
		"tuning knob: minimum prepared receipt age before recovery counters advance (FLY-1884)",
	FLYWHEEL_REPO_ROOT: "plumbing: repo root path",
	FLYWHEEL_DIR: "plumbing: state dir root",
	FLYWHEEL_STATE_DIR: "plumbing: state dir",
	FLYWHEEL_PROJECTS_FILE:
		"plumbing: canonical Lead identity registry path selector (FLY-1726), not a rollout gate",
	FLYWHEEL_REPORTS_DIR: "plumbing: reports dir",
	FLYWHEEL_COMPLETE_MARKER_DIR:
		"plumbing: complete-failed marker dir override for isolated slot runtimes (FLY-1608)",
	FLYWHEEL_DELIVERY_SECRET_PATH:
		"plumbing: versioned 0600 HMAC delivery-secret key path (FLY-1279); defaults to ~/.flywheel/delivery-secret and every isolated QA Bridge MUST point it at its own slot dir, moved off the flag table by FLY-1809 because it is a path, not a switch",
	FLYWHEEL_HOOK_SOURCE_DIR: "plumbing: hook source dir",
	FLYWHEEL_HOOKS_DIR: "plumbing: hooks dir",
	FLYWHEEL_BIN_DIR: "plumbing: bin dir",
	FLYWHEEL_LAND_STATUS_PATH: "plumbing: land-status path",
	FLYWHEEL_MISROUTE_ARCHIVE_DIR: "plumbing: misroute archive dir",
	FLYWHEEL_ALERT_QUEUE_DIR: "plumbing: alert queue dir",
	FLYWHEEL_QUOTA_MONITOR_BIN: "plumbing: external quota-monitor executable",
	FLYWHEEL_ALERT_DEADLETTER_DIR: "plumbing: alert deadletter dir",
	FLYWHEEL_LEAD_LEASE_DB:
		"plumbing: durable Lead identity lease and authorization audit db path (FLY-1309)",
	FLYWHEEL_LEAD_EPISODE_DB:
		"plumbing: deduplicated Lead identity incident episode db path (FLY-1309)",
	FLYWHEEL_PUBLISH_BROKER_SOCKET:
		"plumbing: publish-broker unix socket path (FLY-1062)",
	FLYWHEEL_PUBLISH_AUDIT_PATH: "plumbing: publish audit JSONL path (FLY-1062)",
	FLYWHEEL_PUBLISH_APPROVAL_CHANNEL:
		"config value: publish-approval Discord channel id (FLY-1062)",
	FLYWHEEL_FLEET_SANITIZE:
		"plumbing: fleet-sanitize.sh scanner path override (FLY-1062 broker gate; tests point it at stubs)",
	FLYWHEEL_CLAUDE_ACCOUNTS_PATH:
		"plumbing: claude account-state json path (FLY-696)",
	FLYWHEEL_CLAUDE_ACCOUNTS_LOCK:
		"plumbing: shared claude account switch lock path (FLY-1256 daemon reuses the FLY-696/852 lock)",
	FLYWHEEL_CLAUDE_TRANSITION_JOURNAL:
		"plumbing: crash-recoverable Claude Keychain transition journal path (FLY-1252)",
	FLYWHEEL_CLAUDE_PROFILES_DIR:
		"plumbing: claude profile pool directory (FLY-1256 daemon reuses the existing credential pool)",
	FLYWHEEL_CLAUDE_JSON:
		"plumbing: machine claude identity json path (FLY-865; scratch override for FLY-1182 QA)",
	FLYWHEEL_ACCOUNT_PENDING_PATH:
		"plumbing: account_switch_pending store path (FLY-696)",
	FLYWHEEL_CLAUDE_PROFILE_BIN:
		"plumbing: flywheel-claude-profile script path (FLY-696)",
	FLYWHEEL_CLAUDE_SECURITY_BIN:
		"plumbing: macOS security executable override for scratch-keychain QA (FLY-1256)",
	FLYWHEEL_CLAUDE_KEYCHAIN:
		"plumbing: optional macOS keychain path for isolated profile credentials (FLY-1256)",
	FLYWHEEL_CLAUDE_KEYCHAIN_ACCOUNT:
		"config value: machine Keychain item account selector (FLY-1256)",
	FLYWHEEL_CLAUDE_KEYCHAIN_SERVICE:
		"config value: machine Keychain item service selector (FLY-1256)",
	FLYWHEEL_CLAUDE_LOCK_DELEGATED:
		"internal contract: parent lock-holder pid passed to the profile script (FLY-852 anti-deadlock; validated against the live holder marker)",
	FLYWHEEL_LEASE_PROOF:
		"internal contract: non-secret account-lock ownership proof passed to delegated mutation helpers (FLY-1252)",
	FLYWHEEL_CLAUDE_OAUTH_ENDPOINT:
		"config value: OAuth token-refresh endpoint override for the freshness helper (FLY-871; enable-gate spike pins the exact contract without a code change)",
	FLYWHEEL_PROFILE_IDENTITY_ENDPOINT:
		"config value: OAuth profile identity endpoint override for hermetic FLY-1252 tests",
	FLYWHEEL_CLAUDE_OAUTH_CLIENT_ID:
		"config value: OAuth public client id override for the freshness helper (FLY-871)",
	FLYWHEEL_ACCOUNT_LEDGER_PATH:
		"plumbing: account-ledger json path override (FLY-871)",
	FLYWHEEL_INFRA_BOT_USER_ID:
		"context: Codex Infra Bot discord user id, for @-mention on account-switch assignment posts (FLY-871)",
	FLYWHEEL_BRIDGE_LOOP_GUARD_LOG: "plumbing: event-loop guard log path",
	FLYWHEEL_BRIDGE_LOOP_GUARD_HEARTBEAT_MS:
		"tuning knob: event-loop guard heartbeat cadence",
	FLYWHEEL_BRIDGE_LOOP_GUARD_STALL_MS:
		"tuning knob: event-loop guard stall threshold",
	FLYWHEEL_BRIDGE_LOOP_GUARD_CHECK_MS:
		"tuning knob: event-loop guard worker check cadence",
	FLYWHEEL_LEAD_ALERT_BIN:
		"plumbing: lead-alert executable override for hermetic quota-monitor QA (FLY-1256)",
	FLYWHEEL_RESTART_STORM_GATE_BIN:
		"plumbing: restart-storm gate executable path override (FLY-1501)",
	FLYWHEEL_META_ALERT_BIN:
		"plumbing: kernel-independent meta-alert executable path override (FLY-1501)",
	FLYWHEEL_RESTART_STORM_WINDOW_SEC:
		"numeric tuning: restart-storm rolling window in seconds (FLY-1501)",
	FLYWHEEL_RESTART_STORM_MAX:
		"numeric tuning: restart-storm attempts allowed per window (FLY-1501)",
	FLYWHEEL_RESTART_STORM_LOCK_DEADLINE_SEC:
		"numeric tuning: restart-storm fcntl acquisition deadline (FLY-1501)",
	FLYWHEEL_META_ALERT_TIMEOUT_S:
		"numeric tuning: bound on the brake-unavailable alert from a launch path (FLY-1501)",
	FLYWHEEL_RESTART_STORM_FAULT:
		"internal test-only fault injection seam; never set in production launch environments (FLY-1501)",
	FLYWHEEL_QUOTA_PIDFILE:
		"plumbing: external quota-monitor singleton pidfile path (FLY-1256)",
	FLYWHEEL_QUOTA_RUN_MARKER:
		"plumbing: external quota-monitor graceful-exit marker path (FLY-1256)",
	FLYWHEEL_QUOTA_HEALTH_MARKER:
		"plumbing: external quota-monitor completed-tick evidence path (FLY-1182)",
	FLYWHEEL_QUOTA_MONITOR_CONFIG:
		"config value: external quota-monitor runtime config path (FLY-1256)",
	FLYWHEEL_QUOTA_MONITOR_DIST:
		"plumbing: deployed quota-monitor entrypoint path (FLY-1256 wrapper; FLY-1182 rebuild daemon-identity check)",
	FLYWHEEL_POOL_REBUILD_JOURNAL:
		"plumbing: restart-safe Claude pool rebuild journal path (FLY-1182)",
	FLYWHEEL_POOL_REBUILD_LOCK:
		"plumbing: Claude pool rebuild generation-claim directory (FLY-1182)",
	FLYWHEEL_POOL_REBUILD_CONFIG_PREIMAGE:
		"plumbing: frozen quota config rollback preimage path (FLY-1182)",
	FLYWHEEL_PROFILE_IDENTITY_MAP:
		"plumbing: canonical Claude profile identity-map path (FLY-1182)",
	FLYWHEEL_CLAUDE_JSON_LOCK:
		"plumbing: machine Claude display-identity lock path (FLY-1182)",
	FLYWHEEL_QUOTA_LAUNCH_LABEL:
		"config value: external quota-monitor launchd service label (FLY-1182)",
	FLYWHEEL_QUOTA_PLIST_DEST:
		"plumbing: external quota-monitor LaunchAgent plist path (FLY-1182)",
	FLYWHEEL_QUOTA_LAUNCHCTL_BIN:
		"plumbing: launchctl executable override for hermetic pool-rebuild QA (FLY-1182)",
	FLYWHEEL_JANITOR_LAUNCHCTL:
		"plumbing: launchctl executable override for hermetic log-janitor installer QA (FLY-1330)",
	FLYWHEEL_JANITOR_REPORT_CHANNEL:
		"config value: tri-state log-janitor Discord destination (unset inherits FLYWHEEL_NOTIFY_CHANNEL, empty disables, non-empty overrides) for FLY-1330, not a persistent on/off rollout gate",
	FLYWHEEL_QUOTA_STATUSLINE_CACHE:
		"plumbing: statusline usage cache output path (FLY-1256)",
	FLYWHEEL_QUOTA_TMUX_SOCKET:
		"plumbing: tmux socket name for isolated quota revive scans (FLY-1256)",
	FLYWHEEL_QUOTA_STATE_PATH:
		"plumbing: external quota-monitor durable state path (FLY-1256)",
	FLYWHEEL_QUOTA_CONFIRMATION_DIR:
		"plumbing: durable quota-switch confirmation evidence directory (FLY-1182)",
	FLYWHEEL_QUOTA_API_BASE:
		"config value: OAuth usage API base URL override (FLY-1256; local mock in QA)",
	FLYWHEEL_QA_STALL_INBOX_LOOP_LEAD:
		"internal QA-only fault seam: Lead id whose inbox loop stalls only when the effective FLYWHEEL_COMM_ROOT/FLYWHEEL_COMM_DIR is below the OS temp root and outside ~/.flywheel (FLY-1393)",
	FLYWHEEL_QUOTA_ALERT_MENTION_USER:
		"config value: Discord user id mentioned by actionable quota alerts (FLY-1252)",
	FLYWHEEL_QUOTA_ALERT_SEVERE_CHANNEL_ID:
		"config value: secondary Discord channel id for severe quota alerts (FLY-1252)",
	// secrets / token env names
	FLYWHEEL_INGEST_TOKEN: "secret: ingest token",
	FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL:
		"secret: short-lived per-execution workflow submission credential",
	FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED:
		"plumbing: engine-owned workflow submission credential expectation sentinel (FLY-1425)",
	FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL:
		"secret: one-shot generalized workflow output credential",
	FLYWHEEL_ALERT_REPAIR_BOT_TOKEN_ENV:
		"config value: repair-bot token env NAME",
	// value config (non-boolean)
	FLYWHEEL_PROJECTS: "config value: inline projects json (env-pin)",
	FLYWHEEL_COMM_BACKEND: "config value: comm backend",
	FLYWHEEL_LEAD_BACKEND: "config value: Lead runtime backend",
	FLYWHEEL_MEMORY_MODEL: "config value: memory model",
	FLYWHEEL_LEAD_MODEL: "config value: per-lead model (fleet)",
	FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID: "config value: alert channel id",
	FLYWHEEL_INFRA_BOT_CHAT_CHANNEL_ID: "config value: infra bot chat channel id",
	FLYWHEEL_CLAUDE_INFRA_BOT_USER_ID:
		"config value: Claude infra bot Discord user id",
	FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN: "secret: alert dispatch bot token",
	FLYWHEEL_NOTIFY_CHANNEL: "config value: restart notification channel id",
	FLYWHEEL_ROUNDTABLE_GUILD_ID: "config value: roundtable Discord guild id",
	FLYWHEEL_ROUNDTABLE_CHANNEL_ID: "config value: roundtable Discord channel id",
	FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS:
		"config value: comma-separated cross-department Discord channel ids (FLY-267), read by BOTH the Codex lead-actions MCP child (poll + mention-gate) and the Bridge voice router; configured per Lead via the launcher / ~/.flywheel/.env, moved off the flag table by FLY-1809 because it is a channel id, not a switch",
	FLYWHEEL_ROUNDTABLE_BOT_TOKEN_ENV:
		"config value: roundtable bot token env name",
	FLYWHEEL_ROUNDTABLE_BOT_USER_ID:
		"config value: roundtable bot Discord user id",
	FLYWHEEL_ROUNDTABLE_TRIGGER_MODE: "config value: roundtable trigger mode",
	FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD:
		"config value: roundtable reply routing mode",
	FLYWHEEL_FLY324_SWEEP_EXCLUDE: "config value: sweep exclude list",
	FLYWHEEL_FOUNDER_AUTO_APPROVE_DENYLIST:
		"config value: comma-separated projects excluded from founder auto-approve (FLY-799)",
	FLYWHEEL_DIGEST_CHANNEL: "config value: daily digest channel id (FLY-727)",
	FLYWHEEL_DIGEST_TZ: "config value: daily digest timezone (FLY-727)",
	FLYWHEEL_FOUNDER_TZ:
		"config value: founder local timezone override (FLY-1319)",
	FLYWHEEL_FOUNDER_CONSENT_ENABLED:
		"legacy alias of DECISION_MODE (the enum gate is registered)",
	FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE_EFFECTIVE:
		"internal derived var (SET by mcp-config to propagate, not a founder gate)",
	// FLY-766 chrome-reaper: the enable gate itself is a registered kill_switch
	// flag (chrome_session_reaper); these are its two numeric tuning knobs plus
	// one internal ops safety lever (deliberately NOT a founder dashboard flag —
	// it opts into reaping unattributed Chrome, which could touch a human's own
	// browser, so it stays an internal env lever, not a founder-toggle).
	FLYWHEEL_CHROME_REAPER_ORPHAN_GRACE_MIN:
		"tuning knob: chrome-reaper orphan idle grace minutes (FLY-766)",
	FLYWHEEL_CHROME_REAPER_INTERVAL_MS:
		"tuning knob: chrome-reaper sweep interval ms (FLY-766)",
	FLY1867_POLICY_PRE_CAS_PAUSE_MS:
		"test-only tuning: bounded pre-CAS pause for deterministic policy-writer race coverage (FLY-1867)",
	FLY1867_POLICY_LOCK_TIMEOUT_SECONDS:
		"test and operator tuning: bounded policy-writer lock acquisition deadline (FLY-1867)",
	// tuning knobs (numeric)
	// FLY-1560: the out-of-process liveness probe's four numeric knobs. They were
	// renamed FLYWHEEL_WATCHDOG_* → FLYWHEEL_LIVENESS_* with the /health key; the
	// three MANIFEST/STALLED names were never registered at all, so setting the
	// knob the shipped probe actually reads used to fail as "unknown".
	FLYWHEEL_LIVENESS_DISABLED_REMINDER_MIN:
		"tuning knob: disabled liveness lane reminder cadence minutes (FLY-1393, renamed FLY-1560)",
	FLYWHEEL_LIVENESS_MANIFEST_GRACE_MIN:
		"tuning knob: liveness manifest degraded-observation grace minutes (FLY-1393, renamed FLY-1560)",
	FLYWHEEL_LIVENESS_MANIFEST_DEGRADED_MIN:
		"tuning knob: consecutive degraded observations before paging (FLY-1393, renamed FLY-1560)",
	FLYWHEEL_LIVENESS_STALLED_ESCALATE_MIN:
		"tuning knob: consecutive W-2 stalled observations before paging (FLY-1393, renamed FLY-1560)",
	FLYWHEEL_REPORT_SHOT_WIDTH: "tuning knob: screenshot width",
	FLYWHEEL_ALERT_DRAIN_STUCK_CYCLES: "tuning knob: alert drain cycles",
	FLYWHEEL_ALERT_QUEUE_MAX: "tuning knob: alert queue max",
	FLYWHEEL_ALERT_RATE_PER_MIN: "tuning knob: alert delivery rate per minute",
	FLYWHEEL_ALERT_REPLAY_FRESHNESS:
		"tuning knob: delayed alert replay policy, accept_delayed or drop_stale (FLY-1764)",
	FLYWHEEL_MAILBOX_WRITE_TIMEOUT_MS: "tuning knob: mailbox write timeout",
	FLYWHEEL_MAILBOX_ACK_LEASE_MS:
		"numeric tuning: mailbox agent-ack lease duration (FLY-1573)",
	FLYWHEEL_MAILBOX_BATCH_WINDOW_MS:
		"numeric tuning: mailbox grouping window (FLY-1573)",
	FLYWHEEL_MAILBOX_BATCH_MAX:
		"numeric tuning: mailbox messages per batch (FLY-1573)",
	FLYWHEEL_MAILBOX_INFLIGHT_BATCHES:
		"numeric tuning: mailbox in-flight batch limit (FLY-1573)",
	FLYWHEEL_MAILBOX_LEASE_RETRY_MAX:
		"numeric tuning: mailbox unacked lease retry limit (FLY-1573)",
	FLYWHEEL_MAILBOX_DEADLETTER_WINDOW_MS:
		"numeric tuning: mailbox dead-letter notification window (FLY-1573)",
	FLYWHEEL_MAILBOX_UNAVAILABLE_RETRY_MAX:
		"numeric tuning: unavailable mailbox delivery retry limit (FLY-1750)",
	FLYWHEEL_LAND_CLEANUP_GRACE_MS:
		"tuning knob: per-session land cleanup opportunity grace period (FLY-1375)",
	FLYWHEEL_CLAUDE_REVIEW_TIMEOUT_MS:
		"tuning knob: active Claude review subprocess timeout (FLY-1254)",
	FLYWHEEL_CRASH_REAP_GRACE_MIN: "tuning knob: crash reap grace minutes",
	FLYWHEEL_PARKED_PHASE_STALE_HOURS:
		"tuning knob: parked DAG workflow reclaim time backstop hours (FLY-1204)",
	FLYWHEEL_BRIDGE_SHUTDOWN_TIMEOUT_MS: "tuning knob: bridge shutdown timeout",
	FLYWHEEL_FOUNDER_MILESTONE_PATROL_TICKS:
		"tuning knob: milestone patrol cadence (FLY-725)",
	FLYWHEEL_FOUNDER_MILESTONE_LOOKBACK_HOURS:
		"tuning knob: milestone patrol lookback (FLY-725)",
	FLYWHEEL_FOUNDER_MILESTONE_GRACE_MS:
		"tuning knob: milestone notify grace window (FLY-725)",
	FLYWHEEL_FOUNDER_REVIEW_ORPHAN_STALE_HOURS:
		"numeric tuning: unanswered founder_review age threshold in hours (FLY-1940)",
	FLYWHEEL_FOUNDER_REVIEW_ORPHAN_DELIVERY_GRACE_MINUTES:
		"numeric tuning: missing founder card grace period with a 10-minute minimum (FLY-1940)",
	FLYWHEEL_CRON_STALE_TTL_MIN:
		"tuning knob: cron stale-blocker TTL minutes (FLY-742)",
	FLYWHEEL_QA_RECONCILE_EVERY_N_TICKS:
		"tuning knob: dead auto-QA recovery reconcile cadence (FLY-1279 D3b)",
	FLYWHEEL_POOL_REBUILD_TIMEOUT_MS:
		"tuning knob: pool-rebuild launchd transition and health wait timeout (FLY-1182)",
	FLYWHEEL_RECEIPT_EXEC_PUSH_CAP:
		"tuning knob: initial per-execution mailbox push budget (FLY-1392)",
	FLYWHEEL_RECEIPT_EXEC_PUSH_WINDOW_MIN:
		"tuning knob: initial mailbox push budget window in minutes (FLY-1392)",
	FLYWHEEL_RECEIPT_WAKE_T1_MS:
		"tuning knob: initial send terminal wake delay in milliseconds (FLY-1392)",
	FLYWHEEL_RECEIPT_WINDOW_P0_MIN:
		"tuning knob: P0 Lead-inbox receipt deadline in minutes (FLY-1426)",
	FLYWHEEL_RECEIPT_WINDOW_P1_MIN:
		"tuning knob: P1 Lead-inbox receipt deadline in minutes (FLY-1426)",
	FLYWHEEL_RECEIPT_WINDOW_P2_MIN:
		"tuning knob: P2 Lead-inbox receipt deadline in minutes (FLY-1426)",
	FLYWHEEL_RECEIPT_WINDOW_P3_MIN:
		"tuning knob: P3 Lead-inbox receipt deadline in minutes (FLY-1426)",
	FLYWHEEL_ALERT_COPY_TO_CHANNEL:
		"internal ops lever: optional Discord observation copy for owner-mailbox infra alerts, default-off (FLY-1764)",
	FLYWHEEL_ALERT_SENDER_TOKEN_ENV:
		"config value: single alert-sender token env NAME (D2), default-unset = own-bot chain (FLY-927)",
};

/**
 * Boolean project-config keys that are ordinary configuration, not gates.
 *
 * Classification rule (FLY-1455): a gate turns behavior/pipeline paths on or
 * off. Founder preferences, consent, and per-run-overridable choices stay out
 * of flag governance and must never enter retirement scanning.
 */
export const NON_FLAG_CONFIG_KEYS: Record<string, string> = {
	"skills.enabled":
		"dormant legacy schema field with no runtime consumer; it currently switches no behavior and must not pretend to be an operable flag",
	"skills.proofshot.vision_default":
		"founder visual-review preference; per-run labels can override it, and preferences never enter flag retirement scans",
	"xiaohongshu_learning.video_opt_in":
		"explicit consent to send video to Gemini, not a rollout gate; consent must never be inferred, retired, or cleaned by flag scans",
};

export const RETIRED_FLAGS = [
	{ envVar: "FLYWHEEL_BRIDGE_WATCHDOG", retiredBy: "FLY-1560" },
	{ envVar: "FLYWHEEL_BRIDGE_WATCHDOG_LOG", retiredBy: "FLY-1560" },
	{
		envVar: "FLYWHEEL_BRIDGE_WATCHDOG_HEARTBEAT_MS",
		retiredBy: "FLY-1560",
	},
	{ envVar: "FLYWHEEL_BRIDGE_WATCHDOG_STALL_MS", retiredBy: "FLY-1560" },
	{ envVar: "FLYWHEEL_BRIDGE_WATCHDOG_CHECK_MS", retiredBy: "FLY-1560" },
	{ envVar: "FLYWHEEL_FOUNDER_REPLY_WATCHDOG", retiredBy: "FLY-1560" },
	{ envVar: "FLYWHEEL_WATCHDOG_BLOCKED", retiredBy: "FLY-1560" },
	{ envVar: "FLYWHEEL_WATCHDOG_LIVENESS", retiredBy: "FLY-1560" },
	// The Lead-pane poll interval died with its poller; it has no read site left.
	{ envVar: "FLYWHEEL_LEAD_WATCHDOG_INTERVAL_MS", retiredBy: "FLY-1560" },
	// Probe knobs renamed FLYWHEEL_WATCHDOG_* → FLYWHEEL_LIVENESS_* (see allowlist).
	{ envVar: "FLYWHEEL_WATCHDOG_DISABLED_REMINDER_MIN", retiredBy: "FLY-1560" },
	{ envVar: "FLYWHEEL_WATCHDOG_MANIFEST_GRACE_MIN", retiredBy: "FLY-1560" },
	{ envVar: "FLYWHEEL_WATCHDOG_MANIFEST_DEGRADED_MIN", retiredBy: "FLY-1560" },
	{ envVar: "FLYWHEEL_WATCHDOG_STALLED_ESCALATE_MIN", retiredBy: "FLY-1560" },
	{ envVar: "FLYWHEEL_IDLE_POLL_MS", retiredBy: "FLY-1560" },
	{ envVar: "FLYWHEEL_QUIET_PERSIST_DEDUP", retiredBy: "FLY-1560" },
	{ envVar: "FLYWHEEL_QUIET_CLASSIFIER", retiredBy: "FLY-1560" },
	{ envVar: "FLYWHEEL_THREE_STAGE", retiredBy: "FLY-1674" },
	{ envVar: "FLYWHEEL_THREE_STAGE_KEEPALIVE", retiredBy: "FLY-1674" },
	{ envVar: "FLYWHEEL_THREE_STAGE_QA_RESPAWN", retiredBy: "FLY-1674" },
	{ envVar: "FLYWHEEL_THREE_STAGE_CODEX_IMPLEMENT", retiredBy: "FLY-1674" },
	{ envVar: "FLYWHEEL_THREE_STAGE_CODEX_DESIGN", retiredBy: "FLY-1674" },
	{ envVar: "FLYWHEEL_PARK_BIASED_HANDOFF", retiredBy: "FLY-1674" },
	{ envVar: "FLYWHEEL_RETEST_HEAD_DELTA_GUARD", retiredBy: "FLY-1674" },
	{ envVar: "FLYWHEEL_RECEIPT_FOUNDATION", retiredBy: "FLY-1645" },
	{ envVar: "FLYWHEEL_MAILBOX_DISCORD", retiredBy: "FLY-1645" },
	{ envVar: "FLYWHEEL_CHAT_RECEIPTS", retiredBy: "FLY-1645" },
	{ envVar: "FLYWHEEL_WATCHDOG_LOOP_HEARTBEAT", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_RECEIPT_ACTIVATION_DRY_RUN", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_LEAD_PENDING_ESCALATION", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_STUCK_DETECT", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_STUCK_FOUNDER_PAGE", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_WATCHDOG_JUDGE", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_STUCK_PANE_CONFIRM", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_WATCHDOG_JUDGE_BIN", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_WATCHDOG_JUDGE_MODEL", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_WATCHDOG_JUDGE_TIMEOUT_MS", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_JUDGE_COOLDOWN_MS", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_JUDGE_SUPPRESS_TTL_MS", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_STUCK_FRAME_GAP_MS", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_STUCK_CONFIRM_PER_TICK", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_STUCK_CONFIRM_DEADLINE_MS", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_DETECTION_LEAD_GRACE_MS", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_DETECTION_FLEET_THRESHOLD", retiredBy: "FLY-1570" },
	{
		envVar: "FLYWHEEL_DETECTION_RECONCILE_EVERY_N_TICKS",
		retiredBy: "FLY-1570",
	},
	{ envVar: "FLYWHEEL_CLEARING_TTL_MS", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_MISROUTE_PATROL", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_ZOMBIE_GATE_RESOLVE", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_PANE_IDLE_SUPPRESS", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_CODEX_HOLD_NUDGE", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_CODEX_HOLD_NUDGE_MS", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_GAP_SCAN_EVERY_N_TICKS", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_GAP_ASK_UNANSWERED_MS", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_GAP_UNCONSUMED_MS", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_GAP_COMM_WINDOW_MS", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_GAP_PROGRESS_STALL_MS", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_FRAME_INTERVAL_MS", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_FRAME_CAPTURES_PER_TICK", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_RECEIPT_UNPROCESSED_WINDOW_MIN", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_RECEIPT_REBIND_WINDOW_MIN", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_RECEIPT_RESEND_CAP", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_RECEIPT_WAKE_T2_MS", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_RECEIPT_WAKE_T3_MS", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_LEAD_NUDGE_BACKOFF_FACTOR", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_LEAD_NUDGE_CAP_MS", retiredBy: "FLY-1570" },
	{ envVar: "FLYWHEEL_LEAD_NUDGE_GRACE_MS", retiredBy: "FLY-1570" },
	{
		envVar: "FLYWHEEL_LEAD_NUDGE_PAGE_ANNIE_ROUNDS",
		retiredBy: "FLY-1570",
	},
	{ envVar: "FLYWHEEL_DETECTION_GAP_SCAN", retiredBy: "FLY-1393" },
	{ envVar: "FLYWHEEL_STUCK_ERRORSIG", retiredBy: "FLY-1393" },
	{ envVar: "FLYWHEEL_DETECTION_ESCALATION", retiredBy: "FLY-1393" },
	{ envVar: "FLYWHEEL_AUTO_REPAIR", retiredBy: "FLY-1243" },
	{ envVar: "FLYWHEEL_ALERT_THREADS", retiredBy: "FLY-1243" },
	{ envVar: "FLYWHEEL_ROUNDTABLE_ENABLED", retiredBy: "FLY-1243" },
	{ envVar: "FLYWHEEL_XHS_REVIEW", retiredBy: "FLY-1243" },
	{ envVar: "FLYWHEEL_ACCOUNT_SELF_HEAL", retiredBy: "FLY-1243" },
	{ envVar: "FLYWHEEL_NOTIFY_DIGEST_EXPECT", retiredBy: "FLY-1243" },
	{ envVar: "FLYWHEEL_PANE_MULTIFRAME", retiredBy: "FLY-1243" },
	{ envVar: "FLYWHEEL_PARK_WATCH", retiredBy: "FLY-1456" },
	{
		envVar: "FLYWHEEL_PARK_WATCH_EVERY_N_TICKS",
		retiredBy: "FLY-1456",
	},
	{ envVar: "FLYWHEEL_PARK_N1_MS", retiredBy: "FLY-1456" },
	{ envVar: "FLYWHEEL_PARK_N2_MS", retiredBy: "FLY-1456" },
	{ envVar: "FLYWHEEL_PARK_QA_N3_MS", retiredBy: "FLY-1456" },
	{ envVar: "FLYWHEEL_DELIVERY_ACK", retiredBy: "FLY-1456" },
	{ envVar: "FLYWHEEL_DELIVERY_UNCONSUMED_V2", retiredBy: "FLY-1456" },
	{ envVar: "FLYWHEEL_DELIVERY_ACK_TIMEOUT_MS", retiredBy: "FLY-1456" },
	{ envVar: "FLYWHEEL_DELIVERY_MAX_REDELIVER", retiredBy: "FLY-1456" },
	{
		envVar: "FLYWHEEL_DELIVERY_MAX_TRANSPORT_FAILURES",
		retiredBy: "FLY-1456",
	},
	{ envVar: "FLYWHEEL_ACK_LATE_WINDOW_MS", retiredBy: "FLY-1456" },
	{ envVar: "FLYWHEEL_LEGACY_DELIVERY_WATCHDOGS", retiredBy: "FLY-1456" },
	{ envVar: "FLYWHEEL_CHECKPOINT_WATCHDOG", retiredBy: "FLY-1456" },
	{ envVar: "FLYWHEEL_QUOTA_DAEMON_CUTOVER", retiredBy: "FLY-1456" },
	{ envVar: "FLYWHEEL_ENGINE_DECLARED_PARK", retiredBy: "FLY-1466" },
	{
		envVar: "FLYWHEEL_FOUNDER_DECISION_DEADLINE_MS",
		retiredBy: "FLY-1466",
	},
	{
		envVar: "FLYWHEEL_TERMINAL_RECEIPT_SETTLEMENT",
		retiredBy: "FLY-1466",
	},
	{ envVar: "FLYWHEEL_SWAP_PRESSURE_HIGH_PCT", retiredBy: "FLY-1501" },
	{ envVar: "FLYWHEEL_SWAP_PRESSURE_LOW_PCT", retiredBy: "FLY-1501" },
	{ envVar: "FLYWHEEL_RESTART_STORM_GATE", retiredBy: "FLY-1501" },
	{ envVar: "FLYWHEEL_LIVENESS_ALERTS", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_PRUNE_PARK_GUARD", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_READOPT_PARKED", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_TMUX_KEEPALIVE", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_CMUX_WAL_QUARANTINE", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_CMUX_ROSTER", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_CMUX_VIEW_INVARIANT", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_CMUX_STRICT_VIEW", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_CODEX_GATE_WAIT", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_DUAL_ACTIVE_SCAN", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_QUOTA_DEGRADED_SWITCH", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_QUOTA_WAKE", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_REVIEW_SEVERITY_POLICY", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_PROGRESS_RESUME", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_CMUX_CLOSE_REQUEST", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_FOUNDER_REVIEW_GATE_EXCLUDE", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_FOUNDER_AUTO_APPROVE", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_STALE_SHIP_REWAKE", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_AUTO_LINEAR_DONE", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_FOUNDER_REPLY_UNREACHABLE", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_ASK_HYGIENE", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_FOUNDER_MILESTONE_NOTIFY", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_ENGINE_UNLAUNCHED_TRIPWIRE", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_REMOTE_REPORTS", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_FLEET_CONSOLE", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_COMMDB_RESIDUE_HARVEST", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_TERMINAL_COMMDB_SYNC", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_CRON_STALE_GUARD", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_SHIP_GATE_REBIND", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_SHIP_GATE_RETIRE", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_SHIP_GATE_CARD", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_TIER2_PREFIX_NORM", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_VIEWER_SESSION_REAPER", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_CHROME_REAPER", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_FLEET_SENSOR_TMUX", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_LAND_NODE", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_VENDOR_AT_DISPATCH", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_COMMDB_PROTECTION", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_CONTINUITY_PREFLIGHT", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_PUSH_GUARD", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_DOA_BACKOFF", retiredBy: "FLY-1807" },
	{ envVar: "FLYWHEEL_GATEPOLLER_CIRCUIT", retiredBy: "FLY-1806" },
	{ envVar: "FLYWHEEL_FOUNDER_THREAD_NOTIFY", retiredBy: "FLY-1806" },
	{ envVar: "FLYWHEEL_FOUNDER_REPLY_DELIVER", retiredBy: "FLY-1806" },
	{ envVar: "FLYWHEEL_DEFERRED_FOUNDER_APPROVAL", retiredBy: "FLY-1806" },
	{ envVar: "FLYWHEEL_HELD_DECLINED_REPLY", retiredBy: "FLY-1806" },
	{ envVar: "FLYWHEEL_FOUNDER_NOTIFY_RETRY_MAX", retiredBy: "FLY-1806" },
	{ envVar: "FLYWHEEL_FOUNDER_REPLY_RETRY_MAX", retiredBy: "FLY-1806" },
	{ envVar: "FLYWHEEL_HEARTBEAT_READOPT", retiredBy: "FLY-1806" },
	{ envVar: "FLYWHEEL_LIVENESS_PANE_DEAD", retiredBy: "FLY-1806" },
	{ envVar: "FLYWHEEL_ISSUE_STATUS_WORD", retiredBy: "FLY-1806" },
	{ envVar: "FLYWHEEL_STALE_TERMINAL_CLOSE", retiredBy: "FLY-1806" },
	{ envVar: "FLYWHEEL_ZOMBIE_RECONCILE", retiredBy: "FLY-1806" },
	{ envVar: "FLYWHEEL_BOOT_SHA_CHECK", retiredBy: "FLY-1806" },
	{ envVar: "FLYWHEEL_WORKTREE_AUTOCLEAN", retiredBy: "FLY-1806" },
	{ envVar: "FLYWHEEL_BRIDGE_LOOP_GUARD", retiredBy: "FLY-1806" },
	{ envVar: "FLYWHEEL_ISSUE_STATUS_EMOJI", retiredBy: "FLY-1806" },
	{ envVar: "FLYWHEEL_ISSUE_ATTACH_PIN", retiredBy: "FLY-1806" },
	{ envVar: "FLYWHEEL_ISSUE_DISPLAY_REFRESH", retiredBy: "FLY-1806" },
	{ envVar: "FLYWHEEL_CRASH_REAPER", retiredBy: "FLY-1806" },
	{ envVar: "FLYWHEEL_COMMDB_FSM_RECONCILE", retiredBy: "FLY-1806" },
	{ envVar: "FLYWHEEL_TERMINAL_THREAD_ARCHIVE", retiredBy: "FLY-1806" },
	{ envVar: "FLYWHEEL_DISPOSITION_RECEIPT", retiredBy: "FLY-1806" },
	{ envVar: "FLYWHEEL_SHIP_READY_NOTIFY", retiredBy: "FLY-1806" },
	{ envVar: "FLYWHEEL_SHIP_READY_REMIND_MS", retiredBy: "FLY-1806" },
	{ envVar: "FLYWHEEL_CODEX_LEAD_TYPING", retiredBy: "FLY-1806" },
	{
		envVar: "FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE",
		retiredBy: "FLY-1806",
	},
	{ envVar: "FLYWHEEL_LEAD_CHROME_ENABLED", retiredBy: "FLY-1806" },
	{ envVar: "FLYWHEEL_ROUNDTABLE_THREAD_OWN_BOT", retiredBy: "FLY-1806" },
	{ envVar: "FLYWHEEL_CMUX_AUTOSTART_EXEC", retiredBy: "FLY-1806" },
	{ envVar: "FLYWHEEL_ACCOUNT_IDENTITY_CHECK", retiredBy: "FLY-1806" },
	{
		envVar: "FLYWHEEL_DONE_THREAD_RECONCILE_DRYRUN",
		retiredBy: "FLY-1806",
	},
	{ envVar: "FLYWHEEL_FOUNDER_UX_GATE_ENABLED", retiredBy: "FLY-1808" },
	{ envVar: "FLYWHEEL_RUNNER_AUTOCONTINUE", retiredBy: "FLY-1808" },
	{ envVar: "FLYWHEEL_AUTOCONTINUE_ARM_WINDOW_MS", retiredBy: "FLY-1808" },
	{ envVar: "FLYWHEEL_COMM_BYPASS_BRIDGE", retiredBy: "FLY-1808" },
	{ envVar: "FLYWHEEL_CMUX_LINKED_VIEW", retiredBy: "FLY-1808" },
	{ envVar: "FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH", retiredBy: "FLY-1808" },
	{ envVar: "FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES", retiredBy: "FLY-1808" },
	{ envVar: "FLYWHEEL_WORKFLOW_CLAIMS_WRITE", retiredBy: "FLY-1808" },
	{ envVar: "FLYWHEEL_WORKFLOW_CLAIMS_READ", retiredBy: "FLY-1808" },
	{ envVar: "FLYWHEEL_WORKFLOW_GATE_CARRIER", retiredBy: "FLY-1808" },
	{ envVar: "FLYWHEEL_ALERT_ROUTING", retiredBy: "FLY-1831" },
	{ envVar: "FLYWHEEL_ALERT_TICKETS", retiredBy: "FLY-1831" },
	{ envVar: "FLYWHEEL_DETECTION_AI_CLASSIFY", retiredBy: "FLY-1831" },
] as const;

export interface FlagTruthValidation {
	ok: boolean;
	errors: string[];
}

export function validateFlagTruthEnvironment(
	environmentEntries: readonly string[],
): FlagTruthValidation {
	const registered = new Set(
		FEATURE_FLAGS.flatMap((flag) => (flag.envVar ? [flag.envVar] : [])),
	);
	const tombstones = new Set(RETIRED_FLAGS.map((flag) => flag.envVar));
	const persistentExemptions = new Set(
		FLAG_EXEMPTIONS.filter(
			(entry) => entry.kind === "env" && entry.persistentEnvAllowed,
		).map((entry) => entry.name),
	);
	const transientExemptions = new Set(
		FLAG_EXEMPTIONS.filter(
			(entry) => entry.kind === "env" && !entry.persistentEnvAllowed,
		).map((entry) => entry.name),
	);
	const errors: string[] = [];
	for (const entry of environmentEntries) {
		const name = entry.split("=", 1)[0]?.trim();
		if (!name?.startsWith("FLYWHEEL_")) continue;
		if (tombstones.has(name as (typeof RETIRED_FLAGS)[number]["envVar"])) {
			errors.push(`${name}: 已退役假开关,删这行`);
			continue;
		}
		if (transientExemptions.has(name)) {
			errors.push(
				`${name}: transient exemption must not appear in a persistent environment`,
			);
			continue;
		}
		if (
			!(name in NON_FLAG_ALLOWLIST) &&
			!registered.has(name) &&
			!persistentExemptions.has(name)
		) {
			errors.push(`${name}: unknown FLYWHEEL environment variable`);
		}
	}
	return { ok: errors.length === 0, errors };
}

const REQUIRED_LIVENESS_ROWS = [
	"w1_process_liveness",
	"w2_delivery_loop",
	"w3_external_drift",
] as const;

export function validateLivenessManifest(value: unknown): FlagTruthValidation {
	const errors: string[] = [];
	if (!value || typeof value !== "object") {
		return { ok: false, errors: ["liveness manifest must be an object"] };
	}
	const manifest = value as {
		schema_version?: unknown;
		components?: Record<string, unknown>;
	};
	if (manifest.schema_version !== 2) {
		errors.push("liveness manifest schema_version must be 2");
	}
	for (const row of REQUIRED_LIVENESS_ROWS) {
		const component = manifest.components?.[row];
		if (!component || typeof component !== "object") {
			errors.push(`liveness manifest missing ${row}`);
			continue;
		}
		const state = component as {
			wired?: unknown;
			effective_enabled?: unknown;
			observation?: unknown;
			leads?: unknown;
			switch?: unknown;
			freshness?: unknown;
			last_check_started_at?: unknown;
			last_check_completed_at?: unknown;
			in_flight_age_ms?: unknown;
		};
		if (state.wired !== true) {
			errors.push(`liveness manifest ${row} must have wired=true`);
		}
		if (typeof state.effective_enabled !== "boolean") {
			errors.push(`liveness manifest ${row} effective_enabled must be boolean`);
		}
		if (row === "w1_process_liveness") {
			// FLY-1560 刀 6: W-1 is now driven by the HeartbeatService
			// reconcileMonitorLoss → reapOrphans span through LivenessCheckTracker.
			// The out-of-process probe judges health on `freshness` and
			// `in_flight_age_ms`; the validator guarantees those fields exist and
			// are well-typed so a missing field can never read as "healthy".
			if (state.switch !== "required") {
				errors.push(
					'liveness manifest w1_process_liveness switch must be "required" (no kill switch)',
				);
			}
			if (state.effective_enabled !== true) {
				errors.push(
					"liveness manifest w1_process_liveness effective_enabled must be true (no kill switch)",
				);
			}
			if (
				state.freshness !== "not_started" &&
				state.freshness !== "fresh" &&
				state.freshness !== "stale" &&
				state.freshness !== "in_flight"
			) {
				errors.push(
					"liveness manifest w1_process_liveness freshness must be not_started, fresh, stale or in_flight",
				);
			}
			for (const field of [
				"last_check_started_at",
				"last_check_completed_at",
			] as const) {
				const at = state[field];
				if (at !== null && typeof at !== "string") {
					errors.push(
						`liveness manifest w1_process_liveness ${field} must be an ISO string or null`,
					);
				}
			}
			const age = state.in_flight_age_ms;
			if (age !== null && typeof age !== "number") {
				errors.push(
					"liveness manifest w1_process_liveness in_flight_age_ms must be a number or null",
				);
			}
		}
		if (
			row === "w3_external_drift" &&
			state.observation !== "static_contract"
		) {
			errors.push(
				"liveness manifest w3_external_drift must have observation=static_contract",
			);
		}
		if (row === "w2_delivery_loop") {
			if (!Array.isArray(state.leads)) {
				errors.push(
					"liveness manifest w2_delivery_loop.leads must be an array",
				);
			} else {
				for (const [index, lead] of state.leads.entries()) {
					if (!lead || typeof lead !== "object") {
						errors.push(
							`liveness manifest w2_delivery_loop.leads[${index}] must be an object`,
						);
						continue;
					}
					const row = lead as { lead_id?: unknown; freshness?: unknown };
					if (typeof row.lead_id !== "string" || row.lead_id.trim() === "") {
						errors.push(
							`liveness manifest w2_delivery_loop.leads[${index}].lead_id must be a non-empty string`,
						);
					}
					if (row.freshness !== "fresh" && row.freshness !== "stale") {
						errors.push(
							`liveness manifest w2_delivery_loop.leads[${index}].freshness must be fresh or stale`,
						);
					}
				}
			}
		}
	}
	return { ok: errors.length === 0, errors };
}
