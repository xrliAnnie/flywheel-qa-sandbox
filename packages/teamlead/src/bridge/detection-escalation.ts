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
	const payload: HookPayload = {
		event_type: "detection_escalation",
		execution_id: input.executionId,
		issue_id: input.issueId,
		issue_identifier: input.issueIdentifier,
		project_name: input.projectName,
		status: "detection_escalation",
		detection_target_key: input.targetKey,
		escalation_kind: input.kind,
		escalation_reason: input.reason,
		escalation_next_step: input.nextStep,
		episode_fingerprint: input.episodeFingerprint,
	};

	// The atomic append+claim (Codex R5 #2 + R6 #1/#2) — one durability unit,
	// BEFORE the first await: a concurrent detection cannot double-deliver
	// while this call is parked at runtime.deliver, a crash cannot strand a
	// durable event beside a NEW row, and a recovered owner is backfilled
	// onto the row so the fleet aggregate routes to a real Lead.
	const { claimed, seq } = deps.store.appendAndClaimDetectionEscalation({
		leadId: owner.leadId,
		eventId,
		eventType: "detection_escalation",
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
			const result = await runtime.deliver({
				seq,
				event: payload,
				sessionKey: input.executionId,
				leadId: owner.leadId,
				timestamp: new Date(nowMs).toISOString(),
			});
			if (result.delivered) deps.store.markLeadEventDelivered(seq);
			else
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
	return `detection-escalation-${row.target_key}-${row.kind}-${row.episode_fingerprint}-${row.first_detected_at_ms}`;
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
	logger?: (msg: string) => void;
	now?: () => number;
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

	const rows = deps.store.getDetectionEscalationsForReconcile();

	// C5 TTL rebound: a cleanup that never finished must not mute forever — a
	// CLEARING row past the TTL reverts to NEW so the episode can re-report.
	// Deliberately NOT paged in this same pass (it re-enters via a fresh
	// Lead-first notification, never straight to the founder).
	for (const row of rows) {
		if (
			row.status === "CLEARING" &&
			row.clearing_since_ms != null &&
			nowMs - row.clearing_since_ms >= clearingTtlMs
		) {
			deps.store.revertDetectionEscalationClearingToNew(
				row.target_key,
				row.kind,
				row.episode_fingerprint,
			);
			logger(
				`CLEARING TTL elapsed for ${row.kind} ${row.target_key} — rebounded to NEW (cleanup never finished)`,
			);
		}
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
		if (activeSameKind.length >= threshold) {
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

// ── C4a/C5: old-flow ownership guard ──

/**
 * The production impl of the old stuck flow's `unifiedOwnsEpisode` dep (C4a)
 * — true when the unified flow holds an ACTIVE episode for this exact
 * (target, fingerprint) under any kind, OR the target is in the C5 cleanup
 * mute (any CLEARING row): during cleanup the pane churns through NEW
 * fingerprints, and the old emitters must stay quiet for ALL of them
 * (FLY-970), not just the fingerprint the unified flow happens to hold.
 */
export function unifiedFlowOwnsTarget(
	store: Pick<
		StateStore,
		| "hasActiveDetectionEscalationForEpisode"
		| "hasClearingDetectionEscalationForTarget"
	>,
	targetKey: string,
	episodeFingerprint: string,
): boolean {
	return (
		store.hasActiveDetectionEscalationForEpisode(
			targetKey,
			episodeFingerprint,
		) || store.hasClearingDetectionEscalationForTarget(targetKey)
	);
}

// ── C3-w: runner-side recovery auto-RESOLVE ──

/**
 * Trusted state of one target, as decided by the PLUGIN's probe (D5: this
 * module never inspects tmux/sessions itself). `null` = unobservable
 * (lead-keyed target / vanished session) — never auto-resolve on absence.
 */
export interface RecoveredTargetState {
	/** The session reached a done/gone outcome — the runner no longer exists to be stuck. */
	terminal: boolean;
	/** Last observed session activity (epoch ms); null when unknown. */
	lastActivityAtMs: number | null;
}

export interface ResolveRecoveredDeps {
	store: Pick<
		StateStore,
		| "getDetectionEscalationsForReconcile"
		| "resolveDetectionEscalationsForTarget"
		| "ackDetectionEscalation"
	>;
	probe: (targetKey: string) => RecoveredTargetState | null;
	/**
	 * FLY-1048 C4 hardening: kinds that PROGRESS evidence may resolve. Fresh
	 * activity refutes "stuck" — it does NOT refute an unanswered ask, an
	 * unconsumed delivery or an unreported park (漏② typically happens on a
	 * runner that keeps working). A TERMINAL target still resolves every kind
	 * (the session is over). Unset = progress resolves everything (the C3-w
	 * behavior, right when only case-c kinds exist).
	 */
	progressResolvableKinds?: ReadonlySet<string>;
	logger?: (msg: string) => void;
}

/**
 * Close out every episode of a RECOVERED target (plan C3: "runner 侧状态恢复
 * (session 进展/terminal)→ 自动 RESOLVED"). Recovery evidence, either:
 *   - terminal: the session reached a done/gone outcome, or
 *   - progress: activity strictly newer than EVERY active episode's
 *     first_detected_at_ms — the "no progress since detection" premise broke.
 *
 * Target-wide resolution (ESCALATED rows included — the C1 method's
 * contract): a recovered runner must not keep any zombie episodes that would
 * suppress a FUTURE genuine episode via dedup. Unobservable targets are left
 * untouched, and a throwing probe only skips its own target.
 *
 * Returns the number of rows resolved.
 */
export function resolveRecoveredDetectionTargets(
	deps: ResolveRecoveredDeps,
): number {
	const logger =
		deps.logger ?? ((m: string) => console.log(`[detection-escalation] ${m}`));

	const rowsByTarget = new Map<
		string,
		{ newestDetectedAtMs: number; rows: DetectionEscalationRow[] }
	>();
	for (const row of deps.store.getDetectionEscalationsForReconcile()) {
		const group = rowsByTarget.get(row.target_key);
		if (!group) {
			rowsByTarget.set(row.target_key, {
				newestDetectedAtMs: row.first_detected_at_ms,
				rows: [row],
			});
		} else {
			group.rows.push(row);
			if (row.first_detected_at_ms > group.newestDetectedAtMs) {
				group.newestDetectedAtMs = row.first_detected_at_ms;
			}
		}
	}

	let resolved = 0;
	for (const [targetKey, group] of rowsByTarget) {
		let state: RecoveredTargetState | null;
		try {
			state = deps.probe(targetKey);
		} catch (err) {
			logger(
				`recovery probe failed for ${targetKey} — target skipped this pass: ${(err as Error).message}`,
			);
			continue;
		}
		if (!state) continue;
		const progressed =
			state.lastActivityAtMs != null &&
			state.lastActivityAtMs > group.newestDetectedAtMs;
		if (state.terminal) {
			// Terminal outranks the kind scope: the session is over, so every
			// episode — ESCALATED included (the C1 method's contract) — closes.
			const n = deps.store.resolveDetectionEscalationsForTarget(targetKey);
			if (n > 0) {
				resolved += n;
				logger(
					`target ${targetKey} recovered (terminal) — ${n} episode(s) auto-RESOLVED`,
				);
			}
			continue;
		}
		if (!progressed) continue;
		// Progress resolves only the declared kinds (unset = all, C3-w).
		let n = 0;
		for (const row of group.rows) {
			if (
				deps.progressResolvableKinds &&
				!deps.progressResolvableKinds.has(row.kind)
			) {
				continue;
			}
			if (
				deps.store.ackDetectionEscalation(
					row.target_key,
					row.kind,
					row.episode_fingerprint,
					{
						atMs: state.lastActivityAtMs ?? Date.now(),
						disposition: "resolve",
						// Machine-proven clear (Codex R3 #1): a genuine same-
						// fingerprint recurrence must revive; 'lead' never does.
						via: "recovery",
					},
				)
			) {
				n += 1;
			}
		}
		if (n > 0) {
			resolved += n;
			logger(
				`target ${targetKey} recovered (progressed) — ${n} episode(s) auto-RESOLVED`,
			);
		}
	}
	return resolved;
}
