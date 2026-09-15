import { expect, it, vi } from "vitest";
import { preflightShipJudgmentInputs } from "../ship-judgment-runtime.js";

const dependencies = () => ({
	projectRepo: "Owner/Repo",
	linearApiKey: "fixture-linear",
	repositories: vi.fn(() => [
		{ repo_identity: "__main__", repo_slug: "owner/repo" },
	]),
	token: vi.fn(async (_signal: AbortSignal) => "fixture-token"),
});

it("returns normalized repository inputs after credential preflight", async () => {
	const deps = dependencies();
	expect(
		await preflightShipJudgmentInputs(deps, new AbortController().signal),
	).toEqual({
		status: "ready",
		reason: "evidence_complete",
		repositories: [{ repo_identity: "__main__", repo_slug: "owner/repo" }],
	});
	expect(deps.repositories).toHaveBeenCalledWith("owner/repo");
});

it.each([
	["repository_slug_invalid", { projectRepo: "invalid slug" }],
	["repositories_unavailable", { repositories: () => undefined }],
	["repositories_unavailable", { repositories: () => [] }],
	["linear_credentials_missing", { linearApiKey: "" }],
	["github_credentials_unavailable", { token: async () => "" }],
	[
		"github_credentials_unavailable",
		{
			token: async () => {
				throw new Error("secret must not leak");
			},
		},
	],
] as const)("identifies missing input: %s", async (reason, override) => {
	expect(
		await preflightShipJudgmentInputs(
			{ ...dependencies(), ...override },
			new AbortController().signal,
		),
	).toEqual({ status: "unavailable", reason });
});

it("bounds a credential resolver that ignores cancellation", async () => {
	vi.useFakeTimers();
	try {
		const pending = preflightShipJudgmentInputs(
			{ ...dependencies(), token: () => new Promise<string>(() => {}) },
			new AbortController().signal,
		);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(await pending).toEqual({
			status: "unavailable",
			reason: "github_credentials_unavailable",
		});
	} finally {
		vi.useRealTimers();
	}
});
