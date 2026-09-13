import { describe, expect, it } from "vitest";
import { CommDB } from "../db.js";
import type { ReworkWakeRetirementProof } from "../rework-wake-identity.js";
import {
	buildReworkWakeId,
	parseReworkWakeMetadata,
} from "../rework-wake-identity.js";

describe("FLY-2517 rework wake identity", () => {
	it("preserves the existing wire identity and parses only typed metadata", () => {
		const wakeId = buildReworkWakeId({
			requestId: "rework:b543",
			activationId: "activation:rework:b543",
			epoch: 9,
		});
		expect(wakeId).toBe(
			"rework-wake:rework:b543:activation:rework:b543:epoch:9",
		);
		const metadata = {
			kind: "workflow_rework",
			wakeId,
			activationId: "activation:rework:b543",
			epoch: 9,
		};
		const expected = { wakeId, activationId: metadata.activationId, epoch: 9 };
		expect(parseReworkWakeMetadata(metadata)).toEqual(expected);
		expect(parseReworkWakeMetadata(JSON.stringify(metadata))).toEqual(expected);
	});

	it.each([
		null,
		[],
		"{broken",
		{},
		{ kind: "phase", wakeId: "wake", activationId: "activation", epoch: 1 },
		...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "9", null].map((epoch) => ({
			kind: "workflow_rework",
			wakeId: "wake",
			activationId: "activation",
			epoch,
		})),
		...["", " ", null, 4].map((wakeId) => ({
			kind: "workflow_rework",
			wakeId,
			activationId: "activation",
			epoch: 1,
		})),
	])("rejects malformed or unrelated metadata: %j", (metadata) => {
		expect(parseReworkWakeMetadata(metadata)).toBeNull();
	});
});

describe("FLY-2517 privileged retirement effects", () => {
	it("finishes the old source without fabricating receipt clocks and disposes late copies", () => {
		const db = new CommDB(":memory:");
		try {
			const now = Date.parse("2026-09-11T15:41:42Z");
			const proof = retirementProof();
			const metadata = {
				kind: "workflow_rework",
				wakeId: proof.wakeId,
				activationId: proof.activationId,
				epoch: proof.epoch,
			};
			db.enqueueTurnWake({
				wakeId: proof.wakeId,
				executionId: proof.executionId,
				activationId: proof.activationId,
				issueId: "FLY-2517",
				epoch: proof.epoch,
				purpose: "workflow_rework",
				envelope: { fromAgent: "bridge", content: "wake", metadata },
				backend: "codex",
				createdAtMs: now,
			});
			db.enqueueRunnerPhaseWake(
				"old",
				{ id: "physical-old", to: "old", content: "wake", metadata },
				now,
			);
			expect(db.applyReworkWakeRetirement(proof, now + 1)).toEqual({
				ok: true,
				idempotentReplay: false,
			});
			expect(db.applyReworkWakeRetirement(proof, now + 2)).toEqual({
				ok: true,
				idempotentReplay: true,
			});
			expect(db.getTurnWake(proof.wakeId)).toMatchObject({
				state: "cancelled",
				acked_at: null,
			});
			const duplicate = db.enqueueRunnerPhaseWake(
				"old",
				{ id: "physical-old", to: "old", content: "wake", metadata },
				now + 3,
			);
			expect(duplicate).toMatchObject({
				kind: "disposed",
				wake: {
					state: "finished",
					started_at: null,
					retirement_id: proof.retirementId,
				},
			});
			const late = db.enqueueRunnerReceiverDelivery(
				"old",
				{ id: "physical-late", to: "old", content: "wake", metadata },
				now + 4,
			);
			expect(late).toMatchObject({
				kind: "disposed",
				wake: { state: "finished", started_at: null },
			});
			expect(
				db.markRunnerPhaseWakeStarted("old", "physical-late", now + 5),
			).toBe(false);
		} finally {
			db.close();
		}
	});
});

function retirementProof(): ReworkWakeRetirementProof {
	const activationId = "activation:request";
	const wakeId = buildReworkWakeId({
		requestId: "request",
		activationId,
		epoch: 9,
	});
	return {
		retirementId: "retirement-1",
		runId: "run",
		requestId: "request",
		nodeId: "implement",
		attempt: 2,
		oldRouteRevision: 1,
		newRouteRevision: 2,
		executionId: "old",
		replacementExecutionId: "replacement",
		activationId,
		epoch: 9,
		wakeId,
		replacementEventUid: "rework_replacement_materialized:request",
	};
}

describe("FLY-2517 retirement before transport", () => {
	it("keeps tombstones without a source and prevents a late parent from becoming pushable", () => {
		const db = new CommDB(":memory:");
		try {
			const proof = retirementProof();
			db.applyReworkWakeRetirement(proof, 1000);
			db.enqueueTurnWake({
				wakeId: proof.wakeId,
				executionId: proof.executionId,
				activationId: proof.activationId,
				issueId: "FLY-2517",
				epoch: proof.epoch,
				purpose: "workflow_rework",
				envelope: { fromAgent: "bridge", content: "late" },
				backend: "codex",
				createdAtMs: 2000,
			});
			expect(db.getTurnWake(proof.wakeId)).toMatchObject({
				state: "cancelled",
				acked_at: null,
			});
			expect(
				db.claimTurnWakeById({
					wakeId: proof.wakeId,
					nowMs: 3000,
					retryAfterMs: 1,
					leaseMs: 1000,
				}),
			).toBeNull();
			expect(() =>
				db.applyReworkWakeRetirement(
					{ ...proof, replacementExecutionId: "different" },
					3000,
				),
			).toThrow("conflict");
			const normal = db.enqueueRunnerPhaseWake(
				"old",
				{
					id: "unrelated",
					to: "old",
					content: "normal",
					metadata: {
						kind: "workflow_rework",
						wakeId: proof.wakeId,
						activationId: proof.activationId,
						epoch: 10,
					},
				},
				3000,
			);
			expect(normal.kind).toBe("queued");
		} finally {
			db.close();
		}
	});
});

describe("FLY-2517 genuine receipt preservation", () => {
	it("preserves a started phase and an acknowledged parent receipt", () => {
		const db = new CommDB(":memory:");
		try {
			const proof = retirementProof();
			const metadata = {
				kind: "workflow_rework",
				wakeId: proof.wakeId,
				activationId: proof.activationId,
				epoch: proof.epoch,
			};
			db.enqueueTurnWake({
				wakeId: proof.wakeId,
				executionId: proof.executionId,
				activationId: proof.activationId,
				issueId: "FLY-2517",
				epoch: proof.epoch,
				purpose: "workflow_rework",
				envelope: { fromAgent: "bridge", content: "wake", metadata },
				backend: "codex",
				createdAtMs: 1000,
			});
			db.ackTurnWakes({
				executionId: "old",
				epoch: 9,
				activationId: proof.activationId,
				ackedAtMs: 2000,
			});
			db.enqueueRunnerPhaseWake(
				"old",
				{ id: "started", to: "old", content: "wake", metadata },
				1000,
			);
			expect(db.markRunnerPhaseWakeStarted("old", "started", 2000)).toBe(true);
			db.applyReworkWakeRetirement(proof, 3000);
			expect(db.getTurnWake(proof.wakeId)).toMatchObject({
				state: "acked",
				acked_at: 2000,
			});
			expect(
				db.enqueueRunnerPhaseWake(
					"old",
					{ id: "started", to: "old", content: "wake", metadata },
					4000,
				),
			).toMatchObject({
				kind: "disposed",
				wake: { state: "finished", started_at: 2000, finished_at: 3000 },
			});
		} finally {
			db.close();
		}
	});
});

describe("FLY-2517 atomic start claim", () => {
	it("distinguishes replay, missing, and retirement after an observation", () => {
		const db = new CommDB(":memory:");
		try {
			const proof = retirementProof();
			const metadata = {
				kind: "workflow_rework",
				wakeId: proof.wakeId,
				activationId: proof.activationId,
				epoch: proof.epoch,
			};
			db.enqueueRunnerPhaseWake(
				"old",
				{ id: "cached", to: "old", content: "wake", metadata },
				1000,
			);
			db.applyReworkWakeRetirement(proof, 2000);
			expect(db.claimRunnerPhaseWakeStart("old", "cached", 3000)).toBe(
				"disposed",
			);
			expect(db.claimRunnerPhaseWakeStart("old", "missing", 3000)).toBe(
				"missing",
			);
			db.enqueueRunnerPhaseWake(
				"old",
				{ id: "normal", to: "old", content: "work" },
				1000,
			);
			expect(db.claimRunnerPhaseWakeStart("old", "normal", 3000)).toBe(
				"started",
			);
			expect(db.claimRunnerPhaseWakeStart("old", "normal", 4000)).toBe(
				"replay",
			);
			db.finishRunnerPhaseWake("old", "normal", 5000);
			expect(db.claimRunnerPhaseWakeStart("old", "normal", 6000)).toBe(
				"replay",
			);
		} finally {
			db.close();
		}
	});
});
