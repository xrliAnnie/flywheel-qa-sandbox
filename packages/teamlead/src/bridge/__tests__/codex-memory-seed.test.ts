import {
	AuditLogger,
	CipherReader,
	HookCallbackServer,
} from "flywheel-edge-worker";
import { Blueprint } from "flywheel-edge-worker/dist/Blueprint.js";
import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../StateStore.js";
import {
	createCodexMemorySeedSourcesLoader,
	createRunBlueprint,
	loadCodexMemorySeedSources,
} from "../run-infra.js";

function session(
	executionId: string,
	overrides: Partial<Session> = {},
): Session {
	return {
		execution_id: executionId,
		issue_id: `issue-${executionId}`,
		issue_identifier: `FLY-${executionId}`,
		issue_title: `Task ${executionId}`,
		started_at: "2026-07-19 18:36:36",
		project_name: "flywheel",
		workflow_node_id: "implement",
		adapter_type: "codex-tmux",
		status: "completed",
		...overrides,
	};
}

describe("loadCodexMemorySeedSources", () => {
	it("admits only terminal legacy sessions with the exact project and workflow node", () => {
		const rows = [
			session("valid"),
			session("valid-canceled", { status: "canceled" }),
			session("current"),
			session("wrong-project", { project_name: "joycon-typeless" }),
			session("wrong-role", { workflow_node_id: "qa" }),
			session("case-role", { workflow_node_id: "Implement" }),
			session("missing-role", { workflow_node_id: undefined }),
			session("wrong-adapter", { adapter_type: "claude-tmux" }),
			session("still-live", { status: "design_done" }),
			session("keyed"),
			session("prepublished"),
			session("unknown"),
		];
		const getProjectSessions = vi.fn(() => rows);
		const resolveHome = vi.fn((executionId: string) => {
			if (executionId === "keyed") {
				return {
					kind: "keyed" as const,
					project: "flywheel",
					role: "implement",
					home: "/homes/agents/flywheel/implement",
				};
			}
			if (executionId === "prepublished") {
				return {
					kind: "prepublished" as const,
					project: "flywheel",
					role: "implement",
					home: "/homes/agents/flywheel/implement",
				};
			}
			if (executionId === "unknown") {
				return { kind: "unknown" as const, reason: "unsafe_session_state" };
			}
			return { kind: "legacy" as const, home: `/homes/${executionId}` };
		});

		const result = loadCodexMemorySeedSources({
			store: { getProjectSessions },
			identity: { project: "flywheel", role: "implement" },
			currentExecutionId: "current",
			resolveHome,
		});

		expect(getProjectSessions).toHaveBeenCalledWith("flywheel");
		expect(result.sources).toEqual([
			{
				executionId: "valid",
				issueId: "issue-valid",
				issueIdentifier: "FLY-valid",
				issueTitle: "Task valid",
				startedAt: "2026-07-19 18:36:36",
			},
			{
				executionId: "valid-canceled",
				issueId: "issue-valid-canceled",
				issueIdentifier: "FLY-valid-canceled",
				issueTitle: "Task valid-canceled",
				startedAt: "2026-07-19 18:36:36",
			},
		]);
		expect(result.skipped).toEqual([
			{ executionId: "case-role", reason: "role_mismatch" },
			{ executionId: "current", reason: "current_execution" },
			{ executionId: "keyed", reason: "keyed_home" },
			{ executionId: "missing-role", reason: "missing_role" },
			{ executionId: "prepublished", reason: "prepublished_home" },
			{ executionId: "still-live", reason: "non_terminal" },
			{ executionId: "unknown", reason: "unknown_home" },
			{ executionId: "wrong-adapter", reason: "adapter_mismatch" },
			{ executionId: "wrong-project", reason: "project_mismatch" },
			{ executionId: "wrong-role", reason: "role_mismatch" },
		]);
	});

	it("propagates a project-session query failure", () => {
		expect(() =>
			loadCodexMemorySeedSources({
				store: {
					getProjectSessions: () => {
						throw new Error("database unavailable");
					},
				},
				identity: { project: "flywheel", role: "implement" },
				currentExecutionId: "current",
				resolveHome: () => ({ kind: "legacy", home: "/unused" }),
			}),
		).toThrow("database unavailable");
	});

	it("binds the production loader to the project-scoped store", async () => {
		const getProjectSessions = vi.fn(() => [session("valid")]);
		const loader = createCodexMemorySeedSourcesLoader({ getProjectSessions });

		expect(
			await loader({
				project: "flywheel",
				role: "implement",
				currentExecutionId: "current",
			}),
		).toMatchObject({
			sources: [{ executionId: "valid" }],
		});
		expect(getProjectSessions).toHaveBeenCalledWith("flywheel");
	});

	it("passes the memory loader through the production Blueprint factory", async () => {
		vi.stubEnv("FLYWHEEL_COMM_BACKEND", "commdb");
		vi.spyOn(HookCallbackServer.prototype, "start").mockResolvedValue(0);
		vi.spyOn(HookCallbackServer.prototype, "stop").mockResolvedValue();
		vi.spyOn(AuditLogger.prototype, "init").mockResolvedValue();
		vi.spyOn(AuditLogger.prototype, "close").mockResolvedValue();
		vi.spyOn(CipherReader.prototype, "loadActivePrinciples").mockResolvedValue(
			[],
		);
		const setSeedSources = vi.spyOn(
			Blueprint.prototype,
			"setCodexMemorySeedSources",
		);
		const loader = vi.fn();

		try {
			const { cleanup } = await createRunBlueprint(
				"fly2359-memory-seed-test",
				vi.fn() as never,
				{} as never,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				loader,
			);
			await cleanup();

			expect(setSeedSources).toHaveBeenCalledOnce();
			expect(setSeedSources).toHaveBeenCalledWith(loader);
		} finally {
			vi.unstubAllEnvs();
			vi.restoreAllMocks();
		}
	});
});
