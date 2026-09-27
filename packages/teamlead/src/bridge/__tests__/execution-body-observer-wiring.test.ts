import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	type BodyObservation,
	FAIL_CLOSED_EXECUTION_BODY_OBSERVER,
} from "../execution-body-observation-contract.js";

describe("FLY-2778 execution body observer production fallback", () => {
	it("turns an unavailable provider into unknown instead of enabling legacy death authority", async () => {
		await expect(
			FAIL_CLOSED_EXECUTION_BODY_OBSERVER.observe("execution-1"),
		).resolves.toBeUndefined();
		expect(
			FAIL_CLOSED_EXECUTION_BODY_OBSERVER.isCurrent({} as BodyObservation),
		).toBe(false);
	});

	it("always injects the fail-closed observer into lifecycle closeout", () => {
		const plugin = readFileSync(
			new URL("../plugin.ts", import.meta.url),
			"utf8",
		);
		expect(plugin).toContain(
			"let executionBodyObserver: ExecutionBodyObserver =\n\t\tFAIL_CLOSED_EXECUTION_BODY_OBSERVER;",
		);
		expect(plugin).toContain("bodyObserver: executionBodyObserver,");
		expect(plugin).not.toContain(
			"...(executionBodyObserver ? { bodyObserver: executionBodyObserver } : {}),",
		);
	});
});
