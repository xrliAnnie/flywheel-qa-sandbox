import { describe, expect, it } from "vitest";
import {
	BATCH_STATUS_VIEW,
	BATCH_STATUSES,
	type BatchJournal,
	buildBatchProgress,
	KEY_STATUS_VIEW,
	KEY_STATUSES,
} from "../bridge/fleet-progress.js";

describe("fleet-progress — exhaustive enum mappings (R8 #3)", () => {
	it("every BatchStatus has a view (no unmapped member)", () => {
		for (const s of BATCH_STATUSES) {
			expect(BATCH_STATUS_VIEW[s], `BatchStatus ${s}`).toBeDefined();
			expect(typeof BATCH_STATUS_VIEW[s].label).toBe("string");
		}
		// No EXTRA keys beyond the enum.
		expect(Object.keys(BATCH_STATUS_VIEW).sort()).toEqual(
			[...BATCH_STATUSES].sort(),
		);
	});

	it("every KeyStatus has a view (no unmapped member)", () => {
		for (const s of KEY_STATUSES) {
			expect(KEY_STATUS_VIEW[s], `KeyStatus ${s}`).toBeDefined();
			expect(KEY_STATUS_VIEW[s].rank).toBeGreaterThanOrEqual(0);
			expect(KEY_STATUS_VIEW[s].rank).toBeLessThanOrEqual(5);
		}
		expect(Object.keys(KEY_STATUS_VIEW).sort()).toEqual(
			[...KEY_STATUSES].sort(),
		);
	});

	it("terminal batch statuses are exactly applied/partial/failed/rejected/recover", () => {
		const terminal = BATCH_STATUSES.filter(
			(s) => BATCH_STATUS_VIEW[s].terminal,
		).sort();
		expect(terminal).toEqual(
			[
				"applied",
				"failed",
				"partially-applied",
				"recover-required",
				"rejected",
			].sort(),
		);
	});

	it("manual-intervention/config-restore-conflict never claim 'kept as-is'", () => {
		expect(KEY_STATUS_VIEW["manual-intervention"].manual).toBe(true);
		expect(KEY_STATUS_VIEW["config-restore-conflict"].manual).toBe(true);
		expect(KEY_STATUS_VIEW["manual-intervention"].label).not.toContain(
			"保原状",
		);
		expect(KEY_STATUS_VIEW["config-restore-conflict"].label).not.toContain(
			"保原状",
		);
		// failed-restored IS the honest "kept as-is" terminal.
		expect(KEY_STATUS_VIEW["failed-restored"].label).toContain("保原状");
	});

	it("ranks advance monotonically along the happy path", () => {
		const r = (s: keyof typeof KEY_STATUS_VIEW) => KEY_STATUS_VIEW[s].rank;
		expect(r("pending")).toBeLessThan(r("config-writing"));
		expect(r("config-writing")).toBeLessThan(r("config-written"));
		expect(r("config-written")).toBeLessThanOrEqual(r("applying"));
		expect(r("applying")).toBeLessThan(r("applied"));
	});
});

describe("fleet-progress — buildBatchProgress", () => {
	const journal: BatchJournal = {
		batchId: "b-1",
		batchStatus: "partially-applied",
		owner: { pid: 1234, created: 100 },
		keys: {
			"geo-peter": {
				from: { model: "claude-fable-5" },
				to: { model: null },
				status: "applied",
			},
			"geo-oliver": {
				from: { model: null },
				to: { model: "claude-fable-5" },
				status: "config-restore-conflict",
			},
		},
	};

	it("maps the batch + per-key views, preserving from/to", () => {
		const p = buildBatchProgress(journal);
		expect(p.batchStatus).toBe("partially-applied");
		expect(p.batchLabel).toBe("部分完成");
		expect(p.terminal).toBe(true);
		const peter = p.keys.find((k) => k.key === "geo-peter");
		expect(peter?.from).toBe("claude-fable-5");
		expect(peter?.to).toBe(null);
		expect(peter?.rank).toBe(5);
		expect(peter?.terminal).toBe(true);
		const oliver = p.keys.find((k) => k.key === "geo-oliver");
		expect(oliver?.manual).toBe(true);
	});

	it("does not throw on an unknown status (loud fallback)", () => {
		const bad = {
			...journal,
			batchStatus: "bogus" as BatchJournal["batchStatus"],
			keys: {
				k: {
					from: { model: null },
					to: { model: null },
					status: "bogus" as never,
				},
			},
		};
		const p = buildBatchProgress(bad);
		expect(p.batchLabel).toContain("未知");
		expect(p.keys[0].manual).toBe(true);
	});
});
