import { describe, expect, it, vi } from "vitest";
import { generateEpicPage } from "../generate.js";
import { materializeEpicPage } from "../materialize.js";
import { buildEpicPageRenderReceipt } from "../receipt.js";
import {
	EPIC_SHAPE_NOW,
	emptyItemFacts,
	epicShapeSnapshot,
} from "./fixtures/epic-shape.js";

describe("FLY-2143 Epic page materialization inputs", () => {
	it("injects signals, prior freshness, and the prospective version into one generation", async () => {
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

		const result = await materializeEpicPage(
			{
				fetchSnapshot: vi.fn(async () => snapshot),
				readItemFacts: () => emptyItemFacts(),
				readSignals,
				readFreshness,
				readLeadNotes,
				generatePage: generateEpicPage,
				buildReceipt: buildEpicPageRenderReceipt,
				now: () => EPIC_SHAPE_NOW,
			},
			{
				projectName: "example",
				binding: { team: "EPX", project: "Example" },
				apiKey: "linear-key",
				trigger: "event",
				version: 9,
				leadNoteFadeDays: 2.5,
				reasons: ["session_completed"],
			},
		);

		expect(readSignals).toHaveBeenCalledWith(
			"example",
			snapshot.items.map((item) => ({
				uuid: item.id,
				identifier: item.identifier,
			})),
			EPIC_SHAPE_NOW,
		);
		expect(readFreshness).toHaveBeenCalledWith("example");
		expect(readLeadNotes).toHaveBeenCalledExactlyOnceWith("example", [
			...new Set([...snapshot.roots, ...snapshot.items].map((item) => item.id)),
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
	});
});
