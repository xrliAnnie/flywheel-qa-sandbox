import { describe, expect, it } from "vitest";
import { buildGovernancePromptSegment } from "../review-governance-prompt.js";
import type { ReviewFindingRulingSnapshot } from "../review-verdict-policy.js";

function ruling(
	findingKey: string,
	createdAt: string,
	overrides: Partial<ReviewFindingRulingSnapshot> = {},
): ReviewFindingRulingSnapshot {
	return {
		rulingId: `ruling-${findingKey}`,
		findingKey,
		reviewType: "code",
		disposition: "overruled",
		rationale: "Lead settled this finding.",
		createdAt,
		...overrides,
	};
}

describe("FLY-1278 governance reviewer prompt", () => {
	it("is absent when there are no active rulings", () => {
		expect(buildGovernancePromptSegment([])).toEqual({ text: "", elided: 0 });
	});

	it("renders fixed structured fields and the explicit dispute protocol", () => {
		const result = buildGovernancePromptSegment([
			ruling("metadata-lease", "2026-07-14 12:00:00", {
				disposition: "follow_up",
				followUpIssue: "FLY-1274",
				findingTitle: "Add a 30s metadata lease",
				rationale: "Correctness wins; optimize separately.",
			}),
		]);

		expect(result.elided).toBe(0);
		expect(result.text).toContain("GOVERNANCE-SETTLED FINDINGS");
		expect(result.text).toContain('finding_key: "metadata-lease"');
		expect(result.text).toContain('follow_up_issue: "FLY-1274"');
		expect(result.text).toContain("do not repeat it");
		expect(result.text).toContain('"disputesRuling": "metadata-lease"');
		expect(result.text).toContain("new HIGH-severity evidence");
	});

	it("sorts newest-first, caps at 20, escapes controls, and truncates privileged text", () => {
		const rows = Array.from({ length: 22 }, (_, index) =>
			ruling(
				`key-${String(index).padStart(2, "0")}`,
				`2026-07-14 12:${String(index).padStart(2, "0")}:00`,
			),
		);
		rows[21] = ruling("newest", "2026-07-14 13:00:00", {
			findingTitle: `line one\n${"t".repeat(220)}TAIL`,
			rationale: `${"r".repeat(520)}TAIL`,
		});
		const result = buildGovernancePromptSegment(rows);

		expect(result.elided).toBe(2);
		expect(result.text.indexOf('finding_key: "newest"')).toBeLessThan(
			result.text.indexOf('finding_key: "key-20"'),
		);
		expect(result.text).toContain("+2 more settled rulings elided");
		expect(result.text).not.toContain('finding_key: "key-00"');
		expect(result.text).not.toContain('finding_key: "key-01"');
		expect(result.text).toContain("line one\\n");
		expect(result.text).not.toContain("TAIL");
		// biome-ignore lint/suspicious/noControlCharactersInRegex: prompt must contain no literal controls except structural newlines
		expect(result.text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/);
	});
});
