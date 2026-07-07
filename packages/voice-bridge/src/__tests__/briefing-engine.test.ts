/**
 * FLY-967 P4 — BriefingEngine: pre-generated, cached meeting briefing so
 * /live opens with zero founder priming and zero wait (compose = memory-only).
 * Covers: 4-section template + truncation, topic promotion, atomic cache
 * write/read, refresh-failure-keeps-old, staleness, docs mtime re-read, and
 * docs[] path-traversal fail-fast.
 */
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BriefingEngine,
	type BriefingEngineOptions,
	type IssuesPage,
} from "../assistant/BriefingEngine.js";

const T0 = new Date("2026-07-07T15:00:00");

function boardPage(): IssuesPage {
	return {
		issues: [
			{
				identifier: "FLY-967",
				title: "纯 Gemini Live 语音助理",
				state: "In Progress",
				updatedAt: "2026-07-07T10:00:00.000Z",
			},
			{
				identifier: "FLY-545",
				title: "Huddle 模式 B",
				state: "In Progress",
				updatedAt: "2026-07-07T09:00:00.000Z",
			},
			{
				identifier: "FLY-954",
				title: "provision sandbox escape",
				state: "In Review",
				updatedAt: "2026-07-06T09:00:00.000Z",
			},
			{
				identifier: "FLY-546",
				title: "语音批准第三信号源",
				state: "Todo",
				updatedAt: "2026-07-05T09:00:00.000Z",
			},
		],
		truncated: false,
	};
}

function donePage(over: Partial<IssuesPage> = {}): IssuesPage {
	return {
		issues: [
			{
				identifier: "FLY-880",
				title: "对内 PM agent build",
				state: "Done",
				updatedAt: "2026-07-05T00:00:00.000Z", // 2 天前 → 在窗内
			},
			{
				identifier: "FLY-100",
				title: "很久以前的决策",
				state: "Done",
				updatedAt: "2026-06-01T00:00:00.000Z", // >14 天 → 滤掉
			},
		],
		truncated: false,
		...over,
	};
}

describe("BriefingEngine (FLY-967 P4)", () => {
	let root: string;
	let cachePath: string;
	let fetchIssues: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		root = mkdtempSync(join(tmpdir(), "fly967-brief-"));
		mkdirSync(join(root, "product"), { recursive: true });
		writeFileSync(join(root, "product", "prd.md"), "PRD 第一要点:零科普开会。");
		cachePath = join(root, "voice-briefing-flywheel.cache.json");
		fetchIssues = vi.fn(async (p: { states: string[] }) =>
			p.states.includes("completed") ? donePage() : boardPage(),
		);
	});

	afterEach(() => {
		vi.useRealTimers();
		rmSync(root, { recursive: true, force: true });
	});

	function makeEngine(over: Partial<BriefingEngineOptions> = {}) {
		return new BriefingEngine({
			projectName: "flywheel",
			projectRoot: root,
			cachePath,
			config: {
				refreshSec: 600,
				maxAgeSec: 1800,
				charBudget: 8000,
				docs: ["product/prd.md"],
			},
			fetchIssues:
				fetchIssues as unknown as BriefingEngineOptions["fetchIssues"],
			...over,
		});
	}

	it("start → refresh → compose builds header + four sections", async () => {
		const e = makeEngine();
		e.start();
		await vi.advanceTimersByTimeAsync(0); // settle the immediate refresh
		const r = e.compose();
		e.stop();
		expect(r.stale).toBe(false);
		expect(r.text).toContain("[简报生成时间 15:00]");
		// board grouped by state name
		expect(r.text).toContain("In Progress");
		expect(r.text).toContain("FLY-967 纯 Gemini Live 语音助理");
		expect(r.text).toContain("In Review");
		expect(r.text).toContain("Todo");
		// recent decisions: in-window item kept, >14d filtered
		expect(r.text).toContain("FLY-880");
		expect(r.text).not.toContain("FLY-100");
		// docs excerpt
		expect(r.text).toContain("prd.md");
		expect(r.text).toContain("零科普开会");
	});

	it("topic promotes case-insensitive hits into 相关 issue", async () => {
		const e = makeEngine();
		e.start();
		await vi.advanceTimersByTimeAsync(0);
		const r = e.compose("GEMINI");
		e.stop();
		const related = r.text.split("相关 issue")[1] ?? "";
		expect(related).toContain("FLY-967");
		expect(related).toContain("In Progress");
	});

	it("no topic (or zero hits) → no 相关 issue section", async () => {
		const e = makeEngine();
		e.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(e.compose().text).not.toContain("相关 issue");
		expect(e.compose("不存在的词").text).not.toContain("相关 issue");
		e.stop();
	});

	it("enforces per-section and total char budgets", async () => {
		const big = {
			issues: Array.from({ length: 80 }, (_, i) => ({
				identifier: `FLY-${i}`,
				title: `很长的标题——${"填充".repeat(30)}`,
				state: "In Progress",
				updatedAt: "2026-07-07T10:00:00.000Z",
			})),
			truncated: false,
		};
		fetchIssues.mockImplementation(async (p: { states: string[] }) =>
			p.states.includes("completed") ? donePage() : big,
		);
		const e = makeEngine({
			config: {
				refreshSec: 600,
				maxAgeSec: 1800,
				charBudget: 1000,
				docs: ["product/prd.md"],
			},
		});
		e.start();
		await vi.advanceTimersByTimeAsync(0);
		const r = e.compose();
		e.stop();
		expect(r.text.length).toBeLessThanOrEqual(1000);
		// board section individually capped at budget/4
		const boardSection = r.text.split("## Board 快照")[1]?.split("##")[0] ?? "";
		expect(boardSection.length).toBeLessThanOrEqual(250 + 4);
	});

	it("caps decisions at 15 and flags an incomplete list", async () => {
		const many = {
			issues: Array.from({ length: 20 }, (_, i) => ({
				identifier: `FLY-D${i}`,
				title: `决策 ${i}`,
				state: "Done",
				updatedAt: "2026-07-06T00:00:00.000Z",
			})),
			truncated: true,
		};
		fetchIssues.mockImplementation(async (p: { states: string[] }) =>
			p.states.includes("completed") ? many : boardPage(),
		);
		const e = makeEngine();
		e.start();
		await vi.advanceTimersByTimeAsync(0);
		const r = e.compose();
		e.stop();
		expect(r.text).toContain("FLY-D14");
		expect(r.text).not.toContain("FLY-D15");
		expect(r.text).toContain("决策列表可能不全");
	});

	it("writes the cache atomically; a fresh engine composes from cache with zero fetches", async () => {
		const e = makeEngine();
		e.start();
		await vi.advanceTimersByTimeAsync(0);
		e.stop();

		const neverFetch = vi.fn(async () => {
			throw new Error("must not be called before compose");
		});
		const e2 = makeEngine({
			fetchIssues:
				neverFetch as unknown as BriefingEngineOptions["fetchIssues"],
		});
		e2.loadCache(); // cache read only — no refresh kicked
		const r = e2.compose();
		expect(r.text).toContain("FLY-967 纯 Gemini Live 语音助理");
		expect(r.generatedAt).toBeTruthy();
		expect(neverFetch).not.toHaveBeenCalled();
	});

	it("a failing refresh keeps the previous snapshot and logs", async () => {
		const log = vi.fn();
		const e = makeEngine({ log });
		e.start();
		await vi.advanceTimersByTimeAsync(0);
		fetchIssues.mockRejectedValue(new Error("bridge down"));
		await vi.advanceTimersByTimeAsync(600_000); // next interval refresh fails
		const r = e.compose();
		e.stop();
		expect(r.text).toContain("FLY-967 纯 Gemini Live 语音助理"); // old snapshot survives
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("briefing refresh failed"),
		);
	});

	it("marks the briefing stale past maxAgeSec (meeting still opens)", async () => {
		const e = makeEngine();
		e.start();
		await vi.advanceTimersByTimeAsync(0);
		e.stop(); // no more refreshes
		vi.setSystemTime(new Date(T0.getTime() + 1801_000));
		const r = e.compose();
		expect(r.stale).toBe(true);
		expect(r.text).toContain("FLY-967"); // content still served
	});

	it("compose without any cache is explicit, not silent", () => {
		const e = makeEngine();
		const r = e.compose();
		expect(r.stale).toBe(true);
		expect(r.generatedAt).toBeNull();
		expect(r.text).toContain("简报不可用");
	});

	it("re-reads a doc only when its mtime changes", async () => {
		const e = makeEngine();
		e.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(e.docReadCount).toBe(1);
		await vi.advanceTimersByTimeAsync(600_000); // unchanged mtime → no re-read
		expect(e.docReadCount).toBe(1);
		const doc = join(root, "product", "prd.md");
		writeFileSync(doc, "PRD 改版:新的要点。");
		utimesSync(
			doc,
			new Date(T0.getTime() + 700_000),
			new Date(T0.getTime() + 700_000),
		);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(e.docReadCount).toBe(2);
		expect(e.compose().text).toContain("新的要点");
		e.stop();
	});

	it("rejects docs[] escaping projectRoot at construction (fail-fast)", () => {
		expect(() =>
			makeEngine({
				config: {
					refreshSec: 600,
					maxAgeSec: 1800,
					charBudget: 8000,
					docs: ["../../etc/passwd"],
				},
			}),
		).toThrow(/projectRoot/);
	});
});
