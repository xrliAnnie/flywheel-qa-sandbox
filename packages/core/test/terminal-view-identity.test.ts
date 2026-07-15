import { describe, expect, it } from "vitest";
import {
	formatViewTitle,
	parseViewTitle,
} from "../src/terminal-view-identity.js";

describe("formatViewTitle (FLY-116)", () => {
	it("formats a full title with sessionRole", () => {
		expect(
			formatViewTitle({
				sessionName: "runner-flywheel",
				projectName: "flywheel",
				executionId: "exec_abc123",
				windowId: "@42",
				sessionRole: "engineer",
			}),
		).toBe("flywheel:runner:runner-flywheel:flywheel:exec_abc123:@42:engineer");
	});

	it("formats without sessionRole when omitted", () => {
		expect(
			formatViewTitle({
				sessionName: "runner-flywheel",
				projectName: "flywheel",
				executionId: "exec_abc123",
				windowId: "@42",
			}),
		).toBe("flywheel:runner:runner-flywheel:flywheel:exec_abc123:@42");
	});

	it("preserves alternative sessionName prefixes (e.g. retry-*)", () => {
		expect(
			formatViewTitle({
				sessionName: "retry-geoforge3d",
				projectName: "geoforge3d",
				executionId: "exec_def456",
				windowId: "@44",
				sessionRole: "engineer",
			}),
		).toBe(
			"flywheel:runner:retry-geoforge3d:geoforge3d:exec_def456:@44:engineer",
		);
	});
});

describe("parseViewTitle (FLY-116)", () => {
	it("round-trips a full title", () => {
		const parts = {
			sessionName: "runner-flywheel",
			projectName: "flywheel",
			executionId: "exec_abc123",
			windowId: "@42",
			sessionRole: "engineer",
		};
		expect(parseViewTitle(formatViewTitle(parts))).toEqual(parts);
	});

	it("round-trips without role", () => {
		const parts = {
			sessionName: "runner-flywheel",
			projectName: "flywheel",
			executionId: "exec_abc123",
			windowId: "@42",
		};
		// formatViewTitle returns no role suffix; parseViewTitle returns sessionRole=undefined
		expect(parseViewTitle(formatViewTitle(parts))).toEqual({
			...parts,
			sessionRole: undefined,
		});
	});

	it("rejects malformed titles (wrong prefix)", () => {
		expect(parseViewTitle("random-tab-title")).toBeNull();
		expect(parseViewTitle("")).toBeNull();
		expect(parseViewTitle("flywheel:runner:incomplete")).toBeNull();
	});

	it("rejects titles where windowId is not @-prefixed", () => {
		expect(
			parseViewTitle(
				"flywheel:runner:runner-flywheel:flywheel:exec_abc:bad-window-id",
			),
		).toBeNull();
	});

	it("preserves complex sessionName fields with alphanumeric+dash", () => {
		const parsed = parseViewTitle(
			"flywheel:runner:retry-geoforge3d:geoforge3d:exec_def:@44:qa",
		);
		expect(parsed).toEqual({
			sessionName: "retry-geoforge3d",
			projectName: "geoforge3d",
			executionId: "exec_def",
			windowId: "@44",
			sessionRole: "qa",
		});
	});
});
