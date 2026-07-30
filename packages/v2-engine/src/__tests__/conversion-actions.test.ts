import {
	FenceViolation,
	type JsonValue,
	listActions,
} from "flywheel-v2-kernel";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversionActionSpec } from "../conversion-actions.js";
import { EngineDriver } from "../driver.js";
import type { ConversionContext } from "../types.js";
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

function deferred<Value>() {
	let resolve!: (value: Value | PromiseLike<Value>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
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
				{
					...LEAD_DRAFT,
					instanceId: "instance-2",
					sessionBinding: testSessionBinding("instance-2"),
				},
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
			{
				...LEAD_DRAFT,
				instanceId: "instance-2",
				sessionBinding: testSessionBinding("instance-2"),
			},
			async () => ({ ok: true, effects: [] }),
			evidence,
		);
		expect(replacement.generation).toBe(2);
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
