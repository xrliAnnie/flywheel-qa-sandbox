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
	it("roundtable parent → topic thread (== msg.id) + durable replyRoute", () => {
		const r = resolveRoundtableReplyRoute(
			{ id: "100", channelId: PARENT },
			ctx(),
		);
		expect(r.replyChannelId).toBe("100");
		expect(r.replyRoute).toEqual({
			kind: "roundtable_thread_from_message",
			parentChannelId: PARENT,
			sourceMessageId: "100",
			threadId: "100",
		});
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
			resolveRoundtableReplyRoute({ id: "100", channelId: PARENT }, c)
				.replyChannelId,
		).toBe("100");
		expect(
			resolveRoundtableReplyRoute({ id: "7", channelId: "other-shared" }, c)
				.replyChannelId,
		).toBe("other-shared");
	});
});
