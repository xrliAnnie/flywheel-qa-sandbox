import { afterEach, describe, expect, it, vi } from "vitest";
import { legacyWorkflowSeeds } from "../../__tests__/fixtures/legacy-workflow-manifests.js";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import { resolveWorkflowRunAlertIdentity } from "../plugin.js";

const WORKFLOW_ON = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
};

const projects: ProjectEntry[] = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/flywheel",
		leads: [
			{
				agentId: "default-lead",
				chatChannel: "default-channel",
				match: { labels: ["ops"] },
			},
			{
				agentId: "owning-lead",
				chatChannel: "owner-channel",
				match: { labels: ["engineering"] },
			},
		],
	},
];

const stores: StateStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

async function runSelectedBy(selectedBy: string): Promise<StateStore> {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const seed = legacyWorkflowSeeds().find(
		(candidate) => candidate.templateId === "tpl_eng_heavy",
	)!;
	store.importWorkflowTemplateSeed(seed);
	store.materializeWorkflowRun({
		runId: "run-1",
		issueId: "FLY-1415",
		projectName: "flywheel",
		taskCategory: "code",
		templateId: seed.templateId,
		claimsReadEnrolled: true,
		actor: "lead",
		env: WORKFLOW_ON,
		selection: {
			source: "lead",
			selectedBy,
			reason: "issue owner",
		},
		startReservation: {
			idempotencyKey: "start-1",
			selectionDigest: "selection-1",
			nodeId: "design",
			attempt: 1,
			executionId: "design-1",
			createdAt: "2026-07-21T00:00:00.000Z",
		},
	});
	return store;
}

describe("workflow-engine alert owning-Lead routing", () => {
	it("resolves an unbound alert to the owning project without fallback logging", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const log = vi.fn();

		expect(
			resolveWorkflowRunAlertIdentity({
				store,
				projects,
				defaultLeadAgentId: "fleet-default-lead",
				projectName: "flywheel",
				issueId: "FLY-2248",
				runId: null,
				log,
			}),
		).toEqual({
			leadId: "default-lead",
			projectName: "flywheel",
			leadResolution: "resolved",
		});
		expect(log).not.toHaveBeenCalled();
	});

	it("uses the durable run owner when the dead execution has no session row", async () => {
		const store = await runSelectedBy("owning-lead");

		expect(
			resolveWorkflowRunAlertIdentity({
				store,
				projects,
				defaultLeadAgentId: "default-lead",
				projectName: "flywheel",
				issueId: "FLY-1415",
				runId: "run-1",
			}),
		).toEqual({
			leadId: "owning-lead",
			projectName: "flywheel",
			leadResolution: "resolved",
		});
	});

	it("uses session labels when the durable selected_by value is not configured", async () => {
		const store = await runSelectedBy("retired-lead");
		store.upsertSession({
			execution_id: "dead-exec",
			issue_id: "FLY-1415",
			project_name: "flywheel",
			status: "failed",
			issue_labels: JSON.stringify(["engineering"]),
		});

		expect(
			resolveWorkflowRunAlertIdentity({
				store,
				projects,
				defaultLeadAgentId: "default-lead",
				projectName: "flywheel",
				issueId: "FLY-1415",
				runId: "run-1",
			}),
		).toEqual({
			leadId: "owning-lead",
			projectName: "flywheel",
			leadResolution: "resolved",
		});
	});

	it("falls back loudly when session labels only produce the project's general lead", async () => {
		const store = await runSelectedBy("retired-lead");
		store.upsertSession({
			execution_id: "dead-exec",
			issue_id: "FLY-1415",
			project_name: "flywheel",
			status: "failed",
			issue_labels: JSON.stringify(["unmatched-label"]),
		});
		const log = vi.fn();

		expect(
			resolveWorkflowRunAlertIdentity({
				store,
				projects,
				defaultLeadAgentId: "fleet-default-lead",
				projectName: "flywheel",
				issueId: "FLY-1415",
				runId: "run-1",
				log,
			}),
		).toEqual({
			leadId: "fleet-default-lead",
			projectName: "flywheel",
			leadResolution: "fallback",
		});
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("no configured run owner or session-label owner"),
		);
	});

	it("falls back loudly only when neither durable owner nor session labels resolve", async () => {
		const store = await runSelectedBy("unassigned");
		const log = vi.fn();

		expect(
			resolveWorkflowRunAlertIdentity({
				store,
				projects,
				defaultLeadAgentId: "default-lead",
				projectName: "flywheel",
				issueId: "FLY-1415",
				runId: "run-1",
				log,
			}),
		).toEqual({
			leadId: "default-lead",
			projectName: "flywheel",
			leadResolution: "fallback",
		});
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("no configured run owner or session-label owner"),
		);
	});
});
