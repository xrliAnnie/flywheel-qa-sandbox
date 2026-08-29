import { describe, expect, it, vi } from "vitest";
import {
	checkReactionConfirmation,
	encodeReactionEmoji,
	extractReactorIds,
	FOUNDER_CONFIRM_EMOJI,
	founderReacted,
	isFounderTokenConfirmation,
	parseConfirmToken,
	type ReactionFetcher,
} from "../founder-confirmation.js";

const FOUNDER = "annie-discord-987";
const CHAN = "chan-1";

describe("founder-confirmation — reaction parsing (D-e)", () => {
	it("extractReactorIds pulls string ids, defensive on garbage", () => {
		expect(
			extractReactorIds([{ id: "a" }, { id: "b" }, { nope: 1 }, null, 7]),
		).toEqual(["a", "b"]);
		expect(extractReactorIds("not-array")).toEqual([]);
		expect(extractReactorIds(undefined)).toEqual([]);
	});

	it("founderReacted matches the exact founder id only", () => {
		expect(founderReacted(["x", FOUNDER], FOUNDER)).toBe(true);
		expect(founderReacted(["x", "y"], FOUNDER)).toBe(false);
		expect(founderReacted([FOUNDER], "")).toBe(false);
	});

	it("encodeReactionEmoji URL-encodes the emoji", () => {
		expect(encodeReactionEmoji(FOUNDER_CONFIRM_EMOJI)).toBe(
			encodeURIComponent("✅"),
		);
	});
});

describe("founder-confirmation — token path (D-e)", () => {
	it("parseConfirmToken matches exact `confirm <nonce>` (anchored, no fuzzy)", () => {
		expect(parseConfirmToken("confirm abc123")).toEqual({ nonce: "abc123" });
		expect(parseConfirmToken("  CONFIRM   xyz  ")).toEqual({ nonce: "xyz" });
		expect(parseConfirmToken("please confirm abc")).toBeNull();
		expect(parseConfirmToken("confirm")).toBeNull();
		expect(parseConfirmToken("yes do it")).toBeNull();
	});

	it("isFounderTokenConfirmation requires founder + channel + exact nonce", () => {
		const exp = { nonce: "N1", channelId: CHAN, founderId: FOUNDER };
		expect(
			isFounderTokenConfirmation(
				{ text: "confirm N1", authorId: FOUNDER, channelId: CHAN },
				exp,
			),
		).toBe(true);
		// wrong author
		expect(
			isFounderTokenConfirmation(
				{ text: "confirm N1", authorId: "impostor", channelId: CHAN },
				exp,
			),
		).toBe(false);
		// wrong channel
		expect(
			isFounderTokenConfirmation(
				{ text: "confirm N1", authorId: FOUNDER, channelId: "other" },
				exp,
			),
		).toBe(false);
		// wrong nonce
		expect(
			isFounderTokenConfirmation(
				{ text: "confirm N2", authorId: FOUNDER, channelId: CHAN },
				exp,
			),
		).toBe(false);
	});
});

describe("checkReactionConfirmation — fail-closed on every error (D-e/R1#11)", () => {
	const mkFetcher = (res: {
		status: number;
		body?: unknown;
		throws?: boolean;
	}): ReactionFetcher =>
		vi.fn(async () => {
			if (res.throws) throw new Error("network down");
			return { status: res.status, body: res.body };
		});

	it("confirmed when the founder's id is among the reactors", async () => {
		const f = mkFetcher({ status: 200, body: [{ id: "x" }, { id: FOUNDER }] });
		expect(
			await checkReactionConfirmation(f, {
				channelId: CHAN,
				messageId: "m1",
				founderId: FOUNDER,
			}),
		).toEqual({ confirmed: true, reason: "confirmed" });
	});

	it("not_yet when the founder has not reacted", async () => {
		const f = mkFetcher({ status: 200, body: [{ id: "someone" }] });
		expect(
			(
				await checkReactionConfirmation(f, {
					channelId: CHAN,
					messageId: "m1",
					founderId: FOUNDER,
				})
			).reason,
		).toBe("not_yet");
	});

	it("rate_limited (429) → NON-approval", async () => {
		const f = mkFetcher({ status: 429 });
		const r = await checkReactionConfirmation(f, {
			channelId: CHAN,
			messageId: "m1",
			founderId: FOUNDER,
		});
		expect(r.confirmed).toBe(false);
		expect(r.reason).toBe("rate_limited");
	});

	it("403/404/5xx → NON-approval (http_error)", async () => {
		for (const status of [403, 404, 500]) {
			const r = await checkReactionConfirmation(mkFetcher({ status }), {
				channelId: CHAN,
				messageId: "m1",
				founderId: FOUNDER,
			});
			expect(r).toEqual({ confirmed: false, reason: "http_error" });
		}
	});

	it("a thrown fetch → NON-approval", async () => {
		const r = await checkReactionConfirmation(
			mkFetcher({ status: 0, throws: true }),
			{
				channelId: CHAN,
				messageId: "m1",
				founderId: FOUNDER,
			},
		);
		expect(r).toEqual({ confirmed: false, reason: "http_error" });
	});

	it("malformed body (200 but not an array) → NON-approval", async () => {
		const r = await checkReactionConfirmation(
			mkFetcher({ status: 200, body: { not: "an array" } }),
			{ channelId: CHAN, messageId: "m1", founderId: FOUNDER },
		);
		expect(r).toEqual({ confirmed: false, reason: "malformed" });
	});

	// Codex code-review R1 LOW-10: pagination — the founder hidden beyond page 1.
	it("paginates: founder on page 2 (full page 1 of non-founder reactors) → confirmed", async () => {
		const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `u${i}` }));
		const page2 = [{ id: "u100" }, { id: FOUNDER }];
		const fetcher: ReactionFetcher = vi.fn(async ({ after }) => ({
			status: 200,
			body: after ? page2 : page1,
		}));
		const r = await checkReactionConfirmation(fetcher, {
			channelId: CHAN,
			messageId: "m1",
			founderId: FOUNDER,
		});
		expect(r).toEqual({ confirmed: true, reason: "confirmed" });
		expect(fetcher).toHaveBeenCalledTimes(2);
		// page 2 fetched with the last reactor id of page 1 as the cursor
		expect((fetcher as ReturnType<typeof vi.fn>).mock.calls[1][0].after).toBe(
			"u99",
		);
	});

	it("an error on page 2 is NON-approval (pagination error never approves)", async () => {
		const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `u${i}` }));
		const fetcher: ReactionFetcher = vi.fn(async ({ after }) =>
			after ? { status: 500 } : { status: 200, body: page1 },
		);
		const r = await checkReactionConfirmation(fetcher, {
			channelId: CHAN,
			messageId: "m1",
			founderId: FOUNDER,
		});
		expect(r).toEqual({ confirmed: false, reason: "http_error" });
	});

	it("stops at a short page (no founder) → not_yet (no infinite loop)", async () => {
		const fetcher: ReactionFetcher = vi.fn(async () => ({
			status: 200,
			body: [{ id: "someone" }],
		}));
		const r = await checkReactionConfirmation(fetcher, {
			channelId: CHAN,
			messageId: "m1",
			founderId: FOUNDER,
		});
		expect(r.reason).toBe("not_yet");
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
});
