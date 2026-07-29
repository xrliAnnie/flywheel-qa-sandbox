import type { ReadTx, WriteTx } from "flywheel-v2-kernel";
import type { CanonicalValue } from "./digests.js";
import { canonicalJson, digestJson } from "./digests.js";
import { DagConflictError } from "./errors.js";

interface EventRow {
	event_uid: string;
	payload: string | null;
}

export function readReceipt<T>(
	tx: ReadTx,
	eventUid: string,
	requestDigest: string,
): T | null {
	const row = tx.get<EventRow>(
		"SELECT event_uid,payload FROM events WHERE event_uid=@eventUid",
		{ eventUid },
	);
	if (!row) return null;
	const payload = JSON.parse(row.payload ?? "{}") as {
		request_digest?: string;
		result?: T;
	};
	if (
		payload.request_digest !== requestDigest ||
		payload.result === undefined
	) {
		throw new DagConflictError(`receipt ${eventUid} conflicts`);
	}
	return payload.result;
}

export function appendEvent(
	tx: WriteTx,
	input: {
		eventUid: string;
		taskId?: string;
		attemptId?: string;
		kind: string;
		sourceKind: string;
		sourceId: string;
		payload: CanonicalValue;
		cutoverEpoch: number;
		createdAt: string;
	},
): void {
	tx.run(
		`INSERT INTO events
		 (event_uid,task_id,attempt_id,kind,source_kind,source_id,payload,
		  cutover_epoch,created_at)
		 VALUES(@eventUid,@taskId,@attemptId,@kind,@sourceKind,@sourceId,@payload,
		        @cutoverEpoch,@createdAt)`,
		{
			...input,
			taskId: input.taskId ?? null,
			attemptId: input.attemptId ?? null,
			payload: canonicalJson(input.payload),
		},
	);
}

export function receiptPayload<T extends CanonicalValue>(
	request: CanonicalValue,
	result: T,
): CanonicalValue {
	return {
		request_digest: digestJson(request),
		result,
	};
}
