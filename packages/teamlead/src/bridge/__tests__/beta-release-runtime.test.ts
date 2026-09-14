import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import { createBetaReleaseRuntime } from "../beta-release-runtime.js";

it("runs canonical project configuration without a management console and stops cleanly", async () => {
	const root = await mkdtemp(join(tmpdir(), "beta-runtime-"));
	const store = await StateStore.create(":memory:");
	try {
		await mkdir(join(root, ".flywheel"));
		await writeFile(
			join(root, ".flywheel/config.yaml"),
			"beta_release:\n  interval_hours: 6\n  workflow_file: beta.yml\n  token_env: A_TOKEN\n",
		);
		let now = 0;
		let dispatches = 0;
		const runtime = createBetaReleaseRuntime({
			store: () => store.betaSchedules,
			projects: () => [
				{ projectName: "a", projectRoot: root, projectRepo: "test/a" },
			],
			env: { FLYWHEEL_BETA_ACTIONS_TOKEN_ENVS: "A_TOKEN", A_TOKEN: "scoped-a" },
			now: () => now,
			fetch: async (url, init) => {
				if (init?.method === "POST") {
					dispatches++;
					return new Response(
						JSON.stringify({
							workflow_run_id: 33,
							run_url: "https://api.github.com/repos/test/a/actions/runs/33",
							html_url: "https://github.com/test/a/actions/runs/33",
						}),
					);
				}
				if (url.includes("/runs?status="))
					return new Response(
						JSON.stringify({ total_count: 0, workflow_runs: [] }),
					);
				const value = url.endsWith("/repos/test/a")
					? { id: 1, full_name: "test/a", default_branch: "main" }
					: url.includes("/actions/variables?")
						? {
								total_count: 1,
								variables: [
									{ name: "FW_BETA_SCHEDULER_OWNER", value: "bridge" },
								],
							}
						: url.endsWith("/commits/main")
							? { sha: "a".repeat(40) }
							: { id: 2, path: ".github/workflows/beta.yml", state: "active" };
				return new Response(JSON.stringify(value));
			},
		});
		await runtime.tick();
		expect(dispatches).toBe(0);
		expect(store.betaSchedules.lane("a")?.nextDueAtMs).toBe(6 * 3600000);
		now = 6 * 3600000;
		await runtime.tick();
		expect(dispatches).toBe(1);
		await runtime.stop();
		now += 3600000;
		await runtime.tick();
		expect(dispatches).toBe(1);
	} finally {
		store.close();
		await rm(root, { recursive: true, force: true });
	}
});

async function localSourceFixture() {
	const root = await mkdtemp(join(tmpdir(), "beta-runtime-local-"));
	const deployedShaPath = join(root, "deployed-sha");
	const store = await StateStore.create(":memory:");
	await mkdir(join(root, ".flywheel"));
	await writeFile(
		join(root, ".flywheel/config.yaml"),
		"beta_release:\n  interval_hours: 6\n  workflow_file: beta.yml\n  token_env: A_TOKEN\n  source_commit: local_deployed_sha\n",
	);
	let now = 0;
	const requests: string[] = [];
	const dispatches: unknown[] = [];
	const runtime = createBetaReleaseRuntime({
		store: () => store.betaSchedules,
		projects: () => [
			{ projectName: "a", projectRoot: root, projectRepo: "test/a" },
		],
		env: {
			FLYWHEEL_BETA_ACTIONS_TOKEN_ENVS: "A_TOKEN",
			A_TOKEN: "scoped-a",
			FLYWHEEL_DEPLOYED_SHA_FILE: deployedShaPath,
		},
		now: () => now,
		fetch: async (url, init) => {
			requests.push(url);
			if (init?.method === "POST") {
				dispatches.push(JSON.parse(String(init.body)));
				return new Response(
					JSON.stringify({
						workflow_run_id: 33,
						run_url: "https://api.github.com/repos/test/a/actions/runs/33",
						html_url: "https://github.com/test/a/actions/runs/33",
					}),
				);
			}
			if (url.includes("/compare/")) {
				const sha = url.split("/compare/")[1]!.split("...")[0];
				return new Response(
					JSON.stringify({
						status: "ahead",
						behind_by: 0,
						merge_base_commit: { sha },
					}),
				);
			}
			if (url.includes("/runs?status="))
				return new Response(
					JSON.stringify({ total_count: 0, workflow_runs: [] }),
				);
			const value = url.endsWith("/repos/test/a")
				? { id: 1, full_name: "test/a", default_branch: "main" }
				: url.includes("/actions/variables?")
					? {
							total_count: 1,
							variables: [{ name: "FW_BETA_SCHEDULER_OWNER", value: "bridge" }],
						}
					: url.endsWith("/commits/main")
						? { sha: "a".repeat(40) }
						: { id: 2, path: ".github/workflows/beta.yml", state: "active" };
			return new Response(JSON.stringify(value));
		},
	});
	return {
		store,
		runtime,
		deployedShaPath,
		requests,
		dispatches,
		setNow: (value: number) => {
			now = value;
		},
		close: async () => {
			await runtime.stop();
			store.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

it("rereads the real deployed SHA file from injected env at due time and freezes its source attribution", async () => {
	const f = await localSourceFixture();
	try {
		await writeFile(f.deployedShaPath, `${"b".repeat(40)}\n`);
		await f.runtime.tick();
		expect(f.store.betaSchedules.lane("a")?.nextDueAtMs).toBe(6 * 3600000);
		await writeFile(f.deployedShaPath, `${"c".repeat(40)}\n`);
		f.setNow(6 * 3600000);
		await f.runtime.tick();
		expect(f.dispatches).toHaveLength(1);
		expect(f.dispatches[0]).toMatchObject({
			inputs: { "source-commit": "c".repeat(40) },
		});
		expect(f.store.betaSchedules.active("a")).toMatchObject({
			sourceCommit: "c".repeat(40),
			sourceOrigin: "local_deployed_sha",
		});
		await writeFile(f.deployedShaPath, "d".repeat(40));
		expect(f.store.betaSchedules.active("a")).toMatchObject({
			sourceCommit: "c".repeat(40),
			sourceOrigin: "local_deployed_sha",
		});
		expect(f.requests.some((url) => url.endsWith("/commits/main"))).toBe(false);
		expect(
			f.requests.some((url) =>
				url.includes(`/compare/${"c".repeat(40)}...main`),
			),
		).toBe(true);
	} finally {
		await f.close();
	}
});

for (const failure of ["missing", "invalid"] as const) {
	for (const phase of ["activation", "due"] as const) {
		it(`rejects ${failure} deployed SHA file at ${phase} without a HEAD fallback`, async () => {
			const f = await localSourceFixture();
			try {
				if (phase === "due") {
					await writeFile(f.deployedShaPath, "b".repeat(40));
					await f.runtime.tick();
					expect(f.store.betaSchedules.lane("a")).not.toBeNull();
					f.setNow(6 * 3600000);
				}
				if (failure === "missing") await rm(f.deployedShaPath, { force: true });
				else await writeFile(f.deployedShaPath, "not-a-sha");
				await f.runtime.tick();
				expect(f.runtime.snapshot()[0]).toMatchObject({
					status: "attention",
					reason: "beta_source_unavailable",
				});
				if (phase === "activation")
					expect(f.store.betaSchedules.lane("a")).toBeNull();
				expect(f.store.betaSchedules.active("a")).toBeNull();
				expect(f.dispatches).toHaveLength(0);
				expect(
					f.requests.some(
						(url) => url.endsWith("/commits/main") || url.includes("/compare/"),
					),
				).toBe(false);
			} finally {
				await f.close();
			}
		});
	}
}
