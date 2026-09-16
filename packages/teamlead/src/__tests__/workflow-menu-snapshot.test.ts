import {
	getModelConfigSnapshot,
	type ModelConfigSnapshot,
} from "flywheel-config";
import { describe, expect, it } from "vitest";
import {
	compileWorkflowMenuSeed,
	loadWorkflowMenuLibrary,
	loadWorkflowMenuSeeds,
} from "../workflow-menu.js";

// An operation's captured generation may reject models accepted by ambient
// configuration. Every layer must honor that rejection, including YAML parsing.
function rejectingSnapshot(): ModelConfigSnapshot {
	return {
		...getModelConfigSnapshot(),
		getModelRegistryEntry() {
			throw new Error("captured generation rejects model");
		},
	};
}

describe("workflow seed publication model generation", () => {
	it("uses the captured generation while loading registry policies", () => {
		expect(() =>
			loadWorkflowMenuLibrary({ modelSnapshot: rejectingSnapshot() }),
		).toThrow("captured generation rejects model");
	});

	it("uses the captured generation while resolving compiled model aliases", () => {
		const menu = loadWorkflowMenuLibrary().find(
			(entry) => entry.shape === "simple_code",
		)!;
		expect(() => compileWorkflowMenuSeed(menu, rejectingSnapshot())).toThrow(
			"captured generation rejects model",
		);
	});

	it("propagates a publication generation from the seed entrypoint", () => {
		expect(() => loadWorkflowMenuSeeds(rejectingSnapshot())).toThrow(
			"captured generation rejects model",
		);
	});
});
