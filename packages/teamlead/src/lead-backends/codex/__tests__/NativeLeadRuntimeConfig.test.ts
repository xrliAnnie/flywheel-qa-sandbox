import { EventEmitter } from "node:events";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fileIo from "flywheel-comm/lead-registry-file-io";
import * as modelConfig from "flywheel-config";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as runtimeSource from "../../../lead-runtime-tuning.js";
import {
	applyCodexLeadRuntimeConfig,
	CodexLeadInboxServer,
	probeCodexLeadInboxCapabilities,
	readCodexLeadRuntimeConfig,
} from "../CodexLeadInboxSocket.js";
import { NativeLeadRuntimeConfig } from "../NativeLeadRuntimeConfig.js";

beforeEach(() => {
	vi.spyOn(runtimeSource, "readLeadRuntimeSource").mockReturnValue({
		model: "gpt-6-astra",
		reasoningEffort: "high",
		configDigest: "a".repeat(64),
		modelRegistryRevision: "registry",
	});
});
afterEach(() => vi.restoreAllMocks());
it("exposes hot hooks only after native protocol and bootstrap settings proof", async () => {
	const dir = mkdtempSync(join(tmpdir(), "native-config-"));
	const proc = Object.assign(new EventEmitter(), {
		updateThreadSettings: vi.fn(async () => {}),
		readThreadSettings: vi.fn(async () => ({
			model: "gpt-6-astra",
			effort: "high",
		})),
	});
	const log = vi.fn();
	const runtime = new NativeLeadRuntimeConfig({
		config: {
			stateDir: dir,
			codexHome: dir,
			projectName: "raya",
			leadId: "raya",
			leadKey: "raya-raya",
			identityDigest: "id",
			botUserId: "123",
		},
		process: proc,
		build: {
			artifactBuildSha: "a".repeat(40),
			bootstrapBuildSha: "a".repeat(40),
		},
		log,
	});
	try {
		expect(proc.listenerCount("notification")).toBe(2);
		expect(runtime.hooks.isSupported()).toBe(false);
		await runtime.bootstrap("thread", {
			model: "gpt-6-astra",
			reasoningEffort: "high",
		});
		expect(runtime.hooks.isSupported()).toBe(true);
		runtime.bindOwner(() => true);
		const admission = await runtime.beforeTurn();
		expect(admission.model).toBeUndefined();
		admission.assertCurrent?.();
		vi.mocked(runtimeSource.readLeadRuntimeSource).mockReturnValueOnce({
			model: "gpt-6-astra",
			reasoningEffort: "low",
			configDigest: "b".repeat(64),
			modelRegistryRevision: "registry",
		});
		expect(await runtime.beforeTurn()).toEqual({});
		expect(log).toHaveBeenCalledWith(
			"runtime config admission unavailable: runtime_config_source_changed; using existing session settings",
		);
		runtime.bindOwner(() => false);
		expect(admission.assertCurrent).toThrow("runtime_config_owner_changed");
		await expect(runtime.beforeTurn()).rejects.toThrow(
			"runtime_config_owner_changed",
		);
		await expect(runtime.beforeTurn(true)).resolves.toBeDefined();
		runtime.bindOwner(() => true);
		expect(runtime.hooks.identity()).toMatchObject({
			threadId: "thread",
			carrierId: runtime.socketOwnerId,
		});
		expect(proc.updateThreadSettings).toHaveBeenCalledWith({
			threadId: "thread",
			model: "gpt-6-astra",
			effort: "high",
		});
		vi.mocked(runtimeSource.readLeadRuntimeSource).mockImplementation(() => {
			throw new Error("lead_runtime_identity_changed");
		});
		expect(runtime.hooks.isSupported()).toBe(false);
		runtime.close();
		expect(runtime.hooks.isSupported()).toBe(false);
		expect(proc.listenerCount("notification")).toBe(0);
	} finally {
		runtime.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
it("does not advertise capability or overwrite a mismatched native bootstrap pair", async () => {
	const dir = mkdtempSync(join(tmpdir(), "native-config-"));
	const proc = Object.assign(new EventEmitter(), {
		updateThreadSettings: vi.fn(async () => {}),
		readThreadSettings: vi.fn(async () => ({
			model: "gpt-6-astra",
			effort: "low",
		})),
	});
	const runtime = new NativeLeadRuntimeConfig({
		config: {
			stateDir: dir,
			codexHome: dir,
			projectName: "raya",
			leadId: "raya",
			leadKey: "raya-raya",
			identityDigest: "id",
			botUserId: "123",
		},
		process: proc,
		build: {
			artifactBuildSha: "a".repeat(40),
			bootstrapBuildSha: "a".repeat(40),
		},
		log: vi.fn(),
	});
	try {
		await runtime.bootstrap("thread", {
			model: "gpt-6-astra",
			reasoningEffort: "high",
		});
		expect(
			JSON.parse(readFileSync(join(dir, "thread-settings.json"), "utf8")),
		).toMatchObject({
			version: 1,
			threadId: "thread",
			model: "gpt-6-astra",
			effort: "low",
			source: "thread_read",
			buildSha: "a".repeat(40),
		});
		expect(runtime.hooks.isSupported()).toBe(false);
		expect(proc.updateThreadSettings).not.toHaveBeenCalled();
		runtime.bindOwner(() => runtime.hooks.isSupported());
		const admission = await runtime.beforeTurn();
		expect(admission.model).toBeUndefined();
		expect(() => admission.assertCurrent?.()).not.toThrow();
	} finally {
		runtime.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("records pinned bootstrap settings and refreshes changed settings after a completed turn", async () => {
	const dir = mkdtempSync(join(tmpdir(), "native-config-evidence-"));
	const threadId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	let pair = { model: "gpt-6-astra", effort: "high" };
	const proc = Object.assign(new EventEmitter(), {
		updateThreadSettings: vi.fn(async () => {}),
		readThreadSettings: vi.fn(async () => ({ ...pair })),
	});
	const writeSpy = vi.spyOn(fileIo, "writeAtomic");
	const runtime = new NativeLeadRuntimeConfig({
		config: {
			stateDir: dir,
			projectName: "raya",
			leadId: "raya",
			leadKey: "raya-raya",
			identityDigest: "id",
			botUserId: "123",
		},
		process: proc,
		build: {
			artifactBuildSha: "b".repeat(40),
			bootstrapBuildSha: "b".repeat(40),
		},
		log: vi.fn(),
	});
	const evidencePath = join(dir, "thread-settings.json");
	try {
		await runtime.bootstrap(threadId, {
			model: pair.model,
			reasoningEffort: pair.effort,
		});
		expect(JSON.parse(readFileSync(evidencePath, "utf8"))).toMatchObject({
			threadId,
			model: "gpt-6-astra",
			effort: "high",
			source: "thread_read",
		});
		const writesAfterBootstrap = writeSpy.mock.calls.filter(
			([path]) => path === evidencePath,
		).length;

		pair = { model: "gpt-6-astra", effort: "low" };
		proc.emit("notification", "turn/completed", { threadId });
		await vi.waitFor(() => {
			expect(JSON.parse(readFileSync(evidencePath, "utf8"))).toMatchObject({
				effort: "low",
			});
		});
		const writesAfterChange = writeSpy.mock.calls.filter(
			([path]) => path === evidencePath,
		).length;
		expect(writesAfterChange).toBe(writesAfterBootstrap + 1);

		proc.emit("notification", "turn/completed", { threadId });
		await vi.waitFor(() => {
			expect(proc.readThreadSettings.mock.calls.length).toBeGreaterThanOrEqual(
				4,
			);
		});
		expect(
			writeSpy.mock.calls.filter(([path]) => path === evidencePath),
		).toHaveLength(writesAfterChange);
	} finally {
		runtime.close();
		writeSpy.mockRestore();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("logs refresh failures and discards a late refresh after close", async () => {
	const dir = mkdtempSync(join(tmpdir(), "native-config-evidence-"));
	const threadId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	let refreshResolve:
		| ((value: { model: string; effort: string }) => void)
		| null = null;
	const refresh = new Promise<{ model: string; effort: string }>((resolve) => {
		refreshResolve = resolve;
	});
	const proc = Object.assign(new EventEmitter(), {
		updateThreadSettings: vi.fn(async () => {}),
		readThreadSettings: vi
			.fn()
			.mockResolvedValueOnce({ model: "gpt-6-astra", effort: "high" })
			.mockResolvedValueOnce({ model: "gpt-6-astra", effort: "high" })
			.mockRejectedValueOnce(new Error("rpc unavailable"))
			.mockImplementationOnce(() => refresh),
	});
	const log = vi.fn();
	const runtime = new NativeLeadRuntimeConfig({
		config: {
			stateDir: dir,
			projectName: "raya",
			leadId: "raya",
			leadKey: "raya-raya",
			identityDigest: "id",
			botUserId: "123",
		},
		process: proc,
		build: {
			artifactBuildSha: "c".repeat(40),
			bootstrapBuildSha: "c".repeat(40),
		},
		log,
	});
	const evidencePath = join(dir, "thread-settings.json");
	try {
		await runtime.bootstrap(threadId, {
			model: "gpt-6-astra",
			reasoningEffort: "high",
		});
		proc.emit("notification", "turn/completed", { threadId });
		await vi.waitFor(() =>
			expect(log).toHaveBeenCalledWith(
				expect.stringContaining("thread settings evidence unavailable"),
			),
		);
		proc.emit("notification", "turn/completed", { threadId });
		await vi.waitFor(() =>
			expect(proc.readThreadSettings).toHaveBeenCalledTimes(4),
		);
		runtime.close();
		refreshResolve?.({ model: "gpt-6-astra", effort: "low" });
		await refresh;
		await Promise.resolve();
		expect(JSON.parse(readFileSync(evidencePath, "utf8"))).toMatchObject({
			effort: "high",
		});
	} finally {
		runtime.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("does not let an old-thread refresh overwrite a newer bootstrap", async () => {
	const dir = mkdtempSync(join(tmpdir(), "native-config-evidence-"));
	const oldThread = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	const newThread = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
	let oldResolve: ((value: { model: string; effort: string }) => void) | null =
		null;
	const oldRefresh = new Promise<{ model: string; effort: string }>(
		(resolve) => {
			oldResolve = resolve;
		},
	);
	const proc = Object.assign(new EventEmitter(), {
		updateThreadSettings: vi.fn(async () => {}),
		readThreadSettings: vi
			.fn()
			.mockResolvedValueOnce({ model: "gpt-6-astra", effort: "high" })
			.mockResolvedValueOnce({ model: "gpt-6-astra", effort: "high" })
			.mockImplementationOnce(() => oldRefresh)
			.mockResolvedValueOnce({ model: "gpt-6-astra", effort: "high" })
			.mockResolvedValueOnce({ model: "gpt-6-astra", effort: "high" }),
	});
	const runtime = new NativeLeadRuntimeConfig({
		config: {
			stateDir: dir,
			projectName: "raya",
			leadId: "raya",
			leadKey: "raya-raya",
			identityDigest: "id",
			botUserId: "123",
		},
		process: proc,
		build: {
			artifactBuildSha: "e".repeat(40),
			bootstrapBuildSha: "e".repeat(40),
		},
		log: vi.fn(),
	});
	const evidencePath = join(dir, "thread-settings.json");
	try {
		await runtime.bootstrap(oldThread, {
			model: "gpt-6-astra",
			reasoningEffort: "high",
		});
		proc.emit("notification", "turn/completed", { threadId: oldThread });
		await vi.waitFor(() =>
			expect(proc.readThreadSettings).toHaveBeenCalledTimes(3),
		);
		await runtime.bootstrap(newThread, {
			model: "gpt-6-astra",
			reasoningEffort: "high",
		});
		expect(JSON.parse(readFileSync(evidencePath, "utf8"))).toMatchObject({
			threadId: newThread,
			effort: "high",
		});
		oldResolve?.({ model: "gpt-6-astra", effort: "low" });
		await oldRefresh;
		await Promise.resolve();
		expect(JSON.parse(readFileSync(evidencePath, "utf8"))).toMatchObject({
			threadId: newThread,
			effort: "high",
		});
	} finally {
		runtime.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("retries an identical pair after an evidence write failure", async () => {
	const dir = mkdtempSync(join(tmpdir(), "native-config-evidence-"));
	const threadId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	const evidencePath = join(dir, "thread-settings.json");
	const originalWrite = fileIo.writeAtomic;
	let evidenceAttempts = 0;
	const writeSpy = vi
		.spyOn(fileIo, "writeAtomic")
		.mockImplementation((path, contents, mode) => {
			if (path === evidencePath && ++evidenceAttempts === 1) {
				throw new Error("disk full");
			}
			return originalWrite(path, contents, mode);
		});
	const proc = Object.assign(new EventEmitter(), {
		updateThreadSettings: vi.fn(async () => {}),
		readThreadSettings: vi.fn(async () => ({
			model: "gpt-6-astra",
			effort: "high",
		})),
	});
	const log = vi.fn();
	const runtime = new NativeLeadRuntimeConfig({
		config: {
			stateDir: dir,
			projectName: "raya",
			leadId: "raya",
			leadKey: "raya-raya",
			identityDigest: "id",
			botUserId: "123",
		},
		process: proc,
		build: {
			artifactBuildSha: "d".repeat(40),
			bootstrapBuildSha: "d".repeat(40),
		},
		log,
	});
	try {
		await runtime.bootstrap(threadId, {
			model: "gpt-6-astra",
			reasoningEffort: "high",
		});
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("thread settings evidence unavailable"),
		);
		expect(evidenceAttempts).toBe(1);
		proc.emit("notification", "turn/completed", { threadId });
		await vi.waitFor(() => expect(evidenceAttempts).toBe(2));
		expect(JSON.parse(readFileSync(evidencePath, "utf8"))).toMatchObject({
			model: "gpt-6-astra",
			effort: "high",
		});
	} finally {
		runtime.close();
		writeSpy.mockRestore();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("keeps socket ownership and turns live when the registry becomes unreadable", async () => {
	const dir = mkdtempSync(join(tmpdir(), "native-config-owner-"));
	const proc = Object.assign(new EventEmitter(), {
		updateThreadSettings: vi.fn(async () => {}),
		readThreadSettings: vi.fn(async () => ({
			model: "gpt-6-astra",
			effort: "high",
		})),
	});
	const log = vi.fn();
	const runtime = new NativeLeadRuntimeConfig({
		config: {
			stateDir: dir,
			projectName: "raya",
			leadId: "raya",
			leadKey: "raya-raya",
			identityDigest: "id",
			botUserId: "123",
		},
		process: proc,
		build: {
			artifactBuildSha: "a".repeat(40),
			bootstrapBuildSha: "a".repeat(40),
		},
		log,
	});
	const server = new CodexLeadInboxServer({
		socketPath: join(dir, "inbox.sock"),
		leadId: "raya",
		authSecret: "secret",
		router: { submitBatch: vi.fn() },
		socketOwnerId: runtime.socketOwnerId,
		runtimeConfig: runtime.hooks,
	});
	try {
		await runtime.bootstrap("thread", {
			model: "gpt-6-astra",
			reasoningEffort: "high",
		});
		await server.listen();
		const mailboxReady = true;
		runtime.bindOwner(() => server.runtimeConfigOwnerCurrent() && mailboxReady);
		vi.mocked(runtimeSource.readLeadRuntimeSource).mockImplementation(() => {
			throw new Error("lead_registry_recovery_required");
		});
		expect(runtime.hooks.isSupported()).toBe(false);
		expect(server.runtimeConfigOwnerCurrent()).toBe(true);
		await expect(runtime.beforeTurn()).resolves.toEqual({});
		expect(log).toHaveBeenCalledWith(
			"runtime config admission unavailable: lead_registry_recovery_required; using existing session settings",
		);
	} finally {
		await server.close();
		runtime.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("routes a signed socket apply through native confirmation and the owning host", async () => {
	const dir = mkdtempSync("/tmp/ncfg-");
	mkdirSync(join(dir, "sessions"));
	const rollout = join(dir, "sessions", "rollout.jsonl");
	let pair = { model: "gpt-6-astra", effort: "low" };
	const proc = Object.assign(new EventEmitter(), {
		readThreadRolloutPath: vi.fn(async () => rollout),
		readThreadSettings: vi.fn(async () => ({ ...pair })),
		updateThreadSettings: vi.fn(
			async (value: { threadId: string; model: string; effort: string }) => {
				pair = { model: value.model, effort: value.effort };
				proc.emit("notification", "thread/settings/updated", {
					threadId: value.threadId,
					threadSettings: pair,
				});
			},
		),
	});
	const spy = vi.spyOn(runtimeSource, "readLeadRuntimeSource").mockReturnValue({
		model: "gpt-6-astra",
		reasoningEffort: "high",
		configDigest: "a".repeat(64),
		modelRegistryRevision: "registry",
	});
	const runtime = new NativeLeadRuntimeConfig({
		config: {
			stateDir: dir,
			codexHome: dir,
			projectName: "raya",
			leadId: "raya",
			leadKey: "raya-raya",
			identityDigest: "id",
			botUserId: "123",
		},
		process: proc,
		build: {
			artifactBuildSha: "b".repeat(40),
			bootstrapBuildSha: "b".repeat(40),
		},
		log: vi.fn(),
	});
	const args = {
		socketPath: join(dir, "inbox.sock"),
		leadId: "raya",
		authSecret: "test-secret",
	};
	const server = new CodexLeadInboxServer({
		...args,
		socketOwnerId: runtime.socketOwnerId,
		router: { submitBatch: vi.fn() },
		runtimeConfig: runtime.hooks,
	});
	runtime.bindOwner(() => server.runtimeConfigOwnerCurrent());
	try {
		await runtime.bootstrap("thread", {
			model: "gpt-6-astra",
			reasoningEffort: "low",
		});
		await server.listen();
		const capability = await probeCodexLeadInboxCapabilities(args);
		expect(capability.features).toContain("lead_runtime_config_v1");
		const target = {
			...runtime.hooks.identity(),
			operationId: "op",
			configGeneration: 1,
			configDigest: "a".repeat(64),
			modelRegistryRevision: "registry",
			model: "gpt-6-astra",
			effort: "high",
		};
		expect(
			await applyCodexLeadRuntimeConfig({
				...args,
				socketOwnerId: runtime.socketOwnerId,
				target,
			}),
		).toMatchObject({ status: "applied", operationId: "op", effort: "high" });
		expect(pair.effort).toBe("high");
		writeFileSync(
			rollout,
			[
				JSON.stringify({ type: "session_meta", payload: { id: "thread" } }),
				JSON.stringify({
					type: "turn_context",
					timestamp: new Date().toISOString(),
					payload: {
						turn_id: "actual-turn",
						model: pair.model,
						effort: pair.effort,
					},
				}),
				"",
			].join("\n"),
		);
		proc.emit("notification", "turn/completed", {
			threadId: "thread",
			turn: { id: "actual-turn" },
		});
		expect(proc.readThreadRolloutPath).not.toHaveBeenCalled();
		proc.emit("notification", "turn/started", {
			threadId: "thread",
			turn: { id: "actual-turn" },
		});
		await vi.waitFor(async () => {
			const state = await readCodexLeadRuntimeConfig({
				...args,
				socketOwnerId: runtime.socketOwnerId,
				target,
			});
			expect(state.observation).toMatchObject({
				source: "registry_hot",
				evidence: { turnId: "actual-turn", effort: "high" },
			});
		});
		pair.effort = "low";
		const read = () =>
			readCodexLeadRuntimeConfig({
				...args,
				socketOwnerId: runtime.socketOwnerId,
				target,
			});
		expect(await read()).toMatchObject({ effort: "low", drifted: true });
		pair.effort = "high";
		expect(await read()).toMatchObject({ effort: "high", drifted: true });
		server.pauseAccepting();
		await expect(runtime.hooks.apply(target, () => {})).rejects.toThrow(
			"runtime_config_owner_changed",
		);
		expect(proc.updateThreadSettings).toHaveBeenCalledTimes(2);
	} finally {
		await server.close();
		runtime.close();
		spy.mockRestore();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("gates native model switches on same-thread context evidence and retries without restart", async () => {
	const dir = mkdtempSync("/tmp/nctx-");
	const original = modelConfig.getModelConfigSnapshot();
	const capacity = 100_000;
	// Fixture capability only: the production registry must provide a verified capacity.
	const snapshot = {
		...original,
		getModelRegistryEntry: (model: string) => {
			const entry = original.getModelRegistryEntry(model);
			return entry ? { ...entry, contextWindowTokens: capacity } : undefined;
		},
	};
	vi.spyOn(modelConfig, "getModelConfigSnapshot").mockReturnValue(snapshot);
	let pair = { model: "old-native-model", effort: "low" };
	const proc = Object.assign(new EventEmitter(), {
		readThreadSettings: vi.fn(async () => ({ ...pair })),
		updateThreadSettings: vi.fn(
			async (value: { threadId: string; model: string; effort: string }) => {
				pair = { model: value.model, effort: value.effort };
				proc.emit("notification", "thread/settings/updated", {
					threadId: value.threadId,
					threadSettings: pair,
				});
			},
		),
	});
	const runtime = new NativeLeadRuntimeConfig({
		config: {
			stateDir: dir,
			projectName: "raya",
			leadId: "raya",
			leadKey: "raya-raya",
			identityDigest: "id",
			botUserId: "123",
		},
		process: proc,
		build: {
			artifactBuildSha: "a".repeat(40),
			bootstrapBuildSha: "a".repeat(40),
		},
		log: vi.fn(),
	});
	try {
		await runtime.bootstrap("thread", {
			model: pair.model,
			reasoningEffort: pair.effort,
		});
		runtime.bindOwner(() => true);
		const target = {
			...runtime.hooks.identity(),
			operationId: "op-context",
			configGeneration: 1,
			configDigest: "a".repeat(64),
			modelRegistryRevision: snapshot.revision,
			model: "gpt-6-astra",
			effort: "high",
		};
		vi.mocked(runtimeSource.readLeadRuntimeSource).mockReturnValue({
			model: target.model,
			reasoningEffort: target.effort,
			configDigest: target.configDigest,
			modelRegistryRevision: snapshot.revision,
		});
		await expect(runtime.hooks.apply(target, () => {})).rejects.toThrow(
			"context_window_incompatible",
		);
		expect(proc.updateThreadSettings).toHaveBeenCalledTimes(1); // bootstrap no-op only
		proc.emit("notification", "thread/tokenUsage/updated", {
			threadId: "thread",
			tokenUsage: {
				last: { totalTokens: 10 },
				total: { totalTokens: capacity * 2 },
				modelContextWindow: capacity,
			},
		});
		await expect(runtime.hooks.apply(target, () => {})).resolves.toMatchObject({
			status: "applied",
		});
		expect(pair).toEqual({ model: target.model, effort: target.effort });
		expect(proc.updateThreadSettings).toHaveBeenCalledTimes(2);
	} finally {
		runtime.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
