import { describe, expect, it } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import type { StateStore, WorkflowGateHolderRow } from "../../StateStore.js";
import {
	resolveFounderGateBotToken,
	resolveLeadIdentityForShadowDeclaration,
} from "../founder-gate-bot-token.js";

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

	it("preserves the first Lead token fallback when source labels are empty", () => {
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
			getSession: () => ({ execution_id: "source" }),
			getSessionLabels: () => [],
		} as unknown as StateStore;

		expect(
			resolveFounderGateBotToken({
				store,
				projects,
				holder: {
					run_id: "run-1",
					source_execution_id: "source",
				} as WorkflowGateHolderRow,
				fallbackToken: "global-token",
			}),
		).toBe("product-token");
	});

	it("preserves fallbackToken for unmatched labels when the first Lead has no token", () => {
		const projects = [
			{
				projectName: "flywheel",
				projectRoot: "/repo",
				leads: [
					{
						agentId: "product-lead",
						chatChannel: "product-channel",
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
			getSession: () => ({ execution_id: "source" }),
			getSessionLabels: () => ["Unknown"],
		} as unknown as StateStore;

		expect(
			resolveFounderGateBotToken({
				store,
				projects,
				holder: {
					run_id: "run-1",
					source_execution_id: "source",
				} as WorkflowGateHolderRow,
				fallbackToken: "global-token",
			}),
		).toBe("global-token");
	});

	it("rejects a general Lead fallback for shadow declarations", () => {
		const projects = [
			{
				projectName: "flywheel",
				projectRoot: "/repo",
				leads: [
					{
						agentId: "eng-lead",
						chatChannel: "eng-channel",
						botToken: "eng-token",
						botUserId: "12345678901234567",
						match: { labels: ["Engineering"] },
					},
				],
			},
		] as ProjectEntry[];
		const store = {
			getWorkflowRun: () => ({ project_name: "flywheel" }),
			getSession: () => ({ execution_id: "source" }),
			getSessionLabels: () => [],
		} as unknown as StateStore;

		expect(
			resolveLeadIdentityForShadowDeclaration({
				store,
				projects,
				holder: {
					run_id: "run-1",
					source_execution_id: "source",
				} as WorkflowGateHolderRow,
			}),
		).toMatchObject({ ok: false });
	});

	it("returns the label-matched Lead identity for shadow declarations", () => {
		const projects = [
			{
				projectName: "flywheel",
				projectRoot: "/repo",
				leads: [
					{
						agentId: "product-lead",
						chatChannel: "product-channel",
						botToken: "product-token",
						botUserId: "12345678901234567",
						match: { labels: ["Product"] },
					},
					{
						agentId: "eng-lead",
						chatChannel: "eng-channel",
						botToken: "eng-token",
						botUserId: "22345678901234567",
						match: { labels: ["Engineering"] },
					},
				],
			},
		] as ProjectEntry[];
		const store = {
			getWorkflowRun: () => ({ project_name: "flywheel" }),
			getSession: () => ({ execution_id: "source" }),
			getSessionLabels: () => ["Engineering"],
		} as unknown as StateStore;

		expect(
			resolveLeadIdentityForShadowDeclaration({
				store,
				projects,
				holder: {
					run_id: "run-1",
					source_execution_id: "source",
				} as WorkflowGateHolderRow,
			}),
		).toEqual({
			ok: true,
			agentId: "eng-lead",
			botToken: "eng-token",
			botUserId: "22345678901234567",
			chatChannel: "eng-channel",
		});
	});
});
