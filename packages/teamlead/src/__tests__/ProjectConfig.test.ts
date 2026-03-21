import { afterEach, describe, expect, it } from "vitest";
import {
	type LeadConfig,
	loadProjects,
	type ProjectEntry,
	resolveLeadForIssue,
} from "../ProjectConfig.js";

describe("LeadConfig type", () => {
	it("LeadConfig has agentId, forumChannel, chatChannel, and match.labels", () => {
		const lead: LeadConfig = {
			agentId: "product-lead",
			forumChannel: "123456",
			chatChannel: "789",
			match: { labels: ["Product"] },
		};
		expect(lead.agentId).toBe("product-lead");
		expect(lead.forumChannel).toBe("123456");
		expect(lead.chatChannel).toBe("789");
		expect(lead.match.labels).toEqual(["Product"]);
	});

	it("ProjectEntry includes leads array", () => {
		const entry: ProjectEntry = {
			projectName: "test",
			projectRoot: "/tmp/test",
			leads: [
				{
					agentId: "eng-lead",
					forumChannel: "789",
					chatChannel: "012",
					match: { labels: ["Engineering"] },
				},
			],
		};
		expect(entry.leads[0]!.agentId).toBe("eng-lead");
	});
});

describe("loadProjects validation", () => {
	const originalEnv = process.env.FLYWHEEL_PROJECTS;

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.FLYWHEEL_PROJECTS;
		} else {
			process.env.FLYWHEEL_PROJECTS = originalEnv;
		}
	});

	it("throws when leads is missing", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{ projectName: "test", projectRoot: "/tmp" },
		]);
		expect(() => loadProjects()).toThrow(/leads/);
	});

	it("throws when leads is empty array", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{ projectName: "test", projectRoot: "/tmp", leads: [] },
		]);
		expect(() => loadProjects()).toThrow(/leads/);
	});

	it("throws when leads[].agentId is missing", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [
					{
						forumChannel: "123",
						chatChannel: "456",
						match: { labels: ["bug"] },
					},
				],
			},
		]);
		expect(() => loadProjects()).toThrow(/agentId/);
	});

	it("throws when leads[].forumChannel is missing", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [
					{
						agentId: "bot",
						chatChannel: "456",
						match: { labels: ["bug"] },
					},
				],
			},
		]);
		expect(() => loadProjects()).toThrow(/forumChannel/);
	});

	it("throws when leads[].chatChannel is missing", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [
					{
						agentId: "bot",
						forumChannel: "123",
						match: { labels: ["bug"] },
					},
				],
			},
		]);
		expect(() => loadProjects()).toThrow(/chatChannel/);
	});

	it("throws when leads[].match is missing", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [
					{
						agentId: "bot",
						forumChannel: "123",
						chatChannel: "456",
					},
				],
			},
		]);
		expect(() => loadProjects()).toThrow(/match/);
	});

	it("throws when leads[].match.labels is empty", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [
					{
						agentId: "bot",
						forumChannel: "123",
						chatChannel: "456",
						match: { labels: [] },
					},
				],
			},
		]);
		expect(() => loadProjects()).toThrow(/labels/);
	});

	it("throws on duplicate projectName", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "dup",
				projectRoot: "/a",
				leads: [
					{
						agentId: "a",
						forumChannel: "1",
						chatChannel: "2",
						match: { labels: ["X"] },
					},
				],
			},
			{
				projectName: "dup",
				projectRoot: "/b",
				leads: [
					{
						agentId: "b",
						forumChannel: "3",
						chatChannel: "4",
						match: { labels: ["Y"] },
					},
				],
			},
		]);
		expect(() => loadProjects()).toThrow(/duplicate/i);
	});

	it("succeeds with valid leads config", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [
					{
						agentId: "product-lead",
						forumChannel: "123",
						chatChannel: "456",
						match: { labels: ["Product"] },
					},
				],
			},
		]);
		const projects = loadProjects();
		expect(projects).toHaveLength(1);
		expect(projects[0]!.leads[0]!.agentId).toBe("product-lead");
	});

	it("returns empty array when projects.json does not exist (ENOENT)", () => {
		// Override HOME to a non-existent dir so projects.json won't be found
		const origHome = process.env.HOME;
		delete process.env.FLYWHEEL_PROJECTS;
		process.env.HOME = "/tmp/flywheel-test-nonexistent-dir";
		try {
			const projects = loadProjects();
			expect(projects).toEqual([]);
		} finally {
			if (origHome !== undefined) process.env.HOME = origHome;
			else delete process.env.HOME;
		}
	});

	it("throws on malformed JSON in env var", () => {
		process.env.FLYWHEEL_PROJECTS = "not valid json{{{";
		expect(() => loadProjects()).toThrow();
	});
});

describe("resolveLeadForIssue", () => {
	const projects: ProjectEntry[] = [
		{
			projectName: "geoforge3d",
			projectRoot: "/tmp/geoforge3d",
			leads: [
				{
					agentId: "product-lead",
					forumChannel: "111",
					chatChannel: "111-chat",
					match: { labels: ["Product"] },
				},
				{
					agentId: "eng-lead",
					forumChannel: "333",
					chatChannel: "333-chat",
					match: { labels: ["Engineering", "Backend"] },
				},
			],
			generalChannel: "999",
		},
		{
			projectName: "marketing-site",
			projectRoot: "/tmp/marketing",
			leads: [
				{
					agentId: "marketing-lead",
					forumChannel: "222",
					chatChannel: "222-chat",
					match: { labels: ["Marketing"] },
				},
			],
		},
	];

	it("returns lead for matching label", () => {
		const result = resolveLeadForIssue(projects, "geoforge3d", ["Product"]);
		expect(result.lead.agentId).toBe("product-lead");
		expect(result.matchMethod).toBe("label");
	});

	it("returns lead for second project", () => {
		const result = resolveLeadForIssue(projects, "marketing-site", [
			"Marketing",
		]);
		expect(result.lead.agentId).toBe("marketing-lead");
		expect(result.matchMethod).toBe("label");
	});

	it("case-insensitive label matching", () => {
		const result = resolveLeadForIssue(projects, "geoforge3d", ["PRODUCT"]);
		expect(result.lead.agentId).toBe("product-lead");
		expect(result.matchMethod).toBe("label");
	});

	it("first match wins (label in second lead)", () => {
		const result = resolveLeadForIssue(projects, "geoforge3d", ["Backend"]);
		expect(result.lead.agentId).toBe("eng-lead");
		expect(result.matchMethod).toBe("label");
	});

	it("first match wins (labels matching multiple leads)", () => {
		const result = resolveLeadForIssue(projects, "geoforge3d", [
			"Product",
			"Engineering",
		]);
		expect(result.lead.agentId).toBe("product-lead");
		expect(result.matchMethod).toBe("label");
	});

	it("no match returns first lead with general method", () => {
		const result = resolveLeadForIssue(projects, "geoforge3d", [
			"UnknownLabel",
		]);
		expect(result.lead.agentId).toBe("product-lead");
		expect(result.matchMethod).toBe("general");
	});

	it("empty labels returns first lead with general method", () => {
		const result = resolveLeadForIssue(projects, "geoforge3d", []);
		expect(result.lead.agentId).toBe("product-lead");
		expect(result.matchMethod).toBe("general");
	});

	it("no labels parameter defaults to general match", () => {
		const result = resolveLeadForIssue(projects, "geoforge3d");
		expect(result.lead.agentId).toBe("product-lead");
		expect(result.matchMethod).toBe("general");
	});

	it("throws for unknown project", () => {
		expect(() => resolveLeadForIssue(projects, "unknown", [])).toThrow(
			/No project found.*unknown/,
		);
	});
});
