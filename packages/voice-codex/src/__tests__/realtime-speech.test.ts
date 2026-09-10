import { describe, expect, it, vi } from "vitest";
import { buildFrontendPrompt, RealtimeFrontend } from "../realtime.js";
import { chunkForSpeech, stripForSpeech } from "../speech.js";

describe("speech projection", () => {
	it("removes markdown shells while preserving words, ticket ids, and numbers", () => {
		expect(
			stripForSpeech(
				"**FLY-2446** [结果](https://example.test) `42`\n```ts\nok\n```",
			),
		).toBe("FLY-2446 结果 42\nok");
		expect(chunkForSpeech("一二三四五六七八九十", 3).join("")).toBe(
			"一二三四五六七八九十",
		);
	});
});

describe("RealtimeFrontend", () => {
	it("keeps the realtime model to a no-brain transcription and readback role", () => {
		const prompt = buildFrontendPrompt("Raya");
		expect(prompt).toContain("不是 Lead 本人");
		expect(prompt).toContain("[BACKEND]");
		expect(prompt).toContain("一个字");
		expect(prompt).toContain("不要回答");
		expect(prompt).toContain("不要调用工具");
	});

	it("pins an empty read-only thread and exact v2 realtime options", async () => {
		const notifications: Array<(method: string, params: unknown) => void> = [];
		const process = {
			start: vi.fn(async () => {}),
			startThreadWithResult: vi.fn(async () => ({
				id: "thread-a",
				result: {
					thread: {
						id: "thread-a",
						cwd: "/scratch/session-a",
						sandbox: "read-only",
						approvalPolicy: "never",
					},
				},
			})),
			request: vi.fn(async () => ({ jsonrpc: "2.0", id: 1, result: {} })),
			notify: vi.fn(),
			on: vi.fn(
				(
					event: string,
					callback: (method: string, params: unknown) => void,
				) => {
					if (event === "notification") notifications.push(callback);
				},
			),
			stop: vi.fn(async () => {}),
		};
		const transcript = vi.fn();
		const audio = vi.fn();
		const delegation = vi.fn();
		const frontend = new RealtimeFrontend({
			process,
			cwd: "/scratch/session-a",
			voice: "marin",
			displayName: "Raya",
			onTranscript: transcript,
			onAudio: audio,
			onClosed: vi.fn(),
			onFrontendDelegation: delegation,
		});
		await frontend.start();
		expect(process.startThreadWithResult).toHaveBeenCalledWith({
			cwd: "/scratch/session-a",
			sandbox: "read-only",
			approvalPolicy: "never",
			baseInstructions: expect.any(String),
			config: { sandbox_workspace_write: { network_access: false } },
		});
		expect(process.request).toHaveBeenCalledWith(
			"thread/realtime/start",
			expect.objectContaining({
				threadId: "thread-a",
				transport: { type: "websocket" },
				version: "v2",
				outputModality: "audio",
				voice: "marin",
				clientManagedHandoffs: true,
				includeStartupContext: false,
				delegationAckFiller: false,
			}),
		);
		const emit = notifications[0]!;
		emit("thread/realtime/transcript/done", {
			threadId: "thread-a",
			role: "user",
			text: "hello",
		});
		emit("thread/realtime/outputAudio/delta", {
			threadId: "thread-a",
			audio: {
				data: Buffer.from([1, 0]).toString("base64"),
				sampleRate: 24_000,
				numChannels: 1,
				samplesPerChannel: 1,
			},
		});
		emit("item/started", {
			threadId: "thread-a",
			item: { id: "handoff-1", type: "handoff_request" },
		});
		emit("item/completed", {
			threadId: "thread-a",
			item: { id: "handoff-1", type: "handoff_request" },
		});
		expect(transcript).toHaveBeenCalledWith({ role: "user", text: "hello" });
		expect(audio).toHaveBeenCalledWith(Buffer.from([1, 0]));
		expect(delegation).toHaveBeenCalledOnce();
		expect(delegation).toHaveBeenCalledWith({ itemId: "handoff-1" });
		frontend.appendAudio(Buffer.alloc(960));
		expect(process.notify).toHaveBeenCalledWith(
			"thread/realtime/appendAudio",
			expect.objectContaining({ threadId: "thread-a" }),
		);
	});

	it("rejects a thread receipt that drifts from the empty read-only sandbox", async () => {
		const process = {
			start: vi.fn(async () => {}),
			startThreadWithResult: vi.fn(async () => ({
				id: "thread-a",
				result: { thread: { cwd: "/wrong", sandbox: "workspace-write" } },
			})),
			request: vi.fn(),
			notify: vi.fn(),
			on: vi.fn(),
			stop: vi.fn(async () => {}),
		};
		const frontend = new RealtimeFrontend({
			process,
			cwd: "/scratch/session-a",
			voice: "marin",
			displayName: "Raya",
			onTranscript: vi.fn(),
			onAudio: vi.fn(),
			onClosed: vi.fn(),
			onFrontendDelegation: vi.fn(),
		});
		await expect(frontend.start()).rejects.toThrow(/thread_receipt_drift/);
		expect(process.request).not.toHaveBeenCalled();
	});

	it("accepts the app-server top-level readOnly policy echo", async () => {
		const process = {
			start: vi.fn(async () => {}),
			startThreadWithResult: vi.fn(async () => ({
				id: "thread-a",
				result: {
					thread: { id: "thread-a" },
					cwd: "/scratch/session-a",
					approvalPolicy: "never",
					sandbox: { type: "readOnly", networkAccess: false },
				},
			})),
			request: vi.fn(async () => ({ jsonrpc: "2.0", id: 1, result: {} })),
			notify: vi.fn(),
			on: vi.fn(),
			stop: vi.fn(async () => {}),
		};
		const frontend = new RealtimeFrontend({
			process,
			cwd: "/scratch/session-a",
			voice: "marin",
			displayName: "Raya",
			onTranscript: vi.fn(),
			onAudio: vi.fn(),
			onClosed: vi.fn(),
			onFrontendDelegation: vi.fn(),
		});
		await expect(frontend.start()).resolves.toBeUndefined();
		expect(process.request).toHaveBeenCalledWith(
			"thread/realtime/start",
			expect.any(Object),
		);
	});
});

describe("RealtimeFrontend cancellation", () => {
	it.each(["process", "thread"])(
		"does not advance %s startup after stop",
		async (stage) => {
			let finish!: () => void;
			const pending = new Promise<void>((resolve) => {
				finish = resolve;
			});
			const process = {
				start: vi.fn(() => (stage === "process" ? pending : Promise.resolve())),
				startThreadWithResult: vi.fn(async () => {
					if (stage === "thread") await pending;
					return {
						id: "thread",
						result: {
							cwd: "/scratch",
							sandbox: "read-only",
							approvalPolicy: "never",
						},
					};
				}),
				request: vi.fn(async () => ({ result: {} })),
				notify: vi.fn(),
				on: vi.fn(),
				stop: vi.fn(async () => {}),
			};
			const frontend = new RealtimeFrontend({
				process,
				cwd: "/scratch",
				voice: "marin",
				displayName: "Raya",
				onTranscript: vi.fn(),
				onAudio: vi.fn(),
				onClosed: vi.fn(),
				onFrontendDelegation: vi.fn(),
			});
			const starting = frontend.start();
			await Promise.resolve();
			await frontend.stop();
			finish();
			await expect(starting).rejects.toThrow("realtime_stopped");
			expect(process.request).not.toHaveBeenCalledWith(
				"thread/realtime/start",
				expect.anything(),
			);
			if (stage === "process")
				expect(process.startThreadWithResult).not.toHaveBeenCalled();
		},
	);
});

it("kills the frontend without waiting for a hung realtime stop receipt", async () => {
	const process = {
		start: vi.fn(async () => {}),
		startThreadWithResult: vi.fn(async () => ({
			id: "thread",
			result: {
				cwd: "/scratch",
				sandbox: "read-only",
				approvalPolicy: "never",
			},
		})),
		request: vi.fn(async (_method: string) => ({ result: {} })),
		notify: vi.fn(),
		on: vi.fn(),
		stop: vi.fn(async () => {}),
	};
	const frontend = new RealtimeFrontend({
		process,
		cwd: "/scratch",
		voice: "marin",
		displayName: "Raya",
		onTranscript: vi.fn(),
		onAudio: vi.fn(),
		onClosed: vi.fn(),
		onFrontendDelegation: vi.fn(),
	});
	await frontend.start();
	process.request.mockReturnValue(new Promise(() => {}));
	const stopping = frontend.stop();
	await Promise.resolve();
	expect(process.stop).toHaveBeenCalledOnce();
	await stopping;
	expect(process.request).toHaveBeenLastCalledWith("thread/realtime/stop", {
		threadId: "thread",
	});
});
