import { describe, expect, it } from "vitest";
import { workflowNodeDisplayLabel } from "../workflow-display-labels.js";
import {
	buildWorkflowRunSnapshotV1,
	parseWorkflowRunSnapshot,
} from "../workflow-run-snapshot.js";
import { legacyEngineeringManifest } from "./fixtures/legacy-workflow-manifests.js";

describe("workflow display labels", () => {
	it.each([
		["tpl_code", "design", "设计(工程)"],
		["tpl_design", "produce", "产品设计"],
		["tpl_prd", "produce", "产品需求"],
		["tpl_prototype", "produce", "原型"],
		["tpl_generic_menu", "execute", "通用执行"],
	] as const)(
		"decodes historical %s/%s without exposing its id",
		(templateId, nodeId, label) => {
			expect(workflowNodeDisplayLabel(templateId, { id: nodeId })).toBe(label);
		},
	);

	it("prefers the backend manifest label and bounds custom-template fallback", () => {
		expect(
			workflowNodeDisplayLabel("tpl_code", {
				id: "eng_design",
				label: "设计(工程)",
			}),
		).toBe("设计(工程)");
		expect(workflowNodeDisplayLabel("tpl_custom", { id: "custom_step" })).toBe(
			"custom_step",
		);
	});

	it("parses a completed historical pin and labels its run/event tuple without an execution fallback", () => {
		const parsed = parseWorkflowRunSnapshot(
			JSON.stringify(
				buildWorkflowRunSnapshotV1({
					template: { id: "tpl_code", revision: 1 },
					manifest: legacyEngineeringManifest(),
				}),
			),
		);
		const node = parsed.resolved.nodes.find(
			(candidate) => candidate.id === "design",
		)!;
		expect(node.agent).toBeUndefined();
		expect(workflowNodeDisplayLabel(parsed.template.id, node)).toBe(
			"设计(工程)",
		);
		expect(workflowNodeDisplayLabel(parsed.template.id, { id: "design" })).toBe(
			"设计(工程)",
		);
	});
});
