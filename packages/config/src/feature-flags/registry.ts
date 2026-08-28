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
 * policy functions; the registry lists each independently controllable layer.
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
 * `dotenv_live`: a separate process reads the shared .env on every use → live.
 * `bridge_boot`: captured once when the Bridge process starts → needs restart.
 * `object_construction`: captured into a closure/const/route at build time → restart.
 * `cli_invocation`: read by a separate CLI process → not a Bridge live-toggle target.
 * `mixed`/unknown: treated conservatively as restart (never `direct`).
 */
export type ReadTiming =
	| "call_time"
	| "dotenv_live"
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
	pattern: "process.env" | "env-param" | "dynamic" | "config" | "delegated";
	timing: ReadTiming;
	/** Required for delegated sites: canonical module and named export. */
	resolverModule?: string;
	resolverSymbol?: string;
	/** Required for config sites: exact member-access chain inside symbol. */
	configAccess?: string;
}

export interface FeatureFlagSpec {
	/** Stable key, e.g. "loop_profiler". */
	name: string;
	category: FlagCategory;
	source: FlagSource;
	scope: FlagScope;
	/** Present when source === "env". */
	envVar?: string;
	/** Present when source === "project_config" (dot path, e.g. "doc_flow.enabled"). */
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
	/** Policy retirement marker; the flag remains discoverable but cannot revive. */
	retiring?: string;
	/**
	 * FLY-1779 (FLY-1412 §5.2) — SCAN-WRITTEN state, NOT a birth-time
	 * declaration. The weekly retirement scan puts a flag in front of Annie; if
	 * she answers 「留」, the system writes `true` here and the scan stops asking
	 * about it. Absent = she has never been asked / has not decided, which is
	 * perfectly legal.
	 *
	 * ⛔ There is deliberately NO creation-time gate on this field. Annie killed
	 * that whole idea outright — 「flag 不需要必须带退役条件呀」 — so no CI
	 * assertion may require a new flag to carry it, and nothing here may
	 * fail-loud when it is missing. (The separate 「必须登记、不许野建」 gate is
	 * FLY-1455 and is unrelated to this field.)
	 */
	longTermKeep?: boolean;
	/** The one-line reason she gave when she answered 「留」. §5.6. */
	keepReason?: string;
}

/** §5.6 rule 3: `retiring` names the issue that is retiring the flag. */
const RETIRING_ISSUE_RE = /^(FLY|GEO)-\d+$/;

/**
 * FLY-1779 (FLY-1412 §5.6) — the simplified mutual exclusion between the
 * scan-written keep fields and the pre-existing `retiring` marker.
 *
 * Returns one message per violated rule (all of them, not just the first);
 * an empty array means the spec is legal. This is a pure predicate so the
 * contract is executable in its own right: no production flag carries either
 * keep field yet (B3 is what writes them), so asserting only over the real
 * table would be vacuously green and would prove nothing.
 *
 * NOT enforced here, on purpose:
 * - §5.6 rule 2 (「retiring 的 flag 扫描不再摆它,但在报告里列已认领」) is scan
 *   behaviour and belongs to B3, not to a registry-shape predicate.
 * - 「longTermKeep === true 就必须给 keepReason」 is NOT required. This is the
 *   deliberate reading of a documented conflict, not a derivation: the Linear
 *   issue's own field comment says the reason 可为空, PRD §5.3's field table
 *   says it is 必填 when longTermKeep is true. Tadashi adjudicated in favour of
 *   the issue, treating §5.3 as text that was never updated after Annie's
 *   2026-07-23 ruling. (Requiring a reason *conditionally* would not by itself
 *   make `longTermKeep` mandatory at creation time — the two are separate
 *   questions.) A reason that is *written but blank* is still rejected — write
 *   something or write nothing.
 */
export function validateKeepFieldContract(spec: FeatureFlagSpec): string[] {
	const violations: string[] = [];
	// §5.6 speaks of a NON-EMPTY `retiring`. An empty string violates the id
	// format rule below and nothing else — it must not also be reported as a
	// contradiction, or one malformed value would produce two diagnoses.
	const claimedByRetiringIssue =
		spec.retiring !== undefined && spec.retiring.trim() !== "";

	if (spec.retiring !== undefined && !RETIRING_ISSUE_RE.test(spec.retiring)) {
		violations.push(
			`${spec.name}: retiring must be a bare issue id matching (FLY|GEO)-<n>, got ${JSON.stringify(spec.retiring)}`,
		);
	}

	if (spec.longTermKeep === true && claimedByRetiringIssue) {
		violations.push(
			`${spec.name}: longTermKeep === true contradicts retiring ${JSON.stringify(spec.retiring)} — a flag cannot be long-term kept and on its way out at the same time`,
		);
	}

	if (spec.keepReason !== undefined) {
		if (spec.longTermKeep !== true) {
			violations.push(
				`${spec.name}: keepReason is only meaningful behind longTermKeep === true`,
			);
		}
		if (spec.keepReason.trim() === "") {
			violations.push(
				`${spec.name}: keepReason is present but blank — record the reason or omit the field`,
			);
		}
	}

	return violations;
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

function flagStoreSite(
	file:
		| "packages/teamlead/src/bridge/plugin.ts"
		| "packages/teamlead/src/bridge/run-infra.ts",
	symbol: string,
	resolverSymbol: string,
): FlagReadSite {
	return {
		file,
		symbol,
		pattern: "delegated",
		timing: "call_time",
		resolverModule: "packages/teamlead/src/bridge/flag-store-runtime.ts",
		resolverSymbol,
	};
}

export const FEATURE_FLAGS: readonly FeatureFlagSpec[] = [
	{
		name: "loop_profiler",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_LOOP_PROFILER",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"FLY-1995: capture bounded Node CPU profiles for Bridge event-loop delay episodes",
		readSites: [
			flagStoreSite(
				"packages/teamlead/src/bridge/plugin.ts",
				"startBridge",
				"storeLoopProfilerEnabled",
			),
		],
		toggleable: "direct",
		directToggleProof:
			"packages/teamlead/src/bridge/__tests__/flag-store-runtime.test.ts: read-on-use wrapper observes the next store write",
	},
	{
		name: "flag_store",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_FLAG_STORE",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"FLY-1778: Bridge SQLite flag store；=0 在下次 Bridge 启动时旁路到 legacy .env",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/flag-store-runtime.ts",
				"initializeFlagStore",
				"bridge_boot",
				"env-param",
			),
		],
		toggleable: "readonly",
		note: "逃生开关只在 Bridge 启动时读取，永不由 flag store 自身管理。",
	},
	// ─── FLY-1992: shipped workflow-node husk convergence ───
	{
		name: "shipped_husk_force",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_SHIPPED_HUSK_FORCE",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"FLY-1992: after one failed post-merge closeout, force-reap an evidence-proven stale workflow-node husk before thread archive; =0 restores cooperative-only shutdown",
		readSites: [
			flagStoreSite(
				"packages/teamlead/src/bridge/plugin.ts",
				"startBridge",
				"storeShippedHuskForceEnabled",
			),
		],
		toggleable: "direct",
		directToggleProof:
			"packages/teamlead/src/bridge/__tests__/flag-store-runtime.test.ts: read-on-use wrapper observes the next store write",
		note: "Only disables new forced teardown intents; strict land-lease and tmux execution-identity fences remain mandatory when enabled.",
	},
	// ─── FLY-1781: weekly retirement candidate scan ───
	{
		name: "flag_retirement_scan",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_FLAG_RETIREMENT_SCAN",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"每周日 08:00 America/Los_Angeles 扫描解析后生效值稳定满 7 天的 flag，生成一批留/清候选；扫描本身永不删除 flag",
		readSites: [
			flagStoreSite(
				"packages/teamlead/src/bridge/plugin.ts",
				"flagRetirementScanner",
				"storeFlagRetirementScanEnabled",
			),
		],
		toggleable: "direct",
		directToggleProof:
			"packages/teamlead/src/bridge/__tests__/flag-retirement-scan.test.ts: kill switch live-observe",
		note: "固定 Sunday 08:00 PT 周槽，故意没有周期配置；=0 只暂停扫描 rider，不改变已有裁决或删除任何东西。",
	},
	// ─── env kill-switches / features, call_time → DIRECT-toggle candidates ───
	{
		name: "converge_cmux_symlink",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_CONVERGE_CMUX_SYMLINK",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"FLY-1446: converge 将 flywheel-cmux-sync/autostart 普通部署副本留档后原子恢复为 trusted main checkout symlink；=0 暂停形态收敛",
		readSites: [
			envSite(
				"scripts/converge-flywheel-bin.sh",
				"converge_cmux_symlink",
				"cli_invocation",
				"dynamic",
			),
		],
		toggleable: "conversational",
		note: "owner=converge CLI；每个 Lead 启动、scheduled updater、restart-services pre-kickstart 的下一次独立调用生效。非法值 fail-safe 回到默认开启；退役条件是全机不再存在可写部署副本路径。",
	},
	{
		name: "cmux_view_helper",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_CMUX_VIEW_HELPER",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"FLY-1884: keep runner mirror tabs attached across exact tmux view-session rebuilds; =0 restores the legacy one-shot attach command.",
		readSites: [
			envSite(
				"scripts/flywheel-cmux-sync.sh",
				"view_helper_enabled",
				"cli_invocation",
				"dynamic",
			),
		],
		toggleable: "conversational",
		note: "The resident watcher reads the shared env on each command build; disabling affects new/repaired view commands and preserves existing tabs.",
	},
	{
		name: "cmux_node_presence",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_CMUX_NODE_PRESENCE",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"FLY-1884: render Bridge-rostered windowless and recent-terminal executions as node: cmux surfaces, with cleanup freshness fencing; =0 freezes existing node surfaces and restores P0 cleanup behavior.",
		readSites: [
			envSite(
				"scripts/flywheel-cmux-sync.sh",
				"cmux_node_presence",
				"cli_invocation",
				"dynamic",
			),
		],
		toggleable: "conversational",
		note: "Default-on founder visibility contract. OFF performs no node mutations and intentionally leaves existing node: workspaces untouched.",
	},
	{
		name: "voice_qa_presence_override",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description:
			"FLY-1353: voice-bridge /gemini headless 声学 E2E 的 presence QA seam —— =1 时 founderPresent() 视为满足(仅 staged rig;armed 时 allowlist 只放行 http://127.0.0.1:9877 staged Bridge,其余 boot 拒启)",
		readSites: [
			envSite(
				"packages/voice-bridge/src/assistant/wiring.ts",
				"wireAssistantMode",
				"object_construction",
				"env-param",
			),
		],
		// The owning reader is the voice-bridge daemon (external process), not the
		// Bridge whose env the direct-toggle surface mutates. QA-only: never a
		// founder dashboard toggle, never set in production.
		toggleable: "readonly",
		note: "QA-only seam(FLY-1353)。生产永不置位;armed + 生产 Bridge URL = boot 拒启。",
	},
	// ─── FLY-799: founder-in-thread ship approval + auto-finalize ───
	// ─── FLY-1099: founder-reply ingest reliability ───
	{
		name: "workflow_rework_reentry",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_WORKFLOW_REWORK_REENTRY",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"FLY-1423: re-enter the original workflow actor for QA/founder rework; =0 holds and alerts without evicting or spawning",
		readSites: [
			flagStoreSite(
				"packages/teamlead/src/bridge/plugin.ts",
				"workflowReworkCoordinatorHolder.current",
				"storeWorkflowReworkReentryEnabled",
			),
			flagStoreSite(
				"packages/teamlead/src/bridge/plugin.ts",
				"workflowEngineDispatcher",
				"storeWorkflowReworkReentryEnabled",
			),
		],
		toggleable: "direct",
		directToggleProof:
			"workflow-engine-dispatcher.test:rework coordinator reads the re-entry switch on every reconcile",
	},

	// ─── env features/kill-switches captured at boot/construction → RESTART ───
	{
		name: "issue_display_sweep_ticks",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_ISSUE_DISPLAY_SWEEP_TICKS",
		polarity: "default_on",
		valueKind: "value",
		default: "60",
		description:
			"issue 显示自愈 sweep 的 GatePoller tick 周期(默认 60 ≈ 3min@3s;0=关,FLY-907)",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/plugin.ts",
				"startBridge",
				"object_construction",
			),
		],
		toggleable: "conversational",
	},
	// ─── FLY-1041: founder-approval binding — single bindable ship gate ───
	// ─── value-type env (non-boolean) → readonly display ───
	// FLY-1809: `lead_cross_dept_channel_ids` used to sit here. It is a Discord
	// channel id, not a switch — moved to NON_FLAG_ALLOWLIST in truth.ts next to
	// its FLYWHEEL_ROUNDTABLE_CHANNEL_ID sibling. Not deleted (that would inline
	// the id) and not tombstoned (production still reads it).
	{
		name: "ghost_guard_wait_ms",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_GHOST_GUARD_WAIT_MS",
		polarity: "default_on",
		valueKind: "value",
		default: "90000",
		description:
			"FLY-1336: generalized launch delivery/session confirmation guard (ms; default 90s; captured when the Bridge loads the runs route)",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/runs-route.ts",
				"GHOST_GUARD_SESSION_WAIT_MS",
				"bridge_boot",
			),
		],
		toggleable: "readonly",
	},

	// ─── governance gates → ALWAYS readonly (default-enable-policy hard exemption) ───
	{
		// FLY-1309: this is a loud, audited break-glass override for the Lead
		// identity authorization gate. It is intentionally a governance gate, not
		// a dashboard feature: each flywheel-comm invocation reads it independently
		// and use emits both an audit record and an alert.
		name: "lead_lease_bypass",
		category: "governance_gate",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_LEAD_LEASE_BYPASS",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description:
			"FLY-1309: 紧急绕过 Lead identity lease 写授权（=1；强告警 + 审计；治理门，只读）",
		readSites: [
			envSite(
				"packages/flywheel-comm/src/lead-lease.ts",
				"authorizeLeadWrite",
				"cli_invocation",
				"env-param",
			),
		],
		toggleable: "readonly",
	},

	// ─── project config flags (per-project scope) ───
	{
		name: "checkpoint_enabled",
		category: "governance_gate",
		source: "project_config",
		scope: "project",
		configKey: "checkpoints.*.enabled",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description: "逐 checkpoint 的启用开关(动态 checkpoint 名)",
		readSites: [
			{
				file: "packages/edge-worker/src/Blueprint.ts",
				symbol: "Blueprint.runInner",
				pattern: "config",
				timing: "call_time",
				configAccess: "cpConfig.enabled",
			},
		],
		toggleable: "readonly",
		note: "登记只补治理账，不改变 question 或任何 checkpoint 行为。",
	},
	{
		name: "pipeline_dag",
		category: "feature",
		source: "project_config",
		scope: "project",
		configKey: "pipeline.dag",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description: "项目级 DAG dispatch enrollment",
		readSites: [
			{
				file: "packages/teamlead/src/bridge/pipeline-config-source.ts",
				symbol: "loadWorkKindConfigStrict",
				pattern: "config",
				timing: "call_time",
				configAccess: "values.dag",
			},
		],
		toggleable: "conversational",
	},
	{
		name: "pipeline_work_kind",
		category: "feature",
		source: "project_config",
		scope: "project",
		configKey: "pipeline.work_kind",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description: "项目级 dispatch work-kind enforcement",
		readSites: [
			{
				file: "packages/teamlead/src/bridge/pipeline-config-source.ts",
				symbol: "loadWorkKindConfigStrict",
				pattern: "config",
				timing: "call_time",
				configAccess: "values.work_kind",
			},
		],
		toggleable: "conversational",
	},
	{
		name: "xiaohongshu_auto_create",
		category: "feature",
		source: "project_config",
		scope: "project",
		configKey: "xiaohongshu_learning.collections[].auto_create",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description: "每个小红书 collection 是否自动创建筛出的 issue",
		readSites: [
			{
				file: "packages/teamlead/src/xiaohongshu-scheduler.ts",
				symbol: "planLearningRuns",
				pattern: "config",
				timing: "call_time",
				configAccess: "col.auto_create",
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
				symbol: "Blueprint.runInner",
				pattern: "config",
				timing: "call_time",
				configAccess: "this.docFlowConfig.enabled",
			},
		],
		toggleable: "conversational",
	},
	{
		// FLY-1356/1609: the four-way skill-framework switch (A=superpowers status
		// quo / B=matt / C=bare / D=bare+ponytail) plus `split` (per-issue
		// stable-hash bucketing). KILL SEMANTICS: set back to "superpowers" (or
		// delete the key) → every NEW dispatch resolves A immediately, no Bridge
		// restart (call_time read + direct toggle). In-flight B/C sessions are
		// NOT retro-changed (spawn-time plugin state persists; use close-runner
		// to clear the floor — see the runbook). Resolution priority lives in
		// resolveSkillFrameworkMode (plan §0).
		name: "skill_framework_mode",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_SKILL_FRAMEWORK_MODE",
		polarity: "default_on",
		valueKind: "enum",
		enumValues: ["superpowers", "matt", "bare", "bare-ponytail", "split"],
		default: "superpowers",
		description:
			"FLY-1356/1609: Runner skill 框架四臂（superpowers=A / matt=B / bare=C / bare-ponytail=D / split=按 issue 稳定哈希分流）。kill = 设回 superpowers，秒级生效不重启；存量 in-flight session 不追改",
		readSites: [
			flagStoreSite(
				"packages/teamlead/src/bridge/plugin.ts",
				"runsRouter",
				"storeSkillFrameworkModeControl",
			),
			flagStoreSite(
				"packages/teamlead/src/bridge/run-infra.ts",
				"skillFrameworkModeControl",
				"storeSkillFrameworkModeControl",
			),
			flagStoreSite(
				"packages/teamlead/src/bridge/run-infra.ts",
				"createRunInfraDispatcher",
				"storeSkillFrameworkModeControl",
			),
		],
		toggleable: "direct",
		directToggleProof:
			"resolve.direct-toggle.test:skill_framework_mode live-observe (enum)",
	},
	{
		// FLY-1356: the project OPT-OUT lever (not an enable switch). Only
		// consulted when the Bridge-global flag skill_framework_mode = "split":
		// `skill_framework.split: false` pins that project's Runners to the A
		// arm (superpowers) with via=project_opt_out. Re-read at every dispatch
		// resolution (Tadashi: Leads can pull their project out immediately);
		// a config read failure fails closed → project pinned to A + warn.
		name: "skill_framework_split_participation",
		category: "feature",
		source: "project_config",
		scope: "project",
		configKey: "skill_framework.split",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"FLY-1356: split 分流下该项目是否参与实验臂（false = 项目钉回 A/superpowers，via 记 project_opt_out；这是退出杠杆，不是启用开关）",
		readSites: [
			{
				file: "packages/teamlead/src/bridge/skill-framework-participation.ts",
				symbol: "makeSkillFrameworkParticipationReader",
				pattern: "config",
				timing: "call_time",
				configAccess: "skillFramework.split",
			},
		],
		toggleable: "readonly",
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
				configAccess: "ps.enabled",
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
				configAccess: "xhs.enabled",
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
				configAccess: "ponytail.enabled",
			},
		],
		toggleable: "readonly",
		dormant: true,
		note: "run-infra.ts 明确不加载 flywheelConfig?.ponytail（项目层 dormant）；Annie-exception。",
	},
	{
		name: "publish_broker",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_PUBLISH_BROKER",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description:
			"FLY-1062: publish broker — 对外发布(promote-commit / 薄壳 npm publish)的唯一执行点。默认关(生产字节兼容);开启 = Bridge boot 起 unix-socket 请求面 + founder ✅-reaction 审批观察。真发布另需 token 供给 + founder 批(P5)",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/publish-broker/wire.ts",
				"wirePublishBroker",
				"bridge_boot",
				"env-param",
			),
		],
		toggleable: "readonly",
	},
	{
		name: "workflow_turn_divergence_alerts",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_WORKFLOW_TURN_DIVERGENCE_ALERTS",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description:
			"FLY-1614: emit severe Lead alerts for durable engine/CommDB TURN divergence. Default off keeps detection and episode recording in shadow mode.",
		readSites: [
			flagStoreSite(
				"packages/teamlead/src/bridge/plugin.ts",
				"gatePoller",
				"storeWorkflowTurnDivergenceAlertsEnabled",
			),
		],
		toggleable: "direct",
		directToggleProof:
			"workflow-turn-ledger-validator test mutates the injected env and the next read changes",
		note: "Set =1 after observing the shadow episodes. Set =0 to stop new severe alerts without disabling comparison, recovery closure, or durable episode evidence.",
	},
	// FLY-1809: `delivery_secret_path` used to sit here. It is a filesystem path,
	// not a switch — moved to NON_FLAG_ALLOWLIST in truth.ts next to the other
	// plumbing paths. Not deleted (that would inline the path and take the QA
	// isolation override with it) and not tombstoned (production still reads it).
	// ─── FLY-1282: zombie-session liveness + folded family defects ───
	// ─── FLY-1718: re-dispatch inventory reconciliation ───
];
