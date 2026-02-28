import { describe, expect, it, vi } from "vitest";
import { PreHydrator } from "../PreHydrator.js";

describe("PreHydrator", () => {
	it("hydrates context from issue and rules", async () => {
		const fetchIssue = vi.fn(async () => ({
			title: "Add login page",
			description: "Build a login form with OAuth",
		}));
		const readRules = vi.fn(async () => "Always use TypeScript");
		const hydrator = new PreHydrator(fetchIssue, readRules, "/project");

		const ctx = await hydrator.hydrate({ id: "issue-1", blockedBy: [] });

		expect(ctx.issueTitle).toBe("Add login page");
		expect(ctx.issueDescription).toBe("Build a login form with OAuth");
		expect(ctx.projectRules).toBe("Always use TypeScript");
		expect(ctx.linkedPRs).toEqual([]);
		expect(ctx.relatedFiles).toEqual([]);
		expect(ctx.recentDecisions).toEqual([]);
	});

	it("handles null description", async () => {
		const fetchIssue = vi.fn(async () => ({
			title: "Title",
			description: null as string | null,
		}));
		const readRules = vi.fn(async () => "rules");
		const hydrator = new PreHydrator(fetchIssue, readRules, "/project");

		const ctx = await hydrator.hydrate({ id: "issue-1", blockedBy: [] });

		expect(ctx.issueDescription).toBe("");
	});

	it("passes issue ID to fetchIssue", async () => {
		const fetchIssue = vi.fn(async () => ({
			title: "T",
			description: "D",
		}));
		const readRules = vi.fn(async () => "");
		const hydrator = new PreHydrator(fetchIssue, readRules, "/root");

		await hydrator.hydrate({ id: "issue-42", blockedBy: [] });

		expect(fetchIssue).toHaveBeenCalledWith("issue-42");
	});

	it("passes projectRoot to readRules", async () => {
		const fetchIssue = vi.fn(async () => ({
			title: "T",
			description: "D",
		}));
		const readRules = vi.fn(async () => "");
		const hydrator = new PreHydrator(
			fetchIssue,
			readRules,
			"/my/project/root",
		);

		await hydrator.hydrate({ id: "issue-1", blockedBy: [] });

		expect(readRules).toHaveBeenCalledWith("/my/project/root");
	});
});
