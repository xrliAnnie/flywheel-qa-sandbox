import { describe, expect, it } from "vitest";
import {
	assertEpicPage,
	type Cell,
	contentDigest,
	EPIC_PAGE_MAX_DOCUMENT_BYTES,
	type EpicPage,
	EpicPageSchemaError,
	stripTimestamps,
} from "../model.js";

const NOW = "2026-09-03T04:00:00Z";

function linearCell<T>(value: T): Cell<T> {
	return {
		value,
		provenance: { kind: "linear", entity: "issue", id: "uuid-1" },
		observed_at: NOW,
		source_updated_at: "2026-09-03T03:00:00.123Z",
	};
}

function derivedCell<T>(value: T, from: string[] = []): Cell<T> {
	return {
		value,
		provenance: { kind: "derived", rule: "done.v1", from },
		observed_at: NOW,
	};
}

function statestoreCell<T>(value: T, table = "sessions"): Cell<T> {
	return {
		value,
		provenance: { kind: "statestore", table, key: { issue_id: "EPX-1" } },
		observed_at: NOW,
	};
}

function validPage(withItem = true): EpicPage {
	const items: EpicPage["items"] = withItem
		? [
				{
					identifier: "EPX-1",
					title: linearCell("Build it"),
					url: linearCell("https://linear.app/example/issue/EPX-1"),
					state: linearCell({ name: "Backlog", type: "backlog" }),
					priority: linearCell(0),
					blocked_by: {
						...linearCell([]),
						provenance: {
							kind: "linear",
							entity: "relation",
							id: "uuid-1",
							field: "inverseRelations",
						},
					},
					blocks: {
						...derivedCell([]),
						provenance: {
							kind: "derived",
							rule: "dependents.v1",
							from: ["/items/0/blocked_by"],
						},
					},
					acceptance: linearCell({ text: "Ship it", truncated: false }),
					founder_named: {
						...linearCell(false),
						provenance: { kind: "linear", entity: "label", id: "uuid-1" },
					},
					session: statestoreCell({ latest: [], ledger_live_count: 0 }),
					run: statestoreCell([], "workflow_run"),
					attempt: statestoreCell([], "workflow_run_node"),
					gates: statestoreCell([], "workflow_gate_holder"),
					carriers: statestoreCell([], "workflow_carrier_delivery"),
					land: statestoreCell([], "land_operation"),
					signals: [],
				},
			]
		: [];
	return {
		schema_version: 1,
		key: { project_name: "example" },
		generated_at: NOW,
		generator: { version: "epic-page/1", trigger: "manual" },
		header: {
			scope_definition: {
				...derivedCell({
					root_state_type: "started" as const,
					daily_title_contains: "日常" as const,
					excluded_item_state_type: "backlog" as const,
				}),
				provenance: { kind: "derived", rule: "scope.v1", from: [] },
			},
			roots: {
				...linearCell([
					{
						identifier: "EPX-100",
						title: "日常",
						url: "https://linear.app/example/issue/EPX-100",
						state: { name: "In Progress", type: "started" },
					},
				]),
				provenance: { kind: "linear", entity: "issues", id: "EPX" },
			},
			items: {
				value: withItem ? ["EPX-1"] : [],
				provenance: { kind: "linear", entity: "children", id: "EPX" },
				observed_at: NOW,
			},
		},
		items,
		done_definition: derivedCell({ terminal_state: "completed" }),
		founder_items: derivedCell([]),
		ready_items: {
			...derivedCell(withItem ? ["EPX-1"] : []),
			provenance: {
				kind: "derived",
				rule: "ready.v1",
				from: withItem
					? ["/items/0/state", "/items/0/priority", "/items/0/blocked_by"]
					: [],
			},
		},
		gaps: derivedCell(
			withItem
				? []
				: [
						{
							item: "EPX-100",
							face: "what",
							reason: "no_children",
						},
					],
		),
	};
}

function expectSchemaFailure(page: unknown, code = "invalid"): void {
	try {
		assertEpicPage(page);
		throw new Error("expected schema failure");
	} catch (error) {
		expect(error).toBeInstanceOf(EpicPageSchemaError);
		expect((error as EpicPageSchemaError).code).toBe(code);
	}
}

describe("EpicPage v1 schema", () => {
	it("accepts the active-root scope header and rejects the single-Epic header", () => {
		expect(assertEpicPage(validPage())).toBeUndefined();
		const legacy = structuredClone(validPage()) as any;
		legacy.key.epic_identifier = "EPX-100";
		legacy.header.title = linearCell("Legacy single Epic");
		expectSchemaFailure(legacy);
	});

	it("accepts ready_items and rejects the abolished batch model", () => {
		expect(assertEpicPage(validPage())).toBeUndefined();
		const legacy = structuredClone(validPage()) as any;
		legacy.items[0].batch = derivedCell(1);
		legacy.batches = derivedCell([{ batch: 1, items: ["EPX-1"] }]);
		expectSchemaFailure(legacy);
	});

	it("uses the measured 200-item bound rounded to a 64KB multiple", () => {
		expect(EPIC_PAGE_MAX_DOCUMENT_BYTES).toBe(1_507_328);
	});

	it("accepts a complete page and the all-empty execution facts", () => {
		expect(assertEpicPage(validPage())).toBeUndefined();
	});

	it("accepts zero children with a sourced empty children cell", () => {
		expect(assertEpicPage(validPage(false))).toBeUndefined();
	});

	it.each([
		[
			"naked leaf",
			(page: any) => {
				page.extra = "unsourced";
			},
		],
		[
			"naked array",
			(page: any) => {
				page.extra = [];
			},
		],
		[
			"bad observed time",
			(page: any) => {
				page.header.roots.observed_at = "yesterday";
			},
		],
		[
			"bad provenance",
			(page: any) => {
				page.header.roots.provenance = { kind: "memory" };
			},
		],
		[
			"bad derived pointer",
			(page: any) => {
				page.ready_items.provenance.from = ["/missing"];
			},
		],
		[
			"null without missing",
			(page: any) => {
				page.items[0].title.value = null;
			},
		],
		[
			"timestamp inside a value",
			(page: any) => {
				page.header.scope_definition.value.changed_at = NOW;
			},
		],
		["signals populated", (page: any) => page.items[0].signals.push("event")],
		[
			"item membership mismatch",
			(page: any) => {
				page.header.items.value = ["EPX-2"];
			},
		],
		["missing done definition", (page: any) => delete page.done_definition],
	] as const)("rejects %s", (_name, mutate) => {
		const page = validPage();
		mutate(page);
		expectSchemaFailure(page);
	});

	it("rejects a missing cell whose value is non-null", () => {
		const page = validPage();
		page.items[0].acceptance.missing = { reason: "no_acceptance_section" };
		expectSchemaFailure(page);
	});

	it("rejects documents beyond the configured byte bound", () => {
		const page = validPage();
		page.items[0].title.value = "x".repeat(EPIC_PAGE_MAX_DOCUMENT_BYTES);
		expectSchemaFailure(page, "size");
	});
});

describe("EpicPage content digest", () => {
	it("strips only observation timestamps recursively", () => {
		expect(
			stripTimestamps({
				observed_at: NOW,
				source_updated_at: NOW,
				generated_at: NOW,
				created_at: NOW,
				nested: [{ ended_at: NOW, observed_at: NOW }],
			}),
		).toEqual({
			created_at: NOW,
			nested: [{ ended_at: NOW }],
		});
	});

	it("is stable across timestamp refreshes and changes with values", () => {
		const first = validPage();
		const refreshed = structuredClone(first);
		refreshed.generated_at = "2026-09-03T05:00:00Z";
		refreshed.header.roots.observed_at = "2026-09-03T05:00:00Z";
		refreshed.header.roots.source_updated_at = "2026-09-03T04:30:00Z";
		expect(contentDigest(first)).toBe(contentDigest(refreshed));
		refreshed.header.roots.value![0]!.title = "Changed";
		expect(contentDigest(first)).not.toBe(contentDigest(refreshed));
	});
});
