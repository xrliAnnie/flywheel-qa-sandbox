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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CODEX_VOICE_BINARY_SHA256,
	CODEX_VOICE_BINARY_VERSION,
	CodexVoiceContainer,
	type CodexVoiceContextSnapshot,
	type CodexVoiceProcess,
	type CodexVoiceProcessFactoryOptions,
} from "../codex/CodexVoiceContainer.js";

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
): CodexVoiceContextSnapshot {
	const snapshotDigest = "a".repeat(64);
	const header = `[voice-context version=1 snapshotDigest=${snapshotDigest} sessionId=${sessionId}]`;
	const baseInstructions = `${header}\n\n${fact}`;
	const realtimePrompt = `${baseInstructions}\n\n# Realtime voice protocol`;
	return {
		baseInstructions,
		realtimePrompt,
		snapshotDigest,
		manifest: {
			version: 1,
			capturedAt,
			snapshotDigest,
			leaseBindingDigest: "b".repeat(64),
		},
		measurements: {
			baseInstructions: {
				bytes: Buffer.byteLength(baseInstructions),
				estimatedTokens: 100,
			},
			realtimePrompt: {
				bytes: Buffer.byteLength(realtimePrompt),
				estimatedTokens: 110,
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
	account: { result?: unknown; error?: { code: number; message: string } } = {
		result: { account: { type: "chatgpt", planType: "pro" } },
	};
	onStartThread?: () => void;

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
		if (!this.realtimeError && method === "thread/realtime/start") {
			const threadId = (params as { threadId: string }).threadId;
			queueMicrotask(() =>
				this.emit("thread/realtime/started", {
					threadId,
					version: "v2",
					realtimeSessionId: `realtime-${threadId}`,
				}),
			);
		}
		if (method === "thread/realtime/stop") {
			const threadId = (params as { threadId: string }).threadId;
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
	const factoryOptions: CodexVoiceProcessFactoryOptions[] = [];
	const evidence: Record<string, unknown>[] = [];
	const createProcess = (options: CodexVoiceProcessFactoryOptions) => {
		factoryOptions.push(options);
		const process = new FakeProcess(`thread-${processes.length + 1}`, options);
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
		onEvidence: (record) => evidence.push(record),
	});
	return {
		base,
		authSource,
		binaryPath,
		container,
		processes,
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
					version: "v2",
					model: "gpt-realtime-2.1",
					voice: "marin",
					outputModality: "audio",
					clientManagedHandoffs: true,
					includeStartupContext: false,
					transport: { type: "websocket" },
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

	it("restarts only the realtime connection and advances its generation after a confirmed close", async () => {
		const h = harness();
		const opened = await h.container.open({
			sessionId: "session-restart",
			voice: "marin",
			loadContext: async () => context("session-restart"),
		});
		const firstTransport = opened.transport;

		expect(opened.generation).toBe(1);
		await expect(opened.restart()).resolves.toBe(2);
		expect(opened.generation).toBe(2);
		expect(opened.transport).not.toBe(firstTransport);
		expect(h.processes[0]?.requests.map(({ method }) => method)).toEqual([
			"account/read",
			"thread/realtime/start",
			"thread/realtime/stop",
			"thread/realtime/start",
		]);
		expect(h.processes[0]?.stopCount).toBe(0);
		expect(h.evidence).toContainEqual(
			expect.objectContaining({
				kind: "codex_voice_realtime_restarted",
				generation: 2,
			}),
		);

		await opened.close();
		expect(h.processes[0]?.stopCount).toBe(1);
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
