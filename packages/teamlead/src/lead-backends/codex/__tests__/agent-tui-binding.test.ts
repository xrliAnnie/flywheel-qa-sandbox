import { describe, expect, it } from "vitest";
import {
	legacyTuiBindingExpectation,
	verifyAgentTuiBinding,
} from "../agent-tui-binding.js";
import { buildTuiCommand, type TuiWindowSpec } from "../tui-window.js";

const LEGACY: TuiWindowSpec = {
	projectName: "growth",
	leadId: "mufasa-lead",
	codexHome: "/Users/x/.codex-mufasa-tui",
	threadId: "019eb-thread-id",
	cwd: "/Users/x/Dev/growth",
	fullAccess: true,
};

const PINS = {
	codexHome: LEGACY.codexHome,
	brokerSocket: "/tmp/cap/socket",
	manifestPath: "/tmp/cap/manifest.json",
	artifactRoot: "/tmp/cap/artifacts",
	modelTempRoot: "/tmp/cap/model-tmp",
	projectName: LEGACY.projectName,
	leadId: LEGACY.leadId,
	activationId: "activation-1",
};

const CAPABILITY: TuiWindowSpec = {
	...LEGACY,
	fullAccess: undefined,
	capabilitySocketPath: "/tmp/owned/app.sock",
	capabilityModelEnv: {
		pins: PINS,
		env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
	},
};

const verdict = (observed: string, expected: TuiWindowSpec) =>
	verifyAgentTuiBinding(observed, { kind: "canonical", spec: expected });

describe("verifyAgentTuiBinding", () => {
	it("accepts both production grammars and one tmux outer quoting layer", () => {
		for (const spec of [LEGACY, CAPABILITY]) {
			const command = buildTuiCommand(spec);
			expect(verdict(command, spec)).toMatchObject({
				ok: true,
				grammar: spec.capabilityModelEnv ? "capability-v2" : "legacy",
				threadId: spec.threadId,
			});
			expect(verdict(JSON.stringify(command), spec).ok).toBe(true);
		}
	});

	it.each([
		["thread", (s: string) => s.replace("019eb-thread-id", "wrong-thread")],
		["cwd", (s: string) => s.replace("/Users/x/Dev/growth", "/tmp/wrong")],
		[
			"home",
			(s: string) => s.replaceAll("/Users/x/.codex-mufasa-tui", "/tmp/wrong"),
		],
		[
			"socket",
			(s: string) =>
				s.replace(
					"app-server-control/app-server-control.sock",
					"app-server-control/wrong.sock",
				),
		],
		["duplicate", (s: string) => s.replace(" resume ", " resume resume ")],
	] as const)("rejects legacy %s drift", (_name, mutate) => {
		expect(verdict(mutate(buildTuiCommand(LEGACY)), LEGACY)).toEqual({
			ok: false,
			reason: "identity_mismatch",
		});
	});

	it.each([
		["thread", (s: string) => s.replace("019eb-thread-id", "wrong-thread")],
		["cwd", (s: string) => s.replace("/Users/x/Dev/growth", "/tmp/wrong")],
		[
			"socket",
			(s: string) => s.replace("/tmp/owned/app.sock", "/tmp/wrong.sock"),
		],
		["carrier", (s: string) => s.replace("activation-1", "activation-other")],
		["duplicate", (s: string) => s.replace(" resume ", " resume resume ")],
	] as const)("rejects capability-v2 %s drift", (_name, mutate) => {
		expect(verdict(mutate(buildTuiCommand(CAPABILITY)), CAPABILITY)).toEqual({
			ok: false,
			reason: "identity_mismatch",
		});
	});

	it("does not allow a trusted grammar to be swapped", () => {
		expect(verdict(buildTuiCommand(CAPABILITY), LEGACY).ok).toBe(false);
		expect(verdict(buildTuiCommand(LEGACY), CAPABILITY).ok).toBe(false);
	});

	it("validates capability-v2 from independently trusted identity fields", () => {
		const expected = {
			kind: "capability-v2" as const,
			codexHome: CAPABILITY.codexHome,
			cwd: CAPABILITY.cwd,
			threadId: CAPABILITY.threadId,
			codexBin: CAPABILITY.codexBin ?? "codex",
			projectName: CAPABILITY.projectName,
			leadId: CAPABILITY.leadId,
			remoteSocket: CAPABILITY.capabilitySocketPath!,
		};
		const command = buildTuiCommand(CAPABILITY);
		expect(verifyAgentTuiBinding(command, expected)).toMatchObject({
			ok: true,
			grammar: "capability-v2",
		});
		expect(
			verifyAgentTuiBinding(
				command.replace("/tmp/owned/app.sock", "/tmp/wrong.sock"),
				expected,
			),
		).toEqual({ ok: false, reason: "identity_mismatch" });
		expect(
			verifyAgentTuiBinding(
				command.replace(
					"FLYWHEEL_PROJECT_NAME=growth",
					"FLYWHEEL_PROJECT_NAME=other",
				),
				expected,
			),
		).toEqual({ ok: false, reason: "identity_mismatch" });
		expect(
			verifyAgentTuiBinding(
				command.replace("'LANG=", "'UNTRUSTED=x' 'LANG="),
				expected,
			),
		).toEqual({ ok: false, reason: "identity_mismatch" });
	});

	it.each([
		`${buildTuiCommand(LEGACY)}; touch /tmp/nope`,
		`${buildTuiCommand(LEGACY)} $(touch /tmp/nope)`,
		`${buildTuiCommand(LEGACY)} > /tmp/nope`,
		`${buildTuiCommand(LEGACY)} | sh`,
	])("rejects shell syntax without executing it", (observed) => {
		expect(verdict(observed, LEGACY)).toEqual({
			ok: false,
			reason: "unsafe_command",
		});
	});

	it("supports Raya's exact remote expectation without startsWith checks", () => {
		const command =
			'CODEX_HOME="/fixture/home with spaces/.codex-raya" codex resume --remote "unix:///fixture/home with spaces/.codex-raya/app-server-control/app-server-control.sock" -C "/fixture/workspace with spaces" thread-current';
		expect(
			verifyAgentTuiBinding(JSON.stringify(command), {
				kind: "legacy",
				...legacyTuiBindingExpectation({
					codexHome: "/fixture/home with spaces/.codex-raya",
					cwd: "/fixture/workspace with spaces",
					threadId: "thread-current",
				}),
			}),
		).toMatchObject({ ok: true, grammar: "legacy" });
	});
});
