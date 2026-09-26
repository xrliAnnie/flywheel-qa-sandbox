/**
 * FLY-696 M1/① — SwitchDeps backed by the `flywheel-claude-profile` bash script.
 *
 * The switch executor's three injected deps, driving the repo-owned script (the
 * A-Keychain executor, landed last):
 *   - applyProfile(name)  → `flywheel-claude-profile use <name>` (writes the
 *     machine Keychain via a no-argv helper + verify-before-commit). Rejects on
 *     non-zero → the executor fails closed and leaves state untouched.
 *   - readActiveProfile() → `flywheel-claude-profile status` → the active pool
 *     account (crash-recovery authority); null when unset / the script errors.
 *   - withLock            → withMkdirLock on ~/.flywheel/claude-accounts.lock,
 *     the SAME lock the bash script takes.
 *
 * `execFile` is injected so this is unit-tested without the real script/Keychain.
 */

import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { withMkdirLock } from "./mkdir-lock.js";
import {
	FreshnessUnavailableError,
	type SwitchDeps,
	TargetStaleError,
} from "./switch-executor.js";

const execFileAsync = promisify(nodeExecFile);

type ExecFileFn = (
	file: string,
	args: string[],
	options?: { env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export interface ClaudeProfileCliDeps {
	/** Absolute path to the `flywheel-claude-profile` script. */
	binPath: string;
	/** Injectable for tests; defaults to node's execFile (promisified). */
	execFile?: ExecFileFn;
	withLock?: <T>(lockPath: string, fn: () => Promise<T>) => Promise<T>;
	/**
	 * FLY-865: surface the switch script's stderr on the AUTOMATIC path. `use`'s
	 * display-identity sync is best-effort — on a missing/failed/locked identity
	 * it warns to stderr but still exits 0 (the token switch is authoritative).
	 * A manual CLI user sees that warning; the Bridge's execFile would otherwise
	 * DISCARD it, silently leaving a stale `/status` display after an auto-switch.
	 * Forward it so the operator can see the display identity wasn't updated.
	 * Defaults to console.warn.
	 */
	onWarn?: (message: string) => void;
}

/** Default script path (override via FLYWHEEL_CLAUDE_PROFILE_BIN). */
export function claudeProfileBinPath(): string {
	return (
		process.env.FLYWHEEL_CLAUDE_PROFILE_BIN ?? "flywheel-claude-profile" // resolved on PATH as a last resort
	);
}

export function makeClaudeProfileSwitchDeps(
	deps: ClaudeProfileCliDeps,
): SwitchDeps {
	const exec: ExecFileFn = deps.execFile ?? (execFileAsync as ExecFileFn);
	const withLock = deps.withLock ?? withMkdirLock;
	const onWarn = deps.onWarn ?? ((m: string) => console.warn(m));

	return {
		withLock,
		async applyProfile(name: string): Promise<void> {
			// FLY-852 (QA-caught self-deadlock): switchAccount calls this INSIDE its
			// withMkdirLock critical section, and the bash script takes the SAME
			// lock — the child would wait on its own parent until timeout. Delegate:
			// pass THIS process's pid; the script accepts it ONLY when it matches
			// the live holder marker (a forged env without the real lock falls
			// through to a normal acquire), and neither takes nor releases the lock.
			// Throws on non-zero exit (execFile rejects) → executor fails closed.
			//
			// FLY-871 R1/C2 (Codex R2#1 HIGH — bypass anti-inheritance): the freshness
			// bypass is an EMERGENCY HUMAN override only. The automatic path spreads
			// the whole parent env, so a polluted parent (.env / launchd wrapper /
			// test parent) could silently carry the bypass into the Bridge auto-switch
			// path. Scrub it here (layer 1); bash additionally refuses it in
			// delegated-lock mode (layer 2). Both are test assertions.
			const childEnv: NodeJS.ProcessEnv = {
				...process.env,
				FLYWHEEL_CLAUDE_LOCK_DELEGATED: String(process.pid),
			};
			delete childEnv.FLYWHEEL_CLAUDE_FRESHNESS_BYPASS;
			let stderr: string;
			try {
				({ stderr } = await exec(deps.binPath, ["use", name], {
					env: childEnv,
				}));
			} catch (err) {
				// FLY-871 R1/C3 — map the freshness exit codes to typed errors the
				// switch executor's candidate loop understands. 30 = target stale (try
				// the next candidate); 31 = freshness helper unavailable (environmental,
				// fail-closed, no loop). Match the numeric exit code OR the stderr
				// marker (execFile may surface `code` as a signal string). Any OTHER
				// failure rethrows unchanged (existing fail-closed behavior).
				const e = err as { code?: number | string; stderr?: string };
				const errText = String(e.stderr ?? "");
				if (e.code === 30 || /FLYWHEEL_TARGET_STALE/.test(errText)) {
					throw new TargetStaleError(name);
				}
				if (e.code === 31 || /FLYWHEEL_FRESHNESS_UNAVAILABLE/.test(errText)) {
					throw new FreshnessUnavailableError(errText.trim() || undefined);
				}
				throw err;
			}
			// FLY-865: the switch succeeded (exit 0), but `use` may have warned on
			// stderr that the DISPLAY identity wasn't updated (no captured identity,
			// lock timeout, patch failure). execFile discards child stderr, so
			// forward it — otherwise an auto-switch silently leaves a stale /status.
			// Only forward actual warnings: `use` also emits a non-warning success
			// line ("Updated ~/.claude.json display identity …") to stderr, which
			// must not be logged at warn level.
			const warning = (stderr ?? "")
				.split("\n")
				.filter((l) => /\bWarning:/i.test(l))
				.join("\n")
				.trim();
			if (warning) onWarn(`[flywheel-claude-profile use ${name}] ${warning}`);
		},
		async readActiveProfile(): Promise<string | null> {
			try {
				const { stdout } = await exec(deps.binPath, ["status"]);
				const m = stdout.match(/Active profile:\s*(.+)/);
				return m?.[1]?.trim() ?? null;
			} catch {
				return null;
			}
		},
	};
}
