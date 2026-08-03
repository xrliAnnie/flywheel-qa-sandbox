/**
 * FLY-1501 QA — scheduler-once against the REAL restart brake.
 *
 * Every other scheduler test drives `RestartGatePort` through a `vi.fn()` mock,
 * so the TypeScript guard and the Python ledger have only ever been verified in
 * isolation. This file exercises the actual seam: `runSchedulerOnce` →
 * `ProcessRestartGate` → `scripts/restart-storm-gate.py` → real fcntl locks,
 * real append-only ledger, real state file, real alert leg. The assertions are
 * on-disk facts, not port call counts.
 */
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	initializeRollbackFenceTx,
	Kernel,
	migrateDatabase,
} from "flywheel-v2-kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SCHEDULER_CONFIG } from "../config.js";
import type { MemorySample, MemoryThresholds } from "../memory-watermark.js";
import {
	type LaunchdPort,
	runSchedulerOnce,
	type SchedulerClock,
} from "../scheduler-once.js";
import { ProcessRestartGate } from "../system-ports.js";

const GATE_BIN = fileURLToPath(
	new URL("../../../../scripts/restart-storm-gate.py", import.meta.url),
);
const CHILD_KEY = "lead.flywheel-eng";
const GIB = 1024 ** 3;

const THRESHOLDS: MemoryThresholds = {
	ramBytes: 48 * GIB,
	pageSizeBytes: 16_384,
	freeTriggerBytes: Math.floor((48 * GIB * 8) / 100),
	freeClearBytes: Math.floor((48 * GIB * 15) / 100),
	swapoutMinPagesPerTick: 3072,
};
const HEALTHY: MemorySample = {
	reclaimableBytes: THRESHOLDS.freeClearBytes + 1,
	swapoutsTotal: 100,
};

function sessionBinding(agentId: string, generation: number): string {
	return JSON.stringify({
		v: 1,
		host_epoch: "host-1",
		session_id: `session-${agentId}-${generation}`,
		pid: 10_000 + generation,
		pid_start: `start-${agentId}-${generation}`,
	});
}

class TestClock implements SchedulerClock {
	now = Date.parse("2026-07-27T00:01:00.000Z");
	nowMs(): number {
		return this.now;
	}
	nowIso(): string {
		return new Date(this.now).toISOString();
	}
	async sleep(ms: number): Promise<void> {
		this.now += ms;
	}
}

let dir: string;
let kernel: Kernel;
let clock: TestClock;
let alertLog: string;
let savedEnv: Record<string, string | undefined>;

function seedStaleLead(): void {
	kernel.write("test.seed", (tx) => {
		tx.run(
			`INSERT INTO agents(
			   agent_id,kind,generation,instance_id,session_binding,last_poll_at,state
			 )
			 VALUES (
			   'eng','lead',3,'instance-eng-3',@sessionBinding,
			   '2026-07-27T00:00:00.000Z','online'
			 )`,
			{ sessionBinding: sessionBinding("eng", 3) },
		);
		tx.run(
			`INSERT INTO mailbox
			 (message_uid,source_kind,source_id,payload,payload_digest,to_agent,kind,
			  retention_class,cutover_epoch,state,retry_count,next_retry_at,created_at)
			 VALUES ('message-1','lead','source-1','{}','digest','eng','instruction',
			  'business',1,'pending',0,NULL,'2026-07-27T00:00:00.000Z')`,
		);
		tx.run(
			`INSERT INTO processing_attempts
			 (attempt_uid,message_uid,attempt_no,instance_id,generation,activation_id,
			  started_at,outcome)
			 VALUES ('attempt-1','message-1',1,'instance',3,NULL,
			  '2026-07-27T00:00:01.000Z','running')`,
		);
	});
}

/** Reset the repair lease so a fresh short-lived scheduler tick can claim again. */
function clearRepairBackoff(): void {
	kernel.write("test.clear-backoff", (tx) => {
		tx.run(`DELETE FROM scheduler_repair_leases`);
	});
}

function ledgerLines(): string[] {
	const path = join(dir, "ledger", `${CHILD_KEY}.jsonl`);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

function gateState(): Record<string, unknown> {
	return JSON.parse(
		execFileSync(
			GATE_BIN,
			["status", "--with-seq", "--root", join(dir, "ledger"), CHILD_KEY],
			{ encoding: "utf8" },
		),
	);
}

function leadAlerts(): string[] {
	if (!existsSync(alertLog)) return [];
	return readFileSync(alertLog, "utf8")
		.split("\n")
		.filter((line) => line.startsWith("lead "));
}

function schedulerInput(
	launchd: LaunchdPort,
	memory: MemorySample | null = HEALTHY,
	runId = `run-${Math.random().toString(16).slice(2)}`,
) {
	return {
		kernel,
		runId,
		backend: "launchd",
		host: "qa-host",
		projectName: "flywheel",
		uid: 501,
		config: {
			...DEFAULT_SCHEDULER_CONFIG,
			heartbeatConfirmMs: 200,
			confirmPollMs: 100,
		},
		clock,
		memory: { thresholds: THRESHOLDS, sample: async () => memory },
		launchd,
		restartCoordination: {
			withMutationLock: async (action: () => Promise<void>) => {
				await action();
				return "executed" as const;
			},
			globalRestartActive: async () => false,
		},
		restartGate: new ProcessRestartGate({
			gateBin: GATE_BIN,
			ledgerRoot: join(dir, "ledger"),
		}),
	};
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fly1501-qa-gate-integration-"));
	alertLog = join(dir, "alerts.log");
	const bin = join(dir, "bin");
	writeFileSync(
		join(dir, "noop.sh"),
		`#!/bin/sh\necho "meta $*" >> ${JSON.stringify(alertLog)}\n`,
	);
	chmodSync(join(dir, "noop.sh"), 0o755);
	writeFileSync(
		join(dir, "lead.sh"),
		`#!/bin/sh\necho "lead $*" >> ${JSON.stringify(alertLog)}\necho sent\n`,
	);
	chmodSync(join(dir, "lead.sh"), 0o755);
	void bin;

	savedEnv = {
		FLYWHEEL_META_ALERT_BIN: process.env.FLYWHEEL_META_ALERT_BIN,
		FLYWHEEL_LEAD_ALERT_BIN: process.env.FLYWHEEL_LEAD_ALERT_BIN,
	};
	process.env.FLYWHEEL_META_ALERT_BIN = join(dir, "noop.sh");
	process.env.FLYWHEEL_LEAD_ALERT_BIN = join(dir, "lead.sh");

	const path = join(dir, "flywheel-v2.db");
	migrateDatabase({ path });
	kernel = Kernel.open({ path });
	kernel.write("test.rollback-fence", (tx) => {
		initializeRollbackFenceTx(tx, {
			authorityState: "live",
			nowIso: "2026-07-27T00:00:00.000Z",
		});
	});
	clock = new TestClock();
	seedStaleLead();
});

afterEach(() => {
	kernel.close();
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(dir, { recursive: true, force: true });
});

// Every case here forks the python gate several times per scheduler tick, so
// the default 5s budget measures machine load rather than the behaviour under
// test. One generous suite-wide budget keeps the assertions honest.
describe("scheduler-once against the real restart brake", () => {
	it("accounts each failed repair as exactly one real ledger event", async () => {
		const failing: LaunchdPort = {
			requestGracefulRestart: async () => {
				throw new Error("launchctl SIGTERM exit 3");
			},
		};

		const result = await runSchedulerOnce(schedulerInput(failing));

		expect(result.failed).toBe(1);
		expect(result.restarted).toBe(0);
		// The Python ledger — not a mock — recorded the attempt exactly once.
		expect(ledgerLines()).toHaveLength(1);
		expect(JSON.parse(ledgerLines()[0]!)).toMatchObject({ seq: 1 });
		expect(gateState()).toMatchObject({ state: "active", ledger_seq: 1 });
		expect(leadAlerts()).toHaveLength(0);
	});

	it("trips the real brake after repeated repairs and stops signaling launchd", async () => {
		const calls: string[] = [];
		const failing: LaunchdPort = {
			requestGracefulRestart: async (label) => {
				calls.push(label);
				throw new Error("launchctl SIGTERM exit 3");
			},
		};

		// Six short-lived ticks: the sixth crosses the default 5-per-10-minute cap.
		for (let tick = 0; tick < 6; tick++) {
			clearRepairBackoff();
			await runSchedulerOnce(schedulerInput(failing));
		}

		expect(gateState()).toMatchObject({ state: "held_alert_attempted" });
		expect(ledgerLines()).toHaveLength(6);
		expect(calls).toHaveLength(6);
		// Exactly one Lead alert for the whole episode — the brake owns it.
		expect(leadAlerts()).toHaveLength(1);
		expect(leadAlerts()[0]).toContain("restart_storm_hold");

		// Once held, a further tick must neither signal nor grow the ledger.
		clearRepairBackoff();
		const afterHold = await runSchedulerOnce(schedulerInput(failing));
		expect(afterHold.held).toBe(1);
		expect(afterHold.restarted).toBe(0);
		expect(calls).toHaveLength(6);
		expect(ledgerLines()).toHaveLength(6);
		expect(leadAlerts()).toHaveLength(1);
	});

	it("does not double-count when the wrapper advanced the ledger first", async () => {
		// Mirrors the real race in the design: the launchd wrapper's own pre-exec
		// gate appends between the guard's status read and its record-failure.
		const racing: LaunchdPort = {
			requestGracefulRestart: async () => {
				execFileSync(
					GATE_BIN,
					["gate", "--root", join(dir, "ledger"), CHILD_KEY],
					{ encoding: "utf8" },
				);
				throw new Error("SIGTERM raced the wrapper");
			},
		};

		await runSchedulerOnce(schedulerInput(racing));

		// One physical restart attempt → exactly one ledger event, not two.
		expect(ledgerLines()).toHaveLength(1);
		expect(gateState()).toMatchObject({ ledger_seq: 1 });
	});

	it("never touches the real ledger when memory pressure declines the repair", async () => {
		const launchd: LaunchdPort = {
			requestGracefulRestart: async () => {
				throw new Error("must not signal under pressure");
			},
		};

		const result = await runSchedulerOnce(schedulerInput(launchd, null));

		expect(result.memoryLimited).toBe(1);
		expect(result.restarted).toBe(0);
		expect(result.failed).toBe(0);
		expect(ledgerLines()).toHaveLength(0);
		expect(leadAlerts()).toHaveLength(0);
		// The orphan attempt must survive: nothing was claimed, so nothing crashed.
		expect(
			kernel.read((tx) =>
				tx.get<{ outcome: string }>(
					`SELECT outcome FROM processing_attempts WHERE attempt_uid='attempt-1'`,
				),
			),
		).toMatchObject({ outcome: "running" });
	});

	it("releases the orphaned attempt exactly once on a confirmed repair", async () => {
		const launchd: LaunchdPort = {
			requestGracefulRestart: async () => {
				kernel.write("test.new-generation", (tx) => {
					tx.run(
						`UPDATE agents
						    SET generation=4,
						        instance_id='instance-eng-4',
						        session_binding=@sessionBinding,
						        last_poll_at='2026-07-27T00:02:00.000Z'
						 WHERE agent_id='eng'`,
						{ sessionBinding: sessionBinding("eng", 4) },
					);
				});
			},
		};

		const result = await runSchedulerOnce(schedulerInput(launchd));

		expect(result.restarted).toBe(1);
		expect(
			kernel.read((tx) =>
				tx.get<{ outcome: string }>(
					`SELECT outcome FROM processing_attempts WHERE attempt_uid='attempt-1'`,
				),
			),
		).toMatchObject({ outcome: "crashed" });
		// A confirmed repair is not a restart failure: the brake stays untouched.
		expect(ledgerLines()).toHaveLength(0);
		expect(leadAlerts()).toHaveLength(0);
	});
}, 120_000);
