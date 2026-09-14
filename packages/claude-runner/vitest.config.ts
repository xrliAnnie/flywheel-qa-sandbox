import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// FLY-2467: bound host contention; VITEST_MAX_FORKS remains Vitest's
		// explicit override. This is not an assertion or hook timeout change.
		pool: "forks",
		poolOptions: { forks: { minForks: 1, maxForks: 1 } },
		teardownTimeout: 60_000,
		watch: false,
		globals: true,
		environment: "node",
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			exclude: [
				"node_modules/**",
				"dist/**",
				"**/*.d.ts",
				"**/*.config.*",
				"**/mockData.ts",
				"**/*.test.ts",
			],
		},
	},
});
