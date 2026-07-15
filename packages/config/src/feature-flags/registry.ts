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
			envSite(
				"packages/teamlead/src/bridge/auto-qa-held.ts",
				"isReviewHeld",
				"call_time",
				"env-param",
			),
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
				"evaluateShipEligibility (resolveDefaultOnGate MERGE_APPROVAL_GATE_KEY)",
				"call_time",
				"env-param",
			),
		],
		toggleable: "readonly",
		note: "B 与 A（FLYWHEEL_QA_DONE_GATE）独立开关（R2 HIGH-3）；改后需重启 Bridge。",
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
				"evaluateQaShipGate (resolveDefaultOnGate QA_DONE_GATE_KEY)",
				"call_time",
				"env-param",
			),
		],
		toggleable: "readonly",
		note: "A 与 B（FLYWHEEL_MERGE_APPROVAL_GATE）独立开关（R2 HIGH-3）；改后需重启 Bridge。",
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
		// FLY-887: keep-alive kill-switch for the three-stage pipeline. Default ON:
		// phase-sessions park across handoffs (design/implement/qa stay alive to
		// ship) and are WOKEN (not respawned) so the QA↔implement fix loop keeps
		// full context. `=0` forces the legacy close-and-respawn behavior
		// everywhere (byte-compatible with the pre-FLY-887 pipeline) for emergency
		// rollback WITHOUT disabling three-stage itself. Read at call_time by both
		// the PhaseOrchestrator (handoff/fail decisions) and the Blueprint worktree
		// in-place-takeover gate. Orthogonal to FLYWHEEL_THREE_STAGE.
		name: "three_stage_keepalive_killswitch",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_THREE_STAGE_KEEPALIVE",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"全局关掉三段式 phase-session 保活（=0 回退 close-and-respawn 旧行为，不关三段式本身；默认 ON=三段 park 保活 + wake，QA↔implement 修复循环留全 context）(FLY-887)",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/three-stage-policy.ts",
				"threeStageKeepAliveEnabled",
				"call_time",
				"env-param",
			),
			envSite(
				"packages/edge-worker/src/Blueprint.ts",
				"runInner (worktree in-place takeover gate)",
				"call_time",
			),
		],
		toggleable: "readonly",
		note: "与 FLYWHEEL_THREE_STAGE 正交（那个关整条三段式）；本 env=0 只回退保活到 close+respawn，改后需重启 Bridge。",
	},
	{
		// FLY-1050: kill-switch for the dead-QA respawn. Default ON: a dead
		// three-stage QA phase row (terminated/failed/completed, no ship claim)
		// no longer blocks the implement→QA handoff re-drive — the stranded
		// implement gets a fresh QA respawned (boot reconcile + the scoped
		// QA-death event sites). `=0` reverts the respawn paths to the pre-fix
		// row-exists criteria (scoped sites inert; the G-A2 zero-row boot
		// re-drive is preserved). The terminated stranded-pass alert hardening
		// is deliberately NOT gated by this switch (rolling back the respawn
		// must not re-introduce the FLY-967 silent strand).
		name: "three_stage_qa_respawn_killswitch",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_THREE_STAGE_QA_RESPAWN",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"三段式死 QA 重生开关（=0 回退修复前行为:死 qa row 继续挡 implement→QA 重驱,scoped 事件位点不重生;terminated stranded-pass 告警硬化不受此开关控制）(FLY-1050)",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/phase-orchestrator.ts",
				"qaRespawnEnabled",
				"call_time",
			),
		],
		toggleable: "readonly",
		note: "与 FLYWHEEL_THREE_STAGE / FLYWHEEL_THREE_STAGE_KEEPALIVE 正交；本 env=0 只关死-QA 重生路径，改后需重启 Bridge。",
	},
	{
		// FLY-1224: per-phase vendor — the implement phase defaults to codex
		// (gpt-5.6-sol, xhigh). `=0` falls the implement dispatch back to the
		// legacy (claude, heavy) row — the operational escape hatch when the
		// codex account quota is exhausted. Display fallbacks (phaseMessageTag /
		// issue-display pending rows) read the same table, so they follow.
		name: "three_stage_codex_implement_killswitch",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_THREE_STAGE_CODEX_IMPLEMENT",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"三段式 implement 段 codex 派发开关（=0 → implement 回落 legacy (claude, heavy)；design/qa 不受影响；改 ~/.flywheel/.env 后需 restart-services.sh --bridge-only）(FLY-1224)",
		readSites: [
			envSite(
				"packages/config/src/three-stage-phases.ts",
				"resolvePhaseDispatch",
				"call_time",
			),
		],
		toggleable: "readonly",
		note: "与 FLYWHEEL_THREE_STAGE(整体开关)/ FLYWHEEL_THREE_STAGE_KEEPALIVE 正交；本 env=0 只翻 implement 段的 vendor/model，phase 表其余行不动。",
	},
	{
		// FLY-1245: per-phase vendor — the design phase defaults to claude/Fable
		// (heavy). `=1` flips the design dispatch to codex (gpt-5.6-sol, xhigh) —
		// the operational escape hatch when the Fable quota is the bottleneck.
		// MIRROR of the implement kill-switch but INVERTED activating value: design
		// defaults to claude (=1 opts INTO codex) whereas implement defaults to
		// codex (=0 falls back to claude). Display fallbacks (phaseMessageTag /
		// issue-display pending rows) read the same table, so they follow.
		name: "three_stage_codex_design_toggle",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_THREE_STAGE_CODEX_DESIGN",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description:
			"三段式 design 段 codex 派发开关（=1 → design 从 Fable 切到 codex gpt-5.6-sol xhigh；不设/≠1 → 现状 claude/heavy(Fable)，字节不变；implement/qa 不受影响；改 ~/.flywheel/.env 后需 restart-services.sh --bridge-only）(FLY-1245)",
		readSites: [
			envSite(
				"packages/config/src/three-stage-phases.ts",
				"resolvePhaseDispatch",
				"call_time",
			),
		],
		toggleable: "readonly",
		note: "与 implement 开关方向相反：implement 默认 codex(=0 关)，design 默认 Fable(=1 开)。正交于 FLYWHEEL_THREE_STAGE / FLYWHEEL_THREE_STAGE_KEEPALIVE；design=codex 后 design review 自动翻 Claude lane(FLY-1188 §7.1)。",
	},
	{
		// FLY-939 (G-D): Bridge boot logs its running HEAD and best-effort compares
		// it to origin/main; a STALE checkout (HEAD strictly behind origin/main)
		// WARNs + records a durable event + alerts the Lead. `=0` skips the whole
		// check. Pure observability (never affects boot). Dev/QA-slot Bridges run
		// branch checkouts → the ahead/diverged classification already silences them.
		name: "boot_sha_check",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_BOOT_SHA_CHECK",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"Bridge 启动打印运行 HEAD 并 best-effort 比对 origin/main;落后(stale checkout,merged 未生效)→ WARN + durable event + Lead 报警。=0 整段跳过。纯可观测,绝不影响启动;分支 checkout(dev/QA slot)自动静音 (FLY-939 G-D)",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/boot-sha-check.ts",
				"runBootShaCheck",
				"call_time",
				"env-param",
			),
		],
		toggleable: "readonly",
		note: "启动时一次性 best-effort git 检查;改后需重启 Bridge 才生效。",
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
	// ─── FLY-799: founder-in-thread ship approval + auto-finalize ───
	{
		name: "founder_auto_approve",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_FOUNDER_AUTO_APPROVE",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"FLY-799: founder 在 [FLY-XX] thread 的文字/✅ 批准 → 归属 founder → 写 approve_to_ship gate → runner 自 ship",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/approval-signal/founder-ship-approval-factory.ts",
				"autoApproveEnabled",
				"call_time",
			),
			envSite(
				"packages/teamlead/src/bridge/approval-signal/founder-reaction-approval-factory.ts",
				"autoApproveEnabled",
				"call_time",
			),
		],
		toggleable: "readonly",
		note: "call_time reads (live-toggleable in principle); marked readonly pending a resolve.direct-toggle proof test (fast-follow). `=0` → deliverer falls back to WAKE-only.",
	},
	{
		name: "stale_ship_rewake",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_STALE_SHIP_REWAKE",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"FLY-799 Part B: 重新唤醒卡在 approved_to_ship 的 runner（漏掉的自-ship wake）；死 runner → alert 一次 defer FLY-795",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/gate-poller.ts",
				"staleShipRewakeEnabled",
				"call_time",
			),
		],
		toggleable: "readonly",
		note: "GatePoller sub-cadence pass；`=0` 关掉再唤醒。call_time read (readonly pending direct-toggle proof).",
	},
	{
		name: "auto_linear_done",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_AUTO_LINEAR_DONE",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"FLY-799: runner 自-ship（confirmed merged）后自动把 Linear issue 翻到 Done",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/linear-issue-finalizer.ts",
				"makeLinearDoneFinalizer",
				"call_time",
			),
		],
		toggleable: "readonly",
		note: "在 runPostShipFinalization（merge-evidence gated）里读；`=0` 关掉自动 Done。call_time read (readonly pending direct-toggle proof).",
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
	// ─── FLY-1099: founder-reply ingest reliability ───
	{
		name: "deferred_founder_approval",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_DEFERRED_FOUNDER_APPROVAL",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"held 期间 founder 批准暂存 + hold 清后自动补绑(OFF=今日 held 提前 decline)",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/approval-signal/deferred-approval.ts",
				"deferredApprovalEnabled",
				"call_time",
			),
		],
		toggleable: "readonly",
		note: "handler 暂存分支与 rebind pass 双读点;call_time read (readonly pending direct-toggle proof).",
	},
	{
		name: "held_declined_reply",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_HELD_DECLINED_REPLY",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"held 时给 founder 发 thread 明文解释(硬要求① — ❓ 不再是哑谜)",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/approval-signal/deferred-approval.ts",
				"heldReplyEnabled",
				"call_time",
			),
		],
		toggleable: "readonly",
		note: "与 deferred_founder_approval 组成 §4.4 2×2 真值表;call_time read.",
	},
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
		name: "founder_notify_retry_max",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_FOUNDER_NOTIFY_RETRY_MAX",
		polarity: "default_on",
		valueKind: "value",
		default: "5",
		description: "founder action ledger 投递重试上限(超限 failed+emit_alert)",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/founder-action-drain.ts",
				"founderNotifyRetryMax",
				"call_time",
			),
		],
		toggleable: "readonly",
	},
	{
		name: "codex_hold_nudge",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_CODEX_HOLD_NUDGE",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description: "codex-hold 30min 早期 nudge 层(ledger 化 queue+wake 再驱动)",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/auto-qa-coordinator.ts",
				"AutoQaCoordinator.reconcileCodexHoldNudges",
				"call_time",
				"env-param",
			),
		],
		toggleable: "readonly",
	},
	{
		name: "codex_hold_nudge_ms",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_CODEX_HOLD_NUDGE_MS",
		polarity: "default_on",
		valueKind: "value",
		default: "1800000",
		description: "codex-hold nudge 阈值(默认 30min,早于 3h stuck 层)",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/auto-qa-coordinator.ts",
				"AutoQaCoordinator.reconcileCodexHoldNudges",
				"call_time",
				"env-param",
			),
		],
		toggleable: "readonly",
	},
	{
		name: "founder_reply_retry_max",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_FOUNDER_REPLY_RETRY_MAX",
		polarity: "default_on",
		valueKind: "value",
		default: "10",
		description: "founder 消息有界重试上限(超限 dead-letter+告警,cursor 解钉)",
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
		name: "founder_reply_watchdog",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_FOUNDER_REPLY_WATCHDOG",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"founder-reply 摄取 watchdog(pass 死亡/cursor 钉死/unreachable runner 告警)",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/founder-reply-watchdog.ts",
				"founderReplyWatchdogEnabled",
				"call_time",
			),
		],
		toggleable: "readonly",
	},
	{
		name: "zombie_gate_resolve",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_ZOMBIE_GATE_RESOLVE",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"僵尸 gate 自动 retire(Z1 三段式;OFF 连 intent 都不写=今日字节路径)",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/zombie-gate-hygiene.ts",
				"zombieGateResolveEnabled",
				"call_time",
			),
		],
		toggleable: "readonly",
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
	// FLY-1048 (PR-B) watchdog LLM judge — opt-in, default OFF. (Its two PR-A
	// detection siblings, stuck_errorsig + pane_multiframe, were固化 default-on
	// and retired in FLY-1243; watchdog_judge stays gated — it spawns Codex.)
	{
		name: "watchdog_judge",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_WATCHDOG_JUDGE",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description:
			"watchdog LLM judge 层(机械快路可疑才升级,跑 Codex 不占 Claude 额度,FLY-1048 PR-B/FLY-976)",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/plugin.ts",
				"buildJudgeRoutingDeps (routeSuspiciousReport judgeEnabled — suspicious 管道 + FLY-1234 心跳确认层共用)",
				"call_time",
			),
		],
		toggleable: "conversational",
	},
	// FLY-1234: the heartbeat session_stuck confirm layer (liveness probe →
	// two-frame compare → judge). Default ON kill-switch — `=0` reverts the
	// checkStuck emit path byte-for-byte (reverse-compat sentinel).
	{
		name: "stuck_pane_confirm",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_STUCK_PANE_CONFIRM",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"session_stuck 心跳告警前的 pane/进程证据确认层(liveness→双帧→judge,只因明确健康证据抑制,FLY-1234)",
		readSites: [
			envSite(
				"packages/teamlead/src/HeartbeatService.ts",
				"stuckConfirmEnabled",
				"call_time",
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
		name: "issue_display_refresh",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_ISSUE_DISPLAY_REFRESH",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"统一 issue 显示刷新：三个显示面从真实状态派生,park/wake/kill/finalize 等全生命周期触发(FLY-907);=0 回退 stage_changed 旧路径",
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
		name: "stale_terminal_close",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_STALE_TERMINAL_CLOSE",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"FLY-867: 终态 session 的 tmux 还活着超过 stale 阈值 → 经 closeRunner 自动收(泄漏兜底);=0 回退 GEO-270 纯通知",
		readSites: [
			envSite(
				"packages/teamlead/src/HeartbeatService.ts",
				"staleCloseEnabled",
				"call_time",
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
		name: "ship_gate_rebind",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_SHIP_GATE_REBIND",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"QA PASS 证据 commit 使 PR head 前移时自动 rebind ship gate(=0 回到 FLY-945 前的 drop 行为)",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/auto-qa-coordinator.ts",
				"shipGateRebindEnabled",
				"call_time",
				"env-param",
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
		name: "ship_gate_retire",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_SHIP_GATE_RETIRE",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"FLY-1041 Fix A: rebind 后 retire 被取代的 approve_to_ship gate(event-route 主路径 + GatePoller sweeper 兜底)——同一时刻只留一个可绑 ship gate(=0 回到 FLY-910 前的僵尸 gate 现状)",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/event-route.ts",
				"retireSupersededShipGate",
				"call_time",
			),
			envSite(
				"packages/teamlead/src/bridge/gate-poller.ts",
				"shipGateRetireEnabled",
				"call_time",
			),
		],
		toggleable: "conversational",
	},
	{
		name: "ship_gate_card",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_SHIP_GATE_CARD",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"FLY-1041 Fix B: approve_to_ship 的 founder 卡转正为主载体(15s grace;=0 回到 10min FLY-605 兜底节奏)",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/gate-poller.ts",
				"shipGateCardEnabled",
				"call_time",
			),
		],
		toggleable: "conversational",
	},
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
	{
		name: "reply_to_card",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_REPLY_TO_CARD",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"FLY-1041 Fix B: founder 真·Discord 回复(type 19)ship 卡 → 确定性收窄到该 gate 归因(=0 忽略 message_reference,回现状)",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/founder-reply-deliverer.ts",
				"processFounderMessage (reply-to-card qualification)",
				"call_time",
			),
		],
		toggleable: "conversational",
	},
	{
		name: "attribution_hold_align",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_ATTRIBUTION_HOLD_ALIGN",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"FLY-1041 Fix B: held(codex 未绿/QA 未绿/merge_block)期间三个 founder 批准写入源(text/✅/voice)统一拒写(=0 回到 held 也写入的 FLY-910 现状;一个开关管三源)",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/auto-qa-held.ts",
				"founderApprovalHoldGuard",
				"call_time",
				"env-param",
			),
		],
		toggleable: "conversational",
	},
	{
		name: "tier2_prefix_norm",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_TIER2_PREFIX_NORM",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"FLY-1041 Fix C: tier2 允许剥离纯语气前缀(「嗯ship」→「ship」确定性命中;=0 回到降级 tier3 的现状——确定性批准语义扩张的独立回滚)",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/approval-signal/text-approval-source.ts",
				"evaluateTextSource",
				"call_time",
			),
		],
		toggleable: "conversational",
	},
	{
		name: "founder_approval_ack",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_FOUNDER_APPROVAL_ACK",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"FLY-1041 Fix C: founder 消息处理后在她消息上点 ✅(绑上)/❓(没绑上)回执 reaction(纯通知,无批准语义;=0 不点)",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/founder-reply-deliverer.ts",
				"processFounderMessage (receipt reaction)",
				"call_time",
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
		// FLY-869: flipped default_on — an absent config resolves to `enforce`
		// via resolveEffectiveFounderUxConfig (was opt_in `off` under FLY-598).
		polarity: "default_on",
		valueKind: "enum",
		enumValues: ["off", "audit_only", "enforce"],
		default: "enforce",
		description:
			"全 issue brainstorm 对齐门（治理门，只读）— 默认 gate 所有实质性 issue，仅 brainstorm-exempt 标签豁免",
		readSites: [
			{
				file: "packages/config/src/ConfigLoader.ts",
				symbol: "ConfigLoader.validate",
				pattern: "config",
				timing: "call_time",
			},
		],
		toggleable: "readonly",
		note: "absent → enforce（resolveEffectiveFounderUxConfig 收口，FLY-869）；显式 mode:off 才是旧行为的 kill-switch。",
	},
	{
		// FLY-900: fleet-wide kill-switch that RETIRES the founder-UX
		// implement-before-signoff gate (FLY-598 / FLY-869). Annie declared the gate
		// unnecessary AND it is currently mis-configured (no FLYWHEEL_FOUNDER_USER_ID
		// → the sign-off write fail-closes 503, permanently blocking every
		// founder-facing issue's implement). Stacks OVER the per-project
		// `founder_ux_gate.mode` (governance gate) as a fleet-wide override, like
		// `three_stage_killswitch` — but OPPOSITE polarity: default OFF (gate
		// disabled), only `=1` re-enables the original enforce. Governance gate →
		// ALWAYS readonly (never a founder dashboard toggle). Requires a Bridge
		// restart to take effect. The single flag semantic lives in the helper
		// `isFounderUxGateEnabled`; Blueprint (prompt injection), the status route,
		// the stage-guard call site, and claude-lead.sh all CONSUME that helper
		// (they carry no env literal, so the drift scanner does not scan them and
		// they are documented here as consumers, not readSites).
		name: "founder_ux_gate_killswitch",
		category: "governance_gate",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_FOUNDER_UX_GATE_ENABLED",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description:
			"全局撤掉 founder-UX 签字门（implement 前必须 thread 签字，FLY-598/869）；默认 OFF=门禁用，=1 恢复原 enforce（叠在 per-project founder_ux_gate.mode 上，FLY-900）",
		readSites: [
			envSite(
				"packages/config/src/founder-ux-config.ts",
				"isFounderUxGateEnabled",
				"call_time",
				"env-param",
			),
		],
		toggleable: "readonly",
		note: "单一语义在 helper isFounderUxGateEnabled；Blueprint(A)/status route(B)/stage-guard(C)/claude-lead.sh(D) 消费该 helper（无 env 字面量，非 readSite）；默认 OFF 撤门，=1 恢复；改后需重启 Bridge。",
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
	{
		name: "fleet_sensor_tmux_killswitch",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_FLEET_SENSOR_TMUX",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"FLY-1082: 关掉 tmux server-loss coordinator（HeartbeatService pre-reaper phase：fleet 级检测 + 成组终态迁移 + 单张 fleet ticket + 按 Lead 分组通知）",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/plugin.ts",
				"createBridgeApp (HeartbeatService serverLoss pre-reaper phase arg)",
				"object_construction",
			),
		],
		toggleable: "readonly",
		note: "=0 时 server-loss 整段关闭,退回 per-runner crash-reaper/reapOrphans 旧行为。HeartbeatService 构造时读一次（ternary 选 phase 对象或 undefined）,翻转需重启 Bridge。",
	},
	{
		// FLY-1165: done-thread reconcile sweep (boot + periodic) — the structural
		// backstop behind the FLY-369 close→archive cascade. Double gate (fresh
		// Linear Done/Canceled + no live runner) + triple liveness veto; archives
		// through the shared sink (archive-once, per-thread serialized).
		name: "done_thread_reconcile",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_DONE_THREAD_RECONCILE",
		polarity: "default_on",
		valueKind: "bool",
		default: true,
		description:
			"FLY-1165: 关掉 done-thread reconcile sweep（Done/Canceled issue 的未归档 thread 自动归档兜底；调度器每 tick 重读 env，off→on/on→off 无需重启）",
		readSites: [
			envSite(
				"packages/teamlead/src/bridge/done-thread-reconcile.ts",
				"resolveDoneThreadReconcileConfig",
				"call_time",
				"env-param",
			),
		],
		toggleable: "direct",
		directToggleProof:
			"resolve.direct-toggle.test:done_thread_reconcile live-observe",
		note: "伴生 knobs：FLYWHEEL_DONE_THREAD_RECONCILE_INTERVAL_MIN / _DRYRUN / _MAX_PER_RUN（下方三条）。QA slot Bridge 由 test-deploy.sh 显式注入 =0 隔离（防扫真 Linear）。",
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
		name: "done_thread_reconcile_dryrun",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_DONE_THREAD_RECONCILE_DRYRUN",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description:
			"FLY-1165: reconcile sweep 只记不归档（=1 观察模式；每 tick 重读）",
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
		name: "workflow_claims_write",
		category: "governance_gate",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_WORKFLOW_CLAIMS_WRITE",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description:
			"FLY-1232/1244: workflow claims shadow writes and enrolled execution admission. Must remain off until the pinned fresh-spawn E2E and peer-credential hardening gates pass.",
		readSites: [
			envSite(
				"packages/teamlead/src/workflow-claims.ts",
				"isWorkflowClaimsWriteEnabled",
				"call_time",
				"env-param",
			),
			envSite(
				"packages/teamlead/src/bridge/plugin.ts",
				"startBridge / createBridgeApp workflow wiring",
				"bridge_boot",
			),
		],
		toggleable: "readonly",
		note: "Independent from claims READ and FORCE_LEGACY; production enable is governance-gated.",
	},
	{
		name: "workflow_claims_read",
		category: "governance_gate",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_WORKFLOW_CLAIMS_READ",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description:
			"FLY-1244: switch explicitly enrolled durable three-stage runs to claims-backed ship eligibility and authoritative head reads.",
		readSites: [
			envSite(
				"packages/teamlead/src/workflow-claims.ts",
				"isWorkflowClaimsReadEnabled",
				"call_time",
				"env-param",
			),
			envSite(
				"packages/flywheel-comm/src/ship-eligibility.ts",
				"evaluateShipEligibility",
				"cli_invocation",
				"dynamic",
			),
		],
		toggleable: "readonly",
		note: "Independent from claims WRITE; explicit run enrollment is still required.",
	},
	{
		name: "workflow_force_legacy",
		category: "kill_switch",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_WORKFLOW_FORCE_LEGACY",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description:
			"FLY-1244: emergency live-.env fallback that forces the legacy ship-eligibility reader before claims queries.",
		readSites: [
			envSite(
				"packages/flywheel-comm/src/ship-eligibility.ts",
				"evaluateShipEligibility",
				"cli_invocation",
				"dynamic",
			),
		],
		toggleable: "readonly",
		note: "Independent emergency fallback; resolved before any claims table access.",
	},
];
