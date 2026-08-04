import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const bridgeDir = fileURLToPath(new URL("..", import.meta.url));
const teamleadSrcDir = fileURLToPath(new URL("../..", import.meta.url));

describe("FLY-1570 watchdog teardown", () => {
	it("physically removes the detection and stuck chase modules", () => {
		const retired = [
			"runner-receipt-patrol.ts",
			"lead-receipt-patrol.ts",
			"lead-pending-escalation.ts",
			"detection-config-source.ts",
			"detection-escalation-sinks.ts",
			"detection-escalation.ts",
			"detection-gap-scan.ts",
			"detection-reconcile-tick.ts",
			"detection-suspicious.ts",
			"stuck-runner-detector.ts",
			"stuck-escalation.ts",
			"stuck-candidate.ts",
			"stuck-pane-confirm.ts",
			"StuckWatcher.ts",
			"watchdog-judge-assembly.ts",
			"watchdog-judge.ts",
			"notify-digest-expect.ts",
			"workflow-route-reminder-drain.ts",
			"inbox-loop-health-checker.ts",
			"park-watch.ts",
			"legacy-delivery-watchdog-policy.ts",
		];

		expect(
			retired.filter((name) => existsSync(`${bridgeDir}/${name}`)),
		).toEqual([]);
	});

	it("leaves no production assembly for detection escalation or stuck chasing", () => {
		const plugin = readFileSync(`${bridgeDir}/plugin.ts`, "utf8");
		const heartbeat = readFileSync(
			`${teamleadSrcDir}/HeartbeatService.ts`,
			"utf8",
		);

		expect(plugin).not.toMatch(
			/detectionReconcileCohortsTick|notifyLeadFirst|notifyUnprocessed|notifyWakeFailure|listPendingReceiptAlerts|upsertDetectionEscalation|stuckConfirmHolder|createWatchdogJudge/,
		);
		expect(heartbeat).not.toContain("getStuckSessions(");
	});
});
