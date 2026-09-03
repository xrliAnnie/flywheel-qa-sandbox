import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
	childEvidenceFromError,
	formatFailureDetail,
	redactSecrets,
	summarizeApplyFailure,
} from "../account-heal/apply-child-evidence.js";

describe("apply child evidence", () => {
	it("redacts known credential forms and control characters", () => {
		const raw = [
			"ordinary text",
			"sk-ant-oat01-FAKETOKEN",
			"Bearer abc.def",
			'"accessToken":"xyz"',
			"refresh_token=refresh-value",
			"password=pass-value\u0000",
		].join("\n");

		const redacted = redactSecrets(raw);

		expect(redacted).toContain("ordinary text");
		expect(redacted).toContain("<redacted>");
		for (const secret of [
			"sk-ant-oat01-FAKETOKEN",
			"abc.def",
			"xyz",
			"refresh-value",
			"pass-value",
		]) {
			expect(redacted).not.toContain(secret);
		}
		expect(redacted).not.toContain("\u0000");
	});

	it("keeps only marker and first error lines, with a sanitized fallback", () => {
		const raw = [
			"noise",
			"FLYWHEEL_ATOMIC_APPLY_CONTRACT_MISMATCH",
			"Error: delegated sk-ant-oat01-FAKETOKEN",
			"Error: ignored second error",
			"Recovery: restart",
		].join("\n");
		const summary = summarizeApplyFailure(raw);

		expect(summary).toBe(
			"FLYWHEEL_ATOMIC_APPLY_CONTRACT_MISMATCH | Error: delegated <redacted>",
		);
		expect(summarizeApplyFailure(summary)).toBe(summary);
		expect(summarizeApplyFailure("noise only")).toBe("");
		expect(
			summarizeApplyFailure("", "spawn flywheel-claude-profile ENOENT"),
		).toBe("Error: spawn flywheel-claude-profile ENOENT");
	});

	it("truncates UTF-8 evidence without splitting a character", () => {
		const summary = summarizeApplyFailure(
			`FLYWHEEL_LONG_DETAIL ${"界".repeat(300)}`,
		);

		expect(Buffer.byteLength(summary, "utf8")).toBeLessThanOrEqual(600);
		expect(summary.startsWith("FLYWHEEL_LONG_DETAIL ")).toBe(true);
		expect(summary.endsWith("…")).toBe(true);
		expect(summary).not.toContain("�");
	});

	it("preserves owned prefixes while enforcing the byte budget", () => {
		expect(
			formatFailureDetail(
				"drift persisted after reconcile: ",
				"FLYWHEEL_STALE_ACTIVE_UNRESOLVABLE personal",
			),
		).toBe(
			"drift persisted after reconcile: FLYWHEEL_STALE_ACTIVE_UNRESOLVABLE personal",
		);
		expect(
			formatFailureDetail(
				"reconcile unresolvable: anchor_ambiguous: ",
				"FLYWHEEL_STALE_ACTIVE_UNRESOLVABLE personal",
			),
		).toContain("reconcile unresolvable: anchor_ambiguous: ");
		expect(formatFailureDetail("", "plain detail")).toBe("plain detail");
		const truncated = formatFailureDetail(
			"drift persisted after reconcile: ",
			`FLYWHEEL_DETAIL ${"界".repeat(300)}`,
		);
		expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(600);
		expect(truncated.startsWith("drift persisted after reconcile: ")).toBe(
			true,
		);
		expect(truncated.endsWith("…")).toBe(true);
		expect(truncated).not.toContain("�");
	});

	it("extracts exit, start state, and summarized detail from child errors", () => {
		const stderr = [
			"FLYWHEEL_ATOMIC_APPLY_CONTRACT_MISMATCH",
			"Error: delegated profile mutation requires marker",
		].join("\n");
		expect(
			childEvidenceFromError({ code: 48, profileChildStarted: true }, stderr),
		).toEqual({
			exitCode: 48,
			childStarted: true,
			detail:
				"FLYWHEEL_ATOMIC_APPLY_CONTRACT_MISMATCH | Error: delegated profile mutation requires marker",
		});
		expect(childEvidenceFromError({ code: "SIGTERM" }, stderr)).toMatchObject({
			exitCode: null,
			childStarted: null,
		});
		const spawnError = Object.assign(
			new Error("spawn flywheel-claude-profile ENOENT"),
			{ code: "ENOENT", profileChildStarted: false },
		);
		expect(childEvidenceFromError(spawnError, "")).toEqual({
			exitCode: null,
			childStarted: false,
			detail: "Error: spawn flywheel-claude-profile ENOENT",
		});
	});
});
