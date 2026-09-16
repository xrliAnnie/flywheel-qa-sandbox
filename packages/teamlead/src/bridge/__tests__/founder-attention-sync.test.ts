import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { expect, it, vi } from "vitest";
import { attentionAudience } from "../../epic-page/attention-presentation.js";
import { readAttentionSources } from "../../epic-page/attention-sources.js";
import { generateAttentionEpicPage } from "../../epic-page/generate.js";
import { renderEpicPageHtml } from "../../epic-page/render-html.js";
import { StateStore } from "../../StateStore.js";
import type { ChatThreadCreator } from "../ChatThreadCreator.js";
import { IssueDisplayRefresher } from "../issue-display-refresher.js";
import type { BridgeConfig } from "../types.js";

it.each([false, true])(
	"keeps page and title together across triggers and replies (UUID alias: %s)",
	async (withUuidAlias) => {
		const store = await StateStore.create(":memory:");
		const dir = mkdtempSync(join(tmpdir(), "founder-sync-"));
		const path = join(dir, "comm.db");
		const db = new CommDB(path);
		const projectName = "another-project",
			issueId = "TEST-1",
			channel = "123",
			thread = "456";
		const now = new Date();
		const uuid = "12345678-1234-4123-8123-123456789abc";
		const titles: Array<string | null> = [];
		const openCommReadonly = () => CommDB.openReadonly(path);
		try {
			store.upsertChatThread(thread, channel, issueId, "lead");
			vi.spyOn(store, "readDiscordConfig").mockReturnValue({
				state: "configured",
				guild_id: "789",
				source_updated_at: now.toISOString(),
			});
			const refresher = new IssueDisplayRefresher({
				store,
				projects: [
					{
						projectName,
						projectRoot: "/tmp/test",
						leads: [
							{
								agentId: "lead",
								chatChannel: channel,
								botToken: "fixture",
								match: { labels: [] },
							},
						],
					},
				],
				config: {} as BridgeConfig,
				flags: { issueStatusEmojiEnabled: true, issueAttachPinEnabled: false },
				keepAliveEnabled: () => true,
				openAttentionCommReadonly: openCommReadonly,
				chatThreadCreator: {
					stampStatusBadgeResult: async (
						_c: unknown,
						_t: string,
						b: string | null,
					) => {
						titles.push(b);
						return "changed";
					},
					stampStageEmojiResult: async (
						_c: unknown,
						_t: string,
						stage: string,
						_w: boolean,
						b?: string,
					) => {
						titles.push(b ?? stage);
						return "changed";
					},
				} as unknown as ChatThreadCreator,
			});
			const page = async () => {
				const attention = await readAttentionSources(
					{
						stateStore: store,
						openCommReadonly,
						fetchFounderReview: async () => ({
							items: [],
							rawCount: 0,
							fetchedAt: now.toISOString(),
							missing: null,
						}),
						fetchIssueMetadata: async () => ({
							items: [
								{
									id: withUuidAlias ? uuid : "uuid",
									identifier: issueId,
									title: "Decide <script>alert(1)</script>",
									url: "https://linear.app/test",
									stateType: "started",
									labels: [],
								},
							],
							rawCount: 1,
							fetchedAt: now.toISOString(),
							missing: null,
						}),
					},
					{
						projectName,
						binding: { team: "TEST" },
						apiKey: "fixture",
						channelIds: [channel],
						now,
					},
				);
				return generateAttentionEpicPage({
					snapshot: null,
					scopeBinding: { team: "TEST" },
					attention,
					itemFacts: [],
					projectName,
					trigger: "manual",
					now,
				});
			};
			const assertAnswer = async () => {
				await refresher.refresh(issueId);
				expect(titles.at(-1)).toBe("🔔要你答");
				const p = await page();
				expect(
					attentionAudience(p, true).map((r) => r.item.identifier.value),
				).toEqual([issueId]);
				expect(renderEpicPageHtml(p, now)).not.toContain(
					"<script>alert(1)</script>",
				);
			};
			const ask = (askId: string, questionId: string | null) => {
				store.insertFounderAsk({
					ask_id: askId,
					project_name: projectName,
					issue_id: issueId,
					channel_id: channel,
					thread_id: thread,
					lead_id: "lead",
					question_id: questionId,
					excerpt: "audit",
					asked_at: new Date(now.getTime() - 3000).toISOString(),
				});
				store.backfillFounderAskMessage(askId, `message-${askId}`);
			};
			// Lead-owned Epic with no runner session.
			ask("standalone", null);
			await assertAnswer();
			store.recordFounderAttentionReply({
				projectName,
				issueId,
				threadId: thread,
				messageId: "founder",
				beforeMs: now.getTime() - 2000,
			});
			await refresher.refresh(issueId);
			expect(titles.at(-1)).toBeNull();
			expect(attentionAudience(await page(), true)).toEqual([]);
			store.upsertSession({
				execution_id: "runner",
				issue_id: issueId,
				issue_identifier: issueId,
				project_name: projectName,
				status: "running",
				session_stage: "implement",
			});
			const linked = db.insertQuestion("runner", "lead", "Need a decision");
			ask("forwarded", linked);
			await assertAnswer();
			db.insertResponse(linked, "lead", "answered");
			await refresher.refresh(issueId);
			expect(titles.at(-1)).toBe("implement");
			expect(attentionAudience(await page(), true)).toEqual([]);
			if (withUuidAlias)
				store.upsertSession({
					execution_id: "uuid-runner",
					issue_id: uuid,
					issue_identifier: issueId,
					project_name: projectName,
					status: "running",
					session_stage: "implement",
				});
			// A new gate created after the acknowledgement is independently visible.
			const gate = db.insertQuestion("runner", "lead", "Decide", {
				checkpoint: "founder_review",
			});
			await assertAnswer();
			store.recordFounderAttentionReply({
				projectName,
				issueId,
				threadId: thread,
				messageId: "reply-to-gate",
				beforeMs: Date.now() + 1000,
			});
			await refresher.refresh(issueId);
			expect(titles.at(-1)).toBe("implement");
			expect(attentionAudience(await page(), true)).toEqual([]);
			expect(db.isQuestionPending(gate)).toBe(true);
			db.insertResponse(gate, "lead", "answer");
			ask("terminal", null);
			const holders = vi
				.spyOn(store, "listAttentionGateFacts")
				.mockReturnValue({
					facts: [
						{
							question_id: linked,
							execution_id: "runner",
							run_id: "run",
							node_id: "founder_gate",
							attempt: 1,
							kind: "founder_gate",
							state: "awaiting_review",
							authority_mode: "engine_terminal",
							since: now.toISOString(),
						},
					],
					rawCount: 1,
					truncated: false,
				} as never);
			await refresher.refresh(issueId);
			expect(titles.at(-1)).toBe("🔔 ⏳待批");
			expect(
				attentionAudience(await page(), true)[0]?.item.sources.map(
					(s) => s.fact.value?.kind,
				),
			).toEqual(["founder_gate"]);
			holders.mockRestore();
			for (const status of ["blocked", "completed", "approved_to_ship"]) {
				store.upsertSession({
					execution_id: "runner",
					issue_id: issueId,
					project_name: projectName,
					status,
				});
				await refresher.refresh(issueId);
				expect(titles.at(-1)).not.toBe("🔔要你答");
				expect(attentionAudience(await page(), true)).toEqual([]);
			}
		} finally {
			store.close();
			db.close();
			rmSync(dir, { recursive: true, force: true });
			vi.restoreAllMocks();
		}
	},
);
