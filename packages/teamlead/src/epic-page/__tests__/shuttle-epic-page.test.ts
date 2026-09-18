import { describe, expect, it } from "vitest";
import { generateAttentionEpicPage, generateEpicPage } from "../generate.js";
import { renderEpicPageHtml } from "../render-html.js";
import { renderEpicPageMarkdown } from "../render-markdown.js";
import { attentionFixture } from "./fixtures/attention.js";
import {
	EPIC_SHAPE_NOW,
	emptyItemFacts,
	epicShapeSnapshot,
} from "./fixtures/epic-shape.js";

function page(
	founderAware: boolean,
	active = true,
	sourceStatus: "complete" | "unavailable" = "complete",
) {
	const snapshot = epicShapeSnapshot();
	const itemFacts = snapshot.items.map(() => emptyItemFacts());
	const legacy = generateEpicPage({
		snapshot,
		itemFacts,
		projectName: "flywheel",
		now: EPIC_SHAPE_NOW,
		trigger: "manual",
	});
	return generateAttentionEpicPage({
		snapshot,
		itemFacts,
		itemSignals: legacy.items.map((item) => ({
			signals: item.signals,
			signal_sources: item.signal_sources,
		})),
		attention: attentionFixture(),
		scopeBinding: { team: "EPX" },
		projectName: "flywheel",
		now: EPIC_SHAPE_NOW,
		trigger: "manual",
		deployment: {
			schemaVersion: 1,
			sourceStatus,
			observedAt: EPIC_SHAPE_NOW.toISOString(),
			retained: 1,
			total: 1,
			units: [
				{
					unitId: "raya-unit",
					projectName: "raya",
					displayName: "Raya <repo>",
					outcome: active ? "failed" : "up_to_date",
					reason: active ? "prestop_validation_failed" : "already_current",
					reasonDisplay: active ? "预停验证失败" : "已经是最新版",
					expected: false,
					observedAt: EPIC_SHAPE_NOW.toISOString(),
					episodeId: active ? "ep-1" : null,
					episodeOpenedAt: active ? EPIC_SHAPE_NOW.toISOString() : null,
					consecutiveScheduledBad: founderAware ? 2 : active ? 1 : 0,
					founderAware,
					behindCommits: active ? 105 : 0,
					driftSince: active ? "2026-09-02T04:00:01Z" : null,
					logRef: "/tmp/flywheel-updater.log",
					deliveryState: active ? "sent" : null,
				},
			],
			activeIncidents: active ? ["raya-unit"] : [],
		},
	});
}

describe("shuttle status on the Epic fixed page", () => {
	it("renders machine state in Markdown and escaped HTML", () => {
		const document = page(false);
		const markdown = renderEpicPageMarkdown(document, EPIC_SHAPE_NOW);
		const html = renderEpicPageHtml(document, EPIC_SHAPE_NOW);
		expect(markdown).toContain("班车状态");
		expect(markdown).toContain("Raya &lt;repo&gt;");
		expect(markdown).toContain("落后 105 个提交");
		expect(markdown).toContain("已确认至少落后 24 小时");
		expect(html).toContain("Raya &lt;repo&gt;");
		expect(html).toContain("已确认至少落后 24 小时");
		expect(html).not.toContain("Raya <repo>");
	});

	it("promotes only two-cycle incidents into the founder section and extinguishes on recovery", () => {
		expect(renderEpicPageMarkdown(page(true), EPIC_SHAPE_NOW)).toContain(
			"需要你知道，Lead 处理中",
		);
		expect(renderEpicPageHtml(page(true), EPIC_SHAPE_NOW)).toContain(
			"data-shuttle-founder",
		);
		const recovered = renderEpicPageHtml(page(false, false), EPIC_SHAPE_NOW);
		expect(recovered).not.toContain("data-shuttle-founder");
		expect(recovered).toContain("班车全部单元正常");
	});

	it("does not call an old document healthy", () => {
		const snapshot = epicShapeSnapshot();
		const old = generateEpicPage({
			snapshot,
			itemFacts: snapshot.items.map(() => emptyItemFacts()),
			projectName: "flywheel",
			now: EPIC_SHAPE_NOW,
			trigger: "manual",
		});
		expect(renderEpicPageMarkdown(old, EPIC_SHAPE_NOW)).toContain(
			"班车状态尚未采集",
		);
		const unavailable = page(false, false, "unavailable");
		expect(renderEpicPageMarkdown(unavailable, EPIC_SHAPE_NOW)).toContain(
			"无法判定当前班车是否健康",
		);
		expect(renderEpicPageHtml(unavailable, EPIC_SHAPE_NOW)).not.toContain(
			"data-shuttle-healthy",
		);
	});

	it("calls a complete projection stale after one missed shuttle cycle", () => {
		const stale = page(false, false);
		const afterOneCycle = new Date(
			EPIC_SHAPE_NOW.getTime() + 12 * 60 * 60_000 + 1,
		);
		const markdown = renderEpicPageMarkdown(stale, afterOneCycle);
		const html = renderEpicPageHtml(stale, afterOneCycle);
		expect(markdown).toContain("班车停跑/读数过期");
		expect(markdown).not.toContain("班车全部单元正常");
		expect(html).toContain("班车停跑/读数过期");
		expect(html).not.toContain("data-shuttle-healthy");
	});

	it("does not call an expected skipped cycle fully healthy", () => {
		const skipped = page(false, false);
		Object.assign(skipped.deployment!.value!.units[0]!, {
			outcome: "skipped",
			reason: "not-in-deploy-wave",
			reasonDisplay: "本班未进入部署波次",
			expected: true,
		});
		const markdown = renderEpicPageMarkdown(skipped, EPIC_SHAPE_NOW);
		const html = renderEpicPageHtml(skipped, EPIC_SHAPE_NOW);
		expect(markdown).toContain("本班未验证");
		expect(markdown).not.toContain("班车全部单元正常");
		expect(html).toContain("本班未验证");
		expect(html).not.toContain("data-shuttle-healthy");
	});
});
