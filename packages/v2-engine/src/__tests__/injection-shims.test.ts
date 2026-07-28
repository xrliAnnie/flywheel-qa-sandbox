import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeInjectionShim, CodexInjectionShim } from "../index.js";

const MESSAGE = {
	messageUid: "message-1",
	attemptUid: "message-1#2",
	payload: '{"task":"repair"}',
} as const;
const ENVELOPE = JSON.stringify({
	v: 1,
	kind: "flywheel-injection",
	messageUid: MESSAGE.messageUid,
	attemptUid: MESSAGE.attemptUid,
	payload: MESSAGE.payload,
});

type RpcMode = "success" | "busy" | "timeout";

class FakeDaemonTransport {
	readonly frames: unknown[] = [];
	closeCalls = 0;
	private messageHandler: (frame: unknown) => void = () => {};
	private closeHandler: (reason: string) => void = () => {};

	constructor(
		private readonly mode: RpcMode,
		private readonly onTransportClosed: () => void,
	) {}

	send(frame: unknown): void {
		this.frames.push(frame);
		const request = frame as { id?: number; method?: string };
		if (typeof request.id !== "number") return;
		if (request.method === "turn/start" && this.mode === "timeout") return;
		queueMicrotask(() => {
			if (request.method === "turn/start" && this.mode === "busy") {
				this.messageHandler({
					jsonrpc: "2.0",
					id: request.id,
					error: { code: -32000, message: "thread already active" },
				});
				return;
			}
			this.messageHandler({ jsonrpc: "2.0", id: request.id, result: {} });
		});
	}

	onMessage(handler: (frame: unknown) => void): void {
		this.messageHandler = handler;
	}

	onClose(handler: (reason: string) => void): void {
		this.closeHandler = handler;
	}

	close(): void {
		this.closeCalls++;
		this.onTransportClosed();
		this.closeHandler("fake closed");
	}
}

describe("vendor InjectionShim implementations", () => {
	const tempRoots: string[] = [];

	afterEach(() => {
		for (const root of tempRoots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("exposes only hint/deliver on both concrete adapter prototypes", () => {
		expect(
			Object.getOwnPropertyNames(ClaudeInjectionShim.prototype).sort(),
		).toEqual(["constructor", "deliver", "hint"]);
		expect(
			Object.getOwnPropertyNames(CodexInjectionShim.prototype).sort(),
		).toEqual(["constructor", "deliver", "hint"]);
	});

	it("writes a stock-compatible Claude mailbox entry and dedupes a repeated messageUid", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1501-claude-shim-"));
		tempRoots.push(root);
		const inboxPath = join(root, "inboxes", "runner-a.json");
		const sidecarPath = join(root, "sidecars", "runner-a.jsonl");
		const sessionRef = JSON.stringify({
			v: 1,
			backend: "claude",
			inboxPath,
			sidecarPath,
			toAgent: "runner-a",
		});
		const shim = new ClaudeInjectionShim();

		await shim.hint(sessionRef);
		await shim.deliver(sessionRef, MESSAGE);
		await shim.deliver(sessionRef, MESSAGE);

		const rows = JSON.parse(readFileSync(inboxPath, "utf8")) as Array<{
			from: string;
			text: string;
			read: boolean;
		}>;
		expect(rows).toEqual([
			expect.objectContaining({
				from: "flywheel-v2",
				text: ENVELOPE,
				read: false,
			}),
		]);
		expect(readFileSync(sidecarPath, "utf8")).toContain(
			`"flywheelId":"${MESSAGE.messageUid}"`,
		);
	});

	it("resolves when Codex persistently accepts turn/start without waiting for task completion", async () => {
		const transports: FakeDaemonTransport[] = [];
		let active = 0;
		const connect = vi.fn(async () => {
			active++;
			const transport = new FakeDaemonTransport("success", () => active--);
			transports.push(transport);
			return transport;
		});
		const shim = new CodexInjectionShim({
			connect,
			connectTimeoutMs: 123,
			rpcTimeoutMs: 456,
		});
		const sessionRef = JSON.stringify({
			v: 1,
			backend: "codex",
			socketPath: "/tmp/flywheel-codex.sock",
			threadId: "thread-1",
		});

		await shim.hint(sessionRef);
		await shim.deliver(sessionRef, MESSAGE);
		await shim.deliver(sessionRef, MESSAGE);

		expect(connect).toHaveBeenCalledTimes(2);
		expect(connect).toHaveBeenNthCalledWith(1, {
			socketPath: "/tmp/flywheel-codex.sock",
			connectTimeoutMs: 123,
		});
		expect(active).toBe(0);
		for (const transport of transports) {
			expect(transport.closeCalls).toBe(1);
			expect(transport.frames).toContainEqual({
				jsonrpc: "2.0",
				id: 2,
				method: "turn/start",
				params: {
					threadId: "thread-1",
					input: [{ type: "text", text: ENVELOPE }],
				},
			});
			expect(
				transport.frames.some(
					(frame) => (frame as { method?: string }).method === "turn/steer",
				),
			).toBe(false);
		}
	});

	it.each([
		{ mode: "busy" as const, pattern: /already active|rpc/i },
		{ mode: "timeout" as const, pattern: /timed out/i },
	])(
		"rejects a Codex $mode result as retryable and closes the connection",
		async ({ mode, pattern }) => {
			let active = 0;
			let transport: FakeDaemonTransport | undefined;
			const shim = new CodexInjectionShim({
				connect: async () => {
					active++;
					transport = new FakeDaemonTransport(mode, () => active--);
					return transport;
				},
				rpcTimeoutMs: 10,
			});
			const sessionRef = JSON.stringify({
				v: 1,
				backend: "codex",
				socketPath: "/tmp/flywheel-codex.sock",
				threadId: "thread-1",
			});

			await expect(shim.deliver(sessionRef, MESSAGE)).rejects.toThrow(pattern);
			expect(active).toBe(0);
			expect(transport?.closeCalls).toBe(1);
		},
	);

	it.each([
		["not-json", "claude"],
		[
			JSON.stringify({
				v: 1,
				backend: "claude",
				inboxPath: "relative",
				sidecarPath: "/tmp/sidecar",
				toAgent: "runner-a",
			}),
			"claude",
		],
		[
			JSON.stringify({
				v: 1,
				backend: "claude",
				inboxPath: "/tmp/inbox",
				sidecarPath: "/tmp/sidecar",
				toAgent: "runner-a",
				extra: true,
			}),
			"claude",
		],
		[
			JSON.stringify({
				v: 2,
				backend: "codex",
				socketPath: "/tmp/flywheel-codex.sock",
				threadId: "thread-1",
			}),
			"codex",
		],
		[
			JSON.stringify({
				v: 1,
				backend: "codex",
				socketPath: "/tmp/flywheel-codex.sock",
				threadId: "",
			}),
			"codex",
		],
	] as const)(
		"rejects malformed or non-exact %s session references",
		async (sessionRef, backend) => {
			const shim =
				backend === "claude"
					? new ClaudeInjectionShim()
					: new CodexInjectionShim({
							connect: async () => {
								throw new Error("must not connect");
							},
						});
			await expect(shim.hint(sessionRef)).rejects.toThrow(/sessionRef/i);
			await expect(shim.deliver(sessionRef, MESSAGE)).rejects.toThrow(
				/sessionRef/i,
			);
		},
	);
});
