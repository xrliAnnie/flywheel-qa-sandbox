#!/usr/bin/env node
// FLY-616 — eval CLI. Two subcommands:
//   extract   --manifest <m.json> --out <condition.json>   (read runs → QualityMetrics + aggregate)
//   scorecard --baseline <a.json> --candidate <b.json> --out <scorecard.html>
//
// 消费编译后的 lib via 相对路径 ../dist/index.js（Codex R6：不 package-name 自 import）。
// extract 走真只读 better-sqlite3 reader（614 token / lagging / diff = v1 mocked）。

import { readFileSync, writeFileSync } from "node:fs";
import {
	aggregate,
	collectMetrics,
	compare,
	createSqliteReaders,
	EvalRunManifestSchema,
} from "../dist/index.js";
import { renderScorecard } from "./scorecard.mjs";

function arg(name, def = null) {
	const i = process.argv.indexOf(name);
	return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

function usage() {
	console.log(`FLY-616 eval CLI
Usage:
  cli.mjs extract   --manifest <manifest.json> --out <condition.json>
  cli.mjs scorecard --baseline <condA.json> --candidate <condB.json> --out <scorecard.html>

extract:   读 EvalRunManifest → 真只读 better-sqlite3 提取每任务 QualityMetrics + aggregate → 写 ConditionResult JSON。
scorecard: 读两个 ConditionResult → compare(count-first advisory) → 渲染 Apple-light HTML。
Notes: 质量信号真读 teamlead.db(只读)；token 读 FLY-614(v1 mocked→null)；滞后信号 v1 not_applicable。`);
}

async function doExtract() {
	const manifestPath = arg("--manifest");
	const out = arg("--out");
	if (!manifestPath || !out) {
		usage();
		process.exit(2);
	}
	const manifest = EvalRunManifestSchema.parse(
		JSON.parse(readFileSync(manifestPath, "utf-8")),
	);
	const readers = await createSqliteReaders();
	const tasks = [];
	for (const handle of manifest.handles) {
		tasks.push(await collectMetrics(handle, readers));
	}
	const agg = aggregate(manifest.conditionLabel, tasks);
	const result = {
		label: manifest.conditionLabel,
		meta: manifest.meta,
		tasks,
		aggregate: agg,
	};
	writeFileSync(out, JSON.stringify(result, null, 2));
	console.log(
		`extracted ${tasks.length} task(s) for condition "${manifest.conditionLabel}" → ${out}`,
	);
}

function doScorecard() {
	const baselinePath = arg("--baseline");
	const candidatePath = arg("--candidate");
	const out = arg("--out", "scorecard.html");
	if (!baselinePath || !candidatePath) {
		usage();
		process.exit(2);
	}
	const baseline = JSON.parse(readFileSync(baselinePath, "utf-8"));
	const candidate = JSON.parse(readFileSync(candidatePath, "utf-8"));
	const comparison = compare(
		baseline.label,
		baseline.tasks,
		candidate.label,
		candidate.tasks,
	);
	const meta = baseline.meta ?? { issue: "FLY-616", date: "", taskSet: [] };
	const input = {
		meta,
		conditions: [
			{
				label: baseline.label,
				tasks: baseline.tasks,
				aggregate: baseline.aggregate,
			},
			{
				label: candidate.label,
				tasks: candidate.tasks,
				aggregate: candidate.aggregate,
			},
		],
		comparison,
	};
	writeFileSync(out, renderScorecard(input));
	console.log(
		`scorecard → ${out}  (overall: ${comparison.overall}${comparison.inconclusive ? " / inconclusive" : ""})`,
	);
}

const cmd = process.argv[2];
if (cmd === "--help" || cmd === "-h" || !cmd) {
	usage();
	process.exit(0);
} else if (cmd === "extract") {
	doExtract().catch((e) => {
		console.error(e);
		process.exit(1);
	});
} else if (cmd === "scorecard") {
	doScorecard();
} else {
	console.error(`unknown command: ${cmd}`);
	usage();
	process.exit(2);
}
