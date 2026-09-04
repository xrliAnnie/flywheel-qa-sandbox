import { describe, expect, it } from "vitest";
import type { EpicItemFacts } from "../../StateStore.js";
import { generateEpicPage } from "../generate.js";
import { assertEpicPage } from "../model.js";
import {
	EPIC_SHAPE_NOW,
	emptyItemFacts,
	epicShapeSnapshot,
} from "./fixtures/epic-shape.js";

function generate(facts?: EpicItemFacts[]) {
	const snapshot = epicShapeSnapshot();
	return generateEpicPage({
		snapshot,
		itemFacts: facts ?? snapshot.items.map(() => emptyItemFacts()),
		now: EPIC_SHAPE_NOW,
		projectName: "example",
		trigger: "manual",
	});
}

describe("generateEpicPage", () => {
	it("projects active Linear roots and their filtered subtree into the page header", () => {
		const snapshot = epicShapeSnapshot();
		const page = generateEpicPage({
			snapshot,
			itemFacts: snapshot.items.map(() => emptyItemFacts()),
			now: EPIC_SHAPE_NOW,
			projectName: "example",
			trigger: "manual",
		});

		expect(page.key).toEqual({ project_name: "example" });
		expect(page.header.roots.value?.map((root) => root.identifier)).toEqual([
			"EPX-100",
			"EPX-200",
		]);
		expect(page.header.items.value).toEqual([
			"EPX-1",
			"EPX-2",
			"EPX-3",
			"EPX-4",
			"EPX-5",
		]);
	});

	it("generates the approved R1 golden page with every value in a Cell", () => {
		const page = generate();
		expect(page.items[0]?.blocks.value).toEqual([
			{
				identifier: "EPX-2",
				title: "Task B",
				url: "https://linear.app/example/issue/EPX-2",
				state_type: "unstarted",
			},
			{
				identifier: "EPX-3",
				title: "Task C",
				url: "https://linear.app/example/issue/EPX-3",
				state_type: "unstarted",
			},
			{
				identifier: "EPX-4",
				title: "Task D",
				url: "https://linear.app/example/issue/EPX-4",
				state_type: "unstarted",
			},
		]);
		expect(page.items[0]?.blocks.provenance).toEqual({
			kind: "derived",
			rule: "dependents.v1",
			from: [
				"/items/1/blocked_by",
				"/items/2/blocked_by",
				"/items/3/blocked_by",
			],
		});
		expect(page.ready_items.value).toEqual(["EPX-1", "EPX-5"]);
		expect(page.ready_items.provenance).toEqual({
			kind: "derived",
			rule: "ready.v1",
			from: expect.arrayContaining([
				"/items/0/state",
				"/items/0/priority",
				"/items/0/blocked_by",
			]),
		});
		expect(page.founder_items.value).toEqual([]);
		expect(page.gaps.value).toEqual([]);
		expect(page.generator).toEqual({
			version: "epic-page/1",
			trigger: "manual",
		});
		expect(page.done_definition).toMatchObject({
			value: { terminal_state: "completed" },
			provenance: { kind: "derived", rule: "done.v1", from: [] },
			observed_at: EPIC_SHAPE_NOW.toISOString(),
		});
		expect(page.items.every((item) => item.signals.length === 0)).toBe(true);
		expect(() => assertEpicPage(page)).not.toThrow();
	});

	it("represents an observed empty active scope without inventing items", () => {
		const snapshot = epicShapeSnapshot();
		snapshot.items = [];
		const page = generateEpicPage({
			snapshot,
			itemFacts: [],
			now: EPIC_SHAPE_NOW,
			projectName: "example",
			trigger: "manual",
		});
		expect(page.header.items.value).toEqual([]);
		expect(page.items).toEqual([]);
		expect(page.gaps.value).toEqual([
			{ item: "example", face: "what", reason: "no_children" },
		]);
		expect(() => assertEpicPage(page)).not.toThrow();
	});

	it("keeps gate and carrier observations separate with their own provenance", () => {
		const facts = epicShapeSnapshot().items.map(() => emptyItemFacts());
		facts[0] = {
			...emptyItemFacts(),
			gates: { ok: true, value: [{ state: "awaiting_review" }] },
			carriers: { ok: true, value: [{ state: "pending" }] },
		};
		const item = generate(facts).items[0]!;
		expect(item.gates.value).toEqual([{ state: "awaiting_review" }]);
		expect(item.gates.provenance).toMatchObject({
			kind: "statestore",
			table: "workflow_gate_holder",
		});
		expect(item.carriers.value).toEqual([{ state: "pending" }]);
		expect(item.carriers.provenance).toMatchObject({
			kind: "statestore",
			table: "workflow_carrier_delivery",
		});
	});

	it.each([
		[
			"session error",
			(facts: EpicItemFacts) => {
				facts.session = { ok: false, table: "sessions" };
			},
		],
		[
			"active run",
			(facts: EpicItemFacts) => {
				facts.run = {
					ok: true,
					value: [
						{
							run_id: "run-1",
							status: "active",
							current_node_id: "build",
							current_node_label: "Build",
							label_source: "manifest",
							template_id: "tpl",
						},
					],
				};
			},
		],
		[
			"held run",
			(facts: EpicItemFacts) => {
				facts.run = {
					ok: true,
					value: [
						{
							run_id: "run-1",
							status: "held",
							current_node_id: "build",
							current_node_label: "Build",
							label_source: "manifest",
							template_id: "tpl",
						},
					],
				};
			},
		],
		[
			"open attempt",
			(facts: EpicItemFacts) => {
				facts.attempt = {
					ok: true,
					value: [{ state: "review", attempt: 1, ledger_open: true }],
				};
			},
		],
		[
			"land operation",
			(facts: EpicItemFacts) => {
				facts.land = {
					ok: true,
					value: [{ pr_number: 7, state: "running", current_step: "merge" }],
				};
			},
		],
		[
			"older live session despite latest completed",
			(facts: EpicItemFacts) => {
				facts.session = {
					ok: true,
					value: {
						latest: [
							{
								status: "completed",
								role: "implement",
								branch: null,
								execution_id8: "deadbeef",
							},
						],
						ledger_live_count: 1,
					},
				};
			},
		],
		[
			"run dependency failure",
			(facts: EpicItemFacts) => {
				facts.run = { ok: false, table: "workflow_run" };
				facts.attempt = { ok: false, table: "workflow_run_node" };
				facts.gates = { ok: false, table: "workflow_gate_holder" };
				facts.carriers = {
					ok: false,
					table: "workflow_carrier_delivery",
				};
			},
		],
		[
			"gate and carrier query failure",
			(facts: EpicItemFacts) => {
				facts.gates = { ok: false, table: "workflow_gate_holder" };
				facts.carriers = {
					ok: false,
					table: "workflow_carrier_delivery",
				};
			},
		],
	] as const)("keeps ready selection independent of %s", (_name, mutate) => {
		const facts = epicShapeSnapshot().items.map(() => emptyItemFacts());
		mutate(facts[0]!);
		const page = generate(facts);
		expect(page.ready_items.value).toContain("EPX-1");
		expect(() => assertEpicPage(page)).not.toThrow();
	});

	it("turns failed fact reads into stable missing cells without error text", () => {
		const facts = epicShapeSnapshot().items.map(() => emptyItemFacts());
		facts[0] = {
			...emptyItemFacts(),
			run: { ok: false, table: "workflow_run" },
			attempt: { ok: false, table: "workflow_run_node" },
			gates: { ok: false, table: "workflow_gate_holder" },
			carriers: { ok: false, table: "workflow_carrier_delivery" },
		};
		const page = generate(facts);
		expect(page.items[0]?.run).toMatchObject({
			value: null,
			missing: { reason: "statestore_error", detail: "workflow_run" },
		});
		expect(JSON.stringify(page)).not.toMatch(/Bearer|\/Users\/private/);
	});

	it("reports every failed execution fact in page gaps by item and cell", () => {
		const facts = epicShapeSnapshot().items.map(() => emptyItemFacts());
		facts[0] = {
			session: { ok: false, table: "sessions" },
			run: { ok: false, table: "workflow_run" },
			attempt: { ok: false, table: "workflow_run_node" },
			gates: { ok: false, table: "workflow_gate_holder" },
			carriers: { ok: false, table: "workflow_carrier_delivery" },
			land: { ok: false, table: "land_operation" },
		};

		const page = generate(facts);

		expect(page.gaps.value).toEqual(
			["session", "run", "attempt", "gates", "carriers", "land"].map(
				(face) => ({
					item: "EPX-1",
					face,
					reason: "statestore_error",
				}),
			),
		);
		expect(page.gaps.provenance).toMatchObject({
			kind: "derived",
			from: expect.arrayContaining([
				"/items/0/title",
				"/items/0/acceptance",
				"/items/0/founder_named",
				"/items/0/session",
				"/items/0/run",
				"/items/0/attempt",
				"/items/0/gates",
				"/items/0/carriers",
				"/items/0/land",
			]),
		});
		expect(() => assertEpicPage(page)).not.toThrow();
	});
});
