import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	CheckpointsConfig,
	DocFlowConfig,
	FounderUxGateConfig,
	PonytailConfig,
	PonytailInput,
	SkillsConfig,
} from "flywheel-config";
import {
	DEFAULT_GATE_TIMEOUT_MS,
	PONYTAIL_CONFLICT,
	PONYTAIL_PLUGIN,
	PONYTAIL_SELECTOR_UNAVAILABLE,
	resolvePonytailRequested,
	toPonytailCondition,
} from "flywheel-config";
import type {
	AdapterExecutionResult,
	DecisionResult,
	ExecutionContext,
	IAdapter,
} from "flywheel-core";
import { buildWindowLabel, cleanIssueTitle } from "flywheel-core";
import type { DagNode } from "flywheel-dag-resolver";
import type { AgentDispatcher } from "./AgentDispatcher.js";
import type { IDecisionLayer } from "./decision/DecisionLayer.js";
import type {
	EventEnvelope,
	ExecutionEventEmitter,
} from "./ExecutionEventEmitter.js";
import type {
	ExecutionEvidence,
	ExecutionEvidenceCollector,
} from "./ExecutionEvidenceCollector.js";
import type { GitResultChecker } from "./GitResultChecker.js";
import type { HydratedContext, PreHydrator } from "./PreHydrator.js";
import type { SkillInjector } from "./SkillInjector.js";
import type { WorktreeInfo, WorktreeManager } from "./WorktreeManager.js";
import { deriveWorktreeKey } from "./WorktreeManager.js";

/**
 * FLY-205: Lead-judged doc tier — controls DOCUMENT OUTPUT ONLY (checkpoint
 * gates and executor hard gates apply at every tier).
 *
 * SINGLE SOURCE OF TRUTH for the enum (Codex R4 note): HTTP input validation
 * (runs-route), StateStore persistence, retry reuse, and prompt assembly all
 * import from here — no layer hand-rolls the value set.
 */
export const DOC_TIERS = ["full", "plan_only", "none"] as const;
export type DocTier = (typeof DOC_TIERS)[number];

/**
 * FLY-205: parse an untrusted value into a DocTier.
 * Returns undefined for anything that is not exactly one of DOC_TIERS —
 * callers decide whether undefined means "reject" (HTTP boundary) or
 * "fall back to full" (persisted-row read).
 */
export function parseDocTier(value: unknown): DocTier | undefined {
	return DOC_TIERS.includes(value as DocTier) ? (value as DocTier) : undefined;
}

/**
 * FLY-205: resolve the department directory segment for doc-flow paths.
 * `owningDept` carries the literal `"multiple"` for the FLY-127 ambiguous
 * case — that must NEVER become a directory name (Codex design R1 #1), so
 * only a concrete non-"multiple" string wins; everything else falls back to
 * the project's configured default department.
 */
export function resolveDocFlowDepartment(
	owningDept: string | "multiple" | undefined,
	defaultDepartment: string,
): string {
	return typeof owningDept === "string" && owningDept !== "multiple"
		? owningDept
		: defaultDepartment;
}

/** Result of a Blueprint execution */
export interface BlueprintResult {
	success: boolean;
	costUsd?: number;
	sessionId?: string;
	tmuxWindow?: string;
	durationMs?: number;
	error?: string;
	/**
	 * FLY-123 (Codex design review R1 #4): adapter session-resume params
	 * (e.g. Codex `threadId`). Previously `runInner()` dropped
	 * `AdapterExecutionResult.sessionParams` on the floor — StateStore could
	 * store it but the event chain never carried it. Passed through both
	 * event sinks into `sessions.session_params`.
	 */
	sessionParams?: Record<string, unknown>;
	// v0.2
	worktreePath?: string;
	evidence?: ExecutionEvidence;
	// v0.2 Step 2b
	decision?: DecisionResult;
	// CIPHER — passed through for event emitter → saveSnapshot
	labels?: string[];
	projectId?: string;
	exitReason?: string;
	consecutiveFailures?: number;
}

/**
 * FLY-615: which backends can actually CONSUME `enablePonytail`. Only the
 * Claude adapter (real plugin via --settings) and the Codex adapter (ruleset
 * injection) do. antigravity-tmux / kimi-tmux ignore it — so ponytail can never
 * be effectively "on" for them (Codex code-review MED): they must read as NOT
 * ready (→ unavailable, never on:*).
 */
const PONYTAIL_SUPPORTED_BACKENDS = new Set(["claude-tmux", "codex-tmux"]);

/**
 * FLY-615: per-backend readiness cache — caches ONLY positive (ready) results.
 * Once a backend probes ready, plugin install state is stable for the Bridge
 * lifetime, so we skip re-shelling-out (Codex LOW: avoid a synchronous
 * `execFileSync` per ponytail-on run-start). A negative result is NOT cached
 * (Codex R2 MED): if the plugin was missing, an operator running
 * `scripts/setup-ponytail.sh` mid-lifetime must be picked up by the next
 * ponytail-on run without a Bridge restart — so `false` is always re-probed.
 */
const ponytailReadyBackends = new Set<string>();

/**
 * FLY-615: default ponytail readiness probe. Codex path injects the ruleset as
 * plain prompt text (no external dep) → ready. Claude path needs the real
 * plugin installed in the inherited CLAUDE_CONFIG_DIR → probe `claude plugin
 * details ponytail@ponytail` (exit 0 = installed/usable). Unsupported backends
 * → not ready. Any error (claude missing, plugin absent) → not ready → caller
 * records an `unavailable` condition and skips the --settings flag (no silent
 * OFF data). Result cached per backend.
 */
export function defaultPonytailReadiness(backend: string): boolean {
	if (!PONYTAIL_SUPPORTED_BACKENDS.has(backend)) return false;
	if (ponytailReadyBackends.has(backend)) return true;
	// codex-tmux: ruleset injection is plain text → always ready.
	let ready = true;
	if (backend === "claude-tmux") {
		try {
			execFileSync("claude", ["plugin", "details", PONYTAIL_PLUGIN], {
				stdio: "ignore",
				timeout: 20_000,
			});
			ready = true;
		} catch {
			ready = false;
		}
	}
	// Cache only the positive result — a negative is re-probed next time so a
	// post-start `setup-ponytail.sh` is picked up without a Bridge restart.
	if (ready) ponytailReadyBackends.add(backend);
	return ready;
}

/** Runtime context for a single Blueprint execution */
export interface BlueprintContext {
	teamName: string;
	runnerName: string;
	/**
	 * FLY-615: ponytail input for this run — `start_signal` (fresh resolve from
	 * run-param + labels + project config) or `frozen_requested` (retry preserves
	 * the predecessor's A/B bucket). Built by runs-route (start) / actions (retry)
	 * and threaded through the dispatcher. Absent → Blueprint falls back to a
	 * start_signal derived from hydrated labels (byte-compatible: off:default
	 * unless a label/project opts in).
	 */
	ponytailInput?: PonytailInput;
	// v0.2 — optional for backward compat
	projectName?: string;
	sessionTimeoutMs?: number;
	// v0.2 Step 2b — tracked by caller (DagDispatcher)
	consecutiveFailures?: number;
	// v0.4 — optional; Blueprint fallback to randomUUID()
	executionId?: string;
	// GEO-168 — retry context for re-executed issues
	retryContext?: {
		predecessorExecutionId: string;
		previousError?: string;
		previousDecisionRoute?: string;
		previousReasoning?: string;
		attempt: number;
		reason?: string;
	};
	// GEO-206 — Lead ID for bidirectional communication prompt
	leadId?: string;
	// FLY-24 — Pre-fetched issue metadata (overrides PreHydrator on conflict)
	issueTitle?: string;
	issueIdentifier?: string;
	// FLY-205 — Linear issue URL from runs-route preflight (start) or session
	// row (retry). Baked into the DOC-FLOW header line; absent → key-only
	// degraded header.
	issueUrl?: string;
	// FLY-205 — Lead-judged doc tier. Defaults to "full" when omitted
	// (fail-safe: no Lead signal → full docs, never silently fewer).
	docTier?: DocTier;
	// FLY-59 — Session role for multi-session-per-issue support
	sessionRole?: string;
	// FLY-116 — Per-runner Terminal viewer hook. Fired by TmuxAdapter
	// after `tmux new-window` returns a windowId, before waitForCompletion.
	// Dispatchers set this to spawn a per-execution macOS Terminal tab.
	onTmuxWindowCreated?: (info: {
		baseSessionName: string;
		windowId: string;
	}) => void;
	// FLY-245 R2 HIGH-3 — fired the instant `tmux new-window` returns, BEFORE
	// CommDB registration. The gateway-retry dispatcher binds it to its durable
	// launch claim so a post-crash replay adopts the live Runner instead of
	// re-driving (which would orphan it). Best-effort.
	onTmuxWindowOpened?: (info: {
		baseSessionName: string;
		windowId: string;
	}) => void;
	// FLY-245 R5 HIGH — durable "Runner committed to start" record (gateway-retry
	// path only). The adapter gates the Runner on this file + writes it at the
	// commit point; the dispatcher adopts a replay ONLY if it exists.
	launchCommitPath?: string;
	// FLY-137 v1.27.2 — Lead override: explicit agent name; bypasses label-match dispatch
	agentName?: string;
	// FLY-137 v1.27.2 — Pre-normalized (lowercased) Linear labels passed by caller
	// (runs-route.ts normalizes once at the boundary). Optional for backward compat
	// with tests / call sites that haven't been migrated; Blueprint falls back to
	// `hydrated.labels` when omitted.
	issueLabels?: string[];
	// FLY-137 v1.27.2 — Owning dept of the issue, resolved by caller via
	// `DepartmentRegistry.getDepartmentForIssue`. Three possible values:
	//   - `string`: one Lead matched (e.g. "product")
	//   - `"multiple"`: 2+ Leads matched (FLY-127 ambiguous case)
	//   - `undefined`: no Lead matched OR no project Lead config
	// AgentDispatcher's dept-aware step 2 uses this to scope label match.
	owningDept?: string | "multiple";

	// FLY-142 PR 1.4 — Agent Team transport identity fields.
	//
	// When all three (runnerAgentName + agentTeamName + vendor) are set,
	// Blueprint forwards them to `adapter.execute()` which then invokes
	// `transport.buildRunnerSpawnConfig(ctx)` to merge vendor-specific CLI
	// flags (`--agent-id`, `--agent-name`, `--team-name`, ...) into the
	// Runner's tmux spawn. claude-code then enters Agent Team mode and
	// `useInboxPoller` reads the matching mailbox file under the
	// CLAUDE_CONFIG_DIR teams subtree — which is where
	// `MailboxLeadRuntime` writes Lead → Runner messages.
	//
	// Without these fields, transport wiring is skipped (transport branch
	// in TmuxAdapter is dead code) and the FLY-142 wake bug fix doesn't
	// actually take effect — mailbox is written but Runner never reads.
	//
	// **Distinct from FLY-137 `agentName`** (Lead-override dispatcher key
	// resolved by AgentDispatcher.dispatchByName). FLY-142 uses
	// `runnerAgentName` to avoid the semantic clash: each Runner needs a
	// per-execution UNIQUE name for its mailbox inbox file, while FLY-137's
	// `agentName` resolves to a shared dispatcher key (e.g., "frontend").

	/** Per-Runner unique agent identity (per-execution), e.g., `runner-<exec-id-slice>`. */
	runnerAgentName?: string;
	/** Agent Team name = Lead's agentId, e.g., `flywheel-test-2`. */
	agentTeamName?: string;
	/** Vendor backend. When `"claude-code"`, transport wiring activates. */
	vendor?: "claude-code" | "codex";
	/** Lead's claude session UUID — Runner spawns as child for the UI tree. */
	leadSessionId?: string;
	/** UI color hint for `--agent-color` (e.g., `"cyan"`). */
	agentColor?: string;

	// FLY-123 — role → adapter resolution (plan §3).

	/**
	 * Executor backend (AdapterRegistry key) resolved by RoleAdapterResolver
	 * in the dispatcher: `"claude-tmux"` | `"codex-tmux"`. Absent →
	 * `"claude-tmux"` (byte-compat default).
	 */
	runnerBackend?: string;
	/** Optional model override resolved alongside the backend (label/roles). */
	runnerModel?: string;
	/**
	 * FLY-671: optional reasoning-effort override (roles.runner.effort), resolved
	 * independently of backend/model. Flows to the claude-tmux adapter `--effort`.
	 * Absent ⇒ no `--effort` flag (account default).
	 */
	runnerEffort?: string;

	/**
	 * FLY-751: per-runner MCP slim profile, computed by run-dispatcher.ts (via
	 * `resolveRunnerMcpProfile`, gated on runnerBackend === "claude-tmux") on
	 * BOTH the start and retry paths. Blueprint only forwards the two fields to
	 * `adapter.execute()` — it never reads env itself (keeps this testable).
	 * Absent/null ⇒ no slimming (byte-compatible spawn).
	 */
	runnerMcpProfile?: {
		disabledPlugins: string[];
		disableChrome: boolean;
	} | null;

	/**
	 * FLY-493 — explicit no-transport contract. Set to `"none"` ONLY for a
	 * deliberately transport-less backend (antigravity-tmux: the `agy` CLI has
	 * no claude-code Agent Team, so v1 has no Lead→Runner push-wake). This is
	 * distinct from `vendor`/`runnerAgentName` being absent on the legacy/
	 * rollback path: those mean "default claude behavior", while
	 * `runnerTransportMode === "none"` means "this backend INTENTIONALLY has no
	 * transport". Blueprint uses it to emit the `pr_handoff` finish procedure
	 * (no `approve_to_ship` gate, no wake wait) — see the no-transport branch.
	 * Absent ⇒ existing behavior (claude/codex).
	 */
	runnerTransportMode?: "none";

	/**
	 * FLY-579: explicit git start point for the worktree (a commit SHA / ref).
	 * Threaded to `WorktreeManager.create({ startPoint })`. The Auto-QA
	 * coordinator passes the parent main session's `pr_head_sha` so the QA
	 * worktree is pinned to the exact reviewed commit. Absent ⇒ existing
	 * behavior (`FLYWHEEL_RUNNER_START_POINT` / `origin/main`).
	 */
	startPoint?: string;

	/**
	 * FLY-579: QA-runner context. Present ONLY for `sessionRole === "qa"`
	 * Auto-QA spawns. Blueprint renders a QA-mode prompt (independent
	 * verification — no implement/branch/push/PR, no approve-gate/ship) and the
	 * QA runner reports its verdict via `flywheel-comm qa-result`.
	 */
	qaContext?: QaContext;
}

/**
 * FLY-579: context injected into an Auto-QA runner's prompt so it knows which
 * PR / commit / parent session it is independently verifying.
 */
export interface QaContext {
	/** The main (implementer) session this QA run gates. */
	parentExecutionId: string;
	/** The reviewed commit the QA worktree is pinned to (`pr_head_sha`). */
	prHeadSha: string;
	/** GitHub PR number, when known. */
	prNumber?: number;
	/** The implementer's branch name, when known. */
	branch?: string;
	/**
	 * FLY-643: the PARENT (implementer) issue identifier being verified (e.g.
	 * "FLY-643"). When auto-QA runs on a SEPARATE `QA·FLY-XX` issue, the runner's
	 * own `issueId` is the QA issue — this carries the actual issue under test so
	 * the prompt says "verifying FLY-643" not "verifying the QA issue". Absent on
	 * the legacy same-issue / manual path (falls back to the runner's issueId).
	 */
	parentIssueIdentifier?: string;
	/** FLY-643: the PARENT issue URL, so the QA runner can read what it gates. */
	parentIssueUrl?: string;
}

/**
 * FLY-579: build the QA-mode runner prompt lines. An Auto-QA runner does
 * INDEPENDENT verification of an already-implemented + code-reviewed change at a
 * pinned commit. It must NOT implement / branch / push / PR / approve / ship — its
 * action is a structured `qa-result` verdict; FLY-752 fix-loop reuse then has it
 * STOP on PASS (the pipeline finalizes + cleans it up) or `declare-state park` +
 * wait for a RE-TEST on FAIL (never a terminal `complete`), which is how the
 * pipeline gates the founder while reusing the SAME QA runner.
 *
 * Exported so the QA prompt contract can be unit-tested directly (in addition to
 * the Blueprint.run() integration test that asserts a QA ctx produces these
 * lines and omits the implement/ship contract).
 */
export function buildQaModeSystemPromptLines(
	qaContext: QaContext,
	issueId: string,
	commCliPath: string,
	executionId: string,
): string[] {
	const prNote = qaContext.prNumber ? ` (PR #${qaContext.prNumber})` : "";
	const branchNote = qaContext.branch ? ` on branch ${qaContext.branch}` : "";
	// FLY-643: when auto-QA runs on a SEPARATE QA·FLY-XX issue, `issueId` is the
	// QA issue itself — verify the PARENT issue instead. Falls back to `issueId`
	// on the legacy same-issue / manual path (no parentIssueIdentifier).
	const verifying = qaContext.parentIssueIdentifier ?? issueId;
	const parentUrlNote = qaContext.parentIssueUrl
		? ` — read the issue at ${qaContext.parentIssueUrl}`
		: "";
	return [
		"You are an INDEPENDENT QA Runner (Flywheel Auto-QA, FLY-579). You did NOT implement this change and you must NOT modify it (qa-developer-separation).",
		`You are verifying ${verifying}${prNote} at the reviewed commit ${qaContext.prHeadSha}${branchNote}${parentUrlNote}. Your git worktree is already checked out at that exact commit (clean, read-only).`,
		...(qaContext.parentIssueIdentifier &&
		qaContext.parentIssueIdentifier !== issueId
			? [
					`(This QA runs on its own tracking issue ${issueId}; the change under test lives on ${verifying} — verify ${verifying}, not this QA issue.)`,
				]
			: []),
		"",
		"Steps:",
		"1. Read the issue, its product spec / plan, and the PR diff at the pinned commit.",
		"2. Plan the verification scenarios from the product spec — who actually uses this and is the flow right.",
		"3. Run real-machine E2E for user-facing flows (Claude-in-Chrome for browser surfaces, NOT Playwright) plus the package's own tests. API-returns-200 is not a product pass.",
		"4. Do NOT implement, do NOT create a feature branch, do NOT push, do NOT open a GitHub PR, do NOT run an approve/ship gate. Read-only git inspection is fine; never modify source/config.",
		"",
		"QA VERDICT (MANDATORY — this is how the pipeline gates the founder):",
		`a. Report your verdict STRUCTURALLY: \`node ${commCliPath} qa-result --exec-id ${executionId} --target-exec ${qaContext.parentExecutionId} --status pass|fail --summary "<what you tested + verdict + any blocking issue>"\``,
		// FLY-752: ONE QA per issue, REUSED in a fix loop — never a fresh QA2/QA3.
		"b. PASS → report qa-result pass, then RELEASE heavy resources (close all Claude-in-Chrome tabs / any browser you opened) and STOP. Do NOT run `complete` — the pipeline finalizes + cleans up this QA runner for you.",
		`c. FAIL → report qa-result fail with a specific report (exact scenario / expected-vs-actual / severity), then RELEASE heavy resources (close Claude-in-Chrome tabs; if your context is large, \`/compact\`), then \`node ${commCliPath} declare-state park --reason "auto-QA awaiting implementer retest"\`, then STOP and WAIT. Do NOT \`complete\`. You will be re-woken with a RE-TEST message when the implementer pushes a new head.`,
		"d. RE-TEST (when you are woken with a new reviewed head): re-fetch + re-checkout your worktree to the NEW commit, re-run your scenarios, then emit `qa-result` again (pass or fail). Same QA session — keep looping until PASS. This is why you release the browser + park between rounds: don't hold heavy resources while the implementer fixes.",
		"PASS → the pipeline notifies the founder (in the issue thread) that the change is ready to ship; the founder still does the ship approval (your PASS merges nothing). FAIL → the pipeline routes your report back to the implementer for a fix and re-tests with THIS SAME QA session (not a new one); the founder is NOT notified.",
		'The structured qa-result IS your deliverable — emit it even if the run is rough. Never use the stock SendMessage to:"team-lead" channel.',
	];
}

/**
 * FLY-137 wire-up fix: resolve the Bridge URL that Runners use to reach
 * `/events`, `/api/sessions/...`, etc. via `flywheel-comm`.
 *
 * Order:
 *   1. `TEAMLEAD_URL` if explicitly set (test-deploy.sh exports it).
 *   2. Fallback to `http://${TEAMLEAD_HOST||127.0.0.1}:${TEAMLEAD_PORT||9876}` —
 *      mirrors the defaults in packages/teamlead/src/config.ts. Blueprint runs
 *      inside the Bridge process, so this is always the origin to call.
 *
 * Returns undefined only if a non-loopback `TEAMLEAD_HOST` is configured but
 * `TEAMLEAD_URL` is not — in that case the caller MUST set `TEAMLEAD_URL`
 * explicitly (loopback assumption no longer holds).
 *
 * Exported for unit testing.
 */
/**
 * FLY-191 Phase 2 (QA-caught wiring gap): resolve the Bridge's StateStore
 * path for propagation into the Runner env (FLYWHEEL_STATE_DB_PATH), so
 * `flywheel-comm verify-approval` reads the SAME StateStore the Bridge
 * writes. Blueprint runs in the Bridge process tree, so the Bridge's own
 * TEAMLEAD_DB_PATH is visible here. `:memory:` (unit-test stores) is never
 * propagated — there is no file for the Runner to read.
 */
export function resolveStateDbPathForRunner(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const p = (env.FLYWHEEL_STATE_DB_PATH ?? env.TEAMLEAD_DB_PATH)?.trim();
	if (!p || p === ":memory:") return undefined;
	return p;
}

export function resolveBridgeUrl(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const explicit = env.TEAMLEAD_URL?.trim();
	if (explicit) return explicit;
	const host = env.TEAMLEAD_HOST?.trim() || "127.0.0.1";
	const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
	if (!LOOPBACK.has(host)) {
		// Non-loopback host — caller must set TEAMLEAD_URL explicitly so the
		// Runner reaches the right interface (loopback assumption broken).
		return undefined;
	}
	const portRaw = env.TEAMLEAD_PORT?.trim();
	const port = portRaw ? Number.parseInt(portRaw, 10) : 9876;
	if (!Number.isFinite(port) || port < 1 || port > 65535) {
		return undefined;
	}
	// Codex R1 fix: IPv6 literals must be bracketed in URL authority per
	// RFC 3986 §3.2.2. `config.ts` ALLOWED_HOSTS accepts `::1`, so a bare
	// `http://::1:9876` was an invalid URL — `flywheel-comm` would fail to
	// parse it. Bracket the host when it's an IPv6 literal (contains `:`).
	const hostForUrl = host.includes(":") ? `[${host}]` : host;
	return `http://${hostForUrl}:${port}`;
}

/** Shell command runner for tmux window cleanup */
export interface ShellRunner {
	execFile(
		cmd: string,
		args: string[],
		cwd: string,
	): Promise<{ stdout: string; exitCode: number }>;
}

/**
 * Blueprint: interactive-mode orchestration engine.
 *
 * Flow: [Worktree setup] → Git preflight → Pre-Hydrate → [Skill injection] →
 *       Launch Claude (tmux) → Wait → Git check → [Evidence collection] →
 *       [Decision Layer] → Result
 *
 * v0.1.1: No worktree, no skills, no evidence, no decision.
 * v0.2: Worktree isolation + skill injection + evidence collection.
 * v0.2 Step 2b: Decision Layer integration (optional).
 * v0.6: Agent dispatch (project-aware prompt assembly).
 */
export class Blueprint {
	constructor(
		private hydrator: PreHydrator,
		private gitChecker: GitResultChecker,
		private getAdapter: (name: string) => IAdapter,
		private shell: ShellRunner,
		// v0.2 — optional for backward compat
		private worktreeManager?: WorktreeManager,
		private skillInjector?: SkillInjector,
		private evidenceCollector?: ExecutionEvidenceCollector,
		private skillsConfig?: SkillsConfig,
		// v0.2 Step 2b — optional for backward compat
		private decisionLayer?: IDecisionLayer,
		// v0.4 — optional event emitter for TeamLead pipeline
		private eventEmitter?: ExecutionEventEmitter,
		// v0.6 — optional agent dispatcher for project-aware prompts
		private agentDispatcher?: AgentDispatcher,
		// FLY-47 — optional checkpoint gate configuration
		private checkpointConfig?: CheckpointsConfig,
		// FLY-137 v1.27.2 — Flywheel repo root, used by Blueprint to resolve
		// shipped-generic agent files when `dispatchResult.agentFileRoot === "flywheel"`.
		// Optional for backward compat with test stubs; if absent AND a dispatch
		// returns `agentFileRoot: "flywheel"`, agent content load logs a warning
		// and the system prompt falls back to baseline (same as v1.27.0 behavior).
		private flywheelRepoRoot?: string,
		// FLY-205 — optional doc-flow config from project .flywheel/config.yaml.
		// MUST stay the LAST constructor parameter (Codex design R2 #5: long
		// positional constructor — inserting between checkpointConfig and
		// flywheelRepoRoot would silently misalign existing call sites and
		// break shipped-generic agent resolution). Absent/disabled → no
		// DOC-FLOW prompt block (byte-compatible spawn prompt).
		private docFlowConfig?: DocFlowConfig,
		// FLY-598 — optional founder-UX gate config. MUST stay the LAST
		// constructor parameter (same positional-alignment contract as
		// docFlowConfig). Absent or mode==="off" → no founder-UX prompt block
		// (byte-compatible spawn prompt).
		private founderUxGateConfig?: FounderUxGateConfig,
		// FLY-615 — optional per-project ponytail config (lowest ladder layer).
		// MUST stay among the LAST constructor parameters (same positional-
		// alignment contract as docFlowConfig / founderUxGateConfig). Absent →
		// no per-project ponytail (label/run layers still apply); byte-compatible.
		private ponytailConfig?: PonytailConfig,
		// FLY-615 — readiness probe: is ponytail actually usable for `backend`?
		// Injectable for tests. Default (set below) checks `claude plugin details`
		// for claude-tmux; the Codex ruleset-injection path is always ready
		// (plain text). `requested on` + NOT ready → effective "unavailable".
		private ponytailReadiness: (
			backend: string,
		) => boolean = defaultPonytailReadiness,
	) {}

	async run(
		node: DagNode,
		projectRoot: string,
		ctx: BlueprintContext,
	): Promise<BlueprintResult> {
		const executionId = ctx.executionId ?? randomUUID();
		// v0.3 — canonical project scope (unified for events + memory)
		const projectScope = ctx.projectName ?? ctx.teamName ?? "unknown";

		// Hydrate BEFORE emitStarted so labels are available in session_started payload
		const hydrated = await this.hydrator.hydrate(node);

		// FLY-615: resolve the ponytail condition BEFORE the event envelope so
		// the session_started upsert carries `ponytail_condition` (the FLY-614/616
		// A/B join key). Falls back to a start_signal from hydrated labels when no
		// explicit ponytailInput was threaded (byte-compatible: off:default unless
		// a label/project opts in). selector-unavailable (labels unreadable under
		// project-on) and readiness failure both yield an `unavailable` condition
		// (no --settings, recorded for audit, excluded from 614/616).
		const ponytailCondition = this.resolvePonytailCondition(ctx, hydrated);

		const env: EventEnvelope = {
			executionId,
			issueId: node.id,
			projectName: projectScope,
			// FLY-24: Pre-fetched metadata from runs-route takes precedence over PreHydrator
			// (PreHydrator may fail Linear API and fall back to stub title)
			issueIdentifier: ctx.issueIdentifier ?? hydrated.issueIdentifier,
			issueTitle: ctx.issueTitle ?? hydrated.issueTitle,
			labels: hydrated.labels,
			retryPredecessor: ctx.retryContext?.predecessorExecutionId,
			runAttempt: ctx.retryContext?.attempt,
			// FLY-59: Propagate session role from context to event envelope
			sessionRole: ctx.sessionRole,
			// FLY-493: persist the resolved executor backend (→ session.adapter_type)
			// so the no-transport wake-guard can recognize an antigravity session.
			...(ctx.runnerBackend && { runnerBackend: ctx.runnerBackend }),
			// FLY-728: persist the resolved runner model (→ session.runner_model) for
			// per-issue model routing visibility. Absent → account default (no --model).
			...(ctx.runnerModel && { runnerModel: ctx.runnerModel }),
			// FLY-615: persisted ponytail condition (→ session.ponytail_condition).
			...(ponytailCondition && { ponytailCondition }),
		};

		// Fire-and-forget started event (labels now populated)
		this.eventEmitter?.emitStarted(env).catch(() => {});

		try {
			const result = await this.runInner(node, projectRoot, ctx, env, hydrated);
			await this.emitTerminal(env, result);
			return result;
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			const failResult: BlueprintResult = { success: false, error: errorMsg };
			await this.emitTerminal(env, failResult);
			throw err;
		}
	}

	/**
	 * FLY-615: resolve this run's ponytail condition (the persisted A/B tag).
	 * Returns the encoded `ponytail_condition` string, or undefined when there
	 * is no ponytail involvement to record (e.g. a label conflict we refuse to
	 * guess — logged, treated as off).
	 */
	private resolvePonytailCondition(
		ctx: BlueprintContext,
		hydrated: HydratedContext,
	): string | undefined {
		const input: PonytailInput = ctx.ponytailInput ?? {
			kind: "start_signal",
			signal: {
				labelStatus: "readable",
				labels: (ctx.issueLabels ?? hydrated.labels).map((l) =>
					l.toLowerCase(),
				),
			},
		};
		let resolved: ReturnType<typeof resolvePonytailRequested>;
		try {
			resolved = resolvePonytailRequested(input, this.ponytailConfig);
		} catch (err) {
			// Conflicting ponytail / ponytail-off labels — refuse to guess. Record
			// a DISTINCT unavailable:conflict (loud, excluded from A/B) rather than
			// a silent off:default; the run proceeds WITHOUT ponytail.
			console.warn(
				`[Blueprint] ponytail label conflict for ${hydrated.issueId} — NOT enabling ponytail, recording unavailable:conflict: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			return PONYTAIL_CONFLICT;
		}
		if (resolved.kind === "selector_unavailable") {
			return PONYTAIL_SELECTOR_UNAVAILABLE;
		}
		const { requested } = resolved;
		if (requested.want === "off") {
			return toPonytailCondition(requested, false).encoded;
		}
		// want === "on" — consult readiness for the resolved backend.
		const ready = this.ponytailReadiness(ctx.runnerBackend ?? "claude-tmux");
		return toPonytailCondition(requested, ready).encoded;
	}

	private async runInner(
		node: DagNode,
		projectRoot: string,
		ctx: BlueprintContext,
		env: EventEnvelope,
		hydrated: HydratedContext,
	): Promise<BlueprintResult> {
		// FLY-615: enable ponytail for this run iff the resolved condition is
		// effectively on (encoded "on:<source>"). unavailable/off → no enablement.
		const enablePonytail = (env.ponytailCondition ?? "").startsWith("on:");
		// FLY-123: adapter lookup is by EXECUTOR BACKEND (registry key), not by
		// ctx.runnerName (a display-ish field the old makeAdapter closure
		// ignored anyway). Absent → claude-tmux, byte-compat with production.
		const adapter = this.getAdapter(ctx.runnerBackend ?? "claude-tmux");
		const startTime = Date.now();
		const executionId = env.executionId;
		let cwd = projectRoot;
		let worktreeInfo: WorktreeInfo | undefined;

		// ── Worktree setup (v0.2 — own try/catch) ──────────────
		if (this.worktreeManager) {
			const projectName = ctx.projectName ?? ctx.teamName;
			// FLY-95: Role-aware worktree naming to prevent main/QA collision.
			// FLY-603: extracted into the shared deriveWorktreeKey() helper so the
			// post-ship / reconciler cleanup derives the exact same key (no drift).
			const worktreeIssueId = deriveWorktreeKey(node.id, ctx.sessionRole);
			try {
				await this.worktreeManager.removeIfExists(
					projectRoot,
					projectName,
					worktreeIssueId,
				);
				worktreeInfo = await this.worktreeManager.create({
					mainRepoPath: projectRoot,
					projectName,
					issueId: worktreeIssueId,
					// FLY-579: QA pins the worktree to the reviewed commit
					// (parent pr_head_sha). Absent → WorktreeManager falls back to
					// FLYWHEEL_RUNNER_START_POINT / origin/main (existing behavior).
					startPoint: ctx.startPoint,
				});
				cwd = worktreeInfo.worktreePath;
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : String(error),
					worktreePath: worktreeInfo?.worktreePath,
				};
			}

			// FLY-137: Persist worktree_path on the session row before any
			// stage event can fire. The Codex auto-trigger handler (Bridge
			// stage_changed=design_review/pr_created) needs
			// `session.worktree_path` to write skip.json + review-result
			// markers inside the Runner's cwd; without this await, skip.json
			// lands in a fallback directory the Runner can't see and the
			// gate hangs until timeout.
			if (this.eventEmitter && worktreeInfo) {
				try {
					await this.eventEmitter.emitWorktreeReady(
						env,
						worktreeInfo.worktreePath,
					);
				} catch (err) {
					// Reliable post already retries internally; if it still
					// fails we log and proceed. Downstream stage handlers
					// fall back to the derived path with a warning.
					console.warn(
						`[Blueprint] emitWorktreeReady failed for ${hydrated.issueId}: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
		}

		// ── Git exclude for .flywheel/runs/ (v0.6 — BEFORE assertCleanTree) ──
		try {
			await ensureFlywheelRunsExclude(cwd);
		} catch (err) {
			console.warn(
				`[Blueprint] Failed to set up .flywheel/runs/ git exclude: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		// ── Git preflight (existing — THROWS on failure) ──────
		await this.gitChecker.assertCleanTree(cwd);
		const baseSha = await this.gitChecker.captureBaseline(cwd);

		// ── Skill injection (v0.2 — best-effort, non-blocking) ─
		let skillInjectionSucceeded = false;
		if (this.skillInjector) {
			const projectName = ctx.projectName ?? ctx.teamName;
			try {
				await this.skillInjector.inject(cwd, {
					issueId: hydrated.issueId,
					issueTitle: hydrated.issueTitle,
					issueDescription: hydrated.issueDescription,
					projectName,
					testCommand: this.skillsConfig?.test_command,
					lintCommand: this.skillsConfig?.lint_command,
					buildCommand: this.skillsConfig?.build_command,
					testFramework: this.skillsConfig?.test_framework,
				});
				skillInjectionSucceeded = true;
			} catch (err) {
				console.warn(
					`[Blueprint] Skill injection failed (non-fatal): ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
		}

		// ── Agent dispatch (v0.6 — after hydrate, before prompt) ─
		// FLY-137 v1.27.2 dispatch contract:
		//   - Lead override (ctx.agentName) → AgentDispatcher.dispatchByName(name); throws on unknown
		//   - Otherwise → AgentDispatcher.dispatch({ issueLabels, owningDept })
		//     - issueLabels: caller-normalized lowercased labels (falls back to hydrated.labels)
		//     - owningDept: caller-resolved via DepartmentRegistry; undefined for legacy callers
		const dispatchResult = (() => {
			if (!this.agentDispatcher) return null;
			if (ctx.agentName) {
				return this.agentDispatcher.dispatchByName(ctx.agentName);
			}
			const issueLabels =
				ctx.issueLabels ?? hydrated.labels.map((l) => l.toLowerCase());
			return this.agentDispatcher.dispatch({
				issueLabels,
				owningDept: ctx.owningDept,
			});
		})();

		// ── Landing signal path (v0.6) ───────────────────────
		const landSignalPath = path.join(
			cwd,
			".flywheel",
			"runs",
			executionId,
			"land-status.json",
		);
		// Landing is only supported in worktree mode (single-repo)
		const landingEnabled = !!this.worktreeManager;
		const hasLandCommand = !!this.skillsConfig?.land_command;
		const canLand =
			landingEnabled && (skillInjectionSucceeded || hasLandCommand);

		// ── Build prompt + system prompt ──────────────────────
		// FLY-579: an Auto-QA runner (sessionRole="qa", qaContext present) does
		// INDEPENDENT verification of an already-implemented + code-reviewed change.
		// It must NOT receive the implement/branch/push/PR or approve-gate/ship
		// contract (that contradicts its read-only QA role). Its detailed protocol
		// comes from the shipped qa-executor agent file (injected as agentContext);
		// the QA base steps + structured verdict are appended after commCliPath is
		// resolved. So we start the QA prompt empty here and skip the implement /
		// land / doc-flow / brainstorm / approve-gate blocks below.
		const isQaRunner = !!ctx.qaContext;

		// FLY-643: an Auto-QA runner verifies the PARENT issue under test. When it
		// runs on a SEPARATE QA·FLY-XX issue, `hydrated.issueId` is the QA issue —
		// point the prompt at the parent (qaContext.parentIssueIdentifier) so it
		// doesn't read "QA the QA issue". Falls back to its own issueId on the
		// legacy same-issue / manual path.
		const qaTarget = ctx.qaContext?.parentIssueIdentifier ?? hydrated.issueId;
		const prompt = isQaRunner
			? `Independently QA ${qaTarget} at the reviewed commit (its own tracking issue is ${hydrated.issueId}: ${hydrated.issueTitle}).\n\n${hydrated.issueDescription}`
			: `Implement ${hydrated.issueId}: ${hydrated.issueTitle}.\n\n${hydrated.issueDescription}`;

		const systemPromptLines: string[] = isQaRunner
			? []
			: [
					"You are working on a Linear issue. Follow these steps:",
					"1. Read the codebase and understand the context (CLAUDE.md, relevant files).",
					"2. Implement the requested changes following TDD.",
					"3. Create a feature branch, commit your changes.",
					"4. Push the branch and create a GitHub PR.",
				];

		if (!isQaRunner && canLand) {
			// v0.6: land after PR creation (v1.0 Phase 2: no merge — report readiness only)
			if (hasLandCommand) {
				systemPromptLines.push(
					`5. After creating the PR, use ${this.skillsConfig!.land_command} to monitor CI readiness.`,
					`   You MUST write the landing signal file. Do NOT merge the PR — write {"status":"ready_to_merge"} and exit.`,
				);
			} else {
				systemPromptLines.push(
					"5. After creating the PR, follow the flywheel-land skill to monitor CI and report readiness.",
				);
			}
			systemPromptLines.push(
				"6. After writing the landing signal (ready_to_merge or failed), exit the session.",
				`Landing signal path: ${landSignalPath}`,
			);
		} else if (!isQaRunner) {
			// Legacy behavior: stop after PR
			systemPromptLines.push(
				"5. Verify CI passes. If CI fails, fix and push again.",
				"6. When all work is complete, stop and wait.",
			);
		}

		if (ctx.retryContext) {
			const rc = ctx.retryContext;
			systemPromptLines.push("");
			systemPromptLines.push(`## Retry Context (Attempt #${rc.attempt})`);
			systemPromptLines.push(
				`This is a retry of a previous execution that ${rc.previousDecisionRoute === "blocked" ? "was blocked" : "failed"}.`,
			);
			if (rc.previousError)
				systemPromptLines.push(`Previous error: ${rc.previousError}`);
			if (rc.previousReasoning)
				systemPromptLines.push(`Previous reasoning: ${rc.previousReasoning}`);
			if (rc.reason) systemPromptLines.push(`CEO instruction: ${rc.reason}`);
			systemPromptLines.push(
				"Please address the issues from the previous attempt.",
			);
		}

		// GEO-292: Lift commCliPath to outer scope so both lead-comm and stage injection can use it
		const __filename = fileURLToPath(import.meta.url);
		const commCliPath = path.resolve(
			path.dirname(__filename),
			"../../flywheel-comm/dist/index.js",
		);

		// FLY-579: QA-mode skeleton + structured verdict (needs commCliPath +
		// executionId). The shipped qa-executor agent file carries the detailed
		// protocol; these lines are the minimal base steps + the qa-result gate.
		if (isQaRunner && ctx.qaContext) {
			systemPromptLines.push(
				...buildQaModeSystemPromptLines(
					ctx.qaContext,
					hydrated.issueId,
					commCliPath,
					executionId,
				),
			);
		}

		// FLY-205: DOC-FLOW block — project doc conventions, injected ONLY when
		// the project's .flywheel/config.yaml enables doc_flow. Unshifted BEFORE
		// the onboard preamble unshift below, so the final order reads:
		//   [onboard preamble] → [DOC-FLOW] → [6-step base flow].
		// Controls DOCUMENT OUTPUT ONLY — checkpoint gates and executor hard
		// gates apply at every tier (locked semantics, Codex design R1 #5).
		// Disabled/absent config → zero lines added (byte-compatible prompt).
		// FLY-579: a QA runner produces no docs → skip doc-flow.
		if (!isQaRunner && this.docFlowConfig?.enabled === true) {
			const defaultDepartment = this.docFlowConfig.default_department;
			if (!defaultDepartment) {
				// ConfigLoader enforces presence when enabled; defensive fail-safe
				// to byte-compat rather than injecting a broken path.
				console.warn(
					"[Blueprint] doc_flow.enabled is true but default_department is missing — skipping DOC-FLOW injection (run ConfigLoader validation on this project's config)",
				);
			} else {
				const tier: DocTier = ctx.docTier ?? "full";
				const dept = resolveDocFlowDepartment(
					ctx.owningDept,
					defaultDepartment,
				);
				const issueKey = ctx.issueIdentifier ?? hydrated.issueId;
				const docDir = `${dept}/doc/${issueKey}-<slug>`;
				const headerIssueLine = ctx.issueUrl
					? `Issue: ${issueKey} (${ctx.issueUrl})`
					: `Issue: ${issueKey} (URL 不可得,只写 issue 号)`;
				const docFlowLines = [
					"DOC-FLOW (project doc conventions — this project has doc_flow enabled):",
					`Doc tier for this task: ${tier} (set by your Lead; full = default).`,
					"This tier controls DOCUMENT OUTPUT ONLY — all checkpoint gates and your",
					"agent-role gates (brainstorm confirmation etc.) still apply at every tier.",
					`Folder: ${docDir}/ — before creating it, \`ls ${dept}/doc/\` and REUSE any`,
					`existing folder with the ${issueKey}- prefix; derive a 2-4 word lowercase`,
					"kebab slug from the issue title. Docs travel with your branch and merge",
					"to main in your PR. Do NOT create status subdirectories (no draft/new/",
					"inprogress/archive) — progress lives in Linear only.",
				];
				if (tier === "full") {
					docFlowLines.push(
						"- full: BEFORE writing implementation code, produce exploration.md,",
						`  research.md, plan.md in that folder. Run \`node ${commCliPath} stage set`,
						"  brainstorm|research|plan` as you enter each phase; after writing plan.md run",
						`  \`node ${commCliPath} stage set design_review --plan ${docDir}/plan.md\``,
						"  and follow the existing design-review gate flow before implementing.",
					);
				} else if (tier === "plan_only") {
					docFlowLines.push(
						"- plan_only: produce only plan.md in that folder before implementation,",
						`  then run \`node ${commCliPath} stage set design_review --plan ${docDir}/plan.md\``,
						"  and follow the existing design-review gate flow before implementing.",
					);
				} else {
					docFlowLines.push(
						"- none: no process docs required for this task (your Lead judged it simple",
						"  and has notified the founder; she may still ask for docs later — comply).",
					);
				}
				if (tier !== "none") {
					docFlowLines.push(
						"Every doc starts with title + 3 lines:",
						`  # ${issueKey} <短标题> — <文档类型: 探索/调研/实施计划>`,
						`  ${headerIssueLine}`,
						"  日期: <today, YYYY-MM-DD>",
						"  基于: <同文件夹上游文档名,如 research.md;没有就写 无>",
					);
				}
				docFlowLines.push("");
				systemPromptLines.unshift(...docFlowLines);
			}
		}

		// FLY-598: FOUNDER-UX GATE block — injected ONLY when the project enables
		// founder_ux_gate (mode !== off). Absent/off → zero lines added
		// (byte-compatible prompt). The judgment ("is this founder-facing UX") is
		// model-driven loose guidance, not a hardcoded rule (Annie decision #2);
		// the HARD enforcement is the Bridge (await-founder-ux-gate fail-closed +
		// stage_changed→implement guard). Self-declare guidance is shown for ALL
		// runs (Codex R2-#5: the backup trigger must not depend on pre-flagging).
		const founderUxMode = this.founderUxGateConfig?.mode;
		if (founderUxMode && founderUxMode !== "off") {
			const fuxLines = [
				"FOUNDER-UX GATE (this project enables founder_ux_gate):",
				"FOUNDER-FACING UX = anything the founder (Annie) directly sees or operates",
				"— notifications, flows, Discord messages, report layouts, command",
				"interactions, visuals, copy. (Examples, not a checklist — use judgment.)",
				"For such work the UX must be brainstormed with Annie and approved by HER",
				"before any implementation code.",
				"",
				"Self-declare (backup): if this issue involves founder-facing UX and was not",
				`already flagged, run \`node ${commCliPath} declare-founder-ux "<one-line why>"\`.`,
				"It prints the exact next steps and opens the gate for this run.",
				"",
				"If this run IS founder-facing UX, BEFORE entering implement you MUST:",
				"  1. Brainstorm the UX with Annie; capture the agreed UX in a canonical",
				"     UX-brief file (e.g. <dept>/doc/<issue>-<slug>/ux-brief.md).",
				"  2. Have your Lead record Annie's natural-language approval (she replies in",
				"     Discord). Then block on the gate before writing implementation code:",
				`       node ${commCliPath} await-founder-ux-gate --ux-file <ux-brief>`,
				"     It fail-closes until Annie's verified sign-off for THIS ux-brief exists.",
				`  3. Enter implement WITH the brief: \`node ${commCliPath} stage set implement --ux-file <ux-brief>\`.`,
				"",
			];
			systemPromptLines.unshift(...fuxLines);
		}

		// FLY-137 v1.27.2: onboard stage preamble. Reports intent BEFORE attempting
		// the onboard skill so the dashboard reflects that the Runner started
		// onboarding (not just that it finished). Failure path uses existing
		// `complete --route blocked` (no new error stage).
		// Inserted at the TOP of systemPromptLines so the Runner sees this before
		// the standard pipeline instructions.
		if (ctx.projectName) {
			const onboardPreamble = [
				"PIPELINE PREAMBLE — run BEFORE any other work:",
				`(1) \`node ${commCliPath} stage set onboard\` — reports intent (you are starting onboarding).`,
				"(2) Attempt the `onboard` skill (or `onboard-<role>` matching your agent role if applicable).",
				`(3) On success: \`node ${commCliPath} stage set brainstorm\` and proceed.`,
				`(4) If the onboard skill file is absent in this project: \`node ${commCliPath} stage set brainstorm\` directly (legitimate for new projects).`,
				`(5) If the skill threw a hard error or hung: do NOT silently proceed. Run \`node ${commCliPath} complete --route blocked --summary "onboard_failed: <short reason>"\` and stop. This is the existing terminal failure channel — Bridge sees \`session_completed\` with \`status=blocked\`, Lead is notified, no silent hangs.`,
				"",
			];
			systemPromptLines.unshift(...onboardPreamble);
		}

		// GEO-206 / FLY-161: Inject flywheel-comm ask instructions when Lead is available
		if (ctx.leadId) {
			systemPromptLines.push(
				`Prefer independent implementation. If you encounter a major ambiguity ` +
					`(architecture choice, API design, priority conflict) that you cannot safely ` +
					`resolve alone but is NOT a hard checkpoint, use ` +
					`\`node ${commCliPath} ask --lead ${ctx.leadId} --exec-id ${executionId} "your question"\` ` +
					`— this is NON-BLOCKING: Bridge surfaces the question to your Lead within ~3 seconds ` +
					`(one GatePoller tick) while you continue working on other parts of the task. ` +
					`Then periodically run \`node ${commCliPath} check {question_id}\` to check for a response. ` +
					`If no response arrives before your session ends, use your best judgment. ` +
					`For HARD CHECKPOINTS where you MUST wait for a Lead decision before continuing ` +
					`(e.g. brainstorm understanding, approve_to_ship), use the \`gate\` commands described ` +
					`later in this prompt — those BLOCK until the Lead responds.`,
			);
			// GEO-266: Inbox instructions — auto-injected via PostToolUse hook, with manual fallback
			systemPromptLines.push(
				`Your Lead may send you instructions during your session. ` +
					`Instructions may appear automatically as context after your tool calls via a PostToolUse hook. ` +
					`Additionally, manually check with \`node ${commCliPath} inbox --exec-id ${executionId}\` at task boundaries ` +
					`(before committing, when starting a new subtask) as a safety net. ` +
					`When you receive a Lead instruction, evaluate urgency and act accordingly. ` +
					`Always briefly acknowledge received instructions.`,
			);

			// FLY-208 A1: LEAD REPORT-BACK + MERGE AUTHORITY hard rules.
			//
			// Production incident (sub LEARN-12, exec 433d4078): a completed
			// Runner executed a post-completion revision and "reported" via the
			// stock SendMessage tool with to:"team-lead" — a recipient that does
			// not exist in Flywheel's lead-named teams. The stock tool does not
			// validate recipients: it auto-creates a black-hole inbox file and
			// returns success, so the Runner honestly believed the Lead was
			// notified while the Lead heard nothing (product-lead's black hole
			// held 184 such reports). These rules live in the leadId block —
			// injected whenever a Lead exists, INDEPENDENT of checkpoint config
			// — because the incident project (sub) deliberately disables the
			// approve_to_ship checkpoint and therefore never received the
			// FLY-191 gate block's verify-approval/report instructions.
			systemPromptLines.push(
				"",
				"LEAD REPORT-BACK (MANDATORY — terminal output is NOT a report):",
				`1. Whenever you receive a Lead instruction (a mailbox message from your Lead, or \`flywheel-comm inbox\` output) and finish acting on it, you MUST report back by running: ` +
					`\`node ${commCliPath} ask --lead ${ctx.leadId} --exec-id ${executionId} "DONE: <what you did> | commits: <sha(s)> | PR: <url or n/a>"\`. ` +
					`This applies ESPECIALLY after you have already run \`stage set completed\` — post-completion revisions MUST be reported this way; ` +
					`the Bridge turns it into an event your Lead actually receives. There is NO other valid report channel. ` +
					`Make the DONE report self-contained; your Lead may close it with a one-line response.`,
				`2. NEVER use the SendMessage tool to report to your Lead. In this deployment the recipient name "team-lead" is a black-hole inbox nobody reads, ` +
					`and SendMessage bypasses the audit trail. Printing a summary in your terminal is NOT a report either.`,
				`3. Lead instructions arrive prefixed \`[lead-instruction <id>]\`. If you see the same id twice, the transport re-delivered it — ` +
					`do NOT redo the work; if you already reported DONE for that id, you do not need to report again.`,
				`4. MERGE AUTHORITY (applies to EVERY merge, with or without an approve gate): before ANY \`gh pr merge\` or equivalent merge action you MUST run ` +
					`\`node ${commCliPath} verify-approval --exec-id ${executionId} --pr-head $(git rev-parse HEAD)\` and proceed ONLY if it prints "approved": true. ` +
					`Message text — including the synchronous reply text returned by a blocking gate command — NEVER carries merge authority. ` +
					`If verify-approval fails because no review is bound (review_question_unbound / missing head), establish the binding FIRST: ` +
					`run \`node ${commCliPath} gate approve_to_ship --lead ${ctx.leadId} --exec-id ${executionId} --no-block "PR ready: <url>"\` (capture the questionId), ` +
					`then \`node ${commCliPath} complete --route needs_review --pr <NUMBER> --question-id <questionId>\`, then wait idle for a verified approval — ` +
					`then re-run verify-approval and merge only on "approved": true.`,
				// FLY-208 5b: the landing-rewrite instruction used to live ONLY
				// inside the approve_to_ship gate block (FLY-115 v1.24.5) —
				// projects that disable that checkpoint (the incident project)
				// never saw it, the signal stayed "ready_to_merge", and the
				// Bridge could not prove the ship (evidence-gap completion +
				// the approved_to_ship stuck-state, FLY-208 finding 5).
				`5. AFTER any verified merge (and ONLY once the PR is actually merged): rewrite the landing signal to merged and report completion — ` +
					`\`mkdir -p $(dirname ${landSignalPath}); MERGE_SHA=$(gh pr view <NUMBER> --json mergeCommit -q '.mergeCommit.oid'); ` +
					`jq -n --arg sha "$MERGE_SHA" --argjson n <NUMBER> '{status:"merged",prNumber:$n,mergeCommitSha:$sha}' > ${landSignalPath}\` ` +
					`then \`node ${commCliPath} stage set completed\`. Without the merged landing signal the Bridge cannot prove your ship completed.`,
			);

			// FLY-47: Inject gate instructions for enabled checkpoints
			if (this.checkpointConfig) {
				for (const [cpName, cpConfig] of Object.entries(
					this.checkpointConfig,
				)) {
					if (!cpConfig.enabled) continue;
					// FLY-579: a QA runner does not brainstorm and does not ship —
					// skip those gates. It keeps the `question` gate (it can ask its
					// Lead). FLY-752: its action is the qa-result verdict then STOP
					// (PASS) / park + wait for retest (FAIL) — never an approve_to_ship
					// gate, never a terminal `complete`.
					if (
						isQaRunner &&
						(cpName === "brainstorm" || cpName === "approve_to_ship")
					) {
						continue;
					}
					// FLY-159: default to 48h (was 30 min) so the gate timeout is
					// long enough that humans waking up in the morning still find
					// a Runner waiting for them. Project YAML can override.
					const timeoutMs = cpConfig.timeout_ms ?? DEFAULT_GATE_TIMEOUT_MS;
					const flags = [`--timeout ${timeoutMs}`];
					if (cpConfig.timeout_behavior) {
						flags.push(`--timeout-behavior ${cpConfig.timeout_behavior}`);
					}
					if (cpConfig.cleanup_ttl_hours != null) {
						flags.push(`--cleanup-ttl ${cpConfig.cleanup_ttl_hours}`);
					}
					if (cpConfig.stage) {
						flags.push(`--stage ${cpConfig.stage}`);
					}
					const flagStr = flags.join(" ");

					if (cpName === "brainstorm") {
						// FLY-123 (Codex design review R3 #1): a Codex runner CANNOT
						// sit inside the blocking gate process — its gate model is
						// process-boundary (register + END TURN; the adapter resumes
						// it with the Lead's reply). Claude text below is byte-identical
						// to pre-FLY-123.
						if (ctx.vendor === "codex") {
							systemPromptLines.push(
								"",
								"BRAINSTORM GATE (MANDATORY — do NOT skip):",
								"Before writing any code, you MUST confirm your understanding with your Lead.",
								"a. Read the issue and codebase. Form your understanding.",
								`b. Run: \`node ${commCliPath} gate brainstorm --lead ${ctx.leadId} --exec-id ${executionId} ${flagStr} --no-block "Your understanding: [what] [how] [expected outcome]"\` — it returns immediately.`,
								"c. Then END YOUR TURN: make your final message the exact understanding you submitted, and STOP. Do NOT write code. Your session will be resumed automatically with your Lead's response.",
								"d. When resumed, the first message is your Lead's response. If corrections were provided, adjust your approach before writing code.",
							);
						} else {
							systemPromptLines.push(
								"",
								"BRAINSTORM GATE (MANDATORY — do NOT skip):",
								"Before writing any code, you MUST confirm your understanding with your Lead.",
								"a. Read the issue and codebase. Form your understanding.",
								`b. Run: \`node ${commCliPath} gate brainstorm --lead ${ctx.leadId} --exec-id ${executionId} ${flagStr} "Your understanding: [what] [how] [expected outcome]"\``,
								"c. This command BLOCKS until your Lead confirms (default 48h timeout). Do NOT write code until it returns.",
								"d. Read the response. If corrections were provided, adjust your approach.",
								"e. If the command exits with a non-zero code (timeout fail-close), STOP immediately and do NOT continue writing code. Your Lead will be notified via Discord by the gate_timed_out event.",
							);
						}
					} else if (
						cpName === "approve_to_ship" &&
						ctx.runnerTransportMode === "none"
					) {
						// FLY-493: a no-transport (e.g. antigravity / kimi) Runner CANNOT be woken,
						// so it must NOT post the non-blocking approve gate (it would
						// strand in awaiting_review → approved_to_ship with no actor to
						// ship). Instead it terminates at `pr_handoff`: build → PR →
						// notify the Lead → record ready_to_merge → complete. The
						// founder ships the PR by hand (founder-gated, FLY-248).
						systemPromptLines.push(
							"",
							"FINISH (no-transport backend — build+PR handoff, NOT a ship gate):",
							"This backend has NO push-wake. Do NOT post an approve_to_ship gate, do NOT wait to be woken, do NOT ship. After your PR is open:",
							`a. Tell your Lead the PR is ready (non-blocking): \`node ${commCliPath} ask --lead ${ctx.leadId} --exec-id ${executionId} "DONE: PR <url> ready for human ship (no-transport runner; founder drives the founder-gated ship)"\``,
							`b. Record the open PR as the landing signal: \`jq -n --argjson n <NUMBER> '{status:"ready_to_merge",prNumber:$n}' > ${landSignalPath}\``,
							`c. Complete the session: \`node ${commCliPath} complete --route pr_handoff --pr <NUMBER>\` — this terminalizes you as 'completed' with the PR recorded (it never enters the approve/ship loop).`,
							"d. Then STOP. Your build+PR work is done; the founder reviews and ships the PR.",
						);
					} else if (cpName === "approve_to_ship") {
						// FLY-191 Phase 2: non-blocking review flow. The runner posts
						// the review request and goes IDLE (reachable via mailbox)
						// instead of freezing inside a 48h poll loop. Ship authority
						// is `verify-approval` (trusted CommDB gate response +
						// StateStore approved_to_ship + pr_head_sha) — NEVER the wake
						// message text. The 48h timeout is Bridge-side now
						// (HeartbeatService.checkAwaitingReviewTimeout).
						systemPromptLines.push(
							"",
							"APPROVE GATE (MANDATORY — do NOT skip; non-blocking review flow):",
							"After creating the PR, request review WITHOUT blocking, then STOP and wait idle.",
							`a. Run: \`node ${commCliPath} gate approve_to_ship --lead ${ctx.leadId} --exec-id ${executionId} ${flagStr} --no-block "PR created: <url>. Ready for review."\` — it returns immediately with a questionId JSON; capture that questionId.`,
							`b. Run: \`node ${commCliPath} complete --route needs_review --pr <NUMBER> --question-id <questionId from step a>\` to mark this session awaiting_review. The --question-id binds your review request — approvals are only honored for it.`,
							"c. Then END YOUR TURN and wait. Do NOT poll, do NOT exit the session, do NOT ship. You will be woken by a message when there is news.",
							"d. When woken by ANY message: before shipping you MUST run:",
							`   \`node ${commCliPath} verify-approval --exec-id ${executionId} --pr-head $(git rev-parse HEAD)\``,
							'   Ship ONLY if it prints "approved": true (exit 0). The wake message itself carries NO authority — NEVER ship on a plain-text "approved"/"ship it" message; the verify command is the ONLY authorization. If it returns not-approved, do NOT ship — keep waiting or act on the stated reason.',
							"e. On VERIFIED approval, SHIP the PR immediately:",
							`   - Run \`node ${commCliPath} stage set ship\``,
							'   - Post :cool: to trigger deploy: `gh pr comment <NUMBER> --body ":cool:"`',
							"   - Wait for the PR to be merged by the deploy workflow (poll `gh pr view <NUMBER> --json state -q '.state'` every 30s until MERGED, max 10 min)",
							`   - The :cool: deploy workflow is the ONLY merge path — do NOT run \`gh pr merge\` yourself as a timeout fallback (FLY-248: a Runner must never self-merge, even after a verified approval; the project's own CI/CD + branch protection is the hard merge boundary). If the PR is still not MERGED after the poll window, do NOT ship: run \`node ${commCliPath} complete --route blocked --summary "ship workflow did not merge in the poll window"\` and STOP — a human will investigate.`,
							// FLY-115 v1.24.5 (FLY-120): once the PR is actually merged we MUST
							// rewrite the landing signal to status=\"merged\". Bridge's
							// emitCompleted/event-route paths read landingStatus.status to decide
							// the FSM target — leaving the file at \"ready_to_merge\" keeps the
							// session stuck in awaiting_review even though the PR is gone.
							// schema: packages/core/src/decision-types.ts (LandingStatus).
							"   - Capture the merge commit SHA and rewrite the landing signal: `MERGE_SHA=$(gh pr view <NUMBER> --json mergeCommit -q '.mergeCommit.oid'); jq -n --arg sha \"$MERGE_SHA\" --argjson n <NUMBER> '{status:\"merged\",prNumber:$n,mergeCommitSha:$sha}' > <land-status-path>`",
							`   - Then run \`node ${commCliPath} stage set completed\`.`,
							'   Do NOT set stage to completed without first merging the PR AND rewriting the landing signal to status="merged".',
							"f. If the wake is FEEDBACK (changes requested — not an approval): address it, push your fixes, then RE-REQUEST review — repeat steps a and b (a NEW gate --no-block + a fresh `complete --route needs_review`; the review window resets). verify-approval will refuse to ship the old head anyway (pr_head_sha mismatch).",
							"g. Ordinary messages (questions, instructions — not approval/feedback): handle them, reply if needed, then keep waiting at this checkpoint.",
						);
					} else if (cpName === "question") {
						if (ctx.vendor === "codex") {
							systemPromptLines.push(
								"",
								"QUESTION GATE (use when needed):",
								"When you have a question that blocks your progress:",
								`a. Run: \`node ${commCliPath} gate question --lead ${ctx.leadId} --exec-id ${executionId} ${flagStr} --no-block "Your question here"\` — it returns immediately.`,
								"b. Then END YOUR TURN: make your final message the exact question, and STOP. Your session will be resumed automatically with your Lead's response.",
							);
						} else {
							systemPromptLines.push(
								"",
								"QUESTION GATE (use when needed):",
								"When you have a question that blocks your progress:",
								`a. Run: \`node ${commCliPath} gate question --lead ${ctx.leadId} --exec-id ${executionId} ${flagStr} "Your question here"\``,
								"b. This command BLOCKS until your Lead responds (default 48h timeout).",
								"c. If the command exits with a non-zero code (timeout fail-close), STOP immediately. Your Lead will be notified via Discord by the gate_timed_out event.",
							);
						}
					} else {
						if (ctx.vendor === "codex") {
							systemPromptLines.push(
								"",
								`${cpName.toUpperCase()} GATE:`,
								`When you reach the ${cpName} checkpoint:`,
								`a. Run: \`node ${commCliPath} gate ${cpName} --lead ${ctx.leadId} --exec-id ${executionId} ${flagStr} --no-block "Your message"\` — it returns immediately.`,
								"b. Then END YOUR TURN: make your final message the exact checkpoint message, and STOP. Your session will be resumed automatically with your Lead's response.",
							);
						} else {
							systemPromptLines.push(
								"",
								`${cpName.toUpperCase()} GATE:`,
								`When you reach the ${cpName} checkpoint:`,
								`a. Run: \`node ${commCliPath} gate ${cpName} --lead ${ctx.leadId} --exec-id ${executionId} ${flagStr} "Your message"\``,
								"b. This command BLOCKS until your Lead responds (default 48h timeout).",
								"c. If the command exits with a non-zero code (timeout fail-close), STOP immediately. Your Lead will be notified via Discord by the gate_timed_out event.",
							);
						}
					}
				}
			}
		} else {
			systemPromptLines.push(
				"Do not ask questions — implement your best judgment.",
			);
		}

		// NOTE: Session registration is handled by TmuxAdapter.run() which registers
		// with the correct session:window format. Do NOT add a duplicate registration
		// instruction here — it would overwrite the correct value with TMUX_PANE.

		// GEO-292: Stage reporting instructions (requires both Bridge URL and projectName)
		// FLY-137 wire-up fix: when TEAMLEAD_URL is unset (production case — only
		// scripts/test-deploy.sh exports it), fall back to the Bridge's own
		// loopback URL derived from TEAMLEAD_HOST/TEAMLEAD_PORT (same defaults
		// as packages/teamlead/src/config.ts). Blueprint runs INSIDE the Bridge
		// process, so this is always the correct origin to call. Without the
		// fallback, the Runner gets no FLYWHEEL_BRIDGE_URL, `flywheel-comm stage`
		// exits 1, and the FLY-137 onboard preamble silently no-ops — designer /
		// agent-specific protocols never trigger end-to-end.
		const bridgeUrl = resolveBridgeUrl();
		if (bridgeUrl && ctx.projectName) {
			systemPromptLines.push(
				`Report your pipeline stage at each major transition using: ` +
					`\`node ${commCliPath} stage set <stage>\`. ` +
					`Valid stages: brainstorm, research, plan, design_review, implement, test, code_review, pr_created, approve, ship, completed. ` +
					`Call this when you start each pipeline phase. ` +
					`Not every task goes through all stages — skip stages that don't apply ` +
					`(e.g., bug fixes may go directly to implement).`,
				"",
				"COMPLETION REPORTING (MANDATORY — run when finished):",
				"When you have completed your task (PR created, or no more work to do), " +
					`run \`node ${commCliPath} stage set completed\` so the system knows you are done. ` +
					"Do NOT leave your session idle without reporting completion.",
			);
		}
		const baseSystemPrompt = systemPromptLines.join("\n");

		// Agent context (additive — prepend before base system prompt)
		// FLY-137 v1.27.2: resolve agent_file root via agentFileRoot discriminant:
		//   - "project" → project cwd (project-declared agents)
		//   - "flywheel" → Flywheel repo root (shipped-generic fallback)
		// Codex Track A Round 1 #1 fix — was previously always cwd, which silently
		// dropped shipped-generic content for zero-config projects.
		let agentContext = "";
		if (dispatchResult) {
			const agentFileBaseDir =
				dispatchResult.agentFileRoot === "flywheel"
					? this.flywheelRepoRoot
					: cwd;
			if (!agentFileBaseDir) {
				console.warn(
					`[Blueprint] agentFileRoot="${dispatchResult.agentFileRoot}" but ` +
						`flywheelRepoRoot is unset on this Blueprint instance — falling back to cwd. ` +
						`Update the construction site to pass flywheelRepoRoot (FLY-137 v1.27.2).`,
				);
			}
			const agentContent = await readAgentFile(
				agentFileBaseDir ?? cwd,
				dispatchResult.agentConfig.agent_file,
			);
			if (agentContent) {
				const parts: string[] = [
					"## Agent Role",
					agentContent.slice(0, 40_000),
					"",
				];
				if (dispatchResult.agentConfig.domain_file) {
					// FLY-137 v1.27.2: domain_file resolves against the same root as agent_file
					const domainContent = await readAgentFile(
						agentFileBaseDir ?? cwd,
						dispatchResult.agentConfig.domain_file,
					);
					if (domainContent) {
						parts.push(`## Domain Config\n${domainContent.slice(0, 10_000)}`);
						parts.push("");
					}
				}
				agentContext = parts.join("\n");
			} else {
				console.warn(
					`[Blueprint] Agent file not found: ${dispatchResult.agentConfig.agent_file}, using generic prompt`,
				);
			}
		}

		const systemPrompt = agentContext
			? `${agentContext}\n## Baseline Rules\n${baseSystemPrompt}`
			: baseSystemPrompt;

		// ── Adapter execution (GEO-157: IAdapter.execute()) ──
		const timeoutMs = ctx.sessionTimeoutMs ?? 86_400_000; // 24h safety net (FLY-97; idle detection via FLY-92 watchdog)

		// GEO-206: Compute commDbPath for Lead ↔ Runner communication.
		// ctx.projectName is resolved from projects config canonical name in
		// run-issue.ts. claude-lead.sh accepts matching project-name as 3rd arg.
		const commDbPath =
			ctx.leadId && ctx.projectName
				? path.join(
						process.env.HOME ?? "/tmp",
						".flywheel",
						"comm",
						ctx.projectName,
						"comm.db",
					)
				: undefined;

		// FLY-272: derive the HUMAN-READABLE display id for the tmux window name /
		// cmux sidebar from the Linear-resolved identifier — NOT the raw `issueId`
		// the Lead passed to /api/runs/start. Some Leads pass the opaque Linear
		// issue UUID as `issueId` (sub's Lead) while others pass the identifier
		// (joycon's Lead, GeoForge3D). A 36-char UUID is unreadable AND overruns
		// the 50-char window-name budget, truncating the issue title to a
		// meaningless fragment (the "Social"/"Packet" Annie saw). Prefer the
		// runs-route preflight identifier (ctx.issueIdentifier), then the
		// PreHydrator-resolved identifier (which already falls back to node.id).
		// `issueId` below stays the raw value so keys/dedup/CommDB are unchanged;
		// this only affects DISPLAY naming → byte-identical wherever the passed
		// id already equals the identifier.
		//
		// Codex R1 LOW: use `||` + `.trim()`, not `??`, so an empty/whitespace
		// identifier from Linear (`issue.identifier === ""`) also falls through —
		// `??` only catches null/undefined and would leave a blank/leading-hyphen
		// window name. The ultimate fallback is the raw issueId (validated
		// non-empty at the /api/runs/start boundary), so the name is never blank.
		const displayId =
			ctx.issueIdentifier?.trim() ||
			hydrated.issueIdentifier?.trim() ||
			hydrated.issueId;
		let result: AdapterExecutionResult;
		try {
			result = await adapter.execute({
				executionId,
				issueId: hydrated.issueId,
				prompt,
				cwd,
				label: buildWindowLabel(displayId, ctx.runnerName, hydrated.issueTitle),
				permissionMode: "bypassPermissions",
				appendSystemPrompt: systemPrompt,
				// FLY-615: enable ponytail for this run (backend decides how).
				...(enablePonytail && { enablePonytail: true }),
				// FLY-123: model override resolved by RoleAdapterResolver
				// (label / roles config). Claude path previously passed no
				// model — absent stays absent (byte-compat).
				...(ctx.runnerModel !== undefined && { model: ctx.runnerModel }),
				// FLY-671: reasoning-effort override (roles.runner.effort) → adapter
				// `--effort`. Absent stays absent (byte-compat; only claude-tmux uses it).
				...(ctx.runnerEffort !== undefined && { effort: ctx.runnerEffort }),
				// FLY-751: per-runner MCP slim profile → adapter --settings/--no-chrome.
				// Absent/null stays absent (byte-compat spawn).
				...(ctx.runnerMcpProfile && {
					disabledPlugins: ctx.runnerMcpProfile.disabledPlugins,
					disableChrome: ctx.runnerMcpProfile.disableChrome,
				}),
				timeoutMs,
				sessionDisplayName: `${displayId} ${cleanIssueTitle(hydrated.issueTitle)}`,
				sentinelPath: canLand ? landSignalPath : undefined,
				commDbPath,
				waitingTimeoutMs: 176_400_000, // FLY-97 base, raised FLY-159 to 49h: 48h gate timeout + 1h buffer
				leadId: ctx.leadId,
				projectName: ctx.projectName,
				bridgeUrl: resolveBridgeUrl(),
				bridgeIngestToken: process.env.TEAMLEAD_INGEST_TOKEN,
				// FLY-191 Phase 2: pin the Runner's verify-approval to THIS
				// Bridge's StateStore (mirrors the FLY-137 bridgeUrl pattern).
				// Unset/:memory: → no injection; both sides fall back to the
				// ~/.flywheel/teamlead.db default (byte-compat with prod today).
				stateDbPath: resolveStateDbPathForRunner(),
				onHeartbeat: () => {
					this.eventEmitter?.emitHeartbeat(env).catch(() => {});
				},
				// FLY-116: forward callback so dispatcher can spawn Terminal viewer
				// when TmuxAdapter creates the tmux window.
				onTmuxWindowCreated: ctx.onTmuxWindowCreated,
				// FLY-245 R2 HIGH-3: earliest durable launch-claim hook.
				onTmuxWindowOpened: ctx.onTmuxWindowOpened,
				// FLY-245 R5: durable commit record (gates the Runner start).
				launchCommitPath: ctx.launchCommitPath,
				// FLY-142 PR 1.4: forward Agent Team transport identity so
				// TmuxAdapter.tryBuildTransportSpawnConfig() actually fires
				// (was dead code in QA E1 verify because none of these were
				// being passed — wake bug fix never wired up end-to-end).
				// NOTE: `ctx.runnerAgentName` (FLY-142, per-Runner unique)
				// is distinct from `ctx.agentName` (FLY-137 Lead-override
				// dispatcher key). AdapterExecutionContext.agentName is the
				// transport-flag side and matches FLY-142 semantics.
				agentName: ctx.runnerAgentName,
				teamName: ctx.agentTeamName,
				vendor: ctx.vendor,
				leadSessionId: ctx.leadSessionId,
				agentColor: ctx.agentColor,
			});
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			console.error(
				`[Blueprint] Adapter failed for ${hydrated.issueId}: ${errorMsg}`,
			);
			return {
				success: false,
				durationMs: Date.now() - startTime,
				error: errorMsg,
				worktreePath: worktreeInfo?.worktreePath,
			};
		}

		// ── Git result check (existing — THROWS on infra error) ─
		const gitResult = await this.gitChecker.check(cwd, baseSha);

		// ── Evidence collection (v0.2 — conditional) ──────────
		let evidence: ExecutionEvidence | undefined;
		if (this.evidenceCollector) {
			evidence = await this.evidenceCollector.collect(
				cwd,
				baseSha,
				gitResult,
				result.durationMs ?? 0,
				canLand ? landSignalPath : undefined,
			);
		}

		// ── Non-worktree cleanup: remove .flywheel/runs/<executionId>/ ──
		if (!this.worktreeManager) {
			const runDir = path.join(cwd, ".flywheel", "runs", executionId);
			try {
				await fs.promises.rm(runDir, { recursive: true, force: true });
			} catch (err) {
				console.warn(
					`[Blueprint] Failed to clean up ${runDir}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		// ── Decision Layer (v0.2 Step 2b — optional) ──────────
		if (this.decisionLayer && evidence) {
			return this.runWithDecision(
				node,
				ctx,
				hydrated,
				evidence,
				result,
				cwd,
				baseSha,
				worktreeInfo,
				env,
			);
		}

		// ── v0.1.1 fallback: no DecisionLayer ─────────────────
		const success = gitResult.commitCount > 0 && !result.timedOut;

		if (result.tmuxWindow) {
			if (success) {
				await this.killTmuxWindow(result.tmuxWindow);
			}
		}

		return {
			success,
			costUsd: result.costUsd,
			sessionId: result.sessionId,
			tmuxWindow: success ? undefined : result.tmuxWindow,
			durationMs: result.durationMs,
			worktreePath: worktreeInfo?.worktreePath,
			evidence,
			// FLY-123 R1 #4: carry adapter resume params to the event sinks
			sessionParams: result.sessionParams,
		};
	}

	/** GEO-261: Await terminal event delivery (retry handled by emitter). */
	private async emitTerminal(
		env: EventEnvelope,
		result: BlueprintResult,
	): Promise<void> {
		if (!this.eventEmitter) return;
		try {
			if (result.success || result.decision) {
				const summary = this.buildSummary(result);
				await this.eventEmitter.emitCompleted(env, result, summary);
			} else {
				await this.eventEmitter.emitFailed(env, result.error ?? "unknown");
			}
		} catch (err) {
			// postEventReliable never throws, but defensive catch for interface changes
			console.error(
				`[Blueprint] emitTerminal failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	private buildSummary(result: BlueprintResult): string | undefined {
		if (!result.evidence) return undefined;
		const parts: string[] = [];
		if (result.evidence.diffSummary) parts.push(result.evidence.diffSummary);
		if (result.evidence.commitMessages?.length) {
			parts.push(`Commits: ${result.evidence.commitMessages.join("; ")}`);
		}
		return parts.join(" | ") || undefined;
	}

	private async runWithDecision(
		_node: DagNode,
		ctx: BlueprintContext,
		hydrated: {
			issueId: string;
			issueTitle: string;
			labels: string[];
			projectId: string;
			issueIdentifier: string;
		},
		evidence: ExecutionEvidence,
		result: AdapterExecutionResult,
		cwd: string,
		baseSha: string,
		worktreeInfo: WorktreeInfo | undefined,
		env: EventEnvelope,
	): Promise<BlueprintResult> {
		// Build ExecutionContext
		const execCtx: ExecutionContext = {
			executionId: env.executionId,
			issueId: hydrated.issueId,
			issueIdentifier: hydrated.issueIdentifier,
			issueTitle: hydrated.issueTitle,
			labels: hydrated.labels,
			projectId: hydrated.projectId,
			exitReason: result.timedOut
				? "timeout"
				: !result.success
					? "error"
					: "completed",
			baseSha,
			commitCount: evidence.commitCount,
			commitMessages: evidence.commitMessages,
			changedFilePaths: evidence.changedFilePaths,
			filesChangedCount: evidence.filesChangedCount,
			linesAdded: evidence.linesAdded,
			linesRemoved: evidence.linesRemoved,
			diffSummary: evidence.diffSummary,
			headSha: evidence.headSha,
			durationMs: evidence.durationMs,
			consecutiveFailures: ctx.consecutiveFailures ?? 0,
			partial: evidence.partial,
			landingStatus: evidence.landingStatus,
			// FLY-493: forward the no-transport marker so the DecisionLayer routes
			// a no-transport ready_to_merge build to `pr_handoff` (terminal),
			// NOT the wake-dependent needs_review.
			...(ctx.runnerTransportMode && {
				runnerTransportMode: ctx.runnerTransportMode,
			}),
		};

		let decision: DecisionResult;
		try {
			decision = await this.decisionLayer!.decide(execCtx, cwd);
		} catch (err) {
			// DecisionLayer failure → conservative needs_review
			decision = {
				route: "needs_review",
				confidence: 0,
				reasoning: `Decision layer error: ${err instanceof Error ? err.message : String(err)}`,
				concerns: ["Decision layer failed"],
				decisionSource: "decision_error_fallback",
			};
		}

		// Route → success mapping. FLY-493: pr_handoff is a successful terminal
		// build+PR completion (the no-transport Runner did its job; the founder
		// ships the PR), so it counts as success — never a retry/failure.
		const success =
			decision.route === "auto_approve" ||
			decision.route === "needs_review" ||
			decision.route === "pr_handoff";

		// Window lifecycle based on decision
		if (result.tmuxWindow) {
			if (decision.route === "auto_approve") {
				await this.killTmuxWindow(result.tmuxWindow);
			}
			// needs_review / blocked → preserve window for inspection
		}

		return {
			success,
			costUsd: result.costUsd,
			sessionId: result.sessionId,
			tmuxWindow:
				decision.route === "auto_approve" ? undefined : result.tmuxWindow,
			durationMs: result.durationMs,
			worktreePath: worktreeInfo?.worktreePath,
			evidence,
			decision,
			labels: hydrated.labels,
			projectId: hydrated.projectId,
			exitReason: execCtx.exitReason,
			consecutiveFailures: execCtx.consecutiveFailures,
			// FLY-123 R1 #4: carry adapter resume params to the event sinks
			sessionParams: result.sessionParams,
		};
	}

	private async killTmuxWindow(tmuxWindow: string): Promise<void> {
		try {
			await this.shell.execFile("tmux", ["kill-window", "-t", tmuxWindow], "/");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(
				`[Blueprint] Failed to kill tmux window ${tmuxWindow}: ${msg}`,
			);
		}
	}
}

/**
 * Safely read an agent/domain file relative to the repo root.
 * Returns null if file doesn't exist or path escapes the repo.
 */
async function readAgentFile(
	repoRoot: string,
	relativePath: string,
): Promise<string | null> {
	// Path safety: reject absolute or parent-escaping paths
	if (path.isAbsolute(relativePath) || relativePath.startsWith("..")) {
		console.warn(`[Blueprint] Unsafe agent path rejected: ${relativePath}`);
		return null;
	}

	const resolved = path.resolve(repoRoot, relativePath);

	// Containment check (resolve-based, no realpath dependency)
	const normalizedRoot = path.resolve(repoRoot);
	if (
		!resolved.startsWith(normalizedRoot + path.sep) &&
		resolved !== normalizedRoot
	) {
		console.warn(`[Blueprint] Agent path escapes repo: ${relativePath}`);
		return null;
	}

	try {
		// Symlink containment: verify real path before reading content
		const realResolved = await fs.promises.realpath(resolved);
		const realRoot = await fs.promises.realpath(repoRoot);
		if (!realResolved.startsWith(realRoot + path.sep)) {
			console.warn(
				`[Blueprint] Agent file symlinks outside repo: ${relativePath}`,
			);
			return null;
		}

		const content = await fs.promises.readFile(realResolved, "utf-8");
		return content || null; // empty file → null
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw err;
	}
}

const RUNS_EXCLUDE_ENTRY = ".flywheel/runs/";

/**
 * Ensure .flywheel/runs/ is in git info/exclude.
 * Must run BEFORE assertCleanTree() to prevent land-status.json from
 * making the tree appear dirty.
 */
async function ensureFlywheelRunsExclude(cwd: string): Promise<void> {
	let excludeFile: string;
	try {
		excludeFile = await new Promise<string>((resolve, reject) => {
			execFile(
				"git",
				["-C", cwd, "rev-parse", "--git-path", "info/exclude"],
				(err, stdout) =>
					err ? reject(err) : resolve(path.resolve(cwd, stdout.trim())),
			);
		});
	} catch (err) {
		console.warn(
			`[Blueprint] ensureFlywheelRunsExclude skipped: ${err instanceof Error ? err.message : String(err)}`,
		);
		return;
	}

	const infoDir = path.dirname(excludeFile);
	await fs.promises.mkdir(infoDir, { recursive: true });

	let content = "";
	try {
		content = await fs.promises.readFile(excludeFile, "utf-8");
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn(
				`[Blueprint] Failed to read ${excludeFile}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	if (!content.includes(RUNS_EXCLUDE_ENTRY)) {
		const suffix = content.endsWith("\n") || content === "" ? "" : "\n";
		await fs.promises.writeFile(
			excludeFile,
			`${content}${suffix}${RUNS_EXCLUDE_ENTRY}\n`,
		);
	}
}
