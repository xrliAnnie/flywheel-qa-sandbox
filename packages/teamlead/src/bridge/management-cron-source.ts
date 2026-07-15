import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import {
	canonicalSubmissionDigest,
	getModelRegistryEntry,
	isModelSelectionSupported,
} from "flywheel-config";
import type { ProjectEntry } from "../ProjectConfig.js";
import {
	buildCronTargetId,
	buildTargetId,
	fileSourceRevision,
	type ManagementCronView,
	type ModelSelection,
	type WeeklySchedule,
} from "./management-console-contract.js";
import type { ManagementSnapshotProvider } from "./management-console-snapshot.js";

type FileStat = {
	isFile(): boolean;
	isSymbolicLink(): boolean;
};

export interface ManagementCronIo {
	readdir(path: string): string[];
	lstat(path: string): FileStat;
	realpath(path: string): string;
	readFile(path: string): Buffer;
	execFile(file: string, args: readonly string[]): string;
}

export interface TypedCronModelBinding {
	selection: ModelSelection | null;
	writable: boolean;
	reason?: string;
}

export interface ScanManagementCronsInput {
	launchAgentsDir: string;
	projects: readonly ProjectEntry[];
	uid?: number;
	modelBindings?: ReadonlyMap<string, TypedCronModelBinding>;
	deps?: Partial<ManagementCronIo>;
}

export interface NormalizedWeeklySchedule {
	schedule: WeeklySchedule | null;
	writable: boolean;
	warnings: string[];
	error?: string;
}

export interface ProjectRootCandidate {
	projectName: string;
	projectRoot: string;
}

export type ProjectRootMatch =
	| { projectName: string }
	| { projectName: null; ambiguous?: string[] };

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function integer(
	value: unknown,
	name: string,
	minimum: number,
	maximum: number,
): number {
	if (
		!Number.isInteger(value) ||
		Number(value) < minimum ||
		Number(value) > maximum
	) {
		throw new Error(`${name} range must be ${minimum}..${maximum}`);
	}
	return Number(value);
}

function scheduleLabel(days: readonly number[]): WeeklySchedule["label"] {
	const key = days.join(",");
	if (key === "1,2,3,4,5,6,7") return "每日";
	if (key === "1,2,3,4,5") return "工作日";
	if (key === "6,7") return "周末";
	return "自定义";
}

export function normalizeWeeklySchedule(
	value: unknown,
): NormalizedWeeklySchedule {
	const entries = Array.isArray(value) ? value : [value];
	const warnings: string[] = [];
	if (entries.length === 0) {
		return {
			schedule: null,
			writable: false,
			warnings,
			error: "StartCalendarInterval must not be empty",
		};
	}
	const pairs = new Set<string>();
	let advanced = false;
	try {
		for (const [index, raw] of entries.entries()) {
			const entry = record(raw);
			if (!entry) throw new Error(`calendar entry ${index} must be an object`);
			if (["Month", "Day", "Second"].some((key) => key in entry)) {
				advanced = true;
				continue;
			}
			if (!("Hour" in entry) || !("Minute" in entry)) {
				advanced = true;
				continue;
			}
			const hour = integer(entry.Hour, "Hour", 0, 23);
			const minute = integer(entry.Minute, "Minute", 0, 59);
			const weekdays =
				entry.Weekday === undefined
					? [1, 2, 3, 4, 5, 6, 7]
					: [integer(entry.Weekday, "Weekday", 0, 7)].map((day) =>
							day === 0 ? 7 : day,
						);
			for (const day of weekdays) {
				const pair = `${day}:${hour}:${minute}`;
				if (pairs.has(pair)) warnings.push(`重复日历项 ${pair}`);
				pairs.add(pair);
			}
		}
	} catch (error) {
		return {
			schedule: null,
			writable: false,
			warnings,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	if (advanced) {
		return {
			schedule: null,
			writable: false,
			warnings: [...warnings, "高级或不完整 launchd 日历保持只读"],
		};
	}
	const decoded = [...pairs].map((pair) => {
		const [day, hour, minute] = pair.split(":").map(Number);
		return { day: day!, hour: hour!, minute: minute! };
	});
	const days = [...new Set(decoded.map((pair) => pair.day))].sort(
		(a, b) => a - b,
	);
	const times = [
		...new Map(
			decoded.map((pair) => [
				`${pair.hour}:${pair.minute}`,
				{ hour: pair.hour, minute: pair.minute },
			]),
		).values(),
	].sort((a, b) => a.hour - b.hour || a.minute - b.minute);
	if (pairs.size !== days.length * times.length) {
		return {
			schedule: null,
			writable: false,
			warnings: [...warnings, "稀疏非笛卡尔日历保持只读"],
		};
	}
	return {
		schedule: { days, times, label: scheduleLabel(days) },
		writable: true,
		warnings,
	};
}

function containsPath(root: string, candidate: string): boolean {
	const rest = relative(root, candidate);
	return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
}

export function matchProjectRoot(
	candidates: readonly string[],
	projects: readonly ProjectRootCandidate[],
): ProjectRootMatch {
	const matches = projects.filter((project) =>
		candidates.some((candidate) =>
			containsPath(project.projectRoot, candidate),
		),
	);
	if (matches.length === 0) return { projectName: null };
	const longest = Math.max(
		...matches.map((project) => project.projectRoot.length),
	);
	const winners = matches.filter(
		(project) => project.projectRoot.length === longest,
	);
	if (winners.length > 1) {
		return {
			projectName: null,
			ambiguous: winners.map((project) => project.projectName).sort(),
		};
	}
	return { projectName: winners[0]!.projectName };
}

const DEFAULT_IO: ManagementCronIo = {
	readdir: (path) => readdirSync(path),
	lstat: (path) => lstatSync(path),
	realpath: (path) => realpathSync(path),
	readFile: (path) => readFileSync(path),
	execFile: (file, args) => execFileSync(file, [...args], { encoding: "utf8" }),
};

function readonlyCapability(reason: string) {
	return {
		writable: false,
		reason,
		consequence: "governance-readonly" as const,
		requiresAcknowledgement: true,
	};
}

function launchdCapability(writable: boolean, reason?: string) {
	return writable
		? {
				writable: true,
				consequence: "reload-launchd" as const,
				requiresAcknowledgement: true,
			}
		: readonlyCapability(reason ?? "cron source is not safely writable");
}

function errorCron(input: {
	path: string;
	label: string;
	revision: string;
	error: string;
}): ManagementCronView {
	return {
		id: buildTargetId("cron", [input.path, input.label]),
		label: input.label,
		projectName: null,
		sourceHint: basename(input.path),
		schedule: {
			targetId: buildCronTargetId(input.path, input.label, "schedule"),
			current: null,
			source: { kind: "launchd_plist", revision: input.revision },
			writeCapability: readonlyCapability(input.error),
		},
		enabled: {
			targetId: buildCronTargetId(input.path, input.label, "enabled"),
			current: true,
			source: { kind: "launchctl", revision: "launchctl:unknown" },
			writeCapability: readonlyCapability(input.error),
		},
		loaded: null,
		warnings: [],
		error: input.error,
	};
}

function disabledLabels(output: string): Set<string> {
	const labels = new Set<string>();
	for (const line of output.split("\n")) {
		const match = /"([^"]+)"\s*=>\s*true/.exec(line);
		if (match) labels.add(match[1]!);
	}
	return labels;
}

function directModelBinding(args: unknown): {
	selection: ModelSelection | null;
	reason?: string;
} {
	if (!Array.isArray(args)) {
		return { selection: null, reason: "未声明模型载体" };
	}
	const hits: string[] = [];
	for (let index = 0; index < args.length - 1; index++) {
		if (args[index] === "--model" && typeof args[index + 1] === "string") {
			hits.push(args[index + 1] as string);
		}
	}
	if (hits.length !== 1) {
		return { selection: null, reason: "未声明模型载体" };
	}
	const registered = getModelRegistryEntry(hits[0]!);
	if (
		!registered ||
		!isModelSelectionSupported({ surface: "cron", model: hits[0]! })
	) {
		return { selection: null, reason: "模型载体不受 registry 支持" };
	}
	return {
		selection: {
			provider: registered.provider,
			model: registered.id,
			effort: null,
		},
	};
}

function canonicalPaths(
	value: Record<string, unknown>,
	deps: ManagementCronIo,
	warnings: string[],
): string[] {
	const raw = [
		value.Program,
		...(Array.isArray(value.ProgramArguments) ? value.ProgramArguments : []),
	].filter(
		(candidate): candidate is string =>
			typeof candidate === "string" && isAbsolute(candidate),
	);
	const paths: string[] = [];
	for (const candidate of raw) {
		try {
			paths.push(deps.realpath(candidate));
		} catch {
			warnings.push(`无法解析程序路径 ${candidate}`);
		}
	}
	return paths;
}

export function scanManagementCrons(input: ScanManagementCronsInput): {
	projectCrons: Array<{ projectName: string; crons: ManagementCronView[] }>;
	unassignedCrons: ManagementCronView[];
	revision: string;
} {
	const deps: ManagementCronIo = { ...DEFAULT_IO, ...input.deps };
	const uid = input.uid ?? process.getuid?.() ?? 0;
	let disabled = new Set<string>();
	try {
		disabled = disabledLabels(
			deps.execFile("launchctl", ["print-disabled", `gui/${uid}`]),
		);
	} catch {
		// Runtime evidence is independent from declared plist schedule.
	}
	const canonicalProjects: ProjectRootCandidate[] = input.projects.map(
		(project) => {
			try {
				return {
					projectName: project.projectName,
					projectRoot: deps.realpath(project.projectRoot),
				};
			} catch {
				return {
					projectName: project.projectName,
					projectRoot: project.projectRoot,
				};
			}
		},
	);
	const byProject = new Map(
		input.projects.map((project) => [
			project.projectName,
			[] as ManagementCronView[],
		]),
	);
	const unassignedCrons: ManagementCronView[] = [];
	for (const name of deps
		.readdir(input.launchAgentsDir)
		.filter((entry) => entry.endsWith(".plist"))
		.sort((a, b) => a.localeCompare(b))) {
		const path = join(input.launchAgentsDir, name);
		let stat: FileStat;
		try {
			stat = deps.lstat(path);
		} catch (error) {
			unassignedCrons.push(
				errorCron({
					path,
					label: name.replace(/\.plist$/, ""),
					revision: "file:unreadable",
					error: error instanceof Error ? error.message : String(error),
				}),
			);
			continue;
		}
		if (stat.isSymbolicLink() || !stat.isFile()) {
			const reason = stat.isSymbolicLink()
				? "symlink plist is visible but not writable"
				: "non-regular plist is visible but not writable";
			unassignedCrons.push(
				errorCron({
					path,
					label: name.replace(/\.plist$/, ""),
					revision: "file:non-regular",
					error: reason,
				}),
			);
			continue;
		}
		let bytes: Buffer;
		let plist: Record<string, unknown>;
		try {
			bytes = deps.readFile(path);
			const parsed = record(
				JSON.parse(
					deps.execFile("plutil", ["-convert", "json", "-o", "-", path]),
				),
			);
			if (!parsed) throw new Error("plist root must be a dictionary");
			plist = parsed;
		} catch (error) {
			unassignedCrons.push(
				errorCron({
					path,
					label: name.replace(/\.plist$/, ""),
					revision: "file:parse-error",
					error: error instanceof Error ? error.message : String(error),
				}),
			);
			continue;
		}
		if (!("StartCalendarInterval" in plist)) continue;
		const warnings: string[] = [];
		let canonicalPath = path;
		try {
			canonicalPath = deps.realpath(path);
		} catch {
			warnings.push("无法解析 plist 真实路径");
		}
		const label =
			typeof plist.Label === "string" && plist.Label.trim()
				? plist.Label.trim()
				: name.replace(/\.plist$/, "");
		const normalized = normalizeWeeklySchedule(plist.StartCalendarInterval);
		warnings.push(...normalized.warnings);
		const ownership = matchProjectRoot(
			canonicalPaths(plist, deps, warnings),
			canonicalProjects,
		);
		const ambiguous =
			"ambiguous" in ownership ? ownership.ambiguous : undefined;
		const ownershipError = ambiguous
			? `project ownership ambiguous: ${ambiguous.join(", ")}`
			: ownership.projectName
				? undefined
				: "Unassigned/Unmanaged";
		const sourceRevision = fileSourceRevision(bytes);
		const safelyManaged = Boolean(ownership.projectName) && !ambiguous;
		let loaded: boolean | null = null;
		try {
			deps.execFile("launchctl", ["print", `gui/${uid}/${label}`]);
			loaded = true;
		} catch {
			loaded = false;
		}
		const typed = input.modelBindings?.get(canonicalPath);
		const direct = directModelBinding(plist.ProgramArguments);
		const modelBinding = typed ?? {
			selection: direct.selection,
			writable: direct.selection !== null,
			reason: direct.reason,
		};
		const cron: ManagementCronView = {
			id: buildTargetId("cron", [canonicalPath, label]),
			label,
			projectName: ownership.projectName,
			sourceHint: name,
			schedule: {
				targetId: buildCronTargetId(canonicalPath, label, "schedule"),
				current: normalized.schedule,
				source: {
					kind: "launchd_plist",
					revision: sourceRevision,
					hint: name,
				},
				writeCapability: launchdCapability(
					safelyManaged && normalized.writable,
					normalized.error ?? ownershipError ?? warnings[0],
				),
				error: normalized.error,
			},
			enabled: {
				targetId: buildCronTargetId(canonicalPath, label, "enabled"),
				current: !disabled.has(label),
				source: {
					kind: "launchctl",
					revision: `launchctl:${uid}:${disabled.has(label) ? "disabled" : "enabled"}`,
					hint: label,
				},
				writeCapability: launchdCapability(safelyManaged, ownershipError),
			},
			loaded,
			model: {
				targetId: buildCronTargetId(canonicalPath, label, "model"),
				current: modelBinding.selection,
				source: {
					kind: "launchd_plist",
					revision: sourceRevision,
					hint: name,
				},
				writeCapability: launchdCapability(
					safelyManaged && modelBinding.writable,
					modelBinding.reason ?? ownershipError,
				),
			},
			warnings,
			error: ownershipError,
		};
		if (ownership.projectName) byProject.get(ownership.projectName)?.push(cron);
		else unassignedCrons.push(cron);
	}
	const projectCrons = [...byProject.entries()].map(([projectName, crons]) => ({
		projectName,
		crons: crons.sort((a, b) => a.sourceHint.localeCompare(b.sourceHint)),
	}));
	unassignedCrons.sort((a, b) => a.sourceHint.localeCompare(b.sourceHint));
	return {
		projectCrons,
		unassignedCrons,
		revision: `launchd:${canonicalSubmissionDigest({ projectCrons, unassignedCrons })}`,
	};
}

export function createManagementCronProvider(
	input: Omit<ScanManagementCronsInput, "projects"> & {
		projects(): readonly ProjectEntry[];
	},
): ManagementSnapshotProvider {
	return {
		id: "launchd-crons",
		sourceKind: "launchd_plist",
		read: () => {
			const result = scanManagementCrons({
				...input,
				projects: input.projects(),
			});
			return {
				revision: result.revision,
				hint: input.launchAgentsDir,
				fragment: {
					projectCrons: result.projectCrons,
					unassignedCrons: result.unassignedCrons,
				},
			};
		},
	};
}
