import { recordActionIntent, recordActionOutcome } from "flywheel-v2-kernel";
import { afterEach, describe, expect, it } from "vitest";
import { pollOnce } from "../consume-loop.js";
import {
	issueProposalCapability,
	readProposalReceipt,
	submitProposal,
} from "../settlement.js";
import type { ConversionProposal } from "../types.js";
import {
	type EngineFixture,
	enqueueMailbox,
	makeEngineFixture,
	seedSessionRunner,
} from "./helpers.js";

function prepareDelivery(fixture: EngineFixture) {
	const lineage = seedSessionRunner(fixture);
	enqueueMailbox(fixture, {
		uid: "m1",
		agent: lineage.agent.agentId,
		agentKind: "runner",
	});
	const polled = pollOnce(
		fixture.kernel,
		fixture.runtime,
		lineage.agent,
		0,
	).result;
	if (polled.status !== "available") throw new Error("expected available");
	fixture.kernel.write("test.delivery-intent", (tx) => {
		recordActionIntent(tx, {
			id: "delivery-action-1",
			taskId: lineage.taskId,
			attemptId: lineage.attemptId,
			attemptGeneration: lineage.agent.generation,
			actor: lineage.agent,
			kind: "mailbox.deliver",
			payload: { message_uid: "m1" },
			logicalEffectId: "deliver-m1",
			invocationUid: "deliver:m1",
			cutoverEpoch: 1,
		});
	});
	return { lineage, polled };
}

describe("proposal capability and durable receipt", () => {
	let fixture: EngineFixture | undefined;

	afterEach(() => {
		fixture?.cleanup();
		fixture = undefined;
	});

	it("consumes an attempt-bound session capability in the settlement transaction", () => {
		fixture = makeEngineFixture();
		const { polled } = prepareDelivery(fixture);
		const authorization = issueProposalCapability(
			fixture.kernel,
			fixture.runtime,
			polled.handle,
			"delivery-action-1",
		);
		const proposal: ConversionProposal = {
			handle: polled.handle,
			effects: [
				{
					kind: "event",
					eventKind: "proposal.completed",
					payload: "{}",
				},
			],
		};

		const proposalDigest = submitProposal(
			fixture.kernel,
			fixture.runtime,
			proposal,
			authorization,
		);
		expect(readProposalReceipt(fixture.kernel, proposal)).toEqual({
			status: "succeeded",
			proposalDigest,
		});
		expect(
			fixture.kernel.read((tx) =>
				tx.get<{ consumed_at: string | null }>(
					"SELECT consumed_at FROM capabilities WHERE issuer='delivery-action-1'",
				),
			)?.consumed_at,
		).toBe(fixture.clock.nowIso());
	});

	it("rejects a capability whose audience changed and rolls back consumption", () => {
		fixture = makeEngineFixture();
		const { polled } = prepareDelivery(fixture);
		const authorization = issueProposalCapability(
			fixture.kernel,
			fixture.runtime,
			polled.handle,
			"delivery-action-1",
		);
		fixture.kernel.write("test.tamper-audience", (tx) => {
			tx.run(
				"UPDATE capabilities SET audience='v2dag:another-session' WHERE issuer='delivery-action-1'",
			);
		});

		expect(() =>
			submitProposal(
				(fixture as EngineFixture).kernel,
				(fixture as EngineFixture).runtime,
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

	it("refuses capability issuance after the session delivery action is terminal", () => {
		fixture = makeEngineFixture();
		const { lineage, polled } = prepareDelivery(fixture);
		fixture.kernel.write("test.finish-delivery-action", (tx) => {
			recordActionOutcome(tx, {
				id: "delivery-action-1",
				actor: lineage.agent,
				state: "succeeded",
				result: { delivered: true },
			});
		});
		expect(() =>
			issueProposalCapability(
				(fixture as EngineFixture).kernel,
				(fixture as EngineFixture).runtime,
				polled.handle,
				"delivery-action-1",
			),
		).toThrow(/does not authorize/);
	});
});
