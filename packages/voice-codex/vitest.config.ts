import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		watch: false,
		pool: "forks",
		poolOptions: { forks: { minForks: 1, maxForks: 1 } },
		exclude: [...configDefaults.exclude, "**/tmux-viewer.macos.test.ts"],
	},
});
