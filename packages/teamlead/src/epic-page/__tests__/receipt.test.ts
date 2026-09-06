import { describe, expect, it } from "vitest";
import type { EpicPage } from "../model.js";
import {
	assertEpicPageRenderReceipt,
	buildEpicPageRenderReceipt,
} from "../receipt.js";

const NOW = "2026-09-03T04:00:00Z";

describe("Epic page render receipt liveness sources", () => {
	it("records reasons and signal nodes from both source stores", () => {
		const page = {
			key: { project_name: "example" },
			generated_at: NOW,
			generator: {
				version: "epic-page/1",
				trigger: "event",
				reasons: ["session_completed"],
			},
			items: [
				{
					signals: [
						{
							kind: "runner_stopped",
							reason: "quota",
							since: NOW,
							execution_id8: "exec-a",
							provenance: {
								kind: "commdb",
								table: "questions",
								key: { execution_id: "exec-a-long" },
							},
							observed_at: NOW,
						},
						{
							kind: "declared_blocked",
							since: NOW,
							execution_id8: "exec-b",
							provenance: {
								kind: "statestore",
								table: "sessions",
								key: { execution_id: "exec-b-long" },
							},
							observed_at: NOW,
						},
					],
				},
			],
		} as unknown as EpicPage;

		const receipt = buildEpicPageRenderReceipt(page);
		expect(receipt.reasons).toEqual(["session_completed"]);
		expect(receipt.sources.map((source) => source.path)).toEqual([
			"/items/0/signals/0",
			"/items/0/signals/1",
		]);
		expect(receipt.sources[0]?.provenance.kind).toBe("commdb");
	});

	it("rejects absent, duplicate, unknown, and unsorted reasons", () => {
		const base = {
			schema_version: 1,
			project_name: "example",
			generated_at: NOW,
			trigger: "event",
			reasons: ["dependency_changed", "session_completed"],
			sources: [],
		};
		expect(() => assertEpicPageRenderReceipt(base)).not.toThrow();
		for (const reasons of [
			[],
			["session_completed", "session_completed"],
			["unknown"],
			["session_completed", "dependency_changed"],
		]) {
			expect(() => assertEpicPageRenderReceipt({ ...base, reasons })).toThrow();
		}
	});
});
