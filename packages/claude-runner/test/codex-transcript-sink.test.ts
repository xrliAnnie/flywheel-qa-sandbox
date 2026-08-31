import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CodexTranscriptSink,
	renderCodexNotification,
} from "../src/codex-transcript-sink.js";

const tempRoots: string[] = [];

function tempPath(...parts: string[]): string {
	const root = mkdtempSync(join(tmpdir(), "flywheel-codex-transcript-"));
	tempRoots.push(root);
	return join(root, ...parts);
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("renderCodexNotification", () => {
	it("renders turn boundaries and authoritative completed items", () => {
		expect(
			renderCodexNotification("turn/started", {
				threadId: "thread-own",
				turn: { id: "turn-1", status: "inProgress", items: [] },
			}),
		).toBe("── turn started: turn-1 ──");
		expect(
			renderCodexNotification("turn/completed", {
				threadId: "thread-own",
				turn: { id: "turn-1", status: "completed", items: [] },
			}),
		).toBe("── turn completed: turn-1 ──");
		expect(
			renderCodexNotification("item/completed", {
				threadId: "thread-own",
				turnId: "turn-1",
				item: {
					type: "agentMessage",
					id: "item-1",
					text: "First line\nSecond line",
					phase: "commentary",
				},
			}),
		).toBe("First line\nSecond line");
		expect(
			renderCodexNotification("item/completed", {
				threadId: "thread-own",
				turnId: "turn-1",
				item: {
					type: "commandExecution",
					id: "item-2",
					command: "pnpm test",
					cwd: "/repo",
					status: "completed",
					exitCode: 0,
				},
			}),
		).toBe("[command completed exit=0] pnpm test");
	});

	it("drops high-volume deltas and token usage, then bounds unknown events", () => {
		expect(
			renderCodexNotification("item/agentMessage/delta", {
				delta: "partial",
			}),
		).toBeUndefined();
		expect(
			renderCodexNotification("thread/tokenUsage/updated", {
				tokens: 100,
			}),
		).toBeUndefined();

		const rendered = renderCodexNotification("future/event", {
			text: `line one\n${"x".repeat(800)}`,
		});
		expect(rendered).toMatch(/^\[future\/event\] /);
		expect(rendered).not.toContain("\n");
		expect(Array.from(rendered ?? "").length).toBeLessThanOrEqual(517);
		expect(rendered).toContain("…");
	});

	it("sanitizes terminal control sequences while preserving readable whitespace", () => {
		const rendered = renderCodexNotification("item/completed", {
			item: {
				type: "agentMessage",
				id: "item-1",
				text: "safe\u001b[2J\u001b]0;owned\u0007 text\nnext\tcell\u0000\u001bcreset\u001b(0grid\u001b7saved\u001b#8screen",
			},
		});
		expect(rendered).toBe("safe text\nnext\tcellcreset(0grid7saved#8screen");
		expect(rendered).not.toContain("\u001b");
	});

	it("summarizes reasoning, file changes, and goal state", () => {
		expect(
			renderCodexNotification("item/completed", {
				item: {
					type: "reasoning",
					id: "item-r",
					summary: [{ text: "Checked the tmux ownership path." }],
					content: [],
				},
			}),
		).toBe("[reasoning] Checked the tmux ownership path.");
		expect(
			renderCodexNotification("item/completed", {
				item: {
					type: "fileChange",
					id: "item-f",
					status: "completed",
					changes: [
						{ path: "src/a.ts", kind: "update", diff: "..." },
						{ path: "src/b.ts", kind: "add", diff: "..." },
					],
				},
			}),
		).toBe("[files completed] update src/a.ts, add src/b.ts");
		expect(
			renderCodexNotification("thread/goal/updated", {
				threadId: "thread-own",
				turnId: "turn-1",
				goal: { status: "active", tokensUsed: 42 },
			}),
		).toBe("── goal active · tokens=42 ──");
	});
});

describe("CodexTranscriptSink", () => {
	it("creates parent directories and writes a readable scoped transcript", async () => {
		const path = tempPath("nested", "transcript.log");
		const sink = new CodexTranscriptSink({ path });

		sink.writeHeader({
			executionId: "exec-1",
			issueId: "FLY-2169",
			label: "implement",
			cwd: "/repo",
			objective: "Make the runner visible",
			socketPath: "/tmp/codex.sock",
		});
		sink.appendMeta("daemon pgid: 4242");
		sink.setThreadScope("thread-own");
		sink.onNotification("item/completed", {
			threadId: "thread-own",
			item: { type: "agentMessage", text: "Working on the adapter." },
		});
		await sink.close("completed");

		const transcript = readFileSync(path, "utf8");
		expect(transcript).toContain("Codex runner observer");
		expect(transcript).toContain("FLY-2169 · implement");
		expect(transcript).toContain("execution: exec-1");
		expect(transcript).toContain("working directory: /repo");
		expect(transcript).toContain("daemon pgid: 4242");
		expect(transcript).toContain("thread: thread-own");
		expect(transcript).toContain("Working on the adapter.");
		expect(transcript).toContain("run ended: completed");
	});

	it("rotates the current log before an append would exceed maxBytes", async () => {
		const path = tempPath("transcript.log");
		writeFileSync(path, "old transcript\n", "utf8");
		const sink = new CodexTranscriptSink({ path, maxBytes: 16 });

		sink.appendMeta("new transcript entry");
		await sink.close();

		expect(readFileSync(`${path}.1`, "utf8")).toBe("old transcript\n");
		expect(readFileSync(path, "utf8")).toContain("new transcript entry");
	});

	it("filters foreign threads and emits one visible pre-thread marker", async () => {
		const path = tempPath("transcript.log");
		const sink = new CodexTranscriptSink({ path });

		sink.onNotification("turn/started", {
			threadId: "thread-before",
			turn: { id: "turn-before" },
		});
		sink.onNotification("turn/completed", {
			threadId: "thread-before",
			turn: { id: "turn-before" },
		});
		sink.setThreadScope("thread-own");
		sink.onNotification("item/completed", {
			threadId: "thread-foreign",
			item: { type: "agentMessage", text: "foreign" },
		});
		sink.onNotification("item/completed", {
			threadId: "thread-own",
			item: { type: "agentMessage", text: "owned" },
		});
		await sink.close();

		const transcript = readFileSync(path, "utf8");
		expect(transcript.match(/waiting for thread scope/g)).toHaveLength(1);
		expect(transcript).not.toContain("foreign");
		expect(transcript).toContain("owned");
	});

	it("accepts canonical nested thread ids and whitelisted unscoped goal events", async () => {
		const path = tempPath("transcript.log");
		const sink = new CodexTranscriptSink({ path });

		sink.setThreadScope("thread-own");
		sink.onNotification("item/completed", {
			thread: { id: "thread-own" },
			item: { type: "agentMessage", text: "nested thread message" },
		});
		sink.onNotification("thread/goal/updated", {
			goal: { status: "blocked" },
		});
		sink.onNotification("item/completed", {
			item: { type: "agentMessage", text: "unscoped item must stay hidden" },
		});
		await sink.close();

		const transcript = readFileSync(path, "utf8");
		expect(transcript).toContain("nested thread message");
		expect(transcript).toContain("goal blocked");
		expect(transcript).not.toContain("unscoped item must stay hidden");
	});

	it("bounds queued output and leaves a visible backpressure marker", async () => {
		let releaseFirst: (() => void) | undefined;
		const firstWrite = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const writes: string[] = [];
		let appendCalls = 0;
		const sink = new CodexTranscriptSink({
			path: "/virtual/transcript.log",
			maxQueuedBytes: 48,
			fsOps: {
				appendFile: vi.fn(async (_path, data) => {
					writes.push(data);
					appendCalls += 1;
					if (appendCalls === 1) await firstWrite;
				}),
				mkdir: vi.fn(async () => undefined),
				rename: vi.fn(async () => undefined),
				stat: vi.fn(async () => ({ size: 0 })),
			},
		});

		sink.appendMeta("first pending entry");
		sink.appendMeta("x".repeat(200));
		sink.appendMeta("y".repeat(200));
		releaseFirst?.();
		await sink.close();

		expect(writes.join("")).toContain("first pending entry");
		expect(writes.join("")).toContain("output dropped (backpressure)");
		expect(writes.join("")).not.toContain("x".repeat(200));
		expect(
			writes.join("").match(/output dropped \(backpressure\)/g),
		).toHaveLength(1);
	});

	it("ensures the private directory and probes file size only once", async () => {
		const mkdir = vi.fn(async () => undefined);
		const stat = vi.fn(async () => ({ size: 0 }));
		const sink = new CodexTranscriptSink({
			path: "/virtual/transcript.log",
			fsOps: {
				appendFile: vi.fn(async () => undefined),
				mkdir,
				rename: vi.fn(async () => undefined),
				stat,
			},
		});

		sink.appendMeta("first");
		sink.appendMeta("second");
		await sink.close();

		expect(mkdir).toHaveBeenCalledOnce();
		expect(stat).toHaveBeenCalledOnce();
	});

	it("fails open when filesystem, renderer, and logger callbacks throw", async () => {
		const render = vi.fn(() => {
			throw new Error("render failed");
		});
		const sink = new CodexTranscriptSink({
			path: "/virtual/transcript.log",
			fsOps: {
				appendFile: vi.fn(async () => {
					throw new Error("append failed");
				}),
				mkdir: vi.fn(async () => {
					throw new Error("mkdir failed");
				}),
				rename: vi.fn(async () => {
					throw new Error("rename failed");
				}),
				stat: vi.fn(async () => {
					throw new Error("stat failed");
				}),
			},
			render,
			log: () => {
				throw new Error("logger failed");
			},
		});

		expect(() =>
			sink.writeHeader({ executionId: "e", cwd: "/repo" }),
		).not.toThrow();
		expect(() => sink.appendMeta("still alive")).not.toThrow();
		sink.setThreadScope("thread-own");
		expect(() =>
			sink.onNotification("future/event", { threadId: "thread-own" }),
		).not.toThrow();
		expect(render).toHaveBeenCalledOnce();
		await expect(sink.close("failed")).resolves.toBeUndefined();
	});

	it("returns from close when an append never resolves", async () => {
		const logs: string[] = [];
		const sink = new CodexTranscriptSink({
			path: "/virtual/transcript.log",
			closeDeadlineMs: 5,
			fsOps: {
				appendFile: vi.fn(() => new Promise<void>(() => undefined)),
				mkdir: vi.fn(async () => undefined),
				rename: vi.fn(async () => undefined),
				stat: vi.fn(async () => ({ size: 0 })),
			},
			log: (message) => logs.push(message),
		});
		sink.appendMeta("never flushed");

		const startedAt = Date.now();
		await sink.close("timeout");

		expect(Date.now() - startedAt).toBeLessThan(100);
		expect(logs.join("\n")).toContain("close deadline");
	});

	it("does not require the transcript to exist before construction", () => {
		const path = tempPath("not-created-yet.log");
		new CodexTranscriptSink({ path });
		expect(existsSync(path)).toBe(false);
	});
});
