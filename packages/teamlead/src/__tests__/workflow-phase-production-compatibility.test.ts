import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	buildWorkflowRunSnapshotV2,
	buildWorkflowRunSnapshotV3,
} from "../workflow-run-snapshot.js";
import { validateWorkflowManifest } from "../workflow-template.js";

const captured = JSON.parse(
	readFileSync(
		new URL("./fixtures/fly2533-published-workflows.json", import.meta.url),
		"utf8",
	),
) as {
	templates: Array<{ templateId: string; revision: number; manifest: unknown }>;
};
const canonicalRoot = fileURLToPath(new URL("../../../../", import.meta.url));

describe("FLY-2533 published workflow and real role compatibility", () => {
	it("materializes every captured production type/role combination using unchanged real role files", () => {
		const combinations = new Set<string>();
		expect(captured.templates).toHaveLength(6);
		for (const { templateId, revision, manifest: raw } of captured.templates) {
			const manifest = validateWorkflowManifest(raw);
			expect(manifest.schema_version, templateId).not.toBe(1);
			const build =
				manifest.schema_version === 3
					? buildWorkflowRunSnapshotV3
					: buildWorkflowRunSnapshotV2;
			const snapshot = build({
				template: { id: templateId, revision },
				manifest,
				canonicalRoot,
			});
			for (const node of manifest.nodes) {
				const resolved = snapshot.resolved.nodes.find(
					(item) => item.id === node.id,
				)!;
				if (node.type === "gate" || node.type === "land") {
					expect(resolved.agent).toBeUndefined();
					continue;
				}
				combinations.add(
					`${node.type}:${node.handbook_ref ?? node.role ?? node.id}`,
				);
				expect(resolved.agent?.content, `${templateId}/${node.id}`).toMatch(
					new RegExp(`^# Workflow phase protocol: ${node.type}\\n`),
				);
				expect(resolved.agent?.content).not.toContain(
					"FLYWHEEL_PHASE_PROTOCOL:",
				);
			}
		}
		expect([...combinations].sort()).toEqual([
			"design:eng_design",
			"generic:general",
			"generic:pm",
			"generic:product_design",
			"generic:proto",
			"implement:implement",
			"qa:qa",
		]);
	});
});
