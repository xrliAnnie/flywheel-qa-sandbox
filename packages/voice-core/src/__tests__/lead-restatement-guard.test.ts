import { describe, expect, it, vi } from "vitest";
import { LeadRestatementGuard } from "../backends/openai-live/LeadRestatementGuard.js";

describe("LeadRestatementGuard", () => {
	it("detects normalized exact/contained Lead text without relabeling it", async () => {
		const guard = new LeadRestatementGuard();
		guard.remember({
			resultEventId: "result-1",
			text: "已完成 FLY-2798 的门铃修复。",
		});

		await expect(
			guard.inspect("我补充一下：已完成 FLY-2798 的门铃修复！", {
				hasNewUserRestatementRequest: false,
			}),
		).resolves.toEqual({
			code: "unsolicited_lead_restatement",
			match: "contained",
			resultEventId: "result-1",
		});
	});

	it("uses an injected semantic check for paraphrases and skips it after a match", async () => {
		const semanticDuplicate = vi.fn(async () => true);
		const guard = new LeadRestatementGuard({ semanticDuplicate });
		guard.remember({
			resultEventId: "result-2",
			text: "Lead says the migration is finished and the service is healthy.",
		});

		await expect(
			guard.inspect(
				"The backend reports a successful migration with normal health.",
				{
					hasNewUserRestatementRequest: false,
				},
			),
		).resolves.toEqual({
			code: "unsolicited_lead_restatement",
			match: "semantic",
			resultEventId: "result-2",
		});
		expect(semanticDuplicate).toHaveBeenCalledOnce();

		await guard.inspect(
			"Lead says the migration is finished and the service is healthy.",
			{
				hasNewUserRestatementRequest: false,
			},
		);
		expect(semanticDuplicate).toHaveBeenCalledOnce();
	});

	it("flags shared critical identifiers but permits an explicit user readback", async () => {
		const guard = new LeadRestatementGuard();
		guard.remember({
			resultEventId: "result-3",
			text: "The authoritative result is PR #1305 at commit 313befcfa.",
		});

		await expect(
			guard.inspect("Frontend status: commit 313befcfa is ready.", {
				hasNewUserRestatementRequest: false,
			}),
		).resolves.toMatchObject({
			code: "unsolicited_lead_restatement",
			match: "critical_identifier",
		});
		await expect(
			guard.inspect("Frontend status: commit 313befcfa is ready.", {
				hasNewUserRestatementRequest: true,
			}),
		).resolves.toBeNull();
	});

	it("bounds recent Lead text and ignores unrelated frontend output", async () => {
		const guard = new LeadRestatementGuard({ maxRecentResults: 1 });
		guard.remember({ resultEventId: "old", text: "Old canonical sentence." });
		guard.remember({ resultEventId: "new", text: "New canonical sentence." });

		await expect(
			guard.inspect("Old canonical sentence.", {
				hasNewUserRestatementRequest: false,
			}),
		).resolves.toBeNull();
		await expect(
			guard.inspect("A simple unrelated answer.", {
				hasNewUserRestatementRequest: false,
			}),
		).resolves.toBeNull();
	});
});
