import { describe, expect, it } from "vitest";
import { LiveUtteranceAssembler } from "../backends/openai-live/LiveUtteranceAssembler.js";

function assembler() {
	return new LiveUtteranceAssembler({
		sessionId: "voice-session-1",
		generation: 7,
		backendId: "openai-live",
	});
}

describe("LiveUtteranceAssembler", () => {
	it("binds one delegation offset to one RoomIO utterance and preserves the original words", () => {
		const turns = assembler();
		turns.startProviderGeneration(3, 1_000);
		turns.observeRoom({
			sessionId: "voice-session-1",
			generation: 7,
			utteranceId: "utterance-1",
			attribution: { kind: "known", speakerUserId: "founder-1" },
			observedAt: 1_100,
			phase: "start",
		});
		turns.appendInput({
			generation: 3,
			eventId: "delta-1",
			startMs: 100,
			endMs: 180,
			delta: "帮我 ",
		});
		turns.appendInput({
			generation: 3,
			eventId: "delta-2",
			startMs: 180,
			endMs: 260,
			delta: "查查 查查这个",
		});
		turns.observeRoom({
			sessionId: "voice-session-1",
			generation: 7,
			utteranceId: "utterance-1",
			attribution: { kind: "known", speakerUserId: "founder-1" },
			observedAt: 1_300,
			phase: "end",
		});

		const utterance = turns.sealDelegation({
			generation: 3,
			delegationId: "provider-delegation-1",
			offsetMs: 250,
		});

		expect(utterance).toMatchObject({
			sessionId: "voice-session-1",
			generation: 7,
			utteranceId: "utterance-1",
			transcriptId: "live:voice-session-1:7:3:utterance-1",
			text: "帮我 查查 查查这个",
			final: true,
			attribution: { kind: "known", speakerUserId: "founder-1" },
		});
	});

	it("deduplicates provider event ids but never deduplicates repeated words", () => {
		const turns = assembler();
		turns.startProviderGeneration(1, 0);
		turns.observeRoom({
			sessionId: "voice-session-1",
			generation: 7,
			utteranceId: "u1",
			attribution: { kind: "known", speakerUserId: "founder-1" },
			observedAt: 0,
			phase: "start",
		});
		for (const eventId of ["same", "same", "different"]) {
			turns.appendInput({
				generation: 1,
				eventId,
				startMs: 1,
				endMs: 2,
				delta: "好",
			});
		}
		turns.observeRoom({
			sessionId: "voice-session-1",
			generation: 7,
			utteranceId: "u1",
			attribution: { kind: "known", speakerUserId: "founder-1" },
			observedAt: 10,
			phase: "end",
		});

		expect(
			turns.sealDelegation({
				generation: 1,
				delegationId: "d1",
				offsetMs: 2,
			}).text,
		).toBe("好好");
	});

	it("preserves available text as unknown when overlapping speakers prevent unique attribution", () => {
		const turns = assembler();
		turns.startProviderGeneration(1, 1_000);
		for (const [utteranceId, speakerUserId, start, end] of [
			["u1", "founder-1", 1_010, 1_200],
			["u2", "other-1", 1_050, 1_180],
		] as const) {
			turns.observeRoom({
				sessionId: "voice-session-1",
				generation: 7,
				utteranceId,
				attribution: { kind: "known", speakerUserId },
				observedAt: start,
				phase: "start",
			});
			turns.observeRoom({
				sessionId: "voice-session-1",
				generation: 7,
				utteranceId,
				attribution: { kind: "known", speakerUserId },
				observedAt: end,
				phase: "end",
			});
		}
		turns.appendInput({
			generation: 1,
			eventId: "delta-1",
			startMs: 20,
			endMs: 100,
			delta: "不要丢掉这句",
		});

		const utterance = turns.sealDelegation({
			generation: 1,
			delegationId: "d1",
			offsetMs: 90,
		});

		expect(utterance.text).toBe("不要丢掉这句");
		expect(utterance.attribution).toEqual({
			kind: "unknown",
			reason: "overlapping_room_utterances",
		});
	});

	it("does not reuse a provider delegation id as the cross-generation identity", () => {
		const turns = assembler();
		for (const [providerGeneration, base] of [
			[1, 0],
			[2, 1_000],
		] as const) {
			turns.startProviderGeneration(providerGeneration, base);
			turns.observeRoom({
				sessionId: "voice-session-1",
				generation: 7,
				utteranceId: `u${providerGeneration}`,
				attribution: { kind: "known", speakerUserId: "founder-1" },
				observedAt: base,
				phase: "start",
			});
			turns.appendInput({
				generation: providerGeneration,
				eventId: `e${providerGeneration}`,
				startMs: 1,
				endMs: 2,
				delta: `第${providerGeneration}句`,
			});
			turns.observeRoom({
				sessionId: "voice-session-1",
				generation: 7,
				utteranceId: `u${providerGeneration}`,
				attribution: { kind: "known", speakerUserId: "founder-1" },
				observedAt: base + 10,
				phase: "end",
			});
		}

		const first = turns.sealDelegation({
			generation: 1,
			delegationId: "provider-reused-id",
			offsetMs: 2,
		});
		const second = turns.sealDelegation({
			generation: 2,
			delegationId: "provider-reused-id",
			offsetMs: 2,
		});

		expect(first.transcriptId).not.toBe(second.transcriptId);
		expect([first.text, second.text]).toEqual(["第1句", "第2句"]);
	});

	it("waits for an open RoomIO window and preserves its available text as incomplete if sealed early", () => {
		const turns = assembler();
		turns.startProviderGeneration(1, 1_000);
		turns.observeRoom({
			sessionId: "voice-session-1",
			generation: 7,
			utteranceId: "u1",
			attribution: { kind: "known", speakerUserId: "founder-1" },
			observedAt: 1_050,
			phase: "start",
		});
		turns.appendInput({
			generation: 1,
			eventId: "before",
			startMs: 50,
			endMs: 100,
			delta: "帮我",
		});
		turns.appendInput({
			generation: 1,
			eventId: "after",
			startMs: 100,
			endMs: 180,
			delta: "查完整状态",
		});
		const delegation = {
			generation: 1,
			delegationId: "d1",
			offsetMs: 100,
		};

		expect(turns.delegationWindowState(delegation)).toBe("waiting");
		expect(turns.sealDelegation(delegation)).toMatchObject({
			text: "帮我查完整状态",
			attribution: { kind: "unknown", reason: "room_utterance_incomplete" },
		});

		turns.observeRoom({
			sessionId: "voice-session-1",
			generation: 7,
			utteranceId: "u1",
			attribution: { kind: "known", speakerUserId: "founder-1" },
			observedAt: 1_200,
			phase: "end",
		});
		expect(turns.delegationWindowState(delegation)).toBe("ready");
	});

	it("abandons an orphaned RoomIO window when a later utterance starts", () => {
		const turns = assembler();
		turns.startProviderGeneration(1, 1_000);
		turns.observeRoom({
			sessionId: "voice-session-1",
			generation: 7,
			utteranceId: "orphan",
			attribution: { kind: "known", speakerUserId: "founder-1" },
			observedAt: 1_050,
			phase: "start",
		});
		turns.observeRoom({
			sessionId: "voice-session-1",
			generation: 7,
			utteranceId: "later",
			attribution: { kind: "known", speakerUserId: "founder-1" },
			observedAt: 2_000,
			phase: "start",
		});
		turns.appendInput({
			generation: 1,
			eventId: "later-delta",
			startMs: 1_020,
			endMs: 1_100,
			delta: "第二个问题",
		});
		turns.observeRoom({
			sessionId: "voice-session-1",
			generation: 7,
			utteranceId: "later",
			attribution: { kind: "known", speakerUserId: "founder-1" },
			observedAt: 2_150,
			phase: "end",
		});
		const delegation = {
			generation: 1,
			delegationId: "d2",
			offsetMs: 1_100,
		};

		expect(turns.delegationWindowState(delegation)).toBe("ready");
		expect(turns.sealDelegation(delegation)).toMatchObject({
			utteranceId: "later",
			text: "第二个问题",
			attribution: { kind: "known", speakerUserId: "founder-1" },
		});
	});
});
