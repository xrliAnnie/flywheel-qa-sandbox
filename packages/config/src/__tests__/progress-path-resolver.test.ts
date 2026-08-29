import { describe, expect, it } from "vitest";
import {
	type ProgressPathInput,
	resolveProgressPath,
} from "../progress-path-resolver.js";

/**
 * FLY-795 (Codex R2 #2): the shared, deterministic progress.md path resolver.
 * PURE — git/fs discovery is done by callers who pass results in, so the same
 * precedence produces the SAME path on the write side (progress command), the
 * read side (teamlead resume detection), and the inject side (Blueprint env).
 */
describe("resolveProgressPath (FLY-795)", () => {
	const base: ProgressPathInput = {
		docBaseDir: "engineering/doc",
		issueIdentifier: "FLY-795",
		slug: "restart-resilient-resume",
	};

	it("① prefers the persisted plan_path dirname", () => {
		expect(
			resolveProgressPath({
				...base,
				planPath: "engineering/doc/FLY-795-restart-resilient-resume/plan.md",
			}),
		).toBe("engineering/doc/FLY-795-restart-resilient-resume/progress.md");
	});

	it("② falls back to a discovered doc dir", () => {
		expect(
			resolveProgressPath({
				...base,
				discoveredDocDir: "engineering/doc/FLY-795-something",
			}),
		).toBe("engineering/doc/FLY-795-something/progress.md");
	});

	it("③ falls back to a deterministic default (docBaseDir + issue + slug)", () => {
		expect(resolveProgressPath(base)).toBe(
			"engineering/doc/FLY-795-restart-resilient-resume/progress.md",
		);
	});

	it("docTier none (no slug) → deterministic <issue>-progress dir", () => {
		expect(
			resolveProgressPath({
				docBaseDir: "engineering/doc",
				issueIdentifier: "FLY-900",
			}),
		).toBe("engineering/doc/FLY-900-progress/progress.md");
	});

	it("always returns a relative path inside the doc base (no escape)", () => {
		const p = resolveProgressPath(base);
		expect(p.startsWith("/")).toBe(false);
		expect(p).not.toContain("..");
		expect(p).toContain("FLY-795");
	});

	it("precedence is stable: planPath wins over discoveredDocDir wins over default", () => {
		const p = resolveProgressPath({
			...base,
			planPath: "engineering/doc/FLY-795-A/plan.md",
			discoveredDocDir: "engineering/doc/FLY-795-B",
		});
		expect(p).toBe("engineering/doc/FLY-795-A/progress.md");
	});
});
