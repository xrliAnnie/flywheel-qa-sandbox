/**
 * FLY-127 / FLY-163: DepartmentRegistry — server-side spawn scope authorization.
 *
 * Decision precedence in isLeadInScope:
 *   1. project_unknown
 *   2. lead_unknown
 *   3. lead_cannot_spawn      (precedes label checks)
 *   4. issue_no_department_label
 *   5. issue_multiple_department_labels
 *   6. label_mismatch
 *   7. ok
 *
 * canSpawnRunners semantics (FLY-163):
 *   - Defaults to `true` when the field is absent (PM/triage leads must opt out
 *     with explicit `canSpawnRunners: false`)
 *   - Explicit value (true/false) always wins
 *   - Registry must defend even if loadProjects() normalization is bypassed
 *     (e.g., hand-written ProjectEntry[] in tests)
 */

import { describe, expect, it } from "vitest";
import { DepartmentRegistry } from "../department-registry.js";
import type { ProjectEntry } from "../ProjectConfig.js";

const baseProject = (): ProjectEntry => ({
	projectName: "TestProject",
	projectRoot: "/tmp/test-project",
	leads: [
		{
			agentId: "product-lead",
			chatChannel: "p-chat",
			match: { labels: ["Product"] },
		},
		{
			agentId: "ops-lead",
			chatChannel: "o-chat",
			match: { labels: ["Operations"] },
		},
		{
			agentId: "cos-lead",
			chatChannel: "c-chat",
			match: { labels: ["PM"] },
			// FLY-163: PM/triage leads MUST set explicit canSpawnRunners: false
			canSpawnRunners: false,
		},
	],
});

describe("DepartmentRegistry — canSpawnRunners", () => {
	it("defaults to true when field is absent (FLY-163)", () => {
		const registry = new DepartmentRegistry([baseProject()]);
		expect(registry.canSpawnRunners("TestProject", "product-lead")).toBe(true);
	});

	it("explicit false honored for PM/triage lead (FLY-163)", () => {
		const registry = new DepartmentRegistry([baseProject()]);
		expect(registry.canSpawnRunners("TestProject", "cos-lead")).toBe(false);
	});

	it("explicit true on a PM lead is honored by registry (validator is in loadProjects, not here)", () => {
		const project = baseProject();
		project.leads[2]!.canSpawnRunners = true;
		const registry = new DepartmentRegistry([project]);
		expect(registry.canSpawnRunners("TestProject", "cos-lead")).toBe(true);
	});

	it("explicit false overrides default-true for a dept lead", () => {
		const project = baseProject();
		project.leads[0]!.canSpawnRunners = false;
		const registry = new DepartmentRegistry([project]);
		expect(registry.canSpawnRunners("TestProject", "product-lead")).toBe(false);
	});

	it("returns false for unknown project (fail-closed)", () => {
		const registry = new DepartmentRegistry([baseProject()]);
		expect(registry.canSpawnRunners("nope", "product-lead")).toBe(false);
	});

	it("returns false for unknown lead (fail-closed)", () => {
		const registry = new DepartmentRegistry([baseProject()]);
		expect(registry.canSpawnRunners("TestProject", "marketing-lead")).toBe(
			false,
		);
	});
});

describe("DepartmentRegistry — classifyIssue", () => {
	it("classifies as 'none' when issue has zero labels", () => {
		const registry = new DepartmentRegistry([baseProject()]);
		const result = registry.classifyIssue("TestProject", []);
		expect(result.kind).toBe("none");
	});

	it("classifies as 'none' when issue labels match no spawning lead", () => {
		const registry = new DepartmentRegistry([baseProject()]);
		const result = registry.classifyIssue("TestProject", ["Marketing", "Bug"]);
		expect(result.kind).toBe("none");
	});

	it("classifies as 'one' when exactly one spawning lead matches", () => {
		const registry = new DepartmentRegistry([baseProject()]);
		const result = registry.classifyIssue("TestProject", ["Product"]);
		expect(result.kind).toBe("one");
		if (result.kind === "one") {
			expect(result.leadId).toBe("product-lead");
		}
	});

	it("classifies case-insensitively", () => {
		const registry = new DepartmentRegistry([baseProject()]);
		const result = registry.classifyIssue("TestProject", ["product"]);
		expect(result.kind).toBe("one");
	});

	it("classifies as 'one' when issue has dept label plus non-dept labels", () => {
		const registry = new DepartmentRegistry([baseProject()]);
		const result = registry.classifyIssue("TestProject", ["Product", "Bug"]);
		expect(result.kind).toBe("one");
	});

	it("classifies as 'many' when issue carries two dept labels", () => {
		const registry = new DepartmentRegistry([baseProject()]);
		const result = registry.classifyIssue("TestProject", [
			"Product",
			"Operations",
		]);
		expect(result.kind).toBe("many");
		if (result.kind === "many") {
			expect(result.leadIds).toContain("product-lead");
			expect(result.leadIds).toContain("ops-lead");
		}
	});

	it("ignores non-spawning leads (cos-lead's PM label) for classification", () => {
		const registry = new DepartmentRegistry([baseProject()]);
		const result = registry.classifyIssue("TestProject", ["PM"]);
		expect(result.kind).toBe("none");
	});

	it("returns 'none' for unknown project", () => {
		const registry = new DepartmentRegistry([baseProject()]);
		const result = registry.classifyIssue("nope", ["Product"]);
		expect(result.kind).toBe("none");
	});
});

describe("DepartmentRegistry — resolveCanonicalLead", () => {
	it("returns ok with the spawning lead on single-dept-label match", () => {
		const registry = new DepartmentRegistry([baseProject()]);
		const result = registry.resolveCanonicalLead("TestProject", ["Product"]);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.lead.agentId).toBe("product-lead");
		}
	});

	it("returns issue_no_department_label on empty / foreign labels", () => {
		const registry = new DepartmentRegistry([baseProject()]);
		const empty = registry.resolveCanonicalLead("TestProject", []);
		expect(empty.ok).toBe(false);
		if (!empty.ok) {
			expect(empty.decision.reason).toBe("issue_no_department_label");
		}

		const foreign = registry.resolveCanonicalLead("TestProject", ["Marketing"]);
		expect(foreign.ok).toBe(false);
		if (!foreign.ok) {
			expect(foreign.decision.reason).toBe("issue_no_department_label");
		}
	});

	it("returns issue_multiple_department_labels on multi-dept match", () => {
		const registry = new DepartmentRegistry([baseProject()]);
		const result = registry.resolveCanonicalLead("TestProject", [
			"Product",
			"Operations",
		]);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.decision.reason).toBe("issue_multiple_department_labels");
			expect(result.decision.matchedLeadIds).toEqual(
				expect.arrayContaining(["product-lead", "ops-lead"]),
			);
		}
	});

	it("returns project_unknown on unknown project", () => {
		const registry = new DepartmentRegistry([baseProject()]);
		const result = registry.resolveCanonicalLead("nope", ["Product"]);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.decision.reason).toBe("project_unknown");
		}
	});
});

describe("DepartmentRegistry — isLeadInScope (precedence)", () => {
	it("precedence 1: project_unknown beats everything", () => {
		const registry = new DepartmentRegistry([baseProject()]);
		const d = registry.isLeadInScope("nope", "product-lead", ["Product"]);
		expect(d.allowed).toBe(false);
		expect(d.reason).toBe("project_unknown");
	});

	it("precedence 2: lead_unknown when leadId not in project", () => {
		const registry = new DepartmentRegistry([baseProject()]);
		const d = registry.isLeadInScope("TestProject", "marketing-lead", [
			"Product",
		]);
		expect(d.allowed).toBe(false);
		expect(d.reason).toBe("lead_unknown");
	});

	it("precedence 3: lead_cannot_spawn beats label checks", () => {
		const registry = new DepartmentRegistry([baseProject()]);
		// cos-lead has PM label + explicit canSpawnRunners: false (FLY-163).
		// Even if we hand it an Operations label, reason should be lead_cannot_spawn,
		// not label_mismatch — the precedence rule.
		const d = registry.isLeadInScope("TestProject", "cos-lead", ["Operations"]);
		expect(d.allowed).toBe(false);
		expect(d.reason).toBe("lead_cannot_spawn");
	});

	it("precedence 4: issue_no_department_label when no spawning lead matches issue labels", () => {
		const registry = new DepartmentRegistry([baseProject()]);
		const d = registry.isLeadInScope("TestProject", "product-lead", [
			"Marketing",
		]);
		expect(d.allowed).toBe(false);
		expect(d.reason).toBe("issue_no_department_label");
	});

	it("precedence 5: issue_multiple_department_labels when issue spans 2 spawning leads", () => {
		const registry = new DepartmentRegistry([baseProject()]);
		const d = registry.isLeadInScope("TestProject", "product-lead", [
			"Product",
			"Operations",
		]);
		expect(d.allowed).toBe(false);
		expect(d.reason).toBe("issue_multiple_department_labels");
		expect(d.matchedLeadIds).toEqual(
			expect.arrayContaining(["product-lead", "ops-lead"]),
		);
	});

	it("precedence 6: label_mismatch when leadId is wrong dept for the issue's single label", () => {
		const registry = new DepartmentRegistry([baseProject()]);
		const d = registry.isLeadInScope("TestProject", "product-lead", [
			"Operations",
		]);
		expect(d.allowed).toBe(false);
		expect(d.reason).toBe("label_mismatch");
		expect(d.canonicalLeadId).toBe("ops-lead");
	});

	it("precedence 7: ok on exact match", () => {
		const registry = new DepartmentRegistry([baseProject()]);
		const d = registry.isLeadInScope("TestProject", "product-lead", [
			"Product",
		]);
		expect(d.allowed).toBe(true);
		expect(d.reason).toBe("ok");
		expect(d.canonicalLeadId).toBe("product-lead");
	});

	it("ok with case-insensitive label match", () => {
		const registry = new DepartmentRegistry([baseProject()]);
		const d = registry.isLeadInScope("TestProject", "product-lead", [
			"product",
		]);
		expect(d.allowed).toBe(true);
	});

	it("ok with extra non-dept labels alongside the dept label", () => {
		const registry = new DepartmentRegistry([baseProject()]);
		const d = registry.isLeadInScope("TestProject", "product-lead", [
			"Product",
			"Bug",
			"P0",
		]);
		expect(d.allowed).toBe(true);
	});

	it("populates a non-empty english message on every rejection", () => {
		const registry = new DepartmentRegistry([baseProject()]);
		const cases = [
			["nope", "product-lead", ["Product"]] as const,
			["TestProject", "marketing-lead", ["Product"]] as const,
			["TestProject", "cos-lead", ["Operations"]] as const,
			["TestProject", "product-lead", ["Marketing"]] as const,
			["TestProject", "product-lead", ["Product", "Operations"]] as const,
			["TestProject", "product-lead", ["Operations"]] as const,
		];
		for (const [project, leadId, labels] of cases) {
			const d = registry.isLeadInScope(project, leadId, [...labels]);
			expect(d.allowed).toBe(false);
			expect(d.message.length).toBeGreaterThan(0);
		}
	});
});
