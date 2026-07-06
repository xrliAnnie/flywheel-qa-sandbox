/**
 * FLY-286 PR-3: `flywheel-comm xhs-analysis` CLI integration tests.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { xhsAnalysis } from "../commands/xhs-analysis.js";
import { xhsState } from "../commands/xhs-state.js";
import {
	createLocalAnalysisStore,
	createLocalFeedbackStore,
	type XiaohongshuAnalysisRun,
} from "../xiaohongshu-analysis-store.js";
import { readLocator } from "../xiaohongshu-review-locator.js";

const P = "flywheel";
const C = "c1";
const RK = "run-key-1";
let dir: string;
let out: string[];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "xhs-an-"));
	out = [];
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
		out.push(String(chunk));
		return true;
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

function lastJson(): any {
	return JSON.parse(out.filter((s) => s.trim()).pop() ?? "null");
}
function runFile(overrides: Partial<XiaohongshuAnalysisRun> = {}): string {
	const run: XiaohongshuAnalysisRun = {
		schemaVersion: 1,
		runToken: "run-1",
		execId: "e1",
		project: P,
		collectionId: C,
		collectionLabel: "claude",
		generatedAt: "2026-06-17T00:00:00Z",
		sourceWindow: { fetched: 1, total: 1, capped: false },
		posts: [
			{
				noteId: "n1",
				title: "t",
				url: "https://www.xiaohongshu.com/explore/n1",
				mediaKinds: ["text"],
				summary: "s",
				judgment: { useful: true, reason: "r" },
				status: "candidate",
			},
		],
		summary: { analyzed: 1, created: 0, candidates: 1, skipped: 0 },
		review: null,
		...overrides,
	};
	const f = join(dir, "run.json");
	writeFileSync(f, JSON.stringify(run));
	return f;
}
async function an(...args: string[]): Promise<number> {
	out = [];
	return xhsAnalysis([args[0], "--state-dir", dir, ...args.slice(1)]);
}
async function acquireLease(owner = RK): Promise<void> {
	await xhsState([
		"acquire-lease",
		"--project",
		P,
		"--collection",
		C,
		"--state-dir",
		dir,
		"--owner",
		owner,
	]);
}
/** Run a CLI expected to fail() → process.exit(2). */
async function expectExit2(fn: () => Promise<number>): Promise<void> {
	const spy = vi.spyOn(process, "exit").mockImplementation(((c?: number) => {
		throw new Error(`exit:${c}`);
	}) as never);
	await expect(fn()).rejects.toThrow("exit:2");
	spy.mockRestore();
}

describe("xhs-analysis write-run", () => {
	it("persists a valid run", async () => {
		expect(await an("write-run", "--file", runFile())).toBe(0);
		expect(lastJson().ok).toBe(true);
		expect(
			createLocalAnalysisStore(dir).readRun(P, C, "run-1")?.posts[0].noteId,
		).toBe("n1");
	});
	it("rejects a malformed run (bad status enum)", async () => {
		const f = join(dir, "bad.json");
		writeFileSync(
			f,
			JSON.stringify({
				schemaVersion: 1,
				runToken: "r",
				execId: "e",
				project: P,
				collectionId: C,
				collectionLabel: "x",
				generatedAt: "t",
				sourceWindow: { fetched: 0, total: 0, capped: false },
				posts: [
					{
						noteId: "n1",
						status: "bogus",
						mediaKinds: ["text"],
						judgment: { useful: true },
					},
				],
				summary: { analyzed: 0, created: 0, candidates: 0, skipped: 0 },
				review: null,
			}),
		);
		await expectExit2(() => an("write-run", "--file", f));
	});
});

describe("xhs-analysis deliver", () => {
	it("owner-fenced delivery: writes artifacts + state pointers + returns url", async () => {
		await acquireLease();
		expect(
			await an(
				"deliver",
				"--file",
				runFile(),
				"--owner",
				RK,
				"--base-url",
				"http://127.0.0.1:9876",
			),
		).toBe(0);
		const res = lastJson();
		expect(res.url).toBe(`http://127.0.0.1:9876/xhs-review/${res.reportToken}`);
		// locator resolves + state pointers updated + run marked delivered
		expect(readLocator(dir, res.reportToken)?.runToken).toBe("run-1");
		await xhsState([
			"read",
			"--project",
			P,
			"--collection",
			C,
			"--state-dir",
			dir,
		]);
		const st = lastJson();
		expect(st.lastReportToken).toBe(res.reportToken);
		expect(st.pendingFeedbackRunTokens).toContain("run-1");
	});
	it("stale owner → exit-equivalent reason, no URL", async () => {
		await acquireLease("other-owner");
		expect(
			await an(
				"deliver",
				"--file",
				runFile(),
				"--owner",
				RK,
				"--base-url",
				"http://127.0.0.1:9876",
			),
		).toBe(2);
		expect(lastJson().reason).toBe("not_lease_owner");
	});
});

describe("xhs-analysis read-feedback + mark-feedback-consumed", () => {
	beforeEach(async () => {
		await acquireLease();
		// seed feedback for run-1
		createLocalFeedbackStore(dir).writeFeedback(P, C, {
			schemaVersion: 1,
			runToken: "run-1",
			comments: [],
			actions: [
				{ noteId: "n1", action: "close_created", targetOpId: "op1", at: "t" },
			],
			consumedActions: [],
		});
	});
	it("read-feedback by --run-token", async () => {
		expect(
			await an(
				"read-feedback",
				"--project",
				P,
				"--collection",
				C,
				"--run-token",
				"run-1",
			),
		).toBe(0);
		expect(lastJson().actions[0].action).toBe("close_created");
	});
	it("read-feedback unknown report-token → null; malformed → exit 2", async () => {
		expect(await an("read-feedback", "--report-token", "nope")).toBe(0);
		expect(lastJson()).toBeNull();
		await expectExit2(() => an("read-feedback", "--report-token", "../escape"));
	});
	it("mark-feedback-consumed appends + dedups by opId; stale owner rejected", async () => {
		const mk = () =>
			an(
				"mark-feedback-consumed",
				"--project",
				P,
				"--collection",
				C,
				"--run-token",
				"run-1",
				"--op-id",
				"fb-op-1",
				"--result",
				"closed",
				"--owner",
				RK,
			);
		expect(await mk()).toBe(0);
		expect(await mk()).toBe(0); // retry → dedup
		const fb = createLocalFeedbackStore(dir).readFeedback(P, C, "run-1");
		expect(fb?.consumedActions).toHaveLength(1);
		expect(fb?.consumedActions[0].opId).toBe("fb-op-1");
		// stale owner → rejected
		expect(
			await an(
				"mark-feedback-consumed",
				"--project",
				P,
				"--collection",
				C,
				"--run-token",
				"run-1",
				"--op-id",
				"fb-op-2",
				"--result",
				"x",
				"--owner",
				"other",
			),
		).toBe(2);
	});
});

describe("xhs-analysis validation (codex code R1)", () => {
	it("write-run rejects an unsafe runToken (exit 2, controlled)", async () => {
		await expectExit2(() =>
			an("write-run", "--file", runFile({ runToken: "../bad" })),
		);
	});
	it("write-run rejects a non-numeric summary counter (exit 2, no coerce)", async () => {
		const f = join(dir, "bad-count.json");
		writeFileSync(
			f,
			JSON.stringify({
				schemaVersion: 1,
				runToken: "run-x",
				execId: "e",
				project: P,
				collectionId: C,
				collectionLabel: "x",
				generatedAt: "t",
				sourceWindow: { fetched: 0, total: 0, capped: false },
				posts: [],
				summary: { analyzed: "bad", created: 0, candidates: 0, skipped: 0 },
				review: null,
			}),
		);
		await expectExit2(() => an("write-run", "--file", f));
	});
	it("deliver rejects a non-http(s) base URL BEFORE the lock (exit 2)", async () => {
		await acquireLease();
		await expectExit2(() =>
			an(
				"deliver",
				"--file",
				runFile(),
				"--owner",
				RK,
				"--base-url",
				"ftp://x",
			),
		);
	});
	it("read-feedback rejects an unsafe explicit --run-token (exit 2)", async () => {
		await expectExit2(() =>
			an(
				"read-feedback",
				"--project",
				P,
				"--collection",
				C,
				"--run-token",
				"../bad",
			),
		);
	});
});
