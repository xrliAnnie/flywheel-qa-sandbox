import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
	return readFileSync(
		fileURLToPath(new URL(relativePath, import.meta.url)),
		"utf8",
	);
}

function section(body: string, start: string, end: string): string {
	const from = body.indexOf(start);
	const to = body.indexOf(end, from + start.length);
	if (from < 0 || to < 0) {
		throw new Error(`section not found: ${start} -> ${end}`);
	}
	return body.slice(from, to);
}

describe("merged landing CI evidence wiring", () => {
	it.each([
		{
			name: "DirectEventSink session completion",
			file: "../../DirectEventSink.ts",
			start: "const desDecision",
			end: "const desShipEligible",
		},
		{
			name: "event-route session_completed",
			file: "../event-route.ts",
			start: "const erDecision",
			end: "const erShipEligible",
		},
		{
			name: "event-route W2 re-finalize",
			file: "../event-route.ts",
			start: "const w2Decision",
			end: "const w2ShipEligible",
		},
		{
			name: "complete-marker replay",
			file: "../complete-marker-reconciler.ts",
			start: "const markerLanding",
			end: "const expectedStatus",
		},
	])("$name supplies merged-state CI evidence", ({ file, start, end }) => {
		expect(section(source(file), start, end)).toContain("mergedPrCiProbe");
	});
});
