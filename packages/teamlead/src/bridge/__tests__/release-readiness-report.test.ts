import { expect, it } from "vitest";
import {
	evaluateReadiness,
	type ReadinessInput,
} from "../release-readiness/evaluate.js";
import { readReadinessPolicy } from "../release-readiness/policy.js";
import { renderReadinessReport } from "../release-readiness/report.js";

it("renders the decision and source evidence as escaped HTML", () => {
	const input: ReadinessInput = {
		subject: { sourceCommit: "a".repeat(40), baseVersion: "1.56.0" },
		now: "2026-09-11T12:00:00.000Z",
		policy: readReadinessPolicy({}),
		localDeployedSha: null,
		anchor: null,
		events: [],
		gaps: [],
		bugs: [],
		bugSourceHealth: {
			label: "<script>alert(1)</script>",
			lastSuccessAt: null,
			lastFailureAt: "2026-09-11T12:00:00.000Z",
			lastError: "unavailable",
		},
		publications: [],
		founderVerdicts: [],
		heartbeats: [],
		outbox: {
			gapsPending: 1,
			gapsInvalid: 1,
			publicationsPending: 0,
			publicationsInvalid: 0,
			oldestPendingAt: null,
			readErrors: [],
		},
	};
	const record = {
		...evaluateReadiness(input),
		subject: input.subject,
		verdictId: "rr-test",
		evaluatedAt: input.now,
	};
	const html = renderReadinessReport(input, record, "2026-09-11");
	expect(html).toContain('lang="zh"');
	expect(html).toContain("unknown");
	expect(html).toContain("outbox_pending");
	expect(html).toContain("&lt;script&gt;");
	expect(html).not.toContain("<script>");
	expect(html).toContain(input.subject.sourceCommit);
	expect(Buffer.byteLength(html)).toBeLessThanOrEqual(512 * 1024);
	expect(() =>
		renderReadinessReport(
			{
				...input,
				bugSourceHealth: {
					...input.bugSourceHealth!,
					lastError: "x".repeat(512 * 1024),
				},
			},
			record,
			"2026-09-11",
		),
	).toThrow("512 KiB");
});
