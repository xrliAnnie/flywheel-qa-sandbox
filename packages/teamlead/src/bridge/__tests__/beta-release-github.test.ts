import { expect, it, vi } from "vitest";
import type { BetaProjectConfig } from "../beta-release-config-source.js";
import { BetaReleaseGitHub } from "../beta-release-github.js";

const project: BetaProjectConfig = {
	projectName: "a",
	projectRoot: "/a",
	projectRepo: "test/a",
	reason: null,
	config: {
		interval_hours: 6,
		workflow_file: "beta.yml",
		token_env: "A_TOKEN",
	},
};
const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), { status });
it("binds stable numeric repository/workflow identity with only the project credential", async () => {
	const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
		expect(init?.redirect).toBe("error");
		expect(new Headers(init?.headers).get("Authorization")).toBe(
			"Bearer scoped-a",
		);
		if (url.endsWith("/repos/test/a"))
			return json({ id: 11, full_name: "test/a", default_branch: "main" });
		return json({
			id: 22,
			path: ".github/workflows/beta.yml",
			state: "active",
		});
	});
	const api = new BetaReleaseGitHub({
		env: { A_TOKEN: "scoped-a", GH_TOKEN: "wrong" },
		fetch: fetcher,
	});
	const binding = await api.resolve(project, new AbortController().signal);
	expect(binding).toMatchObject({
		projectName: "a",
		repositoryId: 11,
		workflowId: 22,
		canonicalRepo: "test/a",
		defaultBranch: "main",
		tokenEnv: "A_TOKEN",
	});
	expect(binding.bindingRevision).toMatch(/^[a-f0-9]{64}$/);
	await expect(
		new BetaReleaseGitHub({
			env: { GH_TOKEN: "wrong" },
			fetch: fetcher,
		}).resolve(project, new AbortController().signal),
	).rejects.toThrow("beta_credential_missing");
});
it("reads owner only from a complete successful variables listing; 404 never means legacy", async () => {
	let mode = "bridge";
	const fetcher = vi.fn(async (url: string) => {
		if (url.endsWith("/repos/test/a"))
			return json({ id: 11, full_name: "test/a", default_branch: "main" });
		if (url.includes("/actions/workflows/"))
			return json({
				id: 22,
				path: ".github/workflows/beta.yml",
				state: "active",
			});
		if (mode === "404") return json({}, 404);
		return json({
			total_count: mode === "missing" ? 0 : 1,
			variables:
				mode === "missing"
					? []
					: [{ name: "FW_BETA_SCHEDULER_OWNER", value: mode }],
		});
	});
	const api = new BetaReleaseGitHub({
		env: { A_TOKEN: "scoped-a" },
		fetch: fetcher,
	});
	const signal = new AbortController().signal;
	const binding = await api.resolve(project, signal);
	expect(await api.owner(binding, signal)).toBe("bridge");
	mode = "missing";
	expect(await api.owner(binding, signal)).toBe("legacy");
	mode = "404";
	await expect(api.owner(binding, signal)).rejects.toThrow(
		"beta_github_http_404",
	);
});
it("posts only the frozen schedule tuple and treats 204 or malformed acceptance as unknown", async () => {
	let status = 200;
	const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
		if (url.endsWith("/repos/test/a"))
			return json({ id: 11, full_name: "test/a", default_branch: "main" });
		if (url.endsWith("/commits/main")) return json({ sha: "b".repeat(40) });
		if (url.endsWith("/dispatches")) {
			expect(JSON.parse(String(init?.body))).toEqual({
				ref: "main",
				inputs: {
					"schedule-key": occurrence.occurrenceId,
					"source-commit": "b".repeat(40),
					"project-key": "a",
				},
			});
			return status === 204
				? new Response(null, { status: 204 })
				: json({
						workflow_run_id: 33,
						run_url: "https://api.github.com/repos/test/a/actions/runs/33",
						html_url: "https://github.com/test/a/actions/runs/33",
					});
		}
		return json({
			id: 22,
			path: ".github/workflows/beta.yml",
			state: "active",
		});
	});
	const api = new BetaReleaseGitHub({
		env: { A_TOKEN: "scoped-a" },
		fetch: fetcher,
	});
	const signal = new AbortController().signal;
	const binding = await api.resolve(project, signal);
	const { betaOccurrenceId } = await import("../beta-release-contract.js");
	const occurrence = {
		occurrenceId: betaOccurrenceId("a", binding.bindingRevision, 3600000),
		projectName: "a",
		bindingRevision: binding.bindingRevision,
		scheduledAtMs: 3600000,
		sourceCommit: "b".repeat(40),
		state: "prepared" as const,
		runIds: [],
		attemptCount: 0,
		retryAtMs: null,
		lastError: null,
		createdAtMs: 3600000,
		settledAtMs: null,
	};
	expect(await api.head(binding, signal)).toBe("b".repeat(40));
	expect(await api.dispatch(binding, occurrence, signal)).toBe(33);
	status = 204;
	expect(await api.dispatch(binding, occurrence, signal)).toBeNull();
	await expect(
		api.dispatch(binding, { ...occurrence, projectName: "b" }, signal),
	).rejects.toThrow("beta_binding_invalid");
});
it("recovers all matching runs across pages and rechecks known live handles", async () => {
	const fetcher = vi.fn(async (url: string) => {
		if (url.endsWith("/repos/test/a"))
			return json({ id: 11, full_name: "test/a", default_branch: "main" });
		if (url.includes("/actions/workflows/beta.yml"))
			return json({
				id: 22,
				path: ".github/workflows/beta.yml",
				state: "active",
			});
		const run = (id: number) => ({
			id,
			repository: { id: 11 },
			workflow_id: 22,
			event: "workflow_dispatch",
			head_branch: "main",
			display_title: `beta-schedule:${occurrence.occurrenceId}`,
			status: "in_progress",
			conclusion: null,
		});
		if (url.includes("/workflows/22/runs?"))
			return json({
				total_count: 2,
				workflow_runs: [run(url.includes("page=2") ? 44 : 33)],
			});
		if (url.endsWith("/runs/33")) return json(run(33));
		if (url.endsWith("/runs/44")) return json(run(44));
		throw new Error("unexpected url");
	});
	const api = new BetaReleaseGitHub({
		env: { A_TOKEN: "scoped-a" },
		fetch: fetcher,
	});
	const signal = new AbortController().signal;
	const binding = await api.resolve(project, signal);
	const { betaOccurrenceId } = await import("../beta-release-contract.js");
	const occurrence: import("../beta-release-contract.js").BetaOccurrence = {
		occurrenceId: betaOccurrenceId("a", binding.bindingRevision, 3600000),
		projectName: "a",
		bindingRevision: binding.bindingRevision,
		scheduledAtMs: 3600000,
		sourceCommit: "b".repeat(40),
		state: "dispatch_unknown",
		runIds: [33],
		attemptCount: 2,
		retryAtMs: null,
		lastError: null,
		createdAtMs: 3600000,
		settledAtMs: null,
	};
	expect(
		(await api.observe(binding, occurrence, signal)).runs.map((r) => r.id),
	).toEqual([33, 44]);
	expect(
		fetcher.mock.calls.filter(([url]) => url.includes("/workflows/22/runs?")),
	).toHaveLength(2);
});
it("downloads and binds a successful receipt without forwarding credentials to artifact storage", async () => {
	const { receiptZip } = await import("./beta-release-zip-fixture.js");
	let redirect = "https://example.blob.core.windows.net/artifact";
	let outcome = "published";
	let ancestry = "ahead";
	const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
		if (url === redirect) {
			expect(new Headers(init?.headers).get("Authorization")).toBeNull();
			expect(init?.redirect).toBe("error");
			return new Response(
				receiptZip([
					{
						name: "receipt.json",
						data: JSON.stringify({
							schemaVersion: 1,
							projectName: "a",
							repositoryId: 11,
							workflowId: 22,
							runId: 33,
							scheduleKey: occurrence.occurrenceId,
							sourceCommit: occurrence.sourceCommit,
							outcome,
							publishedSourceCommit:
								outcome === "covered_by_newer"
									? "c".repeat(40)
									: occurrence.sourceCommit,
							publishedVersion: "beta-a",
							publishedAt: "2026-09-11T00:00:00.000Z",
						}),
					},
				]),
			);
		}
		if (url.endsWith("/repos/test/a"))
			return json({ id: 11, full_name: "test/a", default_branch: "main" });
		if (url.includes("/actions/workflows/beta.yml"))
			return json({
				id: 22,
				path: ".github/workflows/beta.yml",
				state: "active",
			});
		const run = {
			id: 33,
			repository: { id: 11 },
			workflow_id: 22,
			event: "workflow_dispatch",
			head_branch: "main",
			display_title: `beta-schedule:${occurrence.occurrenceId}`,
			status: "completed",
			conclusion: "success",
		};
		if (url.includes("/workflows/22/runs?"))
			return json({ total_count: 1, workflow_runs: [run] });
		if (url.endsWith("/runs/33")) return json(run);
		if (url.includes("/runs/33/artifacts?"))
			return json({
				total_count: 1,
				artifacts: [
					{
						id: 55,
						name: "beta-schedule-receipt",
						expired: false,
						size_in_bytes: 100,
					},
				],
			});
		if (url.includes("/compare/"))
			return json({
				status: ancestry,
				behind_by: 0,
				merge_base_commit: { sha: occurrence.sourceCommit },
			});
		if (url.endsWith("/artifacts/55/zip")) {
			expect(init?.redirect).toBe("manual");
			return new Response(null, {
				status: 302,
				headers: { Location: redirect },
			});
		}
		throw new Error("unexpected request");
	});
	const api = new BetaReleaseGitHub({
		env: { A_TOKEN: "scoped-a" },
		fetch: fetcher,
	});
	const signal = new AbortController().signal;
	const binding = await api.resolve(project, signal);
	const { betaOccurrenceId } = await import("../beta-release-contract.js");
	const occurrence: import("../beta-release-contract.js").BetaOccurrence = {
		occurrenceId: betaOccurrenceId("a", binding.bindingRevision, 3600000),
		projectName: "a",
		bindingRevision: binding.bindingRevision,
		scheduledAtMs: 3600000,
		sourceCommit: "b".repeat(40),
		state: "accepted",
		runIds: [33],
		attemptCount: 1,
		retryAtMs: null,
		lastError: null,
		createdAtMs: 3600000,
		settledAtMs: null,
	};
	expect(
		(await api.observe(binding, occurrence, signal)).runs[0]?.receipt?.outcome,
	).toBe("published");
	outcome = "covered_by_newer";
	expect(
		(await api.observe(binding, occurrence, signal)).runs[0]?.receipt?.outcome,
	).toBe("covered_by_newer");
	ancestry = "diverged";
	await expect(api.observe(binding, occurrence, signal)).rejects.toThrow(
		"beta_receipt_ancestry",
	);
	outcome = "published";
	redirect = "https://evil.example/artifact";
	await expect(api.observe(binding, occurrence, signal)).rejects.toThrow(
		"beta_artifact_redirect",
	);
	expect(fetcher.mock.calls.some(([url]) => url === redirect)).toBe(false);
});
it("honors the request timeout and returns a bounded Retry-After without response text", async () => {
	vi.useFakeTimers();
	try {
		const fetcher = vi.fn(
			(_url: string, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(new Error("sensitive transport detail")),
						{ once: true },
					);
				}),
		);
		const api = new BetaReleaseGitHub({
			env: { A_TOKEN: "scoped-a" },
			fetch: fetcher,
		});
		const pending = expect(
			api.resolve(project, new AbortController().signal),
		).rejects.toThrow("beta_github_timeout");
		await vi.advanceTimersByTimeAsync(10000);
		await pending;
		const limited = new BetaReleaseGitHub({
			env: { A_TOKEN: "scoped-a" },
			now: () => 1000,
			fetch: async () =>
				new Response("sensitive server detail", {
					status: 429,
					headers: { "Retry-After": "120" },
				}),
		});
		await expect(
			limited.resolve(project, new AbortController().signal),
		).rejects.toMatchObject({
			code: "beta_github_http_429",
			retryAtMs: 121000,
			message: "beta_github_http_429",
		});
	} finally {
		vi.useRealTimers();
	}
});
it("does not infer missing owner from malformed variable records", async () => {
	const api = new BetaReleaseGitHub({
		env: { A_TOKEN: "scoped-a" },
		fetch: async () => json({ total_count: 1, variables: [{}] }),
	});
	await expect(
		api.owner(
			{
				projectName: "a",
				repositoryId: 11,
				workflowId: 22,
				canonicalRepo: "test/a",
				defaultBranch: "main",
				bindingRevision: "r",
				tokenEnv: "A_TOKEN",
			},
			new AbortController().signal,
		),
	).rejects.toThrow("beta_github_schema");
});
it("checks old queued and running workflow runs before first takeover", async () => {
	let active = true;
	const api = new BetaReleaseGitHub({
		env: { A_TOKEN: "scoped-a" },
		fetch: async () =>
			json({
				total_count: active ? 1 : 0,
				workflow_runs: active ? [{ id: 3 }] : [],
			}),
	});
	const binding = {
		projectName: "a",
		repositoryId: 11,
		workflowId: 22,
		canonicalRepo: "test/a",
		defaultBranch: "main",
		bindingRevision: "r",
		tokenEnv: "A_TOKEN",
	};
	const signal = new AbortController().signal;
	await expect(api.assertDrained(binding, signal)).rejects.toThrow(
		"beta_takeover_not_drained",
	);
	active = false;
	await expect(api.assertDrained(binding, signal)).resolves.toBeUndefined();
});
