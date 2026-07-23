import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	canonicalSubmissionDigest,
	getModelRegistryEntry,
	isModelSelectionSupported,
	nodeTypeWritesCode,
} from "flywheel-config";
import { parse } from "yaml";
import type { StateStore } from "./StateStore.js";
import { ENG_TIERS, type EngTier } from "./work-kind.js";

export const WORKFLOW_MANIFEST_SCHEMA_VERSION = 1 as const;
export const GENERALIZED_WORKFLOW_MANIFEST_SCHEMA_VERSION = 2 as const;

type EnvLike = Record<string, string | undefined>;

export function isGeneralizedTemplatesEnabled(env: EnvLike): boolean {
	return env.FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES === "1";
}

export const WORKFLOW_OUTCOME_VOCABULARY = {
	qa_pass: { claim: "qa_passed", edge: "qa_pass" },
	qa_fail: { claim: "qa_failed", edge: "qa_fail" },
	founder_approved: {
		claim: "founder_approved",
		edge: "founder_approved",
	},
} as const;

export type WorkflowNodeType =
	| "design"
	| "implement"
	| "qa"
	| "gate"
	| "land"
	| "generic"
	| "review";
export type WorkflowVendor = "claude" | "codex";
export type WorkflowEffort = "low" | "medium" | "high" | "xhigh";
export type WorkflowEdgeCondition =
	| "design_done"
	| "implement_done"
	| "qa_pass"
	| "node_done"
	| "review_pass"
	| "founder_approved";

export interface WorkflowOutputContract {
	schema: "json_v1";
	max_bytes: number;
}

export interface WorkflowManifestNode {
	id: string;
	type: WorkflowNodeType;
	vendor?: WorkflowVendor;
	model?: string;
	effort?: WorkflowEffort;
	handoff_pointer?: { worktree: boolean; design_doc: boolean };
	agent_file?: string;
	produces_output?: boolean;
	output?: WorkflowOutputContract;
	execution?: "engine";
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
	loop_when: "qa_fail" | "review_fail" | "founder_feedback_kickback";
	exit_when: "qa_pass" | "review_pass" | "founder_approved";
	max_iterations: number;
	on_limit: "escalate";
}

export interface WorkflowManifestV1Legacy {
	schema_version: 1;
	nodes: WorkflowManifestNode[];
	edges: WorkflowManifestEdge[];
	loops: WorkflowManifestLoop[];
	terminal_gate: { node: string; predicate: "founder_approved" };
	ship_claims: Array<"qa_passed" | "founder_approved">;
	tier_presets?: Partial<Record<EngTier, WorkflowTemplateOverride>>;
}

export interface WorkflowManifestV1Land {
	schema_version: 1;
	manifest_variant: "land_v1";
	nodes: WorkflowManifestNode[];
	edges: WorkflowManifestEdge[];
	loops: WorkflowManifestLoop[];
	approval_gate: { node: string; predicate: "founder_approved" };
	terminal_node: { node: string };
	ship_claims: Array<"qa_passed" | "founder_approved">;
	tier_presets?: Partial<Record<EngTier, WorkflowTemplateOverride>>;
}

export type WorkflowManifestV1 =
	| WorkflowManifestV1Legacy
	| WorkflowManifestV1Land;

export interface WorkflowManifestV2 {
	schema_version: 2;
	nodes: WorkflowManifestNode[];
	edges: WorkflowManifestEdge[];
	loops: WorkflowManifestLoop[];
	terminal_gate: { node: string; predicate: "founder_approved" };
	ship_claims: Array<
		"qa_passed" | "design_review_approved" | "founder_approved"
	>;
	tier_presets?: Partial<Record<EngTier, WorkflowTemplateOverride>>;
}

export type WorkflowManifest = WorkflowManifestV1 | WorkflowManifestV2;

export interface WorkflowTemplateOverride {
	reason: string;
	nodes?: Record<
		string,
		{
			vendor?: WorkflowVendor;
			model?: string;
			effort?: WorkflowEffort;
			skip?: boolean;
		}
	>;
}

export interface LoadedWorkflowSeed {
	templateId: string;
	name: string;
	projectScope: string;
	manifest: WorkflowManifest;
	contentHash: string;
}

export interface WorkflowManifestValidationOptions {
	/**
	 * Persisted manifests may outlive a registry entry. Read/repair surfaces use
	 * this mode to keep the graph editable; all authoring and run materialization
	 * paths retain strict canonical-registry validation.
	 */
	allowUnsupportedModels?: boolean;
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

function canonicalWorkflowModel(
	vendor: WorkflowVendor,
	model: string,
	effort?: WorkflowEffort,
): string {
	const registered = getModelRegistryEntry(model);
	if (
		!registered ||
		!isModelSelectionSupported({
			surface: "workflow",
			model,
			effort,
			runtimeVendor: vendor,
		})
	) {
		throw new Error(
			`model ${model} is not supported by the canonical workflow registry for vendor ${vendor}${effort ? ` and effort ${effort}` : ""}`,
		);
	}
	return registered.id;
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

function validateTierPresets(
	manifest: WorkflowManifest,
	value: unknown,
): Partial<Record<EngTier, WorkflowTemplateOverride>> | undefined {
	if (value === undefined) return undefined;
	const presets = record(value, "manifest.tier_presets");
	exactKeys(presets, ENG_TIERS, "manifest.tier_presets");
	if (!Object.hasOwn(presets, "heavy")) {
		throw new Error("manifest.tier_presets must define the default heavy tier");
	}
	const normalized: Partial<Record<EngTier, WorkflowTemplateOverride>> = {};
	for (const tier of ENG_TIERS) {
		if (presets[tier] === undefined) continue;
		normalized[tier] = applyWorkflowOverride(manifest, presets[tier]).override;
	}
	return normalized;
}

/** Strict schema + semantic graph validation. Unknown keys fail at every level. */
function validateWorkflowManifestV1(
	value: unknown,
	options: WorkflowManifestValidationOptions = {},
): WorkflowManifestV1 {
	const root = record(value, "manifest");
	const isLandVariant = root.manifest_variant === "land_v1";
	exactKeys(
		root,
		isLandVariant
			? [
					"schema_version",
					"manifest_variant",
					"nodes",
					"edges",
					"loops",
					"approval_gate",
					"terminal_node",
					"ship_claims",
					"tier_presets",
				]
			: [
					"schema_version",
					"nodes",
					"edges",
					"loops",
					"terminal_gate",
					"ship_claims",
					"tier_presets",
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
			isLandVariant
				? [
						"id",
						"type",
						"vendor",
						"model",
						"effort",
						"handoff_pointer",
						"execution",
					]
				: ["id", "type", "vendor", "model", "effort", "handoff_pointer"],
			`manifest.nodes[${index}]`,
		);
		const id = nonempty(node.id, `manifest.nodes[${index}].id`);
		if (nodeIds.has(id)) throw new Error(`duplicate node id: ${id}`);
		nodeIds.add(id);
		const type = oneOf(
			node.type,
			(isLandVariant
				? ["design", "implement", "qa", "gate", "land"]
				: ["design", "implement", "qa", "gate"]) as readonly WorkflowNodeType[],
			`manifest.nodes[${index}].type`,
		);
		if (type === "land") {
			if (node.execution !== "engine") {
				throw new Error(`land node ${id} must define execution: engine`);
			}
			for (const key of ["vendor", "model", "effort", "handoff_pointer"]) {
				if (node[key] !== undefined) {
					throw new Error(`land node ${id} cannot define ${key}`);
				}
			}
			return { id, type, execution: "engine" };
		}
		if (type === "gate") {
			for (const key of [
				"vendor",
				"model",
				"effort",
				"handoff_pointer",
				"execution",
			]) {
				if (node[key] !== undefined) {
					throw new Error(`gate node ${id} cannot define ${key}`);
				}
			}
			return { id, type };
		}
		if (node.execution !== undefined) {
			throw new Error(`node ${id} cannot define execution`);
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
		if (effort && (!vendor || !model)) {
			throw new Error(`node ${id} effort requires a vendor and model`);
		}
		const canonicalModel =
			vendor && model
				? options.allowUnsupportedModels
					? model
					: canonicalWorkflowModel(vendor, model, effort)
				: model;
		return {
			id,
			type,
			...(vendor ? { vendor } : {}),
			...(canonicalModel ? { model: canonicalModel } : {}),
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
				(isLandVariant
					? ["qa_pass", "founder_approved"]
					: ["qa_pass"]) as readonly ("qa_pass" | "founder_approved")[],
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

	const gatePath = isLandVariant
		? "manifest.approval_gate"
		: "manifest.terminal_gate";
	const gateRoot = record(
		isLandVariant ? root.approval_gate : root.terminal_gate,
		gatePath,
	);
	exactKeys(gateRoot, ["node", "predicate"], gatePath);
	const approvalGateNode = nonempty(gateRoot.node, `${gatePath}.node`);
	if (nodes.find((node) => node.id === approvalGateNode)?.type !== "gate") {
		throw new Error(`${gatePath}.node must identify a gate node`);
	}
	const approvalGate = {
		node: approvalGateNode,
		predicate: oneOf(
			gateRoot.predicate,
			["founder_approved"] as const,
			`${gatePath}.predicate`,
		),
	};
	let terminalNode = approvalGateNode;
	if (isLandVariant) {
		const terminal = record(root.terminal_node, "manifest.terminal_node");
		exactKeys(terminal, ["node"], "manifest.terminal_node");
		terminalNode = nonempty(terminal.node, "manifest.terminal_node.node");
		if (nodes.find((node) => node.id === terminalNode)?.type !== "land") {
			throw new Error("terminal_node.node must identify a land node");
		}
	}

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
						: isLandVariant && node.id === approvalGateNode
							? "founder_approved"
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
		} else if (isLandVariant && node.id === approvalGateNode) {
			if (
				nodeLoops.length !== 1 ||
				nodeLoops[0]!.loop_when !== "founder_feedback_kickback" ||
				nodeLoops[0]!.exit_when !== "founder_approved"
			) {
				throw new Error(
					`approval gate ${node.id} requires a founder_feedback_kickback loop`,
				);
			}
		} else if (nodeLoops.length > 0) {
			throw new Error(`node ${node.id} cannot own a loop`);
		}
	}

	const manifest: WorkflowManifestV1 = isLandVariant
		? {
				schema_version: 1,
				manifest_variant: "land_v1",
				nodes,
				edges,
				loops,
				approval_gate: approvalGate,
				terminal_node: { node: terminalNode },
				ship_claims: shipClaims,
			}
		: {
				schema_version: 1,
				nodes,
				edges,
				loops,
				terminal_gate: approvalGate,
				ship_claims: shipClaims,
			};
	const tierPresets = validateTierPresets(manifest, root.tier_presets);
	return tierPresets ? { ...manifest, tier_presets: tierPresets } : manifest;
}

export function isWorkflowManifestV1Land(
	manifest: WorkflowManifestV1 | WorkflowManifestV2,
): manifest is WorkflowManifestV1Land {
	return (
		manifest.schema_version === 1 &&
		"manifest_variant" in manifest &&
		manifest.manifest_variant === "land_v1"
	);
}

export function workflowApprovalGate(
	manifest: WorkflowManifestV1 | WorkflowManifestV2,
): { node: string; predicate: "founder_approved" } {
	return isWorkflowManifestV1Land(manifest)
		? manifest.approval_gate
		: manifest.terminal_gate;
}

export function workflowTerminalNode(
	manifest: WorkflowManifestV1 | WorkflowManifestV2,
): string {
	return isWorkflowManifestV1Land(manifest)
		? manifest.terminal_node.node
		: manifest.terminal_gate.node;
}

function assertSafeAgentFile(value: unknown, path: string): string {
	const relative = nonempty(value, path);
	if (
		isAbsolute(relative) ||
		/^[A-Za-z]:[\\/]/.test(relative) ||
		relative.startsWith("\\\\") ||
		relative.split(/[\\/]/).includes("..")
	) {
		throw new Error(`${path} must be a safe relative path`);
	}
	return relative;
}

function validateWorkflowManifestV2(
	value: unknown,
	nodeWritesCode: (type: WorkflowNodeType) => boolean = nodeTypeWritesCode,
): WorkflowManifestV2 {
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
			"tier_presets",
		],
		"manifest",
	);
	if (root.schema_version !== GENERALIZED_WORKFLOW_MANIFEST_SCHEMA_VERSION) {
		throw new Error("manifest.schema_version must be the supported version 2");
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
		const nodePath = `manifest.nodes[${index}]`;
		const node = record(raw, nodePath);
		exactKeys(
			node,
			[
				"id",
				"type",
				"vendor",
				"model",
				"effort",
				"handoff_pointer",
				"agent_file",
				"produces_output",
				"output",
			],
			nodePath,
		);
		const id = nonempty(node.id, `${nodePath}.id`);
		if (nodeIds.has(id)) throw new Error(`duplicate node id: ${id}`);
		nodeIds.add(id);
		const type = oneOf(
			node.type,
			["design", "implement", "qa", "gate", "generic", "review"] as const,
			`${nodePath}.type`,
		);
		if (type === "gate") {
			for (const key of [
				"vendor",
				"model",
				"effort",
				"handoff_pointer",
				"agent_file",
				"produces_output",
				"output",
			]) {
				if (node[key] !== undefined) {
					throw new Error(`gate node ${id} cannot define ${key}`);
				}
			}
			return { id, type };
		}
		if (type !== "generic") {
			for (const key of ["agent_file", "produces_output", "output"]) {
				if (node[key] !== undefined) {
					throw new Error(`node ${id} of type ${type} cannot define ${key}`);
				}
			}
		}
		const vendor =
			node.vendor === undefined
				? undefined
				: oneOf(
						node.vendor,
						["claude", "codex"] as const,
						`${nodePath}.vendor`,
					);
		const model =
			node.model === undefined
				? undefined
				: nonempty(node.model, `${nodePath}.model`);
		if (model && !vendor) {
			throw new Error(`node ${id} model requires a vendor intent`);
		}
		if (vendor && model && !compatibleModel(vendor, model)) {
			throw new Error(
				`node ${id} vendor ${vendor} is incompatible with model ${model}`,
			);
		}
		const effort =
			node.effort === undefined
				? undefined
				: oneOf(
						node.effort,
						["low", "medium", "high", "xhigh"] as const,
						`${nodePath}.effort`,
					);
		let handoffPointer: WorkflowManifestNode["handoff_pointer"];
		if (node.handoff_pointer !== undefined) {
			const pointer = record(
				node.handoff_pointer,
				`${nodePath}.handoff_pointer`,
			);
			exactKeys(
				pointer,
				["worktree", "design_doc"],
				`${nodePath}.handoff_pointer`,
			);
			if (pointer.worktree !== true || pointer.design_doc !== true) {
				throw new Error(
					`node ${id} handoff_pointer must carry worktree and design_doc pointers`,
				);
			}
			handoffPointer = { worktree: true, design_doc: true };
		}
		if (type !== "generic") {
			return {
				id,
				type,
				...(vendor ? { vendor } : {}),
				...(model ? { model } : {}),
				...(effort ? { effort } : {}),
				...(handoffPointer ? { handoff_pointer: handoffPointer } : {}),
			};
		}
		const agentFile = assertSafeAgentFile(
			node.agent_file,
			`${nodePath}.agent_file`,
		);
		if (
			node.produces_output !== undefined &&
			typeof node.produces_output !== "boolean"
		) {
			throw new Error(`${nodePath}.produces_output must be a boolean`);
		}
		const producesOutput = node.produces_output === true;
		let output: WorkflowOutputContract | undefined;
		if (node.output !== undefined) {
			const rawOutput = record(node.output, `${nodePath}.output`);
			exactKeys(rawOutput, ["schema", "max_bytes"], `${nodePath}.output`);
			if (!producesOutput) {
				throw new Error(`node ${id} output requires produces_output=true`);
			}
			const maxBytes = Number(rawOutput.max_bytes);
			if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > 262_144) {
				throw new Error(`${nodePath}.output.max_bytes must be in 1..262144`);
			}
			output = {
				schema: oneOf(
					rawOutput.schema,
					["json_v1"] as const,
					`${nodePath}.output.schema`,
				),
				max_bytes: maxBytes,
			};
		} else if (producesOutput) {
			throw new Error(`node ${id} produces_output=true requires output`);
		}
		return {
			id,
			type,
			...(vendor ? { vendor } : {}),
			...(model ? { model } : {}),
			...(effort ? { effort } : {}),
			...(handoffPointer ? { handoff_pointer: handoffPointer } : {}),
			agent_file: agentFile,
			...(producesOutput ? { produces_output: true, output } : {}),
		};
	});

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
					"node_done",
					"review_pass",
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
				["qa_fail", "review_fail", "founder_feedback_kickback"] as const,
				`manifest.loops[${index}].loop_when`,
			),
			exit_when: oneOf(
				loop.exit_when,
				["qa_pass", "review_pass"] as const,
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
			["qa_passed", "design_review_approved", "founder_approved"] as const,
			`manifest.ship_claims[${index}]`,
		),
	);
	if (new Set(shipClaims).size !== shipClaims.length) {
		throw new Error("manifest.ship_claims contains duplicates");
	}
	if (!shipClaims.includes("founder_approved")) {
		throw new Error("manifest.ship_claims must require founder_approved");
	}
	const qaCount = nodes.filter((node) => node.type === "qa").length;
	const hasQaClaim = shipClaims.includes("qa_passed");
	if (qaCount > 0 !== hasQaClaim) {
		throw new Error(
			"manifest QA nodes and qa_passed ship claim must be declared together",
		);
	}
	const reviewCount = nodes.filter((node) => node.type === "review").length;
	const hasReviewClaim = shipClaims.includes("design_review_approved");
	if (reviewCount > 0 !== hasReviewClaim) {
		throw new Error(
			"manifest review nodes and design_review_approved ship claim must be declared together",
		);
	}
	if (nodes.some((node) => nodeWritesCode(node.type)) && qaCount !== 1) {
		throw new Error(
			"a workflow containing a code-writing node must contain exactly one independent QA node and qa_passed ship claim",
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
						: node.type === "generic"
							? "node_done"
							: node.type === "review"
								? "review_pass"
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
		} else if (node.type === "review") {
			const upstream = edges.find((edge) => edge.to === node.id)?.from;
			if (
				nodeLoops.length !== 1 ||
				nodeLoops[0]!.loop_when !== "review_fail" ||
				nodeLoops[0]!.exit_when !== "review_pass" ||
				nodeLoops[0]!.to !== upstream
			) {
				throw new Error(
					`review node ${node.id} requires a review_fail loop to its direct upstream with review_pass exit`,
				);
			}
		} else if (nodeLoops.length > 0) {
			throw new Error(`node ${node.id} cannot own a loop`);
		}
	}

	const manifest: WorkflowManifestV2 = {
		schema_version: 2,
		nodes,
		edges,
		loops,
		terminal_gate: terminalGate,
		ship_claims: shipClaims,
	};
	const tierPresets = validateTierPresets(manifest, root.tier_presets);
	return tierPresets ? { ...manifest, tier_presets: tierPresets } : manifest;
}

/** Strict version dispatch. V1 retains canonical-registry validation. */
export function validateWorkflowManifest(
	value: unknown,
	options: WorkflowManifestValidationOptions = {},
): WorkflowManifest {
	const root = record(value, "manifest");
	if (root.schema_version === 1) {
		return validateWorkflowManifestV1(value, options);
	}
	if (root.schema_version === 2) {
		return validateWorkflowManifestV2(value);
	}
	throw new Error(
		"manifest.schema_version must be one of the supported versions: 1, 2",
	);
}

/** Parse a pinned v2 manifest structurally; its frozen capabilities are checked by the snapshot parser. */
export function validatePinnedWorkflowManifest(
	value: unknown,
): WorkflowManifestV2 {
	return validateWorkflowManifestV2(value, () => false);
}

export function parseWorkflowManifestYaml(source: string): WorkflowManifest {
	return validateWorkflowManifest(parse(source));
}

export function applyWorkflowOverride(
	manifestValue: unknown,
	overrideValue: unknown,
): { manifest: WorkflowManifest; override: WorkflowTemplateOverride } {
	const manifest = validateWorkflowManifest(manifestValue);
	const override = record(overrideValue, "override");
	exactKeys(override, ["reason", "nodes"], "override");
	const reason = nonempty(override.reason, "override.reason");
	const nodeOverrides =
		override.nodes === undefined
			? {}
			: record(override.nodes, "override.nodes");
	const next = structuredClone(manifest);
	// A materialized override resolves one concrete manifest. Preset definitions
	// are authoring metadata and must not be re-applied or revalidated against
	// the already-overridden node set (a heavy cross-vendor preset must not make
	// a sibling trivial preset appear incompatible).
	delete next.tier_presets;
	for (const [nodeId, raw] of Object.entries(nodeOverrides)) {
		const nodeOverride = record(raw, `override.nodes.${nodeId}`);
		exactKeys(
			nodeOverride,
			["vendor", "model", "effort", "skip"],
			`override.nodes.${nodeId}`,
		);
		const node = next.nodes.find((candidate) => candidate.id === nodeId);
		if (!node) throw new Error(`override references unknown node: ${nodeId}`);
		if (node.type === "gate")
			throw new Error(`gate node ${nodeId} cannot be overridden`);
		let overrideVendor: WorkflowVendor | undefined;
		if (nodeOverride.vendor !== undefined) {
			overrideVendor = oneOf(
				nodeOverride.vendor,
				["claude", "codex"] as const,
				`override.nodes.${nodeId}.vendor`,
			);
			if (nodeOverride.model === undefined) {
				throw new Error(
					`override.nodes.${nodeId}.vendor requires a paired model`,
				);
			}
		}
		if (nodeOverride.model !== undefined) {
			const model = nonempty(
				nodeOverride.model,
				`override.nodes.${nodeId}.model`,
			);
			const vendor = overrideVendor ?? node.vendor;
			if (!vendor || !compatibleModel(vendor, model)) {
				throw new Error(
					`node ${nodeId} vendor is incompatible with override model ${model}`,
				);
			}
			node.vendor = vendor;
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
			if (node.type === "review")
				throw new Error(`cannot skip review node ${nodeId}`);
			if (node.produces_output) {
				throw new Error(`cannot skip output-producing node ${nodeId}`);
			}
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
	"tpl_product_v1.yaml",
	"tpl_eng_heavy_land_v1.yaml",
	"tpl_eng_light_land_v1.yaml",
	"tpl_eng_trivial_land_v1.yaml",
	// Additive identities remain append-only. Removed dormant identities are not
	// retained merely to preserve their former array positions.
	"tpl_eng.yaml",
	"tpl_eng_land_v1.yaml",
	"tpl_product_designer.yaml",
	"tpl_product_prototype.yaml",
	"tpl_generic.yaml",
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
	env: EnvLike = process.env,
	_log: (message: string) => void = (message) => console.log(message),
): void {
	for (const seed of loadBundledWorkflowSeeds()) {
		store.importWorkflowTemplateSeed(seed, env);
	}
}

export const DEFAULT_BUNDLED_WORKFLOW_TEMPLATE_ID = "tpl_eng_heavy";

export const DEFAULT_ENGINEERING_WORKFLOW_BINDINGS = [
	{ taskCategory: "*", templateId: "tpl_eng_heavy_land_v1" },
	{ taskCategory: "light", templateId: "tpl_eng_light_land_v1" },
	{ taskCategory: "trivial", templateId: "tpl_eng_trivial_land_v1" },
] as const;

const ENGINEERING_LAND_BINDING_MIGRATION = [
	{
		taskCategory: "*",
		legacyTemplateId: "tpl_eng_heavy",
		landTemplateId: "tpl_eng_heavy_land_v1",
	},
	{
		taskCategory: "light",
		legacyTemplateId: "tpl_eng_light",
		landTemplateId: "tpl_eng_light_land_v1",
	},
	{
		taskCategory: "trivial",
		legacyTemplateId: "tpl_eng_trivial",
		landTemplateId: "tpl_eng_trivial_land_v1",
	},
] as const;

const BUNDLED_DEFAULT_OWNER = "system:bundled-default";
const LAND_MIGRATION_OWNER = "system:FLY-1434-land-migration";
const LAND_ROLLBACK_OWNER = "system:FLY-1434-land-rollback";

/**
 * Seed the bundled engineering tiers only for projects with no binding
 * authority yet. Any existing binding means a founder or migration already
 * owns the project registry, so boot must not widen its candidate surface.
 */
export function ensureDefaultWorkflowBindings(
	store: Pick<
		StateStore,
		"listWorkflowCategoryBindings" | "bindWorkflowCategory"
	>,
	projectNames: readonly string[],
): void {
	for (const project of [...new Set(projectNames.map((name) => name.trim()))]
		.filter(Boolean)
		.sort((a, b) => a.localeCompare(b))) {
		const existing = store.listWorkflowCategoryBindings(project);
		if (existing.length > 0) continue;
		for (const binding of DEFAULT_ENGINEERING_WORKFLOW_BINDINGS) {
			store.bindWorkflowCategory({
				project,
				taskCategory: binding.taskCategory,
				templateId: binding.templateId,
				updatedBy: BUNDLED_DEFAULT_OWNER,
			});
		}
	}
}

function migrateSystemEngineeringBindings(input: {
	store: Pick<
		StateStore,
		"listWorkflowCategoryBindings" | "bindWorkflowCategory"
	>;
	projectNames: readonly string[];
	direction: "to_land" | "from_land";
	log: (message: string) => void;
}): number {
	let migrated = 0;
	const allowedOwners =
		input.direction === "to_land"
			? new Set([BUNDLED_DEFAULT_OWNER, LAND_ROLLBACK_OWNER])
			: new Set([BUNDLED_DEFAULT_OWNER, LAND_MIGRATION_OWNER]);
	for (const project of [
		...new Set(input.projectNames.map((name) => name.trim())),
	]
		.filter(Boolean)
		.sort((a, b) => a.localeCompare(b))) {
		const existing = input.store.listWorkflowCategoryBindings(project);
		for (const migration of ENGINEERING_LAND_BINDING_MIGRATION) {
			const binding = existing.find(
				(row) => row.task_category === migration.taskCategory,
			);
			if (!binding) continue;
			const sourceTemplate =
				input.direction === "to_land"
					? migration.legacyTemplateId
					: migration.landTemplateId;
			const targetTemplate =
				input.direction === "to_land"
					? migration.landTemplateId
					: migration.legacyTemplateId;
			if (binding.template_id !== sourceTemplate) continue;
			if (!allowedOwners.has(binding.updated_by)) {
				input.log(
					`[workflow-template] FLY-1434 preserved custom binding ${project}/${binding.task_category}: ${binding.template_id} owner=${binding.updated_by}`,
				);
				continue;
			}
			input.store.bindWorkflowCategory({
				project,
				taskCategory: binding.task_category,
				templateId: targetTemplate,
				updatedBy:
					input.direction === "to_land"
						? LAND_MIGRATION_OWNER
						: LAND_ROLLBACK_OWNER,
			});
			migrated += 1;
		}
	}
	return migrated;
}

/**
 * FLY-1434: move only system-owned engineering defaults onto the land-v1
 * graphs. Founder/custom bindings remain authoritative and are never rewritten.
 */
export function migrateSystemWorkflowBindingsToLand(
	store: Pick<
		StateStore,
		"listWorkflowCategoryBindings" | "bindWorkflowCategory"
	>,
	projectNames: readonly string[],
	log: (message: string) => void = (message) => console.warn(message),
): number {
	return migrateSystemEngineeringBindings({
		store,
		projectNames,
		direction: "to_land",
		log,
	});
}

/** Explicit operator rollback for the FLY-1434 system binding migration. */
export function rollbackSystemWorkflowBindingsFromLand(
	store: Pick<
		StateStore,
		"listWorkflowCategoryBindings" | "bindWorkflowCategory"
	>,
	projectNames: readonly string[],
	log: (message: string) => void = (message) => console.warn(message),
): number {
	return migrateSystemEngineeringBindings({
		store,
		projectNames,
		direction: "from_land",
		log,
	});
}
