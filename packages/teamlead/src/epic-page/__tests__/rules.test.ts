import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateEpicPage } from "../generate.js";
import { type Cell, type EpicItem, EpicPageSchemaError } from "../model.js";
import {
	classifyItem,
	computeDependencyReview,
	computeGaps,
	computeReady,
	computeRootCounts,
	doneDefinition,
	extractAcceptance,
	isFounderNamed,
	rootOf,
} from "../rules.js";
import {
	EPIC_SHAPE_NOW,
	emptyItemFacts,
	epicShapeSnapshotV2,
} from "./fixtures/epic-shape.js";

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
		parent: cell("EPX-100"),
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
		signal_sources: {
			statestore: cell({ signals: 0 }),
			commdb: cell({ signals: 0 }),
		},
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

describe("subtraction.v1", () => {
	it("reports a canceled blocker that still blocks a non-terminal item", () => {
		const candidate = item("EPX-1", [blocker("EPX-0", true, "canceled")]);
		candidate.state = cell({ name: "Todo", type: "unstarted" });

		expect(
			computeDependencyReview([candidate], [candidate.identifier]),
		).toEqual([{ kind: "canceled_blocker", item: "EPX-1", blocker: "EPX-0" }]);
	});

	it("reports a deterministic cycle among in-scope items", () => {
		const first = item("EPX-2", [blocker("EPX-1")]);
		first.state = cell({ name: "Todo", type: "unstarted" });
		const second = item("EPX-1", [blocker("EPX-2")]);
		second.state = cell({ name: "Doing", type: "started" });

		expect(computeDependencyReview([first, second], ["EPX-X"])).toEqual([
			{ kind: "dependency_cycle", members: ["EPX-1", "EPX-2"] },
		]);
	});

	it("reports the sorted blocking frontier when no non-terminal item is ready", () => {
		const first = item("EPX-2", [blocker("GEO-9", false, "started")]);
		first.state = cell({ name: "Todo", type: "unstarted" });
		const second = item("EPX-1", [blocker("EPX-0", false, "backlog")]);
		second.state = cell({ name: "Doing", type: "started" });

		expect(computeDependencyReview([first, second], [])).toEqual([
			{
				kind: "all_blocked",
				non_terminal: 2,
				blocking_edges: [
					{
						blocker: "EPX-0",
						blocked: "EPX-1",
						blocker_state_type: "backlog",
						in_scope: false,
					},
					{
						blocker: "GEO-9",
						blocked: "EPX-2",
						blocker_state_type: "started",
						in_scope: false,
					},
				],
				blocking_edges_truncated: false,
			},
		]);
	});

	it("fails with a schema error when required dependency input is missing", () => {
		const candidate = item("EPX-1");
		candidate.state = {
			value: null,
			provenance: { kind: "linear", entity: "issue", id: "uuid-1" },
			observed_at: NOW,
			missing: { reason: "statestore_error" },
		};

		expect(() => computeDependencyReview([candidate], [])).toThrowError(
			EpicPageSchemaError,
		);
	});

	it("deduplicates repeated canceled blocker observations", () => {
		const candidate = item("EPX-1", [
			blocker("EPX-0", true, "canceled"),
			blocker("EPX-0", true, "canceled"),
		]);
		candidate.state = cell({ name: "Todo", type: "unstarted" });

		expect(
			computeDependencyReview([candidate], [candidate.identifier]),
		).toEqual([{ kind: "canceled_blocker", item: "EPX-1", blocker: "EPX-0" }]);
	});

	it("does not report canceled blockers on terminal items", () => {
		const candidate = item("EPX-1", [blocker("EPX-0", true, "canceled")]);
		candidate.state = cell({ name: "Done", type: "completed" });
		expect(computeDependencyReview([candidate], [])).toEqual([]);
	});

	it("reports three-node cycles and self-loops but ignores external blockers", () => {
		const first = item("EPX-3", [blocker("EPX-1")]);
		const second = item("EPX-1", [blocker("EPX-2")]);
		const third = item("EPX-2", [blocker("EPX-3")]);
		const self = item("EPX-4", [blocker("EPX-4")]);
		const external = item("EPX-5", [blocker("GEO-1", false)]);
		for (const candidate of [first, second, third, self, external]) {
			candidate.state = cell({ name: "Todo", type: "unstarted" });
		}

		expect(
			computeDependencyReview(
				[external, self, third, first, second],
				["EPX-X"],
			),
		).toEqual([
			{ kind: "dependency_cycle", members: ["EPX-1", "EPX-2", "EPX-3"] },
			{ kind: "dependency_cycle", members: ["EPX-4"] },
		]);
	});

	it("does not report all_blocked when every item is terminal", () => {
		const completed = item("EPX-1");
		completed.state = cell({ name: "Done", type: "completed" });
		const canceled = item("EPX-2");
		canceled.state = cell({ name: "Canceled", type: "canceled" });
		expect(computeDependencyReview([completed, canceled], [])).toEqual([]);
	});

	it("caps the all_blocked frontier at fifty edges and marks truncation", () => {
		const candidate = item(
			"EPX-1",
			Array.from({ length: 51 }, (_entry, index) =>
				blocker(`EPX-${index + 2}`, true, "unstarted"),
			),
		);
		candidate.state = cell({ name: "Todo", type: "unstarted" });
		const review = computeDependencyReview([candidate], []);
		const allBlocked = review.find((entry) => entry.kind === "all_blocked");
		expect(allBlocked?.blocking_edges).toHaveLength(50);
		expect(allBlocked?.blocking_edges_truncated).toBe(true);
	});

	it("returns byte-for-byte stable output for the same input", () => {
		const candidate = item("EPX-1", [blocker("EPX-0", false, "started")]);
		candidate.state = cell({ name: "Todo", type: "unstarted" });
		expect(JSON.stringify(computeDependencyReview([candidate], []))).toBe(
			JSON.stringify(computeDependencyReview([candidate], [])),
		);
	});

	it("fails loudly instead of silently truncating an oversized review", () => {
		const candidate = item(
			"EPX-1",
			Array.from({ length: 5001 }, (_entry, index) =>
				blocker(`EXT-${index + 1}`, false, "canceled"),
			),
		);
		candidate.state = cell({ name: "Todo", type: "unstarted" });

		expect(() => computeDependencyReview([candidate], [])).toThrowError(
			/dependency review exceeds 5000 entries/,
		);
	});

	it("applies the review limit to the combined result", () => {
		const candidate = item("EPX-1", [
			...Array.from({ length: 4999 }, (_entry, index) =>
				blocker(`EXT-${index + 1}`, false, "canceled"),
			),
			blocker("EPX-1", true, "unstarted"),
		]);
		candidate.state = cell({ name: "Todo", type: "unstarted" });

		expect(() => computeDependencyReview([candidate], [])).toThrowError(
			/dependency review exceeds 5000 entries/,
		);
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

describe("classifyItem", () => {
	it.each([
		["completed", [], "done"],
		["canceled", [], "canceled"],
		["backlog", [], "idle"],
		["unstarted", [blocker("OUT", false, "completed")], "free"],
		["triage", [blocker("OUT", false, "started")], "waiting"],
		["backlog", [blocker("OUT", false, "canceled")], "waiting"],
		["future", [], null],
	] as const)("classifies %s with %j as %s", (type, blockers, expected) => {
		const subject = item("EPX-1", [...blockers]);
		subject.state.value = { name: type, type };
		expect(classifyItem(subject)).toBe(expected);
	});

	it("uses machine evidence instead of Linear started for live classification", () => {
		const subject = item("EPX-1");
		subject.state.value = { name: "In Progress", type: "started" };
		subject.session.value = {
			latest: [],
			ledger_live_count: 0,
			machine_running_count: 0,
			running_heartbeat_stale_count: 0,
			running_heartbeat_missing_count: 0,
		} as typeof subject.session.value;

		expect(classifyItem(subject)).toBe("stopped_stuck");

		subject.session.value.machine_running_count = 1;
		expect(classifyItem(subject)).toBe("live");
	});

	it.each([
		["active", "review", false, "stopped_acceptance"],
		["active", "pending", true, "evidence_gap"],
		["held", "running", false, "stopped_stuck"],
	] as const)(
		"does not treat an unrelated fresh session as live for a %s run with a %s current attempt",
		(runStatus, attemptState, startingRecent, expected) => {
			const subject = item("EPX-1");
			subject.state.value = { name: "In Progress", type: "started" };
			subject.session.value = {
				latest: [
					{
						status: "running",
						role: "qa",
						branch: "flywheel-EPX-1",
						execution_id8: "unbound1",
					},
				],
				ledger_live_count: 1,
				machine_running_count: 1,
				running_heartbeat_stale_count: 0,
				running_heartbeat_missing_count: 0,
			};
			subject.run.value = [
				{
					run_id: "run-current",
					status: runStatus,
					current_node_id: "implement",
					current_node_label: "实现",
					label_source: "manifest",
					template_id: "workflow-v1",
				},
			];
			subject.attempt.value = [
				{
					state: attemptState,
					attempt: 1,
					ledger_open: true,
					machine_live: attemptState === "running",
					starting_recent: startingRecent,
					heartbeat_state:
						attemptState === "running" ? "fresh" : "not_applicable",
				},
			];
			if (runStatus === "held") {
				subject.signals = [
					{
						kind: "run_held",
						since: NOW,
						execution_id8: "runheld1",
						provenance: {
							kind: "statestore",
							table: "workflow_run",
							key: { run_id: "run-current" },
						},
						observed_at: NOW,
					},
				];
			}

			expect(classifyItem(subject)).toBe(expected);
		},
	);

	it("prioritizes an explicit stuck signal over an unrelated fresh session", () => {
		const subject = item("EPX-1");
		subject.state.value = { name: "In Progress", type: "started" };
		subject.session.value = {
			latest: [
				{
					status: "running",
					role: "qa",
					branch: "flywheel-EPX-1",
					execution_id8: "unbound1",
				},
			],
			ledger_live_count: 1,
			machine_running_count: 1,
			running_heartbeat_stale_count: 0,
			running_heartbeat_missing_count: 0,
		};
		subject.run.value = [
			{
				run_id: "run-current",
				status: "held",
				current_node_id: "land",
				current_node_label: "落地",
				label_source: "manifest",
				template_id: "workflow-v1",
			},
		];
		subject.attempt.value = [
			{
				state: "review",
				attempt: 1,
				ledger_open: true,
				machine_live: false,
				starting_recent: false,
				heartbeat_state: "not_applicable",
			},
		];
		subject.signals = [
			{
				kind: "run_held",
				since: NOW,
				execution_id8: "landheld",
				provenance: {
					kind: "statestore",
					table: "workflow_run",
					key: { run_id: "run-current" },
				},
				observed_at: NOW,
			},
		];

		expect(classifyItem(subject)).toBe("stopped_stuck");
	});

	it("fails closed when either stuck-signal source is unreadable", () => {
		const subject = item("EPX-1");
		subject.state.value = { name: "In Progress", type: "started" };
		subject.session.value = {
			latest: [
				{
					status: "completed",
					role: "qa",
					branch: "flywheel-EPX-1",
					execution_id8: "done0001",
				},
			],
			ledger_live_count: 0,
			machine_running_count: 0,
			running_heartbeat_stale_count: 0,
			running_heartbeat_missing_count: 0,
		};
		subject.signal_sources.statestore = {
			value: null,
			missing: { reason: "statestore_error" },
			provenance: {
				kind: "statestore",
				table: "sessions",
				key: { issue_identifier: subject.identifier },
			},
			observed_at: NOW,
		};

		expect(classifyItem(subject)).toBe("evidence_gap");
	});

	it("requires explicit zero fresh sessions before calling an overdue pending attempt stuck", () => {
		const subject = item("EPX-1");
		subject.state.value = { name: "In Progress", type: "started" };
		subject.session.value = {
			latest: [],
			ledger_live_count: 0,
			running_heartbeat_stale_count: 0,
			running_heartbeat_missing_count: 0,
		};
		subject.run.value = [
			{
				run_id: "run-current",
				status: "active",
				current_node_id: "implement",
				current_node_label: "实现",
				label_source: "manifest",
				template_id: "workflow-v1",
			},
		];
		subject.attempt.value = [
			{
				state: "pending",
				attempt: 1,
				ledger_open: true,
				machine_live: false,
				starting_recent: false,
				heartbeat_state: "not_applicable",
			},
		];

		expect(classifyItem(subject)).toBe("evidence_gap");
		subject.session.value.machine_running_count = 0;
		expect(classifyItem(subject)).toBe("stopped_stuck");
	});

	it("keeps normal completion and heartbeat evidence gaps distinct", () => {
		const subject = item("EPX-1");
		subject.state.value = { name: "In Progress", type: "started" };
		subject.session.value = {
			latest: [
				{
					status: "completed",
					role: "implement",
					branch: "flywheel-FLY-2727",
					execution_id8: "deadbeef",
				},
			],
			ledger_live_count: 0,
			machine_running_count: 0,
			running_heartbeat_stale_count: 0,
			running_heartbeat_missing_count: 0,
		} as typeof subject.session.value;

		expect(classifyItem(subject)).toBe("stopped_acceptance");

		subject.session.value.latest[0]!.status = "running";
		subject.session.value.running_heartbeat_stale_count = 1;
		expect(classifyItem(subject)).toBe("evidence_gap");
	});

	it("treats FLY-2598's held land signal as stuck despite its completed session", () => {
		const subject = item("FLY-2598");
		subject.state.value = { name: "In Progress", type: "started" };
		subject.session.value = {
			latest: [
				{
					status: "completed",
					role: "qa",
					branch: "flywheel-FLY-2598",
					execution_id8: "8575b98f",
				},
			],
			ledger_live_count: 0,
			machine_running_count: 0,
			running_heartbeat_stale_count: 0,
			running_heartbeat_missing_count: 0,
		};
		subject.run.value = [
			{
				run_id: "d0e72d2d",
				status: "held",
				current_node_id: "land",
				current_node_label: "落地",
				label_source: "manifest",
				template_id: "workflow-v1",
			},
		];
		subject.attempt.value = [
			{
				state: "pending",
				attempt: 1,
				ledger_open: true,
				machine_live: false,
				starting_recent: false,
				heartbeat_state: "not_applicable",
			},
		];
		subject.signals = [
			{
				kind: "run_held",
				since: NOW,
				execution_id8: "cfd72ba5",
				provenance: {
					kind: "statestore",
					table: "workflow_run",
					key: { run_id: "d0e72d2d" },
				},
				observed_at: NOW,
			},
		];

		expect(classifyItem(subject)).toBe("stopped_stuck");
	});

	it.each([
		["completed", "stopped_acceptance"],
		["ship_parked", "stopped_acceptance"],
		["awaiting_review", "stopped_acceptance"],
		["design_done", "stopped_acceptance"],
		["approved_to_ship", "stopped_acceptance"],
		["approved", "stopped_acceptance"],
		["failed", "stopped_stuck"],
		["blocked", "stopped_stuck"],
		["timeout", "stopped_stuck"],
		["terminated", "stopped_stuck"],
		["canceled", "stopped_stuck"],
		["cancelled", "stopped_stuck"],
		["rejected", "stopped_stuck"],
		["deferred", "stopped_stuck"],
		["shelved", "stopped_stuck"],
		["unknown", "stopped_stuck"],
		["pending", "stopped_stuck"],
	] as const)("maps a stopped latest session %s to %s", (status, expected) => {
		const subject = item("EPX-1");
		subject.state.value = { name: "In Progress", type: "started" };
		subject.session.value = {
			latest: [
				{
					status,
					role: "implement",
					branch: null,
					execution_id8: "deadbeef",
				},
			],
			ledger_live_count: 0,
			machine_running_count: 0,
			running_heartbeat_stale_count: 0,
			running_heartbeat_missing_count: 0,
		};
		expect(classifyItem(subject)).toBe(expected);
	});
});

describe("rootOf", () => {
	it("finds direct roots and follows descendants", () => {
		const a = item("EPX-1"),
			b = item("EPX-2");
		b.parent.value = a.identifier;
		const byId = new Map([a, b].map((i) => [i.identifier, i]));
		const roots = new Set(["EPX-100"]);
		expect(rootOf(a, byId, roots)).toBe("EPX-100");
		expect(rootOf(b, byId, roots)).toBe("EPX-100");
	});
	it("leaves an entire chain ending at null unattached, retaining parent pointers", () => {
		const a = item("EPX-1"),
			b = item("EPX-2");
		a.parent.value = b.identifier;
		b.parent.value = null;
		const byId = new Map([a, b].map((i) => [i.identifier, i]));
		const roots = new Set(["EPX-100"]);
		expect(rootOf(a, byId, roots)).toBeNull();
		expect(rootOf(b, byId, roots)).toBeNull();
		expect(computeRootCounts([a, b], [{ identifier: "EPX-100" }])).toEqual([
			{
				root: "EPX-100",
				value: {
					root: "EPX-100",
					counts: {
						live: 0,
						stopped_acceptance: 0,
						stopped_stuck: 0,
						evidence_gap: 0,
						waiting: 0,
						free: 0,
						idle: 0,
						done: 0,
						canceled: 0,
						total: 0,
					},
				},
				from: ["/header/roots", "/items/0/parent", "/items/1/parent"],
			},
		]);
	});
	it.each(["dangling", "cycle"])(
		"rejects %s with the original error",
		(kind) => {
			const a = item("EPX-8"),
				b = item("EPX-9");
			a.parent.value = b.identifier;
			b.parent.value = kind === "cycle" ? a.identifier : "unknown";
			const byId = new Map([a, b].map((i) => [i.identifier, i]));
			expect(() => rootOf(a, byId, new Set(["EPX-100"]))).toThrow(
				new EpicPageSchemaError(
					"counts.v1: parent chain does not reach a root: EPX-8",
				),
			);
		},
	);
});

describe("computeRootCounts error precedence", () => {
	it.each(["state", "blocked_by"] as const)(
		"validates %s before a dangling parent",
		(key) => {
			const a = item("EPX-1");
			a[key].value = null;
			for (const parent of ["EPX-100", "unknown"]) {
				a.parent.value = parent;
				expect(() =>
					computeRootCounts([a], [{ identifier: "EPX-100" }]),
				).toThrow(
					new EpicPageSchemaError(
						"counts.v1: state/blocked_by cell must be known: EPX-1",
					),
				);
			}
		},
	);
	it("retains the parent-chain error when cells are known", () => {
		const a = item("EPX-1");
		a.parent.value = "unknown";
		expect(() => computeRootCounts([a], [{ identifier: "EPX-100" }])).toThrow(
			new EpicPageSchemaError(
				"counts.v1: parent chain does not reach a root: EPX-1",
			),
		);
	});
});

it("preserves every scope.v2 root count value, missing state and ordered source path", () => {
	const snapshot = epicShapeSnapshotV2();
	const page = generateEpicPage({
		snapshot,
		itemFacts: snapshot.items.map(() => emptyItemFacts()),
		now: EPIC_SHAPE_NOW,
		projectName: "example",
		trigger: "scan",
	});
	const expected = JSON.parse(
		readFileSync(
			new URL("./fixtures/root-counts-v2.json", import.meta.url),
			"utf8",
		),
	);
	expect(
		page.header.root_counts.map((c) => ({
			value: c.value
				? {
						...c.value,
						counts: Object.fromEntries(
							Object.entries(c.value.counts).filter(([key]) =>
								[
									"live",
									"waiting",
									"free",
									"idle",
									"done",
									"canceled",
									"total",
								].includes(key),
							),
						),
					}
				: null,
			...(c.missing ? { missing: c.missing } : {}),
			from:
				c.provenance.kind === "derived"
					? c.provenance.from.filter(
							(path) => !/(?:session|run|attempt|signal_sources)/.test(path),
						)
					: null,
		})),
	).toEqual(expected);
});
