import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("FLY-1505 boot ordering", () => {
	it("drains durable ship-attempt markers before GatePoller can issue its first re-wake", () => {
		const pluginPath = fileURLToPath(new URL("../plugin.ts", import.meta.url));
		const source = readFileSync(pluginPath, "utf8");
		const drainIndex = source.indexOf("await reconcileCompleteFailedMarkers({");
		const pollerStartIndex = source.indexOf("gatePoller.start();");

		expect(drainIndex).toBeGreaterThan(-1);
		expect(pollerStartIndex).toBeGreaterThan(drainIndex);
	});
});
