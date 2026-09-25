// FLY-2761 product rule: a founder-facing list may filter only on "does this
// still need her", never on "can we render it". Failing to render a row is our
// problem, not a reason for the row to disappear.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { Window } from "happy-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { attentionAudience, attentionLink } from "../attention-presentation.js";
import { readAttentionSources } from "../attention-sources.js";
import { generateAttentionEpicPage } from "../generate.js";
import type { EpicPageV2 } from "../model.js";
import { renderEpicPageHtml } from "../render-html.js";
import { renderEpicPageMarkdown } from "../render-markdown.js";

// The live FLY-2736 row Honey Lemon measured on 2026-09-20 (ask 9c090bb4):
// pending, no runner session, no Epic parent, outside the Linear boundary.
// The live row settled on 2026-09-22, so this fixture is the reproduction.
const SAMPLE = {
	ask_id: "9c090bb4-dc50-4be5-a568-c2cabaf5d91d",
	project_name: "flywheel",
	issue_id: "FLY-2736",
	channel_id: "1523416434498207945",
	thread_id: "1550543837552713790",
	lead_id: "flywheel-product-lead",
	question_id: null,
	excerpt: "PRIVATE ask excerpt stays audit-only",
	asked_at: "2026-09-19T18:02:39.534Z",
};
// The FLY-2775 shape (ask d2184079, 2026-09-24): its run completed and shipped,
// its thread auto-archived on merge, and the ask was never answered.
const CONCLUDED = {
	ask_id: "d2184079-179c-41a6-b9dd-cb95ee7d391d",
	project_name: "flywheel",
	issue_id: "FLY-2775",
	channel_id: "1516209714097291335",
	thread_id: "1552007075771584683",
	lead_id: "flywheel-eng-lead",
	question_id: null,
	excerpt: "PRIVATE concluded ask excerpt",
	asked_at: "2026-09-24T19:31:55.676Z",
};
const GUILD = "1485787271192907816";
const THREAD_URL = `https://discord.com/channels/${GUILD}/${SAMPLE.thread_id}`;
const now = new Date("2026-09-19T23:47:00Z");
// After d2184079 was asked; its thread had already auto-archived on merge.
const later = new Date("2026-09-25T04:00:00Z");

let store: StateStore;
let dir: string;
let commPath: string;
let comm: CommDB;
beforeEach(async () => {
	store = await StateStore.create(":memory:");
	dir = mkdtempSync(join(tmpdir(), "fly2761-"));
	commPath = join(dir, "comm.db");
	comm = new CommDB(commPath);
	store.upsertChatThread(
		SAMPLE.thread_id,
		SAMPLE.channel_id,
		SAMPLE.issue_id,
		SAMPLE.lead_id,
	);
	store.insertFounderAsk(SAMPLE);
	store.backfillFounderAskMessage(SAMPLE.ask_id, "1550600000000000001");
});
afterEach(() => {
	store.close();
	comm.close();
	rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

async function page(
	guild: string | null = GUILD,
	at = now,
): Promise<EpicPageV2> {
	vi.spyOn(store, "readDiscordConfig").mockReturnValue(
		guild === null
			? null
			: {
					state: "configured",
					guild_id: guild,
					source_updated_at: at.toISOString(),
				},
	);
	const attention = await readAttentionSources(
		{
			stateStore: store,
			openCommReadonly: () => CommDB.openReadonly(commPath),
			fetchFounderReview: async () => ({
				items: [],
				rawCount: 0,
				fetchedAt: at.toISOString(),
				missing: null,
			}),
			// The Linear read succeeds, but FLY-2736 is outside the project's
			// team/project/label boundary, so it returns no metadata.
			fetchIssueMetadata: async () => ({
				items: [],
				rawCount: 0,
				fetchedAt: at.toISOString(),
				missing: null,
			}),
		},
		{
			projectName: SAMPLE.project_name,
			binding: { team: "FLY", project: "Flywheel", label: "Flywheel" },
			apiKey: "fixture",
			channelIds: [SAMPLE.channel_id, CONCLUDED.channel_id],
			now: at,
		},
	);
	return generateAttentionEpicPage({
		snapshot: null,
		scopeBinding: { team: "FLY", project: "Flywheel", label: "Flywheel" },
		attention,
		itemFacts: [],
		projectName: SAMPLE.project_name,
		trigger: "manual",
		now: at,
	}) as EpicPageV2;
}
function section(html: string) {
	const window = new Window();
	window.document.write(html);
	return window.document.querySelector("[data-attention-section]")!;
}

it("lists a pending founder ask with no session, no Epic parent and no Linear metadata", async () => {
	expect(store.getSessionByIssue(SAMPLE.issue_id)).toBeUndefined();
	const document = await page();
	const founder = attentionAudience(document, true);
	expect(founder.map(({ item }) => item.identifier.value)).toEqual([
		"FLY-2736",
	]);
	expect(attentionLink(document, founder[0]!.item).url).toBe(THREAD_URL);
	const html = renderEpicPageHtml(document, now);
	const top = section(html);
	expect(top.querySelector(".sec")?.textContent).toBe("⚡ 现在要你看 · 1 件");
	expect(
		top.querySelector("[data-attention-key] .jump")?.getAttribute("href"),
	).toBe(THREAD_URL);
	expect(top.textContent).toContain("FLY-2736");
	expect(top.textContent).not.toContain("清单不完整");
	const markdown = renderEpicPageMarkdown(document, now);
	expect(markdown).toContain("FLY-2736");
	// The identity cites the ask row internally; public bytes never show it.
	for (const output of [html, markdown]) {
		expect(output).not.toContain("PRIVATE ask excerpt");
		expect(output).not.toContain(SAMPLE.ask_id);
	}
	expect(JSON.stringify(document)).toContain(SAMPLE.ask_id);
});

it("keeps and counts the ask when its Discord link cannot be built", async () => {
	const document = await page(null);
	const founder = attentionAudience(document, true);
	expect(founder).toHaveLength(1);
	expect(attentionLink(document, founder[0]!.item).url).toBeNull();
	const top = section(renderEpicPageHtml(document, now));
	expect(top.querySelector(".sec")?.textContent).toBe("⚡ 现在要你看 · 1 件");
	const row = top.querySelector("[data-attention-key]")!;
	expect(row.textContent).toContain("FLY-2736");
	expect(row.textContent).toContain("（无讨论串链接）");
	expect(row.querySelector("a")).toBeNull();
	expect(top.querySelector(".attention-status")?.textContent).toBe(
		"要你看 1 件，其中 1 件缺讨论串链接",
	);
	const markdown = renderEpicPageMarkdown(document, now);
	expect(markdown).toContain("FLY-2736");
	expect(markdown).toContain("要你看 1 件，其中 1 件缺讨论串链接");
});

it("drops the row once the founder answers in the ask's thread", async () => {
	expect(attentionAudience(await page(), true)).toHaveLength(1);
	store.recordFounderAttentionReply({
		projectName: SAMPLE.project_name,
		issueId: SAMPLE.issue_id,
		threadId: SAMPLE.thread_id,
		messageId: "1550600000000000002",
		beforeMs: now.getTime(),
	});
	expect(store.getFounderAsk(SAMPLE.ask_id)?.settled_by).toBe("founder_reply");
	const document = await page();
	expect(attentionAudience(document, true)).toEqual([]);
	const top = section(renderEpicPageHtml(document, now));
	expect(top.querySelector(".sec")?.textContent).toBe("⚡ 现在要你看 · 0 件");
	expect(top.textContent).toContain("现在没有等你的事");
});

// qa@1 rework: the FLY-2597 rule hides an ordinary answer badge once an issue is
// completed. An unsettled founder ask still waits on her, so it must stay on
// the page whatever the session, run or thread state says.
function concludeFly2775() {
	store.upsertChatThread(
		CONCLUDED.thread_id,
		CONCLUDED.channel_id,
		CONCLUDED.issue_id,
		CONCLUDED.lead_id,
	);
	store.insertFounderAsk(CONCLUDED);
	store.backfillFounderAskMessage(CONCLUDED.ask_id, "1552007075771584700");
	store.upsertSession({
		execution_id: "fly2775-implement",
		issue_id: CONCLUDED.issue_id,
		issue_identifier: CONCLUDED.issue_id,
		project_name: CONCLUDED.project_name,
		status: "completed",
		session_stage: "brainstorm",
	});
	store.insertEvent({
		event_id: "fly2775-finalized",
		execution_id: "fly2775-implement",
		issue_id: CONCLUDED.issue_id,
		project_name: CONCLUDED.project_name,
		event_type: "post_ship_finalization_completed",
		source: "fixture",
		payload: {},
	});
	store.markChatThreadArchived(CONCLUDED.thread_id);
}

it("keeps an unanswered ask on a completed, shipped issue with an archived thread", async () => {
	concludeFly2775();
	expect(store.hasFinalizationCompletedForIssue(CONCLUDED.issue_id)).toBe(true);
	expect(
		store.getActiveWorkflowRunForIssue(CONCLUDED.issue_id),
	).toBeUndefined();
	const document = await page(GUILD, later);
	expect(document.attention_sources.gates.value).toEqual({ count: 2 });
	const row = attentionAudience(document, true).find(
		({ item }) => item.identifier.value === CONCLUDED.issue_id,
	);
	expect(row?.item.sources.map((source) => source.fact.value?.id)).toEqual([
		CONCLUDED.ask_id,
	]);
	expect(attentionLink(document, row!.item).url).toBe(
		`https://discord.com/channels/${GUILD}/${CONCLUDED.thread_id}`,
	);
	const html = renderEpicPageHtml(document, later);
	const top = section(html);
	expect(top.querySelector(".sec")?.textContent).toBe("⚡ 现在要你看 · 2 件");
	expect(top.textContent).toContain(CONCLUDED.issue_id);
	expect(html).not.toContain(CONCLUDED.ask_id);
});

it("drops the concluded issue's ask once the founder answers it", async () => {
	concludeFly2775();
	store.recordFounderAttentionReply({
		projectName: CONCLUDED.project_name,
		issueId: CONCLUDED.issue_id,
		threadId: CONCLUDED.thread_id,
		messageId: "1552007075771584701",
		beforeMs: later.getTime(),
	});
	expect(store.getFounderAsk(CONCLUDED.ask_id)?.settled_by).toBe(
		"founder_reply",
	);
	const document = await page(GUILD, later);
	expect(
		attentionAudience(document, true).map(({ item }) => item.identifier.value),
	).toEqual([SAMPLE.issue_id]);
});
