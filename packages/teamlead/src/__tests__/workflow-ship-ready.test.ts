import { describe, expect, it } from "vitest";
import {
	SHIP_READY_REMIND_MS,
	workflowShipReadyUid,
} from "../workflow-ship-ready.js";

describe("workflow ship-ready configuration", () => {
	it("uses the fixed 30-minute reminder threshold", () => {
		expect(SHIP_READY_REMIND_MS).toBe(1_800_000);
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
