import { afterEach, describe, expect, it } from "vitest";
import {
	type LeadConfig,
	loadProjects,
	type ProjectEntry,
	resolveLeadForIssue,
	validateMemoryIds,
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

	it("accepts lead without forumChannel (GEO-275: PM leads)", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [
					{
						agentId: "pm-lead",
						chatChannel: "456",
						match: { labels: ["PM"] },
					},
				],
			},
		]);
		const projects = loadProjects();
		expect(projects[0]!.leads[0]!.forumChannel).toBeUndefined();
	});

	it("throws when leads[].forumChannel is empty string", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [
					{
						agentId: "bot",
						forumChannel: "",
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

describe("linearTeamKey validation (FLY-23)", () => {
	const originalEnv = process.env.FLYWHEEL_PROJECTS;

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.FLYWHEEL_PROJECTS;
		} else {
			process.env.FLYWHEEL_PROJECTS = originalEnv;
		}
	});

	const validLead = {
		agentId: "product-lead",
		forumChannel: "123",
		chatChannel: "456",
		match: { labels: ["Product"] },
	};

	it("accepts project with linearTeamKey", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "geoforge3d",
				projectRoot: "/tmp",
				linearTeamKey: "GEO",
				leads: [validLead],
			},
		]);
		const projects = loadProjects();
		expect(projects[0]!.linearTeamKey).toBe("GEO");
	});

	it("accepts project without linearTeamKey (backward compat)", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [validLead],
			},
		]);
		const projects = loadProjects();
		expect(projects[0]!.linearTeamKey).toBeUndefined();
	});

	it("throws when linearTeamKey is empty string", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				linearTeamKey: "",
				leads: [validLead],
			},
		]);
		expect(() => loadProjects()).toThrow(/linearTeamKey/);
	});

	it("throws when linearTeamKey is non-string", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				linearTeamKey: 123,
				leads: [validLead],
			},
		]);
		expect(() => loadProjects()).toThrow(/linearTeamKey/);
	});

	it("ProjectEntry type includes optional linearTeamKey", () => {
		const entry: ProjectEntry = {
			projectName: "test",
			projectRoot: "/tmp",
			linearTeamKey: "FLY",
			leads: [validLead],
		};
		expect(entry.linearTeamKey).toBe("FLY");
	});
});

describe("statusTagMap validation (GEO-253)", () => {
	const originalEnv = process.env.FLYWHEEL_PROJECTS;

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.FLYWHEEL_PROJECTS;
		} else {
			process.env.FLYWHEEL_PROJECTS = originalEnv;
		}
	});

	const baseLead = {
		agentId: "product-lead",
		forumChannel: "123",
		chatChannel: "456",
		match: { labels: ["Product"] },
	};

	function makeProject(leadOverrides: Record<string, unknown>) {
		return JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [{ ...baseLead, ...leadOverrides }],
			},
		]);
	}

	it("accepts lead without statusTagMap (uses global fallback)", () => {
		process.env.FLYWHEEL_PROJECTS = makeProject({});
		const projects = loadProjects();
		expect(projects[0]!.leads[0]!.statusTagMap).toBeUndefined();
	});

	it("accepts valid statusTagMap", () => {
		process.env.FLYWHEEL_PROJECTS = makeProject({
			statusTagMap: { running: ["tag-1"], failed: ["tag-2"] },
		});
		const projects = loadProjects();
		expect(projects[0]!.leads[0]!.statusTagMap).toEqual({
			running: ["tag-1"],
			failed: ["tag-2"],
		});
	});

	it("throws on empty statusTagMap {}", () => {
		process.env.FLYWHEEL_PROJECTS = makeProject({ statusTagMap: {} });
		expect(() => loadProjects()).toThrow(/must not be empty/);
	});

	it("throws when statusTagMap is an array", () => {
		process.env.FLYWHEEL_PROJECTS = makeProject({ statusTagMap: ["tag-1"] });
		expect(() => loadProjects()).toThrow(/non-array object/);
	});

	it("throws when statusTagMap is null", () => {
		process.env.FLYWHEEL_PROJECTS = makeProject({ statusTagMap: null });
		expect(() => loadProjects()).toThrow(/non-null/);
	});

	it("throws when statusTagMap value is empty array", () => {
		process.env.FLYWHEEL_PROJECTS = makeProject({
			statusTagMap: { running: [] },
		});
		expect(() => loadProjects()).toThrow(/non-empty array/);
	});

	it("throws when statusTagMap value contains empty string tag ID", () => {
		process.env.FLYWHEEL_PROJECTS = makeProject({
			statusTagMap: { running: [""] },
		});
		expect(() => loadProjects()).toThrow(/non-empty string/);
	});

	it("throws when statusTagMap value contains non-string tag ID", () => {
		process.env.FLYWHEEL_PROJECTS = makeProject({
			statusTagMap: { running: [123] },
		});
		expect(() => loadProjects()).toThrow(/non-empty string/);
	});

	it("LeadConfig type includes optional statusTagMap", () => {
		const lead: LeadConfig = {
			...baseLead,
			statusTagMap: { running: ["tag-r"], completed: ["tag-c"] },
		};
		expect(lead.statusTagMap?.running).toEqual(["tag-r"]);
	});
});

describe("memoryAllowedUsers validation", () => {
	const originalEnv = process.env.FLYWHEEL_PROJECTS;

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.FLYWHEEL_PROJECTS;
		} else {
			process.env.FLYWHEEL_PROJECTS = originalEnv;
		}
	});

	const validLead = {
		agentId: "product-lead",
		forumChannel: "123",
		chatChannel: "456",
		match: { labels: ["Product"] },
	};

	it("accepts config with valid memoryAllowedUsers", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [validLead],
				memoryAllowedUsers: ["annie"],
			},
		]);
		const projects = loadProjects();
		expect(projects).toHaveLength(1);
		expect(projects[0]!.memoryAllowedUsers).toEqual(["annie"]);
	});

	it("accepts config without memoryAllowedUsers", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [validLead],
			},
		]);
		const projects = loadProjects();
		expect(projects).toHaveLength(1);
		expect(projects[0]!.memoryAllowedUsers).toBeUndefined();
	});

	it("throws on empty memoryAllowedUsers array", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [validLead],
				memoryAllowedUsers: [],
			},
		]);
		expect(() => loadProjects()).toThrow(/must be a non-empty array/);
	});

	it("throws on memoryAllowedUsers with empty string", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [validLead],
				memoryAllowedUsers: [""],
			},
		]);
		expect(() => loadProjects()).toThrow(
			/each user must be a non-empty string/,
		);
	});
});

describe("botTokenEnv resolution (GEO-252)", () => {
	const originalEnv = process.env.FLYWHEEL_PROJECTS;
	let savedTokenEnv: string | undefined;

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.FLYWHEEL_PROJECTS;
		} else {
			process.env.FLYWHEEL_PROJECTS = originalEnv;
		}
		// Clean up test env var
		if (savedTokenEnv !== undefined) {
			process.env.TEST_PETER_TOKEN = savedTokenEnv;
		} else {
			delete process.env.TEST_PETER_TOKEN;
		}
	});

	const baseLead = {
		agentId: "product-lead",
		forumChannel: "123",
		chatChannel: "456",
		match: { labels: ["Product"] },
		runtime: "claude-discord" as const,
		controlChannel: "ctrl-123",
	};

	it("resolves botToken from env var when botTokenEnv is set", () => {
		savedTokenEnv = process.env.TEST_PETER_TOKEN;
		process.env.TEST_PETER_TOKEN = "resolved-token-value";
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [{ ...baseLead, botTokenEnv: "TEST_PETER_TOKEN" }],
			},
		]);
		const projects = loadProjects();
		expect(projects[0]!.leads[0]!.botToken).toBe("resolved-token-value");
		expect(projects[0]!.leads[0]!.botTokenEnv).toBe("TEST_PETER_TOKEN");
	});

	it("throws when botTokenEnv is set but env var missing for claude-discord", () => {
		savedTokenEnv = process.env.TEST_PETER_TOKEN;
		delete process.env.TEST_PETER_TOKEN;
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [{ ...baseLead, botTokenEnv: "TEST_PETER_TOKEN" }],
			},
		]);
		expect(() => loadProjects()).toThrow(
			/botTokenEnv="TEST_PETER_TOKEN" is set but env var is not defined/,
		);
	});

	it("does not throw when botTokenEnv missing for non-claude-discord runtime", () => {
		savedTokenEnv = process.env.TEST_PETER_TOKEN;
		delete process.env.TEST_PETER_TOKEN;
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [
					{
						...baseLead,
						runtime: "openclaw",
						controlChannel: undefined,
						botTokenEnv: "TEST_PETER_TOKEN",
					},
				],
			},
		]);
		// Should not throw, just warn
		const projects = loadProjects();
		expect(projects[0]!.leads[0]!.botToken).toBeUndefined();
	});

	it("botToken is undefined when botTokenEnv is not configured (backward-compat)", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [baseLead],
			},
		]);
		const projects = loadProjects();
		expect(projects[0]!.leads[0]!.botToken).toBeUndefined();
		expect(projects[0]!.leads[0]!.botTokenEnv).toBeUndefined();
	});

	it("strips raw botToken from JSON input", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [{ ...baseLead, botToken: "raw-secret-leaked" }],
			},
		]);
		const projects = loadProjects();
		// botToken from JSON should be stripped (no botTokenEnv to resolve)
		expect(projects[0]!.leads[0]!.botToken).toBeUndefined();
	});

	it("throws when botTokenEnv is non-string type", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [{ ...baseLead, botTokenEnv: 123 }],
			},
		]);
		expect(() => loadProjects()).toThrow(
			/botTokenEnv: must be a non-empty string/,
		);
	});

	it("throws when botTokenEnv is empty string", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [{ ...baseLead, botTokenEnv: "" }],
			},
		]);
		expect(() => loadProjects()).toThrow(
			/botTokenEnv: must be a non-empty string/,
		);
	});

	it("strips raw botToken and resolves from botTokenEnv instead", () => {
		savedTokenEnv = process.env.TEST_PETER_TOKEN;
		process.env.TEST_PETER_TOKEN = "env-resolved-value";
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [
					{
						...baseLead,
						botToken: "raw-secret-leaked",
						botTokenEnv: "TEST_PETER_TOKEN",
					},
				],
			},
		]);
		const projects = loadProjects();
		// Should use resolved env var, not the raw JSON value
		expect(projects[0]!.leads[0]!.botToken).toBe("env-resolved-value");
	});
});

describe("validateMemoryIds", () => {
	const projects: ProjectEntry[] = [
		{
			projectName: "geoforge3d",
			projectRoot: "/tmp",
			leads: [
				{
					agentId: "product-lead",
					forumChannel: "x",
					chatChannel: "y",
					match: { labels: ["Product"] },
				},
				{
					agentId: "ops-lead",
					forumChannel: "x2",
					chatChannel: "y2",
					match: { labels: ["Operations"] },
				},
			],
			// GEO-203: dual-bucket — lead IDs (private) + project name (shared)
			memoryAllowedUsers: ["annie", "product-lead", "ops-lead", "geoforge3d"],
		},
		{
			projectName: "no-memory-project",
			projectRoot: "/tmp/no-mem",
			leads: [
				{
					agentId: "eng-lead",
					forumChannel: "a",
					chatChannel: "b",
					match: { labels: ["Engineering"] },
				},
			],
		},
	];

	it("returns valid for known project + agent + user", () => {
		const result = validateMemoryIds(
			projects,
			"geoforge3d",
			"product-lead",
			"annie",
		);
		expect(result).toEqual({ valid: true });
	});

	it("returns error for unknown project", () => {
		const result = validateMemoryIds(
			projects,
			"unknown",
			"product-lead",
			"annie",
		);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.error).toContain("unknown project_name");
		}
	});

	it("returns error for unknown agent", () => {
		const result = validateMemoryIds(
			projects,
			"geoforge3d",
			"unknown-agent",
			"annie",
		);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.error).toContain("unknown agent_id");
		}
	});

	it("returns error for unknown user", () => {
		const result = validateMemoryIds(
			projects,
			"geoforge3d",
			"product-lead",
			"bob",
		);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.error).toContain("unknown user_id");
		}
	});

	it("returns error when memoryAllowedUsers not configured (fail-closed)", () => {
		const result = validateMemoryIds(
			projects,
			"no-memory-project",
			"eng-lead",
			"annie",
		);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.error).toContain("memory not configured");
		}
	});

	// GEO-203: dual-bucket — optional agentId tests
	it("valid: agentId=undefined + userId=geoforge3d (shared bucket search)", () => {
		const result = validateMemoryIds(
			projects,
			"geoforge3d",
			undefined,
			"geoforge3d",
		);
		expect(result).toEqual({ valid: true });
	});

	it("valid: agentId=undefined + userId=product-lead (private bucket search)", () => {
		const result = validateMemoryIds(
			projects,
			"geoforge3d",
			undefined,
			"product-lead",
		);
		expect(result).toEqual({ valid: true });
	});

	it("invalid: agentId=undefined + userId=unknown-user (optional agentId does NOT relax user allowlist)", () => {
		const result = validateMemoryIds(
			projects,
			"geoforge3d",
			undefined,
			"unknown-user",
		);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.error).toContain("unknown user_id");
		}
	});

	it("valid: agentId=product-lead + userId=product-lead (private bucket with agent)", () => {
		const result = validateMemoryIds(
			projects,
			"geoforge3d",
			"product-lead",
			"product-lead",
		);
		expect(result).toEqual({ valid: true });
	});

	it("valid: agentId=product-lead + userId=geoforge3d (shared bucket with agent)", () => {
		const result = validateMemoryIds(
			projects,
			"geoforge3d",
			"product-lead",
			"geoforge3d",
		);
		expect(result).toEqual({ valid: true });
	});

	it("invalid: agentId=unknown-agent + userId=geoforge3d (agent not in leads)", () => {
		const result = validateMemoryIds(
			projects,
			"geoforge3d",
			"unknown-agent",
			"geoforge3d",
		);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.error).toContain("unknown agent_id");
		}
	});

	it("invalid: memoryAllowedUsers missing, regardless of agentId", () => {
		const result = validateMemoryIds(
			projects,
			"no-memory-project",
			undefined,
			"annie",
		);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.error).toContain("memory not configured");
		}
	});
});
