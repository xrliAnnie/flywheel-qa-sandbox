import { describe, expect, it } from "vitest";
import {
	buildSummaryPath,
	SUMMARY_PREFIX,
	validateSummaryArtifact,
} from "../summary-contract.js";

const body = (
	overrides: Partial<
		Record<"project" | "lead" | "period" | "facts" | "judgment", string>
	> = {},
) => `---
project: ${overrides.project ?? "flywheel"}
lead: ${overrides.lead ?? "eng-lead"}
period: ${overrides.period ?? "2026-08-21/2026-08-28"}
---
## Facts
${overrides.facts ?? "FLY-2030 moved into implementation."}

## Judgment
${overrides.judgment ?? "The summary inflow contract is the current critical path."}
`;

describe("FLY-2030 summary artifact contract", () => {
	it("pins the only exempt prefix", () => {
		expect(SUMMARY_PREFIX).toBe("summaries/");
	});

	it("builds both founder-owned granularity variants without selecting one", () => {
		expect(
			buildSummaryPath({
				project: "flywheel",
				lead: "eng-lead",
				period: "2026-08-21/2026-08-28",
				sequence: 2,
				granularity: "per-lead",
			}),
		).toBe("summaries/flywheel/2026-08-28--eng-lead--02.md");
		expect(
			buildSummaryPath({
				project: "flywheel",
				lead: "cos-lead",
				period: "2026-08-21/2026-08-28",
				sequence: 2,
				granularity: "per-project",
			}),
		).toBe("summaries/flywheel/2026-08-28--02.md");
	});

	it("accepts a complete per-lead artifact", () => {
		expect(
			validateSummaryArtifact({
				path: "summaries/flywheel/2026-08-28--eng-lead--01.md",
				content: body(),
				granularity: "per-lead",
				expectedProject: "flywheel",
				expectedLead: "eng-lead",
				expectedPeriod: "2026-08-21/2026-08-28",
			}),
		).toMatchObject({ project: "flywheel", lead: "eng-lead" });
	});

	it.each([
		["outside prefix", "notes/flywheel/2026-08-28--eng-lead--01.md", body()],
		["wrong naming", "summaries/flywheel/latest.md", body()],
		[
			"frontmatter mismatch",
			"summaries/flywheel/2026-08-28--eng-lead--01.md",
			body({ project: "growth" }),
		],
		[
			"missing facts",
			"summaries/flywheel/2026-08-28--eng-lead--01.md",
			body({ facts: "   " }),
		],
		[
			"missing judgment",
			"summaries/flywheel/2026-08-28--eng-lead--01.md",
			body({ judgment: "   " }),
		],
	])("rejects %s", (_label, path, content) => {
		expect(() =>
			validateSummaryArtifact({
				path,
				content,
				granularity: "per-lead",
				expectedProject: "flywheel",
				expectedLead: "eng-lead",
				expectedPeriod: "2026-08-21/2026-08-28",
			}),
		).toThrow();
	});

	it.each(["100755", "120000", "160000"])(
		"rejects executable/non-blob git mode %s",
		(mode) => {
			expect(() =>
				validateSummaryArtifact({
					path: "summaries/flywheel/2026-08-28--eng-lead--01.md",
					content: body(),
					granularity: "per-lead",
					gitMode: mode,
				}),
			).toThrow(/mode/);
		},
	);

	it.each([
		"2026-02-30/2026-03-01",
		"2026-08-28T25:00:00Z/2026-08-29T00:00:00Z",
	])("rejects a normalized or malformed calendar period %s", (period) => {
		expect(() =>
			buildSummaryPath({
				project: "flywheel",
				lead: "eng-lead",
				period,
				sequence: 1,
				granularity: "per-lead",
			}),
		).toThrow(/period/);
	});
});
