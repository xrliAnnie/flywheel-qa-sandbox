/**
 * GEO-267: /api/runs routes — start new Runner executions.
 *
 * POST /api/runs/start — start a Runner for an issue
 * GET  /api/runs/active — query active run counts
 *
 * FLY-127 R3 Layer 2: Server-side department scope enforcement. When a Lead
 * calls `/api/runs/start` for an issue outside its department, Bridge rejects
 * with a machine-readable diagnostic code (`DEPT_SCOPE_REJECT` + `reason`)
 * that the Lead translates into one short Chinese diagnostic line per its
 * Action Gate rule. Gated by `BRIDGE_DEPT_SCOPE_REJECT` env var (default on).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Router } from "express";
import type {
	PhaseDispatchVendor,
	PonytailInput,
	RoleEffort,
} from "flywheel-config";
import {
	ACCEPTED_DISPATCH_MODELS,
	ConfigLoader,
	normalizeDispatchModel,
	resolveEffectiveFounderUxConfig,
} from "flywheel-config";
import {
	DOC_TIERS,
	type DocTier,
	parseDocTier,
} from "flywheel-edge-worker/dist/Blueprint.js";
import { DepartmentRegistry } from "../department-registry.js";
import {
	type ProjectEntry,
	resolveCanonicalProjectName,
	resolveLeadForIssue,
} from "../ProjectConfig.js";
import type { Session, StateStore } from "../StateStore.js";
import { validateAndRegisterChatThread } from "./chat-thread-register.js";
import {
	isQaIssueTitle,
	resolveFounderFacingUx,
} from "./founder-ux/trigger.js";
import type { IStartDispatcher } from "./retry-dispatcher.js";
import type { RunnerAdmissionController } from "./runner-admission.js";
import { waitForSession } from "./session-wait.js";
import { loadPipelineConfigByProject } from "./three-stage-config-source.js";
import { resolveThreeStageEntry } from "./three-stage-policy.js";

/** Poll interval / max wait for chat thread_id to appear on session (FLY-91). */
const THREAD_POLL_INTERVAL_MS = 500;
const THREAD_POLL_MAX_MS = 5000;

/**
 * FLY-123 QA Finding 3: ghost-start guard deadline. Reuses FLY-205's
 * `waitForSession` helper (used for the metadata patch above) with a more
 * generous ceiling — the row is created by Blueprint.emitStarted() which
 * races dispatcher.start()'s immediate return, and a slow Codex spawn blocks
 * the event loop AFTER the row exists, so a live runner registers well within
 * this window while a genuine ghost (threw before emitStarted) correctly
 * times out. 30s headroom over the codex spawn latency QA measured (~3.4s).
 */
const GHOST_GUARD_SESSION_WAIT_MS = 30_000;

/**
 * FLY-127: Read the dept-scope reject feature flag.
 *
 * Default: enforcement ON. Set `BRIDGE_DEPT_SCOPE_REJECT=off` (or `false` /
 * `0`) to disable.
 *
 * **Toggling requires a Bridge restart.** Although the value is re-read from
 * `process.env` on every request, a running Node process does not pick up
 * external env-var mutations — `process.env` is a snapshot of the parent
 * shell at fork time. Re-reading per request guards against (hypothetical)
 * intra-process env mutation but does not enable no-restart rollback.
 *
 * For runtime no-restart toggle we'd need an admin endpoint or config-watch
 * mechanism. That is out of scope for FLY-127; tracked as a follow-up.
 */
function isDeptScopeRejectEnabled(): boolean {
	const v = process.env.BRIDGE_DEPT_SCOPE_REJECT;
	if (v === undefined) return true;
	const lower = v.toLowerCase();
	return lower !== "off" && lower !== "false" && lower !== "0";
}

/**
 * FLY-869: load a project's `founder_ux_gate.exempt_labels` from its
 * CANONICAL `.flywheel/config.yaml` root — mirrors
 * `loadPipelineConfigByProject` (SECURITY: reads the mainline checkout, NEVER
 * an implementation PR's worktree, so a runner cannot self-exempt its own
 * issue). Resolved through `resolveEffectiveFounderUxConfig` so an absent
 * project / absent config file / absent `founder_ux_gate` block / malformed
 * config all collapse to the resolver's default exempt list
 * (`["brainstorm-exempt"]`) rather than an empty "nothing is exempt" set —
 * the gate itself still defaults to enforce regardless of this list.
 */
export async function loadFounderUxExemptLabels(
	project: ProjectEntry | undefined,
	readFile: (p: string) => string = (p) => readFileSync(p, "utf-8"),
): Promise<readonly string[]> {
	if (!project) return resolveEffectiveFounderUxConfig().exempt_labels;
	const configPath = join(project.projectRoot, ".flywheel", "config.yaml");
	try {
		const loader = new ConfigLoader(async (p) => readFile(p));
		const cfg = await loader.load(configPath);
		return resolveEffectiveFounderUxConfig(cfg?.founder_ux_gate).exempt_labels;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			console.warn(
				`[founder-ux] config load failed for ${project.projectName}: ${
					(err as Error).message
				} — using default exempt labels`,
			);
		}
		return resolveEffectiveFounderUxConfig().exempt_labels;
	}
}

export function createRunsRouter(
	startDispatcher: IStartDispatcher,
	store: StateStore,
	projects: ProjectEntry[],
	runnerAdmission: RunnerAdmissionController,
	_discordGuildId?: string, // FLY-163: unused after forumLink removal; kept for callsite stability
	chatThreadsEnabled?: boolean,
	// FLY-742: when a run-start is declined by an existing active session, this
	// guard decides whether to auto-finalize a stale done-but-parked blocker
	// (freeing the slot so THIS run proceeds) or durably alert the Lead. Absent →
	// unchanged 409 behavior (byte-compat).
	staleBlockerGuard?: {
		handleActiveBlocker(blocker: Session): Promise<{ proceed: boolean }>;
	},
): Router {
	const router = Router();
	// FLY-127: registry is constructed once per router and re-read on each
	// request through the same `projects` reference. Bridge restart picks up
	// new project config; runtime toggles use the env-var flag instead.
	const departmentRegistry = new DepartmentRegistry(projects);

	router.post("/start", async (req, res) => {
		// GEO-267: LINEAR_API_KEY is required for issue hydration (PreHydrator).
		// Without it, Runner gets stub metadata → degraded agent routing.
		if (!process.env.LINEAR_API_KEY) {
			res.status(503).json({
				success: false,
				message:
					"LINEAR_API_KEY not configured — cannot hydrate issue data for Runner",
			});
			return;
		}

		const { issueId, sessionRole } = req.body;
		const rawProjectName = req.body.projectName;

		// Input validation
		if (!issueId || typeof issueId !== "string") {
			res.status(400).json({
				success: false,
				message: "issueId is required",
			});
			return;
		}
		if (!rawProjectName || typeof rawProjectName !== "string") {
			res.status(400).json({
				success: false,
				message: "projectName is required",
			});
			return;
		}

		// FLY-534: projectName is case-insensitive. Callers (Leads, humans, cron)
		// may send "Sub"/"SUB" while config + cron canonicalize on "sub". Every
		// downstream lookup here is case-SENSITIVE (dispatcher blueprintsByProject
		// .get, dept-scope / lead-scope `=== projectName`, comm.db path, tmux
		// session, BlueprintContext), so a case mismatch yields `No runtime for
		// project` / DEPT_SCOPE_REJECT project_unknown. Canonicalize ONCE here, at
		// the boundary, so the configured exact name flows to all of them — no
		// downstream code reads `req.body.projectName` directly. Unknown projects
		// pass through unchanged and still reject normally below.
		const projectName = resolveCanonicalProjectName(projects, rawProjectName);

		const rawLeadId = req.body.leadId;
		if (
			rawLeadId !== undefined &&
			rawLeadId !== null &&
			typeof rawLeadId !== "string"
		) {
			res.status(400).json({
				success: false,
				code: "INVALID_LEAD_ID",
				reason: "wrong_type",
				silent: false,
			});
			return;
		}
		let leadId = typeof rawLeadId === "string" ? rawLeadId : undefined;
		const hasLeadIdentity =
			typeof leadId === "string" && leadId.trim().length > 0;
		const deptScopeRejectEnabled = isDeptScopeRejectEnabled();

		// FLY-137 v1.27.2: optional Lead override `agentName` body field.
		// Semantics per Codex v1.27.0 Round 1 #2:
		//   - undefined / null / missing → normal dispatch (no override)
		//   - "" (empty string)          → reject with INVALID_AGENT_NAME
		//   - non-empty string           → validate; reject if unknown; else override
		// Final validation against the project's actual agents map happens via
		// `AgentDispatcher.dispatchByName(...)` inside Blueprint at dispatch time;
		// here we only sanity-check shape and reject empty strings.
		const rawAgentName = req.body.agentName;
		let agentName: string | undefined;
		if (rawAgentName === undefined || rawAgentName === null) {
			agentName = undefined;
		} else if (typeof rawAgentName !== "string") {
			res.status(400).json({
				success: false,
				code: "INVALID_AGENT_NAME",
				reason: "wrong_type",
				silent: false,
			});
			return;
		} else if (rawAgentName.length === 0) {
			res.status(400).json({
				success: false,
				code: "INVALID_AGENT_NAME",
				reason: "empty_string",
				silent: false,
			});
			return;
		} else {
			agentName = rawAgentName;
		}

		// FLY-205: optional Lead-judged doc tier body field.
		// Semantics:
		//   - undefined / null / missing → effective tier "full" (fail-safe:
		//     no Lead signal → full docs, never silently fewer)
		//   - one of DOC_TIERS → that tier
		//   - anything else → 400 INVALID_DOC_TIER (machine-only payload,
		//     FLY-127 shape; validated synchronously at the boundary like
		//     agentName — never let a bad enum reach Blueprint)
		const rawDocTier = req.body.docTier;
		let docTier: DocTier | undefined;
		if (rawDocTier === undefined || rawDocTier === null) {
			docTier = undefined;
		} else {
			const parsedTier = parseDocTier(rawDocTier);
			if (!parsedTier) {
				res.status(400).json({
					success: false,
					code: "INVALID_DOC_TIER",
					reason: "unknown_tier",
					allowed: [...DOC_TIERS],
					silent: false,
				});
				return;
			}
			docTier = parsedTier;
		}

		// FLY-728 Part C: optional per-run `model` param — the difficulty-sorter's
		// output (the Lead judges difficulty at dispatch and passes a tier model).
		// Semantics mirror docTier:
		//   - undefined / null / missing → no dispatch override (label/project/account)
		//   - a known tier id or bare alias → normalized to canonical id
		//   - anything else → 400 INVALID_MODEL (machine-only payload, FLY-127 shape).
		// A typo must fail loud at the boundary — never silently spawn the wrong (or
		// account-default) model. FLY-709 makes the accepted set configurable.
		const rawModel = req.body.model;
		let dispatchModel: string | undefined;
		if (rawModel === undefined || rawModel === null) {
			dispatchModel = undefined;
		} else if (typeof rawModel !== "string") {
			res.status(400).json({
				success: false,
				code: "INVALID_MODEL",
				reason: "wrong_type",
				silent: false,
			});
			return;
		} else {
			const normalized = normalizeDispatchModel(rawModel);
			if (!normalized) {
				res.status(400).json({
					success: false,
					code: "INVALID_MODEL",
					reason: "unknown_model",
					// FLY-751: the FULL accepted set (tier ids + aliases + explicit
					// 1M opt-ins like opus-1m) so a Lead can discover the spellings
					// from the error instead of tribal knowledge.
					allowed: [...ACCEPTED_DISPATCH_MODELS],
					silent: false,
				});
				return;
			}
			dispatchModel = normalized;
		}

		// FLY-59: Per-role dedup — same issue can have main + qa concurrently.
		// FLY-793: `let` because a three-stage entry may reroute a fresh `main`
		// dispatch to the Design phase below (after labels are resolved). The dedup
		// here keys on the request role; a fresh three-stage issue has no active
		// session, and a concurrent re-dispatch of an in-flight phase is backstopped
		// by the worktree single-writer (git cannot check out shared branch B twice).
		let role =
			(typeof sessionRole === "string" ? sessionRole : undefined) ?? "main";
		const activeSessions = store.getActiveSessions();
		const alreadyActive = activeSessions.find(
			(s) =>
				s.issue_id === issueId &&
				(s.session_role ?? "main") === role &&
				// FLY-742: include approved_to_ship — getActiveSessions() already
				// treats it as active, so a lingering approved_to_ship session must
				// also route through the stale-blocker guard (align the one-active-
				// session rule with getActiveSessions()).
				["running", "awaiting_review", "approved_to_ship"].includes(s.status),
		);
		if (alreadyActive) {
			// FLY-742: a done-but-parked blocker (finished, PR merged/closed, never
			// emitted `completed`) would silently block this scheduled/cron run
			// forever. The guard either auto-finalizes such a blocker (freeing the
			// slot so this run proceeds — same-tick self-heal) or durably alerts the
			// Lead. Absent guard → unchanged 409 (byte-compat).
			const guarded = staleBlockerGuard
				? await staleBlockerGuard.handleActiveBlocker(alreadyActive)
				: { proceed: false };
			if (!guarded.proceed) {
				res.status(409).json({
					success: false,
					// FLY-229: hint re-engagement. Conditional language — Bridge FSM
					// status alone doesn't prove tmux liveness, so point at
					// runner_terminal_list to confirm parked-alive before re-engaging.
					message: `Issue ${issueId} already has an active session for role "${role}" (${alreadyActive.execution_id}, status: ${alreadyActive.status}). If that session is parked and still alive (idle), re-engage it via 'flywheel-comm send' / SendMessage instead of starting a new run — check runner_terminal_list (class=parked-alive).`,
				});
				return;
			}
			// guard finalized the stale blocker → slot freed → fall through to start.
		}

		// FLY-123 WS-D (P4): resource-based admission — no count cap. Defer only
		// under real load/memory pressure, with a typed reason (never a string-
		// matched "Max concurrent" message).
		const admission = runnerAdmission.tryAdmit();
		if (!admission.admit) {
			const runningInStore = activeSessions.filter(
				(s) => s.status === "running",
			).length;
			res.status(429).json({
				success: false,
				reason: admission.reason,
				message: `Runner admission deferred (${admission.reason}): ${admission.detail}. Running: ${runningInStore}, inflight: ${startDispatcher.getInflightCount()}`,
			});
			return;
		}

		// Lead scope validation — project membership check
		if (hasLeadIdentity) {
			const project = projects.find((p) => p.projectName === projectName);
			if (project) {
				const leadExists = project.leads.some((l) => l.agentId === leadId);
				if (!leadExists) {
					res.status(403).json({
						success: false,
						message: `Lead "${leadId}" is not configured for project "${projectName}"`,
					});
					return;
				}
			}
		}

		// Pre-flight: verify issue exists in Linear before dispatching.
		// Also captures title/identifier for session metadata patching (FLY-24 Bug 1)
		// and the issue URL for DOC-FLOW header continuity (FLY-205).
		let issueTitle: string | undefined;
		let issueIdentifier: string | undefined;
		let issueUrl: string | undefined;
		// FLY-127: labels are needed by both the FLY-80 auto-resolve path AND the
		// new department-scope check. Fetch once, reuse for both.
		let issueLabelNames: string[] = [];
		// FLY-598 (Codex R1 MEDIUM): track whether the label fetch FAILED (distinct
		// from "fetched, but empty"). A failed read must NOT silently downgrade the
		// founder-facing-ux primary trigger to "not founder-facing" (fail-open).
		let issueLabelsFetchFailed = false;
		try {
			const { LinearClient } = await import("@linear/sdk");
			const client = new LinearClient({
				apiKey: process.env.LINEAR_API_KEY!,
			});
			const issue = await client.issue(issueId);
			if (!issue) {
				res.status(404).json({
					success: false,
					message: `Issue ${issueId} not found in Linear`,
				});
				return;
			}
			issueTitle = issue.title;
			issueIdentifier = issue.identifier;
			issueUrl = issue.url;

			// FLY-127: fetch labels regardless of whether leadId is provided.
			// Auto-resolve (FLY-80) and dept-scope check (FLY-127) both need them.
			try {
				const labels = await issue.labels();
				issueLabelNames = labels.nodes.map((l: { name: string }) => l.name);
			} catch (labelErr) {
				console.warn(
					`[runs/start] Could not fetch labels for ${issueIdentifier}:`,
					(labelErr as Error).message,
				);
				// Leave issueLabelNames empty — dept-scope check will treat as
				// `issue_no_department_label` and reject (when enforcement is on).
				// FLY-598 (Codex R1 MEDIUM): record the failure so the founder-ux
				// snapshot fail-closes rather than treating an unreadable label set
				// as "not founder-facing".
				issueLabelsFetchFailed = true;
			}

			if (deptScopeRejectEnabled && !hasLeadIdentity) {
				res.status(403).json({
					success: false,
					code: "DEPT_SCOPE_REJECT",
					reason: "lead_identity_required",
					canonicalLeadId: null,
					silent: false,
				});
				return;
			}

			// FLY-80 rollback: when department-scope enforcement is explicitly off,
			// preserve legacy owner auto-resolution for identity-less callers.
			if (!hasLeadIdentity) {
				try {
					const { lead } = resolveLeadForIssue(
						projects,
						projectName,
						issueLabelNames,
					);
					leadId = lead.agentId;
					console.log(
						`[runs/start] Auto-resolved leadId to "${leadId}" for ${issueIdentifier}`,
					);
				} catch (resolveErr) {
					console.warn(
						`[runs/start] Could not auto-resolve leadId:`,
						(resolveErr as Error).message,
					);
				}
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(
				`[runs/start] Linear pre-flight failed for ${issueId}:`,
				msg,
			);
			res.status(502).json({
				success: false,
				message: `Cannot verify issue ${issueId} in Linear: ${msg}`,
			});
			return;
		}

		// FLY-127 R3 Layer 2: Server-side department scope check.
		//
		// Runs only when the feature flag is on
		// (BRIDGE_DEPT_SCOPE_REJECT != off). The post-preflight guard above proves
		// `leadId` is a nonblank caller identity whenever enforcement is enabled.
		//
		// On reject, returns a machine-readable diagnostic that Lead daemons
		// translate into one short Chinese line per their Action Gate rule.
		// `silent: false` because Bridge is only called on explicit-intent paths
		// (Layer 1b filters passive cross-dept noise before any API call).
		if (deptScopeRejectEnabled && leadId) {
			const decision = departmentRegistry.isLeadInScope(
				projectName,
				leadId,
				issueLabelNames,
			);
			if (!decision.allowed) {
				// Log the english `decision.message` for operator debugging — the
				// HTTP response intentionally carries machine-readable fields only
				// (no free-form prose for the Lead to echo or paraphrase).
				console.log(
					`[runs/start] FLY-127 dept-scope reject: project="${projectName}" ` +
						`lead="${leadId}" issue="${issueIdentifier}" ` +
						`reason=${decision.reason} ` +
						`canonicalLeadId="${decision.canonicalLeadId ?? "null"}" ` +
						`detail="${decision.message}"`,
				);
				// Codex R1: response shape is machine-only — `code` / `reason` /
				// `canonicalLeadId` / `silent`. The Lead translates `reason` into
				// the canonical Chinese diagnostic per its Action Gate rule. No
				// `message` field — preventing Leads from echoing arbitrary
				// english prose into Discord. `canonicalLeadId` always present
				// (string-or-null) for stable response shape across all reject
				// codes; null when the issue has no / multiple labels.
				res.status(403).json({
					success: false,
					code: "DEPT_SCOPE_REJECT",
					reason: decision.reason,
					canonicalLeadId: decision.canonicalLeadId ?? null,
					silent: false,
				});
				return;
			}
		}

		// FLY-91 Round 2: Pre-register chat thread if Lead already created one.
		// Must happen AFTER leadId resolution, BEFORE dispatch (so ensureChatThread() skips).
		if (chatThreadsEnabled) {
			const chatThreadId = req.body.chatThreadId as string | undefined;
			const chatChannelId = req.body.chatChannelId as string | undefined;

			// Pair validation: both or neither
			if (
				(chatThreadId && !chatChannelId) ||
				(!chatThreadId && chatChannelId)
			) {
				res.status(400).json({
					success: false,
					message:
						"chatThreadId and chatChannelId must both be provided or both omitted",
				});
				return;
			}

			if (chatThreadId && chatChannelId) {
				if (!leadId) {
					res.status(400).json({
						success: false,
						message: "leadId is required when chatThreadId is provided",
					});
					return;
				}
				const regResult = await validateAndRegisterChatThread(
					{
						threadId: chatThreadId,
						channelId: chatChannelId,
						issueId,
						leadId,
						projectName,
					},
					store,
					projects,
				);
				if (!regResult.ok) {
					res.status(regResult.status).json({
						success: false,
						message: regResult.error,
					});
					return;
				}
			}
		}

		// FLY-137 v1.27.2: normalize labels ONCE at the Bridge boundary + resolve
		// owningDept via DepartmentRegistry. Downstream consumers (StartRequest →
		// BlueprintContext → AgentDispatcher) receive lowercased labels; dispatcher
		// no longer re-lowercases per call.
		const normalizedIssueLabels = issueLabelNames.map((l) => l.toLowerCase());
		const owningDept = departmentRegistry.getDepartmentForIssue(
			projectName,
			normalizedIssueLabels,
		);

		// FLY-793 (Step 4 ENTRY): a FRESH `main` dispatch on a three-stage-enabled
		// project STARTS at the Design phase — this is the entry the PhaseOrchestrator
		// (handoff-only) does not cover. The policy is resolved SERVER-SIDE from the
		// project's CANONICAL config (+ the issue's Linear labels + the env
		// kill-switch), NEVER the request body, so `shareParentBranch` stays
		// Bridge-internal and a runner cannot self-elevate its own run. Only the fresh
		// `main` entry is rerouted; an explicit phase role (a PhaseOrchestrator handoff
		// calls startDispatcher.start directly, not this HTTP route) and auto-QA
		// (`qa`) pass through. Absent config / OFF / `no-three-stage` label /
		// `FLYWHEEL_THREE_STAGE=0` → stays `main` (byte-compatible).
		let shareParentBranch: boolean | undefined;
		// FLY-887 R2: set with shareParentBranch at entry — phase sessions bypass
		// the runner-label backend/model layer (see the entry branch below).
		let ignoreRunnerLabelSelection: boolean | undefined;
		// FLY-1224: the phase table's vendor + effort for a three-stage entry
		// (design). NEVER read from the request body — the entry decision is the
		// only writer, so the phase table stays the single vendor source.
		let dispatchVendor: PhaseDispatchVendor | undefined;
		let dispatchEffort: RoleEffort | undefined;
		if (role === "main") {
			const proj = projects.find((p) => p.projectName === projectName);
			const pipelineConfig = proj
				? (await loadPipelineConfigByProject([proj])).get(projectName)
				: undefined;
			// FLY-887 R2: resolve the dispatching Lead's chatChannel SERVER-SIDE
			// (leadId → project.leads[].chatChannel — never the request body) for
			// the `three_stage_channels` gate. leadId is trusted here: the
			// membership check (:337-349) rejected a leadId not in project.leads,
			// and the auto-resolve (:400-419) filled it server-side when absent —
			// both ran before this entry decision. A dispatch-forged leadId can
			// only select an ALREADY-CONFIGURED lead's channel, so the gate's
			// risk surface is unchanged (three-stage is a workflow shape, not a
			// privilege).
			const dispatchChannelId = leadId
				? proj?.leads.find((l) => l.agentId === leadId)?.chatChannel
				: undefined;
			const entry = resolveThreeStageEntry({
				requestRole: role,
				pipelineConfig,
				issueLabels: normalizedIssueLabels,
				env: process.env,
				dispatchChannelId,
			});
			if (entry.enteredThreeStage) {
				// FLY-793 (Codex R1 BLOCKING): the per-role dedup above keyed on the
				// request role `main` and CANNOT see an already-active Design/Implement/
				// QA phase for this issue (those rows have a phase `session_role`). A
				// second fresh dispatch here would start another phase AND — via
				// Blueprint.removeIfExists on the SHARED branch-B worktree key — tear
				// away the running phase's worktree instead of failing closed. Reject if
				// any phase is in flight (incl. the design_done handoff window). The
				// single active phase IS the pipeline's own progress.
				const activePhase = store.getActivePhaseSessionForIssue(issueId);
				if (activePhase) {
					res.status(409).json({
						success: false,
						message: `Issue ${issueId} already has an active three-stage ${activePhase.session_role} phase (${activePhase.execution_id}, status: ${activePhase.status}). The pipeline advances Design→Implement→QA on one shared branch — do not start a second run; let the active phase hand off, or terminate it first.`,
					});
					return;
				}
				role = entry.role; // "design"
				shareParentBranch = true;
				// FLY-887 R2: the phase table OWNS the phase model — apply the entry's
				// model UNCONDITIONALLY. A difficulty-sorter pin (e.g. a light-sorted
				// issue pinned to Sonnet) must NOT leak onto a phase session; an issue
				// that genuinely needs a special model opts out of three-stage via the
				// `no-three-stage` label and runs single-session (recorded trade-off,
				// Lead-approved).
				dispatchModel = entry.dispatchModel;
				// FLY-1224: forward the phase table's vendor + effort alongside the
				// model so the resolver's dispatch layer picks the phase backend.
				dispatchVendor = entry.dispatchVendor;
				dispatchEffort = entry.dispatchEffort;
				// FLY-887 R2 (Codex R1 blocker): the Linear label layer outranks
				// dispatchModel in resolveRoleAdapter — a `sonnet` model label or a
				// `codex`/`agy`/`kimi` vendor label would beat the phase table (and a
				// no-transport vendor backend can never receive park/wake mailboxes).
				// Bypass the label layer for phase dispatch (FLY-643 seam, same as
				// auto-QA); issueLabels still flow into BlueprintContext for
				// Lead/thread routing.
				ignoreRunnerLabelSelection = true;
			}
		}

		// FLY-137 Phase 5: snapshot codex-skip label at run start (no mid-run
		// Linear refresh). Semantics: "label the issue before triggering;
		// if you forgot, cancel + retry." Bridge persists this on the session
		// row so event-route's stage_changed handler can check it without
		// touching Linear at transition time.
		const codexSkip = normalizedIssueLabels.includes("codex-skip");

		// FLY-598 / FLY-869: snapshot the founder-facing-ux flag at run start
		// (same "label-before-trigger" semantics as codex-skip). FLY-869 flips
		// this default-ON: every issue is in scope UNLESS it carries one of the
		// project's configured exempt labels (default `["brainstorm-exempt"]`,
		// resolved from `.flywheel/config.yaml`'s `founder_ux_gate.exempt_labels`
		// via `resolveEffectiveFounderUxConfig`). A Runner can also self-declare
		// later via `declare-founder-ux`. The flag is inert unless
		// founder_ux_gate.mode resolves to something other than "off".
		//
		// FLY-598 (Codex R1 MEDIUM): fail-closed on a label-read failure. If we
		// could not read the issue's labels we cannot prove it is exempt, so
		// treat it AS in scope (the trigger must never fail-open on a Linear
		// outage). This only has teeth when the gate is enabled (mode != off).
		const founderUxProject = projects.find(
			(p) => p.projectName === projectName,
		);
		const founderUxExemptLabels =
			await loadFounderUxExemptLabels(founderUxProject);
		const founderFacingUx = resolveFounderFacingUx(
			normalizedIssueLabels,
			issueLabelsFetchFailed,
			founderUxExemptLabels,
			// FLY-869 (Lead 2ee06754): a `QA · <ident>` verification issue is auto-exempt
			// from the brainstorm gate — no manual label. (QA·867 / FLY-873 was the case.)
			isQaIssueTitle(issueTitle),
		);

		// FLY-137 v1.27.2 (Codex Track A #2): validate `agentName` SYNCHRONOUSLY
		// before kicking off any async work. Without this, InvalidAgentNameError
		// thrown deep inside Blueprint.run() gets swallowed by the .catch() chain
		// in RunDispatcher.start() and never surfaces as a 400 response.
		if (agentName !== undefined) {
			const validation = startDispatcher.validateAgentName(
				projectName,
				agentName,
			);
			if (!validation.ok) {
				if (validation.reason === "project_unknown") {
					res.status(404).json({
						success: false,
						message: `Project "${projectName}" is not registered with the Bridge runtime`,
					});
					return;
				}
				// unknown_agent → FLY-127-shape machine-only payload
				console.log(
					`[runs/start] FLY-137 INVALID_AGENT_NAME: project="${projectName}" provided="${agentName}" available=${JSON.stringify(validation.available)}`,
				);
				res.status(400).json({
					success: false,
					code: "INVALID_AGENT_NAME",
					reason: "unknown_agent",
					available: validation.available,
					silent: false,
				});
				return;
			}
		}

		try {
			// FLY-24: Pass pre-fetched title/identifier so Blueprint's EventEnvelope
			// uses real metadata (PreHydrator may fail Linear API and fall back to stub title).
			// FLY-615: per-run ponytail override (highest ladder layer). Build a
			// non-collapsed start_signal (run-param + labels + read status) so
			// Blueprint resolves it against project config. Invalid values are
			// ignored (treated as no override → label/project layers decide).
			const rawPonytail = (req.body as { ponytail?: unknown }).ponytail;
			const ponytailRunOverride =
				rawPonytail === "on" || rawPonytail === "off"
					? (rawPonytail as "on" | "off")
					: undefined;
			const ponytailInput: PonytailInput = {
				kind: "start_signal",
				signal: {
					...(ponytailRunOverride && { runOverride: ponytailRunOverride }),
					labels: normalizedIssueLabels,
					labelStatus: issueLabelsFetchFailed ? "unreadable" : "readable",
				},
			};

			const result = await startDispatcher.start({
				issueId,
				projectName,
				leadId,
				issueTitle,
				issueIdentifier,
				sessionRole: role,
				// FLY-793 (Step 4 ENTRY): Bridge-INTERNAL, set ONLY by the server-side
				// three-stage entry above (never from the request body). Undefined for
				// every non-three-stage dispatch → byte-compatible.
				shareParentBranch,
				// FLY-887 R2: phase dispatch bypasses the runner-label backend/model
				// layer (set with shareParentBranch above; undefined otherwise →
				// byte-compatible).
				ignoreRunnerLabelSelection,
				// FLY-137 v1.27.2: dept-aware dispatch context
				agentName,
				issueLabels: normalizedIssueLabels,
				owningDept,
				// FLY-615: per-run + per-issue ponytail signal (resolved in Blueprint)
				ponytailInput,
				// FLY-137 Phase 5: Codex auto-trigger snapshot
				codexSkip,
				// FLY-205: doc-flow tier + issue URL (header continuity)
				docTier,
				issueUrl,
				// FLY-728 Part C: difficulty-sorter's dispatch model (normalized)
				dispatchModel,
				// FLY-1224: phase table vendor + effort (three-stage entry only;
				// undefined on every non-three-stage dispatch → byte-compatible)
				dispatchVendor,
				dispatchEffort,
			});

			// FLY-91: Poll for chatThreadId. emitStarted() awaits chat thread
			// creation, but we poll defensively in case of race or transient
			// failure.
			let chatThreadId: string | undefined;
			const chatChannel = (() => {
				if (!chatThreadsEnabled || !leadId) return undefined;
				const proj = projects.find((p) => p.projectName === projectName);
				return proj?.leads.find((l) => l.agentId === leadId)?.chatChannel;
			})();

			if (chatChannel) {
				const deadline = Date.now() + THREAD_POLL_MAX_MS;
				while (Date.now() < deadline) {
					await new Promise((r) => setTimeout(r, THREAD_POLL_INTERVAL_MS));
					chatThreadId = store.getChatThreadByIssue(
						issueId,
						chatChannel,
					)?.thread_id;
					if (chatThreadId) break;
				}
			}

			// FLY-137 Phase 5: persist agent dispatch metadata + codex-skip
			// snapshot now that the session row exists.
			// FLY-205 (Codex code R1 HIGH-2): start() returns as soon as
			// blueprint.run() is kicked off; the row is created later by
			// emitStarted(). Without chat threads the THREAD_POLL above never
			// runs, so a bare getSession() here races row creation and the
			// patch (incl. doc_tier) silently skips — wait (bounded) instead.
			// A genuinely failed start still falls through to the FLY-80
			// ghost-start guard below.
			const persistedSession = await waitForSession(store, result.executionId);
			if (persistedSession) {
				const matchMethod: string | undefined = agentName
					? "override"
					: undefined;
				store.patchSessionMetadata(result.executionId, {
					agent_name: agentName ?? undefined,
					agent_match_method: matchMethod,
					codex_skip: codexSkip ? 1 : 0,
					// FLY-598: founder-facing-ux label snapshot (inert unless gate active)
					founder_facing_ux: founderFacingUx ? 1 : 0,
					// FLY-205: persist the EFFECTIVE tier (explicit "full" when the
					// Lead sent nothing) so retry reuses exactly what this run got —
					// never a silent re-default. issue_url for header continuity.
					doc_tier: docTier ?? "full",
					issue_url: issueUrl,
					// FLY-728 Part C: persist the dispatch model param ONLY (not the
					// resolved model) so retry re-applies a genuine sorter/dispatch
					// choice — never a removed label's or a stale project default's model.
					dispatch_model: dispatchModel,
				});
			}

			// FLY-80: Verify session was actually registered (detect ghost starts).
			// If Blueprint.run() failed before emitStarted(), no session exists.
			//
			// FLY-123 QA Finding 3 (HIGH): this MUST be a poll, not a one-shot
			// check. `dispatcher.start()` returns immediately (Blueprint.run is
			// detached) and Blueprint reaches `emitStarted()` — which creates
			// the session row — only after `await hydrate()`. The chatThread
			// poll above is an unreliable proxy: it breaks early when a thread
			// already exists for the issue (e.g. a prior run / a re-label),
			// so the row may not exist yet when we get here. A one-shot check
			// then false-500s a perfectly live runner — and a Codex spawn (a
			// slow synchronous `codex --version` + window setup blocks the
			// event loop after emitStarted) widened the window enough that QA
			// hit it every time. A false 500 is the FLY-172 failure class: the
			// Lead may double-spawn on retry or mark a running session failed.
			//
			// The row is created BEFORE the adapter's blocking spawn work, so a
			// genuinely-alive runner registers quickly once the loop yields;
			// only a true ghost (Blueprint threw before emitStarted) stays
			// absent for the full deadline. One bounded-poll helper, not two —
			// reuses FLY-205's `waitForSession` with the ghost-guard deadline.
			const finalSession = await waitForSession(store, result.executionId, {
				timeoutMs: GHOST_GUARD_SESSION_WAIT_MS,
			});
			if (!finalSession) {
				res.status(500).json({
					success: false,
					message: `Runner failed to start — session not registered after ${GHOST_GUARD_SESSION_WAIT_MS}ms. Check Bridge logs for errors.`,
				});
				return;
			}

			res.json({
				success: true,
				executionId: result.executionId,
				issueId: result.issueId,
				chatThreadId,
				message: `Runner started for ${issueId}`,
			});
		} catch (err) {
			// FLY-137 v1.27.2: InvalidAgentNameError thrown from AgentDispatcher
			// when Lead override `agentName` doesn't match any configured agent.
			// Map to FLY-127-shaped machine-only diagnostic.
			if (err instanceof Error && err.name === "InvalidAgentNameError") {
				const e = err as Error & {
					providedName?: string;
					available?: string[];
				};
				console.log(
					`[runs/start] FLY-137 INVALID_AGENT_NAME: provided="${e.providedName}" available=${JSON.stringify(e.available)}`,
				);
				res.status(400).json({
					success: false,
					code: "INVALID_AGENT_NAME",
					reason: "unknown_agent",
					available: e.available ?? [],
					silent: false,
				});
				return;
			}
			// FLY-123 WS-D (R1 MED #4): dispatcher-side resource admission can
			// defer AFTER the route precheck admitted (load crossed the
			// threshold in between). It throws a typed AdmissionDeferredError →
			// 429 with the reason, never a 500 string-match miss.
			if (err instanceof Error && err.name === "AdmissionDeferredError") {
				const e = err as Error & { reason?: string };
				res.status(429).json({
					success: false,
					reason: e.reason,
					message: e.message,
				});
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			if (message.includes("already in progress")) {
				res.status(409).json({ success: false, message });
			} else if (message.includes("No runtime for project")) {
				res.status(404).json({ success: false, message });
			} else {
				console.error("[runs/start] Unexpected error:", message);
				res.status(500).json({ success: false, message });
			}
		}
	});

	router.get("/active", (_req, res) => {
		const running = store
			.getActiveSessions()
			.filter((s) => s.status === "running").length;
		const inflight = startDispatcher.getInflightCount();
		res.json({
			running,
			inflight,
			total: running + inflight,
			// FLY-123 WS-D (P4): uncapped — no numeric ceiling. `null` signals
			// "unbounded" to the dashboard (never report `max: 0`).
			max: null,
		});
	});

	return router;
}
