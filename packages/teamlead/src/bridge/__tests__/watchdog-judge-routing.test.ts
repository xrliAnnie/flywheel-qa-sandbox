/**
 * FLY-1048 PR-B (Task B3): judge routing — mechanical-uncertain reports go
 * through the judge BEFORE the fail-suspicious deliverer.
 *
 * Matrix (plan §3 B3): env off → PR-A behavior (deliver, no judge);
 * a_working/b_parked(+evidence) → suppress with session_events audit, no
 * Lead event; b_parked without evidence → deliver; c_stuck → deliver with
 * the judge verdict annotated (the PR-C unified flow's hook point);
 * suspicious/null → deliver (never silent); insufficient frames → deliver
 * without paying for a judge call.
 */

import { describe, expect, it, vi } from "vitest";
import type { SuspiciousReport } from "../detection-suspicious.js";
import {
	routeSuspiciousReport,
	type SuspiciousJudgeRoutingDeps,
} from "../watchdog-judge.js";

function report(over: Partial<SuspiciousReport> = {}): SuspiciousReport {
	return {
		targetKind: "runner",
		targetKey: "exec-1",
		reason: "focused_frames_unclear: cannot conclude",
		paneTail: "❯",
		episodeFingerprint: "fp-1",
		frames: [
			{ text: "frame\n❯", capturedAtMs: 0 },
			{ text: "frame\n❯", capturedAtMs: 240_000 },
		],
		...over,
	};
}

function makeDeps(over: Partial<SuspiciousJudgeRoutingDeps> = {}) {
	const delivered: SuspiciousReport[] = [];
	const audits: Array<{ verdict: string; ttlMs: number }> = [];
	const deps: SuspiciousJudgeRoutingDeps = {
		judgeEnabled: () => true,
		judge: {
			judge: vi.fn(async () => ({
				verdict: "a_working" as const,
				attribution: "unknown" as const,
				suggestedAction: "none",
				rationale: "tokens are flowing",
			})),
		},
		deliver: (r) => {
			delivered.push(r);
		},
		auditSuppression: (_r, verdict, ttlMs) => {
			audits.push({ verdict: verdict.verdict, ttlMs });
		},
		mechanicalParkEvidence: () => false,
		buildJudgeInput: (r) =>
			(r.frames?.length ?? 0) >= 2 ? { frames: r.frames as never } : null,
		...over,
	};
	return { deps, delivered, audits };
}

describe("routeSuspiciousReport (B3)", () => {
	it("env OFF → PR-A behavior: deliver directly, judge never called", async () => {
		const judgeFn = vi.fn();
		const { deps, delivered } = makeDeps({
			judgeEnabled: () => false,
			judge: { judge: judgeFn as never },
		});
		expect(await routeSuspiciousReport(deps, report())).toBe("delivered");
		expect(delivered).toHaveLength(1);
		expect(judgeFn).not.toHaveBeenCalled();
	});

	it("a_working → suppressed + audited, NO delivery", async () => {
		const { deps, delivered, audits } = makeDeps();
		expect(await routeSuspiciousReport(deps, report())).toBe("suppressed");
		expect(delivered).toHaveLength(0);
		expect(audits).toHaveLength(1);
		expect(audits[0]!.verdict).toBe("a_working");
		expect(audits[0]!.ttlMs).toBeGreaterThan(0);
	});

	it("b_parked WITH mechanical evidence → suppressed; WITHOUT → delivered", async () => {
		const bParked = {
			judge: vi.fn(async () => ({
				verdict: "b_parked" as const,
				attribution: "lead" as const,
				suggestedAction: "answer the gate",
				rationale: "declared park",
			})),
		};
		const withEvidence = makeDeps({
			judge: bParked as never,
			mechanicalParkEvidence: () => true,
		});
		expect(await routeSuspiciousReport(withEvidence.deps, report())).toBe(
			"suppressed",
		);
		const withoutEvidence = makeDeps({ judge: bParked as never });
		expect(await routeSuspiciousReport(withoutEvidence.deps, report())).toBe(
			"delivered",
		);
	});

	it("c_stuck → delivered with the verdict annotated AND a machine-readable confirmed-stuck audit", async () => {
		const confirmed: string[] = [];
		const { deps, delivered } = makeDeps({
			judge: {
				judge: vi.fn(async () => ({
					verdict: "c_stuck" as const,
					attribution: "runner" as const,
					suggestedAction: "nudge it",
					rationale: "error line frozen across frames",
				})),
			} as never,
			auditConfirmedStuck: (r) => {
				confirmed.push(r.targetKey);
			},
		});
		expect(await routeSuspiciousReport(deps, report())).toBe("delivered");
		expect(delivered[0]!.reason).toContain("c_stuck");
		expect(delivered[0]!.reason).toContain("error line frozen");
		// PR-C consumes this durable record as its judge-confirmed case-c input.
		expect(confirmed).toEqual(["exec-1"]);
	});

	it("a failing confirmed-stuck audit never blocks the delivery", async () => {
		const { deps, delivered } = makeDeps({
			judge: {
				judge: vi.fn(async () => ({
					verdict: "c_stuck" as const,
					attribution: "runner" as const,
					suggestedAction: "nudge it",
					rationale: "frozen",
				})),
			} as never,
			auditConfirmedStuck: () => {
				throw new Error("audit boom");
			},
		});
		expect(await routeSuspiciousReport(deps, report())).toBe("delivered");
		expect(delivered).toHaveLength(1);
	});

	it("suspicious verdict / judge failure (null) → delivered (never silent)", async () => {
		for (const result of [
			{
				verdict: "suspicious" as const,
				attribution: "unknown" as const,
				suggestedAction: "look",
				rationale: "cannot tell",
			},
			null,
		]) {
			const { deps, delivered } = makeDeps({
				judge: { judge: vi.fn(async () => result) } as never,
			});
			expect(await routeSuspiciousReport(deps, report())).toBe("delivered");
			expect(delivered).toHaveLength(1);
		}
	});

	it("insufficient frames (<2) → delivered directly without a judge call", async () => {
		const judgeFn = vi.fn();
		const { deps, delivered } = makeDeps({
			judge: { judge: judgeFn as never },
		});
		expect(
			await routeSuspiciousReport(deps, report({ frames: undefined })),
		).toBe("delivered");
		expect(delivered).toHaveLength(1);
		expect(judgeFn).not.toHaveBeenCalled();
	});

	it("a throwing dependency fail-closes to delivery (never swallows the report)", async () => {
		const { deps, delivered } = makeDeps({
			judge: {
				judge: vi.fn(async () => {
					throw new Error("boom");
				}),
			} as never,
		});
		expect(await routeSuspiciousReport(deps, report())).toBe("delivered");
		expect(delivered).toHaveLength(1);
	});
});
