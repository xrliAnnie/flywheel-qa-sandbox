import { describe, expect, it } from "vitest";
import {
	buildSummaryPath,
	SUMMARY_PREFIX,
	summaryDeliveryBranch,
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

	it.each([
		[
			"growth",
			"reflection-lead",
			"2026-09-06/2026-09-06",
			"summary/growth/reflection-lead/269dc60b2dd3fb93",
		],
		[
			"geoforge3d",
			"ops-lead",
			"2026-09-06T00:00:00-07:00/2026-09-06T16:00:00-07:00",
			"summary/geoforge3d/ops-lead/f2ff841c04d0fd3a",
		],
		[
			"joycon-typeless",
			"joycon-lead",
			"2026-08-31/2026-09-06",
			"summary/joycon-typeless/joycon-lead/9d03b88074cc42d6",
		],
		[
			"tidal-echo",
			"tidal-echo-content-lead",
			"2026-09-06T00:00:00-07:00/2026-09-06T16:20:00-07:00",
			"summary/tidal-echo/tidal-echo-content-lead/9660a326b4890a62",
		],
		[
			"growth",
			"rafiki-lead",
			"2026-09-06T00:00:00-07:00/2026-09-06T23:59:59-07:00",
			"summary/growth/rafiki-lead/9746b0095439c348",
		],
		[
			"geoforge3d",
			"product-lead",
			"2026-09-02T00:00:00-07:00/2026-09-06T16:00:00-07:00",
			"summary/geoforge3d/product-lead/0311962ba79ebb0c",
		],
		[
			"personal-assistant",
			"belle-lead",
			"2026-09-06/2026-09-06",
			"summary/personal-assistant/belle-lead/34876ba1064097a7",
		],
		[
			"flywheel",
			"flywheel-product-lead",
			"2026-09-06T00:00:00-07:00/2026-09-06T23:59:59-07:00",
			"summary/flywheel/flywheel-product-lead/7d30d374a698d7f6",
		],
		[
			"tidal-echo",
			"sub-lead",
			"2026-09-06T00:00:00-07:00/2026-09-06T23:59:59-07:00",
			"summary/tidal-echo/sub-lead/8d117823e9861c20",
		],
		[
			"flywheel",
			"flywheel-eng-lead",
			"2026-09-06T00:00:00-07:00/2026-09-06T23:59:59-07:00",
			"summary/flywheel/flywheel-eng-lead/99bcfcafbd3d8a3e",
		],
	])(
		"reproduces the stable Raya branch for %s/%s",
		(project, author, period, branch) => {
			expect(summaryDeliveryBranch({ project, author, period })).toBe(branch);
		},
	);

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
