import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { Router } from "express";
import { CommDB } from "flywheel-comm/db";
import { resolveFounderId } from "flywheel-comm/founder-attribution";
import type { FounderUxGateMode } from "flywheel-config";
import {
	adapterTypeToFamily,
	isDesignBackend,
	isFounderUxGateEnabled,
	isSkillFrameworkMode,
	isSkillFrameworkVia,
	isWorkflowPhaseRole,
	resolveCompletionSessionRole,
	type SkillFrameworkMode,
	type SkillFrameworkVia,
	verifyRepositoryBaselineSet,
} from "flywheel-config";
import type { TerminalFailureInfo } from "flywheel-core";
import type { CipherWriter, SnapshotInputDto } from "flywheel-edge-worker";
import { extractDimensions, generatePatternKeys } from "flywheel-edge-worker";
import {
	type AccountRotationNotice,
	formatAccountRotationNotice,
} from "../account-heal/account-rotation-notice.js";
import {
	type ApplyTransitionOpts,
	applyTransition,
} from "../applyTransition.js";
import type { ReconnectController } from "../HeartbeatService.js";
import { type ProjectEntry, resolveLeadForIssue } from "../ProjectConfig.js";
import {
	REVIEW_BINDING_UNBOUND,
	type Session,
	type StateStore,
	type WorkflowCompletionActivationContext,
} from "../StateStore.js";
import { nodeRequiresFounderReview } from "../workflow-run-snapshot.js";
import { handleArtifactEvent } from "./artifact-event.js";
import type { AutoQaCoordinator } from "./auto-qa-coordinator.js";
import { isReviewHeld } from "./auto-qa-held.js";
import type { ChatThreadCreator } from "./ChatThreadCreator.js";
import {
	buildCodexInstruction,
	buildMissingDesignPlanInstruction,
	codexReviewTypeFor,
} from "./codex-instruction.js";
import { commDbPathForProject } from "./commdb-path.js";
import {
	DESIGN_HTML_EVIDENCE_ERROR,
	validateDesignHtmlCompletion,
} from "./design-html-admission.js";
import {
	deliverDesignReviewManifest,
	snapshotDesignReviewPlan,
} from "./design-review-manifest.js";
import {
	hasPendingCompleteMarker,
	isDoneButRunning,
} from "./done-running-reconciler.js";
import type { EventFilter } from "./EventFilter.js";
import {
	evaluateFounderReviewAuthority,
	type FounderReviewAuthorityResult,
	founderReviewCheckpointEnabled,
} from "./founder-review-authority.js";
import { evaluateFounderUxStageGuard } from "./founder-ux/stage-guard.js";
import { buildSessionKey, type HookPayload } from "./hook-payload.js";
import {
	type IssueDisplayRefreshHolder,
	pinRunnerAttachForSession,
	stampStageEmojiForSession,
} from "./issue-display-refresher.js";
import {
	GUARDRAIL_EVENT_TYPES,
	type LeadEventEnvelope,
} from "./lead-runtime.js";
import { makeLinearDoneFinalizer } from "./linear-issue-finalizer.js";
import type { MaterializedHeadAuthority } from "./materialized-head-authority.js";
import {
	computeAuthoritativeShipDecision,
	isMergeBlocked,
	mergedPrCiProbe,
	parkMergeBlock,
} from "./merge-ship-gate.js";
import {
	isPostApproveShipComplete,
	type LifecycleShipInfra,
	makeFinalizeWorkflowPhaseRoles,
	markEvidenceGapCompletion,
	runPostShipFinalization,
	settleShipAttemptFailed,
} from "./post-ship-finalization.js";
import { handleProofShotAutoTrigger } from "./proofshot-trigger.js";
import { resolveBoundRepositoryAuthority } from "./repository-authority.js";
import type { RuntimeRegistry } from "./runtime-registry.js";
import { STAGE_ORDER, VALID_STAGES } from "./stage-utils.js";
import type { TurnBeltReconciler } from "./turn-belt-reconcile.js";
import { type BridgeConfig, sqliteDatetime } from "./types.js";
import type { WorktreeCleanupFn } from "./worktree-cleanup.js";

// Re-export so existing callers (if any) keep working.
export { commDbPathForProject } from "./commdb-path.js";

/**
 * FLY-1329 (A5, Codex R1 HIGH-3): does this runner hold an UNEXPIRED park
 * declaration? The boot sweep (done-running-reconciler) got the parked-veto in
 * PR-A; plan v5 A5 requires the LIVE FLY-324 running→completed path to honour it
 * too (both sites). A runner that declared itself parked is asserting it is alive
 * and waiting — which contradicts a stage=completed force-complete. Readonly and
 * A MISSING comm.db means the runner never opened a channel, so there is no
 * parked signal and the completion is allowed (a genuine completed assertion
 * carries no parked marker). But an UNREADABLE comm.db — one that exists yet
 * throws on open/read (corrupt / locked) — is NOT evidence of "not parked"; it is
 * the absence of evidence, and this force-complete is destructive, so it must
 * FAIL CLOSED (veto) exactly like the boot sweep (Codex R2 HIGH).
 */
function isRunnerDeclaredParked(execId: string, projectName: string): boolean {
	if (/[/\\]|\.\./.test(projectName)) return false;
	const dbPath = commDbPathForProject(projectName);
	if (!existsSync(dbPath)) return false; // no channel opened = no parked signal
	let declaredDb: CommDB | undefined;
	try {
		declaredDb = CommDB.openReadonly(dbPath);
		return (
			declaredDb.getEffectiveDeclaredState(execId, Date.now())?.kind ===
			"parked"
		);
	} catch {
		// A comm.db that exists but cannot be read is unresolved, not "not parked".
		// Fail closed: treat as parked so the destructive completion is vetoed.
		return true;
	} finally {
		declaredDb?.close();
	}
}

interface IngestEvent {
	event_id: string;
	execution_id: string;
	issue_id: string;
	project_name: string;
	event_type: string;
	payload?: Record<string, unknown>;
	source?: string;
}

/** Coerce a value to string or undefined — prevents non-string payload fields from crashing upsertSession. */
function asString(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

/**
 * GEO-202: Resolve issue_identifier from payload, falling back to issue_id.
 * Prevents null issue_identifier in sessions when the event payload
 * omits issueIdentifier (e.g., fire-and-forget session_started lost,
 * or emitter didn't include it).
 *
 * Returns undefined (not the fallback) when payload has a valid identifier,
 * so that SQL COALESCE(excluded, existing) can preserve a better existing value.
 * The fallback is only used when the payload has NO identifier at all.
 */
function resolveIdentifier(
	payload: Record<string, unknown>,
	fallbackIssueId: string,
): string {
	const fromPayload = asString(payload.issueIdentifier);
	return fromPayload && fromPayload.length > 0 ? fromPayload : fallbackIssueId;
}

/** Coerce a value to number or undefined. */
function asNumber(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asWorkflowCompletionActivation(
	value: unknown,
): WorkflowCompletionActivationContext | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const activationId = asString(record.activationId);
	const runId = asString(record.runId);
	const nodeId = asString(record.nodeId);
	const attempt = asNumber(record.attempt);
	const turnEpoch = asNumber(record.turnEpoch);
	if (
		!activationId ||
		!runId ||
		!nodeId ||
		!Number.isInteger(attempt) ||
		(attempt ?? 0) < 1 ||
		!Number.isInteger(turnEpoch) ||
		(turnEpoch ?? 0) < 1
	) {
		return undefined;
	}
	return {
		activationId,
		runId,
		nodeId,
		attempt: attempt!,
		turnEpoch: turnEpoch!,
	};
}

function asTerminalFailureInfo(v: unknown): TerminalFailureInfo | undefined {
	if (!v || typeof v !== "object") return undefined;
	const failure = v as Record<string, unknown>;
	const failureKind = asString(failure.failureKind);
	const failureReason = asString(failure.failureReason);
	if (
		(failureKind !== "goal_blocked" &&
			failureKind !== "worktree_takeover_failed") ||
		!failureReason
	) {
		return undefined;
	}
	return { failureKind, failureReason };
}

function formatNotification(session: Session, eventType: string): string {
	const id = session.issue_identifier ?? session.issue_id;
	switch (eventType) {
		case "session_completed":
			if (session.decision_route === "auto_approve") {
				if (session.status === "approved") {
					return `[Already Merged] ${id}: ${session.issue_title ?? ""}. PR was already merged.`;
				}
				return `[Review Required] ${id}: ${session.issue_title ?? ""}. ${session.commit_count ?? 0} commits. Awaiting CEO approval.`;
			}
			if (session.decision_route === "needs_review") {
				return `[Review Required] ${id}: ${session.issue_title ?? ""}. ${session.commit_count ?? 0} commits, +${session.lines_added ?? 0}/-${session.lines_removed ?? 0} lines. Please review.`;
			}
			if (session.decision_route === "blocked") {
				return `[Blocked] ${id}: ${session.issue_title ?? ""}. Reason: ${session.decision_reasoning ?? "unknown"}`;
			}
			return `[Completed] ${id}: ${session.issue_title ?? ""}`;
		case "session_failed":
			return `[Failed] ${id}: ${session.issue_title ?? ""}. Error: ${session.last_error ?? "unknown"}`;
		case "session_started":
			return `[Started] ${id}: ${session.issue_title ?? ""}`;
		default:
			return `[${eventType}] ${id}`;
	}
}

// ---------------------------------------------------------------------------
// FLY-137 Phase 5: Codex auto-trigger helpers.
//
// On `stage_changed` to `design_review` or `pr_created`, Bridge either:
//   (a) writes a skip.json marker under the Runner's worktree codex dir
//       (when codex-skip label was snapshotted at run start), so the
//       Runner's `await-codex-gate` bypass-exits 0 immediately; OR
//   (b) writes a CommDB instruction telling the Runner to run
//       `/codex-design-review <plan>` or `/codex-code-review`, then call
//       `flywheel-comm await-codex-gate <type>` before advancing stages.
//
// Bridge ONLY writes skip.json — Runner/Codex writes the result JSON
// (design-review.json / code-review.json). This keeps the gate from
// being self-authorizing.
// ---------------------------------------------------------------------------

// commDbPathForProject moved to "./commdb-path.js" so the helper is shared with proofshot-trigger.ts.

/**
 * Resolve the Runner worktree path for the session. Falls back to
 * `${HOME}/Dev/<projectName>/worktrees/<execId>` only if session is
 * missing — normally Blueprint patches `worktree_path` after worktree
 * creation, so the stored value should be present by the time
 * design_review or pr_created fires.
 */
function resolveWorktreeForCodex(
	session: Session | undefined,
	projectName: string,
	executionId: string,
): string {
	if (session?.worktree_path && session.worktree_path.length > 0) {
		return session.worktree_path;
	}
	// Defensive fallback. Logged by caller.
	return join(homedir(), "Dev", projectName, "worktrees", executionId);
}

/**
 * Atomically write a JSON payload into the codex dir under
 * `<worktree>/.flywheel/runs/<execId>/codex/<file>`. Writes to a tmp
 * file then `rename()` (POSIX atomic). Returns the resolved absolute
 * path on success; throws on error (caller handles).
 */
function writeCodexJsonAtomic(
	worktree: string,
	executionId: string,
	fileName: string,
	payload: unknown,
): string {
	const dir = resolvePath(worktree, ".flywheel", "runs", executionId, "codex");
	mkdirSync(dir, { recursive: true });
	const finalPath = join(dir, fileName);
	const tmpPath = `${finalPath}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
	renameSync(tmpPath, finalPath);
	return finalPath;
}

function isSafePlanPath(planPath: string): boolean {
	if (typeof planPath !== "string" || planPath.length === 0) return false;
	if (isAbsolute(planPath)) return false;
	if (planPath.split("/").some((seg) => seg === "..")) return false;
	return true;
}

/**
 * Handle stage_changed → design_review / pr_created. Reads session
 * state (codex_skip + worktree_path + plan_path) and either writes
 * skip.json or writes a CommDB instruction to the Runner inbox.
 * Failures are logged + non-fatal; the parent stage transition still
 * succeeds.
 */
function handleCodexAutoTrigger(
	store: StateStore,
	event: IngestEvent,
	stage: string,
	payloadPlanPath: string | undefined,
): void {
	const reviewType = codexReviewTypeFor(stage);
	if (!reviewType) return;

	const session = store.getSession(event.execution_id);
	const worktree = resolveWorktreeForCodex(
		session,
		event.project_name,
		event.execution_id,
	);

	// Persist plan_path from the payload (if provided + safe). Even on
	// the skip path we still record it for audit/diagnostics.
	if (reviewType === "design" && payloadPlanPath !== undefined) {
		if (!isSafePlanPath(payloadPlanPath)) {
			console.warn(
				`[codex-trigger] unsafe plan_path rejected for ${event.execution_id}: ${payloadPlanPath}`,
			);
		} else {
			store.patchSessionMetadata(event.execution_id, {
				plan_path: payloadPlanPath,
			});
		}
	}

	const refreshedSession = store.getSession(event.execution_id);
	const codexSkip = !!refreshedSession?.codex_skip;
	const persistedPlanPath = refreshedSession?.plan_path;
	const queueDesignPlanCorrection = (detail?: string): void => {
		try {
			const dbPath = commDbPathForProject(event.project_name);
			mkdirSync(dirname(dbPath), { recursive: true });
			const commDb = new CommDB(dbPath);
			try {
				commDb.insertInstruction(
					"bridge",
					event.execution_id,
					buildMissingDesignPlanInstruction(event.execution_id, detail),
				);
				console.log(
					`[codex-trigger] unbindable plan — correction instruction sent for ${event.execution_id}`,
				);
			} finally {
				commDb.close();
			}
		} catch (err) {
			console.warn(
				`[codex-trigger] failed to write plan correction instruction for ${event.execution_id}: ${(err as Error).message}`,
			);
		}
	};

	// FLY-827: for CODE review, register the durable gate record (audit-friendly;
	// the gate truth is an approved/skipped record for the CURRENT head or
	// session.codex_skip — NOT a pending row). pr_head_sha is usually absent at
	// pr_created (setReviewBinding writes it on the completion event), so this only
	// fires when a head is already bound; the codex_skip session flag carries the
	// bypass otherwise.
	if (reviewType === "code") {
		const head = refreshedSession?.pr_head_sha?.toLowerCase();
		if (head && /^[0-9a-f]{40}$/.test(head)) {
			if (codexSkip) {
				store.markCodexReviewSkipped({
					executionId: event.execution_id,
					targetPrHeadSha: head,
					issueId: event.issue_id,
					projectName: event.project_name,
				});
			} else {
				store.upsertCodexReviewPending({
					executionId: event.execution_id,
					targetPrHeadSha: head,
					issueId: event.issue_id,
					projectName: event.project_name,
				});
			}
		}
	}

	// FLY-1188 §7.1: codex-tmux AUTHORS do not use the legacy codex-reviewer
	// trigger (skip.json / await-codex-gate instruction). Their review lane is
	// event-driven: the runner opens a review gate and registers a request via
	// `/review-requests`; the ReviewRequestCoordinator runs the cross-family
	// Claude reviewer and answers the bound question. The durable FLY-827
	// record registration above still applies (gate state, not a trigger).
	// claude / NULL authors keep the path below byte-for-byte.
	if ((refreshedSession?.adapter_type ?? "claude-tmux") === "codex-tmux") {
		console.log(
			`[codex-trigger] ${event.execution_id} is a codex-tmux author — ${reviewType} review is request-driven (FLY-1188 §7.1); legacy trigger skipped`,
		);
		return;
	}

	if (codexSkip) {
		try {
			const skipPath = writeCodexJsonAtomic(
				worktree,
				event.execution_id,
				"skip.json",
				{
					executionId: event.execution_id,
					reviewType,
					reason: "codex-skip-label",
					timestamp: new Date().toISOString(),
				},
			);
			console.log(
				`[codex-trigger] skip ${reviewType} review for ${event.execution_id} (codex-skip label) → ${skipPath}`,
			);
		} catch (err) {
			console.warn(
				`[codex-trigger] failed to write skip.json for ${event.execution_id}: ${(err as Error).message}`,
			);
		}
		return;
	}

	// Missing plan_path on design_review → fail-closed instruction so
	// Runner re-issues stage with --plan; await-codex-gate will time
	// out (no skip.json, no result) → Runner reports to Lead.
	if (reviewType === "design" && !persistedPlanPath) {
		queueDesignPlanCorrection("stage_changed requires --plan <relative-path>");
		return;
	}

	// FLY-1718 P3: default-on exact plan binding. The manifest write precedes
	// CommDB delivery; a stable instruction id plus boot/periodic reconciliation
	// closes the crash window between those two durable stores.
	if (
		reviewType === "design" &&
		process.env.FLYWHEEL_INSTRUCTION_PATH_CHECK !== "0"
	) {
		if (!refreshedSession || !persistedPlanPath) return;
		const snapshot = snapshotDesignReviewPlan(
			refreshedSession,
			persistedPlanPath,
		);
		if (!snapshot.ok) {
			queueDesignPlanCorrection(snapshot.message);
			return;
		}
		try {
			const manifest = store.advanceDesignReviewManifest({
				executionId: event.execution_id,
				projectName: event.project_name,
				sourceEventId: event.event_id,
				expectedPlanPath: persistedPlanPath,
				expectedBlobSha: snapshot.blobSha,
			});
			const delivered = deliverDesignReviewManifest(store, manifest);
			console.log(
				`[codex-trigger] ${delivered.deduped ? "reconciled" : "queued"} design review manifest ${event.execution_id}/${manifest.revision}`,
			);
		} catch (err) {
			console.warn(
				`[codex-trigger] failed to bind/deliver design instruction for ${event.execution_id}: ${(err as Error).message}`,
			);
		}
		return;
	}

	// Happy path: write the Codex review instruction to the Runner inbox.
	try {
		const dbPath = commDbPathForProject(event.project_name);
		mkdirSync(dirname(dbPath), { recursive: true });
		const commDb = new CommDB(dbPath);
		try {
			const content = buildCodexInstruction(
				reviewType,
				persistedPlanPath,
				event.execution_id,
			);
			commDb.insertInstruction("bridge", event.execution_id, content);
			console.log(
				`[codex-trigger] queued ${reviewType} review instruction for ${event.execution_id}`,
			);
		} finally {
			commDb.close();
		}
	} catch (err) {
		console.warn(
			`[codex-trigger] failed to write instruction for ${event.execution_id}: ${(err as Error).message}`,
		);
	}
}

// FLY-907: `parseIssueLabels`, `issueStatusWordEnabled`, and the two legacy
// stage_changed display renderers (`stampStageEmojiForSession`,
// `pinRunnerAttachForSession`, incl. the FLY-892 HEADER_DONE_STATUSES set)
// moved verbatim to `issue-display-refresher.ts` — event-route keeps thin
// forwards. When the unified refresher holder is wired (default), the
// stage_changed branch enqueues a full derive-from-state refresh instead; the
// legacy functions remain the `FLYWHEEL_ISSUE_DISPLAY_REFRESH=0` escape hatch.

export function createEventRouter(
	store: StateStore,
	projects: ProjectEntry[],
	config: BridgeConfig,
	cipherWriter?: CipherWriter,
	transitionOpts?: ApplyTransitionOpts,
	eventFilter?: EventFilter,
	registry?: RuntimeRegistry,
	chatThreadCreator?: ChatThreadCreator,
	// FLY-603 Layer A: optional worktree-cleanup closure (composition root).
	removeCleanWorktree?: WorktreeCleanupFn,
	// FLY-560 Feature C: independent gating for the two chat-thread behaviours
	// (emoji stamp vs attach pin). Defaults keep byte-compat: when a creator is
	// passed without flags, emoji stamping stays ON (Feature A) and attach pin
	// stays OFF (opt-in). plugin.ts passes the resolved env flags.
	featureFlags?: {
		issueStatusEmojiEnabled?: boolean;
		issueAttachPinEnabled?: boolean;
	},
	// FLY-623: late-bound holder → live HeartbeatService reconnecting set. A
	// genuine, accepted runner event proves the runner's event channel is live
	// again, so it leaves the reconnecting state (resumes normal monitoring +
	// clears the "⚠️重连中" title). Absent / kill-switch → no-op.
	reconnectHolder?: { current: ReconnectController | null },
	// FLY-579: auto-QA pipeline coordinator, passed as a late-bound holder (same
	// pattern as reconnectHolder) because it is built AFTER createBridgeApp returns
	// (it needs the LeadAlertNotifier, constructed later in startBridge). A main
	// session entering awaiting_review spawns independent QA + holds the founder;
	// qa_result events drive the verdict. Holder absent / .current undefined →
	// existing behaviour byte-for-byte (no held records exist, isQaHeld is false).
	autoQaCoordinator?: { current: AutoQaCoordinator | undefined },
	turnBeltReconciler?: { current: TurnBeltReconciler | undefined },
	// FLY-696 M1/④: late-bound Alerts-post for `account_rotation` events. Built in
	// startBridge (needs the unified-channel DiscordOps, constructed after this
	// router). `.current` undefined ⇒ the event is acked but not posted (byte-compat:
	// no unified channel = no self-heal Alerts surface). FLY-929 A4: the structured
	// notice rides along as an optional second argument for the notify digest.
	accountRotationPost?: {
		current?: (
			detail: string,
			rotation?: AccountRotationNotice,
		) => Promise<void>;
	},
	// FLY-907: late-bound unified issue-display refresher. `.current` set (the
	// default once startBridge wires it) → stage_changed enqueues ONE unified
	// derive-from-state refresh of all three faces; unset (byte-compat /
	// FLYWHEEL_ISSUE_DISPLAY_REFRESH=0) → the legacy per-face stamp+pin path.
	issueDisplayRefresh?: IssueDisplayRefreshHolder,
	// FLY-1185: the ship-entry lifecycle bundle (remote branch CAS + issue
	// closeout + trailing sweep) built once at the composition root. Absent →
	// classic finalization only (byte-compat).
	lifecycleInfra?: LifecycleShipInfra,
	// FLY-1282 Part C: targeted terminal-archive enqueue (pre-binding buffer →
	// FLY-1165 scheduler consumer). The composition root injects this ONLY when
	// FLYWHEEL_TERMINAL_THREAD_ARCHIVE is ON (single boot-time capture);
	// absent → zero enqueue (byte-compat).
	terminalArchiveEnqueue?: (issueId: string) => void,
	// FLY-1307 PR-7.5: trusted receipt-backed head for output-backed reviews.
	materializedHeadAuthority?: MaterializedHeadAuthority,
): Router {
	const router = Router();
	const issueStatusEmojiEnabled =
		featureFlags?.issueStatusEmojiEnabled !== false;
	const issueAttachPinEnabled = featureFlags?.issueAttachPinEnabled === true;
	// FLY-887: ship-time DAG workflow finalizer (built once; needs
	// transitionOpts to close parked phases through the FSM). Undefined without
	// transitionOpts → runPostShipFinalization skips it (byte-compat).
	const finalizeWorkflowPhaseRoles = transitionOpts
		? makeFinalizeWorkflowPhaseRoles(
				store,
				transitionOpts,
				(issueId) =>
					// FLY-907: the post-close refresh now drives ALL THREE faces via the
					// unified refresher (late-bound holder; absent → no refresh).
					issueDisplayRefresh?.current?.refresh(issueId) ?? Promise.resolve(),
			)
		: undefined;

	// Dedicated heartbeat route — lightweight, no session_events write, no lead notification
	router.post("/heartbeat", (req, res) => {
		const body = req.body as { execution_id?: string } | undefined;
		if (
			!body ||
			typeof body.execution_id !== "string" ||
			body.execution_id.length === 0
		) {
			res.status(400).json({ error: "missing or invalid field: execution_id" });
			return;
		}
		store.updateHeartbeat(body.execution_id);
		res.json({ ok: true });
	});

	router.post("/", async (req, res) => {
		const event = req.body as IngestEvent | undefined;
		if (!event || typeof event !== "object") {
			res.status(400).json({ error: "expected JSON object" });
			return;
		}

		// FLY-696 M1/④: a Codex per-runner account rotation notice. Handled BEFORE
		// the issue/execution required-field validation below — it is a fleet-global
		// visibility event (no issue/execution semantics; the emitter may not know
		// either) carrying only provider/to/reason/... in its payload. Post one line
		// to the unified Alerts channel via the late-bound callback, then ack.
		// Best-effort by contract (the emitter calls it with `|| true`); a missing
		// callback (no unified channel) or a failed POST never fails the request.
		if (event.event_type === "account_rotation") {
			const rot = (event.payload ?? {}) as Record<string, unknown>;
			const provider = asString(rot.provider);
			const to = asString(rot.to);
			if (!provider || !to) {
				res.status(400).json({
					error:
						"account_rotation: payload.provider and payload.to are required",
				});
				return;
			}
			// FLY-929 A4: keep the STRUCTURED notice and pass it alongside the
			// formatted Alerts line, so the plugin's post site can build the
			// #flywheel-notify digest from structured data instead of re-parsing
			// human text (Codex design R1#3). Detail-only impls stay valid.
			const notice: AccountRotationNotice = {
				provider,
				to,
				from: asString(rot.from),
				reason: asString(rot.reason),
				resetAt: asString(rot.resetAt),
			};
			const detail = formatAccountRotationNotice(notice);
			const post = accountRotationPost?.current;
			if (post) {
				try {
					await post(detail, notice);
				} catch (err) {
					console.error(
						`[event-route] account_rotation post failed: ${(err as Error).message}`,
					);
				}
			}
			res.json({ ok: true });
			return;
		}

		// Validate required fields
		const required = [
			"event_id",
			"execution_id",
			"issue_id",
			"project_name",
			"event_type",
		] as const;
		for (const field of required) {
			if (typeof event[field] !== "string" || event[field].length === 0) {
				res.status(400).json({ error: `missing or invalid field: ${field}` });
				return;
			}
		}

		let workflowNodeId: string | undefined;
		if (
			event.event_type === "session_started" ||
			event.event_type === "session_completed" ||
			event.event_type === "session_failed"
		) {
			try {
				workflowNodeId = store.resolveWorkflowNodeIdForExecution(
					event.execution_id,
				);
			} catch (err) {
				res.status(409).json({
					error: "workflow_node_identity_conflict",
					detail: (err as Error).message,
				});
				return;
			}
		}

		if (event.event_type === "session_completed") {
			const decision =
				event.payload?.decision &&
				typeof event.payload.decision === "object" &&
				!Array.isArray(event.payload.decision)
					? (event.payload.decision as Record<string, unknown>)
					: undefined;
			const route = asString(decision?.route);
			const existingIdentifier = store.getSession(
				event.execution_id,
			)?.issue_identifier;
			const authoritativeIssueIdentifier =
				typeof existingIdentifier === "string" &&
				/^[A-Z]+-\d+$/.test(existingIdentifier)
					? existingIdentifier
					: /^[A-Z]+-\d+$/.test(event.issue_id)
						? event.issue_id
						: undefined;
			const designHtmlAdmission = validateDesignHtmlCompletion({
				route,
				payload: event.payload,
				authoritativeIssueIdentifier,
				gateDisabled: process.env.FLYWHEEL_DESIGN_HTML_GATE === "0",
			});
			if (!designHtmlAdmission.ok) {
				res.status(409).json({
					error: DESIGN_HTML_EVIDENCE_ERROR,
					reason: designHtmlAdmission.reason,
					remediation: designHtmlAdmission.remediation,
				});
				return;
			}
			if (designHtmlAdmission.disabled) {
				console.warn(
					"[event-route] design-HTML gate DISABLED via FLYWHEEL_DESIGN_HTML_GATE=0 — skipping founder design HTML validation",
				);
			}
		}

		if (event.event_type === "session_completed") {
			if (event.source === "flywheel-comm") {
				const decision =
					event.payload?.decision &&
					typeof event.payload.decision === "object" &&
					!Array.isArray(event.payload.decision)
						? (event.payload.decision as Record<string, unknown>)
						: undefined;
				const rawWorkflowActivation = event.payload?.workflowActivation;
				const rawCompletionEvidence =
					event.payload?.evidence &&
					typeof event.payload.evidence === "object" &&
					!Array.isArray(event.payload.evidence)
						? (event.payload.evidence as Record<string, unknown>)
						: undefined;
				const completionHeadRaw = asString(
					rawCompletionEvidence?.headSha,
				)?.toLowerCase();
				const callerCompletionHead =
					completionHeadRaw && /^[0-9a-f]{40}$/.test(completionHeadRaw)
						? completionHeadRaw
						: undefined;
				const workflowActivation = asWorkflowCompletionActivation(
					rawWorkflowActivation,
				);
				if (rawWorkflowActivation !== undefined && !workflowActivation) {
					res.status(409).json({
						error: "workflow_completion_rejected",
						reason: "invalid_activation_context",
					});
					return;
				}
				const generalizedContext = workflowActivation
					? store.getGeneralizedWorkflowNodeForActivation(
							workflowActivation.activationId,
						)
					: store.getGeneralizedWorkflowNodeForExecution(event.execution_id);
				const completionRoute = asString(decision?.route) ?? "";
				let completionHead = callerCompletionHead;
				let completionRepoPath: string | undefined;
				let noCodeAttestation:
					| {
							worktreeBindingGeneration: string;
							baselineDigest: string;
							currentDigest: string;
					  }
					| undefined;
				let prBinding:
					| {
							prNumber: number;
							headSha: string;
							targetRepoIdentity: string;
							probeRepoSlug: string;
							targetRepoPath: string;
							worktreeBindingGeneration: string;
					  }
					| undefined;
				if (generalizedContext) {
					const landing =
						rawCompletionEvidence?.landingStatus &&
						typeof rawCompletionEvidence.landingStatus === "object" &&
						!Array.isArray(rawCompletionEvidence.landingStatus)
							? (rawCompletionEvidence.landingStatus as Record<string, unknown>)
							: undefined;
					const prNumber = Number(landing?.prNumber);
					const targetRepoPath = asString(landing?.targetRepoPath);
					const hasPrEvidence =
						landing !== undefined &&
						Number.isSafeInteger(prNumber) &&
						prNumber > 0;
					if (
						landing &&
						!hasPrEvidence &&
						(asString(landing.status) === "ready_to_merge" ||
							targetRepoPath !== undefined)
					) {
						res.status(422).json({
							error: "workflow_pr_binding_rejected",
							reason: "invalid_pr_number",
						});
						return;
					}
					const worktreeBinding = store.getWorktreeBinding(event.execution_id);
					if (
						completionRoute === "no_code" &&
						worktreeBinding?.repoBaselineSetJson &&
						worktreeBinding.repoBaselineSetDigest
					) {
						const verified = verifyRepositoryBaselineSet({
							authorityRoot: worktreeBinding.path,
							baselineJson: worktreeBinding.repoBaselineSetJson,
							baselineDigest: worktreeBinding.repoBaselineSetDigest,
						});
						if (verified.ok) {
							noCodeAttestation = {
								worktreeBindingGeneration: worktreeBinding.generation,
								baselineDigest: worktreeBinding.repoBaselineSetDigest,
								currentDigest: verified.currentDigest,
							};
						} else {
							console.warn(
								`[event-route] no_code repository proof refused for ${event.execution_id}: ${verified.reason}`,
							);
						}
					}
					if (worktreeBinding) {
						completionRepoPath = worktreeBinding.path;
						try {
							const authority = await resolveBoundRepositoryAuthority({
								authorityRoot: worktreeBinding.path,
								...(targetRepoPath
									? { requestedRepoPath: targetRepoPath }
									: {}),
							});
							completionHead = authority.headSha;
							completionRepoPath = authority.path;
							if (
								callerCompletionHead &&
								callerCompletionHead !== authority.headSha
							) {
								console.warn(
									`[event-route] rejected caller PR head ${callerCompletionHead} for ${event.execution_id}; server authority is ${authority.headSha}`,
								);
							} else if (
								hasPrEvidence &&
								callerCompletionHead === authority.headSha
							) {
								prBinding = {
									prNumber,
									headSha: authority.headSha,
									targetRepoIdentity: authority.identity,
									probeRepoSlug: authority.probeRepoSlug,
									targetRepoPath: authority.path,
									worktreeBindingGeneration: worktreeBinding.generation,
								};
							} else if (hasPrEvidence) {
								console.warn(
									`[event-route] generalized PR #${prNumber} for ${event.execution_id} was not bound because evidence.headSha is missing`,
								);
							}
						} catch (error) {
							completionHead = undefined;
							if (hasPrEvidence) {
								res.status(422).json({
									error: "workflow_pr_binding_rejected",
									reason: "repository_authority_unavailable",
									detail:
										error instanceof Error ? error.message : String(error),
								});
								return;
							}
							console.warn(
								`[event-route] generalized PR authority unavailable for ${event.execution_id}; completion continues without PR evidence: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
					} else if (hasPrEvidence) {
						res.status(422).json({
							error: "workflow_pr_binding_rejected",
							reason: "worktree_binding_missing",
						});
						return;
					} else if (landing || callerCompletionHead) {
						completionHead = undefined;
						console.warn(
							`[event-route] generalized PR evidence ignored for ${event.execution_id}: immutable worktree binding missing`,
						);
					}
				}
				let alertIdentity:
					| {
							leadId: string;
							projectName: string;
							leadResolution: "resolved" | "fallback";
					  }
					| undefined;
				if (generalizedContext) {
					const projectName = generalizedContext.run.project_name;
					const session = store.getSessionByIssue(
						generalizedContext.run.issue_id,
					);
					try {
						const labels = session
							? store.getSessionLabels(session.execution_id)
							: [];
						alertIdentity = {
							leadId: resolveLeadForIssue(projects, projectName, labels).lead
								.agentId,
							projectName,
							leadResolution: "resolved",
						};
					} catch {
						alertIdentity = {
							leadId: config.defaultLeadAgentId,
							projectName,
							leadResolution: "fallback",
						};
					}
				}
				if (
					generalizedContext &&
					nodeRequiresFounderReview(
						generalizedContext.snapshot,
						generalizedContext.node.id,
					)
				) {
					const project = projects.find(
						(candidate) =>
							candidate.projectName === generalizedContext.run.project_name,
					);
					if (!project) {
						res.status(409).json({
							error: "founder_review_required",
							reason: "project_authority_missing",
						});
						return;
					}
					let enabled: boolean;
					try {
						enabled = await founderReviewCheckpointEnabled(project.projectRoot);
					} catch (error) {
						res.status(409).json({
							error: "founder_review_required",
							reason: "checkpoint_config_invalid",
							detail: error instanceof Error ? error.message : String(error),
						});
						return;
					}
					if (enabled && (!completionHead || !completionRepoPath)) {
						res.status(409).json({
							error: "founder_review_required",
							reason: "repository_authority_missing",
						});
						return;
					}
					if (completionHead && completionRepoPath) {
						let authority: FounderReviewAuthorityResult;
						try {
							authority = evaluateFounderReviewAuthority({
								enabled,
								store,
								commDbPath: commDbPathForProject(
									generalizedContext.run.project_name,
								),
								runId: generalizedContext.run.run_id,
								nodeId: generalizedContext.node.id,
								snapshot: generalizedContext.snapshot,
								repoRoot: completionRepoPath,
								head: completionHead,
								founderId: resolveFounderId({ processEnv: process.env }),
							});
						} catch (error) {
							res.status(409).json({
								error: "founder_review_required",
								reason: "authority_unavailable",
								detail: error instanceof Error ? error.message : String(error),
							});
							return;
						}
						if (authority.required && authority.verdict.status !== "passed") {
							res.status(409).json({
								error: "founder_review_required",
								reason: authority.verdict.status,
								...("reason" in authority.verdict
									? { detail: authority.verdict.reason }
									: {}),
							});
							return;
						}
					}
				}
				const completion = store.commitEnrolledCompletion({
					executionId: event.execution_id,
					route: completionRoute,
					sourceEventId: event.event_id,
					completionSubmission: event.payload ?? {},
					...(completionHead ? { subjectDigest: completionHead } : {}),
					...(workflowActivation ? { workflowActivation } : {}),
					...(prBinding ? { prBinding } : {}),
					...(noCodeAttestation ? { noCodeAttestation } : {}),
					alertIdentity,
				});
				if (
					!(completion.ok === false && completion.reason === "not_enrolled")
				) {
					if (!completion.ok) {
						if (completion.reason === "stale_execution_superseded") {
							res.json({
								ok: true,
								generalized: true,
								settled: "stale_execution_superseded",
							});
							return;
						}
						if (completion.reason === "stale_resubmission") {
							res.json({
								ok: true,
								generalized: true,
								settled: "stale_resubmission_escalated",
							});
							return;
						}
						if (completion.reason === "terminal_status_immune") {
							res.json({
								ok: true,
								generalized: true,
								settled: "terminal_status_immune",
							});
							return;
						}
						res.status(409).json({
							error:
								completion.reason === "missing_output"
									? "workflow_output_required"
									: "workflow_completion_rejected",
							reason: completion.reason,
							...("detail" in completion ? { detail: completion.detail } : {}),
							...("retryable" in completion
								? { retryable: completion.retryable }
								: {}),
						});
						return;
					}
					store.insertEvent({
						event_id: `wfca:${completion.eventUid.slice("wfc:".length)}`,
						execution_id: event.execution_id,
						issue_id: event.issue_id,
						project_name: event.project_name,
						event_type: "session_completed",
						payload: event.payload,
						source: "workflow-generalized-completion",
					});
					res.json({
						ok: true,
						generalized: true,
						duplicate: completion.idempotentReplay,
						...(completion.completionDisposition
							? {
									completionDisposition: completion.completionDisposition,
								}
							: {}),
					});
					return;
				}
			} else {
				const generalized = store.getGeneralizedWorkflowNodeForExecution(
					event.execution_id,
				);
				if (generalized) {
					const recorded = store.recordEnrolledTerminalSignal({
						executionId: event.execution_id,
						sourceEventId: event.event_id,
						signal: "completed",
						source:
							typeof event.source === "string" ? event.source : "orchestrator",
					});
					if (!recorded.ok) {
						res.status(409).json({
							error: "workflow_teardown_record_rejected",
							reason: recorded.reason,
						});
						return;
					}
					res.json({
						ok: true,
						generalized: true,
						teardown: "held_recorded",
						duplicate: recorded.idempotentReplay,
						statusPreserved: recorded.statusPreserved,
					});
					return;
				}
			}
		} else if (event.event_type === "session_failed") {
			const generalized = store.getGeneralizedWorkflowNodeForExecution(
				event.execution_id,
			);
			if (generalized) {
				const failure = asTerminalFailureInfo(event.payload?.failure);
				const recorded = store.recordEnrolledTerminalSignal({
					executionId: event.execution_id,
					sourceEventId: event.event_id,
					signal: "failed",
					failureKind: failure?.failureKind,
					lastError:
						failure?.failureKind === "goal_blocked"
							? failure.failureReason
							: asString(event.payload?.error),
					source:
						typeof event.source === "string" ? event.source : "orchestrator",
				});
				if (!recorded.ok) {
					res.status(409).json({
						error: "workflow_teardown_record_rejected",
						reason: recorded.reason,
					});
					return;
				}
				if (failure?.failureKind === "worktree_takeover_failed") {
					const failedSession = store.getSession(event.execution_id);
					if (failedSession) {
						await turnBeltReconciler?.current?.alertWorktreeTakeoverFailure(
							failedSession,
							failure.failureReason,
						);
					}
				}
				res.json({
					ok: true,
					generalized: true,
					teardown: "held_recorded",
					duplicate: recorded.idempotentReplay,
					statusPreserved: recorded.statusPreserved,
				});
				return;
			}
		}

		// FLY-1425: generalized workflow verdicts are capability-backed engine
		// decisions. Accepting one through the legacy event endpoint would return
		// 200 without consuming the credential or advancing the DAG. Reject before
		// idempotency storage so a misroute can never look successful or pollute the
		// legacy QA paths. Shadow/legacy runs remain byte-compatible.
		if (
			event.event_type === "qa_result" &&
			store.isWorkflowEngineOwnedExecution(event.execution_id)
		) {
			res.status(409).json({
				ok: false,
				reason: "workflow_submission_required",
				hint: "Submit this verdict to /api/workflow/decision with the original FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL; do not strip the runner environment.",
			});
			return;
		}

		// Store event (idempotent)
		const isNew = store.insertEvent({
			event_id: event.event_id,
			execution_id: event.execution_id,
			issue_id: event.issue_id,
			project_name: event.project_name,
			event_type: event.event_type,
			payload: event.payload,
			source: typeof event.source === "string" ? event.source : "orchestrator",
		});

		if (!isNew) {
			res.json({ ok: true, duplicate: true });
			return;
		}

		// FLY-579: a QA verdict is not a session-lifecycle transition (the QA
		// session's own completion is separate). Drive the coordinator's PASS/FAIL
		// branch and return. Idempotency is enforced by insertEvent dedup (above)
		// AND the coordinator's record-status check (defence in depth).
		//
		if (event.event_type === "qa_result") {
			if (autoQaCoordinator?.current) {
				try {
					await autoQaCoordinator.current.onQaResult(event);
				} catch (err) {
					console.error(
						`[event-route] onQaResult threw for ${event.execution_id}: ${(err as Error).message}`,
					);
				}
			}
			res.json({ ok: true });
			return;
		}

		// FLY-827: a Codex CODE review verdict (from `await-codex-gate code`). Record
		// the durable approval + (race closure) re-drive QA if the parent already
		// reached awaiting_review. Not a session-lifecycle transition — return early.
		if (event.event_type === "codex_review_result") {
			if (autoQaCoordinator?.current) {
				try {
					await autoQaCoordinator.current.onCodexReviewResult(event);
				} catch (err) {
					console.error(
						`[event-route] onCodexReviewResult threw for ${event.execution_id}: ${(err as Error).message}`,
					);
				}
			}
			res.json({ ok: true });
			return;
		}

		// FLY-623 (Codex code-review R1 HIGH): clearing reconnecting must happen
		// ONLY after an event is genuinely ACCEPTED + PERSISTED — never here, right
		// after the dedup guard, because a malformed / spurious / invalid-route
		// terminal event passes the dedup but then early-returns (non-running guard,
		// FSM rejection, invalid route) leaving the session `running`. Clearing here
		// would let such an event strip the reconnecting suppression + "⚠️重连中"
		// title and let false stuck/idle/orphan alarms resume. Instead: clear inside
		// the accepted+persisted `stage_changed` path (below, the live-progress
		// proof), and let the reconcile cycle's `status !== "running"` check own
		// terminal removal (post-persist, so a rejected terminal never clears).

		// Update session read model
		const now = sqliteDatetime();
		const payload = event.payload ?? {};
		let transitionRejected = false;
		// FLY-1282 Part C: source-side exclusions for the targeted
		// terminal-archive enqueue at the end of this handler. Post-ship
		// completions (runPostShipFinalization owns the cleanup→archive order
		// exclusively) and FLY-208 evidence-gap completions (FLY-210 / manual
		// close owns them) never enqueue. stage_changed only enqueues via the
		// accepted FLY-324 running→completed transition — the W2 merged branch
		// is structurally excluded (post-ship owner).
		let terminalArchiveExcluded = false;
		let fly324Completed = false;
		// FLY-752: capture the PRE-transition status so the auto-QA coordinator can
		// tell a genuine FRESH review-pass (running/other → awaiting_review) from a
		// re-emitted / parked-waiting-for-founder awaiting_review (never auto-QA the
		// latter). Read BEFORE any status write below.
		const autoQaPriorStatus = store.getSession(event.execution_id)?.status;

		try {
			const ctx = {
				executionId: event.execution_id,
				issueId: event.issue_id,
				projectName: event.project_name,
				trigger: event.event_type,
			};

			if (event.event_type === "session_started") {
				// FLY-1709 R1: activation time is set-once on both ingest surfaces.
				// Replayed HTTP events must not move an old run past a later archive
				// epoch and falsely clear the founder's archive protection.
				const startedAt =
					store.getSession(event.execution_id)?.started_at ?? now;
				// GEO-152: store issue labels for multi-lead routing
				const eventLabels = Array.isArray(payload.labels)
					? (payload.labels as string[])
					: [];
				const issueLabelsJson =
					eventLabels.length > 0 ? JSON.stringify(eventLabels) : undefined;
				// FLY-59: Read session role from event payload
				const eventSessionRole = asString(payload.sessionRole) ?? "main";
				// FLY-493: persist the resolved executor backend as adapter_type so
				// the no-transport wake-guard (and the dashboard) can see it.
				const eventAdapterType = asString(payload.runnerBackend);
				// FLY-728: persist the resolved runner model (per-issue model routing
				// visibility). Mirrors the DirectEventSink production path.
				const eventRunnerModel = asString(payload.runnerModel);
				// FLY-1259: accept only the public enum on the untrusted event wire.
				const eventDesignBackend = isDesignBackend(payload.designBackend)
					? payload.designBackend
					: undefined;
				// FLY-615: persist the resolved ponytail condition (A/B join key).
				const eventPonytailCondition = asString(payload.ponytailCondition);
				// FLY-1356 (R1#7): accept ONLY the closed enums on the untrusted
				// event wire — the /events ingest token is runner-visible, and the
				// attribution columns must never hold arbitrary strings. BOTH must
				// be valid to record EITHER (Bar-Raiser LOW-4: a valid mode with a
				// garbage via would land a NULL-via row that silently drops out of
				// the runbook's via-filtered GROUP BY).
				const bothSkillEnumsValid =
					isSkillFrameworkMode(payload.skillFrameworkMode) &&
					isSkillFrameworkVia(payload.skillFrameworkModeVia);
				const eventSkillFrameworkMode = bothSkillEnumsValid
					? (payload.skillFrameworkMode as SkillFrameworkMode)
					: undefined;
				const eventSkillFrameworkVia = bothSkillEnumsValid
					? (payload.skillFrameworkModeVia as SkillFrameworkVia)
					: undefined;
				// FLY-793 (Step 11): persist the chat-thread role (computed at dispatch
				// as shareParentBranch ? role : 'main'). This HTTP started path must
				// persist it too, or a runner started via /events loses the signal that
				// routes its thread to the phase side-table.
				const eventChatThreadRole = asString(payload.chatThreadRole) ?? "main";
				// FLY-1372 §2.5 AUTHORITY BOUNDARY (Codex design R3-3): the Bridge-
				// trusted behavior fields (docTier / issueUrl / codexSkip /
				// founderFacingUx) are deliberately NOT read from this payload — the
				// /events ingest token is runner-visible, so a runner could spoof
				// them (e.g. founderFacingUx:false to dodge the gate). They are
				// persisted ONLY by the in-process DirectEventSink. Do not add them
				// to this mapping.

				if (transitionOpts) {
					const result = applyTransition(
						transitionOpts,
						event.execution_id,
						"running",
						ctx,
						{
							started_at: startedAt,
							last_activity_at: now,
							heartbeat_at: now,
							issue_identifier: resolveIdentifier(payload, event.issue_id),
							issue_title: asString(payload.issueTitle),
							issue_labels: issueLabelsJson,
							session_stage: "started",
							stage_updated_at: now,
							session_role: eventSessionRole,
							chat_thread_role: eventChatThreadRole,
							...(eventAdapterType && { adapter_type: eventAdapterType }),
							...(eventRunnerModel && { runner_model: eventRunnerModel }),
							...(eventDesignBackend && {
								design_backend: eventDesignBackend,
							}),
							...(eventPonytailCondition && {
								ponytail_condition: eventPonytailCondition,
							}),
							...(eventSkillFrameworkMode && {
								skill_framework_mode: eventSkillFrameworkMode,
								skill_framework_mode_via: eventSkillFrameworkVia,
							}),
							workflow_node_id: workflowNodeId,
						},
					);
					if (!result.ok) {
						console.warn(
							`[event-route] FSM rejected ${event.event_type}: ${result.error}`,
						);
						transitionRejected = true;
					}
				} else {
					store.upsertSession({
						execution_id: event.execution_id,
						issue_id: event.issue_id,
						project_name: event.project_name,
						status: "running",
						started_at: startedAt,
						last_activity_at: now,
						heartbeat_at: now,
						issue_identifier: resolveIdentifier(payload, event.issue_id),
						issue_title: asString(payload.issueTitle),
						issue_labels: issueLabelsJson,
						session_stage: "started",
						stage_updated_at: now,
						session_role: eventSessionRole,
						chat_thread_role: eventChatThreadRole,
						...(eventAdapterType && { adapter_type: eventAdapterType }),
						...(eventRunnerModel && { runner_model: eventRunnerModel }),
						...(eventDesignBackend && {
							design_backend: eventDesignBackend,
						}),
						...(eventPonytailCondition && {
							ponytail_condition: eventPonytailCondition,
						}),
						...(eventSkillFrameworkMode && {
							skill_framework_mode: eventSkillFrameworkMode,
							skill_framework_mode_via: eventSkillFrameworkVia,
						}),
						workflow_node_id: workflowNodeId,
					});
				}

				// FLY-163: Forum thread inheritance + ForumPostCreator removed.
				// Per-issue chat thread creation runs in DirectEventSink (FLY-91).
			} else if (event.event_type === "worktree_ready") {
				// FLY-137: Blueprint reports the resolved worktree path
				// immediately after `WorktreeManager.create()` returns. We
				// persist it on the session row so the Codex auto-trigger
				// handlers (stage_changed=design_review / pr_created) and
				// the `codex-skip` snapshot can write skip.json + review
				// markers inside the Runner's actual cwd. Without this,
				// downstream handlers fall back to a derived path the
				// Runner cannot see and the await-codex-gate hangs until
				// timeout.
				//
				// Codex R2 #1 fix: `emitStarted` is fire-and-forget while
				// `emitWorktreeReady` is reliable (postEventReliable +
				// retries). The worktree_ready POST can therefore land at
				// Bridge BEFORE session_started's POST (especially if
				// started's first attempt failed and silently gave up).
				// `patchSessionMetadata` no-ops on missing rows, which
				// would silently lose worktree_path. Defend by upserting
				// a minimal running session when the row is absent — the
				// later session_started POST will UPSERT and refresh the
				// fields it cares about (started_at, labels, etc.) via
				// COALESCE.
				// FLY-1185 §2.1 (R5#1 option a): the HTTP `worktree_ready` is
				// DISPLAY METADATA ONLY — the shared /events ingest token is
				// runner-visible, so this path can NEVER create or modify the
				// worktree authority binding (that happens exclusively in the
				// bridge-local DirectEventSink at create time). For a session
				// that already holds a binding, a divergent HTTP path write is
				// refused + audited (`worktree_binding_rejected`) instead of
				// silently repointing the display path a deleter might consult.
				const worktreePath =
					typeof payload.worktreePath === "string" &&
					payload.worktreePath.length > 0
						? payload.worktreePath
						: undefined;
				if (worktreePath) {
					const existing = store.getSession(event.execution_id);
					const bound = store.getWorktreeBinding(event.execution_id);
					if (bound && bound.path !== worktreePath) {
						store.insertEvent({
							event_id: `worktree-binding-rejected-http-${event.execution_id}-${event.event_id}`,
							execution_id: event.execution_id,
							issue_id: event.issue_id,
							project_name: event.project_name,
							event_type: "worktree_binding_rejected",
							source: "bridge.event-route",
							payload: {
								attemptedPath: worktreePath,
								boundPath: bound.path,
								via: "http_worktree_ready",
							},
						});
					} else if (!existing) {
						// Codex R3 #1 fix: when the row is created by
						// worktree_ready (race condition with the fire-and-
						// forget session_started POST), keep status as
						// `pending` so the later session_started can apply
						// the FSM-legal `pending → running` transition
						// (running → running is rejected by WorkflowFSM and
						// would skip labels/title/thread initialization).
						store.upsertSession({
							execution_id: event.execution_id,
							issue_id: event.issue_id,
							project_name: event.project_name,
							status: "pending",
							worktree_path: worktreePath,
						});
					} else {
						store.patchSessionMetadata(event.execution_id, {
							worktree_path: worktreePath,
						});
					}
				} else {
					console.warn(
						`[event-route] worktree_ready event for ${event.execution_id} missing worktreePath payload`,
					);
				}
			} else if (event.event_type === "session_completed") {
				const decision = payload.decision as
					| Record<string, unknown>
					| undefined;
				const evidence = payload.evidence as
					| Record<string, unknown>
					| undefined;
				const route = asString(decision?.route);
				const landingStatus = evidence?.landingStatus as
					| { status?: string; prNumber?: number }
					| undefined;

				// FLY-123 (Codex design review R1 #4): persist adapter session-
				// resume params (e.g. Codex threadId) on the HTTP sink path —
				// parity with DirectEventSink. MERGE-patch (proofshot state
				// shares the session_params JSON). Placed BEFORE the strict
				// route guard: resume metadata must survive even a malformed
				// route emission.
				const sessionParamsPayload = payload.sessionParams as
					| Record<string, unknown>
					| undefined;
				if (
					sessionParamsPayload &&
					typeof sessionParamsPayload === "object" &&
					!Array.isArray(sessionParamsPayload) &&
					Object.keys(sessionParamsPayload).length > 0
				) {
					try {
						const existingParams =
							store.getSessionParams(event.execution_id) ?? {};
						store.setSessionParams(event.execution_id, {
							...existingParams,
							...sessionParamsPayload,
						});
					} catch (err) {
						console.warn(
							`[event-route] sessionParams persist failed for ${event.execution_id}: ${(err as Error).message}`,
						);
					}
				}

				// FLY-58: If session is approved_to_ship, Runner finished shipping
				// → go straight to completed (no Decision Layer needed).
				// Looked up BEFORE the strict-route guard so the natural-completion
				// path (Annie :cool: → Runner ships → session_completed with
				// decision.route = undefined) is preserved. Mirrors the
				// `else status = "completed"` fallback in
				// DirectEventSink.emitCompleted (DirectEventSink.ts:273-274) and is
				// pinned by DirectEventSink.test.ts:822-841.
				const existingSession = store.getSession(event.execution_id);
				const isPostApproveShip =
					existingSession?.status === "approved_to_ship";

				// FLY-108 Decision 4: strict route guard. A payload with a foreign or
				// missing route is almost always an emitter bug (GEO-362 Variant A) —
				// fail loudly instead of silently falling through to "completed".
				// Codex R2 (FLY-115 v1.24.5): exempt `approved_to_ship` sessions so
				// the natural-completion path keeps working — DirectEventSink already
				// allows this via its `else status = "completed"` branch, and the
				// HTTP /events sink must have parity (otherwise a Runner that ships
				// after Annie :cool: gets dropped here and the Lead never sees the
				// terminal completion).
				const VALID_ROUTES = new Set([
					"auto_approve",
					"needs_review",
					"blocked",
					"ship_attempt_failed",
					// FLY-222 #1: no-code/no-merge clean success → terminal completed.
					"no_code",
					// FLY-493: pr_handoff — no-transport antigravity build+PR terminal
					// (running→completed; never awaiting_review/approved_to_ship).
					"pr_handoff",
					// FLY-793: DAG workflow Design phase completion → design_done.
					"phase_design_complete",
				]);
				if (!isPostApproveShip && (!route || !VALID_ROUTES.has(route))) {
					console.warn(
						`[event-route] session_completed ${event.execution_id} has invalid route ` +
							`(${route ?? "undefined"}) — skipping FSM update. ` +
							`Expected one of ${[...VALID_ROUTES].join(", ")}. ` +
							`Likely Runner emitter bug or deprecated code path.`,
					);
					res.json({ ok: true, warning: "invalid route skipped" });
					return;
				}

				// FLY-222 #1 (Codex code-review MED-2): no_code is ONLY a
				// running→completed terminal. Reject it from any non-running
				// pre-existing state so a review-gated runner (awaiting_review /
				// approved_to_ship) cannot clear its gate via no_code without merge
				// evidence / evidence-gap / finalization. Skip like an invalid route.
				// FLY-493: pr_handoff has the SAME running-only constraint.
				if (
					(route === "no_code" ||
						route === "pr_handoff" ||
						route === "phase_design_complete") &&
					existingSession?.status !== "running"
				) {
					console.warn(
						`[event-route] session_completed ${event.execution_id} route=${route} ` +
							`from non-running status (${existingSession?.status ?? "none"}) — ` +
							`skipping (${route} only terminalizes a running runner).`,
					);
					res.json({
						ok: true,
						warning: `${route} from non-running skipped`,
					});
					return;
				}

				// FLY-108: status mapping. Mirrors DirectEventSink.emitCompleted
				// (DirectEventSink.ts:258-274) — explicit failure routes win over
				// the post-approve-ship natural-completion fallback so a ship that
				// fails (`route="blocked"`) ends in `blocked`, not `completed`.
				//
				// Codex R3 (FLY-115 v1.24.5): pre-R3 code put the
				// `if (isPostApproveShip)` branch first, which incorrectly mapped
				// `approved_to_ship + route="blocked"` to `completed` and then
				// ran post-ship cleanup on a failed ship. Order is now:
				//   1. route="needs_review" (with merged → completed shortcut)
				//   2. route="auto_approve" (with merged → completed shortcut)
				//   3. route="blocked" → blocked
				//   4. route=undefined → only reachable when isPostApproveShip is
				//      true (guard above rejects undefined route otherwise) →
				//      completed (natural-completion path).
				//
				// Pinned by:
				//   - DirectEventSink.test.ts:798-820 (blocked → no finalization)
				//   - DirectEventSink.test.ts:822-841 (undefined → completed)
				//   - event-route-dual-session-completed Scenario D (undefined HTTP)
				//   - event-route-dual-session-completed Scenario E (blocked HTTP)
				let status: string;
				// FLY-208 5a: a session ALREADY approved_to_ship that re-completes
				// with auto_approve/needs_review but WITHOUT merged landing used to
				// map to awaiting_review — an FSM-invalid transition from
				// approved_to_ship (rejected → session stuck there forever; the
				// LEARN-12 incident: sub disables the approve checkpoint, so its
				// Runner never gets the landing-rewrite instruction and the signal
				// stays "ready_to_merge"). Unstick by completing WITH an
				// evidence-gap marker; post-ship finalization is suppressed for it
				// (isPostApproveShipComplete now requires merged landing) — see
				// markEvidenceGapCompletion / FLY-210 for the later cleanup.
				//
				// FLY-945 Fix C: EXCEPT when the completion carries a NEW review
				// question binding (see the needs_review branch) — that is a
				// deliberate review re-request after an expired approval, mapped to
				// awaiting_review via the new approved_to_ship→awaiting_review edge.
				let evidenceGap = false;
				// FLY-945 Fix C: the completion's reviewQuestionId, validated at the
				// boundary (hoisted above the status mapping — the needs_review
				// branch needs it; setReviewBinding below reuses it).
				const reviewQidRaw = asString(payload.reviewQuestionId)?.trim();
				const reviewQuestionId =
					reviewQidRaw && /^[0-9a-fA-F-]{8,64}$/.test(reviewQidRaw)
						? reviewQidRaw
						: undefined;
				// FLY-869 B: ship-eligibility gate computed BEFORE any status mutation
				// (design R2 HIGH-1). SISTER computation to DirectEventSink.emitCompleted —
				// both sinks MUST agree. A merged landing that is NOT ship-eligible is
				// parked with a durable merge_block marker (决定③ — no auto-revert).
				const erMergedLanding = landingStatus?.status === "merged";
				// FLY-869 B (Codex R2 #1): the row's pr_head_sha is written later (≈line 1189) on
				// the first complete — fall back to the event's evidence.headSha so a merge_block
				// parked here binds the REAL merged head (else same-head recovery can't match).
				const erPrHead =
					existingSession?.pr_head_sha?.trim() ||
					asString(evidence?.headSha)?.toLowerCase();
				// Always route through the shared predicate (uniform kill-switch handling).
				// A missing prior session row → verifyApproval reads no approval and
				// fail-closes when the gate is ON (correct for a no-context merge), and
				// the kill-switch still bypasses when OFF. Use the event identity so the
				// gate is consulted even for a first-seen session_completed.
				const erDecision = erMergedLanding
					? await computeAuthoritativeShipDecision(
							store,
							existingSession ?? {
								execution_id: event.execution_id,
								project_name: event.project_name,
							},
							erPrHead,
							process.env,
							materializedHeadAuthority,
							mergedPrCiProbe,
						)
					: undefined;
				const erShipEligible = erMergedLanding
					? (erDecision?.eligible ?? false)
					: undefined;
				const erParkUnapprovedMerge = (): "awaiting_review" => {
					if (existingSession) {
						const claimed = parkMergeBlock(
							store,
							existingSession,
							erDecision?.authoritativeHead ?? erPrHead ?? "",
							erDecision ?? {
								eligible: false,
								mergeApprovalOk: false,
								qaOk: false,
								mergeReason: "no_pr_head",
								qaReason: "session_not_found",
							},
						);
						if (claimed) {
							console.warn(
								`[event-route] FLY-869 merge_without_approval — ${event.execution_id} ` +
									`merged head=${erPrHead ?? "(none)"} NOT ship-eligible ` +
									`(merge=${erDecision?.mergeReason ?? "no_head"} qa=${erDecision?.qaReason ?? "n/a"}); ` +
									`parked awaiting_review + merge_block marker (no auto-revert)`,
							);
							// FLY-869 决定③: fire the ONE loud Discord alert (once per head —
							// gated by the parkMergeBlock claim above). Not auto-reverted, not
							// marked Done, issue stays open → a human must resolve it.
							void autoQaCoordinator?.current?.alertMergeWithoutApproval(
								existingSession,
								`⛔ Runner ${event.execution_id}（${existingSession.issue_id}）自行 merge 但未获批准 —— merged head ${erPrHead ?? "(none)"} 未通过 ship 闸（merge=${erDecision?.mergeReason ?? "no_head"} qa=${erDecision?.qaReason ?? "n/a"}）。已挂 merge_block、未标 Done、issue 留 open，不会自动 revert —— 需要人来处理。`,
							);
						}
					}
					return "awaiting_review";
				};
				if (route === "needs_review") {
					// FLY-115 v1.24.5 (FLY-120): mirror the auto_approve+merged
					// short-circuit so a Runner that self-merges after Lead
					// unblocks `approve_to_ship` (e.g. via flywheel-comm respond)
					// reaches "completed" instead of being stuck in
					// "awaiting_review" with a PR already on main. Sister fix
					// in DirectEventSink.emitCompleted; both paths must agree
					// because emitCompleted is in-process while this is the
					// HTTP /events sink.
					if (landingStatus?.status === "merged") {
						// FLY-869 B: merged → completed ONLY when ship-eligible.
						status = erShipEligible ? "completed" : erParkUnapprovedMerge();
					} else if (isPostApproveShip) {
						// FLY-945 Fix C: an approved_to_ship session re-requesting
						// review with a NEW question binding (≠ its current one) is a
						// deliberate recovery lap (approval expired on a head move) —
						// back to awaiting_review; writeReviewBinding below rebinds
						// question + pr_head via the standard needs_review path.
						// Same/missing questionId → FLY-208 5a evidence-gap completion
						// (a re-emission or a binding-less legacy completion, not a
						// re-review). Sister branch: DirectEventSink + reconciler.
						if (
							reviewQuestionId &&
							reviewQuestionId !== existingSession?.review_question_id
						) {
							status = "awaiting_review";
						} else {
							status = "completed";
							evidenceGap = true;
						}
					} else {
						status = "awaiting_review";
					}
				} else if (route === "auto_approve") {
					if (landingStatus?.status === "merged") {
						// FLY-58 + FLY-869 B: auto_approve + merged → completed only if
						// ship-eligible; otherwise park (merge_without_approval).
						status = erShipEligible ? "completed" : erParkUnapprovedMerge();
					} else if (isPostApproveShip) {
						status = "completed";
						evidenceGap = true;
					} else {
						status = "awaiting_review";
					}
				} else if (route === "blocked" || route === "ship_attempt_failed") {
					if (isPostApproveShip) {
						const settle = settleShipAttemptFailed(store, event.execution_id, {
							attemptHeadSha: asString(evidence?.headSha),
							currentHeadSha: existingSession?.pr_head_sha,
							prNumber:
								asNumber(evidence?.prNumber) ??
								existingSession?.pr_number ??
								undefined,
							// Live HTTP delivery and this row snapshot share one
							// time context, so legacy qid-less completions may use
							// the row binding. Delayed marker replay stays event-only.
							reviewQuestionId:
								reviewQuestionId ?? existingSession?.review_question_id,
							currentReviewQuestionId: existingSession?.review_question_id,
							summary: asString(payload.summary),
						});
						if (
							(settle.outcome === "marked" ||
								settle.outcome === "unknown_head_marked") &&
							settle.firstAttemptForHead &&
							existingSession
						) {
							const retryPosture =
								settle.outcome === "marked"
									? "同 head 的自动重唤醒已暂停，请由 Lead 显式唤醒。"
									: "本次完成未携带可验证的 head；自动重唤醒仍开启（fail-open）。";
							void autoQaCoordinator?.current?.alertShipAttemptFailed(
								existingSession,
								`⚠️ Runner ${event.execution_id}（${existingSession.issue_id}）报告 ship attempt 失败/停滞；会话保持 approved_to_ship，founder 批准仍有效。请检查 PR #${existingSession.pr_number ?? "unknown"} 的 ship workflow；诊断后重试前先重新运行 verify-approval。${retryPosture}`,
							);
						}
						console.warn(
							`[event-route] FLY-1505 ship_attempt_failed deflected for ${event.execution_id} — approved_to_ship preserved (${settle.outcome})`,
						);
						res.json({
							ok: true,
							warning:
								"ship_attempt_failed deflected (approved_to_ship preserved)",
						});
						return;
					}
					if (route === "ship_attempt_failed") {
						res.status(409).json({
							ok: false,
							reason:
								"ship_attempt_failed requires an approved_to_ship session",
							retryable: false,
						});
						return;
					}
					status = "blocked";
				} else if (route === "phase_design_complete") {
					// FLY-793: DAG workflow Design phase done (docs on the shared
					// branch, no PR) → non-terminal design_done (running → design_done).
					// The workflow engine hands off to Implement. Sister branch:
					// DirectEventSink.ts.
					status = "design_done";
				} else if (route === "no_code" || route === "pr_handoff") {
					// FLY-222 #1: no-code/no-merge clean success → terminal completed.
					// `running → completed` is a legal FSM edge. evidenceGap stays
					// false (this is NOT an approved_to_ship merge-evidence gap — it
					// is a legitimate code-less completion, so FLY-210 must not treat
					// it as a deferred-finalization). runPostShipFinalization is gated
					// on merged landing (post-ship-finalization.ts:75), so it cannot
					// fire here. Sister branch: DirectEventSink.ts.
					//
					// FLY-493: pr_handoff is the no-transport antigravity build+PR
					// terminal — same running→completed mapping. Its landingStatus is
					// `ready_to_merge` (NOT merged), so finalization is likewise gated
					// off; the founder ships the PR by hand. No review binding is
					// written (status !== "awaiting_review"), so the session never
					// enters the wake-dependent approve loop.
					status = "completed";
				} else if (erMergedLanding) {
					// FLY-869 B: natural (:cool:) completion WITH a merged landing must
					// pass the ship-eligibility gate too (design R2 HIGH-3 — every
					// merged→completed surface). Sister branch: DirectEventSink.ts.
					status = erShipEligible ? "completed" : erParkUnapprovedMerge();
				} else {
					// route is undefined here — only reachable when
					// isPostApproveShip is true (the strict route guard above
					// rejects undefined route otherwise). Natural-completion
					// path: Annie :cool: → Runner ships → session_completed with
					// no decision route. Sister branch:
					// DirectEventSink.ts (`else status = "completed"`).
					status = "completed";
					// FLY-208 5a: even the natural-completion path completes
					// WITHOUT merge proof when the landing signal was never
					// rewritten — mark the gap so FLY-210 can finish the
					// (now-suppressed) post-ship cleanup once proof arrives.
					// (merged handled by the erMergedLanding branch above.)
					evidenceGap = true;
				}

				// FLY-59: Read session role from completed event payload.
				// FLY-793 (824 R2 E2E fix): a completion signal must NOT clobber a
				// dispatched phase role. The `flywheel-comm complete` CLI defaults its
				// payload role to "main" (phase runners don't pass --session-role), so
				// writing it back would overwrite the design/implement/qa role and the
				// DAG workflow handoff would silently never fire. Preserve the existing
				// phase role server-side (existingSession = pre-transition snapshot,
				// line 850). Byte-compat: a non-phase existing role ("main"/none) falls
				// through to the payload role, identical to the prior behavior.
				const completedSessionRole = resolveCompletionSessionRole(
					existingSession?.session_role,
					asString(payload.sessionRole),
				);

				// FLY-191 Phase 2 (§5.5.2 + Codex PR R1 CRITICAL/HIGH-2): the review
				// BINDING — the exact gate questionId + PR head this review request
				// is for. External input → validate at the boundary (full 40-hex
				// sha; uuid-shaped questionId); malformed values become NULL.
				// Written via setReviewBinding on EVERY awaiting_review outcome so a
				// re-review can never inherit a previous review's binding — a
				// missing/garbled value CLEARS the column (verify-approval
				// fail-closes on NULLs) instead of silently retaining stale data.
				const prHeadShaRaw = asString(evidence?.headSha)?.toLowerCase();
				const prHeadSha =
					prHeadShaRaw && /^[0-9a-f]{40}$/.test(prHeadShaRaw)
						? prHeadShaRaw
						: undefined;
				let reviewShipTarget:
					| {
							runId?: string;
							sourceRequestId?: string;
							targetRepoPath: string;
							targetRepoIdentity: string;
							probeRepoSlug: string;
							worktreeBindingGeneration: string;
					  }
					| undefined;
				if (status === "awaiting_review" && reviewQuestionId && prHeadSha) {
					const worktreeBinding = store.getWorktreeBinding(event.execution_id);
					if (worktreeBinding) {
						try {
							const requestedRepoPath = asString(
								(evidence?.landingStatus as Record<string, unknown> | undefined)
									?.targetRepoPath,
							);
							const authority = await resolveBoundRepositoryAuthority({
								authorityRoot: worktreeBinding.path,
								...(requestedRepoPath ? { requestedRepoPath } : {}),
							});
							if (authority.headSha !== prHeadSha) {
								throw new Error("review_ship_target_head_mismatch");
							}
							const source = store.findApprovedReviewShipTargetSource({
								projectName: event.project_name,
								issueId: event.issue_id,
								targetRepoIdentity: authority.identity,
								targetPrHeadSha: authority.headSha,
							});
							const isClaudeLegacyMain =
								authority.identity === "__main__" &&
								adapterTypeToFamily(existingSession?.adapter_type) === "claude";
							if (source.status === "resolved" || isClaudeLegacyMain) {
								const workflowRunId = store.getWorkflowRunIdForExecution(
									event.execution_id,
								);
								reviewShipTarget = {
									...(workflowRunId ? { runId: workflowRunId } : {}),
									...(source.status === "resolved" && source.sourceRequestId
										? { sourceRequestId: source.sourceRequestId }
										: {}),
									targetRepoPath: authority.path,
									targetRepoIdentity: authority.identity,
									probeRepoSlug: authority.probeRepoSlug,
									worktreeBindingGeneration: worktreeBinding.generation,
								};
							} else {
								console.warn(
									`[event-route] review ship target unavailable for ${event.execution_id}: approved review source ${source.status}`,
								);
							}
						} catch (error) {
							console.warn(
								`[event-route] review ship target unavailable for ${event.execution_id}: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
					}
				}
				// (reviewQuestionId validated above the status mapping — FLY-945.)
				const writeReviewBinding = (): void => {
					if (status !== "awaiting_review") return;
					store.setReviewBinding(event.execution_id, {
						questionId: reviewQuestionId ?? null,
						prHeadSha: prHeadSha ?? null,
						...(reviewShipTarget ? { shipTarget: reviewShipTarget } : {}),
					});
				};

				// FLY-1041 Fix A (main path): after a successful REBIND to a NEW
				// question, retire the SUPERSEDED gate's CommDB row so only ONE
				// approve_to_ship gate is founder-bindable at a time (the FLY-910
				// multi-gate ambiguity). Order is rebind FIRST (authoritative,
				// already done by writeReviewBinding) then retire — a crash in
				// between leaves the old gate alive a little longer and the
				// gate-poller sweeper converges it (R2). retireShipGate's WHERE is
				// double-guarded (approve_to_ship + unanswered), so an answered
				// gate can never be rewritten.
				const retireSupersededShipGate = (): void => {
					if (status !== "awaiting_review") return;
					const supersededQid = existingSession?.review_question_id;
					if (
						!supersededQid ||
						supersededQid === REVIEW_BINDING_UNBOUND ||
						!reviewQuestionId ||
						supersededQid === reviewQuestionId
					) {
						return;
					}
					try {
						const commDb = new CommDB(
							commDbPathForProject(event.project_name),
							false,
						);
						let retired = false;
						try {
							retired = commDb.retireShipGate(supersededQid, {
								supersededBy: reviewQuestionId,
							});
						} finally {
							commDb.close();
						}
						if (retired) {
							store.insertEvent({
								event_id: `ship-gate-superseded-${supersededQid}`,
								execution_id: event.execution_id,
								issue_id: event.issue_id,
								project_name: event.project_name,
								event_type: "ship_gate_superseded",
								source: "bridge.event-route",
								payload: {
									supersededQid,
									newQid: reviewQuestionId,
									by: "event-route",
								},
							});
						}
					} catch (err) {
						console.warn(
							`[event-route] FLY-1041 ship-gate retire failed for ${supersededQid} ` +
								`(${event.execution_id}): ${(err as Error).message} — sweeper will converge it`,
						);
					}
				};

				// FLY-191 Phase 2: shared completion-evidence patch (used by both the
				// normal transition success branch and the re-review branch below).
				// pr_head_sha deliberately NOT here — it is owned by
				// setReviewBinding (NULL-capable; patch skips undefined).
				const patchCompletionEvidence = (): void => {
					const prNumber = asNumber(
						(evidence?.landingStatus as Record<string, unknown> | undefined)
							?.prNumber,
					);
					store.patchSessionMetadata(event.execution_id, {
						decision_route: route,
						decision_reasoning: asString(decision?.reasoning),
						commit_count: asNumber(evidence?.commitCount),
						files_changed: asNumber(evidence?.filesChangedCount),
						lines_added: asNumber(evidence?.linesAdded),
						lines_removed: asNumber(evidence?.linesRemoved),
						summary: asString(payload.summary),
						diff_summary: asString(evidence?.diffSummary),
						commit_messages: Array.isArray(evidence?.commitMessages)
							? (evidence.commitMessages as string[]).join("\n")
							: undefined,
						changed_file_paths: Array.isArray(evidence?.changedFilePaths)
							? (evidence.changedFilePaths as string[]).join("\n")
							: undefined,
						pr_number: prNumber,
					});
				};

				// FLY-191 Phase 2: review RE-REQUEST. A fresh needs_review completion
				// while ALREADY awaiting_review (changes_requested → runner re-posted
				// for review) is legal but has no FSM self-loop — handle explicitly:
				// reset the review window (deadline + timeout-dedup stamp), refresh
				// the PR-head binding (the re-review is for a NEW head), and fall
				// through to the normal Lead-notification flow below (the Lead must
				// learn a re-review was requested). Replays can't re-stamp:
				// insertEvent event_id dedup short-circuits upstream.
				const isReReview =
					status === "awaiting_review" &&
					existingSession?.status === "awaiting_review";

				if (isReReview) {
					// Codex PR R3 HIGH: dual-sink protection. The in-process emitter
					// (ExecutionEventEmitter/TeamLeadClient) also POSTs needs_review
					// completions and NEVER carries a reviewQuestionId. If this
					// qid-less completion lands on a session that already has a REAL
					// binding (set by the runner's `flywheel-comm complete
					// --question-id ...`), writing the UNBOUND sentinel here would
					// clobber the good binding and permanently fail-close approval.
					// Treat it as a duplicate emission of the SAME review: keep the
					// binding, keep the deadline (no window drift), patch evidence
					// only. A GENUINE re-review that forgot --question-id degrades
					// safely too — the old binding stays, its question can't approve
					// the new head (pr_head_sha unchanged → mismatch), and recovery
					// is re-requesting review properly.
					const existingBinding = existingSession?.review_question_id;
					const protectedBinding =
						!reviewQuestionId &&
						!!existingBinding &&
						existingBinding !== REVIEW_BINDING_UNBOUND;

					store.patchSessionMetadata(event.execution_id, {
						last_activity_at: now,
						// GEO-202: coerce "" → undefined so COALESCE preserves existing non-null value
						issue_identifier: asString(payload.issueIdentifier) || undefined,
						issue_title: asString(payload.issueTitle),
						session_role: completedSessionRole,
					});
					patchCompletionEvidence();
					if (protectedBinding) {
						console.log(
							`[event-route] qid-less needs_review for ${event.execution_id} with a real binding (${existingBinding}) — treating as duplicate dual-sink emission; binding + review window preserved`,
						);
					} else {
						store.resetAwaitingReviewWindow(event.execution_id);
						writeReviewBinding();
						// FLY-1041 Fix A: the old gate is now superseded — retire it.
						retireSupersededShipGate();
						console.log(
							`[event-route] re-review request for ${event.execution_id}: window reset, questionId=${reviewQuestionId ?? "(unbound)"}, pr_head_sha=${prHeadSha ?? "(cleared)"}`,
						);
					}
				} else if (transitionOpts) {
					const result = applyTransition(
						transitionOpts,
						event.execution_id,
						status,
						ctx,
						{
							last_activity_at: now,
							// GEO-202: coerce "" → undefined so COALESCE preserves existing non-null value
							issue_identifier: asString(payload.issueIdentifier) || undefined,
							issue_title: asString(payload.issueTitle),
							session_role: completedSessionRole,
							workflow_node_id: workflowNodeId,
						},
					);
					if (!result.ok) {
						// FLY-108: upgrade to error + carry pre-state / target / route for triage
						const preState = existingSession?.status ?? "<none>";
						console.error(
							`[event-route] FSM rejected ${event.event_type} ${event.execution_id}: ` +
								`pre-state=${preState} → target=${status} (route=${route}): ${result.error}`,
						);
						transitionRejected = true;
					} else {
						// Metadata via patchSessionMetadata only on successful transition
						const prNumber = asNumber(
							(evidence?.landingStatus as Record<string, unknown> | undefined)
								?.prNumber,
						);
						patchCompletionEvidence();
						writeReviewBinding();
						// FLY-1041 Fix A: covers the FLY-945 approved_to_ship →
						// awaiting_review recovery lap (and is a no-op on a first
						// needs_review — no prior binding to supersede).
						retireSupersededShipGate();

						// FLY-208 5a: evidence-gap completion — persist the marker
						// (FLY-210 consumes it) and warn loudly.
						if (evidenceGap) {
							// FLY-1282 Part C: evidence-gap completions belong to
							// FLY-210 / manual close — never the targeted archive queue.
							terminalArchiveExcluded = true;
							markEvidenceGapCompletion(store, event.execution_id, {
								route,
								landingStatus: landingStatus?.status,
							});
							console.warn(
								`[event-route] FLY-208 evidence-gap completion for ${event.execution_id}: ` +
									`approved_to_ship + route=${route} but landing=${landingStatus?.status ?? "(none)"} — ` +
									`completed WITHOUT merge evidence; post-ship finalization suppressed (FLY-210 owns later cleanup)`,
							);
						}

						// GEO-292: Auto-infer stage from landing status (only advance, never regress)
						if (prNumber) {
							const landingStatusObj = evidence?.landingStatus as
								| Record<string, unknown>
								| undefined;
							const landingStatusValue = asString(landingStatusObj?.status);
							const inferredStage =
								landingStatusValue === "merged" ? "ship" : "pr_created";
							const currentSession = store.getSession(event.execution_id);
							const currentOrder =
								STAGE_ORDER[currentSession?.session_stage ?? ""] ?? -1;
							const inferredOrder = STAGE_ORDER[inferredStage] ?? -1;
							if (inferredOrder > currentOrder) {
								store.patchSessionMetadata(event.execution_id, {
									session_stage: inferredStage,
									stage_updated_at: now,
								});
							}
						}
					}
				} else {
					const legacyPrNumber = asNumber(
						(evidence?.landingStatus as Record<string, unknown> | undefined)
							?.prNumber,
					);
					store.upsertSession({
						execution_id: event.execution_id,
						issue_id: event.issue_id,
						project_name: event.project_name,
						status,
						last_activity_at: now,
						decision_route: route,
						decision_reasoning: asString(decision?.reasoning),
						commit_count: asNumber(evidence?.commitCount),
						files_changed: asNumber(evidence?.filesChangedCount),
						lines_added: asNumber(evidence?.linesAdded),
						lines_removed: asNumber(evidence?.linesRemoved),
						summary: asString(payload.summary),
						diff_summary: asString(evidence?.diffSummary),
						commit_messages: Array.isArray(evidence?.commitMessages)
							? (evidence.commitMessages as string[]).join("\n")
							: undefined,
						changed_file_paths: Array.isArray(evidence?.changedFilePaths)
							? (evidence.changedFilePaths as string[]).join("\n")
							: undefined,
						// GEO-202: coerce "" → undefined so COALESCE preserves existing non-null value
						issue_identifier: asString(payload.issueIdentifier) || undefined,
						issue_title: asString(payload.issueTitle),
						pr_number: legacyPrNumber,
						session_role: completedSessionRole,
						workflow_node_id: workflowNodeId,
					});

					// FLY-191 Phase 2: upsertSession's column list doesn't carry the
					// review binding — write it separately on the legacy path too.
					writeReviewBinding();

					// GEO-292: Auto-infer stage for legacy path (only advance, never regress)
					if (legacyPrNumber) {
						const landingStatusObj = evidence?.landingStatus as
							| Record<string, unknown>
							| undefined;
						const landingStatusValue = asString(landingStatusObj?.status);
						const legacyStage =
							landingStatusValue === "merged" ? "ship" : "pr_created";
						const currentSession = store.getSession(event.execution_id);
						const currentOrder =
							STAGE_ORDER[currentSession?.session_stage ?? ""] ?? -1;
						const inferredOrder = STAGE_ORDER[legacyStage] ?? -1;
						if (inferredOrder > currentOrder) {
							store.patchSessionMetadata(event.execution_id, {
								session_stage: legacyStage,
								stage_updated_at: now,
							});
						}
					}
				}

				// GEO-152: store labels on completed events (not just started)
				if (!transitionRejected) {
					const payloadLabels = Array.isArray(payload.labels)
						? (payload.labels as string[])
						: undefined;
					if (payloadLabels && payloadLabels.length > 0) {
						store.patchSessionMetadata(event.execution_id, {
							issue_labels: JSON.stringify(payloadLabels),
						});
					}
				}

				// FLY-102: Post-approve-ship finalization (tmux → notifier → archive).
				// Must match DES's gate: covers both "approved_to_ship" branch AND
				// auto_approve+merged branch (Codex Round 1 fix).
				if (
					!transitionRejected &&
					status === "completed" &&
					isPostApproveShipComplete({
						existingStatus: existingSession?.status,
						route,
						landingStatus,
						// FLY-869 B: thread the pre-transition decision (parked = awaiting_review).
						shipEligible: erShipEligible,
					})
				) {
					// FLY-1282 Part C: post-ship owner's cleanup→archive sequence is
					// exclusive — this completion never enters the targeted queue.
					terminalArchiveExcluded = true;
					runPostShipFinalization(
						{
							executionId: event.execution_id,
							runId: store.getWorkflowRunIdForExecution(event.execution_id),
							...(Number.isInteger(landingStatus?.prNumber) &&
							landingStatus!.prNumber! > 0 &&
							!!erPrHead
								? {
										mergedPr: {
											prNumber: landingStatus!.prNumber!,
											headSha: erPrHead,
										},
									}
								: {}),
							issueId: event.issue_id,
							issueIdentifier: asString(payload.issueIdentifier) || undefined,
							projectName: event.project_name,
							sessionStatus: status,
							discordOwnerUserId: config.chatThreadsEnabled
								? config.discordOwnerUserId
								: undefined,
							fallbackBotToken: config.discordBotToken,
						},
						{
							store,
							projects,
							removeCleanWorktree,
							// FLY-887: close parked design + implement phases before worktree removal.
							finalizeWorkflowPhaseRoles,
							// FLY-799: auto-flip the shipped issue to Done (ship-success gated
							// by runPostShipFinalization's merge-evidence predicate).
							markIssueDone: makeLinearDoneFinalizer(config),
							// FLY-907: final terminal-state display refresh (before archive).
							refreshIssueDisplay: (issueId) =>
								issueDisplayRefresh?.current?.refresh(issueId) ??
								Promise.resolve(),
							// FLY-1185 entry A: remote branch CAS + issue closeout + sweep.
							...lifecycleInfra,
						},
					).catch((err) => {
						console.error(
							`[event-route] runPostShipFinalization failed for ${event.execution_id}:`,
							(err as Error).message,
						);
					});
				}

				// Auto-approve disabled by policy (v1.0 Phase 2)
				// CEO must approve via Slack before merge. No auto-merge flow.

				// CIPHER Phase A: save snapshot for awaiting_review sessions
				// Skip if FSM rejected the transition (out-of-order/duplicate events)
				if (
					cipherWriter &&
					status === "awaiting_review" &&
					!transitionRejected
				) {
					// FLY-108 Decision 6: Runner-driven `session_completed` omits
					// labels/projectId (Runner has no Linear SDK access). Backfill
					// from StateStore so the CIPHER snapshot contract holds.
					// Explicit payload.labels (Array.isArray) wins over backfill —
					// `labels: []` on an emitter means "no labels", not "look it up".
					let labels = Array.isArray(payload.labels)
						? (payload.labels as string[])
						: null;
					if (!labels) {
						// getSessionLabels() returns [] when unstored — StateStore.ts:1113-1123.
						labels = store.getSessionLabels(event.execution_id);
					}

					const changedFilePaths = Array.isArray(evidence?.changedFilePaths)
						? (evidence.changedFilePaths as string[])
						: null;
					// projectId: Runner payload may omit; saveSnapshot below already
					// uses `projectId ?? ""` fallback, so degraded empty is fine.
					const projectId = asString(payload.projectId);

					// `labels` is now always an array (possibly empty). Skip only
					// when changedFilePaths is missing (no diff → nothing to snapshot).
					if (!changedFilePaths) {
						console.warn(
							`[CIPHER] Skipping snapshot for ${event.execution_id}: missing changedFilePaths`,
						);
					} else {
						const snapshotInput: SnapshotInputDto = {
							labels,
							exitReason: asString(payload.exitReason) || "completed",
							changedFilePaths,
							commitCount: asNumber(evidence?.commitCount) ?? 0,
							filesChangedCount: asNumber(evidence?.filesChangedCount) ?? 0,
							linesAdded: asNumber(evidence?.linesAdded) ?? 0,
							linesRemoved: asNumber(evidence?.linesRemoved) ?? 0,
							consecutiveFailures: asNumber(payload.consecutiveFailures) ?? 0,
						};
						const dimensions = extractDimensions(snapshotInput);
						const patternKeys = generatePatternKeys(dimensions);

						try {
							await cipherWriter.saveSnapshot({
								executionId: event.execution_id,
								issueId: event.issue_id,
								issueIdentifier: resolveIdentifier(payload, event.issue_id),
								issueTitle: asString(payload.issueTitle) ?? "",
								projectId: projectId ?? "",
								issueLabels: labels,
								dimensions,
								patternKeys,
								systemRoute: asString(decision?.route) ?? "",
								systemConfidence: asNumber(decision?.confidence) ?? 0,
								decisionSource: asString(decision?.decisionSource) ?? "",
								decisionReasoning: asString(decision?.reasoning),
								commitCount: snapshotInput.commitCount,
								filesChanged: snapshotInput.filesChangedCount,
								linesAdded: snapshotInput.linesAdded,
								linesRemoved: snapshotInput.linesRemoved,
								diffSummary: asString(evidence?.diffSummary),
								commitMessages: Array.isArray(evidence?.commitMessages)
									? (evidence.commitMessages as string[])
									: [],
								changedFilePaths,
								exitReason: snapshotInput.exitReason,
								durationMs: asNumber(evidence?.durationMs) ?? 0,
								consecutiveFailures: snapshotInput.consecutiveFailures,
							});
						} catch (err) {
							console.error(
								`[CIPHER] saveSnapshot failed for ${event.execution_id}:`,
								err,
							);
						}
					}
				}
			} else if (event.event_type === "session_failed") {
				const failure = asTerminalFailureInfo(payload.failure);
				const goalBlocked = failure?.failureKind === "goal_blocked";
				const terminalStatus = goalBlocked ? "blocked" : "failed";
				const terminalError = goalBlocked
					? failure.failureReason
					: asString(payload.error);
				// FLY-59: Read session role from failed event payload.
				// FLY-793 (824 R2 E2E fix): same invariant as the completed path — a
				// signal must not downgrade a dispatched phase role to the payload
				// default "main" (keeps session_role accurate for triage / the
				// three_stage_stuck path). existingSession (completed branch) is not
				// in scope here, so read a pre-failure snapshot.
				const preFailureSession = store.getSession(event.execution_id);
				const failedSessionRole = resolveCompletionSessionRole(
					preFailureSession?.session_role,
					asString(payload.sessionRole),
				);

				if (transitionOpts) {
					const result = applyTransition(
						transitionOpts,
						event.execution_id,
						terminalStatus,
						ctx,
						{
							last_activity_at: now,
							last_error: terminalError,
							// GEO-202: coerce "" → undefined so COALESCE preserves existing non-null value
							issue_identifier: asString(payload.issueIdentifier) || undefined,
							issue_title: asString(payload.issueTitle),
							session_role: failedSessionRole,
							workflow_node_id: workflowNodeId,
						},
					);
					if (!result.ok) {
						console.warn(
							`[event-route] FSM rejected ${event.event_type}: ${result.error}`,
						);
						transitionRejected = true;
					}
				} else {
					store.upsertSession({
						execution_id: event.execution_id,
						issue_id: event.issue_id,
						project_name: event.project_name,
						status: terminalStatus,
						last_activity_at: now,
						last_error: terminalError,
						// GEO-202: coerce "" → undefined so COALESCE preserves existing non-null value
						issue_identifier: asString(payload.issueIdentifier) || undefined,
						issue_title: asString(payload.issueTitle),
						session_role: failedSessionRole,
						workflow_node_id: workflowNodeId,
					});
				}

				// GEO-152: store labels on failed events (not just started)
				if (!transitionRejected) {
					const payloadLabels = Array.isArray(payload.labels)
						? (payload.labels as string[])
						: undefined;
					if (payloadLabels && payloadLabels.length > 0) {
						store.patchSessionMetadata(event.execution_id, {
							issue_labels: JSON.stringify(payloadLabels),
						});
					}
				}
			} else if (event.event_type === "founder_ux_declared") {
				// FLY-598 trigger C (backup): a Runner self-declared this run as
				// founder-facing UX (the Lead's label may have been missed). Set the
				// flag so the gate applies; the Runner CLI already printed the
				// fail-closed next-step sequence. (Founder notification is best-effort
				// follow-up; the gate enforces regardless of notification.)
				store.patchSessionMetadata(event.execution_id, {
					founder_facing_ux: 1,
					last_activity_at: now,
				});
				console.log(
					`[FLY-598] founder_ux_declared for ${event.execution_id}: ${asString(payload.reason) ?? "(no reason)"}`,
				);
				res.json({ ok: true, declared: true });
				return;
			} else if (event.event_type === "stage_changed") {
				// GEO-292: Runner-reported pipeline stage change
				const stage = asString(payload.stage);
				if (stage && VALID_STAGES.has(stage)) {
					// FLY-598 Layer B: founder-UX gate. On entry into `implement`, a
					// founder-facing run must carry a verified Annie sign-off bound to
					// the current ux_hash. enforce → reject (FOUNDER_UX_SIGNOFF_REQUIRED,
					// which `stage set implement` fail-closes on) BEFORE recording the
					// stage; audit_only → log + proceed; off / non-founder-facing → pass.
					// FLY-900: the gate is retired fleet-wide by default — only run the
					// guard when the kill-switch is explicitly re-enabled. Disabled →
					// skip entirely (never read the snapshot, never block), so a
					// founder-facing implement passes even without a sign-off.
					if (stage === "implement" && isFounderUxGateEnabled()) {
						const guardSession = store.getSession(event.execution_id);
						const mode =
							(guardSession?.founder_ux_gate_mode as
								| FounderUxGateMode
								| undefined) ?? "off";
						const guard = evaluateFounderUxStageGuard(store, mode, {
							executionId: event.execution_id,
							incomingStage: "implement",
							uxHash: asString(payload.ux_hash),
						});
						if (guard.decision === "block") {
							console.warn(
								`[FLY-598] founder-ux gate BLOCK implement for ${event.execution_id}: ${guard.reason}`,
							);
							res.status(409).json({
								ok: false,
								error: guard.code,
								reason: guard.reason,
							});
							return;
						}
						if (guard.decision === "audit") {
							console.warn(
								`[FLY-598] founder-ux gate AUDIT (audit_only, not blocked) implement for ${event.execution_id}: ${guard.reason}`,
							);
						}
					}

					store.patchSessionMetadata(event.execution_id, {
						session_stage: stage,
						stage_updated_at: now,
						last_activity_at: now,
					});

					// FLY-623 (Codex code-review R1 HIGH): a genuinely ACCEPTED +
					// PERSISTED stage_changed proves the Runner's own event channel is
					// live again AND it is still running — leave the reconnecting state
					// so normal stuck/orphan/idle monitoring resumes. The
					// stampStageEmojiForSession call just below restamps the real stage
					// badge (clearing "⚠️重连中"). Placed AFTER the persist + the FLY-598
					// implement-gate early-return, so a rejected stage never clears.
					// Terminal removal is owned by the reconcile cycle's status check.
					reconnectHolder?.current?.clearReconnecting(event.execution_id);

					// FLY-560 Feature A: auto-stamp the stage emoji onto the issue's
					// [FLY-XX] thread title so Annie reads status at a glance. Wired
					// only when the feature flag is on (plugin.ts passes the creator);
					// fully fire-and-forget so it never blocks/breaks the transition.
					if (
						chatThreadCreator &&
						(issueStatusEmojiEnabled || issueAttachPinEnabled)
					) {
						const sessionForStamp = store.getSession(event.execution_id);
						if (sessionForStamp) {
							if (issueDisplayRefresh?.current) {
								// FLY-907: ONE unified derive-from-state refresh of all
								// three faces (the persisted session_stage above is what
								// the derivation reads, so the reported stage is honored).
								issueDisplayRefresh.current.enqueue(event.issue_id);
							} else {
								// Legacy per-face path (FLYWHEEL_ISSUE_DISPLAY_REFRESH=0
								// escape hatch, or refresher not yet wired).
								if (issueStatusEmojiEnabled) {
									stampStageEmojiForSession(
										{ store, projects, config, chatThreadCreator },
										sessionForStamp,
										stage,
									);
								}
								// FLY-560 Feature C: keep the pinned `tmux attach` command
								// current (post on first stage once tmux_window registers;
								// update only when the command changes).
								if (issueAttachPinEnabled) {
									pinRunnerAttachForSession(
										{ store, projects, config, chatThreadCreator },
										sessionForStamp,
									);
								}
							}
						}
					}

					// FLY-137 Phase 5: Codex auto-trigger fires on design_review
					// and pr_created. Honors codex-skip label snapshot (writes
					// skip.json), enforces plan_path requirement for design_review
					// (fail-closed via missing-plan instruction), otherwise queues
					// a CommDB instruction to the Runner inbox.
					if (stage === "design_review" || stage === "pr_created") {
						const planPath = asString(payload.plan_path);
						handleCodexAutoTrigger(store, event, stage, planPath);
					}

					// GEO-151: ProofShot auto-trigger. Reads
					// `session_params.proofshot.config` (persisted by
					// DirectEventSink.emitStarted) and filters on
					// `config.capture_stages`. Default config has enabled=false
					// → handler short-circuits for projects that don't opt in.
					// Fire-and-forget: handler is async but parent stage
					// transition must not block on mailbox write.
					void handleProofShotAutoTrigger(store, projects, event, stage).catch(
						(err: unknown) => {
							console.warn(
								`[proofshot-trigger] async handler threw for ${event.execution_id} stage=${stage}:`,
								err instanceof Error ? err.message : err,
							);
						},
					);

					// FLY-60 W2: post-merge re-finalize path. When stage=completed
					// and the payload carries `landing_status.status="merged"`, the
					// Runner has finished shipping and rewritten land-status.json
					// to merged after PR merge. Earlier `session_completed` event
					// (DirectEventSink) may have mapped status to `awaiting_review`
					// because landingStatus was still "ready_to_merge" at that time.
					// We re-evaluate the predicate with the now-merged landing
					// status and fire `runPostShipFinalization` to drive the
					// kill-Runner-tmux + chat-thread-cleanup chain.
					//
					// Scope (per plan §12.3): Run-#4-repair only — requires prior
					// `session_completed` to have written `decision_route`. The
					// "session=running, no prior session_completed" case is out of
					// scope (would need stage payload to carry route).
					if (stage === "completed") {
						const landingStatus = payload.landing_status as
							| {
									status?: string;
									prNumber?: number;
									mergeCommitSha?: string;
							  }
							| undefined;
						const sessionAtStage = store.getSession(event.execution_id);
						const stageRoute = asString(sessionAtStage?.decision_route);
						// FLY-869 B: compute ship-eligibility BEFORE applyTransition→completed
						// (design R2 HIGH-4 — the W2 re-finalize surface must gate too). A
						// merged-but-unapproved session is parked, NOT transitioned/finalized.
						const w2PrHead = sessionAtStage?.pr_head_sha?.trim();
						const w2Decision =
							landingStatus?.status === "merged"
								? await computeAuthoritativeShipDecision(
										store,
										sessionAtStage ?? {
											execution_id: event.execution_id,
											project_name: event.project_name,
										},
										w2PrHead,
										process.env,
										materializedHeadAuthority,
										mergedPrCiProbe,
									)
								: undefined;
						const w2ShipEligible =
							landingStatus?.status === "merged"
								? (w2Decision?.eligible ?? false)
								: undefined;
						if (
							landingStatus?.status === "merged" &&
							w2ShipEligible === false &&
							sessionAtStage
						) {
							const claimed = parkMergeBlock(
								store,
								sessionAtStage,
								w2Decision?.authoritativeHead ?? w2PrHead ?? "",
								w2Decision ?? {
									eligible: false,
									mergeApprovalOk: false,
									qaOk: false,
									mergeReason: "no_pr_head",
									qaReason: "session_not_found",
								},
							);
							if (claimed) {
								console.warn(
									`[event-route W2] FLY-869 merge_without_approval — ${event.execution_id} ` +
										`merged head=${w2PrHead ?? "(none)"} NOT ship-eligible; parked (no finalize).`,
								);
								// FLY-869 决定③: one loud Discord alert (once per head).
								void autoQaCoordinator?.current?.alertMergeWithoutApproval(
									sessionAtStage,
									`⛔ Runner ${event.execution_id}（${sessionAtStage.issue_id}）自行 merge 但未获批准（stage=completed，merged head ${w2PrHead ?? "(none)"} 未通过 ship 闸：merge=${w2Decision?.mergeReason ?? "no_head"} qa=${w2Decision?.qaReason ?? "n/a"}）。已挂 merge_block、未标 Done、issue 留 open，不会自动 revert —— 需要人来处理。`,
								);
							}
						}
						if (
							landingStatus?.status === "merged" &&
							isPostApproveShipComplete({
								existingStatus: sessionAtStage?.status,
								route: stageRoute,
								landingStatus,
								// FLY-869 B: gated — returns false when parked (not eligible).
								shipEligible: w2ShipEligible,
							})
						) {
							// (i) FSM transition FIRST via canonical applyTransition;
							// pr_number patched via sessionFields so write is tied to
							// the validated transition (codex R4 M2). merge_commit_sha
							// is NOT a StateStore.Session column — it stays in the
							// payload for downstream stage_context consumption only.
							let transitionApplied = false;
							if (transitionOpts) {
								const sessionFields: Partial<{
									pr_number: number;
									last_activity_at: string;
								}> = { last_activity_at: now };
								if (landingStatus.prNumber !== undefined) {
									sessionFields.pr_number = landingStatus.prNumber;
								}
								const w2Result = applyTransition(
									transitionOpts,
									event.execution_id,
									"completed",
									ctx,
									sessionFields,
								);
								if (!w2Result.ok) {
									console.warn(
										`[event-route W2] FSM rejected ${sessionAtStage?.status}→completed for ${event.execution_id}: ${w2Result.error}`,
									);
									transitionRejected = true;
								} else {
									transitionApplied = true;
								}
							} else {
								// Defensive: production plugin.ts always passes
								// transitionOpts. If somehow absent, refuse to fire
								// finalization (no legacy fallback for stage_changed
								// handler). codex R5 M1.
								transitionRejected = true;
								console.warn(
									`[event-route W2] missing transitionOpts; refusing post-ship finalization for ${event.execution_id}`,
								);
							}

							// (ii) Fire orchestrator with the EXACT PostShipOpts shape
							// used at the session_completed branch (line ~567). Do NOT
							// pass landingStatus/decisionRoute/prNumber as fields — they
							// are not part of PostShipOpts and TS would reject.
							if (transitionApplied) {
								runPostShipFinalization(
									{
										executionId: event.execution_id,
										runId: store.getWorkflowRunIdForExecution(
											event.execution_id,
										),
										...(Number.isInteger(landingStatus.prNumber) &&
										landingStatus.prNumber! > 0 &&
										!!w2PrHead
											? {
													mergedPr: {
														prNumber: landingStatus.prNumber!,
														headSha: w2PrHead,
													},
												}
											: {}),
										issueId: event.issue_id,
										issueIdentifier:
											sessionAtStage?.issue_identifier ??
											resolveIdentifier(payload, event.issue_id),
										projectName: event.project_name,
										sessionStatus: "completed",
										discordOwnerUserId: config.chatThreadsEnabled
											? config.discordOwnerUserId
											: undefined,
										fallbackBotToken: config.discordBotToken,
									},
									{
										store,
										projects,
										removeCleanWorktree,
										// FLY-887: close parked design + implement phases before worktree removal.
										finalizeWorkflowPhaseRoles,
										// FLY-799: auto-flip the shipped issue to Done (ship-success gated
										// by runPostShipFinalization's merge-evidence predicate).
										markIssueDone: makeLinearDoneFinalizer(config),
										// FLY-907: final terminal-state display refresh (before archive).
										refreshIssueDisplay: (issueId) =>
											issueDisplayRefresh?.current?.refresh(issueId) ??
											Promise.resolve(),
										// FLY-1185 entry A: remote branch CAS + issue closeout + sweep.
										...lifecycleInfra,
									},
								).catch((err) => {
									console.error(
										`[event-route W2] runPostShipFinalization failed for ${event.execution_id}:`,
										(err as Error).message,
									);
								});
							}
						} else if (
							landingStatus?.status !== "merged" &&
							!landingStatus?.prNumber &&
							isDoneButRunning(sessionAtStage ?? {}) &&
							!hasPendingCompleteMarker(event.execution_id)
						) {
							// FLY-324: a no-PR / no-code / QA Runner that finishes via
							// `flywheel-comm stage set completed` only emits this
							// stage_changed event — `complete --route` (which drives the
							// `session_completed` FSM transition) is never called. The
							// session is then stuck at `running`: close_runner rejects it,
							// its tmux + worktree linger until the next Bridge restart, and
							// idle detection false-positived session_stuck. `running →
							// completed` is a legal FSM edge; apply it so the auto-close /
							// reaper / notifier chain unblocks. isDoneButRunning guards on
							// status===running + stage===completed + no decision_route + no
							// pr_number; the non-merged landing check keeps the FLY-60 W2
							// merged-ship path above as the sole owner of merged sessions.
							//
							// Design-review #3: also skip when the INCOMING land-status
							// carries a prNumber. `stage set completed` attaches
							// land-status.json (status + prNumber); a PR-created session
							// whose `complete --route` was lost without a marker could match
							// isDoneButRunning (pr_number not yet persisted), but a PR exists,
							// so it must go through review, not be force-completed here.
							//
							// Scope (design-review #1): this live path treats a
							// stage=completed report as a TERMINAL "done" assertion. A Runner
							// that intends to stay parked must NOT report stage=completed. The
							// Lead exclude list is a CUTOVER boot-sweep-only safety net for
							// the pre-fix backlog where that contract wasn't yet in force.
							if (
								transitionOpts &&
								isRunnerDeclaredParked(
									event.execution_id,
									// Authoritative project from the resolved session row, not the
									// event envelope: a mismatched event.project_name would look up
									// the wrong comm.db and silently miss the veto (Codex R2 HIGH).
									sessionAtStage?.project_name ?? event.project_name,
								)
							) {
								// FLY-1329 (A5): the runner declared itself parked — a
								// stage=completed report that contradicts that must not
								// force-complete it. Mirrors the boot sweep's veto.
								console.log(
									`[event-route FLY-324] prune_skipped_parked_conflict: ${event.execution_id} declares itself parked — NOT force-completing (FLY-1329 A5)`,
								);
							} else if (transitionOpts) {
								const r324 = applyTransition(
									transitionOpts,
									event.execution_id,
									"completed",
									ctx,
									{ last_activity_at: now },
								);
								if (!r324.ok) {
									console.warn(
										`[event-route FLY-324] FSM rejected running→completed for ${event.execution_id}: ${r324.error}`,
									);
									transitionRejected = true;
								} else {
									// FLY-1282 Part C: an ACCEPTED FLY-324 completion is a
									// targeted terminal-archive enqueue site.
									fly324Completed = true;
								}
							}
						}
					}

					// NOTE: stage_changed values OTHER than "completed" (and the
					// FLY-324 running→completed branch above) remain informational
					// only — they do NOT trigger FSM transitions or orchestrators.
					// The FSM status change for merged-ship completion flows through
					// `session_completed` / the FLY-60 W2 merged branch.
				}
			}
		} catch (err) {
			console.error(
				`[event-route] Session update failed for ${event.execution_id}:`,
				err,
			);
			if (
				err instanceof Error &&
				err.message.startsWith("workflow_ship_target_binding_")
			) {
				res.status(409).json({
					ok: false,
					error: "review_ship_target_binding_rejected",
					reason: err.message,
				});
				return;
			}
			// Event is already stored — return success with a warning rather than 500
			// so retries don't get stuck on duplicate detection
			res.json({ ok: true, warning: "event stored but session update failed" });
			return;
		}

		// Skip notification when FSM rejected the transition
		if (transitionRejected) {
			// FLY-921 Fix C (Codex code R1 HIGH): a killed PARKED holder is exactly
			// this shape — the FSM has no awaiting_review→failed edge, so the
			// terminal signal is rejected and this early return would skip the
			// stale-holder recovery below forever. The process is dead regardless
			// of the status flip: run the scoped reconcile here too (guard 1 +
			// the liveness probe inside reconcileTurnBelt keep it safe — a
			// spurious signal against a live holder probes alive and no-ops).
			if (
				(event.event_type === "session_completed" ||
					event.event_type === "session_failed") &&
				turnBeltReconciler?.current
			) {
				const rejectedSession = store.getSession(event.execution_id);
				if (
					rejectedSession?.project_name &&
					isWorkflowPhaseRole(rejectedSession.session_role)
				) {
					try {
						await turnBeltReconciler.current.reconcileTurnBelt({
							issueId: rejectedSession.issue_id,
							projectName: rejectedSession.project_name,
							terminalExecId: event.execution_id,
						});
					} catch (err) {
						console.error(
							`[event-route] reconcileTurnBelt (FSM-rejected path) threw for ${event.execution_id}: ${(err as Error).message}`,
						);
					}
				}
			}
			res.json({
				ok: true,
				warning:
					"FSM rejected transition — event stored but session not updated",
			});
			return;
		}

		// GEO-202: Backfill null issue_identifier after upsert.
		// This handles the case where session_started was lost (fire-and-forget)
		// and session_completed/failed creates the session without an identifier.
		{
			const postSession = store.getSession(event.execution_id);
			if (postSession && !postSession.issue_identifier) {
				store.patchSessionMetadata(event.execution_id, {
					issue_identifier: event.issue_id,
				});
			}
		}

		// GEO-151 B8: Runner registered a build artifact (.glb/.stl/.3mf).
		// Persist into session_params.last_artifact.model_path so the next
		// stage_changed=test fires the 3D capture branch in
		// handleProofShotAutoTrigger (GeoForge3D only). Fire-and-forget;
		// we still let the generic "always deliver" block run so the Lead
		// gets a notice that a build output was registered.
		if (event.event_type === "last_artifact_set") {
			const modelPath = asString(payload.model_path);
			if (modelPath) {
				const cur = store.getSessionParams(event.execution_id) ?? {};
				const lastArtifact =
					typeof cur.last_artifact === "object" && cur.last_artifact !== null
						? (cur.last_artifact as Record<string, unknown>)
						: {};
				store.setSessionParams(event.execution_id, {
					...cur,
					last_artifact: { ...lastArtifact, model_path: modelPath },
				});
				console.log(
					`[event-route] last_artifact_set: ${event.execution_id} model_path=${modelPath}`,
				);
			} else {
				console.warn(
					`[event-route] last_artifact_set missing payload.model_path for ${event.execution_id}`,
				);
			}
		}

		// GEO-151: ProofShot artifact_emitted has a specialized delivery path
		// (resolves chat thread + builds artifact_delivery HookPayload + posts
		// to appendLeadEvent + runtime.deliver with correlation). If we hand
		// off here, skip the generic "always deliver" block below so the same
		// event doesn't produce TWO Lead inbox messages (one typed, one
		// generic).
		if (event.event_type === "artifact_emitted" && registry) {
			try {
				const result = await handleArtifactEvent(store, projects, registry, {
					event_id: event.event_id,
					execution_id: event.execution_id,
					issue_id: event.issue_id,
					project_name: event.project_name,
					payload,
				});
				if (result.handled) {
					res.json({
						ok: true,
						artifact_delivery: {
							seq: result.seq,
							delivered: result.delivered,
						},
					});
					return;
				}
				// not handled → fall through to generic path (logs only since
				// there's no Lead resolvable). Better than silently dropping.
			} catch (err) {
				console.error(
					`[event-route] handleArtifactEvent threw for ${event.execution_id}:`,
					(err as Error).message,
				);
				// Same fallthrough as above.
			}
		}

		// Best-effort notification push via RuntimeRegistry (GEO-195)
		const session = store.getSession(event.execution_id);
		const terminalFailure =
			event.event_type === "session_failed"
				? asTerminalFailureInfo(payload.failure)
				: undefined;
		if (
			terminalFailure?.failureKind === "worktree_takeover_failed" &&
			session
		) {
			await turnBeltReconciler?.current?.alertWorktreeTakeoverFailure(
				session,
				terminalFailure.failureReason,
			);
		}
		if (event.event_type === "session_failed" && autoQaCoordinator?.current) {
			try {
				await autoQaCoordinator.current.onQaSessionFailed(event.execution_id);
			} catch (err) {
				console.error(
					`[event-route] auto-QA failure hook threw for ${event.execution_id}: ${(err as Error).message}`,
				);
			}
		}

		// FLY-579: a main session that just entered awaiting_review (code review
		// passed, approve gate opened) → drive the auto-QA pipeline. This runs
		// BEFORE the always-deliver block below so the held record exists by the
		// time the QA-held suppression check is evaluated (held-first ordering,
		// plan §7.1). Coordinator absent / not-main / not-awaiting_review → no-op.
		if (
			event.event_type === "session_completed" &&
			autoQaCoordinator?.current &&
			session &&
			(session.session_role ?? "main") === "main" &&
			session.status === "awaiting_review" &&
			// FLY-869 B: a parked merged-but-unapproved session (merge_block marker)
			// must NOT drive auto-QA (design R2 HIGH-4 suppressor). Sister guard:
			// DirectEventSink.emitCompleted.
			!isMergeBlocked(session)
		) {
			try {
				await autoQaCoordinator.current.onMainAwaitingReview(session, {
					// FLY-752: a genuine fresh review-pass transitioned INTO
					// awaiting_review; a re-emitted / parked-for-founder one did not.
					freshTransition: autoQaPriorStatus !== "awaiting_review",
				});
			} catch (err) {
				console.error(
					`[event-route] onMainAwaitingReview threw for ${event.execution_id}: ${(err as Error).message}`,
				);
			}
		}

		// FLY-921 Fix C: a DAG workflow session reaching a terminal signal
		// (completed OR failed — the failed path never goes through
		// onPhaseComplete) may be the current TURN holder. Scoped reconcile with
		// guard 1: only acts when this exec IS the holder, so a handoff that just
		// moved the TURN to a fresh spawn is never raced. Runs AFTER the handoff
		// above (same event flow, serial). Sister call: DirectEventSink.ts.
		if (
			(event.event_type === "session_completed" ||
				event.event_type === "session_failed") &&
			turnBeltReconciler?.current &&
			session?.project_name &&
			isWorkflowPhaseRole(session.session_role)
		) {
			try {
				await turnBeltReconciler.current.reconcileTurnBelt({
					issueId: session.issue_id,
					projectName: session.project_name,
					terminalExecId: event.execution_id,
				});
			} catch (err) {
				console.error(
					`[event-route] reconcileTurnBelt threw for ${event.execution_id}: ${(err as Error).message}`,
				);
			}
		}

		// FLY-1282 Part C: targeted terminal-archive enqueue. Runs AFTER the
		// phase orchestration/handoff above so a DAG workflow successor row is
		// durable before the targeted check reads alias state. Fresh getSession
		// confirms the row actually landed completed (FSM-rejected / duplicate
		// terminal → zero enqueue). Post-ship completions and FLY-208
		// evidence-gap completions are excluded at their source sites;
		// stage_changed only enqueues via the accepted FLY-324 transition (the
		// W2 merged branch is post-ship-owned and structurally never enqueues).
		// Sister call: DirectEventSink.ts.
		if (
			terminalArchiveEnqueue &&
			!terminalArchiveExcluded &&
			!transitionRejected &&
			(event.event_type === "session_completed" || fly324Completed)
		) {
			const freshTerminalRow = store.getSession(event.execution_id);
			if (freshTerminalRow?.status === "completed") {
				try {
					terminalArchiveEnqueue(event.issue_id);
				} catch (err) {
					console.error(
						`[event-route] terminal-archive enqueue threw for ${event.issue_id}: ${(err as Error).message}`,
					);
				}
			}
		}

		if (session && registry) {
			try {
				// GEO-152: fallback to payload labels when session labels are empty
				const storedLabels = store.getSessionLabels(event.execution_id);
				const labels =
					storedLabels.length > 0
						? storedLabels
						: Array.isArray(payload.labels)
							? (payload.labels as string[])
							: [];
				const { lead } = registry.resolveWithLead(
					projects,
					event.project_name,
					labels,
				);
				const sessionKey = buildSessionKey(session);
				const hookPayload: HookPayload = {
					event_type: event.event_type,
					execution_id: event.execution_id,
					issue_id: event.issue_id,
					issue_identifier: session.issue_identifier,
					issue_title: session.issue_title,
					project_name: event.project_name,
					status: session.status,
					decision_route: session.decision_route,
					commit_count: session.commit_count,
					lines_added: session.lines_added,
					lines_removed: session.lines_removed,
					summary: session.summary,
					last_error: session.last_error,
					chat_channel: lead.chatChannel,
					issue_labels: labels,
					pr_number: session.pr_number,
					session_role: session.session_role ?? "main",
					design_backend: session.design_backend,
				};

				// FLY-47: Add stage_context for stage_changed events to prevent Lead misinterpretation
				// FLY-208 7a: the old text asserted PR state purely from
				// session.pr_number existence and said it with full confidence —
				// production showed it claiming "is OPEN ... do NOT tell Annie the
				// PR is merged" 31 seconds AFTER the merge, and "No PR detected"
				// 53 seconds after PR creation. Now: use the event's own
				// landing_status when it proves a merge; otherwise label the line
				// as a snapshot and tell the Lead to verify — never assert the
				// negative. Live PR querying is FLY-210 scope.
				if (event.event_type === "stage_changed") {
					const stage = asString(payload.stage);
					if (stage === "completed") {
						const stageLanding = payload.landing_status as
							| { status?: string; mergeCommitSha?: string }
							| undefined;
						const snapshotTs = new Date().toISOString();
						if (stageLanding?.status === "merged") {
							hookPayload.stage_context = `Runner completed work. PR #${session.pr_number ?? "?"} was merged by the Runner${stageLanding.mergeCommitSha ? ` (sha ${stageLanding.mergeCommitSha})` : ""}.`;
						} else if (session.pr_number) {
							hookPayload.stage_context = `Runner completed work. PR #${session.pr_number} status snapshot at ${snapshotTs}: last known not merged — verify with \`gh pr view ${session.pr_number}\` before reporting merge status to Annie.`;
						} else {
							hookPayload.stage_context = `Runner completed work. No PR recorded as of ${snapshotTs} (a just-created PR may not be ingested yet) — verify before reporting to Annie.`;
						}
					}
				}

				// FLY-159: Copy gate_timed_out payload fields onto hookPayload so the
				// Lead notification surface (chat thread / mailbox formatter) can
				// render checkpoint name, wait duration, and the Runner's original
				// message. Without this mapping, the Lead would only see a generic
				// "gate_timed_out" envelope with no actionable detail.
				if (event.event_type === "gate_timed_out") {
					hookPayload.checkpoint = asString(payload.checkpoint);
					hookPayload.waited_ms = asNumber(payload.waited_ms);
					hookPayload.original_message = asString(payload.original_message);
					hookPayload.timeout_behavior = asString(payload.timeout_behavior);
					hookPayload.timeout_behavior_source = asString(
						payload.timeout_behavior_source,
					);
					hookPayload.question_id = asString(payload.question_id);
				}

				// FLY-47 / FLY-163: Classify event — priority hints (chat-only).
				if (eventFilter) {
					const filterResult = eventFilter.classify(
						event.event_type,
						hookPayload,
					);
					hookPayload.filter_priority = filterResult.priority;
					hookPayload.notification_context = filterResult.reason;
				}

				// FLY-579: QA-held — do NOT surface "review required" to the
				// founder until QA is green. The GatePoller (approve gate) and
				// HeartbeatService (gate_timed_out) suppress in parallel via the
				// same isQaHeld predicate; the 🧪 QA-started post and the (on-pass)
				// ship-ready notification reach the issue thread through the
				// coordinator's ThreadPoster, NOT this block.
				if (
					event.event_type === "session_completed" &&
					(isReviewHeld(store, session) ||
						!store.workflowGatePresentationDisposition({
							executionId: event.execution_id,
							checkpoint: "approve_to_ship",
						}).allow)
				) {
					console.log(
						`[event-route] suppressing non-authoritative review-required Lead delivery for ${event.execution_id}`,
					);
				} else {
					// FLY-47: Always deliver ALL events to Lead — Lead decides routing
					// (mirrors Agent Team pattern: all teammate messages reach the lead)
					const seq = store.appendLeadEvent(
						lead.agentId,
						event.event_id,
						event.event_type,
						JSON.stringify(hookPayload),
						sessionKey,
					);
					const envelope: LeadEventEnvelope = {
						eventId: event.event_id,
						seq,
						event: hookPayload,
						sessionKey,
						leadId: lead.agentId,
						timestamp: new Date().toISOString(),
					};
					// FLY-80: Only mark delivered on success. On failure, leave undelivered
					// so inbox-mcp can pick it up on next poll (CommDB is the reliable store).
					// FLY-159 (Codex R2 Issue 1): runtime.deliver() returns {delivered:
					// false, error} instead of throwing on Lead-side failures. Without
					// recordDeliveryFailure on that branch, GUARDRAIL_EVENT_TYPES retry
					// the durable delivery-failure ledger would never see
					// these rows. Pattern mirrors HeartbeatService.ts:416.
					const isGuardrail = GUARDRAIL_EVENT_TYPES.has(event.event_type);
					registry
						.dispatchLeadEvent(envelope)
						.then((result) => {
							if (result.delivered) {
								store.markLeadEventDelivered(seq);
							} else if (result.queued) {
								// The durable inbox loop owns receipt, audit, and consume.
							} else if (isGuardrail) {
								store.recordDeliveryFailure(
									seq,
									result.error ?? "deliver returned delivered=false",
								);
							} else {
								// Non-guardrail: keep legacy best-effort behavior — mark
								// delivered to clear the row even if Lead didn't actually
								// see it (inbox-mcp poll is the safety net here).
								store.markLeadEventDelivered(seq);
							}
						})
						.catch((err) => {
							if (isGuardrail) {
								store.recordDeliveryFailure(seq, (err as Error).message);
							} else {
								console.warn(
									`[event-route] Delivery failed for seq=${seq} to ${lead.agentId}:`,
									(err as Error).message,
								);
							}
						});
				} // end else (FLY-579 QA-held review-required suppression)
			} catch (err) {
				console.warn(
					`[event-route] Unknown project "${event.project_name}" — skipping notification:`,
					(err as Error).message,
				);
			}
		}

		res.json({ ok: true });
	});

	return router;
}

// Export for testing
export { formatNotification };
