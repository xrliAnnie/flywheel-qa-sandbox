import { describe, expect, it } from "vitest";
import {
	evaluateGoNoGo,
	GO_NO_GO_CHECKS,
	type GoNoGoObservation,
} from "../index.js";

function green(): GoNoGoObservation {
	return {
		legacyWritersStopped: true,
		oldCredentialsRejected: true,
		activeAttemptUniqueness: true,
		actionEffectKeyContract: true,
		actionOutcomesSettled: true,
		gatesBindExactHead: true,
		databaseContract: true,
		migrationConservation: true,
		journalsDrained: true,
		archivesAndTombstones: true,
		liveFirePassed: true,
		namespacesDisjoint: true,
		githubLanePassed: true,
		evidence: Object.fromEntries(
			GO_NO_GO_CHECKS.map((check) => [check.id, `/evidence/${check.id}.json`]),
		),
	};
}

describe("Go/No-Go ten checks plus locked additions", () => {
	it("requires every check and emits named evidence", () => {
		const report = evaluateGoNoGo(green(), "2026-07-28T00:00:00.000Z");
		expect(report.status).toBe("go");
		expect(report.checks).toHaveLength(12);
		expect(report.checks.every((check) => check.status === "pass")).toBe(true);
	});

	it("fails the whole window on any missing evidence or failed journal drain", () => {
		const input = green();
		input.journalsDrained = false;
		delete input.evidence["8"];
		const report = evaluateGoNoGo(input, "2026-07-28T00:00:00.000Z");
		expect(report.status).toBe("no-go");
		expect(report.checks.find((check) => check.id === "8")).toMatchObject({
			status: "fail",
		});
	});
});
