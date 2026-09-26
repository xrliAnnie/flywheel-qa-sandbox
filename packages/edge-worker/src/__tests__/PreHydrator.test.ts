import { describe, expect, it, vi } from "vitest";
import { PreHydrator } from "../PreHydrator.js";

describe("PreHydrator", () => {
	it("hydrates context from issue", async () => {
		const fetchIssue = vi.fn(async () => ({
			title: "Add login page",
			description: "Build a login form with OAuth",
		}));
		const hydrator = new PreHydrator(fetchIssue);

		const ctx = await hydrator.hydrate({ id: "GEO-101", blockedBy: [] });

		expect(ctx.issueId).toBe("GEO-101");
		expect(ctx.issueTitle).toBe("Add login page");
		expect(ctx.issueDescription).toBe("Build a login form with OAuth");
	});

	it("handles null description", async () => {
		const fetchIssue = vi.fn(async () => ({
			title: "Title",
			description: null as string | null,
		}));
		const hydrator = new PreHydrator(fetchIssue);

		const ctx = await hydrator.hydrate({ id: "GEO-102", blockedBy: [] });

		expect(ctx.issueDescription).toBe("");
	});

	it("passes issue ID to fetchIssue", async () => {
		const fetchIssue = vi.fn(async () => ({
			title: "T",
			description: "D",
		}));
		const hydrator = new PreHydrator(fetchIssue);

		await hydrator.hydrate({ id: "issue-42", blockedBy: [] });

		expect(fetchIssue).toHaveBeenCalledWith("issue-42");
	});

	it("includes issueId in hydrated context", async () => {
		const fetchIssue = vi.fn(async () => ({
			title: "T",
			description: "D",
		}));
		const hydrator = new PreHydrator(fetchIssue);

		const ctx = await hydrator.hydrate({ id: "GEO-99", blockedBy: [] });

		expect(ctx.issueId).toBe("GEO-99");
	});

	// --- Step 2b enrichment ---

	it("returns labels from fetch", async () => {
		const fetchIssue = vi.fn(async () => ({
			title: "T",
			description: "D",
			labels: ["security", "auth"],
		}));
		const hydrator = new PreHydrator(fetchIssue);

		const ctx = await hydrator.hydrate({ id: "GEO-1", blockedBy: [] });

		expect(ctx.labels).toEqual(["security", "auth"]);
	});

	it("defaults labels to [] when fetch omits them", async () => {
		const fetchIssue = vi.fn(async () => ({
			title: "T",
			description: "D",
		}));
		const hydrator = new PreHydrator(fetchIssue);

		const ctx = await hydrator.hydrate({ id: "GEO-1", blockedBy: [] });

		expect(ctx.labels).toEqual([]);
	});

	it("returns projectId from fetch", async () => {
		const fetchIssue = vi.fn(async () => ({
			title: "T",
			description: "D",
			projectId: "proj-abc",
		}));
		const hydrator = new PreHydrator(fetchIssue);

		const ctx = await hydrator.hydrate({ id: "GEO-1", blockedBy: [] });

		expect(ctx.projectId).toBe("proj-abc");
	});

	it("defaults projectId to empty when omitted", async () => {
		const fetchIssue = vi.fn(async () => ({
			title: "T",
			description: "D",
		}));
		const hydrator = new PreHydrator(fetchIssue);

		const ctx = await hydrator.hydrate({ id: "GEO-1", blockedBy: [] });

		expect(ctx.projectId).toBe("");
	});

	it("returns identifier from fetch", async () => {
		const fetchIssue = vi.fn(async () => ({
			title: "T",
			description: "D",
			identifier: "GEO-95",
		}));
		const hydrator = new PreHydrator(fetchIssue);

		const ctx = await hydrator.hydrate({ id: "issue-id-1", blockedBy: [] });

		expect(ctx.issueIdentifier).toBe("GEO-95");
	});

	it("defaults identifier to issueId when omitted", async () => {
		const fetchIssue = vi.fn(async () => ({
			title: "T",
			description: "D",
		}));
		const hydrator = new PreHydrator(fetchIssue);

		const ctx = await hydrator.hydrate({ id: "issue-id-1", blockedBy: [] });

		expect(ctx.issueIdentifier).toBe("issue-id-1");
	});
});
