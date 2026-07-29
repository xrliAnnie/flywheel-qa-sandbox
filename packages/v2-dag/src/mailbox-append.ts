import { randomUUID } from "node:crypto";
import type { WriteTx } from "flywheel-v2-kernel";
import { type CanonicalValue, canonicalJson, sha256 } from "./digests.js";
import { DagConflictError } from "./errors.js";

export function appendMailboxTx(
	tx: WriteTx,
	input: {
		sourceKind: string;
		sourceId: string;
		toAgent: string;
		kind: string;
		payload: CanonicalValue;
		retentionClass: "notice" | "business" | "dlq";
		cutoverEpoch: number;
		createdAt: string;
	},
): string {
	const payload = canonicalJson(input.payload);
	const payloadDigest = sha256(payload);
	const existing = tx.get<{
		message_uid: string;
		payload_digest: string;
		to_agent: string;
		kind: string;
		retention_class: string;
	}>(
		`SELECT message_uid,payload_digest,to_agent,kind,retention_class
		   FROM mailbox WHERE source_kind=@sourceKind AND source_id=@sourceId`,
		input,
	);
	if (existing) {
		if (
			existing.payload_digest !== payloadDigest ||
			existing.to_agent !== input.toAgent ||
			existing.kind !== input.kind ||
			existing.retention_class !== input.retentionClass
		) {
			throw new DagConflictError(
				`mailbox source ${input.sourceKind}/${input.sourceId} conflicts`,
			);
		}
		return existing.message_uid;
	}
	const messageUid = randomUUID();
	tx.run(
		`INSERT INTO mailbox
		 (message_uid,source_kind,source_id,payload,payload_digest,to_agent,kind,
		  retention_class,cutover_epoch,state,retry_count,next_retry_at,created_at)
		 VALUES(@messageUid,@sourceKind,@sourceId,@payload,@payloadDigest,@toAgent,
		        @kind,@retentionClass,@cutoverEpoch,'pending',0,NULL,@createdAt)`,
		{ ...input, messageUid, payload, payloadDigest },
	);
	return messageUid;
}
