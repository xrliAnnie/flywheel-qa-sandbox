import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		watch: false,
		globals: true,
		environment: "node",
		include: ["test/tmux-3.7c-exact.gate.ts"],
	},
});
