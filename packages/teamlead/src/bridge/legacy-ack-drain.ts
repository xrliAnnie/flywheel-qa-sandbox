/** FLY-1373 one-shot retirement of the pre-loop ACK delivery cohort. */

import { CommDB } from "flywheel-comm/db";
import type { LeadEventRow, StateStore } from "../StateStore.js";
import {
	type DeliverySecretProvider,
	deriveLeadEventAckToken,
	tokenMatches,
} from "./lead-event-delivery.js";

export interface LegacyAckDrainOptions {
	store: StateStore;
	commDbPaths: readonly string[];
	secretProvider: DeliverySecretProvider;
	now?: () => Date;
}

export interface LegacyAckDrainResult {
	receiptsConsumed: number;
	autoAcked: number;
	retired: number;
}

export class LegacyAckDrain {
	private readonly now: () => Date;

	constructor(private readonly opts: LegacyAckDrainOptions) {
		this.now = opts.now ?? (() => new Date());
	}

	run(): LegacyAckDrainResult {
		let receiptsConsumed = 0;
		let autoAcked = 0;
		const nowIso = this.now().toISOString();
		let activeSecret:
			| ReturnType<DeliverySecretProvider["getActive"]>
			| undefined;
		for (const dbPath of new Set(this.opts.commDbPaths)) {
			const db = new CommDB(dbPath, false);
			try {
				for (const receipt of db.getPendingAckReceipts()) {
					try {
						const payload = JSON.parse(receipt.content) as {
							event_seq?: unknown;
							ack_token?: unknown;
						};
						if (
							typeof payload.event_seq !== "number" ||
							typeof payload.ack_token !== "string"
						) {
							continue;
						}
						const row = this.opts.store.getLeadEventBySeq(payload.event_seq);
						if (
							!row?.ack_owner_lead_id ||
							row.acked_at ||
							row.ack_retired_at ||
							receipt.from_agent !== row.ack_owner_lead_id
						) {
							continue;
						}
						activeSecret ??= this.opts.secretProvider.getActive();
						const expected = deriveLeadEventAckToken(activeSecret, {
							eventSeq: row.seq,
							ackOwnerLeadId: row.ack_owner_lead_id,
							ownerEpoch: row.ack_owner_epoch ?? 0,
						});
						if (tokenMatches(payload.ack_token, expected)) {
							this.opts.store.markLeadEventAcked(row.seq, nowIso);
						}
					} finally {
						if (db.markAckReceiptConsumed(receipt.id)) receiptsConsumed++;
					}
				}
			} finally {
				db.close();
			}
		}

		for (const row of [
			...this.opts.store.listOpenAckLeadEvents(10_000),
			...this.opts.store.listLateAckLeadEvents(nowIso, 10_000),
		]) {
			if (this.autoAckFromMachineEvidence(row, nowIso)) autoAcked++;
		}
		const retired = this.opts.store.retireOpenLeadEventAcks(
			nowIso,
			"fly1373_cutover",
		);
		return { receiptsConsumed, autoAcked, retired };
	}

	private autoAckFromMachineEvidence(
		row: LeadEventRow,
		nowIso: string,
	): boolean {
		if (!row.routing_snapshot) return false;
		try {
			const route = JSON.parse(row.routing_snapshot) as {
				commDbPath?: string;
				questionId?: string;
			};
			if (!route.questionId) return false;
			if (row.ack_policy === "founder_surface_confirmed") {
				if (!row.session_key) return false;
				const confirmed = this.opts.store
					.getEventsByExecution(row.session_key)
					.some(
						(event) =>
							event.event_id === `founder-thread-notify-${route.questionId}` &&
							(event.payload as { reason?: string } | undefined)?.reason ===
								"posted",
					);
				return confirmed && this.opts.store.markLeadEventAcked(row.seq, nowIso);
			}
			if (row.ack_policy !== "question_response" || !route.commDbPath) {
				return false;
			}
			const db = new CommDB(route.commDbPath, false);
			try {
				return (
					Boolean(db.getResponse(route.questionId)) &&
					this.opts.store.markLeadEventAcked(row.seq, nowIso)
				);
			} finally {
				db.close();
			}
		} catch {
			return false;
		}
	}
}
