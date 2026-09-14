#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { scanHtmlTags } from "../packages/flywheel-comm/dist/report-html.js";

const path =
	process.argv[2] ??
	"engineering/doc/FLY-2390-criteria-c-aggregator/fixtures/report-sample.html";
const html = readFileSync(path, "utf8");
const bytes = Buffer.byteLength(html);
assert(bytes > 0 && bytes <= 512 * 1024, "report exceeds 512KiB or is empty");
const tags = scanHtmlTags(html);
assert(
	tags.openings.some((tag) => tag.name === "main"),
	"missing main",
);
assert(
	!tags.openings.some((tag) => tag.name === "script"),
	"unexpected script",
);
const headings = tags.openings
	.filter((tag) => tag.name === "h2")
	.map((tag) => {
		const end = tags.closings.find(
			(close) => close.name === "h2" && close.start > tag.end,
		);
		assert(end, "unclosed heading");
		return html
			.slice(tag.end + 1, end.start)
			.replace(/<[^>]*>/g, "")
			.trim();
	});
for (const heading of [
	"判定理由",
	"信号计数",
	"Heartbeat 时间轴",
	"原始事件",
	"采集缺口",
	"Bug 与待落定意图",
	"Bug 源健康",
	"Outbox 盘点",
	"日报发布与扫描",
	"Annie 的反馈",
	"本次阈值",
])
	assert(
		headings.some((text) => text.startsWith(heading)),
		`missing evidence section: ${heading}`,
	);
assert(
	tags.openings.some((tag) =>
		tag.attributes.some(
			(attr) =>
				attr.name === "class" && attr.value?.split(" ").includes("timeline"),
		),
	),
	"missing minute timeline",
);
assert(
	tags.openings.some((tag) =>
		tag.attributes.some(
			(attr) =>
				attr.name === "class" &&
				/\bstate (green|hold|unknown)\b/.test(attr.value ?? ""),
		),
	),
	"missing decision state",
);
assert(
	tags.openings.some((tag) => tag.name === "i"),
	"empty minute timeline",
);
assert(
	html.includes("本机部署") && html.includes("窗口"),
	"missing identity/window",
);
console.log(
	JSON.stringify({
		ok: true,
		bytes,
		headings: headings.length,
		sha256: createHash("sha256").update(html).digest("hex"),
		visualAcceptance: "deferred to QA",
	}),
);
