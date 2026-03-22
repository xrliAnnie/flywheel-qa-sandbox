import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateBootstrap } from "../bridge/bootstrap-generator.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const projects: ProjectEntry[] = [
	{
		projectName: "geoforge3d",
		projectRoot: "/tmp/geoforge3d",
		leads: [
			{
				agentId: "product-lead",
				forumChannel: "forum-1",
				chatChannel: "chat-1",
				match: { labels: ["Product"] },
			},
			{
				agentId: "ops-lead",
				forumChannel: "forum-2",
				chatChannel: "chat-2",
				match: { labels: ["Operations"] },
			},
		],
	},
];

describe("Bootstrap Generator (GEO-195)", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => {
		store.close();
	});

	it("returns empty bootstrap for a lead with no activity", async () => {
		const bootstrap = await generateBootstrap("product-lead", store, projects);
		expect(bootstrap.leadId).toBe("product-lead");
		expect(bootstrap.activeSessions).toHaveLength(0);
		expect(bootstrap.pendingDecisions).toHaveLength(0);
		expect(bootstrap.recentFailures).toHaveLength(0);
		expect(bootstrap.recentEvents).toHaveLength(0);
		expect(bootstrap.memoryRecall).toBeNull();
	});

	it("includes active sessions matching the lead", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			issue_identifier: "GEO-100",
			issue_title: "Fix bug",
			project_name: "geoforge3d",
			status: "running",
			issue_labels: JSON.stringify(["Product"]),
		});
		store.upsertSession({
			execution_id: "exec-2",
			issue_id: "issue-2",
			project_name: "geoforge3d",
			status: "running",
			issue_labels: JSON.stringify(["Operations"]),
		});

		const bootstrap = await generateBootstrap("product-lead", store, projects);
		expect(bootstrap.activeSessions).toHaveLength(1);
		expect(bootstrap.activeSessions[0]!.executionId).toBe("exec-1");
		expect(bootstrap.activeSessions[0]!.issueIdentifier).toBe("GEO-100");
	});

	it("includes pending decisions (awaiting_review)", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			issue_identifier: "GEO-100",
			project_name: "geoforge3d",
			status: "awaiting_review",
			issue_labels: JSON.stringify(["Product"]),
		});

		const bootstrap = await generateBootstrap("product-lead", store, projects);
		expect(bootstrap.pendingDecisions).toHaveLength(1);
		expect(bootstrap.pendingDecisions[0]!.executionId).toBe("exec-1");
	});

	it("includes recent failures", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "failed",
			last_error: "Something broke",
			issue_labels: JSON.stringify(["Product"]),
		});

		const bootstrap = await generateBootstrap("product-lead", store, projects);
		expect(bootstrap.recentFailures).toHaveLength(1);
		expect(bootstrap.recentFailures[0]!.lastError).toBe("Something broke");
	});

	it("includes recently delivered events from journal", async () => {
		const seq = store.appendLeadEvent(
			"product-lead",
			"evt-1",
			"session_completed",
			JSON.stringify({ event_type: "session_completed", execution_id: "exec-1", issue_id: "issue-1" }),
			"flywheel:GEO-100",
		);
		store.markLeadEventDelivered(seq);

		const bootstrap = await generateBootstrap("product-lead", store, projects);
		expect(bootstrap.recentEvents).toHaveLength(1);
		expect(bootstrap.recentEvents[0]!.event.event_type).toBe("session_completed");
	});

	it("is idempotent — multiple calls produce same result", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "running",
			issue_labels: JSON.stringify(["Product"]),
		});

		const b1 = await generateBootstrap("product-lead", store, projects);
		const b2 = await generateBootstrap("product-lead", store, projects);
		expect(b1.activeSessions).toEqual(b2.activeSessions);
		expect(b1.pendingDecisions).toEqual(b2.pendingDecisions);
	});
});
