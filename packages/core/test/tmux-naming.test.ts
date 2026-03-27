import { describe, expect, it } from "vitest";
import {
	buildSessionName,
	buildWindowLabel,
	cleanIssueTitle,
	sanitizeTmuxName,
} from "../src/tmux-naming.js";

describe("cleanIssueTitle", () => {
	it("strips [P0] priority tag", () => {
		expect(cleanIssueTitle("[P0] Fix the auth bug")).toBe("Fix the auth bug");
	});

	it("strips [P1] priority tag with mixed case", () => {
		expect(cleanIssueTitle("[p1] Add feature")).toBe("Add feature");
	});

	it("converts em-dash to hyphen (consuming surrounding spaces)", () => {
		expect(cleanIssueTitle("OSM attribution — add license")).toBe(
			"OSM attribution-add license",
		);
	});

	it("trims whitespace", () => {
		expect(cleanIssueTitle("  hello world  ")).toBe("hello world");
	});

	it("handles title with no priority tag", () => {
		expect(cleanIssueTitle("Simple title")).toBe("Simple title");
	});

	it("handles title with multiple priority tags", () => {
		expect(cleanIssueTitle("[P0] [P2] Double tagged")).toBe("Double tagged");
	});
});

describe("sanitizeTmuxName", () => {
	it("replaces special chars with dash", () => {
		expect(sanitizeTmuxName("GEO/101:special.chars!")).toBe(
			"GEO-101-special-chars",
		);
	});

	it("collapses consecutive dashes", () => {
		expect(sanitizeTmuxName("a--b---c")).toBe("a-b-c");
	});

	it("strips trailing dash", () => {
		expect(sanitizeTmuxName("abc-")).toBe("abc");
	});

	it("truncates to 50 chars by default", () => {
		const long = "a".repeat(60);
		expect(sanitizeTmuxName(long)).toHaveLength(50);
	});

	it("accepts custom maxLen", () => {
		expect(sanitizeTmuxName("abcdefgh", 5)).toBe("abcde");
	});

	it("handles empty string", () => {
		expect(sanitizeTmuxName("")).toBe("");
	});
});

describe("buildSessionName", () => {
	it("produces sanitized issueId-cleanTitle", () => {
		expect(buildSessionName("GEO-95", "Fix the bug")).toBe(
			"GEO-95-Fix-the-bug",
		);
	});

	it("strips priority tags and sanitizes", () => {
		const result = buildSessionName(
			"GEO-95",
			"[P0] OSM attribution — add OpenStreetMap license notice in UI",
		);
		expect(result).toBe("GEO-95-OSM-attribution-add-OpenStreetMap-license-n");
		expect(result.length).toBeLessThanOrEqual(50);
	});

	it("truncates long titles to 50 chars", () => {
		const result = buildSessionName("GEO-95", "a".repeat(100));
		expect(result.length).toBeLessThanOrEqual(50);
	});
});

describe("buildWindowLabel", () => {
	it("produces issueId-runner-cleanTitle (unsanitized)", () => {
		expect(buildWindowLabel("GEO-101", "claude", "Issue GEO-101 title")).toBe(
			"GEO-101-claude-Issue GEO-101 title",
		);
	});

	it("strips priority tags from title", () => {
		expect(buildWindowLabel("GEO-42", "claude", "[P0] Fix auth")).toBe(
			"GEO-42-claude-Fix auth",
		);
	});

	it("preserves spaces (sanitize is caller's responsibility)", () => {
		const result = buildWindowLabel("GEO-1", "runner", "hello world");
		expect(result).toContain(" ");
	});
});
