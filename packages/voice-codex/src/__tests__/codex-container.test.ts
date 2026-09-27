import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdmissionResidualRegistry } from "../codex/admission-residuals.js";
import {
	CAPABILITY_FEATURE_ARGV,
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
								"remote_plugin",
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
					delta: JSON.stringify({
						spoken: "准备好了。",
						threadText: null,
						tell: true,
						skipReason: null,
					}),
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
		this.onStop?.();
	}
	onStop?: () => void;

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
		scratchRoot?: (base: string) => string;
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
	const order: string[] = [];
	const parent = {
		manifest: {
			manifestDigest: "c".repeat(64),
			operationIds: [
				"linear.issue.read",
				"github.pr.read",
				"browser.list_pages",
			],
			deniedOperationIds: ["bridge.merge", "bridge.ship"],
			browserMode: "off" as const,
		},
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
		close: vi.fn(async () => {
			order.push("parent.close");
		}),
		revoke: vi.fn(() => {
			order.push("parent.revoke");
		}),
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
		scratchRoot: overrides.scratchRoot?.(base) ?? join(base, "scratch"),
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
		residuals: new AdmissionResidualRegistry({
			root: join(base, "scratch", "residuals"),
			system: {
				snapshot: () => {
					order.push("reap.snapshot");
					return [];
				},
				signal: () => undefined,
				removeDirectory: (path) =>
					rmSync(path, { recursive: true, force: true }),
				pause: async () => undefined,
			},
			report: () => undefined,
		}),
	});
	return {
		order,
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

	it("binds discovered capability categories and reserved actions into opening and restarted briefs", async () => {
		const h = harness();
		const opened = await h.container.open({
			sessionId: "session-capability-brief",
			voice: "marin",
			loadContext: async () => context("session-capability-brief"),
			background: {
				enabled: true,
				onTurnStarted: vi.fn(),
				onTurnTerminal: vi.fn(),
			},
		});
		await opened.restart();
		const prompts = h.processes[0]!.requests.filter(
			(row) => row.method === "thread/realtime/start",
		).map((row) => (row.params as { prompt: string }).prompt);
		expect(prompts).toHaveLength(2);
		for (const prompt of prompts) {
			expect(prompt).toContain("后台工具类别：GitHub、Linear");
			expect(prompt).toContain("bridge.merge、bridge.ship");
			expect(prompt).toContain("这场没有浏览器工具");
			expect(prompt).not.toContain("snapshotDigest=" + "a".repeat(64));
		}
		expect(h.parent.verifyEffectiveConfig).toHaveBeenCalled();
		await opened.close();
	});

	// FLY-2886 QA@4 D2: a realtime generation restart (barge-in) re-ran the full
	// capability self-check; skills drift failed it and took the whole session
	// down with the result undelivered. A restart only re-proves the lease.
	it("restarts a background session without re-running the capability self-check, even when it would now fail", async () => {
		const h = harness();
		const opened = await h.container.open({
			sessionId: "session-restart-drift",
			voice: "marin",
			loadContext: async () => context("session-restart-drift"),
			background: {
				enabled: true,
				onTurnStarted: vi.fn(),
				onTurnTerminal: vi.fn(),
			},
		});
		const capability = h.processes[0]!;
		const admissionRequests = capability.requests.length;
		const skillsChecks = h.parent.verifyEffectiveSkills.mock.calls.length;
		const configChecks = h.parent.verifyEffectiveConfig.mock.calls.length;
		const leaseChecks = h.parent.assertCurrent.mock.calls.length;
		h.parent.verifyEffectiveSkills.mockRejectedValue(
			new Error("capability_skills_unverified"),
		);
		mkdirSync(
			join(
				h.factoryOptions[0]!.codexHome,
				"plugins",
				"cache",
				"openai-curated-remote",
			),
			{ recursive: true },
		);
		await expect(opened.restart()).resolves.toBe(2);
		expect(h.parent.verifyEffectiveSkills).toHaveBeenCalledTimes(skillsChecks);
		expect(h.parent.verifyEffectiveConfig).toHaveBeenCalledTimes(configChecks);
		expect(h.parent.assertCurrent.mock.calls.length).toBeGreaterThan(
			leaseChecks,
		);
		expect(
			capability.requests
				.slice(admissionRequests)
				.map((row) => row.method)
				.filter((method) =>
					["skills/list", "config/read", "mcpServerStatus/list"].includes(
						method,
					),
				),
		).toEqual([]);
		// The drift is reported, not fatal.
		expect(h.evidence).toContainEqual(
			expect.objectContaining({
				kind: "codex_capability_plugins_observed",
				generation: 2,
			}),
		);
		const prompts = capability.requests
			.filter((row) => row.method === "thread/realtime/start")
			.map((row) => (row.params as { prompt: string }).prompt);
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain("后台工具类别：GitHub、Linear");
		await opened.close();
	});

	it("still fails a restart closed when the lease is no longer current", async () => {
		const h = harness();
		const opened = await h.container.open({
			sessionId: "session-restart-lease",
			voice: "marin",
			loadContext: async () => context("session-restart-lease"),
			background: {
				enabled: true,
				onTurnStarted: vi.fn(),
				onTurnTerminal: vi.fn(),
			},
		});
		h.parent.assertCurrent.mockRejectedValue(new Error("lease_fenced"));
		await expect(opened.restart()).rejects.toThrow("lease_fenced");
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
		// Only managed MCP servers: ChatGPT apps are switched off (FLY-2886 real
		// host), and so is the plugin system — on the real host Codex installed
		// openai-curated-remote plugins mid-session, whose skills then failed the
		// restart self-check (QA@4 D2/D3).
		expect(CAPABILITY_FEATURE_ARGV).toEqual([
			"-c",
			"features.apps=false",
			"-c",
			"features.plugins=false",
			"-c",
			"features.remote_plugin=false",
		]);
		expect(h.factoryOptions[0]!.mcpArgv.slice(-6)).toEqual([
			...CAPABILITY_FEATURE_ARGV,
		]);
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

	it("interrupts a rejected system-speech turn before granting parent delivery context", async () => {
		const h = harness();
		const started = vi.fn();
		const terminal = vi.fn();
		const opened = await h.container.open({
			sessionId: "session-system-tell",
			voice: "marin",
			loadContext: async () => context("session-system-tell"),
			background: {
				enabled: true,
				acceptTurnStarted: () => false,
				onTurnStarted: started,
				onTurnTerminal: terminal,
			},
		});
		const process = h.processes[0]!;
		process.emit("turn/started", {
			threadId: opened.threadId,
			turn: { id: "turn-from-lead-tell", status: "inProgress" },
		});
		await vi.waitFor(() =>
			expect(process.requests).toContainEqual({
				method: "turn/interrupt",
				params: {
					threadId: opened.threadId,
					turnId: "turn-from-lead-tell",
				},
			}),
		);
		expect(h.parent.beginTurn).not.toHaveBeenCalled();
		expect(started).not.toHaveBeenCalled();
		process.emit("turn/completed", {
			threadId: opened.threadId,
			turn: { id: "turn-from-lead-tell", status: "interrupted" },
		});
		expect(h.parent.endTurn).not.toHaveBeenCalled();
		expect(terminal).not.toHaveBeenCalled();
		await opened.close();
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
		"plugins_enabled",
		"remote_plugin_enabled",
		"plugin_cache_present",
	] as const)(
		"degrades on enabled admission drift %s: revokes, reports, reaps, closes, then opens foreground",
		async (drift) => {
			const h = harness({
				configureProcess: (process) => {
					const capability = process.options.profile === "voice-capability";
					if (drift === "permission_profile" && capability)
						process.threadResult = receipt(
							process.threadId,
							process.options.cwd,
						);
					if (drift === "plugin_cache_present" && capability)
						mkdirSync(
							join(
								process.options.codexHome,
								"plugins",
								"cache",
								"openai-curated-remote",
								"github",
							),
							{ recursive: true },
						);
					process.requestHook = (method) => {
						if (
							method === "config/read" &&
							capability &&
							(drift === "plugins_enabled" || drift === "remote_plugin_enabled")
						)
							return Promise.resolve({
								result: {
									config: {
										features: {
											plugins: drift === "plugins_enabled",
											remote_plugin: drift === "remote_plugin_enabled",
										},
										mcp_servers: {
											flywheel_lead_capabilities: {
												enabled_tools: ["lead_operation"],
											},
										},
									},
								},
							});
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
			const markDegraded = vi.fn(async (reason: string) => {
				h.order.push(`bridge.degraded:${reason}`);
			});
			const onDegraded = vi.fn();
			const loadContext = vi.fn(async () => context("session-drift"));
			const opened = await h.container.open({
				sessionId: "session-drift",
				voice: "marin",
				loadContext,
				background: {
					enabled: true,
					onTurnStarted: vi.fn(),
					onTurnTerminal: vi.fn(),
					markDegraded,
					onDegraded,
				},
			});
			const reason = ["background_api_account", "scribe_api_account"].includes(
				drift,
			)
				? "subscription_auth_unverified"
				: "capability_process_failed";
			// Plan v12 §14.2: admission failure degrades; the session still opens.
			expect(opened.background).toEqual({ state: "degraded", reason });
			expect(markDegraded).toHaveBeenCalledExactlyOnceWith(reason);
			expect(onDegraded).toHaveBeenCalledExactlyOnceWith(reason);
			// Fixed order: revoke → Bridge degraded → reap → close.
			expect(h.order.indexOf("parent.revoke")).toBe(0);
			expect(h.order[1]).toBe(`bridge.degraded:${reason}`);
			expect(h.order[2]).toBe("reap.snapshot");
			expect(h.order.indexOf("parent.close")).toBeGreaterThan(2);
			expect(h.parent.close).toHaveBeenCalledTimes(1);
			const admission = h.processes.slice(0, -1);
			const foreground = h.processes.at(-1)!;
			expect(admission.every((process) => process.stopCount === 1)).toBe(true);
			for (const process of admission) {
				expect(
					process.options.profile === "voice-capability" ||
						!process.options.voiceProfile,
				).toBe(true);
				expect(
					process.requests.some(
						(row) => row.method === "thread/realtime/start",
					),
				).toBe(false);
				expect(existsSync(process.options.root)).toBe(false);
			}
			// Foreground: fresh home under fg/, read-only thread, no tools.
			expect(foreground.options.profile).toBeUndefined();
			expect(foreground.options.mcpArgv).toEqual([]);
			expect(foreground.options.codexHome).toBe(
				join(opened.root, "fg", "home"),
			);
			expect(foreground.threadParams).toMatchObject({ sandbox: "read-only" });
			expect(
				foreground.requests.some(
					(row) => row.method === "thread/realtime/start",
				),
			).toBe(true);
			expect(existsSync(join(opened.root, "admission"))).toBe(false);
			// The foreground context is reloaded after Bridge knows.
			expect(loadContext).toHaveBeenCalledTimes(2);
			expect(h.evidence).toContainEqual(
				expect.objectContaining({
					kind: "codex_voice_background_degraded",
					reason,
				}),
			);
			expect(h.evidence).toContainEqual(
				expect.objectContaining({ kind: "codex_voice_open_timing" }),
			);
			await opened.close();
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
		// The parent's short /tmp root holds only its broker socket and pins; no
		// sweep owns it after admission, so it goes now (review R6).
		const { activationRoot } = h.createCapabilityParent.mock
			.calls[0]![0] as unknown as { activationRoot: string };
		expect(existsSync(activationRoot)).toBe(false);
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

describe("background admission degrades to foreground voice (FLY-2886 plan v12 §14.2)", () => {
	const background = (
		markDegraded = vi.fn(async (_reason: string) => undefined),
	) => ({
		enabled: true as const,
		onTurnStarted: vi.fn(),
		onTurnTerminal: vi.fn(),
		markDegraded,
		onDegraded: vi.fn(),
	});

	it("reports enabled when the admission succeeds", async () => {
		const h = harness();
		const opened = await h.container.open({
			sessionId: "session-enabled",
			voice: "marin",
			loadContext: async () => context("session-enabled"),
			background: background(),
		});
		expect(opened.background).toEqual({ state: "enabled" });
		expect(h.order).not.toContain("parent.revoke");
		// An admitted session owns its processes: no residual record may remain
		// for the periodic sweep to reap under a live conversation.
		expect(
			existsSync(join(h.base, "scratch", "residuals", "session-enabled.json")),
		).toBe(false);
		await opened.close();
	});

	it("opens the foreground when the parent itself cannot start, with nothing else created", async () => {
		const h = harness();
		h.createCapabilityParent.mockRejectedValueOnce(
			new Error("model_isolation_unproven"),
		);
		const input = background();
		const opened = await h.container.open({
			sessionId: "session-parent-failed",
			voice: "marin",
			loadContext: async () => context("session-parent-failed"),
			background: input,
		});
		expect(opened.background).toEqual({
			state: "degraded",
			reason: "model_isolation_unproven",
		});
		expect(input.markDegraded).toHaveBeenCalledExactlyOnceWith(
			"model_isolation_unproven",
		);
		expect(h.processes).toHaveLength(1);
		expect(h.processes[0]!.options.profile).toBeUndefined();
		expect(h.evidence).toContainEqual(
			expect.objectContaining({
				kind: "codex_voice_background_degraded",
				stage: "parent",
				errorCode: "model_isolation_unproven",
			}),
		);
		await opened.close();
	});

	it("is unavailable when Bridge cannot record the degrade, after reaping and closing", async () => {
		const h = harness({
			configureProcess: (process) => {
				if (process.options.profile === "voice-capability")
					process.requestHook = (method) =>
						method === "account/read"
							? Promise.resolve({ result: { account: { type: "apiKey" } } })
							: undefined;
			},
		});
		const input = background(
			vi.fn(async () => {
				throw new Error("bridge_down");
			}),
		);
		await expect(
			h.container.open({
				sessionId: "session-post-failed",
				voice: "marin",
				loadContext: async () => context("session-post-failed"),
				background: input,
			}),
		).rejects.toMatchObject({ code: "voice_unavailable" });
		expect(h.order[0]).toBe("parent.revoke");
		expect(h.order).toContain("reap.snapshot");
		expect(h.parent.close).toHaveBeenCalledTimes(1);
		expect(h.processes[0]!.stopCount).toBe(1);
		// No foreground was started on a background-shaped context.
		expect(h.processes).toHaveLength(1);
		expect(input.onDegraded).not.toHaveBeenCalled();
	});

	it("skips the background when the open deadline leaves too little admission time", async () => {
		const h = harness();
		const input = background();
		const now = Date.parse("2026-09-23T10:00:00.000Z");
		const opened = await h.container.open({
			sessionId: "session-budget",
			voice: "marin",
			loadContext: async () => context("session-budget"),
			background: input,
			openDeadlineAt: now + 25_000 + 20_000 + 9_000,
		});
		expect(h.createCapabilityParent).not.toHaveBeenCalled();
		expect(opened.background).toEqual({
			state: "degraded",
			reason: "admission_budget_exhausted",
		});
		expect(input.markDegraded).toHaveBeenCalledExactlyOnceWith(
			"admission_budget_exhausted",
		);
		await opened.close();
	});

	it("times out the admission, keeps a late parent out of the session and leaves the foreground alone", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const h = harness();
		let resolveParent!: (value: typeof h.parent) => void;
		h.createCapabilityParent.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveParent = resolve as never;
				}) as never,
		);
		const input = background();
		const now = Date.parse("2026-09-23T10:00:00.000Z");
		const pending = h.container.open({
			sessionId: "session-late-parent",
			voice: "marin",
			loadContext: async () => context("session-late-parent"),
			background: input,
			openDeadlineAt: now + 25_000 + 20_000 + 11_000,
		});
		await vi.waitFor(() => expect(h.createCapabilityParent).toHaveBeenCalled());
		await vi.advanceTimersByTimeAsync(11_000);
		const opened = await pending;
		expect(opened.background).toEqual({
			state: "degraded",
			reason: "admission_timeout",
		});
		expect(h.processes).toHaveLength(1);
		// The parent arrives after the deadline: revoked and closed, never assembled.
		resolveParent(h.parent);
		await vi.waitFor(() => expect(h.parent.close).toHaveBeenCalled());
		expect(h.parent.revoke).toHaveBeenCalled();
		expect(existsSync(join(opened.root, "fg", "home"))).toBe(true);
		expect(h.factoryOptions.every((row) => row.profile === undefined)).toBe(
			true,
		);
		await opened.close();
	});

	it("a late admission continuation makes no further RPC after the deadline (review R1#4)", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let releaseAccount!: () => void;
		const h = harness({
			configureProcess: (process) => {
				if (!process.options.profile && !process.options.voiceProfile)
					process.requestHook = (method) =>
						method === "account/read"
							? new Promise((resolve) => {
									releaseAccount = () =>
										resolve({ result: { account: { type: "chatgpt" } } });
								})
							: undefined;
			},
		});
		const now = Date.parse("2026-09-23T10:00:00.000Z");
		const pending = h.container.open({
			sessionId: "session-late-scribe",
			voice: "marin",
			loadContext: async () => context("session-late-scribe"),
			background: background(),
			openDeadlineAt: now + 25_000 + 20_000 + 11_000,
		});
		await vi.waitFor(() => expect(releaseAccount).toBeTypeOf("function"));
		await vi.advanceTimersByTimeAsync(11_000);
		const opened = await pending;
		expect(opened.background).toEqual({
			state: "degraded",
			reason: "admission_timeout",
		});
		const scribe = h.processes.find(
			(process) => !process.options.profile && !process.options.voiceProfile,
		)!;
		const before = scribe.requests.length;
		releaseAccount();
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));
		expect(scribe.requests.slice(before)).toEqual([]);
		expect(scribe.threadParams).toBeUndefined();
		await opened.close();
	});

	it("still closes the rest when one admission resource fails to close", async () => {
		const h = harness({
			configureProcess: (process) => {
				if (!process.options.profile && !process.options.voiceProfile) {
					// The scribe: fails its probe, then fails to stop.
					process.requestHook = (method) =>
						method === "turn/start"
							? Promise.resolve({ error: { code: 429, message: "quota" } })
							: undefined;
					process.stop = vi.fn(async () => {
						throw new Error("still_alive");
					});
				}
			},
		});
		const opened = await h.container.open({
			sessionId: "session-close-failed",
			voice: "marin",
			loadContext: async () => context("session-close-failed"),
			background: background(),
		});
		expect(opened.background).toMatchObject({ state: "degraded" });
		expect(h.processes[0]!.stopCount).toBe(1);
		expect(h.parent.close).toHaveBeenCalledTimes(1);
		await opened.close();
	});
});

describe("the broker socket fits the platform limit in the production layout (QA@3 B1)", () => {
	// Production: <HOME>/.flywheel/voice/codex-containers/container-XXXXXX/...,
	// here with a HOME far longer than the host's own.
	const deep = (base: string) =>
		join(base, "h".repeat(90), ".flywheel", "voice", "codex-containers");
	const activationRootOf = (h: ReturnType<typeof harness>) =>
		(
			h.createCapabilityParent.mock.calls[0]![0] as unknown as {
				activationRoot: string;
			}
		).activationRoot;
	// runtime-parent: mkdtemp("run-") + "/broker.sock", listen limit 100 bytes.
	const socketBytes = (activationRoot: string) =>
		Buffer.byteLength(join(activationRoot, "run-XXXXXX", "broker.sock"));

	it("admits with a short private activation root, removed when the session closes", async () => {
		const h = harness({ scratchRoot: deep });
		const opened = await h.container.open({
			sessionId: "session-socket",
			voice: "marin",
			loadContext: async () => context("session-socket"),
			background: {
				enabled: true,
				onTurnStarted: vi.fn(),
				onTurnTerminal: vi.fn(),
			},
		});
		const activationRoot = activationRootOf(h);
		expect(socketBytes(activationRoot)).toBeLessThanOrEqual(100);
		expect(activationRoot.startsWith(`${realpathSync("/tmp")}/fw-vcap-`)).toBe(
			true,
		);
		expect(statSync(activationRoot).mode & 0o777).toBe(0o700);
		await opened.close();
		expect(existsSync(activationRoot)).toBe(false);
	});

	it("removes the activation root when the open fails after admission and a child cannot stop (review R6)", async () => {
		const h = harness({
			scratchRoot: deep,
			configureProcess: (process) => {
				if (process.options.profile !== "voice-capability") return;
				process.realtimeError = { code: -32602, message: "rejected" };
				process.stop = vi.fn(async () => {
					throw new Error("still_alive");
				});
			},
		});
		await expect(
			h.container.open({
				sessionId: "session-socket-open-failed",
				voice: "marin",
				loadContext: async () => context("session-socket-open-failed"),
				background: {
					enabled: true,
					onTurnStarted: vi.fn(),
					onTurnTerminal: vi.fn(),
				},
			}),
		).rejects.toBeDefined();
		const activationRoot = activationRootOf(h);
		await vi.waitFor(() => expect(existsSync(activationRoot)).toBe(false));
	});

	it("removes the activation root when the admission degrades", async () => {
		const h = harness({ scratchRoot: deep });
		h.createCapabilityParent.mockRejectedValueOnce(
			new Error("model_isolation_unproven"),
		);
		const opened = await h.container.open({
			sessionId: "session-socket-degraded",
			voice: "marin",
			loadContext: async () => context("session-socket-degraded"),
			background: {
				enabled: true,
				onTurnStarted: vi.fn(),
				onTurnTerminal: vi.fn(),
				markDegraded: vi.fn(async () => undefined),
				onDegraded: vi.fn(),
			},
		});
		const activationRoot = activationRootOf(h);
		expect(socketBytes(activationRoot)).toBeLessThanOrEqual(100);
		await vi.waitFor(() => expect(existsSync(activationRoot)).toBe(false));
		await opened.close();
	});
});
