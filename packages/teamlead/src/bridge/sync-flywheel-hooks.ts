/**
 * FLY-142 PR #186 amend — auto-deploy runtime hooks on Bridge boot.
 *
 * **Problem (QA hybrid-swap, 2026-05-13)**: Pre-#186 the hook flow was:
 *
 *   1. Engineer edits `scripts/hooks/inbox-check.sh` in the repo (source).
 *   2. Operator runs `/setup-flywheel-hooks` manually → copies to
 *      `~/.flywheel/hooks/inbox-check.sh` (runtime).
 *   3. PostToolUse hook in `~/.claude/settings.json` invokes the runtime path.
 *
 * `pnpm build` and Bridge restart do NOT deploy the runtime hook. QA caught
 * this on hybrid swap: PR #186's source had the FLY-142 sentinel
 * short-circuit but the runtime hook was the pre-FLY-142 version, so old
 * Runners on the CommDB rollback path STILL hit the wake bug because the
 * hook continued to ignore `type='response'` rows.
 *
 * **Fix**: Bridge boot computes sha256 of source vs runtime for each
 * deployable hook. If they differ (or runtime missing), copy + chmod 0755.
 * Idempotent — no rewrite when checksums match. Synchronous in
 * `startBridge` so the very first Runner spawn after a Bridge restart sees
 * the fresh hook (parallelizing the sync against Runner spawn would leave
 * a short window where the old hook still runs).
 *
 * Allowlist is explicit: only `inbox-check.sh` is in scope. The other file
 * in `scripts/hooks/` is `flywheel-session-end.sh`, which is registered as
 * a Claude Code SessionEnd hook (separate registration mechanism, separate
 * deploy path) and is intentionally NOT covered here.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	readFile,
	readlink,
	rename,
	rm,
	stat,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Hooks that this module is allowed to write into the runtime directory. */
const HOOKS_TO_DEPLOY = ["inbox-check.sh"] as const;

/**
 * Hook files MUST be readable + executable by the running user — without
 * this, Claude Code's PostToolUse invocation fails silently and the FLY-142
 * sentinel short-circuit never runs. We require BOTH the owner-exec bit
 * (0o100) and at least the world-read bit (0o004) so other tooling
 * (e.g., test slot processes with different UIDs) can still invoke the
 * hook. The deployed mode is exactly 0o755 to match what
 * `/setup-flywheel-hooks` produces.
 */
const REQUIRED_HOOK_MODE = 0o755;
const REQUIRED_OWNER_EXEC_BIT = 0o100;

export interface SyncFlywheelHooksResult {
	/** Names that were copied (either missing or content-divergent). */
	synced: string[];
	/** Names whose runtime checksum already matched source. */
	matched: string[];
	/** Names whose source file is missing (no-op, logged). */
	missingSource: string[];
	/** Per-hook errors that didn't block the overall sweep. */
	errors: Array<{ name: string; error: string }>;
}

/** Resolve the in-repo source hooks directory from this module's location.
 *
 * In production: this file is compiled to
 * `packages/teamlead/dist/bridge/sync-flywheel-hooks.js`, so the repo root
 * is four levels up. Allow override via env for unusual deploys (tests use
 * `opts.sourceDir` directly instead of mutating the env).
 */
function defaultSourceHooksDir(): string {
	const envOverride = process.env.FLYWHEEL_HOOK_SOURCE_DIR;
	if (envOverride && envOverride.length > 0) return envOverride;
	const here = dirname(fileURLToPath(import.meta.url));
	// dist/bridge → packages/teamlead/dist/bridge → up 4 → repo root
	return resolve(here, "..", "..", "..", "..", "scripts", "hooks");
}

/** Resolve the runtime hooks directory.
 *
 * Defaults to `~/.flywheel/hooks` to match the `/setup-flywheel-hooks`
 * skill. `FLYWHEEL_HOOKS_DIR` lets ops point this at a test slot.
 */
function defaultTargetHooksDir(): string {
	const envOverride = process.env.FLYWHEEL_HOOKS_DIR;
	if (envOverride && envOverride.length > 0) return envOverride;
	return join(homedir(), ".flywheel", "hooks");
}

async function sha256OfFile(path: string): Promise<string | null> {
	try {
		const buf = await readFile(path);
		return createHash("sha256").update(buf).digest("hex");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

export async function syncFlywheelHooks(opts?: {
	sourceDir?: string;
	targetDir?: string;
	hooks?: readonly string[];
	log?: (msg: string) => void;
}): Promise<SyncFlywheelHooksResult> {
	const sourceDir = opts?.sourceDir ?? defaultSourceHooksDir();
	const targetDir = opts?.targetDir ?? defaultTargetHooksDir();
	const hooks = opts?.hooks ?? HOOKS_TO_DEPLOY;
	const log = opts?.log ?? ((m: string) => console.log(`[sync-hooks] ${m}`));

	const result: SyncFlywheelHooksResult = {
		synced: [],
		matched: [],
		missingSource: [],
		errors: [],
	};

	if (!existsSync(targetDir)) {
		await mkdir(targetDir, { recursive: true });
		log(`created target dir: ${targetDir}`);
	}

	for (const name of hooks) {
		const sourcePath = join(sourceDir, name);
		const targetPath = join(targetDir, name);
		try {
			const sourceHash = await sha256OfFile(sourcePath);
			if (sourceHash === null) {
				result.missingSource.push(name);
				log(`source missing: ${sourcePath} (skipping ${name})`);
				continue;
			}
			const targetHash = await sha256OfFile(targetPath);
			if (targetHash === sourceHash) {
				// Codex Round 3 MEDIUM #1: content match alone is not enough —
				// if a prior boot wrote fresh bytes but crashed/failed before
				// chmod, the next boot would see matching content and skip
				// repair, leaving a non-executable hook. Stat + chmod when the
				// executable bit is missing.
				const targetStat = await stat(targetPath);
				if ((targetStat.mode & REQUIRED_OWNER_EXEC_BIT) === 0) {
					await chmod(targetPath, REQUIRED_HOOK_MODE);
					result.synced.push(name);
					log(
						`repaired permissions on ${name} (content matched but mode=${(targetStat.mode & 0o777).toString(8)} missing exec bit)`,
					);
					continue;
				}
				result.matched.push(name);
				continue;
			}
			// Content diverged — atomic temp-write + rename so existing
			// PostToolUse readers see EITHER the old file or the new file,
			// never a half-written or non-executable transient (Codex Round 3
			// MEDIUM #2: prior `writeFile` overwrite had a window where
			// readers could see truncated bytes or pre-chmod 0o644 perms).
			//
			// We use a temp file in the SAME directory so the final `rename`
			// is atomic on POSIX. chmod runs on the temp file before the
			// rename so the final file is observable as 0o755 the moment it
			// appears under `targetPath`.
			//
			// We use `writeFile` to a fresh path (not `copyFile`) so the
			// executable bit is set explicitly — some filesystems (NFS, fuse
			// mounts) don't propagate source mode bits reliably via copy.
			const buf = await readFile(sourcePath);
			const tempPath = `${targetPath}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
			try {
				await writeFile(tempPath, buf);
				await chmod(tempPath, REQUIRED_HOOK_MODE);
				await rename(tempPath, targetPath);
			} catch (writeErr) {
				// Clean up the temp file on failure so we don't accumulate
				// orphans across crash-restart loops.
				await unlink(tempPath).catch(() => {});
				throw writeErr;
			}
			result.synced.push(name);
			log(
				`synced ${name} (${targetHash === null ? "missing → installed" : `diverged → updated; old=${targetHash.slice(0, 8)} new=${sourceHash.slice(0, 8)}`})`,
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			result.errors.push({ name, error: message });
			log(`ERROR syncing ${name}: ${message}`);
		}
	}

	return result;
}

// ============================================================================
// CLI bin auto-deploy
// ============================================================================
//
// FLY-142 PR #186 Bug #5 (QA hybrid-swap re-test 2026-05-13): the Round 1
// fix in `claude-lead.sh` hard-exits when `command -v agent-team-transport`
// fails and the mailbox backend is active. Without this auto-deploy, the
// CLI sits in `packages/agent-team-transport/dist/bin/agent-team-transport-cli.js`
// (under the monorepo) and is not on the launcher's PATH — Lead never
// starts. Same class of gap as the hook auto-deploy (commits da4b3f1 +
// 662f7ec): we ship source code, but the runtime invocation path expects
// a system-installed binary.
//
// Fix: at Bridge boot, symlink `~/.flywheel/bin/agent-team-transport` to
// the in-repo dist artifact. claude-lead.sh prepends `~/.flywheel/bin` to
// PATH so `command -v` finds it. Symlink (rather than copy) so:
//   - No re-deploy needed when the CLI is rebuilt via `tsc`.
//   - Node module resolution from the dist JS still walks up to its real
//     parent dir (the monorepo dist) and finds sibling packages normally.
//
// Idempotent: existing symlink with the correct target is a no-op. If the
// target is wrong (e.g., an old repo path from a moved checkout), replace.
// If a non-symlink file exists at the path, replace it as well (operator
// may have once `cp`d the CLI by hand — overwrite that with a symlink).

/** Items that this module is allowed to symlink into the bin directory. */
interface CliBinSpec {
	/** Symlink name (e.g., `agent-team-transport`). */
	name: string;
	/** Source path relative to the repo root. */
	relativeSource: string;
}

const CLI_BINS_TO_DEPLOY: readonly CliBinSpec[] = [
	{
		name: "agent-team-transport",
		relativeSource:
			"packages/agent-team-transport/dist/bin/agent-team-transport-cli.js",
	},
];

export interface SyncFlywheelCliBinResult {
	/** Names where the symlink was created or replaced. */
	synced: string[];
	/** Names whose existing symlink already pointed at the right target. */
	matched: string[];
	/** Names whose source binary is missing (no-op, logged). */
	missingSource: string[];
	/** Per-bin errors collected without aborting the sweep. */
	errors: Array<{ name: string; error: string }>;
}

/** Resolve the repo root from this module's compiled location. */
function defaultRepoRoot(): string {
	const envOverride = process.env.FLYWHEEL_REPO_ROOT;
	if (envOverride && envOverride.length > 0) return envOverride;
	const here = dirname(fileURLToPath(import.meta.url));
	// dist/bridge → packages/teamlead/dist/bridge → up 4 → repo root
	return resolve(here, "..", "..", "..", "..");
}

/** Resolve the runtime bin directory.
 *
 * Defaults to `~/.flywheel/bin`. claude-lead.sh prepends this dir to PATH
 * at boot so `command -v agent-team-transport` finds the symlink.
 * `FLYWHEEL_BIN_DIR` overrides for test slots.
 */
function defaultBinDir(): string {
	const envOverride = process.env.FLYWHEEL_BIN_DIR;
	if (envOverride && envOverride.length > 0) return envOverride;
	return join(homedir(), ".flywheel", "bin");
}

/**
 * Sync runtime CLI bin symlinks from the monorepo dist to the runtime bin
 * directory. Default allowlist: `agent-team-transport`. Idempotent on
 * matching symlink target; replaces stale symlinks; replaces regular files.
 *
 * Errors per-bin are collected but don't abort the sweep — Bridge boot
 * stays soft-fail like `syncFlywheelHooks` (operator can fall back to the
 * legacy manual install while the issue is investigated).
 */
export async function syncFlywheelCliBin(opts?: {
	repoRoot?: string;
	binDir?: string;
	bins?: readonly CliBinSpec[];
	log?: (msg: string) => void;
}): Promise<SyncFlywheelCliBinResult> {
	const repoRoot = opts?.repoRoot ?? defaultRepoRoot();
	const binDir = opts?.binDir ?? defaultBinDir();
	const bins = opts?.bins ?? CLI_BINS_TO_DEPLOY;
	const log = opts?.log ?? ((m: string) => console.log(`[sync-bin] ${m}`));

	const result: SyncFlywheelCliBinResult = {
		synced: [],
		matched: [],
		missingSource: [],
		errors: [],
	};

	if (!existsSync(binDir)) {
		await mkdir(binDir, { recursive: true });
		log(`created bin dir: ${binDir}`);
	}

	for (const spec of bins) {
		const sourcePath = resolve(repoRoot, spec.relativeSource);
		const linkPath = join(binDir, spec.name);
		try {
			// Source must exist before we wire up a symlink to it. Bridge boot
			// happens AFTER `pnpm install + pnpm build`, so the dist artifact
			// should be there; if it's not, log and continue (operator can
			// rebuild — Bridge will retry on the next boot).
			if (!existsSync(sourcePath)) {
				result.missingSource.push(spec.name);
				log(`source missing: ${sourcePath} (skipping ${spec.name})`);
				continue;
			}

			// FLY-142 PR #186 Codex Round 5 HIGH: fresh `tsc` emits JS files
			// at mode 0o644 (npm's `bin` field would normally chmod +x on
			// install, but we're using the in-monorepo dist directly, never
			// `npm install`-ing the package). A symlink to a non-executable
			// file passes `command -v` but fails at invocation with
			// `Permission denied`, which trips `claude-lead.sh`'s FATAL
			// check exactly the same way the missing-CLI case did. Stat the
			// source target and chmod 0o755 when the owner-exec bit is
			// missing — defense in depth so the CLI works regardless of
			// `tsc` mode-preservation quirks.
			const sourceStat = await stat(sourcePath);
			if ((sourceStat.mode & REQUIRED_OWNER_EXEC_BIT) === 0) {
				await chmod(sourcePath, REQUIRED_HOOK_MODE);
				log(
					`chmod 0755 on source ${spec.relativeSource} (was mode=${(sourceStat.mode & 0o777).toString(8)}; tsc default 0644 does not preserve exec bit)`,
				);
			}

			// Inspect existing entry at linkPath via lstat (does NOT follow
			// symlinks — we want to know if it's a symlink, regular file, or
			// absent).
			let existingLink: string | null = null;
			let existingIsSymlink = false;
			let existingIsFile = false;
			try {
				const st = await lstat(linkPath);
				if (st.isSymbolicLink()) {
					existingIsSymlink = true;
					existingLink = await readlink(linkPath);
				} else {
					existingIsFile = true;
				}
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
				// linkPath doesn't exist yet — fall through and create.
			}

			if (existingIsSymlink && existingLink === sourcePath) {
				result.matched.push(spec.name);
				continue;
			}

			// Replace stale symlink or regular file. Use rm (not unlink) so
			// `force: true` absorbs the race where the entry was removed
			// between lstat and remove.
			if (existingIsSymlink || existingIsFile) {
				await rm(linkPath, { force: true });
			}
			await symlink(sourcePath, linkPath);
			result.synced.push(spec.name);
			log(
				`synced ${spec.name} → ${sourcePath}${
					existingIsSymlink
						? ` (replaced stale symlink → ${existingLink})`
						: existingIsFile
							? " (replaced regular file)"
							: " (created)"
				}`,
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			result.errors.push({ name: spec.name, error: message });
			log(`ERROR syncing ${spec.name}: ${message}`);
		}
	}

	return result;
}

// ============================================================================
// Umbrella: hooks + CLI bin
// ============================================================================

/**
 * One-stop runtime deploy on Bridge boot: hooks + CLI bins. Logs a single
 * summary per group so ops can spot drift at a glance. Errors per item are
 * collected — Bridge keeps booting (soft fail). See the two underlying
 * functions for per-item semantics and rollback notes.
 */
export async function syncFlywheelRuntime(opts?: {
	hooks?: Parameters<typeof syncFlywheelHooks>[0];
	bins?: Parameters<typeof syncFlywheelCliBin>[0];
}): Promise<{
	hooks: SyncFlywheelHooksResult;
	bins: SyncFlywheelCliBinResult;
}> {
	const hooks = await syncFlywheelHooks(opts?.hooks);
	const bins = await syncFlywheelCliBin(opts?.bins);
	return { hooks, bins };
}
