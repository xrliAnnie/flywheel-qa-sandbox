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
import { assertGatewayOnlyToolSurface } from "./action-surface.js";
import { buildCodexLeadMcpArgv } from "./buildCodexLeadMcpArgv.js";
import {
	CodexDiscordGateway,
	type DiscordInboundMessage,
} from "./CodexDiscordGateway.js";
import { type ChildTransport, CodexLeadProcess } from "./CodexLeadProcess.js";
import { CodexLeadRuntime, type RuntimeWiring } from "./CodexLeadRuntime.js";
import { CodexOutboundSender } from "./CodexOutboundSender.js";
import { CodexTurnExecutor } from "./CodexTurnExecutor.js";
import { assertConfinement, extractThreadDescriptor } from "./confinement.js";
import { DirectDiscordOutboundSender } from "./DirectDiscordOutboundSender.js";
import { FileInboundCursorStore } from "./InboundCursorStore.js";
import { LeadHealthProbe } from "./LeadHealthProbe.js";
import type { OutboundSender } from "./LeadInputRouter.js";
import { LeadInputRouter } from "./LeadInputRouter.js";
import { LeadJournal } from "./LeadJournal.js";
import { McpInventoryWatcher } from "./mcp-inventory.js";
import { buildMentionGate } from "./mention-gate.js";
import { RestPollDiscordInboundSource } from "./RestPollDiscordInboundSource.js";
import { SqliteJournalStore } from "./SqliteJournalStore.js";
import { SecretBroker, washActionSecretEnv } from "./secret-broker.js";

export interface CodexLeadRuntimeConfig {
	projectName: string;
	leadId: string;
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
	bridgeUrl: string;
	apiToken: string;
	stateDir: string;
	journalDbPath: string;
	outboxDbPath: string;
	threadIdPath: string;
	/** Durable inbound-poll cursor (FLY-224 review HIGH-4): restart resumes from the
	 * persisted last-seen Discord msg id instead of re-baselining (no downtime loss). */
	inboundCursorPath: string;
	codexBin: string;
	codexHome: string;
	chrome?: { enabled: boolean; browserUrl?: string };
	/** Outbound path: "direct" posts to Discord with the Lead's own token (no Bridge
	 * restart — low-risk first test); "bridge" uses /api/lead-outbound/send (prod
	 * exactly-once). Default "direct". */
	outboundMode: "direct" | "bridge";
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
}

/** Codex app-server sandbox modes (schema `SandboxMode`). */
export type CodexSandboxMode =
	| "read-only"
	| "workspace-write"
	| "danger-full-access";

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

	const leadId = req("FLYWHEEL_LEAD_ID");
	const projectName = req("FLYWHEEL_PROJECT_NAME");
	const botUserId = req("FLYWHEEL_LEAD_BOT_USER_ID");
	const botToken = req("DISCORD_BOT_TOKEN");
	const chatChannelId = req("FLYWHEEL_LEAD_CHAT_CHANNEL_ID");
	const stateDir = req("FLYWHEEL_CODEX_LEAD_STATE_DIR");
	const codexBin = req("FLYWHEEL_CODEX_BIN");
	const codexHome = req("CODEX_HOME");
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
	const chromeEnabled = env.FLYWHEEL_LEAD_CHROME_ENABLED === "1";
	const chrome = chromeEnabled
		? { enabled: true, browserUrl: env.FLYWHEEL_LEAD_CHROME_URL?.trim() }
		: undefined;
	// Persona/identity files → baseInstructions (comma-separated paths; missing skipped).
	const systemPromptFiles = (env.FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
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

	// FLY-245 Phase A: for a write-capable sandbox, resolve + validate the Lead
	// scratch workspace when configured. Purely additive — when unset, `workspace`
	// stays undefined and the write-capable release gate (buildCodexLeadRuntime →
	// assertWriteCapableRelease) fail-closes.
	let workspace: string | undefined;
	let founderId: string | undefined;
	let cliVersionAllowlist: string[] | undefined;
	let gatewayEntry: string | undefined;
	let gatewayConfirmChannelId: string | undefined;
	if (sandboxMode !== "read-only") {
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
	}

	return {
		projectName,
		leadId,
		botUserId,
		botToken,
		chatChannelId,
		coreChannelId,
		channelIds,
		crossDeptChannelIds,
		mentionPatterns,
		bridgeUrl,
		apiToken,
		stateDir,
		journalDbPath: join(stateDir, "journal.db"),
		outboxDbPath: join(stateDir, "outbox.db"),
		threadIdPath: join(stateDir, "thread-id"),
		inboundCursorPath: join(stateDir, "inbound-cursor.json"),
		codexBin,
		codexHome,
		chrome,
		outboundMode,
		systemPromptFiles,
		sandboxMode,
		workspace,
		founderId,
		cliVersionAllowlist,
		gatewayEntry,
		gatewayConfirmChannelId,
	};
}

/** The deployed gateway MCP entry next to this module (dist layout). Overridable
 * via FLYWHEEL_GATEWAY_ENTRY (tests / non-standard deploys). */
function defaultGatewayEntryPath(): string {
	return fileURLToPath(new URL("./gateway/gateway-main.js", import.meta.url));
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
	config: Pick<CodexLeadRuntimeConfig, "sandboxMode" | "workspace">,
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
	if (config.workspace) params.cwd = config.workspace;
	if (baseInstructions) params.baseInstructions = baseInstructions;
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
}): ChildTransport {
	const args = ["app-server", "--strict-config", ...cfg.mcpArgv];
	const child = spawn(cfg.codexBin, args, {
		env: {
			...washActionSecretEnv(cfg.baseEnv ?? process.env),
			CODEX_HOME: cfg.codexHome,
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
	const writeCapable = config.sandboxMode !== "read-only";
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
					],
				},
			})
		: buildCodexLeadMcpArgv({ chrome: config.chrome });
	for (const w of mcp.warnings) logger.warn(`MCP: ${w}`);

	// ③ + ⑧(static): confinement config + action-surface disable argv precede
	// the MCP overrides on the spawn command line (write-capable only).
	const spawnArgv = release
		? [
				...buildConfinementArgv(release.workspace),
				...buildActionSurfaceDisableArgv(),
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
			}
		: undefined;

	const proc = new CodexLeadProcess({
		spawnChild: () =>
			spawnCodexAppServer({
				codexBin: config.codexBin,
				mcpArgv: spawnArgv,
				codexHome: config.codexHome,
				...(gatewayEnv ? { baseEnv: gatewayEnv } : {}),
			}),
	});

	// ④ runtime half: collect MCP startup notifications; ensureThread blocks on
	// "exactly the gateway, ready" before any thread starts (fail-closed).
	const inventory = release ? new McpInventoryWatcher() : undefined;
	if (inventory) {
		proc.on("notification", (method, params) =>
			inventory.record(method, params),
		);
	}

	// Liveness + activity signals for the health probe.
	let alive = true;
	let lastActivityAt: number | undefined;
	proc.on("exit", () => {
		alive = false;
	});
	proc.on("notification", () => {
		lastActivityAt = Date.now();
	});

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

	const health = new LeadHealthProbe({
		processAlive: () => alive,
		lastActivityAt: () => lastActivityAt,
		journal: { listUnfinished: () => journal.listUnfinished() },
	});

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
			const executor = new CodexTurnExecutor({ process: proc, threadId });
			const router = new LeadInputRouter({
				leadId: config.leadId,
				threadId,
				journal,
				executor,
				sender,
			});
			const source = new RestPollDiscordInboundSource({
				botToken: config.botToken,
				channelIds: config.channelIds,
				// Durable cursor: restart resumes instead of re-baselining (HIGH-4).
				cursorStore: new FileInboundCursorStore(config.inboundCursorPath),
			});
			// FLY-267 判 + 回: when cross-dept channels are configured, gate them on
			// mention AND route replies back to the source channel (chat/core stay
			// always-handled + reply in chat). No cross-dept → neither hook → byte-compat.
			const crossDeptSet = new Set(config.crossDeptChannelIds);
			const shouldHandle =
				config.crossDeptChannelIds.length > 0
					? buildMentionGate({
							botUserId: config.botUserId,
							sharedChannelIds: config.crossDeptChannelIds,
							mentionPatterns: config.mentionPatterns,
						})
					: undefined;
			const resolveReplyChannelId =
				config.crossDeptChannelIds.length > 0
					? (m: DiscordInboundMessage) =>
							crossDeptSet.has(m.channelId) ? m.channelId : undefined
					: undefined;
			const gateway = new CodexDiscordGateway({
				source,
				router,
				botUserId: config.botUserId,
				channelIds: config.channelIds,
				...(shouldHandle ? { shouldHandle } : {}),
				...(resolveReplyChannelId ? { resolveReplyChannelId } : {}),
			});
			return {
				recover: () => router.recover(),
				startGateway: () => gateway.start(),
				stopGateway: () => gateway.stop(),
			};
		},
		shutdownProcess: async () => {
			await proc.stop();
			await broker?.close();
		},
		healthProbe: () => health.probe(),
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
	const mcp = buildCodexLeadMcpArgv({ chrome: config.chrome });
	const noBridge = config.outboundMode === "direct";
	const persona = readBaseInstructions(config.systemPromptFiles);
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
		`inbound       : REST poll (own bot token) — no Bridge`,
		`outbound mode : ${config.outboundMode}${noBridge ? " → DIRECT post to Discord (own bot token), NO Bridge" : ` → Bridge ${config.bridgeUrl}`}`,
		`bridge env    : url=${config.bridgeUrl || "(unset — not needed in direct)"} apiToken=${config.apiToken ? redactSecret(config.apiToken) : "(unset — not needed in direct)"}`,
		`prod Bridge   : ${noBridge ? "NOT CONNECTED (zero prod intrusion)" : "WILL CONNECT (bridge mode)"}`,
		`persona       : ${persona ? `baseInstructions ${persona.length} chars from ${config.systemPromptFiles.length} file(s) → injected` : "(none — default Codex persona; set FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES)"}`,
		`policy        : approvalPolicy=never sandbox=${config.sandboxMode}${config.sandboxMode === "read-only" ? " (companion — read+chat only, cannot act)" : " ⚠️ WRITE-CAPABLE (FLY-245 founder gate: 8-condition release + runtime confinement assertions)"}`,
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
