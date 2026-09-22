import { expect, it, vi } from "vitest";
import { fetchDiscordMessageFromChannel } from "../../bridge/discord-utils.js";
import {
	ensureShipJudgmentPolicyProvenance,
	SHIP_JUDGMENT_POLICY_AUTHOR_ID,
	SHIP_JUDGMENT_POLICY_CREATED_AT,
	SHIP_JUDGMENT_POLICY_MESSAGE_ID,
	SHIP_JUDGMENT_POLICY_PROVENANCE_ID,
	SHIP_JUDGMENT_POLICY_THREAD_ID,
} from "../policy-provenance.js";

const message = () => ({
	id: SHIP_JUDGMENT_POLICY_MESSAGE_ID,
	channelId: SHIP_JUDGMENT_POLICY_THREAD_ID,
	authorId: SHIP_JUDGMENT_POLICY_AUTHOR_ID,
	authorIsBot: false,
	timestampMs: Date.parse(SHIP_JUDGMENT_POLICY_CREATED_AT),
	editedTimestampMs: null,
	content: "那个旧闸应该完整的删掉",
});

it("seals an exact unedited founder message and reuses the durable receipt", async () => {
	let existing: any;
	const record = vi.fn((value) => {
		existing = { ...value, policy: "three-point-auto-v1" };
		return existing;
	});
	const fetchMessage = vi.fn(async () => message());
	const store = {
		getShipJudgmentPolicyProvenance: () => existing,
		recordShipJudgmentPolicyProvenance: record,
	};
	const first = await ensureShipJudgmentPolicyProvenance({
		store,
		founderUserId: SHIP_JUDGMENT_POLICY_AUTHOR_ID,
		verifiedAt: "2026-09-18T16:30:00.000Z",
		fetchMessage,
	});
	const replay = await ensureShipJudgmentPolicyProvenance({
		store,
		founderUserId: SHIP_JUDGMENT_POLICY_AUTHOR_ID,
		verifiedAt: "2026-09-18T16:31:00.000Z",
		fetchMessage,
	});
	expect(first?.provenanceId).toBe(SHIP_JUDGMENT_POLICY_PROVENANCE_ID);
	expect(replay).toBe(first);
	expect(fetchMessage).toHaveBeenCalledTimes(1);
	expect(record).toHaveBeenCalledTimes(1);
});

it("seals the real Discord human shape where the optional bot field is absent", async () => {
	const response = new Response(
		JSON.stringify({
			id: SHIP_JUDGMENT_POLICY_MESSAGE_ID,
			author: { id: SHIP_JUDGMENT_POLICY_AUTHOR_ID },
			timestamp: SHIP_JUDGMENT_POLICY_CREATED_AT,
			edited_timestamp: null,
			content: "那个旧闸应该完整的删掉",
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
	const fetched = await fetchDiscordMessageFromChannel(
		SHIP_JUDGMENT_POLICY_THREAD_ID,
		SHIP_JUDGMENT_POLICY_MESSAGE_ID,
		"token",
		vi.fn().mockResolvedValueOnce(response) as unknown as typeof fetch,
	);
	if (!fetched.ok) throw new Error(fetched.kind);
	const recordShipJudgmentPolicyProvenance = vi.fn((value) => ({
		...value,
		policy: "three-point-auto-v1",
	}));
	const result = await ensureShipJudgmentPolicyProvenance({
		store: {
			getShipJudgmentPolicyProvenance: () => undefined,
			recordShipJudgmentPolicyProvenance,
		},
		founderUserId: SHIP_JUDGMENT_POLICY_AUTHOR_ID,
		verifiedAt: "2026-09-18T16:30:00.000Z",
		fetchMessage: async () => fetched.message,
	});
	expect(fetched.message.authorIsBot).toBe(false);
	expect(result?.provenanceId).toBe(SHIP_JUDGMENT_POLICY_PROVENANCE_ID);
	expect(recordShipJudgmentPolicyProvenance).toHaveBeenCalledTimes(1);
});

it.each([
	["bot", { authorIsBot: true }],
	[
		"edited",
		{ editedTimestampMs: Date.parse(SHIP_JUDGMENT_POLICY_CREATED_AT) + 1 },
	],
	["wrong author", { authorId: "999999999999999999" }],
	[
		"wrong timestamp",
		{ timestampMs: Date.parse(SHIP_JUDGMENT_POLICY_CREATED_AT) + 1 },
	],
])("rejects %s policy evidence", async (_name, override) => {
	const recordShipJudgmentPolicyProvenance = vi.fn();
	const result = await ensureShipJudgmentPolicyProvenance({
		store: {
			getShipJudgmentPolicyProvenance: () => undefined,
			recordShipJudgmentPolicyProvenance,
		},
		founderUserId: SHIP_JUDGMENT_POLICY_AUTHOR_ID,
		verifiedAt: "2026-09-18T16:30:00.000Z",
		fetchMessage: async () => ({ ...message(), ...override }),
	});
	expect(result).toBeUndefined();
	expect(recordShipJudgmentPolicyProvenance).not.toHaveBeenCalled();
});
