import { afterEach, describe, expect, it } from "vitest";
import { EngineDriver } from "../driver.js";
import { registerAgentTx } from "../registration.js";
import {
	type EngineFixture,
	enqueueMailbox,
	makeEngineFixture,
	seedRunnerActivation,
} from "./helpers.js";

function registerRunner(fixture: EngineFixture) {
	const activationId = seedRunnerActivation(fixture);
	return fixture.kernel.write("test.register-runner", (tx) =>
		registerAgentTx(tx, fixture.runtime, "runner-a", {
			kind: "runner",
			agentId: "runner-a",
			instanceId: "instance-1",
			activationId,
		}),
	);
}

describe("transactional mailbox settlement", () => {
	let fixture: EngineFixture | undefined;
	let driver: EngineDriver | undefined;

	afterEach(() => {
		driver?.stop();
		fixture?.cleanup();
		driver = undefined;
		fixture = undefined;
	});

	it("commits proposal effects, mailbox applied, and attempt succeeded atomically", async () => {
		fixture = makeEngineFixture();
		const runner = registerRunner(fixture);
		enqueueMailbox(fixture, {
			uid: "m1",
			agent: "runner-a",
			agentKind: "runner",
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.attachRunner("runner-a", runner);
		const result = driver.poll("runner-a");
		if (result.status !== "available") throw new Error("expected available");

		driver.submitProposal({
			handle: result.handle,
			effects: [
				{
					kind: "task",
					taskKind: "follow-up",
					state: "ready",
					payload: "{}",
					projectId: "project-a",
				},
			],
		});
		expect(
			fixture.kernel.read((tx) => ({
				mailbox: tx.get<{ state: string }>(
					"SELECT state FROM mailbox WHERE message_uid='m1'",
				)?.state,
				attempt: tx.get<{ outcome: string }>(
					"SELECT outcome FROM processing_attempts WHERE attempt_uid='m1#1'",
				)?.outcome,
				tasks: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM tasks WHERE kind='follow-up'",
				)?.count,
				appliedEvents: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM events WHERE kind='mailbox.applied'",
				)?.count,
			})),
		).toEqual({
			mailbox: "applied",
			attempt: "succeeded",
			tasks: 1,
			appliedEvents: 1,
		});
	});

	it("rolls proposal effects and settlement back together on an effect FK failure", async () => {
		fixture = makeEngineFixture();
		const runner = registerRunner(fixture);
		enqueueMailbox(fixture, {
			uid: "m1",
			agent: "runner-a",
			agentKind: "runner",
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.attachRunner("runner-a", runner);
		const result = driver.poll("runner-a");
		if (result.status !== "available") throw new Error("expected available");

		expect(() =>
			driver?.submitProposal({
				handle: result.handle,
				effects: [
					{
						kind: "command",
						commandKind: "invalid",
						payload: "{}",
						effectKey: "invalid-effect",
						taskId: "missing-task",
					},
				],
			}),
		).toThrow();
		expect(
			fixture.kernel.read((tx) => ({
				mailbox: tx.get<{ state: string }>(
					"SELECT state FROM mailbox WHERE message_uid='m1'",
				)?.state,
				attempt: tx.get<{ outcome: string }>(
					"SELECT outcome FROM processing_attempts WHERE attempt_uid='m1#1'",
				)?.outcome,
				commands: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM commands WHERE effect_key='invalid-effect'",
				)?.count,
			})),
		).toEqual({ mailbox: "pending", attempt: "running", commands: 0 });
	});

	it("uses durable max-attempts and emits one exact agent-scoped dead event", async () => {
		fixture = makeEngineFixture();
		const runner = registerRunner(fixture);
		enqueueMailbox(fixture, {
			uid: "m1",
			agent: "runner-a",
			agentKind: "runner",
		});
		fixture.kernel.write("test.configure-dead", (tx) => {
			tx.run("UPDATE config SET value='2' WHERE key='mailbox.max_attempts'");
			tx.run("UPDATE mailbox SET retry_count=1 WHERE message_uid='m1'");
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.attachRunner("runner-a", runner);
		const result = driver.poll("runner-a");
		if (result.status !== "available") throw new Error("expected available");

		driver.reportConversionFailure(result.handle, "conversion failed");
		expect(
			fixture.kernel.read((tx) => ({
				mailbox: tx.get<{ state: string; retry_count: number }>(
					"SELECT state,retry_count FROM mailbox WHERE message_uid='m1'",
				),
				attempt: tx.get<{ outcome: string }>(
					"SELECT outcome FROM processing_attempts WHERE attempt_uid='m1#1'",
				)?.outcome,
				event: tx.get<{
					event_uid: string;
					kind: string;
					source_kind: string;
					source_id: string;
					payload: string;
				}>(
					`SELECT event_uid,kind,source_kind,source_id,payload
					 FROM events WHERE event_uid='mailbox:m1:dead'`,
				),
			})),
		).toEqual({
			mailbox: { state: "dead", retry_count: 2 },
			attempt: "failed",
			event: {
				event_uid: "mailbox:m1:dead",
				kind: "mailbox.dead",
				source_kind: "agent",
				source_id: "runner-a",
				payload: '{"message_uid":"m1","attempt_uid":"m1#1","generation":1}',
			},
		});
		expect(() =>
			driver?.reportConversionFailure(result.handle, "late replay"),
		).toThrow();
	});

	it("rolls attempt and mailbox back when the deterministic dead event collides", async () => {
		fixture = makeEngineFixture();
		const runner = registerRunner(fixture);
		enqueueMailbox(fixture, {
			uid: "m1",
			agent: "runner-a",
			agentKind: "runner",
		});
		fixture.kernel.write("test.seed-collision", (tx) => {
			tx.run("UPDATE config SET value='2' WHERE key='mailbox.max_attempts'");
			tx.run("UPDATE mailbox SET retry_count=1 WHERE message_uid='m1'");
			tx.run(
				`INSERT INTO events
				 (event_uid,kind,source_kind,source_id,payload,cutover_epoch,created_at)
				 VALUES ('mailbox:m1:dead','wrong','agent','runner-a','{}',1,@now)`,
				{ now: fixture?.clock.nowIso() },
			);
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.attachRunner("runner-a", runner);
		const result = driver.poll("runner-a");
		if (result.status !== "available") throw new Error("expected available");

		expect(() =>
			driver?.reportConversionFailure(result.handle, "conversion failed"),
		).toThrow(/dead event collision/);
		expect(
			fixture.kernel.read((tx) => ({
				mailbox: tx.get<{ state: string; retry_count: number }>(
					"SELECT state,retry_count FROM mailbox WHERE message_uid='m1'",
				),
				attempt: tx.get<{ outcome: string }>(
					"SELECT outcome FROM processing_attempts WHERE attempt_uid='m1#1'",
				)?.outcome,
			})),
		).toEqual({
			mailbox: { state: "pending", retry_count: 1 },
			attempt: "running",
		});
		// The deliberate collision leaves the attempt running; a second graceful
		// settlement must fail loudly for the same reason, so skip stop in cleanup.
		driver = undefined;
	});
});
