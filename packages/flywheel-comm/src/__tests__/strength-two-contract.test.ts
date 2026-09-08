import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	canonicalizeRerunSpec,
	deriveRerunArgv,
	LANES,
	RAN_REASONS,
	RECORD_ID_PATTERN,
	RECORD_REASONS,
	renderRerunCommand,
	shellQuote,
	validateRerunSpecV1,
} from "../strength-two-contract.js";

const HEAD = "a".repeat(40);

const generalized = {
	schemaVersion: 1,
	lane: "generalized_e2e_stub",
	deploy: {
		leadLabel: "flywheel-eng-lead",
		extraLeads: [{ slot: 3, deptLabel: "ops" }],
	},
	driver: { issue: "FLY-2397", timeoutMs: 600_000 },
} as const;

describe("strength-two shared contract", () => {
	it("keeps the two reason vocabularies independent except for ok", () => {
		expect(LANES).toEqual([
			"generalized_e2e_stub",
			"generalized_e2e_real",
			"manual_test_deploy",
		]);
		expect(
			RAN_REASONS.filter((reason) => RECORD_REASONS.includes(reason as never)),
		).toEqual(["ok"]);
	});

	it("accepts canonical UUID v4 record ids only", () => {
		expect(RECORD_ID_PATTERN.test("11111111-1111-4111-8111-111111111111")).toBe(
			true,
		);
		for (const invalid of [
			"11111111-1111-3111-8111-111111111111",
			"11111111-1111-4111-7111-111111111111",
			"11111111-1111-4111-8111-11111111111A",
		]) {
			expect(RECORD_ID_PATTERN.test(invalid)).toBe(false);
		}
	});

	it("validates and canonicalizes a generalized recipe", () => {
		const result = validateRerunSpecV1(generalized, "generalized_e2e_stub");
		expect(result).toMatchObject({ ok: true });
		if (!result.ok) return;
		expect(canonicalizeRerunSpec(result.value)).toBe(
			'{"deploy":{"extraLeads":[{"deptLabel":"ops","slot":3}],"leadLabel":"flywheel-eng-lead"},"driver":{"issue":"FLY-2397","timeoutMs":600000},"lane":"generalized_e2e_stub","schemaVersion":1}',
		);
	});

	it.each([
		["lane_mismatch", { ...generalized, lane: "generalized_e2e_real" }],
		["unknown_key", { ...generalized, head: HEAD }],
		["driver_required", { ...generalized, driver: undefined }],
		[
			"issue_invalid",
			{ ...generalized, driver: { issue: "fly-2397", timeoutMs: 600_000 } },
		],
		[
			"timeout_ms_invalid",
			{ ...generalized, driver: { issue: "FLY-2397", timeoutMs: 9_999 } },
		],
		[
			"timeout_ms_invalid",
			{ ...generalized, driver: { issue: "FLY-2397", timeoutMs: 3_600_001 } },
		],
		[
			"extra_leads_require_lead_label",
			{
				...generalized,
				deploy: { extraLeads: [{ slot: 3, deptLabel: "ops" }] },
			},
		],
		[
			"extra_leads_invalid",
			{
				...generalized,
				deploy: {
					leadLabel: "lead",
					extraLeads: Array.from({ length: 5 }, (_, index) => ({
						slot: index + 2,
						deptLabel: `d${index}`,
					})),
				},
			},
		],
		[
			"extra_lead_label_invalid",
			{
				...generalized,
				deploy: {
					leadLabel: "lead",
					extraLeads: [{ slot: 3, deptLabel: "bad label" }],
				},
			},
		],
	] as const)("rejects %s generalized recipes", (reason, value) => {
		expect(validateRerunSpecV1(value, "generalized_e2e_stub")).toEqual({
			ok: false,
			reason,
		});
	});

	it("validates the manual recipe discriminant", () => {
		expect(
			validateRerunSpecV1(
				{
					schemaVersion: 1,
					lane: "manual_test_deploy",
					deploy: { generalized: true, stubRunner: true },
				},
				"manual_test_deploy",
			),
		).toMatchObject({ ok: true });
		expect(
			validateRerunSpecV1(
				{
					schemaVersion: 1,
					lane: "manual_test_deploy",
					deploy: { generalized: false, stubRunner: true },
				},
				"manual_test_deploy",
			),
		).toEqual({ ok: false, reason: "stub_runner_requires_generalized" });
		expect(
			validateRerunSpecV1(
				{ ...generalized, lane: "manual_test_deploy" },
				"manual_test_deploy",
			),
		).toEqual({ ok: false, reason: "driver_forbidden" });
	});

	it("derives argv from the lane instead of trusting repeated caller facts", () => {
		expect(
			deriveRerunArgv({ spec: generalized, siteSlot: 2, headSha: HEAD }),
		).toEqual([
			[
				"bash",
				"scripts/test-deploy.sh",
				"2",
				"--generalized",
				"--stub-runner",
				"--expect-head",
				HEAD,
				"--lead-label",
				"flywheel-eng-lead",
				"--extra-lead",
				"3:ops",
			],
			[
				"node",
				"scripts/qa-529-generalized-e2e.mjs",
				"2",
				"--issue",
				"FLY-2397",
				"--timeout-ms",
				"600000",
			],
		]);
	});

	it.each([
		"plain",
		"two words",
		"apostrophe's",
		"$HOME",
		"`uname`",
		"; rm -rf x",
		"",
	])("POSIX-quotes %j without changing bytes", (token) => {
		const stdout = execFileSync(
			"sh",
			["-c", `printf %s ${shellQuote(token)}`],
			{
				encoding: "utf8",
			},
		);
		expect(stdout).toBe(token);
	});

	it.each(["line\nbreak", "nul\0byte"])(
		"rejects unsafe shell token %j",
		(token) => {
			expect(() => shellQuote(token)).toThrow(/unsafe shell token/);
		},
	);

	it("renders a head-fenced rerun command", () => {
		const argv = deriveRerunArgv({
			spec: generalized,
			siteSlot: 2,
			headSha: HEAD,
		});
		const command = renderRerunCommand({
			worktreePath: "/tmp/work tree's",
			headSha: HEAD,
			argv,
		});
		expect(command).toContain("cd '/tmp/work tree'\\''s'");
		expect(command).toContain("git rev-parse HEAD");
		expect(command).toContain(`'${HEAD}'`);
		expect(command).toContain("TMPDIR=/tmp/ TEST_REPLY_BY_ISSUE=1");
		expect(command).toContain(" && ");
	});
});
