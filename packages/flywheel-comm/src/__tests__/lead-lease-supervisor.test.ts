import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	LeadLeaseStore,
	ProcessProbeTimeoutError,
	type ProcessTupleState,
	processAliveWithStart,
	processStateIsZombie,
	processTupleStateWithStart,
} from "../lead-lease.js";

async function spawnZombieFixture(): Promise<{
	pid: number;
	stop: () => Promise<void>;
}> {
	const fixture = spawn(
		"python3",
		[
			"-c",
			[
				"import os, time",
				"pid = os.fork()",
				"if pid == 0: os._exit(0)",
				"print(pid, flush=True)",
				"time.sleep(30)",
			].join("\n"),
		],
		{ stdio: ["ignore", "pipe", "ignore"] },
	);
	const pid = await new Promise<number>((resolve, reject) => {
		let output = "";
		const timer = setTimeout(
			() => reject(new Error("timed out waiting for zombie fixture pid")),
			2_000,
		);
		fixture.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		fixture.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
			const line = output.split("\n", 1)[0]?.trim();
			if (!line) return;
			clearTimeout(timer);
			resolve(Number(line));
		});
	});
	return {
		pid,
		stop: async () => {
			if (fixture.exitCode === null && fixture.signalCode === null) {
				fixture.kill("SIGKILL");
				await new Promise<void>((resolve) =>
					fixture.once("close", () => resolve()),
				);
			}
		},
	};
}

describe("FLY-1602 supervisor-aware Lead leases", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1602-lease-"));
		dbPath = join(dir, "lead-lease.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function open(states: Readonly<Record<string, ProcessTupleState>> = {}) {
		return new LeadLeaseStore(dbPath, {
			processTupleState: (pid, start) => states[`${pid}:${start}`] ?? "dead",
		});
	}

	function seedBound(input: {
		leadKey: string;
		supervisorPid?: number;
		supervisorStart?: string;
		holderPid?: number;
		holderStart?: string;
	}): void {
		const supervisorPid = input.supervisorPid ?? 100;
		const supervisorStart = input.supervisorStart ?? "supervisor-old";
		const holderPid = input.holderPid ?? 200;
		const holderStart = input.holderStart ?? "holder-old";
		const store = open();
		store.acquire({
			leadKey: input.leadKey,
			project: "flywheel",
			leadId: input.leadKey.replace(/^flywheel-/, ""),
			supervisorPid,
			supervisorStart,
			acquiredBy: "seed",
			now: "2026-08-03T01:00:00.000Z",
		});
		store.bind({
			leadKey: input.leadKey,
			generation: 1,
			expectedSupervisorPid: supervisorPid,
			expectedSupervisorStart: supervisorStart,
			panePid: holderPid,
			paneStart: holderStart,
			now: "2026-08-03T01:00:01.000Z",
		});
		store.close();
	}

	it("treats every Z-prefixed process state as non-executable", () => {
		expect(processStateIsZombie("Z")).toBe(true);
		expect(processStateIsZombie(" Z+")).toBe(true);
		expect(processStateIsZombie("S+")).toBe(false);
	});

	it("classifies a real zombie tuple as dead", async (context) => {
		try {
			execFileSync("/bin/ps", ["-o", "state=", "-p", String(process.pid)], {
				encoding: "utf8",
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EPERM") {
				context.skip("managed sandbox denies /bin/ps process inspection");
				return;
			}
			throw error;
		}
		const fixture = await spawnZombieFixture();
		try {
			let state = "";
			for (let attempt = 0; attempt < 50; attempt += 1) {
				state = execFileSync(
					"ps",
					["-o", "state=", "-p", String(fixture.pid)],
					{ encoding: "utf8" },
				).trim();
				if (processStateIsZombie(state)) break;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			const start = execFileSync(
				"ps",
				["-o", "lstart=", "-p", String(fixture.pid)],
				{ encoding: "utf8" },
			).trim();
			expect(state).toMatch(/^Z/);
			expect(processTupleStateWithStart(fixture.pid, start)).toBe("dead");
		} finally {
			await fixture.stop();
		}
	});

	it("advances and binds a new generation after a zombie-equivalent holder dies", () => {
		seedBound({ leadKey: "flywheel-eng-lead" });
		const store = open({
			"100:supervisor-old": "dead",
			"200:holder-old": processStateIsZombie("Z+") ? "dead" : "alive",
		});
		expect(
			store.acquire({
				leadKey: "flywheel-eng-lead",
				project: "flywheel",
				leadId: "eng-lead",
				supervisorPid: 300,
				supervisorStart: "supervisor-new",
				acquiredBy: "replacement",
			}),
		).toEqual({ status: "acquired", generation: 2 });
		expect(
			store.bind({
				leadKey: "flywheel-eng-lead",
				generation: 2,
				expectedSupervisorPid: 300,
				expectedSupervisorStart: "supervisor-new",
				panePid: 400,
				paneStart: "holder-new",
			}),
		).toEqual({ status: "bound", generation: 2 });
		store.close();
	});

	it("stores independent supervisor and holder tuples and verifies one snapshot", () => {
		const store = open();
		expect(
			store.acquire({
				leadKey: "flywheel-eng-lead",
				project: "flywheel",
				leadId: "eng-lead",
				supervisorPid: 100,
				supervisorStart: "supervisor-old",
				acquiredBy: "test",
				now: "2026-08-03T01:00:00.000Z",
			}),
		).toEqual({ status: "acquired", generation: 1 });
		expect(store.getLease("flywheel-eng-lead")).toMatchObject({
			generation: 1,
			supervisorPid: 100,
			supervisorStart: "supervisor-old",
			supervisorGeneration: 1,
			holderPid: 100,
			holderStart: "supervisor-old",
			boundAt: null,
		});

		store.bind({
			leadKey: "flywheel-eng-lead",
			generation: 1,
			expectedSupervisorPid: 100,
			expectedSupervisorStart: "supervisor-old",
			panePid: 200,
			paneStart: "holder-old",
			now: "2026-08-03T01:00:01.000Z",
		});

		expect(store.progressSnapshot("flywheel-eng-lead")).toEqual({
			status: "present",
			rowFormat: "version_valid",
			generation: 1,
			supervisorPid: 100,
			supervisorStart: "supervisor-old",
			supervisorGeneration: 1,
			holderPid: 200,
			holderStart: "holder-old",
			boundAt: "2026-08-03T01:00:01.000Z",
			acquiredAt: "2026-08-03T01:00:00.000Z",
			identityDigest: null,
		});
		expect(
			store.verifyBound({
				leadKey: "flywheel-eng-lead",
				expectedSupervisorPid: 100,
				expectedSupervisorStart: "supervisor-old",
				expectedHolderPid: 200,
				expectedHolderStart: "holder-old",
			}),
		).toEqual({ status: "verified", generation: 1 });
		store.close();
	});

	it("classifies the complete version-valid supervisor x holder state table", () => {
		const cases: Array<{
			name: string;
			self: boolean;
			states: Record<string, ProcessTupleState>;
			expected: Record<string, unknown>;
		}> = [
			{
				name: "foreign supervisor alive dominates holder state",
				self: false,
				states: { "100:supervisor-old": "alive" },
				expected: { status: "denied_holder_alive", generation: 1 },
			},
			{
				name: "foreign supervisor sensor failure holds",
				self: false,
				states: { "100:supervisor-old": "sensor_error" },
				expected: { status: "denied_sensor_degraded", generation: 1 },
			},
			{
				name: "self with live bound holder resumes adopted monitoring",
				self: true,
				states: { "200:holder-old": "alive" },
				expected: {
					status: "idempotent_adopted",
					generation: 1,
					holderPid: 200,
					holderStart: "holder-old",
				},
			},
			{
				name: "self with dead bound holder advances generation",
				self: true,
				states: { "200:holder-old": "dead" },
				expected: { status: "acquired", generation: 2 },
			},
			{
				name: "self with degraded holder sensor holds",
				self: true,
				states: { "200:holder-old": "sensor_error" },
				expected: { status: "denied_sensor_degraded", generation: 1 },
			},
			{
				name: "dead supervisor plus live holder is an orphan",
				self: false,
				states: {
					"100:supervisor-old": "dead",
					"200:holder-old": "alive",
				},
				expected: {
					status: "holder_orphaned",
					generation: 1,
					holderPid: 200,
					holderStart: "holder-old",
					supervisorPid: 100,
					supervisorStart: "supervisor-old",
				},
			},
			{
				name: "dead supervisor and dead holder advances generation",
				self: false,
				states: {
					"100:supervisor-old": "dead",
					"200:holder-old": "dead",
				},
				expected: { status: "acquired", generation: 2 },
			},
			{
				name: "dead supervisor plus degraded holder sensor holds",
				self: false,
				states: {
					"100:supervisor-old": "dead",
					"200:holder-old": "sensor_error",
				},
				expected: { status: "denied_sensor_degraded", generation: 1 },
			},
		];

		for (const [index, testCase] of cases.entries()) {
			const leadKey = `flywheel-case-${index}`;
			seedBound({ leadKey });
			const store = open(testCase.states);
			const result = store.acquire({
				leadKey,
				project: "flywheel",
				leadId: `case-${index}`,
				supervisorPid: testCase.self ? 100 : 300,
				supervisorStart: testCase.self ? "supervisor-old" : "supervisor-new",
				acquiredBy: "contender",
				now: "2026-08-03T01:01:00.000Z",
			});
			expect(result, testCase.name).toEqual(testCase.expected);
			store.close();
		}
	});

	it("repairs only legacy same-requester unbound rows and fails closed otherwise", () => {
		const seed = open();
		for (const leadKey of [
			"same",
			"foreign-alive",
			"foreign-sensor",
			"foreign-dead",
			"malformed",
		]) {
			seed.acquire({
				leadKey,
				project: "flywheel",
				leadId: leadKey,
				supervisorPid: 100,
				supervisorStart: "supervisor-old",
				acquiredBy: "seed",
			});
		}
		seed.close();

		const mutate = new Database(dbPath);
		mutate
			.prepare(
				`UPDATE lead_lease
				 SET generation = 2, holder_pid = 300, holder_start = 'supervisor-new',
				     bound_at = NULL
				 WHERE lead_key != 'malformed'`,
			)
			.run();
		mutate
			.prepare(
				"UPDATE lead_lease SET supervisor_start = NULL WHERE lead_key = 'malformed'",
			)
			.run();
		mutate.close();

		const same = open();
		expect(
			same.acquire({
				leadKey: "same",
				project: "flywheel",
				leadId: "same",
				supervisorPid: 300,
				supervisorStart: "supervisor-new",
				acquiredBy: "roll-forward",
			}),
		).toEqual({ status: "idempotent", generation: 2 });
		expect(same.progressSnapshot("same")).toMatchObject({
			rowFormat: "version_valid",
			supervisorPid: 300,
			supervisorStart: "supervisor-new",
			supervisorGeneration: 2,
		});
		same.close();

		for (const [leadKey, holderState, expected] of [
			[
				"foreign-alive",
				"alive",
				{ status: "denied_holder_alive", generation: 2 },
			],
			[
				"foreign-sensor",
				"sensor_error",
				{ status: "denied_sensor_degraded", generation: 2 },
			],
			["foreign-dead", "dead", { status: "acquired", generation: 3 }],
		] as const) {
			const store = open({ "300:supervisor-new": holderState });
			expect(
				store.acquire({
					leadKey,
					project: "flywheel",
					leadId: leadKey,
					supervisorPid: 400,
					supervisorStart: "foreign",
					acquiredBy: "roll-forward",
				}),
			).toEqual(expected);
			store.close();
		}

		const malformed = open();
		expect(
			malformed.acquire({
				leadKey: "malformed",
				project: "flywheel",
				leadId: "malformed",
				supervisorPid: 100,
				supervisorStart: "supervisor-old",
				acquiredBy: "roll-forward",
			}),
		).toEqual({ status: "denied_sensor_degraded", generation: 1 });
		expect(malformed.progressSnapshot("malformed")).toMatchObject({
			rowFormat: "malformed",
			supervisorStart: null,
		});
		malformed.close();
	});

	it("migrates legacy rows conservatively and never adopts malformed rows", () => {
		const raw = new Database(dbPath);
		raw.exec(`
			CREATE TABLE lead_lease (
				lead_key TEXT PRIMARY KEY,
				project TEXT NOT NULL,
				lead_id TEXT NOT NULL,
				generation INTEGER NOT NULL,
				holder_pid INTEGER,
				holder_start TEXT,
				bound_at TEXT,
				acquired_at TEXT NOT NULL,
				acquired_by TEXT NOT NULL
			);
			INSERT INTO lead_lease VALUES (
				'flywheel-legacy','flywheel','legacy',7,200,'holder-old',
				'2026-08-03T00:00:01.000Z','2026-08-03T00:00:00.000Z','old-binary'
			);
		`);
		raw.close();

		const legacy = open({ "200:holder-old": "alive" });
		expect(legacy.progressSnapshot("flywheel-legacy")).toMatchObject({
			status: "present",
			rowFormat: "legacy",
			supervisorPid: null,
			supervisorStart: null,
			supervisorGeneration: null,
		});
		expect(
			legacy.acquire({
				leadKey: "flywheel-legacy",
				project: "flywheel",
				leadId: "legacy",
				supervisorPid: 300,
				supervisorStart: "supervisor-new",
				acquiredBy: "new-binary",
			}),
		).toEqual({ status: "denied_holder_alive", generation: 7 });
		legacy.close();

		const mutate = new Database(dbPath);
		mutate
			.prepare(
				"UPDATE lead_lease SET supervisor_pid = 100 WHERE lead_key = 'flywheel-legacy'",
			)
			.run();
		const columns = mutate.pragma("table_info(lead_lease)") as Array<{
			name: string;
		}>;
		expect(columns.map((column) => column.name)).toEqual(
			expect.arrayContaining([
				"supervisor_pid",
				"supervisor_start",
				"supervisor_generation",
			]),
		);
		mutate.close();

		const malformed = open({
			"100:supervisor-old": "dead",
			"200:holder-old": "dead",
		});
		expect(malformed.progressSnapshot("flywheel-legacy")).toMatchObject({
			status: "present",
			rowFormat: "malformed",
		});
		expect(
			malformed.acquire({
				leadKey: "flywheel-legacy",
				project: "flywheel",
				leadId: "legacy",
				supervisorPid: 300,
				supervisorStart: "supervisor-new",
				acquiredBy: "new-binary",
			}),
		).toEqual({ status: "denied_sensor_degraded", generation: 7 });
		malformed.close();
	});

	it("resumes an interrupted ordered migration and classifies OS liveness fail-closed", () => {
		const prefixPath = join(dir, "prefix.db");
		const raw = new Database(prefixPath);
		raw.exec(`
			CREATE TABLE lead_lease (
				lead_key TEXT PRIMARY KEY,
				project TEXT NOT NULL,
				lead_id TEXT NOT NULL,
				generation INTEGER NOT NULL,
				holder_pid INTEGER,
				holder_start TEXT,
				bound_at TEXT,
				acquired_at TEXT NOT NULL,
				acquired_by TEXT NOT NULL,
				supervisor_pid INTEGER
			);
		`);
		raw.close();

		const migrated = new LeadLeaseStore(prefixPath, {
			processTupleState: () => "dead",
		});
		migrated.close();
		const inspect = new Database(prefixPath);
		const columns = inspect.pragma("table_info(lead_lease)") as Array<{
			name: string;
		}>;
		expect(columns.map((column) => column.name)).toEqual(
			expect.arrayContaining([
				"supervisor_pid",
				"supervisor_start",
				"supervisor_generation",
			]),
		);
		inspect.close();

		expect(processTupleStateWithStart(0, "invalid")).toBe("sensor_error");
		expect(processTupleStateWithStart(2_000_000_000, "not-running")).toBe(
			"dead",
		);
		const timeout = () => {
			throw new ProcessProbeTimeoutError(process.pid, "lstart");
		};
		expect(() => processAliveWithStart(process.pid, "start", timeout)).toThrow(
			ProcessProbeTimeoutError,
		);
		expect(
			processTupleStateWithStart(process.pid, "start", {
				processStart: timeout,
			}),
		).toBe("sensor_error");
	});

	it("reports typed verify-bound mismatches without false success", () => {
		seedBound({ leadKey: "flywheel-eng-lead" });
		const store = open();
		expect(
			store.verifyBound({
				leadKey: "missing",
				expectedSupervisorPid: 100,
				expectedSupervisorStart: "supervisor-old",
				expectedHolderPid: 200,
				expectedHolderStart: "holder-old",
			}),
		).toEqual({ status: "mismatch", reason: "missing_lease" });
		expect(
			store.verifyBound({
				leadKey: "flywheel-eng-lead",
				expectedSupervisorPid: 999,
				expectedSupervisorStart: "supervisor-old",
				expectedHolderPid: 200,
				expectedHolderStart: "holder-old",
			}),
		).toEqual({ status: "mismatch", reason: "supervisor_mismatch" });
		expect(
			store.verifyBound({
				leadKey: "flywheel-eng-lead",
				expectedSupervisorPid: 100,
				expectedSupervisorStart: "supervisor-old",
				expectedHolderPid: 999,
				expectedHolderStart: "holder-old",
			}),
		).toEqual({ status: "mismatch", reason: "holder_mismatch" });
		expect(
			store.verifyBound({
				leadKey: "flywheel-eng-lead",
				expectedSupervisorPid: 100,
				expectedSupervisorStart: "supervisor-old",
				expectedHolderPid: 200,
				expectedHolderStart: "holder-old",
			}),
		).toEqual({ status: "verified", generation: 1 });
		store.close();

		const mutate = new Database(dbPath);
		mutate
			.prepare(
				"DELETE FROM lease_generation_history WHERE lead_key = ? AND generation = 1",
			)
			.run("flywheel-eng-lead");
		mutate.close();
		const missingHistory = open();
		expect(
			missingHistory.verifyBound({
				leadKey: "flywheel-eng-lead",
				expectedSupervisorPid: 100,
				expectedSupervisorStart: "supervisor-old",
				expectedHolderPid: 200,
				expectedHolderStart: "holder-old",
			}),
		).toEqual({ status: "mismatch", reason: "missing_history" });
		missingHistory.close();

		const restore = new Database(dbPath);
		restore
			.prepare(
				`INSERT INTO lease_generation_history
				 (lead_key, generation, holder_pid, holder_start, bound_at)
				 VALUES (?, 1, 200, 'holder-old', '2026-08-03T01:00:01.000Z')`,
			)
			.run("flywheel-eng-lead");
		restore
			.prepare(
				"UPDATE lead_lease SET supervisor_generation = 0 WHERE lead_key = ?",
			)
			.run("flywheel-eng-lead");
		restore.close();
		const staleFence = open();
		expect(
			staleFence.verifyBound({
				leadKey: "flywheel-eng-lead",
				expectedSupervisorPid: 100,
				expectedSupervisorStart: "supervisor-old",
				expectedHolderPid: 200,
				expectedHolderStart: "holder-old",
			}),
		).toEqual({
			status: "mismatch",
			reason: "supervisor_generation_mismatch",
		});
		staleFence.close();
	});
});
