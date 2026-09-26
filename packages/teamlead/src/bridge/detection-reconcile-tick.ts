/**
 * FLY-1048 PR-C (C4+C5): the reconcile-tick assembly — everything the
 * unified escalation flow does on the GatePoller piggyback cadence, in one
 * injectable pass (the plugin wires it behind FLYWHEEL_DETECTION_ESCALATION;
 * env unset → the tick is never armed, current behavior byte-for-byte):
 *
 *   1. C5 clearing-TTL rebound — a cleanup that never finished must not mute
 *      an episode forever; lapsed CLEARING rows revert to NEW (可再报).
 *   2. Recovery auto-RESOLVE — targets whose trusted state says terminal /
 *      progressed close out all their episodes (D5: the probe consumes
 *      existing liveness signals only, injected by the plugin).
 *   3. FN4 delivery reconcile — fire `delivery_failed_reconcile` for
 *      undelivered lead_events (attempts exhausted / overdue) and clear
 *      episodes whose evidence got delivered or pruned. Evidence-honest
 *      scope (plan C4): only delivery attempts that exist today.
 *   4. The ~30min grace escalation (C3 core) — founder page / fleet lane.
 *
 * Plus `notifyUnlessClearing` (C5): the notify-leg guard that mutes EVERY
 * detection kind for a target while any of its episodes is CLEARING.
 */

import type { DetectionEscalationRow, StateStore } from "../StateStore.js";
import {
	buildDeliveryFailureInput,
	DELIVERY_FAILURE_KIND,
	evaluateDeliveryFailures,
	FN4_EXCLUDED_EVENT_TYPES,
	GAP_ESCALATION_KINDS,
	parseDeliveryFailureFingerprint,
} from "./detection-detector-wiring.js";
import {
	type DetectionEscalationInput,
	type RecoveredTargetState,
	reconcileDetectionEscalations,
	resolveRecoveredDetectionTargets,
} from "./detection-escalation.js";
import { parseSqliteUtcMs } from "./founder-notify-utils.js";

/** C5: cleanup grace before a muted episode may re-report (plan: default 2h). */
export const DEFAULT_CLEARING_TTL_MS = 7_200_000;

/**
 * FN4: retry budget matching the guardrail loop's exhaustion notion (the
 * getDeliveryStats "failed" bucket uses the same constant).
 */
export const DEFAULT_DELIVERY_MAX_ATTEMPTS = 3;

export interface DetectionReconcileTickDeps {
	store: Pick<
		StateStore,
		| "getDetectionEscalationsForReconcile"
		| "markDetectionEscalationEscalated"
		| "getDetectionEscalation"
		| "revertDetectionEscalationClearingToNew"
		| "resolveDetectionEscalationsForTarget"
		| "ackDetectionEscalation"
		| "getUndeliveredLeadEventsForReconcile"
		| "isLeadEventDeliveredBySeq"
		| "getSession"
		| "countActiveDetectionEscalationsByKind"
	>;
	/** C3 founder-page leg (createFounderPager). */
	pageFounder: (row: DetectionEscalationRow) => Promise<boolean>;
	/** C3 fleet lane (createFleetSink). */
	fleetSink: (kind: string, rows: DetectionEscalationRow[]) => Promise<void>;
	/** The C2 Lead-first notify leg (already CLEARING-guarded by the caller). */
	notify: (input: DetectionEscalationInput) => Promise<void>;
	/** Trusted-state probe for recovery auto-RESOLVE (D5). */
	recoveryProbe: (targetKey: string) => RecoveredTargetState | null;
	/** Kinds PROGRESS may resolve (terminal resolves all) — see
	 * resolveRecoveredDetectionTargets. Unset = all kinds. */
	progressResolvableKinds?: ReadonlySet<string>;
	graceMs?: number;
	graceMsFor?: (row: DetectionEscalationRow) => number | undefined;
	fleetThreshold?: number;
	clearingTtlMs?: number;
	/** FN4 undelivered-age threshold (wired to FLYWHEEL_GAP_UNCONSUMED_MS). */
	fn4OverdueMs: number;
	fn4MaxAttempts?: number;
	now?: () => number;
	logger?: (msg: string) => void;
}

export async function runDetectionReconcileTick(
	deps: DetectionReconcileTickDeps,
): Promise<void> {
	const logger =
		deps.logger ?? ((m: string) => console.log(`[detection-reconcile] ${m}`));
	const nowMs = deps.now?.() ?? Date.now();
	const maxAttempts = deps.fn4MaxAttempts ?? DEFAULT_DELIVERY_MAX_ATTEMPTS;

	// The C5 clearing-TTL rebound runs INSIDE reconcileDetectionEscalations
	// (C3 core, step 4 below) — it reads the same rows and reverts lapsed
	// CLEARING mutes to NEW before the grace pass.

	// 1. Recovery auto-RESOLVE (C3-w core; probe injected — D5).
	try {
		resolveRecoveredDetectionTargets({
			store: deps.store,
			probe: deps.recoveryProbe,
			progressResolvableKinds: deps.progressResolvableKinds,
			logger,
		});
	} catch (err) {
		logger(`recovery pass failed: ${(err as Error).message}`);
	}

	// 2. FN4: fire + clear. A failing pass must never block the grace
	// escalation below (each leg has its own catch).
	try {
		const candidates = deps.store
			.getUndeliveredLeadEventsForReconcile({
				maxAttempts,
				overdueCutoffMs: nowMs - deps.fn4OverdueMs,
				// Codex R3 #3: excluded BEFORE the LIMIT so 100 detection-family
				// rows can never starve genuine failures (matrix filter stays too).
				excludedEventTypes: [...FN4_EXCLUDED_EVENT_TYPES],
			})
			.map((row) => {
				// Codex code R1 #5: production lead_events carry MIXED session_key
				// encodings (execution ids AND `<project>:<identifier>` hook keys) —
				// resolve to a REAL execution id via the payload's own
				// execution_id first, else a session_key that actually resolves.
				// Neither resolving ⇒ sessionKey undefined ⇒ the matrix skips it
				// as unroutable (logged below via the findings loop's session read).
				let executionId: string | undefined;
				try {
					const payload = JSON.parse(row.payload ?? "null") as {
						execution_id?: unknown;
					} | null;
					if (
						typeof payload?.execution_id === "string" &&
						deps.store.getSession(payload.execution_id)
					) {
						executionId = payload.execution_id;
					}
				} catch {
					/* unparseable payload — fall through to session_key */
				}
				if (
					!executionId &&
					row.session_key &&
					deps.store.getSession(row.session_key)
				) {
					executionId = row.session_key;
				}
				return {
					seq: row.seq,
					leadId: row.lead_id,
					eventType: row.event_type,
					sessionKey: executionId,
					deliveryAttempts: row.delivery_attempts ?? 0,
					createdAtMs: parseSqliteUtcMs(row.created_at),
				};
			});
		const findings = evaluateDeliveryFailures(candidates, nowMs, {
			maxAttempts,
			overdueMs: deps.fn4OverdueMs,
		});
		for (const finding of findings) {
			const session = deps.store.getSession(finding.sessionKey);
			if (!session) {
				logger(
					`FN4: session ${finding.sessionKey} gone for failed event seq ${finding.seq} — unroutable, skipped`,
				);
				continue;
			}
			await deps.notify(buildDeliveryFailureInput(finding, session, nowMs));
		}
	} catch (err) {
		logger(`FN4 fire pass failed: ${(err as Error).message}`);
	}
	try {
		for (const row of deps.store.getDetectionEscalationsForReconcile()) {
			if (row.kind !== DELIVERY_FAILURE_KIND) continue;
			const parsed = parseDeliveryFailureFingerprint(row.episode_fingerprint);
			if (!parsed) continue;
			const delivered = deps.store.isLeadEventDeliveredBySeq(parsed.seq);
			// delivered OR the evidence row is gone (pruned) → the failure no
			// longer exists to escalate; close the episode.
			if (delivered !== false) {
				deps.store.ackDetectionEscalation(
					row.target_key,
					row.kind,
					row.episode_fingerprint,
					{ atMs: nowMs, disposition: "resolve", via: "recovery" },
				);
				logger(
					`FN4: seq ${parsed.seq} ${delivered === true ? "delivered" : "pruned"} — episode ${row.episode_fingerprint} auto-RESOLVED`,
				);
			}
		}
	} catch (err) {
		logger(`FN4 clear pass failed: ${(err as Error).message}`);
	}

	// 3. The ~30min grace escalation (C3 core — incl. the clearing-TTL rebound).
	await reconcileDetectionEscalations({
		store: deps.store,
		pageFounder: deps.pageFounder,
		fleetSink: deps.fleetSink,
		graceMs: deps.graceMs,
		graceMsFor: deps.graceMsFor,
		fleetThreshold: deps.fleetThreshold,
		clearingTtlMs: deps.clearingTtlMs,
		logger,
		now: () => nowMs,
	});
}

// ── gap-episode clear pass (self-found during the R2 fold) ──────────────────

/**
 * Resolve gap-kind episodes whose CONDITION disappeared from the current
 * sweep. With progress resolution scoped to case-c (R1 hardening), nothing
 * else closes an answered ask / consumed delivery / reported park — the row
 * would sit LEAD_NOTIFIED until the ~30min grace paged the founder about an
 * ALREADY-RESOLVED matter. The sweep's absence IS the durable clear evidence,
 * so the resolution carries 'recovery' provenance and a genuine recurrence
 * can revive the episode later.
 */
export function resolveClearedGapEpisodes(
	deps: {
		store: Pick<
			StateStore,
			"getDetectionEscalationsForReconcile" | "ackDetectionEscalation"
		>;
		logger?: (msg: string) => void;
	},
	/** `${escalationKind}|${targetKey}` keys still present in THIS sweep. */
	activeConditionKeys: ReadonlySet<string>,
	/**
	 * Codex R4 #1/#2 (supersedes the R3 project-level predicate): keys whose
	 * judgement COMPLETELY ran this sweep (every required signal readable,
	 * target actually scanned). Absence is durable clear evidence ONLY inside
	 * this set. A degraded signal, a skipped project, or a non-active
	 * keep-alive session never contributes keys — those episodes are
	 * conservatively HELD (a held-but-actually-cleared episode may page once;
	 * a falsely cleared one silences a real stall — C-never-missed wins).
	 */
	evaluatedConditionKeys: ReadonlySet<string>,
	nowMs: number,
): number {
	const logger =
		deps.logger ?? ((m: string) => console.log(`[detection-reconcile] ${m}`));
	const gapKinds = new Set<string>(Object.values(GAP_ESCALATION_KINDS));
	let resolved = 0;
	for (const row of deps.store.getDetectionEscalationsForReconcile()) {
		if (!gapKinds.has(row.kind)) continue;
		const key = `${row.kind}|${row.target_key}`;
		if (activeConditionKeys.has(key)) continue;
		if (!evaluatedConditionKeys.has(key)) {
			continue; // judgement did not fully run — absence proves nothing
		}
		if (
			deps.store.ackDetectionEscalation(
				row.target_key,
				row.kind,
				row.episode_fingerprint,
				{ atMs: nowMs, disposition: "resolve", via: "recovery" },
			)
		) {
			resolved += 1;
			logger(
				`gap condition cleared for ${row.kind} ${row.target_key} — episode auto-RESOLVED`,
			);
		}
	}
	return resolved;
}

// ── C5: the notify-leg CLEARING mute ────────────────────────────────────────

export interface NotifyUnlessClearingDeps {
	store: Pick<StateStore, "hasClearingDetectionEscalationForTarget">;
	notify: (input: DetectionEscalationInput) => Promise<void>;
	logger?: (msg: string) => void;
}

/**
 * C5: while ANY episode of a target is CLEARING (its runner is being cleaned
 * up), every detection kind for that target stays quiet — a half-torn-down
 * runner would otherwise trip gap/case-c detectors and spam the Lead about a
 * corpse (FLY-970 family). The TTL rebound in the reconcile tick guarantees
 * a cleanup that never finishes cannot mute forever.
 */
export async function notifyUnlessClearing(
	deps: NotifyUnlessClearingDeps,
	input: DetectionEscalationInput,
): Promise<void> {
	if (deps.store.hasClearingDetectionEscalationForTarget(input.targetKey)) {
		deps.logger?.(
			`target ${input.targetKey} is CLEARING — ${input.kind} notify muted`,
		);
		return;
	}
	await deps.notify(input);
}
