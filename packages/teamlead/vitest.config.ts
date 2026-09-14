import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
import TeamleadSequencer, { serialFiles } from "./vitest.shards.mjs";

export default defineConfig({
	test: {
		sequence: { sequencer: TeamleadSequencer },
		projects: [
			{ extends: true, test: { name: "serial", include: serialFiles } },
			{
				extends: true,
				test: {
					name: "parallel",
					exclude: [...configDefaults.exclude, ...serialFiles],
				},
			},
		],
		// FLY-2467: bound host contention; VITEST_MAX_FORKS remains Vitest's
		// explicit override. This is not an assertion or hook timeout change.
		pool: "forks",
		poolOptions: { forks: { minForks: 1, maxForks: 1 } },
		teardownTimeout: 60_000,
		watch: false,
		globals: true,
		unstubGlobals: true,
		environment: "node",
		env: {
			// Tests pin the built-in model policy. Production intentionally hot-reads
			// ~/.flywheel/models.json, but a developer's live policy must not rewrite
			// workflow snapshots or model aliases underneath this suite.
			FLYWHEEL_MODELS_CONFIG: fileURLToPath(
				new URL(
					"../config/src/__tests__/fixtures/models.builtin.json",
					import.meta.url,
				),
			),
		},
		// FLY-493: redirect each test's per-project CommDB to a fresh temp dir so
		// tests never write to the live Bridge comm.db (which the gate-watcher
		// reads — leaked gate questions otherwise spam the Lead).
		setupFiles: ["./vitest.setup.ts"],
	},
});
