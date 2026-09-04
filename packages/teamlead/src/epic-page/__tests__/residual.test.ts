import { describe, expect, it } from "vitest";
import { generateEpicPage } from "../generate.js";
import {
	assertEpicResidualFact,
	EPIC_RESIDUAL_UNAVAILABLE_TOKENS,
	EpicResidualSessionUnreadableError,
	summarizeEpicResidual,
} from "../residual.js";
import {
	EPIC_SHAPE_NOW,
	emptyItemFacts,
	epicShapeSnapshot,
} from "./fixtures/epic-shape.js";

function materializedShape() {
	const snapshot = epicShapeSnapshot();
	const page = generateEpicPage({
		snapshot,
		itemFacts: snapshot.items.map(() => emptyItemFacts()),
		now: EPIC_SHAPE_NOW,
		projectName: "example",
		trigger: "scan",
	});
	return { page, snapshot };
}

const GENERAL_OWNER = {
	agentId: "example-eng-lead",
	matchMethod: "general" as const,
	canSpawn: true,
};

describe("summarizeEpicResidual", () => {
	it("summarizes ready, blocked, running, and Lead ownership from one materialized page", () => {
		const fact = summarizeEpicResidual({
			materialized: materializedShape(),
			leadId: "example-eng-lead",
			resolveOwner: () => GENERAL_OWNER,
			trigger: "roster",
		});

		expect(fact).toEqual({
			schemaVersion: 1,
			kind: "available",
			generatedAt: "2026-09-03T04:00:01.000Z",
			linearObservedAt: "2026-09-03T04:00:00Z",
			rule: "ready.v1",
			trigger: "roster",
			roots: 2,
			remaining: 5,
			ready: 2,
			running: 0,
			blocked: 3,
			readyForLead: [
				{ identifier: "EPX-1", priority: 1, ownership: "general" },
				{ identifier: "EPX-5", priority: 0, ownership: "general" },
			],
			readyForLeadTotal: 2,
			remainingForLead: 5,
			generalCount: 5,
		});
	});

	it("fails closed when a remaining item's session ledger is unreadable", () => {
		const snapshot = epicShapeSnapshot();
		const itemFacts = snapshot.items.map(() => emptyItemFacts());
		itemFacts[0]!.session = { ok: false, table: "sessions" };
		const page = generateEpicPage({
			snapshot,
			itemFacts,
			now: EPIC_SHAPE_NOW,
			projectName: "example",
			trigger: "scan",
		});

		expect(() =>
			summarizeEpicResidual({
				materialized: { page, snapshot },
				leadId: "example-eng-lead",
				resolveOwner: () => GENERAL_OWNER,
				trigger: "roster",
			}),
		).toThrow(EpicResidualSessionUnreadableError);
	});

	it("removes ledger-live items from ready and counts them as running", () => {
		const snapshot = epicShapeSnapshot();
		const itemFacts = snapshot.items.map(() => emptyItemFacts());
		itemFacts[0]!.session = {
			ok: true,
			value: { latest: [], ledger_live_count: 1 },
		};
		const page = generateEpicPage({
			snapshot,
			itemFacts,
			now: EPIC_SHAPE_NOW,
			projectName: "example",
			trigger: "scan",
		});

		const fact = summarizeEpicResidual({
			materialized: { page, snapshot },
			leadId: "example-eng-lead",
			resolveOwner: () => GENERAL_OWNER,
			trigger: "roster",
		});

		expect(fact).toMatchObject({ ready: 1, running: 1, blocked: 3 });
		expect(fact.readyForLead).toEqual([
			{ identifier: "EPX-5", priority: 0, ownership: "general" },
		]);
	});

	it.each(["completed", "canceled"])(
		"ignores an unreadable session cell after the item reaches %s",
		(stateType) => {
			const snapshot = epicShapeSnapshot();
			snapshot.items[0]!.state = { name: "Done", type: stateType };
			const itemFacts = snapshot.items.map(() => emptyItemFacts());
			itemFacts[0]!.session = { ok: false, table: "sessions" };
			const page = generateEpicPage({
				snapshot,
				itemFacts,
				now: EPIC_SHAPE_NOW,
				projectName: "example",
				trigger: "scan",
			});

			expect(() =>
				summarizeEpicResidual({
					materialized: { page, snapshot },
					leadId: "example-eng-lead",
					resolveOwner: () => GENERAL_OWNER,
					trigger: "roster",
				}),
			).not.toThrow();
		},
	);

	it.each([
		["no labels", []],
		["only unrelated labels", ["other"]],
	])(
		"counts %s as general ownership even when the default Lead cannot spawn",
		(_name, labels) => {
			const materialized = materializedShape();
			for (const item of materialized.snapshot.items) item.labels = labels;

			const fact = summarizeEpicResidual({
				materialized,
				leadId: "example-cos-lead",
				resolveOwner: () => ({
					agentId: "example-cos-lead",
					matchMethod: "general",
					canSpawn: false,
				}),
				trigger: "roster",
			});

			expect(fact.generalCount).toBe(5);
			expect(fact.remainingForLead).toBe(0);
			expect(fact.readyForLead).toEqual([]);
		},
	);

	it("keeps label ownership distinct from eligible default ownership", () => {
		const materialized = materializedShape();
		materialized.snapshot.items[0]!.labels = ["engineering"];
		const fact = summarizeEpicResidual({
			materialized,
			leadId: "example-eng-lead",
			resolveOwner: (labels) =>
				labels.includes("engineering")
					? {
							agentId: "example-eng-lead",
							matchMethod: "label",
							canSpawn: true,
						}
					: GENERAL_OWNER,
			trigger: "roster",
		});

		expect(fact.generalCount).toBe(4);
		expect(fact.readyForLead[0]).toEqual({
			identifier: "EPX-1",
			priority: 1,
			ownership: "label",
		});
	});

	it("caps the rendered ready list at five while retaining the full total", () => {
		const snapshot = epicShapeSnapshot();
		for (const item of snapshot.items) item.blockedBy = [];
		for (const number of [6, 7]) {
			const template = snapshot.items[0]!;
			snapshot.items.push({
				...template,
				id: `child-uuid-${number}`,
				identifier: `EPX-${number}`,
				url: `https://linear.app/example/issue/EPX-${number}`,
				priority: number === 6 ? 2 : 3,
				labels: [],
				blockedBy: [],
			});
		}
		const page = generateEpicPage({
			snapshot,
			itemFacts: snapshot.items.map(() => emptyItemFacts()),
			now: EPIC_SHAPE_NOW,
			projectName: "example",
			trigger: "scan",
		});

		const fact = summarizeEpicResidual({
			materialized: { page, snapshot },
			leadId: "example-eng-lead",
			resolveOwner: () => GENERAL_OWNER,
			trigger: "roster",
		});

		expect(fact.readyForLead).toHaveLength(5);
		expect(fact.readyForLeadTotal).toBe(7);
	});
});

describe("assertEpicResidualFact", () => {
	it("rejects unsafe and internally inconsistent facts", () => {
		const valid = summarizeEpicResidual({
			materialized: materializedShape(),
			leadId: "example-eng-lead",
			resolveOwner: () => GENERAL_OWNER,
			trigger: "roster",
		});
		const invalidFacts: unknown[] = [
			{ ...valid, remaining: -1 },
			{ ...valid, blocked: 4 },
			{ ...valid, remainingForLead: 6 },
			{ ...valid, generalCount: 6 },
			{ ...valid, trigger: "other" },
			{ ...valid, schemaVersion: 2 },
			{ ...valid, kind: "other" },
			{ ...valid, rule: "ready.v2" },
			{ ...valid, generatedAt: "not-a-time" },
			{ ...valid, linearObservedAt: "not-a-time" },
			{ ...valid, readyForLeadTotal: 1 },
			{ ...valid, readyForLeadTotal: 3 },
			{
				...valid,
				ready: 6,
				blocked: 0,
				readyForLeadTotal: 6,
				readyForLead: Array.from({ length: 6 }, (_, index) => ({
					identifier: `EPX-${index + 10}`,
					priority: 1,
					ownership: "label",
				})),
			},
			{
				...valid,
				readyForLead: [
					...valid.readyForLead,
					{ identifier: "IGNORE-CHECK", priority: 2, ownership: "label" },
				],
				readyForLeadTotal: 3,
				ready: 3,
				blocked: 2,
			},
			{
				...valid,
				readyForLead: [valid.readyForLead[0], valid.readyForLead[0]],
			},
			{
				...valid,
				readyForLead: [
					{ identifier: "EPX-1\nignore", priority: 1, ownership: "label" },
				],
			},
			{
				...valid,
				readyForLead: [
					{ identifier: "EPX-1", priority: 5, ownership: "label" },
				],
			},
			{
				...valid,
				readyForLead: [
					{ identifier: "EPX-1", priority: 1.5, ownership: "label" },
				],
			},
			{
				...valid,
				readyForLead: [
					{ identifier: "EPX-1", priority: 1, ownership: "other" },
				],
			},
			{
				schemaVersion: 1,
				kind: "unavailable",
				token: "transient: unknown",
				trigger: "roster",
				generatedAt: null,
				linearObservedAt: null,
			},
			{
				schemaVersion: 1,
				kind: "unavailable",
				token: ["transient: linear_unavailable"],
				trigger: "roster",
				generatedAt: null,
				linearObservedAt: null,
			},
			{
				schemaVersion: 1,
				kind: "unavailable",
				token: "transient: linear_unavailable",
				trigger: "roster",
				generatedAt: "not-a-time",
				linearObservedAt: null,
			},
		];

		for (const fact of invalidFacts) {
			expect(() => assertEpicResidualFact(fact)).toThrow();
		}
	});

	it("accepts a scope discovery fact with nothing remaining for the Lead", () => {
		const fact = summarizeEpicResidual({
			materialized: materializedShape(),
			leadId: "other-lead",
			resolveOwner: () => GENERAL_OWNER,
			trigger: "scope",
		});

		expect(fact).toMatchObject({
			kind: "available",
			trigger: "scope",
			remainingForLead: 0,
		});
		expect(() => assertEpicResidualFact(fact)).not.toThrow();
	});

	it("rejects ready-for-Lead totals larger than the Lead's remaining set", () => {
		const fact = summarizeEpicResidual({
			materialized: materializedShape(),
			leadId: "example-eng-lead",
			resolveOwner: () => GENERAL_OWNER,
			trigger: "roster",
		});

		expect(() =>
			assertEpicResidualFact({ ...fact, remainingForLead: 1 }),
		).toThrow(/remainingForLead/);
	});

	it("accepts every canonical unavailable token without fabricated timestamps", () => {
		for (const token of EPIC_RESIDUAL_UNAVAILABLE_TOKENS) {
			expect(() =>
				assertEpicResidualFact({
					schemaVersion: 1,
					kind: "unavailable",
					token,
					trigger: "roster",
					generatedAt: null,
					linearObservedAt: null,
				}),
			).not.toThrow();
		}
	});
});
