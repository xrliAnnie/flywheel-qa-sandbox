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
			env: { A_TOKEN: "scoped-a" },
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
