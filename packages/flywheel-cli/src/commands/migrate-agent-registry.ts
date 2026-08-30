/** One-shot cutover from path-authored agents to registry-backed stable nodes. */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	loadBundledRegistry,
	loadProjectRegistryOverlay,
	type ProjectRegistryOverlayNode,
	resolveAgentConfigs,
	resolveProjectRegistry,
} from "flywheel-config";
import { parse, stringify } from "yaml";
import { resolveBundledRegistryPath } from "../lib/agent-registry-path.js";
import { resolveProjectPath } from "../lib/resolve-project.js";

const RECEIPT_RELATIVE_PATH =
	".flywheel/migrations/FLY-2121-agent-registry-receipt.json";

interface NodeMapEntry {
	node: string;
	label?: string;
	department?: string;
	departments?: string[];
}

interface MigrationReceipt {
	schemaVersion: 1;
	issue: "FLY-2121";
	project: string;
	createdAt: string;
	bundledRegistry: { path: string; sha256: string };
	projectRegistry: { path: string; sha256: string };
	config: { path: string; sha256: string };
	entries: Array<{ agent: string; node: string }>;
	preflight: { bundled: "passed"; project: "passed" };
}

export interface MigrateAgentRegistryOpts {
	projectPath?: string;
	bundledRegistryPath?: string;
	nodeMap?: string;
	force?: boolean;
}

export interface MigrateAgentRegistryResult {
	projectPath: string;
	moved: Array<{ agent: string; node: string; from: string; to: string }>;
	receiptPath: string;
}

function object(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${path} must be an object`);
	}
	return value as Record<string, unknown>;
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function inside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function loadNodeMap(path: string | undefined): Record<string, NodeMapEntry> {
	if (!path) return {};
	const raw = object(JSON.parse(readFileSync(path, "utf8")), "node map");
	const result: Record<string, NodeMapEntry> = {};
	for (const [agent, value] of Object.entries(raw)) {
		const entry = object(value, `node map.${agent}`);
		if (typeof entry.node !== "string" || !entry.node.trim()) {
			throw new Error(`node map.${agent}.node is required`);
		}
		result[agent] = entry as unknown as NodeMapEntry;
	}
	return result;
}

function gitDirty(projectPath: string, paths: string[]): string {
	return execFileSync("git", ["status", "--porcelain", "--", ...paths], {
		cwd: projectPath,
		encoding: "utf8",
	});
}

export function verifyMigrationReceipt(receiptPath: string): {
	valid: boolean;
	project?: string;
	reason?: string;
} {
	try {
		const receipt = JSON.parse(
			readFileSync(receiptPath, "utf8"),
		) as MigrationReceipt;
		if (receipt.schemaVersion !== 1 || receipt.issue !== "FLY-2121") {
			return { valid: false, reason: "unsupported receipt schema" };
		}
		for (const entry of [
			receipt.bundledRegistry,
			receipt.projectRegistry,
			receipt.config,
		]) {
			if (!existsSync(entry.path) || sha256(entry.path) !== entry.sha256) {
				return {
					valid: false,
					project: receipt.project,
					reason: `receipt hash mismatch: ${entry.path}`,
				};
			}
		}
		return { valid: true, project: receipt.project };
	} catch (error) {
		return {
			valid: false,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

export function migrateAgentRegistry(
	opts: MigrateAgentRegistryOpts,
): MigrateAgentRegistryResult {
	const projectPath = resolveProjectPath({ explicit: opts.projectPath });
	const configPath = join(projectPath, ".flywheel", "config.yaml");
	const registryPath = join(
		projectPath,
		".flywheel",
		"agents",
		"registry.yaml",
	);
	const receiptPath = join(projectPath, RECEIPT_RELATIVE_PATH);
	if (!existsSync(configPath)) {
		throw new Error(`Missing .flywheel/config.yaml at ${configPath}`);
	}
	const bundledPath = resolveBundledRegistryPath(opts.bundledRegistryPath);
	const bundled = loadBundledRegistry(bundledPath);
	const config = object(parse(readFileSync(configPath, "utf8")), "config");
	if (typeof config.project !== "string" || !config.project.trim()) {
		throw new Error("config.project must be a non-empty string");
	}
	const agents = object(config.agents, "config.agents");
	const alreadyMigrated = Object.values(agents).every((value) => {
		const source = object(value, "config agent");
		return typeof source.node === "string" && source.agent_file === undefined;
	});
	if (alreadyMigrated) {
		const resolved = resolveProjectRegistry({
			bundled,
			projectName: config.project,
			projectRoot: projectPath,
		});
		resolveAgentConfigs(
			agents as unknown as Parameters<typeof resolveAgentConfigs>[0],
			resolved,
		);
		const receipt = verifyMigrationReceipt(receiptPath);
		if (!receipt.valid) {
			throw new Error(`Migration receipt invalid: ${receipt.reason}`);
		}
		return { projectPath, moved: [], receiptPath };
	}

	const nodeMap = loadNodeMap(opts.nodeMap);
	const overlayNodes: Record<string, ProjectRegistryOverlayNode> = existsSync(
		registryPath,
	)
		? structuredClone(loadProjectRegistryOverlay(registryPath, bundled).nodes)
		: {};
	const updatedAgents: Record<string, unknown> = {};
	const moves: Array<{
		agent: string;
		node: string;
		from: string;
		to: string;
		sourcePath: string;
		destinationPath: string;
		content: Buffer;
	}> = [];
	const plannedDestinations = new Map<string, Buffer>();
	for (const [agent, value] of Object.entries(agents)) {
		const source = object(value, `config.agents.${agent}`);
		if (typeof source.agent_file !== "string" || !source.agent_file.trim()) {
			throw new Error(
				`config.agents.${agent}.agent_file is required for one-shot migration`,
			);
		}
		const mapping =
			nodeMap[agent] ?? (bundled.nodes[agent] ? { node: agent } : undefined);
		if (!mapping) {
			throw new Error(
				`Node map entry required for non-bundled agent ${agent}; pass --node-map`,
			);
		}
		const node = mapping.node.trim();
		if (!/^[a-z][a-z0-9_]*$/.test(node)) {
			throw new Error(`node map.${agent}.node must be a stable snake_case id`);
		}
		const sourcePath = resolve(projectPath, source.agent_file);
		if (!inside(projectPath, sourcePath) || !existsSync(sourcePath)) {
			throw new Error(
				`Agent source is missing or unsafe: ${source.agent_file}`,
			);
		}
		const to = `.flywheel/agents/nodes/${node}.md`;
		const destinationPath = join(projectPath, to);
		const content = readFileSync(sourcePath);
		const plannedContent = plannedDestinations.get(destinationPath);
		if (plannedContent && !plannedContent.equals(content)) {
			throw new Error(
				`Multiple legacy files map to node ${node} with different content`,
			);
		}
		plannedDestinations.set(destinationPath, content);
		if (
			existsSync(destinationPath) &&
			!readFileSync(destinationPath).equals(content) &&
			!opts.force
		) {
			throw new Error(`Destination exists and differs: ${destinationPath}`);
		}
		const implementation: ProjectRegistryOverlayNode = {
			file: `nodes/${node}.md`,
		};
		const departmentValue = mapping.department ?? source.department;
		if (
			departmentValue !== undefined &&
			(typeof departmentValue !== "string" || !departmentValue.trim())
		) {
			throw new Error(`config.agents.${agent}.department must be a string`);
		}
		const department = departmentValue as string | undefined;
		const departmentsValue = mapping.departments ?? source.departments;
		if (
			departmentsValue !== undefined &&
			(!Array.isArray(departmentsValue) ||
				departmentsValue.length === 0 ||
				!departmentsValue.every(
					(value) => typeof value === "string" && value.length > 0,
				))
		) {
			throw new Error(
				`config.agents.${agent}.departments must be a non-empty string array`,
			);
		}
		const departments = departmentsValue as string[] | undefined;
		if (bundled.nodes[node]) {
			if (department !== undefined) implementation.department = department;
			if (departments !== undefined) implementation.departments = departments;
		} else {
			if (!mapping.label?.trim()) {
				throw new Error(
					`node map.${agent}.label is required for project-local node`,
				);
			}
			if (department === undefined && departments === undefined) {
				throw new Error(
					`node map.${agent}.department or departments is required for project-local node`,
				);
			}
			implementation.label = mapping.label.trim();
			if (department !== undefined) implementation.department = department;
			if (departments !== undefined) implementation.departments = departments;
		}
		const prior = overlayNodes[node];
		if (prior && JSON.stringify(prior) !== JSON.stringify(implementation)) {
			throw new Error(
				`Project registry node ${node} already has another binding`,
			);
		}
		overlayNodes[node] = implementation;
		updatedAgents[agent] = {
			node,
			...(source.domain_file !== undefined
				? { domain_file: source.domain_file }
				: {}),
			match: source.match,
		};
		moves.push({
			agent,
			node,
			from: relative(projectPath, sourcePath),
			to,
			sourcePath,
			destinationPath,
			content,
		});
	}

	const updatedConfig = { ...config, agents: updatedAgents };
	const overlayYaml = stringify({ nodes: overlayNodes });
	const tempRoot = mkdtempSync(join(tmpdir(), "fly2121-overlay-"));
	try {
		const tempOverlay = join(tempRoot, "registry.yaml");
		writeFileSync(tempOverlay, overlayYaml);
		loadProjectRegistryOverlay(tempOverlay, bundled);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
	if (!opts.force) {
		const dirty = gitDirty(projectPath, [
			".flywheel/config.yaml",
			".flywheel/agents",
			...moves.map((move) => move.from),
		]);
		if (dirty.trim()) {
			throw new Error(
				`Refusing migration with uncommitted agent/config changes:\n${dirty}`,
			);
		}
	}

	const backups = new Map<string, Buffer | null>();
	const remember = (path: string) => {
		if (!backups.has(path)) {
			backups.set(path, existsSync(path) ? readFileSync(path) : null);
		}
	};
	try {
		const writtenDestinations = new Set<string>();
		for (const move of moves) {
			if (writtenDestinations.has(move.destinationPath)) continue;
			writtenDestinations.add(move.destinationPath);
			remember(move.destinationPath);
			mkdirSync(dirname(move.destinationPath), { recursive: true });
			writeFileSync(move.destinationPath, move.content);
		}
		remember(configPath);
		writeFileSync(configPath, stringify(updatedConfig));
		remember(registryPath);
		writeFileSync(registryPath, overlayYaml);

		const resolved = resolveProjectRegistry({
			bundled,
			projectName: config.project,
			projectRoot: projectPath,
		});
		resolveAgentConfigs(
			updatedAgents as Parameters<typeof resolveAgentConfigs>[0],
			resolved,
		);
		const removedSources = new Set<string>();
		for (const move of moves) {
			if (move.sourcePath !== move.destinationPath) {
				if (removedSources.has(move.sourcePath)) continue;
				removedSources.add(move.sourcePath);
				remember(move.sourcePath);
				unlinkSync(move.sourcePath);
			}
		}

		const receipt: MigrationReceipt = {
			schemaVersion: 1,
			issue: "FLY-2121",
			project: config.project,
			createdAt: new Date().toISOString(),
			bundledRegistry: { path: bundledPath, sha256: sha256(bundledPath) },
			projectRegistry: { path: registryPath, sha256: sha256(registryPath) },
			config: { path: configPath, sha256: sha256(configPath) },
			entries: moves.map(({ agent, node }) => ({ agent, node })),
			preflight: { bundled: "passed", project: "passed" },
		};
		remember(receiptPath);
		mkdirSync(dirname(receiptPath), { recursive: true });
		writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
		const verified = verifyMigrationReceipt(receiptPath);
		if (!verified.valid) {
			throw new Error(
				`Migration receipt verification failed: ${verified.reason}`,
			);
		}
	} catch (error) {
		for (const [path, original] of [...backups.entries()].reverse()) {
			if (original === null) rmSync(path, { force: true });
			else {
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, original);
			}
		}
		throw error;
	}

	return {
		projectPath,
		moved: moves.map(({ agent, node, from, to }) => ({
			agent,
			node,
			from,
			to,
		})),
		receiptPath,
	};
}

export function runMigrateAgentRegistry(
	opts: MigrateAgentRegistryOpts,
): number {
	const result = migrateAgentRegistry(opts);
	console.log(
		[
			`Flywheel migrate-agent-registry — ${result.projectPath}`,
			...result.moved.map(
				(move) => `  ${move.agent}: ${move.from} → ${move.to} (${move.node})`,
			),
			`  receipt: ${result.receiptPath}`,
		].join("\n"),
	);
	return 0;
}
