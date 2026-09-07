/**
 * FLY-709 — load each project's config into the feature-flag resolver's
 * per-project map from each project's CANONICAL root.
 *
 * ENOENT (no config file) → "no project config", so the flag reads as its
 * absent/default value (entry with an undefined config, no error). A MALFORMED
 * config surfaces as an `error` string in the map so the console shows it as
 * data instead of silently defaulting (Codex R3 note-2). One bad project must
 * not break Bridge startup.
 *
 * `ConfigSnapshotProvider` is the fleet topology/projects.json hot overlay — it
 * is NOT a config.yaml loader; that's why this uses ConfigLoader per project
 * (Codex R2-4).
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	agentConfigsRequireRegistry,
	ConfigLoader,
	type FlywheelConfig,
	type ResolvedAgentConfig,
	type ResolvedProjectRegistry,
	resolveAgentConfigs,
} from "flywheel-config";
import type { ProjectEntry } from "../ProjectConfig.js";
import {
	bundledWorkflowRegistryPath,
	loadLegacyProjectRoster,
	projectUsesAgentRegistry,
	resolveNodeAgentFile,
	resolveProjectAgentRegistry,
} from "../workflow-menu.js";
import {
	fileSourceRevision,
	registrySourceRevision,
} from "./management-console-contract.js";

export type ProjectConfigEntry = {
	config?: FlywheelConfig;
	resolvedAgents?: Readonly<Record<string, ResolvedAgentConfig>>;
	resolvedRegistry?: ResolvedProjectRegistry;
	handbookRegistryActive?: boolean;
	handbookRosterAvailable?: boolean;
	handbookRosterStatus?: "not_applicable" | "ready" | "absent" | "unreadable";
	handbookResolvedFiles?: Readonly<Record<string, string>>;
	handbookResolutionError?: string;
	revision: string;
	error?: string;
};

type ProjectHandbookState = Pick<
	ProjectConfigEntry,
	| "resolvedRegistry"
	| "handbookRegistryActive"
	| "handbookRosterAvailable"
	| "handbookRosterStatus"
	| "handbookResolvedFiles"
	| "handbookResolutionError"
>;

function projectHandbookState(
	project: ProjectEntry,
	registryPath: string,
): ProjectHandbookState {
	let registryActive: boolean;
	try {
		registryActive = projectUsesAgentRegistry(project.projectRoot);
	} catch (error) {
		return {
			handbookRegistryActive: existsSync(
				join(project.projectRoot, ".flywheel", "agents", "registry.yaml"),
			),
			handbookRosterAvailable: false,
			handbookRosterStatus: "unreadable",
			handbookResolvedFiles: {},
			handbookResolutionError:
				error instanceof Error ? error.message : String(error),
		};
	}
	if (registryActive) {
		try {
			const resolvedRegistry = resolveProjectAgentRegistry(
				project.projectRoot,
				registryPath,
			);
			return {
				resolvedRegistry,
				handbookRegistryActive: true,
				handbookRosterAvailable: false,
				handbookRosterStatus: "not_applicable",
				handbookResolvedFiles: Object.fromEntries(
					Object.entries(resolvedRegistry.nodes).map(([ref, node]) => [
						ref,
						realpathSync(node.agentFile),
					]),
				),
			};
		} catch (error) {
			return {
				handbookRegistryActive: true,
				handbookRosterAvailable: false,
				handbookRosterStatus: "not_applicable",
				handbookResolvedFiles: {},
				handbookResolutionError:
					error instanceof Error ? error.message : String(error),
			};
		}
	}

	const rosterPath = join(
		project.projectRoot,
		".flywheel",
		"menus",
		"ic-roster.yaml",
	);
	if (!existsSync(rosterPath)) {
		return {
			handbookRegistryActive: false,
			handbookRosterAvailable: false,
			handbookRosterStatus: "absent",
			handbookResolvedFiles: {},
		};
	}
	try {
		const roster = loadLegacyProjectRoster(project.projectRoot);
		return {
			handbookRegistryActive: false,
			handbookRosterAvailable: true,
			handbookRosterStatus: "ready",
			handbookResolvedFiles: Object.fromEntries(
				Object.keys(roster).map((ref) => [
					ref,
					realpathSync(
						resolve(
							project.projectRoot,
							resolveNodeAgentFile(project.projectRoot, ref),
						),
					),
				]),
			),
		};
	} catch (error) {
		return {
			handbookRegistryActive: false,
			handbookRosterAvailable: true,
			handbookRosterStatus: "unreadable",
			handbookResolvedFiles: {},
			handbookResolutionError:
				error instanceof Error ? error.message : String(error),
		};
	}
}

export async function loadFeatureFlagProjectConfigs(
	projects: ProjectEntry[],
	readFile: (p: string) => string = (p) => readFileSync(p, "utf-8"),
	registryPath: string = bundledWorkflowRegistryPath(),
): Promise<Map<string, ProjectConfigEntry>> {
	const map = new Map<string, ProjectConfigEntry>();
	for (const project of projects) {
		const configPath = join(project.projectRoot, ".flywheel", "config.yaml");
		let raw: string | undefined;
		try {
			const loader = new ConfigLoader(async (p) => {
				raw = readFile(p);
				return raw;
			});
			const cfg = await loader.load(configPath);
			const handbook = projectHandbookState(project, registryPath);
			let resolvedAgents:
				| Readonly<Record<string, ResolvedAgentConfig>>
				| undefined;
			let agentResolutionError: string | undefined;
			try {
				resolvedAgents = cfg.agents
					? resolveAgentConfigs(
							cfg.agents,
							agentConfigsRequireRegistry(cfg.agents)
								? (handbook.resolvedRegistry ??
										resolveProjectAgentRegistry(
											project.projectRoot,
											registryPath,
										))
								: undefined,
							project.projectRoot,
						)
					: undefined;
			} catch (error) {
				agentResolutionError =
					error instanceof Error ? error.message : String(error);
			}
			// ENOENT surfaces as ConfigLoader returning undefined / throwing below;
			// a loaded config (even empty) is stored as the config.
			map.set(project.projectName, {
				config: cfg ?? undefined,
				...(resolvedAgents ? { resolvedAgents } : {}),
				...handbook,
				revision: fileSourceRevision(Buffer.from(raw ?? "")),
				...(agentResolutionError ? { error: agentResolutionError } : {}),
			});
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT" && raw === undefined) {
				// No project config → absent/default semantics (not an error).
				map.set(project.projectName, {
					revision: registrySourceRevision("absent"),
				});
			} else {
				map.set(project.projectName, {
					revision: raw
						? fileSourceRevision(Buffer.from(raw))
						: registrySourceRevision("read-error"),
					error: `${(err as Error).message}`,
				});
			}
		}
	}
	return map;
}

/**
 * FLY-709 P4 (Codex R1 #6) — mtime-cached per-project configs.
 *
 * The runner-config CLI writes config.yaml directly, so the console must show
 * the new value on the NEXT `/api/fleet/snapshot` without a Bridge restart —
 * while unchanged files must not be re-parsed per request. `get()` stats each
 * project's config.yaml (cheap) and reloads only entries whose identity stamp
 * (mtimeMs:size:ino) changed. Presence transitions never serve stale data
 * (Codex R2 note): a file that appears is loaded, one that disappears reverts
 * to absent/default semantics, and an atomic temp+rename changes the inode →
 * stamp mismatch → reload. Projects that leave the roster are pruned.
 */
export class ProjectConfigCache {
	private readonly stamps = new Map<string, string>();
	private readonly entries = new Map<string, ProjectConfigEntry>();

	constructor(
		private readonly readFile: (p: string) => string = (p) =>
			readFileSync(p, "utf-8"),
		private readonly statFile: (p: string) => {
			mtimeMs: number;
			size: number;
			ino: number;
		} = (p) => statSync(p),
		private readonly registryPath: string = bundledWorkflowRegistryPath(),
	) {}

	private sourceStamp(projectRoot: string): string {
		return [
			join(projectRoot, ".flywheel", "config.yaml"),
			join(projectRoot, ".flywheel", "agents", "registry.yaml"),
			join(projectRoot, ".flywheel", "menus", "ic-roster.yaml"),
			this.registryPath,
		]
			.map((path) => {
				try {
					const st = this.statFile(path);
					return `${path}:${st.mtimeMs}:${st.size}:${st.ino}`;
				} catch {
					return `${path}:absent`;
				}
			})
			.join("|");
	}

	/** The last materialized map (for sync consumers between refreshes). */
	current(): Map<string, ProjectConfigEntry> {
		return this.entries;
	}

	async get(
		projects: ProjectEntry[],
	): Promise<Map<string, ProjectConfigEntry>> {
		const seen = new Set<string>();
		for (const project of projects) {
			seen.add(project.projectName);
			const stamp = this.sourceStamp(project.projectRoot);
			if (this.stamps.get(project.projectName) === stamp) continue;
			const loaded = await loadFeatureFlagProjectConfigs(
				[project],
				this.readFile,
				this.registryPath,
			);
			this.entries.set(
				project.projectName,
				loaded.get(project.projectName) ?? {
					revision: registrySourceRevision("read-error"),
				},
			);
			this.stamps.set(project.projectName, stamp);
		}
		for (const name of [...this.entries.keys()]) {
			if (!seen.has(name)) {
				this.entries.delete(name);
				this.stamps.delete(name);
			}
		}
		return this.entries;
	}
}
