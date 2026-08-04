/**
 * FLY-1048 PR-C (C2): the Lead-first notification leg of the unified
 * escalation flow (PRD §4.3/§4.5).
 *
 * A detected episode notifies its OWNER Lead first — a quiet natural-language
 * issue-thread note (no mention) plus a guardrail lead_event into the Lead's
 * inbox — and only C3's reconcile pages the founder after the ~30min grace.
 *
 * The durable `detection_escalations` row (C1) is the authoritative
 * once-per-episode dedup AND the anchor of the grace timer: LEAD_NOTIFIED is
 * stamped only after the lead_event is durably queued, and the FIRST
 * notification timestamp wins forever.
 *
 * Privacy contract: `reason` is a kind-specific one-sentence summary — raw
 * pane text NEVER travels this path (the fail-suspicious A5 leg owns the
 * quoted tail; this leg never repeats it).
 */

import type { DetectionEscalationRow, StateStore } from "../StateStore.js";
import type { HookPayload } from "./hook-payload.js";
import { dispatchLeadEventCompat } from "./runtime-registry.js";

export interface DetectionEscalationInput {
	/** execId (runner) or `<project>:<leadId>` state key (lead). */
	targetKey: string;
	/** Detection kind (e.g. detection_stuck_confirmed / delivery_unconsumed). */
	kind: string;
	/** Stable episode key — same family as stuck_dispositions (C4a). */
	episodeFingerprint: string;
	/** Audit anchor for session_events / lead_events sessionKey. */
	executionId: string;
	issueId: string;
	issueIdentifier?: string;
	projectName: string;
	firstDetectedAtMs: number;
	/** Exact receipt lineage used by terminal settlement; never inferred from
	 * rendered alert text. */
	sourceReceiptId?: string;
	sourceExecutionId?: string;
	sourceQuestionId?: string;
	/** Kind-specific one-sentence summary. NO raw pane text — ever. */
	reason: string;
	/** Truthful next step for the Lead (formatParkAlert wording family). */
	nextStep?: string;
}

/** Resolved owner-Lead routing (same shape as the A5 suspicious owner). */
export interface EscalationOwner {
	leadId: string;
	projectName: string;
	executionId?: string;
	issueId?: string;
}

export interface NotifyLeadFirstDeps {
	store: Pick<
		StateStore,
		| "upsertDetectionEscalation"
		| "appendAndClaimDetectionEscalation"
		| "getDetectionEscalation"
		| "hasClearingDetectionEscalationForTarget"
		| "markLeadEventDelivered"
		| "recordDeliveryFailure"
	>;
	runtimeRegistry: {
		dispatchLeadEvent?(env: {
			seq: number;
			eventId?: string;
			event: HookPayload;
			sessionKey: string;
			leadId: string;
			timestamp: string;
		}): Promise<{ delivered: boolean; queued?: true; error?: string }>;
		getForLead(leadId: string):
			| {
					deliver(env: {
						seq: number;
						event: HookPayload;
						sessionKey: string;
						leadId: string;
						timestamp: string;
					}): Promise<{ delivered: boolean; error?: string }>;
			  }
			| null
			| undefined;
	};
	/** Owner-Lead resolution; null → no_owner (row stays NEW for retry). */
	resolveOwner: (input: DetectionEscalationInput) => EscalationOwner | null;
	/**
	 * Optional quiet issue-thread leg. The CALLER pre-guards the thread
	 * binding (Codex R1 #3 precedent: never call the thread helper with an
	 * undefined thread — omit this dep instead). Failures are non-fatal.
	 */
	emitThreadNote?: (
		input: DetectionEscalationInput,
		owner: EscalationOwner,
	) => Promise<void>;
	logger?: (msg: string) => void;
	now?: () => number;
}

export type NotifyLeadFirstOutcome =
	| "notified"
	| "already_notified"
	| "no_owner"
	/** C5: the target is in cleanup (a CLEARING row exists) — muted for now. */
	| "target_clearing";

/**
 * formatParkAlert-family truthful one-liner for the Lead-facing note:
 * `[FLY-XXX] [Watchdog] <reason>,下一步=<next step>`. Natural language, no
 * fixed card format (PRD §4.2), and never any pane content.
 */
export function formatEscalationLeadNote(
	input: DetectionEscalationInput,
): string {
	const label = input.issueIdentifier ?? input.issueId;
	const next = input.nextStep ?? "Lead 排查(第一响应人,§4.5)";
	return `[${label}] [Watchdog] ${input.reason},下一步=${next}`;
}

/**
 * Notify the owner Lead about a detected episode — exactly once per episode.
 *
 * Ordering contract (Codex R5 #2: the claim precedes every await):
 *   1. upsert the durable row; any status other than NEW ⇒ already handled.
 *   2. resolve the owner; failure leaves the row NEW so the next reconcile
 *      retries (never a silent drop).
 *   3. queue the guardrail lead_event (durable, synchronous, idempotent per
 *      event id — the HeartbeatService redelivery loop owns transport
 *      retries).
 *   4. atomically CLAIM NEW→LEAD_NOTIFIED (starts the ~30min grace clock,
 *      C3). Exactly one concurrent caller wins; losers return
 *      already_notified with no delivery and no thread note. Claiming after
 *      the append means a LEAD_NOTIFIED row always has its lead_event.
 *   5. winner only: best-effort immediate delivery + quiet thread note.
 *
 * NEVER throws: a notification bug must not crash the detection tick.
 */
export async function notifyLeadFirst(
	deps: NotifyLeadFirstDeps,
	input: DetectionEscalationInput,
): Promise<NotifyLeadFirstOutcome> {
	const logger =
		deps.logger ?? ((m: string) => console.log(`[detection-escalation] ${m}`));
	const nowMs = deps.now?.() ?? Date.now();

	const owner = deps.resolveOwner(input);

	const { row } = deps.store.upsertDetectionEscalation({
		targetKey: input.targetKey,
		kind: input.kind,
		episodeFingerprint: input.episodeFingerprint,
		issueId: input.issueId,
		ownerLeadId: owner?.leadId ?? null,
		firstDetectedAtMs: input.firstDetectedAtMs,
		sourceReceiptId: input.sourceReceiptId,
		sourceExecutionId: input.sourceExecutionId,
		sourceQuestionId: input.sourceQuestionId,
	});
	if (row.status !== "NEW") return "already_notified";

	// C5 cleanup mute: while ANY of the target's episodes is CLEARING
	// (close-runner / reap in flight), every detection kind stays quiet —
	// cleanup churn must not spam the Lead (FLY-970). The row above was still
	// upserted (detection-clock continuity); notification resumes when the
	// cleanup resolves or the CLEARING TTL rebounds it.
	if (deps.store.hasClearingDetectionEscalationForTarget(input.targetKey)) {
		logger(
			`target ${input.targetKey} is CLEARING — ${input.kind} notification muted (row kept NEW)`,
		);
		return "target_clearing";
	}

	if (!owner) {
		logger(
			`no owner lead resolvable for ${input.kind} ${input.targetKey} — row stays NEW for retry`,
		);
		return "no_owner";
	}

	const eventId = escalationEventId(row);
	const parkNotice = input.kind.startsWith("park:");
	const journalEventType = parkNotice
		? "runner_park_notice"
		: "detection_escalation";
	const payload: HookPayload = {
		event_type: journalEventType,
		execution_id: input.executionId,
		issue_id: input.issueId,
		issue_identifier: input.issueIdentifier,
		project_name: input.projectName,
		status: "detection_escalation",
		detection_target_key: input.targetKey,
		escalation_kind: input.kind,
		escalation_reason: input.reason,
		escalation_next_step: input.nextStep,
		// Receipt-derived episodes expose the bounded immutable parent id to the
		// Lead; the exact storage key remains internal for legacy-row settlement.
		episode_fingerprint: input.sourceReceiptId ?? input.episodeFingerprint,
		waited_ms: parkNotice
			? Math.max(0, nowMs - input.firstDetectedAtMs)
			: undefined,
	};

	// The atomic append+claim (Codex R5 #2 + R6 #1/#2) — one durability unit,
	// BEFORE the first await: a concurrent detection cannot double-deliver
	// while this call is parked at runtime.deliver, a crash cannot strand a
	// durable event beside a NEW row, and a recovered owner is backfilled
	// onto the row so the fleet aggregate routes to a real Lead.
	const { claimed, seq } = deps.store.appendAndClaimDetectionEscalation({
		leadId: owner.leadId,
		eventId,
		eventType: journalEventType,
		payload: JSON.stringify(payload),
		sessionKey: input.executionId,
		targetKey: input.targetKey,
		kind: input.kind,
		episodeFingerprint: input.episodeFingerprint,
		ownerLeadId: owner.leadId,
		atMs: nowMs,
	});
	if (!claimed) return "already_notified";

	try {
		const runtime = deps.runtimeRegistry.getForLead(owner.leadId);
		if (runtime) {
			const envelope = {
				seq,
				eventId,
				event: payload,
				sessionKey: input.executionId,
				leadId: owner.leadId,
				timestamp: new Date(nowMs).toISOString(),
			};
			const result = await dispatchLeadEventCompat(
				deps.runtimeRegistry,
				runtime,
				envelope,
			);
			if (result.delivered) deps.store.markLeadEventDelivered(seq);
			else if (!(result as { queued?: boolean }).queued)
				deps.store.recordDeliveryFailure(
					seq,
					result.error ?? "deliver returned false",
				);
		}
	} catch (err) {
		try {
			deps.store.recordDeliveryFailure(seq, (err as Error).message);
		} catch {
			/* best-effort */
		}
	}

	if (deps.emitThreadNote) {
		try {
			await deps.emitThreadNote(input, owner);
		} catch (err) {
			logger(`thread-note leg failed (non-fatal): ${(err as Error).message}`);
		}
	}

	return "notified";
}

/**
 * Stable lead_event id for one episode OCCURRENCE's Lead notification.
 * first_detected_at_ms is the occurrence salt (Codex R7 #1, the FLY-253
 * escalatedAt precedent): a machine-cleared recurrence revives the SAME
 * (target, kind, fingerprint) row with a NEW first_detected_at_ms, and must
 * get its OWN outbox row — reusing the prior occurrence's already-delivered
 * event would leave a failed immediate delivery with no heartbeat retry.
 * Retries of the same occurrence stay idempotent (the salt is unchanged).
 */
function escalationEventId(row: DetectionEscalationRow): string {
	return `detection-escalation-${row.target_key}-${row.kind}-${row.source_receipt_id ?? row.episode_fingerprint}-${row.first_detected_at_ms}`;
}

// ── C3: ~30min grace reconcile + fleet guard ──

/** PRD §4.3: Lead handling grace before the founder is paged (~30min). */
export const DEFAULT_DETECTION_LEAD_GRACE_MS = 1_800_000;

/** PRD §4.3 boundary: ≥K same-kind episodes = fleet-scale → FLY-915 lane. */
export const DEFAULT_DETECTION_FLEET_THRESHOLD = 4;

/** C5: cleanup mute horizon — a CLEARING row older than this rebounds to NEW. */
export const DEFAULT_CLEARING_TTL_MS = 7_200_000; // 2h

/**
 * Fleet-scale detection window (Codex code R1 #4): the threshold counts
 * ACTIVE same-kind episodes first-detected inside this window — durable,
 * so staggered deadlines still aggregate. Overridable per-deps (tests).
 */
export const DEFAULT_DETECTION_FLEET_WINDOW_MS = 3_600_000;

export interface ReconcileEscalationsDeps {
	store: Pick<
		StateStore,
		| "getDetectionEscalationsForReconcile"
		| "markDetectionEscalationEscalated"
		| "getDetectionEscalation"
		| "revertDetectionEscalationClearingToNew"
	>;
	/**
	 * Page the founder for one overdue episode (an @founder note in the issue
	 * thread, founder_page_ledger-deduped by the caller). MUST return true
	 * ONLY when the page is CONFIRMED posted — anything else leaves the row
	 * LEAD_NOTIFIED so the next reconcile retries (never a silent ESCALATED).
	 */
	pageFounder: (row: DetectionEscalationRow) => Promise<boolean>;
	/** Per-kind founder/fleet policy. Unset preserves the legacy behavior. */
	pagePolicy?: (
		row: DetectionEscalationRow,
	) => "page" | "lead_only" | "page_no_fleet";
	/**
	 * Fleet-scale aggregate (PRD §4.3 boundary): one ticket into the FLY-915
	 * alert lane for the whole same-kind group — the founder is NOT paged and
	 * Leads are not spammed per-episode.
	 */
	fleetSink: (kind: string, rows: DetectionEscalationRow[]) => Promise<void>;
	/** Lead handling grace (env FLYWHEEL_DETECTION_LEAD_GRACE_MS). */
	graceMs?: number;
	/**
	 * Per-row grace override (PRD §4.3: global + per-project 可配). Returning
	 * undefined falls back to `graceMs`. The plugin wires this to the row's
	 * project config; the core stays project-agnostic.
	 */
	graceMsFor?: (row: DetectionEscalationRow) => number | undefined;
	/** Fleet threshold (env FLYWHEEL_DETECTION_FLEET_THRESHOLD). */
	fleetThreshold?: number;
	/** Fleet-scale counting window over first_detected_at_ms. */
	fleetWindowMs?: number;
	/** C5: CLEARING rebound horizon (env FLYWHEEL_CLEARING_TTL_MS, default 2h). */
	clearingTtlMs?: number;
	/** Exact cohort filter. Receipt and legacy passes must never share rows. */
	kindFilter?: {
		includeKinds?: readonly string[];
		excludeKinds?: readonly string[];
	};
	/** False when the plugin already ran the shared all-cohort maintenance pass. */
	maintainClearing?: boolean;
	logger?: (msg: string) => void;
	now?: () => number;
}

export function reboundExpiredDetectionClearings(input: {
	store: Pick<
		StateStore,
		| "getDetectionEscalationsForReconcile"
		| "revertDetectionEscalationClearingToNew"
	>;
	nowMs: number;
	clearingTtlMs?: number;
	logger?: (msg: string) => void;
}): number {
	const logger =
		input.logger ??
		((message: string) => console.log(`[detection-escalation] ${message}`));
	const clearingTtlMs = input.clearingTtlMs ?? DEFAULT_CLEARING_TTL_MS;
	let rebounded = 0;
	for (const row of input.store.getDetectionEscalationsForReconcile()) {
		if (
			row.status !== "CLEARING" ||
			row.clearing_since_ms == null ||
			input.nowMs - row.clearing_since_ms < clearingTtlMs
		) {
			continue;
		}
		if (
			input.store.revertDetectionEscalationClearingToNew(
				row.target_key,
				row.kind,
				row.episode_fingerprint,
			)
		) {
			rebounded++;
			logger(
				`CLEARING TTL elapsed for ${row.kind} ${row.target_key} — rebounded to NEW (cleanup never finished)`,
			);
		}
	}
	return rebounded;
}

/**
 * One reconcile pass over the durable escalation rows (gate-poller piggyback
 * cadence): every LEAD_NOTIFIED episode whose grace elapsed with no Lead ack
 * escalates — individually via a founder page, or as one aggregate when the
 * same kind crossed the fleet threshold. Timing reads ONLY the durable
 * lead_notified_at_ms, so a Bridge restart can never restart the clock.
 * NEVER throws; a failing leg leaves its row LEAD_NOTIFIED for retry.
 */
export async function reconcileDetectionEscalations(
	deps: ReconcileEscalationsDeps,
): Promise<void> {
	const logger =
		deps.logger ?? ((m: string) => console.log(`[detection-escalation] ${m}`));
	const graceMs = deps.graceMs ?? DEFAULT_DETECTION_LEAD_GRACE_MS;
	const threshold = deps.fleetThreshold ?? DEFAULT_DETECTION_FLEET_THRESHOLD;
	const clearingTtlMs = deps.clearingTtlMs ?? DEFAULT_CLEARING_TTL_MS;
	const nowMs = deps.now?.() ?? Date.now();

	const rows = deps.store.getDetectionEscalationsForReconcile(deps.kindFilter);

	// C5 TTL rebound: a cleanup that never finished must not mute forever — a
	// CLEARING row past the TTL reverts to NEW so the episode can re-report.
	// Deliberately NOT paged in this same pass (it re-enters via a fresh
	// Lead-first notification, never straight to the founder).
	if (deps.maintainClearing !== false) {
		reboundExpiredDetectionClearings({
			store: deps.store,
			nowMs,
			clearingTtlMs,
			logger,
		});
	}

	const overdue = rows.filter(
		(r) =>
			r.status === "LEAD_NOTIFIED" &&
			r.lead_notified_at_ms != null &&
			nowMs - r.lead_notified_at_ms >= (deps.graceMsFor?.(r) ?? graceMs),
	);
	if (overdue.length === 0) return;

	const byKind = new Map<string, DetectionEscalationRow[]>();
	for (const row of overdue) {
		const group = byKind.get(row.kind);
		if (group) group.push(row);
		else byKind.set(row.kind, [row]);
	}

	for (const [kind, group] of byKind) {
		const policy = deps.pagePolicy?.(group[0]!) ?? "page";
		if (policy === "lead_only") continue;
		// Codex code R1 #4 + R2 #3: BOTH the fleet decision AND the aggregate
		// payload use the DURABLE active same-kind window set (ESCALATED
		// included) — staggered deadlines aggregate instead of paging the
		// founder K times, the ticket's count/eventId reflect the real
		// incident, and a late-arriving episode extends the SAME incident
		// (set-derived eventId) instead of minting per-episode tickets that
		// each claim a count of one.
		const windowFloor =
			nowMs - (deps.fleetWindowMs ?? DEFAULT_DETECTION_FLEET_WINDOW_MS);
		const activeSameKind = rows.filter(
			(r) => r.kind === kind && r.first_detected_at_ms >= windowFloor,
		);
		if (policy !== "page_no_fleet" && activeSameKind.length >= threshold) {
			try {
				await deps.fleetSink(kind, activeSameKind);
			} catch (err) {
				logger(
					`fleet sink failed for ${kind} (${group.length} episodes) — rows stay LEAD_NOTIFIED: ${(err as Error).message}`,
				);
				continue;
			}
			for (const row of group) {
				deps.store.markDetectionEscalationEscalated(
					row.target_key,
					row.kind,
					row.episode_fingerprint,
					nowMs,
				);
			}
			continue;
		}
		for (const row of group) {
			try {
				const posted = await deps.pageFounder(row);
				if (posted) {
					deps.store.markDetectionEscalationEscalated(
						row.target_key,
						row.kind,
						row.episode_fingerprint,
						nowMs,
					);
				}
			} catch (err) {
				logger(
					`founder page failed for ${row.kind} ${row.target_key} — row stays LEAD_NOTIFIED: ${(err as Error).message}`,
				);
			}
		}
	}
}
