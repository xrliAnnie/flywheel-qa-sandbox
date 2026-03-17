import type { SlackAction as ChatAction } from "flywheel-edge-worker";
import { describe, expect, it, vi } from "vitest";
import {
	createReactionsEngine,
	ProjectAwareApproveHandler,
} from "../ActionExecutor.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { Session, StateStore } from "../StateStore.js";

const projects: ProjectEntry[] = [
	{
		projectName: "geoforge",
		projectRoot: "/home/user/geoforge",
		projectRepo: "xrliAnnie/GeoForge3D",
	},
];

function makeAction(overrides: Partial<ChatAction> = {}): ChatAction {
	return {
		actionId: "flywheel_approve_GEO-95",
		issueId: "GEO-95",
		action: "approve",
		userId: "U123",
		responseUrl: "https://hooks.slack.com/resp",
		messageTs: "123.456",
		executionId: "exec-1",
		...overrides,
	};
}

function makeStore(session?: Session) {
	return {
		getSession: vi.fn().mockReturnValue(session),
		getLatestActionableSession: vi.fn().mockReturnValue(session),
	} as unknown as StateStore;
}

const session: Session = {
	execution_id: "exec-1",
	issue_id: "GEO-95",
	project_name: "geoforge",
	status: "awaiting_review",
};

describe("ProjectAwareApproveHandler", () => {
	it("looks up session + project and delegates to ApproveHandler", async () => {
		const execFn = vi
			.fn()
			.mockResolvedValueOnce({
				stdout: JSON.stringify([
					{ number: 42, url: "https://github.com/pr/42" },
				]),
			})
			.mockResolvedValueOnce({ stdout: "" });

		const store = makeStore(session);
		const handler = new ProjectAwareApproveHandler(projects, store, execFn);
		const result = await handler.execute(makeAction());

		expect(result.success).toBe(true);
		expect(result.message).toContain("PR #42 merged");
		expect(execFn).toHaveBeenCalledWith(
			"gh",
			expect.arrayContaining(["pr", "list"]),
			"/home/user/geoforge",
		);
	});

	it("returns error if session not found", async () => {
		const store = makeStore(undefined);
		const handler = new ProjectAwareApproveHandler(projects, store, vi.fn());
		const result = await handler.execute(makeAction());

		expect(result.success).toBe(false);
		expect(result.message).toContain("No session found");
	});

	it("returns error if project not found", async () => {
		const store = makeStore({ ...session, project_name: "unknown-project" });
		const handler = new ProjectAwareApproveHandler(projects, store, vi.fn());
		const result = await handler.execute(makeAction());

		expect(result.success).toBe(false);
		expect(result.message).toContain("No project config");
	});
});

describe("createReactionsEngine", () => {
	it("returns engine with all handlers", () => {
		const store = makeStore();
		const engine = createReactionsEngine(projects, store);
		expect(engine).toBeDefined();
	});

	it("stub handler for retry returns acknowledgment", async () => {
		const store = makeStore();
		const engine = createReactionsEngine(projects, store);
		const result = await engine.dispatch(
			makeAction({ action: "retry", actionId: "flywheel_retry_GEO-95" }),
		);

		expect(result.success).toBe(true);
		expect(result.message).toContain("stub");
	});
});
