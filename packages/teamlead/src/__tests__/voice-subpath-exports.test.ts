import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CodexLeadProcess, spawnCodexAppServer } from "../codex-process.js";
import { acquireProcessLifetimeFileLock } from "../process-lock.js";

describe("generic voice narrow imports", () => {
	it("lets an external CoS caller import the Bridge port without the package root", () => {
		const output = execFileSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				'import { createVoiceIntentPort } from "flywheel-teamlead/cos-ports/voice-intent"; console.log(typeof createVoiceIntentPort);',
			],
			{ cwd: new URL("../..", import.meta.url), encoding: "utf8" },
		);
		expect(output.trim()).toBe("function");
	});

	it("exports the Codex process and process lock without importing the package root", () => {
		expect(CodexLeadProcess).toBeTypeOf("function");
		expect(spawnCodexAppServer).toBeTypeOf("function");
		expect(acquireProcessLifetimeFileLock).toBeTypeOf("function");
	});
});
