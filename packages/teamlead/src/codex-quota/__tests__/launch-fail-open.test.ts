import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CodexDaemonGoalRuntime,
	type DaemonHandle,
	type DaemonTransport,
} from "flywheel-claude-runner";
import { expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { createCodexQuotaLaunchBinder } from "../launch-binding.js";
import {
	type CodexQuotaDispatcherWiring,
	initializeCodexQuotaRuntime,
	wireCodexQuotaDispatcher,
} from "../runtime.js";

it("constructor failure still launches and completes a real daemon goal with rotation disabled", async () => {
	const cause = new Error("shared credential migration missing");
	const report = vi.fn();
	const quota = await initializeCodexQuotaRuntime(
		() => true,
		() => {
			throw cause;
		},
		report,
	);
	const dispatcher = {} as Required<CodexQuotaDispatcherWiring>;
	wireCodexQuotaDispatcher(
		dispatcher,
		{
			codexQuota: { isPaused: () => false, isExecutionPaused: () => false },
		} as never,
		quota,
		"root",
	);

	const { runtime, spawnDaemon, methods, logger } = daemonHarness(
		dispatcher.beforeCodexDaemonStart,
	);
	try {
		const result = await runtime.runGoal({ objective: "fixture goal" });
		expect(result.result.succeeded).toBe(true);
		expect(result.quotaBinding).toBeUndefined();
		expect(result.restarts).toBe(0);
		expect(spawnDaemon).toHaveBeenCalledOnce();
		expect(methods).toEqual(
			expect.arrayContaining([
				"initialize",
				"thread/start",
				"thread/goal/set",
				"turn/start",
			]),
		);
		expect(report).toHaveBeenCalledWith("quota_runtime_init_failed", cause);
		expect(logger).toHaveBeenCalledWith(
			"Codex quota rotation disabled for this launch",
		);
	} finally {
		runtime.stop();
		await runtime.drained();
	}
});

function daemonHarness(
	beforeCodexDaemonStart: Required<CodexQuotaDispatcherWiring>["beforeCodexDaemonStart"],
	home = "/fixture/legacy-home",
) {
	let receive: (frame: unknown) => void = () => {};
	const methods: string[] = [];
	const transport: DaemonTransport = {
		send(frame) {
			const request = frame as { id?: number; method: string };
			methods.push(request.method);
			if (request.id === undefined) return;
			const result =
				request.method === "thread/start"
					? { thread: { id: "fixture-thread" } }
					: request.method === "thread/goal/get"
						? { goal: null }
						: {};
			queueMicrotask(() => {
				receive({ id: request.id, result });
				if (request.method === "turn/start") {
					receive({
						method: "goal/updated",
						params: {
							threadId: "fixture-thread",
							turnId: "fixture-turn",
							goal: { status: "complete", tokensUsed: 1 },
						},
					});
				}
			});
		},
		onMessage(handler) {
			receive = handler;
		},
		onClose() {},
		close() {},
	};
	const child = Object.assign(new EventEmitter(), {
		pid: 1,
		exitCode: null,
		signalCode: null as string | null,
	});
	const spawnDaemon = vi.fn(
		async () =>
			({
				child,
				socketPath: "/tmp/quota-fail-open.sock",
				ensureDead: async () => true,
				stop() {
					child.signalCode = "SIGTERM";
					child.emit("exit");
				},
			}) as unknown as DaemonHandle,
	);
	const logger = vi.fn();
	const runtime = new CodexDaemonGoalRuntime({
		executionId: "fixture-execution",
		codexBin: "/fixture/codex",
		codexHomes: [home],
		cwd: "/fixture/work",
		socketPath: "/tmp/quota-fail-open.sock",
		beforeCodexDaemonStart,
		spawnDaemon,
		connectTransport: async () => transport,
		logger,
	});
	return { runtime, spawnDaemon, methods, logger };
}

it.each(["shared", "unshared"])(
	"ON preserves an intentional root pause for an unbound %s execution before any daemon spawn or retry",
	async (homeKind) => {
		const root = await mkdtemp(join(tmpdir(), "quota-pause-launch-"));
		const store = await StateStore.create(":memory:");
		let runtime: CodexDaemonGoalRuntime | undefined;
		try {
			const canonicalHome = join(root, "canonical");
			const home = join(root, "runner");
			await mkdir(canonicalHome);
			await mkdir(home);
			await writeFile(join(canonicalHome, "auth.json"), "business", {
				mode: 0o600,
			});
			await symlink(join(canonicalHome, "auth.json"), join(home, "auth.json"));
			for (const executionId of ["old-execution", "fixture-execution"])
				store.upsertSession({
					execution_id: executionId,
					issue_id: "FLY-2465",
					project_name: "fixture",
					status: "running",
				});
			const bind = createCodexQuotaLaunchBinder({
				store,
				canonicalHome,
				identify: () => ({ profile: "business", accountKey: "business" }),
			});
			const prior = await bind(home, "old-execution");
			store.codexQuota.recordSignal({
				executionId: "old-execution",
				bindingId: prior.bindingId,
			});
			expect(store.codexQuota.isExecutionPaused("fixture-execution")).toBe(
				false,
			);
			expect(store.codexQuota.isPaused(prior.credentialRootKey)).toBe(true);
			if (homeKind === "unshared") {
				await rm(join(home, "auth.json"));
				await writeFile(join(home, "auth.json"), "business", { mode: 0o600 });
			}
			const report = vi.fn();
			const dispatcher = {} as Required<CodexQuotaDispatcherWiring>;
			wireCodexQuotaDispatcher(
				dispatcher,
				store,
				{ beforeCodexDaemonStart: bind } as never,
				prior.credentialRootKey,
				{ enabled: () => true, report },
			);
			const harness = daemonHarness(dispatcher.beforeCodexDaemonStart, home);
			runtime = harness.runtime;
			await expect(
				runtime.runGoal({ objective: "fixture goal" }),
			).rejects.toThrow("codex_quota_pre_auth_rejected");
			expect(harness.spawnDaemon).not.toHaveBeenCalled();
			expect(harness.methods).toEqual([]);
			expect(report).not.toHaveBeenCalled();
		} finally {
			runtime?.stop();
			await runtime?.drained();
			store.close();
			await rm(root, { recursive: true, force: true });
		}
	},
);

it("ON infrastructure binding failure still completes a daemon goal with rotation disabled", async () => {
	const cause = new Error("quota_launch_home_not_shared");
	const report = vi.fn();
	const dispatcher = {} as Required<CodexQuotaDispatcherWiring>;
	wireCodexQuotaDispatcher(
		dispatcher,
		{
			codexQuota: { isPaused: () => false, isExecutionPaused: () => false },
		} as never,
		{
			beforeCodexDaemonStart: async () => {
				throw cause;
			},
		} as never,
		"root",
		{ enabled: () => true, report },
	);
	const { runtime, spawnDaemon, logger } = daemonHarness(
		dispatcher.beforeCodexDaemonStart,
	);
	try {
		const result = await runtime.runGoal({ objective: "fixture goal" });
		expect(result.result.succeeded).toBe(true);
		expect(result.quotaBinding).toBeUndefined();
		expect(result.restarts).toBe(0);
		expect(spawnDaemon).toHaveBeenCalledOnce();
		expect(report).toHaveBeenCalledWith("quota_runtime_bind_failed", cause);
		expect(logger).toHaveBeenCalledWith(
			"Codex quota rotation disabled for this launch",
		);
	} finally {
		runtime.stop();
		await runtime.drained();
	}
});
