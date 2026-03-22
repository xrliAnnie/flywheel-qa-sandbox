import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateBootstrap } from "../bridge/bootstrap-generator.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

function makeMockMemoryService(overrides?: {
	primary?: string[];
	secondary?: string[];
	primaryError?: Error;
	secondaryError?: Error;
}) {
	const primary = overrides?.primary ?? ["role memory 1", "role memory 2"];
	const secondary = overrides?.secondary ?? ["global memory 1"];
	const primaryError = overrides?.primaryError;
	const secondaryError = overrides?.secondaryError;

	return {
		searchMemories: vi
			.fn()
			.mockImplementation((params: { agentId?: string; limit?: number }) => {
				if (params.agentId) {
					if (primaryError) return Promise.reject(primaryError);
					return Promise.resolve(primary);
				}
				if (secondaryError) return Promise.reject(secondaryError);
				return Promise.resolve(secondary);
			}),
		addMessages: vi.fn().mockResolvedValue({ added: 0, updated: 0 }),
		addSessionMemory: vi.fn().mockResolvedValue({ added: 0, updated: 0 }),
		searchAndFormat: vi.fn().mockResolvedValue(null),
	};
}

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
			JSON.stringify({
				event_type: "session_completed",
				execution_id: "exec-1",
				issue_id: "issue-1",
			}),
			"flywheel:GEO-100",
		);
		store.markLeadEventDelivered(seq);

		const bootstrap = await generateBootstrap("product-lead", store, projects);
		expect(bootstrap.recentEvents).toHaveLength(1);
		expect(bootstrap.recentEvents[0]!.event.event_type).toBe(
			"session_completed",
		);
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

describe("Bootstrap Generator — Memory Recall (GEO-203)", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => {
		store.close();
	});

	it("memoryRecall is null when no memoryService provided (backward compat)", async () => {
		const bootstrap = await generateBootstrap("product-lead", store, projects);
		expect(bootstrap.memoryRecall).toBeNull();
	});

	it("includes primary + secondary memories when both return content", async () => {
		const ms = makeMockMemoryService({
			primary: ["decision A", "decision B"],
			secondary: ["global context X"],
		});
		const bootstrap = await generateBootstrap(
			"product-lead",
			store,
			projects,
			ms as any,
		);
		expect(bootstrap.memoryRecall).not.toBeNull();
		expect(bootstrap.memoryRecall).toContain("### Role-Specific Memory");
		expect(bootstrap.memoryRecall).toContain("decision A");
		expect(bootstrap.memoryRecall).toContain("decision B");
		expect(bootstrap.memoryRecall).toContain("### Project-Wide Context");
		expect(bootstrap.memoryRecall).toContain("global context X");
	});

	it("includes only role-specific when secondary is empty", async () => {
		const ms = makeMockMemoryService({
			primary: ["decision A"],
			secondary: [],
		});
		const bootstrap = await generateBootstrap(
			"product-lead",
			store,
			projects,
			ms as any,
		);
		expect(bootstrap.memoryRecall).toContain("### Role-Specific Memory");
		expect(bootstrap.memoryRecall).not.toContain("### Project-Wide Context");
	});

	it("memoryRecall is null when both primary and secondary are empty", async () => {
		const ms = makeMockMemoryService({
			primary: [],
			secondary: [],
		});
		const bootstrap = await generateBootstrap(
			"product-lead",
			store,
			projects,
			ms as any,
		);
		expect(bootstrap.memoryRecall).toBeNull();
	});

	it("memoryRecall is null when memoryService throws", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const ms = makeMockMemoryService({
			primaryError: new Error("Supabase down"),
			secondaryError: new Error("Supabase down"),
		});
		const bootstrap = await generateBootstrap(
			"product-lead",
			store,
			projects,
			ms as any,
		);
		expect(bootstrap.memoryRecall).toBeNull();
		// Other fields still populated
		expect(bootstrap.leadId).toBe("product-lead");
		warnSpy.mockRestore();
	});

	it("returns project-wide only when primary fails but secondary succeeds", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const ms = makeMockMemoryService({
			primaryError: new Error("timeout"),
			secondary: ["global insight"],
		});
		const bootstrap = await generateBootstrap(
			"product-lead",
			store,
			projects,
			ms as any,
		);
		expect(bootstrap.memoryRecall).toContain("### Project-Wide Context");
		expect(bootstrap.memoryRecall).toContain("global insight");
		expect(bootstrap.memoryRecall).not.toContain("### Role-Specific Memory");
		warnSpy.mockRestore();
	});

	it("returns role-specific only when secondary fails but primary succeeds", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const ms = makeMockMemoryService({
			primary: ["my decision"],
			secondaryError: new Error("timeout"),
		});
		const bootstrap = await generateBootstrap(
			"product-lead",
			store,
			projects,
			ms as any,
		);
		expect(bootstrap.memoryRecall).toContain("### Role-Specific Memory");
		expect(bootstrap.memoryRecall).toContain("my decision");
		expect(bootstrap.memoryRecall).not.toContain("### Project-Wide Context");
		warnSpy.mockRestore();
	});

	it("deduplicates secondary memories that overlap with primary", async () => {
		const ms = makeMockMemoryService({
			primary: ["shared memory", "unique primary"],
			secondary: ["shared memory", "unique secondary"],
		});
		const bootstrap = await generateBootstrap(
			"product-lead",
			store,
			projects,
			ms as any,
		);
		expect(bootstrap.memoryRecall).not.toBeNull();
		// "shared memory" should only appear once (in primary)
		const matches = bootstrap.memoryRecall!.match(/shared memory/g);
		expect(matches).toHaveLength(1);
		expect(bootstrap.memoryRecall).toContain("unique primary");
		expect(bootstrap.memoryRecall).toContain("unique secondary");
	});

	it("calls searchMemories with correct params for primary and secondary", async () => {
		const ms = makeMockMemoryService();
		await generateBootstrap("product-lead", store, projects, ms as any);
		// Primary call: agentId = leadId, limit = 10
		expect(ms.searchMemories).toHaveBeenCalledWith(
			expect.objectContaining({
				projectName: "geoforge3d",
				agentId: "product-lead",
				limit: 10,
			}),
		);
		// Secondary call: no agentId, limit = 5
		expect(ms.searchMemories).toHaveBeenCalledWith(
			expect.objectContaining({
				projectName: "geoforge3d",
				limit: 5,
			}),
		);
		// Secondary call should NOT have agentId
		const secondaryCall = ms.searchMemories.mock.calls.find(
			(call: any[]) => !call[0].agentId,
		);
		expect(secondaryCall).toBeDefined();
	});
});
