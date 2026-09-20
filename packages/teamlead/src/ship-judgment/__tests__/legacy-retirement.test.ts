import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { reconcileShipJudgmentLegacyRetirement } from "../legacy-retirement.js";

it.each(["dry_run", "auto"] as const)(
	"retires known and uncertain old messages in %s without invoking old policy",
	async (mode) => {
		const rows = [
			{
				questionId: "known",
				threadId: "t",
				cardMessageId: "c",
				legacyMessageId: "m",
				legacyMarker: "auto-narrow-opinion:known",
				legacyState: "delivered",
				legacyPostingAt: "2026-09-18T07:00:00.000Z",
				status: "pending" as const,
				generation: 0,
				leaseOwner: null,
			},
			{
				questionId: "uncertain",
				threadId: "t",
				cardMessageId: "c",
				legacyMessageId: null,
				legacyMarker: "auto-narrow-opinion:uncertain",
				legacyState: "uncertain",
				legacyPostingAt: "2026-09-18T07:01:00.000Z",
				status: "pending" as const,
				generation: 0,
				leaseOwner: null,
			},
		];
		const finished = vi.fn(() => true);
		const result = await reconcileShipJudgmentLegacyRetirement({
			mode,
			owner: "retirer",
			now: () => "2026-09-18T16:30:00.000Z",
			store: {
				seedShipJudgmentLegacyRetirement: () => 0,
				listShipJudgmentLegacyRetirementWork: () => rows,
				claimShipJudgmentLegacyRetirement: ({ questionId }) => ({
					...rows.find((row) => row.questionId === questionId)!,
					status: "claimed",
					generation: 1,
					leaseOwner: "retirer",
				}),
				finishShipJudgmentLegacyRetirement: finished,
				deferShipJudgmentLegacyRetirement: () => true,
			},
			edit: vi.fn(async ({ content }) => ({ ok: !content.includes("闸①") })),
			scan: vi.fn(async () => ({
				kind: "found" as const,
				messageId: "recovered",
			})),
		});
		expect(result).toEqual({
			scanned: 2,
			retired: 2,
			unavailable: 0,
			deferred: 0,
		});
		expect(finished).toHaveBeenCalledTimes(2);
		expect(finished.mock.calls[1]?.[0]).toMatchObject({
			messageId: "recovered",
		});
	},
);

it("bounds the legacy message-author fetch so retirement cannot pin the poller", () => {
	const source = readFileSync(
		new URL("../../bridge/plugin.ts", import.meta.url),
		"utf8",
	);
	const resolver = source.slice(
		source.indexOf("const resolveLegacyMessageBotToken = async"),
		source.indexOf("const epicIntakeScheduler"),
	);
	expect(resolver).toMatch(
		/fetchDiscordMessageFromChannel\([\s\S]*?fetch,\s*AbortSignal\.timeout\(10_000\),?\s*\)/,
	);
});
