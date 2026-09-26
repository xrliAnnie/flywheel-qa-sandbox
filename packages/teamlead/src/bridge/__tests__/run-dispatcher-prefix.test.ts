import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlueprintContext } from "flywheel-edge-worker/dist/Blueprint.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkflowPrefixFixture } from "../../__tests__/fixtures/workflow-prefix.js";
import type { StateStore } from "../../StateStore.js";
import type { FlagStoreRuntime } from "../flag-store-runtime.js";
import { type ProjectRuntime, RunDispatcher } from "../run-dispatcher.js";
import { createRunInfraDispatcher } from "../run-infra.js";

class NoExternalCommDispatcher extends RunDispatcher {
	protected override preRegisterCommDb(): void {}
	protected override cleanupPreRegistration(): void {}
}
const roots: string[] = [];
beforeEach(() => {
	// A stale role-v1 env must never enable the profile: only the pinned node declaration does.
	vi.stubEnv("FLYWHEEL_RUNNER_PREFIX_PROFILE", "role-v1");
	vi.stubEnv("FLYWHEEL_RUNNER_BACKEND", "claude-tmux");
	vi.stubEnv(
		"FLYWHEEL_RUNNER_DISABLED_PLUGINS",
		"serena@claude-plugins-official",
	);
	vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function harness(profile: "legacy" | "role-v1" | undefined = "role-v1") {
	const root = mkdtempSync(join(tmpdir(), "fly2913-dispatch-prefix-"));
	roots.push(root);
	const pinned = createWorkflowPrefixFixture(
		root,
		3,
		"tpl_code",
		profile ? { prefix_profile: profile } : {},
	);
	const captures: BlueprintContext[] = [];
	const store = {
		getWorkflowExecutionRuntime: vi.fn((executionId: string) => ({
			execution_id: executionId,
			run_id: pinned.run.run_id,
			node_id: pinned.nodeId,
			attempt: 1,
			vendor: "claude",
			model: "claude-fable-5",
			effort: "high",
			resolved_family: "claude",
			capabilities_digest: "a".repeat(64),
			created_at: new Date(0).toISOString(),
		})),
		getWorkflowRun: vi.fn(() => pinned.run),
		getSession: vi.fn(() => undefined),
		getSkillFrameworkStamp: vi.fn(() => undefined),
	};
	const flagRows = new Map<
		string,
		{ hasOverride: boolean; raw: string | null }
	>([
		["skill_framework_mode", { hasOverride: false, raw: null }],
		["runner_prefix_profile", { hasOverride: true, raw: "legacy" }],
	]);
	const flagStore = {
		mode: "ready" as const,
		store: {
			getFlagValueRow: vi.fn((name: string) => flagRows.get(name)),
		},
	};
	const runtime = {
		blueprint: {
			run: vi.fn(
				async (_name: unknown, _root: string, ctx: BlueprintContext) => {
					captures.push(ctx);
					return { success: true };
				},
			),
		},
		projectRoot: root,
		tmuxSessionName: "fixture",
		agentDispatcher: { dispatchByName: vi.fn() },
	} as unknown as ProjectRuntime;
	const dispatcher = createRunInfraDispatcher({
		store: store as unknown as StateStore,
		projectRuntimes: new Map([["fixture", runtime]]),
		cleanupHandles: [],
		dispatcherClass: NoExternalCommDispatcher,
		flagStore: flagStore as unknown as FlagStoreRuntime,
	});
	return { dispatcher, store, captures, pinned, flagStore, flagRows };
}

describe("real dispatcher prefix provenance wiring", () => {
	it.each(["start", "retry", "resume"] as const)(
		"threads pinned engineering context through %s without relying on request role or generalized payload",
		async (lane) => {
			const { dispatcher, store, captures, pinned } = harness();
			const request = {
				issueId: "FLY-2913-fixture",
				projectName: "fixture",
				sessionRole: "main",
			};
			if (lane === "retry")
				await dispatcher.dispatch({
					...request,
					oldExecutionId: "old-exec",
					runAttempt: 2,
				});
			else
				await dispatcher.start({
					...request,
					...(lane === "resume"
						? { previousSession: { sessionId: "prior-native-session" } }
						: {}),
				});
			await dispatcher.drain();
			expect(captures).toHaveLength(1);
			expect(store.getWorkflowExecutionRuntime).toHaveBeenCalledWith(
				captures[0]!.executionId,
			);
			expect(captures[0]!.runnerMcpProfile).toMatchObject({
				prefix: {
					selection: {
						mode: "role-v1",
						role: "implement",
						taskSetId: "engineering",
						workflow: {
							runId: pinned.run.run_id,
							snapshotDigest: pinned.snapshot.snapshot_digest,
						},
					},
					context: {
						phase: "implement",
						nodeId: pinned.nodeId,
						agent: pinned.snapshot.resolved.nodes.find(
							(n) => n.id === pinned.nodeId,
						)!.agent,
					},
				},
			});
		},
	);
	it.each(["legacy", "full-mcp", "codex"])(
		"keeps legacy settings for %s",
		async (bypass) => {
			const { dispatcher, store, captures } = harness(
				bypass === "legacy" ? "legacy" : "role-v1",
			);
			if (bypass === "codex")
				vi.stubEnv("FLYWHEEL_RUNNER_BACKEND", "codex-tmux");
			await dispatcher.start({
				issueId: "FLY-2913-fixture",
				projectName: "fixture",
				issueLabels: bypass === "full-mcp" ? ["full-mcp"] : [],
			});
			await dispatcher.drain();
			if (bypass === "codex")
				expect(store.getWorkflowExecutionRuntime).not.toHaveBeenCalled();
			expect(captures[0]!.runnerMcpProfile?.prefix).toBeUndefined();
			if (bypass !== "codex")
				expect(captures[0]!.runnerPrefixAudit).toMatchObject({
					workflow: { templateRevision: 2 },
					effectiveProfile: "legacy",
					fallbackReason: bypass === "full-mcp" ? "full-mcp" : "node-legacy",
				});
			else expect(captures[0]!).not.toHaveProperty("runnerPrefixAudit");
		},
	);
	it("ignores stale store rows and keeps the same run profile across launches", async () => {
		const { dispatcher, captures, flagRows, flagStore } = harness();
		for (const [index, raw] of ["legacy", "role-v1", "legacy"].entries()) {
			flagRows.set("runner_prefix_profile", { hasOverride: true, raw });
			await dispatcher.start({
				issueId: `FLY-2913-fixture-${index}`,
				projectName: "fixture",
			});
			await dispatcher.drain();
		}
		expect(
			captures.map((c) => c.runnerMcpProfile?.prefix?.selection.mode),
		).toEqual(["role-v1", "role-v1", "role-v1"]);
		expect(flagStore.store.getFlagValueRow).not.toHaveBeenCalledWith(
			"runner_prefix_profile",
		);
	});
	it("keeps unbound and non-engineering triggers on the original profile", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const { dispatcher, store, captures, pinned } = harness();
		pinned.run.template_id = "tpl_research";
		await dispatcher.start({
			issueId: "FLY-2913-fixture",
			projectName: "fixture",
			sessionRole: "implement",
		});
		await dispatcher.drain();
		expect(captures[0]!.runnerMcpProfile).toEqual({
			disabledPlugins: ["serena@claude-plugins-official"],
			disableChrome: false,
			enabledPluginsExtra: [],
		});
		expect(store.getWorkflowExecutionRuntime).toHaveBeenCalledOnce();
		expect(info.mock.calls.flat().join("\n")).toMatch(
			/FLY-2913 prefix legacy reason=unmapped-trigger exec=/,
		);
	});
	it("falls back to legacy with a visible reason when pinned provenance is corrupt", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const { dispatcher, pinned, captures } = harness();
		pinned.run.snapshot = "corrupt";
		await dispatcher.start({
			issueId: "FLY-2913-fixture",
			projectName: "fixture",
		});
		await dispatcher.drain();
		expect(captures).toHaveLength(1);
		expect(captures[0]!.runnerMcpProfile?.prefix).toBeUndefined();
		expect(info.mock.calls.flat().join("\n")).toMatch(
			/FLY-2913 prefix legacy reason=provenance-error:workflow_prefix_context/,
		);
	});
	it("does not let a missing store row disable a pinned role-v1 node", async () => {
		const { dispatcher, captures, flagRows } = harness();
		flagRows.delete("runner_prefix_profile");
		await dispatcher.start({
			issueId: "FLY-2913-fixture",
			projectName: "fixture",
		});
		await dispatcher.drain();
		expect(captures[0]!.runnerMcpProfile?.prefix?.selection.mode).toBe(
			"role-v1",
		);
	});
});
