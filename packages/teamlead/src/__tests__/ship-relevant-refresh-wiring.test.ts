import { describe, expect, it, vi } from "vitest";
import { buildWorkflowShipRelevantRunRefresh } from "../bridge/ship-relevance-refresh.js";

describe("ship relevance refresh wiring", () => {
	it("shares one stable project-root API across the primary and declared PRs", () => {
		const api = vi.fn();
		const refresh = buildWorkflowShipRelevantRunRefresh({
			executionId: "exec-1",
			api,
			primary: {
				target_repo_identity: "__main__",
				probe_repo_slug: "owner/main",
				pr_number: 41,
				head_sha: "a".repeat(40),
			},
			declared: [
				{
					repo_identity: "owner/nested",
					probe_repo_slug: "owner/nested",
					pr_number: 42,
					frozen_head_sha: "b".repeat(40),
				},
			],
		});

		expect(refresh.primary.api).toBe(api);
		expect(refresh.declared).toHaveLength(1);
		expect(refresh.declared[0]).toMatchObject({
			repoIdentity: "owner/nested",
			repoSlug: "owner/nested",
			prNumber: 42,
			prHeadSha: "b".repeat(40),
			role: "declared",
			api,
		});
	});
});
