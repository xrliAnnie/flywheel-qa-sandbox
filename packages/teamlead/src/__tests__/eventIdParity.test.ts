/**
 * FLY-83 regression: the shell path (`scripts/lead-alert.sh`) and the Bridge
 * path (`computeEventId` in alert-kind-copy.ts) must hash the SAME formula or cross-process dedup
 * silently breaks. Codex Round 1 caught us: Bridge was using pipes, shell
 * was using colons. This test shells out to `shasum` (the same tool the
 * shell script calls) with the pipe-joined string, then compares against
 * `createHash("sha1")` on the exact string Bridge would produce. Any future
 * refactor that changes either side will flip this test red.
 */

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { computeEventId } from "../bridge/alert-kind-copy.js";

function shellEventId(
	projectName: string,
	leadId: string,
	kind: string,
	signature: string,
): string {
	const input = `${projectName}|${leadId}|${kind}|${signature}`;
	const out = execFileSync(
		"/bin/bash",
		[
			"-c",
			// Mirror scripts/lead-alert.sh:416-430 byte-for-byte.
			`LC_ALL=C printf '%s|%s|%s|%s' "$1" "$2" "$3" "$4" | LC_ALL=C shasum -a 1 | awk '{print $1}'`,
			"_",
			projectName,
			leadId,
			kind,
			signature,
		],
		{ encoding: "utf-8" },
	).trim();
	expect(out).toHaveLength(40);
	expect(input).toBe([projectName, leadId, kind, signature].join("|"));
	return out;
}

describe("FLY-83 eventId parity (Bridge vs shell)", () => {
	const cases: Array<[string, string, string, string]> = [
		["flywheel", "cos-lead", "rate_limit", "pane-hash-1"],
		["geoforge3d", "peter-lead", "login_expired", "2026-08-14"],
		["p|roject", "lead.with-dash_underscore", "crash_loop", "sig|特殊字符"],
	];

	for (const [projectName, leadId, kind, signature] of cases) {
		it(`matches for project=${projectName} lead=${leadId} kind=${kind}`, () => {
			const bridge = computeEventId(
				projectName,
				leadId,
				kind as Parameters<typeof computeEventId>[2],
				signature,
			);
			const shell = shellEventId(projectName, leadId, kind, signature);
			expect(bridge).toBe(shell);
		});
	}

	it("binds every field into the id", () => {
		const base = computeEventId("flywheel", "cos-lead", "rate_limit", "sig");
		const variants = [
			computeEventId("geoforge3d", "cos-lead", "rate_limit", "sig"),
			computeEventId("flywheel", "product-lead", "rate_limit", "sig"),
			computeEventId("flywheel", "cos-lead", "usage_limit", "sig"),
			computeEventId("flywheel", "cos-lead", "rate_limit", "other"),
		];
		expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
	});
});
