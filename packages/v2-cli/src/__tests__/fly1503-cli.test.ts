import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../cli.js";

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

describe("FLY-1543 lead takeover and runner upstream CLI", () => {
	it("has no death-evidence ceremony on register-lead", () => {
		const parsed = parseCliArgs(BASE);
		expect(parsed.values.has("--death-evidence-file")).toBe(false);
		expect(() =>
			parseCliArgs([
				...BASE,
				"--death-evidence-file",
				"/tmp/flywheel-v2/death-evidence.json",
			]),
		).toThrow(/unknown register-lead option --death-evidence-file/);
	});

	it("parses runner ask without exposing a recipient flag", () => {
		const parsed = parseCliArgs([
			"ask",
			"--socket",
			"/tmp/flywheel-v2/host.sock",
			"--secret",
			"/tmp/flywheel-v2/host.secret",
			"--session",
			"v2dag:11111111-1111-4111-8111-111111111111:1:22222222-2222-4222-8222-222222222222",
			"--ask-kind",
			"ask",
			"--payload",
			"Which test should I run?",
		]);
		expect(parsed.verb).toBe("ask");
		expect(parsed.values.has("--to-agent")).toBe(false);
		expect(() =>
			parseCliArgs([
				"ask",
				"--session",
				"session",
				"--ask-kind",
				"ask",
				"--payload",
				"question",
				"--to-agent",
				"someone-else",
			]),
		).toThrow(/unknown ask option --to-agent/);
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
