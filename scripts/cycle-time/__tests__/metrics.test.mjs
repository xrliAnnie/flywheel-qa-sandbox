import assert from "node:assert/strict";
import test from "node:test";

import {
	CONCURRENCY_INSUFFICIENT_MSG,
	classifyVerdict,
} from "../lib/metrics.mjs";

const evidence = [{ source: "fixture", key: "fixture:1", summary: "fixture" }];

function report(
	issue,
	{ mechanism = 0, execution = 0, work = 0, unknown = 0, closed = true } = {},
) {
	let cursor = 0;
	const segments = [];
	for (const [label, duration] of [
		["idle_gap", mechanism],
		["rework_loop", execution],
		["working", work],
		["unmeasurable", unknown],
	]) {
		if (duration <= 0) continue;
		segments.push({
			start_ms: cursor,
			end_ms: cursor + duration,
			label,
			in_flight: false,
			evidence,
		});
		cursor += duration;
	}
	return {
		kind: "analyzed",
		issue,
		t0: 0,
		end_ms: cursor,
		as_of: cursor,
		closed,
		segments,
		coverage: [],
		overlays: [],
	};
}

test("verdict qualification includes exactly 80% coverage and requires two closed issues", () => {
	const reports = [
		report("FLY-799", { mechanism: 79.9, unknown: 20.1 }),
		report("FLY-800", { mechanism: 80, unknown: 20 }),
		report("FLY-801", { mechanism: 80.1, unknown: 19.9 }),
		report("FLY-OPEN", { mechanism: 100, closed: false }),
	];
	const verdict = classifyVerdict(reports);
	assert.deepEqual(verdict.qualifying_issues, ["FLY-800", "FLY-801"]);
	assert.equal(verdict.kind, "mechanism");
	assert.equal(CONCURRENCY_INSUFFICIENT_MSG, "样本不足以定量,建议持续采集");
});

test("mechanism verdict threshold is inclusive at 30 percent", () => {
	const run = (mechanism) =>
		classifyVerdict([
			report("FLY-A", { mechanism, work: 100 - mechanism }),
			report("FLY-B", { mechanism, work: 100 - mechanism }),
		]);
	assert.equal(run(29.9).kind, "inconclusive");
	assert.equal(run(30).kind, "mechanism");
	assert.equal(run(30.1).kind, "mechanism");
	assert.deepEqual(run(30).thresholds, {
		coverage: 0.8,
		dominance: 0.3,
		operator: ">=",
	});
});

test("pooled and per-issue median disagreement remains inconclusive", () => {
	const verdict = classifyVerdict([
		report("FLY-BIG-M", { mechanism: 1000 }),
		report("FLY-SMALL-E1", { execution: 100 }),
		report("FLY-SMALL-E2", { execution: 100 }),
	]);
	assert.equal(verdict.kind, "inconclusive");
	assert.equal(verdict.reason, "pooled_median_disagree");
	assert.ok(verdict.pooled.mechanism > verdict.pooled.execution);
	assert.ok(verdict.median.mechanism < verdict.median.execution);
});
