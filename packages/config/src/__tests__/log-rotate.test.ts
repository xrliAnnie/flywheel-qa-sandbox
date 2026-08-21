import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	appendRotatedLogSync,
	DEFAULT_LOG_MAX_BYTES,
	DEFAULT_LOG_RETENTION,
	rotateLogIfNeeded,
} from "../log-rotate.js";

const roots: string[] = [];
function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "fly1887-log-rotate-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("rotated log helpers", () => {
	it("publishes the shared 10 MiB / three-generation defaults", () => {
		expect(DEFAULT_LOG_MAX_BYTES).toBe(10 * 1024 * 1024);
		expect(DEFAULT_LOG_RETENTION).toBe(3);
	});

	it("renames complete evidence before appending and retains three archives", () => {
		const log = join(tempRoot(), "audit.log");
		writeFileSync(log, "generation-1\n");
		appendRotatedLogSync(log, "generation-2\n", { maxBytes: 8, keep: 3 });
		expect(readFileSync(`${log}.1`, "utf8")).toBe("generation-1\n");
		expect(readFileSync(log, "utf8")).toBe("generation-2\n");

		for (let generation = 3; generation <= 5; generation += 1) {
			appendRotatedLogSync(log, `generation-${generation}\n`, {
				maxBytes: 8,
				keep: 3,
			});
		}
		expect(readFileSync(`${log}.1`, "utf8")).toBe("generation-4\n");
		expect(readFileSync(`${log}.2`, "utf8")).toBe("generation-3\n");
		expect(readFileSync(`${log}.3`, "utf8")).toBe("generation-2\n");
		expect(existsSync(`${log}.4`)).toBe(false);
	});

	it("skips rotation fail-open when another process owns the mkdir lock", () => {
		const log = join(tempRoot(), "audit.log");
		writeFileSync(log, "old-evidence\n");
		mkdirSync(`${log}.rotate.lock`);

		expect(rotateLogIfNeeded(log, { maxBytes: 1, keep: 3 })).toBe(false);
		appendRotatedLogSync(log, "new-evidence\n", { maxBytes: 1, keep: 3 });
		expect(readFileSync(log, "utf8")).toBe("old-evidence\nnew-evidence\n");
		expect(existsSync(`${log}.1`)).toBe(false);
	});

	it("recovers a stale crash-residue lock before rotating", () => {
		const log = join(tempRoot(), "audit.log");
		const lock = `${log}.rotate.lock`;
		writeFileSync(log, "stale-lock-evidence\n");
		mkdirSync(lock);
		const old = new Date(Date.now() - 10 * 60 * 1000);
		utimesSync(lock, old, old);

		expect(rotateLogIfNeeded(log, { maxBytes: 1, keep: 3 })).toBe(true);
		expect(readFileSync(`${log}.1`, "utf8")).toBe("stale-lock-evidence\n");
		expect(existsSync(lock)).toBe(false);
	});

	it("does not steal a replacement lock installed after stale inspection", async () => {
		const log = join(tempRoot(), "audit.log");
		const lock = `${log}.rotate.lock`;
		const observed = `${lock}.observed`;
		writeFileSync(log, "replacement-lock-evidence\n");
		mkdirSync(lock);
		const old = new Date(Date.now() - 10 * 60 * 1000);
		utimesSync(lock, old, old);
		const staleStats = lstatSync(lock);
		let injected = false;

		vi.resetModules();
		vi.doMock("node:fs", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:fs")>();
			return {
				...actual,
				lstatSync(path: Parameters<typeof actual.lstatSync>[0]) {
					if (path === lock && !injected) {
						injected = true;
						renameSync(lock, observed);
						mkdirSync(lock);
						return staleStats;
					}
					return actual.lstatSync(path);
				},
			};
		});
		try {
			const raced = await import("../log-rotate.js");
			expect(
				raced.rotateLogIfNeeded(log, {
					maxBytes: 1,
					keep: 3,
					lockStaleMs: 5 * 60 * 1000,
				}),
			).toBe(false);
			expect(readFileSync(log, "utf8")).toBe("replacement-lock-evidence\n");
			expect(existsSync(lock)).toBe(true);
		} finally {
			vi.doUnmock("node:fs");
			vi.resetModules();
		}
	});

	it("does not clobber a new owner while abandoning quarantined stale state", async () => {
		const log = join(tempRoot(), "audit.log");
		const lock = `${log}.rotate.lock`;
		writeFileSync(log, "new-owner-evidence\n");
		mkdirSync(lock);
		const old = new Date(Date.now() - 10 * 60 * 1000);
		utimesSync(lock, old, old);
		let replacementIdentity: {
			dev: number | bigint;
			ino: number | bigint;
		} | null = null;
		let injected = false;

		vi.resetModules();
		vi.doMock("node:fs", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:fs")>();
			return {
				...actual,
				lstatSync(path: Parameters<typeof actual.lstatSync>[0]) {
					if (
						typeof path === "string" &&
						path.startsWith(`${lock}.stale.`) &&
						!injected
					) {
						injected = true;
						mkdirSync(lock);
						const replacement = actual.lstatSync(lock);
						replacementIdentity = {
							dev: replacement.dev,
							ino: replacement.ino,
						};
					}
					return actual.lstatSync(path);
				},
			};
		});
		try {
			const raced = await import("../log-rotate.js");
			expect(
				raced.rotateLogIfNeeded(log, {
					maxBytes: 1,
					keep: 3,
					lockStaleMs: 5 * 60 * 1000,
				}),
			).toBe(false);
			const surviving = lstatSync(lock);
			expect({ dev: surviving.dev, ino: surviving.ino }).toEqual(
				replacementIdentity,
			);
			expect(readFileSync(log, "utf8")).toBe("new-owner-evidence\n");
		} finally {
			vi.doUnmock("node:fs");
			vi.resetModules();
		}
	});

	it("keeps append failures visible after a fail-open rotation attempt", () => {
		const root = tempRoot();
		const parentFile = join(root, "not-a-directory");
		writeFileSync(parentFile, "x");
		expect(() =>
			appendRotatedLogSync(join(parentFile, "audit.log"), "line\n"),
		).toThrow();
	});

	it("does not rotate a file below the configured cap", () => {
		const log = join(tempRoot(), "audit.log");
		appendFileSync(log, "short\n");
		expect(rotateLogIfNeeded(log, { maxBytes: 1024, keep: 3 })).toBe(false);
		expect(readFileSync(log, "utf8")).toBe("short\n");
	});
});
