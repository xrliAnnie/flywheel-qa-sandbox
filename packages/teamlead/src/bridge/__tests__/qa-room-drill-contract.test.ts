import { readFileSync } from "node:fs";
import {
	deriveRerunArgv,
	renderRerunCommand,
} from "flywheel-comm/strength-two-contract";
import { describe, expect, it } from "vitest";
import {
	drillArguments,
	drillOutcome,
	parseRoomDeploy,
	parseRoomDrill,
	roomDrillRerunSpec,
} from "../qa-room-contract.js";
import {
	driverPhaseBound,
	minimalRoomEnvironment,
} from "../qa-room-runtime.js";
import type { QaRoom } from "../qa-room-store.js";

const request_id = "67b97fa0-a914-4a99-9915-a95dfd9756b7";
const head = "a".repeat(40);
const drill = {
	request_id,
	driver: "qa529_generalized_e2e",
	issue: "FLY-2405",
};
const deploy = (extra = {}) =>
	parseRoomDeploy(
		{
			request_id,
			head,
			generalized: true,
			stub_runner: true,
			env: { TEST_REPLY_BY_ISSUE: "1" },
			...extra,
		},
		4,
	);
describe("room drill boundary", () => {
	it.each([
		{ argv: [] },
		{ driver: "arbitrary" },
		{ issue: "../../x" },
		{ timeout_ms: 9999 },
		{ timeout_ms: 3600001 },
		{ timeout_ms: 1.5 },
		{ label: "com.flywheel.bridge" },
	])("rejects unsupported drill %j", (extra) => {
		expect(() => parseRoomDrill({ ...drill, ...extra })).toThrow();
	});
	it.each([
		{ codex_runner: true, stub_runner: false },
		{ from_branch: "topic" },
		{ env: {} },
		{ env: { TEST_REPLY_BY_ISSUE: "0" } },
		{ env: { TEST_REPLY_BY_ISSUE: "1", TEST_BRIDGE_DEPT_SCOPE_REJECT: "on" } },
		{ alerts: true },
		{ no_lead: true },
		{ test_discipline: true, stub_runner: false },
	])("rejects unreproducible room %j", (extra) => {
		expect(() =>
			roomDrillRerunSpec(deploy(extra), parseRoomDrill(drill)),
		).toThrow("drill_config_not_reproducible");
	});
	it("rejects real/stub mismatch and non-generalized rooms", () => {
		expect(() =>
			roomDrillRerunSpec(deploy(), parseRoomDrill({ ...drill, real: true })),
		).toThrow("drill_mode_mismatch");
		expect(() =>
			roomDrillRerunSpec(
				deploy({ generalized: false, stub_runner: false }),
				parseRoomDrill(drill),
			),
		).toThrow("room_not_drillable");
	});
	it("round-trips the actual driver argv and injected reply env through the evidence contract", () => {
		const room = deploy({
			lead_label: "main",
			extra_leads: [{ slot: 2, label: "ops" }],
		});
		const body = parseRoomDrill(drill);
		const spec = roomDrillRerunSpec(room, body);
		const argv = deriveRerunArgv({ spec, siteSlot: 1, headSha: head });
		expect(argv[1]?.slice(2)).toEqual(drillArguments(body, 1));
		expect(argv[0]).toEqual([
			"bash",
			"scripts/test-deploy.sh",
			"1",
			"--generalized",
			"--stub-runner",
			"--expect-head",
			head,
			"--lead-label",
			"main",
			"--extra-lead",
			"2:ops",
		]);
		const env = minimalRoomEnvironment(
			{ HOME: "/fixture", GH_TOKEN: "secret", TEAMLEAD_API_TOKEN: "secret" },
			[],
			{} as QaRoom,
			room.env,
		);
		expect(env.TEST_REPLY_BY_ISSUE).toBe("1");
		expect(env.GH_TOKEN).toBeUndefined();
		expect(env.TEAMLEAD_API_TOKEN).toBeUndefined();
		expect(
			renderRerunCommand({ worktreePath: "/fixture", headSha: head, argv }),
		).toContain("TEST_REPLY_BY_ISSUE=1");
	});
	it("pins outcome codes without importing candidate code", () => {
		const driver = readFileSync(
			"../../scripts/qa-529-generalized-e2e.mjs",
			"utf8",
		);
		const lib = readFileSync(
			"../../scripts/lib/qa-generalized-e2e-lib.mjs",
			"utf8",
		);
		expect(driver).toMatch(/A3_DIAGNOSIS_EXIT\s*=\s*20/);
		expect(lib).toMatch(/STUB_FATAL_DIAGNOSIS_EXIT\s*=\s*21/);
		expect([0, 20, 21, 1].map(drillOutcome)).toEqual([
			"passed",
			"a3_diagnosis",
			"stub_fatal_diagnosis",
			"driver_failed",
		]);
	});
	it("counts phase waits, adds convergence, and refuses unknown driver shapes", () => {
		expect(driverPhaseBound("await waitFor(\nawait waitFor(")).toBe(3);
		expect(() => driverPhaseBound("different driver")).toThrow(
			"driver_shape_unknown",
		);
	});
});
