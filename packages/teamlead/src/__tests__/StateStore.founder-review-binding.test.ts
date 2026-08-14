import { beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const DIGEST = "a".repeat(64);

describe("StateStore founder review card bindings", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("inserts once, verifies exact replay, and supports both indexed lookups", () => {
		const input = {
			questionId: "q-1",
			messageId: "m-1",
			runId: "run-1",
			artifactDigest: DIGEST,
			createdAt: "2026-08-14T12:00:00.000Z",
		};
		expect(store.bindFounderReviewCard(input)).toEqual({ status: "inserted" });
		expect(store.bindFounderReviewCard(input)).toEqual({ status: "verified" });
		expect(
			store.bindFounderReviewCard({
				...input,
				createdAt: "2026-08-14T12:01:00.000Z",
			}),
		).toEqual({ status: "verified" });
		expect(store.getFounderReviewCardBindingByQuestion("q-1")).toEqual(
			expect.objectContaining({ question_id: "q-1", message_id: "m-1" }),
		);
		expect(store.getFounderReviewCardBindingByMessage("m-1")).toEqual({
			question_id: "q-1",
			message_id: "m-1",
			run_id: "run-1",
			artifact_digest: DIGEST,
			created_at: "2026-08-14T12:00:00.000Z",
		});
		expect(store.listFounderReviewCardBindingsForRun("run-1")).toEqual([
			expect.objectContaining({ question_id: "q-1", message_id: "m-1" }),
		]);
	});

	it("fails closed when either immutable identity is reused for another round", () => {
		expect(
			store.bindFounderReviewCard({
				questionId: "q-1",
				messageId: "m-1",
				runId: "run-1",
				artifactDigest: DIGEST,
				createdAt: "2026-08-14T12:00:00.000Z",
			}),
		).toEqual({ status: "inserted" });
		expect(
			store.bindFounderReviewCard({
				questionId: "q-1",
				messageId: "m-2",
				runId: "run-1",
				artifactDigest: DIGEST,
				createdAt: "2026-08-14T12:01:00.000Z",
			}),
		).toEqual({ status: "conflict" });
		expect(
			store.bindFounderReviewCard({
				questionId: "q-2",
				messageId: "m-1",
				runId: "run-1",
				artifactDigest: DIGEST,
				createdAt: "2026-08-14T12:01:00.000Z",
			}),
		).toEqual({ status: "conflict" });
	});
});
