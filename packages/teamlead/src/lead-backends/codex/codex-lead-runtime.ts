/**
 * FLY-224 Phase 7 block 2 — codex-lead-runtime: the entrypoint `codex-lead.sh`
 * execs. It reads its config from the environment, assembles the 15-component
 * Codex Lead, and runs the CodexLeadRuntime lifecycle (plan §4, Phase 0A §2/§3).
 *
 * Split for testability:
 *   - `parseCodexLeadRuntimeConfig(env)` + the thread-id store are PURE/IO-thin and
 *     unit-tested (fail-loud on missing required env; deterministic path derivation).
 *   - `spawnCodexAppServer` (child_process) + `buildCodexLeadRuntime` (real-component
 *     wiring) + `main` are the assembly glue — validated by the Phase 7 real-machine
 *     bring-up, not unit tests.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	getProcessStart,
	publishCarrierRuntimeAssertion,
} from "flywheel-comm/lead-lease";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import {
	assertGatewayOnlyToolSurface,
	GATEWAY_ACTION_TOOL_NAMES,
} from "./action-surface.js";
import {
	buildCodexLeadMcpArgv,
	type LeadActionsMcpConfig,
} from "./buildCodexLeadMcpArgv.js";
import {
	CodexDiscordGateway,
	type DiscordInboundMessage,
} from "./CodexDiscordGateway.js";
import { CodexDiscordMailboxStrategy } from "./CodexDiscordMailboxStrategy.js";
import { CodexDiscordRuntimeOwnership } from "./CodexDiscordRuntimeOwnership.js";
import {
	CodexLeadInboxServer,
	resolveCodexLeadInboxSocketPath,
} from "./CodexLeadInboxSocket.js";
import { type ChildTransport, CodexLeadProcess } from "./CodexLeadProcess.js";
import { CodexLeadRuntime, type RuntimeWiring } from "./CodexLeadRuntime.js";
import { CodexOutboundSender } from "./CodexOutboundSender.js";
import { CodexTurnExecutor } from "./CodexTurnExecutor.js";
import { assertConfinement, extractThreadDescriptor } from "./confinement.js";
import { DirectDiscordOutboundSender } from "./DirectDiscordOutboundSender.js";
import { DiscordTypingNotifier } from "./DiscordTypingNotifier.js";
import { ExternalReceiptSaga } from "./ExternalReceiptSaga.js";
import { parseOwnerRepo } from "./gateway/GitPushRunner.js";
import { FileInboundCursorStore } from "./InboundCursorStore.js";
import type { OutboundSender } from "./LeadInputRouter.js";
import { LeadInputRouter } from "./LeadInputRouter.js";
import { LeadJournal } from "./LeadJournal.js";
import { parseExplicitAliases } from "./lead-actions/alias-allowlist.js";
import { McpInventoryWatcher } from "./mcp-inventory.js";
import { buildMentionGate } from "./mention-gate.js";
import { RestPollDiscordInboundSource } from "./RestPollDiscordInboundSource.js";
import {
	buildReplyInThreadWiring,
	type ReplyInThreadConfig,
} from "./roundtable-reply-in-thread-wiring.js";
import { SqliteJournalStore } from "./SqliteJournalStore.js";
import { SecretBroker, washActionSecretEnv } from "./secret-broker.js";

export interface CodexLeadRuntimeConfig {
	projectName: string;
	leadId: string;
	leadKey: string;
	identityDigest: string;
	botUserId: string;
	botToken: string;
	chatChannelId: string;
	coreChannelId?: string;
	channelIds: string[];
	/** FLY-267 收: cross-department / shared channel ids (e.g. #leads-roundtable),
	 * merged into `channelIds` for inbound poll + gateway allowlist. ALSO the set
	 * that is (判) mention-gated and (回) reply-routed. Empty (env unset) → the
	 * single-channel byte-compat behavior (chat + optional core only). */
	crossDeptChannelIds: string[];
	/** FLY-267 判: optional name-mention regexes (e.g. `\bMufasa\b`), applied ONLY
	 * to non-bot authors (a sibling bot must use an exact mention id). Empty (env
	 * unset) → bot-id mention only (most precise; no false "talking about" trigger). */
	mentionPatterns: string[];
	/** FLY-898: when true, this (non-CoS) lead's CORE room (`coreChannelId`) is
	 * mention-gated with the id-only rule — a bare no-@ message is NOT handled
	 * (only the CoS answers those); a real `<@id>` / reply-to-self still is. Set by
	 * the launcher (`FLYWHEEL_LEAD_CORE_MENTION_GATED=1`, computed from
	 * `resolveCoreRoomGate` over projects.json). EFFECTIVE only when `coreChannelId`
	 * is set AND subscribed (see `resolveCoreStrictChannelIds`). Default false →
	 * core always handled (byte-compat, CoS + current fleet). */
	coreMentionGated: boolean;
	/** FLY-314 Phase 2: reply-in-thread (default-OFF). When enabled, roundtable
	 * replies route INTO the topic thread + the Lead subscribes to topic threads to
	 * see other Leads' in-thread replies. Undefined/disabled → FLY-267 behavior. */
	replyInThread?: ReplyInThreadConfig;
	bridgeUrl: string;
	apiToken: string;
	stateDir: string;
	journalDbPath: string;
	outboxDbPath: string;
	threadIdPath: string;
	/** Durable inbound-poll cursor (FLY-224 review HIGH-4): restart resumes from the
	 * persisted last-seen Discord msg id instead of re-baselining (no downtime loss). */
	inboundCursorPath: string;
	commDbPath: string;
	codexBin: string;
	codexHome: string;
	chrome?: { enabled: boolean; browserUrl?: string };
	/** Outbound path: "direct" posts to Discord with the Lead's own token (no Bridge
	 * restart — low-risk first test); "bridge" uses /api/lead-outbound/send (prod
	 * exactly-once). Default "direct". */
	outboundMode: "direct" | "bridge";
	/** FLY-404: show the Discord "typing…" indicator while processing a founder
	 * message. Permanently enabled; posts via the Lead's own bot token. */
	typingEnabled: boolean;
	/** FLY-2131: optional Codex thread model pin. Absent stays absent so existing
	 * Leads keep byte-identical thread/start and thread/resume params. */
	model?: string;
	/** FLY-2131: Codex protocol reasoning effort (not a CLI flag). */
	reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
	/** FLY-2131: explicit Codex model context window, e.g. Raya's 1M pin. */
	modelContextWindow?: number;
	/** FLY-2131: Raya-only v1 context metrics + explicit unavailable ledger. */
	contextUsagePath?: string;
	contextUsageUnavailablePath?: string;
	/** Persona/identity files (e.g. `.lead/<id>/identity.md` + companion-safety-
	 * contract) read + concatenated into the thread's `baseInstructions` system
	 * prompt — the Codex equivalent of claude-lead.sh's `--append-system-prompt-file`.
	 * Empty (or all-missing) → NO baseInstructions passed (byte-compat). */
	systemPromptFiles: string[];
	/** App-server sandbox policy, PINNED on the thread (FLY-224 review HIGH-1 / Phase
	 * 0A §). Default `read-only` = a companion that can only read + chat (structurally
	 * cannot run code / merge / ship). Write-capable modes are refused until a Codex
	 * Lead's founder-gated action path exists (FLY-245). */
	sandboxMode: CodexSandboxMode;
	/** FLY-350: Codex Lead capability profile (env FLYWHEEL_CODEX_LEAD_PROFILE).
	 * "write-capable" (Z) = net-off workspace-write shell + the gateway
	 * (git_push/open_pr/discord_send); "full-access" = Claude-equal project access;
	 * absent = "companion" = read-only chat. An UNKNOWN value is fail-loud at parse
	 * (R2-4) — never a silent default, so a launcher typo can't half-enable a tier.
	 * Profile ↔ sandbox consistency is asserted in `parseCodexLeadRuntimeConfig`. */
	codexProfile: CodexLeadProfile;
	/** FLY-245 Phase A: canonical write-capable Lead scratch workspace (plan §3.3).
	 * Resolved + validated (realpath; no overlap with control-plane/state/CODEX_HOME)
	 * only for write-capable sandboxes when `FLYWHEEL_CODEX_LEAD_WORKSPACE` is set;
	 * `undefined` for read-only companions (byte-compat). Pinned into the thread `cwd`
	 * and the confinement `writable_roots`. */
	workspace?: string;
	/** FLY-245 F-b (write-capable only): founder Discord id — the thread-descriptor
	 * assertion + the gateway's confirmation observer require it (release ⑤). */
	founderId?: string;
	/** FLY-245 F-b (write-capable only): Codex CLI versions vetted by the threat
	 * matrix (release ⑤ — a version bump must re-pass QA before running). */
	cliVersionAllowlist?: string[];
	/** FLY-245 F-b (write-capable only): absolute path to the deployed gateway MCP
	 * entry (dist gateway-main.js) — trusted, OUTSIDE the model's writableRoots. */
	gatewayEntry?: string;
	/** FLY-245 F-b (write-capable only): channel the founder-confirmation messages
	 * post to (defaults to the Lead chat channel). */
	gatewayConfirmChannelId?: string;
	/** FLY-350 (Z) unit 4 (write-capable only): the fine-grained GH_TOKEN
	 * (contents:write + pull_requests:write) for gateway-proxied git_push/open_pr.
	 * Served ONLY over the broker into the gateway child — NEVER the model shell
	 * (net-off, no token). Optional: absent → the gateway's git_push/open_pr fail
	 * closed at call time (the dormant FLY-245 path needs no GH token). */
	githubToken?: string;
	/** FLY-350 (Z) unit 4 (write-capable only): the project's GitHub repo slug
	 * ("owner/repo") — scopes git_push/open_pr to THIS Lead's repo (never inferred
	 * from model-controlled local git state). */
	projectRepo?: string;
	/** FLY-350 full-access (Claude-equal) ONLY: the canonical project root the Lead
	 * runs in — realpath-validated from FLYWHEEL_CODEX_LEAD_PROJECT_DIR (+ optional
	 * SUBDIR). DISTINCT from the (Z) `workspace` scratch (M-1): a full-access Lead
	 * works IN its project checkout like a Claude Lead, not in an isolated scratch.
	 * Pinned as the thread `cwd` and the single `writable_roots` entry (net ON).
	 * `undefined` for every non-full-access tier (byte-compat). */
	fullAccessProjectRoot?: string;
	/** FLY-304 full-access ONLY: absolute path to the deployed lead-actions MCP
	 * entry (dist lead-actions-main.js) — the proactive discord_send server.
	 * Resolved from FLYWHEEL_LEAD_ACTIONS_ENTRY or the dist default; existsSync-
	 * validated at build (fail-closed). `undefined` for every non-full-access tier. */
	leadActionsEntry?: string;
	/** FLY-304 full-access ONLY: optional explicit alias pins
	 * (FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES, e.g. "roundtable:<id>") forwarded to the
	 * lead-actions MCP child so the operator's documented roundtable-disambiguation
	 * path works for full-access too (code-review R1#2). Non-secret. `undefined` when
	 * unset / non-full-access. */
	leadActionsChannelAliases?: string;
}

/** Codex app-server sandbox modes (schema `SandboxMode`). */
export type CodexSandboxMode =
	| "read-only"
	| "workspace-write"
	| "danger-full-access";

/** FLY-350: Codex Lead capability tiers. `companion` = read-only chat;
 * `write-capable` (Z) = net-off workspace-write shell + the gateway
 * (git_push/open_pr/discord_send); `full-access` = a Claude-EQUAL Lead
 * (workspace-write + network ON + local gh/git, NO gateway/broker/release-gate;
 * the retained control is the team-wide founder-gate rule bundle, not confinement).
 * The runtime, ProjectConfig, and fleet-capabilities share this ONE enum so a
 * typo/drift can never silently activate a tier (R2-4). */
export const CODEX_LEAD_PROFILES = [
	"companion",
	"write-capable",
	"full-access",
] as const;
export type CodexLeadProfile = (typeof CODEX_LEAD_PROFILES)[number];

// ── FLY-245 Phase A: write-capable confinement (plan §3.1/§3.3) ──────────────
//
// A write-capable Codex Lead's exec sandbox must be pinned to `workspace-write`
// with network OFF, a single narrow writable root (the canonical Lead scratch),
// and a secret-scrubbing shell env policy. The scratch workspace must NOT overlap
// the control-plane checkout, `~/.flywheel`, the per-Lead state dir, or CODEX_HOME
// — otherwise a sandboxed model could write `comm.db`/`teamlead.db` (forging the
// founder gate's trusted sources) or rewrite the launcher/gateway code that
// launchd later runs OUTSIDE the sandbox (a persistent sandbox escape). Read
// isolation is NOT relied upon (workspace-write can read outside the root — that
// read/exfil surface is FLY-260, out of scope here); the guarantee here is WRITE
// isolation + no path overlap.

/** A path resolver used to canonicalize paths (injected in tests). */
export type RealpathFn = (p: string) => string;

/** Best-effort canonicalization: realpath when the path exists, else a lexical
 * `resolve` (sensitive targets like the state dir may not exist yet at boot —
 * a lexical compare is still sound for overlap detection). */
function canonicalize(p: string, realpath: RealpathFn): string {
	try {
		return realpath(p);
	} catch {
		return resolve(p);
	}
}

/** True when `a` is an ancestor of, descendant of, or equal to `b` (symmetric
 * overlap). Both inputs must already be canonical/absolute. */
export function pathsOverlap(a: string, b: string): boolean {
	if (a === b) return true;
	const under = (rel: string) =>
		rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
	// `b` under `a`  OR  `a` under `b`.
	return under(relative(a, b)) || under(relative(b, a));
}

function containsAsciiControl(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code <= 31 || code === 127) return true;
	}
	return false;
}

export interface LeadWorkspaceContext {
	home: string;
	flywheelDir: string;
	stateDir: string;
	codexHome: string;
	/** Trusted control-plane / gateway / launcher paths that must stay writable-
	 * isolated from the model's scratch (plan §3.3). */
	trustedPaths?: string[];
	realpath?: RealpathFn;
}

/**
 * Resolve + validate the write-capable Lead scratch workspace (plan §3.3, R1#4 /
 * R3-MED). FAIL-LOUD: throws a descriptive error on any violation. Returns the
 * canonical absolute path to pin into both `cwd` and `writable_roots`.
 *
 *   - must be an absolute path that exists (realpath-canonicalized: resolves
 *     symlinks / `..` / case-aliases so a crafted symlink can't smuggle the
 *     scratch into a sensitive location);
 *   - rejected when it EQUALS `$HOME` or is an ANCESTOR of `$HOME` (a normal
 *     workspace is a *descendant* of home — that is allowed; the earlier
 *     "reject any descendant" rule rejected every legitimate deployment, R1#4);
 *   - rejected on symmetric overlap with `~/.flywheel`, the per-Lead state dir,
 *     CODEX_HOME, or any trusted control-plane/gateway/launcher path.
 */
export function resolveLeadWorkspace(
	raw: string,
	ctx: LeadWorkspaceContext,
): string {
	const realpath = ctx.realpath ?? realpathSync;
	const trimmed = raw.trim();
	if (!trimmed || !isAbsolute(trimmed)) {
		throw new Error(
			`FLYWHEEL_CODEX_LEAD_WORKSPACE must be an absolute path (got "${raw}")`,
		);
	}
	let canon: string;
	try {
		canon = realpath(trimmed);
	} catch {
		throw new Error(
			`FLYWHEEL_CODEX_LEAD_WORKSPACE does not exist or is unreadable: ${trimmed} (create the dedicated Lead scratch dir first)`,
		);
	}
	const home = canonicalize(ctx.home, realpath);
	// $HOME rule: reject equal-to or ancestor-of home (NOT descendants).
	if (canon === home) {
		throw new Error(
			`FLYWHEEL_CODEX_LEAD_WORKSPACE must not be $HOME itself: ${canon}`,
		);
	}
	const homeUnderCanon = relative(canon, home);
	if (
		homeUnderCanon !== "" &&
		!homeUnderCanon.startsWith("..") &&
		!isAbsolute(homeUnderCanon)
	) {
		throw new Error(
			`FLYWHEEL_CODEX_LEAD_WORKSPACE must not be an ancestor of $HOME: ${canon}`,
		);
	}
	// Sensitive/trusted targets: reject symmetric overlap (canonicalized).
	const sensitive: Array<[string, string]> = [
		["~/.flywheel", ctx.flywheelDir],
		["the Lead state dir", ctx.stateDir],
		["CODEX_HOME", ctx.codexHome],
		...(ctx.trustedPaths ?? []).map((p): [string, string] => [
			"a trusted control-plane path",
			p,
		]),
	];
	for (const [label, target] of sensitive) {
		if (!target) continue;
		if (pathsOverlap(canon, canonicalize(target, realpath))) {
			throw new Error(
				`FLYWHEEL_CODEX_LEAD_WORKSPACE (${canon}) must not overlap ${label} (${target}) — the model could write trusted sources or launcher code`,
			);
		}
	}
	return canon;
}

/** Build the process-level `-c` confinement overrides for a write-capable Codex
 * Lead (plan §3.1). Net OFF + single narrow writable root + secret-scrubbing
 * shell env policy. read-only companions never call this (byte-compat). */
export function buildConfinementArgv(canonicalWorkspace: string): string[] {
	return [
		"-c",
		"sandbox_workspace_write.network_access=false",
		"-c",
		`sandbox_workspace_write.writable_roots=${JSON.stringify([canonicalWorkspace])}`,
		"-c",
		`shell_environment_policy.exclude=${JSON.stringify([
			"FLYWHEEL_*",
			"DISCORD_*",
			"*TOKEN*",
			"*SECRET*",
			"*KEY*",
			"CODEX_*",
		])}`,
	];
}

/** FLY-350 full-access (= Claude-equal): the process-level `-c` overrides for a
 * full-access Codex Lead. Workspace-write with network **ON** and the project root
 * as the single writable root. Deliberately NO `shell_environment_policy.exclude`
 * (the (Z) secret-scrub) — a full-access Lead keeps its gh/git/flywheel-comm env,
 * exactly like a Claude Lead pane; the H-1 positive env allowlist (buildFullAccessEnv)
 * is what bounds the env, not a Codex-side exclude. NO gateway/broker — the model
 * uses local `gh`/`git`. The retained control is the founder-gate rule bundle +
 * branch protection, NOT confinement (plan §2.1/§3). */
export function buildFullAccessArgv(canonicalProjectRoot: string): string[] {
	return [
		"-c",
		"sandbox_workspace_write.network_access=true",
		"-c",
		`sandbox_workspace_write.writable_roots=${JSON.stringify([canonicalProjectRoot])}`,
	];
}

/** FLY-350 H-1: the positive env allowlist a FULL-ACCESS Codex Lead's app-server
 * child inherits — a MIRROR of what a Claude Lead tmux pane actually gets
 * (claude-lead.sh:901-942) PLUS the gh/git auth path Claude uses. A full-access
 * Lead can READ the disk like a Claude pane (the accepted Claude-equal tradeoff,
 * plan §3), but its process env is never HANDED a secret a Claude pane would not
 * have. Non-secret shell basics (HOME/PATH/SHELL/…) keep gh/git/flywheel-comm
 * functional. gh auth uses the on-disk `~/.config/gh` keyring via HOME (the same
 * path Claude uses — no GH token in the Claude pane allowlist); GH_TOKEN/
 * GITHUB_TOKEN/GH_CONFIG_DIR are listed ONLY so a deploy that opts into env-token
 * auth is covered by the SSOT (the env-diff test asserts the result ⊆ this set). */
export const FULL_ACCESS_ENV_ALLOWLIST = [
	// non-secret shell basics (a functional shell for gh/git/flywheel-comm)
	"HOME",
	"PATH",
	"SHELL",
	"LANG",
	"LC_ALL",
	"TERM",
	"TMPDIR",
	"USER",
	"LOGNAME",
	// Claude Lead pane env — EXACTLY the names claude-lead.sh:901-942 injects into a
	// Claude pane (Codex code-review HIGH: never a token a Claude pane does NOT have).
	// NB: a Claude pane carries TEAMLEAD_API_TOKEN + BRIDGE_URL — NOT the FLYWHEEL_*
	// aliases; the model's flywheel-comm uses the same TEAMLEAD_* names Claude uses.
	"DISCORD_BOT_TOKEN",
	"DISCORD_STATE_DIR",
	"LEAD_ID",
	"FLYWHEEL_LEAD_ID",
	"FLYWHEEL_COMM_DB",
	"FLYWHEEL_COMM_CLI",
	"FLYWHEEL_FOUNDER_TZ",
	"PROJECT_NAME",
	"FLYWHEEL_PROJECT_NAME",
	"FLYWHEEL_PROJECT_DIR",
	"BRIDGE_URL",
	"TEAMLEAD_API_TOKEN",
	"TEAMLEAD_ISSUE_PREFIXES",
	"DISCORD_CORE_CHANNEL",
	"OPENAI_API_KEY",
	"FLYWHEEL_TEAMLEAD_SCRIPT_DIR",
	// gh/git auth — the ONLY sanctioned addition beyond the Claude-pane set (plan
	// H-1). Default is the on-disk keyring via HOME (the same path Claude uses, no
	// GH token in the Claude pane); these cover an opt-in env-token deploy + keep
	// the allowlist the SSOT for "what gh may use". The env-diff test pins the
	// allowlist to EXACTLY {Claude-pane secrets ∪ this gh-auth set}.
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"GH_CONFIG_DIR",
] as const;

/** Build the FULL-ACCESS app-server child env from a source env via the positive
 * allowlist (H-1). Absent vars are omitted (never injected empty — an empty
 * `tmux`-style value can break tooling). NOT raw `process.env`. */
export function buildFullAccessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const name of FULL_ACCESS_ENV_ALLOWLIST) {
		const v = env[name];
		if (v !== undefined) out[name] = v;
	}
	return out;
}

/** Resolve + validate the FULL-ACCESS Lead project root (plan §2.1 M-1). FAIL-LOUD.
 * Returns the canonical absolute path to pin into both `cwd` and `writable_roots`.
 * A full-access Lead works IN its project checkout (Claude-equal), so — unlike the
 * (Z) scratch — a descendant of $HOME is the normal case and is allowed. Rejected:
 * a non-absolute / non-existent path, $HOME itself or an ancestor of it, or overlap
 * with `~/.flywheel` / the Lead state dir / CODEX_HOME (the model must never be able
 * to write the runtime's own journal/thread state or its CODEX_HOME). */
export function resolveFullAccessProjectRoot(
	rawRoot: string | undefined,
	subdir: string | undefined,
	ctx: LeadWorkspaceContext,
): string {
	const realpath = ctx.realpath ?? realpathSync;
	const trimmed = (rawRoot ?? "").trim();
	if (!trimmed || !isAbsolute(trimmed)) {
		throw new Error(
			`FLYWHEEL_CODEX_LEAD_PROJECT_DIR must be an absolute path for a full-access Codex Lead (got "${rawRoot ?? ""}")`,
		);
	}
	const sub = (subdir ?? "").trim();
	const joined = sub ? join(trimmed, sub) : trimmed;
	let canon: string;
	try {
		canon = realpath(joined);
	} catch {
		throw new Error(
			`full-access project root does not exist or is unreadable: ${joined} (FLYWHEEL_CODEX_LEAD_PROJECT_DIR${sub ? ` + SUBDIR=${sub}` : ""})`,
		);
	}
	const home = canonicalize(ctx.home, realpath);
	if (canon === home) {
		throw new Error(
			`full-access project root must not be $HOME itself: ${canon}`,
		);
	}
	const homeUnderCanon = relative(canon, home);
	if (
		homeUnderCanon !== "" &&
		!homeUnderCanon.startsWith("..") &&
		!isAbsolute(homeUnderCanon)
	) {
		throw new Error(
			`full-access project root must not be an ancestor of $HOME: ${canon}`,
		);
	}
	const sensitive: Array<[string, string]> = [
		["~/.flywheel", ctx.flywheelDir],
		["the Lead state dir", ctx.stateDir],
		["CODEX_HOME", ctx.codexHome],
		...(ctx.trustedPaths ?? []).map((p): [string, string] => [
			"a trusted control-plane path",
			p,
		]),
	];
	for (const [label, target] of sensitive) {
		if (!target) continue;
		if (pathsOverlap(canon, canonicalize(target, realpath))) {
			throw new Error(
				`full-access project root (${canon}) must not overlap ${label} (${target}) — the model could write the runtime's own state/CODEX_HOME`,
			);
		}
	}
	return canon;
}

/** Parse + validate the runtime config from the environment. Fail-loud: a single
 * error lists ALL missing required vars (no silent half-config). The Bridge fields
 * (FLYWHEEL_BRIDGE_URL / FLYWHEEL_API_TOKEN) are required ONLY in "bridge" outbound
 * mode — the default "direct" mode needs no Bridge at all (low-risk first test). */
export function parseCodexLeadRuntimeConfig(
	env: NodeJS.ProcessEnv,
): CodexLeadRuntimeConfig {
	const missing: string[] = [];
	const req = (name: string): string => {
		const v = env[name]?.trim();
		if (!v) missing.push(name);
		return v ?? "";
	};
	const opt = (name: string): string => env[name]?.trim() ?? "";

	const outboundMode: "direct" | "bridge" =
		env.FLYWHEEL_CODEX_LEAD_OUTBOUND === "bridge" ? "bridge" : "direct";
	const typingEnabled = true;

	const leadId = req("FLYWHEEL_LEAD_ID");
	const projectName = req("FLYWHEEL_PROJECT_NAME");
	const leadKey = req("FLYWHEEL_LEAD_KEY");
	const backend = req("FLYWHEEL_LEAD_BACKEND");
	const identityDigest = req("FLYWHEEL_LEAD_IDENTITY_DIGEST");
	const botUserId = req("DISCORD_EXPECTED_BOT_USER_ID");
	const botToken = req("DISCORD_BOT_TOKEN");
	const chatChannelId = req("FLYWHEEL_LEAD_CHAT_CHANNEL_ID");
	const stateDir = req("FLYWHEEL_CODEX_LEAD_STATE_DIR");
	const codexBin = req("FLYWHEEL_CODEX_BIN");
	const codexHome = req("CODEX_HOME");
	const commDbPath = req("FLYWHEEL_COMM_DB");
	const rayaMetricsDir = leadId === "raya" ? req("RAYA_METRICS_DIR") : "";
	// Bridge fields: required only when outbound routes through the Bridge.
	const bridgeUrl =
		outboundMode === "bridge"
			? req("FLYWHEEL_BRIDGE_URL")
			: opt("FLYWHEEL_BRIDGE_URL");
	const apiToken =
		outboundMode === "bridge"
			? req("FLYWHEEL_API_TOKEN")
			: opt("FLYWHEEL_API_TOKEN");
	if (missing.length > 0) {
		throw new Error(
			`codex-lead-runtime: missing required env: ${missing.join(", ")}`,
		);
	}
	const expectedLeadKey = `${projectName}-${leadId}`;
	if (leadKey !== expectedLeadKey) {
		throw new Error(
			`codex-lead-runtime: FLYWHEEL_LEAD_KEY must be ${expectedLeadKey}, got ${leadKey}`,
		);
	}
	if (backend !== "codex-app-server") {
		throw new Error(
			`codex-lead-runtime: FLYWHEEL_LEAD_BACKEND must be codex-app-server, got ${backend}`,
		);
	}
	if (!/^[a-f0-9]{64}$/.test(identityDigest)) {
		throw new Error(
			"codex-lead-runtime: FLYWHEEL_LEAD_IDENTITY_DIGEST must be a 64-character lowercase hex digest",
		);
	}
	if (rayaMetricsDir && !isAbsolute(rayaMetricsDir)) {
		throw new Error(
			"codex-lead-runtime: RAYA_METRICS_DIR must be an absolute path",
		);
	}
	if (env.LEAD_ID !== undefined && env.LEAD_ID.trim() !== leadId) {
		throw new Error(
			"codex-lead-runtime: LEAD_ID conflicts with FLYWHEEL_LEAD_ID",
		);
	}
	if (
		env.PROJECT_NAME !== undefined &&
		env.PROJECT_NAME.trim() !== projectName
	) {
		throw new Error(
			"codex-lead-runtime: PROJECT_NAME conflicts with FLYWHEEL_PROJECT_NAME",
		);
	}
	if (env.FLYWHEEL_LEAD_BOT_USER_ID !== undefined) {
		throw new Error(
			"codex-lead-runtime: legacy FLYWHEEL_LEAD_BOT_USER_ID is forbidden; use canonical DISCORD_EXPECTED_BOT_USER_ID",
		);
	}

	const coreChannelId = env.FLYWHEEL_LEAD_CORE_CHANNEL_ID?.trim() || undefined;
	const baseChannels = [
		chatChannelId,
		...(coreChannelId ? [coreChannelId] : []),
	];
	// FLY-267 收: cross-dept / shared channels (e.g. #leads-roundtable). Deduped and
	// stripped of any id already in base (a chat/core channel must NOT be mention-
	// gated). `channelIds` keeps the base array EXACTLY when no cross-dept id is
	// configured (byte-compat — no Set wrapping that could reorder/dedup base).
	const crossSeen = new Set<string>();
	const crossDeptChannelIds: string[] = [];
	for (const id of (env.FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)) {
		if (baseChannels.includes(id) || crossSeen.has(id)) continue;
		crossSeen.add(id);
		crossDeptChannelIds.push(id);
	}
	const channelIds = [...baseChannels, ...crossDeptChannelIds];
	// FLY-267 回 (Codex code-review R1 HIGH): a cross-dept reply in "bridge" outbound
	// mode would be REJECTED by the Bridge — buildAuthorizeLeadChannel authorizes only
	// the Lead's chatChannel + project generalChannel, so a roundtable send 403s and the
	// journal row goes ambiguous. The Bridge can't authoritatively see this per-Lead
	// runtime env, so we FAIL LOUD here rather than ship a silent 403. Cross-dept is
	// supported in "direct" mode (Mufasa); server-side shared-channel authorization for
	// bridge mode is a follow-up.
	if (crossDeptChannelIds.length > 0 && outboundMode === "bridge") {
		throw new Error(
			"codex-lead-runtime: cross-dept channels (FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS) " +
				"require DIRECT outbound mode — bridge mode would 403 a shared-channel reply " +
				"(the Bridge authorizes only chat + generalChannel). Use direct mode, or wait " +
				"for server-side shared-channel authorization (follow-up).",
		);
	}
	// FLY-267 判: optional name-mention regexes (non-bot authors only; see isMentioned).
	const mentionPatterns = (env.FLYWHEEL_LEAD_MENTION_PATTERNS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	// FLY-898: core-room id-only mention gate for a non-CoS lead. The launcher sets
	// this from resolveCoreRoomGate(projects.json); a CoS / core-less / core-no-CoS
	// project never sets it → false → byte-compat (core always handled).
	const coreMentionGated = env.FLYWHEEL_LEAD_CORE_MENTION_GATED === "1";
	// FLY-314 Phase 2: reply-in-thread (default-OFF). The roundtable parent channel
	// MUST be one of the cross-dept channels (so it is polled + mention-gated).
	// `guildId` enables active-thread discovery; without it, only the immediate
	// @-mention path subscribes.
	let replyInThread: ReplyInThreadConfig | undefined;
	// FLY-1243: FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD retired (固化 default-on). A
	// resolvable roundtable parent channel is the de-facto switch now: absent ⇒
	// reply-in-thread simply isn't configured for this Lead (byte-compat OFF),
	// never a throw.
	const parentChannelId =
		(env.FLYWHEEL_ROUNDTABLE_CHANNEL_ID ?? "").trim() ||
		crossDeptChannelIds[0] ||
		"";
	if (parentChannelId) {
		if (!crossDeptChannelIds.includes(parentChannelId)) {
			throw new Error(
				`codex-lead-runtime: reply-in-thread parent ${parentChannelId} must be in FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS (so it is polled + mention-gated)`,
			);
		}
		const capN = Number.parseInt(
			(env.FLYWHEEL_ROUNDTABLE_REPLY_CAP ?? "").trim(),
			10,
		);
		// FLY-676: no-@ in-thread continuation is permanent when a resolvable
		// roundtable parent exists. The EFFECTIVE marker still encodes that parent
		// precondition for downstream consumers.
		const budgetParsed = Number.parseInt(
			(env.FLYWHEEL_ROUNDTABLE_THREAD_BUDGET ?? "").trim(),
			10,
		);
		replyInThread = {
			enabled: true,
			parentChannelId,
			autoContinue: true,
			...(Number.isFinite(budgetParsed) && budgetParsed > 0
				? { budgetN: budgetParsed }
				: {}),
			...((env.FLYWHEEL_ROUNDTABLE_GUILD_ID ?? "").trim() || undefined
				? { guildId: (env.FLYWHEEL_ROUNDTABLE_GUILD_ID ?? "").trim() }
				: {}),
			...(Number.isFinite(capN) && capN > 0 ? { cap: capN } : {}),
		};
	}
	const chrome = undefined;
	// Persona/identity files → baseInstructions (comma-separated paths; missing skipped).
	const systemPromptFiles = (env.FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	// FLY-2131 M2-a: these are thread protocol fields, shared by the headless and
	// TUI runtimes through buildThreadParams. Do not materialize absent fields: the
	// default path must retain the exact pre-M2 JSON frame bytes.
	let model: string | undefined;
	if (env.FLYWHEEL_LEAD_MODEL !== undefined) {
		model = env.FLYWHEEL_LEAD_MODEL.trim();
		if (!model || containsAsciiControl(model)) {
			throw new Error(
				"codex-lead-runtime: FLYWHEEL_LEAD_MODEL must be a non-empty string without control characters",
			);
		}
	}
	let reasoningEffort: CodexLeadRuntimeConfig["reasoningEffort"];
	if (env.FLYWHEEL_LEAD_EFFORT !== undefined) {
		const effort = env.FLYWHEEL_LEAD_EFFORT.trim();
		if (
			effort !== "low" &&
			effort !== "medium" &&
			effort !== "high" &&
			effort !== "xhigh" &&
			effort !== "max"
		) {
			throw new Error(
				`codex-lead-runtime: FLYWHEEL_LEAD_EFFORT="${effort}" invalid (one of: low, medium, high, xhigh, max)`,
			);
		}
		reasoningEffort = effort;
	}
	let modelContextWindow: number | undefined;
	if (env.FLYWHEEL_LEAD_MODEL_CONTEXT_WINDOW !== undefined) {
		const raw = env.FLYWHEEL_LEAD_MODEL_CONTEXT_WINDOW.trim();
		const parsed = Number(raw);
		if (
			!/^\d+$/.test(raw) ||
			!Number.isSafeInteger(parsed) ||
			parsed < 1 ||
			parsed > 10_000_000
		) {
			throw new Error(
				`codex-lead-runtime: FLYWHEEL_LEAD_MODEL_CONTEXT_WINDOW="${raw}" must be an integer from 1 through 10000000`,
			);
		}
		modelContextWindow = parsed;
	}
	// App-server sandbox policy (HIGH-1) — validate against the schema enum; default
	// read-only (companion). An unknown value fails loud rather than silently default.
	const sandboxRaw = env.FLYWHEEL_CODEX_LEAD_SANDBOX?.trim() || "read-only";
	const SANDBOX_MODES: CodexSandboxMode[] = [
		"read-only",
		"workspace-write",
		"danger-full-access",
	];
	if (!SANDBOX_MODES.includes(sandboxRaw as CodexSandboxMode)) {
		throw new Error(
			`codex-lead-runtime: FLYWHEEL_CODEX_LEAD_SANDBOX="${sandboxRaw}" invalid (one of: ${SANDBOX_MODES.join(", ")})`,
		);
	}
	const sandboxMode = sandboxRaw as CodexSandboxMode;
	// FLY-350: capability profile. R2-4 (codex round-2 MED): an UNKNOWN profile is
	// fail-loud — NOT a silent fall to companion. The old "anything else → companion"
	// meant a launcher typo could run `sandbox=workspace-write` under an unrecognized
	// profile (silent write-capable). Now the recognized set is explicit and a typo
	// throws at parse. Profile ↔ sandbox consistency is asserted per tier.
	const profileRaw = env.FLYWHEEL_CODEX_LEAD_PROFILE?.trim() || "companion";
	if (!(CODEX_LEAD_PROFILES as readonly string[]).includes(profileRaw)) {
		throw new Error(
			`codex-lead-runtime: FLYWHEEL_CODEX_LEAD_PROFILE="${profileRaw}" invalid (one of: ${CODEX_LEAD_PROFILES.join(", ")}) — fail-loud, never silently default (R2-4)`,
		);
	}
	const codexProfile = profileRaw as CodexLeadProfile;
	// FLY-350 (Z): write-capable = net-off workspace-write shell + the gateway
	// (git_push/open_pr/discord_send). The profile and the sandbox are kept in a
	// BIDIRECTIONAL lockstep so the profile is the SSOT (plan §3.5; Codex review
	// MEDIUM — closes the "sandbox=workspace-write but profile=companion" drift
	// where fleet/config would mislabel an actually-write-capable Lead):
	//   - write-capable REQUIRES workspace-write (a write-capable read-only shell
	//     is a contradiction), AND
	//   - workspace-write REQUIRES an explicit write tier (no silent
	//     write-capability under companion).
	if (codexProfile === "write-capable" && sandboxMode !== "workspace-write") {
		throw new Error(
			`codex-lead-runtime: FLYWHEEL_CODEX_LEAD_PROFILE=write-capable requires sandbox=workspace-write (got "${sandboxMode}") — the (Z) write-capable Lead is a net-off workspace-write shell + gateway (FLY-350)`,
		);
	}
	// FLY-350 full-access (= Claude-equal): workspace-write with network ON + local
	// gh/git. Like write-capable it REQUIRES workspace-write (a read-only "full-access"
	// is a contradiction); unlike it, there is no gateway/broker/release-gate.
	if (codexProfile === "full-access" && sandboxMode !== "workspace-write") {
		throw new Error(
			`codex-lead-runtime: FLYWHEEL_CODEX_LEAD_PROFILE=full-access requires sandbox=workspace-write (got "${sandboxMode}") — a full-access Codex Lead is workspace-write + network ON, Claude-equal (FLY-350)`,
		);
	}
	// workspace-write is the SSOT-tied write tier: it requires EITHER the (Z)
	// write-capable profile OR the full-access profile — never a silent companion
	// write (config/fleet/runtime drift, R2-4 / §3.5).
	if (
		sandboxMode === "workspace-write" &&
		codexProfile !== "write-capable" &&
		codexProfile !== "full-access"
	) {
		throw new Error(
			`codex-lead-runtime: sandbox=workspace-write requires FLYWHEEL_CODEX_LEAD_PROFILE=write-capable or full-access (got "${codexProfile}") — workspace-write IS a write tier; the explicit profile is the SSOT so config/fleet/runtime can never drift (FLY-350 §3.5)`,
		);
	}
	// FLY-245 Phase A: for a write-capable sandbox, resolve + validate the Lead
	// scratch workspace when configured. Purely additive — when unset, `workspace`
	// stays undefined and the write-capable release gate (buildCodexLeadRuntime →
	// assertWriteCapableRelease) fail-closes.
	let workspace: string | undefined;
	let founderId: string | undefined;
	let cliVersionAllowlist: string[] | undefined;
	let gatewayEntry: string | undefined;
	let gatewayConfirmChannelId: string | undefined;
	let githubToken: string | undefined;
	let projectRepo: string | undefined;
	// FLY-350 full-access: resolve the canonical project root (cwd + single writable
	// root). REQUIRED + fail-loud for full-access; undefined for every other tier.
	let fullAccessProjectRoot: string | undefined;
	// FLY-304 full-access: the proactive discord_send MCP entry (mirrors the gateway
	// entry resolution). Overridable via FLYWHEEL_LEAD_ACTIONS_ENTRY (tests / non-
	// standard deploys); existsSync-validated at build (buildCodexLeadRuntime).
	let leadActionsEntry: string | undefined;
	let leadActionsChannelAliases: string | undefined;
	if (codexProfile === "full-access") {
		fullAccessProjectRoot = resolveFullAccessProjectRoot(
			env.FLYWHEEL_CODEX_LEAD_PROJECT_DIR,
			env.FLYWHEEL_CODEX_LEAD_SUBDIR,
			{
				home: homedir(),
				flywheelDir: join(homedir(), ".flywheel"),
				stateDir,
				codexHome,
			},
		);
		leadActionsEntry =
			env.FLYWHEEL_LEAD_ACTIONS_ENTRY?.trim() || defaultLeadActionsEntryPath();
		// Forward explicit alias pins so the documented multi-cross-dept roundtable
		// disambiguation works for full-access (code-review R1#2).
		leadActionsChannelAliases =
			env.FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES?.trim() || undefined;
	}
	// (Z) write-capable inputs — scoped to the write-capable profile (full-access
	// shares the workspace-write sandbox but uses NONE of the gateway/scratch path).
	if (codexProfile === "write-capable") {
		// Resolve the gateway deploy path FIRST — it (and the teamlead checkout +
		// codex binary) are the trusted control-plane roots the scratch workspace
		// must not overlap (R1 HIGH-2).
		gatewayEntry =
			env.FLYWHEEL_GATEWAY_ENTRY?.trim() || defaultGatewayEntryPath();
		const rawWorkspace = env.FLYWHEEL_CODEX_LEAD_WORKSPACE?.trim();
		if (rawWorkspace) {
			workspace = resolveLeadWorkspace(rawWorkspace, {
				home: homedir(),
				flywheelDir: join(homedir(), ".flywheel"),
				stateDir,
				codexHome,
				// R1 HIGH-2: production now SUPPLIES the trusted roots (the overlap
				// option was wired in Phase A but never fed) — a workspace that
				// overlaps the runtime checkout / gateway deploy dir / deps is rejected.
				trustedPaths: resolveControlPlaneRoots(gatewayEntry, codexBin),
			});
		}
		// FLY-245 F-b: the remaining write-capable release inputs (plan §7) —
		// all optional at parse; assertWriteCapableRelease fail-closes on gaps.
		founderId = env.FLYWHEEL_FOUNDER_DISCORD_USER_ID?.trim() || undefined;
		const allowlist = (env.FLYWHEEL_CODEX_CLI_VERSION_ALLOWLIST ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		cliVersionAllowlist = allowlist.length > 0 ? allowlist : undefined;
		gatewayConfirmChannelId =
			env.FLYWHEEL_GATEWAY_CONFIRM_CHANNEL_ID?.trim() || chatChannelId;
		// FLY-350 (Z) unit 4: gateway-proxied PR inputs. The GH_TOKEN is a SECRET
		// (broker-served into the gateway only — never the shell). projectRepo is a
		// non-secret coordinate. Both optional at parse; git_push/open_pr fail
		// closed at call time when the token/repo are absent.
		githubToken = env.FLYWHEEL_GATEWAY_GITHUB_TOKEN?.trim() || undefined;
		projectRepo = env.FLYWHEEL_GATEWAY_PROJECT_REPO?.trim() || undefined;
	}

	return {
		projectName,
		leadId,
		leadKey,
		identityDigest,
		botUserId,
		botToken,
		chatChannelId,
		coreChannelId,
		channelIds,
		crossDeptChannelIds,
		mentionPatterns,
		coreMentionGated,
		...(replyInThread ? { replyInThread } : {}),
		bridgeUrl,
		apiToken,
		stateDir,
		journalDbPath: join(stateDir, "journal.db"),
		outboxDbPath: join(stateDir, "outbox.db"),
		threadIdPath: join(stateDir, "thread-id"),
		inboundCursorPath: join(stateDir, "inbound-cursor.json"),
		commDbPath,
		codexBin,
		codexHome,
		chrome,
		outboundMode,
		typingEnabled,
		...(model ? { model } : {}),
		...(reasoningEffort ? { reasoningEffort } : {}),
		...(modelContextWindow ? { modelContextWindow } : {}),
		...(rayaMetricsDir
			? {
					contextUsagePath: join(rayaMetricsDir, "context-usage.jsonl"),
					contextUsageUnavailablePath: join(
						rayaMetricsDir,
						"context-usage-unavailable.jsonl",
					),
				}
			: {}),
		systemPromptFiles,
		sandboxMode,
		codexProfile,
		workspace,
		founderId,
		cliVersionAllowlist,
		gatewayEntry,
		gatewayConfirmChannelId,
		githubToken,
		projectRepo,
		fullAccessProjectRoot,
		leadActionsEntry,
		leadActionsChannelAliases,
	};
}

/** FLY-898: the EFFECTIVE core-strict channel set for the mention gate. The core
 * room is id-only-gated iff (a) the launcher flagged it (`coreMentionGated`), AND
 * (b) there is a core channel, AND (c) that core channel is actually in the
 * runtime's subscribed `channelIds` (guardrail #1 — never claim a gate on a
 * channel we don't even poll). Returns `[core]` or `[]`; shared by both runtimes'
 * wiring AND the dry-run report so "on/off" always reflects the real decision. */
export function resolveCoreStrictChannelIds(config: {
	coreMentionGated: boolean;
	coreChannelId?: string;
	channelIds: string[];
}): string[] {
	return config.coreMentionGated &&
		config.coreChannelId &&
		config.channelIds.includes(config.coreChannelId)
		? [config.coreChannelId]
		: [];
}

/** The deployed gateway MCP entry next to this module (dist layout). Overridable
 * via FLYWHEEL_GATEWAY_ENTRY (tests / non-standard deploys). */
function defaultGatewayEntryPath(): string {
	return fileURLToPath(new URL("./gateway/gateway-main.js", import.meta.url));
}

/** FLY-304: the deployed lead-actions MCP entry next to this module (dist layout)
 * — the proactive discord_send server for a FULL-ACCESS Codex Lead. Overridable
 * via FLYWHEEL_LEAD_ACTIONS_ENTRY (tests / non-standard deploys). */
function defaultLeadActionsEntryPath(): string {
	return fileURLToPath(
		new URL("./lead-actions/lead-actions-main.js", import.meta.url),
	);
}

/** FLY-304 (codex review item 2): verify the trusted lead-actions MCP entry EXISTS
 * BEFORE spawning the app-server, so a full-access Lead fails LOUD at boot (with a
 * build hint) instead of silently starting a broken MCP command that only errors
 * when the model first tries to call the tool. Returns the validated path. */
function assertLeadActionsEntry(entry: string | undefined): string {
	if (!entry || !existsSync(entry)) {
		throw new Error(
			`lead-actions entry not deployed at ${entry ?? "(unset)"} — build the ` +
				`teamlead dist (pnpm --filter flywheel-teamlead build) before starting a ` +
				`full-access Codex Lead with proactive discord_send (FLY-304)`,
		);
	}
	return entry;
}

/** FLY-304: the lead-actions MCP options for a full-access Lead — SHARED by the live
 * startup (buildCodexLeadRuntime) and the dry-run report so they can NEVER diverge
 * (code-review R1#3). The bot token is forwarded BY NAME (env_vars) — never a literal;
 * all literal env entries are NON-SECRET coordinates. `entry` is passed in (the live
 * path existsSync-validates it first; dry-run discloses the configured path as-is). */
function fullAccessLeadActionsMcpConfig(
	config: Pick<
		CodexLeadRuntimeConfig,
		| "leadId"
		| "projectName"
		| "chatChannelId"
		| "crossDeptChannelIds"
		| "stateDir"
		| "commDbPath"
		| "leadActionsChannelAliases"
	>,
	entry: string,
	// FLY-676: the EFFECTIVE roundtable autoContinue, computed by the caller from
	// config.replyInThread (replyInThread enabled && autoContinue). Forwarded as a non-secret
	// coordinate so the MCP child guards proactive roundtable sends WITHOUT re-deriving it from
	// raw env (Codex R4#1). Both call sites (live + dry-run) pass the same value.
	roundtableAutoContinue: boolean,
): LeadActionsMcpConfig {
	const env: Record<string, string> = {
		FLYWHEEL_LEAD_ID: config.leadId,
		FLYWHEEL_PROJECT_NAME: config.projectName,
		FLYWHEEL_LEAD_CHAT_CHANNEL_ID: config.chatChannelId,
		FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS: config.crossDeptChannelIds.join(","),
		FLYWHEEL_LEAD_ACTIONS_STATE_DIR: config.stateDir,
		FLYWHEEL_COMM_DB: config.commDbPath,
		// R1#2: forward explicit alias pins so the documented roundtable
		// disambiguation works for full-access (non-secret).
		...(config.leadActionsChannelAliases
			? {
					FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES:
						config.leadActionsChannelAliases,
				}
			: {}),
		// FLY-676: effective roundtable autoContinue (non-secret). Present only when ON so the
		// OFF config keeps its prior env shape (byte-compat). The child fail-soft refuses a
		// proactive target="roundtable" send when this is "1" (FLY-680 engage hook pending).
		...(roundtableAutoContinue
			? { FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE_EFFECTIVE: "1" }
			: {}),
	};
	return {
		command: process.execPath,
		args: [entry],
		env,
		// Token by NAME — already in the full-access app-server env; never a literal.
		envVarNames: ["DISCORD_BOT_TOKEN"],
	};
}

/** Walk up from `start` to the nearest directory containing a `package.json`
 * (the teamlead package root — covers the runtime + launcher script + the
 * node_modules dependency closure). Returns undefined if none is found. */
function findPackageRoot(start: string): string | undefined {
	let dir = start;
	for (let i = 0; i < 12; i++) {
		if (existsSync(join(dir, "package.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

/**
 * FLY-245 R1 HIGH-2: the TRUSTED control-plane roots a write-capable Lead's
 * scratch workspace must NOT overlap — the model could otherwise rewrite the
 * code launchd later runs OUTSIDE the sandbox (persistent escape). Derived
 * (never model-supplied): the teamlead package root (runtime + launcher +
 * dependency closure), the gateway DEPLOY directory, and the codex binary.
 * Passed into `resolveLeadWorkspace` as `trustedPaths` (the overlap check was
 * wired in Phase A but production never supplied these).
 */
export function resolveControlPlaneRoots(
	gatewayEntry: string | undefined,
	codexBin: string,
): string[] {
	const roots: string[] = [];
	const pkgRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
	if (pkgRoot) roots.push(pkgRoot);
	if (gatewayEntry) roots.push(dirname(gatewayEntry));
	if (codexBin && isAbsolute(codexBin)) roots.push(codexBin);
	return roots;
}

/** Build the `thread/start`|`thread/resume` params: the PINNED app-server policy
 * (FLY-224 review HIGH-1 / Phase 0A §) — `approvalPolicy="never"` (a headless
 * app-server can't service interactive approvals) + the configured `sandbox` — plus
 * the persona `baseInstructions` when present. Always returns an object (the policy
 * is always pinned), so the thread never starts with the app-server's permissive
 * defaults. */
export function buildThreadParams(
	config: Pick<
		CodexLeadRuntimeConfig,
		| "sandboxMode"
		| "workspace"
		| "fullAccessProjectRoot"
		| "model"
		| "reasoningEffort"
		| "modelContextWindow"
	>,
	baseInstructions: string | undefined,
): Record<string, unknown> {
	const params: Record<string, unknown> = {
		approvalPolicy: "never",
		sandbox: config.sandboxMode,
	};
	// FLY-245 Phase A (plan §3.3, R7): pin cwd to the canonical Lead scratch for a
	// write-capable Lead — an unpinned cwd auto-becomes a writable root (= the
	// app-server's launch dir, indeterminate). read-only companions leave `workspace`
	// undefined → no cwd → byte-compat with the FLY-224 thread params.
	// FLY-350 full-access: pin cwd to the project root (same rationale; the two
	// fields are mutually exclusive — a Lead is never both write-capable and
	// full-access, enforced at parse).
	if (config.workspace) params.cwd = config.workspace;
	else if (config.fullAccessProjectRoot)
		params.cwd = config.fullAccessProjectRoot;
	if (baseInstructions) params.baseInstructions = baseInstructions;
	if (config.model) params.model = config.model;
	if (
		config.reasoningEffort !== undefined ||
		config.modelContextWindow !== undefined
	) {
		params.config = {
			...(config.reasoningEffort !== undefined
				? { model_reasoning_effort: config.reasoningEffort }
				: {}),
			...(config.modelContextWindow !== undefined
				? { model_context_window: config.modelContextWindow }
				: {}),
		};
	}
	return params;
}

/** Strip a leading YAML frontmatter block (`---\n…\n---\n`) — that block is
 * Claude-Code tooling config (model/permissionMode/…), not persona prose, and
 * would mislead a Codex model (e.g. `model: opus`). No frontmatter → unchanged. */
function stripFrontmatter(s: string): string {
	return s.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

/** Read + concatenate persona/identity files into a single `baseInstructions`
 * system prompt. Missing/unreadable files are skipped (never throws). Returns
 * undefined when nothing readable/non-empty remains → caller omits baseInstructions
 * (byte-compat with the no-persona path). */
export function readBaseInstructions(files: string[]): string | undefined {
	const parts: string[] = [];
	for (const file of files) {
		try {
			const body = stripFrontmatter(readFileSync(file, "utf8")).trim();
			if (body) parts.push(body);
		} catch {
			// missing/unreadable → skip (byte-compat)
		}
	}
	const joined = parts.join("\n\n");
	return joined || undefined;
}

/** Persisted thread id so a restart resumes the same Codex thread. */
export function readThreadId(path: string): string | undefined {
	try {
		const v = readFileSync(path, "utf8").trim();
		return v || undefined;
	} catch {
		return undefined;
	}
}

export function writeThreadId(path: string, threadId: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, threadId, "utf8");
}

// ── FLY-245 F-b: the write-capable release gate (plan §7) ────────────────────

/** §3.5 (release ⑧, static half): explicitly disable the non-MCP action
 * surfaces we can disable via config. `--strict-config` rejects unknown keys,
 * so this list carries only keys verified against the real app-server; the
 * remaining NON_MCP_ACTION_SURFACES (connectors/apps/hooks/multi-agent/
 * skill-install/login) are enumerated + disabled during the Phase F
 * real-machine threat-matrix QA, whose runtime tool-surface assertion
 * (`assertActionToolSurface`, A3) is the load-bearing guard either way. */
export function buildActionSurfaceDisableArgv(): string[] {
	return ["-c", "tools.web_search=false"];
}

/** The validated write-capable release bundle (every field proven present). */
export interface WriteCapableRelease {
	workspace: string;
	founderId: string;
	cliVersionAllowlist: string[];
	gatewayEntry: string;
	gatewayConfirmChannelId: string;
	/** FLY-350 (Z) unit 5: gateway-proxied PR scope — the GH_TOKEN SOURCE (the
	 * value is broker-served, never echoed in the release) + the validated
	 * owner/repo. A write-capable (Z) Lead is PR-capable, so both are required at
	 * boot (fail-loud); the runtime probe re-validates the token's actual scope
	 * at call time. */
	githubTokenConfigured: boolean;
	projectRepo: string;
}

/**
 * FLY-245 §7 — the 8-condition release gate for a write-capable Codex Lead.
 * Replaces the FLY-224 unconditional fail-close: the THROW SEMANTICS ARE
 * PRESERVED for every incomplete configuration; only a configuration that
 * proves ALL statically-checkable conditions unlocks the build, and the
 * runtime assertions (thread descriptor ⑤, MCP inventory ④, action-surface ⑧)
 * still fail the Lead closed after spawn on any drift.
 *
 *   ① sandbox === workspace-write (danger-full-access is REFUSED forever)
 *   ② validated scratch workspace (realpath'd, non-overlapping — Phase A)
 *   ③ confinement argv injected           (wired by buildCodexLeadRuntime)
 *   ④ MCP allowlist = gateway only        (wired + runtime inventory assert)
 *   ⑤ thread-descriptor assertion inputs: founder id + cliVersion allowlist
 *   ⑥ gateway deployed at a trusted ABSOLUTE path outside the workspace
 *   ⑦ broker secrets present (bot token + API token) + washed app-server env
 *   ⑧ non-gateway action surfaces disabled (static argv here; runtime
 *     tool-surface assertion via A3; full enumeration = Phase F QA)
 */
export function assertWriteCapableRelease(
	config: CodexLeadRuntimeConfig,
): WriteCapableRelease {
	// ① danger-full-access is permanently refused — no condition set unlocks it.
	if (config.sandboxMode === "danger-full-access") {
		throw new Error(
			'codex-lead-runtime: sandbox="danger-full-access" is permanently refused for a Codex Lead (FLY-245 §7 ①) — use workspace-write',
		);
	}
	const failures: string[] = [];
	if (config.sandboxMode !== "workspace-write") {
		failures.push(`sandbox "${config.sandboxMode}" is not workspace-write (①)`);
	}
	if (!config.workspace) {
		failures.push(
			"FLYWHEEL_CODEX_LEAD_WORKSPACE missing/invalid — no validated scratch workspace (②)",
		);
	}
	if (!config.founderId) {
		failures.push("FLYWHEEL_FOUNDER_DISCORD_USER_ID missing (⑤)");
	}
	if (!config.cliVersionAllowlist || config.cliVersionAllowlist.length === 0) {
		failures.push(
			"FLYWHEEL_CODEX_CLI_VERSION_ALLOWLIST missing — a Codex version must pass the threat matrix before running write-capable (⑤)",
		);
	}
	if (!config.gatewayEntry || !isAbsolute(config.gatewayEntry)) {
		failures.push("gateway entry path missing/non-absolute (⑥)");
	} else if (!existsSync(config.gatewayEntry)) {
		failures.push(
			`gateway entry not deployed at ${config.gatewayEntry} (⑥ — build the teamlead dist)`,
		);
	} else {
		// Canonicalize (realpath) before the overlap check — the workspace is
		// already canonical, and a symlinked entry must not smuggle past it.
		let entryCanon: string;
		try {
			entryCanon = realpathSync(config.gatewayEntry);
		} catch {
			entryCanon = resolve(config.gatewayEntry);
		}
		if (config.workspace && pathsOverlap(entryCanon, config.workspace)) {
			failures.push(
				"gateway entry lies INSIDE the model-writable workspace — persistent-tamper risk (⑥/§3.3)",
			);
		}
	}
	if (!config.botToken) {
		failures.push("DISCORD_BOT_TOKEN missing — broker has no bot token (⑦)");
	}
	if (!config.apiToken) {
		failures.push(
			"FLYWHEEL_API_TOKEN missing — the gateway cannot reach the Bridge action endpoints (⑦)",
		);
	}
	if (!config.gatewayConfirmChannelId) {
		failures.push("founder-confirmation channel missing (⑤/§5.6)");
	}
	// FLY-350 (Z) unit 5: a write-capable Lead is PR-capable — the gateway-proxied
	// git_push/open_pr REQUIRE a broker-served GH_TOKEN + a valid project repo.
	// Boot-time fail-loud on the SOURCE (presence + slug shape); the runtime
	// probeGitHubToken re-validates the token's actual scope/actor at call time.
	if (!config.githubToken) {
		failures.push(
			"FLYWHEEL_GATEWAY_GITHUB_TOKEN missing — a write-capable (Z) Lead is PR-capable and needs the broker-served fine-grained GH_TOKEN (contents:write + pull_requests:write)",
		);
	}
	if (!config.projectRepo) {
		failures.push(
			"FLYWHEEL_GATEWAY_PROJECT_REPO missing — git_push/open_pr must be scoped to an owner/repo",
		);
	} else {
		try {
			parseOwnerRepo(config.projectRepo);
		} catch {
			failures.push(
				`FLYWHEEL_GATEWAY_PROJECT_REPO "${config.projectRepo}" is not a valid "owner/repo" slug`,
			);
		}
	}
	if (failures.length > 0) {
		throw new Error(
			`codex-lead-runtime: write-capable sandbox REFUSED (fail-closed, FLY-245 §7) — ${failures.join("; ")}`,
		);
	}
	return {
		workspace: config.workspace as string,
		founderId: config.founderId as string,
		cliVersionAllowlist: config.cliVersionAllowlist as string[],
		gatewayEntry: config.gatewayEntry as string,
		gatewayConfirmChannelId: config.gatewayConfirmChannelId as string,
		githubTokenConfigured: Boolean(config.githubToken),
		projectRepo: config.projectRepo as string,
	};
}

/** Real ChildTransport over `codex app-server --strict-config -c …`.
 *
 * FLY-245 Phase E (plan §6 item 1, Codex R1#3): the app-server env is WASHED of
 * action secrets (`*TOKEN*` / `*SECRET*` / `*KEY*`) for EVERY Lead — read-only
 * companions included. The model's exec shell inherits this env, so a secret
 * here is a secret burned; action secrets travel only over the parent-runtime
 * unix-socket broker (secret-broker.ts), which the sandboxed model cannot
 * connect() to. This makes the FLY-224 read-only path "behavior-equivalent
 * plus one env-washing layer", not byte-identical (plan §7.1). */
export function spawnCodexAppServer(cfg: {
	codexBin: string;
	mcpArgv: string[];
	codexHome: string;
	baseEnv?: NodeJS.ProcessEnv;
	/** FLY-350 full-access: when false, the `baseEnv` is used AS-IS — it is already
	 * a curated positive allowlist (buildFullAccessEnv), and washing it would strip
	 * the gh/Discord/Bridge auth a Claude-equal Lead needs. Default TRUE: every
	 * confined / read-only / (Z) write-capable path keeps the unconditional
	 * action-secret wash (byte-compat — the FLY-245 Phase E sentinel holds). */
	washSecrets?: boolean;
	carrierInstanceId?: string;
	leadId?: string;
	projectName?: string;
}): ChildTransport {
	const args = ["app-server", "--strict-config", ...cfg.mcpArgv];
	const base = cfg.baseEnv ?? process.env;
	const child = spawn(cfg.codexBin, args, {
		env: {
			...(cfg.washSecrets === false ? base : washActionSecretEnv(base)),
			CODEX_HOME: cfg.codexHome,
			...(cfg.carrierInstanceId
				? {
						FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: cfg.carrierInstanceId,
						...(cfg.leadId ? { FLYWHEEL_LEAD_ID: cfg.leadId } : {}),
						...(cfg.projectName
							? { FLYWHEEL_PROJECT_NAME: cfg.projectName }
							: {}),
					}
				: {}),
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	return {
		writeStdin: (data) => {
			child.stdin?.write(data);
		},
		endStdin: () => {
			child.stdin?.end();
		},
		kill: (signal) => {
			child.kill(signal);
		},
		onStdout: (cb) => {
			child.stdout?.on("data", (c: string) => cb(c));
		},
		onStderr: (cb) => {
			child.stderr?.on("data", (c: string) => cb(c));
		},
		onExit: (cb) => {
			child.on("exit", cb);
		},
	};
}

/** Assemble the full Codex Lead into a CodexLeadRuntime (real-component wiring). */
export function buildCodexLeadRuntime(
	config: CodexLeadRuntimeConfig,
	logger: {
		info: (m: string, c?: unknown) => void;
		warn: (m: string, c?: unknown) => void;
		error: (m: string, c?: unknown) => void;
	} = console,
): CodexLeadRuntime {
	mkdirSync(config.stateDir, { recursive: true });

	const journal = new LeadJournal({
		store: new SqliteJournalStore(config.journalDbPath),
	});

	// FLY-245 F-b: the write-capable release gate (plan §7) — replaces the
	// FLY-224 unconditional fail-close. Every statically-checkable condition
	// must hold or this THROWS (same fail-closed semantics as before); the
	// runtime assertions below (MCP inventory ④, thread descriptor ⑤) close
	// the rest after spawn. Read-only companions skip all of it (byte-compat
	// modulo the Phase E env wash).
	// FLY-350: branch on PROFILE, not `sandboxMode !== read-only`. full-access shares
	// the workspace-write sandbox but takes a SEPARATE path — NO release gate / gateway
	// / broker / confinement; its control is the founder-gate rule bundle + branch
	// protection (plan §2.1/§3). Only the (Z) write-capable tier runs the §7 release.
	const fullAccess = config.codexProfile === "full-access";
	const writeCapable = !fullAccess && config.sandboxMode !== "read-only";
	const release = writeCapable ? assertWriteCapableRelease(config) : undefined;

	// ⑦ broker: action secrets live in THIS process's memory and travel only
	// over the unix socket the sandboxed model cannot connect() to (Phase E).
	const brokerSocketPath = join(config.stateDir, "broker.sock");
	const broker = release
		? new SecretBroker({
				socketPath: brokerSocketPath,
				secrets: {
					DISCORD_BOT_TOKEN: config.botToken,
					FLYWHEEL_API_TOKEN: config.apiToken,
					// FLY-350 (Z) unit 4: the fine-grained GH_TOKEN for gateway-proxied
					// git_push/open_pr — broker-served into the gateway child ONLY, never
					// the model shell. Omitted when unconfigured (git_push/open_pr then
					// fail closed at call time).
					...(config.githubToken ? { GITHUB_TOKEN: config.githubToken } : {}),
				},
			})
		: undefined;

	// ④ MCP allowlist: write-capable = EXACTLY the gateway (A2); read-only
	// companions keep the FLY-224 chrome-gated path byte-for-byte.
	const mcp = release
		? buildCodexLeadMcpArgv({
				chrome: config.chrome,
				gateway: {
					command: process.execPath,
					args: [release.gatewayEntry],
					envVarNames: [
						"HOME",
						"PATH",
						"FLYWHEEL_LEAD_ID",
						"FLYWHEEL_PROJECT_NAME",
						"FLYWHEEL_FOUNDER_DISCORD_USER_ID",
						"FLYWHEEL_GATEWAY_STATE_DIR",
						"FLYWHEEL_GATEWAY_BROKER_SOCKET",
						"FLYWHEEL_GATEWAY_CONFIRM_CHANNEL_ID",
						"FLYWHEEL_BRIDGE_URL",
						"FLYWHEEL_COMM_ROOT",
						// R2 HIGH-5: the model's canonical writable scratch — the gateway's
						// ship-preflight rejects a target worktree overlapping it. Without
						// forwarding this, the gateway built untrustedRoots=[] and silently
						// disabled the overlap check.
						"FLYWHEEL_CODEX_LEAD_WORKSPACE",
						// FLY-350 (Z) unit 3: discord_send alias coordinates (non-secret).
						// The gateway resolves "chat"/"roundtable" → channel id server-side.
						"FLYWHEEL_LEAD_CHAT_CHANNEL_ID",
						"FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS",
						"FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES",
						// FLY-350 (Z) unit 4: gateway-proxied PR scope (non-secret;
						// "owner/repo"). The GH_TOKEN itself travels over the broker, NOT
						// the env — so it is deliberately NOT listed here.
						"FLYWHEEL_GATEWAY_PROJECT_REPO",
					],
				},
			})
		: fullAccess
			? buildCodexLeadMcpArgv({
					chrome: config.chrome,
					// FLY-304: proactive discord_send for full-access (Claude-equal). The
					// Audited lead-actions MCP via the SHARED helper (so the dry-run report
					// cannot diverge). entry is existsSync-
					// validated here (fail-closed); the bot token is by NAME (env_vars) —
					// pinned into baseEnv below — never a literal. NO broker.
					leadActions: fullAccessLeadActionsMcpConfig(
						config,
						assertLeadActionsEntry(config.leadActionsEntry),
						config.replyInThread?.autoContinue === true,
					),
				})
			: buildCodexLeadMcpArgv({ chrome: config.chrome });
	for (const w of mcp.warnings) logger.warn(`MCP: ${w}`);
	// FLY-304 (codex review item 5 + R2#1): make roundtable availability visible at
	// boot. "roundtable" resolves when EXACTLY one cross-dept channel is configured,
	// OR when an explicit roundtable pin selects one of several (mirror the alias
	// resolver, so the log matches what the MCP child will actually authorize).
	if (fullAccess) {
		const ids = config.crossDeptChannelIds;
		const pin = config.leadActionsChannelAliases
			? parseExplicitAliases(config.leadActionsChannelAliases).roundtable
			: undefined;
		const rt =
			ids.length === 1
				? `available (${ids[0]})`
				: pin && ids.includes(pin)
					? `available (pinned ${pin})`
					: ids.length === 0
						? "UNAVAILABLE — set FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS to serve #leads-roundtable"
						: `ambiguous (${ids.length} cross-dept channels — pin one via FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES)`;
		logger.info(
			`lead-actions: proactive discord_send enabled (chat=${config.chatChannelId}; roundtable ${rt})`,
		);
	}

	// ③ + ⑧(static): confinement config + action-surface disable argv precede
	// the MCP overrides on the spawn command line (write-capable only). FLY-350
	// full-access prepends buildFullAccessArgv (net ON + project writable root) but
	// NO action-surface disable (a Claude-equal Lead keeps a normal agent surface).
	const spawnArgv = release
		? [
				...buildConfinementArgv(release.workspace),
				...buildActionSurfaceDisableArgv(),
				...mcp.argv,
			]
		: fullAccess
			? [
					...buildFullAccessArgv(config.fullAccessProjectRoot as string),
					...mcp.argv,
				]
			: mcp.argv;

	// The gateway child resolves these env var NAMES from the app-server env —
	// non-secret coordinates only (the wash strips anything secret-shaped).
	const gatewayEnv: NodeJS.ProcessEnv | undefined = release
		? {
				...process.env,
				FLYWHEEL_GATEWAY_STATE_DIR: config.stateDir,
				FLYWHEEL_GATEWAY_BROKER_SOCKET: brokerSocketPath,
				FLYWHEEL_GATEWAY_CONFIRM_CHANNEL_ID: release.gatewayConfirmChannelId,
				FLYWHEEL_FOUNDER_DISCORD_USER_ID: release.founderId,
				// R2 HIGH-5: pin the CANONICAL workspace (realpath'd at parse) — never
				// trust whatever raw value the ambient env happened to carry, so the
				// gateway's worktree-overlap check is always against the real scratch.
				FLYWHEEL_CODEX_LEAD_WORKSPACE: release.workspace,
				// FLY-350 (Z) unit 3: discord_send alias coordinates (non-secret) —
				// pin from the runtime config so the gateway's alias allowlist matches
				// the Lead's actual chat + cross-dept channels. An alias pin
				// (FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES), if set, passes through the
				// inherited process.env above.
				FLYWHEEL_LEAD_CHAT_CHANNEL_ID: config.chatChannelId,
				FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS:
					config.crossDeptChannelIds.join(","),
				// FLY-676: effective roundtable autoContinue (non-secret; runtime-computed).
				// Present only when ON → the gateway's discord_send fail-soft refuses a proactive
				// target="roundtable" while autoContinue is on (FLY-680 engage hook pending).
				...(config.replyInThread?.autoContinue
					? { FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE_EFFECTIVE: "1" }
					: {}),
				// FLY-350 (Z) unit 4: non-secret PR scope (owner/repo). The GH_TOKEN
				// travels over the broker, never the gateway child env.
				...(config.projectRepo
					? { FLYWHEEL_GATEWAY_PROJECT_REPO: config.projectRepo }
					: {}),
			}
		: undefined;

	const proc = new CodexLeadProcess({
		spawnChild: () => {
			const carrierInstanceId = randomBytes(32).toString("base64url");
			publishCarrierRuntimeAssertion({
				leadKey: config.leadKey,
				identityDigest: config.identityDigest,
				rawCarrierInstanceId: carrierInstanceId,
				pid: process.pid,
				lstart: getProcessStart(process.pid),
			});
			const transport = spawnCodexAppServer({
				codexBin: config.codexBin,
				mcpArgv: spawnArgv,
				codexHome: config.codexHome,
				carrierInstanceId,
				leadId: config.leadId,
				projectName: config.projectName,
				// FLY-350 full-access: the app-server child inherits the H-1 positive
				// env allowlist (Claude-pane mirror + gh auth) AS-IS — washSecrets:false
				// so its gh/Discord/Bridge auth survives. Every other path keeps the
				// unconditional action-secret wash (byte-compat).
				// FLY-304 (codex review item 3): pin DISCORD_BOT_TOKEN from the PARSED
				// config (not just the allowlist copy) so the lead_actions env_vars
				// by-name forward resolves even when config came from a different env
				// object (tests / embedded callers). Still by NAME → never in argv.
				...(fullAccess
					? {
							baseEnv: {
								...buildFullAccessEnv(process.env),
								DISCORD_BOT_TOKEN: config.botToken,
							},
							washSecrets: false,
						}
					: gatewayEnv
						? { baseEnv: gatewayEnv }
						: {}),
			});
			return transport;
		},
	});

	// ④ runtime half: collect MCP startup notifications; ensureThread blocks on
	// "exactly the gateway, ready" before any thread starts (fail-closed).
	const inventory = release ? new McpInventoryWatcher() : undefined;
	if (inventory) {
		proc.on("notification", (method, params) =>
			inventory.record(method, params),
		);
	}

	// Outbound: "direct" (default) posts to Discord with the Lead's own token — no
	// Bridge route / restart (low-risk first bring-up). "bridge" uses the durable
	// /api/lead-outbound/send exactly-once path (prod; needs the route deployed).
	const sender: OutboundSender =
		config.outboundMode === "bridge"
			? new CodexOutboundSender({
					bridgeUrl: config.bridgeUrl,
					apiToken: config.apiToken,
					projectName: config.projectName,
					channelId: config.chatChannelId,
					dbPath: config.outboxDbPath,
				})
			: new DirectDiscordOutboundSender({
					botToken: config.botToken,
					channelId: config.chatChannelId,
				});
	logger.info(`outbound mode: ${config.outboundMode}`);

	// Persona injection: concatenate identity/persona files → thread baseInstructions
	// (the Codex equivalent of claude-lead.sh's --append-system-prompt-file). Absent
	// → undefined → thread starts with no baseInstructions (byte-compat).
	const baseInstructions = readBaseInstructions(config.systemPromptFiles);
	if (baseInstructions) {
		logger.info(
			`persona: baseInstructions injected (${baseInstructions.length} chars from ${config.systemPromptFiles.length} file(s))`,
		);
	} else if (config.systemPromptFiles.length > 0) {
		// FAIL-CLOSED (FLY-224 review MEDIUM): persona files were EXPLICITLY configured
		// but none was readable/non-empty. A companion silently falling back to the
		// default engineering persona is worse than failing loudly at boot — surface
		// the misconfig. (No files configured → no persona → fine; byte-compat.)
		throw new Error(
			`persona: FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES set but no file was readable/non-empty: ${config.systemPromptFiles.join(", ")}`,
		);
	}
	// FOUNDER-GATE SAFETY (FLY-224 HIGH-1 → FLY-245 §7): the unconditional
	// write-capable fail-close is replaced by the 8-condition release gate
	// (`assertWriteCapableRelease`, evaluated ABOVE before any wiring). The model
	// still cannot self-authorize: confinement (③) blocks its shell's
	// network/socket actions, the gateway (④) is its only action channel, and
	// every reserved action there passes founder preflight/consent (C2/D).
	const threadParams = buildThreadParams(config, baseInstructions);

	const steps = {
		startProcess: async () => {
			// ⑦ the broker must be listening BEFORE the app-server (and so the
			// gateway child) comes up — the gateway fetches its secrets at startup.
			if (broker) await broker.listen();
			proc.start();
		},
		ensureThread: async (): Promise<string> => {
			const saved = readThreadId(config.threadIdPath);
			if (release && inventory) {
				// ④ runtime inventory: EXACTLY the gateway, ready — or fail-closed.
				await inventory.waitForExact(mcp.included, 30_000);
				// ⑧ runtime tool-surface assertion (Codex code-review R1 HIGH-1):
				// the model-callable tools advertised at startup must EQUAL the two
				// reserved gateway tools — an empty/unproven surface or any extra
				// connector/built-in egress tool fails the Lead closed BEFORE any
				// thread is usable. (The MCP inventory above already guarantees no
				// OTHER MCP server; this catches the tool granularity + non-MCP
				// built-ins the Phase F threat matrix pins.)
				assertGatewayOnlyToolSurface(inventory.observedTools());
				// ⑤ thread-descriptor hard assertion on START **and** RESUME
				// (R1#9): the echoed policy must equal the expected confinement;
				// any drift (net on, extra root, wrong cwd, unvetted cliVersion)
				// throws → the runtime exits fail-closed.
				const expectation = {
					workspace: release.workspace,
					cliVersionAllowlist: release.cliVersionAllowlist,
				};
				if (saved) {
					const { id, result } = await proc.resumeThreadWithResult(
						saved,
						threadParams,
					);
					assertConfinement(extractThreadDescriptor(result), expectation);
					return id;
				}
				const { id, result } = await proc.startThreadWithResult(threadParams);
				assertConfinement(extractThreadDescriptor(result), expectation);
				writeThreadId(config.threadIdPath, id);
				return id;
			}
			if (saved) {
				// Re-pass baseInstructions on resume so a persona edit takes effect on
				// restart (thread/resume accepts baseInstructions).
				await proc.resumeThread(saved, threadParams);
				return saved;
			}
			const id = await proc.startThread(threadParams);
			writeThreadId(config.threadIdPath, id);
			return id;
		},
		wire: async (threadId: string): Promise<RuntimeWiring> => {
			const externalReceiptQueue = new MailboxQueue(config.commDbPath);
			const externalReceiptSaga = new ExternalReceiptSaga({
				leadId: config.leadId,
				queue: externalReceiptQueue,
				journal,
			});
			const executor = new CodexTurnExecutor({ process: proc, threadId });
			// FLY-1806: Discord typing is fixed on. Posts with the Lead's own bot token
			// in the reply channel while a founder message is processed; closed on
			// stopGateway.
			const typing = config.typingEnabled
				? new DiscordTypingNotifier({
						botToken: config.botToken,
						defaultChannelId: config.chatChannelId,
					})
				: undefined;
			const source = new RestPollDiscordInboundSource({
				botToken: config.botToken,
				channelIds: config.channelIds,
				// Durable cursor: restart resumes instead of re-baselining (HIGH-4).
				cursorStore: new FileInboundCursorStore(config.inboundCursorPath),
			});
			// FLY-314 Phase 2: reply-in-thread wiring (default-OFF → undefined → FLY-267).
			const replyInThread = config.replyInThread
				? buildReplyInThreadWiring({
						cfg: config.replyInThread,
						botToken: config.botToken,
						botUserId: config.botUserId,
						crossDeptChannelIds: config.crossDeptChannelIds,
						source,
					})
				: undefined;
			const router = new LeadInputRouter({
				leadId: config.leadId,
				threadId,
				journal,
				executor,
				sender,
				onEntryCompleted: (entry) => {
					if (
						entry.source === "discord" &&
						(entry.replyChannelId || entry.replyRoute)
					) {
						externalReceiptSaga.handle(entry.idempotencyKey, entry.id);
					}
				},
				...(typing ? { typing } : {}),
				...(replyInThread
					? {
							ensureReplyRoute: replyInThread.ensureReplyRoute,
							onTopicEngaged: replyInThread.seedBudgetForRoute,
						}
					: {}),
			});
			const inboxServer = new CodexLeadInboxServer({
				socketPath: resolveCodexLeadInboxSocketPath(config.stateDir),
				leadId: config.leadId,
				router,
				authSecret: config.botToken,
			});
			// FLY-267 判 + 回: when cross-dept channels are configured, gate them on
			// mention AND route replies back to the source channel (chat/core stay
			// always-handled + reply in chat). No cross-dept → neither hook → byte-compat.
			const crossDeptSet = new Set(config.crossDeptChannelIds);
			// FLY-898: id-only gate the core room for a non-CoS lead (empty otherwise).
			const coreStrictChannelIds = resolveCoreStrictChannelIds(config);
			const shouldHandle =
				config.crossDeptChannelIds.length > 0 || coreStrictChannelIds.length > 0
					? buildMentionGate({
							botUserId: config.botUserId,
							sharedChannelIds: config.crossDeptChannelIds,
							// FLY-898: the core channel stays in baseChannels (still polled +
							// reply-routed to itself, no bridge-403); it is gated id-only here,
							// NOT added to crossDeptChannelIds (which would trigger the
							// bridge-mode 403 throw + roundtable reply-routing).
							coreStrictChannelIds,
							mentionPatterns: config.mentionPatterns,
							// FLY-314 Phase 2: topic threads are dynamic shared channels.
							...(replyInThread
								? {
										dynamicSharedChannels: replyInThread.registry,
										autoContinue: replyInThread.autoContinue,
										budgetStore: replyInThread.budgetStore,
										budgetN: replyInThread.budgetN,
									}
								: {}),
						})
					: undefined;
			const resolveReplyChannelId =
				config.crossDeptChannelIds.length > 0
					? (m: DiscordInboundMessage) =>
							crossDeptSet.has(m.channelId) ? m.channelId : undefined
					: undefined;
			const mailboxStrategy = new CodexDiscordMailboxStrategy({
				leadId: config.leadId,
				...(config.founderId ? { founderId: config.founderId } : {}),
				dbPath: config.commDbPath,
				queue: externalReceiptQueue,
				journal,
				router,
				externalReceiptSaga,
				mailboxReady: () => ownership?.mailboxReady() === true,
				logger,
			});
			const gateway = new CodexDiscordGateway({
				source,
				router,
				botUserId: config.botUserId,
				channelIds: config.channelIds,
				externalReceiptSaga,
				durableAccept: (input) => mailboxStrategy.accept(input),
				...(shouldHandle ? { shouldHandle } : {}),
				// FLY-314 Phase 2 ON → registry allowlist + structured route supersede
				// resolveReplyChannelId; OFF → FLY-267 source-channel routing.
				...(replyInThread
					? {
							registry: replyInThread.registry,
							resolveReplyRoute: replyInThread.resolveReplyRoute,
						}
					: resolveReplyChannelId
						? { resolveReplyChannelId }
						: {}),
			});
			const ownership = new CodexDiscordRuntimeOwnership({
				stateDir: config.stateDir,
				leadId: config.leadId,
				authSecret: config.botToken,
				server: inboxServer,
				gateway: {
					start: async () => {
						await gateway.start();
						try {
							await replyInThread?.start();
						} catch (error) {
							await gateway.stop();
							throw error;
						}
					},
					stop: async () => {
						try {
							await replyInThread?.stop();
						} finally {
							await gateway.stop();
						}
					},
				},
				logger,
			});
			return {
				recover: () => router.recover(),
				startGateway: async () => {
					externalReceiptSaga.reconcile({
						olderThan: new Date().toISOString(),
						// Without an authoritative Discord watermark, startup may repair
						// accepted rows but never guesses that a message is absent.
						absenceProvenThroughMessageId: "0",
					});
					// Open Bridge batch ingress after journal recovery and before Discord intake.
					// FLY-314 Phase 2 (Codex code review #1): START THE GATEWAY FIRST so
					// `source.onMessage(handler)` is installed BEFORE discovery's
					// `addChannel()` can drain a resumed thread — otherwise drained downtime
					// messages hit a missing handler (safe-to-advance) and are dropped while
					// the cursor advances past them.
					await ownership.start();
				},
				stopGateway: async () => {
					try {
						await ownership.stop();
					} finally {
						typing?.close();
						externalReceiptQueue.close();
					}
				},
			};
		},
		shutdownProcess: async () => {
			await proc.stop();
			await broker?.close();
		},
		logger,
	};

	// NOTE (FLY-245): the founder-gate enforcement primitives live in the GATEWAY
	// process (gateway-main.ts): CodexFounderPreflight (merge/ship, over the same
	// flywheel-comm `verifyApproval` as a Claude Lead) + verifyLifecycleConsent
	// behind the founder-confirmation edge (LifecycleOrchestrator). The runtime's
	// job here is confinement: the model's ONLY action channel is that gateway.

	return new CodexLeadRuntime(steps);
}

/** Redact a secret to its first 4 chars for the dry-run report. */
function redactSecret(s: string): string {
	if (!s) return "(unset)";
	return s.length <= 6 ? "****" : `${s.slice(0, 4)}…(${s.length} chars)`;
}

/**
 * Pre-flight DRY-RUN report (FLYWHEEL_LEAD_DRY_RUN=1): describe EXACTLY what would
 * start, with NO process spawned, NO Discord poll, NO Bridge connection, and NO
 * secret leaked. Returns the report lines for the operator to verify before the
 * real cutover.
 */
export function dryRunReport(config: CodexLeadRuntimeConfig): string[] {
	// FLY-304 (code-review R1#3): mirror the LIVE full-access MCP injection so the
	// preflight evidence (MCP injected / spawn cmd) actually shows `lead_actions` +
	// env_vars=["DISCORD_BOT_TOKEN"] — the token NAME only, never its value. Uses the
	// configured entry as-is (no existsSync throw — a dry-run describes, never aborts).
	const mcp =
		config.codexProfile === "full-access" && config.leadActionsEntry
			? buildCodexLeadMcpArgv({
					chrome: config.chrome,
					leadActions: fullAccessLeadActionsMcpConfig(
						config,
						config.leadActionsEntry,
						config.replyInThread?.autoContinue === true,
					),
				})
			: buildCodexLeadMcpArgv({ chrome: config.chrome });
	const noBridge = config.outboundMode === "direct";
	const persona = readBaseInstructions(config.systemPromptFiles);
	// FLY-350 (Z) L-1 (Codex review LOW): a write-capable Lead's dry-run must
	// surface the audited Z-mode fields — gateway injection + EXACT 5-tool surface,
	// net-off, the single writable root, the project repo, and the GH-token SOURCE
	// (redacted) — not the read-only MCP report. The values come from config; the
	// release gate + runtime assertions are what ENFORCE them (this is disclosure).
	// FLY-350: full-access is ALSO workspace-write but is NOT the (Z) gateway tier —
	// it gets a DIFFERENT disclosure (net ON, local gh/git, founder-gated merge).
	const fullAccess = config.codexProfile === "full-access";
	const writeCapableZ = config.sandboxMode === "workspace-write" && !fullAccess;
	const writeCapableLines = writeCapableZ
		? [
				`(Z) gateway   : flywheel_gateway MCP — tool surface = EXACTLY [${GATEWAY_ACTION_TOOL_NAMES.join(", ")}] (⑧ runtime assert)`,
				`(Z) network   : OFF (buildConfinementArgv network_access=false — shell cannot curl/push)`,
				`(Z) writable  : ${config.workspace ?? "(unset — release gate fail-closes)"} (ONLY writable root; net-off)`,
				`(Z) PR scope  : repo=${config.projectRepo ?? "(unset — release gate fail-closes)"} GH_TOKEN=${config.githubToken ? `${redactSecret(config.githubToken)} (broker-served to gateway ONLY; washed from model env)` : "(unset — git_push/open_pr fail-closed)"}`,
				`(Z) merge     : STRUCTURALLY impossible (no :cool:/merge tool, net-off shell, no shell token)`,
			]
		: [];
	const fullAccessLines = fullAccess
		? [
				`full-access   : ⚠️ = Claude-equal Lead (workspace-write + local gh/git; NO gateway/broker/release-gate)`,
				`network       : ON (sandbox_workspace_write.network_access=true — local gh/git/curl like a Claude pane)`,
				`writable      : ${config.fullAccessProjectRoot ?? "(unset — parse fail-loud)"} (cwd + ONLY writable root = the project checkout)`,
				`env (H-1)     : positive allowlist (Claude-pane mirror + gh auth) — NO extra *TOKEN*/*SECRET*/*KEY*`,
				`merge         : founder-gated by the founder-only-authority rule bundle + main branch protection (NOT structurally impossible — honest, = Claude Leads)`,
			]
		: [];
	return [
		"=== CODEX LEAD DRY RUN (nothing started) ===",
		`ROLE          : lead / companion-style (project ${config.projectName})`,
		`leadId        : ${config.leadId}`,
		`bot user id   : ${config.botUserId} (reused Discord bot — identity unchanged)`,
		`bot token     : ${redactSecret(config.botToken)} (redacted)`,
		`chat channel  : ${config.chatChannelId}${config.coreChannelId ? ` (+core ${config.coreChannelId})` : ""}`,
		// FLY-267: surface the cross-dept / shared-channel config so it is auditable
		// before a restart (which channels get mention-gated + reply-routed).
		`cross-dept    : ${config.crossDeptChannelIds.length ? `${config.crossDeptChannelIds.join(", ")} (mention-gated + reply-routed)` : "(none — single-channel byte-compat)"}`,
		`mention policy: ${config.crossDeptChannelIds.length ? (config.mentionPatterns.length ? `bot-id mention + name regex [${config.mentionPatterns.join(", ")}] (non-bot authors)` : "bot-id mention only") : "n/a (no shared channels)"}`,
		// FLY-898: surface whether this (non-CoS) lead's core room is id-only gated,
		// reflecting the EFFECTIVE decision (flag set AND core actually subscribed).
		`core mention gate: ${
			resolveCoreStrictChannelIds(config).length > 0
				? `on (${config.coreChannelId} — id-only: real @ or reply-to-self; bare name text ignored)`
				: "off (core always handled — CoS / core-less / core-no-CoS / gate flag unset)"
		}`,
		`inbound       : REST poll (own bot token) — no Bridge`,
		`outbound mode : ${config.outboundMode}${noBridge ? " → DIRECT post to Discord (own bot token), NO Bridge" : ` → Bridge ${config.bridgeUrl}`}`,
		// FLY-404: surface the typing indicator state so the operator can verify it
		// before the Mufasa flip (parity with the Claude Lead's "typing…").
		"typing        : ON (Discord typing… while processing — parity with Claude Lead)",
		`bridge env    : url=${config.bridgeUrl || "(unset — not needed in direct)"} apiToken=${config.apiToken ? redactSecret(config.apiToken) : "(unset — not needed in direct)"}`,
		`prod Bridge   : ${noBridge ? "NOT CONNECTED (zero prod intrusion)" : "WILL CONNECT (bridge mode)"}`,
		`persona       : ${persona ? `baseInstructions ${persona.length} chars from ${config.systemPromptFiles.length} file(s) → injected` : "(none — default Codex persona; set FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES)"}`,
		`policy        : approvalPolicy=never sandbox=${config.sandboxMode}${
			config.sandboxMode === "read-only"
				? " (companion — read+chat only, cannot act)"
				: fullAccess
					? " ⚠️ FULL-ACCESS (= Claude-equal; merge/ship founder-gated by rule bundle + branch protection)"
					: " ⚠️ WRITE-CAPABLE (FLY-245 founder gate: 8-condition release + runtime confinement assertions)"
		}`,
		...writeCapableLines,
		...fullAccessLines,
		`CODEX_HOME    : ${config.codexHome} (isolated per-Lead — not the host ~/.codex)`,
		`codex bin     : ${config.codexBin}`,
		`state dir     : ${config.stateDir}`,
		`  journal     : ${config.journalDbPath}`,
		`  thread-id   : ${config.threadIdPath}`,
		`MCP injected  : ${mcp.included.length ? mcp.included.join(", ") : "(none — Discord MCP never injected; chrome only if enabled)"}`,
		...mcp.warnings.map((w) => `MCP warning   : ${w}`),
		`spawn cmd     : CODEX_HOME=${config.codexHome} ${config.codexBin} app-server --strict-config ${mcp.argv.join(" ")}`.trim(),
		"=== END DRY RUN — no process spawned, no Discord/Bridge contacted ===",
	];
}

/** Process entrypoint. */
export async function main(
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const config = parseCodexLeadRuntimeConfig(env);

	// DRY RUN: print the plan and exit BEFORE constructing/spawning anything.
	if (env.FLYWHEEL_LEAD_DRY_RUN === "1") {
		for (const line of dryRunReport(config)) console.log(line);
		return;
	}

	const runtime = buildCodexLeadRuntime(config);
	const shutdown = (sig: NodeJS.Signals) => {
		console.warn(`[codex-lead-runtime] ${sig} → stopping`);
		runtime.stop().finally(() => process.exit(0));
	};
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
	await runtime.start();
	console.warn(
		`[codex-lead-runtime] ${config.leadId}@${config.projectName} started`,
	);
}

// Run when executed directly (codex-lead.sh execs the built file).
if (process.argv[1]?.includes("codex-lead-runtime")) {
	main().catch((err) => {
		console.error("[codex-lead-runtime] fatal:", err);
		process.exit(1);
	});
}
