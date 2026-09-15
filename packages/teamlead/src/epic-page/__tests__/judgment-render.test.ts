import { Window } from "happy-dom";
import { expect, it } from "vitest";
import { decodeAuditSidecar } from "../audit-sidecar.js";
import { generateEpicPage } from "../generate.js";
import { renderHistoryPreview } from "../history-preview.js";
import { renderEpicPageBudgetBundle } from "../optional-budget.js";
import { renderEpicPageBundle, renderEpicPageHtml } from "../render-html.js";
import { renderEpicPageMarkdown } from "../render-markdown.js";
import {
	EPIC_SHAPE_NOW,
	emptyItemFacts,
	epicShapeSnapshot,
} from "./fixtures/epic-shape.js";

it("renders bounded judgment links with lossless sidecar and standalone audit evidence", () => {
	const snapshot = epicShapeSnapshot();
	const page = generateEpicPage({
		snapshot,
		itemFacts: snapshot.items.map(() => emptyItemFacts()),
		now: EPIC_SHAPE_NOW,
		projectName: "flywheel",
		trigger: "manual",
	});
	const baseline = renderEpicPageBundle(page, EPIC_SHAPE_NOW);
	const cell = {
		value: {
			question_id: "q",
			opinion_id: "opinion",
			input_id: null,
			evaluation_id: null,
			source: "machine" as const,
			overall: "undetermined" as const,
			alignment: null,
			conflict: null,
			coverage: null,
			display: "pending" as const,
			reason: "missing_qa",
			policy_version: "v1",
			model_snapshot_digest: null,
			evidence: {
				evaluation: null,
				mechanical: {
					detail: "</script><img src=x onerror=alert(1)>".repeat(100),
				},
			},
		},
		observed_at: EPIC_SHAPE_NOW.toISOString(),
		source_updated_at: "2026-09-01T00:00:00.000Z",
		provenance: {
			kind: "statestore" as const,
			table: "ship_judgment_opinion",
			key: { issue_id: snapshot.items[0]!.id },
		},
	};
	page.items[0]!.ship_judgment = cell;
	const bundle = renderEpicPageBundle(page, EPIC_SHAPE_NOW);
	const compact = renderEpicPageBundle(page, EPIC_SHAPE_NOW, {
		judgmentRows: 0,
		historyRows: 0,
	});
	expect(compact.html).not.toContain("<div data-judgment>");
	expect(compact.html).toContain("机器意见摘要已缩减");
	expect(decodeAuditSidecar(compact.audit.json)).toContainEqual(cell);
	expect(compact.html.match(/class="kid"/g)).toHaveLength(page.items.length);

	expect(bundle.html).toContain("机器意见：待展示 · 无法判断");
	expect(bundle.html).toContain(`href="${bundle.audit.path}#`);
	expect(
		Buffer.byteLength(bundle.html) - Buffer.byteLength(baseline.html),
	).toBeLessThanOrEqual(256);
	expect(decodeAuditSidecar(bundle.audit.json)).toContainEqual(cell);
	expect(bundle.html).not.toContain("onerror=alert");
	const standalone = renderEpicPageHtml(page, EPIC_SHAPE_NOW);
	expect(standalone).toContain("机器意见：待展示 · 无法判断");
	expect(standalone).toContain("&lt;/script&gt;");
	const markdown = renderEpicPageMarkdown(page, EPIC_SHAPE_NOW);
	expect(markdown).toContain("机器意见：待展示 · 无法判断");
	expect(markdown).toContain("2026-09-01T00:00:00.000Z");
	expect(markdown).toContain("missing_qa");
});

it("keeps only one history footer link in HTML and preserves Markdown and audit history", () => {
	const snapshot = epicShapeSnapshot();
	const rows = Array.from({ length: 20 }, (_, i) => ({
		questionId: `q${i}`,
		issue: `FLY-${i} ` + "<&😀".repeat(300),
		auditId: `audit-${i}`,
		source: "legacy_retro" as const,
		overall: "recommend_reject" as const,
		decision: "approved" as const,
		decisionSource: "lead_manual" as const,
		decisionAuditId: "decision",
		clarificationAuditId: null,
		authorship: "unknown" as const,
		clarification: "pending" as const,
		summary: "</script><img src=x onerror=alert(1)>".repeat(100),
		cardUrl: `https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333`,
		updatedAt: EPIC_SHAPE_NOW.toISOString(),
	}));
	const history = {
		rows,
		total: 150,
		url: "https://reports.example/r/old",
		publishedAsOf: EPIC_SHAPE_NOW.toISOString(),
		error: "history_round_failed",
		dirty: true,
		readError: false,
	};
	const page = generateEpicPage({
		snapshot,
		itemFacts: snapshot.items.map(() => emptyItemFacts()),
		now: EPIC_SHAPE_NOW,
		projectName: "flywheel",
		trigger: "manual",
		shipJudgmentHistory: history,
	});
	const bundle = renderEpicPageBundle(page, EPIC_SHAPE_NOW);
	for (const html of [
		bundle.html,
		renderEpicPageHtml(page, EPIC_SHAPE_NOW),
		renderEpicPageBudgetBundle(page, EPIC_SHAPE_NOW).html,
	]) {
		expect(html).not.toContain("data-judgment-history");
		expect(html).not.toContain("机器意见历史");
		expect(html).not.toContain("data-history-row");
		expect(html.match(/查看近 30 天历史/g)).toHaveLength(1);
		const window = new Window({
			settings: { disableJavaScriptEvaluation: true },
		});
		window.document.write(html);
		const link = window.document.querySelector("footer[data-history-link] a");
		expect(link?.getAttribute("href")).toBe(history.url);
		expect(link?.closest("details")).toBeNull();
		expect(link?.parentElement?.textContent).toBe("查看近 30 天历史");
		window.close();
	}
	expect(decodeAuditSidecar(bundle.audit.json)).toContainEqual(
		page.ship_judgment_history,
	);
	expect(renderEpicPageMarkdown(page, EPIC_SHAPE_NOW)).toContain(
		"最近 20 / 150 条",
	);
	page.ship_judgment_history!.value!.readError = true;
	const failed = renderEpicPageBundle(page, EPIC_SHAPE_NOW).html;
	expect(failed).not.toContain("预览读取失败");
	expect(failed).toContain('href="https://reports.example/r/old"');
	page.ship_judgment_history!.value!.url =
		'https://reports.example/r/old?x=1&y="quoted"';
	expect(renderEpicPageHtml(page, EPIC_SHAPE_NOW)).toContain(
		'href="https://reports.example/r/old?x=1&amp;y=&quot;quoted&quot;"',
	);
	for (const url of [null, "", "https://reports.example/" + "&".repeat(400)]) {
		page.ship_judgment_history!.value!.url = url;
		expect(renderEpicPageHtml(page, EPIC_SHAPE_NOW)).not.toContain(
			"data-history-link",
		);
	}
	page.ship_judgment_history!.value = null;
	expect(renderEpicPageHtml(page, EPIC_SHAPE_NOW)).not.toContain(
		"机器意见历史",
	);
	delete page.ship_judgment_history;
	expect(renderEpicPageHtml(page, EPIC_SHAPE_NOW)).not.toContain(
		"data-history-link",
	);
});

it("bounds zero-row fallback and does not claim an unavailable prior publication", () => {
	const cell = {
		value: {
			rows: [],
			total: 200,
			url: "https://reports.example/r/old",
			publishedAsOf: null,
			error: "history_state_unavailable",
			dirty: true,
			readError: false,
		},
		observed_at: EPIC_SHAPE_NOW.toISOString(),
		provenance: {
			kind: "statestore" as const,
			table: "ship_judgment_project_state",
			key: { project_name: "flywheel" },
		},
	};
	const fallback = renderHistoryPreview(cell, 0);
	expect(Buffer.byteLength(fallback)).toBeLessThanOrEqual(1024);
	expect(fallback).toContain("最近 0 / 200 条");
	cell.value.url = "https://reports.example/r/" + "&".repeat(400);
	const unavailable = renderHistoryPreview(cell, 0);
	expect(Buffer.byteLength(unavailable)).toBeLessThanOrEqual(1024);
	expect(unavailable).toContain("历史入口尚不可用");
	expect(unavailable).not.toContain("保留上次发布");
});
