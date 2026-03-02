#!/usr/bin/env npx tsx
/**
 * TmuxRunner E2E Test — validates the v0.1.1 interactive pipeline.
 *
 * Tests the REAL TmuxRunner flow:
 *   1. Creates a temp git repo with a buggy file
 *   2. Sets up FLYWHEEL_MARKER_DIR (normally DagDispatcher does this)
 *   3. Installs SessionEnd hook (if not already installed)
 *   4. Launches TmuxRunner → Claude Code opens in a visible tmux window
 *   5. Waits for completion via SessionEnd hook or pane_dead polling
 *   6. GitResultChecker verifies commits were made
 *   7. Reports success/failure
 *
 * Prerequisites:
 *   - tmux running (you should be in a tmux session)
 *   - claude CLI installed and authenticated
 *   - Run from a REGULAR TERMINAL (not inside Claude Code)
 *   - pnpm build has been run
 *
 * Usage:
 *   cd /path/to/flywheel
 *   pnpm build
 *   packages/edge-worker/node_modules/.bin/tsx scripts/e2e-tmux-runner.ts
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TmuxRunner } from "../packages/claude-runner/dist/TmuxRunner.js";
import { GitResultChecker } from "../packages/edge-worker/dist/GitResultChecker.js";
import { FLYWHEEL_MARKER_DIR } from "../packages/core/dist/constants.js";

// ── Helpers ──────────────────────────────────────────────────

function log(msg: string) {
	const time = new Date().toLocaleTimeString();
	console.log(`[${time}] ${msg}`);
}

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

// ── Setup ────────────────────────────────────────────────────

function setupTempRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "flywheel-e2e-tmux-"));
	log(`Created temp repo: ${dir}`);

	git(["init"], dir);
	git(["config", "user.email", "e2e-test@flywheel.dev"], dir);
	git(["config", "user.name", "Flywheel E2E Test"], dir);

	// Simple bug: a function that returns wrong value
	writeFileSync(
		join(dir, "greet.ts"),
		`/**
 * Returns a greeting for the given name.
 * Bug: returns "Goodbye" instead of "Hello".
 */
export function greet(name: string): string {
  return \`Goodbye, \${name}!\`;
}
`,
	);

	writeFileSync(
		join(dir, "greet.test.ts"),
		`import { greet } from "./greet";

const result = greet("World");
const expected = "Hello, World!";
if (result === expected) {
  console.log("PASS: greet('World') =", result);
  process.exit(0);
} else {
  console.log("FAIL: greet('World') =", result, "(expected:", expected + ")");
  process.exit(1);
}
`,
	);

	git(["add", "."], dir);
	git(["commit", "-m", "initial: add buggy greet module"], dir);

	log("Created buggy greet.ts (says Goodbye instead of Hello)");
	return dir;
}

function ensureMarkerDir(): void {
	if (!existsSync(FLYWHEEL_MARKER_DIR)) {
		mkdirSync(FLYWHEEL_MARKER_DIR, { recursive: true });
		log(`Created marker dir: ${FLYWHEEL_MARKER_DIR}`);
	} else {
		log(`Marker dir exists: ${FLYWHEEL_MARKER_DIR}`);
	}
}

function checkHookInstalled(): boolean {
	const settingsPath = join(process.env.HOME ?? "", ".claude", "settings.json");
	if (!existsSync(settingsPath)) return false;
	try {
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		const hooks = settings?.hooks?.SessionEnd ?? [];
		return hooks.some((h: any) =>
			h?.hooks?.some((inner: any) => inner?.command?.includes("flywheel-session-end")),
		);
	} catch {
		return false;
	}
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
	console.log("\n========================================");
	console.log("  TmuxRunner E2E Test (v0.1.1)");
	console.log("========================================\n");

	// 1. Check prerequisites
	if (process.env.CLAUDECODE) {
		console.error("ERROR: Running inside Claude Code session. Run from a regular terminal.");
		process.exit(1);
	}

	try {
		execFileSync("tmux", ["-V"], { encoding: "utf-8" });
		log(`tmux: ${execFileSync("tmux", ["-V"], { encoding: "utf-8" }).trim()}`);
	} catch {
		console.error("ERROR: tmux not found. Install with: brew install tmux");
		process.exit(1);
	}

	try {
		const ver = execFileSync("claude", ["--version"], { encoding: "utf-8" }).trim();
		log(`claude: ${ver}`);
	} catch {
		console.error("ERROR: claude CLI not found.");
		process.exit(1);
	}

	// 2. Check SessionEnd hook
	const hookInstalled = checkHookInstalled();
	if (hookInstalled) {
		log("SessionEnd hook: installed (primary completion path)");
	} else {
		log("SessionEnd hook: NOT installed (will rely on pane_dead polling fallback)");
		log("  To install: bash scripts/install-hooks.sh");
	}

	// 3. Setup
	const repoDir = setupTempRepo();
	ensureMarkerDir();

	log("\n--- Before fix ---");
	try {
		execFileSync("npx", ["tsx", "greet.test.ts"], { cwd: repoDir, encoding: "utf-8" });
		log("Tests pass (unexpected — bug should fail)");
	} catch (e: any) {
		console.log(e.stdout?.trim() || "(tests failed as expected)");
	}

	// 4. Setup GitResultChecker
	const gitChecker = new GitResultChecker(
		async (cmd: string, args: string[], cwd: string) => {
			const result = execFileSync(cmd, args, { cwd, encoding: "utf-8" });
			return { stdout: result };
		},
	);

	await gitChecker.assertCleanTree(repoDir);
	const baseSha = await gitChecker.captureBaseline(repoDir);
	log(`Git baseline: ${baseSha.slice(0, 8)}`);

	// 5. Launch TmuxRunner
	log("\n--- Launching TmuxRunner ---");
	log("A tmux window will open with Claude Code. You can watch it work!");
	log("  tmux select-window -t flywheel-e2e  (to switch to it)\n");

	const runner = new TmuxRunner(
		"flywheel-e2e",   // session name
		undefined,        // default execFile
		3000,             // poll every 3s (faster for E2E)
		120_000,          // 2 min timeout
	);

	// Auto-open a Terminal window so the user can watch Claude work in real time.
	// The shell command retries until the tmux session appears (created by TmuxRunner).
	execFileSync("osascript", [
		"-e",
		`tell application "Terminal" to do script "echo 'Waiting for Claude to start...' && while ! tmux has-session -t flywheel-e2e 2>/dev/null; do sleep 1; done && tmux attach -t flywheel-e2e"`,
	]);
	log("Opened viewer window — it will connect once Claude starts");

	// Auto-interaction: handle trust prompt + auto-exit after Claude completes work.
	// Phase 1: Auto-confirm "trust this folder" prompt (fires once for new temp dirs).
	// Phase 2: Detect Claude idle at prompt after completing work → send /exit.
	//
	// Why auto-exit is needed: In interactive mode, Claude completes its turn and waits
	// at the `❯` prompt. /exit is a user-typed CLI command — the AI model can't invoke it.
	// Without this, the session never ends and TmuxRunner times out.
	let trustConfirmed = false;
	let exitSent = false;
	const autoInteractInterval = setInterval(() => {
		try {
			const paneContent = execFileSync("tmux", [
				"capture-pane", "-t", "flywheel-e2e:E2E-TEST", "-p",
			], { encoding: "utf-8" });

			// Phase 1: trust prompt
			if (!trustConfirmed && (paneContent.includes("trust this folder") || paneContent.includes("Enter to confirm"))) {
				execFileSync("tmux", ["send-keys", "-t", "flywheel-e2e:E2E-TEST", "Enter"]);
				log("Auto-confirmed workspace trust prompt");
				trustConfirmed = true;
				return; // check again next interval
			}

			// Phase 2: detect Claude completed work, kill the pane to trigger pane_dead.
			// Why kill-pane instead of /exit: sending /exit via tmux send-keys gets
			// intercepted by Claude Code's autocomplete UI and doesn't reliably submit.
			// Killing the pane is clean — TmuxRunner's pane_dead polling detects it.
			const hasGitCommitOutput = /\[main [a-f0-9]+\]/.test(paneContent);
			if (!exitSent && hasGitCommitOutput) {
				// Wait for Claude to finish its response (render "Done." message)
				setTimeout(() => {
					try {
						execFileSync("tmux", ["kill-pane", "-t", "flywheel-e2e:E2E-TEST"]);
						log("Killed pane after detecting git commit — triggering pane_dead");
					} catch { /* window may already be gone */ }
				}, 5000);
				exitSent = true;
			}
		} catch { /* window may not exist yet */ }
	}, 3000);

	const startTime = Date.now();
	const result = await runner.run({
		prompt: [
			"Fix the bug in greet.ts: it says 'Goodbye' but should say 'Hello'.",
			"Change 'Goodbye' to 'Hello' in the greet function.",
			"Then commit with message 'fix: greet says Hello instead of Goodbye'.",
			"Do NOT push, do NOT create a PR, do NOT create new files.",
			"When done, type /exit to end the session.",
		].join(" "),
		cwd: repoDir,
		permissionMode: "bypassPermissions",
		label: "E2E-TEST",
	});
	clearInterval(autoInteractInterval);
	const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

	// 6. Report TmuxRunner result
	console.log("\n--- TmuxRunner Result ---\n");
	console.log(`  sessionId:  ${result.sessionId}`);
	console.log(`  tmuxWindow: ${result.tmuxWindow}`);
	console.log(`  timedOut:   ${result.timedOut}`);
	console.log(`  durationMs: ${result.durationMs}`);
	console.log(`  elapsed:    ${elapsed}s`);

	// 7. Check git results
	const gitResult = await gitChecker.check(repoDir, baseSha);
	console.log("\n--- GitResultChecker ---\n");
	console.log(`  hasNewCommits: ${gitResult.hasNewCommits}`);
	console.log(`  commitCount:   ${gitResult.commitCount}`);
	console.log(`  filesChanged:  ${gitResult.filesChanged}`);
	console.log(`  messages:      ${gitResult.commitMessages.join("; ") || "(none)"}`);

	const success = gitResult.commitCount > 0 && !result.timedOut;

	// 8. Verify the fix
	console.log("\n--- Final greet.ts ---\n");
	console.log(readFileSync(join(repoDir, "greet.ts"), "utf-8"));

	console.log("--- After fix ---\n");
	try {
		const out = execFileSync("npx", ["tsx", "greet.test.ts"], {
			cwd: repoDir,
			encoding: "utf-8",
			timeout: 10_000,
		});
		console.log(out.trim());
	} catch (e: any) {
		console.log(e.stdout?.trim() || e.message);
	}

	console.log("\n--- Git history ---\n");
	console.log(git(["log", "--oneline"], repoDir));

	// 9. Verdict
	console.log("\n========================================");
	if (success) {
		console.log("  PASS — TmuxRunner E2E works!");
	} else if (result.timedOut) {
		console.log("  FAIL — Timed out (Claude didn't finish in time)");
	} else {
		console.log("  FAIL — No commits (Claude didn't commit)");
	}
	console.log("========================================\n");

	console.log(`Temp repo: ${repoDir}`);

	// 10. Cleanup marker dir
	try {
		rmSync(FLYWHEEL_MARKER_DIR, { recursive: true, force: true });
		log("Cleaned up marker dir");
	} catch { /* ok */ }

	process.exit(success ? 0 : 1);
}

main().catch((err) => {
	console.error("E2E test crashed:", err);
	process.exit(1);
});
