import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import * as publicApi from "../index.js";

const EXPECTED_RUNTIME_EXPORTS = [
	"ClaudeInjectionShim",
	"CodexInjectionShim",
	"DEFAULT_ENGINE_CONFIG",
	"EngineConfigError",
	"EngineDriver",
	"MAX_EFFECTS_PER_PROPOSAL",
	"MAX_FIELD_BYTES",
	"MAX_PROPOSAL_TOTAL_BYTES",
	"PollTransientError",
	"enqueue",
	"initializeEngineDb",
	"provisionAgentRecipient",
	"registerAgentTx",
	"reportConversionFailure",
	"selectNext",
	"submitProposal",
].sort();

describe("v2-engine public package boundary", () => {
	it("exports exactly the approved runtime value set", () => {
		expect(Object.keys(publicApi).sort()).toEqual(EXPECTED_RUNTIME_EXPORTS);
		for (const removed of [
			"ConsumerCoordinator",
			"ENGINE_SQL",
			"MAX_ATTEMPTS",
			"disposeTerminalRecipient",
			"registerConsumerTx",
		]) {
			expect(removed in publicApi).toBe(false);
		}
	});

	it("allows only the package root", () => {
		const rootKeys = JSON.parse(
			execFileSync(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					"console.log(JSON.stringify(Object.keys(await import('flywheel-v2-engine')).sort()))",
				],
				{ cwd: new URL("../..", import.meta.url), encoding: "utf8" },
			),
		);
		expect(rootKeys).toEqual(EXPECTED_RUNTIME_EXPORTS);

		for (const subpath of [
			"driver",
			"transitions",
			"settlement",
			"dist/index.js",
		]) {
			const code = `try { await import('flywheel-v2-engine/${subpath}'); process.exit(2); } catch (error) { console.log(error.code); }`;
			expect(
				execFileSync(process.execPath, ["--input-type=module", "-e", code], {
					cwd: new URL("../..", import.meta.url),
					encoding: "utf8",
				}).trim(),
			).toBe("ERR_PACKAGE_PATH_NOT_EXPORTED");
		}
		// Five synchronous node spawns: the default 5s budget is a machine-load
		// measurement, not an API-surface assertion (QA reproduced a cold-cache
		// failure at 5104ms).
	}, 60_000);
});
