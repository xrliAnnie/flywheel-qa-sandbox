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

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ConfigLoader, type FlywheelConfig } from "flywheel-config";
import type { ProjectEntry } from "../ProjectConfig.js";
import {
	fileSourceRevision,
	registrySourceRevision,
} from "./management-console-contract.js";

export type ProjectConfigEntry = {
	config?: FlywheelConfig;
	revision: string;
	error?: string;
};

export async function loadFeatureFlagProjectConfigs(
	projects: ProjectEntry[],
	readFile: (p: string) => string = (p) => readFileSync(p, "utf-8"),
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
			// ENOENT surfaces as ConfigLoader returning undefined / throwing below;
			// a loaded config (even empty) is stored as the config.
			map.set(project.projectName, {
				config: cfg ?? undefined,
				revision: fileSourceRevision(Buffer.from(raw ?? "")),
			});
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
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
	) {}

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
			const configPath = join(project.projectRoot, ".flywheel", "config.yaml");
			let stamp = "absent";
			try {
				const st = this.statFile(configPath);
				stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
			} catch {
				// ENOENT (or stat failure) = absent semantics.
			}
			if (this.stamps.get(project.projectName) === stamp) continue;
			const loaded = await loadFeatureFlagProjectConfigs(
				[project],
				this.readFile,
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
