import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	classifyRecipientLiveness,
	type LivenessEvidence,
} from "../bridge/delivery-contract/liveness.js";
import { parseSqliteUtcMs } from "../bridge/founder-notify-utils.js";

const nowMs = Date.parse("2026-09-03T14:00:00.000Z");
const windowMs = 10 * 60_000;

describe("FLY-2278 recipient liveness", () => {
	it.each([
		{
			name: "has no evidence",
			evidence: {
				heartbeatAtMs: null,
				lastActivityAtMs: null,
				recentOutboundInWindow: false,
				observedAtMs: nowMs,
			},
			expected: "unknown",
		},
		{
			name: "has a fresh activity timestamp with a null heartbeat",
			evidence: {
				heartbeatAtMs: null,
				lastActivityAtMs: nowMs - 60_000,
				recentOutboundInWindow: false,
				observedAtMs: nowMs,
			},
			expected: "alive",
		},
		{
			name: "has only stale timestamp evidence",
			evidence: {
				heartbeatAtMs: nowMs - windowMs - 1,
				lastActivityAtMs: null,
				recentOutboundInWindow: false,
				observedAtMs: nowMs,
			},
			expected: "absent",
		},
		{
			name: "has recent outbound traffic despite stale timestamps",
			evidence: {
				heartbeatAtMs: nowMs - windowMs - 1,
				lastActivityAtMs: nowMs - windowMs - 2,
				recentOutboundInWindow: true,
				observedAtMs: nowMs,
			},
			expected: "alive",
		},
	] as Array<{
		name: string;
		evidence: LivenessEvidence;
		expected: "alive" | "absent" | "unknown";
	}>)("classifies $name", ({ evidence, expected }) => {
		expect(classifyRecipientLiveness(evidence, nowMs, windowMs)).toBe(expected);
	});

	it.each([
		["2026-09-03 14:00:00", nowMs],
		["2026-09-03T14:00:00.000Z", nowMs],
		["2026-09-03T07:00:00.000-07:00", nowMs],
		[null, null],
		["not-a-time", null],
	])("parses %s without manufacturing NaN", (value, expected) => {
		expect(parseSqliteUtcMs(value)).toBe(expected);
	});

	it("filters nullable stamps before its only Math.max and imports no stale parser", () => {
		const source = readFileSync(
			resolve(process.cwd(), "src/bridge/delivery-contract/liveness.ts"),
			"utf8",
		);
		expect(source.match(/Math\.max\(/g)).toHaveLength(1);
		expect(source).toContain("Math.max(...stamps)");
		for (const path of [
			"src/bridge/delivery-contract/liveness.ts",
			"src/bridge/hold-writers.ts",
		]) {
			let candidate = "";
			try {
				candidate = readFileSync(resolve(process.cwd(), path), "utf8");
			} catch {
				// The hold writer lands in M2; absence is acceptable in this M0 guard.
			}
			expect(candidate).not.toContain("stale-blocker-guard");
		}
	});
});
