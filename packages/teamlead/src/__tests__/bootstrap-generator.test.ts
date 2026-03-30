import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	findProjectForLead,
	generateBootstrap,
} from "../bridge/bootstrap-generator.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";
import type { MemoryService } from "flywheel-edge-worker";

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
		memoryAllowedUsers: ["product-lead", "ops-lead", "geoforge3d"],
	},
	{
		projectName: "other-project",
		projectRoot: "/tmp/other-project",
		leads: [
			{
				agentId: "other-lead",
				chatChannel: "chat-other",
				match: { labels: ["Other"] },
			},
		],
	},
];

function mockMemoryService(
	overrides?: Partial<MemoryService>,
): MemoryService {
	return {
		searchMemories: vi.fn().mockResolvedValue([]),
		addMessages: vi.fn().mockResolvedValue({ added: 0, updated: 0 }),
		searchAndFormat: vi.fn().mockResolvedValue(null),
		...overrides,
	} as unknown as MemoryService;
}

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

describe("findProjectForLead()", () => {
	it("returns project entry for a known leadId", () => {
		const result = findProjectForLead("product-lead", projects);
		expect(result).not.toBeNull();
		expect(result!.projectName).toBe("geoforge3d");
	});

	it("returns null for unknown leadId", () => {
		const result = findProjectForLead("unknown-lead", projects);
		expect(result).toBeNull();
	});

	it("finds lead in second project", () => {
		const result = findProjectForLead("other-lead", projects);
		expect(result).not.toBeNull();
		expect(result!.projectName).toBe("other-project");
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

	it("no memoryService → memoryRecall: null (backward compat)", async () => {
		const bootstrap = await generateBootstrap("product-lead", store, projects);
		expect(bootstrap.memoryRecall).toBeNull();
	});

	it("private + shared both return → merged with both section headers, deduped", async () => {
		const ms = mockMemoryService({
			searchMemories: vi.fn().mockImplementation(async (params) => {
				if (params.agentId === "product-lead") {
					return ["private fact A", "shared overlap"];
				}
				// shared bucket (no agentId)
				return ["shared fact B", "shared overlap"];
			}),
		});

		const bootstrap = await generateBootstrap(
			"product-lead",
			store,
			projects,
			ms,
		);
		expect(bootstrap.memoryRecall).not.toBeNull();
		expect(bootstrap.memoryRecall).toContain("### Personal Memory (private)");
		expect(bootstrap.memoryRecall).toContain("private fact A");
		expect(bootstrap.memoryRecall).toContain("shared overlap");
		expect(bootstrap.memoryRecall).toContain("### Project Facts (shared)");
		expect(bootstrap.memoryRecall).toContain("shared fact B");
		// "shared overlap" should appear only once (in private, deduped from shared)
		const overlapCount = (bootstrap.memoryRecall!.match(/shared overlap/g) || [])
			.length;
		expect(overlapCount).toBe(1);
	});

	it("private has content, shared empty → personal memory only", async () => {
		const ms = mockMemoryService({
			searchMemories: vi.fn().mockImplementation(async (params) => {
				if (params.agentId === "product-lead") {
					return ["private fact only"];
				}
				return [];
			}),
		});

		const bootstrap = await generateBootstrap(
			"product-lead",
			store,
			projects,
			ms,
		);
		expect(bootstrap.memoryRecall).not.toBeNull();
		expect(bootstrap.memoryRecall).toContain("### Personal Memory (private)");
		expect(bootstrap.memoryRecall).toContain("private fact only");
		expect(bootstrap.memoryRecall).not.toContain(
			"### Project Facts (shared)",
		);
	});

	it("both empty → memoryRecall: null", async () => {
		const ms = mockMemoryService({
			searchMemories: vi.fn().mockResolvedValue([]),
		});

		const bootstrap = await generateBootstrap(
			"product-lead",
			store,
			projects,
			ms,
		);
		expect(bootstrap.memoryRecall).toBeNull();
	});

	it("memoryService throws → memoryRecall: null, other fields normal", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const ms = mockMemoryService({
			searchMemories: vi.fn().mockRejectedValue(new Error("mem0 down")),
		});

		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			issue_identifier: "GEO-100",
			project_name: "geoforge3d",
			status: "running",
			issue_labels: JSON.stringify(["Product"]),
		});

		const bootstrap = await generateBootstrap(
			"product-lead",
			store,
			projects,
			ms,
		);
		expect(bootstrap.memoryRecall).toBeNull();
		// Other fields should still be populated
		expect(bootstrap.activeSessions).toHaveLength(1);
		expect(bootstrap.leadId).toBe("product-lead");
		warnSpy.mockRestore();
	});

	it("private timeout, shared succeeds → project facts only", async () => {
		const ms = mockMemoryService({
			searchMemories: vi.fn().mockImplementation(async (params) => {
				if (params.agentId === "product-lead") {
					// Simulate timeout — never resolves
					return new Promise((_resolve, reject) => {
						setTimeout(() => reject(new Error("TIMEOUT")), 10);
					});
				}
				return ["shared fact from project"];
			}),
		});

		const bootstrap = await generateBootstrap(
			"product-lead",
			store,
			projects,
			ms,
		);
		expect(bootstrap.memoryRecall).not.toBeNull();
		expect(bootstrap.memoryRecall).not.toContain(
			"### Personal Memory (private)",
		);
		expect(bootstrap.memoryRecall).toContain("### Project Facts (shared)");
		expect(bootstrap.memoryRecall).toContain("shared fact from project");
	});

	it("shared timeout, private succeeds → personal memory only", async () => {
		const ms = mockMemoryService({
			searchMemories: vi.fn().mockImplementation(async (params) => {
				if (params.agentId === "product-lead") {
					return ["private fact only"];
				}
				// Simulate timeout for shared bucket
				return new Promise((_resolve, reject) => {
					setTimeout(() => reject(new Error("TIMEOUT")), 10);
				});
			}),
		});

		const bootstrap = await generateBootstrap(
			"product-lead",
			store,
			projects,
			ms,
		);
		expect(bootstrap.memoryRecall).not.toBeNull();
		expect(bootstrap.memoryRecall).toContain("### Personal Memory (private)");
		expect(bootstrap.memoryRecall).toContain("private fact only");
		expect(bootstrap.memoryRecall).not.toContain(
			"### Project Facts (shared)",
		);
	});

	it("shared has duplicates of private → deduped", async () => {
		const ms = mockMemoryService({
			searchMemories: vi.fn().mockImplementation(async (params) => {
				if (params.agentId === "product-lead") {
					return ["fact X", "fact Y"];
				}
				return ["fact X", "fact Z"];
			}),
		});

		const bootstrap = await generateBootstrap(
			"product-lead",
			store,
			projects,
			ms,
		);
		expect(bootstrap.memoryRecall).not.toBeNull();
		// "fact X" in private, deduped from shared
		const xCount = (bootstrap.memoryRecall!.match(/fact X/g) || []).length;
		expect(xCount).toBe(1);
		// "fact Z" only in shared
		expect(bootstrap.memoryRecall).toContain("fact Z");
		// "fact Y" only in private
		expect(bootstrap.memoryRecall).toContain("fact Y");
	});

	it("leadId not found in any project → memoryRecall: null", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const ms = mockMemoryService({
			searchMemories: vi.fn().mockResolvedValue(["should not appear"]),
		});

		const bootstrap = await generateBootstrap(
			"unknown-lead",
			store,
			projects,
			ms,
		);
		expect(bootstrap.memoryRecall).toBeNull();
		// searchMemories should NOT have been called
		expect(ms.searchMemories).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it("private search uses userId=leadId; shared search uses userId=projectName", async () => {
		const searchFn = vi.fn().mockResolvedValue([]);
		const ms = mockMemoryService({ searchMemories: searchFn });

		await generateBootstrap("product-lead", store, projects, ms);

		expect(searchFn).toHaveBeenCalledTimes(2);
		// Private bucket call
		const privateCall = searchFn.mock.calls.find(
			(c: unknown[]) => (c[0] as { agentId?: string }).agentId === "product-lead",
		);
		expect(privateCall).toBeDefined();
		expect(privateCall![0].userId).toBe("product-lead");

		// Shared bucket call
		const sharedCall = searchFn.mock.calls.find(
			(c: unknown[]) => (c[0] as { agentId?: string }).agentId === undefined,
		);
		expect(sharedCall).toBeDefined();
		expect(sharedCall![0].userId).toBe("geoforge3d");
	});

	it("private search includes agentId=leadId; shared search omits agentId", async () => {
		const searchFn = vi.fn().mockResolvedValue([]);
		const ms = mockMemoryService({ searchMemories: searchFn });

		await generateBootstrap("product-lead", store, projects, ms);

		expect(searchFn).toHaveBeenCalledTimes(2);
		// Private bucket
		const privateCall = searchFn.mock.calls.find(
			(c: unknown[]) => (c[0] as { agentId?: string }).agentId === "product-lead",
		);
		expect(privateCall).toBeDefined();
		expect(privateCall![0].agentId).toBe("product-lead");
		expect(privateCall![0].limit).toBe(10);

		// Shared bucket — agentId should be undefined
		const sharedCall = searchFn.mock.calls.find(
			(c: unknown[]) => (c[0] as { agentId?: string }).agentId === undefined,
		);
		expect(sharedCall).toBeDefined();
		expect(sharedCall![0].agentId).toBeUndefined();
		expect(sharedCall![0].limit).toBe(5);
	});

	it("project without memoryAllowedUsers → memoryRecall: null (fail-closed)", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const ms = mockMemoryService({
			searchMemories: vi.fn().mockResolvedValue(["should not appear"]),
		});

		const bootstrap = await generateBootstrap(
			"other-lead",
			store,
			projects,
			ms,
		);
		expect(bootstrap.memoryRecall).toBeNull();
		// searchMemories should NOT have been called — fail-closed
		expect(ms.searchMemories).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it("project with memoryAllowedUsers missing leadId → memoryRecall: null", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		// Create a project where leadId is NOT in memoryAllowedUsers
		const restrictedProjects: ProjectEntry[] = [
			{
				projectName: "restricted",
				projectRoot: "/tmp/restricted",
				leads: [
					{
						agentId: "restricted-lead",
						chatChannel: "chat-r",
						match: { labels: ["R"] },
					},
				],
				memoryAllowedUsers: ["someone-else"],
			},
		];
		const ms = mockMemoryService({
			searchMemories: vi.fn().mockResolvedValue(["should not appear"]),
		});

		const bootstrap = await generateBootstrap(
			"restricted-lead",
			store,
			restrictedProjects,
			ms,
		);
		expect(bootstrap.memoryRecall).toBeNull();
		expect(ms.searchMemories).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it("result > 1500 chars → truncated with suffix", async () => {
		const longFact = "A".repeat(200);
		const ms = mockMemoryService({
			searchMemories: vi.fn().mockImplementation(async (params) => {
				if (params.agentId === "product-lead") {
					return Array.from({ length: 10 }, (_, i) => `${longFact}-${i}`);
				}
				return Array.from({ length: 5 }, (_, i) => `shared-${longFact}-${i}`);
			}),
		});

		const bootstrap = await generateBootstrap(
			"product-lead",
			store,
			projects,
			ms,
		);
		expect(bootstrap.memoryRecall).not.toBeNull();
		expect(bootstrap.memoryRecall!.length).toBeLessThanOrEqual(1600); // soft limit + suffix margin
		expect(bootstrap.memoryRecall).toContain("…(truncated)");
	});
});
