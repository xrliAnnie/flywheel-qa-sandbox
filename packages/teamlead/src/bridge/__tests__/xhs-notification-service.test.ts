import { afterEach, expect, it, vi } from "vitest";
import { startXhsNotificationService } from "../xhs-notification-service.js";

const state = vi.hoisted(() => ({
	attempts: 0,
	immediate: false,
	acked: false,
	order: [] as string[],
	absent: true,
	signals: [] as AbortSignal[],
}));
vi.mock("../../xiaohongshu-write/parent-client-policy.js", () => ({
	createBridgeXhsNotificationClients: (path: string) => {
		expect(path).toBe("/Library/Application Support/Flywheel/Xhs/policy.json");
		state.attempts++;
		if (state.absent) throw Error("private-root-error");
		return [
			{
				scope: { projectId: "project", leadId: "lead" },
				client: {
					async call(_action: string, _input: unknown, signal: AbortSignal) {
						state.signals.push(signal);
						if (state.immediate) {
							state.order.push(_action);
							if (_action === "notification_ack") {
								state.acked = true;
								return { acknowledged: true };
							}
							return {
								events: state.acked
									? []
									: [
											{
												eventId:
													"xhs-approved:12345678-1234-4234-8234-123456789012",
												eventKind: "approved",
												receiptId: "12345678-1234-4234-8234-123456789012",
												proposalId: "12345678-1234-4234-8234-123456789013",
												contentDigest: "a".repeat(64),
												expiry: 2000000000000,
											},
										],
							};
						}
						return new Promise((_resolve, reject) =>
							signal.addEventListener(
								"abort",
								() => reject(Error("cancelled")),
								{ once: true },
							),
						);
					},
				},
			},
		];
	},
}));
afterEach(() => {
	vi.useRealTimers();
	state.attempts = 0;
	state.immediate = false;
	state.acked = false;
	state.order = [];
	state.absent = true;
	state.signals = [];
});
it("retries absent policy at five seconds, avoids overlapping polls and drains cancellation on close", async () => {
	vi.useFakeTimers();
	const enqueue = vi.fn();
	const service = startXhsNotificationService({ enqueue });
	await vi.advanceTimersByTimeAsync(0);
	expect(state.attempts).toBe(1);
	state.absent = false;
	await vi.advanceTimersByTimeAsync(4999);
	expect(state.attempts).toBe(1);
	await vi.advanceTimersByTimeAsync(1);
	expect(state.attempts).toBe(2);
	expect(state.signals).toHaveLength(1);
	await vi.advanceTimersByTimeAsync(10000);
	expect(state.attempts).toBe(2);
	await service.close();
	expect(state.signals[0]?.aborted).toBe(true);
	await vi.advanceTimersByTimeAsync(10000);
	expect(state.attempts).toBe(2);
	expect(enqueue).not.toHaveBeenCalled();
	await service.close();
});

it("runs the real poller from the lifecycle and ACKs only after its enqueue receipt", async () => {
	vi.useFakeTimers();
	state.absent = false;
	state.immediate = true;
	const service = startXhsNotificationService({
		enqueue: (scope, notice) => {
			expect(scope).toEqual({ projectId: "project", leadId: "lead" });
			state.order.push("enqueue");
			return { queued: true, deliveryId: notice.eventId };
		},
	});
	try {
		await vi.advanceTimersByTimeAsync(0);
		expect(state.order).toEqual([
			"notifications",
			"enqueue",
			"notification_ack",
		]);
		await vi.advanceTimersByTimeAsync(5000);
		expect(state.order).toEqual([
			"notifications",
			"enqueue",
			"notification_ack",
			"notifications",
		]);
	} finally {
		await service.close();
	}
});
