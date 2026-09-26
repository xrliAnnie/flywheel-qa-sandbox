import { describe, expect, it } from "vitest";
import {
	extractProtectedTokens,
	repairSpokenScript,
	validateSpokenScript,
} from "../codex/SpokenScript.js";

const source = (itemId: string, text: string) => ({ itemId, text });

describe("spoken script protected-field fidelity", () => {
	it("accepts a conversational paraphrase when every protected field has source evidence", () => {
		const result = validateSpokenScript({
			spoken: "2886这单现在是PR #1326，Tadashi在20:19更新过，提交是a1b2c3d。",
			sources: [
				source(
					"tool-1",
					"FLY-2886 status: PR #1326; owner Tadashi; updated 20:19; head a1b2c3d.",
				),
			],
			rosterNames: ["Tadashi"],
		});

		expect(result).toMatchObject({ ok: true });
		if (result.ok) {
			expect(result.evidence.map((entry) => entry.token)).toEqual([
				"PR #1326",
				"a1b2c3d",
				"2886",
				"1326",
				"20:19",
				"Tadashi",
			]);
			expect(
				result.evidence.every((entry) => entry.sourceItemId === "tool-1"),
			).toBe(true);
		}
	});

	it("rejects the circular-source counterexample instead of trusting the answer itself", () => {
		const result = validateSpokenScript({
			spoken: "FLY-9999 现在在 PR #9876。",
			sources: [source("tool-1", "FLY-2886 is on PR #2886")],
			rosterNames: [],
		});

		expect(result).toMatchObject({
			ok: false,
			unsupported: expect.arrayContaining([
				expect.objectContaining({ token: "FLY-9999", kind: "issue" }),
				expect.objectContaining({ token: "PR #9876", kind: "pull_request" }),
			]),
		});
	});

	it("uses complete-token boundaries for issue ids and numbers", () => {
		const result = validateSpokenScript({
			spoken: "是 FLY-28，数量 12。",
			sources: [source("tool-1", "是 FLY-2886，数量 312。")],
			rosterNames: [],
		});

		expect(result).toMatchObject({
			ok: false,
			unsupported: expect.arrayContaining([
				expect.objectContaining({ token: "FLY-28" }),
				expect.objectContaining({ token: "12" }),
			]),
		});
	});

	it("normalizes only case and full-width forms for matching", () => {
		const result = validateSpokenScript({
			spoken: "ｆｌｙ－２８８６ 是 PR ＃１３２６。",
			sources: [source("tool-1", "FLY-2886 is PR #1326")],
			rosterNames: [],
		});

		expect(result).toMatchObject({ ok: true });
	});

	it("treats roster names as protected and rejects an unsupported person", () => {
		const result = validateSpokenScript({
			spoken: "Tadashi说已经好了。",
			sources: [source("tool-1", "任务已经好了。")],
			rosterNames: ["Tadashi", "Annie"],
		});

		expect(result).toMatchObject({
			ok: false,
			unsupported: [
				expect.objectContaining({ token: "Tadashi", kind: "name" }),
			],
		});
	});

	it("requires source issue and PR ids in rewrite mode unless the script ends with the approved thread pointer", () => {
		const input = {
			sources: [source("lead-original", "FLY-2886 is on PR #1326")],
			rosterNames: [] as string[],
			mode: "rewrite" as const,
		};
		expect(
			validateSpokenScript({ ...input, spoken: "这件已经处理好了。" }),
		).toMatchObject({
			ok: false,
			missingRequired: expect.arrayContaining([
				expect.objectContaining({ token: "FLY-2886" }),
				expect.objectContaining({ token: "PR #1326" }),
			]),
		});
		expect(
			validateSpokenScript({
				...input,
				spoken: "这条我发到 thread 了，编号以文字为准。",
			}),
		).toMatchObject({ ok: true, usedThreadPointer: true });
	});

	it("extracts commit hashes only when the token contains both letters and digits", () => {
		expect(extractProtectedTokens("head deadbe1，数字 1234567。", [])).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ token: "deadbe1", kind: "commit" }),
				expect.objectContaining({ token: "1234567", kind: "number" }),
			]),
		);
		expect(
			extractProtectedTokens("head deadbe1，数字 1234567。", []).filter(
				(token) => token.kind === "commit",
			),
		).toHaveLength(1);
	});
});

// FLY-2886 (Lead 1c8019f8, founder 2026-09-26 12:19 PDT): paraphrase freely;
// only key facts (ids, numbers, names, times, yes/no outcomes) must match the
// source, and a mismatch drops that whole sentence instead of truncating.
describe("key-fact guard for free paraphrase", () => {
	it("passes a free paraphrase that keeps every key fact", () => {
		const result = validateSpokenScript({
			spoken:
				"2886 那张单的 PR #1360 已经合进去了，CI 都过了，Tadashi 20:19 确认的。",
			sources: [
				source(
					"lead",
					"FLY-2886 的 PR #1360 CI 全绿，已经合并了，Tadashi 20:19 确认的。",
				),
			],
			rosterNames: ["Tadashi"],
		});
		expect(result).toMatchObject({ ok: true });
	});

	it("catches a paraphrase that flips a yes/no outcome", () => {
		const result = validateSpokenScript({
			spoken: "PR #1360 的 CI 通过了。",
			sources: [source("lead", "PR #1360 的 CI 没通过，卡在 lint。")],
			rosterNames: [],
		});
		expect(result).toMatchObject({
			ok: false,
			unsupported: [{ kind: "outcome", token: "positive" }],
		});
		// Negation is read before the bare word: 没过 matches 没通过.
		expect(
			validateSpokenScript({
				spoken: "PR #1360 的 CI 没过。",
				sources: [source("lead", "PR #1360 的 CI 没通过，卡在 lint。")],
				rosterNames: [],
			}),
		).toMatchObject({ ok: true });
	});

	it("catches a paraphrase that changes a PR number or a time", () => {
		for (const spoken of ["PR #1361 已经合并了。", "20:30 合并的。"])
			expect(
				validateSpokenScript({
					spoken,
					sources: [source("lead", "PR #1360 已经合并了，20:19 合并的。")],
					rosterNames: [],
				}).ok,
			).toBe(false);
	});

	it("drops only the sentence with a wrong key fact, keeps whole sentences, and points to the thread", () => {
		const repaired = repairSpokenScript({
			spoken: "PR #1361 已经合并了。CI 都过了！",
			sources: [source("lead", "PR #1360 已经合并了，CI 全绿。")],
			rosterNames: [],
		});
		expect(repaired).toEqual({
			spoken: "CI 都过了！这条我发到 thread 了，编号以文字为准。",
			droppedSentences: ["PR #1361 已经合并了。"],
			needsThread: true,
		});
		expect(
			validateSpokenScript({
				spoken: repaired.spoken,
				sources: [source("lead", "PR #1360 已经合并了，CI 全绿。")],
				rosterNames: [],
				mode: "rewrite",
			}).ok,
		).toBe(true);
	});

	it("leaves a fully supported paraphrase untouched", () => {
		expect(
			repairSpokenScript({
				spoken: "PR #1360 合并了，CI 也过了。",
				sources: [source("lead", "PR #1360 已经合并了，CI 全绿。")],
				rosterNames: [],
				mode: "rewrite",
			}),
		).toEqual({
			spoken: "PR #1360 合并了，CI 也过了。",
			droppedSentences: [],
			needsThread: false,
		});
	});

	it("points to the thread when a required id was left out rather than guessing", () => {
		const repaired = repairSpokenScript({
			spoken: "那个 PR 合并了。",
			sources: [source("lead", "PR #1360 已经合并了。")],
			rosterNames: [],
			mode: "rewrite",
		});
		expect(repaired.needsThread).toBe(true);
		expect(repaired.spoken).toBe(
			"那个 PR 合并了。这条我发到 thread 了，编号以文字为准。",
		);
	});
});

// Review b5bc5d89 advisory: time phrases are not outcomes.
it("does not read 过了十分钟 / 没过多久 as a yes/no outcome", () => {
	expect(
		extractProtectedTokens("过了 10 分钟 CI 还红着", []).filter(
			(token) => token.kind === "outcome",
		),
	).toEqual([{ kind: "outcome", token: "negative" }]);
	expect(
		validateSpokenScript({
			spoken: "CI 过了。",
			sources: [source("lead", "过了 10 分钟 CI 还红着")],
			rosterNames: [],
		}).ok,
	).toBe(false);
	expect(
		extractProtectedTokens("没过多久他就回复了", []).filter(
			(token) => token.kind === "outcome",
		),
	).toEqual([]);
});
