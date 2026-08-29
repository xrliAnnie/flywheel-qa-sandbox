import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("FLY-1505 boot ordering", () => {
	const pluginPath = fileURLToPath(new URL("../plugin.ts", import.meta.url));
	const source = readFileSync(pluginPath, "utf8");

	it("drains durable ship-attempt markers before GatePoller can issue its first re-wake", () => {
		const drainIndex = source.indexOf("await reconcileCompleteFailedMarkers({");
		const pollerStartIndex = source.indexOf("gatePoller.start();");

		expect(drainIndex).toBeGreaterThan(-1);
		expect(pollerStartIndex).toBeGreaterThan(drainIndex);
	});

	it("reconciles neutral Codex holds before marker drain and GatePoller startup", () => {
		const holderIndex = source.indexOf(
			"codexReviewHoldHolder.current = new CodexReviewHoldCoordinator",
		);
		const reconcileIndex = source.indexOf(
			".reconcileCodexHolds()",
			holderIndex,
		);
		const markerDrainIndex = source.indexOf(
			"await reconcileCompleteFailedMarkers({",
			holderIndex,
		);
		const pollerStartIndex = source.indexOf("gatePoller.start();", holderIndex);

		expect(holderIndex).toBeGreaterThan(-1);
		expect(reconcileIndex).toBeGreaterThan(holderIndex);
		expect(markerDrainIndex).toBeGreaterThan(reconcileIndex);
		expect(pollerStartIndex).toBeGreaterThan(markerDrainIndex);
	});

	it("wires merge-without-approval alerts into boot and periodic marker replay", () => {
		const heartbeatIndex = source.indexOf("new HeartbeatService(");
		const heartbeatEnd = source.indexOf(
			"48, // reviewTimeoutHours",
			heartbeatIndex,
		);
		const bootDrainIndex = source.indexOf(
			"await reconcileCompleteFailedMarkers({",
		);
		const bootDrainEnd = source.indexOf("gatePoller.start();", bootDrainIndex);

		expect(source.slice(heartbeatIndex, heartbeatEnd)).toContain(
			"alertMergeWithoutApproval:",
		);
		expect(source.slice(bootDrainIndex, bootDrainEnd)).toContain(
			"alertMergeWithoutApproval:",
		);
	});

	it("keeps periodic ship-alert replay strict and rejects while the holder is unavailable", () => {
		const heartbeatIndex = source.indexOf("new HeartbeatService(");
		const heartbeatEnd = source.indexOf(
			"48, // reviewTimeoutHours",
			heartbeatIndex,
		);
		const heartbeatWiring = source.slice(heartbeatIndex, heartbeatEnd);

		expect(heartbeatWiring).toContain(
			"alerts.alertShipAttemptFailed(session, reason)",
		);
		expect(heartbeatWiring).toContain(
			'Promise.reject(new Error("ship-attempt alert sink unavailable"))',
		);
	});

	it("rejects orphan alert delivery while the sink holder is unavailable", () => {
		const sweepIndex = source.indexOf("const patrolOrphanSweepPass =");
		const sweepEnd = source.indexOf(
			"const workflowResumeCheckpointStore",
			sweepIndex,
		);
		const sweepWiring = source.slice(sweepIndex, sweepEnd);

		expect(sweepIndex).toBeGreaterThan(-1);
		expect(sweepEnd).toBeGreaterThan(sweepIndex);
		expect(sweepWiring).toContain(
			'throw new Error("patrol orphan alert sink unavailable")',
		);
	});
});
