import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
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
	it("expires archives without rotating a young active file, and honors a live lock", () => {
		const log = join(tempRoot(), "audit.log");
		writeFileSync(log, "current\n");
		const nowMs = Date.now();
		const options = {
			maxBytes: 10_000,
			keep: 3,
			maxAgeMs: 1000,
			nowMs,
			strict: true,
		};
		writeFileSync(`${log}.1`, "expired\n");
		utimesSync(`${log}.1`, new Date(nowMs - 1000), new Date(nowMs - 1000));
		mkdirSync(`${log}.rotate.lock`);
		appendRotatedLogSync(log, "with-lock\n", options);
		expect(existsSync(`${log}.1`)).toBe(true);
		rmSync(`${log}.rotate.lock`, { recursive: true });
		appendRotatedLogSync(log, "after-lock\n", options);
		expect(existsSync(`${log}.1`)).toBe(false);
		expect(readFileSync(log, "utf8")).toBe("current\nwith-lock\nafter-lock\n");
	});

	it("cleans stale archives on restart with a missing active file without following archive symlinks", () => {
		const log = join(tempRoot(), "audit.log");
		const target = `${log}.target`;
		writeFileSync(target, "private\n");
		writeFileSync(`${log}.1`, "expired\n");
		const old = new Date(Date.now() - 10_000);
		utimesSync(`${log}.1`, old, old);
		symlinkSync(target, `${log}.2`);
		appendRotatedLogSync(log, "restarted\n", { maxAgeMs: 1000, strict: true });
		expect(existsSync(`${log}.1`)).toBe(false);
		expect(lstatSync(`${log}.2`).isSymbolicLink()).toBe(true);
		expect(readFileSync(target, "utf8")).toBe("private\n");
		expect(readFileSync(log, "utf8")).toBe("restarted\n");
	});

	it.each([{ maxAgeMs: 0 }, { maxFileAgeMs: -1 }, { nowMs: Number.NaN }])(
		"rejects invalid age options before strict append: %j",
		(options) => {
			const log = join(tempRoot(), "audit.log");
			expect(() =>
				appendRotatedLogSync(log, "invalid\n", { ...options, strict: true }),
			).toThrow("invalid_log_rotation_options");
			expect(existsSync(log)).toBe(false);
		},
	);

	it("rotates an aged active file and prunes expired archives under the retention lock", () => {
		const log = join(tempRoot(), "lifecycle.jsonl");
		writeFileSync(log, "retained-event\n");
		const createdAt = lstatSync(log).birthtimeMs;
		writeFileSync(`${log}.1`, "expired-event\n");
		utimesSync(
			`${log}.1`,
			new Date(createdAt - 8 * 86_400_000),
			new Date(createdAt - 8 * 86_400_000),
		);
		appendRotatedLogSync(log, "new-event\n", {
			maxBytes: 2_000_000,
			keep: 7,
			maxFileAgeMs: 86_400_000,
			maxAgeMs: 7 * 86_400_000,
			nowMs: createdAt + 86_400_000,
			strict: true,
		});
		expect(readFileSync(log, "utf8")).toBe("new-event\n");
		expect(readFileSync(`${log}.1`, "utf8")).toBe("retained-event\n");
		expect(existsSync(`${log}.2`)).toBe(false);
	});

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

	it("recovers a stale regular-file lock before rotating", () => {
		const log = join(tempRoot(), "audit.log");
		const lock = `${log}.rotate.lock`;
		writeFileSync(log, "stale-file-lock-evidence\n");
		writeFileSync(lock, "crash residue\n");
		const old = new Date(Date.now() - 10 * 60 * 1000);
		utimesSync(lock, old, old);

		expect(rotateLogIfNeeded(log, { maxBytes: 1, keep: 3 })).toBe(true);
		expect(readFileSync(`${log}.1`, "utf8")).toBe("stale-file-lock-evidence\n");
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

	it("strict append refuses a symlinked active path without touching its target", () => {
		const root = tempRoot();
		const target = join(root, "outside-target");
		const log = join(root, "bridge.log");
		writeFileSync(target, "must-survive\n");
		symlinkSync(target, log);

		expect(() =>
			appendRotatedLogSync(log, "forbidden\n", {
				maxBytes: 1,
				keep: 3,
				strict: true,
			}),
		).toThrow(/active_log_unsafe/);
		expect(readFileSync(target, "utf8")).toBe("must-survive\n");
	});

	it("strict append quarantines an unsafe generation and continues rotation", () => {
		const root = tempRoot();
		const target = join(root, "generation-target");
		const log = join(root, "bridge.log");
		writeFileSync(target, "generation-must-survive\n");
		writeFileSync(log, "active-must-survive\n");
		symlinkSync(target, `${log}.1`);

		expect(
			appendRotatedLogSync(log, "continued\n", {
				maxBytes: 1,
				keep: 3,
				strict: true,
			}),
		).toMatchObject({ rotated: true, rotationStalled: false });
		expect(readFileSync(`${log}.1`, "utf8")).toBe("active-must-survive\n");
		expect(readFileSync(log, "utf8")).toBe("continued\n");
		expect(readFileSync(target, "utf8")).toBe("generation-must-survive\n");
		const quarantined = readdirSync(root).filter((name) =>
			name.startsWith(`bridge.log.1.corrupt.${process.pid}.`),
		);
		expect(quarantined).toHaveLength(1);
		expect(
			lstatSync(join(root, quarantined[0] ?? "missing")).isSymbolicLink(),
		).toBe(true);
	});

	it("strict append tolerates contention and reports a persistent 2x stall fail-open", () => {
		const root = tempRoot();
		const log = join(root, "bridge.log");
		const lock = `${log}.rotate.lock`;
		writeFileSync(log, "1234");
		mkdirSync(lock);

		const transient = appendRotatedLogSync(log, "5", {
			maxBytes: 3,
			keep: 3,
			strict: true,
		});
		expect(transient).toMatchObject({
			rotationDue: true,
			rotated: false,
			sizeBefore: 4,
		});
		expect(readFileSync(log, "utf8")).toBe("12345");

		appendFileSync(log, "6");
		expect(
			appendRotatedLogSync(log, "7", {
				maxBytes: 3,
				keep: 3,
				strict: true,
			}),
		).toMatchObject({
			rotationDue: true,
			rotated: false,
			rotationStalled: true,
		});
		expect(readFileSync(log, "utf8")).toBe("1234567");
	});

	it("strict no-follow open rejects an active path swapped to a symlink", async () => {
		const root = tempRoot();
		const target = join(root, "race-target");
		const log = join(root, "bridge.log");
		writeFileSync(target, "race-target-survives\n");
		writeFileSync(log, "safe-active\n");
		let injected = false;

		vi.resetModules();
		vi.doMock("node:fs", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:fs")>();
			return {
				...actual,
				openSync(
					path: Parameters<typeof actual.openSync>[0],
					flags: Parameters<typeof actual.openSync>[1],
					mode?: Parameters<typeof actual.openSync>[2],
				) {
					if (path === log && !injected) {
						injected = true;
						unlinkSync(log);
						symlinkSync(target, log);
					}
					return mode === undefined
						? actual.openSync(path, flags)
						: actual.openSync(path, flags, mode);
				},
			};
		});
		try {
			const raced = await import("../log-rotate.js");
			expect(() =>
				raced.appendRotatedLogSync(log, "forbidden\n", {
					maxBytes: 1024,
					keep: 3,
					strict: true,
				}),
			).toThrow();
			expect(readFileSync(target, "utf8")).toBe("race-target-survives\n");
		} finally {
			vi.doUnmock("node:fs");
			vi.resetModules();
		}
	});
});
