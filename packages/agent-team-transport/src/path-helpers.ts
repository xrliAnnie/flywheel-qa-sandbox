/**
 * Path resolution helpers.
 *
 * Per plan §2.0.7 (Codex r1 high #5 + r2 medium #6):
 * - claude-code uses native `CLAUDE_CONFIG_DIR + "/teams"` (per
 *   `/Users/xiaorongli/Dev/claude-code/src/utils/envUtils.ts:8-17`).
 *   We MUST NOT introduce `FLYWHEEL_TEAMS_DIR` for claude-code — it would
 *   create a dual truth source where stock binary polls one path and
 *   flywheel writes to another.
 * - Vendor-neutral structured-inbox / sentinel files live under
 *   `FLYWHEEL_STATE_DIR` (default `~/.flywheel/state`).
 * - Other vendors (codex) own their own path env (e.g. future
 *   `FLYWHEEL_CODEX_INBOX_DIR`) — decoupled from CLAUDE_CONFIG_DIR.
 */

import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_CLAUDE_CONFIG_DIR = ".claude";
const DEFAULT_FLYWHEEL_STATE_DIR = ".flywheel/state";

/**
 * Resolve `CLAUDE_CONFIG_DIR` env (claude-code's native control), defaulting
 * to `~/.claude`. Returned path is absolute.
 *
 * **NFC normalization** (Codex r1 medium #4): mirrors stock claude-code's
 * `getClaudeConfigHomeDir()` (`/Users/xiaorongli/Dev/claude-code/src/utils/envUtils.ts:8-17`).
 * Without `.normalize("NFC")`, decomposed Unicode paths on macOS (e.g. NFD
 * canonical form returned by `readdir`) can produce a different string than
 * the stock binary derives, leading to writes/reads landing on different
 * paths.
 */
export function getClaudeConfigDir(): string {
	const env = process.env.CLAUDE_CONFIG_DIR;
	const raw =
		env && env.length > 0 ? env : join(homedir(), DEFAULT_CLAUDE_CONFIG_DIR);
	return raw.normalize("NFC");
}

/**
 * Mirror stock claude-code's `sanitizePathComponent` (tasks.ts:217-219):
 *   `input.replace(/[^a-zA-Z0-9_-]/g, "-")`
 *
 * Used for inbox path components so we land at the same `<teams>/<safeTeam>/inboxes/<safeAgent>.json`
 * file that the stock `useInboxPoller` reads from.
 *
 * NOT the same as `sanitizeName()` in `claude/team-bootstrap.ts` (which
 * lowercases + uses different replacement set). Stock claude-code itself
 * uses different sanitizers in different places — we faithfully mirror both
 * to stay bug-for-bug compatible.
 */
export function sanitizePathComponent(input: string): string {
	return input.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/**
 * Resolve `FLYWHEEL_STATE_DIR` env (vendor-neutral state path for
 * structured-inbox + sentinel files). Defaults to `~/.flywheel/state`.
 * Returned path is absolute.
 */
export function getStateDir(): string {
	const env = process.env.FLYWHEEL_STATE_DIR;
	if (env && env.length > 0) {
		return env;
	}
	return join(homedir(), DEFAULT_FLYWHEEL_STATE_DIR);
}

// ----------------------------------------------------------------------------
// Claude-specific path helpers (Used only by ClaudeCodeAdapter / its tests.
// Production code outside packages/agent-team-transport/src/claude/** MUST
// NOT call these directly — go through `transport.getInboxPath(...)` instead.
// CI grep gate enforces this.)
// ----------------------------------------------------------------------------

/** `<CLAUDE_CONFIG_DIR>/teams` */
export function getClaudeTeamsDir(): string {
	return join(getClaudeConfigDir(), "teams");
}

/**
 * `<CLAUDE_CONFIG_DIR>/teams/<safeLead>/config.json`
 *
 * **Sanitized** with `sanitizePathComponent` — matches stock claude-code's
 * `getInboxPath` directory layer. Note: stock `team-helpers.getTeamDir`
 * uses a DIFFERENT sanitizer (`sanitizeName` lowercases + different replace
 * set). Stock claude-code itself has this inconsistency. We mirror the
 * `getInboxPath` layout for inboxes (this fn) and `team-bootstrap.ts`
 * mirrors `getTeamDir` for the team config file. If callers always pass
 * already-sanitized lowercase alphanumeric names (recommended), the two
 * helpers produce the same path.
 */
export function getClaudeTeamConfigPath(leadName: string): string {
	return join(
		getClaudeTeamsDir(),
		sanitizePathComponent(leadName),
		"config.json",
	);
}

/**
 * `<CLAUDE_CONFIG_DIR>/teams/<safeLead>/inboxes/<safeAgent>.json`
 *
 * **Sanitized** with stock `sanitizePathComponent` for both team + agent
 * (Codex r1 high #1) — mirrors stock `teammateMailbox.getInboxPath`
 * (`teammateMailbox.ts:56-66`). Without this, names with spaces / `@` /
 * `/` / `..` either land at paths the stock poller doesn't read or escape
 * the inbox directory (path traversal).
 */
export function getClaudeInboxPath(
	leadName: string,
	agentName: string,
): string {
	const safeLead = sanitizePathComponent(leadName);
	const safeAgent = sanitizePathComponent(agentName);
	return join(getClaudeTeamsDir(), safeLead, "inboxes", `${safeAgent}.json`);
}

/** `<inbox>.flywheel.jsonl` — sidecar for flywheelId dedupe (§2.0.6). */
export function getClaudeSidecarPath(
	leadName: string,
	agentName: string,
): string {
	return `${getClaudeInboxPath(leadName, agentName)}.flywheel.jsonl`;
}

/**
 * `<FLYWHEEL_STATE_DIR>/inbox-structured/<lead>/requests` — vendor-neutral
 * structured request directory (Runner→Lead gate requests, watched by
 * Bridge `StructuredInboxRouter`).
 */
export function getStructuredRequestDir(leadName: string): string {
	return join(getStateDir(), "inbox-structured", leadName, "requests");
}

/**
 * `<FLYWHEEL_STATE_DIR>/inbox-structured/<runner>/responses` — vendor-neutral
 * structured response directory (Lead→Runner gate responses, watched by
 * await-mcp via fs.watch — §2.6 Codex r2 critical #2).
 */
export function getStructuredResponseDir(runnerName: string): string {
	return join(getStateDir(), "inbox-structured", runnerName, "responses");
}

/**
 * Derive a Runner's Agent Team mailbox identity from its execution id + the
 * owning Lead id. This is the SINGLE source of truth for the mapping used at
 * Runner spawn (`run-dispatcher.ts:buildAgentTeamIdentity`) AND at message
 * send (`flywheel-comm send` mailbox dual-write, FLY-168).
 *
 *   agentName = `runner-${execId.slice(0, 8)}`   (claude-code `--agent-name`)
 *   teamName  = leadId                            (claude-code `--team-name`)
 *
 * The inbox the Runner's stock `useInboxPoller` reads is therefore
 * `getClaudeInboxPath(teamName, agentName)`. Keeping the derivation here (not
 * inlined at each call site) prevents the two sides from silently diverging.
 *
 * NOTE: the 8-char execId slice is an ACCEPTED existing constraint — it is the
 * already-shipped Runner identity, so FLY-168 must reuse it to reach live
 * Runner inboxes. It is a 32-bit namespace, not a globally collision-proof id;
 * widening it would be a separate compatibility project.
 */
export function deriveRunnerMailboxIdentity(
	executionId: string,
	leadId: string,
): { agentName: string; teamName: string } {
	return { agentName: `runner-${executionId.slice(0, 8)}`, teamName: leadId };
}
