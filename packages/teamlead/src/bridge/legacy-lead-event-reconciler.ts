/** FLY-1373 boot reconciliation for pre-cutover undelivered lead_events. */

import { CommDB } from "flywheel-comm/db";
import type { LeadInboxQueue } from "flywheel-comm/lead-inbox-queue";
import type { LeadEventRow, StateStore } from "../StateStore.js";
import { canonicalLeadEventDeliveryId } from "./lead-event-queue.js";
import type { LeadEventEnvelope } from "./lead-runtime.js";
import {
	classifyLegacyRowError,
	LegacyRowPoisonError,
	parseLegacyEventPayload,
} from "./legacy-row-errors.js";
import type { RuntimeRegistry } from "./runtime-registry.js";

export type LegacyDeliveryProbeResult =
	| { status: "delivered"; alias: string }
	| { status: "none" }
	| { status: "conflict"; alias?: string; error: string };

export interface LegacyLeadEventReconcilerOptions {
	store: StateStore;
	registry: RuntimeRegistry;
	ownerEpoch: string;
	queueForLead: (leadId: string) => LeadInboxQueue | undefined;
	probeLegacyDelivery: (input: {
		row: LeadEventRow;
		aliases: readonly string[];
		content: string;
	}) => Promise<LegacyDeliveryProbeResult>;
	now?: () => Date;
	auditOnlyEventTypes?: ReadonlySet<string>;
	/**
	 * FLY-1586 B — durable sink for a deterministically-bad row.
	 *
	 * Called ONLY after {@link classifyLegacyRowError} returns "quarantine". It
	 * must durably record the row (marker + alert intent) before returning;
	 * returning normally is what licenses the loop to skip the row and carry on.
	 *
	 * If this is not wired, the reconciler RETHROWS instead of skipping. That is
	 * deliberate: without a durable record we cannot prove the row was captured,
	 * and silently dropping it would lose a real notification. A wedge is loud
	 * and recoverable; silent loss is neither.
	 */
	onRowQuarantine?: (row: LeadEventRow, error: Error) => void;
}

const DEFAULT_AUDIT_ONLY_TYPES = new Set([
	"account_switch_audit",
	"rescue_audit",
	// Pending CommDB questions are materialized by QuestionAdmission under the
	// canonical question:<lead>:<qid> id. Replaying their audit mirror here would
	// create a second model row for the same gate during boot cutover.
	"gate_question",
	"runner_question",
	// FLY-1586 BLOCKER-2 (code review R1) — identical shape, higher stakes.
	// The canonical founder row is created directly by `enqueueHubRoot` under
	// `founder_msg:<lead>:<msgId>`; GatePoller separately appends a `founder_reply`
	// AUDIT MIRROR to `lead_events` and marks it delivered in a different
	// autocommit. A crash between those two leaves an undelivered mirror, and
	// materializing it here would mint a SECOND model row carrying the founder's
	// answer — created after the freeze watermark, so the stock freeze cannot see
	// it. That is a founder instruction replayed by the very code meant to
	// prevent replay.
	"founder_reply",
]);

/** Frozen v1 migration map; live generic ingress never classifies by type. */
function legacyPriorityForEvent(eventType: string): 0 | 1 | 2 | 3 {
	const normalized = eventType.toLowerCase();
	if (
		normalized.includes("founder") ||
		normalized === "ship_approval_request" ||
		normalized === "approve_to_ship"
	) {
		return 0;
	}
	if (
		normalized.includes("gate") ||
		normalized.includes("question") ||
		normalized.includes("approval") ||
		normalized.includes("review")
	) {
		return 1;
	}
	if (
		normalized.includes("report") ||
		normalized.includes("completed") ||
		normalized.includes("artifact") ||
		normalized.includes("action")
	) {
		return 2;
	}
	return 3;
}

export function sqliteTimestampToIso(value: string): string {
	const normalized = value.includes("T")
		? value
		: `${value.replace(" ", "T")}Z`;
	const parsed = new Date(normalized);
	return Number.isFinite(parsed.getTime())
		? parsed.toISOString()
		: "1970-01-01T00:00:00.000Z";
}

/**
 * Rebuild the canonical delivery envelope from the journal row, never from a
 * caller's newer in-memory payload. That makes append→crash→retry byte-stable.
 */
export function leadEventEnvelopeFromJournalRow(
	row: LeadEventRow,
	priority?: LeadEventEnvelope["priority"],
): LeadEventEnvelope {
	return {
		seq: row.seq,
		eventId: row.event_id,
		// FLY-1586 B: typed poison ONLY around this exact parse. Anything wider
		// starts absorbing failures that deserve a retry.
		event: parseLegacyEventPayload(
			row.payload,
			row.seq,
		) as LeadEventEnvelope["event"],
		sessionKey: row.session_key ?? "",
		leadId: row.lead_id,
		timestamp: sqliteTimestampToIso(row.created_at),
		...(priority !== undefined ? { priority } : {}),
	};
}

export class LegacyLeadEventReconciler {
	private readonly now: () => Date;
	private readonly auditOnly: ReadonlySet<string>;

	constructor(private readonly opts: LegacyLeadEventReconcilerOptions) {
		this.now = opts.now ?? (() => new Date());
		this.auditOnly = opts.auditOnlyEventTypes ?? DEFAULT_AUDIT_ONLY_TYPES;
	}

	async run(): Promise<void> {
		for (const row of this.opts.store.listUndeliveredLeadEvents()) {
			if (this.auditOnly.has(row.event_type)) continue;
			try {
				await this.reconcileRow(row);
			} catch (err) {
				// FLY-1586 B — classify by TYPE, never by message text.
				//
				// Before this, ONE deterministically bad row aborted the whole
				// cutover, which aborted admit(), which meant neither claim path
				// ran — 14 Leads / 7 projects, 61 hours. But the opposite mistake
				// is worse and quieter: a bare catch would treat SQLITE_BUSY, an
				// I/O blip, or a lost owner lease as poison and discard a REAL
				// notification. So only deliberately-minted types quarantine;
				// everything else keeps throwing into the existing retry path.
				if (classifyLegacyRowError(err) !== "quarantine") throw err;

				// Quarantine requires a DURABLE record. Without a sink we cannot
				// prove the row was recorded, and skipping it would lose the
				// notification silently — so fail closed (rethrow) instead. Loud
				// and recoverable beats silent and not.
				if (!this.opts.onRowQuarantine) throw err;
				this.opts.onRowQuarantine(row, err as Error);
				// Marker committed → this row is settled; the loop continues so a
				// single bad row can no longer hold the fleet.
			}
		}
	}

	private async reconcileRow(row: LeadEventRow): Promise<void> {
		{
			const queue = this.opts.queueForLead(row.lead_id);
			const runtime = this.opts.registry.getRawForLead(row.lead_id);
			if (!queue || !runtime) return;
			const envelope = leadEventEnvelopeFromJournalRow(row);
			// FLY-1586 R3 BLOCKER — the fifth founder-replay path.
			//
			// `notifyLeadFirst` durably appends a `receipt_unprocessed` escalation
			// to lead_events BEFORE its best-effort dispatch, and that payload
			// carries the subject root's contentSummary plus a next step telling
			// the Lead to complete the routing side effect. For a founder root that
			// IS the old instruction. If the original enqueue died on the poison
			// row, the journal entry stays undelivered — and F only freezes rows
			// already in lead_inbox, so the next boot materializes this one ABOVE
			// the watermark, claimable, carrying the founder's answer.
			//
			// R3 also notes the sting: the contentSummary truncation on this very
			// path is what minted seq 56649. Same pipe, not adjacent telemetry.
			//
			// Deliberately NARROW: only receipt_unprocessed escalations whose
			// subject is an explicitly fenced root. Blanket-suppressing every
			// detection_escalation would create fresh silence — most have no other
			// canonical delivery.
			//
			// `episode_fingerprint` is the subject root's lead_inbox id (verified
			// against production: founder_msg / chat / lead_event fingerprints each
			// join 1:1 in their project's CommDB).
			const escalation = envelope.event as {
				escalation_kind?: string;
				episode_fingerprint?: string;
			};
			if (
				row.event_type === "detection_escalation" &&
				escalation.escalation_kind === "receipt_unprocessed" &&
				typeof escalation.episode_fingerprint === "string" &&
				queue.isFencedRoot(escalation.episode_fingerprint)
			) {
				this.opts.store.recordLegacyStockSuppressed({
					seq: row.seq,
					leadId: row.lead_id,
					fencedRoot: escalation.episode_fingerprint,
					now: this.now().toISOString(),
				});
				return;
			}
			const id = canonicalLeadEventDeliveryId(envelope);
			const existing = queue.getById(id);
			if (existing?.consumed_at) {
				if (
					existing.disposition === "delivered" ||
					(existing.disposition === "migrated" && existing.delivered_at)
				) {
					this.opts.store.markLeadEventDelivered(row.seq);
				}
				return;
			}
			if (existing) return;

			// FLY-1586 B (code review R1 HIGH-5) — a payload that is valid JSON but
			// the wrong SHAPE makes the renderer dereference typed fields and throw
			// an untyped TypeError. The classifier rightly refuses to quarantine
			// untyped errors (it cannot distinguish them from transient faults), so
			// before this the row re-threw on every boot and wedged the cutover
			// forever — the original failure, reached by a different door.
			//
			// It must not be quarantined either: a PRESENTATION problem should not
			// make a real notification vanish. So deliver the raw JSON and record
			// the downgrade. The scope is exactly the render call — a pure string
			// build — so this cannot swallow anything that deserved a retry.
			let content: string;
			let renderFellBack = false;
			try {
				content =
					runtime.renderEnvelope?.(envelope) ?? JSON.stringify(envelope.event);
			} catch (renderError) {
				// ⚠️ Code review R2 HIGH-2 — my first attempt caught EVERYTHING here.
				// `renderEnvelope` has no purity contract, so a renderer that hits
				// SQLITE_BUSY would have been "handled" by delivering raw JSON
				// instead of retrying. That is the precise failure this whole change
				// exists to prevent, and I reintroduced it while fixing something
				// else. Codex reproduced it.
				//
				// Narrow, typed, same discipline as `parseLegacyEventPayload` only
				// catching SyntaxError: a shape mismatch surfaces as a bare
				// TypeError. SQLite/I-O errors carry a `code`, so requiring its
				// absence keeps them on the rethrow path.
				const isShapeDefect =
					renderError instanceof TypeError &&
					(renderError as { code?: unknown }).code === undefined;
				if (!isShapeDefect) throw renderError;
				content = JSON.stringify(envelope.event);
				renderFellBack = true;
			}
			const attempts = this.opts.store.listLeadEventDeliveryAttempts(row.seq);
			const aliases = [
				...attempts.map(({ attempt_id }) => `${row.lead_id}-${attempt_id}`),
				`${row.lead_id}-${row.seq}-${envelope.event.execution_id ?? "no-exec"}`,
			];
			const answered = this.questionAlreadyAnswered(row);
			const probe = answered
				? ({ status: "none" } as const)
				: await this.opts.probeLegacyDelivery({ row, aliases, content });
			const legacyAlias =
				probe.status === "delivered" ? probe.alias : aliases[0];
			const queueInput = {
				id,
				toLead: row.lead_id,
				source: `lead_event:${row.seq}`,
				type: row.event_type,
				msgClass: "model",
				priority: legacyPriorityForEvent(row.event_type),
				content,
				legacyAlias,
				createdAt: envelope.timestamp,
			} as const;

			if (answered) {
				this.terminalizeNew(queue, queueInput, "migrated", false);
			} else if (probe.status === "delivered") {
				// Cross-store order: target receipt → audit mirror → one-shot
				// terminal comm.db insert. A crash after the audit commit leaves no live
				// queue row that could duplicate model delivery on restart.
				this.opts.store.markLeadEventDelivered(row.seq);
				this.terminalizeNew(queue, queueInput, "migrated", true);
			} else if (probe.status === "conflict") {
				this.terminalizeNew(queue, queueInput, "quarantined", false);
			} else {
				queue.enqueue(queueInput);
			}
			// R2 HIGH-2 (second half): record the downgrade only AFTER the canonical
			// queue operation succeeded. Writing it earlier left a durable record
			// describing an *attempted* fallback as a delivered one — a probe or
			// SQLite failure in between would have made the record a lie.
			if (renderFellBack) {
				this.opts.store.recordLegacyRenderFallback({
					seq: row.seq,
					leadId: row.lead_id,
					// Name only — the message would quote the offending payload.
					errorName: "TypeError",
					now: this.now().toISOString(),
				});
			}
		}
	}

	private terminalizeNew(
		queue: LeadInboxQueue,
		input: Parameters<LeadInboxQueue["reconcileEnqueueConsumed"]>[0],
		disposition: string,
		delivered: boolean,
	): void {
		const result = queue.reconcileEnqueueConsumed(input, {
			ownerEpoch: this.opts.ownerEpoch,
			disposition,
			delivered,
			now: this.now().toISOString(),
		});
		// FLY-1586 R2 HIGH-3 — the two failures are NOT the same failure.
		//
		// `owner_lost` is transient: another process holds the lease, and the next
		// tick may well succeed. It must keep throwing into the existing retry.
		//
		// `conflict` is deterministic: this id already holds a row that genuinely
		// differs, and it will differ identically forever. Throwing the generic
		// owner-fence error for it — which is what this did — meant the classifier
		// rethrew, admission aborted, and the fleet wedged on every retry. Same
		// outage, reached through the terminal path.
		if (result.outcome === "owner_lost") {
			throw new Error(`owner fence lost while reconciling ${input.id}`);
		}
		if (result.outcome === "conflict") {
			throw new LegacyRowPoisonError(
				"terminal_conflict",
				input.id,
				result.field,
			);
		}
	}

	private questionAlreadyAnswered(row: LeadEventRow): boolean {
		if (!row.routing_snapshot) return false;
		// ⚠️ Code review R2 HIGH-4 — this used to wrap the CommDB open/query/close
		// in the same catch as the snapshot parse and answer `false` for all of
		// them. A busy or unreadable authority DB therefore made the reconciler
		// decide "not answered yet" and re-materialize a question that HAD been
		// answered elsewhere.
		//
		// That is the mirror image of the wedge: instead of retrying a transient
		// fault, it silently picks a business answer. Only a malformed snapshot may
		// be swallowed; authority failures must propagate to the existing retry.
		let route: { commDbPath?: string; questionId?: string };
		try {
			route = JSON.parse(row.routing_snapshot) as typeof route;
		} catch (err) {
			// Malformed snapshot only — a shape problem, not an authority problem.
			if (!(err instanceof SyntaxError)) throw err;
			return false;
		}
		if (!route.commDbPath || !route.questionId) return false;
		const db = new CommDB(route.commDbPath, false);
		try {
			return Boolean(db.getResponse(route.questionId));
		} finally {
			db.close();
		}
	}
}
