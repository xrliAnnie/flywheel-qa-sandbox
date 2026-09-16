import { appendFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import {
	prepareLeadManifestSources,
	recordActualLeadRuleSources,
} from "../rule-sources.js";
import { attachLeadSkillAdapters } from "../skill-adapters.js";

it("binds the reviewed framework adapter and leaves unreviewed or drifted sources unavailable", () => {
	const root = resolve("lead-skill-adapters");
	const records = recordActualLeadRuleSources([
		{
			sourceId: "skill/mvp",
			layer: "skill",
			sourcePath: resolve(root, "mvp/SKILL.md"),
		},
	]);
	expect(attachLeadSkillAdapters(records, root)[0]).toMatchObject({
		status: "selected",
		adapterPath: resolve(root, "mvp/SKILL.md"),
	});
	expect(
		attachLeadSkillAdapters(
			[{ ...records[0]!, sourceSha256: "0".repeat(64) }],
			root,
		)[0],
	).toMatchObject({ status: "missing", reason: "skill_adapter_unverified" });
	expect(
		attachLeadSkillAdapters(
			[{ ...records[0]!, sourceId: "skill/unreviewed-research" }],
			root,
		)[0],
	).toMatchObject({ status: "missing", reason: "skill_adapter_unverified" });
});

it("rejects modified adapter bytes and a modified pin index", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2519-adapter-drift-"));
	try {
		cpSync(resolve("lead-skill-adapters"), root, { recursive: true });
		const records = recordActualLeadRuleSources([
			{
				sourceId: "skill/mvp",
				layer: "skill",
				sourcePath: resolve("lead-skill-adapters/mvp/SKILL.md"),
			},
		]);
		expect(attachLeadSkillAdapters(records, root)[0]?.status).toBe("selected");
		appendFileSync(join(root, "mvp/SKILL.md"), "\nUnreviewed instruction\n");
		expect(attachLeadSkillAdapters(records, root)[0]?.status).toBe("missing");
		cpSync(
			resolve("lead-skill-adapters/mvp/SKILL.md"),
			join(root, "mvp/SKILL.md"),
		);
		appendFileSync(join(root, "source-pins.json"), "\n");
		expect(attachLeadSkillAdapters(records, root)[0]?.status).toBe("missing");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("keeps XHS runner workflows visible with the ruled gap reason", () => {
	const records = recordActualLeadRuleSources([
		{
			sourceId: "skill/xiaohongshu-learning",
			layer: "skill",
			sourcePath: resolve("lead-skill-adapters/mvp/SKILL.md"),
		},
	]);
	const bound = attachLeadSkillAdapters(
		records,
		resolve("lead-skill-adapters"),
	);
	expect(prepareLeadManifestSources(bound, []).skillGaps).toEqual([
		{
			sourceId: "skill/xiaohongshu-learning",
			reason: "runner_workflow_not_lead_capability",
		},
	]);
	expect(bound[0]).toMatchObject({
		status: "missing",
		reason: "runner_workflow_not_lead_capability",
	});
});

it.each([
	["deep-research", "authenticated_research_not_available"],
	["last30days", "research_provider_not_admitted"],
])(
	"preserves the ruled research gap for %s through manifest preparation",
	(name, reason) => {
		const records = recordActualLeadRuleSources([
			{
				sourceId: `skill/${name}`,
				layer: "skill",
				sourcePath: resolve("lead-skill-adapters/mvp/SKILL.md"),
			},
		]);
		const bound = attachLeadSkillAdapters(
			records,
			resolve("lead-skill-adapters"),
		);
		expect(bound[0]).toMatchObject({
			status: "missing",
			reason,
			adapterPath: null,
		});
		expect(prepareLeadManifestSources(bound, []).skillGaps).toEqual([
			{ sourceId: `skill/${name}`, reason },
		]);
		expect(prepareLeadManifestSources(bound, []).skillSources).toEqual([]);
	},
);
