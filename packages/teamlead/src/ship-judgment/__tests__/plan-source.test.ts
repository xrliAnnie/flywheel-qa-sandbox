import { describe, expect, it, vi } from "vitest";
import { readReviewedPlanSource } from "../plan-source.js";
import { bindingFixture, HEAD } from "./binding-fixture.js";

describe("reviewed plan source", () => {
	it("selects the current run review, pins its path to the PR head and rejects later pending review or blob drift", async () => {
		const { store } = await bindingFixture();
		try {
			store.insertCodexReviewJob({
				requestId: "review1",
				executionId: "execution",
				issueId: "FLY-2399",
				projectName: "flywheel",
				reviewType: "design",
				questionId: "review-q1",
				targetPath: "engineering/doc/FLY-2399-learning/plan.md",
			});
			store.completeCodexReviewJob("review1", "APPROVED");
			const reference = store.readShipJudgmentPlanReference("r", "__main__");
			expect(reference).toMatchObject({
				requestId: "review1",
				path: "engineering/doc/FLY-2399-learning/plan.md",
			});
			const reader = {
				readText: vi.fn(async () => ({
					text: "R1: requirement",
					blobSha: "b".repeat(40),
				})),
			};
			expect(
				await readReviewedPlanSource(reference, HEAD, reader),
			).toMatchObject({ body: "R1: requirement", format: "text" });
			expect(reader.readText).toHaveBeenCalledWith(HEAD, reference!.path);
			expect(
				await readReviewedPlanSource(
					{ ...reference!, expectedBlobSha: "c".repeat(40) },
					HEAD,
					reader,
				),
			).toBeNull();
			for (const path of [
				"/tmp/plan.md",
				"../plan.md",
				"a/../plan.md",
				"a\\plan.md",
			]) {
				const calls = reader.readText.mock.calls.length;
				expect(
					await readReviewedPlanSource({ ...reference!, path }, HEAD, reader),
				).toBeNull();
				expect(reader.readText).toHaveBeenCalledTimes(calls);
			}
			store.insertCodexReviewJob({
				requestId: "review2",
				executionId: "execution",
				issueId: "FLY-2399",
				projectName: "flywheel",
				reviewType: "design",
				round: 2,
				questionId: "review-q2",
				targetPath: reference!.path,
			});
			expect(
				store.readShipJudgmentPlanReference("r", "__main__"),
			).toBeUndefined();
			expect(
				store.readShipJudgmentPlanReference("r", "unrelated-repo"),
			).toBeUndefined();
		} finally {
			store.close();
		}
	});
});
