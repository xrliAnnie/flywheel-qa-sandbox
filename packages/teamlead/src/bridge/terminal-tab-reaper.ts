/**
 * FLY-116: One-shot Bridge startup reaper for stale Terminal.app tabs.
 *
 * Status-dominant policy:
 *   - PRESERVE_STATES (failed/blocked) NEVER closed by reaper, even if tmux
 *     window is dead. Annie may want to inspect scrollback.
 *   - Otherwise close iff:
 *       (a) StateStore session is in AUTO_CLOSE_STATES, OR
 *       (b) no StateStore row AND tmux window is gone (true orphan)
 *
 * The reaper is fired exactly ONCE from Bridge bootstrap, after StateStore
 * has been initialized (`StateStore.create()` resolved). The bootstrap
 * ordering itself is the readiness gate — no separate `isReady()` API.
 *
 * Selectors are exact-match on Terminal custom title — NEVER broad
 * patterns like `[exited]` or `contains "..."`.
 */

import { execFile, execFileSync } from "node:child_process";
import { withSyncOpMarker } from "flywheel-claude-runner";
import { parseViewTitle } from "flywheel-core";
import type { StateStore } from "../StateStore.js";
import { isTmuxWindowAlive } from "./tmux-lookup.js";

const AUTO_CLOSE_STATES = new Set([
	"completed",
	"rejected",
	"deferred",
	"shelved",
	"terminated",
]);

const PRESERVE_STATES = new Set(["failed", "blocked"]);

export interface ReapResult {
	scanned: number;
	closed: number;
	preserved: number;
	errors: string[];
}

/**
 * One-shot scan + close of stale Terminal.app tabs.
 *
 * Best-effort: failures log warn but never throw. Returns counters for audit.
 */
export async function reapTerminalTabs(store: StateStore): Promise<ReapResult> {
	const result: ReapResult = {
		scanned: 0,
		closed: 0,
		preserved: 0,
		errors: [],
	};

	// 1. Enumerate Terminal tabs whose custom title starts with the FLY-116 prefix.
	const listScript = [
		'tell application "Terminal"',
		"  set out to {}",
		"  repeat with w in windows",
		"    repeat with t in tabs of w",
		"      try",
		"        set ttl to (custom title of t as text)",
		'        if ttl starts with "flywheel:runner:" then',
		"          set end of out to ttl",
		"        end if",
		"      end try",
		"    end repeat",
		"  end repeat",
		"  set AppleScript's text item delimiters to linefeed",
		"  return out as text",
		"end tell",
	].join("\n");

	let titles: string;
	try {
		titles = await runOsascript(listScript);
	} catch (err) {
		// Terminal.app may not be running at startup, or osascript may not be
		// authorized yet. Both are benign — nothing to do, return empty result.
		const msg = err instanceof Error ? err.message : String(err);
		console.log(
			`[terminal-reaper] enumerate skipped (${msg}) — no tabs to reap`,
		);
		return result;
	}

	const lines = titles
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	result.scanned = lines.length;

	for (const title of lines) {
		const parsed = parseViewTitle(title);
		if (!parsed) continue;
		const { sessionName, projectName, executionId, windowId } = parsed;

		const session = store.getSession(executionId);

		// PRESERVE: failed/blocked tabs stay even if tmux is gone.
		if (session && PRESERVE_STATES.has(session.status)) {
			result.preserved++;
			continue;
		}

		// tmuxWindow constructed from the parsed sessionName (NOT reconstructed
		// from project name — sessionName may be runner-* or retry-* or other).
		const tmuxWindow = `${sessionName}:${windowId}`;
		const tmuxAlive = await isTmuxWindowAlive(tmuxWindow);

		const shouldClose =
			(session && AUTO_CLOSE_STATES.has(session.status)) ||
			(!session && !tmuxAlive);

		if (!shouldClose) continue;

		// Close this exact tab. Terminal.app's `tab` class does not accept
		// `close` — must close the parent window. Defensive guard: only close
		// when the parent window has exactly one tab so we don't take down
		// user-merged tabs by accident. `saving no` suppresses the
		// "process is still running" confirmation dialog.
		const safeTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		const closeScript = [
			'tell application "Terminal"',
			`  set targetTitle to "${safeTitle}"`,
			"  repeat with w in windows",
			"    repeat with t in tabs of w",
			"      try",
			"        if (custom title of t as text) is targetTitle then",
			"          if (count of tabs of w) is 1 then",
			"            close w saving no",
			'            return "closed"',
			"          else",
			'            return "skipped_multi_tab"',
			"          end if",
			"        end if",
			"      end try",
			"    end repeat",
			"  end repeat",
			'  return "not_found"',
			"end tell",
		].join("\n");

		try {
			const closeOut = (await runOsascript(closeScript)).trim();

			// Multi-tab parent — don't risk user tabs. Skip close + linked-session
			// kill (the next runner cycle will reap once user disposes the tab).
			if (closeOut === "skipped_multi_tab") {
				console.warn(
					`[terminal-reaper] ${title} is inside a multi-tab window; skipping`,
				);
				continue;
			}

			// Also kill the linked viewer session for this exec (best-effort).
			try {
				withSyncOpMarker("terminal-reaper:tmux-kill", () =>
					execFileSync(
						"tmux",
						["kill-session", "-t", `=viewer-${executionId}`],
						{
							stdio: "ignore",
							timeout: 3000,
							killSignal: "SIGKILL",
						},
					),
				);
			} catch {
				/* benign — viewer session may already be gone */
			}

			result.closed++;
			store.insertEvent({
				event_id: `terminal-reaper-${executionId}-${windowId}-${Date.now()}`,
				execution_id: executionId,
				issue_id: session?.issue_id ?? "unknown",
				project_name: projectName,
				event_type: "terminal_tab_reaped",
				source: "bridge.startup-reaper",
				payload: {
					title,
					sessionName,
					sessionStatus: session?.status,
					tmuxAlive,
				},
			});
		} catch (e) {
			result.errors.push(`${title}: ${(e as Error).message}`);
		}
	}

	return result;
}

function runOsascript(script: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("osascript", ["-e", script], { timeout: 10000 }, (err, stdout) => {
			if (err) reject(err);
			else resolve(stdout);
		});
	});
}
