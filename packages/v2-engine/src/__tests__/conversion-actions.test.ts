import {
	FenceViolation,
	type JsonValue,
	listActions,
} from "flywheel-v2-kernel";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ConversionActionSpec,
	deriveConversionInvocationUid,
} from "../conversion-actions.js";
import { EngineDriver } from "../driver.js";
import { registerAgentTx } from "../registration.js";
import type { ConversionContext, RegisteredAgent } from "../types.js";
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

function deferred<Value>() {
	let resolve!: (value: Value | PromiseLike<Value>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function registerRunner(fixture: EngineFixture): RegisteredAgent {
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

function actionSpec(
	logicalEffectId: string,
	overrides: Partial<ConversionActionSpec> = {},
): ConversionActionSpec {
	return {
		kind: "test.tool",
		payload: { logicalEffectId },
		logicalEffectId,
		...overrides,
	};
}

describe("conversion actions", () => {
	let fixture: EngineFixture | undefined;
	let driver: EngineDriver | undefined;

	afterEach(() => {
		driver?.stop();
		fixture?.cleanup();
		driver = undefined;
		fixture = undefined;
	});

	it("records a runner action with its durable DAG and mailbox binding", async () => {
		fixture = makeEngineFixture();
		const runner = registerRunner(fixture);
		enqueueMailbox(fixture, {
			uid: "m1",
			agent: "runner-a",
			agentKind: "runner",
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.attachRunner("runner-a", runner);
		const polled = driver.poll("runner-a");
		if (polled.status !== "available") throw new Error("expected available");
		let performCount = 0;

		const result = await driver.performConversionAction(
			polled.handle,
			actionSpec("reply"),
			() => {
				performCount += 1;
				return { externalId: "external-1" };
			},
		);

		expect(result).toMatchObject({
			disposition: "performed",
			action: {
				state: "succeeded",
				taskId: "task-runner-a-1",
				attemptId: "attempt-runner-a-1",
				attemptGeneration: 1,
				actor: {
					kind: "runner",
					agentId: "runner-a",
					activationId: "activation-runner-a-1",
				},
				result: { externalId: "external-1" },
			},
		});
		expect(performCount).toBe(1);
	});

	it("derives collision-free invocation identities and validates qualifier evidence", async () => {
		expect(deriveConversionInvocationUid("a", "x", "b::x::c")).not.toBe(
			deriveConversionInvocationUid("a::x::b", "x", "c"),
		);

		fixture = makeEngineFixture();
		const runner = registerRunner(fixture);
		enqueueMailbox(fixture, {
			uid: "m1",
			agent: "runner-a",
			agentKind: "runner",
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.attachRunner("runner-a", runner);
		const polled = driver.poll("runner-a");
		if (polled.status !== "available") throw new Error("expected available");

		expect(() =>
			driver?.performConversionAction(
				polled.handle,
				actionSpec("reply", { qualifier: "retry-2" }),
				() => ({ ok: true }),
			),
		).toThrow(/qualifier.*supersedesActionId.*retryBasis/i);
		expect(fixture.kernel.read((tx) => listActions(tx, { limit: 10 }))).toEqual(
			[],
		);
	});

	it("fails closed before intent and effect when the captured epoch drifts", async () => {
		fixture = makeEngineFixture();
		const runner = registerRunner(fixture);
		enqueueMailbox(fixture, {
			uid: "m1",
			agent: "runner-a",
			agentKind: "runner",
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.attachRunner("runner-a", runner);
		const polled = driver.poll("runner-a");
		if (polled.status !== "available") throw new Error("expected available");
		let performCount = 0;

		const pending = driver.performConversionAction(
			polled.handle,
			actionSpec("reply"),
			() => {
				performCount += 1;
				return { ok: true };
			},
		);
		fixture.kernel.write("test.cutover-drift", (tx) => {
			tx.run(
				"UPDATE meta SET value='2' WHERE key='cutover_epoch' AND value='1'",
			);
		});

		await expect(pending).rejects.toBeInstanceOf(FenceViolation);
		expect(performCount).toBe(0);
		expect(fixture.kernel.read((tx) => listActions(tx, { limit: 10 }))).toEqual(
			[],
		);
	});

	it("rejects a runner whose activation has no DAG binding", async () => {
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, {
			uid: "m1",
			agent: "runner-a",
			agentKind: "runner",
		});
		fixture.kernel.write("test.promote-unbound-runner", (tx) => {
			tx.run(
				"UPDATE agents SET generation=1,state='online' WHERE agent_id='runner-a'",
			);
		});
		const runner: RegisteredAgent = {
			kind: "runner",
			agentId: "runner-a",
			instanceId: "instance-1",
			activationId: "missing-activation",
			generation: 1,
		};
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.attachRunner("runner-a", runner);
		const polled = driver.poll("runner-a");
		if (polled.status !== "available") throw new Error("expected available");
		let performCount = 0;

		await expect(
			driver.performConversionAction(polled.handle, actionSpec("reply"), () => {
				performCount += 1;
				return { ok: true };
			}),
		).rejects.toBeInstanceOf(FenceViolation);
		expect(performCount).toBe(0);
	});

	it("preserves arbitrary JSON result typing through the public driver seam", async () => {
		fixture = makeEngineFixture();
		const runner = registerRunner(fixture);
		enqueueMailbox(fixture, {
			uid: "m1",
			agent: "runner-a",
			agentKind: "runner",
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.attachRunner("runner-a", runner);
		const polled = driver.poll("runner-a");
		if (polled.status !== "available") throw new Error("expected available");
		const expected: JsonValue = { nested: ["ok", 1, true, null] };

		const result = await driver.performConversionAction(
			polled.handle,
			actionSpec("typed-result"),
			() => expected,
		);

		expect(result.action.result).toEqual(expected);
	});

	it("drains an unawaited lead action before successful settlement", async () => {
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, { uid: "m1", agent: "lead-a" });
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		const effect = deferred<JsonValue>();
		const started = deferred<void>();
		let actionResult:
			| ReturnType<ConversionContext["performAction"]>
			| undefined;

		await driver.registerLead(
			"lead-a",
			LEAD_DRAFT,
			async (_message, context) => {
				actionResult = context.performAction(actionSpec("notify"), () => {
					started.resolve();
					return effect.promise;
				});
				return { ok: true, effects: [] };
			},
		);
		await started.promise;

		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ state: string }>(
						"SELECT state FROM mailbox WHERE message_uid='m1'",
					)?.state,
			),
		).toBe("pending");

		effect.resolve({ externalId: "external-1" });
		await actionResult;
		await driver.drain("lead-a");
		expect(
			fixture.kernel.read((tx) => ({
				mailbox: tx.get<{ state: string }>(
					"SELECT state FROM mailbox WHERE message_uid='m1'",
				)?.state,
				action: tx.get<{ state: string }>(
					"SELECT state FROM actions WHERE kind='test.tool'",
				)?.state,
			})),
		).toEqual({ mailbox: "applied", action: "succeeded" });
	});

	it("drains a lead action started through the public driver before settlement", async () => {
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, { uid: "m1", agent: "lead-a" });
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		const effect = deferred<JsonValue>();
		const started = deferred<void>();
		let actionResult:
			| ReturnType<EngineDriver["performConversionAction"]>
			| undefined;

		await driver.registerLead(
			"lead-a",
			LEAD_DRAFT,
			async (_message, context) => {
				actionResult = driver?.performConversionAction(
					context.handle,
					actionSpec("direct-notify"),
					() => {
						started.resolve();
						return effect.promise;
					},
				);
				return { ok: true, effects: [] };
			},
		);
		await started.promise;
		const drained = driver.drain("lead-a");
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ state: string }>(
						"SELECT state FROM mailbox WHERE message_uid='m1'",
					)?.state,
			),
		).toBe("pending");

		effect.resolve({ externalId: "external-direct-1" });
		await actionResult;
		await drained;
		expect(
			fixture.kernel.read((tx) => ({
				mailbox: tx.get<{ state: string }>(
					"SELECT state FROM mailbox WHERE message_uid='m1'",
				)?.state,
				action: tx.get<{ state: string }>(
					"SELECT state FROM actions WHERE kind='test.tool'",
				)?.state,
			})),
		).toEqual({ mailbox: "applied", action: "succeeded" });
	});

	it("blocks direct success and failure settlement until a runner action finishes", async () => {
		fixture = makeEngineFixture();
		const runner = registerRunner(fixture);
		enqueueMailbox(fixture, {
			uid: "m1",
			agent: "runner-a",
			agentKind: "runner",
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.attachRunner("runner-a", runner);
		const polled = driver.poll("runner-a");
		if (polled.status !== "available") throw new Error("expected available");
		const effect = deferred<JsonValue>();
		const pending = driver.performConversionAction(
			polled.handle,
			actionSpec("notify"),
			() => effect.promise,
		);

		expect(() =>
			driver?.submitProposal({ handle: polled.handle, effects: [] }),
		).toThrow(FenceViolation);
		expect(() =>
			driver?.reportConversionFailure(polled.handle, "too early"),
		).toThrow(FenceViolation);
		effect.resolve({ ok: true });
		await pending;
		driver.submitProposal({ handle: polled.handle, effects: [] });
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ state: string }>(
						"SELECT state FROM mailbox WHERE message_uid='m1'",
					)?.state,
			),
		).toBe("applied");
	});

	it("closes a lead conversion context after the converter returns", async () => {
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, { uid: "m1", agent: "lead-a" });
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		let captured: ConversionContext | undefined;
		await driver.registerLead(
			"lead-a",
			LEAD_DRAFT,
			async (_message, context) => {
				captured = context;
				return { ok: true, effects: [] };
			},
		);
		await driver.drain("lead-a");
		let performCount = 0;

		await expect(
			captured?.performAction(actionSpec("late"), () => {
				performCount += 1;
				return { ok: true };
			}),
		).rejects.toBeInstanceOf(FenceViolation);
		expect(performCount).toBe(0);
		expect(fixture.kernel.read((tx) => listActions(tx, { limit: 10 }))).toEqual(
			[],
		);
	});

	it("registers an action before its synchronous perform prefix can reenter settlement", async () => {
		fixture = makeEngineFixture();
		const runner = registerRunner(fixture);
		enqueueMailbox(fixture, {
			uid: "m1",
			agent: "runner-a",
			agentKind: "runner",
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.attachRunner("runner-a", runner);
		const polled = driver.poll("runner-a");
		if (polled.status !== "available") throw new Error("expected available");

		const pending = driver.performConversionAction(
			polled.handle,
			actionSpec("reentrant"),
			() => {
				expect(() =>
					driver?.submitProposal({ handle: polled.handle, effects: [] }),
				).toThrow(FenceViolation);
				return { ok: true };
			},
		);
		await pending;
		driver.submitProposal({ handle: polled.handle, effects: [] });
	});

	it("waits for a started action before settling a thrown conversion as failed", async () => {
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, { uid: "m1", agent: "lead-a" });
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		const effect = deferred<JsonValue>();
		const started = deferred<void>();
		let actionResult:
			| ReturnType<ConversionContext["performAction"]>
			| undefined;

		await driver.registerLead(
			"lead-a",
			LEAD_DRAFT,
			async (_message, context) => {
				actionResult = context.performAction(actionSpec("before-throw"), () => {
					started.resolve();
					return effect.promise;
				});
				throw new Error("conversion exploded");
			},
		);
		await started.promise;
		expect(
			fixture.kernel.read((tx) => ({
				retryCount: tx.get<{ retry_count: number }>(
					"SELECT retry_count FROM mailbox WHERE message_uid='m1'",
				)?.retry_count,
				outcome: tx.get<{ outcome: string }>(
					"SELECT outcome FROM processing_attempts WHERE attempt_uid='m1#1'",
				)?.outcome,
			})),
		).toEqual({ retryCount: 0, outcome: "running" });

		effect.resolve({ ok: true });
		await actionResult;
		await driver.drain("lead-a");
		expect(
			fixture.kernel.read((tx) => ({
				retryCount: tx.get<{ retry_count: number }>(
					"SELECT retry_count FROM mailbox WHERE message_uid='m1'",
				)?.retry_count,
				outcome: tx.get<{ outcome: string }>(
					"SELECT outcome FROM processing_attempts WHERE attempt_uid='m1#1'",
				)?.outcome,
			})),
		).toEqual({ retryCount: 1, outcome: "failed" });
	});

	it("turns an ignored action rejection into one conversion failure settlement", async () => {
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, { uid: "m1", agent: "lead-a" });
		driver = new EngineDriver(fixture.kernel, fixture.runtime);

		await driver.registerLead(
			"lead-a",
			LEAD_DRAFT,
			async (_message, context) => {
				void context.performAction(actionSpec("reject"), () => {
					throw new Error("effect rejected");
				});
				return { ok: false, error: "converter also failed" };
			},
		);
		await driver.drain("lead-a");

		expect(
			fixture.kernel.read((tx) => ({
				retryCount: tx.get<{ retry_count: number }>(
					"SELECT retry_count FROM mailbox WHERE message_uid='m1'",
				)?.retry_count,
				attempts: tx.get<{ count: number }>(
					"SELECT count(*) AS count FROM processing_attempts WHERE outcome='failed'",
				)?.count,
				actionState: tx.get<{ state: string }>(
					"SELECT state FROM actions WHERE kind='test.tool'",
				)?.state,
			})),
		).toEqual({ retryCount: 1, attempts: 1, actionState: "failed" });
	});

	it("refuses stop without any lifecycle write while an action is pending", async () => {
		fixture = makeEngineFixture();
		const runner = registerRunner(fixture);
		enqueueMailbox(fixture, {
			uid: "m1",
			agent: "runner-a",
			agentKind: "runner",
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.attachRunner("runner-a", runner);
		const polled = driver.poll("runner-a");
		if (polled.status !== "available") throw new Error("expected available");
		const effect = deferred<JsonValue>();
		const started = deferred<void>();
		const pending = driver.performConversionAction(
			polled.handle,
			actionSpec("pending-stop"),
			() => {
				started.resolve();
				return effect.promise;
			},
		);
		await started.promise;

		expect(() => driver?.stop()).toThrow(FenceViolation);
		expect(
			fixture.kernel.read((tx) => ({
				agentState: tx.get<{ state: string }>(
					"SELECT state FROM agents WHERE agent_id='runner-a'",
				)?.state,
				outcome: tx.get<{ outcome: string }>(
					"SELECT outcome FROM processing_attempts WHERE attempt_uid='m1#1'",
				)?.outcome,
			})),
		).toEqual({ agentState: "online", outcome: "running" });

		effect.resolve({ ok: true });
		await pending;
		driver.stop();
		driver = undefined;
		expect(
			fixture.kernel.read(
				(tx) =>
					tx.get<{ state: string }>(
						"SELECT state FROM agents WHERE agent_id='runner-a'",
					)?.state,
			),
		).toBe("offline");
	});

	it("refuses same-driver runner attachment replacement while an action is pending", async () => {
		fixture = makeEngineFixture();
		const runner = registerRunner(fixture);
		enqueueMailbox(fixture, {
			uid: "m1",
			agent: "runner-a",
			agentKind: "runner",
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.attachRunner("runner-a", runner);
		const polled = driver.poll("runner-a");
		if (polled.status !== "available") throw new Error("expected available");
		const effect = deferred<JsonValue>();
		const pending = driver.performConversionAction(
			polled.handle,
			actionSpec("pending-attach"),
			() => effect.promise,
		);

		await expect(
			driver.attachRunner("runner-a", runner),
		).rejects.toBeInstanceOf(FenceViolation);
		expect(() =>
			driver?.submitProposal({ handle: polled.handle, effects: [] }),
		).toThrow(FenceViolation);
		effect.resolve({ ok: true });
		await pending;
		await driver.attachRunner("runner-a", runner);
	});

	it("refuses same-driver lead re-registration before generation or attempt writes", async () => {
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, { uid: "m1", agent: "lead-a" });
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		const effect = deferred<JsonValue>();
		const started = deferred<void>();

		await driver.registerLead(
			"lead-a",
			LEAD_DRAFT,
			async (_message, context) => {
				void context.performAction(actionSpec("pending-register"), () => {
					started.resolve();
					return effect.promise;
				});
				return { ok: true, effects: [] };
			},
		);
		await started.promise;
		const evidence = {
			agentId: "lead-a",
			generation: 1,
			confirmedAbsentAt: fixture.clock.nowIso(),
		};

		await expect(
			driver.registerLead(
				"lead-a",
				{ ...LEAD_DRAFT, instanceId: "instance-2" },
				async () => ({ ok: true, effects: [] }),
				evidence,
			),
		).rejects.toBeInstanceOf(FenceViolation);
		expect(
			fixture.kernel.read((tx) => ({
				generation: tx.get<{ generation: number }>(
					"SELECT generation FROM agents WHERE agent_id='lead-a'",
				)?.generation,
				outcome: tx.get<{ outcome: string }>(
					"SELECT outcome FROM processing_attempts WHERE attempt_uid='m1#1'",
				)?.outcome,
			})),
		).toEqual({ generation: 1, outcome: "running" });

		effect.resolve({ ok: true });
		await driver.drain("lead-a");
		const replacement = await driver.registerLead(
			"lead-a",
			{ ...LEAD_DRAFT, instanceId: "instance-2" },
			async () => ({ ok: true, effects: [] }),
			evidence,
		);
		expect(replacement.generation).toBe(2);
	});

	it("replays a completed effect after a crash without performing it twice", async () => {
		fixture = makeEngineFixture();
		const runner = registerRunner(fixture);
		enqueueMailbox(fixture, {
			uid: "m1",
			agent: "runner-a",
			agentKind: "runner",
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.attachRunner("runner-a", runner);
		const first = driver.poll("runner-a");
		if (first.status !== "available") throw new Error("expected available");
		let performCount = 0;
		const performed = await driver.performConversionAction(
			first.handle,
			actionSpec("durable-send"),
			() => {
				performCount += 1;
				return { externalId: "external-1" };
			},
		);
		expect(performed.disposition).toBe("performed");

		driver.stop();
		driver = undefined;
		fixture.clock.advance(30_000);
		const takeover = fixture.kernel.write("test.runner-takeover", (tx) =>
			registerAgentTx(
				tx,
				fixture?.runtime as never,
				"runner-a",
				{
					kind: "runner",
					agentId: "runner-a",
					instanceId: "instance-2",
					activationId: "activation-runner-a-1",
				},
				{
					agentId: "runner-a",
					generation: 1,
					confirmedAbsentAt: fixture?.clock.nowIso() as string,
				},
			),
		);
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.attachRunner("runner-a", takeover);
		const retried = driver.poll("runner-a");
		if (retried.status !== "available") throw new Error("expected retry");

		const replayed = await driver.performConversionAction(
			retried.handle,
			actionSpec("durable-send"),
			() => {
				performCount += 1;
				return { externalId: "duplicate" };
			},
		);
		expect(replayed).toMatchObject({
			disposition: "replayed",
			action: { id: performed.action.id, state: "succeeded" },
		});
		expect(performCount).toBe(1);
		driver.submitProposal({ handle: retried.handle, effects: [] });
	});

	it("keeps a pre-intent crash pending so the retried effect is not lost", async () => {
		fixture = makeEngineFixture();
		const runner = registerRunner(fixture);
		enqueueMailbox(fixture, {
			uid: "m1",
			agent: "runner-a",
			agentKind: "runner",
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.attachRunner("runner-a", runner);
		const first = driver.poll("runner-a");
		if (first.status !== "available") throw new Error("expected available");
		driver.stop();
		driver = undefined;
		expect(fixture.kernel.read((tx) => listActions(tx, { limit: 10 }))).toEqual(
			[],
		);

		fixture.clock.advance(30_000);
		const takeover = fixture.kernel.write("test.runner-takeover", (tx) =>
			registerAgentTx(
				tx,
				fixture?.runtime as never,
				"runner-a",
				{
					kind: "runner",
					agentId: "runner-a",
					instanceId: "instance-2",
					activationId: "activation-runner-a-1",
				},
				{
					agentId: "runner-a",
					generation: 1,
					confirmedAbsentAt: fixture?.clock.nowIso() as string,
				},
			),
		);
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.attachRunner("runner-a", takeover);
		const retried = driver.poll("runner-a");
		if (retried.status !== "available") throw new Error("expected retry");
		let performCount = 0;

		const performed = await driver.performConversionAction(
			retried.handle,
			actionSpec("not-lost"),
			() => {
				performCount += 1;
				return { ok: true };
			},
		);
		expect(performed.disposition).toBe("performed");
		expect(performCount).toBe(1);
		driver.submitProposal({ handle: retried.handle, effects: [] });
	});

	it("preserves an effect-after-crash as intended across generation takeover and allows one evidenced successor", async () => {
		fixture = makeEngineFixture();
		const runner = registerRunner(fixture);
		enqueueMailbox(fixture, {
			uid: "m1",
			agent: "runner-a",
			agentKind: "runner",
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.attachRunner("runner-a", runner);
		const first = driver.poll("runner-a");
		if (first.status !== "available") throw new Error("expected available");
		let performCount = 0;
		let takeover: RegisteredAgent | undefined;

		await expect(
			driver.performConversionAction(
				first.handle,
				actionSpec("unknown-outcome"),
				() => {
					performCount += 1;
					takeover = fixture?.kernel.write("test.take-over-mid-effect", (tx) =>
						registerAgentTx(
							tx,
							fixture?.runtime as never,
							"runner-a",
							{
								kind: "runner",
								agentId: "runner-a",
								instanceId: "instance-2",
								activationId: "activation-runner-a-1",
							},
							{
								agentId: "runner-a",
								generation: 1,
								confirmedAbsentAt: fixture?.clock.nowIso() as string,
							},
						),
					);
					return { externalId: "unknown-1" };
				},
			),
		).rejects.toThrow(/CAS expected 1 changed row/);
		const intended = fixture.kernel.read((tx) =>
			listActions(tx, { state: "intended", limit: 10 }),
		);
		expect(intended).toHaveLength(1);
		expect(performCount).toBe(1);

		driver.stop();
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.attachRunner("runner-a", takeover as RegisteredAgent);
		fixture.clock.advance(30_000);
		const retried = driver.poll("runner-a");
		if (retried.status !== "available") throw new Error("expected retry");
		const replayed = await driver.performConversionAction(
			retried.handle,
			actionSpec("unknown-outcome"),
			() => {
				performCount += 1;
				return { externalId: "must-not-run" };
			},
		);
		expect(replayed).toMatchObject({
			disposition: "replayed",
			action: { id: intended[0]?.id, state: "intended" },
		});
		expect(performCount).toBe(1);

		const successorSpec = actionSpec("unknown-outcome", {
			qualifier: "retry-2",
			supersedesActionId: intended[0]?.id,
			retryBasis: {
				evidenceRef: "test://provider-confirmed-no-result",
				reason: "operator approved explicit retry",
			},
		});
		const successor = await driver.performConversionAction(
			retried.handle,
			successorSpec,
			() => {
				performCount += 1;
				return { externalId: "external-2" };
			},
		);
		expect(successor.disposition).toBe("performed");
		const successorReplay = await driver.performConversionAction(
			retried.handle,
			successorSpec,
			() => {
				performCount += 1;
				return { externalId: "duplicate" };
			},
		);
		expect(successorReplay).toMatchObject({
			disposition: "replayed",
			action: { id: successor.action.id, state: "succeeded" },
		});
		expect(performCount).toBe(2);
		driver.submitProposal({ handle: retried.handle, effects: [] });
	});

	it("runs two lead actions exactly once each across whole-message redelivery", async () => {
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, { uid: "m1", agent: "lead-a" });
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		const counts = { first: 0, second: 0 };
		const dispositions: string[][] = [];
		let conversionCount = 0;

		await driver.registerLead(
			"lead-a",
			LEAD_DRAFT,
			async (_message, context) => {
				conversionCount += 1;
				const first = await context.performAction(actionSpec("first"), () => {
					counts.first += 1;
					return { ok: true };
				});
				const second = await context.performAction(actionSpec("second"), () => {
					counts.second += 1;
					return { ok: true };
				});
				dispositions.push([first.disposition, second.disposition]);
				return conversionCount === 1
					? { ok: false, error: "retry the whole message" }
					: { ok: true, effects: [] };
			},
		);
		await driver.drain("lead-a");
		fixture.clock.advance(30_000);
		expect(driver.poll("lead-a").status).toBe("available");
		await driver.drain("lead-a");

		expect(counts).toEqual({ first: 1, second: 1 });
		expect(dispositions).toEqual([
			["performed", "performed"],
			["replayed", "replayed"],
		]);
	});

	it("replays the first lead action and performs the not-yet-intended second action after retry", async () => {
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, { uid: "m1", agent: "lead-a" });
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		const counts = { first: 0, second: 0 };
		const dispositions: string[][] = [];
		let conversionCount = 0;

		await driver.registerLead(
			"lead-a",
			LEAD_DRAFT,
			async (_message, context) => {
				conversionCount += 1;
				const first = await context.performAction(actionSpec("first"), () => {
					counts.first += 1;
					return { ok: true };
				});
				if (conversionCount === 1) {
					dispositions.push([first.disposition]);
					throw new Error("crash before second intent");
				}
				const second = await context.performAction(actionSpec("second"), () => {
					counts.second += 1;
					return { ok: true };
				});
				dispositions.push([first.disposition, second.disposition]);
				return { ok: true, effects: [] };
			},
		);
		await driver.drain("lead-a");
		fixture.clock.advance(30_000);
		expect(driver.poll("lead-a").status).toBe("available");
		await driver.drain("lead-a");

		expect(counts).toEqual({ first: 1, second: 1 });
		expect(dispositions).toEqual([["performed"], ["replayed", "performed"]]);
	});
});
