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

export const FEATURE_FLAGS: readonly FeatureFlagSpec[] = [
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
			"每 7 天扫描解析后生效值稳定的 flag，生成一批留/清候选；扫描本身永不删除 flag",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/flag-retirement-scan.ts",
				"flagRetirementScanEnabled",
				"call_time",
				"env-param",
			),
		],
		toggleable: "direct",
		directToggleProof:
			"packages/teamlead/src/bridge/__tests__/flag-retirement-scan.test.ts: kill switch live-observe",
		note: "固定每周，故意没有周期配置；=0 只暂停扫描 rider，不改变已有裁决或删除任何东西。",
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
		// FLY-827: the Codex code-review HARD GATE kill-switch. Default-ON: any PR
		// must pass Codex code review (for its current head) before auto-QA spawns
		// and before verify-approval permits merge; not passed → founder held +
		// alert. `=0` is the emergency release. `direct` toggle: the Bridge reads
		// process.env live (mutated in place by the flag apply). The runner-CLI
		// verify-approval ALSO honors it live but via a call-time read of
		// ~/.flywheel/.env (NOT a Bridge process.env readSite) — that CLI live-read
		// is proven separately and deliberately NOT listed as a call_time readSite
		// here so isDirectToggleable (which requires every listed readSite be
		// Bridge call_time) still accepts this flag.
		name: "codex_hard_gate_killswitch",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_CODEX_HARD_GATE",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"全局关掉 Codex code-review 硬门（=0 应急放行；默认 ON=任何 PR 没过 Codex APPROVED 就卡住 auto-QA + merge）",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/codex-gate.ts",
				"isCodexGateSatisfied / codexHardGateEnabled",
				"call_time",
				"env-param",
			),
			{
				file: "packages/teamlead/src/bridge/auto-qa-held.ts",
				symbol: "codexHardGateEnabled",
				pattern: "delegated",
				timing: "call_time",
				resolverModule: "packages/teamlead/src/bridge/codex-gate.ts",
				resolverSymbol: "codexHardGateEnabled",
			},
		],
		toggleable: "direct",
		// Two live-observe proofs: the Bridge-side registry direct-toggle test AND
		// the runner-CLI verify-approval .env bidirectional live-toggle test.
		directToggleProof:
			"resolve.direct-toggle.test:codex_hard_gate_killswitch live-observe + verify-approval.test:.env live-toggle",
	},
	{
		// FLY-869 B: the merge-race ship gate kill-switch. Default-ON (决定②): a merged
		// landing maps to completed/Done ONLY when verifyApproval confirms a bound,
		// answered approve_to_ship for the current head (+ FLY-827 Codex gate) — else the
		// session is parked with a merge_block marker (决定③, no auto-revert) + a loud
		// alert. `=0` is the emergency release (restores the pre-FLY-869 merged→completed
		// short-circuit). INDEPENDENT of the QA gate below (R2 HIGH-3). Read via the
		// shared evaluateShipEligibility predicate (const key in ship-eligibility.ts).
		name: "merge_approval_gate_killswitch",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_MERGE_APPROVAL_GATE",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"全局关掉 merge-抢跑 ship 闸（=0 应急放行；默认 ON=merged 只有经 verifyApproval 批准才 completed/Done，否则挂 merge_block 不自动 revert + 响亮 alert）",
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
		note: "B 与 A（FLYWHEEL_QA_DONE_GATE）独立开关（R2 HIGH-3）；Bridge caller 与 CLI live-.env 均在下一次调用生效,分歧时可能 split-brain；授权面保持 readonly。",
	},
	{
		// FLY-869 A: the QA-done ship gate kill-switch. Default-ON (决定②/④): a session
		// whose persisted qa_required snapshot is 1 needs a PASSED auto_qa_record for the
		// head before completed/Done; exempt (snapshot 0 / no-code / no-PR / no-qa label /
		// qa.auto:false) passes. `=0` is the emergency release. INDEPENDENT of the merge
		// gate above (R2 HIGH-3). Read via the shared evaluateQaShipGate predicate.
		name: "qa_done_gate_killswitch",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_QA_DONE_GATE",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"全局关掉 QA-done ship 闸（=0 应急放行；默认 ON=qa_required=1 的 session 必须有 head 的 passed auto_qa_record 才 completed/Done；豁免口=快照0/no-code/no-PR/no-qa/qa.auto:false）",
		readSites: [
			envSite(
				"packages/flywheel-comm/src/ship-eligibility.ts",
				"resolveDefaultOnGate argsEnv-wins Bridge caller (QA_DONE_GATE_KEY)",
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
		note: "A 与 B（FLYWHEEL_MERGE_APPROVAL_GATE）独立开关（R2 HIGH-3）；Bridge caller 与 CLI live-.env 均在下一次调用生效,分歧时可能 split-brain；授权面保持 readonly。",
	},
	{
		// FLY-1404: every design node — independent of DAG shape — must attach
		// committed, issue-scoped founder design HTML evidence before completion.
		// The CLI mints the attestation and every completion ingress validates it.
		// `=0` is an operator-only emergency escape, never a product toggle.
		name: "design_html_gate",
		category: "governance_gate",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_DESIGN_HTML_GATE",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"design node 完成前必须提交 issue-scoped founder 设计 HTML 并携带 HEAD 绑定的可信证据；=0 仅作 operator 应急放行，与 DAG 是否三段式无关 (FLY-1404)",
		readSites: [
			envSite(
				"packages/flywheel-comm/src/commands/complete.ts",
				"collectDesignHtmlEvidence",
				"cli_invocation",
			),
			envSite(
				"packages/teamlead/src/bridge/event-route.ts",
				"POST /events completion admission",
				"call_time",
			),
			envSite(
				"packages/teamlead/src/DirectEventSink.ts",
				"emitCompleted",
				"call_time",
			),
			envSite(
				"packages/teamlead/src/bridge/complete-marker-reconciler.ts",
				"tryReconcileComplete",
				"call_time",
			),
		],
		toggleable: "readonly",
		note: "CLI 每次调用即时读取；Bridge 进程在每次 completion admission 读取 process.env，但修改共享 .env 后仍需重启 Bridge。",
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
	{
		name: "ship_ci_guard",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_SHIP_CI_GUARD",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"FLY-1314: approve gate 与最终 ship authority 的即时 GitHub CI 守卫（=0 紧急旁路 GitHub evidence axis）",
		readSites: [
			envSite(
				"packages/flywheel-comm/src/ship-ci-guard.ts",
				"probeShipCiGreen",
				"cli_invocation",
				"env-param",
			),
		],
		toggleable: "readonly",
		note: "由每次 flywheel-comm CLI invocation 读取；默认开启，=0 仅用于 GitHub/gh 证据链故障的紧急恢复。",
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
			envSite(
				"packages/teamlead/src/bridge/workflow-rework-coordinator.ts",
				"reconcile",
				"call_time",
				"env-param",
			),
			envSite(
				"packages/teamlead/src/bridge/workflow-engine-dispatcher.ts",
				"reconcileWorkflowReworks",
				"call_time",
				"env-param",
			),
			envSite(
				"packages/teamlead/src/bridge/workflow-engine-dispatcher.ts",
				"reconcileWorkflowReworkStalls",
				"call_time",
				"env-param",
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

	// ─── env features read via an injected `env` param (Codex R1 caught; the
	//     drift scanner now also matches `env.FLYWHEEL_*`). Conservative `mixed`
	//     timing → not direct. ───
	{
		name: "lead_core_mention_gated",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_LEAD_CORE_MENTION_GATED",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description:
			"core-room 无-@ 消息只让 CoS 回、非-CoS lead 需被点名才回（FLY-898，launcher 从 projects.json 计算）",
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
	// ─── value-type env (non-boolean) → readonly display ───
	// FLY-1809: `lead_cross_dept_channel_ids` used to sit here. It is a Discord
	// channel id, not a switch — moved to NON_FLAG_ALLOWLIST in truth.ts next to
	// its FLYWHEEL_ROUNDTABLE_CHANNEL_ID sibling. Not deleted (that would inline
	// the id) and not tombstoned (production still reads it).
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
				"packages/config/src/decision-mode.ts",
				"resolveDecisionMode",
				"call_time",
				"env-param",
			),
		],
		toggleable: "readonly",
	},
	{
		name: "founder_attribution_gate",
		category: "governance_gate",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_FOUNDER_ATTRIBUTION_GATE",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"verify-approval 要求 approve gate 答复归属 founder 侧(founder id / bridge / bridge-founder-consent;=0 仅供 QA 房/应急;治理门,只读;FLY-945 Fix E)",
		readSites: [
			envSite(
				"packages/flywheel-comm/src/founder-attribution.ts",
				"resolveFounderAttributionGateOn",
				"cli_invocation",
				"env-param",
			),
		],
		toggleable: "readonly",
	},
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
		name: "founder_milestone_report_enabled",
		category: "feature",
		source: "project_config",
		scope: "project",
		configKey: "founder_milestone_report.enabled",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description: "项目级 founder terminal-milestone push",
		readSites: [
			{
				file: "packages/teamlead/src/bridge/gate-poller.ts",
				symbol: "GatePoller.maybeEmitMilestoneReports",
				pattern: "config",
				timing: "call_time",
				configAccess: "cfg.enabled",
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
				configAccess: "cfg.auto",
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
			envSite(
				"packages/config/src/skill-framework-mode.ts",
				"resolveSkillFrameworkMode",
				"call_time",
				"env-param",
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
		name: "workflow_resume",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_WORKFLOW_RESUME",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description:
			"FLY-1707: admit same-run workflow resume requests from durable checkpoints; default off preserves the existing /runs/start path.",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/runs-route.ts",
				"isWorkflowResumeEnabled",
				"call_time",
				"env-param",
			),
		],
		toggleable: "direct",
		directToggleProof:
			"packages/teamlead/src/bridge/__tests__/runs-route.dag-entry.test.ts",
		note: "Only explicit resume:true requests enter the T3/T4 admission namespace; existing start reservation keys are untouched.",
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
			envSite(
				"packages/teamlead/src/bridge/workflow-turn-ledger-validator.ts",
				"workflowTurnDivergenceAlertsEnabled",
				"call_time",
				"env-param",
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
	{
		name: "instruction_path_check",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_INSTRUCTION_PATH_CHECK",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"FLY-1718 P3: design-review 自动指令绑定已提交 plan path/blob，并由 Bridge 校验结果投影",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/plugin.ts",
				"reconcileDesignReviewManifestOutbox",
				"call_time",
			),
			envSite(
				"packages/teamlead/src/bridge/event-route.ts",
				"handleStageChanged design review manifest",
				"call_time",
			),
			envSite(
				"packages/teamlead/src/bridge/design-review-validation.ts",
				"validateDesignReviewProjection",
				"call_time",
				"env-param",
			),
			envSite(
				"packages/flywheel-comm/src/commands/await-codex-gate.ts",
				"validateResult",
				"cli_invocation",
				"env-param",
			),
			envSite(
				"packages/flywheel-comm/src/commands/await-codex-gate.ts",
				"validateDesignProjectionWithBridge",
				"cli_invocation",
				"env-param",
			),
		],
		toggleable: "readonly",
		note: "Bridge 与独立 flywheel-comm CLI 均读取；跨进程授权安全面不提供 web toggle。",
	},
];
