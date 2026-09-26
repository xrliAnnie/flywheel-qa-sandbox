import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalSubmissionDigest } from "flywheel-config";
import { parse } from "yaml";
import type { StateStore } from "./StateStore.js";

export const WORKFLOW_MANIFEST_SCHEMA_VERSION = 1 as const;

export const WORKFLOW_OUTCOME_VOCABULARY = {
	qa_pass: { claim: "qa_passed", edge: "qa_pass" },
	qa_fail: { claim: "qa_failed", edge: "qa_fail" },
	founder_approved: {
		claim: "founder_approved",
		edge: "founder_approved",
	},
} as const;

export type WorkflowNodeType = "design" | "implement" | "qa" | "gate";
export type WorkflowVendor = "claude" | "codex";
export type WorkflowEffort = "low" | "medium" | "high" | "xhigh";
export type WorkflowEdgeCondition =
	| "design_done"
	| "implement_done"
	| "qa_pass"
	| "founder_approved";

export interface WorkflowManifestNode {
	id: string;
	type: WorkflowNodeType;
	vendor?: WorkflowVendor;
	model?: string;
	effort?: WorkflowEffort;
	handoff_pointer?: { worktree: boolean; design_doc: boolean };
}

export interface WorkflowManifestEdge {
	id: string;
	from: string;
	to: string;
	condition: WorkflowEdgeCondition;
}

export interface WorkflowManifestLoop {
	id: string;
	from: string;
	to: string;
	loop_when: "qa_fail" | "founder_feedback_kickback";
	exit_when: "qa_pass";
	max_iterations: number;
	on_limit: "escalate";
}

export interface WorkflowManifestV1 {
	schema_version: 1;
	nodes: WorkflowManifestNode[];
	edges: WorkflowManifestEdge[];
	loops: WorkflowManifestLoop[];
	terminal_gate: { node: string; predicate: "founder_approved" };
	ship_claims: Array<"qa_passed" | "founder_approved">;
}

export interface WorkflowTemplateOverride {
	reason: string;
	nodes?: Record<
		string,
		{ model?: string; effort?: WorkflowEffort; skip?: boolean }
	>;
}

export interface LoadedWorkflowSeed {
	templateId: string;
	name: string;
	projectScope: string;
	manifest: WorkflowManifestV1;
	contentHash: string;
}

export function workflowSeedContentHash(
	seed: Pick<
		LoadedWorkflowSeed,
		"templateId" | "name" | "projectScope" | "manifest"
	>,
): string {
	return canonicalSubmissionDigest({
		templateId: seed.templateId,
		name: seed.name,
		projectScope: seed.projectScope,
		manifest: seed.manifest,
	});
}

function record(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${path} must be an object`);
	}
	return value as Record<string, unknown>;
}

function exactKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	path: string,
): void {
	const unknown = Object.keys(value).find((key) => !allowed.includes(key));
	if (unknown) throw new Error(`${path} unknown key: ${unknown}`);
}

function nonempty(value: unknown, path: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${path} must be a non-empty string`);
	}
	return value.trim();
}

function oneOf<T extends string>(
	value: unknown,
	values: readonly T[],
	path: string,
): T {
	if (typeof value !== "string" || !values.includes(value as T)) {
		throw new Error(`${path} must be one of: ${values.join(", ")}`);
	}
	return value as T;
}

function compatibleModel(vendor: WorkflowVendor, model: string): boolean {
	return vendor === "claude"
		? model.startsWith("claude-")
		: model.startsWith("gpt-");
}

function assertAcyclic(nodes: string[], edges: WorkflowManifestEdge[]): void {
	const outgoing = new Map<string, string[]>();
	for (const node of nodes) outgoing.set(node, []);
	for (const edge of edges) outgoing.get(edge.from)?.push(edge.to);
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (node: string): void => {
		if (visiting.has(node)) {
			throw new Error("ordinary edges contain an undeclared backedge/cycle");
		}
		if (visited.has(node)) return;
		visiting.add(node);
		for (const next of outgoing.get(node) ?? []) visit(next);
		visiting.delete(node);
		visited.add(node);
	};
	for (const node of nodes) visit(node);
}

/** Strict schema + semantic graph validation. Unknown keys fail at every level. */
export function validateWorkflowManifest(value: unknown): WorkflowManifestV1 {
	const root = record(value, "manifest");
	exactKeys(
		root,
		[
			"schema_version",
			"nodes",
			"edges",
			"loops",
			"terminal_gate",
			"ship_claims",
		],
		"manifest",
	);
	if (root.schema_version !== WORKFLOW_MANIFEST_SCHEMA_VERSION) {
		throw new Error("manifest.schema_version must be the supported version 1");
	}
	if (!Array.isArray(root.nodes) || root.nodes.length === 0) {
		throw new Error("manifest.nodes must be a non-empty array");
	}
	if (!Array.isArray(root.edges))
		throw new Error("manifest.edges must be an array");
	if (!Array.isArray(root.loops))
		throw new Error("manifest.loops must be an array");
	if (!Array.isArray(root.ship_claims)) {
		throw new Error("manifest.ship_claims must be an array");
	}

	const nodeIds = new Set<string>();
	const nodes = root.nodes.map((raw, index): WorkflowManifestNode => {
		const node = record(raw, `manifest.nodes[${index}]`);
		exactKeys(
			node,
			["id", "type", "vendor", "model", "effort", "handoff_pointer"],
			`manifest.nodes[${index}]`,
		);
		const id = nonempty(node.id, `manifest.nodes[${index}].id`);
		if (nodeIds.has(id)) throw new Error(`duplicate node id: ${id}`);
		nodeIds.add(id);
		const type = oneOf(
			node.type,
			["design", "implement", "qa", "gate"] as const,
			`manifest.nodes[${index}].type`,
		);
		if (type === "gate") {
			for (const key of ["vendor", "model", "effort", "handoff_pointer"]) {
				if (node[key] !== undefined) {
					throw new Error(`gate node ${id} cannot define ${key}`);
				}
			}
			return { id, type };
		}
		const vendor =
			node.vendor === undefined
				? undefined
				: oneOf(
						node.vendor,
						["claude", "codex"] as const,
						`manifest.nodes[${index}].vendor`,
					);
		const model =
			node.model === undefined
				? undefined
				: nonempty(node.model, `manifest.nodes[${index}].model`);
		if (model && !vendor) {
			throw new Error(`node ${id} model requires a vendor intent`);
		}
		if (vendor && model && !compatibleModel(vendor, model)) {
			throw new Error(
				`node ${id} vendor ${vendor} is incompatible with model ${model}`,
			);
		}
		let handoffPointer: WorkflowManifestNode["handoff_pointer"];
		if (node.handoff_pointer !== undefined) {
			const pointer = record(
				node.handoff_pointer,
				`manifest.nodes[${index}].handoff_pointer`,
			);
			exactKeys(
				pointer,
				["worktree", "design_doc"],
				`node ${id}.handoff_pointer`,
			);
			if (pointer.worktree !== true || pointer.design_doc !== true) {
				throw new Error(
					`node ${id} handoff_pointer must carry worktree and design_doc pointers`,
				);
			}
			handoffPointer = { worktree: true, design_doc: true };
		}
		const effort =
			node.effort === undefined
				? undefined
				: oneOf(
						node.effort,
						["low", "medium", "high", "xhigh"] as const,
						`manifest.nodes[${index}].effort`,
					);
		return {
			id,
			type,
			...(vendor ? { vendor } : {}),
			...(model ? { model } : {}),
			...(effort ? { effort } : {}),
			...(handoffPointer ? { handoff_pointer: handoffPointer } : {}),
		};
	});
	if (nodes.filter((node) => node.type === "qa").length !== 1) {
		throw new Error("manifest must contain exactly one independent QA node");
	}

	const edgeIds = new Set<string>();
	const edges = root.edges.map((raw, index): WorkflowManifestEdge => {
		const edge = record(raw, `manifest.edges[${index}]`);
		exactKeys(
			edge,
			["id", "from", "to", "condition"],
			`manifest.edges[${index}]`,
		);
		const id = nonempty(edge.id, `manifest.edges[${index}].id`);
		if (edgeIds.has(id)) throw new Error(`duplicate edge id: ${id}`);
		edgeIds.add(id);
		const from = nonempty(edge.from, `manifest.edges[${index}].from`);
		const to = nonempty(edge.to, `manifest.edges[${index}].to`);
		if (!nodeIds.has(from) || !nodeIds.has(to)) {
			throw new Error(`edge ${id} references an unknown node`);
		}
		return {
			id,
			from,
			to,
			condition: oneOf(
				edge.condition,
				[
					"design_done",
					"implement_done",
					"qa_pass",
					"founder_approved",
				] as const,
				`manifest.edges[${index}].condition`,
			),
		};
	});

	const loopIds = new Set<string>();
	const loops = root.loops.map((raw, index): WorkflowManifestLoop => {
		const loop = record(raw, `manifest.loops[${index}]`);
		exactKeys(
			loop,
			[
				"id",
				"from",
				"to",
				"loop_when",
				"exit_when",
				"max_iterations",
				"on_limit",
			],
			`manifest.loops[${index}]`,
		);
		const id = nonempty(loop.id, `manifest.loops[${index}].id`);
		if (loopIds.has(id) || edgeIds.has(id))
			throw new Error(`duplicate edge/loop id: ${id}`);
		loopIds.add(id);
		const from = nonempty(loop.from, `manifest.loops[${index}].from`);
		const to = nonempty(loop.to, `manifest.loops[${index}].to`);
		if (!nodeIds.has(from) || !nodeIds.has(to)) {
			throw new Error(`loop ${id} references an unknown node`);
		}
		if (
			!Number.isInteger(loop.max_iterations) ||
			Number(loop.max_iterations) <= 0
		) {
			throw new Error(`loop ${id}.max_iterations must be a positive integer`);
		}
		return {
			id,
			from,
			to,
			loop_when: oneOf(
				loop.loop_when,
				["qa_fail", "founder_feedback_kickback"] as const,
				`manifest.loops[${index}].loop_when`,
			),
			exit_when: oneOf(
				loop.exit_when,
				["qa_pass"] as const,
				`manifest.loops[${index}].exit_when`,
			),
			max_iterations: Number(loop.max_iterations),
			on_limit: oneOf(
				loop.on_limit,
				["escalate"] as const,
				`manifest.loops[${index}].on_limit`,
			),
		};
	});

	const terminal = record(root.terminal_gate, "manifest.terminal_gate");
	exactKeys(terminal, ["node", "predicate"], "manifest.terminal_gate");
	const terminalNode = nonempty(terminal.node, "manifest.terminal_gate.node");
	if (nodes.find((node) => node.id === terminalNode)?.type !== "gate") {
		throw new Error("terminal_gate.node must identify a gate node");
	}
	const terminalGate = {
		node: terminalNode,
		predicate: oneOf(
			terminal.predicate,
			["founder_approved"] as const,
			"terminal_gate.predicate",
		),
	};

	const shipClaims = root.ship_claims.map((claim, index) =>
		oneOf(
			claim,
			["qa_passed", "founder_approved"] as const,
			`manifest.ship_claims[${index}]`,
		),
	);
	if (new Set(shipClaims).size !== shipClaims.length) {
		throw new Error("manifest.ship_claims contains duplicates");
	}
	if (
		!shipClaims.includes("qa_passed") ||
		!shipClaims.includes("founder_approved")
	) {
		throw new Error(
			"manifest.ship_claims must require qa_passed and founder_approved",
		);
	}

	assertAcyclic(
		nodes.map((node) => node.id),
		edges,
	);
	const incoming = new Map(nodes.map((node) => [node.id, 0]));
	for (const edge of edges)
		incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
	const starts = nodes.filter((node) => incoming.get(node.id) === 0);
	if (starts.length !== 1)
		throw new Error("manifest must have exactly one start node");
	const reachable = new Set<string>();
	const queue = [starts[0]!.id];
	while (queue.length > 0) {
		const current = queue.shift()!;
		if (reachable.has(current)) continue;
		reachable.add(current);
		for (const edge of edges.filter(
			(candidate) => candidate.from === current,
		)) {
			queue.push(edge.to);
		}
	}
	if (reachable.size !== nodes.length)
		throw new Error("manifest contains an unreachable node");

	for (const node of nodes) {
		const conditions = edges
			.filter((edge) => edge.from === node.id)
			.map((edge) => edge.condition);
		const nodeLoops = loops.filter((loop) => loop.from === node.id);
		if (node.id === terminalNode) {
			if (conditions.length || nodeLoops.length)
				throw new Error("terminal gate cannot have outgoing edges");
			continue;
		}
		const expected =
			node.type === "design"
				? "design_done"
				: node.type === "implement"
					? "implement_done"
					: node.type === "qa"
						? "qa_pass"
						: undefined;
		if (!expected || conditions.length !== 1 || conditions[0] !== expected) {
			throw new Error(
				`node ${node.id} outgoing conditions are incomplete or ambiguous`,
			);
		}
		if (node.type === "qa") {
			if (
				nodeLoops.length !== 1 ||
				nodeLoops[0]!.loop_when !== "qa_fail" ||
				nodeLoops[0]!.exit_when !== "qa_pass"
			) {
				throw new Error(
					`QA node ${node.id} requires a qa_fail loop with qa_pass exit`,
				);
			}
		} else if (nodeLoops.length > 0) {
			throw new Error(`node ${node.id} cannot own a loop`);
		}
	}

	return {
		schema_version: 1,
		nodes,
		edges,
		loops,
		terminal_gate: terminalGate,
		ship_claims: shipClaims,
	};
}

export function parseWorkflowManifestYaml(source: string): WorkflowManifestV1 {
	return validateWorkflowManifest(parse(source));
}

export function applyWorkflowOverride(
	manifestValue: unknown,
	overrideValue: unknown,
): { manifest: WorkflowManifestV1; override: WorkflowTemplateOverride } {
	const manifest = validateWorkflowManifest(manifestValue);
	const override = record(overrideValue, "override");
	exactKeys(override, ["reason", "nodes"], "override");
	const reason = nonempty(override.reason, "override.reason");
	const nodeOverrides =
		override.nodes === undefined
			? {}
			: record(override.nodes, "override.nodes");
	const next = structuredClone(manifest);
	for (const [nodeId, raw] of Object.entries(nodeOverrides)) {
		const nodeOverride = record(raw, `override.nodes.${nodeId}`);
		exactKeys(
			nodeOverride,
			["model", "effort", "skip"],
			`override.nodes.${nodeId}`,
		);
		const node = next.nodes.find((candidate) => candidate.id === nodeId);
		if (!node) throw new Error(`override references unknown node: ${nodeId}`);
		if (node.type === "gate")
			throw new Error(`gate node ${nodeId} cannot be overridden`);
		if (nodeOverride.model !== undefined) {
			const model = nonempty(
				nodeOverride.model,
				`override.nodes.${nodeId}.model`,
			);
			if (!node.vendor || !compatibleModel(node.vendor, model)) {
				throw new Error(
					`node ${nodeId} vendor is incompatible with override model ${model}`,
				);
			}
			node.model = model;
		}
		if (nodeOverride.effort !== undefined) {
			node.effort = oneOf(
				nodeOverride.effort,
				["low", "medium", "high", "xhigh"] as const,
				`override.nodes.${nodeId}.effort`,
			);
		}
		if (
			nodeOverride.skip !== undefined &&
			typeof nodeOverride.skip !== "boolean"
		) {
			throw new Error(`override.nodes.${nodeId}.skip must be boolean`);
		}
		if (nodeOverride.skip === true) {
			if (node.type === "qa")
				throw new Error(`cannot skip independent QA node ${nodeId}`);
			if (
				next.loops.some((loop) => loop.from === nodeId || loop.to === nodeId)
			) {
				throw new Error(
					`cannot skip node ${nodeId} because a declared loop depends on it`,
				);
			}
			const incoming = next.edges.filter((edge) => edge.to === nodeId);
			const outgoing = next.edges.filter((edge) => edge.from === nodeId);
			if (incoming.length > 1 || outgoing.length !== 1) {
				throw new Error(
					`cannot skip node ${nodeId}: graph cannot be rewired unambiguously`,
				);
			}
			next.nodes = next.nodes.filter((candidate) => candidate.id !== nodeId);
			next.edges = next.edges.filter(
				(edge) => edge.from !== nodeId && edge.to !== nodeId,
			);
			if (incoming[0]) {
				next.edges.push({
					id: `override_skip_${nodeId}`,
					from: incoming[0].from,
					to: outgoing[0]!.to,
					condition: incoming[0].condition,
				});
			}
		}
	}
	return {
		manifest: validateWorkflowManifest(next),
		override: {
			reason,
			...(Object.keys(nodeOverrides).length > 0
				? {
						nodes: structuredClone(
							nodeOverrides,
						) as WorkflowTemplateOverride["nodes"],
					}
				: {}),
		},
	};
}

const BUNDLED_SEED_FILES = [
	"tpl_eng_heavy.yaml",
	"tpl_eng_light.yaml",
	"tpl_eng_trivial.yaml",
] as const;

export function loadBundledWorkflowSeeds(): LoadedWorkflowSeed[] {
	const directory = fileURLToPath(
		new URL("./workflow-seeds/", import.meta.url),
	);
	return BUNDLED_SEED_FILES.map((filename) => {
		const raw = record(
			parse(readFileSync(join(directory, filename), "utf8")),
			`seed ${filename}`,
		);
		exactKeys(
			raw,
			["template_id", "name", "project_scope", "manifest"],
			`seed ${filename}`,
		);
		const manifest = validateWorkflowManifest(raw.manifest);
		const seed = {
			templateId: nonempty(raw.template_id, `${filename}.template_id`),
			name: nonempty(raw.name, `${filename}.name`),
			projectScope: nonempty(raw.project_scope, `${filename}.project_scope`),
			manifest,
		};
		return { ...seed, contentHash: workflowSeedContentHash(seed) };
	});
}

export function importBundledWorkflowSeeds(
	store: Pick<StateStore, "importWorkflowTemplateSeed">,
): void {
	for (const seed of loadBundledWorkflowSeeds())
		store.importWorkflowTemplateSeed(seed);
}
