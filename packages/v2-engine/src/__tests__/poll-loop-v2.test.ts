import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineDriver } from "../driver.js";
import { registerAgentTx } from "../registration.js";
import {
	type ConversionResult,
	PollTransientError,
	type RegisteredAgent,
} from "../types.js";
import {
	type EngineFixture,
	enqueueMailbox,
	makeEngineFixture,
	seedRunnerActivation,
} from "./helpers.js";

const LEAD_DRAFT = {
	kind: "lead",
	leadId: "lead-a",
	instanceId: "instance-1",
} as const;

describe("serial explicit mailbox polling", () => {
	let fixture: EngineFixture | undefined;
	let driver: EngineDriver | undefined;

	afterEach(() => {
		driver?.stop();
		fixture?.cleanup();
		driver = undefined;
		fixture = undefined;
	});

	it("pulls immediately after registration and rechecks one-at-a-time until empty", async () => {
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, { uid: "m1", agent: "lead-a" });
		enqueueMailbox(fixture, { uid: "m2", agent: "lead-a" });
		const order: string[] = [];
		const converter = vi.fn(
			async (message: { messageUid: string }): Promise<ConversionResult> => {
				order.push(message.messageUid);
				return { ok: true, effects: [] };
			},
		);
		driver = new EngineDriver(fixture.kernel, fixture.runtime);

		await driver.registerLead("lead-a", LEAD_DRAFT, converter);
		await driver.drain("lead-a");

		expect(order).toEqual(["m1", "m2"]);
		expect(converter).toHaveBeenCalledTimes(2);
		expect(
			fixture.kernel.read((tx) =>
				tx.all<{ message_uid: string; state: string }>(
					"SELECT message_uid,state FROM mailbox ORDER BY seq",
				),
			),
		).toEqual([
			{ message_uid: "m1", state: "applied" },
			{ message_uid: "m2", state: "applied" },
		]);
	});

	it("rejects a runner identity passed through the lead registration API", async () => {
		fixture = makeEngineFixture();
		driver = new EngineDriver(fixture.kernel, fixture.runtime);

		await expect(
			driver.registerLead(
				"runner-a",
				{
					kind: "runner",
					agentId: "runner-a",
					instanceId: "instance-1",
					activationId: "activation-1",
				} as never,
				async () => ({ ok: true, effects: [] }),
			),
		).rejects.toThrow("registerLead requires a lead identity");
	});

	it("keeps heartbeat cadence alive while one converter is blocked without redelivery or a second start", async () => {
		vi.useFakeTimers();
		try {
			fixture = makeEngineFixture();
			enqueueMailbox(fixture, { uid: "m1", agent: "lead-a" });
			enqueueMailbox(fixture, { uid: "m2", agent: "lead-a" });
			let release: (() => void) | undefined;
			const blocked = new Promise<void>((resolve) => {
				release = resolve;
			});
			const converter = vi.fn(async (message: { messageUid: string }) => {
				if (message.messageUid === "m1") await blocked;
				return { ok: true as const, effects: [] };
			});
			driver = new EngineDriver(fixture.kernel, fixture.runtime);
			await driver.registerLead("lead-a", LEAD_DRAFT, converter);
			expect(converter).toHaveBeenCalledTimes(1);

			const firstPollAt = fixture.kernel.read(
				(tx) =>
					tx.get<{ last_poll_at: string }>(
						"SELECT last_poll_at FROM agents WHERE agent_id='lead-a'",
					)?.last_poll_at,
			);
			fixture.clock.advance(5_000);
			await vi.advanceTimersByTimeAsync(5_000);
			expect(
				fixture.kernel.read(
					(tx) =>
						tx.get<{ last_poll_at: string }>(
							"SELECT last_poll_at FROM agents WHERE agent_id='lead-a'",
						)?.last_poll_at,
				),
			).not.toBe(firstPollAt);
			expect(converter).toHaveBeenCalledTimes(1);
			expect(
				fixture.kernel.read(
					(tx) =>
						tx.get<{ count: number }>(
							"SELECT count(*) AS count FROM processing_attempts WHERE outcome='running'",
						)?.count,
				),
			).toBe(1);

			release?.();
			await driver.drain("lead-a");
			expect(converter).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("surfaces an asynchronous lead settlement error on the next shell poll", async () => {
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, { uid: "m1", agent: "lead-a" });
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.registerLead("lead-a", LEAD_DRAFT, async () => ({
			ok: true,
			effects: [
				{
					kind: "event",
					eventKind: "proposal.prelude",
					payload: "{}",
				},
				{
					kind: "task",
					taskKind: "invalid-follow-up",
					state: "ready",
					payload: "{}",
					projectId: "project-a",
					lineageRootTaskId: "missing-task",
				},
			],
		}));

		await vi.waitFor(() =>
			expect(() => driver?.poll("lead-a")).toThrow(
				/FOREIGN KEY constraint failed/,
			),
		);
	});

	it("retries a transient lead settlement error by resuming the durable running attempt", async () => {
		fixture = makeEngineFixture(50);
		enqueueMailbox(fixture, { uid: "m1", agent: "lead-a" });
		const locker = new Database(fixture.path);
		let lockHeld = false;
		const converter = vi.fn(async () => {
			if (!lockHeld) {
				locker.exec("BEGIN IMMEDIATE");
				lockHeld = true;
			}
			return { ok: true as const, effects: [] };
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.registerLead("lead-a", LEAD_DRAFT, converter);

		await expect(driver.drain("lead-a")).rejects.toBeInstanceOf(
			PollTransientError,
		);
		locker.exec("ROLLBACK");
		locker.close();

		expect(driver.poll("lead-a").status).toBe("available");
		await driver.drain("lead-a");
		expect(converter).toHaveBeenCalledTimes(2);
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ state: string }>(
						"SELECT state FROM mailbox WHERE message_uid='m1'",
					)?.state,
			),
		).toBe("applied");
	});

	it("does not fence on agents.state and lets heartbeat reassert online observation", async () => {
		fixture = makeEngineFixture();
		const activationId = seedRunnerActivation(fixture);
		const runner = fixture.kernel.write("test.register-runner", (tx) =>
			registerAgentTx(tx, fixture?.runtime as never, "runner-a", {
				kind: "runner",
				agentId: "runner-a",
				instanceId: "instance-1",
				activationId,
			}),
		);
		enqueueMailbox(fixture, {
			uid: "m1",
			agent: "runner-a",
			agentKind: "runner",
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.attachRunner("runner-a", runner);
		fixture.kernel.write("test.scheduler-observation", (tx) => {
			tx.run("UPDATE agents SET state='offline' WHERE agent_id='runner-a'");
		});

		const result = driver.poll("runner-a");
		expect(result.status).toBe("available");
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ state: string }>(
						"SELECT state FROM agents WHERE agent_id='runner-a'",
					)?.state,
			),
		).toBe("online");
	});

	it("treats a settled currentAttemptUid as stale and hands the next available runner message through", async () => {
		fixture = makeEngineFixture();
		const activationId = seedRunnerActivation(fixture);
		const runner = fixture.kernel.write("test.register-runner", (tx) =>
			registerAgentTx(tx, fixture?.runtime as never, "runner-a", {
				kind: "runner",
				agentId: "runner-a",
				instanceId: "instance-1",
				activationId,
			}),
		);
		enqueueMailbox(fixture, {
			uid: "m1",
			agent: "runner-a",
			agentKind: "runner",
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.attachRunner("runner-a", runner);
		const first = driver.poll("runner-a");
		if (first.status !== "available") throw new Error("expected available");
		driver.submitProposal({ handle: first.handle, effects: [] });
		enqueueMailbox(fixture, {
			uid: "m2",
			agent: "runner-a",
			agentKind: "runner",
		});

		const second = driver.poll("runner-a", first.handle.attemptUid);
		expect(second.status).toBe("available");
		if (second.status === "available") {
			expect(second.handle.messageUid).toBe("m2");
		}
	});

	it("fails closed when a busy uid is bound to a foreign audit identity", async () => {
		fixture = makeEngineFixture();
		const activationId = seedRunnerActivation(fixture);
		const runner = fixture.kernel.write("test.register-runner", (tx) =>
			registerAgentTx(tx, fixture?.runtime as never, "runner-a", {
				kind: "runner",
				agentId: "runner-a",
				instanceId: "instance-1",
				activationId,
			}),
		);
		enqueueMailbox(fixture, {
			uid: "m1",
			agent: "runner-a",
			agentKind: "runner",
		});
		fixture.kernel.write("test.seed-foreign-running", (tx) => {
			tx.run(
				`INSERT INTO processing_attempts
				 (attempt_uid,message_uid,attempt_no,instance_id,generation,activation_id,started_at,outcome)
				 VALUES ('m1#1','m1',1,'foreign-instance',1,@activationId,@now,'running')`,
				{ activationId, now: fixture?.clock.nowIso() },
			);
			tx.run(
				`UPDATE agents SET last_poll_at=@now
				 WHERE agent_id='runner-a' AND generation=1`,
				{ now: fixture?.clock.nowIso() },
			);
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.attachRunner("runner-a", runner);

		expect(() => driver?.poll("runner-a", "m1#1")).toThrow(
			/attempt binding mismatch/,
		);
		driver = undefined;
	});

	it("coalesces empty heartbeat writes until the configured interval", async () => {
		fixture = makeEngineFixture();
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.registerLead("lead-a", LEAD_DRAFT, async () => ({
			ok: true,
			effects: [],
		}));
		await driver.drain("lead-a");
		const first = fixture.kernel.read(
			(tx) =>
				tx.get<{ last_poll_at: string }>(
					"SELECT last_poll_at FROM agents WHERE agent_id='lead-a'",
				)?.last_poll_at,
		);

		fixture.clock.advance(1_000);
		expect(driver.poll("lead-a")).toEqual({
			status: "empty",
			retryAfterMs: 1_000,
		});
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ last_poll_at: string }>(
						"SELECT last_poll_at FROM agents WHERE agent_id='lead-a'",
					)?.last_poll_at,
			),
		).toBe(first);
		fixture.clock.advance(4_000);
		expect(driver.poll("lead-a").status).toBe("empty");
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ last_poll_at: string }>(
						"SELECT last_poll_at FROM agents WHERE agent_id='lead-a'",
					)?.last_poll_at,
			),
		).not.toBe(first);
	});

	it("starts conservatively at the VIP bound so an existing normal message gets service first", async () => {
		fixture = makeEngineFixture();
		const activationId = seedRunnerActivation(fixture);
		const runner = fixture.kernel.write("test.register-runner", (tx) =>
			registerAgentTx(tx, fixture?.runtime as never, "runner-a", {
				kind: "runner",
				agentId: "runner-a",
				instanceId: "instance-1",
				activationId,
			}),
		) as RegisteredAgent;
		enqueueMailbox(fixture, {
			uid: "founder",
			agent: "runner-a",
			agentKind: "runner",
			sourceKind: "founder",
		});
		enqueueMailbox(fixture, {
			uid: "normal",
			agent: "runner-a",
			agentKind: "runner",
			sourceKind: "lead",
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.attachRunner("runner-a", runner);

		const first = driver.poll("runner-a");
		expect(first.status === "available" && first.handle.messageUid).toBe(
			"normal",
		);
	});

	it("gracefully stops its own running attempt exactly once before going offline", async () => {
		fixture = makeEngineFixture();
		const activationId = seedRunnerActivation(fixture);
		const runner = fixture.kernel.write("test.register-runner", (tx) =>
			registerAgentTx(tx, fixture?.runtime as never, "runner-a", {
				kind: "runner",
				agentId: "runner-a",
				instanceId: "instance-1",
				activationId,
			}),
		);
		enqueueMailbox(fixture, {
			uid: "m1",
			agent: "runner-a",
			agentKind: "runner",
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.attachRunner("runner-a", runner);
		const polled = driver.poll("runner-a");
		if (polled.status !== "available") throw new Error("expected available");

		driver.stop();
		driver.stop();
		expect(
			fixture.kernel.read((tx) => ({
				agent: tx.get<{ state: string }>(
					"SELECT state FROM agents WHERE agent_id='runner-a'",
				)?.state,
				attempt: tx.get<{ outcome: string }>(
					"SELECT outcome FROM processing_attempts WHERE attempt_uid='m1#1'",
				)?.outcome,
				retry: tx.get<{ retry_count: number }>(
					"SELECT retry_count FROM mailbox WHERE message_uid='m1'",
				)?.retry_count,
			})),
		).toEqual({ agent: "offline", attempt: "crashed", retry: 1 });
		expect(() =>
			driver?.submitProposal({ handle: polled.handle, effects: [] }),
		).toThrow();
	});

	it("continues stopping later agents after one agent fails its running-attempt fence", async () => {
		fixture = makeEngineFixture();
		const activationA = seedRunnerActivation(fixture, "runner-a");
		const activationB = seedRunnerActivation(fixture, "runner-b");
		const runnerA = fixture.kernel.write("test.register-runner-a", (tx) =>
			registerAgentTx(tx, fixture?.runtime as never, "runner-a", {
				kind: "runner",
				agentId: "runner-a",
				instanceId: "instance-a",
				activationId: activationA,
			}),
		);
		const runnerB = fixture.kernel.write("test.register-runner-b", (tx) =>
			registerAgentTx(tx, fixture?.runtime as never, "runner-b", {
				kind: "runner",
				agentId: "runner-b",
				instanceId: "instance-b",
				activationId: activationB,
			}),
		);
		enqueueMailbox(fixture, {
			uid: "m-a",
			agent: "runner-a",
			agentKind: "runner",
		});
		enqueueMailbox(fixture, {
			uid: "m-b",
			agent: "runner-b",
			agentKind: "runner",
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.attachRunner("runner-a", runnerA);
		await driver.attachRunner("runner-b", runnerB);
		expect(driver.poll("runner-a").status).toBe("available");
		expect(driver.poll("runner-b").status).toBe("available");
		fixture.kernel.write("test.corrupt-runner-a-audit", (tx) => {
			tx.run(
				"UPDATE processing_attempts SET instance_id='foreign' WHERE attempt_uid='m-a#1'",
			);
		});

		expect(() => driver?.stop()).toThrow(AggregateError);
		expect(
			fixture.kernel.read((tx) => ({
				agentB: tx.get<{ state: string }>(
					"SELECT state FROM agents WHERE agent_id='runner-b'",
				)?.state,
				attemptB: tx.get<{ outcome: string }>(
					"SELECT outcome FROM processing_attempts WHERE attempt_uid='m-b#1'",
				)?.outcome,
				retryB: tx.get<{ retry_count: number }>(
					"SELECT retry_count FROM mailbox WHERE message_uid='m-b'",
				)?.retry_count,
			})),
		).toEqual({ agentB: "offline", attemptB: "crashed", retryB: 1 });
	});
});
