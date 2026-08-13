import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type { PatrolConfig } from "./types.js";

export type { PatrolConfig } from "./types.js";

export const DEFAULT_PATROL_INTERVAL_MINUTES = 60;
export const MIN_PATROL_INTERVAL_MINUTES = 10;
export const MAX_PATROL_INTERVAL_MINUTES = 24 * 60;

export interface PatrolConfigSnapshot {
	readonly revision: string;
	readonly sourcePath: string;
	readonly config: Readonly<PatrolConfig>;
}

interface SnapshotCache {
	key: string;
	snapshot: PatrolConfigSnapshot;
}

let globalCache: SnapshotCache | undefined;
const projectCaches = new Map<string, SnapshotCache>();

function fileCacheKey(path: string): string {
	try {
		const stat = statSync(path);
		return [
			path,
			stat.dev.toString(),
			stat.ino.toString(),
			stat.mtimeMs.toString(),
			stat.size.toString(),
		].join(":");
	} catch (error) {
		return `${path}:unavailable:${(error as NodeJS.ErrnoException).code ?? "UNKNOWN"}`;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePatrolConfig(
	value: unknown,
	context: string,
	warnings: string[],
): Readonly<PatrolConfig> {
	if (value === undefined) return Object.freeze({});
	if (!isRecord(value)) {
		warnings.push(`${context} must be a mapping`);
		return Object.freeze({});
	}
	if (value.interval_minutes === undefined) return Object.freeze({});
	const raw = value.interval_minutes;
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
		warnings.push(
			`${context}.interval_minutes must be a positive finite number`,
		);
		return Object.freeze({});
	}
	const clamped = Math.min(
		MAX_PATROL_INTERVAL_MINUTES,
		Math.max(MIN_PATROL_INTERVAL_MINUTES, raw),
	);
	if (clamped !== raw) {
		warnings.push(
			`${context}.interval_minutes=${raw} clamped to ${clamped} ` +
				`(${MIN_PATROL_INTERVAL_MINUTES}..${MAX_PATROL_INTERVAL_MINUTES})`,
		);
	}
	return Object.freeze({ interval_minutes: clamped });
}

function makeSnapshot(
	path: string,
	revision: string,
	config: Readonly<PatrolConfig>,
	warnings: readonly string[],
): PatrolConfigSnapshot {
	if (warnings.length > 0) {
		console.warn(`[patrol_config] ${warnings.join("; ")}`);
	}
	return Object.freeze({ revision, sourcePath: path, config });
}

export function getGlobalPatrolConfigSnapshot(): PatrolConfigSnapshot {
	const override = process.env.FLYWHEEL_PATROL_CONFIG?.trim();
	const path = override || join(homedir(), ".flywheel", "patrol.json");
	const key = fileCacheKey(path);
	if (globalCache?.key === key) return globalCache.snapshot;
	const warnings: string[] = [];
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" || override) {
			warnings.push(
				`global patrol config ignored: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	const snapshot = makeSnapshot(
		path,
		key,
		normalizePatrolConfig(raw, "patrol", warnings),
		warnings,
	);
	globalCache = { key, snapshot };
	return snapshot;
}

/**
 * Hot-read one project's mainline config. Callers must pass ProjectEntry.projectRoot;
 * accepting only that explicit root keeps session worktrees out of this policy seam.
 */
export function getProjectPatrolConfigSnapshot(
	projectRoot: string,
): PatrolConfigSnapshot {
	const path = join(projectRoot, ".flywheel", "config.yaml");
	const key = fileCacheKey(path);
	const cached = projectCaches.get(path);
	if (cached?.key === key) return cached.snapshot;
	const warnings: string[] = [];
	let patrol: unknown;
	try {
		const document = parse(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(document))
			throw new Error("project config must be a mapping");
		patrol = document.patrol;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			warnings.push(
				`project patrol config ignored: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	const snapshot = makeSnapshot(
		path,
		key,
		normalizePatrolConfig(patrol, "patrol", warnings),
		warnings,
	);
	projectCaches.set(path, { key, snapshot });
	return snapshot;
}

export function effectivePatrolIntervalMs(
	project: Readonly<PatrolConfig> | undefined,
	global: Readonly<PatrolConfig> | undefined,
): number {
	const raw =
		project?.interval_minutes ??
		global?.interval_minutes ??
		DEFAULT_PATROL_INTERVAL_MINUTES;
	const safe =
		typeof raw === "number" && Number.isFinite(raw) && raw > 0
			? raw
			: DEFAULT_PATROL_INTERVAL_MINUTES;
	return (
		Math.min(
			MAX_PATROL_INTERVAL_MINUTES,
			Math.max(MIN_PATROL_INTERVAL_MINUTES, safe),
		) * 60_000
	);
}

export function resetPatrolConfigCachesForTests(): void {
	globalCache = undefined;
	projectCaches.clear();
}
