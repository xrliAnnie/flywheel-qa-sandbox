import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	countTopicFiles,
	formatRunnerMemoryCloseoutLine,
	measureIndexPrefix,
	measureRunnerMemoryIndex,
	parseRunnerMemoryCloseoutReceipt,
	parseRunnerMemorySnapshot,
	RUNNER_MEMORY_DEFAULT_BUDGET,
	RUNNER_MEMORY_HARD_LIMIT,
	RUNNER_MEMORY_SCAN_CEILING_BYTES,
	type RunnerMemoryCloseoutReceipt,
	type RunnerMemoryIndexMeasurement,
	type RunnerMemorySnapshot,
	readIndexPrefixBounded,
	resolveRunnerMemoryCloseoutState,
	sanitizeOneLine,
} from "../runner-memory-index.js";

const roots: string[] = [];

function makeRoot(prefix = "fly2148-memory-index-"): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

function snapshot(
	overrides: Partial<RunnerMemorySnapshot> = {},
): RunnerMemorySnapshot {
	return {
		lines: 3,
		linesExact: true,
		bytes: 6,
		sha16: "0123456789abcdef",
		topicFiles: 0,
		...overrides,
	};
}

function measurement(input: {
	spawn?: RunnerMemorySnapshot;
	closeout?: Partial<RunnerMemoryIndexMeasurement["snapshot"]> &
		Partial<RunnerMemoryIndexMeasurement["stats"]>;
}): Parameters<typeof resolveRunnerMemoryCloseoutState>[0] {
	const closeout = {
		...snapshot(),
		overBudget: false,
		overHard: false,
		...input.closeout,
	};
	return { spawn: input.spawn, closeout };
}

function receipt(
	overrides: Partial<RunnerMemoryCloseoutReceipt> = {},
): RunnerMemoryCloseoutReceipt {
	const spawn = snapshot();
	return {
		v: 1,
		state: "unchanged",
		dir: "/tmp/fly2148-memory",
		measuredAt: "2026-09-04T00:00:00.000Z",
		spawn,
		closeout: { ...spawn, overBudget: false, overHard: false },
		delta: { indexChanged: false, lines: 0, topicFiles: 0 },
		...overrides,
	} as RunnerMemoryCloseoutReceipt;
}

afterEach(() => {
	vi.restoreAllMocks();
	while (roots.length > 0) {
		rmSync(roots.pop() as string, { recursive: true, force: true });
	}
});

describe("FLY-2148 runner-memory index measurement", () => {
	it("keeps the B0 limits unchanged and the soft budget strictly lower", () => {
		expect(RUNNER_MEMORY_DEFAULT_BUDGET).toEqual({
			lines: 160,
			bytes: 20_000,
		});
		expect(RUNNER_MEMORY_HARD_LIMIT).toEqual({
			lines: 200,
			bytes: 25_000,
		});
		expect(RUNNER_MEMORY_SCAN_CEILING_BYTES).toBe(65_536);
		expect(RUNNER_MEMORY_DEFAULT_BUDGET.lines).toBeLessThan(
			RUNNER_MEMORY_HARD_LIMIT.lines,
		);
		expect(RUNNER_MEMORY_DEFAULT_BUDGET.bytes).toBeLessThan(
			RUNNER_MEMORY_HARD_LIMIT.bytes,
		);
	});

	it.each([
		{ name: "empty", text: "", lines: 0, hard: false },
		{
			name: "three terminated lines",
			text: "a\nb\nc\n",
			lines: 3,
			hard: false,
		},
		{
			name: "218 lines",
			text: `${Array.from({ length: 218 }, (_, index) => `line-${index}`).join("\n")}\n`,
			lines: 218,
			hard: true,
		},
	])("measures $name exactly", ({ text, lines, hard }) => {
		const prefix = Buffer.from(text);
		const stats = measureIndexPrefix({ prefix, size: prefix.length });
		expect(stats.lines).toBe(lines);
		expect(stats.linesExact).toBe(true);
		expect(stats.bytes).toBe(prefix.length);
		expect(stats.overHard).toBe(hard);
		if (hard) expect(stats.firstDroppedLine).toBe(201);
	});

	it("finds the first byte-limited dropped line and marks a truncated scan inexact", () => {
		const text = `${Array.from({ length: 153 }, () => "x".repeat(210)).join("\n")}\n`;
		const prefix = Buffer.from(text);
		const stats = measureIndexPrefix({ prefix, size: prefix.length });
		expect(stats.lines).toBe(153);
		expect(stats.overHard).toBe(true);
		expect(stats.firstDroppedLine).toBeGreaterThan(1);
		expect(stats.firstDroppedLine).toBeLessThanOrEqual(153);

		const truncated = measureIndexPrefix({
			prefix: Buffer.alloc(RUNNER_MEMORY_SCAN_CEILING_BYTES, 0x61),
			size: RUNNER_MEMORY_SCAN_CEILING_BYTES + 1,
		});
		expect(truncated.linesExact).toBe(false);
	});

	it("keeps the first dropped line visible when the bounded read ends early", () => {
		const stats = measureIndexPrefix({
			prefix: Buffer.from("a\nb\n"),
			size: 30_000,
		});
		expect(stats).toMatchObject({
			lines: 2,
			linesExact: false,
			overBudget: true,
			overHard: true,
			firstDroppedLine: 3,
		});
	});

	it("bounds sparse-file reads and closes the descriptor exactly once", () => {
		const root = makeRoot();
		const path = join(root, "MEMORY.md");
		writeFileSync(path, `${"x\n".repeat(300)}${"x".repeat(8 * 1024 * 1024)}`);
		const read = vi.spyOn(fs, "readSync");
		const close = vi.spyOn(fs, "closeSync");
		const result = readIndexPrefixBounded(path);
		expect(result.size).toBeGreaterThan(8 * 1024 * 1024);
		expect(result.prefix).toHaveLength(RUNNER_MEMORY_SCAN_CEILING_BYTES);
		expect(
			read.mock.calls.reduce((sum, args) => sum + Number(args[3] ?? 0), 0),
		).toBeLessThanOrEqual(RUNNER_MEMORY_SCAN_CEILING_BYTES);
		expect(close).toHaveBeenCalledOnce();
	});

	it("supports short reads and still closes when fstat fails", () => {
		const root = makeRoot();
		const path = join(root, "MEMORY.md");
		writeFileSync(path, "x".repeat(1_000));
		const realRead = fs.readSync.bind(fs);
		const read = vi.spyOn(fs, "readSync");
		read
			.mockImplementationOnce((...args) =>
				realRead(
					args[0],
					args[1] as Buffer,
					args[2] as number,
					Math.min(args[3] as number, 100),
					args[4] as number,
				),
			)
			.mockReturnValueOnce(0);
		const result = readIndexPrefixBounded(path);
		expect(result.prefix).toHaveLength(100);
		expect(result.size).toBe(1_000);
		expect(read).toHaveBeenCalledTimes(2);

		vi.restoreAllMocks();
		const close = vi.spyOn(fs, "closeSync");
		vi.spyOn(fs, "fstatSync").mockImplementation(() => {
			throw new Error("fstat exploded");
		});
		expect(() => readIndexPrefixBounded(path)).toThrow("fstat exploded");
		expect(close).toHaveBeenCalledOnce();
	});

	it("counts only regular topic markdown files and saturates at 10,000", () => {
		const root = makeRoot();
		writeFileSync(join(root, "MEMORY.md"), "index\n");
		writeFileSync(join(root, "a.md"), "a");
		writeFileSync(join(root, "b.md"), "b");
		writeFileSync(join(root, "notes.txt"), "n");
		fs.mkdirSync(join(root, "sub"));
		writeFileSync(join(root, "sub", "c.md"), "c");
		expect(countTopicFiles(root)).toBe(2);
		expect(countTopicFiles(join(root, "missing"))).toBe(-1);

		const readdir = vi.spyOn(fs, "readdirSync").mockReturnValue(
			Array.from({ length: 10_001 }, (_, index) => ({
				name: `${index}.md`,
				isFile: () => true,
			})) as never,
		);
		expect(countTopicFiles(root)).toBe(10_000);
		expect(readdir).toHaveBeenCalledOnce();
	});

	it("derives stats and snapshot from one bounded index read", () => {
		const root = makeRoot();
		writeFileSync(join(root, "MEMORY.md"), "a\nb\nc\n");
		writeFileSync(join(root, "a.md"), "a");
		writeFileSync(join(root, "b.md"), "b");
		const open = vi.spyOn(fs, "openSync");
		const read = vi.spyOn(fs, "readSync");
		const close = vi.spyOn(fs, "closeSync");
		const readdir = vi.spyOn(fs, "readdirSync");
		const measured = measureRunnerMemoryIndex(root);
		expect(measured.snapshot).toMatchObject({
			lines: 3,
			linesExact: true,
			bytes: 6,
			sha16: expect.stringMatching(/^[0-9a-f]{16}$/),
			topicFiles: 2,
		});
		expect(measured.stats.lines).toBe(measured.snapshot.lines);
		expect(measured.stats.linesExact).toBe(measured.snapshot.linesExact);
		expect(measured.stats.bytes).toBe(measured.snapshot.bytes);
		expect(open).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
		expect(readdir).toHaveBeenCalledOnce();
		expect(
			read.mock.calls.reduce((sum, args) => sum + Number(args[3] ?? 0), 0),
		).toBeLessThanOrEqual(RUNNER_MEMORY_SCAN_CEILING_BYTES);

		const beforeHash = measured.snapshot.sha16;
		writeFileSync(join(root, "MEMORY.md"), "a\nb\nd\n");
		expect(measureRunnerMemoryIndex(root).snapshot.sha16).not.toBe(beforeHash);
	});

	it("fails loudly when MEMORY.md cannot be read", () => {
		const root = makeRoot();
		expect(() => measureRunnerMemoryIndex(root)).toThrow();
		fs.mkdirSync(join(root, "MEMORY.md"));
		expect(() => measureRunnerMemoryIndex(root)).toThrow();
	});
});

describe("FLY-2148 runner-memory closeout contract", () => {
	it.each([
		{
			name: "soft budget wins over a changed index",
			input: measurement({
				spawn: snapshot(),
				closeout: { lines: 170, sha16: "fedcba9876543210", overBudget: true },
			}),
			state: "over_budget",
			error: undefined,
		},
		{
			name: "missing snapshot under budget",
			input: measurement({}),
			state: "unmeasurable",
			error: "snapshot_missing",
		},
		{
			name: "missing snapshot over budget",
			input: measurement({ closeout: { lines: 170, overBudget: true } }),
			state: "over_budget",
			error: undefined,
		},
		{
			name: "unavailable spawn topic count",
			input: measurement({ spawn: snapshot({ topicFiles: -1 }) }),
			state: "unmeasurable",
			error: "topic_count_unavailable",
		},
		{
			name: "unchanged",
			input: measurement({ spawn: snapshot() }),
			state: "unchanged",
			error: undefined,
		},
		{
			name: "topic file added",
			input: measurement({ spawn: snapshot(), closeout: { topicFiles: 1 } }),
			state: "written",
			error: undefined,
		},
		{
			name: "index changed while topics shrink",
			input: measurement({
				spawn: snapshot({ topicFiles: 3 }),
				closeout: { sha16: "fedcba9876543210", topicFiles: 0 },
			}),
			state: "written",
			error: undefined,
		},
	] as const)("resolves $name", ({ input, state, error }) => {
		expect(resolveRunnerMemoryCloseoutState(input)).toEqual({ state, error });
	});

	it("parses valid snapshots and rejects open or malformed shapes", () => {
		expect(parseRunnerMemorySnapshot(snapshot())).toEqual(snapshot());
		for (const invalid of [
			{ ...snapshot(), extra: true },
			{ ...snapshot(), lines: -1 },
			{ ...snapshot(), bytes: 1.5 },
			{ ...snapshot(), topicFiles: -2 },
			{ ...snapshot(), sha16: "ABCDEF0123456789" },
			null,
			[],
		]) {
			expect(parseRunnerMemorySnapshot(invalid)).toBeUndefined();
		}
	});

	it.each([
		{
			name: "unchanged",
			value: receipt(),
		},
		{
			name: "written with negative deltas",
			value: receipt({
				state: "written",
				spawn: snapshot({ lines: 50, topicFiles: 3 }),
				closeout: {
					...snapshot({ lines: 30, sha16: "fedcba9876543210", topicFiles: 1 }),
					overBudget: false,
					overHard: false,
				},
				delta: { indexChanged: true, lines: -20, topicFiles: -2 },
			}),
		},
		{
			name: "soft over budget",
			value: receipt({
				state: "over_budget",
				closeout: {
					...snapshot({ lines: 170, bytes: 20_001 }),
					overBudget: true,
					overHard: false,
				},
				delta: { indexChanged: false, lines: 167, topicFiles: 0 },
			}),
		},
		{
			name: "filesystem unmeasurable",
			value: {
				v: 1,
				state: "unmeasurable",
				dir: "/tmp/fly2148-memory",
				measuredAt: "2026-09-04T00:00:00.000Z",
				error: "ENOENT",
			} as RunnerMemoryCloseoutReceipt,
		},
		{
			name: "snapshot missing",
			value: {
				v: 1,
				state: "unmeasurable",
				dir: "/tmp/fly2148-memory",
				measuredAt: "2026-09-04T00:00:00.000Z",
				closeout: {
					...snapshot(),
					overBudget: false,
					overHard: false,
				},
				error: "snapshot_missing",
			} as RunnerMemoryCloseoutReceipt,
		},
	] as const)("round-trips $name receipts", ({ value }) => {
		expect(
			parseRunnerMemoryCloseoutReceipt(JSON.parse(JSON.stringify(value))),
		).toEqual(value);
	});

	it.each([
		["wrong version", { ...receipt(), v: 2 }],
		["unknown state", { ...receipt(), state: "done" }],
		["non-string state", { ...receipt(), state: ["written"] }],
		["relative dir", { ...receipt(), dir: "relative/path" }],
		["control character in dir", { ...receipt(), dir: "/tmp/a\nb" }],
		["non-canonical timestamp", { ...receipt(), measuredAt: "2026-09-04" }],
		["extra top-level key", { ...receipt(), extra: true }],
		[
			"extra closeout key",
			{ ...receipt(), closeout: { ...receipt().closeout, extra: true } },
		],
		[
			"overHard without firstDroppedLine",
			{ ...receipt(), closeout: { ...receipt().closeout, overHard: true } },
		],
		[
			"unchanged with nonzero delta",
			{ ...receipt(), delta: { indexChanged: false, lines: 1, topicFiles: 0 } },
		],
		["written without a changed field", { ...receipt(), state: "written" }],
		[
			"over budget state without the flag",
			{ ...receipt(), state: "over_budget" },
		],
		[
			"budget flag on written state",
			{
				...receipt(),
				state: "written",
				closeout: { ...receipt().closeout, overBudget: true },
			},
		],
		[
			"delta inconsistent with snapshots",
			{ ...receipt(), delta: { indexChanged: true, lines: 0, topicFiles: 0 } },
		],
		[
			"delta with unavailable topic count",
			{
				...receipt(),
				spawn: snapshot({ topicFiles: -1 }),
				state: "unmeasurable",
				error: "topic_count_unavailable",
			},
		],
		[
			"unmeasurable without error",
			{
				v: 1,
				state: "unmeasurable",
				dir: "/tmp/x",
				measuredAt: "2026-09-04T00:00:00.000Z",
			},
		],
	] as const)("rejects %s", (_name, value) => {
		expect(parseRunnerMemoryCloseoutReceipt(value)).toBeUndefined();
	});

	it("rejects oversized receipts and unsafe errors", () => {
		expect(
			parseRunnerMemoryCloseoutReceipt({
				v: 1,
				state: "unmeasurable",
				dir: `/tmp/${"x".repeat(1_020)}`,
				measuredAt: "2026-09-04T00:00:00.000Z",
				error: "x",
			}),
		).toBeUndefined();
		expect(
			parseRunnerMemoryCloseoutReceipt({
				v: 1,
				state: "unmeasurable",
				dir: "/tmp/x",
				measuredAt: "2026-09-04T00:00:00.000Z",
				error: "x\ny",
			}),
		).toBeUndefined();
		expect(
			parseRunnerMemoryCloseoutReceipt({
				v: 1,
				state: "unmeasurable",
				dir: "/tmp/x",
				measuredAt: "2026-09-04T00:00:00.000Z",
				error: "x".repeat(201),
			}),
		).toBeUndefined();
	});

	it("formats all four visible states, including truncation and negative delta", () => {
		const written = receipt({
			state: "written",
			spawn: snapshot({ lines: 50, topicFiles: 3 }),
			closeout: {
				...snapshot({ lines: 30, sha16: "fedcba9876543210", topicFiles: 1 }),
				overBudget: false,
				overHard: false,
			},
			delta: { indexChanged: true, lines: -20, topicFiles: -2 },
		});
		expect(formatRunnerMemoryCloseoutLine("[complete]", written)).toMatch(
			/^\[complete\] runner-memory closeout state=written .* delta=-20L\/-2files budget=160L\/20000B hard=200L\/25000B$/,
		);
		expect(formatRunnerMemoryCloseoutLine("[complete]", receipt())).toContain(
			"nothing new was written this execution",
		);
		const hard = receipt({
			state: "over_budget",
			closeout: {
				...snapshot({ lines: 218, bytes: 30_000 }),
				overBudget: true,
				overHard: true,
				firstDroppedLine: 201,
			},
			delta: { indexChanged: false, lines: 215, topicFiles: 0 },
		});
		expect(formatRunnerMemoryCloseoutLine("[qa-result]", hard)).toContain(
			"the next runner will NOT load entries from about line 201 onward",
		);
		const unavailable = {
			v: 1,
			state: "unmeasurable",
			dir: "/tmp/x",
			measuredAt: "2026-09-04T00:00:00.000Z",
			error: "ENOENT",
		} as RunnerMemoryCloseoutReceipt;
		expect(formatRunnerMemoryCloseoutLine("[complete]", unavailable)).toBe(
			"[complete] runner-memory closeout state=unmeasurable dir=/tmp/x error=ENOENT",
		);
	});

	it("sanitizes one-line fields deterministically", () => {
		expect(sanitizeOneLine("a\nb\tc\u0007d", 200)).toBe("a b c d");
		expect(sanitizeOneLine("x".repeat(300), 200)).toHaveLength(200);
		expect(sanitizeOneLine("", 200)).toBe("unknown");
	});

	it("uses the spied default fs object instead of named node:fs imports", () => {
		const source = readFileSync(
			fileURLToPath(new URL("../runner-memory-index.ts", import.meta.url)),
			"utf8",
		);
		expect(source).toContain('import fs from "node:fs"');
		expect(source).not.toMatch(/import\s*\{[^}]+\}\s*from\s*["']node:fs["']/s);
	});
});
