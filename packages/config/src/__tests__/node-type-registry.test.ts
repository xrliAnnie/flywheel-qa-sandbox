import { describe, expect, it } from "vitest";
import {
	getNodeTypeRegistryEntry,
	NODE_TYPE_REGISTRY,
	nodeTypeWritesCode,
} from "../node-type-registry.js";
import {
	PHASE_THREAD_BADGE,
	THREE_STAGE_PHASE_SEQUENCE,
} from "../three-stage-phases.js";

describe("generalized workflow node-type registry", () => {
	it("keeps the legacy phase identity surface byte-compatible", () => {
		expect(
			THREE_STAGE_PHASE_SEQUENCE.map((id) => ({
				id,
				isPhaseRole: getNodeTypeRegistryEntry(id).isPhaseRole,
				preserveCompletionRole:
					getNodeTypeRegistryEntry(id).preserveCompletionRole,
				badge: getNodeTypeRegistryEntry(id).badge,
			})),
		).toEqual(
			THREE_STAGE_PHASE_SEQUENCE.map((id) => ({
				id,
				isPhaseRole: true,
				preserveCompletionRole: true,
				badge: PHASE_THREAD_BADGE[id],
			})),
		);
	});

	it("models generic and review as no-code types and derives D2 writers only from capabilities", () => {
		expect(Object.keys(NODE_TYPE_REGISTRY)).toEqual([
			"design",
			"implement",
			"qa",
			"gate",
			"generic",
			"review",
		]);
		expect(nodeTypeWritesCode("design")).toBe(true);
		expect(nodeTypeWritesCode("implement")).toBe(true);
		expect(nodeTypeWritesCode("generic")).toBe(false);
		expect(nodeTypeWritesCode("review")).toBe(false);
		expect(getNodeTypeRegistryEntry("generic").capabilities).toMatchObject({
			shared_branch_writer: false,
			creates_pr: false,
			can_ship: false,
			can_land: false,
			produces_output: false,
			completion_route: "no_code",
			output_mode: "none",
		});
		expect(
			getNodeTypeRegistryEntry("review").capabilities.needs_review_evidence,
		).toBe(true);
	});

	it("fails closed for an unknown node type", () => {
		expect(() => getNodeTypeRegistryEntry("mystery")).toThrow(
			/unknown workflow node type/i,
		);
	});
});
