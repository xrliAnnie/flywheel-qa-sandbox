/**
 * FLY-222: routing-tuple validation tests (plan §Phase 2 / Codex R2 #6).
 */

import { describe, expect, it } from "vitest";
import type { LeadConfig, ProjectEntry } from "../ProjectConfig.js";
import { validateLearningRoutingTuple } from "../xiaohongshu-routing.js";

function lead(
	agentId: string,
	labels: string[],
	canSpawn?: boolean,
): LeadConfig {
	return {
		agentId,
		match: { labels },
		...(canSpawn !== undefined ? { canSpawnRunners: canSpawn } : {}),
	} as LeadConfig;
}

function project(name: string, leads: LeadConfig[]): ProjectEntry {
	return { projectName: name, leads } as ProjectEntry;
}

const PROJECTS: ProjectEntry[] = [
	project("sub", [lead("sub-lead", ["Sub"], true)]),
	project("geoforge3d", [
		lead("product-lead", ["Product"], true),
		lead("ops-lead", ["Operations"], true),
		lead("cos-lead", ["PM"], false),
	]),
];

describe("validateLearningRoutingTuple", () => {
	it("accepts a coherent tuple", () => {
		expect(
			validateLearningRoutingTuple(PROJECTS, "sub", {
				leadId: "sub-lead",
				departmentLabel: "Sub",
			}),
		).toEqual({ valid: true });
	});

	it("matches department_label case-insensitively", () => {
		expect(
			validateLearningRoutingTuple(PROJECTS, "geoforge3d", {
				leadId: "product-lead",
				departmentLabel: "product",
			}).valid,
		).toBe(true);
	});

	it("rejects an unknown project", () => {
		const r = validateLearningRoutingTuple(PROJECTS, "nope", {
			leadId: "x",
			departmentLabel: "y",
		});
		expect(r).toMatchObject({ valid: false, reason: "project_not_found" });
	});

	it("rejects a lead_id that is not in the project", () => {
		const r = validateLearningRoutingTuple(PROJECTS, "sub", {
			leadId: "ghost-lead",
			departmentLabel: "Sub",
		});
		expect(r).toMatchObject({ valid: false, reason: "lead_not_found" });
	});

	it("rejects a lead that cannot spawn runners", () => {
		const r = validateLearningRoutingTuple(PROJECTS, "geoforge3d", {
			leadId: "cos-lead",
			departmentLabel: "PM",
		});
		expect(r).toMatchObject({ valid: false, reason: "lead_cannot_spawn" });
	});

	it("rejects a department_label that matches no Lead", () => {
		const r = validateLearningRoutingTuple(PROJECTS, "sub", {
			leadId: "sub-lead",
			departmentLabel: "Marketing",
		});
		expect(r).toMatchObject({
			valid: false,
			reason: "label_routes_to_no_lead",
		});
	});

	it("rejects a department_label that routes to a DIFFERENT lead", () => {
		const r = validateLearningRoutingTuple(PROJECTS, "geoforge3d", {
			leadId: "product-lead",
			departmentLabel: "Operations",
		});
		expect(r).toMatchObject({
			valid: false,
			reason: "label_routes_to_other_lead",
		});
		if (!r.valid) expect(r.detail).toContain("ops-lead");
	});

	it("rejects a department_label that routes to MULTIPLE leads (ambiguous)", () => {
		const ambiguous = [
			project("multi", [
				lead("a-lead", ["Shared"], true),
				lead("b-lead", ["Shared"], true),
			]),
		];
		const r = validateLearningRoutingTuple(ambiguous, "multi", {
			leadId: "a-lead",
			departmentLabel: "Shared",
		});
		expect(r).toMatchObject({ valid: false, reason: "label_ambiguous" });
	});

	it("treats undefined canSpawnRunners as allowed (default true)", () => {
		const p = [project("p", [lead("l", ["L"])])];
		expect(
			validateLearningRoutingTuple(p, "p", {
				leadId: "l",
				departmentLabel: "L",
			}).valid,
		).toBe(true);
	});
});
