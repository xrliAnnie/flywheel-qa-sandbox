import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		watch: false,
		globals: true,
		environment: "node",
		// FLY-598: neutralize prod infra env (real Bridge URL / comm DB / runner
		// identity) BEFORE any test or spawned CLI subprocess can inherit it, so
		// running the suite inside a live runner session cannot leak gate/question
		// events to the production Bridge or write to the real comm DB.
		setupFiles: ["./src/__tests__/setup/isolate-prod-infra.ts"],
	},
});
