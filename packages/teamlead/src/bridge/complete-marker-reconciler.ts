/**
 * FLY-172: Reconcile orphaned `flywheel-comm complete` fail-close markers.
 *
 * ## Why this exists
 * `flywheel-comm complete` (packages/flywheel-comm/src/commands/complete.ts) is
 * the Runner-driven `session_completed` emitter that `/spin` MUST call before
 * exiting (`.claude/commands/spin.md`). It POSTs to the STABLE Bridge `/events`
 * endpoint with 4 retries; if all fail (typically because a Flywheel restart had
 * the Bridge down for the ~tens-of-seconds completion window), it fail-closes by
 * writing a marker at `~/.flywheel/state/complete-failed/<execId>.json` carrying
 * the full `session_completed` body (route + evidence + PR number + summary).
 *
 * Nothing consumed that marker (complete.ts even has a comment lamenting the
 * missing "stale patrol"). So a Runner that genuinely finished — with its result
 * captured in the marker — would sit at `status=running` until its tmux window
 * died, then get force-failed by orphan reaping. False `failed`.
 *
 * ## What this does
 * Replays the marker's `session_completed` event back through the canonical
 * `/events` route via a loopback HTTP self-POST (Plan A — maximum parity with
 * the production ingest path: strict route guard, WorkflowFSM, post-ship
 * finalization, Lead notification, and `insertEvent` idempotency).
 *
 * Crucially, marker deletion is NOT based on HTTP 2xx: `/events` returns
 * `200 {ok,warning}` on invalid-route / FSM-reject, and inserts `event_id`
 * before the session update (so a same-id retry is a perpetual no-op). After
 * replay we re-read `store.getSession()` and verify it reached the status the
 * marker's payload PROVES (computed with the same mapping as `event-route.ts`),
 * and only then delete the marker. Anything ambiguous is quarantined.
 *
 * This module owns marker files + replay + verification ONLY. It does NOT probe
 * tmux and does NOT decide a session's fallback status — that is the caller's
 * job (HeartbeatService owns tmux liveness; see Codex design-review guidance #1),
 * so we never split-brain liveness decisions across the heartbeat loop.
 */

import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalSubmissionDigest } from "flywheel-config";
import { isNoOutEdgeTerminalStatus } from "flywheel-core";
import {
	type ApplyTransitionOpts,
	applyTransition,
} from "../applyTransition.js";
import type {
	Session,
	StateStore,
	WorkflowCompletionActivationContext,
} from "../StateStore.js";
import { ENGINE_INVARIANT_REASON_PREFIX } from "../workflow-engine-invariant.js";
import { validateDesignHtmlCompletion } from "./design-html-admission.js";
import type { MaterializedHeadAuthority } from "./materialized-head-authority.js";
import {
	computeAuthoritativeShipDecision,
	mergedPrCiProbe,
	parkMergeBlock,
} from "./merge-ship-gate.js";
import {
	type ShipAttemptSettle,
	settleShipAttemptFailed,
} from "./post-ship-finalization.js";
import { isClosedSettledCompletion } from "./workflow-completion-settled.js";

/**
 * Default marker directory — mirrors `flywheel-comm/complete.ts` writeMarker().
 * FLY-1608: QA slots override this path so their Bridge never drains production.
 */
export function defaultMarkerDir(): string {
	const fromEnv = process.env.FLYWHEEL_COMPLETE_MARKER_DIR?.trim();
	if (fromEnv) return fromEnv;
	return join(
		process.env.HOME ?? homedir(),
		".flywheel",
		"state",
		"complete-failed",
	);
}

/** One marker-dir knob must isolate quarantine too; never fall back separately. */
export function defaultQuarantineDir(): string {
	return `${defaultMarkerDir()}-quarantine`;
}

// FLY-222 #1 (Codex code-review MED-1): `no_code` must be a recognized route
// here too, else a fail-close marker from `complete --route no_code` (Bridge
// unreachable) is quarantined as unreplayable and the no-code run is wrongly
// force-failed / left stuck on boot drain.
const VALID_ROUTES = new Set([
	"auto_approve",
	"needs_review",
	"blocked",
	"ship_attempt_failed",
	"no_code",
	// FLY-493: pr_handoff (no-transport antigravity build+PR terminal) must be
	// recognized here too, else a fail-close marker from
	// `complete --route pr_handoff` is quarantined as unreplayable.
	"pr_handoff",
	// FLY-793 (Codex full-PR R1 #2): phase_design_complete is a `complete --route`,
	// so its crash-safety marker MUST be replayable — else a Design phase that
	// completes while Bridge is down is quarantined as unreplayable and the
	// Design→Implement handoff never fires (stranded).
	"phase_design_complete",
]);
const TERMINAL_STATUSES = new Set([
	"completed",
	"awaiting_review",
	"blocked",
	"failed",
]);

/**
 * FLY-869 B (Codex R1 #2): the TRUE no-out terminal states for the pre-replay
 * merge_block park — a merged-but-unapproved session is parked to `awaiting_review`
 * (which `TERMINAL_STATUSES` above deliberately treats as terminal for the replay
 * bookkeeping), so the park gate must use THIS narrower set. `awaiting_review` /
 * `approved_to_ship` are eligible to be (re-)parked; a session that already reached
 * one of these is genuinely done and must not be touched.
 */
const NO_OUT_TERMINAL_STATUSES = new Set(["completed", "blocked", "failed"]);

/**
 * Discriminated reconcile outcome (Codex R1 #4 / R2 #2). The caller force-fails
 * ONLY on `absent`; `transient_failed` blocks force-fail and retries later;
 * `reconciled`/`duplicate_terminal` mean the session reached its true terminal
 * status (caller deletes nothing else); `quarantined` means the marker file was
 * moved aside and the caller must choose a definite fallback status so no
 * "dead + stuck-in-running" session is left behind.
 */
export type ReconcileOutcome =
	| { kind: "absent" }
	| { kind: "reconciled"; status: string }
	| { kind: "duplicate_terminal"; status: string }
	// FLY-869 B (design R2 HIGH-4): a merged marker whose session is NOT
	// ship-eligible was parked with a merge_block marker + the complete-marker
	// SETTLED (deleted, NOT quarantined, NOT forced completed/failed).
	| { kind: "settled_merge_block"; head: string }
	| {
			kind: "settled_ship_attempt_failed";
			settle: ShipAttemptSettle["outcome"];
	  }
	| {
			kind: "held_for_lead";
			invariant: string;
			alertState: "accepted" | "pending";
	  }
	| { kind: "transient_failed"; error: string }
	| {
			kind: "quarantined";
			reason: "duplicate_nonterminal" | "invalid" | "rejected";
			/** Status the marker payload INTENDED, for the caller's fallback. */
			routeStatus?: string;
			/** Where the marker was moved, for last_error breadcrumbs. */
			quarantinePath: string;
	  };

export interface MarkerReconcilerDeps {
	store: StateStore;
	/** Already-built loopback base URL, e.g. `http://127.0.0.1:9876` or `http://[::1]:9876`. */
	bridgeBaseUrl: string;
	ingestToken?: string;
	/** Injectable for tests; defaults to global fetch. */
	fetchFn?: typeof fetch;
	markerDir?: string;
	quarantineDir?: string;
	log?: (msg: string) => void;
	/**
	 * FLY-869 决定③: fire the ONE loud merge_without_approval Lead alert when THIS
	 * restart-replay is the first to park a merged-but-unapproved marker (the live
	 * sinks fire it in-band; this covers a Bridge that died in the exact window
	 * before the live sink processed the completion). Best-effort; wired to the
	 * ReviewAuthorizationAlerts in plugin.ts. Absent → marker + log only.
	 */
	alertMergeWithoutApproval?: (session: Session, reason: string) => void;
	/**
	 * FLY-1505: durable ship-attempt alert. A rejected Promise keeps the
	 * complete-failed marker retryable instead of deleting the only alert receipt.
	 */
	alertShipAttemptFailed?: (session: Session, reason: string) => Promise<void>;
	/** FLY-1066: direct forceStatus fallback bypasses applyTransition. */
	onTerminalStatusPersisted?: (
		executionId: string,
		status: "failed" | "blocked",
		projectName: string,
	) => void;
	/** FLY-1307 PR-7.5: trusted receipt-backed head for output-backed reviews. */
	materializedHeadAuthority?: MaterializedHeadAuthority;
	/** FLY-1912: durable, event-id-deduplicated alert sink. */
	alertCompleteMarkerHeld?: (args: CompleteMarkerHeldAlert) => Promise<void>;
}

export interface CompleteMarkerHeldAlert {
	eventId: string;
	kind: "engine_invariant" | "unknown_5xx_episode";
	execId: string;
	issueId: string;
	projectName: string;
	session?: Session;
	markerPath: string;
	reason: string;
	httpStatus?: number;
	binding?: { runId: string; nodeId: string; attempt: number };
}

/**
 * Build a loopback base URL from the Bridge's configured host + port, handling
 * IPv6 (`::1`) bracketing (Codex R1 #5). The replay MUST target the actual
 * listener, not a hardcoded `127.0.0.1`.
 */
export function buildLoopbackBaseUrl(host: string, port: number): string {
	const h = host.includes(":") ? `[${host}]` : host;
	return `http://${h}:${port}`;
}

type ReplayLedger = {
	v: 1;
	mode: "backoff" | "held";
	streak: number;
	episode_started_at: string;
	last_status: number;
	last_at: string;
	next_probe_at: string;
	invariant?: string;
	alert_event_id?: string;
	alert_state?: "pending" | "accepted";
};

type MarkerBody = {
	event_id: string;
	execution_id: string;
	issue_id: string;
	project_name: string;
	event_type: string;
	source?: string;
	payload?: {
		decision?: { route?: string };
		evidence?: {
			landingStatus?: { status?: string };
			headSha?: string;
			prNumber?: number;
		};
		reviewQuestionId?: string;
		summary?: string;
		sessionRole?: string;
		workflowActivation?: WorkflowCompletionActivationContext;
		[k: string]: unknown;
	};
	replay_ledger?: unknown;
};

function markerWorkflowActivation(
	value: unknown,
): WorkflowCompletionActivationContext | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const row = value as Record<string, unknown>;
	if (
		typeof row.activationId !== "string" ||
		!row.activationId ||
		typeof row.runId !== "string" ||
		!row.runId ||
		typeof row.nodeId !== "string" ||
		!row.nodeId ||
		!Number.isInteger(row.attempt) ||
		Number(row.attempt) < 1 ||
		!Number.isInteger(row.turnEpoch) ||
		Number(row.turnEpoch) < 1
	) {
		return undefined;
	}
	return {
		activationId: row.activationId,
		runId: row.runId,
		nodeId: row.nodeId,
		attempt: Number(row.attempt),
		turnEpoch: Number(row.turnEpoch),
	};
}

/**
 * Compute the terminal status the marker's payload PROVES, using the EXACT same
 * mapping as `event-route.ts` `session_completed` branch (Codex R2 #6). Returns
 * `null` when the marker would be rejected by the strict route guard (invalid /
 * missing route with no post-approve-ship context), i.e. it cannot be replayed
 * into a known terminal state.
 */
export function expectedStatusFromMarker(
	body: MarkerBody,
	currentStatus: string | undefined,
	/**
	 * FLY-945 Fix C (Codex R1 #5): the session row's CURRENT
	 * `review_question_id`. Needed for the new-vs-old questionId comparison —
	 * `(body, currentStatus)` alone cannot express the recovery-lap criterion.
	 * Omitted (legacy call shape) → the comparison degrades to "marker carries
	 * ANY valid questionId", which still mirrors event-route when the row has
	 * no binding.
	 */
	currentReviewQuestionId?: string,
): string | null {
	const route = body.payload?.decision?.route;
	const landing = body.payload?.evidence?.landingStatus?.status;
	const isPostApproveShip = currentStatus === "approved_to_ship";

	// Strict route guard parity: invalid/missing route is only allowed for the
	// natural-completion (post-approve-ship) path.
	if (!isPostApproveShip && (!route || !VALID_ROUTES.has(route))) {
		return null;
	}

	if (route === "needs_review" || route === "auto_approve") {
		if (landing === "merged") return "completed";
		// FLY-208 5a (Codex PR-2 R1 HIGH): /events now maps
		// approved_to_ship + needs_review/auto_approve WITHOUT merged landing
		// to "completed" (evidence-gap unstick) instead of the FSM-invalid
		// awaiting_review. This expectation copy MUST mirror it — the stale
		// "awaiting_review" expectation made tryReconcileComplete() quarantine
		// a correctly-reconciled marker, and applyQuarantineFallback() could
		// then force the successfully-unstuck session to "failed" on boot
		// drain (a false failure on the exact Bridge-down recovery path the
		// markers exist to protect).
		//
		// FLY-945 Fix C: EXCEPT the recovery lap — approved_to_ship +
		// needs_review whose marker carries a NEW reviewQuestionId (`complete
		// --route needs_review --question-id` writes it into the completion
		// payload) ≠ the row's current binding → event-route maps it to
		// awaiting_review (fresh review window), so this expectation copy must
		// agree or the correctly-replayed marker gets quarantined. A missing /
		// malformed / SAME questionId fail-safes to the 5a "completed"
		// expectation exactly as before.
		if (isPostApproveShip && route === "needs_review") {
			const rawQid = body.payload?.reviewQuestionId;
			const markerQid =
				typeof rawQid === "string" && /^[0-9a-fA-F-]{8,64}$/.test(rawQid.trim())
					? rawQid.trim()
					: undefined;
			if (markerQid && markerQid !== currentReviewQuestionId) {
				return "awaiting_review";
			}
		}
		return isPostApproveShip ? "completed" : "awaiting_review";
	}
	if (route === "blocked") {
		return isPostApproveShip ? "approved_to_ship" : "blocked";
	}
	if (route === "ship_attempt_failed") {
		return isPostApproveShip ? "approved_to_ship" : null;
	}
	if (route === "no_code" || route === "pr_handoff") {
		// FLY-222 #1 (Codex code-review MED-2 parity): no_code only terminalizes a
		// RUNNING runner. From any non-running state, fail closed (null →
		// quarantine), mirroring event-route.ts's non-running skip — a no_code
		// marker must never clear a review-gated session.
		// FLY-493: pr_handoff behaves identically (running→completed, else null).
		return currentStatus === "running" ? "completed" : null;
	}
	if (route === "phase_design_complete") {
		// FLY-793 (Codex full-PR R1 #2): a Design phase only completes from RUNNING,
		// mapping to the non-terminal design_done (both sinks). From any non-running
		// state, fail closed (null → quarantine), mirroring the sink guards. NOTE:
		// after replay, event-route awaits the handoff which finalizes design_done →
		// completed — the post-replay status check accepts BOTH (see tryReconcile-
		// Complete), so this expectation returning design_done does not quarantine a
		// successfully-handed-off Design.
		return currentStatus === "running" ? "design_done" : null;
	}
	// route undefined here only reachable when isPostApproveShip — natural completion.
	return "completed";
}

function parseMarker(raw: string): MarkerBody | null {
	let obj: unknown;
	try {
		obj = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!obj || typeof obj !== "object") return null;
	const m = obj as Partial<MarkerBody>;
	if (
		typeof m.event_id !== "string" ||
		typeof m.execution_id !== "string" ||
		typeof m.issue_id !== "string" ||
		typeof m.project_name !== "string" ||
		m.event_type !== "session_completed"
	) {
		return null;
	}
	return m as MarkerBody;
}

function parseReplayLedger(
	value: unknown,
	log: (message: string) => void,
): ReplayLedger | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		log("[complete-reconciler] malformed replay ledger ignored");
		return undefined;
	}
	const row = value as Record<string, unknown>;
	const validTimestamp = (candidate: unknown) =>
		typeof candidate === "string" && Number.isFinite(Date.parse(candidate));
	const validAlertState =
		row.alert_state === undefined ||
		(row.alert_event_id !== undefined &&
			typeof row.alert_event_id === "string" &&
			(row.alert_state === "pending" || row.alert_state === "accepted"));
	if (
		row.v !== 1 ||
		(row.mode !== "backoff" && row.mode !== "held") ||
		!Number.isInteger(row.streak) ||
		Number(row.streak) < (row.mode === "backoff" ? 1 : 0) ||
		!Number.isInteger(row.last_status) ||
		!validTimestamp(row.episode_started_at) ||
		!validTimestamp(row.last_at) ||
		!validTimestamp(row.next_probe_at) ||
		(row.mode === "held" &&
			(typeof row.invariant !== "string" || !row.invariant)) ||
		!validAlertState
	) {
		log("[complete-reconciler] malformed replay ledger ignored");
		return undefined;
	}
	return row as ReplayLedger;
}

function persistReplayLedger(
	body: MarkerBody,
	markerPath: string,
	ledger: ReplayLedger,
	log: (message: string) => void,
): boolean {
	const tempPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(
			tempPath,
			JSON.stringify({ ...body, replay_ledger: ledger }),
			"utf8",
		);
		renameSync(tempPath, markerPath);
		body.replay_ledger = ledger;
		return true;
	} catch (error) {
		try {
			if (existsSync(tempPath)) unlinkSync(tempPath);
		} catch {
			// Best effort: the unique temp file is never a scan candidate.
		}
		log(
			`[complete-reconciler] replay ledger write failed ${markerPath}: ${(error as Error).message}`,
		);
		return false;
	}
}

function replayDelayMs(ledger: ReplayLedger): number {
	return ledger.mode === "held"
		? 60 * 60_000
		: Math.min(60_000 * 2 ** (ledger.streak - 1), 60 * 60_000);
}

function markerBinding(
	body: MarkerBody,
): { runId: string; nodeId: string; attempt: number } | undefined {
	const activation = markerWorkflowActivation(body.payload?.workflowActivation);
	return activation
		? {
				runId: activation.runId,
				nodeId: activation.nodeId,
				attempt: activation.attempt,
			}
		: undefined;
}

async function retryPendingReplayAlert(input: {
	body: MarkerBody;
	ledger: ReplayLedger;
	markerPath: string;
	session?: Session;
	deps: MarkerReconcilerDeps;
	log: (message: string) => void;
}): Promise<ReconcileOutcome> {
	const { body, ledger, markerPath, session, deps, log } = input;
	if (!ledger.alert_event_id || ledger.alert_state !== "pending") {
		return { kind: "transient_failed", error: "invalid pending alert ledger" };
	}
	if (!deps.alertCompleteMarkerHeld) {
		return {
			kind: "transient_failed",
			error: "complete-marker durable alert sink unavailable",
		};
	}
	try {
		await deps.alertCompleteMarkerHeld({
			eventId: ledger.alert_event_id,
			kind: ledger.mode === "held" ? "engine_invariant" : "unknown_5xx_episode",
			execId: body.execution_id,
			issueId: body.issue_id,
			projectName: body.project_name,
			session,
			markerPath,
			reason:
				ledger.mode === "held"
					? `Workflow completion is held by engine invariant ${ledger.invariant}; repair the workflow state and keep the marker for the hourly probe.`
					: `Workflow completion replay returned Bridge ${ledger.last_status} ${ledger.streak} consecutive times; the marker is retained with bounded retry.`,
			httpStatus: ledger.last_status,
			binding: markerBinding(body),
		});
	} catch (error) {
		return {
			kind: "transient_failed",
			error: error instanceof Error ? error.message : String(error),
		};
	}
	const accepted: ReplayLedger = { ...ledger, alert_state: "accepted" };
	if (!persistReplayLedger(body, markerPath, accepted, log)) {
		return {
			kind: "transient_failed",
			error: "replay ledger alert acceptance write failed",
		};
	}
	return ledger.mode === "held"
		? {
				kind: "held_for_lead",
				invariant: ledger.invariant ?? "unknown",
				alertState: "accepted",
			}
		: { kind: "transient_failed", error: `Bridge ${ledger.last_status}` };
}

/** Path-traversal guard for execId-derived filenames. */
function safeExecId(execId: string): boolean {
	return !/[/\\]|\.\./.test(execId) && execId.length > 0;
}

function moveToQuarantine(
	markerPath: string,
	quarantineDir: string,
	fileName: string,
	log: (m: string) => void,
): string {
	mkdirSync(quarantineDir, { recursive: true });
	const dest = join(quarantineDir, fileName);
	try {
		renameSync(markerPath, dest);
	} catch (err) {
		log(
			`[complete-reconciler] quarantine move failed ${markerPath} → ${dest}: ${(err as Error).message}`,
		);
	}
	return dest;
}

/**
 * Reconcile a single marker by execution id. Reads `<markerDir>/<execId>.json`,
 * replays it through `/events`, and verifies the session reached the marker's
 * proven terminal status before deleting. Does NOT touch session status on the
 * quarantine paths — returns the outcome so the caller applies a fallback with
 * its own tmux-liveness knowledge.
 */
const completeReconcileInFlight = new Map<string, Promise<ReconcileOutcome>>();

export async function tryReconcileComplete(
	execId: string,
	deps: MarkerReconcilerDeps,
): Promise<ReconcileOutcome> {
	if (!safeExecId(execId)) return { kind: "absent" };
	const markerDir = deps.markerDir ?? defaultMarkerDir();
	const markerPath = join(markerDir, `${execId}.json`);
	const existing = completeReconcileInFlight.get(markerPath);
	if (existing) return existing;
	const reconcile = tryReconcileCompleteOnce(execId, deps).finally(() => {
		if (completeReconcileInFlight.get(markerPath) === reconcile) {
			completeReconcileInFlight.delete(markerPath);
		}
	});
	completeReconcileInFlight.set(markerPath, reconcile);
	return reconcile;
}

async function tryReconcileCompleteOnce(
	execId: string,
	deps: MarkerReconcilerDeps,
): Promise<ReconcileOutcome> {
	const log = deps.log ?? ((m: string) => console.log(m));
	const markerDir = deps.markerDir ?? defaultMarkerDir();
	const quarantineDir = deps.quarantineDir ?? `${markerDir}-quarantine`;

	if (!safeExecId(execId)) return { kind: "absent" };

	const fileName = `${execId}.json`;
	const markerPath = join(markerDir, fileName);
	if (!existsSync(markerPath)) return { kind: "absent" };

	let raw: string;
	try {
		raw = readFileSync(markerPath, "utf8");
	} catch (err) {
		log(
			`[complete-reconciler] read failed ${markerPath}: ${(err as Error).message}`,
		);
		return { kind: "transient_failed", error: (err as Error).message };
	}

	const body = parseMarker(raw);
	if (!body) {
		const qp = moveToQuarantine(markerPath, quarantineDir, fileName, log);
		log(`[complete-reconciler] invalid marker quarantined: ${qp}`);
		return { kind: "quarantined", reason: "invalid", quarantinePath: qp };
	}

	// Filename execId must match payload execution_id (Codex R1 #7).
	if (body.execution_id !== execId) {
		const qp = moveToQuarantine(markerPath, quarantineDir, fileName, log);
		log(
			`[complete-reconciler] execId mismatch (file=${execId} payload=${body.execution_id}) quarantined: ${qp}`,
		);
		return { kind: "quarantined", reason: "invalid", quarantinePath: qp };
	}

	const currentSession = deps.store.getSession(execId);
	const currentStatus = currentSession?.status;
	const replayLedger = parseReplayLedger(body.replay_ledger, log);
	if (replayLedger?.alert_state === "pending") {
		return retryPendingReplayAlert({
			body,
			ledger: replayLedger,
			markerPath,
			session: currentSession,
			deps,
			log,
		});
	}
	const currentIdentifier = currentSession?.issue_identifier;
	const authoritativeIssueIdentifier =
		typeof currentIdentifier === "string" &&
		/^[A-Z]+-\d+$/.test(currentIdentifier)
			? currentIdentifier
			: /^[A-Z]+-\d+$/.test(body.issue_id)
				? body.issue_id
				: undefined;
	const designHtmlAdmission = validateDesignHtmlCompletion({
		route: body.payload?.decision?.route,
		payload: body.payload,
		authoritativeIssueIdentifier,
	});
	if (!designHtmlAdmission.ok) {
		const qp = moveToQuarantine(markerPath, quarantineDir, fileName, log);
		log(
			`[complete-reconciler] founder design HTML evidence rejected for ${execId}: ${designHtmlAdmission.reason}; quarantined: ${qp}`,
		);
		return { kind: "quarantined", reason: "invalid", quarantinePath: qp };
	}
	const rawWorkflowActivation = body.payload?.workflowActivation;
	const workflowActivation = markerWorkflowActivation(rawWorkflowActivation);
	if (rawWorkflowActivation !== undefined && !workflowActivation) {
		const qp = moveToQuarantine(markerPath, quarantineDir, fileName, log);
		log(
			`[complete-reconciler] malformed workflow activation quarantined ${execId}: ${qp}`,
		);
		return { kind: "quarantined", reason: "invalid", quarantinePath: qp };
	}
	const generalizedBinding = workflowActivation
		? deps.store.getGeneralizedWorkflowNodeForActivation(
				workflowActivation.activationId,
			)?.binding
		: deps.store.getGeneralizedWorkflowNodeForExecution(execId)?.binding;
	const generalizedReceipt = generalizedBinding
		? deps.store.getWorkflowNodeCompletion(
				generalizedBinding.run_id,
				generalizedBinding.node_id,
				generalizedBinding.attempt,
			)
		: undefined;
	const generalizedSubmissionDigest = canonicalSubmissionDigest(
		body.payload ?? {},
	);
	if (generalizedReceipt) {
		if (
			generalizedReceipt.execution_id !== execId ||
			generalizedReceipt.route !== body.payload?.decision?.route
		) {
			const qp = moveToQuarantine(markerPath, quarantineDir, fileName, log);
			log(
				`[complete-reconciler] generalized completion conflict quarantined ${execId}: ${qp}`,
			);
			return {
				kind: "quarantined",
				reason: "rejected",
				quarantinePath: qp,
			};
		}
		if (
			generalizedReceipt.completion_submission_digest ===
			generalizedSubmissionDigest
		) {
			const canonicalAuditId = `wfca:${generalizedReceipt.event_uid.slice("wfc:".length)}`;
			const canonicalAuditPayload =
				deps.store.getEventPayloadById(canonicalAuditId);
			if (canonicalAuditPayload) {
				if (
					canonicalSubmissionDigest(canonicalAuditPayload) !==
					generalizedReceipt.completion_submission_digest
				) {
					const qp = moveToQuarantine(markerPath, quarantineDir, fileName, log);
					log(
						`[complete-reconciler] generalized canonical audit conflict quarantined ${execId}: ${qp}`,
					);
					return {
						kind: "quarantined",
						reason: "rejected",
						quarantinePath: qp,
					};
				}
				safeUnlink(markerPath, log);
				return { kind: "duplicate_terminal", status: "node_completed" };
			}
		}
	}

	const markerLanding = body.payload?.evidence?.landingStatus?.status;

	// FLY-1505: an explicit failed-attempt settlement (or a legacy blocked
	// completion) after founder approval describes a ship ATTEMPT, not a blocked
	// session. Generalized completions and markers claiming a merge retain their
	// older authoritative replay/merge-block paths below.
	if (
		(body.payload?.decision?.route === "blocked" ||
			body.payload?.decision?.route === "ship_attempt_failed") &&
		currentStatus === "approved_to_ship" &&
		!generalizedBinding &&
		markerLanding !== "merged"
	) {
		let settle: ShipAttemptSettle;
		try {
			const markerPrNumber = body.payload?.evidence?.prNumber;
			const markerReviewQuestionId = body.payload?.reviewQuestionId;
			const usableMarkerPrNumber =
				typeof markerPrNumber === "number" &&
				Number.isInteger(markerPrNumber) &&
				markerPrNumber > 0
					? markerPrNumber
					: undefined;
			settle = settleShipAttemptFailed(deps.store, execId, {
				attemptHeadSha: body.payload?.evidence?.headSha,
				currentHeadSha: currentSession?.pr_head_sha,
				prNumber:
					usableMarkerPrNumber ?? currentSession?.pr_number ?? undefined,
				reviewQuestionId:
					typeof markerReviewQuestionId === "string"
						? markerReviewQuestionId
						: undefined,
				currentReviewQuestionId: currentSession?.review_question_id,
				summary: body.payload?.summary,
			});
			if (
				(settle.outcome === "marked" ||
					settle.outcome === "unknown_head_marked") &&
				currentSession
			) {
				const retryPosture =
					settle.outcome === "marked"
						? "同 head 的自动重唤醒已暂停，请由 Lead 显式唤醒。"
						: "本次完成未携带可验证的 head；自动重唤醒仍开启（fail-open）。";
				// The notifier event id is approval-binding + head deduped. Await
				// it before consuming the durable marker so a transient notifier
				// failure is replayed after restart instead of becoming silent.
				if (!deps.alertShipAttemptFailed) {
					throw new Error("ship_attempt_failed durable alert sink unavailable");
				}
				await deps.alertShipAttemptFailed(
					currentSession,
					`⚠️ Runner ${execId}（${currentSession.issue_id}）报告 ship attempt 失败/停滞；会话保持 approved_to_ship，founder 批准仍有效。请检查 PR #${usableMarkerPrNumber ?? currentSession.pr_number ?? "unknown"} 的 ship workflow；诊断后重试前先重新运行 verify-approval。${retryPosture}`,
				);
			}
		} catch (err) {
			return { kind: "transient_failed", error: String(err) };
		}
		safeUnlink(markerPath, log);
		log(
			`[complete-reconciler] FLY-1505 ship_attempt_failed deflected for ${execId} — approved_to_ship preserved (${settle.outcome})`,
		);
		return {
			kind: "settled_ship_attempt_failed",
			settle: settle.outcome,
		};
	}

	// FLY-869 B (design R2 HIGH-4): a merged marker whose session is NOT
	// ship-eligible must NOT reconcile to `completed` (that would finalize/Done a
	// merge_without_approval). Park it + SETTLE the marker (delete — the marker did
	// its job; do NOT quarantine or force completed/failed). Same-head approval
	// recovery later clears the park. Checked BEFORE the replay so the reconciler's
	// expected-status bookkeeping never quarantines a legitimately-blocked merge.
	//
	// Codex R1 #2: `TERMINAL_STATUSES` here INCLUDES `awaiting_review` (used by the
	// replay bookkeeping below), but a merged-without-approval session is parked to
	// EXACTLY `awaiting_review` — so this pre-replay park must run for it. Gate only on
	// the true no-out terminals ({completed, blocked, failed}); `awaiting_review` /
	// `approved_to_ship` fall through to the eligibility check (an approved+merged row is
	// eligible → not parked → normal completion; a parked/unapproved row → parked here).
	if (
		markerLanding === "merged" &&
		currentSession &&
		!currentSession.merge_block_reason &&
		!NO_OUT_TERMINAL_STATUSES.has(currentStatus ?? "")
	) {
		// Prefer the persisted row head; fall back to the marker's own head evidence
		// (Codex R1 #2 — a crash before the row's pr_head_sha was written must still
		// resolve a head so verifyApproval fail-closes correctly rather than passing).
		const prHead =
			currentSession.pr_head_sha?.trim() ||
			body.payload?.evidence?.headSha?.trim();
		// Always route through the shared predicate so the always-armed QA/review
		// checks and the remaining merge-approval switch stay uniform. A missing
		// head fail-closes whenever merge approval is armed.
		const decision = await computeAuthoritativeShipDecision(
			deps.store,
			currentSession,
			prHead,
			process.env,
			deps.materializedHeadAuthority,
			mergedPrCiProbe,
		);
		const eligible = decision.eligible;
		if (!eligible) {
			const claimed = parkMergeBlock(
				deps.store,
				currentSession,
				decision.authoritativeHead || prHead || "",
				decision ?? {
					eligible: false,
					mergeApprovalOk: false,
					qaOk: false,
					mergeReason: "no_pr_head",
					qaReason: "session_not_found",
				},
			);
			safeUnlink(markerPath, log);
			log(
				`[complete-reconciler] FLY-869 merge_without_approval ${execId} — parked + marker settled (no finalize)`,
			);
			// FLY-869 决定③: one loud Discord alert on the first claim (once per head).
			if (claimed) {
				deps.alertMergeWithoutApproval?.(
					currentSession,
					`⛔ Runner ${execId}（${currentSession.issue_id}）自行 merge 但未获批准（重启对账发现：merged head ${prHead ?? "(none)"} 未通过 ship 闸：merge=${decision.mergeReason} qa=${decision.qaReason}）。已挂 merge_block、未标 Done、issue 留 open，不会自动 revert —— 需要人来处理。`,
				);
			}
			return { kind: "settled_merge_block", head: prHead ?? "" };
		}
	}

	const expectedStatus = expectedStatusFromMarker(
		body,
		currentStatus,
		currentSession?.review_question_id,
	);
	if (expectedStatus === null && !generalizedBinding) {
		// FLY-222 #1 (Codex code-review R2 MED): if the session already reached a
		// terminal state, an unreplayable/stale marker (e.g. a no_code marker that
		// lost its response AFTER the Bridge already completed the run, or any
		// non-running no_code) is MOOT — it must NOT regress that state via the
		// quarantine fallback (completed→failed) or clear a review gate. Treat as a
		// duplicate (delete, no quarantine, no fallback mutation).
		if (currentStatus && TERMINAL_STATUSES.has(currentStatus)) {
			safeUnlink(markerPath, log);
			log(
				`[complete-reconciler] unreplayable marker for already-terminal ${execId} (status=${currentStatus}) — duplicate, deleted`,
			);
			return { kind: "duplicate_terminal", status: currentStatus };
		}
		// Strict route guard would 200+warning this — not replayable to a known
		// terminal state. Quarantine and let caller fallback (which itself only
		// mutates a session still stuck in `running` — see applyQuarantineFallback).
		const qp = moveToQuarantine(markerPath, quarantineDir, fileName, log);
		log(
			`[complete-reconciler] unreplayable route quarantined ${execId}: ${qp}`,
		);
		return { kind: "quarantined", reason: "rejected", quarantinePath: qp };
	}

	// If already at expected terminal state, nothing to replay — just delete.
	if (!generalizedBinding && currentStatus === expectedStatus) {
		safeUnlink(markerPath, log);
		return { kind: "duplicate_terminal", status: expectedStatus };
	}
	const replayNowMs = Date.now();
	if (replayLedger && replayNowMs < Date.parse(replayLedger.next_probe_at)) {
		return replayLedger.mode === "held"
			? {
					kind: "held_for_lead",
					invariant: replayLedger.invariant ?? "unknown",
					alertState: replayLedger.alert_state ?? "accepted",
				}
			: {
					kind: "transient_failed",
					error: `Bridge ${replayLedger.last_status}; next probe ${replayLedger.next_probe_at}`,
				};
	}

	// Replay via loopback self-POST.
	const fetchFn = deps.fetchFn ?? fetch;
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (deps.ingestToken) headers.Authorization = `Bearer ${deps.ingestToken}`;
	const replayBody = {
		event_id: body.event_id,
		execution_id: body.execution_id,
		issue_id: body.issue_id,
		project_name: body.project_name,
		event_type: body.event_type,
		source: body.source ?? "flywheel-comm",
		payload: body.payload ?? {},
	};

	let json:
		| {
				ok?: boolean;
				duplicate?: boolean;
				warning?: string;
				reason?: string;
				retryable?: boolean;
				settled?: string;
				detail?: {
					transitionReason?: string;
					alertPending?: boolean;
				};
		  }
		| undefined;
	let response: Response;
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 5000);
		try {
			response = await fetchFn(`${deps.bridgeBaseUrl}/events`, {
				method: "POST",
				headers,
				body: JSON.stringify(replayBody),
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timer);
		}
		try {
			json = (await response.json()) as typeof json;
		} catch {
			json = undefined;
		}
		if (response.status === 429) {
			if (replayLedger) {
				const pushed: ReplayLedger = {
					...replayLedger,
					last_status: response.status,
					last_at: new Date(replayNowMs).toISOString(),
					next_probe_at: new Date(
						replayNowMs + replayDelayMs(replayLedger),
					).toISOString(),
				};
				if (!persistReplayLedger(body, markerPath, pushed, log)) {
					return {
						kind: "transient_failed",
						error: "replay ledger probe deferral write failed",
					};
				}
			}
			return { kind: "transient_failed", error: "Bridge 429" };
		}
		if (response.status >= 500) {
			const streak =
				replayLedger?.mode === "backoff" ? replayLedger.streak + 1 : 1;
			const episodeStartedAt =
				replayLedger?.mode === "backoff"
					? replayLedger.episode_started_at
					: new Date(replayNowMs).toISOString();
			const backoff: ReplayLedger = {
				v: 1,
				mode: "backoff",
				streak,
				episode_started_at: episodeStartedAt,
				last_status: response.status,
				last_at: new Date(replayNowMs).toISOString(),
				next_probe_at: new Date(
					replayNowMs + Math.min(60_000 * 2 ** (streak - 1), 60 * 60_000),
				).toISOString(),
				...(replayLedger?.mode === "backoff" && replayLedger.alert_event_id
					? {
							alert_event_id: replayLedger.alert_event_id,
							alert_state: replayLedger.alert_state,
						}
					: {}),
				...(streak === 3
					? {
							alert_event_id: `complete-marker-5xx:${execId}:${episodeStartedAt}`,
							alert_state: "pending" as const,
						}
					: {}),
			};
			if (!persistReplayLedger(body, markerPath, backoff, log)) {
				return {
					kind: "transient_failed",
					error: "replay ledger backoff write failed",
				};
			}
			if (backoff.alert_state === "pending") {
				return retryPendingReplayAlert({
					body,
					ledger: backoff,
					markerPath,
					session: currentSession,
					deps,
					log,
				});
			}
			return {
				kind: "transient_failed",
				error: `Bridge ${response.status}`,
			};
		}
		if (!response.ok) {
			if (
				generalizedBinding &&
				response.status === 409 &&
				json?.reason === "missing_output" &&
				json.retryable === true
			) {
				return { kind: "transient_failed", error: "missing_output" };
			}
			const transitionReason = json?.detail?.transitionReason;
			if (
				response.status === 409 &&
				transitionReason?.startsWith(ENGINE_INVARIANT_REASON_PREFIX)
			) {
				const invariant = transitionReason.slice(
					ENGINE_INVARIANT_REASON_PREFIX.length,
				);
				const binding = generalizedBinding
					? {
							runId: generalizedBinding.run_id,
							nodeId: generalizedBinding.node_id,
							attempt: generalizedBinding.attempt,
						}
					: markerBinding(body);
				const alertEventId = binding
					? `engine_invariant:${binding.runId}:${binding.nodeId}:${binding.attempt}:${invariant}`
					: `engine_invariant:${execId}:${invariant}`;
				const priorHeld =
					replayLedger?.mode === "held" && replayLedger.invariant === invariant
						? replayLedger
						: undefined;
				const held: ReplayLedger = {
					v: 1,
					mode: "held",
					streak: 0,
					episode_started_at:
						priorHeld?.episode_started_at ??
						new Date(replayNowMs).toISOString(),
					last_status: response.status,
					last_at: new Date(replayNowMs).toISOString(),
					next_probe_at: new Date(replayNowMs + 60 * 60_000).toISOString(),
					invariant,
					alert_event_id: priorHeld?.alert_event_id ?? alertEventId,
					alert_state:
						priorHeld?.alert_state ??
						(json?.detail?.alertPending ? "pending" : "accepted"),
				};
				if (!persistReplayLedger(body, markerPath, held, log)) {
					return {
						kind: "transient_failed",
						error: "replay ledger held write failed",
					};
				}
				if (held.alert_state === "pending") {
					return retryPendingReplayAlert({
						body,
						ledger: held,
						markerPath,
						session: currentSession,
						deps,
						log,
					});
				}
				return {
					kind: "held_for_lead",
					invariant,
					alertState: "accepted",
				};
			}
			// 4xx (non-429) — malformed request, won't succeed on retry.
			const qp = moveToQuarantine(markerPath, quarantineDir, fileName, log);
			log(
				`[complete-reconciler] replay 4xx (${response.status}) quarantined ${execId}: ${qp}`,
			);
			return {
				kind: "quarantined",
				reason: "rejected",
				routeStatus: expectedStatus ?? undefined,
				quarantinePath: qp,
			};
		}
	} catch (err) {
		// Network error / abort — Bridge unreachable. Keep marker, retry later.
		if (replayLedger) {
			const pushed: ReplayLedger = {
				...replayLedger,
				last_at: new Date(replayNowMs).toISOString(),
				next_probe_at: new Date(
					replayNowMs + replayDelayMs(replayLedger),
				).toISOString(),
			};
			if (!persistReplayLedger(body, markerPath, pushed, log)) {
				return {
					kind: "transient_failed",
					error: "replay ledger probe deferral write failed",
				};
			}
		}
		return { kind: "transient_failed", error: (err as Error).message };
	}

	if (generalizedBinding) {
		if (isClosedSettledCompletion(json?.settled)) {
			safeUnlink(markerPath, log);
			return { kind: "reconciled", status: json.settled };
		}
		if (json?.settled === "terminal_status_immune") {
			const verifiedStatus = deps.store.getSession(execId)?.status;
			if (
				isNoOutEdgeTerminalStatus(verifiedStatus) &&
				verifiedStatus !== "completed"
			) {
				safeUnlink(markerPath, log);
				return { kind: "reconciled", status: "terminal_status_immune" };
			}
			return {
				kind: "transient_failed",
				error: "terminal_status_immune status verification failed",
			};
		}
		const receipt = deps.store.getWorkflowNodeCompletion(
			generalizedBinding.run_id,
			generalizedBinding.node_id,
			generalizedBinding.attempt,
		);
		if (
			receipt?.execution_id === execId &&
			receipt.route === body.payload?.decision?.route &&
			receipt.completion_submission_digest === generalizedSubmissionDigest
		) {
			const canonicalAuditId = `wfca:${receipt.event_uid.slice("wfc:".length)}`;
			const canonicalAuditPayload =
				deps.store.getEventPayloadById(canonicalAuditId);
			if (
				canonicalAuditPayload &&
				canonicalSubmissionDigest(canonicalAuditPayload) ===
					receipt.completion_submission_digest
			) {
				safeUnlink(markerPath, log);
				return { kind: "reconciled", status: "node_completed" };
			}
		}
		return {
			kind: "transient_failed",
			error:
				json?.warning ??
				"generalized completion receipt or canonical audit missing",
		};
	}

	// Re-read session and verify it reached the proven terminal status. Do NOT
	// trust HTTP 2xx (event-route returns 200+warning on FSM/route rejection).
	const afterStatus = deps.store.getSession(execId)?.status;
	// FLY-793 (Codex full-PR R1 #2): phase_design_complete's replay lands at
	// design_done, then event-route AWAITS the handoff which finalizes it to
	// completed (success) or leaves it design_done (fail-closed + Lead alert). BOTH
	// mean the Design completion was reconciled — accept either, or a
	// successfully-handed-off Design gets falsely quarantined + force-failed on boot.
	const isPhaseDesign =
		body.payload?.decision?.route === "phase_design_complete";
	if (
		afterStatus === expectedStatus ||
		(isPhaseDesign && afterStatus === "completed")
	) {
		safeUnlink(markerPath, log);
		return { kind: "reconciled", status: afterStatus ?? expectedStatus };
	}

	// Duplicate event_id but session never reached terminal — same-id retry is a
	// perpetual no-op (event-route returns early on duplicate). Quarantine.
	if (json?.duplicate) {
		const qp = moveToQuarantine(markerPath, quarantineDir, fileName, log);
		log(
			`[complete-reconciler] duplicate non-terminal quarantined ${execId} (status=${afterStatus}): ${qp}`,
		);
		return {
			kind: "quarantined",
			reason: "duplicate_nonterminal",
			routeStatus: expectedStatus ?? undefined,
			quarantinePath: qp,
		};
	}

	// 200 + warning (route guard / FSM rejected) — not replayable. Quarantine.
	const qp = moveToQuarantine(markerPath, quarantineDir, fileName, log);
	log(
		`[complete-reconciler] replay did not reach ${expectedStatus} (got ${afterStatus}, warning=${json?.warning}) quarantined ${execId}: ${qp}`,
	);
	return {
		kind: "quarantined",
		reason: "rejected",
		routeStatus: expectedStatus ?? undefined,
		quarantinePath: qp,
	};
}

function safeUnlink(path: string, log: (m: string) => void): void {
	try {
		unlinkSync(path);
	} catch (err) {
		log(
			`[complete-reconciler] delete failed ${path}: ${(err as Error).message}`,
		);
	}
}

/**
 * Apply the fallback terminal status for a quarantined marker (Codex R2 #3).
 * Used by both boot drain and the heartbeat reconcile pass. The caller decides
 * whether tmux is alive: when dead, the session is forced to a definite terminal
 * status (route's intended status, or `failed`) with a breadcrumb to the
 * quarantine path so no dead session is left stuck in `running`. When alive, the
 * session is left running (the Runner is still working; monitor-lost advisory
 * handles it).
 */
export function applyQuarantineFallback(args: {
	store: StateStore;
	transitionOpts?: ApplyTransitionOpts;
	executionId: string;
	issueId?: string;
	projectName?: string;
	tmuxAlive: boolean;
	/**
	 * FLY-1282 (code R1 #5): optional tri-state verdict for HONEST logging.
	 * `tmuxAlive` keeps its legacy meaning ("not provably dead") byte-for-byte
	 * for existing boolean callers; when the caller also passes the verdict,
	 * an indeterminate probe is logged as indeterminate — never as "alive".
	 */
	livenessVerdict?: "alive" | "dead" | "indeterminate";
	routeStatus?: string;
	quarantinePath: string;
	onTerminalStatusPersisted?: (
		executionId: string,
		status: "failed" | "blocked",
		projectName: string,
	) => void;
	log?: (m: string) => void;
}): void {
	const log = args.log ?? ((m: string) => console.log(m));
	if (args.tmuxAlive) {
		log(
			args.livenessVerdict === "indeterminate"
				? `[complete-reconciler] ${args.executionId}: marker quarantined, liveness indeterminate — leaving running (never reaped on uncertainty)`
				: `[complete-reconciler] ${args.executionId}: marker quarantined but tmux alive — leaving running, advisory will fire`,
		);
		return;
	}
	// FLY-222 #1 (Codex code-review R2 MED): this fallback exists ONLY to rescue a
	// dead Runner left stuck in `running`. A session that already progressed off
	// `running` (completed / awaiting_review / approved_to_ship / any terminal)
	// must NOT be forced to `failed` by a stale quarantined marker — that would
	// regress completed→failed or clear a review gate. Leave it untouched.
	const currentStatus = args.store.getSession(args.executionId)?.status;
	if (currentStatus !== "running") {
		log(
			`[complete-reconciler] ${args.executionId}: quarantined marker but status=${currentStatus ?? "none"} (not running) — leaving as-is (no fallback mutation)`,
		);
		return;
	}
	const target =
		args.routeStatus && TERMINAL_STATUSES.has(args.routeStatus)
			? args.routeStatus
			: "failed";
	const now = new Date()
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d+Z$/, "");
	const lastError = `complete reconcile failed, evidence quarantined at ${args.quarantinePath}`;

	// Codex R1 MEDIUM: prefer the canonical FSM/audit path when it allows the
	// transition (matches Codex design-review guidance #2). Only fall back to a
	// direct forced write when the FSM rejects — a genuine fail-close where a
	// dead Runner must NOT be left stuck in `running`.
	if (args.transitionOpts) {
		const result = applyTransition(
			args.transitionOpts,
			args.executionId,
			target,
			{
				executionId: args.executionId,
				issueId: args.issueId ?? "",
				projectName: args.projectName ?? "",
				trigger: "complete_marker_quarantine",
			},
			{ last_activity_at: now, last_error: lastError },
		);
		if (result.ok) {
			log(
				`[complete-reconciler] ${args.executionId}: dead + un-replayable marker → applyTransition status=${target}`,
			);
			return;
		}
		log(
			`[complete-reconciler] ${args.executionId}: FSM rejected ${target} (${result.error}) — fail-close forceStatus`,
		);
	}
	args.store.forceStatus(args.executionId, target, now, lastError);
	if (
		(target === "failed" || target === "blocked") &&
		args.projectName &&
		args.onTerminalStatusPersisted
	) {
		try {
			args.onTerminalStatusPersisted(
				args.executionId,
				target,
				args.projectName,
			);
		} catch (err) {
			log(
				`[complete-reconciler] terminal CommDB enqueue threw for ${args.executionId}: ${(err as Error).message}`,
			);
		}
	}
	log(
		`[complete-reconciler] ${args.executionId}: dead + un-replayable marker → forced status=${target}`,
	);
}

/**
 * Boot drain (Codex R1 #2): scan the marker directory once on Bridge startup and
 * reconcile every marker. Markers written just before/around the restart are
 * replayed immediately so a completed Runner's status is corrected without
 * waiting for the heartbeat loop. Event-driven (boot event), no new timer.
 *
 * Quarantine fallback at boot probes tmux per-marker (boot is not the heartbeat
 * loop, so this does not split-brain the loop's single-owner liveness rule).
 */
export async function reconcileCompleteFailedMarkers(
	deps: MarkerReconcilerDeps & {
		transitionOpts?: ApplyTransitionOpts;
		isTmuxWindowAlive?: (tmuxWindow: string) => Promise<boolean>;
		getTmuxTarget?: (
			executionId: string,
			projectName: string,
		) => { tmuxWindow: string } | undefined;
	},
): Promise<{
	scanned: number;
	reconciled: number;
	quarantined: number;
	held: number;
}> {
	const log = deps.log ?? ((m: string) => console.log(m));
	const markerDir = deps.markerDir ?? defaultMarkerDir();
	const result = { scanned: 0, reconciled: 0, quarantined: 0, held: 0 };

	if (!existsSync(markerDir)) return result;

	let files: string[];
	try {
		files = readdirSync(markerDir).filter((f) => f.endsWith(".json"));
	} catch (err) {
		log(
			`[complete-reconciler] boot drain: cannot read ${markerDir}: ${(err as Error).message}`,
		);
		return result;
	}

	for (const file of files) {
		result.scanned += 1;
		const execId = file.replace(/\.json$/, "");
		const outcome = await tryReconcileComplete(execId, deps);
		if (
			outcome.kind === "reconciled" ||
			outcome.kind === "duplicate_terminal" ||
			// FLY-869 B: a settled merge_block is a successfully-PROCESSED marker
			// (parked, not finalized) — count it as reconciled, never fall back.
			outcome.kind === "settled_merge_block" ||
			// FLY-1505: the attempt marker was durably settled while the live
			// approval/session status was preserved.
			outcome.kind === "settled_ship_attempt_failed"
		) {
			result.reconciled += 1;
		} else if (outcome.kind === "held_for_lead") {
			result.held += 1;
		} else if (outcome.kind === "quarantined") {
			result.quarantined += 1;
			// Boot fallback: probe tmux to choose a definite terminal status.
			let tmuxAlive = false;
			const session = deps.store.getSession(execId);
			if (
				session?.project_name &&
				deps.getTmuxTarget &&
				deps.isTmuxWindowAlive
			) {
				const target = deps.getTmuxTarget(execId, session.project_name);
				if (target) {
					try {
						tmuxAlive = await deps.isTmuxWindowAlive(target.tmuxWindow);
					} catch {
						tmuxAlive = false;
					}
				}
			}
			applyQuarantineFallback({
				store: deps.store,
				transitionOpts: deps.transitionOpts,
				executionId: execId,
				issueId: session?.issue_id,
				projectName: session?.project_name,
				tmuxAlive,
				routeStatus: outcome.routeStatus,
				quarantinePath: outcome.quarantinePath,
				onTerminalStatusPersisted: deps.onTerminalStatusPersisted,
				log,
			});
		}
		// transient_failed / absent → leave for next boot or heartbeat cycle.
	}

	if (result.scanned > 0) {
		log(
			`[complete-reconciler] boot drain: scanned=${result.scanned} reconciled=${result.reconciled} quarantined=${result.quarantined} held=${result.held}`,
		);
	}
	return result;
}
