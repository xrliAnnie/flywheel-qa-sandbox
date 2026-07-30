import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../cli.js";

/**
 * FLY-1503 item 2 — the CLI surface for an evidenced generation takeover.
 *
 * registerAgentTx validated DeathEvidence and driver.registerLead forwarded it,
 * but no operator-reachable surface could supply it, so a lead whose session was
 * confirmed dead could never be replaced.
 */
const BASE = [
	"register-lead",
	"--socket",
	"/tmp/flywheel-v2/host.sock",
	"--secret",
	"/tmp/flywheel-v2/host.secret",
	"--agent",
	"lead-runtime",
	"--instance",
	"lead-session-2",
	"--host-epoch",
	"host-1",
	"--session-id",
	"lead-session-2",
	"--session-proof-root",
	"/tmp/flywheel-v2/session-proofs",
	"--pid",
	"31002",
];

describe("FLY-1503 item 2 — register-lead death evidence flag", () => {
	it("accepts --death-evidence-file", () => {
		const parsed = parseCliArgs([
			...BASE,
			"--death-evidence-file",
			"/tmp/flywheel-v2/death-evidence.json",
		]);
		expect(parsed.verb).toBe("register-lead");
		expect(parsed.values.get("--death-evidence-file")).toBe(
			"/tmp/flywheel-v2/death-evidence.json",
		);
	});

	it("still parses register-lead without the flag", () => {
		const parsed = parseCliArgs(BASE);
		expect(parsed.values.has("--death-evidence-file")).toBe(false);
	});

	it("rejects the flag on an unrelated verb", () => {
		expect(() =>
			parseCliArgs([
				"next",
				"--socket",
				"/tmp/flywheel-v2/host.sock",
				"--secret",
				"/tmp/flywheel-v2/host.secret",
				"--agent",
				"engineer",
				"--death-evidence-file",
				"/tmp/flywheel-v2/death-evidence.json",
			]),
		).toThrow(/unknown next option --death-evidence-file/);
	});
});

describe("Codex R3 HIGH-2 — the pull credential never travels through argv", () => {
	it("takes the credential as a file path on both sides", () => {
		expect(
			parseCliArgs([
				...BASE,
				"--delivery-credential-out",
				"/tmp/flywheel-v2/lead-credential.json",
			]).values.get("--delivery-credential-out"),
		).toBe("/tmp/flywheel-v2/lead-credential.json");
		expect(
			parseCliArgs([
				"next",
				"--socket",
				"/tmp/flywheel-v2/host.sock",
				"--secret",
				"/tmp/flywheel-v2/host.secret",
				"--agent",
				"lead-runtime",
				"--delivery-credential-file",
				"/tmp/flywheel-v2/lead-credential.json",
			]).values.get("--delivery-credential-file"),
		).toBe("/tmp/flywheel-v2/lead-credential.json");
	});

	it("has no flag that would put the token itself on the command line", () => {
		// argv is readable by every same-uid process, which is the attacker in this
		// finding. There must be no way to pass the token as a value.
		for (const verb of ["next", "register-lead"]) {
			expect(() =>
				parseCliArgs([
					verb,
					"--socket",
					"/tmp/flywheel-v2/host.sock",
					"--secret",
					"/tmp/flywheel-v2/host.secret",
					"--delivery-token",
					"deadbeef",
				]),
			).toThrow(/unknown .* option --delivery-token/);
		}
	});
});
