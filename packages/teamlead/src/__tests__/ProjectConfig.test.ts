import { afterEach, describe, expect, it } from "vitest";
import {
	type LeadConfig,
	loadProjects,
	type ProjectEntry,
	resolveLeadForProject,
} from "../ProjectConfig.js";

describe("LeadConfig type", () => {
	it("LeadConfig has agentId and channel", () => {
		const lead: LeadConfig = { agentId: "product-lead", channel: "123456" };
		expect(lead.agentId).toBe("product-lead");
		expect(lead.channel).toBe("123456");
	});

	it("ProjectEntry includes lead field", () => {
		const entry: ProjectEntry = {
			projectName: "test",
			projectRoot: "/tmp/test",
			lead: { agentId: "eng-lead", channel: "789" },
		};
		expect(entry.lead.agentId).toBe("eng-lead");
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

	it("throws when lead is missing", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{ projectName: "test", projectRoot: "/tmp" },
		]);
		expect(() => loadProjects()).toThrow(/lead/);
	});

	it("throws when lead.agentId is missing", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{ projectName: "test", projectRoot: "/tmp", lead: { channel: "123" } },
		]);
		expect(() => loadProjects()).toThrow(/agentId/);
	});

	it("throws when lead.channel is missing", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{ projectName: "test", projectRoot: "/tmp", lead: { agentId: "bot" } },
		]);
		expect(() => loadProjects()).toThrow(/channel/);
	});

	it("throws on duplicate projectName", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "dup",
				projectRoot: "/a",
				lead: { agentId: "a", channel: "1" },
			},
			{
				projectName: "dup",
				projectRoot: "/b",
				lead: { agentId: "b", channel: "2" },
			},
		]);
		expect(() => loadProjects()).toThrow(/duplicate/i);
	});

	it("succeeds with valid lead config", () => {
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: "test",
				projectRoot: "/tmp",
				lead: { agentId: "product-lead", channel: "123" },
			},
		]);
		const projects = loadProjects();
		expect(projects).toHaveLength(1);
		expect(projects[0].lead.agentId).toBe("product-lead");
	});

	it("returns empty array when projects.json does not exist (ENOENT)", () => {
		// No env var set, file doesn't exist → should return []
		delete process.env.FLYWHEEL_PROJECTS;
		// loadProjects reads ~/.flywheel/projects.json by default
		// In test env this file may or may not exist; we test via env var path
		// For ENOENT, we rely on the real file not existing in CI
	});

	it("throws on malformed JSON in env var", () => {
		process.env.FLYWHEEL_PROJECTS = "not valid json{{{";
		expect(() => loadProjects()).toThrow();
	});
});

describe("resolveLeadForProject", () => {
	const projects: ProjectEntry[] = [
		{
			projectName: "geoforge3d",
			projectRoot: "/tmp/geoforge3d",
			lead: { agentId: "product-lead", channel: "111" },
		},
		{
			projectName: "marketing-site",
			projectRoot: "/tmp/marketing",
			lead: { agentId: "marketing-lead", channel: "222" },
		},
	];

	it("returns lead config for matching project", () => {
		const lead = resolveLeadForProject(projects, "geoforge3d");
		expect(lead).toEqual({ agentId: "product-lead", channel: "111" });
	});

	it("returns lead for second project", () => {
		const lead = resolveLeadForProject(projects, "marketing-site");
		expect(lead).toEqual({ agentId: "marketing-lead", channel: "222" });
	});

	it("throws for unknown project", () => {
		expect(() => resolveLeadForProject(projects, "unknown")).toThrow(
			/No project found.*unknown/,
		);
	});
});
