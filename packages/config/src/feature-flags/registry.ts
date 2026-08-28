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
	/** Stable key, e.g. "founder_review_orphan_monitor". */
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
	// ─── FLY-1940: unanswered founder-review lifecycle monitor ───
	{
		name: "founder_review_orphan_monitor",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_FOUNDER_REVIEW_ORPHAN_MONITOR",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"FLY-1940: monitor live, open, unsuperseded, unanswered founder_review gates and surface missing card delivery or aged unanswered rounds to the Lead",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/orphan-founder-review-monitor.ts",
				"sweepOrphanFounderReviewGates",
				"call_time",
				"env-param",
			),
		],
		toggleable: "direct",
		directToggleProof:
			"packages/teamlead/src/bridge/__tests__/orphan-founder-review-monitor.test.ts: kill switch live-observe",
		note: "=0 pauses only new monitor alerts; it does not reopen, retire, answer, or mutate any gate.",
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
	// ─── FLY-1393: liveness controls ───
	// ─── FLY-1573: lease redelivery + batch delivery + dead-letter gate ───
	{
		name: "mailbox_queue",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_MAILBOX_QUEUE",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"mailbox 租约原地重投、合批投递与死信闸(=0 运行时回切 FLY-1572 旧投递流)",
		readSites: [
			envSite(
				"packages/config/src/feature-flags/mailbox-queue.ts",
				"mailboxQueueEnabled",
				"call_time",
				"env-param",
			),
			envSite(
				"packages/inbox-mcp/src/queue-mode.ts",
				"resolveLiveMailboxQueueEnabled",
				"dotenv_live",
				"dynamic",
			),
		],
		toggleable: "direct",
		directToggleProof:
			"packages/teamlead/src/bridge/__tests__/mailbox-queue-config.test.ts",
		note: "每个 lane tick 开头解析一次不可变快照；默认 ON，只有精确值 0 回旧流。",
	},
	// ─── FLY-1329: session lifecycle floor — liveness never authorizes alone ───
	{
		// FLY-1329 (A2): wording-only. Deliberately NOT an input to the destructive
		// verdict — a decision that swung on "was there traffic recently" would be
		// unreproducible and would re-introduce the FLY-1319 bug class.
		name: "liveness_activity_window_ms",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_LIVENESS_ACTIVITY_WINDOW_MS",
		polarity: "opt_in",
		valueKind: "value",
		default: "600000",
		description:
			"absent-park 告警正文里判定 likely-alive / likely-dead 的活动窗口(默认 10 分钟)。【只影响告警措辞,绝不影响裁决】——活动证据故意不作为 decideDestructive 的输入 (FLY-1329 A2)",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/liveness-evidence.ts",
				"activityWindowMs",
				"call_time",
			),
		],
		toggleable: "readonly",
		note: "非法/未设/≤0 的 env 值由 activityWindowMs() 在运行时 sanitize 回默认 600000;resolveFlag 对本 flag 走同款 sanitizer(见 resolve.ts 特判),故 registry 显示的 effective 值 = 运行时实际生效值(Codex R2 LOW,修正 R1 LOW-6 的 raw-string 展示)。改这个改不了任何生命周期决定,只改人读的那句话。",
	},
	// ─── env kill-switches / features, call_time → DIRECT-toggle candidates ───
	{
		// FLY-869 B: the merge-race ship gate kill-switch. Default-ON (决定②): a merged
		// landing maps to completed/Done ONLY when verifyApproval confirms a bound,
		// answered approve_to_ship for the current head (+ FLY-827 Codex gate) — else the
		// session is parked with a merge_block marker (决定③, no auto-revert) + a loud
		// alert. `=0` bypasses only this merge-approval half; the independent QA
		// check remains always armed. Read via the shared evaluateShipEligibility
		// predicate (const key in ship-eligibility.ts).
		name: "merge_approval_gate_killswitch",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_MERGE_APPROVAL_GATE",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"全局关掉 ship 判定中的 merge-approval 半闸（=0 只绕过 verifyApproval；QA 校验固定开启，仍须通过）",
		readSites: [
			envSite(
				"packages/flywheel-comm/src/ship-eligibility.ts",
				"resolveDefaultOnGate argsEnv-wins Bridge caller (MERGE_APPROVAL_GATE_KEY)",
				"call_time",
				"env-param",
			),
			envSite(
				"packages/flywheel-comm/src/ship-eligibility.ts",
				"resolveDefaultOnGate",
				"dotenv_live",
				"dynamic",
			),
		],
		toggleable: "readonly",
		note: "B 的逃生开关只影响 merge approval；A（QA）固定开启且没有环境变量旁路。B 的 Bridge caller 与 CLI live-.env 均在下一次调用生效，分歧时可能 split-brain；授权面保持 readonly。",
	},
	{
		name: "issue_gate_supersede_mode",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_ISSUE_GATE_SUPERSEDE",
		polarity: "default_on",
		valueKind: "enum",
		enumValues: ["enforce", "observe", "0"],
		default: "enforce",
		description:
			"FLY-1314: issue gate supersede patrol 模式（enforce=收敛、observe=只审计、0=停止新 mutation）",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/issue-gate-supersede.ts",
				"sweepIssueGatesForProject",
				"call_time",
				"env-param",
			),
		],
		toggleable: "readonly",
		note: "已写入 superseded_at/superseded_by 的 disposition 永久有效；=0 只停止新的 mutation，不回滚历史 stamp。",
	},
	// ─── FLY-799: founder-in-thread ship approval + auto-finalize ───
	// ─── FLY-1099: founder-reply ingest reliability ───
	{
		name: "deferred_approval_ttl_ms",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_DEFERRED_APPROVAL_TTL_MS",
		polarity: "default_on",
		valueKind: "value",
		default: "2700000",
		description: "暂存批准的 TTL(默认 45min;过期需 founder 重新确认)",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/approval-signal/deferred-approval.ts",
				"deferredApprovalTtlMs",
				"call_time",
			),
		],
		toggleable: "readonly",
	},
	{
		name: "founder_reply_deadletter_age_ms",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_FOUNDER_REPLY_DEADLETTER_AGE_MS",
		polarity: "default_on",
		valueKind: "value",
		default: "1800000",
		description: "founder 消息重试超龄上限(默认 30min,与次数上限双阈值)",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/gate-poller.ts",
				"GatePoller (method)",
				"call_time",
			),
		],
		toggleable: "readonly",
	},
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
		name: "ship_gate_grace_ms",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_SHIP_GATE_GRACE_MS",
		polarity: "opt_in",
		valueKind: "value",
		default: "15000",
		description:
			"founder 文字/✅ 对 approve_to_ship gate 的放行 grace(ms;默认 15s;设 600000 回到 FLY-605 旧 10min 行为——这就是 kill-switch,FLY-945 Fix A)",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/gate-poller.ts",
				"shipGateGraceMs",
				"call_time",
			),
		],
		toggleable: "conversational",
	},
	{
		name: "external_merge_reconcile",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_EXTERNAL_MERGE_RECONCILE",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"外部 merge(executor-merge 残局)收敛兜底 pass(=0 关闭;FLY-945 Fix D——兜底不是许可)",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/external-merge-reconcile.ts",
				"createExternalMergeReconciler pass()",
				"call_time",
				"env-param",
			),
		],
		toggleable: "conversational",
	},
	{
		name: "merge_reconcile_window_days",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_MERGE_RECONCILE_WINDOW_DAYS",
		polarity: "opt_in",
		valueKind: "value",
		default: "7",
		description:
			"外部 merge 收敛 pass 的 completed-but-unfinalized 回看窗口(天;FLY-945 Fix D)",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/external-merge-reconcile.ts",
				"createExternalMergeReconciler pass()",
				"call_time",
				"env-param",
			),
		],
		toggleable: "conversational",
	},
	// ─── FLY-1041: founder-approval binding — single bindable ship gate ───
	{
		name: "ship_gate_card_grace_ms",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_SHIP_GATE_CARD_GRACE_MS",
		polarity: "opt_in",
		valueKind: "value",
		default: "15000",
		description:
			"FLY-1041 Fix B: ship 卡发出前的 grace(ms;默认 15s;env > config > default)",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/gate-poller.ts",
				"shipGateCardGraceMs",
				"call_time",
			),
		],
		toggleable: "conversational",
	},

	// ─── value-type env (non-boolean) → readonly display ───
	// FLY-1809: `lead_cross_dept_channel_ids` used to sit here. It is a Discord
	// channel id, not a switch — moved to NON_FLAG_ALLOWLIST in truth.ts next to
	// its FLYWHEEL_ROUNDTABLE_CHANNEL_ID sibling. Not deleted (that would inline
	// the id) and not tombstoned (production still reads it).

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
		name: "done_thread_reconcile_interval_min",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_DONE_THREAD_RECONCILE_INTERVAL_MIN",
		polarity: "default_on",
		valueKind: "value",
		default: "360",
		description:
			"FLY-1165: reconcile sweep 周期（分钟；0=只跑 boot pass；调度器每 tick 重读）",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/done-thread-reconcile.ts",
				"resolveDoneThreadReconcileConfig",
				"call_time",
				"env-param",
			),
		],
		toggleable: "readonly",
	},
	{
		name: "done_thread_reconcile_max_per_run",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_DONE_THREAD_RECONCILE_MAX_PER_RUN",
		polarity: "default_on",
		valueKind: "value",
		default: "25",
		description:
			"FLY-1165: 每轮 reconcile 最多归档数（Discord 429 保护；每 tick 重读）",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/done-thread-reconcile.ts",
				"resolveDoneThreadReconcileConfig",
				"call_time",
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
