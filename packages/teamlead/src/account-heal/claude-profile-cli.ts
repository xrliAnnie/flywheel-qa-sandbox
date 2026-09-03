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
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AccountStore } from "./account-store.js";
import {
	reconcileTransitionJournal,
	withAccountsLock,
} from "./accounts-lock.js";
import {
	type ApplyChildEvidence,
	childEvidenceFromError,
	type ReconcileMachineResult,
	summarizeApplyFailure,
} from "./apply-child-evidence.js";
import {
	defaultClaudeJsonPath,
	defaultMachinePoolDir,
	resolveMachineAccount,
} from "./machine-account.js";
import { renewMkdirLock } from "./mkdir-lock.js";
import {
	ActiveMarkerDriftError,
	ApplyContractMismatchError,
	type ApplyProfileIdentityCheck,
	type ApplyProfileReport,
	FreshnessUnavailableError,
	IdentityRollbackFailedError,
	KeychainPreimageConflictError,
	LiveIdentityUnavailableError,
	LockLeaseLostError,
	type SwitchDeps,
	TargetIdentityMismatchError,
	TargetIdentityRolledBackError,
	TargetIdentityUnverifiableError,
	TargetQuotaExhaustedError,
	TargetStaleError,
} from "./switch-executor.js";

const execFileAsync = promisify(nodeExecFile);

type ExecFileFn = (
	file: string,
	args: string[],
	options?: {
		env?: NodeJS.ProcessEnv;
		timeout?: number;
		maxBuffer?: number;
	},
) => Promise<{ stdout: string; stderr: string }>;

type SpawnFn = typeof nodeSpawn;

const PROFILE_LABEL = /^(?!\.)(?!.*\.\.)[A-Za-z0-9._-]+$/;
const DIGEST = /^[a-f0-9]{64}$/;
const UNAVAILABLE_IDENTITY_DIGEST = createHash("sha256")
	.update("identity-digest-unavailable")
	.digest("hex");
const IDENTITY_CHECKPOINTS = new Set(["pre_write", "capture_back", "capture"]);
const IDENTITY_VERDICTS = new Set([
	"match",
	"mismatch",
	"unknown_missing",
	"profile_network",
	"profile_malformed",
	"profile_unauthorized",
]);
const MAX_APPLY_FAILURE_DETAIL_LENGTH = 2048;

function applyFailureDiagnostic(error: unknown, stderr: string): Error {
	const base = error instanceof Error ? error.message : String(error);
	const profileChildStarted =
		typeof (error as { profileChildStarted?: unknown })?.profileChildStarted ===
		"boolean"
			? (error as { profileChildStarted: boolean }).profileChildStarted
			: undefined;
	const normalized = Array.from(
		stderr.replace(/[\r\n]+/g, " | "),
		(character) => {
			const code = character.charCodeAt(0);
			return code < 32 || code === 127 ? " " : character;
		},
	)
		.join("")
		.trim();
	const detail =
		normalized.length > MAX_APPLY_FAILURE_DETAIL_LENGTH
			? `…${normalized.slice(-(MAX_APPLY_FAILURE_DETAIL_LENGTH - 1))}`
			: normalized;
	const diagnostic = new Error(detail ? `${base}: ${detail}` : base, {
		cause: error,
	});
	return profileChildStarted === undefined
		? diagnostic
		: Object.assign(diagnostic, { profileChildStarted });
}

function hasControlCharacter(value: string): boolean {
	return Array.from(value, (character) => character.charCodeAt(0)).some(
		(code) => code < 32 || code === 127,
	);
}

function parseApplyProfileReport(raw: string): ApplyProfileReport | undefined {
	try {
		const parsed = JSON.parse(raw) as {
			identityChecks?: unknown;
			freshened?: unknown;
		};
		if (
			!Array.isArray(parsed.identityChecks) ||
			parsed.identityChecks.length > 32
		) {
			return undefined;
		}
		const identityChecks: ApplyProfileIdentityCheck[] = [];
		for (const value of parsed.identityChecks) {
			if (typeof value !== "object" || value === null) return undefined;
			const check = value as Record<string, unknown>;
			if (
				typeof check.label !== "string" ||
				!PROFILE_LABEL.test(check.label) ||
				typeof check.checkpoint !== "string" ||
				!IDENTITY_CHECKPOINTS.has(check.checkpoint) ||
				typeof check.verdict !== "string" ||
				!IDENTITY_VERDICTS.has(check.verdict) ||
				(check.expectedKey !== undefined &&
					(typeof check.expectedKey !== "string" ||
						!DIGEST.test(check.expectedKey))) ||
				(check.actualDigest !== undefined &&
					(typeof check.actualDigest !== "string" ||
						!DIGEST.test(check.actualDigest)))
			) {
				return undefined;
			}
			identityChecks.push({
				label: check.label,
				checkpoint: check.checkpoint as ApplyProfileIdentityCheck["checkpoint"],
				verdict: check.verdict as ApplyProfileIdentityCheck["verdict"],
				...(typeof check.expectedKey === "string"
					? { expectedKey: check.expectedKey }
					: {}),
				...(typeof check.actualDigest === "string"
					? { actualDigest: check.actualDigest }
					: {}),
			});
		}
		let freshened: ApplyProfileReport["freshened"];
		if (parsed.freshened !== undefined) {
			if (typeof parsed.freshened !== "object" || parsed.freshened === null) {
				return undefined;
			}
			const fact = parsed.freshened as Record<string, unknown>;
			if (
				typeof fact.name !== "string" ||
				!PROFILE_LABEL.test(fact.name) ||
				typeof fact.identityProof !== "object" ||
				fact.identityProof === null
			) {
				return undefined;
			}
			const proof = fact.identityProof as Record<string, unknown>;
			if (
				typeof proof.email !== "string" ||
				proof.email.length === 0 ||
				proof.email.length > 320 ||
				hasControlCharacter(proof.email) ||
				typeof proof.uuid !== "string" ||
				proof.uuid.length === 0 ||
				proof.uuid.length > 256 ||
				hasControlCharacter(proof.uuid)
			) {
				return undefined;
			}
			freshened = {
				name: fact.name,
				identityProof: { email: proof.email, uuid: proof.uuid },
			};
		}
		return { identityChecks, ...(freshened ? { freshened } : {}) };
	} catch {
		return undefined;
	}
}

function readApplyProfileReport(path: string): ApplyProfileReport | undefined {
	try {
		const stat = lstatSync(path);
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o777) !== 0o600 ||
			stat.size > 64 * 1024
		) {
			return undefined;
		}
		return parseApplyProfileReport(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

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
	poolDir?: string;
	claudeJsonPath?: string;
	storePath?: string;
	lockPath?: string;
	deliverNotification?: SwitchDeps["deliverNotification"];
}

/**
 * Default script path for direct Node/daemon launches (override via
 * FLYWHEEL_CLAUDE_PROFILE_BIN). Public Bash `use|next` treats the invoked
 * primitive as authoritative and overwrites the ambient value before launch.
 */
export function claudeProfileBinPath(): string {
	return (
		process.env.FLYWHEEL_CLAUDE_PROFILE_BIN ?? "flywheel-claude-profile" // resolved on PATH as a last resort
	);
}

export async function reconcileClaudeProfile(
	deps: Pick<ClaudeProfileCliDeps, "binPath" | "execFile"> & {
		env?: NodeJS.ProcessEnv;
	},
): Promise<ReconcileMachineResult> {
	const childEnv: NodeJS.ProcessEnv = {
		...process.env,
		...deps.env,
		FLYWHEEL_NODE_BIN: process.execPath,
		FLYWHEEL_PROFILE_GROUP_LEADER: "1",
	};
	delete childEnv.FLYWHEEL_CLAUDE_LOCK_DELEGATED;
	delete childEnv.FLYWHEEL_LEASE_PROOF;
	for (const retired of [
		"FLY" + "WHEEL_CLAUDE_FRESHNESS_BYPASS",
		"FLY" + "WHEEL_CLAUDE_QUOTA_BYPASS",
		"FLY" + "WHEEL_ATOMIC_FRESHNESS_BYPASS",
		"FLY" + "WHEEL_ATOMIC_QUOTA_BYPASS",
	]) {
		delete childEnv[retired];
	}
	delete childEnv.FLYWHEEL_PROFILE_IDENTITY_BYPASS;
	delete childEnv.FLYWHEEL_CLAUDE_QUOTA_PREVERIFIED;
	delete childEnv.FLYWHEEL_ATOMIC_SWITCH_APPLY;
	delete childEnv.FLYWHEEL_ATOMIC_SWITCH_AUDIT_CMD;
	let stdout = "";
	let stderr = "";
	let exitCode: number | null = 0;
	let message: string | undefined;
	try {
		({ stdout, stderr } = await (
			deps.execFile ?? (execFileAsync as ExecFileFn)
		)(deps.binPath, ["reconcile"], {
			env: childEnv,
			timeout: 60_000,
			maxBuffer: 65_536,
		}));
	} catch (error) {
		const failure = error as {
			code?: unknown;
			stdout?: unknown;
			stderr?: unknown;
			message?: unknown;
		};
		stdout = typeof failure.stdout === "string" ? failure.stdout : "";
		stderr = typeof failure.stderr === "string" ? failure.stderr : "";
		exitCode =
			typeof failure.code === "number" && Number.isInteger(failure.code)
				? failure.code
				: null;
		message = typeof failure.message === "string" ? failure.message : undefined;
	}
	const detail = summarizeApplyFailure(stderr, message);
	if (exitCode !== 0 && exitCode !== 10 && exitCode !== 20) {
		return { ok: false, outcome: "execution_failed", exitCode, detail };
	}
	let parsed: Record<string, unknown>;
	try {
		const value = JSON.parse(stdout.trim());
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error("reconcile result is not an object");
		}
		parsed = value as Record<string, unknown>;
	} catch {
		return { ok: false, outcome: "malformed", exitCode, detail };
	}
	const validLabel = (value: unknown): value is string =>
		typeof value === "string" &&
		value.length <= 256 &&
		PROFILE_LABEL.test(value);
	if (exitCode === 0 && parsed.outcome === "already_consistent") {
		return { ok: true, outcome: "already_consistent", exitCode, detail };
	}
	if (
		exitCode === 0 &&
		parsed.outcome === "repaired" &&
		validLabel(parsed.from) &&
		validLabel(parsed.to)
	) {
		return {
			ok: true,
			outcome: "repaired",
			from: parsed.from,
			to: parsed.to,
			exitCode,
			detail,
		};
	}
	if (exitCode === 10 && parsed.outcome === "no_credential") {
		return { ok: false, outcome: "no_credential", exitCode, detail };
	}
	const reasons = new Set([
		"keychain_unreadable",
		"probe_unavailable",
		"anchor_ambiguous",
	]);
	if (
		exitCode === 20 &&
		parsed.outcome === "unresolvable" &&
		typeof parsed.reason === "string" &&
		parsed.reason.length <= 256 &&
		reasons.has(parsed.reason)
	) {
		return {
			ok: false,
			outcome: "unresolvable",
			reason: parsed.reason,
			exitCode,
			detail,
		};
	}
	return { ok: false, outcome: "malformed", exitCode, detail };
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
		storePath: deps.storePath,
		lockPath: deps.lockPath,
		withLock,
		renewLock: renewMkdirLock,
		deliverNotification: deps.deliverNotification,
		resolveMachineAccount: (store: AccountStore) =>
			resolveMachineAccount({
				poolDir: deps.poolDir ?? defaultMachinePoolDir(),
				claudeJsonPath: deps.claudeJsonPath ?? defaultClaudeJsonPath(),
				store,
			}),
		async applyProfile(
			name: string,
			context?: Parameters<SwitchDeps["applyProfile"]>[1],
		): Promise<
			{
				identitySynced: boolean;
				evidence: ApplyChildEvidence;
			} & ApplyProfileReport
		> {
			// FLY-852 (QA-caught self-deadlock): switchAccount calls this INSIDE its
			// withMkdirLock critical section, and the bash script takes the SAME
			// lock — the child would wait on its own parent until timeout. Delegate:
			// pass THIS process's pid; the script accepts it ONLY when it matches
			// the live holder marker (a forged env without the real lock falls
			// through to a normal acquire), and neither takes nor releases the lock.
			// Throws on non-zero exit (execFile rejects) → executor fails closed.
			//
			// The automatic path spreads the parent env, so retired safety-bypass
			// names are still scrubbed defensively even though no runtime reads them.
			const childEnv: NodeJS.ProcessEnv = {
				...process.env,
				FLYWHEEL_CLAUDE_LOCK_DELEGATED: String(process.pid),
				FLYWHEEL_NODE_BIN: process.execPath,
			};
			if (context) {
				childEnv.FLYWHEEL_CLAUDE_ACCOUNTS_LOCK = context.lease.lockPath;
				childEnv.FLYWHEEL_LEASE_PROOF = JSON.stringify(context.lease);
			}
			for (const retired of [
				"FLY" + "WHEEL_CLAUDE_FRESHNESS_BYPASS",
				"FLY" + "WHEEL_CLAUDE_QUOTA_BYPASS",
				"FLY" + "WHEEL_ATOMIC_FRESHNESS_BYPASS",
				"FLY" + "WHEEL_ATOMIC_QUOTA_BYPASS",
			]) {
				delete childEnv[retired];
			}
			delete childEnv.FLYWHEEL_PROFILE_IDENTITY_BYPASS;
			delete childEnv.FLYWHEEL_CLAUDE_QUOTA_PREVERIFIED;
			delete childEnv.FLYWHEEL_ATOMIC_SWITCH_APPLY;
			delete childEnv.FLYWHEEL_ATOMIC_SWITCH_AUDIT_CMD;
			childEnv.FLYWHEEL_ATOMIC_SWITCH_APPLY = "1";
			if (context?.manualMode === "next") {
				childEnv.FLYWHEEL_ATOMIC_SWITCH_AUDIT_CMD = "next";
			}
			if (deps.quotaPreverified === true) {
				childEnv.FLYWHEEL_CLAUDE_QUOTA_PREVERIFIED = "1";
			}
			const reportDir = mkdtempSync(join(tmpdir(), "flywheel-apply-report-"));
			const reportPath = join(reportDir, "report.json");
			childEnv.FLYWHEEL_APPLY_REPORT_FILE = reportPath;
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
				const report = readApplyProfileReport(reportPath);
				rmSync(reportDir, { recursive: true, force: true });
				// FLY-871 R1/C3 — map the freshness exit codes to typed errors the
				// switch executor's candidate loop understands. 30 = target stale (try
				// the next candidate); 31 = freshness helper unavailable (environmental,
				// fail-closed, no loop). Match the numeric exit code OR the stderr
				// marker (execFile may surface `code` as a signal string). Any OTHER
				// failure rethrows unchanged (existing fail-closed behavior).
				const e = err as { code?: number | string; stderr?: string };
				const errText = String(e.stderr ?? "");
				const evidence = childEvidenceFromError(err, errText);
				if (
					e.code === 48 ||
					/FLYWHEEL_ATOMIC_APPLY_CONTRACT_MISMATCH/.test(errText)
				) {
					throw new ApplyContractMismatchError(
						evidence.detail || undefined,
						evidence,
					);
				}
				if (/FLYWHEEL_KEYCHAIN_PREIMAGE_CONFLICT/.test(errText)) {
					throw new KeychainPreimageConflictError(
						errText.trim(),
						report,
						evidence,
					);
				}
				if (/FLYWHEEL_LIVE_IDENTITY_UNAVAILABLE/.test(errText)) {
					throw new LiveIdentityUnavailableError(
						errText.trim(),
						report,
						evidence,
					);
				}
				// FLY-1201: classify active-marker reconciliation before the older
				// account-specific identity markers. Strict capture may emit an inner
				// target-identity marker before the outer repair failure; that must not
				// poison or rotate the requested target account.
				if (
					e.code === 46 ||
					e.code === 47 ||
					/FLYWHEEL_STALE_ACTIVE_UNRESOLVABLE|FLYWHEEL_STALE_ACTIVE_REPAIR_FAILED/.test(
						errText,
					)
				) {
					throw new ActiveMarkerDriftError(
						errText.trim() || undefined,
						evidence,
					);
				}
				if (
					e.code === 34 ||
					/FLYWHEEL_TARGET_IDENTITY_MISMATCH/.test(errText)
				) {
					const actualDigest =
						report?.identityChecks.find(
							(check) =>
								check.label === name &&
								check.checkpoint === "pre_write" &&
								check.verdict === "mismatch",
						)?.actualDigest ??
						errText.match(/actualDigest=([a-f0-9]{64})/)?.[1] ??
						UNAVAILABLE_IDENTITY_DIGEST;
					throw new TargetIdentityMismatchError(
						name,
						actualDigest,
						report,
						evidence,
					);
				}
				if (e.code === 36 || /FLYWHEEL_IDENTITY_ROLLED_BACK/.test(errText)) {
					throw new TargetIdentityRolledBackError(name, report, evidence);
				}
				if (
					e.code === 37 ||
					/FLYWHEEL_IDENTITY_ROLLBACK_FAILED/.test(errText)
				) {
					throw new IdentityRollbackFailedError(name, report, evidence);
				}
				if (
					e.code === 38 ||
					/FLYWHEEL_TARGET_IDENTITY_UNVERIFIABLE/.test(errText)
				) {
					throw new TargetIdentityUnverifiableError(name, report, evidence);
				}
				if (e.code === 32 || /FLYWHEEL_TARGET_QUOTA_EXHAUSTED/.test(errText)) {
					throw new TargetQuotaExhaustedError(name, report, evidence);
				}
				if (e.code === 30 || /FLYWHEEL_TARGET_STALE/.test(errText)) {
					throw new TargetStaleError(name, report, evidence);
				}
				if (e.code === 31 || /FLYWHEEL_FRESHNESS_UNAVAILABLE/.test(errText)) {
					throw new FreshnessUnavailableError(
						errText.trim() || undefined,
						report,
						evidence,
					);
				}
				if (e.code === 39 || /FLYWHEEL_LOCK_LEASE_LOST/.test(errText)) {
					throw new LockLeaseLostError(errText.trim() || undefined, evidence);
				}
				throw Object.assign(applyFailureDiagnostic(err, errText), { evidence });
			}
			const report = readApplyProfileReport(reportPath);
			rmSync(reportDir, { recursive: true, force: true });
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
			return {
				identitySynced: !/display identity/i.test(warning),
				identityChecks: report?.identityChecks ?? [],
				...(report?.freshened ? { freshened: report.freshened } : {}),
				evidence: { exitCode: 0, childStarted: true, detail: "" },
			};
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
			reject(Object.assign(error, { profileChildStarted: false }));
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
						{
							code: code ?? childSignal,
							stdout,
							stderr,
							profileChildStarted: true,
						},
					),
				);
			};
			finishAfterGroupExit();
		});
	});
}
