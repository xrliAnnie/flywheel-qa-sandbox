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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildCodexLeadMcpArgv } from "./buildCodexLeadMcpArgv.js";
import { CodexDiscordGateway } from "./CodexDiscordGateway.js";
import { type ChildTransport, CodexLeadProcess } from "./CodexLeadProcess.js";
import { CodexLeadRuntime, type RuntimeWiring } from "./CodexLeadRuntime.js";
import { CodexOutboundSender } from "./CodexOutboundSender.js";
import { CodexTurnExecutor } from "./CodexTurnExecutor.js";
import { DirectDiscordOutboundSender } from "./DirectDiscordOutboundSender.js";
import { FileInboundCursorStore } from "./InboundCursorStore.js";
import { LeadHealthProbe } from "./LeadHealthProbe.js";
import type { OutboundSender } from "./LeadInputRouter.js";
import { LeadInputRouter } from "./LeadInputRouter.js";
import { LeadJournal } from "./LeadJournal.js";
import { RestPollDiscordInboundSource } from "./RestPollDiscordInboundSource.js";
import { SqliteJournalStore } from "./SqliteJournalStore.js";

export interface CodexLeadRuntimeConfig {
	projectName: string;
	leadId: string;
	botUserId: string;
	botToken: string;
	chatChannelId: string;
	coreChannelId?: string;
	channelIds: string[];
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
}

/** Codex app-server sandbox modes (schema `SandboxMode`). */
export type CodexSandboxMode =
	| "read-only"
	| "workspace-write"
	| "danger-full-access";

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
	const channelIds = [chatChannelId, ...(coreChannelId ? [coreChannelId] : [])];
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

	return {
		projectName,
		leadId,
		botUserId,
		botToken,
		chatChannelId,
		coreChannelId,
		channelIds,
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
	};
}

/** Build the `thread/start`|`thread/resume` params: the PINNED app-server policy
 * (FLY-224 review HIGH-1 / Phase 0A §) — `approvalPolicy="never"` (a headless
 * app-server can't service interactive approvals) + the configured `sandbox` — plus
 * the persona `baseInstructions` when present. Always returns an object (the policy
 * is always pinned), so the thread never starts with the app-server's permissive
 * defaults. */
export function buildThreadParams(
	config: Pick<CodexLeadRuntimeConfig, "sandboxMode">,
	baseInstructions: string | undefined,
): Record<string, unknown> {
	const params: Record<string, unknown> = {
		approvalPolicy: "never",
		sandbox: config.sandboxMode,
	};
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

/** Real ChildTransport over `codex app-server --strict-config -c …`. */
export function spawnCodexAppServer(cfg: {
	codexBin: string;
	mcpArgv: string[];
	codexHome: string;
	baseEnv?: NodeJS.ProcessEnv;
}): ChildTransport {
	const args = ["app-server", "--strict-config", ...cfg.mcpArgv];
	const child = spawn(cfg.codexBin, args, {
		env: { ...(cfg.baseEnv ?? process.env), CODEX_HOME: cfg.codexHome },
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
	const mcp = buildCodexLeadMcpArgv({ chrome: config.chrome });
	for (const w of mcp.warnings) logger.warn(`MCP: ${w}`);

	const proc = new CodexLeadProcess({
		spawnChild: () =>
			spawnCodexAppServer({
				codexBin: config.codexBin,
				mcpArgv: mcp.argv,
				codexHome: config.codexHome,
			}),
	});

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
	// FOUNDER-GATE SAFETY (FLY-224 review HIGH-1 / FLY-245): a write-capable sandbox
	// would let the model run reserved actions (e.g. `gh pr merge`) in its OWN shell,
	// bypassing the Bridge founder gate. The client-side enforcement primitive
	// (CodexFounderPreflight) MUST be wired into such an action path first — that path
	// is NOT built yet. Fail-closed: refuse to start a write-capable Codex Lead until
	// then. A read-only companion has no reserved-action path and is safe.
	if (config.sandboxMode !== "read-only") {
		throw new Error(
			`codex-lead-runtime: sandbox="${config.sandboxMode}" is write-capable, but the founder-gated action path for a Codex Lead is not implemented yet (FLY-245). Refusing to start — set FLYWHEEL_CODEX_LEAD_SANDBOX=read-only (companion) until then.`,
		);
	}
	const threadParams = buildThreadParams(config, baseInstructions);

	const health = new LeadHealthProbe({
		processAlive: () => alive,
		lastActivityAt: () => lastActivityAt,
		journal: { listUnfinished: () => journal.listUnfinished() },
	});

	const steps = {
		startProcess: () => proc.start(),
		ensureThread: async (): Promise<string> => {
			const saved = readThreadId(config.threadIdPath);
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
			const gateway = new CodexDiscordGateway({
				source,
				router,
				botUserId: config.botUserId,
				channelIds: config.channelIds,
			});
			return {
				recover: () => router.recover(),
				startGateway: () => gateway.start(),
				stopGateway: () => gateway.stop(),
			};
		},
		shutdownProcess: () => proc.stop(),
		healthProbe: () => health.probe(),
		logger,
	};

	// NOTE (FLY-245): the founder-gate enforcement primitive is `CodexFounderPreflight`
	// (a read-only, fail-closed consumer of the same flywheel-comm `verifyApproval` as
	// a Claude Lead). A read-only COMPANION has no merge/ship/runner-lifecycle action
	// path, so there is nothing to gate here (the write-capable guard above fail-closes
	// any Codex Lead that COULD act). When a write-capable Codex Lead role is added, its
	// action path MUST construct + call CodexFounderPreflight.check() before each
	// reserved action — it is intentionally NOT constructed-then-discarded here.

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
		`inbound       : REST poll (own bot token) — no Bridge`,
		`outbound mode : ${config.outboundMode}${noBridge ? " → DIRECT post to Discord (own bot token), NO Bridge" : ` → Bridge ${config.bridgeUrl}`}`,
		`bridge env    : url=${config.bridgeUrl || "(unset — not needed in direct)"} apiToken=${config.apiToken ? redactSecret(config.apiToken) : "(unset — not needed in direct)"}`,
		`prod Bridge   : ${noBridge ? "NOT CONNECTED (zero prod intrusion)" : "WILL CONNECT (bridge mode)"}`,
		`persona       : ${persona ? `baseInstructions ${persona.length} chars from ${config.systemPromptFiles.length} file(s) → injected` : "(none — default Codex persona; set FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES)"}`,
		`policy        : approvalPolicy=never sandbox=${config.sandboxMode}${config.sandboxMode === "read-only" ? " (companion — read+chat only, cannot act)" : " ⚠️ WRITE-CAPABLE (refused at start — FLY-245)"}`,
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
