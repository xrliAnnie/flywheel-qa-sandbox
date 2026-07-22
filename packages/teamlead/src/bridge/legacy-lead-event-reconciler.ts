/** FLY-1373 boot reconciliation for pre-cutover undelivered lead_events. */

import { CommDB } from "flywheel-comm/db";
import type { LeadInboxQueue } from "flywheel-comm/lead-inbox-queue";
import type { LeadEventRow, StateStore } from "../StateStore.js";
import { canonicalLeadEventDeliveryId } from "./lead-event-queue.js";
import type { LeadEventEnvelope } from "./lead-runtime.js";
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
}

const DEFAULT_AUDIT_ONLY_TYPES = new Set([
	"account_switch_audit",
	"rescue_audit",
	// Pending CommDB questions are materialized by QuestionAdmission under the
	// canonical question:<lead>:<qid> id. Replaying their audit mirror here would
	// create a second model row for the same gate during boot cutover.
	"gate_question",
	"runner_question",
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

function sqliteTimestampToIso(value: string): string {
	const normalized = value.includes("T")
		? value
		: `${value.replace(" ", "T")}Z`;
	const parsed = new Date(normalized);
	return Number.isFinite(parsed.getTime())
		? parsed.toISOString()
		: new Date().toISOString();
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
			const queue = this.opts.queueForLead(row.lead_id);
			const runtime = this.opts.registry.getRawForLead(row.lead_id);
			if (!queue || !runtime) continue;
			const envelope: LeadEventEnvelope = {
				seq: row.seq,
				eventId: row.event_id,
				event: JSON.parse(row.payload),
				sessionKey: row.session_key ?? "",
				leadId: row.lead_id,
				timestamp: sqliteTimestampToIso(row.created_at),
			};
			const id = canonicalLeadEventDeliveryId(envelope);
			const existing = queue.getById(id);
			if (existing?.consumed_at) {
				if (
					existing.disposition === "delivered" ||
					(existing.disposition === "migrated" && existing.delivered_at)
				) {
					this.opts.store.markLeadEventDelivered(row.seq);
				}
				continue;
			}
			if (existing) continue;

			const content =
				runtime.renderEnvelope?.(envelope) ?? JSON.stringify(envelope.event);
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
		}
	}

	private terminalizeNew(
		queue: LeadInboxQueue,
		input: Parameters<LeadInboxQueue["reconcileEnqueueConsumed"]>[0],
		disposition: string,
		delivered: boolean,
	): void {
		if (
			!queue.reconcileEnqueueConsumed(input, {
				ownerEpoch: this.opts.ownerEpoch,
				disposition,
				delivered,
				now: this.now().toISOString(),
			})
		) {
			throw new Error(`owner fence lost while reconciling ${input.id}`);
		}
	}

	private questionAlreadyAnswered(row: LeadEventRow): boolean {
		if (!row.routing_snapshot) return false;
		try {
			const route = JSON.parse(row.routing_snapshot) as {
				commDbPath?: string;
				questionId?: string;
			};
			if (!route.commDbPath || !route.questionId) return false;
			const db = new CommDB(route.commDbPath, false);
			try {
				return Boolean(db.getResponse(route.questionId));
			} finally {
				db.close();
			}
		} catch {
			return false;
		}
	}
}
