import { describe, expect, it, vi } from "vitest";
import { createTerminalCommDbSync } from "../bridge/terminal-commdb-sync.js";

describe("terminal CommDB sync queue (FLY-1066 Layer 1)", () => {
	it("enqueues without opening CommDB in the caller stack, then marks after drain", async () => {
		const statuses = new Map([["exec-1", "failed"]]);
		const mark = vi.fn();
		const close = vi.fn();
		const openDb = vi.fn(() => ({ markSessionTerminalStatus: mark, close }));
		const sync = createTerminalCommDbSync({
			enabled: true,
			getAuthoritativeStatus: (executionId) => statuses.get(executionId),
			resolveDbPath: () => "/tmp/comm.db",
			openDb,
		});
		await sync.warmProjects(["flywheel"]);

		expect(sync.enqueue("exec-1", "failed", "flywheel")).toBe(true);
		expect(openDb).not.toHaveBeenCalled();

		await sync.flush();
		expect(openDb).toHaveBeenCalledWith("/tmp/comm.db");
		expect(mark).toHaveBeenCalledWith("exec-1", "failed");
		expect(close).toHaveBeenCalledOnce();
	});

	it("coalesces by project+execution with latest status winning", async () => {
		const statuses = new Map([["exec-1", "blocked"]]);
		const mark = vi.fn();
		const sync = createTerminalCommDbSync({
			enabled: true,
			getAuthoritativeStatus: (executionId) => statuses.get(executionId),
			resolveDbPath: () => "/tmp/comm.db",
			openDb: () => ({ markSessionTerminalStatus: mark, close: vi.fn() }),
		});
		await sync.warmProjects(["flywheel"]);

		sync.enqueue("exec-1", "failed", "flywheel");
		sync.enqueue("exec-1", "blocked", "flywheel");
		await sync.flush();

		expect(mark).toHaveBeenCalledTimes(1);
		expect(mark).toHaveBeenCalledWith("exec-1", "blocked");
		expect(sync.stats()).toMatchObject({ enqueued: 1, coalesced: 1 });
	});

	it("re-reads StateStore and skips a stale queued status", async () => {
		let authoritative = "failed";
		const mark = vi.fn();
		const sync = createTerminalCommDbSync({
			enabled: true,
			getAuthoritativeStatus: () => authoritative,
			resolveDbPath: () => "/tmp/comm.db",
			openDb: () => ({ markSessionTerminalStatus: mark, close: vi.fn() }),
		});
		await sync.warmProjects(["flywheel"]);

		sync.enqueue("exec-1", "failed", "flywheel");
		authoritative = "running";
		await sync.flush();

		expect(mark).not.toHaveBeenCalled();
		expect(sync.stats().skippedStale).toBe(1);
	});

	it("drops overflow without throwing and lets Layer 2 own convergence", async () => {
		const warnings: string[] = [];
		const mark = vi.fn();
		const sync = createTerminalCommDbSync({
			enabled: true,
			maxPending: 2,
			getAuthoritativeStatus: () => "failed",
			resolveDbPath: () => "/tmp/comm.db",
			openDb: () => ({ markSessionTerminalStatus: mark, close: vi.fn() }),
			log: (message) => warnings.push(message),
		});
		await sync.warmProjects(["flywheel"]);

		expect(sync.enqueue("exec-1", "failed", "flywheel")).toBe(true);
		expect(sync.enqueue("exec-2", "failed", "flywheel")).toBe(true);
		expect(sync.enqueue("exec-3", "failed", "flywheel")).toBe(false);
		await sync.flush();

		expect(mark).toHaveBeenCalledTimes(2);
		expect(sync.stats().dropped).toBe(1);
		expect(warnings.join("\n")).toContain("overflow");
	});

	it("isolates open, mark, and close failures from enqueue callers", async () => {
		const warnings: string[] = [];
		let mode: "open" | "mark" | "close" = "open";
		const sync = createTerminalCommDbSync({
			enabled: true,
			getAuthoritativeStatus: () => "failed",
			resolveDbPath: () => "/tmp/comm.db",
			openDb: () => {
				if (mode === "open") throw new Error("open failed");
				return {
					markSessionTerminalStatus: () => {
						if (mode === "mark") throw new Error("mark failed");
					},
					close: () => {
						if (mode === "close") throw new Error("close failed");
					},
				};
			},
			log: (message) => warnings.push(message),
		});
		await sync.warmProjects(["flywheel"]);

		for (const next of ["open", "mark", "close"] as const) {
			mode = next;
			expect(() =>
				sync.enqueue(`exec-${next}`, "failed", "flywheel"),
			).not.toThrow();
			await sync.flush();
		}

		expect(sync.stats().failed).toBe(3);
		expect(warnings.join("\n")).toMatch(/open failed|mark failed|close failed/);
	});

	it("disables all enqueue behavior when the kill-switch is off", async () => {
		const openDb = vi.fn();
		const warmProject = vi.fn();
		const sync = createTerminalCommDbSync({
			enabled: false,
			getAuthoritativeStatus: () => "failed",
			resolveDbPath: () => "/tmp/comm.db",
			openDb,
			warmProject,
		});
		await sync.warmProjects(["flywheel"]);

		expect(sync.enqueue("exec-1", "failed", "flywheel")).toBe(false);
		expect(sync.enqueue("exec-2", "completed", "flywheel")).toBe(false);
		await sync.flush();
		expect(openDb).not.toHaveBeenCalled();
		expect(warmProject).not.toHaveBeenCalled();
		expect(sync.stats().enqueued).toBe(0);
	});

	it("ignores non-CRASH_PRESERVE transitions while enabled", async () => {
		const openDb = vi.fn();
		const sync = createTerminalCommDbSync({
			enabled: true,
			getAuthoritativeStatus: () => "completed",
			resolveDbPath: () => "/tmp/comm.db",
			openDb,
		});
		await sync.warmProjects(["flywheel"]);

		expect(sync.enqueue("exec-1", "completed", "flywheel")).toBe(false);
		await sync.flush();
		expect(openDb).not.toHaveBeenCalled();
		expect(sync.stats().enqueued).toBe(0);
	});

	it("bounds shutdown drain and abandons unfinished warm work to Layer 2", async () => {
		const sync = createTerminalCommDbSync({
			enabled: true,
			getAuthoritativeStatus: () => "failed",
			resolveDbPath: () => "/tmp/comm.db",
			openDb: () => ({ markSessionTerminalStatus: vi.fn(), close: vi.fn() }),
			warmProject: () => new Promise((resolve) => setTimeout(resolve, 25)),
			log: vi.fn(),
		});
		const warming = sync.warmProjects(["flywheel"]);

		await expect(sync.close(1)).resolves.toBe(false);
		await warming;
	});

	it("keeps a project degraded after warm-migration failure, then enables it on bounded retry", async () => {
		const retryCallbacks: Array<() => void> = [];
		let warmFails = true;
		const mark = vi.fn();
		const sync = createTerminalCommDbSync({
			enabled: true,
			getAuthoritativeStatus: () => "failed",
			resolveDbPath: () => "/tmp/comm.db",
			openDb: () => ({ markSessionTerminalStatus: mark, close: vi.fn() }),
			warmProject: () => {
				if (warmFails) throw new Error("database is locked");
			},
			scheduleRetry: (callback) => {
				retryCallbacks.push(callback);
				return callback;
			},
			cancelRetry: vi.fn(),
			log: vi.fn(),
		});

		await sync.warmProjects(["flywheel"]);
		expect(sync.stats().degradedProjects).toEqual(["flywheel"]);
		expect(sync.enqueue("exec-before", "failed", "flywheel")).toBe(false);
		expect(retryCallbacks).toHaveLength(1);

		warmFails = false;
		retryCallbacks[0]!();
		await sync.flush();
		expect(sync.stats().degradedProjects).toEqual([]);
		expect(sync.enqueue("exec-after", "failed", "flywheel")).toBe(true);
		await sync.flush();
		expect(mark).toHaveBeenCalledWith("exec-after", "failed");
	});
});
