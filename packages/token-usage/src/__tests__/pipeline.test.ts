import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { aggregateAndPersist, dateRange, generateReport } from "../pipeline.js";
import { LocalSqliteUsageStore } from "../store/local-sqlite-store.js";
import type { DailyRow } from "../types.js";

function totalRow(day: string, tokens: number): DailyRow {
	return {
		day,
		scope: "total",
		dimKey: "",
		project: null,
		inputTokens: tokens,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: tokens,
		freshTokens: tokens,
		costMicroUsd: 0,
		isCompleted: null,
	};
}

function emptyBaseDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tu-empty-"));
}

describe("dateRange", () => {
	it("lists inclusive days", () => {
		expect(dateRange("2026-06-25", "2026-06-27")).toEqual([
			"2026-06-25",
			"2026-06-26",
			"2026-06-27",
		]);
		expect(dateRange("2026-06-26", "2026-06-26")).toEqual(["2026-06-26"]);
	});
});

describe("aggregateAndPersist rates seam (FLY-713 Codex R4)", () => {
	// A baseDir with one real CC jsonl assistant turn (1M opus input tokens),
	// under a /Dev/flywheel cwd so the classifier attributes it to the flywheel project.
	function baseDirWithOneOpusTurn(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-rates-"));
		const line = JSON.stringify({
			type: "assistant",
			timestamp: "2026-06-26T12:00:00Z",
			requestId: "req-rates-1",
			cwd: "/Users/test/Dev/flywheel",
			message: {
				model: "claude-opus-4-8",
				usage: {
					input_tokens: 1_000_000,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		});
		fs.writeFileSync(path.join(dir, "session.jsonl"), `${line}\n`);
		return dir;
	}

	function capturingStore() {
		const saved: DailyRow[] = [];
		return {
			saved,
			store: {
				replaceDaily: (_day: string, rows: DailyRow[]) => {
					saved.push(...rows);
					return Promise.resolve();
				},
				queryDaily: () => Promise.resolve([]),
			},
		};
	}

	it("persists cost from the configured rates table, not the defaults", async () => {
		const baseDir = baseDirWithOneOpusTurn();
		const cap = capturingStore();
		try {
			await aggregateAndPersist({
				baseDir,
				store: cap.store,
				since: "2026-06-26",
				until: "2026-06-26",
				timeZone: "UTC",
				rates: {
					"claude-opus-4-8": {
						input: 1,
						output: 1,
						cacheRead: 1,
						cacheWrite: 1,
					},
				},
			});
			const total = cap.saved.find((r) => r.scope === "total");
			// 1M input × $1/MTok = $1 = 1_000_000 micro (the configured rate, not the default $5).
			expect(total?.costMicroUsd).toBe(1_000_000);
		} finally {
			fs.rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("falls back to the default table when no rates are passed", async () => {
		const baseDir = baseDirWithOneOpusTurn();
		const cap = capturingStore();
		try {
			await aggregateAndPersist({
				baseDir,
				store: cap.store,
				since: "2026-06-26",
				until: "2026-06-26",
				timeZone: "UTC",
			});
			const total = cap.saved.find((r) => r.scope === "total");
			// Default opus-4-8 input rate is $5/MTok → 5_000_000 micro.
			expect(total?.costMicroUsd).toBe(5_000_000);
		} finally {
			fs.rmSync(baseDir, { recursive: true, force: true });
		}
	});
});

describe("aggregateAndPersist mid-run fallback (Codex R1)", () => {
	it("writes to localFallback when the primary store throws", async () => {
		const baseDir = emptyBaseDir(); // no jsonl → no records → empty-day replace
		const fallback = new LocalSqliteUsageStore(":memory:");
		const throwingPrimary = {
			replaceDaily: () => Promise.reject(new Error("supabase down mid-run")),
			queryDaily: () => Promise.resolve([]),
		};
		try {
			const { days, fallbackDays } = await aggregateAndPersist({
				baseDir,
				store: throwingPrimary,
				since: "2026-06-26",
				until: "2026-06-26",
				timeZone: "UTC",
				localFallback: fallback,
			});
			expect(days).toEqual(["2026-06-26"]);
			expect(fallbackDays).toEqual(["2026-06-26"]);
			expect(fallback.pendingDays()).toEqual(["2026-06-26"]);
		} finally {
			fallback.close();
			fs.rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("clears fallback pending when a later run writes the day to the primary (Codex R3)", async () => {
		const baseDir = emptyBaseDir();
		const fallback = new LocalSqliteUsageStore(":memory:");
		let failNext = true;
		const primary = {
			replaceDaily: () =>
				failNext ? Promise.reject(new Error("down")) : Promise.resolve(),
			queryDaily: () => Promise.resolve([]),
		};
		const args = {
			baseDir,
			store: primary,
			since: "2026-06-26",
			until: "2026-06-26",
			timeZone: "UTC",
			localFallback: fallback,
		};
		try {
			await aggregateAndPersist(args); // run 1: primary fails → pending
			expect(fallback.pendingDays()).toEqual(["2026-06-26"]);
			failNext = false;
			await aggregateAndPersist(args); // run 2: primary succeeds → pending cleared
			expect(fallback.pendingDays()).toEqual([]);
		} finally {
			fallback.close();
			fs.rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("report merges unsynced local-fallback days over the primary (Codex R2)", async () => {
		// primary (e.g. Supabase) is missing the report day; local fallback has it pending.
		const primary = {
			queryDaily: () => Promise.resolve([totalRow("2026-06-25", 800)]),
			replaceDaily: () => Promise.resolve(),
		};
		const fallback = new LocalSqliteUsageStore(":memory:");
		try {
			await fallback.replaceDaily("2026-06-26", [totalRow("2026-06-26", 500)]);
			const gen = await generateReport({
				store: primary,
				reportDay: "2026-06-26",
				trendSince: "2026-06-25",
				timeZone: "UTC",
				completedDbPath: "/nonexistent/teamlead.db",
				storeMode: "supabase",
				localFallback: fallback,
			});
			// report day 26 came from the local fallback, not the (missing) primary row
			expect(gen.model.total.tokens).toBe(500);
			expect(gen.model.warning).toContain("2026-06-26");
		} finally {
			fallback.close();
		}
	});

	it("rethrows when no fallback is provided", async () => {
		const baseDir = emptyBaseDir();
		const throwingPrimary = {
			replaceDaily: () => Promise.reject(new Error("boom")),
			queryDaily: () => Promise.resolve([]),
		};
		try {
			await expect(
				aggregateAndPersist({
					baseDir,
					store: throwingPrimary,
					since: "2026-06-26",
					until: "2026-06-26",
					timeZone: "UTC",
				}),
			).rejects.toThrow(/boom/);
		} finally {
			fs.rmSync(baseDir, { recursive: true, force: true });
		}
	});
});
