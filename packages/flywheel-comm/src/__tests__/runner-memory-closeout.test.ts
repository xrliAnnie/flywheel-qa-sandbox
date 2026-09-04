import {
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	formatRunnerMemoryCloseoutLine,
	measureRunnerMemoryIndex,
} from "flywheel-config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectRunnerMemoryCloseout } from "../runner-memory-closeout.js";

const cleanups: string[] = [];
afterEach(() => {
	while (cleanups.length > 0) {
		rmSync(cleanups.pop() as string, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

function memoryDir(name = "memory"): string {
	const root = mkdtempSync(join(tmpdir(), "fly2148-closeout-"));
	cleanups.push(root);
	const dir = join(root, name);
	mkdirSync(dir);
	writeFileSync(join(dir, "MEMORY.md"), "# Memory\n\nIndex.\n");
	return dir;
}

function envFor(dir: string, snapshot: unknown): NodeJS.ProcessEnv {
	return {
		FLYWHEEL_RUNNER_MEMORY_DIR: dir,
		FLYWHEEL_RUNNER_MEMORY_SNAPSHOT: JSON.stringify(snapshot),
	};
}

describe("FLY-2148 runner-memory closeout collector", () => {
	it("returns unchanged with an exact delta when the index and topics did not move", () => {
		const dir = memoryDir();
		const spawn = measureRunnerMemoryIndex(dir).snapshot;
		const receipt = collectRunnerMemoryCloseout(envFor(dir, spawn), {
			prefix: "[complete]",
			now: () => new Date("2026-09-04T00:00:00.000Z"),
		});
		expect(receipt).toEqual({
			v: 1,
			state: "unchanged",
			dir,
			measuredAt: "2026-09-04T00:00:00.000Z",
			spawn,
			closeout: {
				...spawn,
				overBudget: false,
				overHard: false,
			},
			delta: { indexChanged: false, lines: 0, topicFiles: 0 },
		});
		expect(formatRunnerMemoryCloseoutLine("[complete]", receipt!)).toContain(
			"runner-memory closeout state=unchanged",
		);
	});

	it("returns written after a durable topic and pointer are added", () => {
		const dir = memoryDir();
		const spawn = measureRunnerMemoryIndex(dir).snapshot;
		writeFileSync(join(dir, "lesson.md"), "---\nname: lesson\n---\nFact.\n");
		writeFileSync(join(dir, "MEMORY.md"), "# Memory\n\nIndex.\n- lesson.md\n");
		const receipt = collectRunnerMemoryCloseout(envFor(dir, spawn), {
			prefix: "[qa-result]",
		});
		expect(receipt).toMatchObject({
			state: "written",
			dir,
			delta: { indexChanged: true, lines: 1, topicFiles: 1 },
		});
	});

	it("makes truncation visible as over_budget even without a usable spawn snapshot", () => {
		const dir = memoryDir();
		writeFileSync(
			join(dir, "MEMORY.md"),
			Array.from({ length: 218 }, (_, index) => `- pointer ${index}`).join(
				"\n",
			),
		);
		const receipt = collectRunnerMemoryCloseout(
			{
				FLYWHEEL_RUNNER_MEMORY_DIR: dir,
				FLYWHEEL_RUNNER_MEMORY_SNAPSHOT: "malformed",
			},
			{ prefix: "[complete]" },
		);
		expect(receipt).toMatchObject({
			state: "over_budget",
			closeout: {
				overBudget: true,
				overHard: true,
				firstDroppedLine: 201,
			},
		});
		expect(formatRunnerMemoryCloseoutLine("[complete]", receipt!)).toContain(
			"the next runner will NOT load entries from about line 201 onward",
		);
	});

	it.each(["relative", "  ", `/tmp/${"x".repeat(1_025)}`, "/tmp/bad\npath"])(
		"rejects invalid directory %j without throwing",
		(dir) => {
			const log = vi.fn();
			expect(
				collectRunnerMemoryCloseout(
					{ FLYWHEEL_RUNNER_MEMORY_DIR: dir },
					{ prefix: "[complete]", log },
				),
			).toBeUndefined();
			expect(log).toHaveBeenCalledWith(
				"[complete] runner-memory closeout skipped: invalid FLYWHEEL_RUNNER_MEMORY_DIR",
			);
		},
	);

	it("preserves a legal trailing space in the directory identity", () => {
		const original = memoryDir("dir");
		const renamed = `${original} `;
		renameSync(original, renamed);
		const receipt = collectRunnerMemoryCloseout(
			{ FLYWHEEL_RUNNER_MEMORY_DIR: renamed },
			{ prefix: "[complete]" },
		);
		expect(receipt?.dir).toBe(renamed);
		expect(receipt).toMatchObject({
			state: "unmeasurable",
			error: "snapshot_missing",
		});
	});

	it("is silent when no mounted role-memory directory exists", () => {
		const log = vi.fn();
		expect(
			collectRunnerMemoryCloseout({}, { prefix: "[complete]", log }),
		).toBeUndefined();
		expect(log).not.toHaveBeenCalled();
	});

	it("turns filesystem failures into a bounded one-line unmeasurable receipt", () => {
		const dir = memoryDir();
		rmSync(join(dir, "MEMORY.md"));
		const receipt = collectRunnerMemoryCloseout(
			{ FLYWHEEL_RUNNER_MEMORY_DIR: dir },
			{ prefix: "[complete]" },
		);
		expect(receipt).toMatchObject({ state: "unmeasurable", dir });
		expect(
			receipt && "error" in receipt ? receipt.error.length : 201,
		).toBeLessThanOrEqual(200);
		expect(receipt && "error" in receipt ? receipt.error : "\n").not.toMatch(
			/[\r\n]/,
		);
	});

	it("never lets a throwing clock or logger break completion", () => {
		const dir = memoryDir();
		const log = vi.fn(() => {
			throw new Error("logger failed");
		});
		expect(() =>
			collectRunnerMemoryCloseout(
				{ FLYWHEEL_RUNNER_MEMORY_DIR: dir },
				{
					prefix: "[complete]",
					now: () => {
						throw new Error("clock failed");
					},
					log,
				},
			),
		).not.toThrow();
	});
});
