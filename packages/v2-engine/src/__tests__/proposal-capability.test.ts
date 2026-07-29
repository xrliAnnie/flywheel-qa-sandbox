import { recordActionIntent } from "flywheel-v2-kernel";
import { afterEach, describe, expect, it } from "vitest";
import { EngineDriver } from "../driver.js";
import { registerAgentTx } from "../registration.js";
import { issueProposalCapability, readProposalReceipt } from "../settlement.js";
import {
	type EngineFixture,
	enqueueMailbox,
	makeEngineFixture,
	seedRunnerActivation,
	testSessionBinding,
} from "./helpers.js";

function attachRunner(fixture: EngineFixture, driver: EngineDriver) {
	const activationId = seedRunnerActivation(fixture);
	const runner = fixture.kernel.write("test.register-runner", (tx) =>
		registerAgentTx(tx, fixture.runtime, "runner-a", {
			kind: "runner",
			agentId: "runner-a",
			instanceId: "instance-1",
			activationId,
			sessionBinding: testSessionBinding("instance-1"),
		}),
	);
	return driver.attachRunner("runner-a", runner);
}

describe("proposal capability and durable receipt", () => {
	let fixture: EngineFixture | undefined;
	let driver: EngineDriver | undefined;

	afterEach(() => {
		driver?.stop();
		fixture?.cleanup();
		driver = undefined;
		fixture = undefined;
	});

	it("consumes an attempt-bound capability in the same transaction as settlement", async () => {
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, {
			uid: "m1",
			agent: "runner-a",
			agentKind: "runner",
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime, {
			requireProposalCapability: true,
		});
		await attachRunner(fixture, driver);
		const polled = driver.poll("runner-a");
		if (polled.status !== "available") throw new Error("expected available");
		fixture.kernel.write("test.delivery-intent", (tx) => {
			recordActionIntent(tx, {
				id: "delivery-action-1",
				taskId: "task-runner-a-1",
				attemptId: "attempt-runner-a-1",
				attemptGeneration: 1,
				actor: {
					kind: "runner",
					agentId: "runner-a",
					instanceId: "instance-1",
					generation: 1,
					activationId: "activation-runner-a-1",
				},
				kind: "mailbox.deliver",
				payload: { message_uid: "m1" },
				logicalEffectId: "deliver-m1",
				invocationUid: "deliver:m1",
				cutoverEpoch: 1,
			});
		});
		const authorization = issueProposalCapability(
			fixture.kernel,
			fixture.runtime,
			polled.handle,
			"delivery-action-1",
		);
		const proposal = {
			handle: polled.handle,
			effects: [
				{
					kind: "event" as const,
					eventKind: "proposal.completed",
					payload: "{}",
				},
			],
		};

		const digest = driver.submitProposal(proposal, authorization);
		expect(readProposalReceipt(fixture.kernel, proposal)).toEqual({
			status: "succeeded",
			proposalDigest: digest,
		});
		expect(
			fixture.kernel.read((tx) =>
				tx.get<{ consumed_at: string | null }>(
					"SELECT consumed_at FROM capabilities WHERE issuer='delivery-action-1'",
				),
			)?.consumed_at,
		).toBe(fixture.clock.nowIso());
	});

	it("fails closed on a token bound to a different audience and rolls back consumption", async () => {
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, {
			uid: "m1",
			agent: "runner-a",
			agentKind: "runner",
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime, {
			requireProposalCapability: true,
		});
		await attachRunner(fixture, driver);
		const polled = driver.poll("runner-a");
		if (polled.status !== "available") throw new Error("expected available");
		fixture.kernel.write("test.delivery-intent", (tx) => {
			recordActionIntent(tx, {
				id: "delivery-action-1",
				taskId: "task-runner-a-1",
				attemptId: "attempt-runner-a-1",
				attemptGeneration: 1,
				actor: {
					kind: "runner",
					agentId: "runner-a",
					instanceId: "instance-1",
					generation: 1,
					activationId: "activation-runner-a-1",
				},
				kind: "mailbox.deliver",
				payload: { message_uid: "m1" },
				logicalEffectId: "deliver-m1",
				invocationUid: "deliver:m1",
				cutoverEpoch: 1,
			});
		});
		const authorization = issueProposalCapability(
			fixture.kernel,
			fixture.runtime,
			polled.handle,
			"delivery-action-1",
		);
		fixture.kernel.write("test.tamper-audience", (tx) => {
			tx.run(
				"UPDATE capabilities SET audience='runner-b' WHERE issuer='delivery-action-1'",
			);
		});

		expect(() =>
			driver?.submitProposal(
				{ handle: polled.handle, effects: [] },
				authorization,
			),
		).toThrow(/capability binding/);
		expect(
			fixture.kernel.read((tx) =>
				tx.get<{ consumed_at: string | null }>(
					"SELECT consumed_at FROM capabilities WHERE issuer='delivery-action-1'",
				),
			)?.consumed_at,
		).toBeNull();
	});

	it("requires capability authorization when the production driver fence is enabled", async () => {
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, {
			uid: "m1",
			agent: "runner-a",
			agentKind: "runner",
		});
		driver = new EngineDriver(fixture.kernel, fixture.runtime, {
			requireProposalCapability: true,
		});
		await attachRunner(fixture, driver);
		const polled = driver.poll("runner-a");
		if (polled.status !== "available") throw new Error("expected available");

		expect(() =>
			driver?.submitProposal({ handle: polled.handle, effects: [] }),
		).toThrow(/proposal capability is required/);
	});
});
