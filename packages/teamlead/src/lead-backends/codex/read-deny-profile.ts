/**
 * FLY-260 — read-deny hardening for a read-only Codex Lead (e.g. Mufasa).
 *
 * A Codex Lead's model exec shell runs under Codex's sandbox. The legacy
 * `sandbox_mode=read-only` only blocks WRITES + network, NOT reads, so the shell
 * can `cat ~/.codex-mufasa/auth.json` (and `printenv` a token) and exfil it through
 * the Lead's normal Discord reply. This module is the runtime half of the fix: a
 * Codex 0.140 `[permissions]` profile (`filesystem = "deny"`, kernel/Seatbelt
 * enforced) + `[shell_environment_policy].exclude`, gated behind the default-OFF
 * `FLYWHEEL_CODEX_LEAD_READ_DENY` flag.
 *
 * Pure + dependency-light → exhaustively unit-tested. The canonical config shape
 * lives in `scripts/templates/codex-read-deny-profile.toml` (the single source of
 * truth, appended by `codex-lead-tui-home.sh`); the constants here mirror it and a
 * cross-check test asserts they stay in sync (so the deny list can never silently
 * regress into a known-ineffective form — see FORBIDDEN_DENY_FORMS below).
 *
 * NOTE: comments here deliberately avoid the literal recursive-glob token (a
 * star-star-slash sequence contains the JS block-comment terminator). The actual
 * glob strings live in the constant arrays, which are the source of truth.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The named permission profile (matches the fragment's `default_permissions`). */
export const READ_DENY_PROFILE_NAME = "flywheel-lead-secret-deny";

/** The base the profile extends. A read-only Lead extends `:read-only`. */
export const READ_DENY_PROFILE_EXTENDS = ":read-only";

/**
 * The VERIFIED-EFFECTIVE filesystem deny keys (real-machine tested on codex 0.140).
 * Single source for the cross-check test. The glob forms are load-bearing:
 * a single-star codex-home glob does NOT match `~/.codex-mufasa`, and a bare env
 * glob is rejected by codex — only the recursive double-star forms below work.
 * `~/.flywheel` is DELIBERATELY ABSENT: a COE Director orchestrates through it, and
 * the secret env files inside it are caught by the recursive `.env` glob instead.
 */
export const READ_DENY_FILESYSTEM_PATHS: readonly string[] = [
	"~/.codex**",
	"~/.ssh",
	"~/.aws",
	"~/.config/gh",
	"~/.config/gcloud",
	"~/.npmrc",
	"~/.docker",
	"~/**/.env**",
];

/**
 * Token-shaped env excluded from the model exec shell (env is a parallel exfil
 * surface). Glob matching is case-INSENSITIVE (verified), so UPPER forms suffice.
 * Token-shaped ONLY — never a blanket FLYWHEEL_ / DISCORD_ removal (that would break
 * a COE Director's coordination env).
 *
 * FLY-350 code-review HIGH-2: also hide the `FLYWHEEL_LEAD_ACTIONS_*` coordinate
 * family (notably the broker socket path) from the model exec shell. It is NOT a
 * secret, but the lead-actions MCP child receives those coordinates via its
 * config.toml `env` table — the MODEL never needs them, and leaking the broker
 * socket path would hand a path-disclosure half of a token-fetch to the model if
 * the AF_UNIX connect block ever regressed. This is a targeted family, NOT a
 * blanket `FLYWHEEL_*`, so Director coordination env still survives.
 */
export const READ_DENY_ENV_EXCLUDE: readonly string[] = [
	"*TOKEN*",
	"*SECRET*",
	"*KEY*",
	"FLYWHEEL_LEAD_ACTIONS_*",
];

/**
 * Known-INEFFECTIVE / forbidden deny forms — the cross-check test asserts the
 * fragment contains NONE of these (each would be a silent "fake hardening"):
 * a single-star codex-home glob, a bare env glob, and a blanket `~/.flywheel`.
 */
export const FORBIDDEN_DENY_FORMS: readonly string[] = [
	'"~/.codex*"',
	'"**/.env"',
	'"~/.flywheel"',
];

/** Absolute path to the committed read-deny config fragment (the single source of
 * truth the shell appends). Resolves from BOTH the src and dist layouts (the module
 * sits at .../src|dist/lead-backends/codex/, the fragment at .../scripts/templates/). */
export function readDenyProfileFragmentPath(): string {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	// up: codex -> lead-backends -> (src|dist) -> package root
	const pkgRoot = join(moduleDir, "..", "..", "..");
	return join(pkgRoot, "scripts", "templates", "codex-read-deny-profile.toml");
}

/** Is read-deny enabled? Default OFF (byte-compat); only the literal "1" enables. */
export function isReadDenyEnabled(env: NodeJS.ProcessEnv): boolean {
	return env.FLYWHEEL_CODEX_LEAD_READ_DENY === "1";
}

/** The `activePermissionProfile` echo from a thread/start|resume result. */
interface ActiveProfileEcho {
	id?: unknown;
	extends?: unknown;
}

/** Extract `result.activePermissionProfile` (top-level of a thread result). */
export function extractActivePermissionProfile(
	result: unknown,
): ActiveProfileEcho | null {
	const r = (result ?? {}) as Record<string, unknown>;
	const p = r.activePermissionProfile;
	if (!p || typeof p !== "object") return null;
	return p as ActiveProfileEcho;
}

/**
 * HARD-ASSERT a thread/start|resume result has the read-deny profile active.
 * Throws (caller fail-closes) on null / wrong id / missing-or-wrong extends — i.e.
 * any state where the profile is NOT the expected `{id, extends}` (which would mean
 * the model exec shell is running UNPROTECTED despite the flag being on). Asserts
 * BOTH id and extends so a same-id-different-base drift cannot pass.
 */
export function assertReadDenyProfileActive(result: unknown): void {
	const p = extractActivePermissionProfile(result);
	if (!p) {
		throw new Error(
			`FLY-260 read-deny gate: activePermissionProfile is null/absent — the model exec shell would run UNPROTECTED (expected profile "${READ_DENY_PROFILE_NAME}"). Refusing to start.`,
		);
	}
	if (p.id !== READ_DENY_PROFILE_NAME) {
		throw new Error(
			`FLY-260 read-deny gate: activePermissionProfile.id is ${JSON.stringify(p.id)}, expected "${READ_DENY_PROFILE_NAME}". Refusing to start.`,
		);
	}
	if (p.extends !== READ_DENY_PROFILE_EXTENDS) {
		throw new Error(
			`FLY-260 read-deny gate: activePermissionProfile.extends is ${JSON.stringify(p.extends)}, expected "${READ_DENY_PROFILE_EXTENDS}". Refusing to start.`,
		);
	}
}

/**
 * Pre-gateway enforcement gate (R2-B3). A read-only Codex Lead resumes its existing
 * thread to preserve memory, but `thread/resume` is NOT confirmed to echo
 * `activePermissionProfile` (a turnless thread cannot even be probed without auth).
 * A fresh `thread/start` DOES reliably echo it, and the active profile comes from the
 * daemon/app-server's `default_permissions` (which governs EVERY thread on that
 * process). So before wiring the Discord gateway / founder TUI window, start ONE
 * throwaway ephemeral thread (no model turn), assert its profile, and discard it —
 * proving the daemon config is active independent of the resume echo. Throws
 * (caller fail-closes, no gateway) on any failure. The throwaway thread is turnless
 * and harmless (no rollout persisted).
 */
export async function assertReadDenyDaemonActive(
	startEphemeral: () => Promise<{ id: string; result: unknown }>,
): Promise<void> {
	const { result } = await startEphemeral();
	assertReadDenyProfileActive(result);
}

/** The minimal thread surface `resolveReadDenyThread` needs (both runtimes' proc). */
export interface ReadDenyThreadProc {
	startThreadWithResult(
		params?: Record<string, unknown>,
	): Promise<{ id: string; result: unknown }>;
	resumeThreadWithResult(
		threadId: string,
		params?: Record<string, unknown>,
	): Promise<{ id: string; result: unknown }>;
}

/**
 * The full read-deny ensureThread DECISION, factored out of both runtimes so the
 * fail-closed wiring is unit-testable (Codex code-review R1#1). Sequence:
 *   1. ephemeral throwaway `startThreadWithResult` → assert the daemon's profile is
 *      active (proves enforcement independent of the unconfirmed resume echo);
 *   2. if `saved`: `resumeThreadWithResult` (preserve memory) + assert IF it echoes a
 *      profile. A resume error that `isResumeSelfHeal` recognizes (the TUI's turnless
 *      "no rollout" case) falls through to a fresh start; any other error rethrows;
 *   3. else / after self-heal: fresh `startThreadWithResult` + assert.
 * Any assertion failure THROWS — the caller (ensureThread) runs before wire()/gateway,
 * so a throw fail-closes with NO Discord gateway / TUI window. Returns the thread id +
 * whether it is a freshly-started thread (caller persists the id when `fresh`).
 */
export async function resolveReadDenyThread(
	proc: ReadDenyThreadProc,
	opts: {
		saved: string | undefined;
		threadParams: Record<string, unknown>;
		/** TUI turnless self-heal predicate; omitted (headless) = no self-heal. */
		isResumeSelfHeal?: (err: unknown) => boolean;
	},
): Promise<{ id: string; fresh: boolean }> {
	// 1. ephemeral enforcement gate (fail-closed).
	await assertReadDenyDaemonActive(() =>
		proc.startThreadWithResult(opts.threadParams),
	);
	// 2. resume the real thread (memory continuity).
	if (opts.saved) {
		try {
			const { id, result } = await proc.resumeThreadWithResult(
				opts.saved,
				opts.threadParams,
			);
			if (extractActivePermissionProfile(result)) {
				assertReadDenyProfileActive(result);
			}
			return { id, fresh: false };
		} catch (err) {
			if (!opts.isResumeSelfHeal?.(err)) throw err;
			// turnless thread (no rollout) → nothing to preserve; fall to a fresh start.
		}
	}
	// 3. fresh thread — the real start reliably echoes the profile; assert it.
	const { id, result } = await proc.startThreadWithResult(opts.threadParams);
	assertReadDenyProfileActive(result);
	return { id, fresh: true };
}
