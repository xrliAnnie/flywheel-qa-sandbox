import type { ExecFileFn } from "./TmuxRunner.js";

const TRUST_PATTERNS = [
	"do you trust the files in this folder",
	"trust this folder",
	"trust this project",
	"enter to confirm",
] as const;

/**
 * Auto-dismiss workspace trust prompts.
 * From Claude Squad CheckAndHandleTrustPrompt() pattern.
 *
 * v0.1.1 identified this bug: bypassPermissions doesn't skip
 * trust prompt for new directories (e.g., new worktrees).
 */
export class TrustPromptHandler {
	/** Check if pane output contains a trust prompt (case-insensitive) */
	static isTrustPrompt(paneContent: string): boolean {
		const lower = paneContent.toLowerCase();
		return TRUST_PATTERNS.some((pattern) => lower.includes(pattern));
	}

	/** Send Enter to dismiss the prompt */
	static dismiss(execFile: ExecFileFn, tmuxTarget: string): void {
		execFile("tmux", ["send-keys", "-t", tmuxTarget, "Enter"]);
	}
}
