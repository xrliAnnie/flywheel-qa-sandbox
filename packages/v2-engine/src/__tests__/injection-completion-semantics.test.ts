/**
 * FLY-1501 QA — C5 completion semantics, pinned by observable behaviour.
 *
 * Contract carried over from the FLY-1499 review (mapping §3.1 item 3):
 * `deliver` must settle on the daemon's acceptance of the injected input, never
 * on the vendor finishing the task. Reading the implementation is not enough —
 * these cases make the distinction visible: the daemon replies to `turn/start`
 * and then either stays busy forever or reports the task failed, and neither
 * outcome may change the already-settled delivery.
 *
 * Scope of the evidence, stated exactly: with a fake transport this pins that
 * (a) the full envelope was sent as the `turn/start` input, (b) `deliver`
 * settles on the `turn/start` **success reply** and on nothing later, and
 * (c) a refusal remains distinguishable from an acceptance. It does NOT show
 * that the input reached the daemon's persistent thread record — that needs a
 * persistence observable on the real daemon side, which no shim-level test has.
 */
import { describe, expect, it } from "vitest";
import { CodexInjectionShim } from "../index.js";

const MESSAGE = {
	messageUid: "message-1",
	attemptUid: "message-1#1",
	payload: '{"task":"long-running"}',
} as const;

const ENVELOPE = JSON.stringify({
	v: 1,
	kind: "flywheel-injection",
	messageUid: MESSAGE.messageUid,
	attemptUid: MESSAGE.attemptUid,
	payload: MESSAGE.payload,
});

const SESSION_REF = JSON.stringify({
	v: 1,
	backend: "codex",
	socketPath: "/tmp/flywheel-codex.sock",
	threadId: "thread-1",
});

/**
 * Accepts `turn/start` and then behaves like a real daemon that keeps working:
 * it emits post-acceptance task traffic the shim must ignore entirely.
 */
class AcceptThenKeepWorkingTransport {
	closeCalls = 0;
	postAcceptanceFrames = 0;
	readonly sent: unknown[] = [];
	private onFrame: (frame: unknown) => void = () => {};

	constructor(
		private readonly afterAccept: "silence" | "task_failed" | "task_completed",
	) {}

	send(frame: unknown): void {
		this.sent.push(frame);
		const request = frame as { id?: number; method?: string };
		if (typeof request.id !== "number") return;
		queueMicrotask(() => {
			this.onFrame({
				jsonrpc: "2.0",
				id: request.id,
				result:
					request.method === "thread/read" ? { thread: { turns: [] } } : {},
			});
			if (request.method !== "turn/start") return;
			// Whatever the vendor does next is a later lifecycle, not this delivery.
			if (this.afterAccept === "silence") return;
			queueMicrotask(() => {
				this.postAcceptanceFrames++;
				this.onFrame({
					jsonrpc: "2.0",
					method:
						this.afterAccept === "task_failed"
							? "turn/failed"
							: "turn/completed",
					params: { threadId: "thread-1", error: "model refused" },
				});
			});
		});
	}

	onMessage(handler: (frame: unknown) => void): void {
		this.onFrame = handler;
	}
	onClose(): void {}
	close(): void {
		this.closeCalls++;
	}
}

describe("Codex deliver settles on vendor acceptance, not task completion", () => {
	it("resolves while the vendor turn is still running and no completion ever arrives", async () => {
		const transport = new AcceptThenKeepWorkingTransport("silence");
		const shim = new CodexInjectionShim({
			connect: async () => transport,
			rpcTimeoutMs: 30_000,
		});

		await expect(shim.deliver(SESSION_REF, MESSAGE)).resolves.toBeUndefined();

		// The input really did reach the vendor as a turn input — otherwise
		// "accepted" would be an assumption rather than an observation.
		expect(transport.sent).toContainEqual({
			jsonrpc: "2.0",
			id: 3,
			method: "turn/start",
			params: {
				threadId: "thread-1",
				input: [{ type: "text", text: ENVELOPE }],
				clientUserMessageId: `${MESSAGE.messageUid}:${MESSAGE.attemptUid}`,
			},
		});
		// The daemon never reported the task done, yet delivery already settled —
		// that is the whole distinction between acceptance and completion.
		expect(transport.postAcceptanceFrames).toBe(0);
		expect(transport.closeCalls).toBe(1);
	});

	it.each(["task_failed", "task_completed"] as const)(
		"is not rolled back or re-decided by a later %s notification",
		async (afterAccept) => {
			const transport = new AcceptThenKeepWorkingTransport(afterAccept);
			const shim = new CodexInjectionShim({
				connect: async () => transport,
				rpcTimeoutMs: 30_000,
			});

			const settled = await shim
				.deliver(SESSION_REF, MESSAGE)
				.then(() => "resolved" as const)
				.catch(() => "rejected" as const);
			expect(settled).toBe("resolved");

			// Let any post-acceptance vendor traffic land after the shim is gone.
			await new Promise((resolve) => setTimeout(resolve, 20));

			// The full envelope was the turn input in this case too.
			expect(transport.sent).toContainEqual({
				jsonrpc: "2.0",
				id: 3,
				method: "turn/start",
				params: {
					threadId: "thread-1",
					input: [{ type: "text", text: ENVELOPE }],
					clientUserMessageId: `${MESSAGE.messageUid}:${MESSAGE.attemptUid}`,
				},
			});
			// Non-vacuous: the notification really was emitted. Delivery still
			// stands, and the temporary connection was not reopened to observe it.
			expect(transport.postAcceptanceFrames).toBe(1);
			expect(settled).toBe("resolved");
			expect(transport.closeCalls).toBe(1);
		},
	);

	it("keeps rejecting only when the daemon refuses to accept the input", async () => {
		// The mirror case: refusal (busy/race) is retryable, so it must reject —
		// otherwise acceptance and refusal would be indistinguishable to the engine.
		let closeCalls = 0;
		const sent: unknown[] = [];
		const shim = new CodexInjectionShim({
			connect: async () => ({
				send(frame: unknown) {
					sent.push(frame);
					const request = frame as { id?: number; method?: string };
					if (typeof request.id !== "number") return;
					queueMicrotask(() => {
						this.onFrameHandler?.(
							request.method === "turn/start"
								? {
										jsonrpc: "2.0",
										id: request.id,
										error: { code: -32000, message: "thread already active" },
									}
								: {
										jsonrpc: "2.0",
										id: request.id,
										result:
											request.method === "thread/read"
												? { thread: { turns: [] } }
												: {},
									},
						);
					});
				},
				onFrameHandler: undefined as ((frame: unknown) => void) | undefined,
				onMessage(handler: (frame: unknown) => void) {
					this.onFrameHandler = handler;
				},
				onClose() {},
				close() {
					closeCalls++;
				},
			}),
			rpcTimeoutMs: 5000,
		});

		await expect(shim.deliver(SESSION_REF, MESSAGE)).rejects.toThrow(
			/already active|rpc/i,
		);
		expect(closeCalls).toBe(1);
		// The envelope was still offered in full — the refusal came from the
		// daemon, not from the shim declining to send.
		expect(sent).toContainEqual({
			jsonrpc: "2.0",
			id: 3,
			method: "turn/start",
			params: {
				threadId: "thread-1",
				input: [{ type: "text", text: ENVELOPE }],
				clientUserMessageId: `${MESSAGE.messageUid}:${MESSAGE.attemptUid}`,
			},
		});
	});
});
