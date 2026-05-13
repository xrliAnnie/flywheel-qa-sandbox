import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		// Concurrency tests (60s mailbox writer race) need extra runtime.
		testTimeout: 90_000,
		hookTimeout: 30_000,
	},
});
