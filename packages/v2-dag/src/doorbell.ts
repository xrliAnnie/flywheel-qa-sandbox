import { FENCE, type Kernel } from "flywheel-v2-kernel";
import { appendEvent } from "./events.js";
import { readCutoverEpoch } from "./meta.js";
import type { DagPorts } from "./types.js";

/**
 * FLY-1544 (追加, founder direction): the lead→runner delivery doorbell.
 *
 * FLY-1543 ④ deleted the v1 wake machinery (teams inbox + useInboxPoller)
 * along with the vendor JSON, leaving only the ledger: a row enqueued to a
 * runner session sat unread until the runner happened to pull. The doorbell
 * closes that gap ON THE ENGINE SIDE — no runner-side polling loop, no vendor
 * JSON: every coordinator tick scans pending mailbox rows addressed to live
 * sessions and PASTES the content into the session terminal through the
 * launcher (tmux paste — vendor-neutral), then settles the row.
 *
 * Deliberately excluded:
 * - `dag_task_dispatch` rows: the assignment is embedded in the spawn prompt
 *   and settled through the runner's own proposal — pasting it would
 *   double-deliver and the doorbell settling it would break that settlement.
 * - rows with ANY processing attempt: those are already inside the pull
 *   delivery machinery (the runner asked for them); the attempt owns them.
 * - sessions without a binding: not launched yet, nothing to paste into.
 *
 * A paste failure leaves the row pending (the next tick rings again — a
 * doorbell keeps ringing until answered) and lands one deduped visible event.
 */
export interface SessionDeliveryPort {
	paste(sessionRef: string, text: string): Promise<void>;
}

export interface DoorbellResult {
	examined: number;
	pasted: number;
	failed: number;
	raced: number;
}

interface PendingRow {
	message_uid: string;
	kind: string;
	payload: string;
	to_agent: string;
}

export function formatDoorbellText(row: {
	kind: string;
	messageUid: string;
	payload: string;
}): string {
	return [
		`[flywheel-v2 doorbell] kind=${row.kind} message=${row.messageUid}`,
		"(auto-delivered and settled by the engine — do NOT submit/ack for this delivery)",
		row.payload,
	].join("\n");
}

export async function ringSessionDoorbells(
	kernel: Kernel,
	ports: DagPorts,
): Promise<DoorbellResult> {
	const result: DoorbellResult = {
		examined: 0,
		pasted: 0,
		failed: 0,
		raced: 0,
	};
	const delivery = ports.sessionDelivery;
	if (!delivery) return result;
	const rows = kernel.read((tx) =>
		tx.all<PendingRow>(
			`SELECT m.message_uid,m.kind,m.payload,m.to_agent
			   FROM mailbox m
			   JOIN activations act
			     ON act.session_ref=m.to_agent AND act.state='active'
			  WHERE m.state='pending'
			    AND substr(m.to_agent,1,6)='v2dag:'
			    AND m.source_kind<>'dag_task_dispatch'
			    AND act.session_binding IS NOT NULL
			    AND NOT EXISTS(SELECT 1 FROM processing_attempts pa
			                    WHERE pa.message_uid=m.message_uid)
			  ORDER BY m.seq`,
		),
	);
	for (const row of rows) {
		result.examined += 1;
		try {
			await delivery.paste(
				row.to_agent,
				formatDoorbellText({
					kind: row.kind,
					messageUid: row.message_uid,
					payload: row.payload,
				}),
			);
		} catch (error) {
			result.failed += 1;
			const message = error instanceof Error ? error.message : String(error);
			kernel.write("v2dag.doorbell.paste-failed", (tx) => {
				const epoch = readCutoverEpoch(tx);
				const eventUid = `session_mail_paste_failed:${row.message_uid}`;
				if (
					tx.get("SELECT 1 FROM events WHERE event_uid=@eventUid", { eventUid })
				) {
					return;
				}
				appendEvent(tx, {
					eventUid,
					kind: "session_mail_paste_failed",
					sourceKind: "doorbell",
					sourceId: row.message_uid,
					payload: {
						message_uid: row.message_uid,
						session_ref: row.to_agent,
						kind: row.kind,
						error: message,
					},
					cutoverEpoch: epoch,
					createdAt: ports.clock.nowIso(),
				});
			});
			continue;
		}
		// Settle AFTER the paste, with a race re-check: if the runner pulled the
		// row between the scan and here, an attempt now owns it — leave it to the
		// pull path (the duplicate terminal text is harmless; a lost row is not).
		const settled = kernel.write("v2dag.doorbell.settle", (tx) => {
			const epoch = readCutoverEpoch(tx);
			const owned = tx.get(
				"SELECT 1 FROM processing_attempts WHERE message_uid=@uid",
				{ uid: row.message_uid },
			);
			if (owned) return false;
			tx.cas(FENCE.mailboxCasPendingApplied, {
				now: ports.clock.nowIso(),
				uid: row.message_uid,
			});
			appendEvent(tx, {
				eventUid: `session_mail_pasted:${row.message_uid}`,
				kind: "session_mail_pasted",
				sourceKind: "doorbell",
				sourceId: row.message_uid,
				payload: {
					message_uid: row.message_uid,
					session_ref: row.to_agent,
					kind: row.kind,
				},
				cutoverEpoch: epoch,
				createdAt: ports.clock.nowIso(),
			});
			return true;
		});
		if (settled) result.pasted += 1;
		else result.raced += 1;
	}
	return result;
}
