import {
	existsSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	insertLeadInstruction,
	readZombieCandidates,
} from "../fleet-comm-operations.js";
import { scanZombies } from "../zombie-scan.js";

describe("fleet short-lived CommDB ownership", () => {
	let directory: string;
	let path: string;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "fly2563-comm-"));
		path = join(directory, "comm.db");
	});
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(directory, { recursive: true, force: true });
	});

	it("closes every notification and project read without GC, retaining receipt identity", () => {
		insertLeadInstruction(path, "test-lead", "hello", "receipt");
		const fdDirectory =
			process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
		const count = () =>
			readdirSync(fdDirectory).filter((name) => /^\d+$/.test(name)).length;
		const baseline = count();
		const close = vi.spyOn(CommDB.prototype, "close");
		for (let i = 0; i < 100; i++) {
			insertLeadInstruction(path, "test-lead", "hello", "receipt");
			expect(readZombieCandidates(path, "project-a")).toEqual([]);
			expect(readZombieCandidates(path, "project-b")).toEqual([]);
			expect(close).toHaveBeenCalledTimes((i + 1) * 3);
		}
		expect(count()).toBeLessThanOrEqual(baseline);
		const db = CommDB.openReadonly(path);
		try {
			expect(db.getUnreadInstructions("test-lead")).toEqual([
				expect.objectContaining({
					id: "receipt",
					content: "hello",
					from_agent: "bridge",
				}),
			]);
		} finally {
			db.close();
		}
	});

	it("closes on insert and list errors and preserves the error", () => {
		insertLeadInstruction(path, "test-lead", "hello", "receipt");
		const close = vi.spyOn(CommDB.prototype, "close");
		expect(() =>
			insertLeadInstruction(path, "test-lead", "different", "receipt"),
		).toThrow("reused with different content");
		expect(close).toHaveBeenCalledTimes(1);
		const error = new Error("read failed");
		vi.spyOn(CommDB.prototype, "listSessions").mockImplementationOnce(() => {
			throw error;
		});
		expect(() => readZombieCandidates(path, "project")).toThrow(error);
		expect(close).toHaveBeenCalledTimes(2);
	});

	it("treats only a missing database as uninitialized", () => {
		expect(readZombieCandidates(path, "project")).toEqual([]);
		expect(existsSync(path)).toBe(false);
		writeFileSync(path, "corrupt database");
		expect(() => readZombieCandidates(path, "project")).toThrow();
		expect(() =>
			readZombieCandidates(join(path, "comm.db"), "project"),
		).toThrow();
	});

	it("releases the database before an asynchronous liveness probe hangs", async () => {
		const db = new CommDB(path);
		try {
			db.registerSession("execution", "window", "project");
		} finally {
			db.close();
		}
		const close = vi.spyOn(CommDB.prototype, "close");
		let release!: (alive: boolean) => void;
		const probe = new Promise<boolean>((resolve) => {
			release = resolve;
		});
		const scan = scanZombies({
			commRunning: readZombieCandidates(path, "project"),
			storeSession: () => ({
				status: "running",
				heartbeat_at: "2026-01-01 00:00:00",
			}),
			targetAlive: () => {
				expect(close).toHaveBeenCalledTimes(1);
				return probe;
			},
			nowMs: Date.parse("2026-01-03T00:00:00Z"),
		});
		expect(close).toHaveBeenCalledTimes(1);
		release(false);
		expect(await scan).toEqual([
			expect.objectContaining({ shape: "stale_target" }),
		]);
	});
});
