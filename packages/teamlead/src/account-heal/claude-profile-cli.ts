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

import {
	execFile as nodeExecFile,
	spawn as nodeSpawn,
	type SpawnOptions,
} from "node:child_process";
import { promisify } from "node:util";
import {
	reconcileTransitionJournal,
	withAccountsLock,
} from "./accounts-lock.js";
import { type LeaseProof, renewMkdirLock } from "./mkdir-lock.js";
import {
	FreshnessUnavailableError,
	LockLeaseLostError,
	type SwitchDeps,
	TargetQuotaExhaustedError,
	TargetStaleError,
} from "./switch-executor.js";

const execFileAsync = promisify(nodeExecFile);

type ExecFileFn = (
	file: string,
	args: string[],
	options?: { env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

type SpawnFn = typeof nodeSpawn;

export interface ClaudeProfileCliDeps {
	/** Absolute path to the `flywheel-claude-profile` script. */
	binPath: string;
	/** Injectable for tests; defaults to node's execFile (promisified). */
	execFile?: ExecFileFn;
	spawn?: SpawnFn;
	withLock?: SwitchDeps["withLock"];
	/** Internal daemon assertion that its candidate was live quota-verified. */
	quotaPreverified?: boolean;
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
	const withLock: SwitchDeps["withLock"] =
		deps.withLock ??
		((lockPath, fn) =>
			withAccountsLock(lockPath, fn, {
				reconcile: (lease) =>
					reconcileTransitionJournal(lease, { binPath: deps.binPath }),
			}));
	const onWarn = deps.onWarn ?? ((m: string) => console.warn(m));

	return {
		withLock,
		renewLock: renewMkdirLock,
		async applyProfile(
			name: string,
			context?: { lease: LeaseProof; signal: AbortSignal },
		): Promise<void> {
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
				FLYWHEEL_NODE_BIN: process.execPath,
			};
			if (context) {
				childEnv.FLYWHEEL_CLAUDE_ACCOUNTS_LOCK = context.lease.lockPath;
				childEnv.FLYWHEEL_LEASE_PROOF = JSON.stringify(context.lease);
			}
			delete childEnv.FLYWHEEL_CLAUDE_FRESHNESS_BYPASS;
			delete childEnv.FLYWHEEL_CLAUDE_QUOTA_BYPASS;
			delete childEnv.FLYWHEEL_CLAUDE_QUOTA_PREVERIFIED;
			if (deps.quotaPreverified === true) {
				childEnv.FLYWHEEL_CLAUDE_QUOTA_PREVERIFIED = "1";
			}
			let stderr: string;
			try {
				if (deps.execFile !== undefined || context === undefined) {
					({ stderr } = await exec(deps.binPath, ["use", name], {
						env: childEnv,
					}));
				} else {
					({ stderr } = await runDetachedProfile(
						deps.spawn ?? nodeSpawn,
						deps.binPath,
						["use", name],
						childEnv,
						context.signal,
					));
				}
			} catch (err) {
				// FLY-871 R1/C3 — map the freshness exit codes to typed errors the
				// switch executor's candidate loop understands. 30 = target stale (try
				// the next candidate); 31 = freshness helper unavailable (environmental,
				// fail-closed, no loop). Match the numeric exit code OR the stderr
				// marker (execFile may surface `code` as a signal string). Any OTHER
				// failure rethrows unchanged (existing fail-closed behavior).
				const e = err as { code?: number | string; stderr?: string };
				const errText = String(e.stderr ?? "");
				if (e.code === 32 || /FLYWHEEL_TARGET_QUOTA_EXHAUSTED/.test(errText)) {
					throw new TargetQuotaExhaustedError(name);
				}
				if (e.code === 30 || /FLYWHEEL_TARGET_STALE/.test(errText)) {
					throw new TargetStaleError(name);
				}
				if (e.code === 31 || /FLYWHEEL_FRESHNESS_UNAVAILABLE/.test(errText)) {
					throw new FreshnessUnavailableError(errText.trim() || undefined);
				}
				if (e.code === 39 || /FLYWHEEL_LOCK_LEASE_LOST/.test(errText)) {
					throw new LockLeaseLostError(errText.trim() || undefined);
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

function runDetachedProfile(
	spawn: SpawnFn,
	file: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	signal: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const options: SpawnOptions = {
			detached: true,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		};
		const child = spawn(file, args, options);
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const terminateGroup = () => {
			if (child.pid === undefined) return;
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {
				// The group may already be fully reaped.
			}
			killTimer = setTimeout(() => {
				if (child.pid === undefined) return;
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					// already reaped
				}
			}, 2_000);
			killTimer.unref?.();
		};
		const groupExists = (): boolean => {
			if (child.pid === undefined) return false;
			try {
				process.kill(-child.pid, 0);
				return true;
			} catch (error) {
				return (error as NodeJS.ErrnoException).code === "EPERM";
			}
		};
		if (signal.aborted) terminateGroup();
		else signal.addEventListener("abort", terminateGroup, { once: true });
		child.once("error", (error) => {
			if (killTimer) clearTimeout(killTimer);
			signal.removeEventListener("abort", terminateGroup);
			reject(error);
		});
		child.once("close", (code, childSignal) => {
			const deadline = Date.now() + 5_000;
			const finishAfterGroupExit = () => {
				if (groupExists() && Date.now() < deadline) {
					setTimeout(finishAfterGroupExit, 25);
					return;
				}
				if (groupExists() && child.pid !== undefined) {
					try {
						process.kill(-child.pid, "SIGKILL");
					} catch {
						// already gone
					}
				}
				if (killTimer) clearTimeout(killTimer);
				signal.removeEventListener("abort", terminateGroup);
				if (code === 0 && !groupExists()) {
					resolve({ stdout, stderr });
					return;
				}
				reject(
					Object.assign(
						new Error(
							`flywheel-claude-profile exited ${code ?? childSignal ?? "unknown"}`,
						),
						{ code: code ?? childSignal, stdout, stderr },
					),
				);
			};
			finishAfterGroupExit();
		});
	});
}
