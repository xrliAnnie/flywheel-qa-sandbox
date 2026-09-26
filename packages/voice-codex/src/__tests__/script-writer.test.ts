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

/** Outputs predating the relevance fields default to "tell it". */
function withRelevance(output: unknown): unknown {
	return output && typeof output === "object" && !("tell" in output)
		? { ...output, tell: true, skipReason: null }
		: output;
}

function complete(process: FakeProcess, output: unknown): void {
	process.emit("item/agentMessage/delta", {
		threadId: "thread-1",
		turnId: process.turnId,
		delta: JSON.stringify(withRelevance(output)),
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
		const first = writer.rewrite({
			sourceText: "FLY-2886 已完成",
			rosterNames: [],
		});
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
		const second = writer.rewrite({
			sourceText: "FLY-2999 已完成",
			rosterNames: [],
		});
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
					tell: true,
					skipReason: null,
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
				required: ["spoken", "threadText", "tell", "skipReason"],
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
			tell: true,
			skipReason: null,
			droppedSentences: [],
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
			name: "a skip without an allowed reason",
			output: {
				spoken: "收到。",
				threadText: null,
				tell: false,
				skipReason: "boring",
			},
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

	// FLY-2886 Lead 1c8019f8: a changed key fact no longer rejects the whole
	// rewrite; the wrong sentence is dropped whole and the exact source goes to
	// the thread, so the founder still hears what was right.
	it("drops a sentence with a fabricated key fact and routes the exact source to the thread", async () => {
		const process = new FakeProcess();
		const writer = new ScriptWriter({ process, threadId: "thread-1" });
		const result = writer.rewrite({
			sourceText: "FLY-2886 is on PR #1326. CI passed.",
			rosterNames: [],
		});
		await started(process);
		complete(process, {
			spoken: "FLY-2886 在 PR #9876。CI 过了。",
			threadText: null,
		});
		await expect(result).resolves.toMatchObject({
			spoken: "CI 过了。这条我发到 thread 了，编号以文字为准。",
			threadText: "FLY-2886 is on PR #1326. CI passed.",
			droppedSentences: ["FLY-2886 在 PR #9876。"],
			tell: true,
		});
	});

	it("returns a relevance skip with its reason and sends her recent asks as data", async () => {
		const process = new FakeProcess();
		const writer = new ScriptWriter({ process, threadId: "thread-1" });
		const result = writer.rewrite({
			sourceText: "收到，已记下。",
			rosterNames: [],
			recentFounderAsks: ["2886 的 PR 怎么样了"],
		});
		const params = await started(process);
		expect(JSON.stringify(params.input)).toContain("recentFounderAsks");
		expect(JSON.stringify(params.input)).toContain("2886 的 PR 怎么样了");
		complete(process, {
			spoken: "收到。",
			threadText: null,
			tell: false,
			skipReason: "ack_only",
		});
		await expect(result).resolves.toMatchObject({
			tell: false,
			skipReason: "ack_only",
		});
	});

	// QA@5 B1: the real scribe (6/6 on the production account) answers a pure
	// ack with an empty spoken string. That is a legal skip, not invalid output;
	// rejecting it degraded 7/9 admissions (the self-check says 准备好了。).
	it("accepts the real skip shape with an empty spoken string", async () => {
		const process = new FakeProcess();
		const writer = new ScriptWriter({ process, threadId: "thread-1" });
		const result = writer.rewrite({
			sourceText: "准备好了。",
			rosterNames: [],
		});
		await started(process);
		complete(process, {
			spoken: "",
			threadText: null,
			tell: false,
			skipReason: "ack_only",
		});
		await expect(result).resolves.toMatchObject({
			spoken: "",
			tell: false,
			skipReason: "ack_only",
		});
	});

	it("still rejects an empty script the writer says should be told", async () => {
		const process = new FakeProcess();
		const writer = new ScriptWriter({ process, threadId: "thread-1" });
		const result = writer.rewrite({
			sourceText: "FLY-2886 已合并。",
			rosterNames: [],
		});
		await started(process);
		complete(process, {
			spoken: " ",
			threadText: null,
			tell: true,
			skipReason: null,
		});
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
