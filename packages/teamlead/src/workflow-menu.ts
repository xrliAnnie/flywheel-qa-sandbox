import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type BundledRegistry,
	getModelRegistryEntry,
	getNodeTypeRegistryEntry,
	loadBundledRegistry,
	resolveProjectRegistry,
} from "flywheel-config";
import { parse } from "yaml";
import type { StateStore } from "./StateStore.js";
import {
	type LoadedWorkflowSeed,
	validateWorkflowManifest,
	type WorkflowEffort,
	type WorkflowTemplateOverride,
	workflowSeedContentHash,
} from "./workflow-template.js";

export type WorkflowMenuShapeId = string;

const BUNDLED_REGISTRY_PATH = fileURLToPath(
	new URL("../../../.flywheel/agents/registry.yaml", import.meta.url),
);

export interface WorkflowMenuModel {
	model: string;
	allowedEfforts: WorkflowEffort[];
	defaultEffort: WorkflowEffort;
}

export interface WorkflowMenuNode {
	id: string;
	label: string;
	type: "design" | "implement" | "qa" | "generic" | "gate";
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
	templateId: string;
	label: string;
	landLabel: string;
	founderReview?: boolean;
	nodes: WorkflowMenuNode[];
	edges: WorkflowMenuEdge[];
	loops: WorkflowMenuLoop[];
}

export interface ProjectMenuConfig {
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

function menuFromGraph(
	registry: BundledRegistry,
	shape: string,
): WorkflowMenuShape {
	const graph = registry.graphs[shape];
	if (!graph) throw new Error(`workflow graph ${shape} is not registered`);
	const landId = graph.nodes.find((node) => node === "land");
	if (!landId) throw new Error(`workflow graph ${shape} must register land`);
	const nodes = graph.nodes
		.filter((node) => node !== landId)
		.map((id): WorkflowMenuNode => {
			const executable = registry.nodes[id];
			if (executable) {
				const policy = graph.policies[id]!;
				return {
					id,
					label: executable.label,
					type: executable.type!,
					defaultModel: policy.defaultModel,
					models: policy.models,
				};
			}
			const structural = registry.structural[id];
			if (!structural || id !== "founder_gate") {
				throw new Error(
					`workflow graph ${shape} has unsupported structural node ${id}`,
				);
			}
			return { id, label: structural.label, type: "gate" };
		});
	return {
		shape,
		templateId: graph.templateId,
		label: graph.label,
		landLabel: registry.structural[landId]!.label,
		...(graph.founderReview === undefined
			? {}
			: { founderReview: graph.founderReview }),
		nodes,
		edges: graph.edges.filter(
			(edge) => edge.from !== landId && edge.to !== landId,
		) as WorkflowMenuEdge[],
		loops: graph.loops,
	};
}

export function loadWorkflowMenuLibrary(
	input: { registryPath?: string } = {},
): WorkflowMenuShape[] {
	const registry = loadBundledRegistry(
		input.registryPath ?? BUNDLED_REGISTRY_PATH,
	);
	return Object.keys(registry.graphs).map((shape) =>
		menuFromGraph(registry, shape),
	);
}

export function isBundledWorkflowNodeName(nodeName: string): boolean {
	return Boolean(loadBundledRegistry(BUNDLED_REGISTRY_PATH).nodes[nodeName]);
}

export function loadBundledWorkflowNodeNames(): string[] {
	return Object.keys(loadBundledRegistry(BUNDLED_REGISTRY_PATH).nodes).sort();
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
		.filter((node) => node.type === "qa")
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
			getNodeTypeRegistryEntry(node.type).capabilities.creates_pr,
	);
	let terminalNode = "land";
	while (menu.nodes.some((node) => node.id === terminalNode)) {
		terminalNode = `${terminalNode}_`;
	}
	const manifest = validateWorkflowManifest({
		schema_version: 2,
		nodes: [
			...menu.nodes.map((node) => {
				const type = node.type;
				if (type === "gate") return { id: node.id, label: node.label, type };
				const defaultPolicy = node.models!.find(
					(model) => model.model === node.defaultModel,
				)!;
				const resolved = resolveAlias(defaultPolicy.model);
				return {
					id: node.id,
					label: node.label,
					type,
					...(menu.founderReview === true ? { founder_review: true } : {}),
					vendor: resolved.vendor,
					model: resolved.model,
					effort: defaultPolicy.defaultEffort,
				};
			}),
			...(hasPrProducer
				? [
						{
							id: terminalNode,
							label: menu.landLabel,
							type: "land",
							execution: "engine",
						},
					]
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
		ship_claims: menu.nodes.some((node) => node.type === "qa")
			? ["qa_passed", "founder_approved"]
			: ["founder_approved"],
	});
	const seed = {
		templateId: menu.templateId,
		name: menu.label,
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

export function workflowMenuBindings(): Array<{
	taskCategory: WorkflowMenuShapeId;
	templateId: string;
}> {
	return loadWorkflowMenuLibrary().map((menu) => ({
		taskCategory: menu.shape,
		templateId: menu.templateId,
	}));
}

export function workflowMenuTemplateId(shape: WorkflowMenuShapeId): string {
	const menu = loadWorkflowMenuLibrary().find(
		(candidate) => candidate.shape === shape,
	);
	if (!menu) {
		throw new WorkflowMenuValidationError(
			"MENU_NOT_FOUND",
			`workflow graph ${shape} is not registered`,
			loadWorkflowMenuLibrary().map((candidate) => candidate.shape),
		);
	}
	return menu.templateId;
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
	const menuByShape = new Map(
		loadWorkflowMenuLibrary().map((menu) => [menu.shape, menu]),
	);
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
					templateId: menuByShape.get(shape)!.templateId,
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
	const adoptionRaw = asRecord(
		parse(readFileSync(join(menuDirectory, "adoption.yaml"), "utf8")),
		"adoption",
	);
	const legalShapes = loadWorkflowMenuLibrary().map((menu) => menu.shape);
	const adoption: Record<string, WorkflowMenuShapeId[]> = {};
	for (const [leadId, value] of Object.entries(adoptionRaw)) {
		if (!Array.isArray(value) || value.length === 0) {
			throw new Error(`adoption.${leadId} must be a non-empty array`);
		}
		const menus = value.map((shape, index) =>
			oneOf(shape, legalShapes, `adoption.${leadId}[${index}]`),
		);
		if (new Set(menus).size !== menus.length) {
			throw new Error(`adoption.${leadId} contains duplicate menus`);
		}
		adoption[nonempty(leadId, "adoption lead id")] = menus;
	}
	return { adoption };
}

/** True when a project explicitly adopts Lead-scoped workflow menus. */
export function hasProjectMenuConfig(projectRoot: string): boolean {
	return existsSync(join(projectRoot, ".flywheel", "menus", "adoption.yaml"));
}

function projectNameFromConfig(projectRoot: string): string {
	const raw = asRecord(
		parse(readFileSync(join(projectRoot, ".flywheel", "config.yaml"), "utf8")),
		"project config",
	);
	return nonempty(raw.project, "project config.project");
}

function projectUsesAgentRegistry(projectRoot: string): boolean {
	return (
		projectNameFromConfig(projectRoot) === "flywheel" ||
		existsSync(join(projectRoot, ".flywheel", "agents", "registry.yaml"))
	);
}

function loadLegacyProjectRoster(projectRoot: string): Record<string, string> {
	const rosterPath = join(projectRoot, ".flywheel", "menus", "ic-roster.yaml");
	const rosterRaw = asRecord(
		parse(readFileSync(rosterPath, "utf8")),
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
	return roster;
}

function resolveLegacyNodeAgentFile(
	projectRoot: string,
	nodeName: string,
	roster = loadLegacyProjectRoster(projectRoot),
): string {
	const agentFile = roster[nodeName];
	if (!agentFile) {
		throw new WorkflowMenuValidationError(
			"NODE_NOT_REGISTERED",
			`node ${nodeName} has no project implementation`,
			Object.keys(roster),
		);
	}
	return agentFile;
}

export function resolveProjectAgentRegistry(
	projectRoot: string,
	registryPath?: string,
) {
	const bundled = loadBundledRegistry(registryPath ?? BUNDLED_REGISTRY_PATH);
	return resolveProjectRegistry({
		bundled,
		projectName: projectNameFromConfig(projectRoot),
		projectRoot,
	});
}

export function resolveLeadMenus(input: {
	projectRoot: string;
	leadId: string;
	registryPath?: string;
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
		...(input.registryPath ? { registryPath: input.registryPath } : {}),
	});
	const byShape = new Map(library.map((menu) => [menu.shape, menu]));
	const menus = adopted.map((shape) => byShape.get(shape)!);
	if (projectUsesAgentRegistry(input.projectRoot)) {
		const resolved = resolveProjectAgentRegistry(
			input.projectRoot,
			input.registryPath,
		);
		for (const menu of menus) {
			for (const node of menu.nodes) {
				if (node.type !== "gate" && !resolved.nodes[node.id]) {
					throw new WorkflowMenuValidationError(
						"NODE_NOT_REGISTERED",
						`menu ${menu.shape} node ${node.id} has no project implementation`,
						Object.keys(resolved.nodes),
					);
				}
			}
		}
	} else {
		const roster = loadLegacyProjectRoster(input.projectRoot);
		for (const menu of menus) {
			for (const node of menu.nodes) {
				if (node.type !== "gate") {
					resolveLegacyNodeAgentFile(input.projectRoot, node.id, roster);
				}
			}
		}
	}
	return menus;
}

export function resolveNodeAgentFile(
	projectRoot: string,
	nodeName: string,
): string {
	if (!projectUsesAgentRegistry(projectRoot)) {
		return resolveLegacyNodeAgentFile(projectRoot, nodeName);
	}
	const resolved = resolveProjectAgentRegistry(projectRoot);
	const node = resolved.nodes[nodeName];
	if (!node) {
		throw new WorkflowMenuValidationError(
			"NODE_NOT_REGISTERED",
			`node ${nodeName} has no project implementation`,
			Object.keys(resolved.nodes),
		);
	}
	return relative(projectRoot, node.agentFile);
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
