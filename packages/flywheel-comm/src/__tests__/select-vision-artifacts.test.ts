/**
 * GEO-151 A3 — selectVisionArtifacts tests.
 *
 * Covers AC5 (multi-scenario fixture matrix) + downgrade path + ranking +
 * WebM rejection + deterministic ordering.
 */

import { describe, expect, it } from "vitest";
import {
	type ArtifactFile,
	DEFAULT_PNG_LIMIT,
	estimateArtifactTokens,
	PNG_TOKEN_ESTIMATE,
	SUMMARY_TOKEN_ESTIMATE,
	selectVisionArtifacts,
} from "../select-vision-artifacts.js";

function summary(name = "SUMMARY.md"): ArtifactFile {
	return { path: `/screens/${name}`, bytes: 4096, kind: "summary" };
}

function png(
	idx: number,
	opts: { isError?: boolean; isKey?: boolean } = {},
): ArtifactFile {
	return {
		path: `/screens/step-${idx}.png`,
		bytes: 200_000,
		kind: "png",
		...opts,
	};
}

function webm(idx = 0): ArtifactFile {
	return {
		path: `/screens/session-${idx}.webm`,
		bytes: 5_000_000,
		kind: "webm",
	};
}

describe("selectVisionArtifacts (GEO-151 A3)", () => {
	describe("AC5 — happy path matrix", () => {
		it("under budget: SUMMARY + 3 PNG (default pngLimit)", () => {
			const files = [summary(), png(0), png(1), png(2), png(3), png(4)];
			const result = selectVisionArtifacts(files, 10_000);
			expect(result.selected).toHaveLength(4); // SUMMARY + 3 PNG
			expect(result.selected[0]?.kind).toBe("summary");
			expect(result.dropped).toHaveLength(2);
			expect(result.totalTokens).toBe(
				SUMMARY_TOKEN_ESTIMATE + 3 * PNG_TOKEN_ESTIMATE,
			);
		});

		it("at budget: exactly fits SUMMARY + 3 PNG", () => {
			const files = [summary(), png(0), png(1), png(2)];
			const budget = SUMMARY_TOKEN_ESTIMATE + 3 * PNG_TOKEN_ESTIMATE; // 500 + 4500
			const result = selectVisionArtifacts(files, budget);
			expect(result.selected).toHaveLength(4);
			expect(result.totalTokens).toBe(budget);
			expect(result.dropped).toHaveLength(0);
		});

		it("over budget → downgrade to SUMMARY + last PNG", () => {
			// Budget only fits SUMMARY + 1 PNG (500 + 1500 = 2000).
			const files = [summary(), png(0), png(1), png(2), png(3)];
			const result = selectVisionArtifacts(files, 2000);
			expect(result.selected).toHaveLength(2);
			expect(result.selected[0]?.kind).toBe("summary");
			expect(result.selected[1]?.path).toBe("/screens/step-3.png"); // last
			expect(result.totalTokens).toBe(
				SUMMARY_TOKEN_ESTIMATE + PNG_TOKEN_ESTIMATE,
			);
		});

		it("tiny budget (<= summary) → SUMMARY only", () => {
			const files = [summary(), png(0), png(1)];
			const result = selectVisionArtifacts(files, 500);
			expect(result.selected).toHaveLength(1);
			expect(result.selected[0]?.kind).toBe("summary");
			expect(result.totalTokens).toBe(SUMMARY_TOKEN_ESTIMATE);
		});

		it("no SUMMARY, all PNG → still picks top PNGs only", () => {
			const files = [png(0), png(1), png(2), png(3)];
			const result = selectVisionArtifacts(files, 10_000);
			expect(result.selected).toHaveLength(3);
			expect(result.selected.every((f) => f.kind === "png")).toBe(true);
		});

		it("no SUMMARY + tiny budget → empty selection (degenerate; should NOT throw)", () => {
			// Budget < PNG estimate. Without summary the downgrade path falls
			// to nothing. selected is empty + totalTokens=0; caller decides
			// what to do (current callers will skip the Read step).
			const files = [png(0), png(1)];
			const result = selectVisionArtifacts(files, 100);
			expect(result.selected).toHaveLength(0);
			expect(result.totalTokens).toBe(0);
			expect(result.dropped).toHaveLength(2);
		});
	});

	describe("WebM never selected", () => {
		it("WebM always lands in dropped, never selected", () => {
			const files = [summary(), png(0), webm(0), webm(1)];
			const result = selectVisionArtifacts(files, 100_000);
			expect(result.selected.every((f) => f.kind !== "webm")).toBe(true);
			expect(result.dropped.filter((f) => f.kind === "webm")).toHaveLength(2);
		});

		it("WebM does not count against budget", () => {
			const files = [summary(), png(0), webm(0)];
			const result = selectVisionArtifacts(files, 2000); // exactly summary+png
			expect(result.totalTokens).toBe(
				SUMMARY_TOKEN_ESTIMATE + PNG_TOKEN_ESTIMATE,
			);
			expect(result.selected).toHaveLength(2);
		});
	});

	describe("PNG ranking", () => {
		it("error PNGs win ranking even when not first/last", () => {
			const files = [
				summary(),
				png(0),
				png(1, { isError: true }), // error in middle
				png(2),
				png(3),
				png(4),
			];
			const result = selectVisionArtifacts(files, 10_000);
			const selectedPngs = result.selected.filter((f) => f.kind === "png");
			expect(selectedPngs).toHaveLength(3);
			expect(selectedPngs.some((f) => f.path === "/screens/step-1.png")).toBe(
				true,
			);
		});

		it("key PNGs ranked above generic but below error", () => {
			const files = [
				summary(),
				png(0),
				png(1, { isKey: true }),
				png(2, { isError: true }),
				png(3),
				png(4),
			];
			const result = selectVisionArtifacts(files, 10_000);
			const selectedPngs = result.selected.filter((f) => f.kind === "png");
			expect(selectedPngs).toHaveLength(3);
			// Top 3: error(step-2), key(step-1), first(step-0). Order in selected
			// follows ranking.
			expect(selectedPngs[0]?.path).toBe("/screens/step-2.png"); // error
			expect(selectedPngs[1]?.path).toBe("/screens/step-1.png"); // key
			expect(selectedPngs[2]?.path).toBe("/screens/step-0.png"); // first
		});

		it("first and last preferred when no error/key hints", () => {
			const files = [
				summary(),
				png(0), // first
				png(1),
				png(2),
				png(3), // last
			];
			const result = selectVisionArtifacts(files, 10_000);
			const selectedPaths = result.selected.map((f) => f.path);
			expect(selectedPaths).toContain("/screens/step-0.png"); // first
			expect(selectedPaths).toContain("/screens/step-3.png"); // last
		});
	});

	describe("Multiple summaries (wrapper bug guard)", () => {
		it("only the first summary is selected; rest go to dropped", () => {
			const files = [
				summary("SUMMARY.md"),
				summary("summary-extra.md"),
				png(0),
			];
			const result = selectVisionArtifacts(files, 10_000);
			expect(result.selected.filter((f) => f.kind === "summary")).toHaveLength(
				1,
			);
			expect(result.selected[0]?.path).toBe("/screens/SUMMARY.md");
			expect(result.dropped.filter((f) => f.kind === "summary")).toHaveLength(
				1,
			);
		});
	});

	describe("Custom pngLimit override", () => {
		it("pngLimit=1 picks only the top-ranked PNG", () => {
			const files = [summary(), png(0), png(1, { isError: true }), png(2)];
			const result = selectVisionArtifacts(files, 10_000, { pngLimit: 1 });
			const selectedPngs = result.selected.filter((f) => f.kind === "png");
			expect(selectedPngs).toHaveLength(1);
			expect(selectedPngs[0]?.isError).toBe(true);
		});

		it("pngLimit=0 drops all PNGs", () => {
			const files = [summary(), png(0), png(1)];
			const result = selectVisionArtifacts(files, 10_000, { pngLimit: 0 });
			expect(result.selected).toHaveLength(1); // SUMMARY only
			expect(result.selected[0]?.kind).toBe("summary");
		});
	});

	describe("estimateArtifactTokens", () => {
		it("summary returns SUMMARY_TOKEN_ESTIMATE", () => {
			expect(estimateArtifactTokens(summary())).toBe(SUMMARY_TOKEN_ESTIMATE);
		});

		it("png returns PNG_TOKEN_ESTIMATE", () => {
			expect(estimateArtifactTokens(png(0))).toBe(PNG_TOKEN_ESTIMATE);
		});

		it("webm and other return 0", () => {
			expect(estimateArtifactTokens(webm())).toBe(0);
			expect(
				estimateArtifactTokens({
					path: "/x.txt",
					bytes: 100,
					kind: "other",
				}),
			).toBe(0);
		});
	});

	describe("Determinism", () => {
		it("same input → same output (deterministic)", () => {
			const files = [
				summary(),
				png(0),
				png(1, { isKey: true }),
				png(2),
				png(3, { isError: true }),
				png(4),
				webm(),
			];
			const r1 = selectVisionArtifacts(files, 10_000);
			const r2 = selectVisionArtifacts(files, 10_000);
			expect(r1.selected.map((f) => f.path)).toEqual(
				r2.selected.map((f) => f.path),
			);
			expect(r1.dropped.map((f) => f.path)).toEqual(
				r2.dropped.map((f) => f.path),
			);
			expect(r1.totalTokens).toBe(r2.totalTokens);
		});

		it("DEFAULT_PNG_LIMIT is 3", () => {
			expect(DEFAULT_PNG_LIMIT).toBe(3);
		});
	});
});
