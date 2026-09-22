import { describe, expect, it } from "vitest";
import { generateAttentionEpicPage, generateEpicPage } from "../generate.js";
import type { VoiceHealthView } from "../model.js";
import { renderEpicPageHtml } from "../render-html.js";
import { renderEpicPageMarkdown } from "../render-markdown.js";
import { attentionFixture } from "./fixtures/attention.js";
import {
	EPIC_SHAPE_NOW,
	emptyItemFacts,
	epicShapeSnapshot,
} from "./fixtures/epic-shape.js";

function document(voiceHealth?: VoiceHealthView, projectName = "flywheel") {
	const snapshot = epicShapeSnapshot();
	const itemFacts = snapshot.items.map(() => emptyItemFacts());
	const legacy = generateEpicPage({
		snapshot,
		itemFacts,
		projectName,
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
		projectName,
		now: EPIC_SHAPE_NOW,
		trigger: "manual",
		...(voiceHealth ? { voiceHealth } : {}),
	});
}

function view(input: Partial<VoiceHealthView> = {}): VoiceHealthView {
	return {
		schemaVersion: 1,
		sourceStatus: "complete",
		observedAt: EPIC_SHAPE_NOW.toISOString(),
		status: "dormant",
		demandState: "none",
		phase: "stopped",
		lastIterationSuccessAt: "2026-09-18T19:50:00.000Z",
		lastProgressAt: null,
		failureStreak: 0,
		activeIncidents: [],
		...input,
	};
}

describe("voice health on the Epic fixed page", () => {
	it("omits the Flywheel-only health section from other projects", () => {
		const page = document(undefined, "raya");
		expect(renderEpicPageMarkdown(page, EPIC_SHAPE_NOW)).not.toContain(
			"## 语音健康",
		);
		expect(renderEpicPageHtml(page, EPIC_SHAPE_NOW)).not.toContain(
			"data-voice-health",
		);
	});

	it("keeps legacy absence explicitly unverified", () => {
		const page = document();
		expect(renderEpicPageMarkdown(page, EPIC_SHAPE_NOW)).toContain(
			"语音健康尚未采集",
		);
		expect(renderEpicPageHtml(page, EPIC_SHAPE_NOW)).toContain(
			"data-voice-health-unknown",
		);
	});

	it("renders no-demand/no-process as normal dormancy while retaining last success", () => {
		const page = document(view());
		const markdown = renderEpicPageMarkdown(page, EPIC_SHAPE_NOW);
		const html = renderEpicPageHtml(page, EPIC_SHAPE_NOW);
		expect(markdown).toContain("无会话需求，正常休眠");
		expect(markdown).toContain("2026-09-18T19:50:00.000Z");
		expect(html).toContain("data-voice-health-dormant");
		expect(html).not.toContain("需要常驻进程");
	});

	it("renders required demand faults and delivery state without founder-attention promotion", () => {
		const page = document(
			view({
				status: "unhealthy",
				demandState: "required",
				phase: "session_failed",
				failureStreak: 3,
				activeIncidents: [
					{
						scope: "session_unavailable",
						openedAt: "2026-09-18T19:59:00.000Z",
						reasonClass: "startup_not_ready",
						threshold: "startup_failure",
						deliveryState: "sent",
					},
				],
			}),
		);
		const markdown = renderEpicPageMarkdown(page, EPIC_SHAPE_NOW);
		const html = renderEpicPageHtml(page, EPIC_SHAPE_NOW);
		expect(markdown).toContain("语音不可用");
		expect(markdown).toContain("启动后未就绪");
		expect(markdown).toContain("告警 sent");
		expect(html).toContain("data-voice-health-unhealthy");
		expect(html).not.toContain("data-voice-founder");
	});

	it.each([
		["unavailable", "unknown"],
		["complete", "unknown"],
	] as const)(
		"never paints source=%s status=%s green",
		(sourceStatus, status) => {
			const page = document(
				view({
					sourceStatus,
					status,
					demandState: "unknown",
					phase: "unknown",
				}),
			);
			const markdown = renderEpicPageMarkdown(page, EPIC_SHAPE_NOW);
			const html = renderEpicPageHtml(page, EPIC_SHAPE_NOW);
			expect(markdown).toContain("无法确认当前语音健康");
			expect(markdown).not.toContain("语音健康正常");
			expect(html).toContain("data-voice-health-unknown");
			expect(html).not.toContain("data-voice-health-healthy");
		},
	);

	// FLY-2693 review R5 (render-stale-branch-drops-active-incidents): the
	// projection keeps retained incidents when the source is unavailable or the
	// reading is stale; both human surfaces must keep showing them with the
	// caveat instead of collapsing to a bare "无法确认" paragraph.
	it.each([
		["unavailable", 0],
		["complete", 90_001],
	] as const)(
		"keeps active incidents visible when source=%s and the reading is %d ms old",
		(sourceStatus, ageMs) => {
			const page = document(
				view({
					sourceStatus,
					status: "unhealthy",
					demandState: "required",
					phase: "session_failed",
					failureStreak: 3,
					activeIncidents: [
						{
							scope: "session_unavailable",
							openedAt: "2026-09-18T19:59:00.000Z",
							reasonClass: "startup_not_ready",
							threshold: "startup_failure",
							deliveryState: "delivery_unknown",
						},
					],
				}),
			);
			const at = new Date(EPIC_SHAPE_NOW.getTime() + ageMs);
			const markdown = renderEpicPageMarkdown(page, at);
			const html = renderEpicPageHtml(page, at);
			for (const surface of [markdown, html]) {
				expect(surface).toContain("启动后未就绪");
				expect(surface).toContain("告警 delivery_unknown");
				expect(surface).toContain("不视为当前健康");
				expect(surface).not.toContain("语音健康正常");
			}
			expect(html).toContain("data-voice-health-unhealthy");
			expect(html).not.toContain("data-voice-health-healthy");
			expect(html).toContain(
				sourceStatus === "unavailable"
					? 'data-voice-health-caveat="unavailable"'
					: 'data-voice-health-caveat="stale"',
			);
		},
	);

	it("labels a truncated incident list instead of rendering it as complete", () => {
		const page = document(
			view({
				sourceStatus: "truncated",
				status: "unhealthy",
				demandState: "required",
				phase: "failed_retrying",
				failureStreak: 4,
				activeIncidents: [
					{
						scope: "poll_dependency",
						openedAt: "2026-09-18T19:58:00.000Z",
						reasonClass: "bridge_timeout_headers",
						threshold: "three_consecutive_failures",
						deliveryState: "sent",
					},
				],
			}),
		);
		expect(renderEpicPageMarkdown(page, EPIC_SHAPE_NOW)).toContain("已截断");
		const html = renderEpicPageHtml(page, EPIC_SHAPE_NOW);
		expect(html).toContain("已截断");
		expect(html).toContain('data-voice-health-caveat="truncated"');
		expect(html).toContain("data-voice-health-unhealthy");
	});

	it("treats a stale required projection as unknown", () => {
		const page = document(
			view({
				status: "healthy",
				demandState: "required",
				phase: "active",
			}),
		);
		const late = new Date(EPIC_SHAPE_NOW.getTime() + 90_001);
		expect(renderEpicPageMarkdown(page, late)).toContain("语音读数过期");
		expect(renderEpicPageHtml(page, late)).not.toContain(
			"data-voice-health-healthy",
		);
	});
});
