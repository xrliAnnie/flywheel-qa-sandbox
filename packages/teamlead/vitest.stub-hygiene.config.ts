import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import baseConfig from "./vitest.config";

// FLY-1883: worker-reuse pairing regression. The polluter file must run before
// the victim file. Vitest's default sequencer uses its results cache and file
// size rather than CLI argument order, which can silently invert this pair.
class StubHygieneSequencer extends BaseSequencer {
	async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
		const rank = (spec: TestSpecification) =>
			spec.moduleId.includes("post-ship-finalization") ? 0 : 1;
		return [...files].sort((a, b) => rank(a) - rank(b));
	}
}

export default defineConfig({
	...baseConfig,
	test: {
		...baseConfig.test,
		isolate: false,
		fileParallelism: false,
		sequence: { sequencer: StubHygieneSequencer },
	},
});
