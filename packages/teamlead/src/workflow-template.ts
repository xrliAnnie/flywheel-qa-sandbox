import { isAbsolute } from "node:path";
import {
	canonicalSubmissionDigest,
	getModelConfigSnapshot,
	type ModelConfigSnapshot,
} from "flywheel-config";
import { parse } from "yaml";
import type { StateStore } from "./StateStore.js";
import { ENG_TIERS, type EngTier } from "./work-kind.js";

export const WORKFLOW_MANIFEST_SCHEMA_VERSION = 1 as const;
export const GENERALIZED_WORKFLOW_MANIFEST_SCHEMA_VERSION = 2 as const;

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
export type WorkflowEffort = "low" | "medium" | "high" | "xhigh" | "max";
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
	/** Backend-owned display name; absent only on historical/custom manifests. */
	label?: string;
	type: WorkflowNodeType;
	/** Menu-sourced nodes resolve this role through the project's IC roster. */
	role?: string;
	vendor?: WorkflowVendor;
	model?: string;
	effort?: WorkflowEffort;
	handoff_pointer?: { worktree: boolean; design_doc: boolean };
	agent_file?: string;
	produces_output?: boolean;
	output?: WorkflowOutputContract;
	execution?: "engine";
	submissionWindowMinutes?: number;
	/** A staged product artifact must pass a founder review round before completion. */
	founder_review?: boolean;
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
	max_iterations?: number;
	on_limit?: "escalate";
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

export interface WorkflowManifestV2Legacy {
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

export interface WorkflowManifestV2Land {
	schema_version: 2;
	nodes: WorkflowManifestNode[];
	edges: WorkflowManifestEdge[];
	loops: WorkflowManifestLoop[];
	approval_gate: { node: string; predicate: "founder_approved" };
	terminal_node: { node: string };
	ship_claims: Array<
		"qa_passed" | "design_review_approved" | "founder_approved"
	>;
	tier_presets?: Partial<Record<EngTier, WorkflowTemplateOverride>>;
}

export type WorkflowManifestV2 =
	| WorkflowManifestV2Legacy
	| WorkflowManifestV2Land;

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
			submissionWindowMinutes?: number;
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
	/** Internal transaction seam: one hot-config generation per validation. */
	modelSnapshot?: ModelConfigSnapshot;
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

function optionalPositiveInteger(
	value: unknown,
	path: string,
): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || Number(value) <= 0) {
		throw new Error(`${path} must be a positive integer`);
	}
	return Number(value);
}

function assertSubmissionWindowsTargetDecisions(
	manifest: Pick<WorkflowManifest, "nodes" | "edges" | "loops">,
): void {
	for (const node of manifest.nodes) {
		if (node.submissionWindowMinutes === undefined) continue;
		const verdictLoops = manifest.loops.filter(
			(loop) =>
				loop.from === node.id &&
				(loop.loop_when === "qa_fail" || loop.loop_when === "review_fail"),
		);
		const loop = verdictLoops[0];
		const isVerdictPair =
			verdictLoops.length === 1 &&
			((loop?.loop_when === "qa_fail" && loop.exit_when === "qa_pass") ||
				(loop?.loop_when === "review_fail" &&
					loop.exit_when === "review_pass"));
		const exits = loop
			? manifest.edges.filter(
					(edge) => edge.from === node.id && edge.condition === loop.exit_when,
				)
			: [];
		if (!isVerdictPair || exits.length !== 1) {
			throw new Error(
				`node ${node.id} submissionWindowMinutes is allowed only on a decision node identified by verdict topology`,
			);
		}
	}
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

function compatibleModel(
	vendor: WorkflowVendor,
	model: string,
	snapshot: ModelConfigSnapshot,
): boolean {
	// FLY-1467: judge the CANONICAL id, not the raw spelling. Config may now
	// write a tier ("opus" / "opus-1m") instead of a version, and a tier does not
	// carry the vendor prefix. Resolving first keeps every existing full-id
	// spelling byte-identical while letting tiers through.
	const canonical = snapshot.getModelRegistryEntry(model)?.id ?? model;
	return vendor === "claude"
		? canonical.startsWith("claude-")
		: canonical.startsWith("gpt-");
}

function canonicalWorkflowModel(
	vendor: WorkflowVendor,
	model: string,
	effort?: WorkflowEffort,
	snapshot: ModelConfigSnapshot = getModelConfigSnapshot(),
): string {
	const registered = snapshot.getModelRegistryEntry(model);
	if (
		!registered ||
		!snapshot.isModelSelectionSupported({
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
	modelSnapshot: ModelConfigSnapshot,
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
		normalized[tier] = applyWorkflowOverride(
			manifest,
			presets[tier],
			modelSnapshot,
		).override;
	}
	return normalized;
}

/** Strict schema + semantic graph validation. Unknown keys fail at every level. */
function validateWorkflowManifestV1(
	value: unknown,
	options: WorkflowManifestValidationOptions = {},
): WorkflowManifestV1 {
	const modelSnapshot = options.modelSnapshot ?? getModelConfigSnapshot();
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
						"submissionWindowMinutes",
						"founder_review",
					]
				: [
						"id",
						"type",
						"vendor",
						"model",
						"effort",
						"handoff_pointer",
						"submissionWindowMinutes",
						"founder_review",
					],
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
		const submissionWindowMinutes = optionalPositiveInteger(
			node.submissionWindowMinutes,
			`manifest.nodes[${index}].submissionWindowMinutes`,
		);
		if (
			node.founder_review !== undefined &&
			typeof node.founder_review !== "boolean"
		) {
			throw new Error(
				`manifest.nodes[${index}].founder_review must be boolean`,
			);
		}
		const founderReview = node.founder_review as boolean | undefined;
		if (type === "land") {
			if (node.execution !== "engine") {
				throw new Error(`land node ${id} must define execution: engine`);
			}
			for (const key of [
				"vendor",
				"model",
				"effort",
				"handoff_pointer",
				"founder_review",
			]) {
				if (node[key] !== undefined) {
					throw new Error(`land node ${id} cannot define ${key}`);
				}
			}
			return {
				id,
				type,
				execution: "engine",
				...(submissionWindowMinutes ? { submissionWindowMinutes } : {}),
			};
		}
		if (type === "gate") {
			for (const key of [
				"vendor",
				"model",
				"effort",
				"handoff_pointer",
				"execution",
				"founder_review",
			]) {
				if (node[key] !== undefined) {
					throw new Error(`gate node ${id} cannot define ${key}`);
				}
			}
			return {
				id,
				type,
				...(submissionWindowMinutes ? { submissionWindowMinutes } : {}),
			};
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
						["low", "medium", "high", "xhigh", "max"] as const,
						`manifest.nodes[${index}].effort`,
					);
		if (effort && (!vendor || !model)) {
			throw new Error(`node ${id} effort requires a vendor and model`);
		}
		const canonicalModel =
			vendor && model
				? options.allowUnsupportedModels
					? model
					: canonicalWorkflowModel(vendor, model, effort, modelSnapshot)
				: model;
		return {
			id,
			type,
			...(vendor ? { vendor } : {}),
			...(canonicalModel ? { model: canonicalModel } : {}),
			...(effort ? { effort } : {}),
			...(handoffPointer ? { handoff_pointer: handoffPointer } : {}),
			...(submissionWindowMinutes ? { submissionWindowMinutes } : {}),
			...(founderReview !== undefined ? { founder_review: founderReview } : {}),
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
		const loopWhen = oneOf(
			loop.loop_when,
			["qa_fail", "founder_feedback_kickback"] as const,
			`manifest.loops[${index}].loop_when`,
		);
		const hasMaxIterations = loop.max_iterations !== undefined;
		const hasOnLimit = loop.on_limit !== undefined;
		if (hasMaxIterations !== hasOnLimit) {
			throw new Error(
				`loop ${id}.max_iterations and on_limit must be provided together`,
			);
		}
		const maxIterations = hasMaxIterations
			? Number(loop.max_iterations)
			: undefined;
		if (
			maxIterations !== undefined &&
			(!Number.isInteger(maxIterations) || maxIterations <= 0)
		) {
			throw new Error(`loop ${id}.max_iterations must be a positive integer`);
		}
		return {
			id,
			from,
			to,
			loop_when: loopWhen,
			exit_when: oneOf(
				loop.exit_when,
				["qa_pass", "founder_approved"] as const,
				`manifest.loops[${index}].exit_when`,
			),
			...(maxIterations !== undefined
				? {
						max_iterations: maxIterations,
						on_limit: oneOf(
							loop.on_limit,
							["escalate"] as const,
							`manifest.loops[${index}].on_limit`,
						),
					}
				: {}),
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
			if (conditions.length) {
				throw new Error("terminal gate cannot have outgoing edges");
			}
			if (
				nodeLoops.length > 1 ||
				(nodeLoops.length === 1 &&
					(nodeLoops[0]!.loop_when !== "founder_feedback_kickback" ||
						nodeLoops[0]!.exit_when !== "founder_approved"))
			) {
				throw new Error(
					"terminal gate feedback must be one founder_feedback_kickback loop",
				);
			}
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
	const tierPresets = validateTierPresets(
		manifest,
		root.tier_presets,
		modelSnapshot,
	);
	assertSubmissionWindowsTargetDecisions(manifest);
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

export function isWorkflowManifestLand(
	manifest: WorkflowManifestV1 | WorkflowManifestV2,
): manifest is WorkflowManifestV1Land | WorkflowManifestV2Land {
	return isWorkflowManifestV1Land(manifest) || "approval_gate" in manifest;
}

export function workflowApprovalGate(
	manifest: WorkflowManifestV1 | WorkflowManifestV2,
): { node: string; predicate: "founder_approved" } {
	return isWorkflowManifestLand(manifest)
		? manifest.approval_gate
		: manifest.terminal_gate;
}

export function workflowTerminalNode(
	manifest: WorkflowManifestV1 | WorkflowManifestV2,
): string {
	return isWorkflowManifestLand(manifest)
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

/**
 * The independent-QA requirement keys on the formal engineering pipeline (an
 * `implement` node), not on "can this node edit files". QA guards the merge
 * point, not the editor — and a single-stage workflow has nowhere to put an
 * independent QA node, so keying on write capability would sentence every
 * single-stage graph to death.
 */
function requiresIndependentQa(type: WorkflowNodeType): boolean {
	return type === "implement";
}

function validateWorkflowManifestV2(
	value: unknown,
	nodeRequiresIndependentQa: (
		type: WorkflowNodeType,
	) => boolean = requiresIndependentQa,
	options: WorkflowManifestValidationOptions = {},
): WorkflowManifestV2 {
	const modelSnapshot = options.modelSnapshot ?? getModelConfigSnapshot();
	const root = record(value, "manifest");
	const isLandVariant =
		Object.hasOwn(root, "approval_gate") ||
		Object.hasOwn(root, "terminal_node");
	exactKeys(
		root,
		isLandVariant
			? [
					"schema_version",
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
				"label",
				"type",
				"role",
				"vendor",
				"model",
				"effort",
				"handoff_pointer",
				"agent_file",
				"produces_output",
				"output",
				"submissionWindowMinutes",
				"founder_review",
				...(isLandVariant ? ["execution"] : []),
			],
			nodePath,
		);
		const id = nonempty(node.id, `${nodePath}.id`);
		const label =
			node.label === undefined
				? undefined
				: nonempty(node.label, `${nodePath}.label`);
		if (nodeIds.has(id)) throw new Error(`duplicate node id: ${id}`);
		nodeIds.add(id);
		const type = oneOf(
			node.type,
			(isLandVariant
				? ["design", "implement", "qa", "gate", "land", "generic", "review"]
				: [
						"design",
						"implement",
						"qa",
						"gate",
						"generic",
						"review",
					]) as readonly WorkflowNodeType[],
			`${nodePath}.type`,
		);
		const submissionWindowMinutes = optionalPositiveInteger(
			node.submissionWindowMinutes,
			`${nodePath}.submissionWindowMinutes`,
		);
		if (
			node.founder_review !== undefined &&
			typeof node.founder_review !== "boolean"
		) {
			throw new Error(`${nodePath}.founder_review must be boolean`);
		}
		const founderReview = node.founder_review as boolean | undefined;
		if (type === "land") {
			if (node.execution !== "engine") {
				throw new Error(`land node ${id} must define execution: engine`);
			}
			for (const key of [
				"role",
				"vendor",
				"model",
				"effort",
				"handoff_pointer",
				"agent_file",
				"produces_output",
				"output",
				"submissionWindowMinutes",
				"founder_review",
			]) {
				if (node[key] !== undefined) {
					throw new Error(`land node ${id} cannot define ${key}`);
				}
			}
			return {
				id,
				...(label ? { label } : {}),
				type,
				execution: "engine",
			};
		}
		if (type === "gate") {
			for (const key of [
				"role",
				"vendor",
				"model",
				"effort",
				"handoff_pointer",
				"agent_file",
				"produces_output",
				"output",
				"execution",
				"founder_review",
			]) {
				if (node[key] !== undefined) {
					throw new Error(`gate node ${id} cannot define ${key}`);
				}
			}
			return {
				id,
				...(label ? { label } : {}),
				type,
				...(submissionWindowMinutes ? { submissionWindowMinutes } : {}),
			};
		}
		if (node.execution !== undefined) {
			throw new Error(`node ${id} of type ${type} cannot define execution`);
		}
		if (type !== "generic") {
			for (const key of ["agent_file", "produces_output", "output"]) {
				if (node[key] !== undefined) {
					throw new Error(`node ${id} of type ${type} cannot define ${key}`);
				}
			}
		}
		const role =
			node.role === undefined
				? undefined
				: nonempty(node.role, `${nodePath}.role`);
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
		if (
			vendor &&
			model &&
			!options.allowUnsupportedModels &&
			!compatibleModel(vendor, model, modelSnapshot)
		) {
			throw new Error(
				`node ${id} vendor ${vendor} is incompatible with model ${model}`,
			);
		}
		const effort =
			node.effort === undefined
				? undefined
				: oneOf(
						node.effort,
						["low", "medium", "high", "xhigh", "max"] as const,
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
				...(label ? { label } : {}),
				type,
				...(vendor ? { vendor } : {}),
				...(model ? { model } : {}),
				...(effort ? { effort } : {}),
				...(handoffPointer ? { handoff_pointer: handoffPointer } : {}),
				...(role ? { role } : {}),
				...(founderReview !== undefined
					? { founder_review: founderReview }
					: {}),
				...(submissionWindowMinutes ? { submissionWindowMinutes } : {}),
			};
		}
		const agentFile =
			node.agent_file === undefined
				? undefined
				: assertSafeAgentFile(node.agent_file, `${nodePath}.agent_file`);
		if ((role ? 1 : 0) + (agentFile ? 1 : 0) > 1) {
			throw new Error(
				`generic node ${id} cannot define both role and agent_file`,
			);
		}
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
			...(label ? { label } : {}),
			type,
			...(vendor ? { vendor } : {}),
			...(model ? { model } : {}),
			...(effort ? { effort } : {}),
			...(handoffPointer ? { handoff_pointer: handoffPointer } : {}),
			...(role ? { role } : {}),
			...(founderReview !== undefined ? { founder_review: founderReview } : {}),
			...(agentFile ? { agent_file: agentFile } : {}),
			...(producesOutput ? { produces_output: true, output } : {}),
			...(submissionWindowMinutes ? { submissionWindowMinutes } : {}),
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
		const loopWhen = oneOf(
			loop.loop_when,
			["qa_fail", "review_fail", "founder_feedback_kickback"] as const,
			`manifest.loops[${index}].loop_when`,
		);
		const hasMaxIterations = loop.max_iterations !== undefined;
		const hasOnLimit = loop.on_limit !== undefined;
		if (hasMaxIterations !== hasOnLimit) {
			throw new Error(
				`loop ${id}.max_iterations and on_limit must be provided together`,
			);
		}
		const maxIterations = hasMaxIterations
			? Number(loop.max_iterations)
			: undefined;
		if (
			maxIterations !== undefined &&
			(!Number.isInteger(maxIterations) || maxIterations <= 0)
		) {
			throw new Error(`loop ${id}.max_iterations must be a positive integer`);
		}
		return {
			id,
			from,
			to,
			loop_when: loopWhen,
			exit_when: oneOf(
				loop.exit_when,
				(isLandVariant
					? ["qa_pass", "review_pass", "founder_approved"]
					: [
							"qa_pass",
							"review_pass",
						]) as readonly WorkflowManifestLoop["exit_when"][],
				`manifest.loops[${index}].exit_when`,
			),
			...(maxIterations !== undefined
				? {
						max_iterations: maxIterations,
						on_limit: oneOf(
							loop.on_limit,
							["escalate"] as const,
							`manifest.loops[${index}].on_limit`,
						),
					}
				: {}),
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
		if (nodes.filter((node) => node.type === "land").length !== 1) {
			throw new Error("land workflow must contain exactly one land node");
		}
	}
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
	const hasImplementNode = nodes.some((node) =>
		nodeRequiresIndependentQa(node.type),
	);
	if (hasImplementNode && qaCount !== 1) {
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
				throw new Error("terminal node cannot have outgoing edges or loops");
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
		} else if (isLandVariant && node.id === approvalGateNode) {
			if (
				nodeLoops.length > 1 ||
				(nodeLoops.length === 1 &&
					(nodeLoops[0]!.loop_when !== "founder_feedback_kickback" ||
						nodeLoops[0]!.exit_when !== "founder_approved"))
			) {
				throw new Error(
					`approval gate ${node.id} accepts at most one founder feedback loop`,
				);
			}
		} else if (nodeLoops.length > 0) {
			throw new Error(`node ${node.id} cannot own a loop`);
		}
	}

	const manifest: WorkflowManifestV2 = isLandVariant
		? {
				schema_version: 2,
				nodes,
				edges,
				loops,
				approval_gate: approvalGate,
				terminal_node: { node: terminalNode },
				ship_claims: shipClaims,
			}
		: {
				schema_version: 2,
				nodes,
				edges,
				loops,
				terminal_gate: approvalGate,
				ship_claims: shipClaims,
			};
	const tierPresets = validateTierPresets(
		manifest,
		root.tier_presets,
		modelSnapshot,
	);
	assertSubmissionWindowsTargetDecisions(manifest);
	return tierPresets ? { ...manifest, tier_presets: tierPresets } : manifest;
}

/** Strict version dispatch. V1 retains canonical-registry validation. */
export function validateWorkflowManifest(
	value: unknown,
	options: WorkflowManifestValidationOptions = {},
): WorkflowManifest {
	const modelSnapshot = options.modelSnapshot ?? getModelConfigSnapshot();
	const root = record(value, "manifest");
	if (root.schema_version === 1) {
		return validateWorkflowManifestV1(value, { ...options, modelSnapshot });
	}
	if (root.schema_version === 2) {
		return validateWorkflowManifestV2(value, requiresIndependentQa, {
			...options,
			modelSnapshot,
		});
	}
	throw new Error(
		"manifest.schema_version must be one of the supported versions: 1, 2",
	);
}

/** Parse a pinned v2 manifest structurally; its frozen capabilities are checked by the snapshot parser. */
export function validatePinnedWorkflowManifest(
	value: unknown,
): WorkflowManifestV2 {
	return validateWorkflowManifestV2(value, () => false, {
		allowUnsupportedModels: true,
	});
}

export function parseWorkflowManifestYaml(source: string): WorkflowManifest {
	return validateWorkflowManifest(parse(source));
}

export function applyWorkflowOverride(
	manifestValue: unknown,
	overrideValue: unknown,
	modelSnapshot: ModelConfigSnapshot = getModelConfigSnapshot(),
): { manifest: WorkflowManifest; override: WorkflowTemplateOverride } {
	const manifest = validateWorkflowManifest(manifestValue, { modelSnapshot });
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
			["vendor", "model", "effort", "skip", "submissionWindowMinutes"],
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
			if (!vendor || !compatibleModel(vendor, model, modelSnapshot)) {
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
				["low", "medium", "high", "xhigh", "max"] as const,
				`override.nodes.${nodeId}.effort`,
			);
		}
		if (nodeOverride.submissionWindowMinutes !== undefined) {
			node.submissionWindowMinutes = optionalPositiveInteger(
				nodeOverride.submissionWindowMinutes,
				`override.nodes.${nodeId}.submissionWindowMinutes`,
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
		manifest: validateWorkflowManifest(next, { modelSnapshot }),
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

export const RETIRED_BUNDLED_TEMPLATE_IDS = [
	"tpl_eng_heavy",
	"tpl_product_v1",
	"tpl_product_designer",
	"tpl_product_prototype",
	"tpl_generic",
	"tpl_eng",
	"tpl_eng_land_v1",
	"tpl_eng_heavy_land_v1",
	"tpl_eng_light",
	"tpl_eng_light_land_v1",
	"tpl_eng_trivial",
	"tpl_eng_trivial_land_v1",
] as const;

const RETIREMENT_OWNER = "system:FLY-1693-retirement";
const RETIREMENT_REASON = "FLY-1693 founder-approved template retirement";
const RETIRABLE_SYSTEM_BINDING_OWNERS = new Set([
	"system:bundled-default",
	"system:FLY-1434-land-migration",
	"system:FLY-1434-land-rollback",
]);

export function retireLegacyWorkflowTemplates(
	store: Pick<
		StateStore,
		| "listWorkflowCategoryBindings"
		| "unbindWorkflowCategory"
		| "retireWorkflowTemplate"
	>,
	log: (message: string) => void = (message) => console.warn(message),
): { unbound: number; retired: number; blocked: string[]; errors: string[] } {
	const retiredIds = new Set<string>(RETIRED_BUNDLED_TEMPLATE_IDS);
	const result = {
		unbound: 0,
		retired: 0,
		blocked: [] as string[],
		errors: [] as string[],
	};
	for (const binding of store.listWorkflowCategoryBindings()) {
		if (!retiredIds.has(binding.template_id)) continue;
		if (!RETIRABLE_SYSTEM_BINDING_OWNERS.has(binding.updated_by)) {
			log(
				`[workflow-template] FLY-1693 preserved custom binding ${binding.project}/${binding.task_category}: ${binding.template_id} owner=${binding.updated_by}`,
			);
			continue;
		}
		const unbound = store.unbindWorkflowCategory({
			project: binding.project,
			taskCategory: binding.task_category,
			expectedTemplateId: binding.template_id,
			expectedUpdatedBy: binding.updated_by,
			updatedBy: RETIREMENT_OWNER,
		});
		if (unbound.status === "removed") {
			result.unbound += 1;
		} else {
			result.errors.push(
				`${binding.project}/${binding.task_category}:${unbound.status}`,
			);
		}
	}
	for (const templateId of RETIRED_BUNDLED_TEMPLATE_IDS) {
		const retired = store.retireWorkflowTemplate({
			templateId,
			actor: RETIREMENT_OWNER,
			reason: RETIREMENT_REASON,
		});
		if (retired.status === "retired") {
			result.retired += 1;
			continue;
		}
		if (retired.status !== "refused_bound") continue;
		for (const ref of retired.refs) {
			result.blocked.push(`${templateId}:${ref.project}/${ref.taskCategory}`);
		}
		log(
			`[workflow-template] FLY-1693 retirement blocked for ${templateId}: ${retired.refs
				.map((ref) => `${ref.project}/${ref.taskCategory}`)
				.join(", ")}`,
		);
	}
	return result;
}
