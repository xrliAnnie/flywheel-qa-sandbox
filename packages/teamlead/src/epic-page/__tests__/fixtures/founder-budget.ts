import { generateEpicPage } from "../../generate.js";
import { assertEpicPage } from "../../model.js";
import {
	EPIC_SHAPE_NOW,
	epicShapeSnapshotV3,
	v3ItemFacts,
} from "./epic-shape.js";

// E1 baseline; C5 adds merged attention and one 280-character note per issue.
export function pageForBudgetBase(n: number) {
	if (n < 8 || n > 200)
		throw new Error("budget fixture requires 8..200 children");
	const snapshot = epicShapeSnapshotV3();
	const rootTemplate = snapshot.roots[0]!,
		itemTemplate = snapshot.items[0]!;
	snapshot.roots = Array.from({ length: 8 }, (_, i) => ({
		...structuredClone(rootTemplate),
		id: `budget-root-${i}`,
		identifier: `ROOT-${i}`,
		title: "项".repeat(120),
		url: `https://linear.app/example/issue/ROOT-${i}`,
	}));
	snapshot.items = Array.from({ length: n }, (_, i) => {
		const root = snapshot.roots[i % 8]!;
		return {
			...structuredClone(itemTemplate),
			id: `budget-item-${i}`,
			identifier: `BUD-${i}`,
			title: "任".repeat(120),
			url: `https://linear.app/example/issue/BUD-${i}`,
			parent: { id: root.id, identifier: root.identifier },
			state: {
				name: i % 2 ? "Todo" : "In Progress",
				type: i % 2 ? "unstarted" : "started",
			},
			acceptance: { text: "A".repeat(4096), truncated: false },
			blockedBy: [1, 2, 3].map((offset) => ({
				id: `budget-item-${(i + offset) % n}`,
				identifier: `BUD-${(i + offset) % n}`,
				title: "挡".repeat(120),
				url: `https://linear.app/example/issue/BUD-${(i + offset) % n}`,
				stateType: "started",
				inScope: true,
			})),
		};
	});
	snapshot.descendantIds = snapshot.items.map((i) => i.id);
	const facts = v3ItemFacts(epicShapeSnapshotV3())[0]!;
	const at = EPIC_SHAPE_NOW.toISOString();
	return generateEpicPage({
		snapshot,
		itemFacts: snapshot.items.map(() => structuredClone(facts)),
		itemSignals: snapshot.items.map((item) => ({
			signals: [
				{
					kind: "question_pending",
					since: at,
					execution_id8: "budget01",
					observed_at: at,
					provenance: {
						kind: "commdb",
						table: "questions",
						key: { issue_identifier: item.identifier },
					},
				},
			],
			signal_sources: {
				statestore: {
					value: { signals: 0 },
					observed_at: at,
					provenance: {
						kind: "statestore",
						table: "sessions",
						key: { issue_id: item.id },
					},
				},
				commdb: {
					value: { signals: 1 },
					observed_at: at,
					provenance: {
						kind: "commdb",
						table: "questions",
						key: { issue_identifier: item.identifier },
					},
				},
			},
		})),
		now: EPIC_SHAPE_NOW,
		projectName: "example",
		trigger: "manual",
	});
}

/** FLY-2399 local capacity fixture: original cardinality, one 280-codepoint note per issue.
 * The separate v2 variant adds the actual attention source and budget model. */
export function pageForShipJudgmentBudget(n = 60) {
	const page = pageForBudgetBase(n);
	const at = EPIC_SHAPE_NOW.toISOString();
	page.key.project_name = "flywheel";
	const note = () => ({
		value: "注".repeat(280),
		observed_at: at,
		source_updated_at: at,
		provenance: {
			kind: "lead_note" as const,
			role: "engineering",
			written_at: at,
		},
	});
	for (const root of page.header.roots.value ?? []) root.lead_note = [note()];
	for (const item of page.items) {
		item.lead_note = [note()];
		item.ship_judgment = {
			value: {
				question_id: item.identifier,
				opinion_id: "o".repeat(240),
				input_id: "i".repeat(240),
				evaluation_id: "e".repeat(240),
				source: "machine",
				overall: "recommend_reject",
				alignment: "undetermined",
				conflict: "undetermined",
				coverage: "undetermined",
				display: "published",
				reason: "missing_evidence",
				policy_version: "ship-judgment-v1",
				model_snapshot_digest: "a".repeat(64),
				evidence: {
					evaluation: { quote: "证".repeat(310) },
					mechanical: { scope: "m".repeat(930) },
				},
			},
			observed_at: at,
			source_updated_at: at,
			provenance: {
				kind: "statestore",
				table: "ship_judgment_opinion",
				key: { issue_identifier: item.identifier },
			},
		};
	}
	page.ship_judgment_history = {
		value: {
			rows: Array.from({ length: 20 }, (_, i) => ({
				questionId: `q-${i}`,
				issue: "<&😀".repeat(200),
				auditId: "a".repeat(240),
				source: "auto_narrow_gate",
				overall: "recommend_reject",
				decision: "approved",
				decisionSource: "lead_manual",
				decisionAuditId: "d".repeat(240),
				clarificationAuditId: "c".repeat(240),
				authorship: "unknown",
				clarification: "unavailable",
				summary: "<&😀".repeat(200),
				cardUrl:
					"https://discord.com/channels/11111111111111111111/22222222222222222222/33333333333333333333",
				updatedAt: at,
			})),
			total: 10000,
			url: "https://reports.example/r/" + "a".repeat(200),
			publishedAsOf: at,
			error: "history_round_failed",
			dirty: true,
			readError: false,
		},
		observed_at: at,
		provenance: {
			kind: "statestore",
			table: "ship_judgment_project_state",
			key: { project_name: "flywheel" },
		},
	};
	assertEpicPage(page);
	return page;
}

export async function pageForShipJudgmentAttentionBudget(n = 60) {
	const { buildAttention } = await import("../../attention.js");
	const { attentionFixture, candidate, sourceCell } = await import(
		"./attention.js"
	);
	const input = attentionFixture();
	input.candidates = Array.from({ length: 200 }, (_, i) => {
		const row = candidate(
			i + 1000,
			"founder_gate",
			"statestore",
			"workflow_gate_holder",
		);
		row.title.value = "<&>".repeat(600);
		return row;
	});
	input.reads.gates.value = { count: 200 };
	input.reads.questions.value = { count: 0 };
	input.reads.founder_review.value = { count: 0 };
	return {
		...pageForShipJudgmentBudget(n),
		...buildAttention(input, EPIC_SHAPE_NOW.toISOString()),
		schema_version: 2 as const,
		generator: {
			version: "epic-page/2" as const,
			trigger: "manual" as const,
			reasons: ["manual" as const],
		},
		epic_scope: sourceCell(
			{ available: true as const },
			"linear",
			"active_scope",
		),
	};
}
