import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		watch: false,
		globals: true,
		environment: "node",
		// FLY-493: redirect each test's per-project CommDB to a fresh temp dir so
		// tests never write to the live Bridge comm.db (which the gate-watcher
		// reads — leaked gate questions otherwise spam the Lead).
		setupFiles: ["./vitest.setup.ts"],
	},
});
