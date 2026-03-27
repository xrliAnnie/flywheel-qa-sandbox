import { execFileSync, execFile } from "node:child_process";
import { sanitizeTmuxName } from "./tmux-naming.js";

/**
 * Resolve the absolute path to the tmux binary.
 * Returns undefined if tmux is not installed.
 */
function resolveTmuxPath(): string | undefined {
	try {
		return execFileSync("which", ["tmux"], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	} catch {
		return undefined;
	}
}

/**
 * Open a Terminal.app window attached to the given tmux session.
 * Best-effort — failure is non-fatal (user can always `tmux attach` manually).
 *
 * Features:
 * - Resolves tmux absolute path for AppleScript `do shell script` compatibility
 * - Dedup: skips if a client is already attached (best-effort)
 * - Two-phase AppleScript state machine:
 *   Phase 1: Wait for tmux client to attach (via `tmux list-clients`, bounded 120s)
 *   Phase 2: Auto-close when tmux exits from the Terminal tab
 * - Fire-and-forget: runs async, does not block caller
 *
 * GEO-277
 */
export function openTmuxViewer(sessionName: string): void {
	// Sanitize session name to prevent shell/AppleScript injection —
	// only allows alphanumeric + dash (strips quotes, spaces, special chars)
	const safeName = sanitizeTmuxName(sessionName);

	// Resolve tmux absolute path — do shell script runs /bin/sh without user PATH
	const tmuxPath = resolveTmuxPath();
	if (!tmuxPath) {
		console.warn("[tmux-viewer] tmux not found in PATH, skipping viewer");
		return;
	}

	// Dedup: skip if a client is already attached
	try {
		const clients = execFileSync(
			tmuxPath,
			["list-clients", "-t", `=${safeName}`],
			{
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		if (clients.trim().length > 0) {
			console.log(
				`[tmux-viewer] Viewer already attached to ${safeName}, skipping`,
			);
			return;
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (!msg.includes("can't find session")) {
			console.warn(
				`[tmux-viewer] tmux list-clients failed for ${safeName}: ${msg}`,
			);
		}
		// Session may not exist yet — proceed to open (best-effort)
	}

	// Shell command: POSIX counter wait loop + exec attach (all absolute paths)
	// safeName is guaranteed alphanumeric + dash only (no injection risk)
	const shellCmd = [
		`i=0; while [ $i -lt 120 ] && ! ${tmuxPath} has-session -t '=${safeName}' 2>/dev/null;`,
		`do sleep 1; i=$((i+1)); done;`,
		`exec ${tmuxPath} attach -t '=${safeName}' 2>/dev/null`,
	].join(" ");

	// Two-phase AppleScript state machine:
	// Phase 1: Wait for a real tmux client to attach (tmux list-clients = attach-only signal)
	// Phase 2: Auto-close when tmux exits from the Terminal tab
	const script = [
		'tell application "Terminal"',
		`  set viewerTab to do script "${shellCmd}"`,
		"  set viewerWindow to front window",
		"  activate",
		// Phase 1: Wait for attach (bounded 120 seconds)
		"  set maxWait to 120",
		"  set waited to 0",
		"  set attached to false",
		"  repeat while waited < maxWait",
		"    delay 3",
		"    set waited to waited + 3",
		"    try",
		`      set clients to do shell script "${tmuxPath} list-clients -t '=${safeName}' 2>/dev/null || true"`,
		'      if clients is not "" then',
		"        set attached to true",
		"        exit repeat",
		"      end if",
		"    end try",
		"  end repeat",
		// If no client ever attached, close and bail
		"  if not attached then",
		"    close viewerWindow",
		"    return",
		"  end if",
		// Phase 2: Auto-close when tmux exits from our Terminal tab
		"  repeat",
		"    delay 3",
		"    try",
		"      set p to (processes of viewerTab) as string",
		'      if p does not contain "tmux" then',
		"        close viewerWindow",
		"        exit repeat",
		"      end if",
		"    on error",
		"      exit repeat",
		"    end try",
		"  end repeat",
		"end tell",
	].join("\n");

	execFile("osascript", ["-e", script], (err) => {
		if (err) {
			console.warn(
				`[tmux-viewer] Could not auto-open tmux viewer: ${err.message}`,
			);
		}
	});
}
