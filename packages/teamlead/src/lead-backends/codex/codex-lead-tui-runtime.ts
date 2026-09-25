import {
	buildLeadModelEnv,
	type LeadModelEnvPins,
} from "../../lead-capabilities/model-env.js";
import type { LeadCapabilityParent } from "../../lead-capabilities/runtime-parent.js";
import { captureLeadRuntimeBuild } from "../../lead-runtime-build.js";
import { readLeadRuntimeTuning } from "../../lead-runtime-tuning.js";
import { verifyLeadCapabilityReadiness } from "./capability-readiness.js";
import { createCapabilityTuiRuntime } from "./capability-tui-runtime.js";
import {
	admitLeadTurn,
	type LeadTurnConfigAdmission,
} from "./LeadRuntimeConfigHost.js";
import { McpInventoryWatcher } from "./mcp-inventory.js";
import { NativeLeadRuntimeConfig } from "./NativeLeadRuntimeConfig.js";
import { resolveRunnerActionMcpContext } from "./runner-action-mcp.js";
/**
 * FLY-259 PR-D — codex-lead-tui-runtime: the ③ (real interactive terminal)
 * entrypoint. One shared `codex remote-control` daemon; this sidecar is the
 * machine client (Discord in/out via the FLY-224 component originals over
 * WsTransport), the founder's TUI (`codex resume --remote`, PR-C window) is
 * the human client of the SAME thread.
 *
 * Assembly map (plan v1.44.0 §3, all review-pinned):
 *   - transport: connectDaemonWs → WsTransport → CodexLeadProcess (R4 HIGH-1);
 *   - lifecycle: DaemonConnectionSupervisor generations (R5 HIGH-2 fencing);
 *   - event routing: TurnDemux between the raw process and the executor —
 *     `wireDemuxedProcess` builds the facade (R4 HIGH-2 + R5 HIGH-1 +
 *     poisoned-claim R2 MED-3 → ambiguous);
 *   - founder-terminal turns: observe-only TERMINAL journal rows (D5);
 *   - pins: thread params re-pin on every resume (FLY-224 HIGH-1 original) +
 *     config.toml + TUI command line (R4 HIGH-4 multi-pin);
 *   - TUI window: ensured AFTER the thread id is known (PR-C module).
 *
 * Like FLY-224's codex-lead-runtime: the pure/IO-thin pieces are unit-tested
 * (wireDemuxedProcess here; demux/supervisor/transport in their own files);
 * `buildTuiGeneration`/`main` are assembly glue validated by the real-machine
 * bring-up.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { withSyncOpMarker } from "flywheel-claude-runner";
import {
	getProcessStart,
	publishCarrierRuntimeAssertion,
} from "flywheel-comm/lead-lease";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import {
	canonicalSubmissionDigest,
	resolvePersonaStateRoot,
} from "flywheel-config";
import { storeCodexLeadThreadRotationEnabled } from "../../bridge/flag-store-runtime.js";
import { loadProjects, type ProjectEntry } from "../../ProjectConfig.js";
import { findResidentCodexLeadTargets } from "../../resident-codex-lead-roster.js";
import { StateStore } from "../../StateStore.js";
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
import { CodexLeadProcess, CodexLeadProcessError } from "./CodexLeadProcess.js";
import { CodexLeadRuntime, type RuntimeWiring } from "./CodexLeadRuntime.js";
import { CodexOutboundSender } from "./CodexOutboundSender.js";
import type { CodexProcessLike } from "./CodexTurnExecutor.js";
import { CodexTurnExecutor } from "./CodexTurnExecutor.js";
import {
	buildFullAccessEnv,
	buildThreadParams,
	type CodexLeadProfile,
	type CodexLeadRuntimeConfig,
	dryRunReport,
	parseCodexLeadRuntimeConfig,
	readBaseInstructions,
	resolveCoreStrictChannelIds,
	writeThreadId,
} from "./codex-lead-runtime.js";
import {
	appendRotationReceipt,
	boundedTurnsList,
	readLatestTurn,
	FENCE_IDLE_WAIT_MS,
	isRotationDue,
	ROTATION_CHECK_INTERVAL_MS,
	ROTATION_READY_TIMEOUT_MS,
	type RotationLedger,
	readRotationLedger,
	readThreadIdStrict,
	reconcileRotationLedger,
	rolloutTimestampFor,
	rotationDeveloperNote,
	THREAD_ID_RE,
	writeRotationLedger,
} from "./codex-lead-thread-rotation.js";
import { recordContextUsage } from "./context-usage-recorder.js";
import { DaemonConnectionSupervisor } from "./DaemonConnectionSupervisor.js";
import { DirectDiscordOutboundSender } from "./DirectDiscordOutboundSender.js";
import { DiscordTypingNotifier } from "./DiscordTypingNotifier.js";
import { connectDaemonWs } from "./daemon-ws.js";
import { ExternalReceiptSaga } from "./ExternalReceiptSaga.js";
import { FileInboundCursorStore } from "./InboundCursorStore.js";
import type { OutboundSender } from "./LeadInputRouter.js";
import { LeadInputRouter } from "./LeadInputRouter.js";
import { LeadJournal } from "./LeadJournal.js";
import {
	LeadTurnStateTracker,
	seedTurnStateWithRetry,
} from "./LeadTurnStateTracker.js";
import { tryResolveLeadAttachmentContext } from "./lead-actions/attachment-context.js";
import {
	assertFullAccessLeadActionsConfigGate,
	assertFullAccessSandboxConfig,
	buildFullAccessLeadActionsMcpServerConfig,
} from "./lead-actions/mcp-config.js";
import { buildMentionGate } from "./mention-gate.js";
import { runOutboundPreflight } from "./outbound-preflight.js";
import {
	type PersonaColdProof,
	type VerifiedPersona,
	verifyPersonaColdProof,
	verifyPersonaStartup,
	writePersonaObservationReceipt,
} from "./persona-startup-gate.js";
import { RestPollDiscordInboundSource } from "./RestPollDiscordInboundSource.js";
import { ResidentCodexLeadLifecycleObserver } from "./resident-codex-lead-lifecycle.js";
import { buildReplyInThreadWiring } from "./roundtable-reply-in-thread-wiring.js";
import { SqliteJournalStore } from "./SqliteJournalStore.js";
import { extractTurnId, TurnDemux } from "./TurnDemux.js";
import {
	beginTuiWindowVisibilityProof,
	ensureTuiWindow,
	isTuiWindowAlive,
	killTuiWindow,
	readTuiWindowExitEvidenceAsync,
	readTuiWindowIdentity,
	SAFE_ID,
	type TuiWindowIdentity,
	TuiWindowRetryBackoff,
	type TuiWindowSpec,
} from "./tui-window.js";
import { createTuiWindowAlertGuard } from "./tui-window-alert.js";
import { WsTransport } from "./WsTransport.js";

const execFileP = promisify(execFile);

/** How often the generation re-checks the founder's TUI window and re-creates
 * it if it died (review HIGH-1). Coarse on purpose — it only acts on a confirmed
 * dead pane, so a healthy session is untouched between ticks. */
const TUI_LIVENESS_INTERVAL_MS = 20_000;

// ── config ─────────────────────────────────────────────────────────────────

const runtimeBuildIdentity = captureLeadRuntimeBuild();

export interface CodexLeadTuiRuntimeConfig extends CodexLeadRuntimeConfig {
	/** Working directory for the founder's TUI (`-C`). */
	tuiCwd: string;
	flagStoreDbPath: string;
	/** Runtime-only generation capability; absent while parsing/dry-running. */
	carrierInstanceId?: string;
}

export function parseCodexLeadTuiRuntimeConfig(
	env: NodeJS.ProcessEnv,
): CodexLeadTuiRuntimeConfig {
	const base = parseCodexLeadRuntimeConfig(env);
	const tuiCwd = env.FLYWHEEL_CODEX_TUI_CWD?.trim();
	if (!tuiCwd) {
		throw new Error(
			"codex-lead-tui-runtime: missing required env: FLYWHEEL_CODEX_TUI_CWD",
		);
	}
	if (
		base.capabilityBundleVersion === 2 &&
		tuiCwd !== base.fullAccessProjectRoot
	)
		throw new Error("capability_tui_cwd_mismatch");
	return {
		...base,
		tuiCwd,
		flagStoreDbPath:
			env.TEAMLEAD_DB_PATH ?? join(homedir(), ".flywheel", "teamlead.db"),
	};
}

export function createResidentCodexLeadLifecycleForGeneration(opts: {
	config: CodexLeadTuiRuntimeConfig;
	projects: ReadonlyArray<ProjectEntry>;
	threadId: string;
	generationId: string;
	processPid?: number;
	log?: (message: string) => void;
}): ResidentCodexLeadLifecycleObserver | null {
	const { config } = opts;
	const target = findResidentCodexLeadTargets(opts.projects).find(
		(candidate) =>
			candidate.projectName === config.projectName &&
			candidate.leadId === config.leadId &&
			candidate.leadKey === config.leadKey,
	);
	if (!target || !config.carrierInstanceId) return null;
	return new ResidentCodexLeadLifecycleObserver({
		stateDir: config.stateDir,
		threadId: opts.threadId,
		generationId: opts.generationId,
		processPid: opts.processPid ?? process.pid,
		carrierInstanceId: config.carrierInstanceId,
		log: opts.log,
	});
}

export function loadResidentCodexLeadProjectsSafely(
	options: {
		load?: () => ProjectEntry[];
		log?: (message: string) => void;
	} = {},
): ProjectEntry[] {
	try {
		return (options.load ?? loadProjects)();
	} catch {
		options.log?.(
			"resident Codex Lead residency roster unavailable; lifecycle observer and pane-loss guard disabled",
		);
		return [];
	}
}

/**
 * FLY-398 — the env a TUI daemon (`codex remote-control`) is started with, by tier.
 * Extracted + exported so the runtime→home-script daemon-env boundary is unit-tested
 * (Codex R1 HIGH-1: a direct shell test that pre-sets the profile would NOT have caught
 * that the runtime path drops it).
 *
 *   - full-access (= Claude-equal) → the H-1 POSITIVE allowlist (`buildFullAccessEnv`,
 *     Claude-pane mirror + gh auth) + the bot token for standard Discord inbound;
 *     lead_actions receives only Bridge credentials by name. The daemon-control pin
 *     remains `FLYWHEEL_CODEX_LEAD_PROFILE=full-access`.
 *     The pin is CRITICAL: `buildFullAccessEnv` strips the profile (not in the
 *     allowlist), so without re-pinning it the home script's `ensure_daemon` would
 *     NOT do stop-before-start and a stale
 *     read-only daemon could survive the flip (pin ⑤ — Codex R1 HIGH-1). Non-secret.
 *     The governed alert route reuses that same generic bot-token name, so no
 *     additional secret crosses the runtime→home boundary.
 *   - companion → raw env (byte-compat; no action secrets in play).
 *
 * Every branch sets `FLYWHEEL_CODEX_TUI_HOME` (the home script reads it for CODEX_HOME).
 */
export function buildTuiDaemonEnv(opts: {
	profile: CodexLeadProfile;
	env: NodeJS.ProcessEnv;
	codexHome: string;
	botToken: string;
	bridgeUrl?: string;
	apiToken?: string;
	outboundMode?: "direct" | "bridge";
	carrierInstanceId?: string;
	leadId?: string;
	projectName?: string;
	/** Trusted parent pins only; never inferred from a model-provided env marker. */
	capabilityModelEnv?: LeadModelEnvPins;
	/** Set only after the exact Raya opt-in startup gate succeeds. */
	personaColdRequired?: boolean;
	personaGenerationId?: string;
}): NodeJS.ProcessEnv {
	const { profile, codexHome, botToken } = opts;
	const env = { ...opts.env };
	delete env.FLYWHEEL_RAYA_PERSONA_COLD_REQUIRED;
	delete env.FLYWHEEL_RAYA_PERSONA_GENERATION_ID;
	if (opts.personaColdRequired) {
		if (
			profile !== "full-access" ||
			!/^[a-f0-9]{32}$/.test(opts.personaGenerationId ?? "")
		) {
			throw new Error(
				"persona cold daemon generation requires full-access and a valid generation id",
			);
		}
	}
	if (opts.capabilityModelEnv) {
		if (profile !== "full-access")
			throw new Error("capability model env requires full-access profile");
		return buildLeadModelEnv(env, opts.capabilityModelEnv);
	}
	const carrierEnv = opts.carrierInstanceId
		? {
				FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: opts.carrierInstanceId,
				...(opts.leadId ? { FLYWHEEL_LEAD_ID: opts.leadId } : {}),
				...(opts.projectName
					? { FLYWHEEL_PROJECT_NAME: opts.projectName }
					: {}),
			}
		: {};
	if (profile === "full-access") {
		const outboundMode =
			opts.outboundMode ??
			(env.FLYWHEEL_CODEX_LEAD_OUTBOUND === "bridge" ? "bridge" : "direct");
		const alertChannel = env.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID?.trim();
		const bridgeUrl =
			opts.bridgeUrl?.trim() ||
			env.BRIDGE_URL?.trim() ||
			env.FLYWHEEL_BRIDGE_URL?.trim();
		const apiToken =
			opts.apiToken?.trim() ||
			env.TEAMLEAD_API_TOKEN?.trim() ||
			env.FLYWHEEL_API_TOKEN?.trim();
		return {
			...buildFullAccessEnv(env),
			...resolveRunnerActionMcpContext(env)?.env,
			...(bridgeUrl ? { BRIDGE_URL: bridgeUrl } : {}),
			...(apiToken ? { TEAMLEAD_API_TOKEN: apiToken } : {}),
			...(alertChannel
				? {
						FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID: alertChannel,
						FLYWHEEL_ALERT_SENDER_TOKEN_ENV: "DISCORD_BOT_TOKEN",
					}
				: {}),
			DISCORD_BOT_TOKEN: botToken,
			FLYWHEEL_CODEX_TUI_HOME: codexHome,
			FLYWHEEL_CODEX_LEAD_OUTBOUND: outboundMode,
			// Re-pin the daemon-control flags buildFullAccessEnv strips, so the home
			// script's ensure-daemon does stop-before-start (no stale read-only daemon
			// survives the flip — Codex R1 HIGH-1). Non-secret.
			FLYWHEEL_CODEX_LEAD_PROFILE: "full-access",
			...(opts.personaColdRequired
				? {
						FLYWHEEL_RAYA_PERSONA_COLD_REQUIRED: "1",
						FLYWHEEL_RAYA_PERSONA_GENERATION_ID: opts.personaGenerationId!,
					}
				: {}),
			...carrierEnv,
		};
	}
	return { ...env, FLYWHEEL_CODEX_TUI_HOME: codexHome, ...carrierEnv };
}

export function reportSuccessfulDaemonEnsure(
	stderr: string | Buffer,
	log: (message: string) => void,
): void {
	const output = String(stderr).trimEnd();
	if (output) log(output);
}

// ── demuxed process facade (pure glue — unit-tested) ───────────────────────

export interface DemuxedWiring {
	/** What the executor consumes (only sidecar-claimed turn events arrive). */
	facade: CodexProcessLike;
	/** Single entry the raw process events must be fed into. */
	demux: TurnDemux;
	/**
	 * Await the completion of ONE specific (already-claimed) turn, used by the
	 * bootstrap turn (review HIGH-2). Resolves `"completed"` when that turn's
	 * `turn/completed` arrives, or `"timeout"` after `timeoutMs` — and on timeout
	 * it `releaseTurn`s the id so the demux tombstones any late stragglers
	 * (otherwise a slow bootstrap delta could cross-talk into the next machine
	 * turn once the gateway starts). The internal listener is always removed.
	 */
	awaitTurnCompletion: (
		turnId: string,
		timeoutMs: number,
	) => Promise<"completed" | "timeout">;
}

/**
 * Wire a TurnDemux between a raw process and the executor surface:
 *   raw notifications/turnCompleted → demux.route → (registered) executor
 *   sinks / (foreign) founder observer / (no id) activity only.
 * `startTurn` runs the pending-dispatch handshake; a poisoned claim (overflow,
 * R2 MED-3) throws → the router's existing ambiguous path takes over.
 * Completed sidecar turns are released (bounded registry + tombstones).
 */
export function wireDemuxedProcess(args: {
	beforeTurn?: () => Promise<LeadTurnConfigAdmission>;
	proc: CodexLeadProcess;
	onFounderTurnStarted?: (turnId: string) => void;
	onFounderTurnCompleted: (turnId: string) => void;
	onTokenUsage?: (params: unknown) => void;
	onActivity?: () => void;
	log?: (m: string) => void;
	/** FLY-2882: turn lifecycle feed for the read-only turn-state snapshot. */
	turnState?: Pick<LeadTurnStateTracker, "onTurnStarted" | "onTurnCompleted">;
}): DemuxedWiring {
	const listeners = {
		notification: [] as Array<(method: string, params: unknown) => void>,
		turnCompleted: [] as Array<(params: unknown) => void>,
	};
	// Bounded record of recently-completed turn ids (review R2 HIGH-1): a turn can
	// complete DURING claim-replay (completion-before-response) — i.e. before the
	// bootstrap waiter is registered. The waiter checks this set first so it never
	// misses an already-delivered completion and falsely times out.
	const recentlyCompleted = new Set<string>();
	const recentlyCompletedFifo: string[] = [];
	const RECENT_COMPLETED_CAP = 64;
	const markCompleted = (id: string) => {
		if (recentlyCompleted.has(id)) return;
		recentlyCompleted.add(id);
		recentlyCompletedFifo.push(id);
		if (recentlyCompletedFifo.length > RECENT_COMPLETED_CAP) {
			const evicted = recentlyCompletedFifo.shift();
			if (evicted) recentlyCompleted.delete(evicted);
		}
	};
	const demux = new TurnDemux({
		toExecutor: (method, params) => {
			if (method === "turn/started")
				args.turnState?.onTurnStarted(params, "message");
			if (method === "turn/completed") {
				args.turnState?.onTurnCompleted(params);
				const id = extractTurnId(params);
				for (const cb of listeners.turnCompleted) cb(params);
				if (id) {
					markCompleted(id); // record BEFORE release so a later waiter sees it
					demux.releaseTurn(id); // release AFTER delivery (bounded registry)
				}
			} else {
				for (const cb of listeners.notification) cb(method, params);
			}
		},
		toObserver: (method, params) => {
			// One observe row per founder turn — keyed on its completion (bounded,
			// idempotent; deltas are visible live in the TUI anyway).
			if (method === "turn/started") {
				args.turnState?.onTurnStarted(params, "founder_terminal");
				const id = extractTurnId(params);
				if (id) args.onFounderTurnStarted?.(id);
			} else if (method === "turn/completed") {
				args.turnState?.onTurnCompleted(params);
				const id = extractTurnId(params);
				if (id) args.onFounderTurnCompleted(id);
			}
		},
		onActivity: args.onActivity,
		log: args.log,
	});
	args.proc.on("notification", (method, params) => {
		if (method === "thread/tokenUsage/updated") args.onTokenUsage?.(params);
		demux.route(method, params);
	});
	args.proc.on("turnCompleted", (params) => {
		// FLY-2882: completions are recorded BEFORE demux routing so a completion
		// the demux holds (pre-claim) or drops (tombstoned after a timeout) still
		// clears the turn-state snapshot; the tracker ignores a later replayed start.
		args.turnState?.onTurnCompleted(params);
		demux.route("turn/completed", params);
	});

	const facade: CodexProcessLike = {
		on(event: "notification" | "turnCompleted" | "exit", cb: never): void {
			if (event === "notification") listeners.notification.push(cb);
			else if (event === "turnCompleted") listeners.turnCompleted.push(cb);
			else args.proc.on("exit", cb);
		},
		startTurn: async (a) => {
			let admitted = a;
			if (args.beforeTurn) {
				const admission = await args.beforeTurn();
				admitted = admitLeadTurn(a, admission);
			}
			demux.beginDispatch();
			let turnId: string | undefined;
			try {
				turnId = await args.proc.startTurn(admitted);
			} catch (err) {
				demux.abortDispatch();
				throw err;
			}
			if (turnId === undefined) {
				demux.abortDispatch();
				return undefined;
			}
			if (!demux.claimTurn(turnId)) {
				// R2 MED-3: window was force-settled by overflow — early events are
				// gone; never wait on this turn. The router treats this throw as
				// ambiguous (its existing failure path).
				throw new Error(
					`dispatch window poisoned for turn ${turnId} (hold-buffer overflow) — ambiguous`,
				);
			}
			return turnId;
		},
		request: (m, p) => args.proc.request(m, p),
	} as CodexProcessLike;

	const awaitTurnCompletion = (
		turnId: string,
		timeoutMs: number,
	): Promise<"completed" | "timeout"> =>
		new Promise((resolve) => {
			// Completion-before-response (R2 HIGH-1): if this turn ALREADY completed
			// (consumed during claim-replay before we got here), resolve immediately
			// rather than registering a listener that will never fire → false timeout.
			if (recentlyCompleted.has(turnId)) {
				resolve("completed");
				return;
			}
			let settled = false;
			const remove = () => {
				const i = listeners.turnCompleted.indexOf(onDone);
				if (i >= 0) listeners.turnCompleted.splice(i, 1);
			};
			const onDone = (params: unknown) => {
				if (settled || extractTurnId(params) !== turnId) return;
				settled = true;
				remove();
				clearTimeout(timer);
				resolve("completed");
			};
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				remove();
				// Tombstone the abandoned turn so any late delta is dropped and can
				// never be mistaken for the next machine turn's output (HIGH-2).
				demux.releaseTurn(turnId);
				resolve("timeout");
			}, timeoutMs);
			(timer as { unref?: () => void }).unref?.();
			listeners.turnCompleted.push(onDone);
		});

	return { facade, demux, awaitTurnCompletion };
}

/** Does a persisted rollout exist for this thread? (Real-machine finding:
 * the daemon writes a thread's rollout only at its FIRST TURN — a turnless
 * thread has none, and the TUI's resume bootstrap then fails with "no
 * rollout found". Checked directly so a stale thread-id pointing at a
 * turnless thread also self-heals via the bootstrap turn.) */
export function rolloutExistsFor(codexHome: string, threadId: string): boolean {
	const root = join(codexHome, "sessions");
	if (!existsSync(root)) return false;
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		let entries: Array<{ name: string; isDirectory(): boolean }>;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (e.isDirectory()) stack.push(join(dir, e.name));
			else if (e.name.includes(threadId)) return true;
		}
	}
	return false;
}

/**
 * Is this resume error the specific "turnless thread has no rollout" case
 * (JSON-RPC -32600) that is safe to self-heal with a fresh thread? Gated on the
 * STRUCTURED rpc code AND the exact message (review HIGH-3) — a substring match
 * alone would silently drop a thread on any unrelated resume error that happened
 * to contain the phrase, which is unacceptable memory loss. Everything else is
 * NOT self-healable and must rethrow.
 */
export function isTurnlessRolloutError(err: unknown): boolean {
	return (
		err instanceof CodexLeadProcessError &&
		err.rpcCode === -32600 &&
		/no rollout found/i.test(err.message)
	);
}

/**
 * Read the persona/identity files into `baseInstructions`, FAIL-CLOSED when files
 * were configured but none is readable/non-empty (review MED, R2 MED — applied at
 * EVERY read point: boot AND each generation rebuild, so a companion never
 * silently falls back to the default engineering persona mid-run). No files
 * configured → undefined → no persona (byte-compat).
 */
export function requirePersona(
	config: CodexLeadRuntimeConfig,
): string | undefined {
	const baseInstructions = readBaseInstructions(config.systemPromptFiles);
	if (config.systemPromptFiles.length > 0 && !baseInstructions) {
		throw new Error(
			`codex-lead-tui-runtime: FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES set but no file was readable/non-empty: ${config.systemPromptFiles.join(", ")}`,
		);
	}
	return baseInstructions;
}

// ── generation assembly (glue — validated by real bring-up) ────────────────

export interface TuiGenerationDeps {
	readTuning?: typeof readLeadRuntimeTuning;
	/** Process-owned resources outlive a transient WS generation. Main owns shutdown. */
	capabilitySession?: {
		parent: LeadCapabilityParent;
		journal: SqliteJournalStore;
		socket?: { path: string; assertCurrent(): Promise<void> };
	};
	onWindowOwned?: () => void;
	requestRebuild?: (reason: string) => boolean;
	connectDaemon?: typeof connectDaemonWs;
	createSender?: (config: CodexLeadTuiRuntimeConfig) => OutboundSender;
	preflight?: typeof runOutboundPreflight;
	verifyPersona?: () => Promise<VerifiedPersona | null>;
	verifyColdProof?: (persona: VerifiedPersona) => Promise<void> | void;
	recordPersonaObservation?: (
		stage: "verified" | "ready",
		persona: VerifiedPersona,
		threadId: string,
		threadRpcAckAt: string,
	) => Promise<void> | void;
}

export function buildTuiGeneration(
	config: CodexLeadTuiRuntimeConfig,
	logger: {
		info: (m: string, c?: unknown) => void;
		warn: (m: string, c?: unknown) => void;
		error: (m: string, c?: unknown) => void;
	},
	deps: TuiGenerationDeps = {},
) {
	const capabilityV2 = config.capabilityBundleVersion === 2;
	const capabilityParent = deps.capabilitySession?.parent;
	const journal = new LeadJournal({
		store:
			deps.capabilitySession?.journal ??
			new SqliteJournalStore(config.journalDbPath),
	});
	const residentCodexLeadProjects = loadResidentCodexLeadProjectsSafely({
		log: (message) => logger.warn(message),
	});
	// PROCESS-scope (review R2 HIGH-2): the thread id the founder's TUI is bound
	// to. The first generation, or any generation whose thread CHANGED (turnless
	// self-heal → fresh thread), must UNCONDITIONALLY ensure the window
	// (stale-kill a leftover same-named Claude pane on first cutover, or a TUI
	// still bound to the OLD thread). Only same-thread transient rebuilds preserve
	// a live founder session.
	let ownedTuiThreadId: string | undefined;
	let ownedTuiSocketPath: string | undefined;
	let stableTuiVisibility:
		| {
				threadId: string;
				socketPath: string;
				carrierInstanceId: string;
				identity: TuiWindowIdentity;
		  }
		| undefined;
	const tuiRetryBackoff = new TuiWindowRetryBackoff();
	let tuiRetryBinding: string | undefined;
	// FLY-871 §12 W2: silent-no-pane guard. Process-scoped (declared here, outside
	// the per-generation closure) so its consecutive-failure count + episode latch
	// survive generation rebuilds. It is non-null only for a roster opt-in target
	// when lead-alert.sh resolves; `?.record` keeps other Leads no-op.
	const tuiWindowAlertGuard = createTuiWindowAlertGuard({
		stateDir: config.stateDir,
		leadId: config.leadId,
		projectName: config.projectName,
		leadKey: config.leadKey,
		projects: residentCodexLeadProjects,
		env: process.env,
		log: (m) => logger.warn(m),
	});
	return () => {
		let activeVerifiedPersona: VerifiedPersona | null = null;
		let threadRotationEnabled = false;
		let runtime: CodexLeadRuntime | null = null;
		let proc: CodexLeadProcess | null = null;
		let nativeConfig: NativeLeadRuntimeConfig | undefined;
		let residencyLifecycle: ResidentCodexLeadLifecycleObserver | null = null;
		let lostCb: (() => void) | undefined;
		// FLY-2882: one turn-state tracker per proc generation (dead on exit/stop).
		let turnState: LeadTurnStateTracker | undefined;
		let turnSeed: { cancel(): void } | undefined;
		// Generation-owned TUI lifecycle (review HIGH-1): the window is no longer
		// fire-and-forget — a liveness cadence re-creates it if the founder closes
		// it (only when actually dead, so a healthy session is never disrupted),
		// and `sender`/timer are torn down on stop.
		let sender: OutboundSender | null = null;
		let tuiSpec: TuiWindowSpec | null = null;
		let livenessTimer: ReturnType<typeof setInterval> | null = null;
		let visibilityEpoch = 0;
		let pendingVisibility:
			| {
					epoch: number;
					threadId: string;
					socketPath: string;
					carrierInstanceId: string;
					cancel(): void;
			  }
			| undefined;
		let stopped = false;
		let ledger: RotationLedger | null = null;
		const ledgerPath = join(config.stateDir, "thread-rotation.json");
		let rotationDisabledThisGeneration = false;
		let rotationFenceHeld = false;
		let attemptInFlight = false;
		let founderTurnActive: boolean | "unknown" = "unknown";
		let founderTurnId: string | null = null;
		let lastActivityAt = Date.now();
		let gatewayReady = false;
		let rotationTimer: ReturnType<typeof setInterval> | null = null;
		const markPersonaReady = async (threadId: string): Promise<void> => {
			if (!activeVerifiedPersona) return;
			const threadRpcAckAt = new Date().toISOString();
			await deps.recordPersonaObservation?.(
				"verified",
				activeVerifiedPersona,
				threadId,
				threadRpcAckAt,
			);
			await deps.recordPersonaObservation?.(
				"ready",
				activeVerifiedPersona,
				threadId,
				threadRpcAckAt,
			);
		};
		const emit = (event: string, fields: Record<string, unknown> = {}) => {
			if (!threadRotationEnabled) return;
			appendRotationReceipt(
				join(config.stateDir, "thread-rotation.jsonl"),
				{
					v: 1,
					at: new Date().toISOString(),
					event,
					leadId: config.leadId,
					projectName: config.projectName,
					...fields,
				},
				(message) => logger.warn(message),
			);
		};
		const persist = (
			next: RotationLedger,
			disableOnFailure = true,
		): boolean => {
			try {
				writeRotationLedger(ledgerPath, next, Date.now());
				ledger = next;
				return true;
			} catch {
				if (disableOnFailure) rotationDisabledThisGeneration = true;
				logger.warn("[codex-lead-thread-rotation] ledger write failed");
				return false;
			}
		};
		const recordAttempt = (
			outcome: RotationLedger["lastAttemptOutcome"],
		): boolean => {
			if (!ledger) return false;
			return persist({
				...ledger,
				pending: null,
				lastAttemptAt: new Date().toISOString(),
				lastAttemptOutcome: outcome,
			});
		};
		const history = (from: string, to: string, reason: string) => {
			try {
				appendFileSync(
					join(config.stateDir, "thread-id.history"),
					`${new Date().toISOString()} ${from} -> ${to} reason=${reason}\n`,
					{ mode: 0o600 },
				);
			} catch {
				logger.warn("[codex-lead-thread-rotation] history append failed");
			}
		};
		const settleReadiness = (paneAlive: boolean) => {
			if (
				!threadRotationEnabled ||
				stopped ||
				rotationDisabledThisGeneration ||
				!ledger?.readinessPending
			)
				return;
			const pending = ledger.readinessPending;
			const readyMs = Date.now() - Date.parse(pending.requestedAt);
			if (pending.to !== ledger.currentThreadId) {
				if (persist({ ...ledger, readinessPending: null }, false))
					emit("rotation_degraded", {
						to: pending.to,
						requestedAt: pending.requestedAt,
						reason: "superseded",
					});
			} else if (gatewayReady && paneAlive) {
				if (persist({ ...ledger, readinessPending: null }, false))
					emit("rotation_ready", {
						to: pending.to,
						requestedAt: pending.requestedAt,
						readyMs,
						late: readyMs > ROTATION_READY_TIMEOUT_MS,
					});
			} else if (
				readyMs > ROTATION_READY_TIMEOUT_MS &&
				pending.degradedAt === null
			) {
				if (
					persist(
						{
							...ledger,
							readinessPending: {
								...pending,
								degradedAt: new Date().toISOString(),
							},
						},
						false,
					)
				)
					emit("rotation_degraded", {
						to: pending.to,
						requestedAt: pending.requestedAt,
						gatewayReady,
						paneAlive,
					});
			}
		};

		const tuiSocketPath = (spec: TuiWindowSpec): string =>
			spec.capabilitySocketPath ??
			`${spec.codexHome}/app-server-control/app-server-control.sock`;
		const tuiCarrierInstanceId = (spec: TuiWindowSpec): string =>
			spec.carrierInstanceId ?? "legacy";
		const bindingMatches = (
			binding: {
				threadId: string;
				socketPath: string;
				carrierInstanceId: string;
			},
			spec: TuiWindowSpec,
		): boolean =>
			binding.threadId === spec.threadId &&
			binding.socketPath === tuiSocketPath(spec) &&
			binding.carrierInstanceId === tuiCarrierInstanceId(spec);
		const retryBindingFor = (spec: TuiWindowSpec): string =>
			`${spec.threadId}\0${tuiSocketPath(spec)}\0${tuiCarrierInstanceId(spec)}`;
		const prepareRetryBinding = (spec: TuiWindowSpec) => {
			const binding = retryBindingFor(spec);
			if (binding === tuiRetryBinding) return;
			tuiRetryBinding = binding;
			tuiRetryBackoff.recordHealthy();
		};
		const recordTuiFailure = (spec: TuiWindowSpec) => {
			const delay = tuiRetryBackoff.recordFailure();
			tuiWindowAlertGuard?.record(false);
			if (delay > 0)
				logger.warn(
					`tui-window: unstable resume; retry_backoff_ms=${delay} (${spec.projectName}-${spec.leadId}, thread ${spec.threadId})`,
				);
		};
		const logExitEvidence = (spec: TuiWindowSpec) => {
			void readTuiWindowExitEvidenceAsync(spec)
				.then((evidence) => {
					if (!evidence) return;
					logger.warn(
						`tui-window: retained_exit window=${evidence.windowName} pane=${evidence.paneId} status=${evidence.exitStatus ?? "unknown"} tail=${JSON.stringify(evidence.terminalTail)}`,
					);
				})
				.catch((error) =>
					logger.warn(
						`tui-window: exit evidence unavailable: ${(error as Error).message}`,
					),
				);
		};
		const samePaneTuple = (
			left: TuiWindowIdentity,
			right: TuiWindowIdentity,
		): boolean =>
			left.windowName === right.windowName &&
			left.paneId === right.paneId &&
			left.panePid === right.panePid &&
			left.startCommand === right.startCommand;
		const cancelPendingVisibility = () => {
			const pending = pendingVisibility;
			if (!pending) return;
			pendingVisibility = undefined;
			visibilityEpoch += 1;
			pending.cancel();
		};
		const currentStableTuiIdentity = (): TuiWindowIdentity | null => {
			if (!tuiSpec || !stableTuiVisibility) return null;
			if (!bindingMatches(stableTuiVisibility, tuiSpec)) return null;
			const current = readTuiWindowIdentity(tuiSpec);
			if (
				!current ||
				!current.modelAlive ||
				!samePaneTuple(stableTuiVisibility.identity, current)
			) {
				stableTuiVisibility = undefined;
				return null;
			}
			return current;
		};
		const startVisibilityProof = (first: TuiWindowIdentity) => {
			if (!tuiSpec) return;
			cancelPendingVisibility();
			const spec = tuiSpec;
			const binding = {
				threadId: spec.threadId,
				socketPath: tuiSocketPath(spec),
				carrierInstanceId: tuiCarrierInstanceId(spec),
			};
			const epoch = ++visibilityEpoch;
			const proof = beginTuiWindowVisibilityProof(spec, first);
			pendingVisibility = { ...binding, epoch, cancel: proof.cancel };
			void proof.promise.then((identity) => {
				if (
					stopped ||
					rotationFenceHeld ||
					pendingVisibility?.epoch !== epoch ||
					!tuiSpec ||
					!bindingMatches(binding, tuiSpec)
				)
					return;
				pendingVisibility = undefined;
				if (identity) {
					stableTuiVisibility = { ...binding, identity };
					tuiRetryBackoff.recordHealthy();
					logger.info(
						`tui-window: real TUI up (${identity.windowName}, thread ${binding.threadId})`,
					);
					tuiWindowAlertGuard?.record(true);
					settleReadiness(true);
				} else {
					if (stableTuiVisibility && bindingMatches(stableTuiVisibility, spec))
						stableTuiVisibility = undefined;
					recordTuiFailure(spec);
					logExitEvidence(spec);
					settleReadiness(false);
				}
			});
		};

		// Single TUI-health entry, used by wire() and the liveness cadence (review
		// R2 HIGH-2 + R4 MED-1). Ownership-aware:
		//   - ownedTuiThreadId !== this thread → UNCONDITIONAL ensure (PR-C
		//     stale-kill): first generation, a thread change (turnless self-heal),
		//     OR a previous ensure that FAILED (ownership never recorded). Record
		//     ownership only on success so a failed create keeps retrying instead of
		//     trusting the probe on a leftover old-thread pane.
		//   - same thread, already owned → only re-create if the founder's live
		//     window actually died (never flap a healthy session on rebuild).
		const ensureTuiHealthy = () => {
			if (stopped || !tuiSpec) return false;
			prepareRetryBinding(tuiSpec);
			if (rotationFenceHeld) {
				cancelPendingVisibility();
				return false;
			}
			if (currentStableTuiIdentity()) {
				tuiRetryBackoff.recordHealthy();
				tuiWindowAlertGuard?.record(true);
				return true;
			}
			if (pendingVisibility) {
				if (bindingMatches(pendingVisibility, tuiSpec)) return false;
				cancelPendingVisibility();
			}
			if (!tuiRetryBackoff.canAttempt()) return false;
			// Derive one health signal per tick and feed the silent-no-pane guard
			// (W2). healthy=false unifies "create failed" and "died, re-create
			// failed"; a genuinely alive owned window is healthy without a rebuild.
			let created = false;
			if (
				ownedTuiThreadId !== tuiSpec.threadId ||
				ownedTuiSocketPath !== tuiSpec.capabilitySocketPath
			) {
				created = ensureTuiWindow(tuiSpec, {
					log: (m) => logger.warn(m),
				});
				if (created) {
					deps.onWindowOwned?.();
					ownedTuiThreadId = tuiSpec.threadId;
					ownedTuiSocketPath = tuiSpec.capabilitySocketPath;
				}
			} else if (!readTuiWindowIdentity(tuiSpec)) {
				if (isTuiWindowAlive(tuiSpec)) {
					recordTuiFailure(tuiSpec);
					return false;
				}
				created = ensureTuiWindow(tuiSpec, { log: (m) => logger.warn(m) });
				if (created) deps.onWindowOwned?.();
			}
			if (!created && !isTuiWindowAlive(tuiSpec)) {
				recordTuiFailure(tuiSpec);
				return false;
			}
			const first = readTuiWindowIdentity(tuiSpec);
			if (!first) {
				recordTuiFailure(tuiSpec);
				logExitEvidence(tuiSpec);
				return false;
			}
			startVisibilityProof(first);
			return false;
		};
		const attemptRotation = async (router: LeadInputRouter) => {
			if (
				!ledger ||
				!proc ||
				!tuiSpec ||
				!gatewayReady ||
				!isRotationDue({
					ledger,
					now: Date.now(),
					enabled: threadRotationEnabled,
					stopped,
					disabled: rotationDisabledThisGeneration,
					attemptInFlight,
					completedSinceStart: journal.countCompletedSince(
						Date.parse(ledger.startedAt),
					),
					routerIdle: router.isIdle(),
					founderTurnActive,
					lastActivityAt,
				})
			)
				return;
			attemptInFlight = true;
			rotationFenceHeld = true;
			cancelPendingVisibility();
			router.pause();
			const from = ledger.currentThreadId;
			let idleTimer: ReturnType<typeof setTimeout> | undefined;
			let reason:
				| "fence_error"
				| "pane_kill_unverified"
				| "router_busy"
				| "founder_turn_active"
				| "turns_list_busy"
				| "pending_write_failed"
				| "rebuild_refused"
				| null = null;
			try {
				if (!killTuiWindow(tuiSpec, { log: (message) => logger.warn(message) }))
					reason = "pane_kill_unverified";
				else {
					const idle = await Promise.race([
						router.whenIdle().then(() => true),
						new Promise<false>((resolve) => {
							idleTimer = setTimeout(() => resolve(false), FENCE_IDLE_WAIT_MS);
						}),
					]);
					if (stopped) return;
					if (!idle) reason = "router_busy";
					else if (founderTurnActive === true) reason = "founder_turn_active";
					else if (!(await boundedTurnsList(proc.request.bind(proc), from)))
						reason = "turns_list_busy";
					if (stopped) return;
					if (!reason) {
						founderTurnActive = false;
						const pending = {
							requestedAt: new Date().toISOString(),
							fromThreadId: from,
							reason: "period" as const,
							attemptStartedAt: null,
						};
						if (!persist({ ...ledger, pending }, false))
							reason = "pending_write_failed";
						else {
							emit("rotation_requested", {
								from,
								requestedAt: pending.requestedAt,
								completedSinceStart: journal.countCompletedSince(
									Date.parse(ledger.startedAt),
								),
							});
							if (deps.requestRebuild?.("thread_rotation")) return;
							reason = "rebuild_refused";
						}
					}
				}
			} catch (error) {
				reason = "fence_error";
				logger.error("[codex-lead-thread-rotation] fence failed", {
					error: String(error),
				});
			} finally {
				if (idleTimer !== undefined) clearTimeout(idleTimer);
				if (reason && !stopped) {
					// A pending record that cannot be cleared still authorizes a later generation.
					// Keep its old input fence intact until that generation reconciles it.
					const cleared = recordAttempt(
						reason === "fence_error"
							? "rotation_failed:fence_error"
							: `rotation_skipped:${reason}`,
					);
					if (cleared || ledger.pending === null) {
						router.resume();
						rotationFenceHeld = false;
						ensureTuiHealthy();
					}
					emit(
						reason === "fence_error" ? "rotation_failed" : "rotation_skipped",
						{ reason, from },
					);
				}
				attemptInFlight = false;
			}
		};
		let closing: Promise<void> | undefined;
		const closeGeneration = () => {
			if (closing) return closing;
			closing = (async () => {
				stopped = true;
				turnSeed?.cancel();
				turnState?.markDisconnected();
				nativeConfig?.close();
				if (rotationTimer) clearInterval(rotationTimer);
				rotationTimer = null;
				if (livenessTimer) clearInterval(livenessTimer);
				livenessTimer = null;
				cancelPendingVisibility();
				residencyLifecycle?.generationLost();
				try {
					await runtime?.stop();
				} finally {
					try {
						await proc?.stop();
					} finally {
						try {
							sender?.close?.();
						} finally {
							runtime = null;
							proc = null;
							sender = null;
							residencyLifecycle = null;
						}
					}
				}
			})();
			return closing;
		};
		const startSafely = (start: () => Promise<void>) => async () => {
			try {
				await start();
			} catch (error) {
				await closeGeneration().catch(() =>
					logger.warn("TUI partial startup cleanup failed"),
				);
				throw error;
			}
		};

		return {
			start: startSafely(async () => {
				const verifiedPersona = (await deps.verifyPersona?.()) ?? null;
				if (verifiedPersona) await deps.verifyColdProof?.(verifiedPersona);
				activeVerifiedPersona = verifiedPersona;
				// Validate persona BEFORE opening the WS (review R3 MED-2): a
				// fail-close here must not leak an already-connected transport (at
				// this point `runtime` is unassigned, so stop() couldn't close it).
				// Re-read on every (re)build so a persona edit takes effect on restart.
				if (
					capabilityV2 &&
					(!capabilityParent || !config.fullAccessProjectRoot)
				)
					throw new Error("capability_parent_not_assembled");
				if (
					capabilityV2 &&
					(capabilityParent!.pins.codexHome !== config.codexHome ||
						capabilityParent!.pins.projectName !== config.projectName ||
						capabilityParent!.pins.leadId !== config.leadId)
				)
					throw new Error("capability_parent_identity_mismatch");
				if (!capabilityV2 && deps.capabilitySession)
					throw new Error("capability_parent_version_mismatch");
				if (capabilityV2 && config.outboundMode !== "bridge")
					throw new Error("capability_outbound_requires_bridge");
				if (capabilityV2) await capabilityParent!.assertCurrent();
				const baseInstructions =
					verifiedPersona?.baseInstructions ??
					(capabilityV2
						? capabilityParent!.baseInstructions
						: requirePersona(config));
				if (capabilityV2 && !baseInstructions?.trim())
					throw new Error("capability_rules_unverified");
				if (capabilityParent?.skillGaps?.length)
					logger.warn("Codex Lead persona skill gaps: manual fallback", {
						skillGaps: capabilityParent.skillGaps,
					});
				await deps.capabilitySession?.socket?.assertCurrent();
				if (capabilityV2) {
					logger.warn(
						"[codex-lead-thread-rotation] disabled for capability v2: FLY-2576; rotation flag requires Bridge authority",
					);
				} else {
					let flagStore: StateStore | undefined;
					try {
						flagStore = await StateStore.openForMaintenance(
							config.flagStoreDbPath,
							{ readonly: true },
						);
						threadRotationEnabled = storeCodexLeadThreadRotationEnabled(
							{ mode: "ready", store: flagStore },
							config.projectName,
						);
					} catch (error) {
						logger.warn(
							"[codex-lead-thread-rotation] flag read failed; disabled for this generation",
							{ error: String(error) },
						);
					} finally {
						flagStore?.close();
					}
				}

				const ws = await (deps.connectDaemon ?? connectDaemonWs)({
					codexHome: config.codexHome,
					...(deps.capabilitySession?.socket
						? { socketPath: deps.capabilitySession.socket.path }
						: {}),
				});
				const transport = new WsTransport(ws);
				proc = new CodexLeadProcess({
					spawnChild: () => transport,
					experimentalApi: capabilityV2 || runtimeBuildIdentity !== undefined,
				});
				nativeConfig = runtimeBuildIdentity
					? new NativeLeadRuntimeConfig({
							config,
							process: proc,
							build: runtimeBuildIdentity,
							log: (message) => logger.warn(message),
						})
					: undefined;
				const generationTurnState = new LeadTurnStateTracker({
					binding: journal,
				});
				turnState = generationTurnState;
				proc.on("exit", () => generationTurnState.markDisconnected());
				if (lostCb) proc.on("exit", () => lostCb?.());
				const inventory = capabilityV2 ? new McpInventoryWatcher() : undefined;
				if (inventory)
					proc.on("notification", (method, params) =>
						inventory.record(method, params),
					);

				// The full-access tool-surface guarantee is enforced by the config gate
				// in main() (exact lead_actions MCP, command/args/env, no literal secret)
				// BEFORE the daemon starts. The
				// old runtime "wait for the live MCP to report ready" watcher was removed
				// (race-fix design review): codex 0.141 spawns the MCP EPHEMERALLY per
				// turn with no persistent ready status, so that gate false-timed-out and
				// tore Mufasa down. codex can only spawn what the (gated) config declares.

				let activeThreadId: string | null = null;
				let bootstrapAdmission = true;
				const { facade, awaitTurnCompletion } = wireDemuxedProcess({
					beforeTurn: nativeConfig
						? () => nativeConfig!.beforeTurn(bootstrapAdmission)
						: undefined,
					proc,
					onFounderTurnStarted: (turnId) => {
						founderTurnActive = true;
						founderTurnId = turnId;
						lastActivityAt = Date.now();
					},
					onFounderTurnCompleted: (turnId) => {
						if (founderTurnId === turnId) founderTurnActive = false;
						lastActivityAt = Date.now();
						journal.recordObservation({
							idempotencyKey: `founder:${turnId}`,
							payload: "founder terminal turn (observed; see TUI/rollout)",
						});
					},
					turnState: generationTurnState,
					...(config.contextUsagePath && config.contextUsageUnavailablePath
						? {
								onTokenUsage: (params: unknown) => {
									if (!activeThreadId) return;
									const result = recordContextUsage({
										activeThreadId,
										notification: params,
										usagePath: config.contextUsagePath!,
										unavailablePath: config.contextUsageUnavailablePath!,
										log: (message) => logger.warn(message),
									});
									if (result === "unavailable") {
										logger.warn("Raya context usage sample unavailable");
									}
								},
							}
						: {}),
					log: (m) => logger.warn(m),
				});

				facade.on("turnCompleted", () => {
					lastActivityAt = Date.now();
				});

				const builtSender: OutboundSender =
					deps.createSender?.(config) ??
					(config.outboundMode === "bridge"
						? new CodexOutboundSender({
								bridgeUrl: config.bridgeUrl,
								apiToken: config.apiToken,
								...(capabilityV2
									? { post: capabilityParent!.outboundPost }
									: {}),
								projectName: config.projectName,
								leadId: config.leadId,
								channelId: config.chatChannelId,
								dbPath: config.outboxDbPath,
							})
						: new DirectDiscordOutboundSender({
								botToken: config.botToken,
								channelId: config.chatChannelId,
							}));
				sender = builtSender; // closure-tracked so stop() can close its DB handle

				let bootstrapTuning: ReturnType<typeof readLeadRuntimeTuning> = {};
				const threadParams = () => {
					bootstrapTuning = capabilityV2
						? {
								...(config.model ? { model: config.model } : {}),
								...(config.reasoningEffort
									? { reasoningEffort: config.reasoningEffort }
									: {}),
							}
						: (deps.readTuning ?? readLeadRuntimeTuning)(config);
					return buildThreadParams(
						{ ...config, ...bootstrapTuning },
						baseInstructions,
					);
				};
				const p = proc;
				runtime = new CodexLeadRuntime({
					startProcess: async () => {
						await p.start(); // initialize/initialized over WS
						if (capabilityV2) {
							try {
								await verifyLeadCapabilityReadiness({
									parent: capabilityParent!,
									cwd: config.fullAccessProjectRoot!,
									request: (method, params) => p.request(method, params),
								});
							} catch (error) {
								await p.stop();
								throw error;
							}
						}
						if (config.outboundMode === "bridge") {
							try {
								await (deps.preflight ?? runOutboundPreflight)({
									probe: (channelId) =>
										(
											builtSender as unknown as Pick<
												CodexOutboundSender,
												"probeAuthorization"
											>
										).probeAuthorization(channelId),
									channelIds: config.outboundProbeChannelIds,
									log: logger,
								});
							} catch (error) {
								await p.stop();
								throw error;
							}
						}
					},
					ensureThread: async (): Promise<string> => {
						if (capabilityV2) {
							await verifyLeadCapabilityReadiness({
								parent: capabilityParent!,
								cwd: config.fullAccessProjectRoot!,
								request: (method, params) => p.request(method, params),
							});
							await inventory!.waitForExact(
								capabilityParent!.mcp.included,
								30_000,
							);
						}
						const strict = readThreadIdStrict(config.threadIdPath);
						if (strict.kind !== "ok" && strict.kind !== "missing")
							throw new Error(
								`[codex-lead-thread-rotation] thread-id ${config.threadIdPath}: ${strict.kind}`,
							);
						const saved = strict.kind === "ok" ? strict.id : undefined;
						if (saved && threadRotationEnabled) {
							const reconciled = reconcileRotationLedger(
								saved,
								readRotationLedger(ledgerPath, Date.now()),
								Date.now(),
								rolloutTimestampFor(config.codexHome, saved, Date.now()),
							);
							ledger = reconciled.ledger;
							if (reconciled.reason) {
								persist(ledger);
								emit("reconciled", {
									reason: reconciled.reason,
									currentThreadId: saved,
									startedAt: ledger.startedAt,
								});
							}
							const pending = ledger.pending;
							if (pending && !rotationDisabledThisGeneration) {
								const started = Date.now();
								const fail = (
									reason:
										| "attempt_mark_failed"
										| "thread_start_failed"
										| "thread_id_invalid"
										| "thread_id_write_failed",
								) => {
									recordAttempt(`rotation_failed:${reason}`);
									emit("rotation_failed", {
										reason,
										from: saved,
										requestedAt: pending.requestedAt,
										wallMs: Date.now() - started,
									});
								};
								if (!(await boundedTurnsList(p.request.bind(p), saved))) {
									recordAttempt("reconciled:pending_busy");
									emit("reconciled", {
										reason: "pending_busy",
										currentThreadId: saved,
									});
								} else if (
									!persist(
										{
											...ledger,
											pending: {
												...pending,
												attemptStartedAt: new Date().toISOString(),
											},
										},
										false,
									)
								)
									fail("attempt_mark_failed");
								else {
									const note = rotationDeveloperNote(Date.now(), saved);
									let id: string | undefined;
									try {
										id = await p.startThread({
											...threadParams(),
											developerInstructions: note,
										});
									} catch {
										fail("thread_start_failed");
									}
									if (id !== undefined) {
										if (!THREAD_ID_RE.test(id) || !SAFE_ID.test(id))
											fail("thread_id_invalid");
										else {
											let committed = false;
											try {
												writeThreadId(config.threadIdPath, id);
												committed = true;
											} catch {
												fail("thread_id_write_failed");
											}
											if (committed) {
												history(saved, id, "period");
												const at = new Date().toISOString();
												const ledgerWriteFailed = !persist({
													...ledger,
													currentThreadId: id,
													previousThreadId: saved,
													startedAt: at,
													lastAttemptAt: at,
													lastAttemptOutcome: "rotated",
													pending: null,
													readinessPending: {
														to: id,
														requestedAt: pending.requestedAt,
														degradedAt: null,
													},
												});
												emit("rotated", {
													from: saved,
													to: id,
													requestedAt: pending.requestedAt,
													developerNoteChars: note.length,
													wallMs: Date.now() - started,
													ledgerWriteFailed,
												});
												activeThreadId = id;
												await markPersonaReady(id);
												return id;
											}
										}
									}
								}
							}
						}
						if (saved) {
							try {
								await p.resumeThread(saved, threadParams());
								activeThreadId = saved;
								await markPersonaReady(saved);
								return saved;
							} catch (err) {
								if (!isTurnlessRolloutError(err)) throw err;
								logger.warn(
									"saved thread has no persisted rollout (turnless) — starting a fresh thread",
									{ saved },
								);
							}
						}
						const id = await p.startThread(threadParams());
						if (!THREAD_ID_RE.test(id) || !SAFE_ID.test(id))
							throw new Error("thread-id: invalid new thread id");
						writeThreadId(config.threadIdPath, id);
						if (threadRotationEnabled) {
							const reconciled = reconcileRotationLedger(
								id,
								{ kind: "missing" },
								Date.now(),
								Date.now(),
								true,
							);
							ledger = {
								...reconciled.ledger,
								previousThreadId: saved ?? null,
							};
							persist(ledger);
							if (saved) history(saved, id, "turnless");
							emit("reconciled", {
								reason: saved ? "thread_changed_turnless" : "pristine",
								currentThreadId: id,
								startedAt: ledger.startedAt,
							});
						}
						activeThreadId = id;
						await markPersonaReady(id);
						return id;
					},
					wire: async (threadId: string): Promise<RuntimeWiring> => {
						generationTurnState.bindThread(threadId);
						turnSeed?.cancel();
						turnSeed = seedTurnStateWithRetry({
							tracker: generationTurnState,
							read: () => readLatestTurn(p.request.bind(p), threadId),
						});
						await nativeConfig?.bootstrap(threadId, bootstrapTuning);
						residencyLifecycle = createResidentCodexLeadLifecycleForGeneration({
							config,
							projects: residentCodexLeadProjects,
							threadId,
							generationId: randomBytes(16).toString("hex"),
							log: (message) => logger.warn(message),
						});
						const externalReceiptQueue = new MailboxQueue(config.commDbPath);
						const externalReceiptSaga = new ExternalReceiptSaga({
							leadId: config.leadId,
							queue: externalReceiptQueue,
							journal,
						});
						// The full-access tool-surface guarantee is enforced by the config
						// gate in main() BEFORE the daemon
						// starts — not by a runtime "wait for the live MCP to report ready"
						// gate here. codex 0.141 spawns the MCP ephemerally per turn with no
						// persistent ready status, so the old gate false-timed-out (30s) and
						// tore Mufasa down. codex can only spawn what the (gated) config
						// declares; the first-party MCP registers exactly discord_send.
						const executor = new CodexTurnExecutor({
							process: facade, // demuxed: foreign turns never arrive
							threadId,
							...(residencyLifecycle ? { lifecycle: residencyLifecycle } : {}),
						});
						// FLY-1806: Discord typing indicator is fixed on. The TUI sidecar drives
						// Discord I/O through this SAME router,
						// so the founder sees "typing…" in Discord while a windowed Mufasa works.
						// Closed on stopGateway (also fired on each generation rebuild).
						const typing = config.typingEnabled
							? new DiscordTypingNotifier({
									botToken: config.botToken,
									defaultChannelId: config.chatChannelId,
								})
							: undefined;
						const source = new RestPollDiscordInboundSource({
							botToken: config.botToken,
							channelIds: config.channelIds,
							cursorStore: new FileInboundCursorStore(config.inboundCursorPath),
							...(residencyLifecycle ? { lifecycle: residencyLifecycle } : {}),
						});
						// FLY-314 Phase 2: reply-in-thread wiring (default-OFF → undefined).
						const replyInThread = config.replyInThread
							? buildReplyInThreadWiring({
									cfg: config.replyInThread,
									stateDir: config.stateDir,
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
							sender: builtSender,
							...(capabilityV2
								? {
										enterDeliveryContext: (entryId: string) =>
											capabilityParent!.enterDeliveryContext(entryId),
									}
								: {}),
							onEntryCompleted: (entry) => {
								lastActivityAt = Date.now();
								if (
									entry.source === "discord" &&
									(entry.replyChannelId || entry.replyRoute)
								) {
									externalReceiptSaga.handle(entry.idempotencyKey, entry.id);
								}
							},
							onInputAccepted: (entry) => {
								lastActivityAt = Date.now();
								replyInThread?.onInputAccepted(entry);
							},
							...(typing ? { typing } : {}),
							...(replyInThread
								? {
										ensureReplyRoute: replyInThread.ensureReplyRoute,
										onTopicEngaged: replyInThread.onTopicEngaged,
									}
								: {}),
						});
						const inboxServer = new CodexLeadInboxServer({
							...(nativeConfig
								? {
										socketOwnerId: nativeConfig.socketOwnerId,
										runtimeConfig: nativeConfig.hooks,
									}
								: {}),
							voiceSelfFilter:
								(): import("../../voice-self-filter-contract.js").VoiceSelfFilterObservation =>
									gateway.probeVoiceSelfFilter(),
							ignoredAuthorIds: config.ignoredAuthorIds,
							turnState: {
								snapshot: () => generationTurnState.snapshot(),
							},
							socketPath: resolveCodexLeadInboxSocketPath(config.stateDir),
							leadId: config.leadId,
							router,
							authSecret: config.botToken,
							...(replyInThread?.autoContinue && config.replyInThread
								? {
										proactiveTopic: {
											parentChannelId: config.replyInThread.parentChannelId,
											isCurrentOwner: (): boolean => ownership.proactiveReady(),
											engage: replyInThread.onProactiveTopicEngaged,
										},
									}
								: {}),
							...(replyInThread
								? {
										subscriptions: {
											list: replyInThread.listSubscriptions,
											remove: replyInThread.unsubscribeThread,
										},
									}
								: {}),
						});
						// FLY-267 判 + 回: mirror the headless mention-gate + reply-routing so
						// the TUI runtime does NOT spam shared channels and routes replies back
						// to the source channel. No cross-dept → neither hook → byte-compat.
						const crossDeptSet = new Set(config.crossDeptChannelIds);
						// FLY-898: mirror the headless core-room id-only gate (empty otherwise).
						const coreStrictChannelIds = resolveCoreStrictChannelIds(config);
						const shouldHandle =
							config.crossDeptChannelIds.length > 0 ||
							coreStrictChannelIds.length > 0
								? buildMentionGate({
										botUserId: config.botUserId,
										sharedChannelIds: config.crossDeptChannelIds,
										coreStrictChannelIds,
										mentionPatterns: config.mentionPatterns,
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
								? (msg: DiscordInboundMessage) =>
										crossDeptSet.has(msg.channelId) ? msg.channelId : undefined
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
							ignoredAuthorIds: config.ignoredAuthorIds,
							channelIds: config.channelIds,
							externalReceiptSaga,
							durableAccept: (input) => mailboxStrategy.accept(input),
							...(shouldHandle ? { shouldHandle } : {}),
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
								start: (): Promise<void> =>
									startCodexLeadTuiGateway(gateway, replyInThread),
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
						nativeConfig?.bindOwner(
							() =>
								inboxServer.runtimeConfigOwnerCurrent() &&
								ownership.mailboxReady(),
						);
						// FIRST-BOOT/TURNLESS bootstrap turn (real-machine finding): the daemon
						// persists a thread's rollout only at its FIRST TURN — a turnless
						// thread has no rollout and the TUI's resume bootstrap fails with
						// "no rollout found". Run one tiny turn (await completion, bounded)
						// BEFORE creating the window.
						let bootstrapOutcome: string = "skipped_rollout_exists";
						if (!rolloutExistsFor(config.codexHome, threadId)) {
							bootstrapOutcome = "dispatch_failed";
							let bootstrapTurnId: string | undefined;
							try {
								bootstrapTurnId = await facade.startTurn({
									threadId,
									input: [
										{
											type: "text",
											text: "(系统首启自检,简短回复一句即可,例如:就绪。)",
										},
									],
								});
							} catch (err) {
								// startTurn rejected (rpc failure / poisoned-claim ambiguous):
								// no turn was registered, nothing to release.
								logger.warn(
									"bootstrap turn dispatch failed (TUI window may not attach until the first real turn)",
									{ err: (err as Error).message },
								);
							}
							if (bootstrapTurnId) {
								// Await THIS turn specifically; on timeout the id is released
								// (tombstoned) so a late delta can't bleed into the next
								// machine turn once the gateway starts (review HIGH-2).
								const outcome = await awaitTurnCompletion(
									bootstrapTurnId,
									90_000,
								);
								bootstrapOutcome = outcome;
								if (outcome === "completed") {
									logger.info("bootstrap turn completed (rollout persisted)");
								} else {
									logger.warn(
										"bootstrap turn timed out — released to avoid cross-talk; TUI may attach on first real turn",
										{ bootstrapTurnId },
									);
								}
							}
						}
						if (
							threadRotationEnabled &&
							!rotationDisabledThisGeneration &&
							ledger?.readinessPending?.to === threadId
						)
							emit("rotation_bootstrap", {
								to: threadId,
								requestedAt: ledger.readinessPending.requestedAt,
								outcome: bootstrapOutcome,
							});
						// TUI window AFTER the thread is known (the founder's client
						// resumes the SAME machine-owned thread). Fail-open. Pass the
						// VALIDATED codex binary (review HIGH-4) — a bare `codex` under a
						// sparse launchd PATH could miss or hit the wrong (npm) build.
						bootstrapAdmission = false;
						tuiSpec = {
							projectName: config.projectName,
							leadId: config.leadId,
							codexHome: config.codexHome,
							threadId,
							cwd: config.tuiCwd,
							codexBin: capabilityV2
								? capabilityParent!.codexPath
								: config.codexBin,
							// FLY-398 compatibility identity. The remote thread owns its
							// permission tier; Codex 0.154 rejects TUI-side overrides.
							fullAccess: config.codexProfile === "full-access",
							...(capabilityV2
								? {
										...(deps.capabilitySession?.socket
											? {
													capabilitySocketPath:
														deps.capabilitySession.socket.path,
												}
											: {}),
										capabilityModelEnv: {
											pins: capabilityParent!.pins,
											env: process.env,
										},
									}
								: {}),
							...(config.carrierInstanceId
								? { carrierInstanceId: config.carrierInstanceId }
								: {}),
						};
						// Identity-aware ensure (review R2 HIGH-2 + R3 MED-1 + R4 MED-1):
						// ensureTuiHealthy does the UNCONDITIONAL ensure (PR-C stale-kill)
						// on first generation / thread change / a prior failed ensure, and
						// records ownership only on success; once owned it only re-creates a
						// genuinely dead window (never flaps a healthy founder session).
						ensureTuiHealthy();
						// Liveness cadence (review HIGH-1 + R4 MED-1): re-create the window
						// if the founder closes it, AND retry the unconditional ensure if a
						// prior one failed. Started once per generation; unref'd so it never
						// holds the process open; cleared on stop().
						if (!livenessTimer) {
							livenessTimer = setInterval(
								() => settleReadiness(ensureTuiHealthy()),
								TUI_LIVENESS_INTERVAL_MS,
							);
							(livenessTimer as { unref?: () => void }).unref?.();
						}
						lastActivityAt = Date.now();
						if (threadRotationEnabled) {
							rotationTimer = setInterval(() => {
								void attemptRotation(router).catch(() => {
									rotationDisabledThisGeneration = true;
									logger.error(
										"[codex-lead-thread-rotation] fence failed unexpectedly; disabled this generation",
									);
								});
							}, ROTATION_CHECK_INTERVAL_MS);
							rotationTimer.unref();
						}
						return {
							recover: () => router.recover(),
							// The full-access tool-surface guarantee is enforced by the config
							// gate in main(), before the daemon
							// starts — not by a runtime gate here. See main() / mcp-config.ts.)
							startGateway: async () => {
								externalReceiptSaga.reconcile({
									olderThan: new Date().toISOString(),
									absenceProvenThroughMessageId: "0",
								});
								// FLY-314 Phase 2 (Codex code review #1): gateway FIRST so the
								// source.onMessage handler is installed before discovery's
								// addChannel() can drain a resumed thread (else downtime thread
								// messages are dropped + cursor advances past them).
								// FLY-1373: open Bridge batch ingress only AFTER journal recovery
								// (CodexLeadRuntime orders recover() before startGateway()).
								await ownership.start();
								gatewayReady = true;
								settleReadiness(!!currentStableTuiIdentity());
								residencyLifecycle?.online();
							},
							stopGateway: async () => {
								gatewayReady = false;
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
						nativeConfig?.close();
						await p.stop();
					},
					logger,
				});
				await runtime.start();
			}),
			stop: closeGeneration,
			onConnectionLost: (cb: () => void) => {
				lostCb = cb;
				if (proc) proc.on("exit", () => lostCb?.());
				return () => {
					lostCb = undefined;
				};
			},
		};
	};
}

// ── entrypoint ─────────────────────────────────────────────────────────────

export async function main(
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const config = parseCodexLeadTuiRuntimeConfig(env);
	// FLY-398 (pin ①): a windowed FULL-ACCESS TUI Lead (= Claude-equal) IS now
	// supported — it shares the thread's workspace-write sandbox in a cmux pane.
	// Every OTHER non-read-only sandbox (the (Z) write-capable gateway tier,
	// danger-full-access) stays refused for the TUI runtime — those remain
	// headless-only (FLY-245/FLY-350 §2.3). The parser already enforces
	// full-access ⟹ workspace-write (profile↔sandbox lockstep), so reaching here
	// with full-access guarantees workspace-write.
	const fullAccess = config.codexProfile === "full-access";
	const exactRaya = config.projectName === "raya" && config.leadId === "raya";
	if (config.sandboxMode !== "read-only" && !fullAccess) {
		throw new Error(
			`codex-lead-tui-runtime: sandbox="${config.sandboxMode}" profile="${config.codexProfile}" is write-capable but not full-access — the ③ TUI Lead supports only read-only companion and full-access (Claude-equal); the (Z) write-capable gateway tier is headless-only (FLY-245). Refusing to start.`,
		);
	}
	// Persona fail-close at boot (review MED — parity with headless). The same
	// check runs at every generation read point (requirePersona), so a companion
	// never silently falls back to the default persona.
	if (config.capabilityBundleVersion !== 2 && !exactRaya)
		requirePersona(config);
	// DRY-RUN (review MED — parity with headless): describe what WOULD start with
	// zero side effects (no daemon connect, no Discord poll). The launcher skips
	// ensure-home/ensure-daemon in dry-run so this path is genuinely side-effect free.
	if (env.FLYWHEEL_LEAD_DRY_RUN === "1") {
		console.log(
			"[codex-lead-tui-runtime] DRY-RUN — ③ real terminal (TUI) mode",
		);
		console.log(`  tui cwd       : ${config.tuiCwd}`);
		for (const line of dryRunReport(config)) console.log(line);
		return;
	}
	const carrierInstanceId = randomBytes(32).toString("base64url");
	const carrierConfig: CodexLeadTuiRuntimeConfig = {
		...config,
		carrierInstanceId,
	};
	let personaStateRoot: string | undefined;
	const verifyCurrentPersona = async (): Promise<VerifiedPersona | null> => {
		if (!exactRaya) return null;
		if (
			!config.projectsFile ||
			!config.expectedProjectsDigest ||
			!config.fullAccessProjectRoot
		) {
			throw new Error("persona_startup_authority_missing");
		}
		personaStateRoot ??= resolvePersonaStateRoot(env, homedir());
		return verifyPersonaStartup({
			projectName: config.projectName,
			leadId: config.leadId,
			projectsPath: config.projectsFile,
			expectedProjectsDigest: config.expectedProjectsDigest,
			projectRoot: config.fullAccessProjectRoot,
			stateRoot: personaStateRoot,
			systemPromptFiles: config.systemPromptFiles,
			...(config.capabilityBundleVersion === 2
				? { capabilityBundleVersion: 2 as const }
				: {}),
			bridgeUrl: config.bridgeUrl,
			bridgeToken: config.apiToken,
		});
	};
	publishCarrierRuntimeAssertion({
		env,
		leadKey: config.leadKey,
		identityDigest: config.identityDigest,
		rawCarrierInstanceId: carrierInstanceId,
		pid: process.pid,
		lstart: withSyncOpMarker("codex-lead-tui:process-start", () =>
			getProcessStart(process.pid),
		),
	});
	if (config.capabilityBundleVersion === 2) {
		await verifyCurrentPersona();
		const owned = createCapabilityTuiRuntime(carrierConfig, env, console);
		const stop = () => {
			void owned.stop().then(
				() => process.exit(0),
				() => process.exit(1),
			);
		};
		process.once("SIGTERM", stop);
		process.once("SIGINT", stop);
		try {
			await owned.start();
		} catch (error) {
			process.off("SIGTERM", stop);
			process.off("SIGINT", stop);
			throw error;
		}
		return;
	}
	// Resolve the home script for BOTH layouts: from dist/lead-backends/codex
	// it's ../../../scripts; from src/lead-backends/codex it's ../../scripts
	// is wrong too — scripts/ lives at the package root in both cases, three
	// levels up from this module's directory.
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const homeScript = join(
		moduleDir,
		"..",
		"..",
		"..",
		"scripts",
		"codex-lead-tui-home.sh",
	);
	// FLY-398/FLY-2445 FULL-ACCESS: the lead_actions MCP (proactive discord_send)
	// is injected via config.toml with only the selected transport credential
	// forwarded BY NAME. The §10 config gate runs the FULL-ACCESS variant: it
	// ALLOWS exactly approve + the mode-selected env names while rejecting extra MCP / literal secrets
	// / alternate fields. Fail-closed before the daemon starts.
	if (fullAccess) {
		const mainJsPath = env.FLYWHEEL_LEAD_ACTIONS_MAIN_JS?.trim();
		const stateDir = env.FLYWHEEL_LEAD_ACTIONS_STATE_DIR?.trim();
		if (!mainJsPath || !stateDir) {
			throw new Error(
				"codex-lead-tui-runtime: full-access requires FLYWHEEL_LEAD_ACTIONS_MAIN_JS + FLYWHEEL_LEAD_ACTIONS_STATE_DIR (the full-access TUI launcher sets them) — refusing to start (fail-closed)",
			);
		}
		const expectedMcp = buildFullAccessLeadActionsMcpServerConfig({
			projectsFile: env.FLYWHEEL_PROJECTS_FILE,
			runnerContext: config.runnerActionContext,
			nodeBin: env.FLYWHEEL_LEAD_ACTIONS_NODE_BIN?.trim() || "node",
			mainJsPath,
			leadId: config.leadId,
			projectName: config.projectName,
			chatChannelId: config.chatChannelId,
			crossDeptChannelIds: config.crossDeptChannelIds,
			stateDir,
			commDbPath: config.commDbPath,
			outboundMode: config.outboundMode,
			attachmentContext: tryResolveLeadAttachmentContext({
				projectsPath:
					config.projectsFile ?? join(homedir(), ".flywheel", "projects.json"),
				homeDir: homedir(),
				projectName: config.projectName,
				leadId: config.leadId,
				identityDigest: config.identityDigest,
				outboundMode: config.outboundMode,
			}),
			explicitAliases: env.FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES?.trim(),
			// FLY-676: forward the effective roundtable autoContinue (parity with headless).
			// codex-lead-tui-home.sh writes the matching env into config.toml; the full-access
			// §10 gate asserts EXACT env match (drift fail-closes the daemon).
			roundtableAutoContinue: config.replyInThread?.autoContinue === true,
		});
		const configTomlPath = join(config.codexHome, "config.toml");
		let configTomlContent: string;
		try {
			configTomlContent = readFileSync(configTomlPath, "utf8");
		} catch (err) {
			throw new Error(
				`codex-lead-tui-runtime: cannot read ${configTomlPath} for the full-access §10 config gate (fail-closed): ${(err as Error).message}`,
			);
		}
		assertFullAccessLeadActionsConfigGate(configTomlContent, expectedMcp);
		// Codex R1 HIGH-2: also assert the SANDBOX shape (workspace-write + network ON)
		// and pin writable_roots to the runtime-VALIDATED project root —
		// so a stale/overridden FLYWHEEL_CODEX_TUI_CWD can't point the daemon's writable
		// root at an unvalidated path while the lead_actions block alone looks correct.
		if (!config.fullAccessProjectRoot) {
			throw new Error(
				"codex-lead-tui-runtime: full-access requires a resolved fullAccessProjectRoot (parser invariant) — refusing to start (fail-closed)",
			);
		}
		assertFullAccessSandboxConfig(
			configTomlContent,
			config.fullAccessProjectRoot,
		);
		console.warn(
			`[codex-lead-tui-runtime] full-access §10 config gate PASSED (lead_actions MCP exact + sandbox=workspace-write/network-on + writable_roots=[validated project root], approve mode, outbound=${config.outboundMode}, credential by-name, no broker)`,
		);
	}
	let preparedPersona: VerifiedPersona | null | undefined;
	let preparedPersonaGenerationId: string | undefined;
	let preparedPersonaColdProof: PersonaColdProof | undefined;
	const ensureDaemon = async () => {
		preparedPersona = await verifyCurrentPersona();
		preparedPersonaColdProof = undefined;
		preparedPersonaGenerationId = preparedPersona
			? randomBytes(16).toString("hex")
			: undefined;
		const { stderr } = await execFileP(
			"/bin/bash",
			[homeScript, "ensure-daemon"],
			{
				env: buildTuiDaemonEnv({
					profile: config.codexProfile,
					env,
					codexHome: config.codexHome,
					botToken: config.botToken,
					bridgeUrl: config.bridgeUrl,
					apiToken: config.apiToken,
					outboundMode: config.outboundMode,
					carrierInstanceId,
					leadId: config.leadId,
					projectName: config.projectName,
					personaColdRequired: preparedPersona !== null,
					personaGenerationId: preparedPersonaGenerationId,
				}),
			},
		);
		reportSuccessfulDaemonEnsure(stderr, console.warn);
	};
	const supervisor: DaemonConnectionSupervisor = new DaemonConnectionSupervisor(
		{
			buildGeneration: buildTuiGeneration(carrierConfig, console, {
				requestRebuild: (reason) => supervisor.requestRebuild(reason),
				verifyPersona: async () => {
					if (preparedPersona === undefined)
						throw new Error("persona_daemon_not_prepared");
					const fresh = await verifyCurrentPersona();
					if (
						canonicalSubmissionDigest(fresh) !==
						canonicalSubmissionDigest(preparedPersona)
					)
						throw new Error("persona_authority_changed_after_daemon_start");
					return fresh;
				},
				verifyColdProof: () => {
					if (!preparedPersonaGenerationId)
						throw new Error("persona_cold_generation_missing");
					preparedPersonaColdProof = verifyPersonaColdProof({
						codexHome: config.codexHome,
						generationId: preparedPersonaGenerationId,
					});
				},
				recordPersonaObservation: (
					stage,
					persona,
					threadId,
					threadRpcAckAt,
				) => {
					if (
						!personaStateRoot ||
						!preparedPersonaColdProof ||
						!preparedPersonaGenerationId
					) {
						throw new Error("persona_observation_authority_missing");
					}
					writePersonaObservationReceipt(personaStateRoot, {
						schemaVersion: 1,
						stage,
						generationId: preparedPersonaGenerationId,
						pid: preparedPersonaColdProof.pid,
						processStartTime: preparedPersonaColdProof.processStartTime,
						leadKey: config.leadKey,
						threadId,
						threadRpcAckAt,
						...persona,
					});
				},
			}),
			ensureDaemon,
			log: (m) => console.warn(`[codex-lead-tui-runtime] ${m}`),
		},
	);
	const shutdown = (sig: NodeJS.Signals) => {
		console.warn(`[codex-lead-tui-runtime] ${sig} → stopping`);
		supervisor
			.stop()
			.finally(() => {
				// Real shutdown (not a transient rebuild): tear down the orphan TUI
				// window so a `codex resume --remote` pane never outlives its Lead
				// (review HIGH-1 / cutover "stop the sidecar+TUI first" contract).
				killTuiWindow(
					{ projectName: config.projectName, leadId: config.leadId },
					{ log: (m) => console.warn(`[codex-lead-tui-runtime] ${m}`) },
				);
			})
			.finally(() => process.exit(0));
	};
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
	try {
		await supervisor.start();
	} catch (err) {
		// Startup-failure path (review R2 HIGH-2): a generation may have created
		// the TUI window before failing — tear it down so it never orphans, same
		// as the signal handlers do.
		// Stop a half-started generation before tearing down its TUI window.
		// Best-effort (we are failing closed regardless).
		await supervisor.stop().catch(() => {});
		killTuiWindow(
			{ projectName: config.projectName, leadId: config.leadId },
			{ log: (m) => console.warn(`[codex-lead-tui-runtime] ${m}`) },
		);
		throw err;
	}
	console.warn(
		`[codex-lead-tui-runtime] ${config.leadId}@${config.projectName} started (③ real terminal)`,
	);
}

// Run when executed directly (codex-lead.sh TUI mode execs the built file).
if (process.argv[1]?.includes("codex-lead-tui-runtime")) {
	main().catch((err) => {
		console.error("[codex-lead-tui-runtime] fatal:", err);
		process.exit(1);
	});
}

/** Restore authority before the gateway can drain persisted inbound cursors. */
export async function startCodexLeadTuiGateway(
	gateway: { start(): Promise<void>; stop(): Promise<void> },
	subscriptions?: {
		restoreState(): Promise<void>;
		activateSource(): Promise<void>;
	},
): Promise<void> {
	await subscriptions?.restoreState();
	await gateway.start();
	try {
		await subscriptions?.activateSource();
	} catch (error) {
		await gateway.stop();
		throw error;
	}
}
