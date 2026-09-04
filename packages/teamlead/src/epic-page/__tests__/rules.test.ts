import { describe, expect, it } from "vitest";
import type { Cell, EpicItem } from "../model.js";
import {
	computeGaps,
	computeReady,
	doneDefinition,
	extractAcceptance,
	isFounderNamed,
} from "../rules.js";

const NOW = "2026-09-03T04:00:00Z";

function cell<T>(value: T): Cell<T> {
	return {
		value,
		provenance: { kind: "derived", rule: "ready.v1", from: [] },
		observed_at: NOW,
	};
}

function item(
	identifier: string,
	blockedBy: EpicItem["blocked_by"]["value"] = [],
	priority = 0,
): EpicItem {
	return {
		identifier,
		title: cell(identifier),
		url: cell(`https://linear.app/example/issue/${identifier}`),
		state: cell({ name: "Backlog", type: "backlog" }),
		priority: cell(priority),
		blocked_by: cell(blockedBy ?? []),
		blocks: {
			...cell([]),
			provenance: { kind: "derived", rule: "dependents.v1", from: [] },
		},
		acceptance: cell({ text: "Ship it", truncated: false }),
		founder_named: cell(false),
		session: cell({ latest: [], ledger_live_count: 0 }),
		run: cell([]),
		attempt: cell([]),
		gates: cell([]),
		carriers: cell([]),
		land: cell([]),
		signals: [],
	};
}

function blocker(
	identifier: string,
	inScope = true,
	stateType = "backlog",
): NonNullable<EpicItem["blocked_by"]["value"]>[number] {
	return {
		identifier,
		title: `Title ${identifier}`,
		url: `https://linear.app/example/issue/${identifier}`,
		in_scope: inScope,
		blocker_state_type: stateType,
	};
}

describe("ready.v1", () => {
	it("uses Linear state and blockers only, then sorts by priority", () => {
		const noPriority = item("EPX-0", [], 0);
		noPriority.state = cell({ name: "Todo", type: "unstarted" });
		const urgent = item("EPX-1", [], 1);
		urgent.state = cell({ name: "In Progress", type: "started" });
		const released = item("EPX-2", [blocker("EPX-X", false, "completed")], 2);
		released.state = cell({ name: "Todo", type: "unstarted" });
		const canceledBlocker = item(
			"EPX-3",
			[blocker("EPX-X", false, "canceled")],
			1,
		);
		canceledBlocker.state = cell({ name: "Todo", type: "unstarted" });
		const backlog = item("EPX-4", [], 1);
		const completed = item("EPX-5", [], 1);
		completed.state = cell({ name: "Done", type: "completed" });

		expect(
			computeReady([
				noPriority,
				urgent,
				released,
				canceledBlocker,
				backlog,
				completed,
			]),
		).toEqual(["EPX-1", "EPX-2", "EPX-0"]);
	});
});

describe("other v1 rules", () => {
	it("defines completed as the default done rule at generation time", () => {
		expect(doneDefinition(NOW)).toEqual({
			value: { terminal_state: "completed" },
			provenance: { kind: "derived", rule: "done.v1", from: [] },
			observed_at: NOW,
		});
	});

	it("matches the exact founder-review label", () => {
		expect(isFounderNamed(["Flywheel", "founder-review"])).toBe(true);
		expect(isFounderNamed(["Founder-Review"])).toBe(false);
	});

	it.each([
		["# 验收\n第一条", "第一条"],
		["## 验收:\n第二条", "第二条"],
		["## 验收标准\n第三条", "第三条"],
		["## Acceptance\nFourth", "Fourth"],
		["### Definition of Done\nFifth\n## Next\nNo", "Fifth"],
	])("extracts the first acceptance section from %j", (description, text) => {
		expect(extractAcceptance(description)).toEqual({ text, truncated: false });
	});

	it("treats an empty acceptance section as missing", () => {
		expect(extractAcceptance("## 验收\n   \n## 下一节\n说明")).toBeNull();
	});

	it("stops acceptance at a same-level heading without marker whitespace", () => {
		expect(
			extractAcceptance(
				"## 验收\n- 条件 A\n##下一节\n这里不属于验收\nSECRET-TAIL",
			),
		).toEqual({ text: "- 条件 A", truncated: false });
	});

	it("ignores heading markers inside fenced acceptance examples", () => {
		expect(
			extractAcceptance(
				"## 验收\n- 条件 A\n```md\n# 示例标题\n```\n## 下一节\nSECRET-TAIL",
			),
		).toEqual({
			text: "- 条件 A\n```md\n# 示例标题\n```",
			truncated: false,
		});
	});

	it.each([
		[
			"an unclosed bare fence",
			"## 验收\n- 条件 A\n``` \n## 下一节\nSECRET-TAIL",
			"- 条件 A\n```",
		],
		[
			"an unclosed language-marked fence",
			"## 验收\n- 条件 A\n```bash\necho hi\n## 下一节\nSECRET-TAIL",
			"- 条件 A\n```bash\necho hi",
		],
		[
			"an unclosed fence followed by a heading without marker whitespace",
			"## 验收\n- 条件 A\n```bash\necho hi\n##下一节\nSECRET-TAIL",
			"- 条件 A\n```bash\necho hi",
		],
	])("recovers from %s at the next section heading", (_name, input, text) => {
		expect(extractAcceptance(input)).toEqual({ text, truncated: false });
	});

	it("ignores acceptance headings inside an earlier fenced example", () => {
		expect(
			extractAcceptance("```md\n## 验收\n示例而已\n```\n## 验收\n真实条件"),
		).toEqual({ text: "真实条件", truncated: false });
	});

	it("returns null without a matching heading", () => {
		expect(extractAcceptance("plain description")).toBeNull();
	});

	it("truncates UTF-8 at a character boundary", () => {
		const result = extractAcceptance(`## 验收\n${"界".repeat(2000)}`);
		expect(result?.truncated).toBe(true);
		expect(Buffer.byteLength(result?.text ?? "", "utf8")).toBeLessThanOrEqual(
			4096,
		);
		expect(result?.text.endsWith("界")).toBe(true);
	});

	it("computes gaps from the required item faces", () => {
		const candidate = item("EPX-1");
		candidate.acceptance = {
			value: null,
			provenance: { kind: "linear", entity: "issue", id: "u1" },
			observed_at: NOW,
			missing: { reason: "no_acceptance_section" },
		};
		expect(computeGaps([candidate])).toEqual([
			{
				item: "EPX-1",
				face: "done",
				reason: "no_acceptance_section",
			},
		]);
	});
});
