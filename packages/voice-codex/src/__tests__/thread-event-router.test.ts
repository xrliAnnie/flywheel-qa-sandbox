import { describe, expect, it, vi } from "vitest";
import {
	ThreadEventRouter,
	type ThreadEventRouterProcess,
} from "../codex/ThreadEventRouter.js";

class FakeProcess implements ThreadEventRouterProcess {
	readonly notifications: Array<(method: string, params: unknown) => void> = [];

	on(
		event: "notification",
		callback: (method: string, params: unknown) => void,
	): void {
		expect(event).toBe("notification");
		this.notifications.push(callback);
	}

	emit(method: string, params: unknown): void {
		for (const callback of this.notifications) callback(method, params);
	}
}

describe("ThreadEventRouter", () => {
	it.each(["old_cancel_wait", "new_opening", "new_started"])(
		"routes a completed turn during %s without depending on realtime state",
		(_phase) => {
			const process = new FakeProcess();
			const started = vi.fn();
			const completed = vi.fn();
			const items = vi.fn();
			const router = new ThreadEventRouter(process);
			router.register("thread-a", {
				onTurnStarted: started,
				onTurnTerminal: completed,
				onItemCompleted: items,
			});

			process.emit("turn/started", {
				threadId: "thread-a",
				turn: { id: "turn-a", status: "inProgress" },
			});
			process.emit("item/completed", {
				threadId: "thread-a",
				turnId: "turn-a",
				item: {
					id: "tool-a",
					type: "commandExecution",
					status: "completed",
					aggregatedOutput: "FLY-2886 is on PR #1324",
				},
			});
			process.emit("item/completed", {
				threadId: "thread-a",
				turnId: "turn-a",
				item: {
					id: "answer-a",
					type: "agentMessage",
					text: "【口语】FLY-2886 在 PR #1324。\n【口语】Tadashi 正在看。\n【文字版】https://example.test/pr/1324",
				},
			});
			process.emit("turn/completed", {
				threadId: "thread-a",
				turn: { id: "turn-a", status: "completed" },
			});

			expect(process.notifications).toHaveLength(1);
			expect(started).toHaveBeenCalledWith("turn-a");
			expect(items).toHaveBeenCalledTimes(2);
			expect(completed).toHaveBeenCalledWith({
				turnId: "turn-a",
				outcome: "completed",
				spokenSegments: ["FLY-2886 在 PR #1324。", "Tadashi 正在看。"],
			});
		},
	);

	it("fails closed on a malformed completion and ignores other threads", () => {
		const process = new FakeProcess();
		const completed = vi.fn();
		const router = new ThreadEventRouter(process);
		router.register("thread-a", {
			onTurnStarted: vi.fn(),
			onTurnTerminal: completed,
		});

		process.emit("turn/completed", {
			threadId: "thread-b",
			turn: { id: "foreign", status: "failed" },
		});
		process.emit("turn/completed", {
			threadId: "thread-a",
			turn: {
				id: "turn-failed",
				status: "failed",
				error: { message: "sandbox permission denied" },
			},
		});

		expect(completed).toHaveBeenCalledOnce();
		expect(completed).toHaveBeenCalledWith({
			turnId: "turn-failed",
			outcome: "failed",
			spokenSegments: [],
			reasonCategory: "权限",
		});
	});
});
