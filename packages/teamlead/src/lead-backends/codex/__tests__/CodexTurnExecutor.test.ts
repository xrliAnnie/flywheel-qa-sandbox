import { describe, expect, it, vi } from "vitest";
import { type ChildTransport, CodexLeadProcess } from "../CodexLeadProcess.js";
import { CodexTurnExecutor, parseReconcile } from "../CodexTurnExecutor.js";

class FakeChild implements ChildTransport {
	writes: string[] = [];
	private out?: (c: string) => void;
	private exitCb?: (code: number | null, sig: NodeJS.Signals | null) => void;
	writeStdin(d: string) {
		this.writes.push(d);
	}
	endStdin() {}
	kill() {}
	onStdout(cb: (c: string) => void) {
		this.out = cb;
	}
	onStderr() {}
	onExit(cb: (code: number | null, sig: NodeJS.Signals | null) => void) {
		this.exitCb = cb;
	}
	lastId(): number {
		const f = this.writes.map((w) => JSON.parse(w.trim()));
		return f[f.length - 1].id as number;
	}
	push(o: unknown) {
		this.out?.(`${JSON.stringify(o)}\n`);
	}
	respond(id: number, result: unknown) {
		this.push({ jsonrpc: "2.0", id, result });
	}
	exit(code: number | null) {
		this.exitCb?.(code, null);
	}
}

async function setup() {
	const child = new FakeChild();
	const proc = new CodexLeadProcess({
		spawnChild: () => child,
		logger: { warn: vi.fn(), error: vi.fn() },
	});
	const startP = proc.start();
	child.respond(1, {}); // initialize
	await startP;
	const exec = new CodexTurnExecutor({ process: proc, threadId: "th-1" });
	return { child, proc, exec };
}

describe("CodexTurnExecutor — turn lifecycle", () => {
	it("startTurn sends turn/start with text input + correlation id, returns turnId", async () => {
		const { child, exec } = await setup();
		const p = exec.startTurn({
			threadId: "th-1",
			input: "hi",
			clientUserMessageId: "corr-1",
		});
		const frame = JSON.parse(child.writes[child.writes.length - 1].trim());
		expect(frame.method).toBe("turn/start");
		expect(frame.params.input).toEqual([{ type: "text", text: "hi" }]);
		expect(frame.params.clientUserMessageId).toBe("corr-1");
		child.respond(child.lastId(), { turnId: "t-9" });
		expect(await p).toBe("t-9");
	});

	it("accumulates deltas and resolves awaitCompletion on turn/completed", async () => {
		const { child, exec } = await setup();
		const p = exec.startTurn({
			threadId: "th-1",
			input: "hi",
			clientUserMessageId: "c",
		});
		child.respond(child.lastId(), { turnId: "t-1" });
		const turnId = await p;
		const ap = exec.awaitCompletion(turnId);
		child.push({
			jsonrpc: "2.0",
			method: "agentMessageDelta",
			params: { delta: "hel" },
		});
		child.push({
			jsonrpc: "2.0",
			method: "agentMessageDelta",
			params: { delta: "lo" },
		});
		child.push({
			jsonrpc: "2.0",
			method: "turn/completed",
			params: { threadId: "th-1", turn: { id: "t-1", status: "completed" } },
		});
		expect(await ap).toEqual({ output: "hello" });
	});

	it("excludes tool/command output deltas from the assistant reply (HIGH-1)", async () => {
		const { child, exec } = await setup();
		const p = exec.startTurn({
			threadId: "th-1",
			input: "hi",
			clientUserMessageId: "c",
		});
		child.respond(child.lastId(), { turnId: "t-1" });
		const turnId = await p;
		const ap = exec.awaitCompletion(turnId);
		child.push({
			jsonrpc: "2.0",
			method: "agentMessageDelta",
			params: { delta: "real" },
		});
		// tool/command output delta — must NOT be mixed into the reply:
		child.push({
			jsonrpc: "2.0",
			method: "commandExecutionOutputDelta",
			params: { delta: "$ ls\nfoo" },
		});
		child.push({
			jsonrpc: "2.0",
			method: "agentMessageDelta",
			params: { delta: "-reply" },
		});
		child.push({
			jsonrpc: "2.0",
			method: "turn/completed",
			params: { turn: { id: "t-1", status: "completed" } },
		});
		expect(await ap).toEqual({ output: "real-reply" });
	});

	it("rejects awaitCompletion when the turn completes with a failure status (HIGH-2)", async () => {
		const { child, exec } = await setup();
		const p = exec.startTurn({
			threadId: "th-1",
			input: "x",
			clientUserMessageId: "c",
		});
		child.respond(child.lastId(), { turnId: "t-1" });
		const turnId = await p;
		const ap = exec.awaitCompletion(turnId);
		child.push({
			jsonrpc: "2.0",
			method: "agentMessageDelta",
			params: { delta: "partial" },
		});
		child.push({
			jsonrpc: "2.0",
			method: "turn/completed",
			params: { turn: { id: "t-1", status: "interrupted" } },
		});
		await expect(ap).rejects.toThrow(/interrupted/);
	});

	it("rejects awaitCompletion when turn/completed has NO status (schema requires it)", async () => {
		const { child, exec } = await setup();
		const p = exec.startTurn({
			threadId: "th-1",
			input: "x",
			clientUserMessageId: "c",
		});
		child.respond(child.lastId(), { turnId: "t-1" });
		const turnId = await p;
		const ap = exec.awaitCompletion(turnId);
		child.push({
			jsonrpc: "2.0",
			method: "agentMessageDelta",
			params: { delta: "partial" },
		});
		// Malformed completion missing turn.status → must NOT be treated as success.
		child.push({
			jsonrpc: "2.0",
			method: "turn/completed",
			params: { turn: { id: "t-1" } },
		});
		await expect(ap).rejects.toThrow(/missing/);
	});

	it("a misplaced top-level status can't spoof success (only turn.status counts)", async () => {
		const { child, exec } = await setup();
		const p = exec.startTurn({
			threadId: "th-1",
			input: "x",
			clientUserMessageId: "c",
		});
		child.respond(child.lastId(), { turnId: "t-1" });
		const turnId = await p;
		const ap = exec.awaitCompletion(turnId);
		child.push({
			jsonrpc: "2.0",
			method: "agentMessageDelta",
			params: { delta: "partial" },
		});
		// status at the WRONG level (top-level, not under turn) → not a real success.
		child.push({
			jsonrpc: "2.0",
			method: "turn/completed",
			params: { turn: { id: "t-1" }, status: "completed" },
		});
		await expect(ap).rejects.toThrow(/missing/);
	});

	it("ignores a turn/completed for a different turnId (stale notification)", async () => {
		const { child, exec } = await setup();
		const p = exec.startTurn({
			threadId: "th-1",
			input: "x",
			clientUserMessageId: "c",
		});
		child.respond(child.lastId(), { turnId: "t-current" });
		const turnId = await p;
		const ap = exec.awaitCompletion(turnId);
		// completion naming a DIFFERENT turn must not resolve ours
		child.push({
			jsonrpc: "2.0",
			method: "turn/completed",
			params: { turn: { id: "t-other", status: "completed" } },
		});
		child.push({
			jsonrpc: "2.0",
			method: "agentMessageDelta",
			params: { turnId: "t-current", delta: "ok" },
		});
		child.push({
			jsonrpc: "2.0",
			method: "turn/completed",
			params: { turn: { id: "t-current", status: "completed" } },
		});
		expect(await ap).toEqual({ output: "ok" });
	});

	it("process exit during a pending startTurn rejects without an unhandled rejection", async () => {
		const { child, exec } = await setup();
		const p = exec.startTurn({
			threadId: "th-1",
			input: "x",
			clientUserMessageId: "c",
		});
		// Do not respond to turn/start; kill the process instead.
		child.exit(1);
		await expect(p).rejects.toThrow();
		// No leaked active turn — a fresh turn can start.
		const p2 = exec.startTurn({
			threadId: "th-1",
			input: "y",
			clientUserMessageId: "c2",
		});
		// (proc is exited now, so startTurn rejects again — but cleanly, no leak)
		await expect(p2).rejects.toThrow();
	});

	it("startTurn failure throws and does not leak an active turn", async () => {
		const { child, exec } = await setup();
		const p = exec.startTurn({
			threadId: "th-1",
			input: "x",
			clientUserMessageId: "c",
		});
		child.push({
			jsonrpc: "2.0",
			id: child.lastId(),
			error: { code: -1, message: "no" },
		});
		await expect(p).rejects.toThrow();
		// A subsequent turn can still start (no leaked active turn).
		const p2 = exec.startTurn({
			threadId: "th-1",
			input: "y",
			clientUserMessageId: "c2",
		});
		child.respond(child.lastId(), { turnId: "t-2" });
		expect(await p2).toBe("t-2");
	});

	it("app-server exit mid-turn rejects awaitCompletion (router → ambiguous)", async () => {
		const { child, exec } = await setup();
		const p = exec.startTurn({
			threadId: "th-1",
			input: "x",
			clientUserMessageId: "c",
		});
		child.respond(child.lastId(), { turnId: "t-1" });
		const turnId = await p;
		const ap = exec.awaitCompletion(turnId);
		child.exit(1);
		await expect(ap).rejects.toThrow(/exited/);
	});
});

describe("CodexTurnExecutor.parseReconcile", () => {
	it("finds the turn by clientId and reports completed + output", () => {
		const result = {
			thread: {
				turns: [
					{
						id: "t-77",
						status: { type: "completed" },
						items: [
							{ role: "user", clientId: "corr-x", text: "q" },
							{ role: "assistant", text: "the answer" },
						],
					},
				],
			},
		};
		expect(parseReconcile(result, "corr-x")).toEqual({
			exists: true,
			completed: true,
			turnId: "t-77",
			output: "the answer",
		});
	});

	it("returns not-found when no clientId matches", () => {
		const result = {
			thread: {
				turns: [{ id: "t", items: [{ role: "user", clientId: "other" }] }],
			},
		};
		expect(parseReconcile(result, "corr-x")).toEqual({
			exists: false,
			completed: false,
		});
	});

	it("exists but not completed when the turn is still active", () => {
		const result = {
			thread: {
				turns: [
					{
						id: "t-9",
						status: { type: "active" },
						items: [{ role: "user", clientUserMessageId: "corr-x" }],
					},
				],
			},
		};
		const r = parseReconcile(result, "corr-x");
		expect(r.exists).toBe(true);
		expect(r.completed).toBe(false);
	});

	it("handles a malformed/empty result (incl. null turns/items) without throwing", () => {
		expect(parseReconcile(undefined, "c")).toEqual({
			exists: false,
			completed: false,
		});
		expect(parseReconcile({ thread: {} }, "c")).toEqual({
			exists: false,
			completed: false,
		});
		// null elements in turns / items must not throw (best-effort parse).
		expect(parseReconcile({ thread: { turns: [null] } }, "c")).toEqual({
			exists: false,
			completed: false,
		});
		expect(
			parseReconcile(
				{
					thread: {
						turns: [{ id: "t", items: [null, { clientId: "other" }] }],
					},
				},
				"c",
			),
		).toEqual({ exists: false, completed: false });
	});

	it("does NOT report completed without a real turnId (MED-5)", () => {
		const result = {
			thread: {
				turns: [
					{
						// no id / turnId
						status: { type: "completed" },
						items: [
							{ role: "user", clientId: "corr-x" },
							{ role: "assistant", text: "answer" },
						],
					},
				],
			},
		};
		const r = parseReconcile(result, "corr-x");
		expect(r.exists).toBe(true);
		expect(r.completed).toBe(false); // no turnId → cannot claim completion
	});
});
