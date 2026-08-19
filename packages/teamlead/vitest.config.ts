import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
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
