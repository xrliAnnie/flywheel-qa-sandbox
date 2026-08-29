import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ChildTransport,
	CodexLeadProcess,
	CodexLeadProcessError,
	JSONRPC_METHOD_NOT_FOUND,
} from "../CodexLeadProcess.js";

/**
 * Fake app-server child: captures stdin writes (as parsed JSON frames) and lets
 * the test push stdout/stderr/exit. Drives CodexLeadProcess deterministically
 * without a real `codex app-server`.
 */
class FakeChild implements ChildTransport {
	readonly writes: string[] = [];
	stdinEnded = false;
	killed: NodeJS.Signals | undefined;
	private stdoutCb?: (chunk: string) => void;
	private stderrCb?: (chunk: string) => void;
	private exitCb?: (code: number | null, signal: NodeJS.Signals | null) => void;

	writeStdin(data: string): void {
		this.writes.push(data);
	}
	endStdin(): void {
		this.stdinEnded = true;
	}
	kill(signal?: NodeJS.Signals): void {
		this.killed = signal ?? "SIGTERM";
	}
	onStdout(cb: (chunk: string) => void): void {
		this.stdoutCb = cb;
	}
	onStderr(cb: (chunk: string) => void): void {
		this.stderrCb = cb;
	}
	onExit(
		cb: (code: number | null, signal: NodeJS.Signals | null) => void,
	): void {
		this.exitCb = cb;
	}

	// ── test drivers ──
	/** All stdin frames parsed as JSON. */
	frames(): Array<Record<string, unknown>> {
		return this.writes.map((w) => JSON.parse(w.trim()));
	}
	lastFrame(): Record<string, unknown> {
		const f = this.frames();
		return f[f.length - 1];
	}
	pushStdout(line: string): void {
		this.stdoutCb?.(`${line}\n`);
	}
	pushStdoutRaw(chunk: string): void {
		this.stdoutCb?.(chunk);
	}
	pushStderr(chunk: string): void {
		this.stderrCb?.(chunk);
	}
	exit(code: number | null, signal: NodeJS.Signals | null = null): void {
		this.exitCb?.(code, signal);
	}
	/** Respond to the request with id `id`. */
	respond(id: number, result: unknown): void {
		this.pushStdout(JSON.stringify({ jsonrpc: "2.0", id, result }));
	}
	respondError(id: number, code: number, message: string): void {
		this.pushStdout(
			JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }),
		);
	}
}

const silentLogger = { warn: vi.fn(), error: vi.fn() };

function make(
	opts: Partial<
		Parameters<typeof CodexLeadProcess.prototype.constructor>[0]
	> = {},
) {
	const child = new FakeChild();
	const proc = new CodexLeadProcess({
		spawnChild: () => child,
		logger: silentLogger,
		...opts,
	});
	return { child, proc };
}

afterEach(() => vi.clearAllMocks());

describe("CodexLeadProcess — handshake", () => {
	it("sends initialize request then initialized notification", async () => {
		const { child, proc } = make();
		const startP = proc.start();
		// First frame = initialize request.
		const init = child.frames()[0];
		expect(init.method).toBe("initialize");
		expect(init.id).toBe(1);
		expect((init.params as { clientInfo: unknown }).clientInfo).toBeDefined();
		// Respond → start() resolves and sends initialized.
		child.respond(1, {});
		await startP;
		const initialized = child.lastFrame();
		expect(initialized.method).toBe("initialized");
		expect(initialized.id).toBeUndefined();
	});

	it("rejects double start", async () => {
		const { child, proc } = make();
		const p = proc.start();
		child.respond(1, {});
		await p;
		await expect(proc.start()).rejects.toThrow(/already started/);
	});

	it("treats an initialize ERROR as a failed handshake (no initialized sent)", async () => {
		// CR HIGH-1: an initialize error must NOT be treated as success.
		const { child, proc } = make();
		const startP = proc.start();
		child.respondError(1, -32000, "init refused");
		await expect(startP).rejects.toMatchObject({ kind: "protocol" });
		expect(child.frames().some((f) => f.method === "initialized")).toBe(false);
	});
});

async function started() {
	const { child, proc } = make();
	const p = proc.start();
	child.respond(1, {});
	await p;
	return { child, proc };
}

describe("CodexLeadProcess — request/response", () => {
	it("correlates response to request by id", async () => {
		const { child, proc } = await started();
		const reqP = proc.request("thread/read", { x: 1 });
		const frame = child.lastFrame();
		expect(frame.method).toBe("thread/read");
		child.respond(frame.id as number, { ok: true });
		const res = await reqP;
		expect(res.result).toEqual({ ok: true });
	});

	it("rejects on per-request timeout (never hangs)", async () => {
		vi.useFakeTimers();
		const { proc } = await started();
		const reqP = proc.request("slow/method");
		const assertion = expect(reqP).rejects.toMatchObject({ kind: "timeout" });
		await vi.advanceTimersByTimeAsync(60_001);
		await assertion;
		vi.useRealTimers();
	});

	it("rejects requests after close", async () => {
		const { proc } = await started();
		await proc.stop();
		await expect(proc.request("anything")).rejects.toBeInstanceOf(
			CodexLeadProcessError,
		);
	});
});

describe("CodexLeadProcess — robustness", () => {
	it("skips a malformed stdout line without crashing and keeps working", async () => {
		const { child, proc } = await started();
		const reqP = proc.request("thread/read");
		const id = child.lastFrame().id as number;
		child.pushStdout("this is not json {{{");
		expect(silentLogger.warn).toHaveBeenCalled();
		// A valid response after garbage still resolves.
		child.respond(id, { recovered: true });
		expect((await reqP).result).toEqual({ recovered: true });
	});

	it("buffers partial stdout chunks across newlines", async () => {
		const { child, proc } = await started();
		const reqP = proc.request("thread/read");
		const id = child.lastFrame().id as number;
		const full = JSON.stringify({ jsonrpc: "2.0", id, result: { piece: 1 } });
		child.pushStdoutRaw(full.slice(0, 10));
		child.pushStdoutRaw(`${full.slice(10)}\n`);
		expect((await reqP).result).toEqual({ piece: 1 });
	});

	it("answers an unknown server-request with method-not-found (no hang)", async () => {
		const { child } = await started();
		child.pushStdout(
			JSON.stringify({ jsonrpc: "2.0", id: 99, method: "weird/serverReq" }),
		);
		// Microtask flush for the async handler.
		await Promise.resolve();
		await Promise.resolve();
		const reply = child.lastFrame();
		expect(reply.id).toBe(99);
		expect((reply.error as { code: number }).code).toBe(
			JSONRPC_METHOD_NOT_FOUND,
		);
	});

	it("dispatches an ALLOWLISTED server-request to the handler", async () => {
		const child = new FakeChild();
		const handler = vi.fn(async () => ({ approved: false }));
		const proc = new CodexLeadProcess({
			spawnChild: () => child,
			logger: silentLogger,
			onServerRequest: handler,
			knownServerMethods: ["approval/request"],
		});
		const p = proc.start();
		child.respond(1, {});
		await p;
		child.pushStdout(
			JSON.stringify({ jsonrpc: "2.0", id: 7, method: "approval/request" }),
		);
		await Promise.resolve();
		await Promise.resolve();
		expect(handler).toHaveBeenCalledWith(
			expect.objectContaining({ id: 7, method: "approval/request" }),
		);
		const reply = child.lastFrame();
		expect(reply.id).toBe(7);
		expect(reply.result).toEqual({ approved: false });
	});

	it("returns method-not-found for an UNKNOWN method even with a handler (no hang)", async () => {
		// CR HIGH-2: an unknown method must never reach the handler — a hanging
		// handler can't strand it.
		const child = new FakeChild();
		const handler = vi.fn(() => new Promise(() => {})); // never resolves
		const proc = new CodexLeadProcess({
			spawnChild: () => child,
			logger: silentLogger,
			onServerRequest: handler,
			knownServerMethods: ["approval/request"],
		});
		const p = proc.start();
		child.respond(1, {});
		await p;
		child.pushStdout(
			JSON.stringify({ jsonrpc: "2.0", id: 8, method: "unknown/method" }),
		);
		await Promise.resolve();
		await Promise.resolve();
		expect(handler).not.toHaveBeenCalled();
		const reply = child.lastFrame();
		expect(reply.id).toBe(8);
		expect((reply.error as { code: number }).code).toBe(
			JSONRPC_METHOD_NOT_FOUND,
		);
	});

	it("skips a valid-JSON-but-non-object frame without crashing (null/array)", async () => {
		// CR MED-3.
		const { child, proc } = await started();
		const reqP = proc.request("thread/read");
		const id = child.lastFrame().id as number;
		child.pushStdout("null");
		child.pushStdout("[1,2,3]");
		expect(silentLogger.warn).toHaveBeenCalled();
		child.respond(id, { ok: 1 });
		expect((await reqP).result).toEqual({ ok: 1 });
	});

	it("cleans up pending + timer when the stdin write throws", async () => {
		// CR MED-4: a write failure must reject immediately, not strand to timeout.
		const child = new FakeChild();
		const proc = new CodexLeadProcess({
			spawnChild: () => child,
			logger: silentLogger,
		});
		const p = proc.start();
		child.respond(1, {});
		await p;
		child.writeStdin = () => {
			throw new Error("EPIPE");
		};
		await expect(proc.request("thread/read")).rejects.toBeInstanceOf(
			CodexLeadProcessError,
		);
	});

	it("rejects all pending requests when the child exits", async () => {
		const { child, proc } = await started();
		const reqP = proc.request("thread/read");
		child.exit(1, null);
		await expect(reqP).rejects.toMatchObject({ kind: "exited" });
		expect(proc.hasExited).toBe(true);
	});

	it("captures bounded stderr", async () => {
		const { child, proc } = await started();
		child.pushStderr("boom\n");
		expect(proc.stderr).toContain("boom");
	});

	it("caps stderr by BYTES even with multibyte input (CR R2 LOW)", async () => {
		const child = new FakeChild();
		const proc = new CodexLeadProcess({
			spawnChild: () => child,
			logger: silentLogger,
			maxStderrBytes: 4,
		});
		const p = proc.start();
		child.respond(1, {});
		await p;
		// "é" is 2 bytes, "😀" is 4 bytes — feed > cap of multibyte chars.
		child.pushStderr("éééé😀😀");
		expect(proc.stderrByteLength).toBeLessThanOrEqual(4);
	});
});

describe("CodexLeadProcess — thread/turn", () => {
	it("startThread extracts result.thread.id", async () => {
		const { child, proc } = await started();
		const p = proc.startThread({ cwd: "/tmp" });
		const id = child.lastFrame().id as number;
		child.respond(id, { thread: { id: "th_123" } });
		expect(await p).toBe("th_123");
	});

	it("startThreadWithResult returns id + raw result (FLY-245 Phase B policy echo)", async () => {
		const { child, proc } = await started();
		const p = proc.startThreadWithResult({ cwd: "/scratch" });
		const id = child.lastFrame().id as number;
		const result = {
			thread: { id: "th_456", cliVersion: "0.139.0" },
			cwd: "/scratch",
			runtimeWorkspaceRoots: ["/scratch"],
			approvalPolicy: "never",
			sandbox: {
				type: "workspaceWrite",
				networkAccess: false,
				writableRoots: ["/scratch"],
			},
		};
		child.respond(id, result);
		expect(await p).toEqual({ id: "th_456", result });
	});

	it("startThreadWithResult throws on a protocol error (no result leaked)", async () => {
		const { child, proc } = await started();
		const p = proc.startThreadWithResult({ cwd: "/scratch" });
		const id = child.lastFrame().id as number;
		child.respondError(id, -32603, "boom");
		await expect(p).rejects.toMatchObject({ kind: "protocol" });
	});

	it("startTurn returns the turnId for later steer", async () => {
		const { child, proc } = await started();
		const p = proc.startTurn({
			threadId: "th_1",
			input: [{ type: "text", text: "hi" }],
		});
		const id = child.lastFrame().id as number;
		child.respond(id, { turnId: "tn_9" });
		expect(await p).toBe("tn_9");
	});

	it("steerTurn throws on protocol error response", async () => {
		const { child, proc } = await started();
		const p = proc.steerTurn({
			threadId: "th_1",
			expectedTurnId: "tn_old",
			input: [{ type: "text", text: "stop" }],
		});
		const id = child.lastFrame().id as number;
		child.respondError(id, -32602, "expected turn mismatch");
		await expect(p).rejects.toMatchObject({ kind: "protocol" });
	});

	it("emits turnCompleted on a turn/completed notification", async () => {
		const { child, proc } = await started();
		const onDone = vi.fn();
		proc.on("turnCompleted", onDone);
		child.pushStdout(
			JSON.stringify({
				jsonrpc: "2.0",
				method: "turn/completed",
				params: { threadId: "th_1" },
			}),
		);
		expect(onDone).toHaveBeenCalledWith({ threadId: "th_1" });
	});

	it("emits notification for streaming deltas", async () => {
		const { child, proc } = await started();
		const onNotif = vi.fn();
		proc.on("notification", onNotif);
		child.pushStdout(
			JSON.stringify({
				jsonrpc: "2.0",
				method: "agentMessageDelta",
				params: { delta: "tok" },
			}),
		);
		expect(onNotif).toHaveBeenCalledWith("agentMessageDelta", { delta: "tok" });
	});
});

describe("CodexLeadProcess — shutdown", () => {
	it("stop() ends stdin and rejects pending", async () => {
		const { child, proc } = await started();
		const reqP = proc.request("thread/read");
		await proc.stop();
		expect(child.stdinEnded).toBe(true);
		await expect(reqP).rejects.toMatchObject({ kind: "closed" });
	});
});
