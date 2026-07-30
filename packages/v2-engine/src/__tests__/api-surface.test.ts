import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import * as publicApi from "../index.js";

const EXPECTED_RUNTIME_EXPORTS = [
	"DEFAULT_ENGINE_CONFIG",
	"EngineConfigError",
	"EngineDriver",
	"MAX_EFFECTS_PER_PROPOSAL",
	"MAX_FIELD_BYTES",
	"MAX_PROPOSAL_TOTAL_BYTES",
	"PollTransientError",
	"SESSION_RECIPIENT_PREFIX",
	"canonicalProposalDigest",
	// Codex R3 HIGH-1: the four-state adjudication of a process probe result is
	// part of the public fence contract -- every consumer that decides whether a
	// session is dead must reach the same verdict from the same evidence.
	"classifySessionProcess",
	"enqueue",
	"initializeEngineDb",
	"isSessionRecipient",
	"issueProposalCapability",
	"parseSessionBinding",
	"pollOnce",
	"proposalSubjectDigest",
	"provisionAgentRecipient",
	"readProposalReceipt",
	"reattachAgent",
	"refreshHeartbeat",
	"registerAgentTx",
	"reportConversionFailure",
	"requireAttemptBindingTx",
	"requireCurrentAgentTx",
	"requireCurrentRunnerTx",
	"selectNext",
	"serializeSessionBinding",
	"sessionBindingsEqual",
	"startAttemptTx",
	"submitProposal",
	"validateSessionBinding",
].sort();

describe("v2-engine public package boundary", () => {
	it("exports exactly the approved runtime value set", () => {
		expect(Object.keys(publicApi).sort()).toEqual(EXPECTED_RUNTIME_EXPORTS);
		for (const removed of [
			"ConsumerCoordinator",
			"ENGINE_SQL",
			"MAX_ATTEMPTS",
			"ClaudeInjectionShim",
			"CodexInjectionShim",
			"disposeTerminalRecipient",
			"registerConsumerTx",
			"attachRunner",
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
			"conversion-actions",
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
