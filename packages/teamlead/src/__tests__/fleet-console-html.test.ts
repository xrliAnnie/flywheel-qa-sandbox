import { describe, expect, it } from "vitest";
import { getFleetConsoleHtml } from "../bridge/fleet-console-html.js";

describe("fleet-console-html (WI-4)", () => {
	const html = getFleetConsoleHtml();

	it("is a complete HTML document", () => {
		expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
		expect(html).toContain("Flywheel Fleet");
		expect(html.trimEnd().endsWith("</html>")).toBe(true);
	});

	it("wires the four real backend endpoints", () => {
		expect(html).toContain("/api/fleet/snapshot");
		expect(html).toContain("/api/fleet/stage");
		expect(html).toContain("/api/fleet/apply");
		expect(html).toContain("/api/fleet/progress");
	});

	it("did not leak an unevaluated TS template placeholder", () => {
		// The embedded JS uses string concat, not ${} — so no `${` must survive.
		expect(html).not.toContain("${");
	});

	it("sends toModel keyed by the exact engine key (stage payload shape)", () => {
		expect(html).toContain("toModel");
		expect(html).toContain("confirmToken");
		expect(html).toContain("canonicalRequest");
	});

	it("renders server-driven disabled reasons (no hardcoded eligibility)", () => {
		// The reason strings come from the snapshot's backendOptions, surfaced via
		// disabledReason — the UI must reference that field, not hardcode rules.
		expect(html).toContain("disabledReason");
	});
});
