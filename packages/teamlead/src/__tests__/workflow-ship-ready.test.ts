import { afterEach, describe, expect, it } from "vitest";
import {
	shipReadyNotifyEnabled,
	shipReadyRemindMs,
	workflowShipReadyUid,
} from "../workflow-ship-ready.js";

describe("workflow ship-ready configuration", () => {
	const touched = [
		"FLYWHEEL_SHIP_READY_NOTIFY",
		"FLYWHEEL_SHIP_READY_REMIND_MS",
	] as const;

	afterEach(() => {
		for (const key of touched) delete process.env[key];
	});

	it("reads the default-on notify switch at call time", () => {
		delete process.env.FLYWHEEL_SHIP_READY_NOTIFY;
		expect(shipReadyNotifyEnabled()).toBe(true);
		process.env.FLYWHEEL_SHIP_READY_NOTIFY = "0";
		expect(shipReadyNotifyEnabled()).toBe(false);
		process.env.FLYWHEEL_SHIP_READY_NOTIFY = "1";
		expect(shipReadyNotifyEnabled()).toBe(true);
	});

	it("reads a positive reminder threshold at call time and rejects invalid values", () => {
		delete process.env.FLYWHEEL_SHIP_READY_REMIND_MS;
		expect(shipReadyRemindMs()).toBe(1_800_000);
		process.env.FLYWHEEL_SHIP_READY_REMIND_MS = "2500";
		expect(shipReadyRemindMs()).toBe(2_500);
		for (const invalid of ["0", "-1", "NaN", "1.5", ""]) {
			process.env.FLYWHEEL_SHIP_READY_REMIND_MS = invalid;
			expect(shipReadyRemindMs()).toBe(1_800_000);
		}
	});

	it("builds a stable per-run, gate, and attempt UID", () => {
		expect(
			workflowShipReadyUid({
				runId: "run-1",
				gateNodeId: "founder_gate",
				attempt: 3,
			}),
		).toBe("run-1:founder_gate:3");
	});
});
