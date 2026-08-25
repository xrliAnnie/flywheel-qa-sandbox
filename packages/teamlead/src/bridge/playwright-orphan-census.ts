/**
 * FLY-1867 P2 — audit-only census for orphaned Playwright Chrome mains.
 *
 * This module receives one read-only three-pass process sample and can only
 * append measurement rows. Its periodic API returns a summary string, never a
 * reusable process list.
 */

import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import {
	type ChromeSweepSample,
	isChromeFamilyComm,
} from "./chrome-session-reaper.js";

export const PLAYWRIGHT_CENSUS_MIN_GRACE_MINUTES = 30;
export const PLAYWRIGHT_CENSUS_LEDGER = join(
	homedir(),
	".flywheel",
	"state",
	"fly1867",
	"orphan-census.jsonl",
);
export const PLAYWRIGHT_MCP_PROFILE_ROOT = join(
	homedir(),
	"Library",
	"Caches",
	"ms-playwright-mcp",
);

export interface PlaywrightOrphanCandidate {
	pid: number;
	lstart: string;
	profile_token: string;
	age_min: number;
}

export interface PlaywrightOrphanCensusLine {
	observed_at: string;
	status: "ok" | "unknown";
	effective_grace_min: number;
	mcp_cache_versions: string[];
	profile_roots_in_scope: string[];
	known_profile_roots_out_of_scope: string[];
	sensor_errors: string[];
	candidates: PlaywrightOrphanCandidate[];
}

export interface PlaywrightOrphanCensusInput {
	sample: ChromeSweepSample;
	orphanGraceMinutes: number;
	mode: "boot" | "periodic";
}

interface CensusInspectionDeps {
	now: () => Date;
	readMcpCacheVersions: () => Promise<string[]>;
	profileRoot: string;
}

export interface CreatePlaywrightOrphanCensusRecorderDeps {
	now?: () => Date;
	readMcpCacheVersions?: () => Promise<string[]>;
	appendLedger?: (line: PlaywrightOrphanCensusLine) => Promise<void>;
	profileRoot?: string;
}

export interface PlaywrightOrphanCensusRecorder {
	run(input: PlaywrightOrphanCensusInput): Promise<string>;
}

export interface FormatPlaywrightOrphanCensusOnceInput {
	sample: ChromeSweepSample;
	orphanGraceMinutes: number;
	now?: () => Date;
	readMcpCacheVersions?: () => Promise<string[]>;
	profileRoot?: string;
}

function sensorError(label: string, error: string): string {
	return `${label}:${error}`;
}

export function extractPlaywrightUserDataDir(
	command: string,
): string | undefined {
	const match = command.match(
		/(?:^|\s)--user-data-dir=(?:"([^"]+)"|'([^']+)'|(\S+))(?=\s|$)/,
	);
	return match?.[1] ?? match?.[2] ?? match?.[3];
}

export function exactPlaywrightMcpProfileToken(
	path: string,
	profileRoot: string,
): string | undefined {
	if (!isAbsolute(path)) return undefined;
	const root = resolve(profileRoot);
	const candidate = resolve(path);
	const child = relative(root, candidate);
	if (
		!child ||
		child.startsWith(`..${sep}`) ||
		child === ".." ||
		isAbsolute(child) ||
		dirname(candidate) !== root ||
		!/^mcp-[a-z0-9-]+-[a-f0-9]{7}$/.test(basename(candidate))
	) {
		return undefined;
	}
	return basename(candidate);
}

function effectiveGrace(rawMinutes: number): number {
	return Math.max(
		PLAYWRIGHT_CENSUS_MIN_GRACE_MINUTES,
		Number.isFinite(rawMinutes) && rawMinutes > 0
			? rawMinutes
			: PLAYWRIGHT_CENSUS_MIN_GRACE_MINUTES,
	);
}

async function inspectCensus(
	input: Omit<PlaywrightOrphanCensusInput, "mode">,
	deps: CensusInspectionDeps,
): Promise<PlaywrightOrphanCensusLine> {
	const errors: string[] = [];
	const graceMinutes = effectiveGrace(input.orphanGraceMinutes);
	const versions = await deps.readMcpCacheVersions().catch((error) => {
		errors.push(
			sensorError(
				"mcp_cache_versions",
				error instanceof Error ? error.message : String(error),
			),
		);
		return [];
	});
	if (versions.length === 0 && errors.length === 0) {
		errors.push(sensorError("mcp_cache_versions", "no cached versions found"));
	}

	const sensors = [
		["comm", input.sample.comm],
		["command", input.sample.command],
		["age", input.sample.age],
	] as const;
	for (const [name, sensor] of sensors) {
		if (sensor.status === "unknown") {
			errors.push(sensorError(name, sensor.error));
		}
	}

	if (
		input.sample.comm.status === "ok" &&
		input.sample.command.status === "ok" &&
		input.sample.age.status === "ok"
	) {
		const relevant = new Set<number>();
		for (const [pid, comm] of input.sample.comm.rows) {
			if (isChromeFamilyComm(comm)) relevant.add(pid);
		}
		for (const [pid, { command }] of input.sample.command.rows) {
			const userDataDir = extractPlaywrightUserDataDir(command);
			if (
				userDataDir &&
				exactPlaywrightMcpProfileToken(userDataDir, deps.profileRoot)
			) {
				relevant.add(pid);
			}
		}
		for (const pid of relevant) {
			const missing: string[] = [];
			if (!input.sample.comm.rows.has(pid)) missing.push("comm");
			if (!input.sample.command.rows.has(pid)) missing.push("command");
			if (!input.sample.age.rows.has(pid)) missing.push("age");
			if (missing.length > 0) {
				errors.push(`join:pid=${pid}:missing=${missing.join(",")}`);
			}
		}
	}

	const candidates: PlaywrightOrphanCandidate[] = [];
	if (
		errors.length === 0 &&
		input.sample.comm.status === "ok" &&
		input.sample.command.status === "ok" &&
		input.sample.age.status === "ok"
	) {
		for (const [pid, comm] of input.sample.comm.rows) {
			if (!isChromeFamilyComm(comm)) continue;
			const commandRow = input.sample.command.rows.get(pid);
			const ageRow = input.sample.age.rows.get(pid);
			if (!commandRow || !ageRow || commandRow.ppid !== 1) continue;
			if (/(?:^|\s)--type=/.test(commandRow.command)) continue;
			const userDataDir = extractPlaywrightUserDataDir(commandRow.command);
			const token = userDataDir
				? exactPlaywrightMcpProfileToken(userDataDir, deps.profileRoot)
				: undefined;
			if (!token) continue;
			const ageMinutes = Math.floor(ageRow.ageMs / 60_000);
			if (ageMinutes < graceMinutes) continue;
			candidates.push({
				pid,
				lstart: ageRow.lstart,
				profile_token: token,
				age_min: ageMinutes,
			});
		}
	}

	candidates.sort(
		(left, right) =>
			left.pid - right.pid || left.lstart.localeCompare(right.lstart),
	);
	return {
		observed_at: deps.now().toISOString(),
		status: errors.length === 0 ? "ok" : "unknown",
		effective_grace_min: graceMinutes,
		mcp_cache_versions: [...new Set(versions)].sort(),
		profile_roots_in_scope: [resolve(deps.profileRoot)],
		known_profile_roots_out_of_scope: [
			join(dirname(resolve(deps.profileRoot)), "ms-playwright", "daemon"),
			join(tmpdir(), "playwright_*_profile-*"),
		],
		sensor_errors: errors.sort(),
		candidates: errors.length === 0 ? candidates : [],
	};
}

function candidateFingerprint(line: PlaywrightOrphanCensusLine): string {
	return JSON.stringify({
		status: line.status,
		identities: line.candidates.map(({ pid, lstart }) => ({ pid, lstart })),
	});
}

async function defaultReadMcpCacheVersions(): Promise<string[]> {
	const roots = await readdir(join(homedir(), ".npm", "_npx"), {
		withFileTypes: true,
	});
	const versions: string[] = [];
	for (const root of roots) {
		if (!root.isDirectory()) continue;
		try {
			const raw = await readFile(
				join(
					homedir(),
					".npm",
					"_npx",
					root.name,
					"node_modules",
					"@playwright",
					"mcp",
					"package.json",
				),
				"utf8",
			);
			const version = (JSON.parse(raw) as { version?: unknown }).version;
			if (typeof version === "string" && version) versions.push(version);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return [...new Set(versions)].sort();
}

async function defaultAppendLedger(
	line: PlaywrightOrphanCensusLine,
): Promise<void> {
	await mkdir(dirname(PLAYWRIGHT_CENSUS_LEDGER), { recursive: true });
	await appendFile(
		PLAYWRIGHT_CENSUS_LEDGER,
		`${JSON.stringify(line)}\n`,
		"utf8",
	);
}

export function createPlaywrightOrphanCensusRecorder(
	deps: CreatePlaywrightOrphanCensusRecorderDeps = {},
): PlaywrightOrphanCensusRecorder {
	const inspectionDeps: CensusInspectionDeps = {
		now: deps.now ?? (() => new Date()),
		readMcpCacheVersions:
			deps.readMcpCacheVersions ?? defaultReadMcpCacheVersions,
		profileRoot: deps.profileRoot ?? PLAYWRIGHT_MCP_PROFILE_ROOT,
	};
	const appendLedger = deps.appendLedger ?? defaultAppendLedger;
	let previousFingerprint: string | undefined;
	let previousStatus: PlaywrightOrphanCensusLine["status"] | undefined;
	let previousDay: string | undefined;
	return {
		async run(input) {
			const line = await inspectCensus(input, inspectionDeps);
			const fingerprint = candidateFingerprint(line);
			const day = line.observed_at.slice(0, 10);
			const reason =
				input.mode === "boot" || previousFingerprint === undefined
					? "boot"
					: fingerprint !== previousFingerprint
						? line.status === previousStatus
							? "change"
							: "status"
						: day !== previousDay
							? "heartbeat"
							: undefined;
			if (reason) await appendLedger(line);
			previousFingerprint = fingerprint;
			previousStatus = line.status;
			previousDay = day;
			return `[playwright-orphan-census] status=${line.status} candidates=${line.candidates.length} recorded=${reason ?? "no"}`;
		},
	};
}

export async function formatPlaywrightOrphanCensusOnce(
	input: FormatPlaywrightOrphanCensusOnceInput,
): Promise<string> {
	const line = await inspectCensus(input, {
		now: input.now ?? (() => new Date()),
		readMcpCacheVersions:
			input.readMcpCacheVersions ?? defaultReadMcpCacheVersions,
		profileRoot: input.profileRoot ?? PLAYWRIGHT_MCP_PROFILE_ROOT,
	});
	return JSON.stringify(line);
}
