import { expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";

it("pins a safe review target model to its immutable trusted binding", async () => {
	const store = await StateStore.create(":memory:");
	try {
		const binding = {
			bindingId: "review",
			executionId: "parent",
			runId: null,
			purpose: "review" as const,
			accountKey: "school-key",
			profile: "school",
			generation: 1,
			credentialRootKey: "root",
		};
		store.codexQuota.registerBinding(binding);
		store.codexQuota.registerReviewModel("review", "gpt-6-astra");
		store.codexQuota.registerReviewModel("review", "gpt-6-astra");
		expect(store.codexQuota.getReviewModel("review")).toBe("gpt-6-astra");
		expect(() =>
			store.codexQuota.registerReviewModel("review", "gpt-5.6-sol"),
		).toThrow("quota_review_model_conflict");
		expect(() =>
			store.codexQuota.registerReviewModel("review", "--help"),
		).toThrow("invalid_quota_review_model");
		expect(() =>
			store.codexQuota.registerReviewModel("missing", "gpt-6-astra"),
		).toThrow("quota_review_binding_missing");
		store.codexQuota.registerBinding({
			...binding,
			bindingId: "runner",
			purpose: "runner",
		});
		expect(() =>
			store.codexQuota.registerReviewModel("runner", "gpt-6-astra"),
		).toThrow("quota_review_binding_missing");
	} finally {
		store.close();
	}
});
