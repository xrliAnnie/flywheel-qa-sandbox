import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
	canonicalSubmissionDigest,
	getNodeTypeRegistryEntry,
	type ModelConfigSnapshot,
	type WorkflowNodeCapabilities,
} from "flywheel-config";
import {
	CATEGORY_SOURCES,
	type CategorySource,
	ENG_TIERS,
	type EngTier,
	WORKFLOW_SNAPSHOT_TASK_CATEGORIES,
	type WorkKindCategory,
} from "./work-kind.js";
import {
	isBundledWorkflowNodeName,
	resolveNodeAgentFile,
} from "./workflow-menu.js";
import {
	isWorkflowManifestLand,
	isWorkflowManifestV1Land,
	validatePinnedWorkflowManifest,
	validateWorkflowManifest,
	type WorkflowEffort,
	type WorkflowManifestV1,
	type WorkflowManifestV2,
	type WorkflowNodeType,
	type WorkflowOutputContract,
	type WorkflowVendor,
	workflowApprovalGate,
} from "./workflow-template.js";

interface WorkflowSnapshotWorkKind {
	task_category?: WorkKindCategory;
	category_source?: CategorySource;
	tier?: EngTier;
}

export interface ResolvedWorkflowNode {
	id: string;
	type: WorkflowNodeType;
	capabilities: WorkflowNodeCapabilities;
	/** True when immutable run materialization outranks mutable live config. */
	dispatchPinned?: boolean;
	dispatch?: {
		vendor: WorkflowVendor;
		model: string;
		effort?: WorkflowEffort;
	};
	output?: WorkflowOutputContract;
	agent?: { content: string; digest: string };
}

/** Prompt-only facts derived from the pinned DAG, never from node names. */
export function workflowGateEntryPromptCapabilities(
	snapshot: WorkflowRunSnapshot,
	nodeId: string,
): Record<string, boolean | string> {
	const decision = resolveWorkflowDecisionContract(snapshot, nodeId);
	if (!decision) return {};
	const gateNodeId = workflowApprovalGate(snapshot.manifest).node;
	const entersGate = snapshot.manifest.edges.some(
		(edge) =>
			edge.from === nodeId &&
			edge.condition === decision.passOutcome &&
			edge.to === gateNodeId,
	);
	if (!entersGate) return {};
	return {
		pass_enters_approval_gate: true,
		gate_entry_authority_kind:
			decision.family === "qa_verdict" ? "worktree" : "materialization_receipt",
	};
}

export interface WorkflowRunSnapshotV2 extends WorkflowSnapshotWorkKind {
	schema_version: 2;
	template: { id: string; revision: number };
	manifest: WorkflowManifestV2;
	manifest_digest: string;
	resolved: { nodes: ResolvedWorkflowNode[] };
	snapshot_digest: string;
}

export interface WorkflowRunSnapshotV1 extends WorkflowSnapshotWorkKind {
	schema_version: 1;
	template: { id: string; revision: number };
	manifest: WorkflowManifestV1;
	manifest_digest: string;
	resolved: { nodes: ResolvedWorkflowNode[] };
	snapshot_digest: string;
}

export type WorkflowRunSnapshot = WorkflowRunSnapshotV1 | WorkflowRunSnapshotV2;

/** Residency is a graph fact: only nodes with an inbound pinned loop qualify. */
export function isLoopTargetNode(
	snapshot: WorkflowRunSnapshot,
	nodeId: string,
): boolean {
	return snapshot.manifest.loops.some((loop) => loop.to === nodeId);
}

/** Read only the sealed manifest; a missing field is byte-compatible false. */
export function nodeRequiresFounderReview(
	snapshot: WorkflowRunSnapshot,
	nodeId: string,
): boolean {
	return (
		snapshot.manifest.nodes.find((node) => node.id === nodeId)
			?.founder_review === true
	);
}

export type WorkflowGateAuthorityMode =
	| "land"
	| "runner_ship"
	| "engine_terminal";
export type WorkflowGateSubjectKind = "git_head" | "snapshot_digest";

export interface WorkflowGateAuthority {
	mode: WorkflowGateAuthorityMode;
	subjectKind: WorkflowGateSubjectKind;
	carrierNodeId?: string;
}

export interface WorkflowDecisionContract {
	family: "qa_verdict" | "review_verdict";
	passOutcome: "qa_pass" | "review_pass";
	failOutcome: "qa_fail" | "review_fail";
	passPredicate: "qa_passed" | "design_review_approved";
	failPredicate: "qa_failed" | "design_review_failed";
	subjectKind: "git_head";
}

/**
 * Resolve a decision node from its pinned verdict pair, never its node type or
 * id. The snapshot manifest is the frozen admission contract.
 */
export function resolveWorkflowDecisionContract(
	snapshot: WorkflowRunSnapshot,
	nodeId: string,
): WorkflowDecisionContract | undefined {
	const verdictLoops = snapshot.manifest.loops.filter(
		(loop) =>
			loop.from === nodeId &&
			(loop.loop_when === "qa_fail" || loop.loop_when === "review_fail"),
	);
	if (verdictLoops.length === 0) return undefined;
	if (verdictLoops.length !== 1) {
		throw new Error("workflow_decision_contract_ambiguous");
	}
	const loop = verdictLoops[0]!;
	const exitEdges = snapshot.manifest.edges.filter(
		(edge) => edge.from === nodeId && edge.condition === loop.exit_when,
	);
	if (exitEdges.length !== 1) {
		throw new Error("workflow_decision_contract_exit_ambiguous");
	}
	if (loop.loop_when === "qa_fail" && loop.exit_when === "qa_pass") {
		return {
			family: "qa_verdict",
			passOutcome: "qa_pass",
			failOutcome: "qa_fail",
			passPredicate: "qa_passed",
			failPredicate: "qa_failed",
			subjectKind: "git_head",
		};
	}
	if (loop.loop_when === "review_fail" && loop.exit_when === "review_pass") {
		return {
			family: "review_verdict",
			passOutcome: "review_pass",
			failOutcome: "review_fail",
			passPredicate: "design_review_approved",
			failPredicate: "design_review_failed",
			subjectKind: "git_head",
		};
	}
	throw new Error("workflow_decision_contract_mismatch");
}

/**
 * FLY-1441: derive the post-Gate authority from one coherent pinned capability
 * bundle. Node ids and template ids are intentionally irrelevant.
 */
export function resolveWorkflowGateAuthority(
	snapshot: WorkflowRunSnapshot,
): WorkflowGateAuthority {
	const claimSubjectKind: WorkflowGateSubjectKind =
		snapshot.manifest.ship_claims.some((claim) => claim !== "founder_approved")
			? "git_head"
			: "snapshot_digest";
	if (isWorkflowManifestLand(snapshot.manifest)) {
		return { mode: "land", subjectKind: "git_head" };
	}
	const shipCapable = snapshot.resolved.nodes.filter((node) => {
		const capabilities = node.capabilities;
		return (
			capabilities.creates_pr || capabilities.can_ship || capabilities.can_land
		);
	});
	const candidates = shipCapable;
	if (candidates.length === 0) {
		return { mode: "engine_terminal", subjectKind: claimSubjectKind };
	}
	if (candidates.length !== 1) {
		throw new Error("incoherent_ship_bundle");
	}
	const carrier = candidates[0]!;
	const capabilities = carrier.capabilities;
	if (
		!capabilities.creates_pr ||
		!capabilities.can_ship ||
		!capabilities.can_land ||
		!capabilities.approval_gate_holder ||
		!capabilities.needs_mailbox_transport ||
		capabilities.completion_route !== "needs_review"
	) {
		throw new Error("incoherent_ship_bundle");
	}
	return {
		mode: "runner_ship",
		subjectKind: "git_head",
		carrierNodeId: carrier.id,
	};
}

/** Kept as a source-compatible alias for schema-v2 consumers. */
export type ResolvedWorkflowNodeV2 = ResolvedWorkflowNode;

function object(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${path} must be an object`);
	}
	return value as Record<string, unknown>;
}

function exact(
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
	return value;
}

function snapshotBody<T extends Omit<WorkflowRunSnapshot, "snapshot_digest">>(
	snapshot: T,
): T {
	return snapshot;
}

function readAgent(canonicalRoot: string, agentFile: string) {
	let root: string;
	let target: string;
	try {
		root = realpathSync(canonicalRoot);
		target = realpathSync(resolve(root, agentFile));
	} catch (err) {
		throw new Error(
			`workflow agent file cannot be read: ${(err as Error).message}`,
		);
	}
	const rel = relative(root, target);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error("workflow agent file escapes the canonical project root");
	}
	const source = readFileSync(target, "utf8");
	const content = source.slice(0, 40_000);
	if (!content.trim()) {
		throw new Error("workflow agent content must be non-empty");
	}
	return { content, digest: canonicalSubmissionDigest(content) };
}

function assertDesignNodeCompletionCapabilities(
	capabilities: WorkflowNodeCapabilities,
	path: string,
): void {
	if (
		capabilities.completion_route === "phase_design_complete" &&
		capabilities.shared_branch_writer !== true
	) {
		throw new Error(
			`${path}: design-node completion requires a shared branch writer for its committed founder HTML`,
		);
	}
}

/** Resolve the immutable role text delivered with a typed execution. */
export function workflowNodeAgentContent(
	node: Pick<ResolvedWorkflowNode, "agent">,
): string | undefined {
	return node.agent?.content;
}

/** Materialize the legacy engineering manifest into the same typed engine envelope. */
export function buildWorkflowRunSnapshotV1(input: {
	template: { id: string; revision: number };
	manifest: unknown;
	workKind?: {
		taskCategory?: WorkKindCategory;
		categorySource: CategorySource;
		tier?: EngTier;
	};
}): WorkflowRunSnapshotV1 {
	const validated = validateWorkflowManifest(input.manifest);
	if (validated.schema_version !== 1) {
		throw new Error("typed engineering snapshot requires schema_version 1");
	}
	const resolved: ResolvedWorkflowNode[] = validated.nodes.map((node) => {
		const capabilities = {
			...getNodeTypeRegistryEntry(node.type).capabilities,
			...(isWorkflowManifestV1Land(validated) &&
			node.id === validated.approval_gate.node
				? { can_request_ship_approval: true }
				: {}),
		};
		assertDesignNodeCompletionCapabilities(
			capabilities,
			`workflow node ${node.id}`,
		);
		if (node.type === "gate" || node.type === "land") {
			return { id: node.id, type: node.type, capabilities };
		}
		if (!node.vendor || !node.model) {
			throw new Error(
				`workflow node ${node.id} requires pinned vendor and model`,
			);
		}
		return {
			id: node.id,
			type: node.type,
			capabilities,
			dispatch: {
				vendor: node.vendor,
				model: node.model,
				...(node.effort ? { effort: node.effort } : {}),
			},
		};
	});
	const body = snapshotBody({
		schema_version: 1 as const,
		template: { ...input.template },
		manifest: validated,
		manifest_digest: canonicalSubmissionDigest(validated),
		resolved: { nodes: resolved },
		...(input.workKind
			? {
					...(input.workKind.taskCategory
						? { task_category: input.workKind.taskCategory }
						: {}),
					category_source: input.workKind.categorySource,
					...(input.workKind.tier ? { tier: input.workKind.tier } : {}),
				}
			: {}),
	});
	return { ...body, snapshot_digest: canonicalSubmissionDigest(body) };
}

/** Materialize every live-registry decision into a self-contained v2 snapshot. */
export function buildWorkflowRunSnapshotV2(input: {
	template: { id: string; revision: number };
	manifest: unknown;
	canonicalRoot: string;
	workKind?: {
		taskCategory?: WorkKindCategory;
		categorySource: CategorySource;
		tier?: EngTier;
	};
	/** One registry generation for alias validation and canonicalization. */
	modelSnapshot?: ModelConfigSnapshot;
}): WorkflowRunSnapshotV2 {
	const validated = validateWorkflowManifest(input.manifest, {
		...(input.modelSnapshot ? { modelSnapshot: input.modelSnapshot } : {}),
	});
	if (validated.schema_version !== 2) {
		throw new Error("typed generalized snapshot requires schema_version 2");
	}
	const hasArtifactProducingGeneric = validated.nodes.some(
		(node) => node.type === "generic" && node.produces_output === true,
	);
	const landVariant = isWorkflowManifestLand(validated);
	const resolved: ResolvedWorkflowNode[] = validated.nodes.map((node) => {
		const registry = getNodeTypeRegistryEntry(node.type);
		const isAuxiliaryGeneric =
			node.type === "generic" &&
			node.produces_output !== true &&
			hasArtifactProducingGeneric;
		const capabilities: WorkflowNodeCapabilities = {
			...registry.capabilities,
			...(landVariant && node.type !== "land"
				? {
						can_ship: false,
						can_land: false,
						approval_gate_holder: false,
					}
				: {}),
			...(landVariant && node.id === validated.approval_gate.node
				? { can_request_ship_approval: true }
				: {}),
			...(isAuxiliaryGeneric
				? {
						creates_pr: false,
						can_ship: false,
						can_land: false,
						approval_gate_holder: false,
						needs_review_evidence: false,
						completion_route: "no_code" as const,
					}
				: {}),
			...(node.type === "generic" && node.produces_output
				? { produces_output: true, output_mode: "json_v1" as const }
				: {}),
		};
		if (capabilities.qa_verdict_emitter && capabilities.produces_output) {
			throw new Error(
				`workflow node ${node.id} cannot emit QA verdicts and produce output`,
			);
		}
		assertDesignNodeCompletionCapabilities(
			capabilities,
			`workflow node ${node.id}`,
		);
		if (node.type === "gate" || node.type === "land") {
			return { id: node.id, type: node.type, capabilities };
		}
		if (!node.vendor || !node.model || !node.effort) {
			throw new Error(
				`workflow node ${node.id} requires pinned vendor, model, and effort`,
			);
		}
		return {
			id: node.id,
			type: node.type,
			capabilities,
			dispatchPinned: true,
			dispatch: {
				vendor: node.vendor,
				model: node.model,
				effort: node.effort,
			},
			...(node.output ? { output: node.output } : {}),
			...(node.agent_file
				? { agent: readAgent(input.canonicalRoot, node.agent_file) }
				: node.role || isBundledWorkflowNodeName(node.id)
					? {
							agent: readAgent(
								input.canonicalRoot,
								resolveNodeAgentFile(input.canonicalRoot, node.role ?? node.id),
							),
						}
					: (() => {
							throw new Error(
								`workflow node type ${node.type} requires a registered agent`,
							);
						})()),
		};
	});
	const body = snapshotBody({
		schema_version: 2,
		template: { ...input.template },
		manifest: validated,
		manifest_digest: canonicalSubmissionDigest(validated),
		resolved: { nodes: resolved },
		...(input.workKind
			? {
					...(input.workKind.taskCategory
						? { task_category: input.workKind.taskCategory }
						: {}),
					category_source: input.workKind.categorySource,
					...(input.workKind.tier ? { tier: input.workKind.tier } : {}),
				}
			: {}),
	});
	return { ...body, snapshot_digest: canonicalSubmissionDigest(body) };
}

const CAPABILITY_KEYS = [
	"shared_branch_writer",
	"creates_pr",
	"can_ship",
	"can_land",
	"approval_gate_holder",
	"needs_review_evidence",
	"needs_mailbox_transport",
	"keepalive_park",
	"qa_verdict_emitter",
	"produces_output",
	"completion_route",
	"output_mode",
	"allow_no_code_completion",
] as const;

const LAND_CAPABILITY_KEY = "can_request_ship_approval" as const;

function parseCapabilities(
	value: unknown,
	path: string,
	landVariant: boolean,
): WorkflowNodeCapabilities {
	const raw = object(value, path);
	exact(
		raw,
		landVariant ? [...CAPABILITY_KEYS, LAND_CAPABILITY_KEY] : CAPABILITY_KEYS,
		`${path} capabilities`,
	);
	const booleanKeys = CAPABILITY_KEYS.slice(0, 10);
	for (const key of booleanKeys) {
		if (typeof raw[key] !== "boolean") {
			throw new Error(`${path}.${key} must be boolean`);
		}
	}
	if (
		raw.allow_no_code_completion !== undefined &&
		typeof raw.allow_no_code_completion !== "boolean"
	) {
		throw new Error(`${path}.allow_no_code_completion must be boolean`);
	}
	if (
		landVariant &&
		raw[LAND_CAPABILITY_KEY] !== undefined &&
		typeof raw[LAND_CAPABILITY_KEY] !== "boolean"
	) {
		throw new Error(`${path}.${LAND_CAPABILITY_KEY} must be boolean`);
	}
	if (
		raw.completion_route !== "phase_design_complete" &&
		raw.completion_route !== "needs_review" &&
		raw.completion_route !== "no_code"
	) {
		throw new Error(`${path}.completion_route is unknown`);
	}
	if (raw.output_mode !== "none" && raw.output_mode !== "json_v1") {
		throw new Error(`${path}.output_mode is unknown`);
	}
	return raw as unknown as WorkflowNodeCapabilities;
}

/** Parse only pinned snapshot vocabulary; never consult the mutable live registry. */
export function parseWorkflowRunSnapshot(source: string): WorkflowRunSnapshot {
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch {
		throw new Error("workflow snapshot JSON is corrupt");
	}
	const root = object(parsed, "workflow snapshot");
	exact(
		root,
		[
			"schema_version",
			"template",
			"manifest",
			"manifest_digest",
			"resolved",
			"snapshot_digest",
			"task_category",
			"category_source",
			"tier",
		],
		"workflow snapshot",
	);
	if (root.schema_version !== 1 && root.schema_version !== 2) {
		throw new Error("workflow snapshot schema_version must be 1 or 2");
	}
	const taskCategory =
		root.task_category === undefined
			? undefined
			: nonempty(root.task_category, "workflow snapshot.task_category");
	if (
		taskCategory !== undefined &&
		!WORKFLOW_SNAPSHOT_TASK_CATEGORIES.includes(
			taskCategory as (typeof WORKFLOW_SNAPSHOT_TASK_CATEGORIES)[number],
		)
	) {
		throw new Error("workflow snapshot.task_category is unknown");
	}
	const categorySource = root.category_source;
	if (
		categorySource !== undefined &&
		!CATEGORY_SOURCES.includes(categorySource as CategorySource)
	) {
		throw new Error("workflow snapshot.category_source is unknown");
	}
	if (categorySource === "task_category" && taskCategory === undefined) {
		throw new Error(
			"workflow snapshot.task_category is required for task_category provenance",
		);
	}
	const tier = root.tier;
	if (tier !== undefined && !ENG_TIERS.includes(tier as EngTier)) {
		throw new Error("workflow snapshot.tier is unknown");
	}
	const workKind =
		categorySource === undefined
			? {}
			: {
					...(taskCategory
						? { task_category: taskCategory as WorkKindCategory }
						: {}),
					category_source: categorySource as CategorySource,
					...(tier ? { tier: tier as EngTier } : {}),
				};
	// The manifest is already pinned. Parse its structure without consulting the
	// mutable live node registry; capability invariants are checked below from
	// the snapshot's pinned resolved nodes.
	const manifest =
		root.schema_version === 1
			? validateWorkflowManifest(root.manifest, {
					allowUnsupportedModels: true,
				})
			: validatePinnedWorkflowManifest(root.manifest);
	if (manifest.schema_version !== root.schema_version) {
		throw new Error("workflow snapshot manifest schema_version mismatch");
	}
	const manifestDigest = nonempty(
		root.manifest_digest,
		"workflow snapshot.manifest_digest",
	);
	if (manifestDigest !== canonicalSubmissionDigest(manifest)) {
		throw new Error("workflow snapshot manifest digest mismatch");
	}
	const templateRaw = object(root.template, "workflow snapshot.template");
	exact(templateRaw, ["id", "revision"], "workflow snapshot.template");
	const template = {
		id: nonempty(templateRaw.id, "workflow snapshot.template.id"),
		revision: Number(templateRaw.revision),
	};
	if (!Number.isInteger(template.revision) || template.revision <= 0) {
		throw new Error("workflow snapshot.template.revision must be positive");
	}
	const resolvedRaw = object(root.resolved, "workflow snapshot.resolved");
	exact(resolvedRaw, ["nodes"], "workflow snapshot.resolved");
	if (!Array.isArray(resolvedRaw.nodes)) {
		throw new Error("workflow snapshot.resolved.nodes must be an array");
	}
	const resolved = resolvedRaw.nodes.map(
		(value, index): ResolvedWorkflowNode => {
			const path = `workflow snapshot.resolved.nodes[${index}]`;
			const nodeRaw = object(value, path);
			exact(
				nodeRaw,
				[
					"id",
					"type",
					"capabilities",
					"dispatchPinned",
					"dispatch",
					"output",
					"agent",
				],
				path,
			);
			const id = nonempty(nodeRaw.id, `${path}.id`);
			const manifestNode = manifest.nodes.find((node) => node.id === id);
			if (!manifestNode || manifestNode.type !== nodeRaw.type) {
				throw new Error(`${path} references an unknown or mismatched node`);
			}
			const capabilities = parseCapabilities(
				nodeRaw.capabilities,
				`${path}.capabilities`,
				isWorkflowManifestLand(manifest),
			);
			assertDesignNodeCompletionCapabilities(capabilities, path);
			if (manifestNode.type === "gate" || manifestNode.type === "land") {
				if (
					nodeRaw.dispatch !== undefined ||
					nodeRaw.dispatchPinned !== undefined ||
					nodeRaw.output !== undefined ||
					nodeRaw.agent !== undefined
				) {
					throw new Error(
						`${path} ${manifestNode.type} cannot carry execution fields`,
					);
				}
				return { id, type: manifestNode.type, capabilities };
			}
			const dispatchRaw = object(nodeRaw.dispatch, `${path}.dispatch`);
			exact(dispatchRaw, ["vendor", "model", "effort"], `${path}.dispatch`);
			if (dispatchRaw.vendor !== "claude" && dispatchRaw.vendor !== "codex") {
				throw new Error(`${path}.dispatch.vendor is unknown`);
			}
			if (
				dispatchRaw.effort !== undefined &&
				dispatchRaw.effort !== "low" &&
				dispatchRaw.effort !== "medium" &&
				dispatchRaw.effort !== "high" &&
				dispatchRaw.effort !== "xhigh" &&
				dispatchRaw.effort !== "max"
			) {
				throw new Error(`${path}.dispatch.effort is unknown`);
			}
			if (root.schema_version === 2 && dispatchRaw.effort === undefined) {
				throw new Error(`${path}.dispatch.effort is required`);
			}
			const node: ResolvedWorkflowNode = {
				id,
				type: manifestNode.type,
				capabilities,
				...(nodeRaw.dispatchPinned === true ? { dispatchPinned: true } : {}),
				dispatch: {
					vendor: dispatchRaw.vendor,
					model: nonempty(dispatchRaw.model, `${path}.dispatch.model`),
					...(dispatchRaw.effort
						? { effort: dispatchRaw.effort as WorkflowEffort }
						: {}),
				},
			};
			if (
				nodeRaw.dispatchPinned !== undefined &&
				nodeRaw.dispatchPinned !== true
			) {
				throw new Error(`${path}.dispatchPinned must be true when present`);
			}
			if (
				root.schema_version === 1 &&
				(nodeRaw.output !== undefined || nodeRaw.agent !== undefined)
			) {
				throw new Error(
					`${path} schema-v1 node cannot carry generalized fields`,
				);
			}
			if (nodeRaw.output !== undefined) {
				const outputRaw = object(nodeRaw.output, `${path}.output`);
				exact(outputRaw, ["schema", "max_bytes"], `${path}.output`);
				if (
					outputRaw.schema !== "json_v1" ||
					!Number.isInteger(outputRaw.max_bytes) ||
					Number(outputRaw.max_bytes) <= 0 ||
					Number(outputRaw.max_bytes) > 262_144
				) {
					throw new Error(`${path}.output is invalid`);
				}
				node.output = {
					schema: "json_v1",
					max_bytes: Number(outputRaw.max_bytes),
				};
			}
			if (nodeRaw.agent !== undefined) {
				const agentRaw = object(nodeRaw.agent, `${path}.agent`);
				exact(agentRaw, ["content", "digest"], `${path}.agent`);
				const content = nonempty(agentRaw.content, `${path}.agent.content`);
				const digest = nonempty(agentRaw.digest, `${path}.agent.digest`);
				if (digest !== canonicalSubmissionDigest(content)) {
					throw new Error(`${path}.agent digest mismatch`);
				}
				node.agent = { content, digest };
			} else if (root.schema_version === 2 && manifestNode.type === "generic") {
				throw new Error(`${path} generic node requires a pinned agent`);
			}
			if (capabilities.produces_output !== !!node.output) {
				throw new Error(
					`${path} output capability does not match output contract`,
				);
			}
			return node;
		},
	);
	if (
		resolved.length !== manifest.nodes.length ||
		manifest.nodes.some(
			(node) => !resolved.some((candidate) => candidate.id === node.id),
		)
	) {
		throw new Error(
			"workflow snapshot resolved nodes do not cover the manifest",
		);
	}
	// Mirrors the authoring-side invariant in workflow-template.ts: the
	// independent-QA requirement keys on the formal engineering pipeline (an
	// `implement` node), not on "can this node edit files". Keying on pinned
	// write capability would make every single-stage (generic) run unparseable
	// the moment generic gained the write capabilities it needs to land work.
	const pinnedWritesCode = resolved.some((node) => node.type === "implement");
	const qaVerdictCount = manifest.loops.filter(
		(loop) =>
			loop.loop_when === "qa_fail" &&
			loop.exit_when === "qa_pass" &&
			manifest.edges.some(
				(edge) => edge.from === loop.from && edge.condition === loop.exit_when,
			),
	).length;
	if (
		pinnedWritesCode &&
		(qaVerdictCount !== 1 || !manifest.ship_claims.includes("qa_passed"))
	) {
		throw new Error(
			"a workflow containing a pinned code-writing node must contain exactly one independent QA verdict contract and qa_passed ship claim",
		);
	}
	const body =
		root.schema_version === 1 && manifest.schema_version === 1
			? snapshotBody({
					schema_version: 1 as const,
					template,
					manifest,
					manifest_digest: manifestDigest,
					resolved: { nodes: resolved },
					...workKind,
				})
			: snapshotBody({
					schema_version: 2 as const,
					template,
					manifest: manifest as WorkflowManifestV2,
					manifest_digest: manifestDigest,
					resolved: { nodes: resolved },
					...workKind,
				});
	const digest = nonempty(
		root.snapshot_digest,
		"workflow snapshot.snapshot_digest",
	);
	if (digest !== canonicalSubmissionDigest(body)) {
		throw new Error("workflow snapshot digest mismatch");
	}
	return { ...body, snapshot_digest: digest } as WorkflowRunSnapshot;
}
