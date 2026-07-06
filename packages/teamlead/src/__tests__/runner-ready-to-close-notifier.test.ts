import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitRunnerReadyToCloseNotification } from "../bridge/runner-ready-to-close-notifier.js";
import { StateStore } from "../StateStore.js";

function makeOpts(overrides: Record<string, unknown> = {}) {
	return {
		executionId: "exec-1",
		issueId: "FLY-102",
		issueIdentifier: "FLY-102",
		projectName: "flywheel",
		sessionStatus: "completed",
		tmuxClosed: true,
		thread: { thread_id: "thread-1", channel_id: "chan-1" } as const,
		botToken: "bot-token",
		...overrides,
	};
}

function seedSession(store: StateStore): void {
	store.upsertSession({
		execution_id: "exec-1",
		issue_id: "FLY-102",
		project_name: "flywheel",
		status: "completed",
	});
}

function okResponse(): Response {
	return new Response("{}", { status: 200 });
}

describe("emitRunnerReadyToCloseNotification", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		seedSession(store);
	});

	it("success path: claim + notified events + one fetch", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(okResponse());

		await emitRunnerReadyToCloseNotification(makeOpts(), { store, fetchImpl });

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const url = fetchImpl.mock.calls[0]![0] as string;
		expect(url).toContain("/channels/thread-1/messages");

		const events = store.getEventsByExecution("exec-1");
		const types = events.map((e) => e.event_type);
		expect(types).toContain("runner_ready_to_close_claim");
		expect(types).toContain("runner_ready_to_close_notified");
	});

	it("atomic dedupe: concurrent Promise.all → 1 fetch, 1 notified event", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(okResponse());

		await Promise.all([
			emitRunnerReadyToCloseNotification(makeOpts(), { store, fetchImpl }),
			emitRunnerReadyToCloseNotification(makeOpts(), { store, fetchImpl }),
		]);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const events = store.getEventsByExecution("exec-1");
		const notified = events.filter(
			(e) => e.event_type === "runner_ready_to_close_notified",
		);
		expect(notified).toHaveLength(1);
		const claim = events.filter(
			(e) => e.event_type === "runner_ready_to_close_claim",
		);
		expect(claim).toHaveLength(1);
	});

	it("skips with no_chat_thread when thread is missing", async () => {
		const fetchImpl = vi.fn();
		const opts = makeOpts({ thread: undefined });

		await emitRunnerReadyToCloseNotification(opts, { store, fetchImpl });

		expect(fetchImpl).not.toHaveBeenCalled();
		const skip = store
			.getEventsByExecution("exec-1")
			.find((e) => e.event_type === "runner_ready_to_close_skipped");
		expect(skip).toBeDefined();
		expect((skip!.payload as { reason?: string }).reason).toBe(
			"no_chat_thread",
		);
	});

	it("skips with no_bot_token when botToken is missing", async () => {
		const fetchImpl = vi.fn();
		const opts = makeOpts({ botToken: undefined });

		await emitRunnerReadyToCloseNotification(opts, { store, fetchImpl });

		expect(fetchImpl).not.toHaveBeenCalled();
		const skip = store
			.getEventsByExecution("exec-1")
			.find((e) => e.event_type === "runner_ready_to_close_skipped");
		expect(skip).toBeDefined();
		expect((skip!.payload as { reason?: string }).reason).toBe("no_bot_token");
	});

	it("records notify_failed when Discord returns 403 (does not throw)", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response("forbidden", { status: 403 }));

		await expect(
			emitRunnerReadyToCloseNotification(makeOpts(), { store, fetchImpl }),
		).resolves.toBeUndefined();

		const failed = store
			.getEventsByExecution("exec-1")
			.find((e) => e.event_type === "runner_ready_to_close_notify_failed");
		expect(failed).toBeDefined();
		expect((failed!.payload as { status?: number }).status).toBe(403);
	});

	it("records notify_failed when fetch throws (does not propagate)", async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

		await expect(
			emitRunnerReadyToCloseNotification(makeOpts(), { store, fetchImpl }),
		).resolves.toBeUndefined();

		const failed = store
			.getEventsByExecution("exec-1")
			.find((e) => e.event_type === "runner_ready_to_close_notify_failed");
		expect(failed).toBeDefined();
		expect((failed!.payload as { error?: string }).error).toBe("ECONNREFUSED");
	});
});
