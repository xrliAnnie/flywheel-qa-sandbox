import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		watch: false,
		globals: true,
		environment: "node",
		setupFiles: ["./test/setup.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			exclude: [
				"node_modules",
				"test",
				"dist",
				"**/*.d.ts",
				"**/*.config.*",
				"**/mockData.ts",
			],
		},
		testTimeout: 30000,
		hookTimeout: 30000,
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
			"@test": path.resolve(__dirname, "./test"),
			"flywheel-claude-runner": path.resolve(
				__dirname,
				"../claude-runner/src/index.ts",
			),
			"flywheel-linear-event-transport": path.resolve(
				__dirname,
				"../linear-event-transport/src/index.ts",
			),
		},
	},
});
