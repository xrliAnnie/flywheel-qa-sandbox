/**
 * FLY-709 — central feature-flag registry (single source of truth).
 *
 * Every Flywheel feature flag is declared here ONCE: what it controls, its
 * category, polarity, default, and — critically — WHERE and WHEN the code reads
 * it (`readSites[].timing`). The read-timing decides whether a flag can be live
 * (in-process) toggled: only flags whose every in-Bridge read is `call_time` are
 * `direct`-toggleable, because the running Bridge captured `.env` into its own
 * `process.env` at boot and a value read once at boot/construction will not
 * change without a restart.
 *
 * This registry is a CATALOG + declaration; the effective (current) value is
 * computed by `resolve.ts` from process.env + per-project config, reusing each
 * flag's real in-line semantics (byte-compat). It does NOT replace compound
 * policy functions (e.g. resolveAutoQaPolicy) — those stay; the registry lists
 * the individual layers (e.g. FLYWHEEL_AUTO_QA and qa.auto as two rows).
 *
 * Read `packages/teamlead/lead-rules-base/default-enable-policy.md` for the two
 * idioms (`!== "0"` default-on kill-switch vs `=== "1"` opt-in) and the
 * governance-gate hard exemptions (never web-toggleable).
 */

export type FlagCategory = "feature" | "kill_switch" | "governance_gate";
export type FlagSource = "env" | "project_config" | "code_default";
export type FlagPolarity = "default_on" | "opt_in";
/** env flags are Bridge-global; project_config flags are per-project. */
export type FlagScope = "bridge_global" | "project";
export type FlagValueKind = "bool" | "enum" | "value";
export type FlagToggleability = "direct" | "conversational" | "readonly";

/**
 * When the owning code reads the flag — the safety key for live toggling.
 * `call_time`: read from process.env / config each use → in-proc mutate is live.
 * `bridge_boot`: captured once when the Bridge process starts → needs restart.
 * `object_construction`: captured into a closure/const/route at build time → restart.
 * `cli_invocation`: read by a separate CLI process → not a Bridge live-toggle target.
 * `mixed`/unknown: treated conservatively as restart (never `direct`).
 */
export type ReadTiming =
	| "call_time"
	| "bridge_boot"
	| "object_construction"
	| "cli_invocation"
	| "mixed";

export interface FlagReadSite {
	/** Production source file (repo-relative). */
	file: string;
	/** Stable anchor: the function/class/const that reads the flag. */
	symbol: string;
	/** How the value is reached (drives the drift scanner). */
	pattern: "process.env" | "env-param" | "dynamic" | "config";
	timing: ReadTiming;
}

export interface FeatureFlagSpec {
	/** Stable key, e.g. "auto_qa_killswitch". */
	name: string;
	category: FlagCategory;
	source: FlagSource;
	scope: FlagScope;
	/** Present when source === "env". */
	envVar?: string;
	/** Present when source === "project_config" (dot path, e.g. "qa.auto"). */
	configKey?: string;
	polarity: FlagPolarity;
	valueKind: FlagValueKind;
	/** For valueKind === "enum": the allowed values. */
	enumValues?: string[];
	/** The effective value when nothing overrides it. */
	default: boolean | string;
	/** One-line human description (what it controls). */
	description: string;
	/** Every place the code reads this flag (timing evidence). */
	readSites: FlagReadSite[];
	toggleable: FlagToggleability;
	/**
	 * REQUIRED when toggleable === "direct": the test that proves an in-process
	 * `process.env` mutation is observed by the next real read (no reconstruction).
	 */
	directToggleProof?: string;
	/**
	 * Config validated by ConfigLoader but NOT loaded by the runtime (e.g.
	 * ponytail.enabled: run-infra deliberately leaves the project layer dormant).
	 * Dormant flags are read-only and report no effective value.
	 */
	dormant?: boolean;
	/** Optional note (e.g. Annie-exception). */
	note?: string;
}

// Helper builders keep the big table terse and consistent.
function envSite(
	file: string,
	symbol: string,
	timing: ReadTiming,
	pattern: FlagReadSite["pattern"] = "process.env",
): FlagReadSite {
	return { file, symbol, pattern, timing };
}

export const FEATURE_FLAGS: readonly FeatureFlagSpec[] = [
	// ─── env kill-switches / features, call_time → DIRECT-toggle candidates ───
	{
		name: "auto_qa_killswitch",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_AUTO_QA",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"全局关掉 code-review 后的 auto-QA runner spawn（叠在 qa.auto 上）",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/auto-qa-policy.ts",
				"resolveAutoQaPolicy",
				"call_time",
				"env-param",
			),
		],
		toggleable: "direct",
		directToggleProof:
			"resolve.direct-toggle.test:auto_qa_killswitch live-observe",
	},
	{
		// FLY-793: global hard kill-switch for the three-stage pipeline
		// (Design→Implement→QA). The PRIMARY toggle is the per-project
		// `pipeline.three_stage` config key; this env is a fleet-wide emergency OFF
		// override (unset → the feature may run per project; `=0` → force-off
		// everywhere). Read at call_time when a phase-session completes, so it can
		// gate a live handoff. readonly (not a founder dashboard toggle): the config
		// key is the intended per-project control, this env is an ops safety lever.
		name: "three_stage_killswitch",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_THREE_STAGE",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"全局关掉三段式 pipeline（Design→Implement→QA）；主开关是 per-project pipeline.three_stage config，本 env 是 fleet-wide 紧急 OFF（FLY-793）",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/three-stage-policy.ts",
				"resolveThreeStagePolicy",
				"call_time",
				"env-param",
			),
		],
		toggleable: "readonly",
		note: "三段式主开关是 per-project pipeline.three_stage config；本 env=0 是全局紧急关，改后需重启 Bridge。",
	},
	{
		// FLY-795: global kill-switch for restart-resilient resume. Default ON: a
		// re-dispatched dead runner resumes from its committed progress.md cursor
		// (reusing 793's shareParentBranch/startPoint worktree mechanism) instead of
		// starting over. `=0` = fully revert to the pre-795 fresh-every-time behavior
		// — the teamlead resume computer produces no progressResume AND the Blueprint
		// PROGRESS LEDGER write-discipline prompt line is suppressed (byte-identical
		// prompt). readonly ops safety lever, not a founder dashboard toggle.
		name: "progress_resume_killswitch",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_PROGRESS_RESUME",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"全局关掉 restart-resilient resume（重启/terminate/reboot 后从 progress.md 游标续做）；=0 = 纯 fresh 现状 + 抑制写台账纪律 prompt（FLY-795）",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/run-infra.ts",
				"resumeComputer",
				"call_time",
				"env-param",
			),
			envSite(
				"packages/edge-worker/src/Blueprint.ts",
				"buildSystemPromptLines",
				"call_time",
				"env-param",
			),
		],
		toggleable: "readonly",
		note: "重启/terminate resume 主机制；=0 全局关，改后需重启 Bridge。",
	},
	{
		// FLY-685: close_runner (Bridge) writes a cmux pin close-request marker on a
		// successful window kill; the cmux-sync watcher drains it and closes the
		// stale sidebar pin immediately. readonly (not web-toggleable): the switch
		// is honored on BOTH the Bridge TS side (marker write) and the separate
		// long-running bash watcher (marker drain, its own env) — flipping the
		// Bridge's process.env would not live-affect the watcher, so it needs an
		// env change + restart of both, never a single-process live toggle.
		name: "cmux_close_request_killswitch",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_CMUX_CLOSE_REQUEST",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"close_runner 写 cmux pin close-request marker + watcher 立即移除 stale pin（FLY-685）",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/cmux-close-request.ts",
				"requestCmuxPinClose",
				"call_time",
			),
		],
		toggleable: "readonly",
		note: "watcher 侧同名读取在 scripts/flywheel-cmux-sync.sh（cli_invocation）；=0 关闭两侧，需重启 Bridge + watcher。",
	},
	{
		name: "gatepoller_circuit",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_GATEPOLLER_CIRCUIT",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description: "GatePoller 连续 poll 失败时的熔断",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/gate-poller.ts",
				"GatePoller.poll",
				"call_time",
			),
		],
		toggleable: "direct",
		directToggleProof:
			"resolve.direct-toggle.test:gatepoller_circuit live-observe",
	},
	{
		name: "misroute_patrol",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_MISROUTE_PATROL",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description: "Lead-inbox 误投巡检（每 poll 读）",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/gate-poller.ts",
				"GatePoller.poll",
				"call_time",
			),
		],
		toggleable: "direct",
		directToggleProof:
			"resolve.direct-toggle.test:misroute_patrol live-observe",
	},
	{
		name: "founder_thread_notify",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_FOUNDER_THREAD_NOTIFY",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description: "gate 上给 founder 发 thread 通知",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/gate-poller.ts",
				"GatePoller (method)",
				"call_time",
			),
		],
		toggleable: "direct",
		directToggleProof:
			"resolve.direct-toggle.test:founder_thread_notify live-observe",
	},
	{
		name: "founder_reply_deliver",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_FOUNDER_REPLY_DELIVER",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description: "把 founder 的 gate 回复回投给 runner",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/gate-poller.ts",
				"GatePoller (method)",
				"call_time",
			),
		],
		toggleable: "direct",
		directToggleProof:
			"resolve.direct-toggle.test:founder_reply_deliver live-observe",
	},
	{
		name: "founder_milestone_notify",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_FOUNDER_MILESTONE_NOTIFY",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description: "founder 里程碑推送（FLY-725）",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/gate-poller.ts",
				"GatePoller (method)",
				"call_time",
			),
		],
		toggleable: "direct",
		directToggleProof:
			"resolve.direct-toggle.test:founder_milestone_notify live-observe",
	},
	{
		name: "heartbeat_readopt",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_HEARTBEAT_READOPT",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description: "心跳服务 re-adopt 已有 session",
		readSites: [
			envSite(
				"packages/teamlead/src/HeartbeatService.ts",
				"HeartbeatService (method)",
				"call_time",
			),
		],
		toggleable: "direct",
		directToggleProof:
			"resolve.direct-toggle.test:heartbeat_readopt live-observe",
	},
	{
		name: "liveness_pane_dead",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_LIVENESS_PANE_DEAD",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description: "pane-dead liveness 检测",
		readSites: [
			envSite(
				"packages/teamlead/src/HeartbeatService.ts",
				"HeartbeatService (method)",
				"call_time",
			),
		],
		toggleable: "direct",
		directToggleProof:
			"resolve.direct-toggle.test:liveness_pane_dead live-observe",
	},
	{
		name: "quiet_persist_dedup",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_QUIET_PERSIST_DEDUP",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description: "quiet-persist 信号去重",
		readSites: [
			envSite(
				"packages/teamlead/src/HeartbeatService.ts",
				"HeartbeatService (method)",
				"call_time",
			),
			envSite(
				"packages/teamlead/src/RunnerIdleWatchdog.ts",
				"RunnerIdleWatchdog (method)",
				"call_time",
			),
		],
		toggleable: "direct",
		directToggleProof:
			"resolve.direct-toggle.test:quiet_persist_dedup live-observe",
	},

	// ─── env features/kill-switches captured at boot/construction → RESTART ───
	{
		name: "remote_reports",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_REMOTE_REPORTS",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description: "远程报告发布管线 /api/reports（Bridge + CLI 双侧）",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/plugin.ts",
				"createBridgeApp (reportsEnabled)",
				"object_construction",
			),
			envSite(
				"packages/flywheel-comm/src/commands/publish-report.ts",
				"publishReport",
				"cli_invocation",
			),
		],
		toggleable: "conversational",
	},
	{
		name: "fleet_console",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_FLEET_CONSOLE",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description: "Fleet console 面 + fleet 路由（=0 回退旧 dashboard）",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/plugin.ts",
				"startBridge",
				"bridge_boot",
			),
		],
		toggleable: "conversational",
	},
	{
		name: "pane_idle_suppress",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_PANE_IDLE_SUPPRESS",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description: "抑制 alive-idle Lead pane 的 pane_hash_stuck 误报",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/plugin.ts",
				"createBridgeApp",
				"object_construction",
			),
		],
		toggleable: "conversational",
	},
	{
		name: "alert_threads",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_ALERT_THREADS",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description: "统一 alert 分线程",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/plugin.ts",
				"createBridgeApp",
				"object_construction",
			),
		],
		toggleable: "conversational",
	},
	{
		name: "auto_repair",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_AUTO_REPAIR",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description: "死 agent 自动修复",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/plugin.ts",
				"createBridgeApp",
				"object_construction",
			),
		],
		toggleable: "conversational",
	},
	{
		name: "xhs_review",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_XHS_REVIEW",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description: "小红书 review localhost 路由（注册与否）",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/plugin.ts",
				"createBridgeApp (route mount)",
				"object_construction",
			),
		],
		toggleable: "conversational",
	},
	{
		name: "worktree_autoclean",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_WORKTREE_AUTOCLEAN",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description: "run 后自动清理 git worktree",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/worktree-cleanup.ts",
				"cleanup closure",
				"object_construction",
			),
		],
		toggleable: "conversational",
	},
	{
		name: "bridge_watchdog",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_BRIDGE_WATCHDOG",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"Bridge event-loop watchdog（start() 只在启动看，事后置 0 停不了已跑的）",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/BridgeEventLoopWatchdog.ts",
				"isEnabled/start",
				"mixed",
			),
		],
		toggleable: "conversational",
	},
	{
		name: "issue_status_emoji",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_ISSUE_STATUS_EMOJI",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description: "issue thread 状态 emoji + 重连标记",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/plugin.ts",
				"createBridgeApp",
				"mixed",
			),
		],
		toggleable: "conversational",
	},
	{
		name: "issue_status_word",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_ISSUE_STATUS_WORD",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description: "word 形式的 issue 状态标注",
		readSites: [
			envSite(
				"packages/teamlead/src/HeartbeatService.ts",
				"HeartbeatService",
				"mixed",
			),
		],
		toggleable: "conversational",
	},
	{
		name: "issue_attach_pin",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_ISSUE_ATTACH_PIN",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description: "issue thread 钉 tmux attach 救援命令（FLY-560）",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/plugin.ts",
				"createBridgeApp",
				"object_construction",
			),
		],
		toggleable: "conversational",
	},
	{
		name: "quiet_classifier",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_QUIET_CLASSIFIER",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description: "抑制安静 runner 的 token-贵 Lead wake（FLY-626）",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/plugin.ts",
				"createBridgeApp",
				"mixed",
			),
		],
		toggleable: "conversational",
	},
	{
		name: "crash_reaper",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_CRASH_REAPER",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description: "crash/orphan runner 回收",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/plugin.ts",
				"createBridgeApp",
				"object_construction",
			),
		],
		toggleable: "conversational",
	},
	{
		name: "commdb_fsm_reconcile",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_COMMDB_FSM_RECONCILE",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"CommDB↔FSM reconcile boot sweep — 清 CommDB running 但 FSM 终态+tmux 死的僵尸（FLY-817，补 FLY-638 盲区）",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/plugin.ts",
				"createBridgeApp",
				"mixed",
			),
		],
		toggleable: "conversational",
	},
	{
		name: "lead_pane_readiness",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_LEAD_PANE_READINESS",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description: "冷启 Lead-pane readiness 检查（opt-in）",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/plugin.ts",
				"createBridgeApp",
				"object_construction",
			),
		],
		toggleable: "conversational",
	},
	{
		name: "lead_pending_escalation",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_LEAD_PENDING_ESCALATION",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description: "lead-pending 升级功能",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/lead-pending-escalation.ts",
				"module",
				"mixed",
			),
		],
		toggleable: "conversational",
	},
	{
		name: "cron_stale_guard",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_CRON_STALE_GUARD",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"run-start 409 路径的 stale-blocker guard（=0 回退旧 409，FLY-742）",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/plugin.ts",
				"createStaleBlockerGuard (enabled)",
				"bridge_boot",
			),
		],
		toggleable: "conversational",
	},
	{
		name: "viewer_session_reaper",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_VIEWER_SESSION_REAPER",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"boot sweep 清理泄漏的 viewer-<execId> tmux session（FLY-754）",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/plugin.ts",
				"viewer-session reaper boot sweep",
				"bridge_boot",
			),
		],
		toggleable: "conversational",
	},
	{
		name: "chrome_session_reaper",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_CHROME_REAPER",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"周期清理泄漏的 agent-browser headless Chrome（=0 关闭 reaper，FLY-766）",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/plugin.ts",
				"chrome-session reaper enable gate",
				"bridge_boot",
			),
		],
		toggleable: "conversational",
	},

	// ─── env features read via an injected `env` param (Codex R1 caught; the
	//     drift scanner now also matches `env.FLYWHEEL_*`). Conservative `mixed`
	//     timing → not direct. ───
	{
		name: "stuck_detect",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_STUCK_DETECT",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description: "runner stuck 检测 + 升级",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/stuck-escalation.ts",
				"stuck-detect gate",
				"mixed",
				"env-param",
			),
		],
		toggleable: "conversational",
	},
	{
		name: "codex_lead_typing",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_CODEX_LEAD_TYPING",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description: "Codex Lead 打字指示器",
		readSites: [
			envSite(
				"packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts",
				"codex-lead-runtime",
				"mixed",
				"env-param",
			),
		],
		toggleable: "conversational",
	},
	{
		name: "roundtable_reply_in_thread",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description: "#leads-roundtable 话题 reply-in-thread（FLY-314）",
		readSites: [
			envSite(
				"packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts",
				"codex-lead-runtime",
				"mixed",
				"env-param",
			),
		],
		toggleable: "conversational",
	},
	{
		name: "roundtable_thread_autocontinue",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description: "roundtable 话题线程 auto-continue",
		readSites: [
			envSite(
				"packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts",
				"codex-lead-runtime",
				"mixed",
				"env-param",
			),
		],
		toggleable: "conversational",
	},
	{
		name: "lead_chrome_enabled",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_LEAD_CHROME_ENABLED",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description: "Lead 侧 Chrome/claude-in-chrome 能力",
		readSites: [
			envSite(
				"packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts",
				"codex-lead-runtime",
				"mixed",
				"env-param",
			),
		],
		toggleable: "conversational",
	},
	{
		name: "codex_lead_read_deny",
		category: "governance_gate",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_CODEX_LEAD_READ_DENY",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description: "Codex Lead read-deny 安全约束 profile（治理门，只读）",
		readSites: [
			envSite(
				"packages/teamlead/src/lead-backends/codex/read-deny-profile.ts",
				"read-deny gate",
				"mixed",
				"env-param",
			),
		],
		toggleable: "readonly",
	},

	{
		name: "roundtable_enabled",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_ROUNDTABLE_ENABLED",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description: "#leads-roundtable 跨部门频道功能（FLY-267/314）",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/roundtable/roundtable-config.ts",
				"loadRoundtableConfig",
				"mixed",
				"env-param",
			),
		],
		toggleable: "conversational",
	},
	{
		name: "roundtable_thread_own_bot",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_ROUNDTABLE_THREAD_OWN_BOT",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description: "roundtable 线程包含 own-bot 消息",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/roundtable/roundtable-config.ts",
				"loadRoundtableConfig",
				"mixed",
				"env-param",
			),
		],
		toggleable: "conversational",
	},
	{
		name: "lead_dry_run",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_LEAD_DRY_RUN",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description: "Codex Lead dry-run 预演模式（只描述不执行）",
		readSites: [
			envSite(
				"packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts",
				"dry-run gate",
				"mixed",
				"env-param",
			),
		],
		toggleable: "conversational",
	},

	// ─── value-type env (non-boolean) → readonly display ───
	{
		name: "lead_cross_dept_channel_ids",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS",
		polarity: "opt_in",
		valueKind: "value",
		default: "",
		description:
			"Codex Lead poll+mention-gate 的 #leads-roundtable 频道 id（逗号分隔）",
		readSites: [
			envSite(
				"packages/teamlead/src/lead-backends/codex/lead-actions/config.ts",
				"config",
				"object_construction",
			),
		],
		toggleable: "readonly",
	},
	{
		name: "reports_ttl_days",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_REPORTS_TTL_DAYS",
		polarity: "opt_in",
		valueKind: "value",
		default: "7",
		description: "报告链接保留天数（默认 7）",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/plugin.ts",
				"resolveReportsTtlMs",
				"object_construction",
			),
		],
		toggleable: "readonly",
	},

	// ─── governance gates → ALWAYS readonly (default-enable-policy hard exemption) ───
	{
		name: "founder_consent_decision_mode",
		category: "governance_gate",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE",
		polarity: "opt_in",
		valueKind: "enum",
		enumValues: ["off", "audit_only", "enforce"],
		default: "off",
		description: "founder-consent 硬门模式（治理门，只读）",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/founder-consent/config.ts",
				"resolveDecisionMode",
				"call_time",
				"env-param",
			),
		],
		toggleable: "readonly",
	},
	{
		name: "comm_bypass_bridge",
		category: "governance_gate",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_COMM_BYPASS_BRIDGE",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description:
			"应急：绕过 founder-consent 直写 approve gate（治理门 override，只读）",
		readSites: [
			envSite(
				"packages/flywheel-comm/src/commands/respond.ts",
				"respond",
				"cli_invocation",
			),
		],
		toggleable: "readonly",
	},

	// ─── project config flags (per-project scope) ───
	{
		name: "qa_auto",
		category: "feature",
		source: "project_config",
		scope: "project",
		configKey: "qa.auto",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description: "code-review 后自动 spawn 独立 QA runner（per-project）",
		readSites: [
			{
				file: "packages/teamlead/src/bridge/auto-qa-policy.ts",
				symbol: "resolveAutoQaPolicy",
				pattern: "config",
				timing: "call_time",
			},
		],
		toggleable: "conversational",
	},
	{
		name: "doc_flow",
		category: "feature",
		source: "project_config",
		scope: "project",
		configKey: "doc_flow.enabled",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description: "DOC-FLOW 提示词块：Runner 写部门优先过程文档（per-project）",
		readSites: [
			{
				file: "packages/edge-worker/src/Blueprint.ts",
				symbol: "doc-flow injection",
				pattern: "config",
				timing: "call_time",
			},
		],
		toggleable: "conversational",
	},
	{
		name: "proofshot",
		category: "feature",
		source: "project_config",
		scope: "project",
		configKey: "skills.proofshot.enabled",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description: "ProofShot 视觉验证 auto-trigger（per-project）",
		readSites: [
			{
				file: "packages/config/src/ConfigLoader.ts",
				symbol: "ConfigLoader.validate",
				pattern: "config",
				timing: "call_time",
			},
		],
		toggleable: "conversational",
	},
	{
		name: "xiaohongshu_learning",
		category: "feature",
		source: "project_config",
		scope: "project",
		configKey: "xiaohongshu_learning.enabled",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description: "定期小红书收藏学习管线（per-project）",
		readSites: [
			{
				file: "packages/config/src/ConfigLoader.ts",
				symbol: "ConfigLoader.validate",
				pattern: "config",
				timing: "call_time",
			},
		],
		toggleable: "conversational",
	},
	{
		name: "ponytail",
		category: "feature",
		source: "project_config",
		scope: "project",
		configKey: "ponytail.enabled",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description:
			"代码极简 ponytail 逐项目 rollout（Annie-exception：默认 OFF）",
		readSites: [
			{
				file: "packages/config/src/ConfigLoader.ts",
				symbol: "ConfigLoader.validate",
				pattern: "config",
				timing: "call_time",
			},
		],
		toggleable: "readonly",
		dormant: true,
		note: "run-infra.ts 明确不加载 flywheelConfig?.ponytail（项目层 dormant）；Annie-exception。",
	},
	{
		name: "founder_ux_gate",
		category: "governance_gate",
		source: "project_config",
		scope: "project",
		configKey: "founder_ux_gate.mode",
		polarity: "opt_in",
		valueKind: "enum",
		enumValues: ["off", "audit_only", "enforce"],
		default: "off",
		description: "founder-facing UX brainstorm 门（治理门，只读）",
		readSites: [
			{
				file: "packages/config/src/ConfigLoader.ts",
				symbol: "ConfigLoader.validate",
				pattern: "config",
				timing: "call_time",
			},
		],
		toggleable: "readonly",
	},
	// ─── FLY-818: auto-continue (①) + stuck→founder-page (②) ───
	{
		name: "runner_autocontinue",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_RUNNER_AUTOCONTINUE",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description:
			"FLY-818 ①: opt-in /loop-native goal-driven 自动续跑 arming（AutoContinueArmer）",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/plugin.ts",
				"createBridgeApp (AutoContinueArmer boot gate)",
				"bridge_boot",
			),
			envSite(
				"packages/teamlead/src/bridge/autocontinue-armer.ts",
				"AutoContinueArmer.enabled",
				"call_time",
				"env-param",
			),
		],
		toggleable: "readonly",
		note: "boot-gated：plugin.ts 仅在 =1 时启动 armer poll；翻转需重启 Bridge。默认 off，先单-runner canary。",
	},
	{
		name: "stuck_founder_page_killswitch",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_STUCK_FOUNDER_PAGE",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"FLY-818 ②: 关掉「runner 真卡住 → 在其 [FLY-XX] issue thread @founder」的直达页（default-on 安全网）",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/stuck-escalation.ts",
				"stuckFounderPageEnabled",
				"call_time",
			),
		],
		toggleable: "readonly",
		note: "额外要 owner id + store 才发页；=0 关闭直达页、退回 legacy alert 语义（需重启 Bridge 生效）。",
	},
];
