import { beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../../../StateStore.js";

/**
 * FLY-314 (Codex design review R1#2): roundtable topic threads MUST be isolated
 * from issue-bound `chat_threads`. The reverse lookup `getChatThreadByThreadId`
 * (which feeds `/api/chat-threads/by-thread` and reply-guard's "issue-thread"
 * classification) must NOT see a roundtable thread id.
 */
describe("roundtable_topic_threads isolation", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("round-trips a roundtable topic thread", () => {
		store.upsertRoundtableTopicThread({
			threadId: "999",
			channelId: "rt",
			sourceMessageId: "999",
			authorId: "u1",
			triggerMode: "broadcast",
		});
		const row = store.getRoundtableTopicThread("rt", "999");
		expect(row?.thread_id).toBe("999");
		expect(row?.source_message_id).toBe("999");
		expect(row?.author_id).toBe("u1");
	});

	it("does NOT appear in chat_threads issue-thread reverse lookup", () => {
		store.upsertRoundtableTopicThread({
			threadId: "999",
			channelId: "rt",
			sourceMessageId: "999",
		});
		// The issue-thread reverse lookup (reply-guard / by-thread API) is blind to it.
		expect(store.getChatThreadByThreadId("999")).toBeUndefined();
	});

	it("is idempotent on thread_id", () => {
		store.upsertRoundtableTopicThread({
			threadId: "999",
			channelId: "rt",
			sourceMessageId: "999",
			triggerMode: "a",
		});
		store.upsertRoundtableTopicThread({
			threadId: "999",
			channelId: "rt",
			sourceMessageId: "999",
			triggerMode: "b",
		});
		expect(store.getRoundtableTopicThread("rt", "999")?.thread_id).toBe("999");
	});

	it("markRoundtableTopicThreadMissing hides it from dedup lookup", () => {
		store.upsertRoundtableTopicThread({
			threadId: "999",
			channelId: "rt",
			sourceMessageId: "999",
		});
		store.markRoundtableTopicThreadMissing("999");
		expect(store.getRoundtableTopicThread("rt", "999")).toBeUndefined();
	});
});
