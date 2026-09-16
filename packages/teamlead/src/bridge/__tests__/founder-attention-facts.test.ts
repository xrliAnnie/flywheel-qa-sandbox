import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import { founderAttentionLevel } from "../founder-attention.js";
import { readFounderAttentionFacts } from "../founder-attention-facts.js";

it("reads standalone and relayed asks from durable facts; answered or settled asks disappear", async () => {
	const dir = mkdtempSync(join(tmpdir(), "founder-facts-"));
	const path = join(dir, "comm.db");
	const db = new CommDB(path);
	const store = await StateStore.create(":memory:");
	try {
		const question = db.insertQuestion(
			"runner",
			"lead",
			"@founder is not a marker",
		);
		const base = {
			project_name: "example",
			issue_id: "issue",
			channel_id: "channel",
			thread_id: "thread",
			lead_id: "lead",
			excerpt: "Pick an option",
			asked_at: "2026-09-15T22:00:00.000Z",
		};
		store.insertFounderAsk({
			...base,
			ask_id: "standalone",
			question_id: null,
		});
		store.backfillFounderAskMessage("standalone", "message-1");
		store.insertFounderAsk({ ...base, ask_id: "relay", question_id: question });
		store.backfillFounderAskMessage("relay", "message-2");
		store.insertFounderAsk({ ...base, ask_id: "unsent", question_id: null });
		const read = () =>
			readFounderAttentionFacts(
				{
					stateStore: store,
					openCommReadonly: () => CommDB.openReadonly(path),
				},
				{ projectName: "example", now: new Date("2026-09-15T22:01:00.000Z") },
			);
		const asks = () =>
			read().pending.filter((p) => p.source.fact.value?.kind === "founder_ask");
		expect(asks().map((p) => p.key)).toEqual(["ask:relay", "ask:standalone"]);
		expect(read().reads.gates.value).toEqual({ count: 2 });
		expect(
			founderAttentionLevel(asks().map((p) => p.source.fact.value!.kind)),
		).toBe("answer");
		db.insertResponse(question, "lead", "answered");
		expect(asks().map((p) => p.key)).toEqual(["ask:standalone"]);
		store.settleFounderAsksByThread({
			threadId: "thread",
			beforeMs: Date.parse("2026-09-15T22:01:00.000Z"),
			messageId: "founder-reply",
		});
		expect(asks()).toEqual([]);
	} finally {
		store.close();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it.each(["TEST-1", "12345678-1234-4123-8123-123456789abc"])(
	"extinguishes a legacy gate after a durable reply on alias %s without answering it",
	async (replyAlias) => {
		const dir = mkdtempSync(join(tmpdir(), "founder-legacy-"));
		const path = join(dir, "comm.db");
		const db = new CommDB(path);
		const store = await StateStore.create(":memory:");
		try {
			store.upsertSession({
				execution_id: "runner",
				issue_id: "TEST-1",
				issue_identifier: "TEST-1",
				project_name: "example",
				status: "running",
			});
			store.upsertSession({
				execution_id: "uuid-runner",
				issue_id: "12345678-1234-4123-8123-123456789abc",
				issue_identifier: "TEST-1",
				project_name: "example",
				status: "running",
			});
			const question = db.insertQuestion("runner", "lead", "Please decide", {
				checkpoint: "founder_review",
			});
			const read = () =>
				readFounderAttentionFacts(
					{
						stateStore: store,
						openCommReadonly: () => CommDB.openReadonly(path),
					},
					{ projectName: "example", now: new Date() },
				);
			expect(
				read().pending.find((p) => p.key === `question:${question}`)?.source
					.fact.value?.kind,
			).toBe("legacy_founder_gate");
			store.recordFounderAttentionReply({
				projectName: "example",
				issueId: replyAlias,
				threadId: "thread",
				messageId: "reply",
				beforeMs: Date.now() + 1000,
			});
			expect(
				read().pending.find((p) => p.key === `question:${question}`),
			).toBeUndefined();
			expect(db.isQuestionPending(question)).toBe(true);
		} finally {
			store.close();
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

it("projects the same effective level for page and title, and fails closed on unavailable facts", async () => {
	const store = await StateStore.create(":memory:");
	try {
		const { readEffectiveFounderAttention } = await import(
			"../founder-attention-facts.js"
		);
		store.upsertSession({
			execution_id: "runner",
			issue_id: "issue",
			project_name: "example",
			status: "running",
			session_stage: "implement",
		});
		store.insertFounderAsk({
			ask_id: "ask",
			project_name: "example",
			issue_id: "issue",
			channel_id: "channel",
			thread_id: "thread",
			lead_id: "lead",
			question_id: null,
			excerpt: "Decide",
			asked_at: new Date().toISOString(),
		});
		store.backfillFounderAskMessage("ask", "message");
		const facts = readFounderAttentionFacts(
			{
				stateStore: store,
				openCommReadonly: () => ({
					listAttentionQuestions: () => ({
						questions: [],
						rawCount: 0,
						nextCursor: null,
					}),
					isQuestionPending: () => true,
					close: () => {},
				}),
			},
			{ projectName: "example", now: new Date() },
		);
		expect(readEffectiveFounderAttention(store, facts, "issue")).toMatchObject({
			available: true,
			level: "answer",
		});
		store.upsertSession({
			execution_id: "runner",
			issue_id: "issue",
			project_name: "example",
			status: "completed",
		});
		expect(readEffectiveFounderAttention(store, facts, "issue")).toMatchObject({
			available: true,
			level: null,
		});
		const unavailable = readFounderAttentionFacts(
			{
				stateStore: store,
				openCommReadonly: () => {
					throw new Error("unavailable");
				},
			},
			{ projectName: "example", now: new Date() },
		);
		expect(
			readEffectiveFounderAttention(store, unavailable, "issue"),
		).toMatchObject({ available: false });
	} finally {
		store.close();
	}
});
