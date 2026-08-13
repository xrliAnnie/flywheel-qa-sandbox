import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	getNodeTypeRegistryEntry,
	NODE_TYPE_REGISTRY,
	nodeTypeWritesCode,
} from "../node-type-registry.js";
import {
	isWorkflowPhaseRole,
	PHASE_ROLE_SEQUENCE,
	PHASE_THREAD_BADGE,
	phaseThreadBadge,
	resolveCompletionSessionRole,
} from "../phase-roles.js";

describe("generalized workflow node-type registry", () => {
	it("derives DAG workflow identity from the registry", () => {
		expect(
			PHASE_ROLE_SEQUENCE.map((id) => ({
				id,
				isPhaseRole: getNodeTypeRegistryEntry(id).isPhaseRole,
				preserveCompletionRole:
					getNodeTypeRegistryEntry(id).preserveCompletionRole,
				badge: getNodeTypeRegistryEntry(id).badge,
			})),
		).toEqual(
			PHASE_ROLE_SEQUENCE.map((id) => ({
				id,
				isPhaseRole: true,
				preserveCompletionRole: true,
				badge: PHASE_THREAD_BADGE[id],
			})),
		);
	});

	it("models review as a no-code type, generic as a full work-producing type, and derives D2 writers only from capabilities", () => {
		expect(Object.keys(NODE_TYPE_REGISTRY)).toEqual([
			"design",
			"implement",
			"qa",
			"gate",
			"land",
			"generic",
			"review",
		]);
		expect(nodeTypeWritesCode("design")).toBe(true);
		expect(nodeTypeWritesCode("implement")).toBe(true);
		expect(nodeTypeWritesCode("generic")).toBe(true);
		expect(nodeTypeWritesCode("review")).toBe(false);
		expect(getNodeTypeRegistryEntry("land").capabilities).toMatchObject({
			shared_branch_writer: false,
			creates_pr: false,
			can_ship: true,
			can_land: true,
			completion_route: "no_code",
		});
		// generic is the default single-stage dispatch type: it must be able to
		// write, open a PR, and land, otherwise the engine injects a "no-write
		// node" instruction and single-stage work has nowhere to land.
		// completion_route is "needs_review" because creates_pr makes this node a
		// ship-bundle carrier, and resolveWorkflowGateAuthority rejects a carrier
		// on any other route (incoherent_ship_bundle).
		expect(getNodeTypeRegistryEntry("generic").capabilities).toEqual({
			...getNodeTypeRegistryEntry("implement").capabilities,
			allow_no_code_completion: true,
		});
		expect(getNodeTypeRegistryEntry("generic").capabilities).toMatchObject({
			shared_branch_writer: true,
			creates_pr: true,
			can_ship: true,
			can_land: true,
			approval_gate_holder: true,
			needs_review_evidence: true,
			needs_mailbox_transport: true,
			keepalive_park: true,
			produces_output: false,
			completion_route: "needs_review",
			output_mode: "none",
		});
		expect(
			getNodeTypeRegistryEntry("review").capabilities.needs_review_evidence,
		).toBe(true);
		expect(getNodeTypeRegistryEntry("qa").submissionWindowMinutes).toBe(360);
		expect(
			getNodeTypeRegistryEntry("review").submissionWindowMinutes,
		).toBeUndefined();
	});

	it("fails closed for an unknown node type", () => {
		expect(() => getNodeTypeRegistryEntry("mystery")).toThrow(
			/unknown workflow node type/i,
		);
	});

	it("is the only source for role identity, completion preservation, and badges", () => {
		const registrySource = readFileSync(
			new URL("../node-type-registry.ts", import.meta.url),
			"utf8",
		);
		const phaseSource = readFileSync(
			new URL("../phase-roles.ts", import.meta.url),
			"utf8",
		);
		expect(registrySource).not.toMatch(/from ["'].\/phase-roles\.js["']/);
		expect(phaseSource).toMatch(/from ["'].\/node-type-registry\.js["']/);

		const design = NODE_TYPE_REGISTRY.design as {
			isPhaseRole: boolean;
			preserveCompletionRole: boolean;
			badge: string;
		};
		const original = { ...design };
		try {
			design.isPhaseRole = false;
			expect(isWorkflowPhaseRole("design")).toBe(false);

			design.isPhaseRole = true;
			design.preserveCompletionRole = false;
			expect(resolveCompletionSessionRole("design", "main")).toBe("main");

			design.badge = "fixture-badge";
			expect(phaseThreadBadge("design")).toBe("fixture-badge");
		} finally {
			Object.assign(design, original);
		}
	});
});
