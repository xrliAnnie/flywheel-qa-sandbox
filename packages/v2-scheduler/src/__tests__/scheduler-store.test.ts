import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, migrateDatabase } from "flywheel-v2-kernel";
import { afterEach, describe, expect, it } from "vitest";
import {
	claimHeartbeatRepair,
	finishSchedulerRun,
	listStaleLeadCandidates,
	startSchedulerRun,
} from "../scheduler-store.js";

interface Fixture {
	dir: string;
	path: string;
	kernel: Kernel;
}

const fixtures: Fixture[] = [];

function sessionBinding(agentId: string, generation: number): string {
	return JSON.stringify({
		v: 1,
		host_epoch: "host-1",
		session_id: `session-${agentId}-${generation}`,
		pid: 10_000 + generation,
		pid_start: `start-${agentId}-${generation}`,
	});
}

function makeFixture(): Fixture {
	const dir = mkdtempSync(join(tmpdir(), "flywheel-v2-scheduler-store-"));
	const path = join(dir, "flywheel-v2.db");
	migrateDatabase({ path });
	const kernel = Kernel.open({ path });
	const fixture = { dir, path, kernel };
	fixtures.push(fixture);
	return fixture;
}

function seedAgent(
	fixture: Fixture,
	args: {
		agentId: string;
		kind?: "lead" | "runner";
		generation?: number;
		lastPollAt?: string | null;
		state?: "online" | "offline";
		pending?: boolean;
		running?: boolean;
	},
): void {
	fixture.kernel.write("test.seed-agent", (tx) => {
		const generation = args.generation ?? 3;
		tx.run(
			`INSERT INTO agents(
			   agent_id,kind,generation,instance_id,session_binding,last_poll_at,state
			 )
			 VALUES (
			   @agentId,@kind,@generation,@instanceId,@sessionBinding,@lastPollAt,@state
			 )`,
			{
				agentId: args.agentId,
				kind: args.kind ?? "lead",
				generation,
				instanceId: `instance-${args.agentId}-${generation}`,
				sessionBinding: sessionBinding(args.agentId, generation),
				lastPollAt:
					args.lastPollAt === undefined
						? "2026-07-27T00:00:00.000Z"
						: args.lastPollAt,
				state: args.state ?? "online",
			},
		);
		if (args.pending !== false) {
			tx.run(
				`INSERT INTO mailbox
				 (message_uid,source_kind,source_id,payload,payload_digest,to_agent,kind,
				  retention_class,cutover_epoch,state,retry_count,next_retry_at,created_at)
				 VALUES (@messageUid,'lead',@sourceId,'{}','digest',@agentId,'instruction',
				  'business',1,'pending',0,NULL,'2026-07-27T00:00:00.000Z')`,
				{
					messageUid: `message-${args.agentId}`,
					sourceId: `source-${args.agentId}`,
					agentId: args.agentId,
				},
			);
			if (args.running) {
				tx.run(
					`INSERT INTO processing_attempts
					 (attempt_uid,message_uid,attempt_no,instance_id,generation,activation_id,
					  started_at,outcome)
					 VALUES (@attemptUid,@messageUid,1,'instance',@generation,NULL,
					  '2026-07-27T00:00:01.000Z','running')`,
					{
						attemptUid: `attempt-${args.agentId}`,
						messageUid: `message-${args.agentId}`,
						generation,
					},
				);
			}
		}
	});
}

afterEach(() => {
	for (const fixture of fixtures.splice(0)) {
		fixture.kernel.close();
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

describe("scheduler durable store", () => {
	it("records bounded runs and advances success heartbeat only for a complete sweep", () => {
		const fixture = makeFixture();
		expect(
			startSchedulerRun(fixture.kernel, {
				runId: "run-1",
				backend: "launchd",
				host: "host-a",
				nowIso: "2026-07-27T00:01:00.000Z",
				leaseExpiresAt: "2026-07-27T00:02:00.000Z",
			}),
		).toBe(true);
		expect(
			startSchedulerRun(fixture.kernel, {
				runId: "run-2",
				backend: "launchd",
				host: "host-a",
				nowIso: "2026-07-27T00:01:01.000Z",
				leaseExpiresAt: "2026-07-27T00:02:01.000Z",
			}),
		).toBe(false);

		finishSchedulerRun(fixture.kernel, {
			runId: "run-1",
			result: "partial",
			detail: "one repair failed",
			nowIso: "2026-07-27T00:01:10.000Z",
		});
		expect(
			fixture.kernel.read((tx) =>
				tx.get<{ value: string }>(
					"SELECT value FROM meta WHERE key='last_scheduler_success_at'",
				),
			),
		).toBeUndefined();

		expect(
			startSchedulerRun(fixture.kernel, {
				runId: "run-3",
				backend: "launchd",
				host: "host-a",
				nowIso: "2026-07-27T00:01:11.000Z",
				leaseExpiresAt: "2026-07-27T00:02:11.000Z",
			}),
		).toBe(true);
		finishSchedulerRun(fixture.kernel, {
			runId: "run-3",
			result: "succeeded",
			detail: "{}",
			nowIso: "2026-07-27T00:01:12.000Z",
		});
		expect(
			fixture.kernel.read((tx) =>
				tx.get<{ value: string }>(
					"SELECT value FROM meta WHERE key='last_scheduler_success_at'",
				),
			),
		).toEqual({ value: "2026-07-27T00:01:12.000Z" });
	});

	it("selects only online stale Leads with pending mail and a known heartbeat", () => {
		const fixture = makeFixture();
		seedAgent(fixture, { agentId: "stale" });
		seedAgent(fixture, {
			agentId: "fresh",
			lastPollAt: "2026-07-27T00:00:50.000Z",
		});
		seedAgent(fixture, { agentId: "unknown", lastPollAt: null });
		seedAgent(fixture, { agentId: "runner", kind: "runner" });
		seedAgent(fixture, { agentId: "offline", state: "offline" });
		seedAgent(fixture, { agentId: "empty", pending: false });

		expect(
			listStaleLeadCandidates(fixture.kernel, {
				staleBeforeIso: "2026-07-27T00:00:30.000Z",
				limit: 20,
			}),
		).toEqual([
			{
				agentId: "stale",
				generation: 3,
				lastPollAt: "2026-07-27T00:00:00.000Z",
			},
		]);
	});

	it("claims the exact generation and atomically crashes its running processing attempt", () => {
		const fixture = makeFixture();
		seedAgent(fixture, { agentId: "eng", running: true });
		expect(
			claimHeartbeatRepair(fixture.kernel, {
				runId: "run-1",
				agentId: "eng",
				generation: 3,
				observedLastPollAt: "2026-07-27T00:00:00.000Z",
				staleBeforeIso: "2026-07-27T00:00:30.000Z",
				nowIso: "2026-07-27T00:01:00.000Z",
				leaseExpiresAt: "2026-07-27T00:02:00.000Z",
			}),
		).toEqual({
			agentId: "eng",
			generation: 3,
			lastPollAt: "2026-07-27T00:00:00.000Z",
			crashedAttempts: 1,
			failureCount: 0,
		});
		expect(
			fixture.kernel.read((tx) =>
				tx.get<{ outcome: string; settled_at: string }>(
					"SELECT outcome,settled_at FROM processing_attempts WHERE attempt_uid='attempt-eng'",
				),
			),
		).toEqual({
			outcome: "crashed",
			settled_at: "2026-07-27T00:01:00.000Z",
		});
		expect(
			claimHeartbeatRepair(fixture.kernel, {
				runId: "run-2",
				agentId: "eng",
				generation: 3,
				observedLastPollAt: "2026-07-27T00:00:00.000Z",
				staleBeforeIso: "2026-07-27T00:00:30.000Z",
				nowIso: "2026-07-27T00:01:01.000Z",
				leaseExpiresAt: "2026-07-27T00:02:01.000Z",
			}),
		).toBeNull();
	});

	it("does not acquire a lease or settle work after generation or heartbeat drift", () => {
		const fixture = makeFixture();
		seedAgent(fixture, { agentId: "eng", running: true });
		expect(
			claimHeartbeatRepair(fixture.kernel, {
				runId: "run-1",
				agentId: "eng",
				generation: 2,
				observedLastPollAt: "2026-07-27T00:00:00.000Z",
				staleBeforeIso: "2026-07-27T00:00:30.000Z",
				nowIso: "2026-07-27T00:01:00.000Z",
				leaseExpiresAt: "2026-07-27T00:02:00.000Z",
			}),
		).toBeNull();
		expect(
			fixture.kernel.read((tx) =>
				tx.get<{ outcome: string }>(
					"SELECT outcome FROM processing_attempts WHERE attempt_uid='attempt-eng'",
				),
			),
		).toEqual({ outcome: "running" });
		expect(
			fixture.kernel.read((tx) =>
				tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM scheduler_repair_leases",
				),
			),
		).toEqual({ count: 0 });
	});
});
