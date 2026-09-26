import { describe, expect, it, vi } from "vitest";
import {
	ScriptWriter,
	type ScriptWriterProcess,
} from "../codex/ScriptWriter.js";

class FakeProcess implements ScriptWriterProcess {
	readonly requests: Array<{ method: string; params: unknown }> = [];
	private readonly notifications: Array<
		(method: string, params: unknown) => void
	> = [];
	private readonly exits: Array<() => void> = [];
	turnId = "turn-1";

	on(
		event: "notification" | "exit",
		callback:
			| ((method: string, params: unknown) => void)
			| ((code: number | null, signal: NodeJS.Signals | null) => void),
	): void {
		if (event === "notification") {
			this.notifications.push(
				callback as (method: string, params: unknown) => void,
			);
		} else {
			this.exits.push(() =>
				(
					callback as (
						code: number | null,
						signal: NodeJS.Signals | null,
					) => void
				)(1, null),
			);
		}
	}

	async request(method: string, params?: unknown) {
		this.requests.push({ method, params });
		if (method === "turn/start")
			return { result: { turn: { id: this.turnId } } };
		return { result: {} };
	}

	emit(method: string, params: unknown): void {
		for (const callback of this.notifications) callback(method, params);
	}

	exit(): void {
		for (const callback of this.exits) callback();
	}
}

async function started(process: FakeProcess): Promise<Record<string, unknown>> {
	await vi.waitFor(() =>
		expect(process.requests.some((row) => row.method === "turn/start")).toBe(
			true,
		),
	);
	return process.requests.find((row) => row.method === "turn/start")!
		.params as Record<string, unknown>;
}

function complete(process: FakeProcess, output: unknown): void {
	process.emit("item/agentMessage/delta", {
		threadId: "thread-1",
		turnId: process.turnId,
		delta: JSON.stringify(output),
	});
	process.emit("turn/completed", {
		threadId: "thread-1",
		turn: { id: process.turnId, status: "completed" },
	});
}

describe("subscription-backed voice ScriptWriter", () => {
	it("discards a prior turn final while the next turn start response is still pending", async () => {
		const process = new FakeProcess();
		const writer = new ScriptWriter({ process, threadId: "thread-1" });
		const first = writer.rewrite({ sourceText: "FLY-2886", rosterNames: [] });
		await started(process);
		complete(process, { spoken: "FLY-2886 已完成。", threadText: null });
		await first;
		let startNext!: (value: { result: { turn: { id: string } } }) => void;
		vi.spyOn(process, "request").mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					startNext = resolve;
				}),
		);
		const second = writer.rewrite({ sourceText: "FLY-2999", rosterNames: [] });
		complete(process, { spoken: "FLY-2886 迟到了。", threadText: null });
		startNext({ result: { turn: { id: "turn-2" } } });
		await Promise.resolve();
		process.turnId = "turn-2";
		complete(process, { spoken: "FLY-2999 已完成。", threadText: null });
		await expect(second).resolves.toMatchObject({
			spoken: "FLY-2999 已完成。",
		});
	});

	it("captures completed agent output when the process sends no deltas", async () => {
		const process = new FakeProcess();
		const writer = new ScriptWriter({ process, threadId: "thread-1" });
		const result = writer.rewrite({
			sourceText: "FLY-2886 PR #1326",
			rosterNames: [],
		});
		await started(process);
		process.emit("item/completed", {
			threadId: "thread-1",
			turnId: "turn-1",
			item: {
				id: "answer",
				type: "agentMessage",
				text: JSON.stringify({
					spoken: "FLY-2886 在 PR #1326。",
					threadText: null,
				}),
			},
		});
		process.emit("turn/completed", {
			threadId: "thread-1",
			turn: { id: "turn-1", status: "completed" },
		});
		await expect(result).resolves.toMatchObject({
			spoken: "FLY-2886 在 PR #1326。",
		});
	});

	it("sends source text as data with a strict output schema and returns a locally validated rewrite", async () => {
		const process = new FakeProcess();
		const writer = new ScriptWriter({ process, threadId: "thread-1" });
		const result = writer.rewrite({
			sourceText: "FLY-2886 is on PR #1326 and Tadashi owns it.",
			rosterNames: ["Tadashi"],
		});
		const params = await started(process);
		expect(params).toMatchObject({
			threadId: "thread-1",
			input: [
				{
					type: "text",
					text: expect.stringContaining(
						'"sourceText":"FLY-2886 is on PR #1326 and Tadashi owns it."',
					),
				},
			],
			outputSchema: {
				type: "object",
				additionalProperties: false,
				required: ["spoken", "threadText"],
			},
		});
		complete(process, {
			spoken: "FLY-2886 现在是 PR #1326，负责人是 Tadashi。",
			threadText: null,
		});
		await expect(result).resolves.toEqual({
			spoken: "FLY-2886 现在是 PR #1326，负责人是 Tadashi。",
			threadText: null,
			protectedFieldEvidence: expect.any(Array),
		});
	});

	it.each([
		{
			name: "extra key",
			output: {
				spoken: "FLY-2886 在 PR #1326。",
				threadText: null,
				extra: true,
			},
		},
		{
			name: "over 120 characters",
			output: {
				spoken: `FLY-2886 PR #1326 ${"字".repeat(121)}`,
				threadText: null,
			},
		},
		{
			name: "fabricated protected fields",
			output: { spoken: "FLY-9999 在 PR #9876。", threadText: null },
		},
	])("rejects $name before the script can be spoken", async ({ output }) => {
		const process = new FakeProcess();
		const writer = new ScriptWriter({ process, threadId: "thread-1" });
		const result = writer.rewrite({
			sourceText: "FLY-2886 is on PR #1326.",
			rosterNames: [],
		});
		await started(process);
		complete(process, output);
		await expect(result).rejects.toThrow("script_writer_output_invalid");
	});

	it("interrupts at 15 seconds and discards a late successful result", async () => {
		vi.useFakeTimers();
		const process = new FakeProcess();
		const writer = new ScriptWriter({ process, threadId: "thread-1" });
		const result = writer.rewrite({
			sourceText: "FLY-2886 is on PR #1326.",
			rosterNames: [],
		});
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(15_001);
		await expect(result).rejects.toThrow("script_writer_timeout");
		expect(process.requests).toContainEqual({
			method: "turn/interrupt",
			params: { threadId: "thread-1", turnId: "turn-1" },
		});
		complete(process, {
			spoken: "FLY-2886 在 PR #1326。",
			threadText: null,
		});
		await Promise.resolve();
		vi.useRealTimers();
	});

	it("fails closed and interrupts if the no-tool process emits a tool item", async () => {
		const process = new FakeProcess();
		const writer = new ScriptWriter({ process, threadId: "thread-1" });
		const result = writer.rewrite({ sourceText: "hello", rosterNames: [] });
		await started(process);
		process.emit("item/started", {
			threadId: "thread-1",
			turnId: "turn-1",
			item: { type: "commandExecution" },
		});
		await expect(result).rejects.toThrow("script_writer_forbidden_tool");
		expect(process.requests).toContainEqual({
			method: "turn/interrupt",
			params: { threadId: "thread-1", turnId: "turn-1" },
		});
	});

	it("rejects overlap and a failed turn without returning partial JSON", async () => {
		const process = new FakeProcess();
		const writer = new ScriptWriter({ process, threadId: "thread-1" });
		const first = writer.rewrite({ sourceText: "hello", rosterNames: [] });
		await started(process);
		await expect(
			writer.rewrite({ sourceText: "second", rosterNames: [] }),
		).rejects.toThrow("script_writer_busy");
		process.emit("item/agentMessage/delta", {
			threadId: "thread-1",
			turnId: "turn-1",
			delta: '{"spoken":"partial',
		});
		process.emit("turn/completed", {
			threadId: "thread-1",
			turn: { id: "turn-1", status: "failed" },
		});
		await expect(first).rejects.toThrow("script_writer_turn_failed");
	});
});
