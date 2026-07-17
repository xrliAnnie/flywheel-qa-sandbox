import assert from "node:assert/strict";
import test from "node:test";

import { CONCURRENCY_INSUFFICIENT_MSG } from "../lib/metrics.mjs";
import { renderReport } from "../lib/render.mjs";

const coverage = ["linear", "teamlead", "commdb", "gh"].map((source) => ({
	source,
	authoritative_kind: "all",
	status: "ok",
	covered: [{ start_ms: 0, end_ms: 100 }],
	note: "fixture",
}));

const reports = [
	{
		kind: "analyzed",
		issue: 'FLY-1<script>alert("x")</script>',
		t0: 0,
		end_ms: 100,
		as_of: 100,
		closed: true,
		coverage,
		overlays: [],
		segments: [
			{
				start_ms: 0,
				end_ms: 30,
				label: "working",
				sublabel: "implement",
				in_flight: false,
				evidence: [
					{ source: "fixture", key: "work", summary: "coded <b>unsafe</b>" },
				],
			},
			{
				start_ms: 30,
				end_ms: 60,
				label: "rework_loop",
				sublabel: "review_fix",
				in_flight: false,
				evidence: [{ source: "fixture", key: "fix", summary: "review fix" }],
			},
			{
				start_ms: 60,
				end_ms: 80,
				label: "unmeasurable",
				in_flight: false,
				evidence: [
					{ source: "fixture", key: "unknown", summary: "coverage gap" },
				],
			},
			{
				start_ms: 80,
				end_ms: 100,
				label: "gate_waiting_human",
				sublabel: "approve_to_ship",
				in_flight: true,
				evidence: [{ source: "fixture", key: "gate", summary: "waiting" }],
			},
		],
	},
];

test("report is a complete escaped Apple-light document within publish limits", () => {
	const html = renderReport({
		reports,
		verdict: { kind: "inconclusive", qualifying_issues: [], reason: "fixture" },
		manifests: [{ source_id: "fixture", content_sha256: "abc" }],
		suggestions: [
			{
				id: "handoff",
				title: "消除 handoff gap",
				saving: "0–2h",
				cost: "S",
				rationale: "fixture",
			},
		],
		asOf: "2026-07-17T12:00:00.000Z",
	});
	assert.match(html, /^<!DOCTYPE html>/);
	assert.match(html, /<meta name="viewport"/);
	assert.match(html, /background:\s*#f5f5f7/);
	assert.doesNotMatch(html, /<script>alert/);
	assert.match(html, /&lt;script&gt;alert/);
	assert.match(html, /coded &lt;b&gt;unsafe&lt;\/b&gt;/);
	assert.ok(Buffer.byteLength(html, "utf8") < 512 * 1024);
});

test("hosted interactions use one nonce script, no inline handlers, namespaced state, and mobile copy fallback", () => {
	const html = renderReport({
		reports,
		verdict: { kind: "inconclusive", qualifying_issues: [] },
		manifests: [],
		suggestions: [],
		asOf: "2026-07-17T12:00:00.000Z",
	});
	assert.equal(html.match(/<script nonce="__CSP_NONCE__">/g)?.length, 1);
	assert.doesNotMatch(html, /\sonclick=/i);
	assert.match(html, /localStorage/);
	assert.match(html, /fly1327-/);
	assert.match(html, /execCommand\(["']copy["']\)/);
	assert.match(html, /navigator\.clipboard/);
	assert.match(html, /addEventListener\(["']click["']/);
});

test("report exposes pooled and per-issue views, censoring, evidence, and the fixed concurrency caveat", () => {
	const html = renderReport({
		reports,
		verdict: { kind: "inconclusive", qualifying_issues: [] },
		manifests: [],
		suggestions: [],
		asOf: "2026-07-17T12:00:00.000Z",
	});
	assert.match(html, /Pooled/);
	assert.match(html, /Per-issue/);
	assert.match(html, /无法测量/);
	assert.match(html, /进行中/);
	assert.match(html, /coded &lt;b&gt;unsafe&lt;\/b&gt;/);
	assert.match(html, new RegExp(CONCURRENCY_INSUFFICIENT_MSG));
	assert.doesNotMatch(html, /最佳并发.*\d/);
});

test("pooled chart excludes open issues while per-issue view keeps them visible", () => {
	const closed = {
		...reports[0],
		issue: "FLY-CLOSED",
		segments: [
			{
				start_ms: 0,
				end_ms: 100,
				label: "working",
				in_flight: false,
				evidence: [
					{ source: "fixture", key: "closed", summary: "closed work" },
				],
			},
		],
	};
	const open = {
		...closed,
		issue: "FLY-OPEN",
		closed: false,
		segments: [
			{
				start_ms: 0,
				end_ms: 100,
				label: "idle_gap",
				sublabel: "phase_handoff",
				in_flight: false,
				evidence: [{ source: "fixture", key: "open", summary: "open idle" }],
			},
		],
	};
	const html = renderReport({
		reports: [closed, open],
		verdict: { kind: "inconclusive", qualifying_issues: [] },
		manifests: [],
		suggestions: [],
		asOf: "2026-07-17T12:00:00.000Z",
	});
	const pooled =
		html.match(/<div class="aggregate-bar">(.*?)<\/div>/s)?.[1] ?? "";
	assert.match(pooled, /agg-value_work[^>]+width:100\.0000%/);
	assert.doesNotMatch(pooled, /agg-mechanism_waste/);
	assert.match(
		html,
		/<span>FLY-OPEN<\/span><div class="aggregate-bar"><span class="agg-mechanism_waste"/,
	);
});

test("hero names only the closed issues that qualified for the verdict", () => {
	const html = renderReport({
		reports: [reports[0], { ...reports[0], issue: "FLY-OPEN", closed: false }],
		verdict: {
			kind: "mechanism",
			qualifying_issues: [reports[0].issue],
			pooled: { mechanism: 0.5, execution: 0.1 },
			median: { mechanism: 0.5, execution: 0.1 },
		},
		manifests: [],
		suggestions: [],
		asOf: "2026-07-17T12:00:00.000Z",
	});
	assert.match(html, /达到结论门槛的 1 个已关闭样本/);
	assert.match(html, /FLY-1&lt;script&gt;alert/);
	assert.doesNotMatch(html, /这 2 个样本中，慢主要在机制/);
});
