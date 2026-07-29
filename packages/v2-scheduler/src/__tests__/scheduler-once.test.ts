import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	initializeRollbackFenceTx,
	Kernel,
	migrateDatabase,
} from "flywheel-v2-kernel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SCHEDULER_CONFIG } from "../config.js";
import type { MemorySample, MemoryThresholds } from "../memory-watermark.js";
import {
	type RestartGatePort,
	runSchedulerOnce,
	type SchedulerClock,
} from "../scheduler-once.js";

const GIB = 1024 ** 3;
const HEALTHY_THRESHOLDS: MemoryThresholds = {
	ramBytes: 48 * GIB,
	pageSizeBytes: 16_384,
	freeTriggerBytes: Math.floor((48 * GIB * 8) / 100),
	freeClearBytes: Math.floor((48 * GIB * 15) / 100),
	swapoutMinPagesPerTick: 3072,
};
const HEALTHY_SAMPLE: MemorySample = {
	reclaimableBytes: HEALTHY_THRESHOLDS.freeClearBytes + 1,
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

interface Fixture {
	dir: string;
	kernel: Kernel;
	clock: TestClock;
}

const fixtures: Fixture[] = [];

function makeFixture(): Fixture {
	const dir = mkdtempSync(join(tmpdir(), "flywheel-v2-scheduler-once-"));
	const path = join(dir, "flywheel-v2.db");
	migrateDatabase({ path });
	const kernel = Kernel.open({ path });
	kernel.write("test.schema-seed", (tx) => {
		initializeRollbackFenceTx(tx, {
			authorityState: "live",
			nowIso: "2026-07-27T00:00:00.000Z",
		});
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
	const fixture = { dir, kernel, clock: new TestClock() };
	fixtures.push(fixture);
	return fixture;
}

function seedCandidate(
	fixture: Fixture,
	agentId: string,
	ordinal: number,
): void {
	fixture.kernel.write(`test.seed-candidate.${agentId}`, (tx) => {
		tx.run(
			`INSERT INTO agents(
			   agent_id,kind,generation,instance_id,session_binding,last_poll_at,state
			 )
			 VALUES (
			   @agentId,'lead',3,@instanceId,@sessionBinding,
			   '2026-07-27T00:00:00.000Z','online'
			 )`,
			{
				agentId,
				instanceId: `instance-${agentId}-3`,
				sessionBinding: sessionBinding(agentId, 3),
			},
		);
		tx.run(
			`INSERT INTO mailbox
			 (message_uid,source_kind,source_id,payload,payload_digest,to_agent,kind,
			  retention_class,cutover_epoch,state,retry_count,next_retry_at,created_at)
			 VALUES (@messageUid,'lead',@sourceId,'{}',@digest,@agentId,'instruction',
			  'business',1,'pending',0,NULL,'2026-07-27T00:00:00.000Z')`,
			{
				messageUid: `message-${ordinal}`,
				sourceId: `source-${ordinal}`,
				digest: `digest-${ordinal}`,
				agentId,
			},
		);
		tx.run(
			`INSERT INTO processing_attempts
			 (attempt_uid,message_uid,attempt_no,instance_id,generation,activation_id,
			  started_at,outcome)
			 VALUES (@attemptUid,@messageUid,1,@instanceId,3,NULL,
			  '2026-07-27T00:00:01.000Z','running')`,
			{
				attemptUid: `attempt-${ordinal}`,
				messageUid: `message-${ordinal}`,
				instanceId: `instance-${ordinal}`,
			},
		);
	});
}

function makeGate(
	state: "active" | "held_alert_pending" = "active",
): RestartGatePort & {
	status: ReturnType<typeof vi.fn>;
	recordFailure: ReturnType<typeof vi.fn>;
} {
	return {
		status: vi.fn(async () => ({ state, ledgerSeq: 7 })),
		recordFailure: vi.fn(async () => ({
			state: state.startsWith("held") ? "held_alert_attempted" : "active",
			ledgerSeq: state.startsWith("held") ? 7 : 8,
			recorded: !state.startsWith("held"),
		})),
	};
}

afterEach(() => {
	for (const fixture of fixtures.splice(0)) {
		fixture.kernel.close();
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

describe("scheduler-once heartbeat repair", () => {
	it("atomically releases the stale attempt before kickstart and confirms generation progress", async () => {
		const fixture = makeFixture();
		const gate = makeGate();
		const kickstart = vi.fn(async () => {
			expect(
				fixture.kernel.read((tx) =>
					tx.get<{ outcome: string }>(
						"SELECT outcome FROM processing_attempts WHERE attempt_uid='attempt-1'",
					),
				),
			).toEqual({ outcome: "crashed" });
			fixture.kernel.write("test.new-generation", (tx) => {
				tx.run(
					`UPDATE agents
					    SET generation=4,
					        instance_id='instance-eng-4',
					        session_binding=@sessionBinding,
					        last_poll_at=@now
					 WHERE agent_id='eng' AND generation=3`,
					{
						now: fixture.clock.nowIso(),
						sessionBinding: sessionBinding("eng", 4),
					},
				);
			});
		});

		const result = await runSchedulerOnce({
			kernel: fixture.kernel,
			runId: "run-success",
			backend: "launchd",
			host: "host-a",
			projectName: "flywheel",
			uid: 501,
			config: { ...DEFAULT_SCHEDULER_CONFIG },
			clock: fixture.clock,
			memory: {
				thresholds: HEALTHY_THRESHOLDS,
				sample: vi.fn(async () => HEALTHY_SAMPLE),
			},
			launchd: { kickstart },
			restartGate: gate,
		});

		expect(result).toEqual({
			status: "succeeded",
			candidates: 1,
			restarted: 1,
			held: 0,
			failed: 0,
			memoryLimited: 0,
		});
		expect(kickstart).toHaveBeenCalledWith(
			"gui/501/com.flywheel.lead.flywheel-eng",
		);
		expect(gate.recordFailure).not.toHaveBeenCalled();
	});

	it("accounts a failed kickstart once through expected ledger seq and backs off", async () => {
		const fixture = makeFixture();
		const gate = makeGate();
		const result = await runSchedulerOnce({
			kernel: fixture.kernel,
			runId: "run-failed",
			backend: "launchd",
			host: "host-a",
			projectName: "flywheel",
			uid: 501,
			config: { ...DEFAULT_SCHEDULER_CONFIG },
			clock: fixture.clock,
			memory: {
				thresholds: HEALTHY_THRESHOLDS,
				sample: vi.fn(async () => HEALTHY_SAMPLE),
			},
			launchd: {
				kickstart: vi.fn(async () => {
					throw new Error("launchctl failed");
				}),
			},
			restartGate: gate,
		});

		expect(result.status).toBe("partial");
		expect(result.failed).toBe(1);
		expect(gate.recordFailure).toHaveBeenCalledWith("lead.flywheel-eng", 7);
		expect(
			fixture.kernel.read((tx) =>
				tx.get<{
					failure_count: number;
					last_result: string;
					next_attempt_at: string;
				}>(
					`SELECT failure_count,last_result,next_attempt_at
					 FROM scheduler_repair_leases
					 WHERE agent_id='eng' AND generation=3`,
				),
			),
		).toEqual({
			failure_count: 1,
			last_result: "failed",
			next_attempt_at: "2026-07-27T00:01:06.000Z",
		});
	});

	it("does not claim, crash, kickstart, or touch the restart ledger when memory is unknown", async () => {
		const fixture = makeFixture();
		const gate = makeGate();
		const kickstart = vi.fn();
		const result = await runSchedulerOnce({
			kernel: fixture.kernel,
			runId: "run-memory",
			backend: "launchd",
			host: "host-a",
			projectName: "flywheel",
			uid: 501,
			config: { ...DEFAULT_SCHEDULER_CONFIG },
			clock: fixture.clock,
			memory: {
				thresholds: HEALTHY_THRESHOLDS,
				sample: vi.fn(async () => null),
			},
			launchd: { kickstart },
			restartGate: gate,
		});

		expect(result.memoryLimited).toBe(1);
		expect(kickstart).not.toHaveBeenCalled();
		expect(gate.status).not.toHaveBeenCalled();
		expect(gate.recordFailure).not.toHaveBeenCalled();
		expect(
			fixture.kernel.read((tx) =>
				tx.get<{ outcome: string }>(
					"SELECT outcome FROM processing_attempts WHERE attempt_uid='attempt-1'",
				),
			),
		).toEqual({ outcome: "running" });
	});

	it("lets the held brake own the only Lead alert and never calls launchctl", async () => {
		const fixture = makeFixture();
		const gate = makeGate("held_alert_pending");
		const kickstart = vi.fn();
		const result = await runSchedulerOnce({
			kernel: fixture.kernel,
			runId: "run-held",
			backend: "launchd",
			host: "host-a",
			projectName: "flywheel",
			uid: 501,
			config: { ...DEFAULT_SCHEDULER_CONFIG },
			clock: fixture.clock,
			memory: {
				thresholds: HEALTHY_THRESHOLDS,
				sample: vi.fn(async () => HEALTHY_SAMPLE),
			},
			launchd: { kickstart },
			restartGate: gate,
		});

		expect(result.held).toBe(1);
		expect(kickstart).not.toHaveBeenCalled();
		expect(gate.recordFailure).toHaveBeenCalledWith("lead.flywheel-eng", 7);
	});

	it("grows healthy AIMD capacity and repairs two candidates concurrently in one tick", async () => {
		const fixture = makeFixture();
		seedCandidate(fixture, "ops", 2);
		seedCandidate(fixture, "qa", 3);
		const gate = makeGate();
		const config = {
			...DEFAULT_SCHEDULER_CONFIG,
			restartConcurrencyMax: 2,
			healthyIncreaseWindowMs: 10,
		};
		let concurrent = 0;
		let maxConcurrent = 0;
		let secondWaveArrivals = 0;
		let releaseSecondWave: (() => void) | undefined;
		const secondWaveReady = new Promise<void>((resolve) => {
			releaseSecondWave = resolve;
		});
		const kickstart = vi.fn(async (jobLabel: string) => {
			const agentId = jobLabel.endsWith("-eng")
				? "eng"
				: jobLabel.endsWith("-ops")
					? "ops"
					: "qa";
			if (agentId === "eng") {
				// The first repair occupies capacity=1. Its healthy runtime spans
				// one complete quiet window, allowing the next wave to grow to 2.
				fixture.clock.now += config.healthyIncreaseWindowMs;
			} else {
				concurrent++;
				maxConcurrent = Math.max(maxConcurrent, concurrent);
				secondWaveArrivals++;
				if (secondWaveArrivals === 2) releaseSecondWave?.();
				await Promise.race([
					secondWaveReady,
					new Promise<void>((resolve) => setTimeout(resolve, 50)),
				]);
			}
			fixture.kernel.write(`test.progress.${agentId}`, (tx) => {
				tx.run(
					`UPDATE agents
					    SET generation=4,
					        instance_id=@instanceId,
					        session_binding=@sessionBinding,
					        last_poll_at=@now
					 WHERE agent_id=@agentId AND generation=3`,
					{
						agentId,
						instanceId: `instance-${agentId}-4`,
						sessionBinding: sessionBinding(agentId, 4),
						now: fixture.clock.nowIso(),
					},
				);
			});
			if (agentId !== "eng") concurrent--;
		});

		const result = await runSchedulerOnce({
			kernel: fixture.kernel,
			runId: "run-capacity",
			backend: "launchd",
			host: "host-a",
			projectName: "flywheel",
			uid: 501,
			config,
			clock: fixture.clock,
			memory: {
				thresholds: HEALTHY_THRESHOLDS,
				sample: vi.fn(async () => HEALTHY_SAMPLE),
			},
			launchd: { kickstart },
			restartGate: gate,
		});

		expect(result).toEqual({
			status: "succeeded",
			candidates: 3,
			restarted: 3,
			held: 0,
			failed: 0,
			memoryLimited: 0,
		});
		expect(kickstart).toHaveBeenCalledTimes(3);
		expect(maxConcurrent).toBe(2);
	});
});
