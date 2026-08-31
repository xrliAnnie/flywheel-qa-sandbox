import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import {
	basename,
	extname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { fileURLToPath, URL } from "node:url";
import { parse } from "yaml";
import { getModelRegistryEntry } from "./model-registry.js";
import type { WorkflowNodeTypeId } from "./node-type-registry.js";

export type RegistryWorkflowEffort =
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

const REGISTRY_NODE_TYPES = [
	"design",
	"implement",
	"qa",
	"generic",
] as const satisfies readonly WorkflowNodeTypeId[];
const REGISTRY_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const EDGE_CONDITIONS = [
	"design_done",
	"implement_done",
	"qa_pass",
	"node_done",
	"founder_approved",
] as const;
const LOOP_WHEN = ["qa_fail", "founder_feedback_kickback"] as const;
const EXIT_WHEN = ["qa_pass", "founder_approved"] as const;

export interface RegistryModelPolicy {
	model: string;
	allowedEfforts: RegistryWorkflowEffort[];
	defaultEffort: RegistryWorkflowEffort;
}

export interface RegistryNodePolicy {
	defaultModel: string;
	models: RegistryModelPolicy[];
}

export interface BundledRegistryNode {
	file: string;
	label: string;
	type?: (typeof REGISTRY_NODE_TYPES)[number];
	department?: string;
	departments?: string[];
}

export interface BundledRegistryStructuralNode {
	label: string;
}

export interface RegistryEdge {
	id: string;
	from: string;
	to: string;
	condition: (typeof EDGE_CONDITIONS)[number];
}

export interface RegistryLoop {
	id: string;
	from: string;
	to: string;
	loopWhen: (typeof LOOP_WHEN)[number];
	exitWhen: (typeof EXIT_WHEN)[number];
	maxIterations?: number;
	onLimit?: "escalate";
}

export interface BundledRegistryGraph {
	templateId: string;
	label: string;
	founderReview?: boolean;
	nodes: string[];
	policies: Record<string, RegistryNodePolicy>;
	edges: RegistryEdge[];
	loops: RegistryLoop[];
}

export interface BundledRegistry {
	sourcePath: string;
	nodes: Record<string, BundledRegistryNode>;
	structural: Record<string, BundledRegistryStructuralNode>;
	graphs: Record<string, BundledRegistryGraph>;
}

export interface ProjectRegistryOverlayNode {
	file: string;
	label?: string;
	department?: string;
	departments?: string[];
}

export interface ProjectRegistryOverlay {
	sourcePath: string;
	nodes: Record<string, ProjectRegistryOverlayNode>;
}

export interface ResolvedRegistryNode {
	name: string;
	label: string;
	type?: (typeof REGISTRY_NODE_TYPES)[number];
	agentFile: string;
	agentFileRoot: string;
	department?: string;
	departments: string[];
}

export interface ResolvedProjectRegistry {
	projectName: string;
	projectRoot: string;
	nodes: Record<string, ResolvedRegistryNode>;
	structural: BundledRegistry["structural"];
	graphs: BundledRegistry["graphs"];
}

/** Load the repository/payload registry without mirroring graph names in code. */
export function loadDefaultBundledRegistry(): BundledRegistry {
	const sourcePath = fileURLToPath(
		new URL("../../../.flywheel/agents/registry.yaml", import.meta.url),
	);
	return loadBundledRegistry(sourcePath);
}

/** Canonical task-category → template bindings projected from registry graphs. */
export function workflowRegistryBindings(
	registry: BundledRegistry = loadDefaultBundledRegistry(),
): Array<{ taskCategory: string; templateId: string }> {
	return Object.entries(registry.graphs).map(([taskCategory, graph]) => ({
		taskCategory,
		templateId: graph.templateId,
	}));
}

/** Canonical model/API task-category values projected from registry graphs. */
export function workflowRegistryShapes(
	registry: BundledRegistry = loadDefaultBundledRegistry(),
): string[] {
	return Object.keys(registry.graphs);
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
	if (unknown) throw new Error(`${path}.${unknown} is not allowed`);
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

function optionalDepartments(
	value: unknown,
	path: string,
): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`${path} must be a non-empty array`);
	}
	const departments = value.map((entry, index) =>
		nonempty(entry, `${path}[${index}]`),
	);
	if (new Set(departments).size !== departments.length) {
		throw new Error(`${path} contains duplicates`);
	}
	return departments;
}

function safeRelativeFile(value: unknown, path: string): string {
	const file = nonempty(value, path);
	if (
		isAbsolute(file) ||
		/^[A-Za-z]:[\\/]/.test(file) ||
		file.startsWith("\\\\") ||
		file.split(/[\\/]/).includes("..")
	) {
		throw new Error(`${path} must be a safe relative path`);
	}
	return file;
}

function parseModel(value: unknown, path: string): RegistryModelPolicy {
	const raw = record(value, path);
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
		throw new Error(`${path}.model must be a canonical workflow alias`);
	}
	if (!Array.isArray(raw.allowedEfforts) || raw.allowedEfforts.length === 0) {
		throw new Error(`${path}.allowedEfforts must be a non-empty array`);
	}
	const allowedEfforts = raw.allowedEfforts.map((effort, index) =>
		oneOf(effort, REGISTRY_EFFORTS, `${path}.allowedEfforts[${index}]`),
	);
	if (new Set(allowedEfforts).size !== allowedEfforts.length) {
		throw new Error(`${path}.allowedEfforts contains duplicates`);
	}
	const supported = registry.effortsBySurface.workflow ?? [];
	if (allowedEfforts.some((effort) => !supported.includes(effort))) {
		throw new Error(
			`${path}.allowedEfforts must be supported by ${model}: ${supported.join(", ")}`,
		);
	}
	const defaultEffort = oneOf(
		raw.defaultEffort,
		allowedEfforts,
		`${path}.defaultEffort`,
	);
	return { model, allowedEfforts, defaultEffort };
}

function parsePolicy(value: unknown, path: string): RegistryNodePolicy {
	const raw = record(value, path);
	exactKeys(raw, ["defaultModel", "models"], path);
	const defaultModel = nonempty(raw.defaultModel, `${path}.defaultModel`);
	if (!Array.isArray(raw.models) || raw.models.length === 0) {
		throw new Error(`${path}.models must be a non-empty array`);
	}
	const models = raw.models.map((model, index) =>
		parseModel(model, `${path}.models[${index}]`),
	);
	if (new Set(models.map((model) => model.model)).size !== models.length) {
		throw new Error(`${path}.models contains duplicate aliases`);
	}
	if (!models.some((model) => model.model === defaultModel)) {
		throw new Error(`${path}.defaultModel must identify one declared model`);
	}
	return { defaultModel, models };
}

function parseBundledNode(
	name: string,
	value: unknown,
	path: string,
): BundledRegistryNode {
	const raw = record(value, path);
	exactKeys(raw, ["file", "label", "type", "department", "departments"], path);
	const file = safeRelativeFile(raw.file, `${path}.file`);
	const filename = basename(file, extname(file));
	if (filename !== name) {
		throw new Error(
			`${path} name ${name} must match file basename ${filename}`,
		);
	}
	if (extname(file) !== ".md") {
		throw new Error(`${path}.file must identify a markdown file`);
	}
	const department =
		raw.department === undefined
			? undefined
			: nonempty(raw.department, `${path}.department`);
	const departments = optionalDepartments(
		raw.departments,
		`${path}.departments`,
	);
	return {
		file,
		label: nonempty(raw.label, `${path}.label`),
		...(raw.type === undefined
			? {}
			: { type: oneOf(raw.type, REGISTRY_NODE_TYPES, `${path}.type`) }),
		...(department ? { department } : {}),
		...(departments ? { departments } : {}),
	};
}

function parseEdge(
	value: unknown,
	path: string,
	graphNodes: ReadonlySet<string>,
): RegistryEdge {
	const raw = record(value, path);
	exactKeys(raw, ["id", "from", "to", "condition"], path);
	const from = nonempty(raw.from, `${path}.from`);
	const to = nonempty(raw.to, `${path}.to`);
	if (!graphNodes.has(from) || !graphNodes.has(to)) {
		throw new Error(`${path} references a node not in graph`);
	}
	return {
		id: nonempty(raw.id, `${path}.id`),
		from,
		to,
		condition: oneOf(raw.condition, EDGE_CONDITIONS, `${path}.condition`),
	};
}

function parseLoop(
	value: unknown,
	path: string,
	graphNodes: ReadonlySet<string>,
): RegistryLoop {
	const raw = record(value, path);
	exactKeys(
		raw,
		["id", "from", "to", "loopWhen", "exitWhen", "maxIterations", "onLimit"],
		path,
	);
	const from = nonempty(raw.from, `${path}.from`);
	const to = nonempty(raw.to, `${path}.to`);
	if (!graphNodes.has(from) || !graphNodes.has(to)) {
		throw new Error(`${path} references a node not in graph`);
	}
	const hasLimit = raw.maxIterations !== undefined;
	if (hasLimit !== (raw.onLimit !== undefined)) {
		throw new Error(`${path}.maxIterations and onLimit must appear together`);
	}
	const maxIterations = hasLimit ? Number(raw.maxIterations) : undefined;
	if (
		maxIterations !== undefined &&
		(!Number.isInteger(maxIterations) || maxIterations <= 0)
	) {
		throw new Error(`${path}.maxIterations must be a positive integer`);
	}
	return {
		id: nonempty(raw.id, `${path}.id`),
		from,
		to,
		loopWhen: oneOf(raw.loopWhen, LOOP_WHEN, `${path}.loopWhen`),
		exitWhen: oneOf(raw.exitWhen, EXIT_WHEN, `${path}.exitWhen`),
		...(maxIterations === undefined
			? {}
			: {
					maxIterations,
					onLimit: oneOf(raw.onLimit, ["escalate"] as const, `${path}.onLimit`),
				}),
	};
}

function assertGraphTopology(
	name: string,
	nodes: readonly string[],
	edges: readonly RegistryEdge[],
): void {
	const reachable = new Set<string>([nodes[0]!]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const edge of edges) {
			if (reachable.has(edge.from) && !reachable.has(edge.to)) {
				reachable.add(edge.to);
				changed = true;
			}
		}
	}
	const unreachable = nodes.filter((node) => !reachable.has(node));
	if (unreachable.length > 0) {
		throw new Error(
			`graph ${name} topology leaves nodes unreachable: ${unreachable.join(", ")}`,
		);
	}
}

function assertGraphSemantics(
	name: string,
	graphNodes: readonly string[],
	nodes: BundledRegistry["nodes"],
	structural: BundledRegistry["structural"],
	loops: readonly RegistryLoop[],
): void {
	const executable = graphNodes.filter((nodeName) => nodes[nodeName]);
	const founderGate = graphNodes.find(
		(nodeName) => structural[nodeName] && nodeName === "founder_gate",
	);
	const land = graphNodes.find(
		(nodeName) => structural[nodeName] && nodeName === "land",
	);
	if (!founderGate || !land) {
		throw new Error(
			`graph ${name} must contain registered founder_gate and land nodes`,
		);
	}

	if (name !== "code" && name !== "simple_code") {
		if (executable.length !== 1 || loops.length !== 0) {
			throw new Error(
				`graph ${name} single-session graph must have one executable node and no loops`,
			);
		}
		return;
	}

	const byType = (type: NonNullable<BundledRegistryNode["type"]>) =>
		executable.filter((nodeName) => nodes[nodeName]?.type === type);
	const implement = byType("implement");
	const qa = byType("qa");
	const expectedExecutable = name === "code" ? 3 : 2;
	const design = byType("design");
	const qaLoop = loops.find(
		(loop) =>
			loop.from === qa[0] &&
			loop.to === implement[0] &&
			loop.loopWhen === "qa_fail" &&
			loop.exitWhen === "qa_pass",
	);
	const founderLoop = loops.find(
		(loop) =>
			loop.from === founderGate &&
			loop.to === implement[0] &&
			loop.loopWhen === "founder_feedback_kickback" &&
			loop.exitWhen === "founder_approved",
	);
	const validTypes =
		executable.length === expectedExecutable &&
		implement.length === 1 &&
		qa.length === 1 &&
		(name === "code" ? design.length === 1 : design.length === 0);
	if (
		!validTypes ||
		loops.length !== 2 ||
		!qaLoop ||
		!founderLoop ||
		founderLoop.maxIterations !== undefined ||
		founderLoop.onLimit !== undefined
	) {
		const executableDescription =
			name === "code"
				? "design, implement, and QA executable nodes"
				: "implement and QA executable nodes";
		throw new Error(
			`graph ${name} must have ${executableDescription} plus a QA retry loop and an unbounded founder-rework loop`,
		);
	}
}

export function loadBundledRegistry(registryPath: string): BundledRegistry {
	const root = record(
		parse(readFileSync(registryPath, "utf8")),
		"bundled registry",
	);
	exactKeys(root, ["nodes", "structural", "graphs"], "bundled registry");
	const rawNodes = record(root.nodes, "bundled registry.nodes");
	const nodes: BundledRegistry["nodes"] = {};
	for (const [nameValue, value] of Object.entries(rawNodes)) {
		const name = nonempty(nameValue, "bundled registry node name");
		nodes[name] = parseBundledNode(
			name,
			value,
			`bundled registry.nodes.${name}`,
		);
	}

	const rawStructural = record(root.structural, "bundled registry.structural");
	const structural: BundledRegistry["structural"] = {};
	for (const [nameValue, value] of Object.entries(rawStructural)) {
		const name = nonempty(nameValue, "bundled registry structural name");
		const raw = record(value, `bundled registry.structural.${name}`);
		exactKeys(raw, ["label"], `bundled registry.structural.${name}`);
		structural[name] = {
			label: nonempty(raw.label, `bundled registry.structural.${name}.label`),
		};
	}

	const rawGraphs = record(root.graphs, "bundled registry.graphs");
	const namespaces = new Map<string, string>();
	for (const [namespace, names] of [
		["nodes", Object.keys(nodes)],
		["structural", Object.keys(structural)],
		["graphs", Object.keys(rawGraphs)],
	] as const) {
		for (const name of names) {
			const prior = namespaces.get(name);
			if (prior) {
				throw new Error(
					`${name} appears in multiple registry namespaces: ${prior}, ${namespace}`,
				);
			}
			namespaces.set(name, namespace);
		}
	}

	const graphs: BundledRegistry["graphs"] = {};
	const templateIds = new Set<string>();
	for (const [nameValue, value] of Object.entries(rawGraphs)) {
		const name = nonempty(nameValue, "bundled registry graph name");
		const path = `bundled registry.graphs.${name}`;
		const raw = record(value, path);
		exactKeys(
			raw,
			[
				"templateId",
				"label",
				"founderReview",
				"nodes",
				"policies",
				"edges",
				"loops",
			],
			path,
		);
		const templateId = nonempty(raw.templateId, `${path}.templateId`);
		if (templateIds.has(templateId)) {
			throw new Error(`${path}.templateId ${templateId} is duplicate`);
		}
		templateIds.add(templateId);
		if (!Array.isArray(raw.nodes) || raw.nodes.length < 2) {
			throw new Error(`${path}.nodes must be an array with at least two nodes`);
		}
		const graphNodes = raw.nodes.map((node, index) =>
			nonempty(node, `${path}.nodes[${index}]`),
		);
		if (new Set(graphNodes).size !== graphNodes.length) {
			throw new Error(`${path}.nodes contains duplicates`);
		}
		const graphNodeSet = new Set(graphNodes);
		for (const nodeName of graphNodes) {
			if (!nodes[nodeName] && !structural[nodeName]) {
				throw new Error(
					`${path}.nodes reference ${nodeName} is not registered`,
				);
			}
			if (nodes[nodeName] && !nodes[nodeName].type) {
				throw new Error(`${path}.nodes ${nodeName} must define a type`);
			}
		}
		const rawPolicies = record(raw.policies, `${path}.policies`);
		const policies: Record<string, RegistryNodePolicy> = {};
		for (const [nodeName, policy] of Object.entries(rawPolicies)) {
			if (!graphNodeSet.has(nodeName)) {
				throw new Error(`${path}.policies.${nodeName} is not in graph nodes`);
			}
			if (!nodes[nodeName]) {
				throw new Error(
					`${path}.policies.${nodeName} must target an executable node`,
				);
			}
			policies[nodeName] = parsePolicy(policy, `${path}.policies.${nodeName}`);
		}
		for (const nodeName of graphNodes.filter((candidate) => nodes[candidate])) {
			if (!policies[nodeName]) {
				throw new Error(`${path}.policies.${nodeName} is required`);
			}
		}
		if (!Array.isArray(raw.edges)) {
			throw new Error(`${path}.edges must be an array`);
		}
		const edges = raw.edges.map((edge, index) =>
			parseEdge(edge, `${path}.edges[${index}]`, graphNodeSet),
		);
		if (!Array.isArray(raw.loops)) {
			throw new Error(`${path}.loops must be an array`);
		}
		const loops = raw.loops.map((loop, index) =>
			parseLoop(loop, `${path}.loops[${index}]`, graphNodeSet),
		);
		assertGraphTopology(name, graphNodes, edges);
		assertGraphSemantics(name, graphNodes, nodes, structural, loops);
		if (
			raw.founderReview !== undefined &&
			typeof raw.founderReview !== "boolean"
		) {
			throw new Error(`${path}.founderReview must be boolean`);
		}
		graphs[name] = {
			templateId,
			label: nonempty(raw.label, `${path}.label`),
			...(raw.founderReview === undefined
				? {}
				: { founderReview: raw.founderReview }),
			nodes: graphNodes,
			policies,
			edges,
			loops,
		};
	}
	return { sourcePath: registryPath, nodes, structural, graphs };
}

export function loadProjectRegistryOverlay(
	registryPath: string,
	bundled: BundledRegistry,
): ProjectRegistryOverlay {
	const root = record(
		parse(readFileSync(registryPath, "utf8")),
		"project registry overlay",
	);
	for (const forbidden of ["graphs", "structural"]) {
		if (Object.hasOwn(root, forbidden)) {
			throw new Error(`project registry overlay.${forbidden} is not allowed`);
		}
	}
	exactKeys(root, ["nodes"], "project registry overlay");
	const rawNodes = record(root.nodes, "project registry overlay.nodes");
	const nodes: ProjectRegistryOverlay["nodes"] = {};
	for (const [nameValue, value] of Object.entries(rawNodes)) {
		const name = nonempty(nameValue, "project registry overlay node name");
		const path = `project registry overlay.nodes.${name}`;
		const raw = record(value, path);
		const bundledNode = bundled.nodes[name];
		if (bundledNode) {
			exactKeys(raw, ["file", "department", "departments"], path);
		} else {
			exactKeys(raw, ["file", "label", "department", "departments"], path);
		}
		const file = safeRelativeFile(raw.file, `${path}.file`);
		const filename = basename(file, extname(file));
		if (filename !== name) {
			throw new Error(
				`${path} name ${name} must match file basename ${filename}`,
			);
		}
		if (extname(file) !== ".md") {
			throw new Error(`${path}.file must identify a markdown file`);
		}
		const department =
			raw.department === undefined
				? undefined
				: nonempty(raw.department, `${path}.department`);
		const departments = optionalDepartments(
			raw.departments,
			`${path}.departments`,
		);
		const label =
			raw.label === undefined
				? undefined
				: nonempty(raw.label, `${path}.label`);
		if (!bundledNode) {
			if (!label) throw new Error(`${path}.label is required`);
			if (!department && !departments) {
				throw new Error(`${path}.department or departments is required`);
			}
		}
		nodes[name] = {
			file,
			...(label ? { label } : {}),
			...(department ? { department } : {}),
			...(departments ? { departments } : {}),
		};
	}
	return { sourcePath: registryPath, nodes };
}

function resolveAgentFile(
	root: string,
	configuredFile: string,
	name: string,
): string {
	const candidate = resolve(root, configuredFile);
	if (!existsSync(candidate) || !statSync(candidate).isFile()) {
		throw new Error(`NODE_NOT_REGISTERED: ${name} file does not exist`);
	}
	const canonicalRoot = realpathSync(root);
	const canonicalFile = realpathSync(candidate);
	const rel = relative(canonicalRoot, canonicalFile);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error(
			`NODE_NOT_REGISTERED: ${name} file escapes the project registry root`,
		);
	}
	return candidate;
}

export function resolveProjectRegistry(input: {
	bundled: BundledRegistry;
	projectName: string;
	projectRoot: string;
	overlayPath?: string;
}): ResolvedProjectRegistry {
	const agentFileRoot = join(input.projectRoot, ".flywheel", "agents");
	let implementations: ProjectRegistryOverlay["nodes"];
	if (input.projectName === "flywheel") {
		implementations = Object.fromEntries(
			Object.entries(input.bundled.nodes).map(([name, node]) => [
				name,
				{
					file: node.file,
					...(node.department ? { department: node.department } : {}),
					...(node.departments ? { departments: node.departments } : {}),
				},
			]),
		);
	} else {
		const overlayPath =
			input.overlayPath ?? join(agentFileRoot, "registry.yaml");
		implementations = loadProjectRegistryOverlay(
			overlayPath,
			input.bundled,
		).nodes;
	}

	const nodes: ResolvedProjectRegistry["nodes"] = {};
	for (const [name, implementation] of Object.entries(implementations)) {
		const semantic = input.bundled.nodes[name];
		const label = semantic?.label ?? implementation.label;
		if (!label)
			throw new Error(`NODE_NOT_REGISTERED: ${name} label is missing`);
		const departments = [
			...(implementation.department ? [implementation.department] : []),
			...(implementation.departments ?? []),
		].filter((department, index, all) => all.indexOf(department) === index);
		nodes[name] = {
			name,
			label,
			...(semantic?.type ? { type: semantic.type } : {}),
			agentFile: resolveAgentFile(agentFileRoot, implementation.file, name),
			agentFileRoot,
			...(implementation.department
				? { department: implementation.department }
				: {}),
			departments,
		};
	}
	return {
		projectName: input.projectName,
		projectRoot: input.projectRoot,
		nodes,
		structural: input.bundled.structural,
		graphs: input.bundled.graphs,
	};
}
