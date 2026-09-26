import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVoiceSessionContext } from "flywheel-teamlead/bridge/voice-session-context";
import {
	VOICE_CONTEXT_TOKENIZER,
	type VoiceRealtimeItem,
	voiceContextDigest,
	voiceContextHeader,
	voiceInitialItemsTokens,
} from "flywheel-teamlead/voice-context-contract";
import { getEncoding } from "js-tiktoken";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeVoiceHttpError } from "../bridge-client.js";
import {
	CODEX_VOICE_BINARY_SHA256,
	CODEX_VOICE_BINARY_VERSION,
	CodexVoiceContainer,
	type CodexVoiceContextSnapshot,
	type CodexVoiceProcess,
	type CodexVoiceProcessFactoryOptions,
} from "../codex/CodexVoiceContainer.js";
import type { RealtimeMediaLeg, WebRtcLegOptions } from "../codex/WebRtcLeg.js";

/** The harness's tokenizer unless a test asks for the real one. */
const fixtureTokens = (value: string) =>
	Math.ceil(Buffer.byteLength(value) / 4);

/** Records the leg's lifecycle; the transport's handshake drives it. */
class FakeLeg implements RealtimeMediaLeg {
	readonly answers: string[] = [];
	readonly frames: Buffer[] = [];
	closeCount = 0;

	constructor(
		readonly options: WebRtcLegOptions,
		private readonly order: string[],
	) {}

	async prepareOffer(): Promise<string> {
		return "v=0\r\no=offer";
	}

	async acceptAnswer(sdp: string): Promise<void> {
		this.answers.push(sdp);
	}

	writePcm24(frame: Buffer): boolean {
		this.frames.push(frame);
		return true;
	}

	async close(): Promise<void> {
		this.closeCount += 1;
		this.order.push("leg.close");
	}
}

const roots: string[] = [];

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "fly2799-container-"));
	roots.push(value);
	return value;
}

afterEach(() => {
	vi.useRealTimers();
	for (const value of roots.splice(0))
		rmSync(value, { recursive: true, force: true });
});

function context(
	sessionId: string,
	capturedAt = "2026-09-23T10:00:00.000Z",
	fact = "RAYA_UNIQUE_CONTEXT_FACT",
	initialItems: VoiceRealtimeItem[] = [
		{
			role: "developer",
			text: "【记忆文件 memory/MEMORY.md 第 1/1 段·只读数据】\nMEMORY_FACT",
		},
	],
	countTokens: (value: string) => number = fixtureTokens,
): CodexVoiceContextSnapshot {
	const sourceManifest = {
		version: 1,
		projectName: "raya",
		leadId: "raya",
		sourceKind: "codex-workspace",
		sourceRevision: "rev",
		files: [],
		unloadedReferences: [],
	};
	const baseBody = `${fact}\n\n# Selected Lead memory\n\nMEMORY_FACT`;
	const realtimePromptBody = `${fact}\n\n# Realtime voice protocol`;
	const leaseBindingDigest = "b".repeat(64);
	const rosterDigest = "c".repeat(64);
	const snapshotDigest = voiceContextDigest({
		baseBody,
		realtimePromptBody,
		initialItems,
		leaseBindingDigest,
		sourceManifest,
		rosterDigest,
		sessionId,
	});
	const header = voiceContextHeader(snapshotDigest, sessionId);
	const baseInstructions = `${header}\n\n${baseBody}`;
	const prompt = `${header}\n\n${realtimePromptBody}`;
	const itemBytes = initialItems.reduce(
		(total, item) => total + Buffer.byteLength(item.text),
		0,
	);
	const itemTokens = initialItems.map((item) => countTokens(item.text));
	return {
		baseInstructions,
		realtime: { prompt, initialItems },
		snapshotDigest,
		manifest: {
			...sourceManifest,
			version: 2,
			sourceVersion: 1,
			capturedAt,
			rosterDigest,
			snapshotDigest,
			leaseBindingDigest,
			tokenizer: "js-tiktoken@1.0.21/o200k_base",
		},
		measurements: {
			baseInstructions: {
				bytes: Buffer.byteLength(baseInstructions),
				estimatedTokens: 100,
			},
			realtimePrompt: {
				bytes: Buffer.byteLength(prompt),
				estimatedTokens: 110,
			},
			initialItems: {
				count: initialItems.length,
				bytes: itemBytes,
				codexEstimatedTokens: Math.ceil(itemBytes / 4),
				itemTokens,
				tokens: voiceInitialItemsTokens(itemTokens),
			},
		},
	};
}

function receipt(threadId: string, cwd: string): Record<string, unknown> {
	return {
		thread: {
			id: threadId,
			ephemeral: true,
			environments: [],
			cwd,
			cliVersion: "0.156.1",
			modelProvider: "openai",
		},
		cwd,
		runtimeWorkspaceRoots: [],
		instructionSources: [],
		approvalPolicy: "never",
		sandbox: { type: "readOnly", networkAccess: false },
		activePermissionProfile: null,
		multiAgentMode: "explicitRequestOnly",
	};
}

class FakeProcess implements CodexVoiceProcess {
	readonly notifications: Array<(method: string, params: unknown) => void> = [];
	readonly exits: Array<
		(code: number | null, signal: NodeJS.Signals | null) => void
	> = [];
	readonly requests: Array<{ method: string; params: unknown }> = [];
	threadParams?: Record<string, unknown>;
	startCount = 0;
	stopCount = 0;
	threadResult?: Record<string, unknown>;
	startThreadError?: Error;
	realtimeError?: { code: number; message: string };
	/** Per realtime/start after the first: "ok" | "error" | "silent" (no sdp). */
	startScript: Array<"ok" | "error" | "silent"> = [];
	private starts = 0;
	/** false: a stop never produces closed (the barrier cannot confirm). */
	closedOnStop = true;
	account: { result?: unknown; error?: { code: number; message: string } } = {
		result: { account: { type: "chatgpt", planType: "pro" } },
	};
	onStartThread?: () => void;
	order?: string[];

	constructor(
		readonly threadId: string,
		readonly options: CodexVoiceProcessFactoryOptions,
	) {}

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
			this.exits.push(
				callback as (
					code: number | null,
					signal: NodeJS.Signals | null,
				) => void,
			);
		}
	}

	async start(): Promise<void> {
		this.startCount++;
	}

	async startThreadWithResult(params: Record<string, unknown>) {
		this.threadParams = params;
		this.onStartThread?.();
		if (this.startThreadError) throw this.startThreadError;
		return {
			id: this.threadId,
			result: this.threadResult ?? receipt(this.threadId, this.options.cwd),
		};
	}

	async request(method: string, params?: unknown) {
		this.requests.push({ method, params });
		if (method === "account/read") return this.account;
		if (method === "thread/realtime/start") {
			this.starts += 1;
			const scripted =
				this.starts > 1 ? (this.startScript.shift() ?? "ok") : "ok";
			if (scripted === "error")
				return { error: { code: -32000, message: "scripted start failure" } };
			if (scripted === "silent") return { result: {} };
		}
		if (!this.realtimeError && method === "thread/realtime/start") {
			const threadId = (params as { threadId: string }).threadId;
			queueMicrotask(() => {
				this.emit("thread/realtime/started", {
					threadId,
					version: "v3",
					realtimeSessionId: `realtime-${threadId}`,
				});
				this.emit("thread/realtime/sdp", {
					threadId,
					sdp: `v=0\r\no=answer-${this.requests.length}`,
				});
			});
		}
		if (method === "thread/realtime/stop") {
			this.order?.push("realtime/stop");
			const threadId = (params as { threadId: string }).threadId;
			if (this.closedOnStop)
				queueMicrotask(() =>
					this.emit("thread/realtime/closed", {
						threadId,
						reason: "client_stop",
					}),
				);
		}
		return this.realtimeError ? { error: this.realtimeError } : { result: {} };
	}

	async stop(): Promise<void> {
		this.stopCount++;
		this.order?.push("process.stop");
	}

	emit(method: string, params: unknown = {}): void {
		for (const callback of this.notifications) callback(method, params);
	}
}

function harness(
	overrides: {
		now?: () => number;
		inspectBinary?: () => Promise<{
			version: string;
			sha256: string;
			realtimeFeatureEnabled: boolean;
		}>;
		processEnv?: NodeJS.ProcessEnv;
		configureProcess?: (process: FakeProcess) => void;
		authSource?: (base: string) => string;
		/** null: the container's own o200k counter. */
		countTokens?: ((value: string) => number) | null;
	} = {},
) {
	const base = realpathSync(root());
	const authSource =
		overrides.authSource?.(base) ??
		(() => {
			const path = join(base, "fleet-auth.json");
			writeFileSync(path, '{"tokens":"fixture"}', { mode: 0o600 });
			return path;
		})();
	const binaryPath = join(base, "standalone", "codex");
	mkdirSync(join(base, "standalone"), { recursive: true });
	writeFileSync(binaryPath, "fake standalone binary", { mode: 0o700 });
	const processes: FakeProcess[] = [];
	const legs: FakeLeg[] = [];
	const order: string[] = [];
	const factoryOptions: CodexVoiceProcessFactoryOptions[] = [];
	const evidence: Record<string, unknown>[] = [];
	const createProcess = (options: CodexVoiceProcessFactoryOptions) => {
		factoryOptions.push(options);
		const process = new FakeProcess(`thread-${processes.length + 1}`, options);
		process.order = order;
		processes.push(process);
		overrides.configureProcess?.(process);
		return process;
	};
	const container = new CodexVoiceContainer({
		binaryPath,
		scratchRoot: join(base, "scratch"),
		authSource,
		processEnv: overrides.processEnv ?? {
			HOME: "/real/home",
			PATH: "/usr/bin:/bin",
			LANG: "en_US.UTF-8",
			OPENAI_API_KEY: "wrong-inherited-key",
			DISCORD_BOT_TOKEN: "business-secret",
			FLYWHEEL_API_TOKEN: "business-secret",
			GH_TOKEN: "business-secret",
			NODE_OPTIONS: "--require=/unsafe.js",
		},
		now: overrides.now ?? (() => Date.parse("2026-09-23T10:00:00.000Z")),
		inspectBinary:
			overrides.inspectBinary ??
			(async () => ({
				version: CODEX_VOICE_BINARY_VERSION,
				sha256: CODEX_VOICE_BINARY_SHA256,
				realtimeFeatureEnabled: true,
			})),
		createProcess,
		reconnectTiming: {
			backoffMs: [0, 30, 60],
			attemptTimeoutMs: 150,
			closeTimeoutMs: 80,
		},
		createLeg: (options) => {
			const leg = new FakeLeg(options, order);
			legs.push(leg);
			return leg;
		},
		onEvidence: (record) => evidence.push(record),
		...(overrides.countTokens === null
			? {}
			: { countTokens: overrides.countTokens ?? fixtureTokens }),
	});
	return {
		base,
		authSource,
		binaryPath,
		container,
		processes,
		legs,
		order,
		factoryOptions,
		evidence,
	};
}

describe("Codex voice container", () => {
	it("opens every meeting in a distinct ephemeral home, workdir, process, and thread", async () => {
		const h = harness();
		const first = await h.container.open({
			sessionId: "session-a",
			voice: "marin",
			loadContext: async () => context("session-a"),
		});
		const second = await h.container.open({
			sessionId: "session-b",
			voice: "marin",
			loadContext: async () => context("session-b"),
		});

		expect(first.threadId).toBe("thread-1");
		expect(second.threadId).toBe("thread-2");
		expect(first.threadId).not.toBe(second.threadId);
		expect(first.home).not.toBe(second.home);
		expect(first.workdir).not.toBe(second.workdir);
		for (const path of [
			first.home,
			first.workdir,
			second.home,
			second.workdir,
		]) {
			expect(statSync(path).mode & 0o777).toBe(0o700);
		}

		for (const [index, options] of h.factoryOptions.entries()) {
			expect(options.codexBin).toBe(h.binaryPath);
			// FLY-2885: no API key reaches the child in any form.
			expect("voiceProfile" in options).toBe(false);
			expect(options.baseEnv.CODEX_API_KEY).toBeUndefined();
			expect(
				lstatSync(join(options.codexHome, "auth.json")).isSymbolicLink(),
			).toBe(true);
			expect(readlinkSync(join(options.codexHome, "auth.json"))).toBe(
				h.authSource,
			);
			expect(options.knownServerMethods).toEqual([]);
			expect(options.maxJsonLineBytes).toBe(1024 * 1024);
			expect(options.mcpArgv).toEqual([]);
			expect(options.baseEnv.OPENAI_API_KEY).toBeUndefined();
			expect(options.baseEnv.DISCORD_BOT_TOKEN).toBeUndefined();
			expect(options.baseEnv.FLYWHEEL_API_TOKEN).toBeUndefined();
			expect(options.baseEnv.GH_TOKEN).toBeUndefined();
			expect(options.baseEnv.NODE_OPTIONS).toBeUndefined();
			expect(options.baseEnv.HOME).toBe(options.codexHome);
			const process = h.processes[index]!;
			expect(process.threadParams).toMatchObject({
				cwd: options.cwd,
				approvalPolicy: "never",
				sandbox: "read-only",
				ephemeral: true,
				environments: [],
				config: {
					"features.shell_tool": false,
					"features.memories": false,
				},
			});
			expect(process.threadParams?.baseInstructions).toContain(
				index === 0 ? "session-a" : "session-b",
			);
			expect(
				process.requests.find(
					(request) => request.method === "thread/realtime/start",
				),
			).toMatchObject({
				method: "thread/realtime/start",
				params: {
					threadId: `thread-${index + 1}`,
					version: "v3",
					model: "gpt-live-1-codex",
					voice: "marin",
					outputModality: "audio",
					clientManagedHandoffs: true,
					includeStartupContext: false,
					transport: { type: "webrtc", sdp: "v=0\r\no=offer" },
					initialItems: [
						{
							role: "developer",
							text: "【记忆文件 memory/MEMORY.md 第 1/1 段·只读数据】\nMEMORY_FACT",
						},
					],
				},
			});
		}

		const firstRoot = first.root;
		const secondRoot = second.root;
		await first.close();
		await second.close();
		expect(h.processes.map((process) => process.stopCount)).toEqual([1, 1]);
		expect(existsSync(firstRoot)).toBe(false);
		expect(existsSync(secondRoot)).toBe(false);
		// Removing the container removes only the link.
		expect(readFileSync(h.authSource, "utf8")).toBe('{"tokens":"fixture"}');
		expect(h.processes.map((process) => process.requests[0]?.method)).toEqual([
			"account/read",
			"account/read",
		]);
	});

	it.each([
		["api-key login", { result: { account: { type: "apiKey" } } }],
		["no account", { result: { account: null } }],
		[
			"401",
			{
				error: { code: -32000, message: "unexpected status 401 Unauthorized" },
			},
		],
	] as const)(
		"refuses a %s account before opening realtime and cleans up",
		async (_name, account) => {
			const h = harness({
				configureProcess: (process) => {
					process.account = account;
				},
			});
			await expect(
				h.container.open({
					sessionId: "session-a",
					voice: "cove",
					loadContext: async () => context("session-a"),
				}),
			).rejects.toMatchObject({
				code: "voice_unavailable",
				reason: "codex_auth_rejected",
			});
			const process = h.processes[0]!;
			expect(process.threadParams).toBeUndefined();
			expect(
				process.requests.some(
					(request) => request.method === "thread/realtime/start",
				),
			).toBe(false);
			expect(process.stopCount).toBe(1);
			expect(existsSync(process.options.root)).toBe(false);
		},
	);

	it.each(["missing", "symlink", "public"] as const)(
		"refuses a %s credential source without spawning Codex",
		async (failure) => {
			const h = harness({
				authSource: (base) => {
					const real = join(base, "real-auth.json");
					writeFileSync(real, "{}", {
						mode: failure === "public" ? 0o644 : 0o600,
					});
					if (failure === "missing") return join(base, "absent-auth.json");
					if (failure === "symlink") {
						const link = join(base, "link-auth.json");
						symlinkSync(real, link);
						return link;
					}
					return real;
				},
			});
			await expect(
				h.container.open({
					sessionId: "session-a",
					voice: "cove",
					loadContext: async () => context("session-a"),
				}),
			).rejects.toMatchObject({
				code: "voice_unavailable",
				reason: "codex_profile_mismatch",
			});
			expect(h.processes).toHaveLength(0);
		},
	);

	it.each([
		["usage limit", "codex_quota_exhausted"],
		["You've hit your usage limit. Upgrade to Pro", "codex_quota_exhausted"],
		["rate limit exceeded", "codex_quota_exhausted"],
		["unexpected status 403 Forbidden", "codex_auth_rejected"],
		[
			"unexpected status 401 Unauthorized: token expired",
			"codex_auth_rejected",
		],
	] as const)(
		"classifies subscription-side start failure %s",
		async (message, reason) => {
			const h = harness({
				configureProcess: (process) => {
					process.realtimeError = { code: -32000, message };
				},
			});
			await expect(
				h.container.open({
					sessionId: "session-a",
					voice: "cove",
					loadContext: async () => context("session-a"),
				}),
			).rejects.toMatchObject({ code: "voice_unavailable", reason });
		},
	);

	it("pairs each generation with its own WebRTC leg and closes stop → leg → process → root", async () => {
		const h = harness();
		const opened = await h.container.open({
			sessionId: "session-legs",
			voice: "cove",
			loadContext: async () => context("session-legs"),
		});
		expect(h.legs).toHaveLength(1);
		expect(h.legs[0]!.answers).toEqual(["v=0\r\no=answer-2"]);
		expect(opened.leg).toBe(h.legs[0]);
		expect(h.legs[0]!.options.stunUrls).toEqual([]);
		await opened.close("test");
		expect(h.order).toEqual(["realtime/stop", "leg.close", "process.stop"]);
		expect(existsSync(opened.root)).toBe(false);
	});

	it("routes downlink and data events only from the current generation", async () => {
		const h = harness();
		const downlink = vi.fn();
		const data = vi.fn();
		const opened = await h.container.open({
			sessionId: "session-route",
			voice: "cove",
			loadContext: async () => context("session-route"),
			realtime: { onDownlink: downlink, onDataEvent: data },
		});
		const first = h.legs[0]!;
		const packet = {
			payload: Buffer.from([0xf8]),
			voiced: true,
			rms: 900,
			sequence: 1,
			receivedAtMs: 1,
		};
		first.options.onDownlink(packet);
		first.options.onDataEvent({ type: "session.started", expiresAt: null });
		expect(downlink).toHaveBeenCalledWith({ ...packet, generation: 1 });
		expect(data).toHaveBeenCalledWith({
			generation: 1,
			event: { type: "session.started", expiresAt: null },
		});
		opened.reconnect("test");
		await vi.waitFor(() => expect(opened.generation).toBe(2));
		expect(first.closeCount).toBe(1);
		first.options.onDownlink(packet);
		expect(downlink).toHaveBeenCalledTimes(1);
		h.legs[1]!.options.onDownlink(packet);
		expect(downlink).toHaveBeenLastCalledWith({ ...packet, generation: 2 });
		await opened.close();
	});

	it("delivers app-server notifications only to the current generation's transport", async () => {
		const h = harness();
		const lost = vi.fn();
		const opened = await h.container.open({
			sessionId: "session-retired",
			voice: "cove",
			loadContext: async () => context("session-retired"),
			realtime: { onGenerationLost: lost },
		});
		opened.reconnect("test");
		await vi.waitFor(() => expect(opened.generation).toBe(2));
		lost.mockClear();
		h.processes[0]!.emit("thread/realtime/closed", {
			threadId: opened.threadId,
			reason: "transport_closed",
		});
		expect(lost).toHaveBeenCalledOnce();
		expect(lost).toHaveBeenCalledWith({
			generation: 2,
			reason: "realtime_closed:transport_closed",
		});
		await vi.waitFor(() => expect(opened.generation).toBe(3));
		await opened.close();
	});

	it("merges a lost leg, a closed session and an error into one generation change", async () => {
		const h = harness();
		const lost = vi.fn();
		const ready = vi.fn();
		const closed = vi.fn();
		const opened = await h.container.open({
			sessionId: "session-merge",
			voice: "cove",
			loadContext: async () => context("session-merge"),
			realtime: {
				onGenerationLost: lost,
				onGenerationReady: ready,
				onClosed: closed,
			},
		});
		h.legs[0]!.options.onLost("downlink_silent");
		h.processes[0]!.emit("thread/realtime/error", {
			threadId: opened.threadId,
			message: "sideband gone",
		});
		h.processes[0]!.emit("thread/realtime/closed", {
			threadId: opened.threadId,
			reason: "transport_closed",
		});
		await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
		expect(lost).toHaveBeenCalledOnce();
		expect(lost).toHaveBeenCalledWith({
			generation: 1,
			reason: "webrtc_downlink_silent",
		});
		expect(ready).toHaveBeenCalledWith({ generation: 2 });
		expect(closed).not.toHaveBeenCalled();
		expect(opened.generation).toBe(2);
		expect(h.legs[0]!.closeCount).toBe(1);
		expect(
			h.processes[0]!.requests.filter(
				(request) => request.method === "thread/realtime/start",
			),
		).toHaveLength(2);
		// A late fault of the retired generation only leaves evidence.
		h.legs[0]!.options.onLost("failed");
		expect(lost).toHaveBeenCalledOnce();
		expect(h.evidence).toContainEqual(
			expect.objectContaining({
				kind: "codex_voice_fault_merged",
				generation: 1,
			}),
		);
		await opened.close();
	});

	it("ends cleanly when the old session's close cannot be confirmed", async () => {
		const h = harness({
			configureProcess: (process) => {
				process.closedOnStop = false;
			},
		});
		const closed = vi.fn();
		const opened = await h.container.open({
			sessionId: "session-unconfirmed",
			voice: "cove",
			loadContext: async () => context("session-unconfirmed"),
			realtime: { onClosed: closed },
		});
		h.legs[0]!.options.onLost("failed");
		await vi.waitFor(() =>
			expect(closed).toHaveBeenCalledWith({
				generation: 1,
				reason: "realtime_reconnect_unconfirmed",
			}),
		);
		await vi.waitFor(() => expect(existsSync(opened.root)).toBe(false));
		expect(h.processes[0]!.stopCount).toBe(1);
		expect(
			h.processes[0]!.requests.filter(
				(request) => request.method === "thread/realtime/start",
			),
		).toHaveLength(1);
	});

	it("aborts an attempt stuck waiting for the answer, closes its leg, and tries again", async () => {
		const h = harness({
			configureProcess: (process) => {
				process.startScript = ["silent", "ok"];
			},
		});
		const ready = vi.fn();
		const opened = await h.container.open({
			sessionId: "session-abort",
			voice: "cove",
			loadContext: async () => context("session-abort"),
			realtime: { onGenerationReady: ready },
		});
		opened.reconnect("test");
		await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce(), {
			timeout: 2_000,
		});
		expect(ready).toHaveBeenCalledWith({ generation: 3 });
		// The stuck attempt's leg was closed; its started session was stopped.
		expect(h.legs[1]!.closeCount).toBe(1);
		expect(h.evidence).toContainEqual(
			expect.objectContaining({
				kind: "codex_voice_reconnect_attempt_failed",
				generation: 2,
				reason: "reconnect_attempt_timeout",
			}),
		);
		await opened.close();
	});

	it("gives up after three attempts with backoff and cleans up", async () => {
		const h = harness({
			configureProcess: (process) => {
				process.startScript = ["error", "error", "error"];
			},
		});
		const closed = vi.fn();
		const opened = await h.container.open({
			sessionId: "session-exhausted",
			voice: "cove",
			loadContext: async () => context("session-exhausted"),
			realtime: { onClosed: closed },
		});
		const lostAt = Date.now();
		h.legs[0]!.options.onLost("failed");
		await vi.waitFor(
			() =>
				expect(closed).toHaveBeenCalledWith({
					generation: 1,
					reason: "realtime_reconnect_exhausted",
				}),
			{ timeout: 2_000 },
		);
		// Backoff 0 + 30 + 60 ms (test timing) elapsed between attempts.
		expect(Date.now() - lostAt).toBeGreaterThanOrEqual(85);
		expect(
			h.processes[0]!.requests.filter(
				(request) => request.method === "thread/realtime/start",
			),
		).toHaveLength(4);
		expect(h.legs.slice(1).every((leg) => leg.closeCount === 1)).toBe(true);
		await vi.waitFor(() => expect(existsSync(opened.root)).toBe(false));
	});

	it("ends the session without a reconnect when the app-server exits", async () => {
		const h = harness();
		const closed = vi.fn();
		const lost = vi.fn();
		const opened = await h.container.open({
			sessionId: "session-exit",
			voice: "cove",
			loadContext: async () => context("session-exit"),
			realtime: { onClosed: closed, onGenerationLost: lost },
		});
		for (const exit of h.processes[0]!.exits) exit(null, "SIGKILL");
		expect(closed).toHaveBeenCalledWith({
			generation: 1,
			reason: "process_exit",
		});
		expect(lost).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(existsSync(opened.root)).toBe(false));
	});

	it("drops the WebRTC leg on the QA fault hook and recovers on a new generation", async () => {
		const h = harness();
		const ready = vi.fn();
		const opened = await h.container.open({
			sessionId: "session-qa",
			voice: "cove",
			loadContext: async () => context("session-qa"),
			realtime: { onGenerationReady: ready },
		});
		opened.qaDropLeg();
		await vi.waitFor(() =>
			expect(ready).toHaveBeenCalledWith({ generation: 2 }),
		);
		expect(h.legs[0]!.closeCount).toBeGreaterThanOrEqual(1);
		await opened.close();
	});

	it("accepts a snapshot the Bridge builder produced (builder → container)", async () => {
		const h = harness();
		const memory = Array.from(
			{ length: 400 },
			(_, index) => `- 第 ${index + 1} 条记忆：只读数据。`,
		).join("\n");
		const snapshot = buildVoiceSessionContext({
			sources: {
				manifest: {
					version: 1,
					projectName: "raya",
					leadId: "raya",
					sourceKind: "codex-workspace",
					sourceRevision: "rev",
					files: [],
					unloadedReferences: [],
				},
				contents: [
					{
						kind: "identity",
						relativePath: ".lead/raya/identity.md",
						content: "IDENTITY",
					},
					{
						kind: "workspace-memory",
						relativePath: "memory/MEMORY.md",
						content: memory,
					},
				],
			},
			rosterDigest: "c".repeat(64),
			leaseBindingDigest: "d".repeat(64),
			capturedAt: "2026-09-23T10:00:00.000Z",
			openInitiatedAt: "2026-09-23T10:00:00.000Z",
			state: {
				leadId: "raya",
				activeSessions: [],
				pendingDecisions: [],
				recentFailures: [],
			} as never,
			session: { sessionId: "session-built", mode: "meeting" },
			// Shape and digest are under test here, not the tokenizer.
			countTokens: (value) => Math.ceil(Buffer.byteLength(value) / 4),
		}) as unknown as CodexVoiceContextSnapshot;
		expect(snapshot.realtime.initialItems.length).toBeGreaterThan(1);
		const opened = await h.container.open({
			sessionId: "session-built",
			voice: "cove",
			loadContext: async () => snapshot,
		});
		expect(
			h.processes[0]!.requests.find(
				(request) => request.method === "thread/realtime/start",
			)?.params,
		).toMatchObject({ initialItems: snapshot.realtime.initialItems });
		await opened.close();
	});

	it("passes the verified v2 prompt and items unchanged to every generation", async () => {
		const h = harness();
		const snapshot = context("session-v2");
		const opened = await h.container.open({
			sessionId: "session-v2",
			voice: "cove",
			loadContext: async () => snapshot,
		});
		opened.reconnect("test");
		await vi.waitFor(() => expect(opened.generation).toBe(2));
		const starts = h.processes[0]!.requests.filter(
			(request) => request.method === "thread/realtime/start",
		);
		expect(starts).toHaveLength(2);
		for (const start of starts) {
			expect(start.params).toMatchObject({
				prompt: snapshot.realtime.prompt,
				initialItems: snapshot.realtime.initialItems,
			});
		}
		expect(h.processes[0]!.threadParams?.baseInstructions).toBe(
			snapshot.baseInstructions,
		);
		await opened.close();
	});

	it.each([
		[
			"a tampered item",
			(snapshot: CodexVoiceContextSnapshot) => {
				snapshot.realtime.initialItems[0]!.text += "!";
				snapshot.measurements.initialItems.bytes += 1;
			},
		],
		[
			"a tampered prompt body",
			(snapshot: CodexVoiceContextSnapshot) => {
				snapshot.realtime.prompt += " ";
				snapshot.measurements.realtimePrompt.bytes += 1;
			},
		],
		[
			"a v1 manifest",
			(snapshot: CodexVoiceContextSnapshot) => {
				(snapshot.manifest as { version: number }).version = 1;
			},
		],
		[
			"a prompt over 15,500 tokens",
			(snapshot: CodexVoiceContextSnapshot) => {
				snapshot.measurements.realtimePrompt.estimatedTokens = 15_501;
			},
		],
		[
			"a user-role item",
			(snapshot: CodexVoiceContextSnapshot) => {
				(snapshot.realtime.initialItems[0] as { role: string }).role = "user";
			},
		],
		[
			"a measurement that does not match the items",
			(snapshot: CodexVoiceContextSnapshot) => {
				snapshot.measurements.initialItems.count = 2;
			},
		],
		[
			"a prompt header from another session",
			(snapshot: CodexVoiceContextSnapshot) => {
				snapshot.realtime.prompt = snapshot.realtime.prompt.replace(
					"sessionId=session-bad",
					"sessionId=session-other",
				);
			},
		],
	] as const)(
		"refuses %s as context_invalid before spawning Codex",
		async (_name, mutate) => {
			const h = harness();
			const snapshot = context("session-bad");
			mutate(snapshot);
			await expect(
				h.container.open({
					sessionId: "session-bad",
					voice: "cove",
					loadContext: async () => snapshot,
				}),
			).rejects.toMatchObject({ reason: "context_invalid" });
			expect(h.processes).toHaveLength(0);
		},
	);

	it.each([
		["context_too_large", "context_too_large"],
		["context_token_count_unavailable", "context_invalid"],
	] as const)(
		"maps the Bridge's %s to %s before spawning Codex (plan §12.5)",
		async (bridgeReason, containerReason) => {
			const h = harness();
			const details = {
				block: "realtime.prompt",
				estimatedTokens: 18_000,
				itemsTokens: 7_056,
				tokenizer: VOICE_CONTEXT_TOKENIZER,
			};
			await expect(
				h.container.open({
					sessionId: "session-large",
					voice: "cove",
					loadContext: async () => {
						throw new BridgeVoiceHttpError(503, "http_5xx", undefined, {
							reason: bridgeReason,
							details,
						});
					},
				}),
			).rejects.toMatchObject({ reason: containerReason });
			expect(h.processes).toHaveLength(0);
			expect(h.evidence).toContainEqual(
				expect.objectContaining({
					kind: "codex_voice_container_open_failed",
					reason: containerReason,
					contextReason: bridgeReason,
					details,
				}),
			);
		},
	);

	it("keeps any other Bridge failure a generic open failure", async () => {
		const h = harness();
		await expect(
			h.container.open({
				sessionId: "session-down",
				voice: "cove",
				loadContext: async () => {
					throw new BridgeVoiceHttpError(503, "http_5xx");
				},
			}),
		).rejects.toMatchObject({ reason: "codex_open_failed" });
		expect(h.processes).toHaveLength(0);
	});

	it.each([
		[
			"a different tokenizer",
			(snapshot: CodexVoiceContextSnapshot) => {
				(snapshot.manifest as { tokenizer: string }).tokenizer =
					"js-tiktoken@1.0.22/o200k_base";
			},
		],
		[
			"a per-item count that does not match the recount",
			(snapshot: CodexVoiceContextSnapshot) => {
				snapshot.measurements.initialItems.itemTokens[0]! += 1;
				snapshot.measurements.initialItems.tokens += 1;
			},
		],
		[
			"missing per-item counts",
			(snapshot: CodexVoiceContextSnapshot) => {
				(
					snapshot.measurements.initialItems as { itemTokens?: number[] }
				).itemTokens = undefined;
			},
		],
		[
			"a total that is not the per-item counts plus 8 each",
			(snapshot: CodexVoiceContextSnapshot) => {
				snapshot.measurements.initialItems.tokens -= 8;
			},
		],
	] as const)(
		"refuses %s as context_invalid before spawning Codex (plan §12.2)",
		async (_name, mutate) => {
			const h = harness();
			const snapshot = context("session-count");
			mutate(snapshot);
			await expect(
				h.container.open({
					sessionId: "session-count",
					voice: "cove",
					loadContext: async () => snapshot,
				}),
			).rejects.toMatchObject({ reason: "context_invalid" });
			expect(h.processes).toHaveLength(0);
		},
	);

	it("refuses consistent items that recount over 7,600 tokens", async () => {
		const h = harness();
		// 30,500 bytes: inside the byte limit, 7,625 + 8 tokens under the stub.
		const items = [{ role: "developer" as const, text: "x".repeat(30_500) }];
		await expect(
			h.container.open({
				sessionId: "session-heavy",
				voice: "cove",
				loadContext: async () =>
					context("session-heavy", undefined, undefined, items),
			}),
		).rejects.toMatchObject({ reason: "context_invalid" });
		expect(h.processes).toHaveLength(0);
	});

	it("refuses to open when the container cannot count tokens", async () => {
		const h = harness({
			countTokens: () => {
				throw new Error("rank table missing");
			},
		});
		await expect(
			h.container.open({
				sessionId: "session-nocount",
				voice: "cove",
				loadContext: async () => context("session-nocount"),
			}),
		).rejects.toMatchObject({ reason: "context_invalid" });
		expect(h.processes).toHaveLength(0);
	});

	it("recounts with the real o200k tokenizer by default", async () => {
		const encoder = getEncoding("o200k_base");
		const real = (value: string) => encoder.encode(value).length;
		const items: VoiceRealtimeItem[] = [
			{
				role: "developer",
				text: "【记忆文件 memory/MEMORY.md 第 1/1 段·只读数据】\n创始人上周定下的优先级。",
			},
		];
		const h = harness({ countTokens: null });
		const opened = await h.container.open({
			sessionId: "session-o200k",
			voice: "cove",
			loadContext: async () =>
				context("session-o200k", undefined, undefined, items, real),
		});
		await opened.close();
		// The byte-quarter stub disagrees with o200k on this item.
		expect(fixtureTokens(items[0]!.text)).not.toBe(real(items[0]!.text));
		await expect(
			harness({ countTokens: null }).container.open({
				sessionId: "session-o200k",
				voice: "cove",
				loadContext: async () =>
					context("session-o200k", undefined, undefined, items),
			}),
		).rejects.toMatchObject({ reason: "context_invalid" });
	}, 30_000);

	it("refuses more than 128 items", async () => {
		const h = harness();
		const items = Array.from({ length: 129 }, (_, index) => ({
			role: "developer" as const,
			text: `item ${index}`,
		}));
		await expect(
			h.container.open({
				sessionId: "session-many",
				voice: "cove",
				loadContext: async () =>
					context("session-many", undefined, undefined, items),
			}),
		).rejects.toMatchObject({ reason: "context_invalid" });
	});

	it.each([
		["version", "codex-cli 0.157.0", CODEX_VOICE_BINARY_SHA256, true],
		["digest", CODEX_VOICE_BINARY_VERSION, "0".repeat(64), true],
		["feature", CODEX_VOICE_BINARY_VERSION, CODEX_VOICE_BINARY_SHA256, false],
	] as const)(
		"refuses a mismatched fixed binary %s",
		async (_name, version, sha256, feature) => {
			const h = harness({
				inspectBinary: async () => ({
					version,
					sha256,
					realtimeFeatureEnabled: feature,
				}),
			});
			await expect(
				h.container.open({
					sessionId: "session-a",
					voice: "marin",
					loadContext: async () => context("session-a"),
				}),
			).rejects.toMatchObject({
				code: "voice_unavailable",
				reason: "codex_binary_mismatch",
			});
			expect(h.processes).toHaveLength(0);
		},
	);

	it("refreshes a stale snapshot once, but does not reopen when a 59-second snapshot ages during open", async () => {
		let now = Date.parse("2026-09-23T10:00:59.000Z");
		const h = harness({
			now: () => now,
			configureProcess: (process) => {
				process.onStartThread = () => {
					now += 59_000;
				};
			},
		});
		const freshLoader = vi.fn(async () => context("session-a"));
		const opened = await h.container.open({
			sessionId: "session-a",
			voice: "marin",
			loadContext: freshLoader,
		});
		expect(freshLoader).toHaveBeenCalledTimes(1);
		await opened.close();

		now = Date.parse("2026-09-23T10:02:00.001Z");
		const staleThenFresh = vi
			.fn<() => Promise<CodexVoiceContextSnapshot>>()
			.mockResolvedValueOnce(context("session-b"))
			.mockResolvedValueOnce(context("session-b", "2026-09-23T10:02:00.001Z"));
		const refreshed = await h.container.open({
			sessionId: "session-b",
			voice: "marin",
			loadContext: staleThenFresh,
		});
		expect(staleThenFresh).toHaveBeenCalledTimes(2);
		await refreshed.close();

		const alwaysStale = vi.fn(async () => context("session-c"));
		await expect(
			h.container.open({
				sessionId: "session-c",
				voice: "marin",
				loadContext: alwaysStale,
			}),
		).rejects.toMatchObject({ reason: "context_stale" });
		expect(alwaysStale).toHaveBeenCalledTimes(2);
	});

	it.each([
		[
			"cwd",
			(result: Record<string, unknown>) => ({ ...result, cwd: "/wrong" }),
		],
		[
			"writable roots",
			(result: Record<string, unknown>) => ({
				...result,
				runtimeWorkspaceRoots: ["/wrong"],
			}),
		],
		[
			"instruction source",
			(result: Record<string, unknown>) => ({
				...result,
				instructionSources: ["/host/AGENTS.md"],
			}),
		],
		[
			"sandbox",
			(result: Record<string, unknown>) => ({
				...result,
				sandbox: { type: "workspaceWrite", networkAccess: false },
			}),
		],
		[
			"ephemeral",
			(result: Record<string, unknown>) => ({
				...result,
				thread: {
					...(result.thread as Record<string, unknown>),
					ephemeral: false,
				},
			}),
		],
		[
			"cli version",
			(result: Record<string, unknown>) => ({
				...result,
				thread: {
					...(result.thread as Record<string, unknown>),
					cliVersion: "0.157.0",
				},
			}),
		],
	] as const)(
		"closes and removes the container when thread metadata mismatches: %s",
		async (_name, mutate) => {
			const h = harness({
				configureProcess: (process) => {
					process.threadResult = mutate(
						receipt(process.threadId, process.options.cwd),
					);
				},
			});
			await expect(
				h.container.open({
					sessionId: "session-a",
					voice: "marin",
					loadContext: async () => context("session-a"),
				}),
			).rejects.toMatchObject({
				code: "voice_unavailable",
				reason: "codex_profile_mismatch",
			});
			const process = h.processes[0]!;
			expect(process.stopCount).toBe(1);
			expect(existsSync(process.options.root)).toBe(false);
		},
	);

	it("passes the full context and interrupts backend execution before surfacing the handoff", async () => {
		const h = harness();
		const uniqueTail = `FULL_CONTEXT_TAIL_${"x".repeat(58_000)}`;
		const executionIntents = vi.fn();
		const opened = await h.container.open({
			sessionId: "session-a",
			voice: "marin",
			loadContext: async () => context("session-a", undefined, uniqueTail),
			realtime: { onExecutionIntent: executionIntents },
		});
		const process = h.processes[0]!;
		expect(process.threadParams?.baseInstructions).toContain(uniqueTail);
		expect(
			(
				process.requests.find(
					(request) => request.method === "thread/realtime/start",
				)?.params as { prompt: string }
			).prompt,
		).toContain(uniqueTail);

		process.emit("turn/started", {
			threadId: opened.threadId,
			turn: { id: "background-turn" },
		});
		process.emit("item/started", {
			threadId: opened.threadId,
			turnId: "background-turn",
			item: {
				id: "exec-a",
				type: "commandExecution",
				command: "gh issue view FLY-2799",
			},
		});
		await vi.waitFor(() =>
			expect(process.requests).toContainEqual({
				method: "turn/interrupt",
				params: { threadId: opened.threadId, turnId: "background-turn" },
			}),
		);
		expect(process.stopCount).toBe(0);
		await vi.waitFor(() =>
			expect(executionIntents).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: "commandExecution",
					method: "item/started",
					itemId: "exec-a",
				}),
			),
		);
		// turn/started and the execution item share one interrupt of that turn.
		expect(
			process.requests.filter((request) => request.method === "turn/interrupt"),
		).toHaveLength(1);
		expect(existsSync(opened.root)).toBe(true);
		await opened.close("test-complete");
		expect(process.stopCount).toBe(1);
		expect(existsSync(opened.root)).toBe(false);
	});

	it("reports quota exhaustion as voice unavailable and cleans up", async () => {
		const h = harness({
			configureProcess: (process) => {
				process.realtimeError = {
					code: 429,
					message: "insufficient_quota",
				};
			},
		});
		await expect(
			h.container.open({
				sessionId: "session-a",
				voice: "marin",
				loadContext: async () => context("session-a"),
			}),
		).rejects.toMatchObject({
			code: "voice_unavailable",
			reason: "codex_quota_exhausted",
		});
		expect(h.processes[0]!.stopCount).toBe(1);
		expect(existsSync(h.processes[0]!.options.root)).toBe(false);
	});

	it("keeps the original realtime start failure in error and evidence", async () => {
		const h = harness({
			configureProcess: (process) => {
				process.realtimeError = {
					code: -32602,
					message: "voice prompt was rejected",
				};
			},
		});
		const rejected = h.container.open({
			sessionId: "session-a",
			voice: "marin",
			loadContext: async () => context("session-a"),
		});

		await expect(rejected).rejects.toMatchObject({
			code: "voice_unavailable",
			reason: "codex_open_failed",
			cause: {
				name: "Error",
				message: "thread/realtime/start: voice prompt was rejected",
			},
		});
		expect(h.evidence).toContainEqual({
			kind: "codex_voice_container_open_failed",
			sessionId: "session-a",
			reason: "codex_open_failed",
			errorType: "Error",
			message: "thread/realtime/start: voice prompt was rejected",
		});
	});

	it("fences the child and removes scratch when the single 60-second open deadline expires", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const h = harness({
			configureProcess: (process) => {
				process.start = async () => new Promise<void>(() => undefined);
			},
		});
		const pending = h.container.open({
			sessionId: "session-timeout",
			voice: "marin",
			loadContext: async () => context("session-timeout"),
		});
		const rejected = expect(pending).rejects.toMatchObject({
			code: "voice_unavailable",
			reason: "codex_open_failed",
		});
		while (h.processes.length === 0) {
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		await vi.advanceTimersByTimeAsync(60_000);
		await rejected;
		expect(h.processes[0]!.stopCount).toBe(1);
		expect(existsSync(h.processes[0]!.options.root)).toBe(false);
	});
});
