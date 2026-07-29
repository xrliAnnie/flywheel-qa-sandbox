import { Kernel } from "flywheel-v2-kernel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineDriver } from "../driver.js";
import { enqueue, provisionAgentRecipient } from "../enqueue.js";
import { registerAgentTx } from "../registration.js";
import {
	EngineConfigError,
	type PollResult,
	type RegisteredAgent,
} from "../types.js";
import {
	type EngineFixture,
	enqueueMailbox,
	makeEngineFixture,
	seedRunnerActivation,
	testSessionBinding,
} from "./helpers.js";

// QA (FLY-1499) — independent verification of the mapping-v2final.md contract.
//
// These tests deliberately drive the REAL public entry points (EngineDriver.poll /
// submitProposal / reportConversionFailure / registerAgentTx) instead of the
// `selectNext` pure function, because the mapping's fairness, liveness and
// fail-closed claims are about what a shell actually observes, not about the
// selector in isolation. Each durable-predicate test also carries a positive
// control so a green assertion cannot be vacuous.

const LEAD_DRAFT = {
	kind: "lead",
	leadId: "lead-a",
	instanceId: "instance-1",
	sessionBinding: testSessionBinding("instance-1"),
} as const;

function attachedRunner(
	fixture: EngineFixture,
	driver: EngineDriver,
	agentId = "runner-a",
): Promise<void> {
	const activationId = seedRunnerActivation(fixture, agentId);
	const runner = fixture.kernel.write("qa.register-runner", (tx) =>
		registerAgentTx(tx, fixture.runtime, agentId, {
			kind: "runner",
			agentId,
			instanceId: `instance-${agentId}`,
			activationId,
			sessionBinding: testSessionBinding(`instance-${agentId}`),
		}),
	) as RegisteredAgent;
	return driver.attachRunner(agentId, runner);
}

/** Poll one message and settle it successfully; returns the served message uid. */
function serveOne(driver: EngineDriver, agentId = "runner-a"): string {
	const result: PollResult = driver.poll(agentId);
	if (result.status !== "available") {
		throw new Error(`expected available, got ${result.status}`);
	}
	driver.submitProposal({ handle: result.handle, effects: [] });
	return result.handle.messageUid;
}

function setConfig(fixture: EngineFixture, key: string, value: string): void {
	fixture.kernel.write("qa.set-config", (tx) => {
		tx.cas("UPDATE config SET value=@value WHERE key=@key", { key, value });
	});
}

function setCreatedAt(
	fixture: EngineFixture,
	messageUid: string,
	iso: string,
): void {
	fixture.kernel.write("qa.backdate-message", (tx) => {
		tx.cas("UPDATE mailbox SET created_at=@iso WHERE message_uid=@uid", {
			uid: messageUid,
			iso,
		});
	});
}

describe("QA FLY-1499 — fairness observed through the real poll path", () => {
	let fixture: EngineFixture | undefined;
	let driver: EngineDriver | undefined;

	afterEach(() => {
		try {
			driver?.stop();
		} catch {
			// A test may deliberately leave a fenced attempt behind.
		}
		fixture?.cleanup();
		driver = undefined;
		fixture = undefined;
	});

	it("never serves more than vip_burst founder messages between two normal ones", async () => {
		fixture = makeEngineFixture();
		// n0 first so the conservative restart streak (=K) has debt to repay,
		// then a founder flood, then one more normal message that the K bound
		// must rescue from starvation.
		enqueueMailbox(fixture, {
			uid: "n0",
			agent: "runner-a",
			agentKind: "runner",
			sourceKind: "lead",
		});
		for (const uid of ["f1", "f2", "f3", "f4", "f5", "f6"]) {
			enqueueMailbox(fixture, {
				uid,
				agent: "runner-a",
				agentKind: "runner",
				sourceKind: "founder",
			});
		}
		enqueueMailbox(fixture, {
			uid: "n1",
			agent: "runner-a",
			agentKind: "runner",
			sourceKind: "lead",
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await attachedRunner(fixture, driver);

		const served: string[] = [];
		for (let index = 0; index < 8; index++) served.push(serveOne(driver));

		// K=4: the conservative restart pays the normal message first, then at
		// most four founder messages may run before n1 is forced through.
		expect(served).toEqual(["n0", "f1", "f2", "f3", "f4", "n1", "f5", "f6"]);
		expect(driver.poll("runner-a").status).toBe("empty");
	});

	it("drains a 120-message mixed backlog serially with no starvation and no leaks", async () => {
		fixture = makeEngineFixture();
		// 3:1 founder-heavy traffic — the shape that starves normal messages if the
		// bound is only checked at small scale.
		const expectedUids: string[] = [];
		for (let index = 0; index < 120; index++) {
			const founder = index % 4 !== 3;
			const uid = `${founder ? "f" : "n"}${index}`;
			expectedUids.push(uid);
			enqueueMailbox(fixture, {
				uid,
				agent: "runner-a",
				agentKind: "runner",
				sourceKind: founder ? "founder" : "lead",
			});
		}
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await attachedRunner(fixture, driver);

		const served: string[] = [];
		let maxRunning = 0;
		for (;;) {
			const polled = driver.poll("runner-a");
			if (polled.status === "empty") break;
			if (polled.status !== "available") {
				throw new Error(`unexpected ${polled.status}`);
			}
			maxRunning = Math.max(
				maxRunning,
				fixture.kernel.read(
					(tx) =>
						tx.get<{ count: number }>(
							"SELECT count(*) AS count FROM processing_attempts WHERE outcome='running'",
						)?.count ?? 0,
				),
			);
			driver.submitProposal({ handle: polled.handle, effects: [] });
			served.push(polled.handle.messageUid);
		}

		// batch=1: never two in-flight attempts for the same recipient.
		expect(maxRunning).toBe(1);
		// Every message reaches a terminal state exactly once, nothing is lost.
		expect(served).toHaveLength(120);
		expect([...served].sort()).toEqual([...expectedUids].sort());
		expect(
			fixture.kernel.read((tx) => ({
				pending: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM mailbox WHERE state<>'applied'",
				)?.count,
				attempts: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM processing_attempts",
				)?.count,
				succeeded: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM processing_attempts WHERE outcome='succeeded'",
				)?.count,
			})),
		).toEqual({ pending: 0, attempts: 120, succeeded: 120 });

		// No starvation anywhere in the run: the founder lane never holds the
		// consumer for more than K=4 consecutive picks.
		let run = 0;
		let longestFounderRun = 0;
		for (const uid of served) {
			run = uid.startsWith("f") ? run + 1 : 0;
			longestFounderRun = Math.max(longestFounderRun, run);
		}
		expect(longestFounderRun).toBeLessThanOrEqual(4);
	});

	it("takes a durable vip_burst change into effect on the very next poll", async () => {
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, {
			uid: "n0",
			agent: "runner-a",
			agentKind: "runner",
			sourceKind: "lead",
		});
		for (const uid of ["f1", "f2"]) {
			enqueueMailbox(fixture, {
				uid,
				agent: "runner-a",
				agentKind: "runner",
				sourceKind: "founder",
			});
		}
		enqueueMailbox(fixture, {
			uid: "n1",
			agent: "runner-a",
			agentKind: "runner",
			sourceKind: "lead",
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await attachedRunner(fixture, driver);
		// Changed AFTER the driver seeded its in-memory streak from config, so a
		// cached second truth would keep the K=4 ordering below.
		setConfig(fixture, "mailbox.vip_burst", "1");

		const served: string[] = [];
		for (let index = 0; index < 4; index++) served.push(serveOne(driver));

		expect(served).toEqual(["n0", "f1", "n1", "f2"]);
	});

	it("promotes an aged normal message ahead of a newer founder message", async () => {
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, {
			uid: "seed",
			agent: "runner-a",
			agentKind: "runner",
			sourceKind: "lead",
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await attachedRunner(fixture, driver);
		// Repay the conservative restart debt so the next pick is decided by the
		// founder-class rule rather than by the quota.
		expect(serveOne(driver)).toBe("seed");

		enqueueMailbox(fixture, {
			uid: "f-new",
			agent: "runner-a",
			agentKind: "runner",
			sourceKind: "founder",
		});
		enqueueMailbox(fixture, {
			uid: "n-old",
			agent: "runner-a",
			agentKind: "runner",
			sourceKind: "lead",
		});
		setCreatedAt(
			fixture,
			"n-old",
			new Date(fixture.clock.nowMs() - 31 * 60_000).toISOString(),
		);

		expect(serveOne(driver)).toBe("n-old");
	});

	it("positive control: without promotion age reached, the founder message wins", async () => {
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, {
			uid: "seed",
			agent: "runner-a",
			agentKind: "runner",
			sourceKind: "lead",
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await attachedRunner(fixture, driver);
		expect(serveOne(driver)).toBe("seed");

		enqueueMailbox(fixture, {
			uid: "f-new",
			agent: "runner-a",
			agentKind: "runner",
			sourceKind: "founder",
		});
		enqueueMailbox(fixture, {
			uid: "n-old",
			agent: "runner-a",
			agentKind: "runner",
			sourceKind: "lead",
		});
		// 29 minutes < the 30 minute promotion age: the same shape as the test
		// above must now select the founder message.
		setCreatedAt(
			fixture,
			"n-old",
			new Date(fixture.clock.nowMs() - 29 * 60_000).toISOString(),
		);

		expect(serveOne(driver)).toBe("f-new");
	});
});

describe("QA FLY-1499 — config is the single durable truth", () => {
	let fixture: EngineFixture | undefined;
	let driver: EngineDriver | undefined;

	afterEach(() => {
		try {
			driver?.stop();
		} catch {
			// ignore
		}
		fixture?.cleanup();
		driver = undefined;
		fixture = undefined;
	});

	it("reflects a durable poll_interval_ms change in the very next empty result", async () => {
		fixture = makeEngineFixture();
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.registerLead("lead-a", LEAD_DRAFT, async () => ({
			ok: true,
			effects: [],
		}));
		await driver.drain("lead-a");
		expect(driver.poll("lead-a")).toEqual({
			status: "empty",
			retryAfterMs: 1_000,
		});

		setConfig(fixture, "mailbox.poll_interval_ms", "2500");
		expect(driver.poll("lead-a")).toEqual({
			status: "empty",
			retryAfterMs: 2_500,
		});
	});

	it("fails closed on broken config instead of reporting an empty mailbox", async () => {
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, {
			uid: "m1",
			agent: "runner-a",
			agentKind: "runner",
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await attachedRunner(fixture, driver);
		fixture.kernel.write("qa.break-config", (tx) => {
			tx.run("DELETE FROM config WHERE key='mailbox.vip_burst'");
		});

		expect(() => driver?.poll("runner-a")).toThrow(EngineConfigError);
		expect(
			fixture.kernel.read((tx) => ({
				mailbox: tx.get<{ state: string }>(
					"SELECT state FROM mailbox WHERE message_uid='m1'",
				)?.state,
				attempts: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM processing_attempts",
				)?.count,
			})),
		).toEqual({ mailbox: "pending", attempts: 0 });
	});
});

describe("QA FLY-1499 — liveness without doorbell, timer or watchdog", () => {
	let fixture: EngineFixture | undefined;
	let driver: EngineDriver | undefined;

	afterEach(() => {
		try {
			driver?.stop();
		} catch {
			// ignore
		}
		fixture?.cleanup();
		driver = undefined;
		fixture = undefined;
	});

	it("reaches a retried message by polling alone once its backoff is due", async () => {
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, {
			uid: "m1",
			agent: "runner-a",
			agentKind: "runner",
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await attachedRunner(fixture, driver);
		const first = driver.poll("runner-a");
		if (first.status !== "available") throw new Error("expected available");
		driver.reportConversionFailure(first.handle, "boom");

		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ next_retry_at: string }>(
						"SELECT next_retry_at FROM mailbox WHERE message_uid='m1'",
					)?.next_retry_at,
			),
		).toBe(new Date(fixture.clock.nowMs() + 30_000).toISOString());
		// Not yet due: no doorbell exists, and polling must not resurrect it early.
		expect(driver.poll("runner-a").status).toBe("empty");

		fixture.clock.advance(30_000);
		const second = driver.poll("runner-a");
		expect(second.status).toBe("available");
		if (second.status !== "available") throw new Error("unreachable");
		expect(second.handle.attemptUid).toBe("m1#2");
		expect(second.resumed).toBe(false);
		driver.submitProposal({ handle: second.handle, effects: [] });
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ state: string }>(
						"SELECT state FROM mailbox WHERE message_uid='m1'",
					)?.state,
			),
		).toBe("applied");
	});

	it("exposes a wedged handler by durable attempt age even while heartbeat stays fresh", async () => {
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, {
			uid: "m1",
			agent: "runner-a",
			agentKind: "runner",
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await attachedRunner(fixture, driver);
		const started = driver.poll("runner-a");
		if (started.status !== "available") throw new Error("expected available");

		// The shell keeps its cadence: heartbeat is refreshed, so a heartbeat-only
		// detector would call this agent healthy.
		fixture.clock.advance(31 * 60_000);
		expect(driver.poll("runner-a", started.handle.attemptUid)).toEqual({
			status: "busy",
			attemptUid: "m1#1",
		});

		const wedged = () =>
			fixture?.kernel.read((tx) => {
				const config = tx.get<{ value: string }>(
					"SELECT value FROM config WHERE key='mailbox.running_attempt_max_age_ms'",
				);
				const heartbeatFresh = tx.get<{ count: number }>(
					`SELECT count(*) AS count FROM agents
					 WHERE agent_id='runner-a' AND last_poll_at >= @fresh`,
					{
						fresh: new Date(fixture?.clock.nowMs() ?? 0 - 30_000).toISOString(),
					},
				)?.count;
				const stale = tx.all<{ attempt_uid: string }>(
					`SELECT pa.attempt_uid FROM processing_attempts pa
					 WHERE pa.outcome='running' AND pa.started_at <= @cutoff`,
					{
						cutoff: new Date(
							(fixture?.clock.nowMs() ?? 0) - Number(config?.value),
						).toISOString(),
					},
				);
				return { heartbeatFresh, stale: stale.map((row) => row.attempt_uid) };
			});

		expect(wedged()).toEqual({ heartbeatFresh: 1, stale: ["m1#1"] });

		// Once the short conversion settles, hours-long downstream work must not
		// keep the agent flagged: the mailbox attempt is no longer running.
		driver.submitProposal({ handle: started.handle, effects: [] });
		expect(wedged()).toEqual({ heartbeatFresh: 1, stale: [] });
	});

	it("keeps a cold-start address durably detectable until it registers", async () => {
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, {
			uid: "m1",
			agent: "lead-cold",
			agentKind: "lead",
		});

		const coldStart = () =>
			fixture?.kernel.read((tx) => {
				const ageMs = Number(
					tx.get<{ value: string }>(
						"SELECT value FROM config WHERE key='mailbox.cold_start_alert_after_ms'",
					)?.value,
				);
				return tx
					.all<{ agent_id: string }>(
						`SELECT a.agent_id FROM agents a
						 WHERE a.generation=0 AND a.state='offline'
						   AND EXISTS(SELECT 1 FROM mailbox m
						              WHERE m.to_agent=a.agent_id AND m.state='pending'
						                AND m.created_at <= @cutoff)`,
						{
							cutoff: new Date(
								(fixture?.clock.nowMs() ?? 0) - ageMs,
							).toISOString(),
						},
					)
					.map((row) => row.agent_id);
			});

		expect(coldStart()).toEqual([]);
		fixture.clock.advance(5 * 60_000);
		expect(coldStart()).toEqual(["lead-cold"]);

		fixture.kernel.write("qa.cold-start-registers", (tx) =>
			registerAgentTx(tx, fixture?.runtime as never, "lead-cold", {
				kind: "lead",
				leadId: "lead-cold",
				instanceId: "instance-cold",
				sessionBinding: testSessionBinding("instance-cold"),
			}),
		);
		expect(coldStart()).toEqual([]);
	});
});

describe("QA FLY-1499 — deleted disposal semantics stay deleted at runtime", () => {
	let fixture: EngineFixture | undefined;
	let driver: EngineDriver | undefined;

	afterEach(() => {
		try {
			driver?.stop();
		} catch {
			// ignore
		}
		fixture?.cleanup();
		driver = undefined;
		fixture = undefined;
	});

	it("leaves pending mail untouched when the activation goes terminal and the agent goes offline", async () => {
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, {
			uid: "b1",
			agent: "runner-a",
			agentKind: "runner",
			retentionClass: "business",
		});
		enqueueMailbox(fixture, {
			uid: "n1",
			agent: "runner-a",
			agentKind: "runner",
			retentionClass: "notice",
		});
		enqueueMailbox(fixture, {
			uid: "d1",
			agent: "runner-a",
			agentKind: "runner",
			retentionClass: "dlq",
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await attachedRunner(fixture, driver);
		driver.stop();
		driver = undefined;
		fixture.kernel.write("qa.terminate-activation", (tx) => {
			tx.run("UPDATE activations SET state='terminal' WHERE state='active'");
		});

		expect(
			fixture.kernel.read((tx) =>
				tx.all<{ message_uid: string; state: string; to_agent: string }>(
					"SELECT message_uid,state,to_agent FROM mailbox ORDER BY seq",
				),
			),
		).toEqual([
			{ message_uid: "b1", state: "pending", to_agent: "runner-a" },
			{ message_uid: "n1", state: "pending", to_agent: "runner-a" },
			{ message_uid: "d1", state: "pending", to_agent: "runner-a" },
		]);
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ state: string }>(
						"SELECT state FROM agents WHERE agent_id='runner-a'",
					)?.state,
			),
		).toBe("offline");
	});

	it("structurally rejects the removed tombstoned mailbox state", () => {
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, { uid: "m1", agent: "lead-a" });
		expect(() =>
			fixture?.kernel.write("qa.try-tombstone", (tx) => {
				tx.run("UPDATE mailbox SET state='tombstoned' WHERE message_uid='m1'");
			}),
		).toThrow(/CHECK constraint failed/);
	});
});

describe("QA FLY-1499 — generation fence across two connections", () => {
	let fixture: EngineFixture | undefined;
	let driver: EngineDriver | undefined;
	let other: Kernel | undefined;

	afterEach(() => {
		try {
			driver?.stop();
		} catch {
			// ignore
		}
		other?.close();
		fixture?.cleanup();
		driver = undefined;
		other = undefined;
		fixture = undefined;
	});

	it("fences a stale driver's poll, settlement and stop after a foreign cutover", async () => {
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, {
			uid: "m1",
			agent: "runner-a",
			agentKind: "runner",
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await attachedRunner(fixture, driver);
		const inFlight = driver.poll("runner-a");
		if (inFlight.status !== "available") throw new Error("expected available");

		// A separate connection performs the generation cutover, exactly as a
		// supervisor process would after confirming the old shell is gone.
		other = Kernel.open({ path: fixture.path });
		const activationId = seedRunnerActivation(fixture, "runner-a", 2);
		other.write("qa.foreign-cutover", (tx) =>
			registerAgentTx(
				tx,
				fixture?.runtime as never,
				"runner-a",
				{
					kind: "runner",
					agentId: "runner-a",
					instanceId: "instance-successor",
					activationId,
					sessionBinding: testSessionBinding("instance-successor"),
				},
				{
					agentId: "runner-a",
					generation: 1,
					confirmedAbsentAt: fixture.clock.nowIso(),
				},
			),
		);

		expect(() => driver?.poll("runner-a")).toThrow(/generation is not current/);
		expect(() =>
			driver?.submitProposal({ handle: inFlight.handle, effects: [] }),
		).toThrow(/generation is not current/);
		driver.stop();
		driver = undefined;

		expect(
			fixture.kernel.read((tx) => ({
				agent: tx.get<{ generation: number; state: string }>(
					"SELECT generation,state FROM agents WHERE agent_id='runner-a'",
				),
				attempt: tx.get<{ outcome: string }>(
					"SELECT outcome FROM processing_attempts WHERE attempt_uid='m1#1'",
				)?.outcome,
				mailbox: tx.get<{ state: string; retry_count: number }>(
					"SELECT state,retry_count FROM mailbox WHERE message_uid='m1'",
				),
			})),
		).toEqual({
			// A stale stop() must never drag the live successor offline.
			agent: { generation: 2, state: "online" },
			attempt: "crashed",
			mailbox: { state: "pending", retry_count: 1 },
		});
	});

	it("fences a second live shell that shares the generation but not the instance", async () => {
		fixture = makeEngineFixture();
		const activationId = seedRunnerActivation(fixture, "runner-a");
		const agent = fixture.kernel.write("qa.register-runner", (tx) =>
			registerAgentTx(tx, fixture?.runtime as never, "runner-a", {
				kind: "runner",
				agentId: "runner-a",
				instanceId: "instance-1",
				activationId,
				sessionBinding: testSessionBinding("instance-1"),
			}),
		) as RegisteredAgent;
		enqueueMailbox(fixture, {
			uid: "m1",
			agent: "runner-a",
			agentKind: "runner",
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.attachRunner("runner-a", agent);
		expect(driver.poll("runner-a").status).toBe("available");

		// A duplicate launch that never went through a generation cutover must not
		// be handed the in-flight attempt as a second delivery.
		other = Kernel.open({ path: fixture.path });
		const duplicate = new EngineDriver(other, fixture.runtime);
		await expect(
			duplicate.attachRunner("runner-a", {
				...agent,
				instanceId: "instance-2",
				sessionBinding: testSessionBinding("instance-2"),
			} as RegisteredAgent),
		).rejects.toThrow(/not current/);
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ count: number }>(
						"SELECT count(*) AS count FROM processing_attempts",
					)?.count,
			),
		).toBe(1);
	});

	it("emits exactly one dead-letter event when the final attempt dies in a cutover", async () => {
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, {
			uid: "m1",
			agent: "runner-a",
			agentKind: "runner",
		});
		setConfig(fixture, "mailbox.max_attempts", "2");
		fixture.kernel.write("qa.preload-retry", (tx) => {
			tx.cas("UPDATE mailbox SET retry_count=1 WHERE message_uid='m1'");
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await attachedRunner(fixture, driver);
		expect(driver.poll("runner-a").status).toBe("available");

		const activationId = seedRunnerActivation(fixture, "runner-a", 2);
		fixture.kernel.write("qa.cutover-to-dead", (tx) =>
			registerAgentTx(
				tx,
				fixture?.runtime as never,
				"runner-a",
				{
					kind: "runner",
					agentId: "runner-a",
					instanceId: "instance-successor",
					activationId,
					sessionBinding: testSessionBinding("instance-successor"),
				},
				{
					agentId: "runner-a",
					generation: 1,
					confirmedAbsentAt: fixture.clock.nowIso(),
				},
			),
		);
		driver = undefined;

		expect(
			fixture.kernel.read((tx) => ({
				mailbox: tx.get<{ state: string; retry_count: number }>(
					"SELECT state,retry_count FROM mailbox WHERE message_uid='m1'",
				),
				attempt: tx.get<{ outcome: string }>(
					"SELECT outcome FROM processing_attempts WHERE attempt_uid='m1#1'",
				)?.outcome,
				deadEvents: tx.all<{ event_uid: string; source_id: string }>(
					"SELECT event_uid,source_id FROM events WHERE kind='mailbox.dead'",
				),
			})),
		).toEqual({
			mailbox: { state: "dead", retry_count: 2 },
			attempt: "crashed",
			deadEvents: [{ event_uid: "mailbox:m1:dead", source_id: "runner-a" }],
		});
	});
});

describe("QA FLY-1499 — admission boundary is really typed and FK-backed", () => {
	let fixture: EngineFixture | undefined;

	afterEach(() => {
		fixture?.cleanup();
		fixture = undefined;
	});

	it("keeps the agents foreign key as the last line of defense under a raw insert", () => {
		fixture = makeEngineFixture();
		// enqueue() rejects unknown recipients itself; this asserts the structural
		// backstop the mapping relies on when a future writer bypasses that check.
		expect(() =>
			fixture?.kernel.write("qa.raw-unknown-recipient", (tx) => {
				tx.run(
					`INSERT INTO mailbox
					 (message_uid,source_kind,source_id,payload,payload_digest,to_agent,kind,
					  retention_class,cutover_epoch,state,retry_count,created_at)
					 VALUES ('x','lead','sx','{}','digest','nobody','instruction','business',
					  1,'pending',0,@now)`,
					{ now: fixture?.clock.nowIso() },
				);
			}),
		).toThrow(/FOREIGN KEY constraint failed/);
	});

	it("measures notice admission against the recipient's whole pending backlog", () => {
		fixture = makeEngineFixture();
		provisionAgentRecipient(fixture.kernel, "lead-a", "lead");
		setConfig(fixture, "mailbox.notice_pending_limit", "2");
		const post = (sourceId: string, retentionClass: "business" | "notice") =>
			enqueue(fixture?.kernel as Kernel, fixture?.runtime as never, {
				sourceKind: "lead",
				sourceId,
				payload: "{}",
				toAgent: "lead-a",
				kind: "instruction",
				retentionClass,
				expectedCutoverEpoch: 1,
			});

		for (const id of ["biz-1", "biz-2", "biz-3"]) {
			expect(post(id, "business").status).toBe("enqueued");
		}
		// Documented consequence of counting every pending row: a business backlog
		// above the notice水位 throttles notices for that recipient. Business itself
		// is never throttled by the same水位 — asserted immediately below.
		expect(post("notice-1", "notice")).toEqual({
			status: "rejected",
			reason: "overload",
		});
		expect(post("biz-4", "business").status).toBe("enqueued");
	});
});

describe("QA FLY-1499 — one message is converted exactly once", () => {
	let fixture: EngineFixture | undefined;
	let driver: EngineDriver | undefined;

	afterEach(() => {
		try {
			driver?.stop();
		} catch {
			// ignore
		}
		fixture?.cleanup();
		driver = undefined;
		fixture = undefined;
	});

	it("does not re-convert an in-flight lead message when the shell polls with a stale uid", async () => {
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, { uid: "m1", agent: "lead-a" });
		let release: (() => void) | undefined;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const converter = vi.fn(async () => {
			await blocked;
			return { ok: true as const, effects: [] };
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.registerLead("lead-a", LEAD_DRAFT, converter);
		await vi.waitFor(() => expect(converter).toHaveBeenCalledTimes(1));

		// A shell that lost track of its own attempt uid must be handed the same
		// in-flight attempt back (documented stale-hint behaviour), never a second
		// message and never a second conversion of the same one.
		const stale = driver.poll("lead-a", "does-not-exist#9");
		expect(stale.status).toBe("available");
		if (stale.status !== "available") throw new Error("unreachable");
		expect(stale.handle.attemptUid).toBe("m1#1");
		expect(stale.resumed).toBe(true);
		expect(converter).toHaveBeenCalledTimes(1);
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ count: number }>(
						"SELECT count(*) AS count FROM processing_attempts",
					)?.count,
			),
		).toBe(1);

		release?.();
		await driver.drain("lead-a");
		expect(converter).toHaveBeenCalledTimes(1);
		expect(
			fixture.kernel.read((tx) => ({
				mailbox: tx.get<{ state: string }>(
					"SELECT state FROM mailbox WHERE message_uid='m1'",
				)?.state,
				applied: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM events WHERE kind='mailbox.applied'",
				)?.count,
			})),
		).toEqual({ mailbox: "applied", applied: 1 });
	});
});
