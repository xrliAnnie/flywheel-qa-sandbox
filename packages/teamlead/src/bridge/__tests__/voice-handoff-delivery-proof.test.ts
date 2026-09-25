import type { ChatDeliveryEnvelopeV1 } from "flywheel-comm/discord-chat-ingest";
import { describe, expect, it } from "vitest";
import { voiceHandoffDeliveryMatches } from "../voice-handoff-delivery-proof.js";
import type { VoiceHandoffRecord } from "../voice-handoff-store.js";

const HANDOFF = "018f47d2-7b64-7b42-a3df-000000000002";
const KEY = "AbCdEfGhIjKlMnOpQrStUvWx";

function record(agenda: VoiceHandoffRecord["agenda"]): VoiceHandoffRecord {
	return {
		handoffId: HANDOFF,
		idempotencyKey: "t:raya:query",
		requestDigest: "d".repeat(64),
		projectName: "raya",
		founderUserId: "300000000000000001",
		targetLeadId: "raya",
		sessionId: "s",
		generation: 3,
		state: "ambiguous",
		messageId: `voice-handoff:${HANDOFF}`,
		providerOperationId: `chat:raya:voice-handoff:${HANDOFF}`,
		attemptToken: null,
		stateVersion: 1,
		requestKind: agenda?.kind === "brief" ? "agenda_brief" : "user_handoff",
		request: {
			intentKind: "query",
			transcriptId: "t",
			utteranceId: "u",
			originalText: "好，授权",
		} as VoiceHandoffRecord["request"],
		agenda,
		terminalReason: null,
		createdAt: "2026-09-24T00:00:00.000Z",
		updatedAt: "2026-09-24T00:00:00.000Z",
	};
}

function envelope(
	agenda: NonNullable<ChatDeliveryEnvelopeV1["voiceHandoff"]>["agenda"],
	overrides: Partial<ChatDeliveryEnvelopeV1> = {},
): ChatDeliveryEnvelopeV1 {
	return {
		v: 1,
		deliveryId: `chat:raya:voice-handoff:${HANDOFF}`,
		leadId: "raya",
		chatId: "1",
		originChannelId: "1",
		messageId: `voice-handoff:${HANDOFF}`,
		authorId: "300000000000000001",
		authorName: "Founder voice",
		ts: "2026-09-24T00:00:00.000Z",
		priority: 1,
		msgKind: "guild",
		attachments: [],
		text: "好，授权",
		origin: "voice",
		voiceSessionId: "s",
		voiceHandoff: {
			version: 1,
			handoffId: HANDOFF,
			intentKind: "query",
			requestDigest: "d".repeat(64),
			targetLeadId: "raya",
			transcriptId: "t",
			utteranceId: "u",
			sessionGeneration: 3,
			...(agenda ? { agenda } : {}),
		},
		...overrides,
	};
}

const TURN = {
	kind: "turn" as const,
	itemKey: "blocked:I1:t",
	turnId: "turn:1",
	itemState: "active" as const,
	answerKey: KEY,
};

describe("voiceHandoffDeliveryMatches (FLY-2863 review R2)", () => {
	it("proves a bound founder turn only with its exact agenda facts and key", () => {
		expect(voiceHandoffDeliveryMatches(envelope(TURN), record(TURN))).toBe(
			true,
		);
		for (const carried of [
			undefined,
			{ ...TURN, answerKey: undefined },
			{ ...TURN, answerKey: `${KEY.slice(1)}x` },
			{ ...TURN, itemState: "closed" as const },
			{ ...TURN, itemKey: "blocked:I2:t" },
			{ ...TURN, turnId: "turn:2" },
		])
			expect(
				voiceHandoffDeliveryMatches(envelope(carried as never), record(TURN)),
			).toBe(false);
	});

	it("an unbound handoff must not carry agenda facts", () => {
		expect(voiceHandoffDeliveryMatches(envelope(undefined), record(null))).toBe(
			true,
		);
		expect(voiceHandoffDeliveryMatches(envelope(TURN), record(null))).toBe(
			false,
		);
	});

	it("proves a brief by author, text, purpose and item", () => {
		const brief = {
			kind: "brief" as const,
			purpose: "item" as const,
			itemKey: "blocked:I1:t",
			clientRequestId: "c",
			authorId: "400000000000000001",
			answerKey: KEY,
			brief: {},
			text: `【语音议程·item】 say --request x --key ${KEY} --item blocked:I1:t`,
		};
		const carried = {
			kind: "brief" as const,
			purpose: "item" as const,
			itemKey: "blocked:I1:t",
		};
		const base = {
			authorId: "400000000000000001",
			text: brief.text,
		};
		expect(
			voiceHandoffDeliveryMatches(envelope(carried, base), record(brief)),
		).toBe(true);
		expect(
			voiceHandoffDeliveryMatches(
				envelope({ ...carried, purpose: "open" }, base),
				record(brief),
			),
		).toBe(false);
		expect(
			voiceHandoffDeliveryMatches(
				envelope(carried, { ...base, text: "别的" }),
				record(brief),
			),
		).toBe(false);
	});

	it("never proves a legacy record that has no answer key (upgrade)", () => {
		const legacyTurn = { ...TURN, answerKey: undefined } as never;
		expect(
			voiceHandoffDeliveryMatches(envelope(legacyTurn), record(legacyTurn)),
		).toBe(false);
		const legacyBrief = {
			kind: "brief" as const,
			purpose: "item" as const,
			itemKey: "blocked:I1:t",
			clientRequestId: "c",
			authorId: "400000000000000001",
			brief: {},
			text: "【语音议程·item】 old text without a key",
		} as never;
		expect(
			voiceHandoffDeliveryMatches(
				envelope(
					{ kind: "brief", purpose: "item", itemKey: "blocked:I1:t" },
					{
						authorId: "400000000000000001",
						text: "【语音议程·item】 old text without a key",
					},
				),
				record(legacyBrief),
			),
		).toBe(false);
	});
});
