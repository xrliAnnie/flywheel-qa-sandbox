import { createHash } from "node:crypto";
import type { ShipJudgmentPolicyProvenanceRow } from "../StateStore.js";

export const SHIP_JUDGMENT_POLICY_PROVENANCE_ID =
	"27370000-0000-4000-8000-155054384196";
export const SHIP_JUDGMENT_POLICY_CHANNEL_ID = "1516209714097291335";
export const SHIP_JUDGMENT_POLICY_THREAD_ID = "1550442575066955787";
export const SHIP_JUDGMENT_POLICY_MESSAGE_ID = "1550543841961050283";
export const SHIP_JUDGMENT_POLICY_AUTHOR_ID = "1138241636057481306";
export const SHIP_JUDGMENT_POLICY_CREATED_AT = "2026-09-18T16:27:39.635Z";

interface PolicyProvenanceStore {
	getShipJudgmentPolicyProvenance(
		provenanceId?: string,
	): ShipJudgmentPolicyProvenanceRow | undefined;
	recordShipJudgmentPolicyProvenance(input: {
		provenanceId: string;
		channelId: string;
		threadId: string;
		messageId: string;
		authorId: string;
		messageCreatedAt: string;
		originalMessageDigest: string;
		verifiedAt: string;
		verificationReceiptId: string;
	}): ShipJudgmentPolicyProvenanceRow;
}

export interface PolicyProvenanceMessage {
	id: string;
	channelId: string;
	authorId: string;
	authorIsBot?: boolean;
	timestampMs: number;
	editedTimestampMs?: number | null;
	content: string;
}

/** Fetches and seals the founder's original policy replacement message exactly once. */
export async function ensureShipJudgmentPolicyProvenance(input: {
	store: PolicyProvenanceStore;
	founderUserId: string;
	verifiedAt: string;
	fetchMessage(): Promise<PolicyProvenanceMessage | undefined>;
}): Promise<ShipJudgmentPolicyProvenanceRow | undefined> {
	const existing = input.store.getShipJudgmentPolicyProvenance(
		SHIP_JUDGMENT_POLICY_PROVENANCE_ID,
	);
	if (existing) return existing;
	if (input.founderUserId !== SHIP_JUDGMENT_POLICY_AUTHOR_ID) return undefined;
	const message = await input.fetchMessage();
	if (
		!message ||
		message.id !== SHIP_JUDGMENT_POLICY_MESSAGE_ID ||
		message.channelId !== SHIP_JUDGMENT_POLICY_THREAD_ID ||
		message.authorId !== input.founderUserId ||
		message.authorIsBot !== false ||
		message.editedTimestampMs !== null ||
		new Date(message.timestampMs).toISOString() !==
			SHIP_JUDGMENT_POLICY_CREATED_AT ||
		!message.content.trim()
	) {
		return undefined;
	}
	const digest = createHash("sha256").update(message.content).digest("hex");
	return input.store.recordShipJudgmentPolicyProvenance({
		provenanceId: SHIP_JUDGMENT_POLICY_PROVENANCE_ID,
		channelId: SHIP_JUDGMENT_POLICY_CHANNEL_ID,
		threadId: SHIP_JUDGMENT_POLICY_THREAD_ID,
		messageId: SHIP_JUDGMENT_POLICY_MESSAGE_ID,
		authorId: message.authorId,
		messageCreatedAt: SHIP_JUDGMENT_POLICY_CREATED_AT,
		originalMessageDigest: digest,
		verifiedAt: input.verifiedAt,
		verificationReceiptId: `discord-fetch:${message.id}:${digest}`,
	});
}
