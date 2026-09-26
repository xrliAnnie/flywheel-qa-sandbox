/**
 * Unit tests for the FLY-142 PR #186 amend — `syncFlywheelHooks`.
 *
 * Pins the gap QA caught on hybrid swap:
 *   - Source / runtime checksum diverge → Bridge boot detects + syncs.
 *   - Idempotent — repeated boots with matching content don't rewrite.
 *   - Missing target dir is created.
 *   - Missing source file is logged + skipped (no crash).
 *   - Executable bit (0o755) is set on the deployed file regardless of
 *     source perms (some filesystems don't propagate mode via copy).
 *   - Allowlist is honored — only declared hooks are written; other files
 *     in the source dir are NOT copied even if they exist.
 */

import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	syncFlywheelCliBin,
	syncFlywheelHooks,
	syncFlywheelRuntime,
} from "../bridge/sync-flywheel-hooks.js";

interface Ctx {
	sourceDir: string;
	targetDir: string;
	cleanup: () => Promise<void>;
}

async function setupTmpDirs(): Promise<Ctx> {
	const root = await mkdtemp(join(tmpdir(), "fly142-sync-hooks-"));
	const sourceDir = join(root, "source");
	const targetDir = join(root, "target");
	await mkdir(sourceDir, { recursive: true });
	// targetDir intentionally NOT created — tests verify mkdir-on-demand.
	return {
		sourceDir,
		targetDir,
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}

describe("syncFlywheelHooks", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setupTmpDirs();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	it("missing target dir + missing target file: creates dir and copies", async () => {
		await writeFile(
			join(ctx.sourceDir, "inbox-check.sh"),
			"#!/bin/bash\necho hi\n",
		);

		const result = await syncFlywheelHooks({
			sourceDir: ctx.sourceDir,
			targetDir: ctx.targetDir,
			log: () => {},
		});

		expect(result.synced).toEqual(["inbox-check.sh"]);
		expect(result.matched).toEqual([]);
		expect(result.errors).toEqual([]);

		const deployed = await readFile(
			join(ctx.targetDir, "inbox-check.sh"),
			"utf-8",
		);
		expect(deployed).toBe("#!/bin/bash\necho hi\n");

		const st = await stat(join(ctx.targetDir, "inbox-check.sh"));
		// Executable bit on owner+group+other (0o755).
		expect(st.mode & 0o755).toBe(0o755);
	});

	it("source / runtime checksum diverge: copies new content", async () => {
		await writeFile(
			join(ctx.sourceDir, "inbox-check.sh"),
			"#!/bin/bash\nfresh\n",
		);
		await mkdir(ctx.targetDir, { recursive: true });
		await writeFile(
			join(ctx.targetDir, "inbox-check.sh"),
			"#!/bin/bash\nstale\n",
		);
		// Set a different permission to verify chmod overrides whatever was there.
		await chmod(join(ctx.targetDir, "inbox-check.sh"), 0o644);

		const result = await syncFlywheelHooks({
			sourceDir: ctx.sourceDir,
			targetDir: ctx.targetDir,
			log: () => {},
		});

		expect(result.synced).toEqual(["inbox-check.sh"]);
		expect(result.matched).toEqual([]);
		const deployed = await readFile(
			join(ctx.targetDir, "inbox-check.sh"),
			"utf-8",
		);
		expect(deployed).toBe("#!/bin/bash\nfresh\n");
		const st = await stat(join(ctx.targetDir, "inbox-check.sh"));
		expect(st.mode & 0o755).toBe(0o755);
	});

	it("idempotent: matching checksum → no rewrite (matched, not synced)", async () => {
		const content = "#!/bin/bash\nsame\n";
		await writeFile(join(ctx.sourceDir, "inbox-check.sh"), content);
		await mkdir(ctx.targetDir, { recursive: true });
		await writeFile(join(ctx.targetDir, "inbox-check.sh"), content);
		await chmod(join(ctx.targetDir, "inbox-check.sh"), 0o755);

		const stBefore = await stat(join(ctx.targetDir, "inbox-check.sh"));

		const result = await syncFlywheelHooks({
			sourceDir: ctx.sourceDir,
			targetDir: ctx.targetDir,
			log: () => {},
		});

		expect(result.matched).toEqual(["inbox-check.sh"]);
		expect(result.synced).toEqual([]);

		const stAfter = await stat(join(ctx.targetDir, "inbox-check.sh"));
		// mtime should be unchanged because we didn't rewrite.
		expect(stAfter.mtimeMs).toBe(stBefore.mtimeMs);
	});

	it("running sync twice in a row: second call is fully idempotent", async () => {
		await writeFile(join(ctx.sourceDir, "inbox-check.sh"), "#!/bin/bash\nv\n");

		const first = await syncFlywheelHooks({
			sourceDir: ctx.sourceDir,
			targetDir: ctx.targetDir,
			log: () => {},
		});
		expect(first.synced).toEqual(["inbox-check.sh"]);

		const second = await syncFlywheelHooks({
			sourceDir: ctx.sourceDir,
			targetDir: ctx.targetDir,
			log: () => {},
		});
		expect(second.synced).toEqual([]);
		expect(second.matched).toEqual(["inbox-check.sh"]);
		expect(second.errors).toEqual([]);
	});

	it("missing source: reported in result, no crash", async () => {
		// sourceDir exists but the expected hook file does not.
		const result = await syncFlywheelHooks({
			sourceDir: ctx.sourceDir,
			targetDir: ctx.targetDir,
			log: () => {},
		});

		expect(result.missingSource).toEqual(["inbox-check.sh"]);
		expect(result.synced).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	it("allowlist: extra files in source dir are NOT copied", async () => {
		await writeFile(
			join(ctx.sourceDir, "inbox-check.sh"),
			"#!/bin/bash\nrun\n",
		);
		await writeFile(
			join(ctx.sourceDir, "evil-extra.sh"),
			"#!/bin/bash\nrm -rf /\n",
		);
		await writeFile(
			join(ctx.sourceDir, "flywheel-session-end.sh"),
			"#!/bin/bash\nsession\n",
		);

		const result = await syncFlywheelHooks({
			sourceDir: ctx.sourceDir,
			targetDir: ctx.targetDir,
			log: () => {},
		});

		expect(result.synced).toEqual(["inbox-check.sh"]);
		// Non-allowlisted files MUST NOT exist in target.
		await expect(stat(join(ctx.targetDir, "evil-extra.sh"))).rejects.toThrow(
			/ENOENT/,
		);
		await expect(
			stat(join(ctx.targetDir, "flywheel-session-end.sh")),
		).rejects.toThrow(/ENOENT/);
	});

	it("hooks override: caller can extend allowlist (e.g., for follow-up scope)", async () => {
		await writeFile(join(ctx.sourceDir, "hook-A.sh"), "A\n");
		await writeFile(join(ctx.sourceDir, "hook-B.sh"), "B\n");

		const result = await syncFlywheelHooks({
			sourceDir: ctx.sourceDir,
			targetDir: ctx.targetDir,
			hooks: ["hook-A.sh", "hook-B.sh"],
			log: () => {},
		});

		expect(result.synced.sort()).toEqual(["hook-A.sh", "hook-B.sh"]);
		expect(await readFile(join(ctx.targetDir, "hook-A.sh"), "utf-8")).toBe(
			"A\n",
		);
		expect(await readFile(join(ctx.targetDir, "hook-B.sh"), "utf-8")).toBe(
			"B\n",
		);
	});

	it("Codex R3 MEDIUM #1: content match BUT missing exec bit → chmod-only repair, no rewrite", async () => {
		// Reproduces the partial-boot failure mode: a previous sync wrote
		// fresh bytes but crashed before chmod. The next boot must see the
		// missing exec bit and re-chmod, even though content already matches.
		const content = "#!/bin/bash\nmatch\n";
		await writeFile(join(ctx.sourceDir, "inbox-check.sh"), content);
		await mkdir(ctx.targetDir, { recursive: true });
		await writeFile(join(ctx.targetDir, "inbox-check.sh"), content);
		// Simulate the post-crash state — content matches but mode is 0o644.
		await chmod(join(ctx.targetDir, "inbox-check.sh"), 0o644);

		const stBefore = await stat(join(ctx.targetDir, "inbox-check.sh"));
		expect(stBefore.mode & 0o100).toBe(0); // owner-exec NOT set

		const result = await syncFlywheelHooks({
			sourceDir: ctx.sourceDir,
			targetDir: ctx.targetDir,
			log: () => {},
		});

		// Treated as a repair sync — reports as synced, not matched.
		expect(result.synced).toEqual(["inbox-check.sh"]);
		expect(result.matched).toEqual([]);
		const stAfter = await stat(join(ctx.targetDir, "inbox-check.sh"));
		expect(stAfter.mode & 0o755).toBe(0o755);
		// Content unchanged (no rewrite, just chmod).
		const after = await readFile(
			join(ctx.targetDir, "inbox-check.sh"),
			"utf-8",
		);
		expect(after).toBe(content);
	});

	it("Codex R3 MEDIUM #2: divergent rewrite uses atomic temp+rename — no half-written window observable", async () => {
		// Reproduces the live-overwrite race: a PostToolUse reader invoking
		// the hook during a sync MUST see either old-good content (with old
		// permissions) or new-good content (with 0o755). Never a truncated
		// or pre-chmod transient.
		//
		// We can't directly observe the rename's atomicity from a single test
		// process, but we CAN assert the temp-file strategy: after `sync`,
		// no `.tmp.*` artifacts remain in the target dir even when content
		// diverged. And the final file is 0o755 with the new content.
		const { readdir } = await import("node:fs/promises");
		await writeFile(join(ctx.sourceDir, "inbox-check.sh"), "#!/bin/bash\nv2\n");
		await mkdir(ctx.targetDir, { recursive: true });
		await writeFile(join(ctx.targetDir, "inbox-check.sh"), "#!/bin/bash\nv1\n");

		const result = await syncFlywheelHooks({
			sourceDir: ctx.sourceDir,
			targetDir: ctx.targetDir,
			log: () => {},
		});

		expect(result.synced).toEqual(["inbox-check.sh"]);

		// No orphan temp files left behind.
		const targetFiles = await readdir(ctx.targetDir);
		expect(targetFiles.filter((f) => f.includes(".tmp."))).toEqual([]);
		// Final file is the new content + executable.
		expect(await readFile(join(ctx.targetDir, "inbox-check.sh"), "utf-8")).toBe(
			"#!/bin/bash\nv2\n",
		);
		const st = await stat(join(ctx.targetDir, "inbox-check.sh"));
		expect(st.mode & 0o755).toBe(0o755);
	});

	it("FLYWHEEL_HOOKS_DIR env: respected as default target when no override", async () => {
		// Mock env via temporary override.
		const original = process.env.FLYWHEEL_HOOKS_DIR;
		process.env.FLYWHEEL_HOOKS_DIR = ctx.targetDir;
		await writeFile(
			join(ctx.sourceDir, "inbox-check.sh"),
			"#!/bin/bash\nenv\n",
		);
		try {
			// Override sourceDir only — targetDir comes from env.
			const result = await syncFlywheelHooks({
				sourceDir: ctx.sourceDir,
				log: () => {},
			});
			expect(result.synced).toEqual(["inbox-check.sh"]);
			expect(
				await readFile(join(ctx.targetDir, "inbox-check.sh"), "utf-8"),
			).toBe("#!/bin/bash\nenv\n");
		} finally {
			if (original === undefined) delete process.env.FLYWHEEL_HOOKS_DIR;
			else process.env.FLYWHEEL_HOOKS_DIR = original;
		}
	});
});

// ============================================================================
// FLY-142 PR #186 Bug #5 — CLI bin symlink auto-deploy
// ============================================================================
//
// QA hybrid-swap re-test (2026-05-13) caught that Round 1's `claude-lead.sh`
// FATAL check fires in prod because `agent-team-transport` ships as a
// monorepo dist artifact and is never on the launcher's PATH. These tests
// pin the symlink semantics: idempotent on matching target, replace stale
// symlinks, replace regular files, handle missing source, allowlist-only.

interface BinCtx {
	repoRoot: string;
	binDir: string;
	cleanup: () => Promise<void>;
}

async function setupBinDirs(): Promise<BinCtx> {
	const root = await mkdtemp(join(tmpdir(), "fly142-sync-bin-"));
	const repoRoot = join(root, "repo");
	const binDir = join(root, "bin");
	// Mimic the in-repo dist layout that `syncFlywheelCliBin`'s default
	// allowlist expects (`packages/agent-team-transport/dist/bin/`).
	const distBin = join(
		repoRoot,
		"packages",
		"agent-team-transport",
		"dist",
		"bin",
	);
	await mkdir(distBin, { recursive: true });
	return {
		repoRoot,
		binDir,
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}

describe("syncFlywheelCliBin", () => {
	let ctx: BinCtx;

	beforeEach(async () => {
		ctx = await setupBinDirs();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	const writeCliSource = async () => {
		const sourcePath = join(
			ctx.repoRoot,
			"packages",
			"agent-team-transport",
			"dist",
			"bin",
			"agent-team-transport-cli.js",
		);
		await writeFile(sourcePath, "#!/usr/bin/env node\nconsole.log('cli');\n");
		await chmod(sourcePath, 0o755);
		return sourcePath;
	};

	it("missing bin dir + missing symlink: creates dir + symlink → source", async () => {
		const sourcePath = await writeCliSource();

		const result = await syncFlywheelCliBin({
			repoRoot: ctx.repoRoot,
			binDir: ctx.binDir,
			log: () => {},
		});

		expect(result.synced).toEqual(["agent-team-transport"]);
		expect(result.matched).toEqual([]);
		expect(result.errors).toEqual([]);

		// Symlink exists + points at the dist binary.
		const linkPath = join(ctx.binDir, "agent-team-transport");
		const st = await lstat(linkPath);
		expect(st.isSymbolicLink()).toBe(true);
		expect(await readlink(linkPath)).toBe(sourcePath);
	});

	it("idempotent: matching symlink target → matched, not re-synced", async () => {
		const sourcePath = await writeCliSource();
		await mkdir(ctx.binDir, { recursive: true });
		await symlink(sourcePath, join(ctx.binDir, "agent-team-transport"));

		const result = await syncFlywheelCliBin({
			repoRoot: ctx.repoRoot,
			binDir: ctx.binDir,
			log: () => {},
		});

		expect(result.matched).toEqual(["agent-team-transport"]);
		expect(result.synced).toEqual([]);
	});

	it("stale symlink (wrong target): replaced with correct target", async () => {
		const sourcePath = await writeCliSource();
		await mkdir(ctx.binDir, { recursive: true });
		// Operator's previous repo at a different path — point at a stale
		// location to simulate a moved checkout.
		const stalePath = join(ctx.repoRoot, "old-checkout", "cli.js");
		await mkdir(dirOf(stalePath), { recursive: true });
		await writeFile(stalePath, "old\n");
		await symlink(stalePath, join(ctx.binDir, "agent-team-transport"));

		const result = await syncFlywheelCliBin({
			repoRoot: ctx.repoRoot,
			binDir: ctx.binDir,
			log: () => {},
		});

		expect(result.synced).toEqual(["agent-team-transport"]);
		expect(await readlink(join(ctx.binDir, "agent-team-transport"))).toBe(
			sourcePath,
		);
	});

	it("regular file at bin path: replaced with symlink", async () => {
		const sourcePath = await writeCliSource();
		await mkdir(ctx.binDir, { recursive: true });
		// Operator once `cp`'d the CLI here — we should overwrite with a
		// symlink so subsequent rebuilds are picked up automatically.
		await writeFile(
			join(ctx.binDir, "agent-team-transport"),
			"#!/usr/bin/env node\nconsole.log('stale copy');\n",
		);
		await chmod(join(ctx.binDir, "agent-team-transport"), 0o755);

		const result = await syncFlywheelCliBin({
			repoRoot: ctx.repoRoot,
			binDir: ctx.binDir,
			log: () => {},
		});

		expect(result.synced).toEqual(["agent-team-transport"]);
		const st = await lstat(join(ctx.binDir, "agent-team-transport"));
		expect(st.isSymbolicLink()).toBe(true);
		expect(await readlink(join(ctx.binDir, "agent-team-transport"))).toBe(
			sourcePath,
		);
	});

	it("missing source binary: reported in missingSource, no crash", async () => {
		// Don't writeCliSource — source binary intentionally missing.
		const result = await syncFlywheelCliBin({
			repoRoot: ctx.repoRoot,
			binDir: ctx.binDir,
			log: () => {},
		});

		expect(result.missingSource).toEqual(["agent-team-transport"]);
		expect(result.synced).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	it("bin allowlist: caller can extend / override (e.g., for codex)", async () => {
		await writeFile(
			join(ctx.repoRoot, "tool-x.js"),
			"#!/usr/bin/env node\nconsole.log('x');\n",
		);
		await chmod(join(ctx.repoRoot, "tool-x.js"), 0o755);

		const result = await syncFlywheelCliBin({
			repoRoot: ctx.repoRoot,
			binDir: ctx.binDir,
			bins: [{ name: "tool-x", relativeSource: "tool-x.js" }],
			log: () => {},
		});

		expect(result.synced).toEqual(["tool-x"]);
		expect(await readlink(join(ctx.binDir, "tool-x"))).toBe(
			join(ctx.repoRoot, "tool-x.js"),
		);
	});

	it("Codex Round 5 HIGH: source binary at 0o644 → chmod 0o755 + create symlink", async () => {
		// Reproduces Codex's empirical finding: fresh `tsc` emits JS files
		// at 0o644. Even though the file has a `#!/usr/bin/env node`
		// shebang, the missing exec bit means `command -v` reports the
		// symlink exists but the actual invocation fails with
		// `Permission denied`. `syncFlywheelCliBin` must repair the source
		// mode so the symlink is usable.
		const sourcePath = await writeCliSource();
		// Simulate the post-tsc state — JS file emitted at 0o644.
		await chmod(sourcePath, 0o644);
		const stBefore = await stat(sourcePath);
		expect(stBefore.mode & 0o100).toBe(0); // owner-exec NOT set

		const result = await syncFlywheelCliBin({
			repoRoot: ctx.repoRoot,
			binDir: ctx.binDir,
			log: () => {},
		});

		expect(result.synced).toEqual(["agent-team-transport"]);
		// Source has been repaired to 0o755 so the symlink is invokable.
		const stAfter = await stat(sourcePath);
		expect(stAfter.mode & 0o755).toBe(0o755);
		// Symlink exists + points at the dist binary.
		const st = await lstat(join(ctx.binDir, "agent-team-transport"));
		expect(st.isSymbolicLink()).toBe(true);
		expect(await readlink(join(ctx.binDir, "agent-team-transport"))).toBe(
			sourcePath,
		);
	});

	it("Codex Round 5 HIGH: matching symlink + source at 0o644 → still repairs source mode", async () => {
		// Edge case: a previous boot created the symlink when the source
		// was 0o755, then someone (or a fresh `tsc`) changed the source
		// back to 0o644. Symlink target match short-circuits to "matched"
		// — we still need to repair the source mode in that case.
		const sourcePath = await writeCliSource();
		await mkdir(ctx.binDir, { recursive: true });
		await symlink(sourcePath, join(ctx.binDir, "agent-team-transport"));
		// Now degrade source to 0o644 (simulating fresh tsc rebuild).
		await chmod(sourcePath, 0o644);

		const result = await syncFlywheelCliBin({
			repoRoot: ctx.repoRoot,
			binDir: ctx.binDir,
			log: () => {},
		});

		// Symlink target still matches; source mode repaired, reported as
		// synced (mode repair is a side effect we surface to ops).
		const stAfter = await stat(sourcePath);
		expect(stAfter.mode & 0o755).toBe(0o755);
		// Either "matched" (if mode repair is silent) or "synced"-style
		// surfacing — the asserted invariant is mode-after-call.
		expect(result.matched.length + result.synced.length).toBeGreaterThanOrEqual(
			1,
		);
	});

	it("FLYWHEEL_BIN_DIR + FLYWHEEL_REPO_ROOT env respected when no opts override", async () => {
		await writeCliSource();
		const originalBin = process.env.FLYWHEEL_BIN_DIR;
		const originalRoot = process.env.FLYWHEEL_REPO_ROOT;
		process.env.FLYWHEEL_BIN_DIR = ctx.binDir;
		process.env.FLYWHEEL_REPO_ROOT = ctx.repoRoot;
		try {
			const result = await syncFlywheelCliBin({ log: () => {} });
			expect(result.synced).toEqual(["agent-team-transport"]);
		} finally {
			if (originalBin === undefined) delete process.env.FLYWHEEL_BIN_DIR;
			else process.env.FLYWHEEL_BIN_DIR = originalBin;
			if (originalRoot === undefined) delete process.env.FLYWHEEL_REPO_ROOT;
			else process.env.FLYWHEEL_REPO_ROOT = originalRoot;
		}
	});
});

describe("syncFlywheelRuntime umbrella", () => {
	let hookCtx: Ctx;
	let binCtx: BinCtx;

	beforeEach(async () => {
		hookCtx = await setupTmpDirs();
		binCtx = await setupBinDirs();
	});

	afterEach(async () => {
		await hookCtx.cleanup();
		await binCtx.cleanup();
	});

	it("runs both syncs and returns combined result", async () => {
		await writeFile(
			join(hookCtx.sourceDir, "inbox-check.sh"),
			"#!/bin/bash\nhook\n",
		);
		const cliSource = join(
			binCtx.repoRoot,
			"packages",
			"agent-team-transport",
			"dist",
			"bin",
			"agent-team-transport-cli.js",
		);
		await writeFile(cliSource, "#!/usr/bin/env node\nconsole.log('cli');\n");
		await chmod(cliSource, 0o755);

		const result = await syncFlywheelRuntime({
			hooks: {
				sourceDir: hookCtx.sourceDir,
				targetDir: hookCtx.targetDir,
				log: () => {},
			},
			bins: {
				repoRoot: binCtx.repoRoot,
				binDir: binCtx.binDir,
				log: () => {},
			},
		});

		expect(result.hooks.synced).toEqual(["inbox-check.sh"]);
		expect(result.bins.synced).toEqual(["agent-team-transport"]);
	});
});

function dirOf(path: string): string {
	const lastSlash = path.lastIndexOf("/");
	return lastSlash === -1 ? "." : path.slice(0, lastSlash);
}
