import { describe, expect, it } from "vitest";
import {
	computeAutoNarrowMetrics,
	renderAutoNarrowOpinion,
} from "../opinion.js";

describe("auto narrow opinion metrics", () => {
	it("keeps auto precision separate from overall action agreement", () => {
		const metrics = computeAutoNarrowMetrics([
			{ decidedAt: "2026-09-01T00:00:00.000Z", predicted: true, actual: true },
			{ decidedAt: "2026-09-02T00:00:00.000Z", predicted: true, actual: false },
			{
				decidedAt: "2026-09-03T00:00:00.000Z",
				predicted: false,
				actual: false,
			},
			{ decidedAt: "2026-09-04T00:00:00.000Z", predicted: false, actual: true },
		]);
		expect(metrics).toEqual({
			sampleN: 4,
			agreeN: 2,
			precisionA: 1,
			precisionB: 2,
			confidenceLower: null,
			sampleStartAt: "2026-09-01T00:00:00.000Z",
			sampleEndAt: "2026-09-04T00:00:00.000Z",
			lastEligibleHumanAt: "2026-09-02T00:00:00.000Z",
		});
	});

	it("uses the Wilson 95% lower bound at five eligible samples", () => {
		const metrics = computeAutoNarrowMetrics(
			Array.from({ length: 5 }, (_, index) => ({
				decidedAt: `2026-09-0${index + 1}T00:00:00.000Z`,
				predicted: true,
				actual: true,
			})),
		);
		expect(metrics.confidenceLower).toBeCloseTo(0.565517535, 8);
	});

	it("keeps zero-success Wilson bounds nonnegative throughout the sample window", () => {
		for (let total = 5; total <= 200; total++) {
			const metrics = computeAutoNarrowMetrics(
				Array.from({ length: total }, () => ({
					decidedAt: "2026-09-09T00:00:00.000Z",
					predicted: true,
					actual: false,
				})),
			);
			expect(
				metrics.confidenceLower,
				`eligible samples: ${total}`,
			).toBeGreaterThanOrEqual(0);
			expect(metrics.confidenceLower).toBeCloseTo(0, 14);
		}
	});

	it("renders all three gates, mode, target, caveat, and stale-sample warning", () => {
		const rendered = renderAutoNarrowOpinion({
			mode: "dry_run",
			eligible: false,
			gate1: true,
			gate2: false,
			gate3: true,
			reasonCode: "gate2_failed",
			metrics: {
				sampleN: 5,
				agreeN: 4,
				precisionA: 4,
				precisionB: 5,
				confidenceLower: 0.3755,
				sampleStartAt: "2026-08-01T00:00:00.000Z",
				sampleEndAt: "2026-08-05T00:00:00.000Z",
				lastEligibleHumanAt: "2026-08-05T00:00:00.000Z",
			},
			now: "2026-08-13T00:00:00.001Z",
			correlationMarker: "auto-narrow-opinion:abc",
		});
		expect(rendered).toContain("不可自动批");
		expect(rendered).toContain("闸① 机器判纯文档 ✓");
		expect(rendered).toContain("闸② Lead代理声明 pure_docs ✗");
		expect(rendered).toContain("闸③ 强度二证据 ✓");
		expect(rendered).toContain("模式 dry_run");
		expect(rendered).toContain("目标 98%");
		expect(rendered).toContain("下界不是这张卡的正确概率");
		expect(rendered).toContain("历史样本，非近期验证");
		expect(rendered).toContain("auto-narrow-opinion:abc");
		expect(rendered.length).toBeLessThanOrEqual(1_800);
	});

	it("renders a founder negative guard as ineligible even when all three gates pass", () => {
		const rendered = renderAutoNarrowOpinion({
			mode: "auto",
			eligible: false,
			gate1: true,
			gate2: true,
			gate3: true,
			reasonCode: "negative_guard",
			metrics: {
				sampleN: 0,
				agreeN: 0,
				precisionA: 0,
				precisionB: 0,
				confidenceLower: null,
				sampleStartAt: null,
				sampleEndAt: null,
				lastEligibleHumanAt: null,
			},
			now: "2026-09-09T03:00:00.000Z",
			correlationMarker: "auto-narrow-opinion:guarded",
		});
		expect(rendered).toContain("机器意见：不可自动批");
		expect(rendered).toContain("founder 已打回或仍有待处理输入");
	});
});
