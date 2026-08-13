import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

describe("FLY-1718 design review manifest", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => store.close());

	it("advances one current revision and deduplicates a source event replay", () => {
		const first = store.advanceDesignReviewManifest({
			executionId: "exec-1",
			projectName: "flywheel",
			sourceEventId: "evt-1",
			expectedPlanPath: "engineering/doc/FLY-1/plan.md",
			expectedBlobSha: "a".repeat(40),
		});
		const replay = store.advanceDesignReviewManifest({
			executionId: "exec-1",
			projectName: "flywheel",
			sourceEventId: "evt-1",
			expectedPlanPath: "engineering/doc/FLY-1/plan.md",
			expectedBlobSha: "a".repeat(40),
		});

		expect(first.revision).toBe(1);
		expect(replay).toEqual(first);
		expect(store.getCurrentDesignReviewManifest("exec-1")).toEqual(first);
	});

	it("makes a re-stage the sole current request and tracks delivery receipt", () => {
		const first = store.advanceDesignReviewManifest({
			executionId: "exec-1",
			projectName: "flywheel",
			sourceEventId: "evt-1",
			expectedPlanPath: "engineering/doc/FLY-1/plan-a.md",
			expectedBlobSha: "a".repeat(40),
		});
		const second = store.advanceDesignReviewManifest({
			executionId: "exec-1",
			projectName: "flywheel",
			sourceEventId: "evt-2",
			expectedPlanPath: "engineering/doc/FLY-1/plan-b.md",
			expectedBlobSha: "b".repeat(40),
		});

		expect(second.revision).toBe(2);
		expect(second.request_id).not.toBe(first.request_id);
		expect(store.getCurrentDesignReviewManifest("exec-1")).toEqual(second);
		expect(store.listUndeliveredDesignReviewManifests()).toEqual([second]);

		expect(
			store.markDesignReviewManifestDelivered(
				second.execution_id,
				second.revision,
			),
		).toBe(true);
		expect(store.listUndeliveredDesignReviewManifests()).toEqual([]);
		expect(
			store.markDesignReviewManifestDelivered(
				second.execution_id,
				second.revision,
			),
		).toBe(false);
	});
});
