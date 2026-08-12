import { describe, expect, it } from "vitest";
import { formatDeadLetterNotice } from "../dead-letter-format.js";

describe("FLY-1708 dead-letter wording", () => {
	it.each([
		[
			"routable runner",
			"runner-a",
			"StateStore 视图=alive / 最近心跳=2m（注意：此为登记视图非 pane 直读，处置前仍须人工验活）",
		],
		[
			"ownerless runner",
			"runner-b",
			"StateStore 视图=terminal / 最近心跳=45m（注意：此为登记视图非 pane 直读，处置前仍须人工验活）",
		],
		["Lead", "lead-a", undefined],
	] as const)(
		"states facts without inferring death for %s",
		(_kind, recipient, probeFacts) => {
			const text = formatDeadLetterNotice({
				recipient,
				count: 2,
				probeFacts,
				summaries: ["question from runner-a: hello"],
			});

			expect(text).toContain(`${recipient} 有 2 封信未签收。`);
			expect(text).toContain("未签收 ≠ 已下线");
			expect(text).toContain(
				probeFacts ? `探针实况：${probeFacts}` : "探针实况：不可得",
			);
			expect(text).toContain(
				"处置前必须先验活体（tmux pane 直读 + Bridge 心跳）",
			);
			expect(text).toContain("活着则不要动它");
			expect(text).not.toContain("可能已下线");
			expect(text).not.toContain("never acknowledged");
		},
	);
});
