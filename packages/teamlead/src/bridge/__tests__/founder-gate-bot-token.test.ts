import { describe, expect, it } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import type { StateStore, WorkflowGateHolderRow } from "../../StateStore.js";
import { resolveFounderGateBotToken } from "../founder-gate-bot-token.js";

describe("founder gate Discord token selection", () => {
	it("selects the Lead matching the holder source session labels", () => {
		const projects = [
			{
				projectName: "flywheel",
				projectRoot: "/repo",
				leads: [
					{
						agentId: "product-lead",
						chatChannel: "product-channel",
						botToken: "product-token",
						match: { labels: ["Product"] },
					},
					{
						agentId: "eng-lead",
						chatChannel: "eng-channel",
						botToken: "eng-token",
						match: { labels: ["Engineering"] },
					},
				],
			},
		] as ProjectEntry[];
		const store = {
			getWorkflowRun: () => ({ project_name: "flywheel" }),
			getSession: (executionId: string) =>
				executionId === "qa-engineering"
					? { execution_id: executionId }
					: undefined,
			getSessionLabels: () => ["Engineering"],
		} as unknown as StateStore;
		const holder = {
			run_id: "run-1",
			source_execution_id: "qa-engineering",
		} as WorkflowGateHolderRow;

		expect(
			resolveFounderGateBotToken({
				store,
				projects,
				holder,
				fallbackToken: "global-token",
			}),
		).toBe("eng-token");
	});

	it("fails closed when the holder source session is unavailable", () => {
		const store = {
			getWorkflowRun: () => ({ project_name: "flywheel" }),
			getSession: () => undefined,
		} as unknown as StateStore;
		expect(
			resolveFounderGateBotToken({
				store,
				projects: [],
				holder: {
					run_id: "run-1",
					source_execution_id: "missing",
				} as WorkflowGateHolderRow,
				fallbackToken: "global-token",
			}),
		).toBeUndefined();
	});
});
