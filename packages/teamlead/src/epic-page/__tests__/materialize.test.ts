import { describe, expect, it, vi } from "vitest";
import { ActiveScopeNotFoundError } from "../../bridge/linear-epic-query.js";
import { generateAttentionEpicPage, generateEpicPage } from "../generate.js";
import { materializeEpicPage } from "../materialize.js";
import {
	hostedBundleBytes,
	renderEpicPageBudgetBundle,
} from "../optional-budget.js";
import { buildEpicPageRenderReceipt } from "../receipt.js";
import { attentionFixture, candidate } from "./fixtures/attention.js";
import {
	EPIC_SHAPE_NOW,
	emptyItemFacts,
	epicShapeSnapshot,
} from "./fixtures/epic-shape.js";

describe("FLY-2143 Epic page materialization inputs", () => {
	it("budgets the complete hardened hosted HTML without losing Epic items", async () => {
		const attention = attentionFixture();
		attention.candidates = Array.from({ length: 200 }, (_, i) => {
			const row = candidate(
				i + 1000,
				"founder_gate",
				"statestore",
				"workflow_gate_holder",
			);
			row.title.value = "<&>".repeat(600);
			return row;
		});
		attention.reads.gates.value = { count: 200 };
		attention.reads.questions.value = { count: 0 };
		attention.reads.founder_review.value = { count: 0 };
		const result = await materializeEpicPage(
			{
				fetchSnapshot: async () => epicShapeSnapshot(),
				readAttention: async () => attention,
				readLeadNotes: () => [],
				readItemFacts: () => emptyItemFacts(),
				readSignals: () =>
					generateEpicPage({
						snapshot: epicShapeSnapshot(),
						itemFacts: epicShapeSnapshot().items.map(() => emptyItemFacts()),
						projectName: "example",
						now: EPIC_SHAPE_NOW,
						trigger: "manual",
					}).items.map((item) => ({
						signals: item.signals,
						signal_sources: item.signal_sources,
					})),
				readFreshness: () => ({}),
				generatePage: generateAttentionEpicPage,
				buildReceipt: buildEpicPageRenderReceipt,
				now: () => new Date("2026-09-09T12:00:00Z"),
			},
			{
				projectName: "example",
				binding: { team: "EPX" },
				apiKey: "test",
				trigger: "manual",
				version: 1,
				reasons: ["manual"],
			},
		);
		expect(result.page.items).toHaveLength(epicShapeSnapshot().items.length);
		expect(
			hostedBundleBytes(
				renderEpicPageBudgetBundle(
					result.page,
					new Date(result.page.generated_at),
				),
			),
		).toBeLessThanOrEqual(512 * 1024);
		expect(result.page.attention_sources.budget.missing?.reason).toBe(
			"source_truncated",
		);
	});
	it.each(["no_active_roots", "missing_daily_root"] as const)(
		"preserves independent attention with %s",
		async (reason) => {
			const readAttention = vi.fn(async () => attentionFixture());
			const readItemFacts = vi.fn();
			const result = await materializeEpicPage(
				{
					fetchSnapshot: async () => {
						throw new ActiveScopeNotFoundError("missing", reason);
					},
					readAttention,
					readLeadNotes: () => [],
					readItemFacts,
					readSignals: () => [],
					readFreshness: () => ({}),
					generatePage: generateAttentionEpicPage,
					buildReceipt: buildEpicPageRenderReceipt,
					now: () => new Date("2026-09-09T12:00:00Z"),
				},
				{
					projectName: "example",
					binding: { team: "EPX" },
					apiKey: "test",
					trigger: "manual",
					version: 1,
					reasons: ["manual"],
				},
			);
			expect(result.snapshot).toBeNull();
			expect(result.page).toMatchObject({
				schema_version: 2,
				epic_scope: {
					value: null,
					missing: { reason: "epic_scope_unavailable" },
				},
			});
			expect(result.page.attention).toHaveLength(3);
			expect(readItemFacts).not.toHaveBeenCalled();
			expect(readAttention).toHaveBeenCalledOnce();
		},
	);
	it.each(["example", "flywheel"])(
		"injects signals, freshness and local history for %s",
		async (projectName) => {
			const snapshot = epicShapeSnapshot();
			const readSignals = vi.fn((_projectName, items) =>
				items.map((_item: unknown, index: number) => ({
					signals:
						index === 0
							? [
									{
										kind: "declared_blocked" as const,
										since: "2026-09-03T03:45:00.000Z",
										execution_id8: "exec-one",
										provenance: {
											kind: "statestore" as const,
											table: "sessions",
											key: { execution_id: "exec-one-full" },
										},
										observed_at: EPIC_SHAPE_NOW.toISOString(),
									},
								]
							: [],
					signal_sources: {
						statestore: {
							value: { signals: index === 0 ? 1 : 0 },
							provenance: {
								kind: "statestore" as const,
								table: "sessions",
								key: { issue_id: snapshot.items[index]!.id },
							},
							observed_at: EPIC_SHAPE_NOW.toISOString(),
						},
						commdb: {
							value: { signals: 0 },
							provenance: {
								kind: "commdb" as const,
								table: "mailbox",
								key: { issue_identifier: snapshot.items[index]!.identifier },
							},
							observed_at: EPIC_SHAPE_NOW.toISOString(),
						},
					},
				})),
			);
			const readFreshness = vi.fn(() => ({
				history: {
					last_generated: {
						version: 8,
						attempted_at: "2026-09-03T03:30:00.000Z",
						trigger: "scan" as const,
					},
					publish_failures_since_last_published: 1,
				},
			}));
			const readLeadNotes = vi.fn(() => [
				{
					issue_uuid: snapshot.roots[0]!.id,
					role: "engineering",
					text: "判断",
					written_at: "2026-09-01T12:00:00.000Z",
				},
			]);

			const history = {
				rows: [],
				total: 0,
				url: null,
				publishedAsOf: null,
				error: null,
				dirty: false,
				readError: false,
			};
			const readShipJudgmentHistory = vi.fn(() => history);
			const result = await materializeEpicPage(
				{
					fetchSnapshot: vi.fn(async () => snapshot),
					readItemFacts: () => emptyItemFacts(),
					readSignals,
					readFreshness,
					readLeadNotes,
					readShipJudgmentHistory,
					generatePage: generateAttentionEpicPage,
					readAttention: async () => attentionFixture(),
					buildReceipt: buildEpicPageRenderReceipt,
					now: () => EPIC_SHAPE_NOW,
				},
				{
					projectName,
					binding: { team: "EPX", project: "Example" },
					apiKey: "linear-key",
					trigger: "event",
					version: 9,
					leadNoteFadeDays: 2.5,
					reasons: ["session_completed"],
				},
			);

			if (projectName === "flywheel") {
				expect(readShipJudgmentHistory).toHaveBeenCalledExactlyOnceWith(
					EPIC_SHAPE_NOW.toISOString(),
				);
				expect(result.page.ship_judgment_history?.value).toEqual(history);
			} else {
				expect(readShipJudgmentHistory).not.toHaveBeenCalled();
				expect(result.page.ship_judgment_history).toBeUndefined();
			}
			expect(readSignals).toHaveBeenCalledWith(
				projectName,
				snapshot.items.map((item) => ({
					uuid: item.id,
					identifier: item.identifier,
				})),
				EPIC_SHAPE_NOW,
			);
			expect(readFreshness).toHaveBeenCalledWith(projectName);
			expect(readLeadNotes).toHaveBeenCalledExactlyOnceWith(projectName, [
				...new Set(
					[...snapshot.roots, ...snapshot.items].map((item) => item.id),
				),
			]);
			expect(result.page.header.roots.value![0]!.lead_note?.[0]?.value).toBe(
				"判断",
			);
			expect(result.page.lead_note_policy?.value).toEqual({
				fade_after_days: 2.5,
			});
			expect(result.page.freshness.current.value).toEqual({
				version: 9,
				trigger: "event",
				reasons: ["session_completed"],
			});
			expect(result.page.items[0]?.signals[0]?.kind).toBe("declared_blocked");
			expect(result.receipt.reasons).toEqual(["session_completed"]);
		},
	);
});

it("budgets the hosted representation for full notes and judgment history without dropping Epic tasks", async () => {
	const { pageForShipJudgmentAttentionBudget } = await import(
		"./fixtures/founder-budget.js"
	);
	const candidate = await pageForShipJudgmentAttentionBudget(60);
	const { renderEpicPageBudgetBundle, hostedBundleBytes } = await import(
		"../optional-budget.js"
	);
	const result = await materializeEpicPage(
		{
			fetchSnapshot: async () => epicShapeSnapshot(),
			readAttention: async () => attentionFixture(),
			readLeadNotes: () => [],
			readItemFacts: () => emptyItemFacts(),
			readSignals: () => [],
			readFreshness: () => ({}),
			generatePage: () => candidate,
			buildReceipt: buildEpicPageRenderReceipt,
			now: () => EPIC_SHAPE_NOW,
		},
		{
			projectName: "flywheel",
			binding: { team: "EPX" },
			apiKey: "fixture",
			trigger: "manual",
			version: 1,
			reasons: ["manual"],
		},
	);
	expect(result.page.items).toHaveLength(60);
	expect(result.page.header.roots.value).toHaveLength(8);
	expect(
		hostedBundleBytes(renderEpicPageBudgetBundle(result.page, EPIC_SHAPE_NOW)),
	).toBeLessThanOrEqual(524288);
}, 15_000);

it("materializes child thread bindings with the same generation timestamp", async () => {
	const snapshot = epicShapeSnapshot();
	const readChildThreads = vi.fn(
		() =>
			new Map([
				[
					snapshot.items[0]!.id,
					{
						value: "https://discord.com/channels/123/456",
						observed_at: EPIC_SHAPE_NOW.toISOString(),
						provenance: {
							kind: "statestore" as const,
							table: "chat_threads",
							key: { issue_id: snapshot.items[0]!.id },
						},
					},
				],
			]),
	);
	const deps = {
		fetchSnapshot: async () => snapshot,
		readAttention: async () => attentionFixture(),
		readLeadNotes: () => [],
		readChildThreads,
		readItemFacts: () => emptyItemFacts(),
		readSignals: () =>
			generateEpicPage({
				snapshot,
				itemFacts: snapshot.items.map(() => emptyItemFacts()),
				projectName: "example",
				now: EPIC_SHAPE_NOW,
				trigger: "manual",
			}).items.map(({ signals, signal_sources }) => ({
				signals,
				signal_sources,
			})),
		readFreshness: () => ({}),
		generatePage: generateAttentionEpicPage,
		buildReceipt: buildEpicPageRenderReceipt,
		now: () => EPIC_SHAPE_NOW,
	};
	const result = await materializeEpicPage(deps, {
		projectName: "example",
		binding: { team: "EPX" },
		apiKey: "test",
		trigger: "manual",
		version: 1,
		reasons: ["manual"],
	});
	expect(readChildThreads).toHaveBeenCalledWith(
		"example",
		snapshot.items,
		EPIC_SHAPE_NOW,
	);
	expect(result.page.items[0]!.thread_url?.value).toBe(
		"https://discord.com/channels/123/456",
	);
});
