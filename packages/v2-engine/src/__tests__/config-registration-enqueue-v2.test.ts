import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FenceViolation, Kernel, migrateDatabase } from "flywheel-v2-kernel";
import { afterEach, describe, expect, it } from "vitest";
import { initializeEngineDb } from "../bootstrap.js";
import { readEngineConfigTx } from "../config.js";
import { enqueue, provisionAgentRecipient } from "../enqueue.js";
import { registerAgentTx } from "../registration.js";
import {
	DEFAULT_ENGINE_CONFIG,
	EngineConfigError,
	type EngineRuntime,
} from "../types.js";

class Clock {
	#now = Date.parse("2026-07-28T00:00:00.000Z");

	nowMs(): number {
		return this.#now;
	}

	nowIso(): string {
		return new Date(this.#now).toISOString();
	}
}

interface Fixture {
	dir: string;
	kernel: Kernel;
	runtime: EngineRuntime;
	cleanup(): void;
}

function makeFixture(): Fixture {
	const dir = mkdtempSync(join(tmpdir(), "flywheel-v2-engine-next-"));
	const path = join(dir, "flywheel-v2.db");
	migrateDatabase({ path });
	const kernel = Kernel.open({ path });
	initializeEngineDb(kernel);
	const runtime = { clock: new Clock() };
	return {
		dir,
		kernel,
		runtime,
		cleanup() {
			kernel.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

const LEAD_DRAFT = {
	kind: "lead",
	leadId: "lead-a",
	instanceId: "instance-1",
} as const;

describe("durable config, address allocation, and generation registration", () => {
	let fixture: Fixture | undefined;

	afterEach(() => {
		fixture?.cleanup();
		fixture = undefined;
	});

	it("seeds eleven durable config keys once and reads the exact validated shape", () => {
		fixture = makeFixture();
		expect(
			fixture.kernel.read((tx) =>
				tx.all<{ key: string; value: string }>(
					"SELECT key,value FROM config ORDER BY key",
				),
			),
		).toHaveLength(11);
		expect(fixture.kernel.read((tx) => readEngineConfigTx(tx))).toEqual(
			DEFAULT_ENGINE_CONFIG,
		);

		fixture.kernel.write("test.override-config", (tx) => {
			tx.run("UPDATE config SET value='7' WHERE key='mailbox.vip_burst'");
		});
		initializeEngineDb(fixture.kernel);
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ value: string }>(
						"SELECT value FROM config WHERE key='mailbox.vip_burst'",
					)?.value,
			),
		).toBe("7");
	});

	it.each([
		["missing", "DELETE FROM config WHERE key='mailbox.max_attempts'"],
		[
			"non-canonical",
			"UPDATE config SET value='01' WHERE key='mailbox.max_attempts'",
		],
		[
			"out-of-range",
			"UPDATE config SET value='1' WHERE key='mailbox.max_attempts'",
		],
		[
			"cross-field",
			"UPDATE config SET value='1000' WHERE key='mailbox.heartbeat_stale_after_ms'",
		],
	])("fails closed for %s config", (_name, sql) => {
		fixture = makeFixture();
		fixture.kernel.write("test.break-config", (tx) => {
			tx.run(sql);
		});
		expect(() => fixture?.kernel.read((tx) => readEngineConfigTx(tx))).toThrow(
			EngineConfigError,
		);
	});

	it("provisions an offline generation-zero address idempotently and rejects kind collisions", () => {
		fixture = makeFixture();
		expect(provisionAgentRecipient(fixture.kernel, "lead-a", "lead")).toEqual({
			agentId: "lead-a",
			kind: "lead",
			generation: 0,
			lastPollAt: null,
			state: "offline",
		});
		expect(provisionAgentRecipient(fixture.kernel, "lead-a", "lead")).toEqual({
			agentId: "lead-a",
			kind: "lead",
			generation: 0,
			lastPollAt: null,
			state: "offline",
		});
		expect(() =>
			provisionAgentRecipient(fixture?.kernel as Kernel, "lead-a", "runner"),
		).toThrow(FenceViolation);
	});

	it("supports self-first generation one, preprovisioned zero-to-one, and exact old-generation cutover", () => {
		fixture = makeFixture();
		const first = fixture.kernel.write("test.register-first", (tx) =>
			registerAgentTx(
				tx,
				fixture?.runtime as EngineRuntime,
				"lead-a",
				LEAD_DRAFT,
			),
		);
		expect(first).toEqual({
			kind: "lead",
			agentId: "lead-a",
			instanceId: "instance-1",
			generation: 1,
		});

		provisionAgentRecipient(fixture.kernel, "lead-b", "lead");
		const preprovisioned = fixture.kernel.write(
			"test.register-preprovisioned",
			(tx) =>
				registerAgentTx(tx, fixture?.runtime as EngineRuntime, "lead-b", {
					...LEAD_DRAFT,
					leadId: "lead-b",
				}),
		);
		expect(preprovisioned.generation).toBe(1);

		fixture.kernel.write("test.seed-running", (tx) => {
			tx.run(
				`INSERT INTO mailbox
				 (message_uid,source_kind,source_id,payload,payload_digest,to_agent,kind,
				  retention_class,cutover_epoch,state,retry_count,created_at)
				 VALUES ('m1','lead','source-m1','{}','digest','lead-a','instruction',
				  'business',1,'pending',0,@now)`,
				{ now: fixture?.runtime.clock.nowIso() },
			);
			tx.run(
				`INSERT INTO processing_attempts
				 (attempt_uid,message_uid,attempt_no,instance_id,generation,activation_id,started_at,outcome)
				 VALUES ('m1#1','m1',1,'instance-1',1,NULL,@now,'running')`,
				{ now: fixture?.runtime.clock.nowIso() },
			);
		});
		const second = fixture.kernel.write("test.cutover", (tx) =>
			registerAgentTx(
				tx,
				fixture?.runtime as EngineRuntime,
				"lead-a",
				{ ...LEAD_DRAFT, instanceId: "instance-2" },
				{
					agentId: "lead-a",
					generation: 1,
					confirmedAbsentAt: fixture?.runtime.clock.nowIso() as string,
				},
			),
		);
		expect(second.generation).toBe(2);
		expect(
			fixture.kernel.read((tx) => ({
				attempt: tx.get<{ outcome: string }>(
					"SELECT outcome FROM processing_attempts WHERE attempt_uid='m1#1'",
				)?.outcome,
				mailbox: tx.get<{ retry_count: number }>(
					"SELECT retry_count FROM mailbox WHERE message_uid='m1'",
				)?.retry_count,
			})),
		).toEqual({ attempt: "crashed", mailbox: 1 });
	});

	it("cuts a runner over without coupling agent generation to the task attempt generation", () => {
		fixture = makeFixture();
		fixture.kernel.write("test.seed-runner-attempt", (tx) => {
			tx.run(
				`INSERT INTO tasks
				 (id,project_id,kind,state,lineage_root_id,created_at)
				 VALUES ('task-a','project-a','build','running','task-a',@now)`,
				{ now: fixture?.runtime.clock.nowIso() },
			);
			tx.run(
				`INSERT INTO attempts
				 (id,task_id,generation,desired_state,observed_state,started_at)
				 VALUES ('attempt-a','task-a',1,'started','present',@now)`,
				{ now: fixture?.runtime.clock.nowIso() },
			);
			tx.run(
				`INSERT INTO activations(id,attempt_id,session_ref,generation,state)
				 VALUES ('activation-1','attempt-a','session-1',1,'active')`,
			);
		});
		const first = fixture.kernel.write("test.register-runner-one", (tx) =>
			registerAgentTx(tx, fixture?.runtime as EngineRuntime, "runner-a", {
				kind: "runner",
				agentId: "runner-a",
				instanceId: "instance-1",
				activationId: "activation-1",
			}),
		);
		fixture.kernel.write("test.rotate-runner-activation", (tx) => {
			tx.run("UPDATE activations SET state='terminal' WHERE id='activation-1'");
			tx.run(
				`INSERT INTO activations(id,attempt_id,session_ref,generation,state)
				 VALUES ('activation-2','attempt-a','session-2',1,'active')`,
			);
		});

		const second = fixture.kernel.write("test.register-runner-two", (tx) =>
			registerAgentTx(
				tx,
				fixture?.runtime as EngineRuntime,
				"runner-a",
				{
					kind: "runner",
					agentId: "runner-a",
					instanceId: "instance-2",
					activationId: "activation-2",
				},
				{
					agentId: "runner-a",
					generation: first.generation,
					confirmedAbsentAt: fixture?.runtime.clock.nowIso() as string,
				},
			),
		);

		expect(second).toEqual({
			kind: "runner",
			agentId: "runner-a",
			instanceId: "instance-2",
			activationId: "activation-2",
			generation: 2,
		});
	});

	it("accepts offline recipients, returns typed unknown-recipient, and parameterizes notice admission", () => {
		fixture = makeFixture();
		const base = {
			payload: "{}",
			toAgent: "lead-a",
			kind: "instruction",
			retentionClass: "notice" as const,
			expectedCutoverEpoch: 1,
		};
		expect(
			enqueue(fixture.kernel, fixture.runtime, {
				...base,
				sourceKind: "lead",
				sourceId: "unknown",
			}),
		).toEqual({ status: "rejected", reason: "unknown_recipient" });

		provisionAgentRecipient(fixture.kernel, "lead-a", "lead");
		fixture.kernel.write("test.notice-limit", (tx) => {
			tx.run(
				"UPDATE config SET value='2' WHERE key='mailbox.notice_pending_limit'",
			);
		});
		for (let index = 1; index <= 3; index++) {
			expect(
				enqueue(fixture.kernel, fixture.runtime, {
					...base,
					sourceKind: "lead",
					sourceId: `notice-${index}`,
				}).status,
			).toBe("enqueued");
		}
		expect(
			enqueue(fixture.kernel, fixture.runtime, {
				...base,
				sourceKind: "lead",
				sourceId: "notice-4",
			}),
		).toEqual({ status: "rejected", reason: "overload" });
	});
});
