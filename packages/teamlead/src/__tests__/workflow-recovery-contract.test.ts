import { canonicalSubmissionDigest } from "flywheel-config";
import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

function candidate() {
	const sourceHoldEventUids = ["hold:a", "hold:b"];
	return {
		version: 2,
		runId: "run-2922",
		shape: "workflow_node_recovery",
		holdEventUid: "hold:a",
		decision: null,
		reason: "operator verified recovery",
		principal: "master",
		clientRequestId: "recovery-2922",
		target: {
			operationKind: "redispatch_current",
			runId: "run-2922",
			nodeId: "implement",
			attempt: 1,
			previousExecutionId: "implement-dead",
			previousLaunchOrdinal: 2,
			snapshotDigest: "a".repeat(64),
			holdSetDigest: canonicalSubmissionDigest(sourceHoldEventUids),
			startAuthority: {
				mode: "execution_head",
				sourceExecutionId: "design-1",
				reservationKey: null,
				repositoryIdentity: "/repos/flywheel",
				branch: "flywheel-FLY-2922",
				headSha: "b".repeat(40),
				evidenceDigest: "c".repeat(64),
				provenance: "predecessor_completion",
			},
			sourceHoldEventUids,
			rework: null,
			land: null,
		},
	};
}

describe("FLY-2922 frozen recovery canonical", () => {
	it("binds every authority field while treating source UIDs as a sorted set", () => {
		const value = candidate();
		const normalized = StateStore.canonicalizeHoldResume(value);
		expect(normalized?.canonical).toEqual(value);
		expect(normalized?.digest).toBe(canonicalSubmissionDigest(value));
		const reordered = structuredClone(value);
		reordered.target.sourceHoldEventUids.reverse();
		expect(StateStore.canonicalizeHoldResume(reordered)).toEqual(normalized);
		for (const mutate of [
			(v: ReturnType<typeof candidate>) => {
				v.target.previousExecutionId = "replacement";
			},
			(v: ReturnType<typeof candidate>) => {
				v.target.previousLaunchOrdinal++;
			},
			(v: ReturnType<typeof candidate>) => {
				v.target.startAuthority.headSha = "d".repeat(40);
			},
			(v: ReturnType<typeof candidate>) => {
				v.target.snapshotDigest = "e".repeat(64);
			},
		]) {
			const changed = structuredClone(value);
			mutate(changed);
			const result = StateStore.canonicalizeHoldResume(changed);
			expect(result).toBeDefined();
			expect(result?.digest).not.toBe(normalized?.digest);
		}
	});

	it("rejects unknown authority, nested extras, ambiguous generations and mismatched episodes", () => {
		const value = candidate();
		const targets = [
			{ ...value.target, runId: "other-run" },
			{ ...value.target, operationKind: "terminate" },
			{ ...value.target, attempt: 0 },
			{ ...value.target, previousLaunchOrdinal: 1.5 },
			{ ...value.target, previousLaunchOrdinal: Number.MAX_SAFE_INTEGER + 1 },
			{ ...value.target, sourceHoldEventUids: ["hold:b"] },
			{ ...value.target, sourceHoldEventUids: ["hold:a", "hold:a"] },
			{ ...value.target, holdSetDigest: "f".repeat(64) },
			{ ...value.target, liveness: "dead" },
			{
				...value.target,
				startAuthority: { ...value.target.startAuthority, headSha: "main" },
			},
			{
				...value.target,
				startAuthority: { ...value.target.startAuthority, trusted: true },
			},
			{ ...value.target, rework: { requestId: "rework", routeRevision: 0 } },
			{
				...value.target,
				land: {
					operationId: "land",
					resumeGeneration: -1,
					approvedHead: "b".repeat(40),
				},
			},
		];
		for (const target of targets) {
			expect(
				StateStore.canonicalizeHoldResume({ ...value, target }),
			).toBeUndefined();
		}
		expect(
			StateStore.canonicalizeHoldResume({ ...value, version: 3 }),
		).toBeUndefined();
		expect(
			StateStore.canonicalizeHoldResume({
				...value,
				shape: "run_held_by_operator",
			}),
		).toBeUndefined();
		expect(
			StateStore.canonicalizeHoldResume({ ...value, liveness: "dead" }),
		).toBeUndefined();
	});

	it("preserves the byte-equivalent legacy canonical and rejects versionless recovery targets", () => {
		const { version: _version, target: _target, ...legacy } = candidate();
		legacy.shape = "run_held_by_operator";
		expect(StateStore.canonicalizeHoldResume(legacy)).toEqual({
			canonical: legacy,
			digest: canonicalSubmissionDigest(legacy),
		});
		expect(
			StateStore.canonicalizeHoldResume({
				...legacy,
				target: candidate().target,
			}),
		).toBeUndefined();
	});
});
