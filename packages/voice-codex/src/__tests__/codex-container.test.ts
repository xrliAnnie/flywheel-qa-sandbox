import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
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
	onStartThread?: () => void;
	requestHook?: (
		method: string,
		params: unknown,
	) =>
		| Promise<{
				result?: unknown;
				error?: { code: number; message: string };
		  }>
		| undefined;

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
			result: this.threadResult ?? {
				...receipt(this.threadId, this.options.cwd),
				...(this.options.profile === "voice-capability"
					? {
							activePermissionProfile: {
								id: "flywheel-lead-v2",
								extends: ":workspace",
							},
						}
					: {}),
			},
		};
	}

	async request(method: string, params?: unknown) {
		this.requests.push({ method, params });
		const hooked = this.requestHook?.(method, params);
		if (hooked) return hooked;
		if (method === "account/read")
			return { result: { account: { type: "chatgpt" } } };
		if (method === "config/read")
			return {
				result: {
					config: {
						web_search: "disabled",
						features: Object.fromEntries(
							[
								"shell_tool",
								"unified_exec",
								"view_image",
								"image_generation",
								"code_mode_host",
								"standalone_web_search",
								"memories",
								"apps",
								"plugins",
								"browser_use",
								"computer_use",
								"multi_agent",
								"hooks",
							].map((key) => [key, false]),
						),
						mcp_servers: this.options.profile
							? {
									flywheel_lead_capabilities: {
										enabled_tools: ["lead_operation"],
									},
								}
							: {},
					},
				},
			};
		if (method === "skills/list") return { result: { data: [] } };
		if (method === "mcpServerStatus/list")
			return {
				result: {
					data: this.options.profile
						? [
								{
									name: "flywheel_lead_capabilities",
									tools: { lead_operation: { name: "lead_operation" } },
								},
							]
						: [],
					nextCursor: null,
				},
			};
		if (method === "turn/start") {
			queueMicrotask(() => {
				this.emit("item/agentMessage/delta", {
					threadId: this.threadId,
					turnId: "scribe-probe",
					delta: JSON.stringify({ spoken: "准备好了。", threadText: null }),
				});
				this.emit("turn/completed", {
					threadId: this.threadId,
					turn: { id: "scribe-probe", status: "completed" },
				});
			});
			return { result: { turn: { id: "scribe-probe" } } };
		}
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
	} = {},
) {
	const base = root();
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
	const parent = {
		cwd: base,
		capabilityModelEnv: {},
		authSourcePath: join(base, "auth.json"),
		baseInstructions: "TRUSTED_CAPABILITY_RULES",
		mcp: {
			argv: ["-c", "capability=true"],
			included: ["flywheel_lead_capabilities"],
			configHash: "config",
			warnings: [],
		},
		permissionArgv: ["-c", 'default_permissions="flywheel-lead-v2"'],
		beginTurn: vi.fn(),
		actionLedger: vi.fn(() => []),
		endTurn: vi.fn(),
		close: vi.fn(async () => undefined),
		assertCurrent: vi.fn(async () => undefined),
		verifyEffectiveConfig: vi.fn(async () => undefined),
		verifyEffectiveSkills: vi.fn(async () => undefined),
	};
	writeFileSync(parent.authSourcePath, "{}", { mode: 0o600 });
	const createCapabilityParent = vi.fn(async (input: { codexHome: string }) => {
		const config =
			'# Flywheel managed capability bundle v2\ndefault_permissions = "flywheel-lead-v2"\n';
		writeFileSync(join(input.codexHome, "config.toml"), config, {
			mode: 0o600,
		});
		writeFileSync(
			join(input.codexHome, ".flywheel-capability-config.sha256"),
			`${createHash("sha256").update(config).digest("hex")}\n`,
			{ mode: 0o600 },
		);
		symlinkSync(parent.authSourcePath, join(input.codexHome, "auth.json"));
		return parent;
	});
	const container = new CodexVoiceContainer({
		capability: {
			projectName: "flywheel",
			leadId: "lead",
			leaseFence: "fence",
			browserMode: "off",
			projectsPath: join(base, "projects.json"),
			stateDir: base,
			assertLeaseCurrent() {},
		},
		createCapabilityParent: createCapabilityParent as never,
		binaryPath,
		scratchRoot: join(base, "scratch"),
		openAiApiKey: "voice-api-key",
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
		binaryPath,
		container,
		processes,
		factoryOptions,
		evidence,
		parent,
		createCapabilityParent,
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
			expect(options.voiceProfile).toEqual({
				openAiApiKey: "voice-api-key",
			});
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
			expect(process.requests[0]).toMatchObject({
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
	});

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

	it("reloads fresh background context once per natural realtime generation", async () => {
		const h = harness();
		const loadContext = vi.fn(async (generation?: number) =>
			context(
				"session-refresh",
				undefined,
				`BACKGROUND_GENERATION_${generation ?? 1}`,
			),
		);
		const opened = await h.container.open({
			sessionId: "session-refresh",
			voice: "marin",
			loadContext,
		});
		await Promise.all([opened.restart(), opened.restart()]);
		expect(loadContext.mock.calls).toEqual([[undefined], [2]]);
		const prompts = h.processes[0]!.requests.filter(
			(row) => row.method === "thread/realtime/start",
		).map((row) => (row.params as { prompt: string }).prompt);
		expect(prompts[0]).toContain("BACKGROUND_GENERATION_1");
		expect(prompts[1]).toContain("BACKGROUND_GENERATION_2");
		expect(prompts[1]).not.toContain("BACKGROUND_GENERATION_1");
		await opened.close();
	});

	it("uses durable context generation after process recreation and never reuses failed start generations", async () => {
		const h = harness();
		const loadContext = vi.fn(async (generation?: number) => ({
			...context("session-durable"),
			contextGeneration: generation ?? 8,
		}));
		const opened = await h.container.open({
			sessionId: "session-durable",
			voice: "marin",
			loadContext,
		});
		expect(opened.generation).toBe(8);
		h.processes[0]!.requestHook = (method) =>
			method === "thread/realtime/start"
				? Promise.resolve({
						error: { code: 503, message: "temporary_failure" },
					})
				: undefined;
		await expect(opened.restart()).rejects.toThrow();
		expect(opened.generation).toBe(9);
		h.processes[0]!.requestHook = undefined;
		await expect(opened.restart()).resolves.toBe(10);
		expect(loadContext.mock.calls).toEqual([[undefined], [9], [10]]);
		await opened.close();
	});

	it("admits separate bounded realtime brief and background detail in enabled mode", async () => {
		const h = harness();
		const snapshot = context(
			"session-split",
			undefined,
			"FULL_BACKGROUND_DETAIL",
		);
		snapshot.realtimePrompt = `${snapshot.baseInstructions.split("\n")[0]}\n\nSHORT_FRONTEND_BRIEF`;
		snapshot.measurements.realtimePrompt = {
			bytes: Buffer.byteLength(snapshot.realtimePrompt),
			estimatedTokens: 90,
		};
		const opened = await h.container.open({
			sessionId: "session-split",
			voice: "marin",
			loadContext: async () => snapshot,
			background: {
				enabled: true,
				onTurnStarted: vi.fn(),
				onTurnTerminal: vi.fn(),
			},
		});
		expect(h.processes[0]!.threadParams?.developerInstructions).toContain(
			"FULL_BACKGROUND_DETAIL",
		);
		const start = h.processes[0]!.requests.find(
			(row) => row.method === "thread/realtime/start",
		)!;
		expect((start.params as { prompt: string }).prompt).toContain(
			"SHORT_FRONTEND_BRIEF",
		);
		expect((start.params as { prompt: string }).prompt).not.toContain(
			"FULL_BACKGROUND_DETAIL",
		);
		await opened.close();
	});

	it("opens subscription capability and isolated scribe children and binds each background turn", async () => {
		const h = harness();
		const opened = await h.container.open({
			sessionId: "session-capability",
			voice: "marin",
			loadContext: async () => context("session-capability"),
			background: {
				enabled: true,
				onTurnStarted: vi.fn(),
				onTurnTerminal: vi.fn(),
			},
		});
		expect(h.createCapabilityParent).toHaveBeenCalledTimes(1);
		expect(h.processes).toHaveLength(2);
		expect(h.factoryOptions[0]).toMatchObject({
			profile: "voice-capability",
			capabilityModelEnv: h.parent.capabilityModelEnv,
			cwd: h.parent.cwd,
		});
		expect(h.processes[0]!.threadParams).toMatchObject({
			permissions: "flywheel-lead-v2",
		});
		expect(h.processes[0]!.threadParams?.baseInstructions).toContain(
			"TRUSTED_CAPABILITY_RULES",
		);
		expect(h.parent.verifyEffectiveConfig).toHaveBeenCalled();
		expect(h.parent.verifyEffectiveSkills).toHaveBeenCalled();
		const scribe = h.factoryOptions[1]!;
		expect(scribe.voiceProfile).toBeUndefined();
		expect(scribe.mcpArgv).toEqual([]);
		expect(scribe.baseEnv.OPENAI_API_KEY).toBeUndefined();
		expect(scribe.baseEnv.GH_TOKEN).toBeUndefined();
		expect(scribe.codexHome).not.toBe(opened.home);
		h.processes[0]!.emit("turn/started", {
			threadId: opened.threadId,
			turn: { id: "turn-1", status: "inProgress" },
		});
		expect(h.parent.beginTurn).toHaveBeenCalledWith(opened.threadId, "turn-1");
		h.processes[0]!.emit("item/completed", {
			threadId: opened.threadId,
			turnId: "turn-1",
			item: { id: "answer", type: "agentMessage", text: "【口语】准备好了。" },
		});
		h.processes[0]!.emit("turn/completed", {
			threadId: opened.threadId,
			turn: { id: "turn-1", status: "completed" },
		});
		expect(h.parent.endTurn).toHaveBeenCalledWith("turn-1", "completed");
		await opened.close();
		expect(h.processes.map((p) => p.stopCount)).toEqual([1, 1]);
		expect(h.parent.close).toHaveBeenCalledTimes(1);
	});

	it.each([
		"background_api_account",
		"scribe_api_account",
		"extra_tool",
		"missing_tool",
		"extra_server",
		"scribe_tool",
		"permission_profile",
		"scribe_probe_failed",
	] as const)(
		"rejects enabled admission drift %s and closes parent and both acquired children",
		async (drift) => {
			const h = harness({
				configureProcess: (process) => {
					const capability = process.options.profile === "voice-capability";
					if (drift === "permission_profile" && capability)
						process.threadResult = receipt(
							process.threadId,
							process.options.cwd,
						);
					process.requestHook = (method) => {
						if (
							method === "account/read" &&
							((drift === "background_api_account" && capability) ||
								(drift === "scribe_api_account" && !capability))
						)
							return Promise.resolve({
								result: { account: { type: "apiKey" } },
							});
						if (
							method === "mcpServerStatus/list" &&
							capability &&
							["extra_tool", "missing_tool", "extra_server"].includes(drift)
						)
							return Promise.resolve({
								result: {
									data: [
										{
											name: "flywheel_lead_capabilities",
											tools:
												drift === "extra_tool"
													? { lead_operation: {}, raw_write: {} }
													: drift === "missing_tool"
														? {}
														: { lead_operation: {} },
										},
										...(drift === "extra_server"
											? [{ name: "rogue", tools: { write: {} } }]
											: []),
									],
									nextCursor: null,
								},
							});
						if (
							method === "mcpServerStatus/list" &&
							!capability &&
							drift === "scribe_tool"
						)
							return Promise.resolve({
								result: {
									data: [{ name: "rogue", tools: { write: {} } }],
									nextCursor: null,
								},
							});
						if (
							method === "turn/start" &&
							!capability &&
							drift === "scribe_probe_failed"
						)
							return Promise.resolve({
								error: { code: 429, message: "quota" },
							});
						return undefined;
					};
				},
			});
			await expect(
				h.container.open({
					sessionId: "session-drift",
					voice: "marin",
					loadContext: async () => context("session-drift"),
					background: {
						enabled: true,
						onTurnStarted: vi.fn(),
						onTurnTerminal: vi.fn(),
					},
				}),
			).rejects.toMatchObject({ code: "voice_unavailable" });
			expect(h.parent.close).toHaveBeenCalledTimes(1);
			expect(h.processes.every((process) => process.stopCount === 1)).toBe(
				true,
			);
			expect(
				h.processes.some((process) =>
					process.requests.some(
						(row) => row.method === "thread/realtime/start",
					),
				),
			).toBe(false);
			for (const process of h.processes)
				expect(existsSync(process.options.root)).toBe(false);
		},
	);

	it("revokes the capability parent and stops the scribe even if the background child cannot stop", async () => {
		const h = harness();
		const opened = await h.container.open({
			sessionId: "session-stop-failed",
			voice: "marin",
			loadContext: async () => context("session-stop-failed"),
			background: {
				enabled: true,
				onTurnStarted: vi.fn(),
				onTurnTerminal: vi.fn(),
			},
		});
		h.processes[0]!.stop = vi.fn(async () => {
			throw new Error("still_alive");
		});
		await expect(opened.close()).rejects.toMatchObject({
			reason: "cleanup_pending",
		});
		expect(h.parent.close).toHaveBeenCalledTimes(1);
		expect(h.processes[1]!.stopCount).toBe(1);
		expect(existsSync(opened.root)).toBe(true);
	});

	it.each(["old_cancel_wait", "new_opening", "new_started"] as const)(
		"keeps process-level background completion during %s",
		async (phase) => {
			const h = harness();
			const started = vi.fn();
			const terminal = vi.fn();
			const opened = await h.container.open({
				sessionId: `session-${phase}`,
				voice: "marin",
				loadContext: async () => context(`session-${phase}`),
				background: {
					enabled: true,
					onTurnStarted: started,
					onTurnTerminal: terminal,
				},
			});
			const process = h.processes[0]!;
			process.emit("turn/started", {
				threadId: opened.threadId,
				turn: { id: "turn-background", status: "inProgress" },
			});
			process.emit("item/started", {
				threadId: opened.threadId,
				turnId: "turn-background",
				item: {
					id: "tool-background",
					type: "commandExecution",
					status: "inProgress",
				},
			});
			expect(started).toHaveBeenCalledWith("turn-background");
			expect(
				process.requests.filter(
					(request) => request.method === "turn/interrupt",
				),
			).toEqual([]);

			let release!: () => void;
			const held = new Promise<{
				result?: unknown;
				error?: { code: number; message: string };
			}>((resolve) => {
				release = () => resolve({ result: {} });
			});
			if (phase === "old_cancel_wait") {
				process.requestHook = (method) =>
					method === "thread/realtime/stop" ? held : undefined;
			} else if (phase === "new_opening") {
				process.requestHook = (method) =>
					method === "thread/realtime/start" ? held : undefined;
			}

			const restart = opened.restart();
			if (phase === "old_cancel_wait") {
				await vi.waitFor(() =>
					expect(process.requests.at(-1)?.method).toBe("thread/realtime/stop"),
				);
			} else if (phase === "new_opening") {
				await vi.waitFor(() =>
					expect(
						process.requests.filter(
							(request) => request.method === "thread/realtime/start",
						),
					).toHaveLength(2),
				);
			} else {
				await restart;
			}

			process.emit("item/completed", {
				threadId: opened.threadId,
				turnId: "turn-background",
				item: {
					id: "answer-background",
					type: "agentMessage",
					text: "【口语】FLY-2886 在 PR #1324。",
				},
			});
			process.emit("turn/completed", {
				threadId: opened.threadId,
				turn: { id: "turn-background", status: "completed" },
			});
			expect(terminal).toHaveBeenCalledWith({
				turnId: "turn-background",
				outcome: "completed",
				spokenSegments: ["FLY-2886 在 PR #1324。"],
			});

			if (phase === "old_cancel_wait") {
				release();
				process.emit("thread/realtime/closed", {
					threadId: opened.threadId,
					reason: "client_stop",
				});
				await restart;
			} else if (phase === "new_opening") {
				release();
				process.emit("thread/realtime/started", {
					threadId: opened.threadId,
					version: "v2",
					realtimeSessionId: "realtime-restarted",
				});
				await restart;
			}
			process.requestHook = undefined;
			await opened.close();
		},
	);

	it("interrupts an enabled active background turn when the conversation closes", async () => {
		const h = harness();
		const opened = await h.container.open({
			sessionId: "session-close-background",
			voice: "marin",
			loadContext: async () => context("session-close-background"),
			background: {
				enabled: true,
				onTurnStarted: vi.fn(),
				onTurnTerminal: vi.fn(),
			},
		});
		const process = h.processes[0]!;
		process.emit("turn/started", {
			threadId: opened.threadId,
			turn: { id: "turn-active", status: "inProgress" },
		});

		await opened.close();

		expect(process.requests).toContainEqual({
			method: "turn/interrupt",
			params: { threadId: opened.threadId, turnId: "turn-active" },
		});
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
			(process.requests[0]?.params as { prompt: string }).prompt,
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
