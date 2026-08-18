import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("FLY-1808 retired runner autocontinue", () => {
	it("Bridge boot has no armer import, construction, or enable env", () => {
		const plugin = readFileSync(
			fileURLToPath(new URL("../plugin.ts", import.meta.url)),
			"utf8",
		);
		expect(plugin).not.toMatch(
			/AutoContinueArmer|autocontinue-armer|FLYWHEEL_RUNNER_AUTOCONTINUE/,
		);
	});
});
