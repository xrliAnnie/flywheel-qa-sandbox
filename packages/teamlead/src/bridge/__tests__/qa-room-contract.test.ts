import { describe, expect, it } from "vitest";
import {
	deployArguments,
	parseRoomDeploy,
	parseRoomTeardown,
	roomRequestDigest,
} from "../qa-room-contract.js";

const request = {
	request_id: "67b97fa0-a914-4a99-9915-a95dfd9756b7",
	head: "a".repeat(40),
};
describe("QA room request boundary", () => {
	it("uses the actual deployment script timeout flag names", () => {
		const body = parseRoomDeploy({ ...request, lead_ready_timeout_sec: 60, lead_channel_timeout_sec: 90 }, 4);
		expect(deployArguments(body, 1).slice(-4)).toEqual(["--lead-ready-timeout", "60", "--lead-channel-timeout", "90"]);
	});
	it("normalizes defaults and builds only fixed script argv", () => {
		const parsed = parseRoomDeploy(
			{
				...request,
				generalized: true,
				extra_leads: [{ slot: 2, label: "ops" }],
				env: { TEST_REPLY_BY_ISSUE: "1" },
			},
			4,
		);
		expect(parsed.slot).toBe("auto");
		expect(deployArguments(parsed, 1)).toEqual([
			"1",
			"--mode",
			"slot",
			"--from-branch",
			"main",
			"--generalized",
			"--expect-head",
			request.head,
			"--extra-lead",
			"2:ops",
		]);
	});
	it.each([
		{ label: "com.flywheel.bridge" },
		{ env: { TEST_API_TOKEN: "x" } },
		{ argv: ["--anything"] },
		{ slot: 5 },
		{ slot: 0 },
		{ head: "short" },
		{ from_branch: "../main" },
		{ from_branch: "--upload-pack=x" },
		{ mode: "mirror", slot: 4 },
		{ mode: "roundtable", generalized: true },
		{ stub_runner: true },
		{ codex_runner: true },
		{ generalized: true, stub_runner: true, codex_runner: true },
		{ generalized: true, stub_runner: true, test_discipline: true },
		{ no_lead: true, extra_leads: [{ slot: 2, label: "ops" }] },
		{ slot: 2, extra_leads: [{ slot: 2, label: "ops" }] },
		{
			extra_leads: [
				{ slot: 2, label: "ops" },
				{ slot: 2, label: "sales" },
			],
		},
		{ alert_duty: true },
		{ codex_home_reconcile: true },
		{ voice_fixture: true },
		{ env: { TEST_REPLY_BY_ISSUE: "$(touch x)" } },
	])("rejects unsupported or incompatible input %j", (extra) => {
		expect(() => parseRoomDeploy({ ...request, ...extra }, 4)).toThrow();
	});
	it("labels production targets distinctly, even nested in unknown fields", () => {
		expect(() =>
			parseRoomDeploy(
				{ ...request, env: { TARGET: "com.flywheel.bridge" } },
				4,
			),
		).toThrow("production_target_refused");
		expect(() =>
			parseRoomDeploy({ ...request, lead_label: "com.flywheel.qa.test" }, 4),
		).not.toThrow();
	});
	it("binds digest to normalized request and action but excludes credentials", () => {
		expect(
			roomRequestDigest("deploy", { ...request, credential: "secret" }),
		).toBe(roomRequestDigest("deploy", request));
		expect(roomRequestDigest("deploy", request)).not.toBe(
			roomRequestDigest("teardown", request),
		);
	});
	it("only accepts snapshot omission with a nonempty explicit reason", () => {
		for (const extra of [
			{ skip_snapshot: true },
			{ skip_snapshot: true, reason: "" },
			{ reason: "not requested" },
			{ skip_snapshot: false, reason: "no" },
		])
			expect(() =>
				parseRoomTeardown({ request_id: request.request_id, ...extra }),
			).toThrow();
		expect(
			parseRoomTeardown({
				request_id: request.request_id,
				skip_snapshot: true,
				reason: "prior snapshot already published",
			}).skip_snapshot,
		).toBe(true);
	});
});
