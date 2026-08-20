import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	getModelRegistryEntry,
	getNodeTypeRegistryEntry,
	WORKFLOW_MENU_SHAPES,
	type WorkflowMenuShapeId,
	workflowMenuTemplateId,
} from "flywheel-config";
import { parse } from "yaml";
import type { StateStore } from "./StateStore.js";
import {
	type LoadedWorkflowSeed,
	validateWorkflowManifest,
	type WorkflowEffort,
	type WorkflowManifestNode,
	type WorkflowTemplateOverride,
	workflowSeedContentHash,
} from "./workflow-template.js";

export { WORKFLOW_MENU_SHAPES, type WorkflowMenuShapeId };

const MENU_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const MENU_SOURCE_DIRECTORY = fileURLToPath(
	new URL("../../../menus/shapes/", import.meta.url),
);

export interface WorkflowMenuModel {
	model: string;
	allowedEfforts: WorkflowEffort[];
	defaultEffort: WorkflowEffort;
}

export interface WorkflowMenuNode {
	id: string;
	role?: string;
	type?: "gate";
	defaultModel?: string;
	models?: WorkflowMenuModel[];
}

export interface WorkflowMenuEdge {
	id: string;
	from: string;
	to: string;
	condition: "design_done" | "implement_done" | "qa_pass" | "node_done";
}

export interface WorkflowMenuLoop {
	id: string;
	from: string;
	to: string;
	loopWhen: "qa_fail" | "founder_feedback_kickback";
	exitWhen: "qa_pass" | "founder_approved";
	maxIterations?: number;
	onLimit?: "escalate";
}

export interface WorkflowMenuShape {
	shape: WorkflowMenuShapeId;
	founderReview?: boolean;
	nodes: WorkflowMenuNode[];
	edges: WorkflowMenuEdge[];
	loops: WorkflowMenuLoop[];
}

export interface ProjectMenuConfig {
	roster: Record<string, string>;
	adoption: Record<string, WorkflowMenuShapeId[]>;
}

export type MenuNodeOverrides = Record<
	string,
	{ model?: string; effort?: string }
>;

export class WorkflowMenuValidationError extends Error {
	readonly status = 400 as const;

	constructor(
		readonly code: string,
		message: string,
		readonly legal: readonly string[],
	) {
		super(message);
		this.name = "WorkflowMenuValidationError";
	}
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
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
	legal: readonly T[],
	path: string,
): T {
	if (typeof value !== "string" || !legal.includes(value as T)) {
		throw new Error(`${path} must be one of: ${legal.join(", ")}`);
	}
	return value as T;
}

function safeProjectRelativePath(value: unknown, path: string): string {
	const candidate = nonempty(value, path);
	if (
		isAbsolute(candidate) ||
		/^[A-Za-z]:[\\/]/.test(candidate) ||
		candidate.startsWith("\\\\") ||
		candidate.split(/[\\/]/).includes("..")
	) {
		throw new Error(`${path} must be a safe project-relative path`);
	}
	return candidate;
}

function parseMenuModel(value: unknown, path: string): WorkflowMenuModel {
	const raw = asRecord(value, path);
	exactKeys(raw, ["model", "allowedEfforts", "defaultEffort"], path);
	const model = nonempty(raw.model, `${path}.model`);
	const registry = getModelRegistryEntry(model);
	if (
		!registry ||
		!registry.aliases.some(
			(alias) => alias.toLowerCase() === model.toLowerCase(),
		) ||
		!registry.surfaces.includes("workflow")
	) {
		throw new Error(
			`${path}.model must be a workflow alias from the canonical model registry`,
		);
	}
	if (!Array.isArray(raw.allowedEfforts)) {
		throw new Error(`${path}.allowedEfforts must be an array`);
	}
	const allowedEfforts = raw.allowedEfforts.map((effort, index) =>
		oneOf(effort, MENU_EFFORTS, `${path}.allowedEfforts[${index}]`),
	);
	if (new Set(allowedEfforts).size !== allowedEfforts.length) {
		throw new Error(`${path}.allowedEfforts contains duplicates`);
	}
	const registryEfforts = [
		...(registry.effortsBySurface.workflow ?? []),
	] as WorkflowEffort[];
	if (allowedEfforts.some((effort) => !registryEfforts.includes(effort))) {
		throw new Error(
			`${path}.allowedEfforts must be a subset of the ${model} workflow CLI set: ${registryEfforts.join(", ")}`,
		);
	}
	const defaultEffort = oneOf(
		raw.defaultEffort,
		allowedEfforts,
		`${path}.defaultEffort`,
	);
	return { model, allowedEfforts, defaultEffort };
}

function parseMenuNode(value: unknown, path: string): WorkflowMenuNode {
	const raw = asRecord(value, path);
	const id = nonempty(raw.id, `${path}.id`);
	if (raw.type === "gate") {
		exactKeys(raw, ["id", "type"], path);
		return { id, type: "gate" };
	}
	exactKeys(raw, ["id", "role", "defaultModel", "models"], path);
	const role = nonempty(raw.role, `${path}.role`);
	const defaultModel = nonempty(raw.defaultModel, `${path}.defaultModel`);
	if (!Array.isArray(raw.models) || raw.models.length === 0) {
		throw new Error(`${path}.models must be a non-empty array`);
	}
	const models = raw.models.map((model, index) =>
		parseMenuModel(model, `${path}.models[${index}]`),
	);
	if (new Set(models.map((model) => model.model)).size !== models.length) {
		throw new Error(`${path}.models contains duplicate aliases`);
	}
	if (!models.some((model) => model.model === defaultModel)) {
		throw new Error(`${path}.defaultModel must identify one declared model`);
	}
	return { id, role, defaultModel, models };
}

function parseMenuShape(value: unknown, source: string): WorkflowMenuShape {
	const raw = asRecord(value, source);
	exactKeys(raw, ["shape", "founderReview", "nodes", "edges", "loops"], source);
	const shape = oneOf(raw.shape, WORKFLOW_MENU_SHAPES, `${source}.shape`);
	if (
		raw.founderReview !== undefined &&
		typeof raw.founderReview !== "boolean"
	) {
		throw new Error(`${source}.founderReview must be a boolean`);
	}
	if (!Array.isArray(raw.nodes) || raw.nodes.length < 2) {
		throw new Error(`${source}.nodes must contain executable and gate nodes`);
	}
	const nodes = raw.nodes.map((node, index) =>
		parseMenuNode(node, `${source}.nodes[${index}]`),
	);
	const nodeIds = new Set<string>();
	for (const node of nodes) {
		if (nodeIds.has(node.id))
			throw new Error(`${source} duplicate node ${node.id}`);
		nodeIds.add(node.id);
	}
	const gates = nodes.filter((node) => node.type === "gate");
	if (gates.length !== 1) {
		throw new Error(`${source} must contain exactly one gate`);
	}
	if (!Array.isArray(raw.edges))
		throw new Error(`${source}.edges must be an array`);
	const edges = raw.edges.map((value, index): WorkflowMenuEdge => {
		const path = `${source}.edges[${index}]`;
		const edge = asRecord(value, path);
		exactKeys(edge, ["id", "from", "to", "condition"], path);
		const from = nonempty(edge.from, `${path}.from`);
		const to = nonempty(edge.to, `${path}.to`);
		if (!nodeIds.has(from) || !nodeIds.has(to)) {
			throw new Error(`${path} references an unknown node`);
		}
		return {
			id: nonempty(edge.id, `${path}.id`),
			from,
			to,
			condition: oneOf(
				edge.condition,
				["design_done", "implement_done", "qa_pass", "node_done"] as const,
				`${path}.condition`,
			),
		};
	});
	if (!Array.isArray(raw.loops))
		throw new Error(`${source}.loops must be an array`);
	const loops = raw.loops.map((value, index): WorkflowMenuLoop => {
		const path = `${source}.loops[${index}]`;
		const loop = asRecord(value, path);
		exactKeys(
			loop,
			["id", "from", "to", "loopWhen", "exitWhen", "maxIterations", "onLimit"],
			path,
		);
		const from = nonempty(loop.from, `${path}.from`);
		const to = nonempty(loop.to, `${path}.to`);
		if (!nodeIds.has(from) || !nodeIds.has(to)) {
			throw new Error(`${path} references an unknown node`);
		}
		const loopWhen = oneOf(
			loop.loopWhen,
			["qa_fail", "founder_feedback_kickback"] as const,
			`${path}.loopWhen`,
		);
		const hasMaxIterations = loop.maxIterations !== undefined;
		const hasOnLimit = loop.onLimit !== undefined;
		if (hasMaxIterations !== hasOnLimit) {
			throw new Error(
				`${path}.maxIterations and ${path}.onLimit must be provided together`,
			);
		}
		if (loopWhen !== "founder_feedback_kickback" && !hasMaxIterations) {
			throw new Error(
				`${path}.maxIterations and ${path}.onLimit are required for ${loopWhen}`,
			);
		}
		const maxIterations = hasMaxIterations
			? Number(loop.maxIterations)
			: undefined;
		if (
			maxIterations !== undefined &&
			(!Number.isInteger(maxIterations) || maxIterations <= 0)
		) {
			throw new Error(`${path}.maxIterations must be a positive integer`);
		}
		return {
			id: nonempty(loop.id, `${path}.id`),
			from,
			to,
			loopWhen,
			exitWhen: oneOf(
				loop.exitWhen,
				["qa_pass", "founder_approved"] as const,
				`${path}.exitWhen`,
			),
			...(maxIterations !== undefined
				? {
						maxIterations,
						onLimit: oneOf(
							loop.onLimit,
							["escalate"] as const,
							`${path}.onLimit`,
						),
					}
				: {}),
		};
	});
	const executableCount = nodes.filter((node) => node.type !== "gate").length;
	if (shape === "code") {
		const qaLoop = loops.find(
			(loop) => loop.loopWhen === "qa_fail" && loop.exitWhen === "qa_pass",
		);
		const founderLoop = loops.find(
			(loop) =>
				loop.loopWhen === "founder_feedback_kickback" &&
				loop.exitWhen === "founder_approved",
		);
		if (
			executableCount !== 3 ||
			loops.length !== 2 ||
			qaLoop?.maxIterations !== 3 ||
			founderLoop?.maxIterations !== undefined ||
			founderLoop?.onLimit !== undefined
		) {
			throw new Error(
				`${source} code must have three executable nodes plus a max-3 QA loop and an unbounded founder-rework loop`,
			);
		}
	} else if (shape === "simple_code") {
		const executable = nodes.filter((node) => node.type !== "gate");
		const implement = executable.find((node) => node.role === "implement");
		const qa = executable.find((node) => node.role === "qa");
		const qaLoop = loops.find(
			(loop) =>
				loop.from === qa?.id &&
				loop.to === implement?.id &&
				loop.loopWhen === "qa_fail" &&
				loop.exitWhen === "qa_pass",
		);
		const founderLoop = loops.find(
			(loop) =>
				loop.from === gates[0]?.id &&
				loop.to === implement?.id &&
				loop.loopWhen === "founder_feedback_kickback" &&
				loop.exitWhen === "founder_approved",
		);
		if (
			executableCount !== 2 ||
			!implement ||
			!qa ||
			loops.length !== 2 ||
			qaLoop?.maxIterations !== 10 ||
			qaLoop?.onLimit !== "escalate" ||
			founderLoop?.maxIterations !== undefined ||
			founderLoop?.onLimit !== undefined
		) {
			throw new Error(
				`${source} simple_code must have implement and QA executable nodes plus a max-10 QA loop and an unbounded founder-rework loop`,
			);
		}
	} else if (executableCount !== 1 || loops.length !== 0) {
		throw new Error(
			`${source} single-session shape must have one executable node and no loops`,
		);
	}
	return {
		shape,
		...(raw.founderReview !== undefined
			? { founderReview: raw.founderReview }
			: {}),
		nodes,
		edges,
		loops,
	};
}

export function loadWorkflowMenuLibrary(
	input: { shapesDirectory?: string } = {},
): WorkflowMenuShape[] {
	const directory = input.shapesDirectory ?? MENU_SOURCE_DIRECTORY;
	return WORKFLOW_MENU_SHAPES.map((shape) => {
		const filename = join(directory, `${shape}.yaml`);
		return parseMenuShape(
			parse(readFileSync(filename, "utf8")),
			`menu ${shape}`,
		);
	});
}

function nodeType(node: WorkflowMenuNode): WorkflowManifestNode["type"] {
	if (node.type === "gate") return "gate";
	if (node.role === "design") return "design";
	if (node.role === "implement") return "implement";
	if (node.role === "qa") return "qa";
	return "generic";
}

function resolveAlias(alias: string): {
	vendor: "claude" | "codex";
	model: string;
} {
	const entry = getModelRegistryEntry(alias);
	if (
		!entry ||
		!entry.aliases.some(
			(candidate) => candidate.toLowerCase() === alias.toLowerCase(),
		) ||
		!entry.surfaces.includes("workflow")
	) {
		throw new Error(`unknown workflow model alias: ${alias}`);
	}
	return { vendor: entry.runtimeVendor, model: entry.id };
}

function menuReviewPairs(menu: WorkflowMenuShape): Array<{
	qa: WorkflowMenuNode;
	producer: WorkflowMenuNode;
}> {
	return menu.nodes
		.filter((node) => node.role === "qa")
		.map((qa) => {
			const producers = menu.edges
				.filter((edge) => edge.to === qa.id)
				.map((edge) => menu.nodes.find((node) => node.id === edge.from))
				.filter(
					(node): node is WorkflowMenuNode => !!node && node.type !== "gate",
				);
			if (producers.length !== 1) {
				throw new Error(
					`menu ${menu.shape} QA node ${qa.id} must have exactly one executable producer`,
				);
			}
			return { qa, producer: producers[0]! };
		});
}

export function compileWorkflowMenuSeed(
	menu: WorkflowMenuShape,
): LoadedWorkflowSeed {
	for (const { qa, producer } of menuReviewPairs(menu)) {
		const qaVendor = resolveAlias(qa.defaultModel!).vendor;
		const producerVendor = resolveAlias(producer.defaultModel!).vendor;
		if (qaVendor === producerVendor) {
			throw new Error(
				`menu ${menu.shape} QA node ${qa.id} uses the same vendor as producer ${producer.id}`,
			);
		}
	}
	const approvalGate = menu.nodes.find((node) => node.type === "gate")!;
	const hasPrProducer = menu.nodes.some(
		(node) =>
			node.type !== "gate" &&
			getNodeTypeRegistryEntry(nodeType(node)).capabilities.creates_pr,
	);
	let terminalNode = "land";
	while (menu.nodes.some((node) => node.id === terminalNode)) {
		terminalNode = `${terminalNode}_`;
	}
	const manifest = validateWorkflowManifest({
		schema_version: 2,
		nodes: [
			...menu.nodes.map((node) => {
				const type = nodeType(node);
				if (type === "gate") return { id: node.id, type };
				const defaultPolicy = node.models!.find(
					(model) => model.model === node.defaultModel,
				)!;
				const resolved = resolveAlias(defaultPolicy.model);
				return {
					id: node.id,
					type,
					...(menu.founderReview === true ? { founder_review: true } : {}),
					role: node.role,
					vendor: resolved.vendor,
					model: resolved.model,
					effort: defaultPolicy.defaultEffort,
				};
			}),
			...(hasPrProducer
				? [{ id: terminalNode, type: "land", execution: "engine" }]
				: []),
		],
		edges: [
			...menu.edges,
			...(hasPrProducer
				? [
						{
							id: `${approvalGate.id}_approved`,
							from: approvalGate.id,
							to: terminalNode,
							condition: "founder_approved",
						},
					]
				: []),
		],
		loops: menu.loops.map((loop) => ({
			id: loop.id,
			from: loop.from,
			to: loop.to,
			loop_when: loop.loopWhen,
			exit_when: loop.exitWhen,
			...(loop.maxIterations !== undefined
				? {
						max_iterations: loop.maxIterations,
						on_limit: loop.onLimit!,
					}
				: {}),
		})),
		...(hasPrProducer
			? {
					approval_gate: {
						node: approvalGate.id,
						predicate: "founder_approved",
					},
					terminal_node: { node: terminalNode },
				}
			: {
					terminal_gate: {
						node: approvalGate.id,
						predicate: "founder_approved",
					},
				}),
		ship_claims: menu.nodes.some((node) => node.role === "qa")
			? ["qa_passed", "founder_approved"]
			: ["founder_approved"],
	});
	const seed = {
		templateId: workflowMenuTemplateId(menu.shape),
		name: `${menu.shape} menu`,
		projectScope: "global",
		manifest,
	};
	return { ...seed, contentHash: workflowSeedContentHash(seed) };
}

export function loadWorkflowMenuSeeds(): LoadedWorkflowSeed[] {
	return loadWorkflowMenuLibrary().map(compileWorkflowMenuSeed);
}

export function importWorkflowMenuSeeds(
	store: Pick<StateStore, "importWorkflowTemplateSeed">,
	env: Record<string, string | undefined> = process.env,
): void {
	for (const seed of loadWorkflowMenuSeeds()) {
		store.importWorkflowTemplateSeed(seed, env);
	}
}

export function reconcileMenuCategoryBindings(
	store: Pick<
		StateStore,
		"getWorkflowCategoryBindingExact" | "bindWorkflowCategory"
	>,
	projects: readonly { projectName: string; projectRoot: string }[],
	log: (message: string) => void = console.warn,
): { bound: number; existing: number; errors: string[] } {
	let bound = 0;
	let existing = 0;
	const errors: string[] = [];
	for (const project of projects) {
		if (!hasProjectMenuConfig(project.projectRoot)) continue;
		let adopted: Set<WorkflowMenuShapeId>;
		try {
			adopted = new Set(
				Object.values(
					loadProjectMenuConfig(project.projectRoot).adoption,
				).flat(),
			);
		} catch (error) {
			const detail = `${project.projectName}:config:${error instanceof Error ? error.message : String(error)}`;
			errors.push(detail);
			log(`[workflow-menu] binding reconcile failed: ${detail}`);
			continue;
		}
		for (const shape of adopted) {
			if (store.getWorkflowCategoryBindingExact(project.projectName, shape)) {
				existing += 1;
				continue;
			}
			try {
				store.bindWorkflowCategory({
					project: project.projectName,
					taskCategory: shape,
					templateId: workflowMenuTemplateId(shape),
					updatedBy: "system:menu-binding-reconcile",
				});
				bound += 1;
			} catch (error) {
				const detail = `${project.projectName}:${shape}:${error instanceof Error ? error.message : String(error)}`;
				errors.push(detail);
				log(`[workflow-menu] binding reconcile failed: ${detail}`);
			}
		}
	}
	return { bound, existing, errors };
}

export function loadProjectMenuConfig(projectRoot: string): ProjectMenuConfig {
	const menuDirectory = join(projectRoot, ".flywheel", "menus");
	const rosterRaw = asRecord(
		parse(readFileSync(join(menuDirectory, "ic-roster.yaml"), "utf8")),
		"ic-roster",
	);
	const roster: Record<string, string> = {};
	for (const [role, rawPath] of Object.entries(rosterRaw)) {
		const cleanRole = nonempty(role, "ic-roster role");
		const configuredPath = safeProjectRelativePath(
			rawPath,
			`ic-roster.${cleanRole}`,
		);
		const absolutePath = resolve(projectRoot, configuredPath);
		if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
			throw new Error(`ic-roster.${cleanRole} file does not exist`);
		}
		const canonicalRoot = realpathSync(projectRoot);
		const canonicalFile = realpathSync(absolutePath);
		const rel = relative(canonicalRoot, canonicalFile);
		if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
			throw new Error(`ic-roster.${cleanRole} escapes the project root`);
		}
		roster[cleanRole] = configuredPath;
	}
	const adoptionRaw = asRecord(
		parse(readFileSync(join(menuDirectory, "adoption.yaml"), "utf8")),
		"adoption",
	);
	const adoption: Record<string, WorkflowMenuShapeId[]> = {};
	for (const [leadId, value] of Object.entries(adoptionRaw)) {
		if (!Array.isArray(value) || value.length === 0) {
			throw new Error(`adoption.${leadId} must be a non-empty array`);
		}
		const menus = value.map((shape, index) =>
			oneOf(shape, WORKFLOW_MENU_SHAPES, `adoption.${leadId}[${index}]`),
		);
		if (new Set(menus).size !== menus.length) {
			throw new Error(`adoption.${leadId} contains duplicate menus`);
		}
		adoption[nonempty(leadId, "adoption lead id")] = menus;
	}
	return { roster, adoption };
}

/** True when a project has entered the menu-config domain (partial config counts). */
export function hasProjectMenuConfig(projectRoot: string): boolean {
	const menuDirectory = join(projectRoot, ".flywheel", "menus");
	return (
		existsSync(join(menuDirectory, "ic-roster.yaml")) ||
		existsSync(join(menuDirectory, "adoption.yaml"))
	);
}

export function resolveLeadMenus(input: {
	projectRoot: string;
	leadId: string;
	shapesDirectory?: string;
}): WorkflowMenuShape[] {
	const config = loadProjectMenuConfig(input.projectRoot);
	const adopted = config.adoption[input.leadId];
	if (!adopted) {
		throw new WorkflowMenuValidationError(
			"LEAD_MENU_ADOPTION_NOT_FOUND",
			`lead ${input.leadId} has no menu adoption`,
			Object.keys(config.adoption),
		);
	}
	const library = loadWorkflowMenuLibrary({
		...(input.shapesDirectory
			? { shapesDirectory: input.shapesDirectory }
			: {}),
	});
	const byShape = new Map(library.map((menu) => [menu.shape, menu]));
	const menus = adopted.map((shape) => byShape.get(shape)!);
	for (const menu of menus) {
		for (const node of menu.nodes) {
			if (node.role && !config.roster[node.role]) {
				throw new WorkflowMenuValidationError(
					"IC_ROLE_NOT_FOUND",
					`menu ${menu.shape} role ${node.role} is absent from the IC roster`,
					Object.keys(config.roster),
				);
			}
		}
	}
	return menus;
}

export function resolveMenuAgentFile(
	projectRoot: string,
	role: string,
): string {
	const roster = loadProjectMenuConfig(projectRoot).roster;
	const agentFile = roster[role];
	if (!agentFile) {
		throw new WorkflowMenuValidationError(
			"IC_ROLE_NOT_FOUND",
			`role ${role} is absent from the IC roster`,
			Object.keys(roster),
		);
	}
	return agentFile;
}

export function resolveMenuOverrides(
	menu: WorkflowMenuShape,
	overridesValue: unknown,
): {
	templateOverride: WorkflowTemplateOverride;
	receipts: Record<
		string,
		{ model: string; effort: WorkflowEffort; overridden: boolean }
	>;
} {
	const overrides =
		overridesValue === undefined ? {} : asRecord(overridesValue, "overrides");
	const executable = menu.nodes.filter((node) => node.type !== "gate");
	const legalNodes = executable.map((node) => node.id);
	for (const nodeId of Object.keys(overrides)) {
		if (!legalNodes.includes(nodeId)) {
			throw new WorkflowMenuValidationError(
				"MENU_NODE_NOT_FOUND",
				`node ${nodeId} is not executable in menu ${menu.shape}`,
				legalNodes,
			);
		}
	}
	const nodes: NonNullable<WorkflowTemplateOverride["nodes"]> = {};
	const receipts: Record<
		string,
		{ model: string; effort: WorkflowEffort; overridden: boolean }
	> = {};
	const selected = new Map<
		string,
		{ alias: string; vendor: "claude" | "codex" }
	>();
	for (const node of executable) {
		const rawOverride = overrides[node.id];
		const override =
			rawOverride === undefined
				? undefined
				: asRecord(rawOverride, `overrides.${node.id}`);
		if (override) {
			exactKeys(override, ["model", "effort"], `overrides.${node.id}`);
			if (override.model === undefined && override.effort === undefined) {
				throw new Error(`overrides.${node.id} must set model or effort`);
			}
		}
		const requestedModel =
			override?.model === undefined
				? node.defaultModel!
				: nonempty(override.model, `overrides.${node.id}.model`);
		const modelPolicy = node.models!.find(
			(model) => model.model === requestedModel,
		);
		if (!modelPolicy) {
			throw new WorkflowMenuValidationError(
				"MODEL_NOT_ALLOWED_FOR_NODE",
				`model ${requestedModel} is not allowed for node ${node.id}`,
				node.models!.map((model) => model.model),
			);
		}
		const effort =
			override?.effort === undefined
				? modelPolicy.defaultEffort
				: nonempty(override.effort, `overrides.${node.id}.effort`);
		if (!modelPolicy.allowedEfforts.includes(effort as WorkflowEffort)) {
			throw new WorkflowMenuValidationError(
				"EFFORT_NOT_ALLOWED_FOR_MODEL",
				`effort ${effort} is not allowed for ${requestedModel} on node ${node.id}`,
				modelPolicy.allowedEfforts,
			);
		}
		const resolved = resolveAlias(requestedModel);
		selected.set(node.id, {
			alias: requestedModel,
			vendor: resolved.vendor,
		});
		if (override) {
			nodes[node.id] = {
				vendor: resolved.vendor,
				model: resolved.model,
				effort: effort as WorkflowEffort,
			};
		}
		receipts[node.id] = {
			model: `${requestedModel} (= ${resolved.model})`,
			effort: effort as WorkflowEffort,
			overridden: override !== undefined,
		};
	}
	for (const { qa, producer } of menuReviewPairs(menu)) {
		const qaSelection = selected.get(qa.id)!;
		const producerSelection = selected.get(producer.id)!;
		if (qaSelection.vendor === producerSelection.vendor) {
			const legal = [
				...producer
					.models!.filter(
						(model) => resolveAlias(model.model).vendor !== qaSelection.vendor,
					)
					.map((model) => `${producer.id}:${model.model}`),
				...qa
					.models!.filter(
						(model) =>
							resolveAlias(model.model).vendor !== producerSelection.vendor,
					)
					.map((model) => `${qa.id}:${model.model}`),
			];
			throw new WorkflowMenuValidationError(
				"SAME_VENDOR_REVIEW_COMBINATION",
				`menu ${menu.shape} QA node ${qa.id} and producer ${producer.id} both resolve to ${qaSelection.vendor}`,
				legal,
			);
		}
	}
	return {
		templateOverride: {
			reason: "menu_api_override",
			...(Object.keys(nodes).length > 0 ? { nodes } : {}),
		},
		receipts,
	};
}
