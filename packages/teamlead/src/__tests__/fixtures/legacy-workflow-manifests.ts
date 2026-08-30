import {
	type LoadedWorkflowSeed,
	validateWorkflowManifest,
	type WorkflowManifestV1,
	type WorkflowManifestV2,
	workflowSeedContentHash,
} from "../../workflow-template.js";
import { LEGACY_WORKFLOW_SEED_DEFINITIONS } from "./legacy-workflow-seed-definitions.js";

export function legacyEngineeringManifest(): WorkflowManifestV1 {
	return {
		schema_version: 1,
		nodes: [
			{
				id: "design",
				type: "design",
				vendor: "claude",
				model: "claude-fable-5",
				handoff_pointer: { worktree: true, design_doc: true },
			},
			{
				id: "implement",
				type: "implement",
				vendor: "codex",
				model: "gpt-5.6-sol",
				effort: "xhigh",
				handoff_pointer: { worktree: true, design_doc: true },
			},
			{
				id: "qa",
				type: "qa",
				vendor: "claude",
				model: "opus",
				submissionWindowMinutes: 180,
				handoff_pointer: { worktree: true, design_doc: true },
			},
			{ id: "founder_gate", type: "gate" },
		],
		edges: [
			{
				id: "design_done",
				from: "design",
				to: "implement",
				condition: "design_done",
			},
			{
				id: "implement_done",
				from: "implement",
				to: "qa",
				condition: "implement_done",
			},
			{
				id: "qa_pass",
				from: "qa",
				to: "founder_gate",
				condition: "qa_pass",
			},
		],
		loops: [
			{
				id: "qa_retry",
				from: "qa",
				to: "implement",
				loop_when: "qa_fail",
				exit_when: "qa_pass",
				max_iterations: 3,
				on_limit: "escalate",
			},
			{
				id: "founder_feedback",
				from: "founder_gate",
				to: "implement",
				loop_when: "founder_feedback_kickback",
				exit_when: "founder_approved",
				max_iterations: 3,
				on_limit: "escalate",
			},
		],
		terminal_gate: { node: "founder_gate", predicate: "founder_approved" },
		ship_claims: ["qa_passed", "founder_approved"],
	};
}

export function legacyGenericManifest(): WorkflowManifestV2 {
	return {
		schema_version: 2,
		nodes: [
			{
				id: "execute",
				type: "generic",
				vendor: "codex",
				model: "gpt-5.6-sol",
				effort: "low",
				agent_file: ".flywheel/agents/nodes/general.md",
				produces_output: true,
				output: { schema: "json_v1", max_bytes: 262_144 },
			},
			{ id: "founder_gate", type: "gate" },
			{ id: "land", type: "land", execution: "engine" },
		],
		edges: [
			{
				id: "execute_done",
				from: "execute",
				to: "founder_gate",
				condition: "node_done",
			},
			{
				id: "founder_approved",
				from: "founder_gate",
				to: "land",
				condition: "founder_approved",
			},
		],
		loops: [],
		approval_gate: { node: "founder_gate", predicate: "founder_approved" },
		terminal_node: { node: "land" },
		ship_claims: ["founder_approved"],
	};
}

export function legacyLandEngineeringManifest(): WorkflowManifestV1 {
	const legacy = legacyEngineeringManifest();
	return {
		schema_version: 1,
		manifest_variant: "land_v1",
		nodes: [...legacy.nodes, { id: "land", type: "land", execution: "engine" }],
		edges: [
			...legacy.edges,
			{
				id: "founder_approved",
				from: "founder_gate",
				to: "land",
				condition: "founder_approved",
			},
		],
		loops: legacy.loops,
		approval_gate: { node: "founder_gate", predicate: "founder_approved" },
		terminal_node: { node: "land" },
		ship_claims: legacy.ship_claims,
	};
}

function seed(
	templateId: string,
	name: string,
	manifest: unknown,
): LoadedWorkflowSeed {
	const value = {
		templateId,
		name,
		projectScope: "global",
		manifest: validateWorkflowManifest(manifest),
	};
	return { ...value, contentHash: workflowSeedContentHash(value) };
}

export function legacyEngineeringSeed(
	templateId = "tpl_eng_heavy",
): LoadedWorkflowSeed {
	return seed(
		templateId,
		`Legacy engineering ${templateId}`,
		legacyEngineeringManifest(),
	);
}

/**
 * Test-only cutover fixture: retain historical node ids/topology while pinning
 * every executable node through the current registry contract. Production
 * history remains byte-for-byte schema v1 and receives no execution fallback.
 */
export function pinLegacyWorkflowSeedAgents(
	legacySeed: LoadedWorkflowSeed,
): LoadedWorkflowSeed {
	const roleByType = {
		design: "eng_design",
		implement: "implement",
		qa: "qa",
		review: "qa",
	} as const;
	const nodes = legacySeed.manifest.nodes.map((node) => {
		if (node.type === "gate" || node.type === "land") return node;
		if (node.type === "generic") {
			return node.role || node.agent_file
				? node
				: { ...node, agent_file: ".flywheel/agents/nodes/general.md" };
		}
		return {
			...node,
			effort: node.effort ?? ("high" as const),
			role: node.role ?? roleByType[node.type],
		};
	});
	const manifestInput =
		legacySeed.manifest.schema_version === 1 &&
		"manifest_variant" in legacySeed.manifest
			? (() => {
					const { manifest_variant: _variant, ...manifest } =
						legacySeed.manifest;
					return {
						...manifest,
						schema_version: 2 as const,
						nodes,
						loops: manifest.loops.filter(
							(loop) =>
								loop.exit_when === "qa_pass" ||
								loop.exit_when === "review_pass",
						),
					};
				})()
			: {
					...legacySeed.manifest,
					schema_version: 2 as const,
					nodes,
					loops: legacySeed.manifest.loops.filter(
						(loop) =>
							loop.exit_when === "qa_pass" || loop.exit_when === "review_pass",
					),
				};
	const manifest = validateWorkflowManifest(manifestInput);
	const value = { ...legacySeed, manifest };
	return { ...value, contentHash: workflowSeedContentHash(value) };
}

export function legacyGenericSeed(
	templateId = "tpl_generic",
): LoadedWorkflowSeed {
	return seed(
		templateId,
		`Legacy generic ${templateId}`,
		legacyGenericManifest(),
	);
}

export function legacyLandEngineeringSeed(
	templateId = "tpl_eng_heavy_land_v1",
): LoadedWorkflowSeed {
	return seed(
		templateId,
		`Legacy land engineering ${templateId}`,
		legacyLandEngineeringManifest(),
	);
}

export const LEGACY_WORKFLOW_TEMPLATE_IDS = [
	"tpl_eng_heavy",
	"tpl_eng_light",
	"tpl_eng_trivial",
	"tpl_product_v1",
	"tpl_eng_heavy_land_v1",
	"tpl_eng_light_land_v1",
	"tpl_eng_trivial_land_v1",
	"tpl_eng",
	"tpl_eng_land_v1",
	"tpl_product_designer",
	"tpl_product_prototype",
	"tpl_generic",
] as const;

export function legacyWorkflowSeed(templateId: string): LoadedWorkflowSeed {
	const definition = LEGACY_WORKFLOW_SEED_DEFINITIONS.find(
		(candidate) => candidate.template_id === templateId,
	);
	if (!definition)
		throw new Error(`unknown legacy workflow seed: ${templateId}`);
	return seed(templateId, definition.name, definition.manifest);
}

export function legacyWorkflowSeeds(): LoadedWorkflowSeed[] {
	return LEGACY_WORKFLOW_TEMPLATE_IDS.map(legacyWorkflowSeed);
}

export function importLegacyWorkflowSeeds(
	store: Pick<StateStore, "importWorkflowTemplateSeed">,
	env: Record<string, string | undefined> = process.env,
	_log: (message: string) => void = () => {},
): void {
	for (const workflowSeed of legacyWorkflowSeeds()) {
		store.importWorkflowTemplateSeed(workflowSeed, env);
	}
}

import type { StateStore } from "../../StateStore.js";
