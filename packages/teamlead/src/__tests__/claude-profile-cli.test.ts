/**
 * FLY-696 M1/① — the SwitchDeps that drive the `flywheel-claude-profile` bash
 * script (the A-Keychain executor, landed last). applyProfile = `use <name>`
 * (throws on non-zero → fail-closed); readActiveProfile parses `status`. Exec is
 * injected so this is tested without the real script/Keychain.
 */

import { EventEmitter } from "node:events";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	makeClaudeProfileSwitchDeps,
	reconcileClaudeProfile,
} from "../account-heal/claude-profile-cli.js";
import {
	ActiveMarkerDriftError,
	ApplyContractMismatchError,
	type ApplyProfileReport,
	FreshnessUnavailableError,
	IdentityRollbackFailedError,
	KeychainPreimageConflictError,
	LiveIdentityUnavailableError,
	TargetIdentityMismatchError,
	TargetIdentityRolledBackError,
	TargetIdentityUnverifiableError,
	TargetQuotaExhaustedError,
	TargetStaleError,
} from "../account-heal/switch-executor.js";

const BIN = "/x/flywheel-claude-profile";
const LEASE = {
	lockPath: "/tmp/accounts.lock",
	markerPath: "/tmp/accounts.lock/holder.1.token",
	ownershipToken: "token",
};

function deps(
	execFile: ReturnType<typeof vi.fn>,
	onWarn?: (m: string) => void,
	quotaPreverified?: boolean,
) {
	return makeClaudeProfileSwitchDeps({
		binPath: BIN,
		execFile: execFile as never,
		withLock: async (lockPath, fn) => ({
			kind: "ok",
			value: await fn({ ...LEASE, lockPath }),
		}),
		onWarn,
		quotaPreverified,
	});
}

describe("reconcileClaudeProfile", () => {
	it("runs the existing reconcile command without inherited trust bypasses", async () => {
		const execFile = vi.fn(async () => ({
			stdout: JSON.stringify({
				outcome: "repaired",
				from: "personal1",
				to: "personal",
				displaySynced: true,
			}),
			stderr: "",
		}));

		await expect(
			reconcileClaudeProfile({
				binPath: BIN,
				execFile: execFile as never,
				env: {
					FLYWHEEL_CLAUDE_LOCK_DELEGATED: "123",
					FLYWHEEL_PROFILE_IDENTITY_BYPASS: "1",
					FLYWHEEL_CLAUDE_FRESHNESS_BYPASS: "1",
				},
			}),
		).resolves.toEqual({
			ok: true,
			outcome: "repaired",
			from: "personal1",
			to: "personal",
			exitCode: 0,
			detail: "",
		});
		expect(execFile).toHaveBeenCalledWith(
			BIN,
			["reconcile"],
			expect.objectContaining({
				timeout: 60_000,
				maxBuffer: 65_536,
			}),
		);
		const childEnv = execFile.mock.calls[0][2].env as NodeJS.ProcessEnv;
		expect(childEnv.FLYWHEEL_CLAUDE_LOCK_DELEGATED).toBeUndefined();
		expect(childEnv.FLYWHEEL_PROFILE_IDENTITY_BYPASS).toBeUndefined();
		expect(childEnv.FLYWHEEL_CLAUDE_FRESHNESS_BYPASS).toBeUndefined();
		expect(childEnv.FLYWHEEL_PROFILE_GROUP_LEADER).toBe("1");
		expect(childEnv.FLYWHEEL_NODE_BIN).toBe(process.execPath);
	});

	it("accepts an already-consistent live identity", async () => {
		const execFile = vi.fn(async () => ({
			stdout: JSON.stringify({
				outcome: "already_consistent",
				freshened: true,
				displaySynced: true,
			}),
			stderr: "",
		}));

		await expect(
			reconcileClaudeProfile({ binPath: BIN, execFile: execFile as never }),
		).resolves.toEqual({
			ok: true,
			outcome: "already_consistent",
			exitCode: 0,
			detail: "",
		});
	});

	it("fails closed when reconcile cannot prove a unique live identity", async () => {
		const execFile = vi.fn(async () => {
			throw Object.assign(new Error("unresolvable"), {
				code: 20,
				stdout: JSON.stringify({
					outcome: "unresolvable",
					reason: "anchor_ambiguous",
				}),
				stderr: "FLYWHEEL_LIVE_IDENTITY_UNRESOLVABLE",
			});
		});

		await expect(
			reconcileClaudeProfile({ binPath: BIN, execFile: execFile as never }),
		).resolves.toEqual({
			ok: false,
			outcome: "unresolvable",
			reason: "anchor_ambiguous",
			exitCode: 20,
			detail: "FLYWHEEL_LIVE_IDENTITY_UNRESOLVABLE",
		});
	});

	it("pairs reconcile stdout with its process exit and keeps stderr evidence", async () => {
		const repaired = await reconcileClaudeProfile({
			binPath: BIN,
			execFile: vi.fn(async () => ({
				stdout: '{"outcome":"repaired","from":"personal","to":"school"}',
				stderr: "FLYWHEEL_STALE_ACTIVE_RECONCILED personal school",
			})) as never,
		});
		expect(repaired).toEqual({
			ok: true,
			outcome: "repaired",
			from: "personal",
			to: "school",
			exitCode: 0,
			detail: "FLYWHEEL_STALE_ACTIVE_RECONCILED personal school",
		});

		const noCredential = await reconcileClaudeProfile({
			binPath: BIN,
			execFile: vi.fn(async () => {
				throw Object.assign(new Error("empty keychain"), {
					code: 10,
					stdout: '{"outcome":"no_credential"}',
					stderr: "",
				});
			}) as never,
		});
		expect(noCredential).toEqual({
			ok: false,
			outcome: "no_credential",
			exitCode: 10,
			detail: "Error: empty keychain",
		});
	});

	it.each([
		{
			name: "invalid JSON on exit zero",
			failure: { code: 0, stdout: "not-json", stderr: "" },
			outcome: "malformed",
			exitCode: 0,
		},
		{
			name: "exit/outcome mismatch",
			failure: {
				code: 20,
				stdout: '{"outcome":"repaired","from":"a","to":"b"}',
				stderr: "",
			},
			outcome: "malformed",
			exitCode: 20,
		},
		{
			name: "signal termination",
			failure: { code: "SIGTERM", stdout: "", stderr: "" },
			outcome: "execution_failed",
			exitCode: null,
		},
		{
			name: "unexpected exit",
			failure: { code: 1, stdout: "", stderr: "" },
			outcome: "execution_failed",
			exitCode: 1,
		},
	])("classifies $name", async ({ failure, outcome, exitCode }) => {
		const execFile = vi.fn(async () => {
			throw Object.assign(new Error("reconcile failed"), failure);
		});
		await expect(
			reconcileClaudeProfile({ binPath: BIN, execFile: execFile as never }),
		).resolves.toMatchObject({ ok: false, outcome, exitCode });
	});

	it.each([
		'{"outcome":"unknown"}',
		`{"outcome":"repaired","from":"${"a".repeat(257)}","to":"b"}`,
		'{"outcome":"unresolvable","reason":"secret-value"}',
	])("rejects malformed reconcile payload %s", async (stdout) => {
		const declared = JSON.parse(stdout) as { outcome: string };
		const code = declared.outcome === "unresolvable" ? 20 : 0;
		const execFile = vi.fn(async () => {
			if (code === 0) return { stdout, stderr: "" };
			throw Object.assign(new Error("unresolvable"), {
				code,
				stdout,
				stderr: "",
			});
		});
		await expect(
			reconcileClaudeProfile({ binPath: BIN, execFile: execFile as never }),
		).resolves.toMatchObject({
			ok: false,
			outcome: "malformed",
			exitCode: code,
		});
	});
});

describe("makeClaudeProfileSwitchDeps", () => {
	const DIGEST = "a".repeat(64);
	const REPORT: ApplyProfileReport = {
		identityChecks: [
			{
				label: "school",
				checkpoint: "pre_write",
				verdict: "mismatch",
				expectedKey: "b".repeat(64),
				actualDigest: DIGEST,
			},
		],
	};

	it("applyProfile runs `<bin> use <name>` with the lock delegated to THIS pid", async () => {
		// FLY-852: switchAccount calls applyProfile INSIDE its withMkdirLock
		// critical section and the bash script takes the SAME lock — the child
		// must be told the parent already holds it (validated against the live
		// holder marker script-side) or it deadlocks until timeout.
		const execFile = vi.fn(async () => ({ stdout: "Switched", stderr: "" }));
		await deps(execFile).applyProfile("school");
		expect(execFile).toHaveBeenCalledWith(
			BIN,
			["use", "school"],
			expect.objectContaining({
				env: expect.objectContaining({
					FLYWHEEL_CLAUDE_LOCK_DELEGATED: String(process.pid),
				}),
			}),
		);
	});

	it("issues only atomic apply/audit markers and scrubs retired safety bypass names", async () => {
		const execFile = vi.fn(async () => ({ stdout: "Switched", stderr: "" }));
		const atomicFreshness = "FLY" + "WHEEL_ATOMIC_FRESHNESS_BYPASS";
		const atomicQuota = "FLY" + "WHEEL_ATOMIC_QUOTA_BYPASS";
		const publicFreshness = "FLY" + "WHEEL_CLAUDE_FRESHNESS_BYPASS";
		const publicQuota = "FLY" + "WHEEL_CLAUDE_QUOTA_BYPASS";
		process.env.FLYWHEEL_ATOMIC_SWITCH_APPLY = "forged";
		process.env[atomicFreshness] = "forged";
		process.env[atomicQuota] = "forged";
		process.env.FLYWHEEL_ATOMIC_SWITCH_AUDIT_CMD = "forged";
		try {
			await deps(execFile).applyProfile("school", {
				lease: LEASE,
				signal: new AbortController().signal,
				manualMode: "next",
			});

			const childEnv = execFile.mock.calls[0][2].env as NodeJS.ProcessEnv;
			expect(childEnv.FLYWHEEL_ATOMIC_SWITCH_APPLY).toBe("1");
			expect(childEnv[atomicFreshness]).toBeUndefined();
			expect(childEnv[atomicQuota]).toBeUndefined();
			expect(childEnv.FLYWHEEL_ATOMIC_SWITCH_AUDIT_CMD).toBe("next");
			expect(childEnv[publicFreshness]).toBeUndefined();
			expect(childEnv[publicQuota]).toBeUndefined();
		} finally {
			delete process.env.FLYWHEEL_ATOMIC_SWITCH_APPLY;
			delete process.env[atomicFreshness];
			delete process.env[atomicQuota];
			delete process.env.FLYWHEEL_ATOMIC_SWITCH_AUDIT_CMD;
		}
	});

	it("FLY-865: applyProfile forwards the switch script's stderr (identity warning) via onWarn on a SUCCESSFUL (exit 0) switch", async () => {
		// `use` exits 0 (token switched) but warned on stderr that the display
		// identity was not updated — execFile discards it, so onWarn must surface it.
		const execFile = vi.fn(async () => ({
			stdout: "Switched machine Claude account to profile 'school'",
			stderr:
				"Warning: profile 'school' has no captured display identity — new claude /status may show a stale account. To fix: capture school",
		}));
		const warns: string[] = [];
		const result = await deps(execFile, (m) => warns.push(m)).applyProfile(
			"school",
		);
		expect(result).toEqual({
			identitySynced: false,
			identityChecks: [],
			evidence: { exitCode: 0, childStarted: true, detail: "" },
		});
		expect(warns).toHaveLength(1);
		expect(warns[0]).toContain("use school");
		expect(warns[0]).toContain("no captured display identity");
	});

	it("FLY-865: applyProfile does NOT warn when the switch had no stderr", async () => {
		const execFile = vi.fn(async () => ({ stdout: "Switched", stderr: "" }));
		const warns: string[] = [];
		await deps(execFile, (m) => warns.push(m)).applyProfile("school");
		expect(warns).toHaveLength(0);
	});

	it("FLY-865: applyProfile does NOT warn on the non-warning success stderr line", async () => {
		// `use` prints the identity-success line to stderr too; it must not be
		// logged at warn level (only real "Warning:" lines are forwarded).
		const execFile = vi.fn(async () => ({
			stdout: "Switched machine Claude account to profile 'school'",
			stderr:
				"Updated ~/.claude.json display identity to 'school' (email: s@x.com)",
		}));
		const warns: string[] = [];
		const result = await deps(execFile, (m) => warns.push(m)).applyProfile(
			"school",
		);
		expect(result).toEqual({
			identitySynced: true,
			identityChecks: [],
			evidence: { exitCode: 0, childStarted: true, detail: "" },
		});
		expect(warns).toHaveLength(0);
	});

	it("applyProfile throws when the script exits non-zero (fail-closed)", async () => {
		const execFile = vi.fn(async () => {
			throw new Error("verify failed");
		});
		await expect(deps(execFile).applyProfile("school")).rejects.toThrow(
			"verify failed",
		);
	});

	it("retains child stderr for an unknown apply failure", async () => {
		const execFile = vi.fn(async () => {
			throw Object.assign(new Error("profile primitive exited 77"), {
				code: 77,
				stderr: "synthetic keychain writer rejected apply\nsecond line",
			});
		});

		await expect(deps(execFile).applyProfile("school")).rejects.toThrow(
			"profile primitive exited 77: synthetic keychain writer rejected apply | second line",
		);
		await expect(deps(execFile).applyProfile("school")).rejects.toMatchObject({
			evidence: {
				exitCode: 77,
				childStarted: null,
				detail: "Error: profile primitive exited 77",
			},
		});
	});

	it("retains the decisive stderr tail for an oversized unknown apply failure", async () => {
		const base = "profile primitive exited 77";
		const execFile = vi.fn(async () => {
			throw Object.assign(new Error(base), {
				code: 77,
				stderr: `${"synthetic progress noise ".repeat(200)}\nsynthetic decisive apply verdict`,
			});
		});

		const error = await deps(execFile)
			.applyProfile("school")
			.catch((caught: unknown) => caught as Error);

		expect(error.message).toContain("synthetic decisive apply verdict");
		expect(error.message).toContain(": …");
		expect(error.message.length).toBeLessThanOrEqual(`${base}: `.length + 2048);
	});

	it("exit 39 maps to LockLeaseLostError", async () => {
		const execFile = vi.fn(async () => {
			throw Object.assign(new Error("lease lost"), {
				code: 39,
				stderr: "FLYWHEEL_LOCK_LEASE_LOST",
			});
		});
		await expect(deps(execFile).applyProfile("school")).rejects.toMatchObject({
			name: "LockLeaseLostError",
		});
	});

	it.each([
		{ exit: 34, ErrorType: TargetIdentityMismatchError },
		{ exit: 36, ErrorType: TargetIdentityRolledBackError },
		{ exit: 37, ErrorType: IdentityRollbackFailedError },
		{ exit: 38, ErrorType: TargetIdentityUnverifiableError },
	])(
		"identity exit $exit maps to $ErrorType.name and carries the apply report",
		async ({ exit, ErrorType }) => {
			let reportPath = "";
			const execFile = vi.fn(async (_file, _args, options) => {
				reportPath = String(options?.env?.FLYWHEEL_APPLY_REPORT_FILE ?? "");
				writeFileSync(reportPath, JSON.stringify(REPORT), { mode: 0o600 });
				throw Object.assign(new Error("identity policy refused"), {
					code: exit,
					stderr: `identity failure actualDigest=${DIGEST}`,
				});
			});

			const rejected = await deps(execFile)
				.applyProfile("school")
				.catch((error: unknown) => error);

			expect(rejected).toBeInstanceOf(ErrorType);
			expect(rejected).toMatchObject({ report: REPORT });
			expect(rejected).toMatchObject({
				evidence: { exitCode: exit, childStarted: null },
			});
			if (exit === 34) {
				expect(rejected).toMatchObject({ actualDigest: DIGEST });
			}
			expect(reportPath).not.toBe("");
			expect(existsSync(reportPath)).toBe(false);
		},
	);

	it("exit 34 without a readable report still carries an opaque digest", async () => {
		const execFile = vi.fn(async () => {
			throw Object.assign(new Error("identity policy refused"), {
				code: 34,
				stderr: "FLYWHEEL_TARGET_IDENTITY_MISMATCH",
			});
		});

		const rejected = await deps(execFile)
			.applyProfile("school")
			.catch((error: unknown) => error);

		expect(rejected).toBeInstanceOf(TargetIdentityMismatchError);
		expect(rejected).toMatchObject({
			actualDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
			report: undefined,
		});
		expect(rejected.actualDigest).not.toBe("unknown");
	});

	it("returns a valid apply report on success", async () => {
		const execFile = vi.fn(async (_file, _args, options) => {
			writeFileSync(
				String(options?.env?.FLYWHEEL_APPLY_REPORT_FILE),
				JSON.stringify(REPORT),
				{ mode: 0o600 },
			);
			return { stdout: "Switched", stderr: "" };
		});

		await expect(deps(execFile).applyProfile("school")).resolves.toEqual({
			...REPORT,
			identitySynced: true,
			evidence: { exitCode: 0, childStarted: true, detail: "" },
		});
	});

	it("returns a verified freshening fact without identity checkpoints", async () => {
		const freshened = {
			name: "personal",
			identityProof: { email: "annie@example.com", uuid: "uuid-personal" },
		};
		const execFile = vi.fn(async (_file, _args, options) => {
			writeFileSync(
				String(options?.env?.FLYWHEEL_APPLY_REPORT_FILE),
				JSON.stringify({ identityChecks: [], freshened }),
				{ mode: 0o600 },
			);
			return { stdout: "Switched", stderr: "" };
		});

		await expect(deps(execFile).applyProfile("school")).resolves.toEqual({
			identitySynced: true,
			identityChecks: [],
			freshened,
			evidence: { exitCode: 0, childStarted: true, detail: "" },
		});
	});

	it("target-stale carries a verified outgoing-account freshening fact", async () => {
		const report: ApplyProfileReport = {
			identityChecks: [],
			freshened: {
				name: "personal",
				identityProof: { email: "annie@example.com", uuid: "uuid-personal" },
			},
		};
		const execFile = vi.fn(async (_file, _args, options) => {
			writeFileSync(
				String(options?.env?.FLYWHEEL_APPLY_REPORT_FILE),
				JSON.stringify(report),
				{ mode: 0o600 },
			);
			throw Object.assign(new Error("stale"), {
				code: 30,
				stderr: "FLYWHEEL_TARGET_STALE school",
			});
		});

		await expect(deps(execFile).applyProfile("school")).rejects.toMatchObject({
			name: "TargetStaleError",
			report,
		});
	});

	it.each([
		{
			marker: "FLYWHEEL_LIVE_IDENTITY_UNAVAILABLE probe_unavailable",
			ErrorType: LiveIdentityUnavailableError,
		},
		{
			marker: "FLYWHEEL_KEYCHAIN_PREIMAGE_CONFLICT",
			ErrorType: KeychainPreimageConflictError,
		},
	])("maps $marker to $ErrorType.name", async ({ marker, ErrorType }) => {
		const execFile = vi.fn(async () => {
			throw Object.assign(new Error(marker), { code: 88, stderr: marker });
		});

		await expect(deps(execFile).applyProfile("school")).rejects.toBeInstanceOf(
			ErrorType,
		);
	});

	it.each(["missing", "malformed"])(
		"a $s apply report is treated as no facts",
		async (mode) => {
			const execFile = vi.fn(async (_file, _args, options) => {
				if (mode === "malformed") {
					writeFileSync(
						String(options?.env?.FLYWHEEL_APPLY_REPORT_FILE),
						'{"identityChecks":[{"label":"school","verdict":"mismatch","actualDigest":"token-secret"}]}',
						{ mode: 0o600 },
					);
				}
				return { stdout: "Switched", stderr: "" };
			});

			await expect(deps(execFile).applyProfile("school")).resolves.toEqual({
				identitySynced: true,
				identityChecks: [],
				evidence: { exitCode: 0, childStarted: true, detail: "" },
			});
		},
	);

	it("rejects a valid-looking report that is not owner-only", async () => {
		const execFile = vi.fn(async (_file, _args, options) => {
			const path = String(options?.env?.FLYWHEEL_APPLY_REPORT_FILE);
			writeFileSync(path, JSON.stringify(REPORT), { mode: 0o600 });
			chmodSync(path, 0o644);
			return { stdout: "Switched", stderr: "" };
		});

		await expect(deps(execFile).applyProfile("school")).resolves.toEqual({
			identitySynced: true,
			identityChecks: [],
			evidence: { exitCode: 0, childStarted: true, detail: "" },
		});
	});

	it("production apply starts a detached process group and passes the lease proof", async () => {
		const child = new EventEmitter() as EventEmitter & {
			pid: number;
			stdout: PassThrough;
			stderr: PassThrough;
		};
		child.pid = 43210;
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		const spawn = vi.fn(() => child);
		const controller = new AbortController();
		const apply = makeClaudeProfileSwitchDeps({
			binPath: BIN,
			spawn: spawn as never,
			withLock: async (lockPath, fn) => ({
				kind: "ok",
				value: await fn({ ...LEASE, lockPath }),
			}),
		}).applyProfile("school", { lease: LEASE, signal: controller.signal });
		child.emit("close", 0, null);
		await apply;

		expect(spawn).toHaveBeenCalledWith(
			BIN,
			["use", "school"],
			expect.objectContaining({
				detached: true,
				env: expect.objectContaining({
					FLYWHEEL_CLAUDE_ACCOUNTS_LOCK: LEASE.lockPath,
					FLYWHEEL_LEASE_PROOF: JSON.stringify(LEASE),
				}),
			}),
		);
	});

	it("records that a production apply child never started on spawn ENOENT", async () => {
		const child = new EventEmitter();
		const spawn = vi.fn(() => child);
		const apply = makeClaudeProfileSwitchDeps({
			binPath: BIN,
			spawn: spawn as never,
			withLock: async (lockPath, fn) => ({
				kind: "ok",
				value: await fn({ ...LEASE, lockPath }),
			}),
		}).applyProfile("school", {
			lease: LEASE,
			signal: new AbortController().signal,
		});
		child.emit(
			"error",
			Object.assign(new Error("spawn flywheel-claude-profile ENOENT"), {
				code: "ENOENT",
			}),
		);

		await expect(apply).rejects.toMatchObject({
			profileChildStarted: false,
			evidence: {
				exitCode: null,
				childStarted: false,
				detail: "Error: spawn flywheel-claude-profile ENOENT",
			},
		});
	});

	it("readActiveProfile parses `Active profile: X`", async () => {
		const execFile = vi.fn(async () => ({
			stdout: "Active profile: personal\n",
			stderr: "",
		}));
		expect(await deps(execFile).readActiveProfile()).toBe("personal");
	});

	it("readActiveProfile returns null when none is set", async () => {
		const execFile = vi.fn(async () => ({
			stdout: "No active profile set for this home.\n",
			stderr: "",
		}));
		expect(await deps(execFile).readActiveProfile()).toBeNull();
	});

	it("readActiveProfile returns null (not throw) when the script errors", async () => {
		const execFile = vi.fn(async () => {
			throw new Error("no such file");
		});
		expect(await deps(execFile).readActiveProfile()).toBeNull();
	});

	it("exposes withLock for the switch executor to serialize on", () => {
		const d = deps(vi.fn());
		expect(typeof d.withLock).toBe("function");
		expect(typeof d.renewLock).toBe("function");
	});

	describe("FLY-1252 quota exit-code mapping and env trust", () => {
		const PREVERIFIED = "FLYWHEEL_CLAUDE_QUOTA_PREVERIFIED";
		const BYPASS = "FLYWHEEL_CLAUDE_QUOTA_BYPASS";
		const saved = new Map<string, string | undefined>();

		afterEach(() => {
			for (const key of [PREVERIFIED, BYPASS]) {
				const value = saved.get(key);
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			saved.clear();
		});

		it("exit 32 maps to TargetQuotaExhaustedError", async () => {
			const execFile = vi.fn(async () => {
				throw Object.assign(new Error("use failed"), {
					code: 32,
					stderr: "FLYWHEEL_TARGET_QUOTA_EXHAUSTED school\n",
				});
			});

			await expect(
				deps(execFile).applyProfile("school"),
			).rejects.toBeInstanceOf(TargetQuotaExhaustedError);
		});

		it("quotaPreverified true injects the internal marker and scrubs manual bypass", async () => {
			for (const key of [PREVERIFIED, BYPASS]) saved.set(key, process.env[key]);
			process.env[BYPASS] = "1";
			const execFile = vi.fn(async () => ({ stdout: "Switched", stderr: "" }));

			await deps(execFile, undefined, true).applyProfile("school");

			const childEnv = execFile.mock.calls[0][2].env as NodeJS.ProcessEnv;
			expect(childEnv[PREVERIFIED]).toBe("1");
			expect(childEnv[BYPASS]).toBeUndefined();
		});

		it("legacy deps scrub ambient preverified and manual bypass values", async () => {
			for (const key of [PREVERIFIED, BYPASS]) saved.set(key, process.env[key]);
			process.env[PREVERIFIED] = "1";
			process.env[BYPASS] = "1";
			const execFile = vi.fn(async () => ({ stdout: "Switched", stderr: "" }));

			await deps(execFile).applyProfile("school");

			const childEnv = execFile.mock.calls[0][2].env as NodeJS.ProcessEnv;
			expect(childEnv[PREVERIFIED]).toBeUndefined();
			expect(childEnv[BYPASS]).toBeUndefined();
		});
	});

	// ─── FLY-871 R1/C3 — freshness exit-code mapping + bypass env scrub ───
	describe("FLY-871 freshness exit-code mapping", () => {
		it("exit 30 → TargetStaleError (stale target, don't switch)", async () => {
			const execFile = vi.fn(async () => {
				throw Object.assign(new Error("use failed"), {
					code: 30,
					stderr: "FLYWHEEL_TARGET_STALE school\n",
				});
			});
			await expect(
				deps(execFile).applyProfile("school"),
			).rejects.toBeInstanceOf(TargetStaleError);
		});

		it("exit 30 mapped from the stderr marker even if code is a string", async () => {
			const execFile = vi.fn(async () => {
				throw Object.assign(new Error("use failed"), {
					code: "SOMETHING",
					stderr: "FLYWHEEL_TARGET_STALE business\n",
				});
			});
			await expect(
				deps(execFile).applyProfile("business"),
			).rejects.toBeInstanceOf(TargetStaleError);
		});

		it("exit 31 → FreshnessUnavailableError (helper missing, fail-closed)", async () => {
			const execFile = vi.fn(async () => {
				throw Object.assign(new Error("use failed"), {
					code: 31,
					stderr: "FLYWHEEL_FRESHNESS_UNAVAILABLE school\n",
				});
			});
			await expect(
				deps(execFile).applyProfile("school"),
			).rejects.toBeInstanceOf(FreshnessUnavailableError);
		});

		it("any other non-zero exit rethrows the original error (unchanged behavior)", async () => {
			const execFile = vi.fn(async () => {
				throw Object.assign(new Error("verify-before-commit failed"), {
					code: 1,
					stderr: "verify-before-commit failed",
				});
			});
			await expect(deps(execFile).applyProfile("school")).rejects.toThrow(
				"verify-before-commit failed",
			);
			await expect(
				deps(execFile).applyProfile("school"),
			).rejects.not.toBeInstanceOf(TargetStaleError);
		});
	});

	describe("FLY-1201 stale active marker exit-code mapping", () => {
		it.each([
			{
				code: 48,
				stderr:
					"FLYWHEEL_ATOMIC_APPLY_CONTRACT_MISMATCH\nError: delegated profile mutation requires marker",
				exitCode: 48,
			},
			{
				code: "SIGTERM",
				stderr: "FLYWHEEL_ATOMIC_APPLY_CONTRACT_MISMATCH",
				exitCode: null,
			},
		])(
			"maps atomic-apply contract mismatch $code before drift and identity errors",
			async ({ code, stderr, exitCode }) => {
				const execFile = vi.fn(async () => {
					throw Object.assign(new Error("atomic apply refused"), {
						code,
						stderr: `${stderr}\nFLYWHEEL_TARGET_IDENTITY_MISMATCH school`,
						profileChildStarted: true,
					});
				});
				const rejected = await deps(execFile)
					.applyProfile("school")
					.catch((error: unknown) => error);
				expect(rejected).toBeInstanceOf(ApplyContractMismatchError);
				expect(rejected).toMatchObject({
					evidence: {
						exitCode,
						childStarted: true,
						detail: expect.stringContaining(
							"FLYWHEEL_ATOMIC_APPLY_CONTRACT_MISMATCH",
						),
					},
				});
			},
		);

		it.each([46, 47])(
			"exit %s maps to ActiveMarkerDriftError before account-specific identity errors",
			async (code) => {
				const execFile = vi.fn(async () => {
					throw Object.assign(new Error("stale active repair failed"), {
						code,
						stderr:
							"FLYWHEEL_TARGET_IDENTITY_MISMATCH school\nFLYWHEEL_STALE_ACTIVE_REPAIR_FAILED personal\n",
					});
				});
				const rejected = await deps(execFile)
					.applyProfile("school")
					.catch((error: unknown) => error);
				expect(rejected).toBeInstanceOf(ActiveMarkerDriftError);
				expect(rejected).toMatchObject({
					evidence: { exitCode: code, childStarted: null },
				});
			},
		);

		it.each([
			"FLYWHEEL_STALE_ACTIVE_UNRESOLVABLE personal",
			"FLYWHEEL_STALE_ACTIVE_REPAIR_FAILED personal",
		])("maps terminal marker fallback %s", async (stderr) => {
			const execFile = vi.fn(async () => {
				throw Object.assign(new Error("signal-shaped failure"), {
					code: "SIGTERM",
					stderr,
				});
			});
			await expect(
				deps(execFile).applyProfile("school"),
			).rejects.toBeInstanceOf(ActiveMarkerDriftError);
		});

		it("keeps exit 30 as TargetStaleError when reconciliation success markers precede it", async () => {
			const execFile = vi.fn(async () => {
				throw Object.assign(new Error("target stale"), {
					code: 30,
					stderr:
						"FLYWHEEL_STALE_ACTIVE_MARKER business\nFLYWHEEL_STALE_ACTIVE_RECONCILED business shopping\nFLYWHEEL_TARGET_STALE business\n",
				});
			});
			await expect(
				deps(execFile).applyProfile("business"),
			).rejects.toBeInstanceOf(TargetStaleError);
		});

		it("does not forward reconciliation success markers as warnings", async () => {
			const warns: string[] = [];
			const execFile = vi.fn(async () => ({
				stdout: "Switched",
				stderr:
					"FLYWHEEL_STALE_ACTIVE_MARKER business\nFLYWHEEL_STALE_ACTIVE_RECONCILED business shopping\n",
			}));
			await deps(execFile, (message) => warns.push(message)).applyProfile(
				"shopping",
			);
			expect(warns).toEqual([]);
		});
	});

	describe("FLY-871 bypass env scrub (Codex R2#1 — no inheritance into the auto path)", () => {
		const KEY = "FLYWHEEL_CLAUDE_FRESHNESS_BYPASS";
		let saved: string | undefined;
		afterEach(() => {
			if (saved === undefined) delete process.env[KEY];
			else process.env[KEY] = saved;
		});

		it("a polluted parent env (bypass=1) is SCRUBBED from the child env", async () => {
			saved = process.env[KEY];
			process.env[KEY] = "1"; // parent pollution (.env / launchd / test parent)
			const execFile = vi.fn(async () => ({ stdout: "Switched", stderr: "" }));
			await deps(execFile).applyProfile("school");
			const callEnv = execFile.mock.calls[0][2].env as Record<string, string>;
			expect(callEnv[KEY]).toBeUndefined(); // the bypass NEVER reaches bash automatically
			// the legitimate delegated-lock env is still passed
			expect(callEnv.FLYWHEEL_CLAUDE_LOCK_DELEGATED).toBe(String(process.pid));
		});
	});

	describe("FLY-1182 identity bypass env scrub", () => {
		const KEY = "FLYWHEEL_PROFILE_IDENTITY_BYPASS";
		let saved: string | undefined;
		afterEach(() => {
			if (saved === undefined) delete process.env[KEY];
			else process.env[KEY] = saved;
		});

		it("scrubs a polluted identity bypass from every automatic delegated switch", async () => {
			saved = process.env[KEY];
			process.env[KEY] = "1";
			const execFile = vi.fn(async () => ({ stdout: "Switched", stderr: "" }));

			await deps(execFile).applyProfile("school");

			const callEnv = execFile.mock.calls[0][2].env as Record<string, string>;
			expect(callEnv[KEY]).toBeUndefined();
			expect(callEnv.FLYWHEEL_CLAUDE_LOCK_DELEGATED).toBe(String(process.pid));
		});
	});
});
