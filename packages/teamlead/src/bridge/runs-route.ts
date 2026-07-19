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

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Router } from "express";
import type {
	DesignBackend,
	PhaseDispatchVendor,
	PipelineConfig,
	PonytailInput,
	RoleEffort,
} from "flywheel-config";
import {
	ACCEPTED_DISPATCH_MODELS,
	ConfigLoader,
	DESIGN_BACKENDS,
	isDesignBackend,
	isThreeStagePhaseRole,
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
import {
	parseWorkflowRunSnapshot,
	workflowNodeAgentContent,
} from "../workflow-run-snapshot.js";
import { workflowTemplateDispatchBlockReason } from "../workflow-template-dispatch.js";
import {
	recoverWorkflowStartSelection,
	resolveWorkflowTemplateCandidateSchema,
	resolveWorkflowTemplateSelection,
	type WorkflowRequestAuthKind,
	type WorkflowTemplateSelectionResult,
} from "../workflow-template-selection.js";
import { validateAndRegisterChatThread } from "./chat-thread-register.js";
import {
	isQaIssueTitle,
	resolveFounderFacingUx,
} from "./founder-ux/trigger.js";
import {
	getGeneralizedLaunchDelivery,
	probeGeneralizedLaunchLiveness,
	waitForGeneralizedLaunchDelivery,
} from "./generalized-launch-recovery.js";
import type { IStartDispatcher } from "./retry-dispatcher.js";
import type { RunnerAdmissionController } from "./runner-admission.js";
import { waitForSession } from "./session-wait.js";
import { loadPipelineConfigByProject } from "./three-stage-config-source.js";
import {
	NO_THREE_STAGE_LABEL,
	resolveGlobalThreeStageKillSwitch,
	resolveThreeStageEntry,
} from "./three-stage-policy.js";

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
 * times out. The default is deliberately above the saturated-host launch
 * delivery observed in FLY-1336; operators can tune it only at process start.
 */
function positiveInt(raw: string | undefined, fallback: number): number {
	const parsed = Number(raw);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const GHOST_GUARD_SESSION_WAIT_MS = positiveInt(
	process.env.FLYWHEEL_GHOST_GUARD_WAIT_MS,
	90_000,
);

function secureTokenEqual(
	actual: string | undefined,
	expected: string | undefined,
) {
	if (!actual || !expected) return false;
	const actualDigest = createHash("sha256").update(actual).digest();
	const expectedDigest = createHash("sha256").update(expected).digest();
	return timingSafeEqual(actualDigest, expectedDigest);
}

function isSchemaSnapshot(
	snapshot: string | null | undefined,
	schemaVersion: 1 | 2,
): boolean {
	if (!snapshot) return false;
	try {
		const parsed = JSON.parse(snapshot) as { schema_version?: unknown };
		return parsed?.schema_version === schemaVersion;
	} catch {
		return false;
	}
}

function isSchemaV2Snapshot(snapshot: string | null | undefined): boolean {
	return isSchemaSnapshot(snapshot, 2);
}

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
	auth?: { masterToken?: string; scopedToken?: string },
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
		if (Object.hasOwn(req.body, "founderOverrideTemplateId")) {
			res.status(400).json({
				success: false,
				code: "FOUNDER_OVERRIDE_FORBIDDEN",
			});
			return;
		}
		const bearer =
			typeof req.headers.authorization === "string" &&
			req.headers.authorization.startsWith("Bearer ")
				? req.headers.authorization.slice("Bearer ".length)
				: undefined;
		const requestAuthKind: WorkflowRequestAuthKind = secureTokenEqual(
			bearer,
			auth?.masterToken,
		)
			? "master"
			: secureTokenEqual(bearer, auth?.scopedToken)
				? "scoped"
				: "tokenless";
		const rawProjectName = req.body.projectName;
		let leadId = req.body.leadId as string | undefined;

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

		// FLY-1259: optional per-dispatch design author. Validate the exact public
		// enum before any admission, policy, or runner side effect.
		const rawDesignBackend = req.body.designBackend;
		let requestedDesignBackend: DesignBackend | undefined;
		if (rawDesignBackend === undefined || rawDesignBackend === null) {
			requestedDesignBackend = undefined;
		} else if (typeof rawDesignBackend !== "string") {
			res.status(400).json({
				success: false,
				code: "INVALID_DESIGN_BACKEND",
				reason: "wrong_type",
				allowed: [...DESIGN_BACKENDS],
				silent: false,
			});
			return;
		} else if (!isDesignBackend(rawDesignBackend)) {
			res.status(400).json({
				success: false,
				code: "INVALID_DESIGN_BACKEND",
				reason: "unknown_backend",
				allowed: [...DESIGN_BACKENDS],
				silent: false,
			});
			return;
		} else {
			requestedDesignBackend = rawDesignBackend;
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
		if (requestedDesignBackend && role !== "main") {
			res.status(400).json({
				success: false,
				code: "DESIGN_BACKEND_NOT_APPLICABLE",
				reason: "non_main_role",
				requested: requestedDesignBackend,
				silent: false,
			});
			return;
		}
		// FLY-1259 (Codex code R1/R2): settle the Bridge-global kill-switch HERE —
		// ahead of dedup, the stale-blocker guard and admission — so an override sent
		// to a Bridge with three-stage off entirely gets its bounded 400 instead of a
		// 409/429, and never makes the guard finalize/alert a previous session on
		// behalf of a doomed request.
		//
		// Global-only is a precedence constraint (see the helper): the remaining
		// checks — `no-three-stage` label, channel allowlist, pipeline opt-in — all
		// rank BELOW the label check, which needs the Linear pre-flight that runs
		// after dedup by design. Deciding them here would report a reason code the
		// authoritative path disagrees with. They stay below and stay authoritative;
		// for them a conflicting/deferred request still answers 409/429 first, which
		// is honest — nothing can start for that issue yet regardless of backend, and
		// a retry surfaces the 400.
		//
		// Entered ONLY for an explicit override, so the default path — including its
		// 409/429 ordering — is byte-identical.
		if (requestedDesignBackend) {
			const globalBlock = resolveGlobalThreeStageKillSwitch(process.env);
			if (globalBlock) {
				console.warn(
					`[runs/start] designBackend=${requestedDesignBackend} not applicable: ${globalBlock.reason}`,
				);
				res.status(400).json({
					success: false,
					code: "DESIGN_BACKEND_NOT_APPLICABLE",
					reason: globalBlock.reasonCode,
					requested: requestedDesignBackend,
					silent: false,
				});
				return;
			}
		}
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
		const requestedStartKey =
			typeof req.body.idempotencyKey === "string"
				? req.body.idempotencyKey.trim()
				: undefined;
		const replayReservation = requestedStartKey
			? store.getWorkflowStartReservation(requestedStartKey)
			: undefined;
		const exactGeneralizedReplay =
			requestAuthKind === "master" &&
			replayReservation?.execution_id === alreadyActive?.execution_id &&
			isSchemaV2Snapshot(
				replayReservation
					? store.getWorkflowRun(replayReservation.run_id)?.snapshot
					: undefined,
			);
		if (alreadyActive && !exactGeneralizedReplay) {
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
		if (leadId) {
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

			// FLY-80: Auto-resolve leadId from project config if not provided.
			// Without leadId, Blueprint skips approve gate instructions entirely.
			if (!leadId) {
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
		// Runs only when:
		//   - the feature flag is on (BRIDGE_DEPT_SCOPE_REJECT != off)
		//   - leadId is known (either provided by caller or auto-resolved above)
		//
		// On reject, returns a machine-readable diagnostic that Lead daemons
		// translate into one short Chinese line per their Action Gate rule.
		// `silent: false` because Bridge is only called on explicit-intent paths
		// (Layer 1b filters passive cross-dept noise before any API call).
		if (isDeptScopeRejectEnabled() && leadId) {
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

		// ── FLY-1372 问题⓪ (part 1): DAG recovery-domain classification. Runs
		// BEFORE the candidate preflight — recovery depends only on the active
		// run + reservation + pinned snapshot, so a corrupted CURRENT binding/
		// template must never strand a recoverable run (Codex design R3-2).
		// The classification key is the durable `entry_kind='pipeline_dag_v1'`
		// provenance marker — NOT `engine_owned`, which every start-reservation
		// run (existing v2 / explicit-v1) also carries (R3-1). Unmarked runs
		// fall through to today's paths byte-identically.
		let mainPipelineConfig: PipelineConfig | undefined;
		let mainPipelineConfigLoaded = false;
		const loadMainPipelineConfig = async () => {
			if (!mainPipelineConfigLoaded) {
				mainPipelineConfigLoaded = true;
				const proj = projects.find((p) => p.projectName === projectName);
				mainPipelineConfig = proj
					? (await loadPipelineConfigByProject([proj])).get(projectName)
					: undefined;
			}
			return mainPipelineConfig;
		};
		// Shared DAG request validation (Codex design R3-4): both the fresh and
		// the recovery domain run it BEFORE any cache/selection — an explicit
		// param the template overrides hard must 400, never be silently
		// swallowed by a cached replay. Responds and returns false on reject.
		const validateDagRequestParameters = (): boolean => {
			if (requestedDesignBackend) {
				res.status(400).json({
					success: false,
					code: "DESIGN_BACKEND_NOT_APPLICABLE",
					reason: "dag_dispatch",
					requested: requestedDesignBackend,
					silent: false,
				});
				return false;
			}
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
						return false;
					}
					res.status(400).json({
						success: false,
						code: "INVALID_AGENT_NAME",
						reason: "unknown_agent",
						available: validation.available,
						silent: false,
					});
					return false;
				}
			}
			return true;
		};
		let dagEntry = false;
		let dagRecovery: WorkflowTemplateSelectionResult | undefined;
		let hadDagRun = false;
		{
			// Codex code R2 #1: the marked-run invariant is classified for EVERY
			// same-issue start, independent of role/auth — a master qa-role or a
			// scoped main request could otherwise skip both DAG domains AND the
			// main-only three-stage block, get a silent null from selection, and
			// start an unbound legacy session beside the active DAG run. Recovery
			// stays main+master; everything else answers a typed 409 while the
			// marker is active. Never-enrolled projects have no marked runs (zero
			// behavior change), and real auto-QA dispatches on a SEPARATE QA·issue.
			const activeRun = store.getActiveWorkflowRunForIssue(issueId);
			const dagRun =
				activeRun?.entry_kind === "pipeline_dag_v1" ? activeRun : undefined;
			if (dagRun) {
				hadDagRun = true;
				if (role !== "main" || requestAuthKind !== "master") {
					res.status(409).json({
						success: false,
						code: "DAG_RUN_ACTIVE",
						reason: `issue ${issueId} has an active pipeline-dag run (${dagRun.run_id}) — only a master main-role request may re-drive it; let the engine converge it or terminate the run first`,
					});
					return;
				}
				const pipelineConfig = await loadMainPipelineConfig();
				const reservation = store.getWorkflowStartReservationForRun(
					dagRun.run_id,
				);
				if (!reservation) {
					res.status(409).json({
						success: false,
						code: "DAG_RUN_STATE_CORRUPT",
						reason: `active pipeline-dag run ${dagRun.run_id} has no start reservation`,
					});
					return;
				}
				if (!validateDagRequestParameters()) return;
				let runSchema: 1 | 2;
				try {
					runSchema = parseWorkflowRunSnapshot(
						dagRun.snapshot ?? "",
					).schema_version;
				} catch (err) {
					res.status(409).json({
						success: false,
						code: "DAG_RUN_STATE_CORRUPT",
						reason: `active pipeline-dag run ${dagRun.run_id} snapshot unreadable: ${(err as Error).message}`,
					});
					return;
				}
				if (
					workflowTemplateDispatchBlockReason(runSchema, process.env) !==
						undefined ||
					pipelineConfig?.dag !== true
				) {
					// Rollback window: never resume the run past the kill switch,
					// and never let legacy start beside a partial engine run
					// (Codex design R2-2b). Operators restore the flags/config to
					// converge the run, or explicitly finalize it first.
					res.status(409).json({
						success: false,
						code: "ACTIVE_DAG_RUN_RECOVERY_HELD",
						reason: `issue ${issueId} has an active pipeline-dag run (${dagRun.run_id}) but DAG dispatch is currently disabled — restore workflow flags + pipeline.dag to converge it, or finalize/terminate the run before dispatching legacy`,
					});
					return;
				}
				if (
					requestedStartKey &&
					requestedStartKey !== reservation.idempotency_key
				) {
					// Codex code R1 #1: a DIFFERENT explicit key must never fall
					// through — the normal selection path can silently return null
					// (v1 gates) and start legacy beside the marked run. Any start
					// for this issue while the marked run is active must go through
					// its reservation; answer loudly.
					res.status(409).json({
						success: false,
						code: "DAG_RUN_KEY_MISMATCH",
						reason: `issue ${issueId} has an active pipeline-dag run bound to a different start reservation — retry keyless (recovery) or with the original idempotencyKey, or finalize/terminate the run first`,
					});
					return;
				}
				{
					// Keyless (or matching-key) re-drive: mirror exactSchemaV1Replay —
					// the start execution itself replays; a live SUCCESSOR phase means
					// the run is mid-flight and a new dispatch is a double-start.
					const activePhase = store.getActivePhaseSessionForIssue(issueId);
					if (
						activePhase &&
						activePhase.execution_id !== reservation.execution_id
					) {
						res.status(409).json({
							success: false,
							message: `Issue ${issueId} already has an active DAG phase (${activePhase.session_role}, ${activePhase.execution_id}, status: ${activePhase.status}). The engine advances the run — do not start a second run; let it converge or terminate it first.`,
						});
						return;
					}
					try {
						dagRecovery = recoverWorkflowStartSelection(store, {
							issueId,
							projectName,
							authKind: requestAuthKind,
						});
					} catch (err) {
						res.status(409).json({
							success: false,
							code: "DAG_RUN_STATE_CORRUPT",
							reason: (err as Error).message,
						});
						return;
					}
				}
			}
		}

		const templateCandidateInput = {
			project: projectName,
			taskCategory:
				typeof req.body.taskCategory === "string"
					? req.body.taskCategory
					: undefined,
			leadTemplateId:
				typeof req.body.templateId === "string"
					? req.body.templateId
					: undefined,
		};
		let candidateSchemaAtEntry: 1 | 2 | null;
		if (dagRecovery) {
			// FLY-1372 (Codex design R3-2): the recovery domain is CANDIDATE-FREE.
			// The current resolver can throw on a corrupted/nonexistent current
			// template — that must never strand a run with a good pinned snapshot,
			// so it is not even consulted on the recovery path (the value is unused
			// there: three-stage and selection are both bypassed).
			candidateSchemaAtEntry = null;
		} else {
			try {
				candidateSchemaAtEntry = resolveWorkflowTemplateCandidateSchema(
					store,
					templateCandidateInput,
				);
			} catch (err) {
				res.status(409).json({
					success: false,
					code: "GENERALIZED_WORKFLOW_REJECTED",
					reason: (err as Error).message,
				});
				return;
			}
		}

		// ── FLY-1372 问题⓪ (part 2): DAG fresh domain. Only when NO marked run
		// exists; consumes the candidate resolved just above. Flags outrank the
		// candidate-missing 409 (flags OFF = the sanctioned rollback lever →
		// byte-identical legacy), and only a schema-1 candidate enters — the
		// pilot is v1-only, schema-2 keeps today's explicit path untouched.
		if (
			!dagRecovery &&
			!hadDagRun &&
			role === "main" &&
			requestAuthKind === "master"
		) {
			const pipelineConfig = await loadMainPipelineConfig();
			if (
				pipelineConfig?.dag === true &&
				!normalizedIssueLabels.includes(NO_THREE_STAGE_LABEL)
			) {
				const dagBlock = workflowTemplateDispatchBlockReason(
					candidateSchemaAtEntry ?? 1,
					process.env,
				);
				if (dagBlock === undefined) {
					if (candidateSchemaAtEntry === null) {
						// Enrolled + flags ON + no candidate = broken configuration.
						// Fail loud — a silent legacy fallback here is exactly the
						// incident class this entry exists to kill (FLY-802).
						res.status(409).json({
							success: false,
							code: "DAG_TEMPLATE_CANDIDATE_MISSING",
							reason: `project ${projectName} is DAG-enrolled with dispatch flags ON but no workflow template candidate resolves (binding/template missing)`,
						});
						return;
					}
					if (candidateSchemaAtEntry === 1) {
						if (!validateDagRequestParameters()) return;
						const activePhase = store.getActivePhaseSessionForIssue(issueId);
						if (activePhase) {
							// No marked run exists, so this is a parked LEGACY phase
							// session — a new DAG run must not collide with it (A7).
							res.status(409).json({
								success: false,
								message: `Issue ${issueId} already has an active legacy phase session (${activePhase.session_role}, ${activePhase.execution_id}, status: ${activePhase.status}). Let it hand off or terminate it before dispatching into the DAG.`,
							});
							return;
						}
						dagEntry = true;
					}
				}
			}
		}

		// FLY-793 (Step 4 ENTRY): resolve the trusted three-stage policy before
		// schema-v1 template selection. The v1 engine is an implementation of this
		// entry, so it may not bypass an opt-out or the shared-worktree phase guard.
		// Schema v2 remains independently selectable and skips this legacy policy.
		let shareParentBranch: boolean | undefined;
		let ignoreRunnerLabelSelection: boolean | undefined;
		let dispatchVendor: PhaseDispatchVendor | undefined;
		let dispatchEffort: RoleEffort | undefined;
		let effectiveDesignBackend: DesignBackend | undefined;
		// FLY-1372: a DAG entry / recovery短路s the whole three-stage block — the
		// DAG run carries design→implement→qa itself; no role rewrite here.
		if (
			!dagEntry &&
			!dagRecovery &&
			role === "main" &&
			candidateSchemaAtEntry !== 2
		) {
			const proj = projects.find((p) => p.projectName === projectName);
			const pipelineConfig = await loadMainPipelineConfig();
			const dispatchChannelId = leadId
				? proj?.leads.find((l) => l.agentId === leadId)?.chatChannel
				: undefined;
			const entry = resolveThreeStageEntry({
				requestRole: role,
				pipelineConfig,
				issueLabels: normalizedIssueLabels,
				env: process.env,
				dispatchChannelId,
				designBackend: requestedDesignBackend,
			});
			if (requestedDesignBackend && !entry.enteredThreeStage) {
				console.warn(
					`[runs/start] designBackend=${requestedDesignBackend} not applicable: ${entry.notEnteredDetail ?? entry.notEnteredReasonCode ?? "policy_disabled"}`,
				);
				res.status(400).json({
					success: false,
					code: "DESIGN_BACKEND_NOT_APPLICABLE",
					reason: entry.notEnteredReasonCode ?? "policy_disabled",
					requested: requestedDesignBackend,
					silent: false,
				});
				return;
			}
			if (entry.enteredThreeStage) {
				const activePhase = store.getActivePhaseSessionForIssue(issueId);
				const exactSchemaV1Replay =
					requestAuthKind === "master" &&
					replayReservation?.execution_id === activePhase?.execution_id &&
					isSchemaSnapshot(
						replayReservation
							? store.getWorkflowRun(replayReservation.run_id)?.snapshot
							: undefined,
						1,
					);
				if (activePhase && !exactSchemaV1Replay) {
					res.status(409).json({
						success: false,
						message: `Issue ${issueId} already has an active three-stage ${activePhase.session_role} phase (${activePhase.execution_id}, status: ${activePhase.status}). The pipeline advances Design→Implement→QA on one shared branch — do not start a second run; let the active phase hand off, or terminate it first.`,
					});
					return;
				}
				role = entry.role;
				shareParentBranch = true;
				dispatchModel = entry.dispatchModel;
				dispatchVendor = entry.dispatchVendor;
				dispatchEffort = entry.dispatchEffort;
				effectiveDesignBackend = entry.designBackend;
				ignoreRunnerLabelSelection = true;
			}
		}

		// FLY-1372 §2.5: start-snapshot helpers shared by the DAG entry and the
		// legacy path. The legacy call sites keep their original positions —
		// identical values, byte-identical persistence timing when DAG is off.
		//
		// codexSkip — FLY-137 Phase 5: "label the issue before triggering; if you
		// forgot, cancel + retry" (no mid-run Linear refresh).
		// founderFacingUx — FLY-598/FLY-869: default-ON, exempt only via the
		// project's configured exempt labels (canonical `.flywheel/config.yaml`)
		// or a `QA · <ident>` title; FAIL-CLOSED on a label-read failure (an
		// unreadable label set must never read as "not founder-facing"). Inert
		// unless founder_ux_gate.mode != off.
		const computeStartBehaviorSnapshot = async () => {
			const codexSkip = normalizedIssueLabels.includes("codex-skip");
			const founderUxProject = projects.find(
				(p) => p.projectName === projectName,
			);
			const founderUxExemptLabels =
				await loadFounderUxExemptLabels(founderUxProject);
			const founderFacingUx = resolveFounderFacingUx(
				normalizedIssueLabels,
				issueLabelsFetchFailed,
				founderUxExemptLabels,
				isQaIssueTitle(issueTitle),
			);
			return { codexSkip, founderFacingUx };
		};
		const buildPonytailInput = (): PonytailInput => {
			const rawPonytail = (req.body as { ponytail?: unknown }).ponytail;
			const ponytailRunOverride =
				rawPonytail === "on" || rawPonytail === "off"
					? (rawPonytail as "on" | "off")
					: undefined;
			return {
				kind: "start_signal",
				signal: {
					...(ponytailRunOverride && { runOverride: ponytailRunOverride }),
					labels: normalizedIssueLabels,
					labelStatus: issueLabelsFetchFailed ? "unreadable" : "readable",
				},
			};
		};
		// FLY-1372 §2.5: request-scoped advisory echo — the durable authority is
		// the pinned run snapshot itself. `model`/`agentName` are accepted (Lead
		// shared rules require them on every dispatch; three-stage entry already
		// overrides the sorter model unconditionally — same sovereignty, made
		// explicit) but the template pins per-node vendor/model/agent. ponytail
		// rides the legacy-identical ladder and is NOT in this list.
		const dagAuthority =
			dagEntry || dagRecovery
				? {
						templateAuthority: {
							overrode: [
								...(rawModel != null ? ["model"] : []),
								...(agentName !== undefined ? ["agentName"] : []),
							],
						},
					}
				: {};

		const generalizedProject = projects.find(
			(project) => project.projectName === projectName,
		);
		// FLY-1372: the DAG entry synthesizes a start key when the Lead sent none
		// (random — a deterministic per-issue key would forever replay the FIRST
		// run's cached response on later fresh dispatches). Keyless RETRY safety
		// comes from the recovery domain above, not from key determinism.
		const effectiveStartKey =
			requestedStartKey ?? (dagEntry ? `dag-auto-${randomUUID()}` : undefined);
		let generalizedSelection:
			| ReturnType<typeof resolveWorkflowTemplateSelection>
			| undefined;
		if (dagRecovery) {
			generalizedSelection = dagRecovery;
		} else {
			try {
				generalizedSelection = resolveWorkflowTemplateSelection(store, {
					...templateCandidateInput,
					issueId,
					leadReason:
						typeof req.body.selectionReason === "string"
							? req.body.selectionReason
							: undefined,
					selectedBy: leadId ?? "unassigned",
					actor: requestAuthKind,
					authKind: requestAuthKind,
					canonicalRoot: generalizedProject?.projectRoot ?? "",
					idempotencyKey: effectiveStartKey,
					allowSchemaV1Dispatch:
						dagEntry || (role === "design" && shareParentBranch === true),
					candidateSchemaAtEntry,
					...(dagEntry ? { entryKind: "pipeline_dag_v1" as const } : {}),
					env: process.env,
				});
			} catch (err) {
				res.status(409).json({
					success: false,
					code: "GENERALIZED_WORKFLOW_REJECTED",
					reason: (err as Error).message,
				});
				return;
			}
		}
		// FLY-1372 fail-closed: the DAG entry decided to dispatch but selection
		// yielded nothing (a flag flipped mid-request via the direct-toggle flag
		// console, or the binding vanished between reads). NEVER fall through to
		// legacy silently — that is the FLY-802 incident class.
		if (dagEntry && !generalizedSelection) {
			res.status(409).json({
				success: false,
				code: "DAG_ENTRY_NOT_MATERIALIZED",
				reason:
					"dag entry selected no workflow candidate (flag flipped mid-request or binding removed) — refusing silent legacy fallback",
			});
			return;
		}

		if (generalizedSelection) {
			const priorResponse = store.getWorkflowStartResponse(
				generalizedSelection.idempotencyKey,
			);
			if (priorResponse) {
				res.json(priorResponse);
				return;
			}
			const now = new Date();
			const workflowAdmission = store.admitGeneralizedWorkflowExecution({
				runId: generalizedSelection.runId,
				nodeId: generalizedSelection.nodeId,
				executionId: generalizedSelection.executionId,
				attempt: 1,
				now: now.toISOString(),
				expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
				absoluteDeadlineAt: new Date(
					now.getTime() + 24 * 60 * 60_000,
				).toISOString(),
				env: process.env,
				idempotencyKey: generalizedSelection.idempotencyKey,
			});
			if (!workflowAdmission.ok) {
				res.status(409).json({
					success: false,
					code: "GENERALIZED_ADMISSION_REJECTED",
					reason: workflowAdmission.reason,
				});
				return;
			}
			if (!generalizedSelection.node.dispatch) {
				res.status(409).json({
					success: false,
					code: "GENERALIZED_NODE_NOT_EXECUTABLE",
				});
				return;
			}
			const workflowAgentContent = workflowNodeAgentContent(
				generalizedSelection.node,
			);
			if (!workflowAgentContent) {
				res.status(409).json({
					success: false,
					code: "GENERALIZED_AGENT_CONTENT_MISSING",
				});
				return;
			}
			let startedSession = store.getSession(generalizedSelection.executionId);
			let workflowOutputCredential = workflowAdmission.outputCredential;
			const workflowSubmissionCredential =
				workflowAdmission.submissionCredential;
			let launchGateToken: string | undefined;
			let commitWorkflowLaunch:
				| (() => { ok: boolean; reason?: string })
				| undefined;
			// Codex code R1 #2: a session row alone is NOT launch evidence —
			// Blueprint creates it BEFORE the adapter's launch commit, so a crash
			// between the two would otherwise answer 202 forever without ever
			// re-entering the owner state machine. Only a durably DELIVERED
			// generation short-circuits; otherwise run the machine (typed 409 hold
			// inside the live lease, reacquire + re-drive after expiry).
			const priorDelivery = getGeneralizedLaunchDelivery(
				store,
				generalizedSelection.executionId,
			);
			if (!startedSession || !priorDelivery) {
				const launchOwnerId = randomUUID();
				const launchMarkerPath = join(
					process.env.HOME ?? homedir(),
					".flywheel",
					"state",
					"launch-commits",
					generalizedSelection.executionId,
				);
				const launchNow = new Date();
				const launch = store.recoverOrAcquireWorkflowLaunch({
					executionId: generalizedSelection.executionId,
					ownerId: launchOwnerId,
					now: launchNow.toISOString(),
					leaseExpiresAt: new Date(
						launchNow.getTime() + 60 * 60_000,
					).toISOString(),
					markerPath: launchMarkerPath,
				});
				if (launch.status === "hold" || launch.status === "busy") {
					res.status(409).json({
						success: false,
						code: "GENERALIZED_LAUNCH_HELD",
						reason:
							launch.status === "hold"
								? launch.reason
								: `owner generation ${launch.generation} is active`,
					});
					return;
				}
				let shouldDispatch = launch.status === "acquired";
				if (launch.status === "committed") {
					const liveness = await probeGeneralizedLaunchLiveness(
						generalizedSelection.executionId,
						projectName,
					);
					if (liveness === "unknown") {
						res.status(409).json({
							success: false,
							code: "GENERALIZED_LAUNCH_LIVENESS_HOLD",
							reason:
								"committed launch has neither a durable session nor conclusive tmux liveness evidence",
						});
						return;
					}
					if (liveness === "dead") {
						// The output ticket is hash-only and launch-commit makes rotation
						// terminal. Rebuilding an output-producing shell cannot recover its
						// plaintext capability, so this shape must remain fail-closed.
						if (generalizedSelection.node.capabilities.produces_output) {
							res.status(409).json({
								success: false,
								code: "GENERALIZED_DELIVERY_REPAIR_CREDENTIAL_HELD",
								reason:
									"committed output credential is not reconstructable for delivery repair",
							});
							return;
						}
						const repairNow = new Date();
						const repair = store.claimWorkflowLaunchDeliveryRepair({
							executionId: generalizedSelection.executionId,
							repairOwner: launchOwnerId,
							now: repairNow.toISOString(),
							leaseExpiresAt: new Date(
								repairNow.getTime() + 60 * 60_000,
							).toISOString(),
						});
						if (repair.status !== "claimed") {
							res.status(409).json({
								success: false,
								code: "GENERALIZED_DELIVERY_REPAIR_HELD",
								reason:
									repair.status === "busy"
										? `delivery repair attempt ${repair.attempt} is active`
										: repair.reason,
							});
							return;
						}
						launchGateToken = repair.token;
						commitWorkflowLaunch = () =>
							store.commitWorkflowLaunchDeliveryRepair({
								executionId: generalizedSelection!.executionId,
								repairOwner: launchOwnerId,
								generation: repair.generation,
								attempt: repair.attempt,
								markerPath: launchMarkerPath,
								now: new Date().toISOString(),
							});
						shouldDispatch = true;
					}
				} else {
					if (
						generalizedSelection.node.capabilities.produces_output &&
						!workflowOutputCredential
					) {
						const rotationNow = new Date();
						const rotated = store.rotateGeneralizedWorkflowOutputCredential({
							executionId: generalizedSelection.executionId,
							ownerId: launchOwnerId,
							generation: launch.generation,
							now: rotationNow.toISOString(),
							expiresAt: new Date(
								rotationNow.getTime() + 60 * 60_000,
							).toISOString(),
							absoluteDeadlineAt: new Date(
								rotationNow.getTime() + 24 * 60 * 60_000,
							).toISOString(),
						});
						if (!rotated.ok) {
							res.status(409).json({
								success: false,
								code: "GENERALIZED_START_RECOVERY_HELD",
								reason: rotated.reason,
							});
							return;
						}
						workflowOutputCredential = rotated.outputCredential;
					}
					const renewalNow = new Date();
					const renewed = store.renewWorkflowLaunchOwner({
						executionId: generalizedSelection.executionId,
						ownerId: launchOwnerId,
						generation: launch.generation,
						now: renewalNow.toISOString(),
						leaseExpiresAt: new Date(
							renewalNow.getTime() + 60 * 60_000,
						).toISOString(),
					});
					if (!renewed.ok) {
						res.status(409).json({
							success: false,
							code: "GENERALIZED_LAUNCH_HELD",
							reason: renewed.reason,
						});
						return;
					}
					launchGateToken = launch.token;
					commitWorkflowLaunch = () =>
						store.fencedCommitWorkflowLaunch({
							executionId: generalizedSelection!.executionId,
							ownerId: launchOwnerId,
							generation: launch.generation,
							deliveryAttempt: launch.deliveryAttempt,
							markerPath: launchMarkerPath,
							now: new Date().toISOString(),
						});
				}
				if (shouldDispatch) {
					const workflowRole = isThreeStagePhaseRole(
						generalizedSelection.node.type,
					)
						? generalizedSelection.node.type
						: "main";
					// FLY-1372 §2.5: DAG starts carry the EFFECTIVE behavior snapshot
					// (docTier defaulted, founder-ux computed, ponytail ladder input)
					// so the durable emitStarted seam persists them with the session
					// row. Non-DAG generalized starts keep today's exact shape.
					const dagBehavior =
						dagEntry || dagRecovery
							? await computeStartBehaviorSnapshot()
							: undefined;
					await startDispatcher.start({
						issueId,
						projectName,
						leadId,
						issueTitle,
						issueIdentifier,
						sessionRole: workflowRole,
						shareParentBranch: workflowRole === "main" ? undefined : true,
						issueLabels: normalizedIssueLabels,
						owningDept,
						codexSkip:
							dagBehavior?.codexSkip ??
							normalizedIssueLabels.includes("codex-skip"),
						docTier: dagBehavior ? (docTier ?? "full") : docTier,
						...(dagBehavior && {
							founderFacingUx: dagBehavior.founderFacingUx,
							ponytailInput: buildPonytailInput(),
						}),
						issueUrl,
						generalizedExecution: {
							engineOwned: true,
							executionId: generalizedSelection.executionId,
							runId: generalizedSelection.runId,
							nodeId: generalizedSelection.nodeId,
							attempt: 1,
							snapshotDigest: generalizedSelection.snapshotDigest,
							dispatch: generalizedSelection.node.dispatch,
							capabilities: { ...generalizedSelection.node.capabilities },
							agentContent: workflowAgentContent,
							outputCredential: workflowOutputCredential,
							submissionCredential: workflowSubmissionCredential,
							idempotencyKey: generalizedSelection.idempotencyKey,
							launchGateToken,
							commitWorkflowLaunch,
						},
					});
					store.advanceWorkflowStartStage(
						generalizedSelection.idempotencyKey,
						"commdb_registered",
					);
					startedSession = await waitForSession(
						store,
						generalizedSelection.executionId,
						{ timeoutMs: GHOST_GUARD_SESSION_WAIT_MS },
					);
					if (!startedSession) {
						res.status(500).json({
							success: false,
							code: "GENERALIZED_START_NOT_LIVE",
							message: `Runner failed to start — session not registered after ${GHOST_GUARD_SESSION_WAIT_MS}ms.`,
						});
						return;
					}
					// FLY-1372 §2.5: audit-only fields (best-effort, fresh path only —
					// a replay must never overwrite the original request's audit trail).
					if (dagEntry && !generalizedSelection.replayed) {
						const audit: {
							dispatch_model?: string;
							agent_name?: string;
						} = {};
						if (dispatchModel) audit.dispatch_model = dispatchModel;
						if (agentName) audit.agent_name = agentName;
						if (Object.keys(audit).length > 0) {
							store.patchSessionMetadata(
								generalizedSelection.executionId,
								audit,
							);
						}
					}
				}
			}
			let committedOwner = await waitForGeneralizedLaunchDelivery(
				store,
				generalizedSelection.executionId,
				{ timeoutMs: GHOST_GUARD_SESSION_WAIT_MS },
			);
			if (!committedOwner) {
				// Close the wait-boundary race before degrading to accepted-pending. A
				// launch can become delivered after the helper's last read but before its
				// deadline branch returns; the final durable read must win in that case.
				committedOwner = getGeneralizedLaunchDelivery(
					store,
					generalizedSelection.executionId,
				);
			}
			if (!committedOwner) {
				// The run and launch owner are already durable, so reporting failure here
				// invites a duplicate caller retry. Do not cache this transitional reply:
				// the same idempotency key must be able to upgrade to the delivered 200.
				res.status(202).json({
					success: true,
					pending: true,
					code: "GENERALIZED_LAUNCH_PENDING",
					executionId: generalizedSelection.executionId,
					issueId,
					workflowRunId: generalizedSelection.runId,
					workflowNodeId: generalizedSelection.nodeId,
					// FLY-1372: 202 carries the same advisory echo as the 200.
					...dagAuthority,
					message: `Runner launch accepted for ${issueId}; delivery confirmation is pending.`,
				});
				return;
			}
			store.advanceWorkflowStartStage(
				generalizedSelection.idempotencyKey,
				"launch_committed",
			);
			const response = {
				success: true,
				executionId: generalizedSelection.executionId,
				issueId,
				generalized: true,
				workflowRunId: generalizedSelection.runId,
				workflowNodeId: generalizedSelection.nodeId,
				...dagAuthority,
				message: `Runner started for ${issueId}`,
			};
			store.recordWorkflowStartResponse({
				idempotencyKey: generalizedSelection.idempotencyKey,
				response,
			});
			res.json(response);
			return;
		}

		// FLY-137 Phase 5: snapshot codex-skip label at run start (no mid-run
		// Linear refresh). Semantics: "label the issue before triggering;
		// if you forgot, cancel + retry." Bridge persists this on the session
		// row so event-route's stage_changed handler can check it without
		// touching Linear at transition time.
		// FLY-137 Phase 5 (codex-skip) + FLY-598/FLY-869 (founder-facing-ux):
		// label snapshots at run start. Computation extracted to the shared
		// `computeStartBehaviorSnapshot` helper (FLY-1372 §2.5) — this call site
		// keeps its original position, so the flags-OFF legacy persistence timing
		// is byte-identical. See the helper for the fail-closed label semantics.
		const { codexSkip, founderFacingUx } = await computeStartBehaviorSnapshot();

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
			// (FLY-1372: build extracted to the shared `buildPonytailInput` helper;
			// this call site keeps its original position — identical value/shape.)
			const ponytailInput: PonytailInput = buildPonytailInput();

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
				...(effectiveDesignBackend && {
					designBackend: effectiveDesignBackend,
				}),
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
				...(requestedDesignBackend && effectiveDesignBackend
					? { designBackend: effectiveDesignBackend }
					: {}),
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
