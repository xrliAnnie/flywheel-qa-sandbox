import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const stores: StateStore[] = [];
afterEach(() => {
	for (const s of stores.splice(0)) s.close();
});
async function fixture() {
	const s = await StateStore.create(":memory:");
	stores.push(s);
	return s;
}
function db(s: StateStore) {
	return (s as unknown as { db: { raw: Database.Database } }).db.raw;
}
const uuid = "12345678-1234-4234-9234-123456789012";
function session(
	s: StateStore,
	exec = "exec",
	project = "flywheel",
	id = uuid,
) {
	db(s)
		.prepare(
			"INSERT INTO sessions(execution_id,issue_id,issue_identifier,project_name,status) VALUES(?,?, 'FLY-2483',?,'completed')",
		)
		.run(exec, id, project);
}
describe("StateStore attention identity", () => {
	it("uses exact ship card event issue and validates its bound thread channel", async () => {
		const s = await fixture();
		session(s);
		s.upsertChatThread("100", "20", "card-issue");
		s.insertEvent({
			event_id: "binding",
			execution_id: "exec",
			issue_id: "card-issue",
			project_name: "flywheel",
			event_type: "ship_gate_msg_binding",
			source: "test",
			payload: {
				questionId: "q",
				executionId: "exec",
				issueId: "card-issue",
				threadId: "100",
				prHeadSha: "a".repeat(40),
			},
		});
		expect(
			s.resolveAttentionQuestionIdentity("flywheel", "q", "exec"),
		).toMatchObject({
			status: "resolved",
			issue_id: "card-issue",
			channel_id: "20",
		});
	});

	it("resolves ended same-project session without parsing question content", async () => {
		const s = await fixture();
		session(s);
		expect(
			s.resolveAttentionQuestionIdentity("flywheel", "question", "exec"),
		).toMatchObject({
			status: "resolved",
			issue_id: uuid,
			identifier: "FLY-2483",
			aliases: [uuid, "FLY-2483"],
		});
		expect(
			s.resolveAttentionQuestionIdentity("other", "question", "exec"),
		).toEqual({ status: "unknown" });
	});
	it("exact founder card binds the run before a reused execution session", async () => {
		const s = await fixture();
		session(s);
		s.createWorkflowRun({
			runId: "run",
			issueId: "other-issue",
			projectName: "flywheel",
		});
		db(s)
			.prepare(
				"INSERT INTO founder_review_card_binding VALUES ('question','message','run',?,'2026-09-09')",
			)
			.run("a".repeat(64));
		expect(
			s.resolveAttentionQuestionIdentity("flywheel", "question", "exec"),
		).toMatchObject({
			status: "resolved",
			issue_id: "other-issue",
			run_id: "run",
		});
	});
	it("rejects conflicting session aliases instead of choosing the newest", async () => {
		const s = await fixture();
		session(s);
		session(s, "second", "flywheel", "22345678-1234-4234-9234-123456789012");
		expect(
			s.resolveAttentionQuestionIdentity("flywheel", "question", "exec"),
		).toEqual({ status: "conflict" });
	});
	it("resolves one workflow binding but refuses multiple activations", async () => {
		const s = await fixture();
		s.createWorkflowRun({
			runId: "run",
			issueId: uuid,
			projectName: "flywheel",
		});
		db(s).exec("PRAGMA foreign_keys=OFF");
		db(s)
			.prepare(
				"INSERT INTO workflow_execution_binding(activation_id,execution_id,run_id,node_id,attempt,mode,bound_at) VALUES('a','exec','run','implement',1,'spawn','2026-09-09')",
			)
			.run();
		expect(
			s.resolveAttentionQuestionIdentity("flywheel", "q", "exec"),
		).toMatchObject({ status: "resolved", issue_id: uuid });
		db(s)
			.prepare(
				"INSERT INTO workflow_execution_binding(activation_id,execution_id,run_id,node_id,attempt,mode,bound_at) VALUES('b','exec','run','qa',1,'wake','2026-09-09')",
			)
			.run();
		expect(s.resolveAttentionQuestionIdentity("flywheel", "q", "exec")).toEqual(
			{ status: "conflict" },
		);
	});
});
describe("StateStore attention thread binding", () => {
	const input = {
		projectName: "flywheel",
		aliases: [uuid, "FLY-2483"],
		channelIds: ["10", "20"],
	};
	it("searches every configured channel and alias, ignoring lead name and archive marker", async () => {
		const s = await fixture();
		s.upsertChatThread("100", "20", "FLY-2483", "arbitrary-lead");
		db(s).exec("UPDATE chat_threads SET archived_at='2026-09-01'");
		expect(s.resolveAttentionThreadBinding(input)).toEqual({
			status: "resolved",
			thread_id: "100",
			channel_id: "20",
		});
		expect(
			s.resolveAttentionThreadBinding({ ...input, channelIds: ["10"] }),
		).toEqual({ status: "no_thread_binding" });
	});
	it("conflicting aliases/channels disable unless an exact authoritative channel resolves uniquely", async () => {
		const s = await fixture();
		s.upsertChatThread("100", "10", uuid);
		s.upsertChatThread("200", "20", "FLY-2483");
		expect(s.resolveAttentionThreadBinding(input)).toEqual({
			status: "thread_binding_conflict",
		});
		expect(
			s.resolveAttentionThreadBinding({
				...input,
				authoritativeChannelId: "20",
			}),
		).toEqual({ status: "resolved", thread_id: "200", channel_id: "20" });
		s.upsertChatThread("300", "20", uuid);
		expect(
			s.resolveAttentionThreadBinding({
				...input,
				authoritativeChannelId: "20",
			}),
		).toEqual({ status: "thread_binding_conflict" });
	});
	it("fails closed for absent identity, foreign channel, missing thread and malformed ID", async () => {
		const s = await fixture();
		expect(s.resolveAttentionThreadBinding({ ...input, aliases: [] })).toEqual({
			status: "issue_identity_unknown",
		});
		expect(
			s.resolveAttentionThreadBinding({
				...input,
				authoritativeChannelId: "30",
			}),
		).toEqual({ status: "no_thread_binding" });
		s.upsertChatThread("100", "10", uuid);
		db(s).exec("UPDATE chat_threads SET discord_missing_at='2026-09-09'");
		expect(s.resolveAttentionThreadBinding(input)).toEqual({
			status: "thread_missing",
		});
		db(s).exec(
			"UPDATE chat_threads SET discord_missing_at=NULL,thread_id='@me'",
		);
		expect(s.resolveAttentionThreadBinding(input)).toEqual({
			status: "invalid_discord_id",
		});
	});
});
