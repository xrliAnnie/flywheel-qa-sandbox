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
});
