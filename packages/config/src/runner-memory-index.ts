import { createHash } from "node:crypto";
import fs from "node:fs";
import { isAbsolute, join } from "node:path";

/** Claude Code's documented auto-memory load limits. */
export const RUNNER_MEMORY_HARD_LIMIT = {
	lines: 200,
	bytes: 25_000,
} as const;

/** Flywheel's visible soft budget, leaving headroom before truncation. */
export const RUNNER_MEMORY_DEFAULT_BUDGET = {
	lines: 160,
	bytes: 20_000,
} as const;

export const RUNNER_MEMORY_SCAN_CEILING_BYTES = 65_536;
export const RUNNER_MEMORY_SNAPSHOT_ENV =
	"FLYWHEEL_RUNNER_MEMORY_SNAPSHOT" as const;

export type RunnerMemoryIndexStats = {
	lines: number;
	linesExact: boolean;
	bytes: number;
	firstRun: boolean;
	overBudget: boolean;
	overHard: boolean;
	firstDroppedLine: number | undefined;
};

export type RunnerMemorySnapshot = {
	lines: number;
	linesExact: boolean;
	bytes: number;
	sha16: string;
	topicFiles: number;
};

export type RunnerMemoryIndexMeasurement = {
	stats: Omit<RunnerMemoryIndexStats, "firstRun">;
	snapshot: RunnerMemorySnapshot;
};

export type RunnerMemoryCloseoutState =
	| "written"
	| "unchanged"
	| "over_budget"
	| "unmeasurable";

export type RunnerMemoryCloseoutMeasurement = RunnerMemorySnapshot & {
	overBudget: boolean;
	overHard: boolean;
	firstDroppedLine?: number;
};

export type RunnerMemoryCloseoutDelta = {
	indexChanged: boolean;
	lines: number;
	topicFiles: number;
};

type RunnerMemoryCloseoutBase = {
	v: 1;
	dir: string;
	measuredAt: string;
};

export type RunnerMemoryCloseoutReceipt = RunnerMemoryCloseoutBase &
	(
		| {
				state: "written" | "unchanged" | "over_budget";
				spawn?: RunnerMemorySnapshot;
				closeout: RunnerMemoryCloseoutMeasurement;
				delta?: RunnerMemoryCloseoutDelta;
		  }
		| {
				state: "unmeasurable";
				spawn?: RunnerMemorySnapshot;
				closeout?: RunnerMemoryCloseoutMeasurement;
				error: string;
		  }
	);

/** Measure exact file size and the line count visible in a bounded prefix. */
export function measureIndexPrefix(input: {
	prefix: Buffer;
	size: number;
}): Omit<RunnerMemoryIndexStats, "firstRun"> {
	const { prefix, size } = input;
	let lines = 0;
	for (const byte of prefix) {
		if (byte === 0x0a) lines += 1;
	}
	if (prefix.length > 0 && prefix[prefix.length - 1] !== 0x0a) lines += 1;

	const linesExact = prefix.length === size;
	const overBudget =
		lines > RUNNER_MEMORY_DEFAULT_BUDGET.lines ||
		size > RUNNER_MEMORY_DEFAULT_BUDGET.bytes;
	const overHard =
		lines > RUNNER_MEMORY_HARD_LIMIT.lines ||
		size > RUNNER_MEMORY_HARD_LIMIT.bytes;

	let firstDroppedLine: number | undefined;
	if (overHard) {
		let line = 1;
		let lineStart = 0;
		for (let index = 0; index < prefix.length; index += 1) {
			if (prefix[index] !== 0x0a) continue;
			const cumulativeBytes = index + 1;
			if (
				line > RUNNER_MEMORY_HARD_LIMIT.lines ||
				cumulativeBytes > RUNNER_MEMORY_HARD_LIMIT.bytes
			) {
				firstDroppedLine = line;
				break;
			}
			line += 1;
			lineStart = index + 1;
		}
		if (
			firstDroppedLine === undefined &&
			lineStart < prefix.length &&
			(line > RUNNER_MEMORY_HARD_LIMIT.lines ||
				prefix.length > RUNNER_MEMORY_HARD_LIMIT.bytes)
		) {
			firstDroppedLine = line;
		}
		// A concurrent truncate can make readSync stop before the fstat size.
		// The first unobserved line is still the earliest safe truncation marker.
		if (firstDroppedLine === undefined) firstDroppedLine = line;
	}

	return {
		lines,
		linesExact,
		bytes: size,
		overBudget,
		overHard,
		firstDroppedLine,
	};
}

/** Read at most the bounded prefix while retaining the exact on-disk size. */
export function readIndexPrefixBounded(indexPath: string): {
	prefix: Buffer;
	size: number;
} {
	const fd = fs.openSync(indexPath, "r");
	try {
		const size = fs.fstatSync(fd).size;
		const buffer = Buffer.alloc(
			Math.min(size, RUNNER_MEMORY_SCAN_CEILING_BYTES),
		);
		let filled = 0;
		while (filled < buffer.length) {
			const count = fs.readSync(
				fd,
				buffer,
				filled,
				buffer.length - filled,
				filled,
			);
			if (count === 0) break;
			filled += count;
		}
		return { prefix: buffer.subarray(0, filled), size };
	} finally {
		fs.closeSync(fd);
	}
}

/** Count bounded regular topic files; -1 makes an I/O failure explicit. */
export function countTopicFiles(dir: string): number {
	try {
		let count = 0;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (
				entry.name !== "MEMORY.md" &&
				entry.name.endsWith(".md") &&
				entry.isFile()
			) {
				count += 1;
				if (count >= 10_000) return 10_000;
			}
		}
		return count;
	} catch {
		return -1;
	}
}

/** Produce index stats and the spawn/closeout snapshot from one bounded read. */
export function measureRunnerMemoryIndex(
	dir: string,
): RunnerMemoryIndexMeasurement {
	const { prefix, size } = readIndexPrefixBounded(join(dir, "MEMORY.md"));
	const stats = measureIndexPrefix({ prefix, size });
	return {
		stats,
		snapshot: {
			lines: stats.lines,
			linesExact: stats.linesExact,
			bytes: stats.bytes,
			sha16: createHash("sha256").update(prefix).digest("hex").slice(0, 16),
			topicFiles: countTopicFiles(dir),
		},
	};
}

export function resolveRunnerMemoryCloseoutState(input: {
	spawn?: RunnerMemorySnapshot;
	closeout: RunnerMemoryCloseoutMeasurement;
}): { state: RunnerMemoryCloseoutState; error?: string } {
	if (input.closeout.overBudget || input.closeout.overHard) {
		return { state: "over_budget" };
	}
	if (!input.spawn) {
		return { state: "unmeasurable", error: "snapshot_missing" };
	}
	if (input.spawn.topicFiles === -1 || input.closeout.topicFiles === -1) {
		return { state: "unmeasurable", error: "topic_count_unavailable" };
	}
	if (
		input.spawn.sha16 !== input.closeout.sha16 ||
		input.spawn.topicFiles !== input.closeout.topicFiles
	) {
		return { state: "written" };
	}
	return { state: "unchanged" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return (
		actual.length === expected.length &&
		actual.every((key, index) => key === expected[index])
	);
}

function isIntegerAtLeast(value: unknown, minimum: number): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		Number.isFinite(value) &&
		value >= minimum
	);
}

function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function isSafeDir(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= 1_024 &&
		isAbsolute(value) &&
		!hasControlCharacter(value)
	);
}

function isCanonicalIso(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const date = new Date(value);
	return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

export function parseRunnerMemorySnapshot(
	value: unknown,
): RunnerMemorySnapshot | undefined {
	if (!isRecord(value)) return undefined;
	if (
		!hasExactKeys(value, [
			"lines",
			"linesExact",
			"bytes",
			"sha16",
			"topicFiles",
		]) ||
		!isIntegerAtLeast(value.lines, 0) ||
		typeof value.linesExact !== "boolean" ||
		!isIntegerAtLeast(value.bytes, 0) ||
		typeof value.sha16 !== "string" ||
		!/^[0-9a-f]{16}$/.test(value.sha16) ||
		!isIntegerAtLeast(value.topicFiles, -1)
	) {
		return undefined;
	}
	return {
		lines: value.lines,
		linesExact: value.linesExact,
		bytes: value.bytes,
		sha16: value.sha16,
		topicFiles: value.topicFiles,
	};
}

function parseCloseout(
	value: unknown,
): RunnerMemoryCloseoutMeasurement | undefined {
	if (!isRecord(value)) return undefined;
	const firstDroppedPresent = "firstDroppedLine" in value;
	if (
		!hasExactKeys(value, [
			"lines",
			"linesExact",
			"bytes",
			"sha16",
			"topicFiles",
			"overBudget",
			"overHard",
			...(firstDroppedPresent ? ["firstDroppedLine"] : []),
		]) ||
		typeof value.overBudget !== "boolean" ||
		typeof value.overHard !== "boolean" ||
		value.overHard !== firstDroppedPresent ||
		(value.overHard && !value.overBudget) ||
		(firstDroppedPresent && !isIntegerAtLeast(value.firstDroppedLine, 1))
	) {
		return undefined;
	}
	const parsedSnapshot = parseRunnerMemorySnapshot({
		lines: value.lines,
		linesExact: value.linesExact,
		bytes: value.bytes,
		sha16: value.sha16,
		topicFiles: value.topicFiles,
	});
	if (!parsedSnapshot) return undefined;
	return {
		...parsedSnapshot,
		overBudget: value.overBudget,
		overHard: value.overHard,
		...(firstDroppedPresent
			? { firstDroppedLine: value.firstDroppedLine as number }
			: {}),
	};
}

function parseDelta(value: unknown): RunnerMemoryCloseoutDelta | undefined {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["indexChanged", "lines", "topicFiles"]) ||
		typeof value.indexChanged !== "boolean" ||
		!Number.isInteger(value.lines) ||
		!Number.isInteger(value.topicFiles)
	) {
		return undefined;
	}
	return {
		indexChanged: value.indexChanged,
		lines: value.lines as number,
		topicFiles: value.topicFiles as number,
	};
}

function closeoutDeltaMatches(
	spawn: RunnerMemorySnapshot,
	closeout: RunnerMemoryCloseoutMeasurement,
	delta: RunnerMemoryCloseoutDelta,
): boolean {
	return (
		delta.indexChanged === (spawn.sha16 !== closeout.sha16) &&
		delta.lines === closeout.lines - spawn.lines &&
		delta.topicFiles === closeout.topicFiles - spawn.topicFiles
	);
}

/** Parse the untrusted runner receipt with closed shapes and state invariants. */
export function parseRunnerMemoryCloseoutReceipt(
	value: unknown,
): RunnerMemoryCloseoutReceipt | undefined {
	if (!isRecord(value)) return undefined;
	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch {
		return undefined;
	}
	if (Buffer.byteLength(serialized, "utf8") > 4_096) return undefined;

	const allowedTop = new Set([
		"v",
		"state",
		"dir",
		"measuredAt",
		"spawn",
		"closeout",
		"delta",
		"error",
	]);
	if (Object.keys(value).some((key) => !allowedTop.has(key))) return undefined;
	if (
		value.v !== 1 ||
		!isSafeDir(value.dir) ||
		!isCanonicalIso(value.measuredAt) ||
		typeof value.state !== "string" ||
		!new Set(["written", "unchanged", "over_budget", "unmeasurable"]).has(
			value.state,
		)
	) {
		return undefined;
	}

	const spawn =
		value.spawn === undefined
			? undefined
			: parseRunnerMemorySnapshot(value.spawn);
	if (value.spawn !== undefined && !spawn) return undefined;
	const closeout =
		value.closeout === undefined ? undefined : parseCloseout(value.closeout);
	if (value.closeout !== undefined && !closeout) return undefined;
	const delta = value.delta === undefined ? undefined : parseDelta(value.delta);
	if (value.delta !== undefined && !delta) return undefined;
	const error = value.error;
	if (
		error !== undefined &&
		(typeof error !== "string" ||
			error.length === 0 ||
			error.length > 200 ||
			hasControlCharacter(error))
	) {
		return undefined;
	}

	const state = value.state as RunnerMemoryCloseoutState;
	if (state !== "unmeasurable") {
		if (!closeout || error !== undefined) return undefined;
		if ((state === "over_budget") !== closeout.overBudget) return undefined;
		if (state === "written" || state === "unchanged") {
			if (
				!spawn ||
				closeout.overBudget ||
				spawn.topicFiles < 0 ||
				closeout.topicFiles < 0
			) {
				return undefined;
			}
		}
		const deltaRequired =
			spawn !== undefined && spawn.topicFiles >= 0 && closeout.topicFiles >= 0;
		if (deltaRequired !== (delta !== undefined)) return undefined;
		if (delta && spawn && !closeoutDeltaMatches(spawn, closeout, delta)) {
			return undefined;
		}
		if (
			state === "unchanged" &&
			(!delta ||
				delta.indexChanged ||
				delta.lines !== 0 ||
				delta.topicFiles !== 0)
		) {
			return undefined;
		}
		if (
			state === "written" &&
			(!delta || (!delta.indexChanged && delta.topicFiles === 0))
		) {
			return undefined;
		}
		return {
			v: 1,
			state,
			dir: value.dir,
			measuredAt: value.measuredAt,
			...(spawn ? { spawn } : {}),
			closeout,
			...(delta ? { delta } : {}),
		};
	}

	if (typeof error !== "string" || delta) return undefined;
	if (closeout) {
		if (closeout.overBudget) return undefined;
		if (!spawn && error !== "snapshot_missing") return undefined;
		if (
			spawn &&
			(error !== "topic_count_unavailable" ||
				(spawn.topicFiles >= 0 && closeout.topicFiles >= 0))
		) {
			return undefined;
		}
	} else if (
		error === "snapshot_missing" ||
		error === "topic_count_unavailable"
	) {
		return undefined;
	}
	return {
		v: 1,
		state: "unmeasurable",
		dir: value.dir,
		measuredAt: value.measuredAt,
		...(spawn ? { spawn } : {}),
		...(closeout ? { closeout } : {}),
		error,
	};
}

function formatSigned(value: number): string {
	return value >= 0 ? `+${value}` : String(value);
}

function displayLines(snapshotValue: RunnerMemorySnapshot): string {
	return `${snapshotValue.linesExact ? "" : ">="}${snapshotValue.lines}`;
}

export function formatRunnerMemoryCloseoutLine(
	prefix: string,
	receiptValue: RunnerMemoryCloseoutReceipt,
): string {
	if (receiptValue.state === "unmeasurable") {
		return `${prefix} runner-memory closeout state=unmeasurable dir=${receiptValue.dir} error=${receiptValue.error}`;
	}
	const index = `index=${displayLines(receiptValue.closeout)}L/${receiptValue.closeout.bytes}B`;
	if (receiptValue.state === "unchanged") {
		return `${prefix} runner-memory closeout state=unchanged dir=${receiptValue.dir} ${index} delta=+0L/+0files — nothing new was written this execution; if you learned a durable, reusable judgment, write it now (one topic file + one pointer line) before you park or exit.`;
	}
	const delta = receiptValue.delta
		? `${formatSigned(receiptValue.delta.lines)}L/${formatSigned(receiptValue.delta.topicFiles)}files`
		: "?L/?files";
	switch (receiptValue.state) {
		case "written":
			return `${prefix} runner-memory closeout state=written dir=${receiptValue.dir} ${index} delta=${delta} budget=160L/20000B hard=200L/25000B`;
		case "over_budget": {
			const dropped = receiptValue.closeout.overHard
				? String(receiptValue.closeout.firstDroppedLine)
				: "none";
			const truncation = receiptValue.closeout.overHard
				? ` (the next runner will NOT load entries from about line ${dropped} onward).`
				: ".";
			return `${prefix} runner-memory closeout state=over_budget dir=${receiptValue.dir} ${index} delta=${delta} first_dropped_line=${dropped} — MEMORY.md is over budget; consolidate topic files and replace or drop superseded pointers before you finish${truncation}`;
		}
		default:
			return assertNever(receiptValue.state);
	}
}

function assertNever(value: never): never {
	throw new Error(`unsupported runner-memory closeout state: ${String(value)}`);
}

export function sanitizeOneLine(text: string, max = 200): string {
	const safeMax = Number.isInteger(max) && max > 0 ? max : 200;
	let withoutControls = "";
	for (const character of String(text)) {
		const code = character.charCodeAt(0);
		withoutControls += code <= 0x1f || code === 0x7f ? " " : character;
	}
	const sanitized = withoutControls.replace(/\s+/g, " ").trim();
	return (sanitized || "unknown").slice(0, safeMax);
}
