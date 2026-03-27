import { describe, expect, it, vi } from "vitest";
import {
	filterSessionsByLead,
	matchesLead,
	parseSessionLabels,
} from "../bridge/lead-scope.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { Session } from "../StateStore.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const projects: ProjectEntry[] = [
	{
		projectName: "geoforge3d",
		projectRoot: "/tmp/geoforge3d",
		leads: [
			{
				agentId: "product-lead",
				forumChannel: "111",
				chatChannel: "111-chat",
				match: { labels: ["Product"] },
			},
			{
				agentId: "ops-lead",
				forumChannel: "222",
				chatChannel: "222-chat",
				match: { labels: ["Operations"] },
			},
		],
	},
];

/** Helper to build a minimal Session with only the fields lead-scope cares about. */
function makeSession(
	overrides: Partial<Session> & Pick<Session, "execution_id" | "project_name">,
): Session {
	return {
		issue_id: "i-default",
		status: "running",
		...overrides,
	} as Session;
}

// ---------------------------------------------------------------------------
// parseSessionLabels
// ---------------------------------------------------------------------------

describe("parseSessionLabels", () => {
	it("parses JSON string array", () => {
		const session = makeSession({
			execution_id: "e1",
			project_name: "geoforge3d",
			issue_labels: '["Product"]',
		});
		expect(parseSessionLabels(session)).toEqual(["Product"]);
	});

	it("parses JSON array with multiple labels", () => {
		const session = makeSession({
			execution_id: "e2",
			project_name: "geoforge3d",
			issue_labels: '["Product", "Frontend"]',
		});
		expect(parseSessionLabels(session)).toEqual(["Product", "Frontend"]);
	});

	it("parses CSV fallback", () => {
		const session = makeSession({
			execution_id: "e3",
			project_name: "geoforge3d",
			issue_labels: "Product, Frontend",
		});
		expect(parseSessionLabels(session)).toEqual(["Product", "Frontend"]);
	});

	it("returns [] for undefined issue_labels", () => {
		const session = makeSession({
			execution_id: "e4",
			project_name: "geoforge3d",
		});
		expect(parseSessionLabels(session)).toEqual([]);
	});

	it("returns [] for empty string issue_labels", () => {
		const session = makeSession({
			execution_id: "e5",
			project_name: "geoforge3d",
			issue_labels: "",
		});
		expect(parseSessionLabels(session)).toEqual([]);
	});

	it("falls through to CSV when JSON parses to number array", () => {
		const session = makeSession({
			execution_id: "e6",
			project_name: "geoforge3d",
			issue_labels: "[1,2]",
		});
		// JSON.parse succeeds but result is not string[] → CSV fallback
		// CSV split of "[1,2]" → ["[1", "2]"]
		expect(parseSessionLabels(session)).toEqual(["[1", "2]"]);
	});

	it("falls through to CSV when JSON parses to object", () => {
		const session = makeSession({
			execution_id: "e7",
			project_name: "geoforge3d",
			issue_labels: '{"a":"b"}',
		});
		// JSON.parse succeeds but result is not an array → CSV fallback
		// CSV split of '{"a":"b"}' → ['{"a":"b"}']
		expect(parseSessionLabels(session)).toEqual(['{"a":"b"}']);
	});

	it("handles CSV with extra whitespace and empty segments", () => {
		const session = makeSession({
			execution_id: "e8",
			project_name: "geoforge3d",
			issue_labels: " Product ,, Frontend , ",
		});
		expect(parseSessionLabels(session)).toEqual(["Product", "Frontend"]);
	});
});

// ---------------------------------------------------------------------------
// matchesLead
// ---------------------------------------------------------------------------

describe("matchesLead", () => {
	it("returns true when labels route to matching Lead", () => {
		const session = makeSession({
			execution_id: "e1",
			project_name: "geoforge3d",
			issue_labels: '["Product"]',
		});
		expect(matchesLead(session, "product-lead", projects)).toBe(true);
	});

	it("returns false when labels route to a different Lead", () => {
		const session = makeSession({
			execution_id: "e2",
			project_name: "geoforge3d",
			issue_labels: '["Operations"]',
		});
		expect(matchesLead(session, "product-lead", projects)).toBe(false);
	});

	it("defaults to first lead when no labels match", () => {
		const session = makeSession({
			execution_id: "e3",
			project_name: "geoforge3d",
			issue_labels: '["Unknown"]',
		});
		// resolveLeadForIssue falls back to first lead (product-lead)
		expect(matchesLead(session, "product-lead", projects)).toBe(true);
		expect(matchesLead(session, "ops-lead", projects)).toBe(false);
	});

	it("throws for unknown project", () => {
		const session = makeSession({
			execution_id: "e4",
			project_name: "nonexistent-project",
			issue_labels: '["Product"]',
		});
		expect(() => matchesLead(session, "product-lead", projects)).toThrow(
			/No project found for "nonexistent-project"/,
		);
	});

	it("matches case-insensitively", () => {
		const session = makeSession({
			execution_id: "e5",
			project_name: "geoforge3d",
			issue_labels: '["product"]',
		});
		expect(matchesLead(session, "product-lead", projects)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// filterSessionsByLead
// ---------------------------------------------------------------------------

describe("filterSessionsByLead", () => {
	const productSession = makeSession({
		execution_id: "e-product",
		project_name: "geoforge3d",
		issue_labels: '["Product"]',
	});
	const opsSession = makeSession({
		execution_id: "e-ops",
		project_name: "geoforge3d",
		issue_labels: '["Operations"]',
	});

	it("filters correctly when leadId is provided", () => {
		const result = filterSessionsByLead(
			[productSession, opsSession],
			"product-lead",
			projects,
		);
		expect(result).toHaveLength(1);
		expect(result[0]!.execution_id).toBe("e-product");
	});

	it("returns only ops-lead sessions when leadId is ops-lead", () => {
		const result = filterSessionsByLead(
			[productSession, opsSession],
			"ops-lead",
			projects,
		);
		expect(result).toHaveLength(1);
		expect(result[0]!.execution_id).toBe("e-ops");
	});

	it("returns all sessions when leadId is undefined", () => {
		const result = filterSessionsByLead(
			[productSession, opsSession],
			undefined,
			projects,
		);
		expect(result).toHaveLength(2);
	});

	it("logs warning and excludes sessions with unknown projects", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const unknownSession = makeSession({
			execution_id: "e-unknown",
			project_name: "unknown-project",
			issue_labels: '["Product"]',
		});

		const result = filterSessionsByLead(
			[productSession, unknownSession],
			"product-lead",
			projects,
		);

		expect(result).toHaveLength(1);
		expect(result[0]!.execution_id).toBe("e-product");

		expect(warnSpy).toHaveBeenCalledOnce();
		expect(warnSpy.mock.calls[0]![0]).toContain("[lead-scope]");
		expect(warnSpy.mock.calls[0]![0]).toContain("e-unknown");
		expect(warnSpy.mock.calls[0]![0]).toContain("unknown-project");

		warnSpy.mockRestore();
	});

	it("returns empty array when no sessions match the lead", () => {
		const result = filterSessionsByLead([opsSession], "product-lead", projects);
		expect(result).toHaveLength(0);
	});

	it("handles empty sessions array", () => {
		const result = filterSessionsByLead([], "product-lead", projects);
		expect(result).toEqual([]);
	});
});
