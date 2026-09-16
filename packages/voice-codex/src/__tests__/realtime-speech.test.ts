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
			request: vi.fn(async (method: string) => ({
				result:
					method === "account/read" ? { account: { type: "apiKey" } } : {},
			})),
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
		const closed = vi.fn();
		const frontend = new RealtimeFrontend({
			apiKey: "test-api-key",
			process,
			cwd: "/scratch/session-a",
			voice: "marin",
			displayName: "Raya",
			onTranscript: transcript,
			onAudio: audio,
			onClosed: closed,
			onFrontendDelegation: delegation,
		});
		await frontend.start();
		expect(process.request).toHaveBeenNthCalledWith(1, "account/login/start", {
			type: "apiKey",
			apiKey: "test-api-key",
		});
		expect(process.request).toHaveBeenNthCalledWith(2, "account/read", {
			refreshToken: false,
		});
		expect(
			process.startThreadWithResult.mock.invocationCallOrder[0],
		).toBeGreaterThan(process.request.mock.invocationCallOrder[1]!);
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
		process.request.mockResolvedValue({
			error: { code: 401, message: "test-api-key private error" },
		});
		await expect(frontend.appendSpeech("hello")).rejects.toThrow(
			/^realtime_append_speech$/,
		);
		emit("thread/realtime/closed", {
			threadId: "thread-a",
			reason: "test-api-key private reason",
		});
		expect(closed).toHaveBeenCalledWith("realtime_closed");
	});

	it.each([
		"missing",
		"login-error",
		"login-throw",
		"read-error",
		"read-throw",
		"subscription",
		"no-account",
	])(
		"fails closed on API auth %s before creating any thread",
		async (failure) => {
			const process = {
				start: vi.fn(async () => {}),
				startThreadWithResult: vi.fn(),
				notify: vi.fn(),
				on: vi.fn(),
				stop: vi.fn(async () => {}),
				request: vi.fn(async (method: string) => {
					if (
						(failure === "login-throw" && method === "account/login/start") ||
						(failure === "read-throw" && method === "account/read")
					)
						throw new Error("test-api-key private upstream error");
					if (
						(failure === "login-error" && method === "account/login/start") ||
						(failure === "read-error" && method === "account/read")
					)
						return {
							error: {
								code: 401,
								message: "test-api-key private upstream error",
							},
						};
					return {
						result:
							method === "account/read"
								? {
										account:
											failure === "no-account" ? null : { type: "chatgpt" },
									}
								: {},
					};
				}),
			};
			const frontend = new RealtimeFrontend({
				process,
				apiKey: failure === "missing" ? " " : "test-api-key",
				cwd: "/scratch",
				voice: "marin",
				displayName: "Raya",
				onAudio: vi.fn(),
				onTranscript: vi.fn(),
				onClosed: vi.fn(),
				onFrontendDelegation: vi.fn(),
			});
			await expect(frontend.start()).rejects.toThrow(/^realtime_api_auth$/);
			expect(process.startThreadWithResult).not.toHaveBeenCalled();
			expect(process.request).not.toHaveBeenCalledWith(
				"thread/realtime/start",
				expect.anything(),
			);
		},
	);

	it("does not expose a server exception after API authentication", async () => {
		const process = {
			start: vi.fn(async () => {}),
			startThreadWithResult: vi.fn(async () => {
				throw new Error("test-api-key private error");
			}),
			request: vi.fn(async (method: string) => ({
				result:
					method === "account/read" ? { account: { type: "apiKey" } } : {},
			})),
			notify: vi.fn(),
			on: vi.fn(),
			stop: vi.fn(async () => {}),
		};
		const frontend = new RealtimeFrontend({
			process,
			apiKey: "test-api-key",
			cwd: "/scratch",
			voice: "marin",
			displayName: "Raya",
			onTranscript: vi.fn(),
			onAudio: vi.fn(),
			onClosed: vi.fn(),
			onFrontendDelegation: vi.fn(),
		});
		await expect(frontend.start()).rejects.toThrow(/^realtime_thread_start$/);
	});

	it("rejects a thread receipt that drifts from the empty read-only sandbox", async () => {
		const process = {
			start: vi.fn(async () => {}),
			startThreadWithResult: vi.fn(async () => ({
				id: "thread-a",
				result: { thread: { cwd: "/wrong", sandbox: "workspace-write" } },
			})),
			request: vi.fn(async (method: string) => ({
				result:
					method === "account/read" ? { account: { type: "apiKey" } } : {},
			})),
			notify: vi.fn(),
			on: vi.fn(),
			stop: vi.fn(async () => {}),
		};
		const frontend = new RealtimeFrontend({
			apiKey: "test-api-key",
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
		expect(process.request).not.toHaveBeenCalledWith(
			"thread/realtime/start",
			expect.anything(),
		);
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
			request: vi.fn(async (method: string) => ({
				result:
					method === "account/read" ? { account: { type: "apiKey" } } : {},
			})),
			notify: vi.fn(),
			on: vi.fn(),
			stop: vi.fn(async () => {}),
		};
		const frontend = new RealtimeFrontend({
			apiKey: "test-api-key",
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
	it.each(["process", "login", "read", "thread"])(
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
				request: vi.fn(async (method: string) => {
					if (
						(stage === "login" && method === "account/login/start") ||
						(stage === "read" && method === "account/read")
					)
						await pending;
					return {
						result:
							method === "account/read" ? { account: { type: "apiKey" } } : {},
					};
				}),
				notify: vi.fn(),
				on: vi.fn(),
				stop: vi.fn(async () => {}),
			};
			const frontend = new RealtimeFrontend({
				apiKey: "test-api-key",
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
			await vi.waitFor(() => {
				if (stage === "process") expect(process.start).toHaveBeenCalled();
				else if (stage === "thread")
					expect(process.startThreadWithResult).toHaveBeenCalled();
				else
					expect(process.request).toHaveBeenCalledWith(
						stage === "login" ? "account/login/start" : "account/read",
						expect.anything(),
					);
			});
			await frontend.stop();
			finish();
			await expect(starting).rejects.toThrow("realtime_stopped");
			expect(process.request).not.toHaveBeenCalledWith(
				"thread/realtime/start",
				expect.anything(),
			);
			if (stage !== "thread")
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
		request: vi.fn(async (method: string) => ({
			result: method === "account/read" ? { account: { type: "apiKey" } } : {},
		})),
		notify: vi.fn(),
		on: vi.fn(),
		stop: vi.fn(async () => {}),
	};
	const frontend = new RealtimeFrontend({
		apiKey: "test-api-key",
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
