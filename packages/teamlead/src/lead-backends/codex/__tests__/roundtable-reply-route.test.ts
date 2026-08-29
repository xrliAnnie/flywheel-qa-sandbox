import { describe, expect, it } from "vitest";
import { RoundtableThreadRegistry } from "../RoundtableThreadRegistry.js";
import { resolveRoundtableReplyRoute } from "../roundtable-reply-route.js";

const PARENT = "roundtable-parent";

function ctx(
	over: Partial<Parameters<typeof resolveRoundtableReplyRoute>[1]> = {},
) {
	return {
		roundtableParentChannelId: PARENT,
		registry: new RoundtableThreadRegistry(),
		staticCrossDept: new Set<string>(),
		...over,
	};
}

describe("resolveRoundtableReplyRoute (FLY-314 Phase 2, ordered table R2#2)", () => {
	it("roundtable parent (fresh topic) → topic thread (== msg.id) + durable replyRoute with descriptive threadName", () => {
		const r = resolveRoundtableReplyRoute(
			{ id: "100", channelId: PARENT, content: "<@1> deploy plan sync" },
			ctx(),
		);
		expect(r.replyChannelId).toBe("100");
		expect(r.replyRoute).toEqual({
			kind: "roundtable_thread_from_message",
			parentChannelId: PARENT,
			sourceMessageId: "100",
			threadId: "100",
			// FLY-314 fix: correct-from-start name so creator 2 never leaves a placeholder.
			threadName: "deploy plan sync",
		});
	});

	// FLY-314 fix — Option B: a Discord follow-up in the roundtable parent must NOT
	// open a second thread. If the referenced topic thread is already known (registry),
	// route the reply INTO it synchronously (no replyRoute → no create/seed/subscribe);
	// otherwise fall back to the parent (accepted residual). Both carry NO replyRoute.
	it("follow-up + registry-KNOWN referenced thread → route INTO that thread, no replyRoute", () => {
		const registry = new RoundtableThreadRegistry();
		registry.add("100"); // the known topic thread (id == original topic message id)
		const r = resolveRoundtableReplyRoute(
			{
				id: "205",
				channelId: PARENT,
				content: "agreed, ship it",
				referencedMessageId: "100",
			},
			ctx({ registry }),
		);
		expect(r.replyChannelId).toBe("100"); // lands in the existing thread, not the parent
		expect(r.replyRoute).toBeUndefined(); // no create / no budget seed / no subscribe
	});

	it("noise (short ack / emoji even WITH a mention) → parent, no replyRoute (Codex R1 HIGH — no thread)", () => {
		for (const content of ["ok <@42>", "👍 <@42>", "🎉🎉"]) {
			const r = resolveRoundtableReplyRoute(
				{ id: "300", channelId: PARENT, content },
				ctx(),
			);
			expect(r.replyChannelId).toBe(PARENT);
			expect(r.replyRoute).toBeUndefined();
		}
	});

	it("follow-up + registry-UNKNOWN referenced thread → fall back to parent, no replyRoute (accepted residual)", () => {
		const r = resolveRoundtableReplyRoute(
			{
				id: "205",
				channelId: PARENT,
				content: "agreed",
				referencedMessageId: "999", // not in the registry
			},
			ctx(),
		);
		expect(r.replyChannelId).toBe(PARENT); // stays in the parent
		expect(r.replyRoute).toBeUndefined(); // never creates a thread for a follow-up
	});

	it("message inside a subscribed thread → reply back into that thread, NO ensure route", () => {
		const registry = new RoundtableThreadRegistry();
		registry.add("100"); // the topic thread (id == original message id)
		const r = resolveRoundtableReplyRoute(
			{ id: "205", channelId: "100" },
			ctx({ registry }),
		);
		expect(r.replyChannelId).toBe("100");
		expect(r.replyRoute).toBeUndefined();
	});

	it("OTHER static cross-dept channel → source channel (preserve FLY-267)", () => {
		const r = resolveRoundtableReplyRoute(
			{ id: "9", channelId: "other-shared" },
			ctx({ staticCrossDept: new Set(["other-shared"]) }),
		);
		expect(r.replyChannelId).toBe("other-shared");
		expect(r.replyRoute).toBeUndefined();
	});

	it("chat/core (unmatched) → undefined (default chat)", () => {
		const r = resolveRoundtableReplyRoute({ id: "9", channelId: "dm" }, ctx());
		expect(r.replyChannelId).toBeUndefined();
		expect(r.replyRoute).toBeUndefined();
	});

	it("two cross-dept channels: roundtable→msg.id, the other→msg.channelId (R2#2 sentinel)", () => {
		const c = ctx({ staticCrossDept: new Set(["other-shared"]) });
		expect(
			resolveRoundtableReplyRoute(
				{ id: "100", channelId: PARENT, content: "a real topic" },
				c,
			).replyChannelId,
		).toBe("100");
		expect(
			resolveRoundtableReplyRoute({ id: "7", channelId: "other-shared" }, c)
				.replyChannelId,
		).toBe("other-shared");
	});
});
