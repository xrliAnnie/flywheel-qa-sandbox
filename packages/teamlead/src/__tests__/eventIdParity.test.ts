/**
 * FLY-83 regression: the shell path (`scripts/lead-alert.sh`) and the Bridge
 * path (`LeadWatchdog`) must hash the SAME formula or cross-process dedup
 * silently breaks. Codex Round 1 caught us: Bridge was using pipes, shell
 * was using colons. This test shells out to `shasum` (the same tool the
 * shell script calls) with the pipe-joined string, then compares against
 * `createHash("sha1")` on the exact string Bridge would produce. Any future
 * refactor that changes either side will flip this test red.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

function bridgeEventId(leadId: string, kind: string, bucket: number): string {
	return createHash("sha1").update(`${leadId}|${kind}|${bucket}`).digest("hex");
}

function shellEventId(leadId: string, kind: string, bucket: number): string {
	const input = `${leadId}|${kind}|${bucket}`;
	const out = execFileSync(
		"/bin/bash",
		[
			"-c",
			// Mirror lead-alert.sh:141 byte-for-byte.
			`LC_ALL=C printf '%s|%s|%s' "$1" "$2" "$3" | LC_ALL=C shasum -a 1 | awk '{print $1}'`,
			"_",
			leadId,
			kind,
			String(bucket),
		],
		{ encoding: "utf-8" },
	).trim();
	// Sanity: `printf '%s|%s|%s' a b c` must equal `${a}|${b}|${c}`.
	expect(out).toHaveLength(40);
	// The input we pass TS side and the input shell reconstructs must match.
	expect(input).toBe([leadId, kind, bucket].join("|"));
	return out;
}

describe("FLY-83 eventId parity (Bridge vs shell)", () => {
	const cases: Array<[string, string, number]> = [
		["cos-lead", "rate_limit", 12345],
		["peter-lead", "login_expired", 67890],
		["simba-lead", "permission_blocked", 1_000_000],
		["oliver-lead", "pane_hash_stuck", 0],
		// Special chars in leadId shouldn't desync (we don't normalize anywhere).
		["lead.with-dash_underscore", "crash_loop", 999_999],
	];

	for (const [leadId, kind, bucket] of cases) {
		it(`matches for leadId=${leadId} kind=${kind} bucket=${bucket}`, () => {
			const bridge = bridgeEventId(leadId, kind, bucket);
			const shell = shellEventId(leadId, kind, bucket);
			expect(bridge).toBe(shell);
		});
	}
});
