/**
 * QA FLY-1518 — independent equivalence proof for the retired `commands` outbox.
 *
 * conversion-actions.test.ts asserts the seam's own return values. This suite
 * instead re-derives the guarantees the retired outbox used to provide and
 * checks each one against the *database*, through a second kernel connection
 * wherever durability is the claim:
 *
 *   O1 durable intent lands before the external effect runs;
 *   O2 at-most-once external effect across crash + generation takeover;
 *   O3 at-least-once delivery — a pre-intent crash loses nothing;
 *   O4 settlement stays atomic (effects + mailbox + attempt in one transaction);
 *   O5 ordering — the mailbox is never applied before the action outcome lands;
 *   O6 the retired tables are gone and any surviving writer fails loudly.
 *
 * Crashes are simulated the production way: abandon the driver without settling,
 * then take the agent over in a new generation with death evidence.
 */
import { Kernel } from "flywheel-v2-kernel";
import { afterEach, describe, expect, it } from "vitest";
import { EngineDriver } from "../driver.js";
import { registerAgentTx } from "../registration.js";
import type {
	AttemptHandle,
	ConversionContext,
	ConversionResult,
	RegisteredAgent,
} from "../types.js";
import {
	type EngineFixture,
	enqueueMailbox,
	makeEngineFixture,
	seedRunnerActivation,
	testSessionBinding,
} from "./helpers.js";

interface ActionRow {
	id: string;
	lid: string;
	state: string;
	result: string | null;
}

interface MailboxRow {
	state: string;
	applied_at: string | null;
}

/** Reads through an independent connection, so a passing row is a committed row. */
function readCommitted<Row>(
	fixture: EngineFixture,
	sql: string,
	params: Record<string, unknown> = {},
): Row[] {
	const observer = Kernel.open({ path: fixture.path });
	try {
		return observer.read((tx) => tx.all<Row>(sql, params));
	} finally {
		observer.close();
	}
}

const committedActions = (fixture: EngineFixture): ActionRow[] =>
	readCommitted<ActionRow>(
		fixture,
		`SELECT id, json_extract(payload,'$.lid') AS lid, state, result
		 FROM actions ORDER BY lid, created_at`,
	);

const committedMailbox = (fixture: EngineFixture, uid: string): MailboxRow =>
	readCommitted<MailboxRow>(
		fixture,
		"SELECT state, applied_at FROM mailbox WHERE message_uid=@uid",
		{ uid },
	)[0];

const countOf = (fixture: EngineFixture, table: string): number =>
	readCommitted<{ n: number }>(fixture, `SELECT count(*) AS n FROM ${table}`)[0]
		.n;

describe("QA FLY-1518 — commands outbox guarantees on pure actions", () => {
	let fixture: EngineFixture | undefined;
	const drivers: EngineDriver[] = [];

	afterEach(() => {
		for (const driver of drivers.splice(0)) {
			try {
				driver.stop();
			} catch {
				// A driver abandoned mid-action cannot stop; that is the simulated
				// crash, not a QA failure.
			}
		}
		fixture?.cleanup();
		fixture = undefined;
	});

	function newDriver(): EngineDriver {
		const driver = new EngineDriver(
			(fixture as EngineFixture).kernel,
			(fixture as EngineFixture).runtime,
		);
		drivers.push(driver);
		return driver;
	}

	function seedRunner(): RegisteredAgent {
		const activationId = seedRunnerActivation(fixture as EngineFixture);
		return (fixture as EngineFixture).kernel.write("qa.register-runner", (tx) =>
			registerAgentTx(tx, (fixture as EngineFixture).runtime, "runner-a", {
				kind: "runner",
				agentId: "runner-a",
				instanceId: "instance-1",
				activationId,
				sessionBinding: testSessionBinding("instance-1"),
			}),
		);
	}

	/** Confirmed-death takeover into the next generation. */
	function takeOverRunner(generation: number): RegisteredAgent {
		const target = fixture as EngineFixture;
		target.clock.advance(30_000);
		return target.kernel.write("qa.runner-takeover", (tx) =>
			registerAgentTx(
				tx,
				target.runtime,
				"runner-a",
				{
					kind: "runner",
					agentId: "runner-a",
					instanceId: `instance-${generation + 1}`,
					activationId: "activation-runner-a-1",
					sessionBinding: testSessionBinding(`instance-${generation + 1}`),
				},
				{
					agentId: "runner-a",
					generation,
					confirmedAbsentAt: target.clock.nowIso(),
				},
			),
		);
	}

	async function attachedRunner(
		agent: RegisteredAgent,
		advanceMsBeforePoll = 0,
	): Promise<{ driver: EngineDriver; handle: AttemptHandle }> {
		const driver = newDriver();
		await driver.attachRunner("runner-a", agent);
		if (advanceMsBeforePoll > 0) {
			(fixture as EngineFixture).clock.advance(advanceMsBeforePoll);
		}
		const polled = driver.poll("runner-a");
		if (polled.status !== "available") {
			throw new Error(`expected an available message, got ${polled.status}`);
		}
		return { driver, handle: polled.handle };
	}

	it("O1 commits the action intent before the external effect runs", async () => {
		fixture = makeEngineFixture();
		const agent = seedRunner();
		enqueueMailbox(fixture, {
			uid: "m-o1",
			agent: "runner-a",
			agentKind: "runner",
		});
		const { driver, handle } = await attachedRunner(agent);

		let seenFromInsidePerform: ActionRow[] = [];
		await driver.performConversionAction(
			handle,
			{
				kind: "qa.send",
				payload: { lid: "send-1", to: "discord" },
				logicalEffectId: "send-1",
			},
			() => {
				// Still inside the external effect: the intent must already be durable
				// on disk, exactly as the retired outbox row was.
				seenFromInsidePerform = committedActions(fixture as EngineFixture);
				return { messageId: "ext-1" };
			},
		);

		expect(seenFromInsidePerform).toHaveLength(1);
		expect(seenFromInsidePerform[0]).toMatchObject({
			lid: "send-1",
			state: "intended",
		});
		const settled = committedActions(fixture);
		expect(settled).toHaveLength(1);
		expect(settled[0].state).toBe("succeeded");
		expect(JSON.parse(settled[0].result as string)).toEqual({
			messageId: "ext-1",
		});
	});

	it("O2 performs the external effect exactly once across a crash and takeover", async () => {
		fixture = makeEngineFixture();
		const agent = seedRunner();
		enqueueMailbox(fixture, {
			uid: "m-o2",
			agent: "runner-a",
			agentKind: "runner",
		});
		let performCount = 0;
		const spec = {
			kind: "qa.send",
			payload: { lid: "send-1" },
			logicalEffectId: "send-1",
		} as const;

		const first = await attachedRunner(agent);
		const performed = await first.driver.performConversionAction(
			first.handle,
			spec,
			() => {
				performCount += 1;
				return { messageId: `ext-${performCount}` };
			},
		);
		expect(performed.disposition).toBe("performed");
		// Crash: the driver dies before it ever settles the message.
		first.driver.stop();
		expect(committedMailbox(fixture, "m-o2").state).not.toBe("applied");

		const second = await attachedRunner(takeOverRunner(1));
		const replayed = await second.driver.performConversionAction(
			second.handle,
			spec,
			() => {
				performCount += 1;
				return { messageId: `ext-${performCount}` };
			},
		);

		expect(replayed.disposition).toBe("replayed");
		expect(performCount).toBe(1); // at-most-once: the retry replayed, it did not resend
		const rows = committedActions(fixture);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: performed.action.id,
			state: "succeeded",
		});
		expect(JSON.parse(rows[0].result as string)).toEqual({
			messageId: "ext-1",
		});

		second.driver.submitProposal({ handle: second.handle, effects: [] });
		expect(committedMailbox(fixture, "m-o2").state).toBe("applied");
	});

	it("O3 loses nothing when the crash precedes any intent", async () => {
		fixture = makeEngineFixture();
		const agent = seedRunner();
		enqueueMailbox(fixture, {
			uid: "m-o3",
			agent: "runner-a",
			agentKind: "runner",
		});

		const first = await attachedRunner(agent);
		first.driver.stop(); // crash before a single action intent
		expect(countOf(fixture, "actions")).toBe(0);
		expect(committedMailbox(fixture, "m-o3").state).not.toBe("applied");

		let performCount = 0;
		const second = await attachedRunner(takeOverRunner(1));
		const performed = await second.driver.performConversionAction(
			second.handle,
			{
				kind: "qa.send",
				payload: { lid: "send-1" },
				logicalEffectId: "send-1",
			},
			() => {
				performCount += 1;
				return { messageId: "ext-1" };
			},
		);

		expect(performed.disposition).toBe("performed");
		expect(performCount).toBe(1);
		expect(committedActions(fixture)).toHaveLength(1);
		second.driver.submitProposal({ handle: second.handle, effects: [] });
		expect(committedMailbox(fixture, "m-o3").state).toBe("applied");
	});

	it("O4 rolls the whole settlement back when one effect violates a foreign key", async () => {
		fixture = makeEngineFixture();
		const agent = seedRunner();
		enqueueMailbox(fixture, {
			uid: "m-o4",
			agent: "runner-a",
			agentKind: "runner",
		});
		const { driver, handle } = await attachedRunner(agent);
		await driver.performConversionAction(
			handle,
			{
				kind: "qa.send",
				payload: { lid: "send-1" },
				logicalEffectId: "send-1",
			},
			() => ({ messageId: "ext-1" }),
		);
		const eventsBefore = countOf(fixture, "events");
		const tasksBefore = countOf(fixture, "tasks");

		expect(() =>
			driver.submitProposal({
				handle,
				effects: [
					// A legitimate leading effect: if only the failing one rolled back,
					// this one would survive and the atomicity claim would be false.
					{ kind: "event", eventKind: "qa.valid.event", payload: "{}" },
					{
						kind: "task",
						taskKind: "qa.task",
						state: "ready",
						payload: "{}",
						projectId: "project-a",
						lineageRootTaskId: "task-that-does-not-exist",
					},
				],
			}),
		).toThrow();

		expect(countOf(fixture, "events")).toBe(eventsBefore);
		expect(countOf(fixture, "tasks")).toBe(tasksBefore);
		const mailbox = committedMailbox(fixture, "m-o4");
		expect(mailbox.state).not.toBe("applied");
		expect(mailbox.applied_at).toBeNull();
		expect(
			readCommitted<{ outcome: string }>(
				fixture,
				"SELECT outcome FROM processing_attempts WHERE attempt_uid=@uid",
				{ uid: handle.attemptUid },
			)[0].outcome,
		).toBe("running");

		// The already-settled action outcome is untouched by the failed settlement.
		const rows = committedActions(fixture);
		expect(rows).toHaveLength(1);
		expect(rows[0].state).toBe("succeeded");
	});

	it("O5 never applies the mailbox before an unawaited lead action lands", async () => {
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, { uid: "m-o5", agent: "lead-qa" });
		let releasePerform: (() => void) | undefined;
		const performGate = new Promise<void>((resolve) => {
			releasePerform = resolve;
		});
		let mailboxWhilePending: MailboxRow | undefined;
		let actionStateWhilePending: string | undefined;
		let performCount = 0;

		const driver = newDriver();
		await driver.registerLead(
			"lead-qa",
			{
				kind: "lead",
				leadId: "lead-qa",
				instanceId: "instance-1",
				sessionBinding: testSessionBinding("instance-1"),
			},
			async (_message, ctx: ConversionContext): Promise<ConversionResult> => {
				// Deliberately NOT awaited: the driver's barrier, not the converter's
				// discipline, has to hold settlement back.
				void ctx.performAction(
					{
						kind: "qa.send",
						payload: { lid: "send-1" },
						logicalEffectId: "send-1",
					},
					async () => {
						performCount += 1;
						mailboxWhilePending = committedMailbox(
							fixture as EngineFixture,
							"m-o5",
						);
						actionStateWhilePending = committedActions(
							fixture as EngineFixture,
						)[0]?.state;
						await performGate;
						return { messageId: "ext-1" };
					},
				);
				return { ok: true, effects: [] };
			},
		);

		const drained = driver.drain("lead-qa");
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(performCount).toBe(1);
		expect(actionStateWhilePending).toBe("intended");
		expect(mailboxWhilePending?.state).not.toBe("applied");
		expect(committedMailbox(fixture, "m-o5").state).not.toBe("applied");

		releasePerform?.();
		await drained;

		expect(committedActions(fixture)[0].state).toBe("succeeded");
		expect(committedMailbox(fixture, "m-o5").state).toBe("applied");
	});

	it("O5b refuses direct settlement while a runner action is in flight", async () => {
		fixture = makeEngineFixture();
		const agent = seedRunner();
		enqueueMailbox(fixture, {
			uid: "m-o5b",
			agent: "runner-a",
			agentKind: "runner",
		});
		const { driver, handle } = await attachedRunner(agent);
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const pending = driver.performConversionAction(
			handle,
			{
				kind: "qa.send",
				payload: { lid: "send-1" },
				logicalEffectId: "send-1",
			},
			async () => {
				await gate;
				return { messageId: "ext-1" };
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(() => driver.submitProposal({ handle, effects: [] })).toThrow(
			/in flight/,
		);
		expect(() => driver.reportConversionFailure(handle, "qa")).toThrow(
			/in flight/,
		);
		expect(committedMailbox(fixture, "m-o5b").state).not.toBe("applied");

		release?.();
		await pending;
		driver.submitProposal({ handle, effects: [] });
		expect(committedMailbox(fixture, "m-o5b").state).toBe("applied");
	});

	it("O2b keeps two effects of one message independent and each exactly once", async () => {
		fixture = makeEngineFixture();
		const agent = seedRunner();
		enqueueMailbox(fixture, {
			uid: "m-o2b",
			agent: "runner-a",
			agentKind: "runner",
		});
		const performCounts = new Map<string, number>();
		const bump = (id: string) => {
			performCounts.set(id, (performCounts.get(id) ?? 0) + 1);
			return { ok: true };
		};

		const first = await attachedRunner(agent);
		await first.driver.performConversionAction(
			first.handle,
			{
				kind: "qa.send",
				payload: { lid: "notify-founder" },
				logicalEffectId: "notify-founder",
			},
			() => bump("notify-founder"),
		);
		first.driver.stop(); // crash between the first and second effect

		const second = await attachedRunner(takeOverRunner(1));
		const replayed = await second.driver.performConversionAction(
			second.handle,
			{
				kind: "qa.send",
				payload: { lid: "notify-founder" },
				logicalEffectId: "notify-founder",
			},
			() => bump("notify-founder"),
		);
		const fresh = await second.driver.performConversionAction(
			second.handle,
			{
				kind: "qa.send",
				payload: { lid: "notify-lead" },
				logicalEffectId: "notify-lead",
			},
			() => bump("notify-lead"),
		);

		expect(replayed.disposition).toBe("replayed");
		expect(fresh.disposition).toBe("performed");
		expect(performCounts.get("notify-founder")).toBe(1);
		expect(performCounts.get("notify-lead")).toBe(1);
		const rows = committedActions(fixture);
		expect(rows.map((row) => row.lid)).toEqual([
			"notify-founder",
			"notify-lead",
		]);
		expect(rows.every((row) => row.state === "succeeded")).toBe(true);
	});

	it("O2c leaves a died-before-outcome effect at intended and never redoes it", async () => {
		fixture = makeEngineFixture();
		const agent = seedRunner();
		enqueueMailbox(fixture, {
			uid: "m-o2c",
			agent: "runner-a",
			agentKind: "runner",
		});
		const spec = {
			kind: "qa.send",
			payload: { lid: "send-1" },
			logicalEffectId: "send-1",
		} as const;
		let performCount = 0;

		const first = await attachedRunner(agent);
		// The real E4 window: the external effect happens, but no outcome — success
		// OR failure — is ever written. A merely-throwing perform does NOT model
		// this (runRecordedAction still records a `failed` outcome on the way out).
		// The faithful shape is losing the right to write: the generation is taken
		// over while the effect is in flight, so the outcome write hits the fence.
		let takeover: RegisteredAgent | undefined;
		await expect(
			first.driver.performConversionAction(first.handle, spec, () => {
				performCount += 1;
				takeover = takeOverRunner(1);
				return { messageId: "ext-1" };
			}),
		).rejects.toThrow();

		// Ground truth on disk, read through an independent connection: the row
		// really is stranded at `intended` with no result.
		const stranded = committedActions(fixture);
		expect(stranded).toHaveLength(1);
		expect(stranded[0].state).toBe("intended");
		expect(stranded[0].result).toBeNull();
		expect(performCount).toBe(1);

		first.driver.stop();
		// The abandoned generation left its processing attempt `running`; the
		// takeover can only reclaim it once the staleness window has passed.
		const second = await attachedRunner(takeover as RegisteredAgent, 30_000);
		const retried = await second.driver.performConversionAction(
			second.handle,
			spec,
			() => {
				performCount += 1;
				return { messageId: "ext-2" };
			},
		);

		// Founder-accepted semantics (FLY-1500 mapping §8.1): the unknown window is
		// surfaced as replayed+intended, never auto-redone. A "performed" here would
		// be a second external send; a "succeeded" state would be a lie about an
		// outcome nobody ever observed.
		expect(retried.disposition).toBe("replayed");
		expect(retried.action.state).toBe("intended");
		expect(performCount).toBe(1);
		expect(committedActions(fixture)).toHaveLength(1);
	});
});

describe("QA FLY-1518 — the v2 schema has no retired outbox left", () => {
	let fixture: EngineFixture | undefined;

	afterEach(() => {
		fixture?.cleanup();
		fixture = undefined;
	});

	it("O6 carries no commands, command_dependencies, or obligations table", () => {
		fixture = makeEngineFixture();
		expect(
			readCommitted<{ name: string }>(
				fixture,
				`SELECT name FROM sqlite_master
				 WHERE type='table'
				   AND name IN ('commands','command_dependencies','obligations')`,
			),
		).toEqual([]);
	});

	it("O6b fails loudly rather than silently if anything still writes the outbox", () => {
		fixture = makeEngineFixture();
		expect(() =>
			(fixture as EngineFixture).kernel.write("qa.legacy-outbox", (tx) => {
				tx.run(
					`INSERT INTO commands (id, kind, cutover_epoch, created_at)
					 VALUES ('x','y',1,'z')`,
				);
			}),
		).toThrow(/no such table/i);
	});
});
