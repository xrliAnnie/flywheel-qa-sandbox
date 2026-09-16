import { createHmac, timingSafeEqual } from "node:crypto";
import type { DeliverySecret } from "./lead-event-delivery.js";
export function deriveLeadEventAckToken(
	secret: DeliverySecret,
	input: { eventSeq: number; ackOwnerLeadId: string; ownerEpoch: number },
): string {
	const canonical = JSON.stringify({
		purpose: "lead-event-ack",
		eventSeq: input.eventSeq,
		ackOwnerLeadId: input.ackOwnerLeadId,
		ownerEpoch: input.ownerEpoch,
	});
	return createHmac("sha256", secret.key).update(canonical).digest("base64url");
}

export function tokenMatches(actual: string, expected: string): boolean {
	const a = Buffer.from(actual);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}
