import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	type ContinuityEntry,
	type ContinuityObservation,
	evaluateContinuity,
} from "../patrol-continuity.js";

const start = Date.parse("2026-08-20T17:51:17Z");
function sample(
	atMs = start,
	patch: Partial<ContinuityObservation> = {},
): ContinuityObservation {
	return {
		identity: {
			project: "flywheel",
			lead: "flywheel-eng-lead",
			executionId: "fa7e14cf-362e-48aa-9c2e-e09a8193ff82",
			activationId: "legacy:fa7e14cf-362e-48aa-9c2e-e09a8193ff82",
			runId: null,
			nodeId: null,
			attempt: null,
			turnEpoch: null,
			bindingGeneration: "generation-1",
			repoSourceIdentity:
				"project_registry_root:xrliannie/flywheel:flywheel-FLY-1945",
		},
		sampledAtMs: atMs,
		semanticState: {
			sessionStatus: "running",
			sessionStage: "implement",
			nodeState: null,
			turnRelation: "legacy",
			effectiveWait: null,
		},
		refs: [
			{
				repoIdentity: "xrliannie/flywheel",
				fullRef: "refs/heads/flywheel-FLY-1945",
				headSha: "a".repeat(40),
				observedAtMs: atMs,
			},
		],
		sourcesComplete: true,
		ownershipComplete: true,
		eventsComplete: true,
		canAttributeRemote: true,
		sourceCursors: { stageEventId: 0, workflowEventSeq: 0 },
		...patch,
	};
}
describe("patrol continuity semantics", () => {
	it.each(["%7", "%8"])(
		"falsifies the historical frozen row %s at the original 21:37 observation",
		(pane) => {
			const fixture = JSON.parse(
				readFileSync(
					new URL(
						"../../../../engineering/doc/FLY-1945-patrol-evidence-gate/historical-observations.json",
						import.meta.url,
					),
					"utf8",
				),
			);
			let previous: ContinuityEntry | undefined;
			let result: ReturnType<typeof evaluateContinuity> | undefined;
			for (const row of fixture.observations.filter(
				(r: { pane: string }) => r.pane === pane,
			)) {
				const observation = sample(Date.parse(row.captured_at));
				observation.identity.executionId = row.execution_id;
				// Historical display prefixes are confined to this adapter; live refs require full SHA.
				observation.refs[0].headSha = row.observed_head_prefix.padEnd(40, "0");
				result = evaluateContinuity(previous, observation);
				previous = result.entry;
			}
			expect(result?.activity).toBe("ACTIVE");
			expect(result?.last_change_basis).toBe("remote_head");
			expect(result?.last_change_epoch).not.toBe(1787248266);
		},
	);
	it("establishes a baseline, then stalls only at 3600 seconds of complete coverage", () => {
		const initial = evaluateContinuity(undefined, sample());
		expect(initial.activity).toBe("OBSERVING");
		expect(initial.entry?.lastStateChangeAtMs).toBeNull();
		expect(
			evaluateContinuity(initial.entry, sample(start + 3599000)).activity,
		).toBe("OBSERVING");
		expect(
			evaluateContinuity(initial.entry, sample(start + 3600000)).activity,
		).toBe("STALLED_60M");
	});
	it("state transition changes last_change but repeated observations do not", () => {
		let previous = evaluateContinuity(undefined, sample()).entry;
		const changed = sample(start + 1000);
		changed.semanticState.sessionStage = "test";
		const active = evaluateContinuity(previous, changed);
		previous = active.entry;
		expect(active.last_change_basis).toBe("state_transition");
		expect(
			evaluateContinuity(previous, { ...changed, sampledAtMs: start + 2000 })
				.last_change_epoch,
		).toBe((start + 1000) / 1000);
	});
	it("records a verified A-B-A transition without mistaking event sequence alone for progress", () => {
		const previous = evaluateContinuity(undefined, sample()).entry;
		const current = sample(start + 3600000, {
			semanticTransitions: [
				{
					atMs: start + 1800000,
					state: { ...sample().semanticState, sessionStage: "test" },
				},
				{ atMs: start + 1801000, state: sample().semanticState },
			],
		});
		expect(evaluateContinuity(previous, current).activity).toBe("ACTIVE");
		expect(
			evaluateContinuity(
				previous,
				sample(start + 3600000, {
					sourceCursors: { stageEventId: 5, workflowEventSeq: 5 },
				}),
			).activity,
		).toBe("STALLED_60M");
	});
	it("does not attribute another TURN holder's remote progress to a parked runner", () => {
		const old = sample();
		old.canAttributeRemote = false;
		old.semanticState.effectiveWait = { kind: "phase", id: "episode" };
		const previous = evaluateContinuity(undefined, old).entry;
		const next = {
			...old,
			sampledAtMs: start + 3600000,
			refs: [
				{
					...old.refs[0],
					headSha: "b".repeat(40),
					observedAtMs: start + 3600000,
				},
			],
		};
		expect(evaluateContinuity(previous, next).activity).toBe("WAITING");
		expect(evaluateContinuity(previous, next).branch_activity).toBe(true);
	});
	it("does not attribute a branch change across an ambiguous-writer observation", () => {
		const old = sample(start, { canAttributeRemote: false });
		const previous = evaluateContinuity(undefined, old).entry;
		const next = sample(start + 3600000);
		next.refs[0].headSha = "b".repeat(40);
		const result = evaluateContinuity(previous, next);
		expect(result.activity).toBe("UNKNOWN");
		expect(result.reason).toBe("remote_attribution_ambiguous");
		expect(result.entry?.lastProgressObservedAtMs).toBeNull();
	});

	it("resets attribution and coverage across execution or repo identity changes", () => {
		const previous = evaluateContinuity(undefined, sample()).entry;
		const next = sample(start + 3600000);
		next.identity = { ...next.identity, turnEpoch: 2 };
		next.refs[0].headSha = "b".repeat(40);
		expect(evaluateContinuity(previous, next).activity).toBe("OBSERVING");
	});
	it.each(["sourcesComplete", "ownershipComplete", "eventsComplete"] as const)(
		"fails visible for %s",
		(field) => {
			const previous = evaluateContinuity(undefined, sample()).entry;
			expect(
				evaluateContinuity(
					previous,
					sample(start + 3600000, { [field]: false }),
				).activity,
			).toBe("UNKNOWN");
		},
	);
	it("vetoes stalled with positive remote evidence even across a coverage gap", () => {
		const previous = evaluateContinuity(undefined, sample()).entry;
		const current = sample(start + 7200000);
		current.refs[0].headSha = "b".repeat(40);
		expect(evaluateContinuity(previous, current).activity).toBe("ACTIVE");
	});
	it("does not turn a sampling outage, rollback, invalid SHA, or missing ref into stalled", () => {
		const previous = evaluateContinuity(undefined, sample()).entry;
		expect(evaluateContinuity(previous, sample(start + 7200000)).activity).toBe(
			"UNKNOWN",
		);
		expect(evaluateContinuity(previous, sample(start - 1)).activity).toBe(
			"UNKNOWN",
		);
		expect(
			evaluateContinuity(previous, sample(start + 3600000, { refs: [] }))
				.activity,
		).toBe("UNKNOWN");
		const bad = sample(start + 3600000);
		bad.refs[0].headSha = "1234";
		expect(evaluateContinuity(previous, bad).activity).toBe("UNKNOWN");
	});
});
