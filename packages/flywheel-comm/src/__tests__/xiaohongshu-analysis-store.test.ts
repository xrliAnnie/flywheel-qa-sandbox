/**
 * FLY-286: analysis + feedback store tests.
 */

import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createLocalAnalysisStore,
	createLocalFeedbackStore,
	DEFAULT_ANALYSIS_RETENTION,
	MAX_STORE_FILE_BYTES,
	XIAOHONGSHU_ANALYSIS_SCHEMA_VERSION,
	XIAOHONGSHU_FEEDBACK_SCHEMA_VERSION,
	type XiaohongshuAnalysisRun,
	type XiaohongshuFeedbackFile,
} from "../xiaohongshu-analysis-store.js";

const PROJECT = "flywheel";
const COLLECTION = "6884765b0000000023036a58";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "xhs-store-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function run(token: string, generatedAt: string): XiaohongshuAnalysisRun {
	return {
		schemaVersion: XIAOHONGSHU_ANALYSIS_SCHEMA_VERSION,
		runToken: token,
		execId: "exec-1",
		project: PROJECT,
		collectionId: COLLECTION,
		collectionLabel: "claude",
		generatedAt,
		sourceWindow: { fetched: 2, total: 2, capped: false },
		posts: [
			{
				noteId: "n1",
				title: "t1",
				url: "https://www.xiaohongshu.com/explore/n1",
				mediaKinds: ["text", "image"],
				summary: "s1",
				judgment: { useful: true, reason: "r1" },
				createdIssue: { issueId: "FLY-900", opId: "op1", state: "triage" },
				status: "created",
			},
		],
		summary: { analyzed: 1, created: 1, candidates: 0, skipped: 0 },
		review: { reportToken: "rep1" },
	};
}

describe("AnalysisStore (local fs)", () => {
	it("writeRun + readRun roundtrips", () => {
		const store = createLocalAnalysisStore(dir);
		store.writeRun(run("tok1", "2026-06-16T00:00:00Z"));
		const back = store.readRun(PROJECT, COLLECTION, "tok1");
		expect(back?.runToken).toBe("tok1");
		expect(back?.posts[0]?.createdIssue?.issueId).toBe("FLY-900");
		expect(back?.review?.reportToken).toBe("rep1");
	});

	it("readRun of a missing token returns null (not a throw)", () => {
		const store = createLocalAnalysisStore(dir);
		expect(store.readRun(PROJECT, COLLECTION, "nope")).toBeNull();
	});

	it("listRuns returns tokens; empty when none", () => {
		const store = createLocalAnalysisStore(dir);
		expect(store.listRuns(PROJECT, COLLECTION)).toEqual([]);
		store.writeRun(run("a", "2026-06-16T00:00:00Z"));
		store.writeRun(run("b", "2026-06-16T01:00:00Z"));
		expect(store.listRuns(PROJECT, COLLECTION).sort()).toEqual(["a", "b"]);
	});

	it("retention prunes the oldest beyond the cap", () => {
		const store = createLocalAnalysisStore(dir);
		const n = DEFAULT_ANALYSIS_RETENTION + 3;
		for (let i = 0; i < n; i++) {
			// zero-padded hour keeps lexicographic == chronological
			const at = `2026-06-16T${String(i).padStart(2, "0")}:00:00Z`;
			store.writeRun(run(`tok${String(i).padStart(2, "0")}`, at));
		}
		const remaining = store.listRuns(PROJECT, COLLECTION);
		expect(remaining.length).toBe(DEFAULT_ANALYSIS_RETENTION);
		// oldest (tok00) pruned, newest kept
		expect(remaining).not.toContain("tok00");
		expect(remaining).toContain(`tok${String(n - 1).padStart(2, "0")}`);
	});

	it("writes 0600 + atomically (no .tmp left)", () => {
		const store = createLocalAnalysisStore(dir);
		store.writeRun(run("m", "2026-06-16T00:00:00Z"));
		const file = join(dir, `${PROJECT}__${COLLECTION}`, "analysis", "m.json");
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(store.listRuns(PROJECT, COLLECTION)).toEqual(["m"]);
	});

	it("rejects an oversized file (loud, no silent truncation)", () => {
		const store = createLocalAnalysisStore(dir);
		const big = run("big", "2026-06-16T00:00:00Z");
		big.posts[0].summary = "x".repeat(MAX_STORE_FILE_BYTES + 1);
		expect(() => store.writeRun(big)).toThrow(/refusing to write/);
	});

	it("rejects an unsafe runToken / project segment", () => {
		const store = createLocalAnalysisStore(dir);
		expect(() => store.readRun(PROJECT, COLLECTION, "../escape")).toThrow(
			/unsafe runToken/,
		);
		expect(() => store.readRun("bad/proj", COLLECTION, "ok")).toThrow(
			/unsafe project/,
		);
	});

	it("throws on an unsupported schemaVersion on read", () => {
		const store = createLocalAnalysisStore(dir);
		store.writeRun(run("v", "2026-06-16T00:00:00Z"));
		const file = join(dir, `${PROJECT}__${COLLECTION}`, "analysis", "v.json");
		writeFileSync(
			file,
			JSON.stringify({ ...run("v", "x"), schemaVersion: 99 }),
		);
		expect(() => store.readRun(PROJECT, COLLECTION, "v")).toThrow(
			/unsupported analysis schemaVersion/,
		);
	});
});

describe("FeedbackStore (local fs)", () => {
	function fb(): XiaohongshuFeedbackFile {
		return {
			schemaVersion: XIAOHONGSHU_FEEDBACK_SCHEMA_VERSION,
			runToken: "tok1",
			comments: [{ noteId: "n1", text: "wrong direction", at: "t" }],
			actions: [
				{ noteId: "n1", action: "close_created", targetOpId: "op1", at: "t" },
			],
			consumedActions: [],
		};
	}

	it("writeFeedback + readFeedback roundtrips", () => {
		const store = createLocalFeedbackStore(dir);
		store.writeFeedback(PROJECT, COLLECTION, fb());
		const back = store.readFeedback(PROJECT, COLLECTION, "tok1");
		expect(back?.actions[0]?.action).toBe("close_created");
		expect(back?.comments[0]?.text).toBe("wrong direction");
	});

	it("readFeedback of a missing run returns null", () => {
		const store = createLocalFeedbackStore(dir);
		expect(store.readFeedback(PROJECT, COLLECTION, "nope")).toBeNull();
	});

	it("throws on an unsupported feedback schemaVersion on read", () => {
		const store = createLocalFeedbackStore(dir);
		store.writeFeedback(PROJECT, COLLECTION, fb());
		const file = join(
			dir,
			`${PROJECT}__${COLLECTION}`,
			"feedback",
			"tok1.json",
		);
		writeFileSync(file, JSON.stringify({ ...fb(), schemaVersion: 99 }));
		expect(() => store.readFeedback(PROJECT, COLLECTION, "tok1")).toThrow(
			/unsupported feedback schemaVersion/,
		);
	});
});

describe("store hardening (codex code-review R1)", () => {
	it("refuses to write through a symlinked collection dir (R1#2)", () => {
		// Pre-plant the collection dir as a symlink pointing outside the store.
		const outside = mkdtempSync(join(tmpdir(), "xhs-outside-"));
		try {
			symlinkSync(outside, join(dir, `${PROJECT}__${COLLECTION}`));
			const store = createLocalAnalysisStore(dir);
			expect(() => store.writeRun(run("t", "2026-06-16T00:00:00Z"))).toThrow(
				/symlink/,
			);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("refuses to READ an oversized file (R1#3, analysis + feedback)", () => {
		const aStore = createLocalAnalysisStore(dir);
		aStore.writeRun(run("big", "2026-06-16T00:00:00Z"));
		const aFile = join(
			dir,
			`${PROJECT}__${COLLECTION}`,
			"analysis",
			"big.json",
		);
		writeFileSync(aFile, "x".repeat(MAX_STORE_FILE_BYTES + 1));
		expect(() => aStore.readRun(PROJECT, COLLECTION, "big")).toThrow(
			/refusing to read/,
		);

		const fStore = createLocalFeedbackStore(dir);
		fStore.writeFeedback(PROJECT, COLLECTION, {
			schemaVersion: XIAOHONGSHU_FEEDBACK_SCHEMA_VERSION,
			runToken: "fbig",
			comments: [],
			actions: [],
			consumedActions: [],
		});
		const fFile = join(
			dir,
			`${PROJECT}__${COLLECTION}`,
			"feedback",
			"fbig.json",
		);
		writeFileSync(fFile, "y".repeat(MAX_STORE_FILE_BYTES + 1));
		expect(() => fStore.readFeedback(PROJECT, COLLECTION, "fbig")).toThrow(
			/refusing to read/,
		);
	});

	it("refuses to READ/LIST through a symlinked collection dir (R2#1)", () => {
		// First write real data, then replace the collection dir with a symlink
		// to an outside dir that contains a planted run file.
		const realStore = createLocalAnalysisStore(dir);
		realStore.writeRun(run("real", "2026-06-16T00:00:00Z"));
		const collPath = join(dir, `${PROJECT}__${COLLECTION}`);
		const outside = mkdtempSync(join(tmpdir(), "xhs-evil-"));
		try {
			rmSync(collPath, { recursive: true, force: true });
			// plant an analysis run file in the outside (symlink target) dir
			const aStore2 = createLocalAnalysisStore(outside);
			aStore2.writeRun(run("evil", "2026-06-16T00:00:00Z"));
			// outside now has <outside>/<proj__cid>/analysis/evil.json — point the
			// real store's collection dir name at outside/<proj__cid>
			symlinkSync(join(outside, `${PROJECT}__${COLLECTION}`), collPath);

			const store = createLocalAnalysisStore(dir);
			expect(() => store.readRun(PROJECT, COLLECTION, "evil")).toThrow(
				/symlink/,
			);
			expect(() => store.listRuns(PROJECT, COLLECTION)).toThrow(/symlink/);
			const fStore = createLocalFeedbackStore(dir);
			expect(() => fStore.readFeedback(PROJECT, COLLECTION, "evil")).toThrow(
				/symlink/,
			);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("is exported from the package (R1#1 reuse seam)", () => {
		const pkgPath = fileURLToPath(
			new URL("../../package.json", import.meta.url),
		);
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
			exports: Record<string, string>;
		};
		expect(pkg.exports["./xiaohongshu-analysis-store"]).toBe(
			"./dist/xiaohongshu-analysis-store.js",
		);
	});
});
