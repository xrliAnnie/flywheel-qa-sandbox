import type { VoiceHandoffResultEvent } from "flywheel-voice-core";
import { describe, expect, it, vi } from "vitest";
import {
	LiveReplyEvents,
	type LiveReplyNotification,
} from "../live-reply-events.js";

const BINDING = {
	sessionId: "voice-session",
	generation: 9,
	handoffId: "handoff-1",
	requestDigest: "request-digest",
	targetLeadId: "flywheel-eng-lead",
} as const;

function event(seq: number): VoiceHandoffResultEvent {
	return {
		resultEventId: `result-${seq}`,
		seq,
		handoffId: BINDING.handoffId,
		requestDigest: BINDING.requestDigest,
		sourceLeadId: BINDING.targetLeadId,
		sourceDeliveryId: `delivery-${seq}`,
		resultKind: "lead_reply",
		text: `reply ${seq}`,
		createdAt: `2026-09-24T00:00:0${seq}.000Z`,
	};
}

function notifications() {
	const listeners = new Set<(notification: LiveReplyNotification) => void>();
	return {
		subscribe: vi.fn(
			(listener: (notification: LiveReplyNotification) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		),
		emit(notification: LiveReplyNotification) {
			for (const listener of listeners) listener(notification);
		},
	};
}

describe("LiveReplyEvents", () => {
	it("uses notifications only as wakeups and replays durable result pages from each handoff cursor", async () => {
		const source = notifications();
		const applyResult = vi.fn(async () => undefined);
		const listResults = vi.fn(async (_handoffId: string, after: number) =>
			after === 0
				? { events: [event(1), event(2)], highWatermark: 2, nextCursor: 2 }
				: { events: [event(3)], highWatermark: 3, nextCursor: 3 },
		);
		const replies = new LiveReplyEvents({
			sessionId: BINDING.sessionId,
			generation: BINDING.generation,
			subscribe: source.subscribe,
			listResults,
			applyResult,
			record: vi.fn(),
		});

		replies.start();
		replies.register(BINDING);
		await vi.waitFor(() => expect(applyResult).toHaveBeenCalledTimes(2));
		expect(listResults).toHaveBeenLastCalledWith(BINDING.handoffId, 0, 100);

		source.emit({
			sessionId: BINDING.sessionId,
			generation: BINDING.generation,
			handoffId: BINDING.handoffId,
		});
		await vi.waitFor(() => expect(applyResult).toHaveBeenCalledTimes(3));
		expect(listResults).toHaveBeenLastCalledWith(BINDING.handoffId, 2, 100);
		expect(applyResult.mock.calls.map(([value]) => value.seq)).toEqual([
			1, 2, 3,
		]);
	});

	it("does not advance the replay cursor when applying a result fails", async () => {
		const source = notifications();
		const applyResult = vi
			.fn()
			.mockRejectedValueOnce(new Error("speaker unavailable"))
			.mockResolvedValue(undefined);
		const listResults = vi.fn(async () => ({
			events: [event(1)],
			highWatermark: 1,
			nextCursor: 1,
		}));
		const record = vi.fn();
		const replies = new LiveReplyEvents({
			sessionId: BINDING.sessionId,
			generation: BINDING.generation,
			subscribe: source.subscribe,
			listResults,
			applyResult,
			record,
		});

		replies.start();
		replies.register(BINDING);
		await vi.waitFor(() =>
			expect(record).toHaveBeenCalledWith(
				expect.objectContaining({ kind: "live_reply_drain_failed" }),
			),
		);
		source.emit({
			sessionId: BINDING.sessionId,
			generation: BINDING.generation,
			handoffId: BINDING.handoffId,
		});

		await vi.waitFor(() => expect(applyResult).toHaveBeenCalledTimes(2));
		expect(listResults.mock.calls.map(([, after]) => after)).toEqual([0, 0]);
	});

	it("coalesces overlapping wakeups and ignores foreign session notifications", async () => {
		const source = notifications();
		let releaseFirst!: (page: {
			events: VoiceHandoffResultEvent[];
			highWatermark: number;
			nextCursor: number;
		}) => void;
		const first = new Promise<{
			events: VoiceHandoffResultEvent[];
			highWatermark: number;
			nextCursor: number;
		}>((resolve) => {
			releaseFirst = resolve;
		});
		const listResults = vi
			.fn()
			.mockReturnValueOnce(first)
			.mockResolvedValue({ events: [], highWatermark: 1, nextCursor: 1 });
		const replies = new LiveReplyEvents({
			sessionId: BINDING.sessionId,
			generation: BINDING.generation,
			subscribe: source.subscribe,
			listResults,
			applyResult: vi.fn(async () => undefined),
			record: vi.fn(),
		});

		replies.start();
		replies.register(BINDING);
		source.emit({ ...BINDING, sessionId: "foreign-session" });
		source.emit(BINDING);
		source.emit(BINDING);
		releaseFirst({ events: [event(1)], highWatermark: 1, nextCursor: 1 });

		await vi.waitFor(() => expect(listResults).toHaveBeenCalledTimes(2));
		expect(listResults.mock.calls.map(([, after]) => after)).toEqual([0, 1]);
	});
});
