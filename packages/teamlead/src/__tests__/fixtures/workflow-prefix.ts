import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildWorkflowRunSnapshotV1,
	buildWorkflowRunSnapshotV2,
	buildWorkflowRunSnapshotV3,
} from "../../workflow-run-snapshot.js";
import { legacyEngineeringManifest } from "./legacy-workflow-manifests.js";

export function createWorkflowPrefixFixture(
	root: string,
	version: 1 | 2 | 3 = 3,
	templateId = "tpl_code",
	profiles: {
		prefix_profile?: "legacy" | "role-v1";
		review_prefix_profile?: "legacy" | "role-v1";
	} = {},
) {
	mkdirSync(join(root, "agents"));
	mkdirSync(join(root, ".flywheel/menus"), { recursive: true });
	writeFileSync(
		join(root, ".flywheel/menus/ic-roster.yaml"),
		"implement: agents/role.md\nqa: agents/qa.md\n",
	);
	writeFileSync(
		join(root, "agents/role.md"),
		"---\nskills: [implement]\n---\nPinned role.\n",
	);
	writeFileSync(join(root, "agents/qa.md"), "Independent QA.\n");
	const authorId = version === 2 ? "author" : "implement";
	writeFileSync(
		join(root, ".flywheel/config.yaml"),
		"project: fly2913-fixture\n",
	);
	const template = { id: templateId, revision: 2 };
	const manifest = {
		schema_version: version,
		nodes: [
			{
				id: authorId,
				...profiles,
				type: "implement",
				vendor: "claude",
				model: "claude-fable-5",
				...(version === 2 ? { role: "implement" } : {}),
				effort: "high",
				...(version === 3 ? { handbook_ref: authorId } : {}),
			},
			{
				id: "qa",
				type: "qa",
				vendor: "codex",
				model: "gpt-5.6-sol",
				effort: "low",
				...(version === 3 ? { handbook_ref: "qa" } : {}),
			},
			{ id: "approval", type: "gate" },
		],
		edges: [
			{ id: "done", from: authorId, to: "qa", condition: "implement_done" },
			{ id: "pass", from: "qa", to: "approval", condition: "qa_pass" },
		],
		loops: [
			{
				id: "retry",
				from: "qa",
				to: authorId,
				loop_when: "qa_fail",
				exit_when: "qa_pass",
				max_iterations: 3,
				on_limit: "escalate",
			},
		],
		terminal_gate: { node: "approval", predicate: "founder_approved" },
		ship_claims: ["qa_passed", "founder_approved"],
	};
	const snapshot =
		version === 1
			? buildWorkflowRunSnapshotV1({
					template,
					manifest: {
						...legacyEngineeringManifest(),
						nodes: legacyEngineeringManifest().nodes.map((node) =>
							node.id === authorId ? { ...node, ...profiles } : node,
						),
					},
				})
			: (version === 2
					? buildWorkflowRunSnapshotV2
					: buildWorkflowRunSnapshotV3)({
					template,
					manifest,
					canonicalRoot: root,
				});
	return {
		root,
		snapshot,
		run: {
			run_id: "run-2913",
			template_id: templateId,
			template_revision: 2,
			snapshot: JSON.stringify(snapshot),
		},
		nodeId: authorId,
	};
}
