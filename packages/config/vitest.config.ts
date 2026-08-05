import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		watch: false,
		globals: true,
		environment: "node",
		env: {
			FLYWHEEL_MODELS_CONFIG: fileURLToPath(
				new URL(
					"./src/__tests__/fixtures/models.builtin.json",
					import.meta.url,
				),
			),
		},
	},
});
