import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineDriver } from "../driver.js";
import { type ConversionResult, PollTransientError } from "../types.js";
import {
	type EngineFixture,
	enqueueMailbox,
	makeEngineFixture,
	testSessionBinding,
} from "./helpers.js";

const LEAD_DRAFT = {
	kind: "lead",
	leadId: "lead-a",
	instanceId: "instance-1",
	sessionBinding: testSessionBinding("instance-1"),
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
					sessionBinding: testSessionBinding("instance-1"),
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
});
