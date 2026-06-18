import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	assertReadDenyDaemonActive,
	assertReadDenyProfileActive,
	extractActivePermissionProfile,
	FORBIDDEN_DENY_FORMS,
	isReadDenyEnabled,
	READ_DENY_ENV_EXCLUDE,
	READ_DENY_FILESYSTEM_PATHS,
	READ_DENY_PROFILE_EXTENDS,
	READ_DENY_PROFILE_NAME,
	type ReadDenyThreadProc,
	readDenyProfileFragmentPath,
	resolveReadDenyThread,
} from "../read-deny-profile.js";

const ok = {
	activePermissionProfile: {
		id: READ_DENY_PROFILE_NAME,
		extends: READ_DENY_PROFILE_EXTENDS,
	},
};

describe("isReadDenyEnabled (default OFF — byte-compat)", () => {
	it('only the literal "1" enables it', () => {
		expect(isReadDenyEnabled({})).toBe(false);
		expect(isReadDenyEnabled({ FLYWHEEL_CODEX_LEAD_READ_DENY: "0" })).toBe(
			false,
		);
		expect(isReadDenyEnabled({ FLYWHEEL_CODEX_LEAD_READ_DENY: "true" })).toBe(
			false,
		);
		expect(isReadDenyEnabled({ FLYWHEEL_CODEX_LEAD_READ_DENY: "1" })).toBe(
			true,
		);
	});
});

describe("assertReadDenyProfileActive (id + extends, fail-closed)", () => {
	it("passes for the exact {id, extends}", () => {
		expect(() => assertReadDenyProfileActive(ok)).not.toThrow();
	});
	it("throws on null/absent profile", () => {
		expect(() => assertReadDenyProfileActive({})).toThrow(/null\/absent/);
		expect(() =>
			assertReadDenyProfileActive({ activePermissionProfile: null }),
		).toThrow(/null\/absent/);
	});
	it("throws on wrong id", () => {
		expect(() =>
			assertReadDenyProfileActive({
				activePermissionProfile: { id: "other", extends: ":read-only" },
			}),
		).toThrow(/\.id is/);
	});
	it("throws on missing extends", () => {
		expect(() =>
			assertReadDenyProfileActive({
				activePermissionProfile: { id: READ_DENY_PROFILE_NAME },
			}),
		).toThrow(/\.extends is/);
	});
	it("throws on wrong extends (same id, different base = drift)", () => {
		expect(() =>
			assertReadDenyProfileActive({
				activePermissionProfile: {
					id: READ_DENY_PROFILE_NAME,
					extends: ":workspace",
				},
			}),
		).toThrow(/\.extends is/);
	});
});

describe("extractActivePermissionProfile", () => {
	it("returns the object or null", () => {
		expect(extractActivePermissionProfile(ok)).toEqual({
			id: READ_DENY_PROFILE_NAME,
			extends: READ_DENY_PROFILE_EXTENDS,
		});
		expect(extractActivePermissionProfile({})).toBeNull();
		expect(extractActivePermissionProfile(null)).toBeNull();
		expect(
			extractActivePermissionProfile({ activePermissionProfile: null }),
		).toBeNull();
	});
});

describe("assertReadDenyDaemonActive (ephemeral-start gate)", () => {
	it("resolves when the ephemeral start echoes the profile", async () => {
		await expect(
			assertReadDenyDaemonActive(async () => ({ id: "eph", result: ok })),
		).resolves.toBeUndefined();
	});
	it("rejects (fail-closed) when the ephemeral start has no profile", async () => {
		await expect(
			assertReadDenyDaemonActive(async () => ({ id: "eph", result: {} })),
		).rejects.toThrow(/null\/absent/);
	});
});

describe("resolveReadDenyThread (boot-gate wiring — Codex code-review R1#1)", () => {
	// Mock proc that records the call sequence + lets each call be scripted.
	function mockProc(script: {
		startResults?: Array<{ id: string; result: unknown } | Error>;
		resumeResult?: { id: string; result: unknown } | Error;
	}): ReadDenyThreadProc & { calls: string[] } {
		const starts = [...(script.startResults ?? [])];
		const calls: string[] = [];
		return {
			calls,
			startThreadWithResult: async () => {
				calls.push("start");
				const next = starts.shift();
				if (next instanceof Error) throw next;
				if (!next) throw new Error("unexpected extra start call");
				return next;
			},
			resumeThreadWithResult: async (id: string) => {
				calls.push(`resume:${id}`);
				const r = script.resumeResult;
				if (r instanceof Error) throw r;
				if (!r) throw new Error("unexpected resume call");
				return r;
			},
		};
	}

	it("ephemeral gate runs FIRST and fail-closes (no resume) when its profile is absent", async () => {
		const proc = mockProc({ startResults: [{ id: "eph", result: {} }] });
		await expect(
			resolveReadDenyThread(proc, { saved: "s1", threadParams: {} }),
		).rejects.toThrow(/null\/absent/);
		expect(proc.calls).toEqual(["start"]); // gate threw → resume never attempted
	});

	it("saved + resume echoes the profile → asserts + returns {fresh:false}", async () => {
		const proc = mockProc({
			startResults: [{ id: "eph", result: ok }],
			resumeResult: { id: "s1", result: ok },
		});
		await expect(
			resolveReadDenyThread(proc, { saved: "s1", threadParams: {} }),
		).resolves.toEqual({ id: "s1", fresh: false });
		expect(proc.calls).toEqual(["start", "resume:s1"]);
	});

	it("saved + resume echoes a WRONG profile → throws (fail-closed)", async () => {
		const proc = mockProc({
			startResults: [{ id: "eph", result: ok }],
			resumeResult: {
				id: "s1",
				result: { activePermissionProfile: { id: "x", extends: ":read-only" } },
			},
		});
		await expect(
			resolveReadDenyThread(proc, { saved: "s1", threadParams: {} }),
		).rejects.toThrow(/\.id is/);
	});

	it("saved + resume echoes NO profile → assert-if-present skips, returns {fresh:false}", async () => {
		const proc = mockProc({
			startResults: [{ id: "eph", result: ok }],
			resumeResult: { id: "s1", result: {} },
		});
		await expect(
			resolveReadDenyThread(proc, { saved: "s1", threadParams: {} }),
		).resolves.toEqual({ id: "s1", fresh: false });
	});

	it("saved + non-self-heal resume error → rethrows (no fresh start)", async () => {
		const proc = mockProc({
			startResults: [{ id: "eph", result: ok }],
			resumeResult: new Error("network boom"),
		});
		await expect(
			resolveReadDenyThread(proc, {
				saved: "s1",
				threadParams: {},
				isResumeSelfHeal: () => false,
			}),
		).rejects.toThrow(/network boom/);
		expect(proc.calls).toEqual(["start", "resume:s1"]); // no second start
	});

	it("saved + self-heal resume error → fresh start (asserts), returns {fresh:true}", async () => {
		const proc = mockProc({
			startResults: [
				{ id: "eph", result: ok },
				{ id: "new", result: ok },
			],
			resumeResult: new Error("no rollout found"),
		});
		await expect(
			resolveReadDenyThread(proc, {
				saved: "s1",
				threadParams: {},
				isResumeSelfHeal: () => true,
			}),
		).resolves.toEqual({ id: "new", fresh: true });
		expect(proc.calls).toEqual(["start", "resume:s1", "start"]);
	});

	it("no saved → fresh start asserts + returns {fresh:true}", async () => {
		const proc = mockProc({
			startResults: [
				{ id: "eph", result: ok },
				{ id: "new", result: ok },
			],
		});
		await expect(
			resolveReadDenyThread(proc, { saved: undefined, threadParams: {} }),
		).resolves.toEqual({ id: "new", fresh: true });
		expect(proc.calls).toEqual(["start", "start"]);
	});

	it("fresh start with no profile → throws (fail-closed before returning)", async () => {
		const proc = mockProc({
			startResults: [
				{ id: "eph", result: ok },
				{ id: "new", result: {} },
			],
		});
		await expect(
			resolveReadDenyThread(proc, { saved: undefined, threadParams: {} }),
		).rejects.toThrow(/null\/absent/);
	});
});

describe("read-deny config fragment — single source of truth cross-check", () => {
	const fragment = readFileSync(readDenyProfileFragmentPath(), "utf8");

	it("declares default_permissions = the profile name", () => {
		expect(fragment).toContain(
			`default_permissions = "${READ_DENY_PROFILE_NAME}"`,
		);
		expect(fragment).toContain(`[permissions.${READ_DENY_PROFILE_NAME}]`);
		expect(fragment).toContain(`extends = "${READ_DENY_PROFILE_EXTENDS}"`);
	});

	it("has NO top-level sandbox_mode (would disable the profile — Gotcha A)", () => {
		// no line that sets a top-level sandbox_mode (ignore prose in comments)
		const codeLines = fragment
			.split("\n")
			.filter((l) => !l.trimStart().startsWith("#"));
		expect(codeLines.some((l) => /^\s*sandbox_mode\s*=/.test(l))).toBe(false);
	});

	it("pins approval_policy = never", () => {
		expect(fragment).toContain('approval_policy = "never"');
	});

	it("excludes token-shaped env (shell_environment_policy)", () => {
		expect(fragment).toContain("[shell_environment_policy]");
		for (const g of READ_DENY_ENV_EXCLUDE) {
			expect(fragment).toContain(`"${g}"`);
		}
	});

	it("contains EVERY filesystem deny key with value 'deny'", () => {
		for (const path of READ_DENY_FILESYSTEM_PATHS) {
			expect(fragment).toContain(`"${path}" = "deny"`);
		}
	});

	it("contains NONE of the known-ineffective / forbidden deny forms", () => {
		for (const bad of FORBIDDEN_DENY_FORMS) {
			// forbidden form must not appear as an active deny key
			expect(fragment).not.toContain(`${bad} = "deny"`);
		}
	});

	it("does NOT blanket-deny ~/.flywheel (would break COE Director orchestration)", () => {
		expect(fragment).not.toContain('"~/.flywheel" = "deny"');
		// but DOES deny the secret env files inside it via the recursive .env glob
		expect(READ_DENY_FILESYSTEM_PATHS).toContain("~/**/.env**");
	});
});
