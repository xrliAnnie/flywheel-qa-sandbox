import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	CODEX_READING_STALE_AFTER_MS,
	codexReadingFreshness,
} from "../bin/codex-account-core.mjs";

interface FreshnessVector {
	name: string;
	nowMs: number | "NaN" | "Infinity";
	staleAfterMs?: number | "NaN" | "Infinity";
	reading: Parameters<typeof codexReadingFreshness>[0];
	expected: ReturnType<typeof codexReadingFreshness>;
}

const VECTORS = JSON.parse(
	readFileSync(
		new URL(
			"../../../scripts/__tests__/fixtures/codex-reading-freshness-vectors.json",
			import.meta.url,
		),
		"utf8",
	),
) as FreshnessVector[];

const number = (value: number | "NaN" | "Infinity" | undefined) =>
	value === "NaN" ? Number.NaN : value === "Infinity" ? Infinity : value;

describe("FLY-2869 — shared Codex reading freshness", () => {
	it("uses a thirty-minute default threshold", () => {
		expect(CODEX_READING_STALE_AFTER_MS).toBe(30 * 60_000);
	});

	it.each(VECTORS)("$name", (vector) => {
		const staleAfterMs = number(vector.staleAfterMs);
		expect(
			staleAfterMs === undefined
				? codexReadingFreshness(vector.reading, number(vector.nowMs)!)
				: codexReadingFreshness(
						vector.reading,
						number(vector.nowMs)!,
						staleAfterMs,
					),
		).toBe(vector.expected);
	});
});
