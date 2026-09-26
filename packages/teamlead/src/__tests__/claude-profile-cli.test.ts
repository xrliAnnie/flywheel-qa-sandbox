/**
 * FLY-696 M1/① — the SwitchDeps that drive the `flywheel-claude-profile` bash
 * script (the A-Keychain executor, landed last). applyProfile = `use <name>`
 * (throws on non-zero → fail-closed); readActiveProfile parses `status`. Exec is
 * injected so this is tested without the real script/Keychain.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeClaudeProfileSwitchDeps } from "../account-heal/claude-profile-cli.js";
import {
	FreshnessUnavailableError,
	TargetStaleError,
} from "../account-heal/switch-executor.js";

const BIN = "/x/flywheel-claude-profile";

function deps(
	execFile: ReturnType<typeof vi.fn>,
	onWarn?: (m: string) => void,
) {
	return makeClaudeProfileSwitchDeps({
		binPath: BIN,
		execFile: execFile as never,
		withLock: async (_l, fn) => fn(),
		onWarn,
	});
}

describe("makeClaudeProfileSwitchDeps", () => {
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

	it("FLY-865: applyProfile forwards the switch script's stderr (identity warning) via onWarn on a SUCCESSFUL (exit 0) switch", async () => {
		// `use` exits 0 (token switched) but warned on stderr that the display
		// identity was not updated — execFile discards it, so onWarn must surface it.
		const execFile = vi.fn(async () => ({
			stdout: "Switched machine Claude account to profile 'school'",
			stderr:
				"Warning: profile 'school' has no captured display identity — new claude /status may show a stale account. To fix: capture school",
		}));
		const warns: string[] = [];
		await deps(execFile, (m) => warns.push(m)).applyProfile("school");
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
		await deps(execFile, (m) => warns.push(m)).applyProfile("school");
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
});
