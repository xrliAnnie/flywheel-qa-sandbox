import { describe, expect, it } from "vitest";
import {
	APPROVE_INTENT,
	CONFIRM,
	DENY,
	matchPhrase,
	OPEN_WORD,
	PAUSE,
	REPLY,
	SKIP,
	STOP_WORD,
} from "../headphone/phrases.js";

describe("matchPhrase — exact normalized matching, never substring", () => {
	it("matches the stop word exactly", () => {
		expect(matchPhrase("芝麻关门", STOP_WORD)).toBe(true);
	});

	it("normalizes trailing punctuation and surrounding whitespace", () => {
		expect(matchPhrase("芝麻关门。", STOP_WORD)).toBe(true);
		expect(matchPhrase(" 芝麻关门 ", STOP_WORD)).toBe(true);
		expect(matchPhrase("芝麻关门!", STOP_WORD)).toBe(true);
	});

	it("does NOT match when the phrase is embedded in a longer sentence", () => {
		expect(matchPhrase("帮我把芝麻关门那个改了", STOP_WORD)).toBe(false);
		expect(matchPhrase("芝麻关门的事待会说", STOP_WORD)).toBe(false);
	});

	it("open word accepts both spoken and slash forms", () => {
		expect(matchPhrase("芝麻开门", OPEN_WORD)).toBe(true);
		expect(matchPhrase("/headphone on", OPEN_WORD)).toBe(true);
	});

	it("ascii phrases match case-insensitively", () => {
		expect(matchPhrase("SKIP", SKIP)).toBe(true);
		expect(matchPhrase("Skip", SKIP)).toBe(true);
	});

	it("full-width forms normalize via NFKC", () => {
		expect(matchPhrase("ｓｋｉｐ", SKIP)).toBe(true);
	});

	it("disposition word sets carry the §17 vocabulary", () => {
		for (const w of ["不用", "跳过", "下一条"]) {
			expect(matchPhrase(w, SKIP)).toBe(true);
		}
		for (const w of ["要回", "回复"]) {
			expect(matchPhrase(w, REPLY)).toBe(true);
		}
		for (const w of ["确认", "对"]) {
			expect(matchPhrase(w, CONFIRM)).toBe(true);
		}
		for (const w of ["不对", "取消", "不批"]) {
			expect(matchPhrase(w, DENY)).toBe(true);
		}
		for (const w of ["ship 吧", "批准", "可以 ship", "发布吧"]) {
			expect(matchPhrase(w, APPROVE_INTENT)).toBe(true);
		}
		for (const w of ["暂停", "待会", "先停一下"]) {
			expect(matchPhrase(w, PAUSE)).toBe(true);
		}
	});

	it("collapses internal whitespace so 'ship  吧' still matches", () => {
		expect(matchPhrase("ship  吧", APPROVE_INTENT)).toBe(true);
	});

	it("empty / punctuation-only input never matches", () => {
		expect(matchPhrase("", SKIP)).toBe(false);
		expect(matchPhrase("。。。", SKIP)).toBe(false);
	});

	it("word sets are plain arrays a daemon config can override", () => {
		expect(matchPhrase("好的批吧", ["好的批吧"])).toBe(true);
	});
});
