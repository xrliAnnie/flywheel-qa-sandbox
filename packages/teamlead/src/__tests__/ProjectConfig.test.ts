import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type LeadConfig,
	loadProjects,
	type ProjectEntry,
	resolveLeadForIssue,
	validateMemoryIds,
} from "../ProjectConfig.js";

describe("LeadConfig type", () => {
	it("LeadConfig has agentId, chatChannel, and match.labels", () => {
		const lead: LeadConfig = {
			agentId: "product-lead",
			chatChannel: "789",
			match: { labels: ["Product"] },
		};
		expect(lead.agentId).toBe("product-lead");
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
						chatChannel: "456",
						match: { labels: ["bug"] },
					},
				],
			},
		]);
		expect(() => loadProjects()).toThrow(/agentId/);
	});

	it("throws when leads[].chatChannel is missing", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [
					{
						agentId: "bot",
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

	// FLY-173: generalChannel (project core channel) validation.
	const baseLeads = [
		{
			agentId: "cos-lead",
			chatChannel: "ch-core",
			match: { labels: ["PM"] },
			canSpawnRunners: false,
		},
	];

	it("accepts a valid generalChannel (non-empty string)", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				generalChannel: "ch-core",
				leads: baseLeads,
			},
		]);
		const projects = loadProjects();
		expect(projects[0]!.generalChannel).toBe("ch-core");
	});

	it("accepts a project with generalChannel omitted (optional)", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{ projectName: "test", projectRoot: "/tmp", leads: baseLeads },
		]);
		const projects = loadProjects();
		expect(projects[0]!.generalChannel).toBeUndefined();
	});

	it("throws when generalChannel is an empty string", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				generalChannel: "",
				leads: baseLeads,
			},
		]);
		expect(() => loadProjects()).toThrow(/generalChannel/);
	});

	it("throws when generalChannel is not a string", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				generalChannel: 12345,
				leads: baseLeads,
			},
		]);
		expect(() => loadProjects()).toThrow(/generalChannel/);
	});
});

// FLY-231: companion (non-engineering) Lead marker.
describe("loadProjects companion validation", () => {
	const originalEnv = process.env.FLYWHEEL_PROJECTS;
	afterEach(() => {
		if (originalEnv === undefined) delete process.env.FLYWHEEL_PROJECTS;
		else process.env.FLYWHEEL_PROJECTS = originalEnv;
	});

	const companionLead = (companion: unknown) => ({
		agentId: "mufasa-lead",
		chatChannel: "ch-growth",
		match: { labels: ["growth"] },
		canSpawnRunners: false,
		...(companion === undefined ? {} : { companion }),
	});

	it("preserves companion: true", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "growth",
				projectRoot: "/tmp",
				leads: [companionLead(true)],
			},
		]);
		expect(loadProjects()[0]!.leads[0]!.companion).toBe(true);
	});

	it("leaves companion undefined when absent (NOT normalized to false)", () => {
		// Codex R2 MEDIUM-9: do not normalize — keep existing in-memory shape so
		// the 5 existing Leads are byte-identical. Consumers check `=== true`.
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "growth",
				projectRoot: "/tmp",
				leads: [companionLead(undefined)],
			},
		]);
		expect(loadProjects()[0]!.leads[0]!.companion).toBeUndefined();
	});

	it("preserves explicit companion: false", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "growth",
				projectRoot: "/tmp",
				leads: [companionLead(false)],
			},
		]);
		expect(loadProjects()[0]!.leads[0]!.companion).toBe(false);
	});

	it("throws when companion is not a boolean", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "growth",
				projectRoot: "/tmp",
				leads: [companionLead("yes")],
			},
		]);
		expect(() => loadProjects()).toThrow(/companion/);
	});

	it("is orthogonal to canSpawnRunners (cos-lead is canSpawnRunners:false but NOT companion)", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "gf",
				projectRoot: "/tmp",
				leads: [
					{
						agentId: "cos-lead",
						chatChannel: "ch",
						match: { labels: ["PM"] },
						canSpawnRunners: false,
					},
				],
			},
		]);
		const lead = loadProjects()[0]!.leads[0]!;
		expect(lead.canSpawnRunners).toBe(false);
		expect(lead.companion).toBeUndefined();
	});
});

describe("FLY-163: deprecated field handling", () => {
	const originalEnv = process.env.FLYWHEEL_PROJECTS;
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
		if (originalEnv === undefined) {
			delete process.env.FLYWHEEL_PROJECTS;
		} else {
			process.env.FLYWHEEL_PROJECTS = originalEnv;
		}
	});

	it("strips deprecated forumChannel field with warning", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [
					{
						agentId: "product-lead",
						forumChannel: "deprecated-id",
						chatChannel: "456",
						match: { labels: ["Product"] },
					},
				],
			},
		]);
		const projects = loadProjects();
		expect(
			(projects[0]!.leads[0]! as Record<string, unknown>).forumChannel,
		).toBeUndefined();
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringMatching(/forumChannel.*deprecated.*FLY-163/),
		);
	});

	it("strips deprecated statusTagMap field with warning", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [
					{
						agentId: "product-lead",
						chatChannel: "456",
						match: { labels: ["Product"] },
						statusTagMap: { running: ["tag-1"] },
					},
				],
			},
		]);
		const projects = loadProjects();
		expect(
			(projects[0]!.leads[0]! as Record<string, unknown>).statusTagMap,
		).toBeUndefined();
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringMatching(/statusTagMap.*deprecated.*FLY-163/),
		);
	});
});

describe("FLY-163: PM/Triage canSpawnRunners validator", () => {
	const originalEnv = process.env.FLYWHEEL_PROJECTS;
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
		if (originalEnv === undefined) {
			delete process.env.FLYWHEEL_PROJECTS;
		} else {
			process.env.FLYWHEEL_PROJECTS = originalEnv;
		}
	});

	function makeLead(overrides: Record<string, unknown> = {}) {
		return JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [
					{
						agentId: "lead-x",
						chatChannel: "456",
						match: { labels: ["PM"] },
						...overrides,
					},
				],
			},
		]);
	}

	it("accepts PM label + explicit canSpawnRunners: false", () => {
		process.env.FLYWHEEL_PROJECTS = makeLead({ canSpawnRunners: false });
		const projects = loadProjects();
		expect(projects[0]!.leads[0]!.canSpawnRunners).toBe(false);
	});

	it("throws on PM label + explicit canSpawnRunners: true", () => {
		process.env.FLYWHEEL_PROJECTS = makeLead({ canSpawnRunners: true });
		expect(() => loadProjects()).toThrow(/PM\/Triage.*canSpawnRunners/);
	});

	it("throws on PM label + canSpawnRunners absent (default true)", () => {
		process.env.FLYWHEEL_PROJECTS = makeLead({});
		expect(() => loadProjects()).toThrow(/PM\/Triage.*canSpawnRunners/);
	});

	it("accepts dept-only label + canSpawnRunners absent (defaults to true)", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [
					{
						agentId: "product-lead",
						chatChannel: "456",
						match: { labels: ["Product"] },
					},
				],
			},
		]);
		const projects = loadProjects();
		expect(projects[0]!.leads[0]!.canSpawnRunners).toBe(true);
	});

	it("throws on multi-label including PM + canSpawnRunners absent", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [
					{
						agentId: "lead-x",
						chatChannel: "456",
						match: { labels: ["PM", "Bug"] },
					},
				],
			},
		]);
		expect(() => loadProjects()).toThrow(/PM\/Triage.*canSpawnRunners/);
	});

	it("PM/Triage matching is case-insensitive and trim-tolerant", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [
					{
						agentId: "lead-x",
						chatChannel: "456",
						match: { labels: ["pm "] },
					},
				],
			},
		]);
		expect(() => loadProjects()).toThrow(/PM\/Triage.*canSpawnRunners/);
	});

	it("Triage label is treated like PM", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [
					{
						agentId: "lead-x",
						chatChannel: "456",
						match: { labels: ["Triage"] },
					},
				],
			},
		]);
		expect(() => loadProjects()).toThrow(/PM\/Triage.*canSpawnRunners/);
	});

	it("validator runs AFTER deprecated forumChannel strip", () => {
		// Even with deprecated forumChannel present, the validator should reject
		// a PM lead missing canSpawnRunners: false — the strip happens first.
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [
					{
						agentId: "lead-x",
						forumChannel: "ignored-dep",
						chatChannel: "456",
						match: { labels: ["PM"] },
					},
				],
			},
		]);
		expect(() => loadProjects()).toThrow(/PM\/Triage.*canSpawnRunners/);
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
					chatChannel: "111-chat",
					match: { labels: ["Product"] },
				},
				{
					agentId: "eng-lead",
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
		chatChannel: "456",
		match: { labels: ["Product"] },
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

	it("warns but does not throw when botTokenEnv is set but env var missing", () => {
		savedTokenEnv = process.env.TEST_PETER_TOKEN;
		delete process.env.TEST_PETER_TOKEN;
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [{ ...baseLead, botTokenEnv: "TEST_PETER_TOKEN" }],
			},
		]);
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
					chatChannel: "y",
					match: { labels: ["Product"] },
				},
				{
					agentId: "ops-lead",
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

describe("FLY-83 alert fields", () => {
	const originalEnv = process.env.FLYWHEEL_PROJECTS;

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.FLYWHEEL_PROJECTS;
		} else {
			process.env.FLYWHEEL_PROJECTS = originalEnv;
		}
	});

	function validLead(overrides: Partial<LeadConfig> = {}): LeadConfig {
		return {
			agentId: "product-lead",
			chatChannel: "222",
			match: { labels: ["Product"] },
			...overrides,
		};
	}

	it("accepts a lead without any alert fields (all optional)", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "geo",
				projectRoot: "/tmp/geo",
				leads: [validLead()],
			},
		]);
		const projects = loadProjects();
		expect(projects[0]!.leads[0]!.alertChannel).toBeUndefined();
		expect(projects[0]!.leads[0]!.alertBotTokenEnv).toBeUndefined();
		expect(projects[0]!.leads[0]!.alertDmUserId).toBeUndefined();
		expect(projects[0]!.leads[0]!.alertFallbackToCore).toBeUndefined();
	});

	it("preserves alertChannel / alertBotTokenEnv / alertDmUserId / alertFallbackToCore when valid", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "geo",
				projectRoot: "/tmp/geo",
				leads: [
					validLead({
						alertChannel: "1487340532610109520",
						alertBotTokenEnv: "SIMBA_BOT_TOKEN",
						alertDmUserId: "999",
						alertFallbackToCore: true,
					}),
				],
			},
		]);
		const lead = loadProjects()[0]!.leads[0]!;
		expect(lead.alertChannel).toBe("1487340532610109520");
		expect(lead.alertBotTokenEnv).toBe("SIMBA_BOT_TOKEN");
		expect(lead.alertDmUserId).toBe("999");
		expect(lead.alertFallbackToCore).toBe(true);
	});

	it("rejects empty-string alertChannel", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "geo",
				projectRoot: "/tmp/geo",
				leads: [validLead({ alertChannel: "" })],
			},
		]);
		expect(() => loadProjects()).toThrow(/alertChannel/);
	});

	it("rejects non-string alertBotTokenEnv", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "geo",
				projectRoot: "/tmp/geo",
				leads: [validLead({ alertBotTokenEnv: 42 as unknown as string })],
			},
		]);
		expect(() => loadProjects()).toThrow(/alertBotTokenEnv/);
	});

	it("rejects non-boolean alertFallbackToCore", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "geo",
				projectRoot: "/tmp/geo",
				leads: [
					validLead({
						alertFallbackToCore: "yes" as unknown as boolean,
					}),
				],
			},
		]);
		expect(() => loadProjects()).toThrow(/alertFallbackToCore/);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// FLY-247 WI-1: per-lead fleet fields — leads[].{model, backend}
// Plan: doc/engineer/plan/new/v1.40.0-FLY-247-fleet-config-dashboard.md §3.1
// ─────────────────────────────────────────────────────────────────────────────
describe("FLY-247 leads[].{model,backend} validation", () => {
	const originalEnv = process.env.FLYWHEEL_PROJECTS;

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.FLYWHEEL_PROJECTS;
		} else {
			process.env.FLYWHEEL_PROJECTS = originalEnv;
		}
	});

	function fleetLead(overrides: Partial<LeadConfig> = {}): LeadConfig {
		return {
			agentId: "product-lead",
			chatChannel: "222",
			match: { labels: ["Product"] },
			...overrides,
		};
	}

	function loadWith(lead: LeadConfig): ProjectEntry[] {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{ projectName: "geo", projectRoot: "/tmp/geo", leads: [lead] },
		]);
		return loadProjects();
	}

	it("accepts claude-code backend with a model, fields preserved verbatim", () => {
		const projects = loadWith(
			fleetLead({ model: "claude-fable-5", backend: "claude-code" }),
		);
		expect(projects[0]!.leads[0]!.model).toBe("claude-fable-5");
		expect(projects[0]!.leads[0]!.backend).toBe("claude-code");
	});

	it("does NOT lowercase or trim-rewrite a valid model id (case-sensitive)", () => {
		const projects = loadWith(fleetLead({ model: "Claude-Fable-5" }));
		expect(projects[0]!.leads[0]!.model).toBe("Claude-Fable-5");
	});

	it("rejects empty-string model", () => {
		expect(() => loadWith(fleetLead({ model: "" }))).toThrow(/model/);
	});

	it("rejects whitespace-only model", () => {
		expect(() => loadWith(fleetLead({ model: "   " }))).toThrow(/model/);
	});

	it("rejects non-string model", () => {
		expect(() =>
			loadWith(fleetLead({ model: 5 as unknown as string })),
		).toThrow(/model/);
	});

	it("rejects model containing control characters (plist safety boundary)", () => {
		expect(() => loadWith(fleetLead({ model: "claude\nfable" }))).toThrow(
			/model/,
		);
		expect(() => loadWith(fleetLead({ model: "claude\u0007fable" }))).toThrow(
			/model/,
		);
	});

	it("rejects unknown backend enum value (e.g. the Runner's claude-tmux)", () => {
		expect(() =>
			loadWith(
				fleetLead({ backend: "claude-tmux" as unknown as "claude-code" }),
			),
		).toThrow(/backend/);
	});

	it("rejects codex-app-server backend on a non-companion lead (FLY-245 fail-close)", () => {
		expect(() => loadWith(fleetLead({ backend: "codex-app-server" }))).toThrow(
			/FLY-245/,
		);
	});

	it("rejects codex-app-server when companion:true but canSpawnRunners defaults true", () => {
		expect(() =>
			loadWith(fleetLead({ backend: "codex-app-server", companion: true })),
		).toThrow(/FLY-245/);
	});

	it("rejects codex-app-server when companion:true but canSpawnRunners explicitly true", () => {
		expect(() =>
			loadWith(
				fleetLead({
					backend: "codex-app-server",
					companion: true,
					canSpawnRunners: true,
				}),
			),
		).toThrow(/FLY-245/);
	});

	it("accepts codex-app-server with companion:true AND canSpawnRunners:false", () => {
		const projects = loadWith(
			fleetLead({
				backend: "codex-app-server",
				companion: true,
				canSpawnRunners: false,
			}),
		);
		expect(projects[0]!.leads[0]!.backend).toBe("codex-app-server");
	});

	it("rejects unsafe identifier grammar (path separators) in agentId (R5#6)", () => {
		expect(() => loadWith(fleetLead({ agentId: "../escape" }))).toThrow(
			/agentId/,
		);
	});

	it("rejects exact-key collisions across (projectName, agentId) pairs (R5#6)", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "a-b",
				projectRoot: "/tmp/ab",
				leads: [{ agentId: "c", chatChannel: "1", match: { labels: ["P"] } }],
			},
			{
				projectName: "a",
				projectRoot: "/tmp/a",
				leads: [{ agentId: "b-c", chatChannel: "2", match: { labels: ["P"] } }],
			},
		]);
		expect(() => loadProjects()).toThrow(/collision/);
	});

	it("reverse-compat sentinel: leads without model/backend keep their exact object shape", () => {
		const projects = loadWith(fleetLead());
		const lead = projects[0]!.leads[0]!;
		// Fields must NOT be normalized into the in-memory object (FLY-231 pattern).
		expect(Object.keys(lead)).not.toContain("model");
		expect(Object.keys(lead)).not.toContain("backend");
	});
});
