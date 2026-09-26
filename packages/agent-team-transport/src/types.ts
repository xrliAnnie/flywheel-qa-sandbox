/**
 * Vendor-neutral transport adapter types for Lead↔Runner mailbox IPC.
 *
 * Per plan v1.27.1 §2.0.3, the transport surface is split into five facets
 * (writer / reader / receiver-wake / spawn / preflight) plus an aggregate
 * `IAgentTeamTransport`. ClaudeCodeAdapter implements all five; CodexAdapter
 * implements them for real since FLY-123 Phase 1 (Spike-δ validated the
 * Codex CLI session/wake semantics on 2026-06-03).
 *
 * **Vendor neutrality discipline**: production code outside
 * `packages/agent-team-transport/src/claude/**` MUST NOT import claude-code
 * internals. Path resolution always goes through `IAgentTeamTransport`
 * helpers (`getInboxPath`, `getStateDir`). A CI grep gate enforces this.
 */

// ============================================================================
// Logger (minimal interface — full ILogger lives in flywheel-core)
// ============================================================================

export interface ILogger {
	debug(message: string, context?: Record<string, unknown>): void;
	info(message: string, context?: Record<string, unknown>): void;
	warn(message: string, context?: Record<string, unknown>): void;
	error(message: string, context?: Record<string, unknown>): void;
}

// ============================================================================
// Semantic payload (vendor-neutral)
// ============================================================================

/**
 * Caller-facing message payload. Vendor-neutral: each adapter projects this
 * onto its own wire format.
 *
 * Idempotency contract (Codex r4 high #1):
 * - Set `metadata.flywheelId` to a caller-stable opaque string for idempotent
 *   writes. Most callers have a natural source: await-mcp uses `request_id`,
 *   Bridge actions use `eventId`, Lead respond uses source-message id.
 * - Omit `flywheelId` for best-effort writes (no dedupe — retries may produce
 *   duplicates; caller knowingly opts out).
 */
export interface MailboxPayload {
	from: string;
	to: string;
	content: string;
	metadata?: MailboxMetadata;
}

export interface MailboxMetadata {
	/**
	 * Caller-provided opaque idempotency key. If set, adapter checks sidecar
	 * dedupe and skips write on hit.
	 */
	flywheelId?: string;
	execId?: string;
	requestId?: string;
	checkpoint?: string;
	[key: string]: unknown;
}

/**
 * Vendor-decoded message after read+ack. `id` is vendor-stable (claude-code
 * derives `${from}:${timestamp}`; codex uses its own scheme — stable across
 * reads of the same message). `ts` is unix milliseconds (vendor-decoded from
 * its native timestamp format).
 */
export interface MailboxMessage extends MailboxPayload {
	id: string;
	ts: number;
	read: boolean;
	deliveredAt?: number;
}

// ============================================================================
// Write side (Lead-only)
// ============================================================================

export interface MailboxWriteResult {
	flywheelId?: string;
	idempotent: boolean;
	wroteAt: number;
	/**
	 * For `idempotent: true` returns: did the prior write reach a finalized
	 * state in the underlying store?
	 *
	 * - `true` → prior write is durably recorded in the main mailbox (sidecar
	 *   has a finalized entry for this flywheelId). Retry can safely skip
	 *   `verifyLastWrite` because the write is committed (even if newer
	 *   messages have since been appended — last entry is no longer this id).
	 * - `false` → prior write is still pending (writer in flight, or died
	 *   before finalizing). Retry should NOT trust this as durable; caller
	 *   should treat as in-flight (defer to original writer who'll finalize
	 *   within ~60s, or stale-replace path if dead).
	 * - `undefined` → adapter doesn't track finalization state (best-effort
	 *   semantics — caller treats as `false` defensively).
	 *
	 * For `idempotent: false` returns: always `true` (we just wrote it +
	 * Phase C finalize completes synchronously) OR `undefined` for adapters
	 * without two-phase semantics. Caller should NOT condition on this for
	 * non-idempotent — it's always safe to verify.
	 *
	 * Per Codex r2 PR 1.3 HIGH #1 — needed to distinguish finalized vs
	 * pending idempotent so wrappers like MailboxTransport.writeVerified can
	 * make correct skip-verify decisions.
	 */
	finalized?: boolean;
}

export class MailboxWriteError extends Error {
	constructor(
		message: string,
		readonly code:
			| "lock_timeout"
			| "permission_denied"
			| "missing_dir"
			| "corrupted_json"
			| "verify_mismatch"
			| "unknown",
		readonly recipient: string,
		readonly retryable: boolean,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "MailboxWriteError";
	}
}

export interface IMailboxWriter {
	/**
	 * Write a message to recipient's mailbox. MUST be atomic and MUST throw on
	 * failure (no silent swallow per plan §2.7).
	 *
	 * If `payload.metadata.flywheelId` is set and a sidecar entry already
	 * exists for that id, returns `{ idempotent: true }` and writes nothing.
	 */
	write(args: {
		leadName: string;
		recipient: string;
		payload: MailboxPayload;
	}): Promise<MailboxWriteResult>;

	/**
	 * Read-after-write verification: throws `MailboxWriteError` (code:
	 * `verify_mismatch`) if the last entry for `expected.from`/`expected.to`
	 * does not match `expected`. Used by `MailboxTransport.writeVerified`
	 * (§2.7).
	 */
	verifyLastWrite(args: {
		leadName: string;
		recipient: string;
		expected: MailboxPayload;
	}): Promise<void>;
}

// ============================================================================
// Read side (await-mcp / Bridge route)
// ============================================================================

export interface IMailboxReader {
	/** Read all unread messages for the given agent inbox. */
	readUnread(args: {
		leadName: string;
		agentName: string;
	}): Promise<MailboxMessage[]>;

	/**
	 * Mark messages consumed. claude-code flips `read=true` in the main file;
	 * flywheel sidecar tracks `delivered_at` for idempotency.
	 */
	ack(args: {
		leadName: string;
		agentName: string;
		messageIds: string[];
	}): Promise<void>;

	/**
	 * Vendor-stable dedupe key for an individual message — used by external
	 * watchers (codex) to avoid double-injecting via tmux send-keys.
	 *
	 * For claude-code: `${from}:${timestamp}` (timestamp is the stock ISO
	 * field, stable across reads).
	 */
	dedupeKey(message: MailboxMessage): string;
}

// ============================================================================
// Receiver wake (vendor-specific — null for vendors with builtin polling)
// ============================================================================

export interface RunnerSpawnContext {
	leadName: string;
	runnerName: string;
	teamName: string;
	tmuxSession?: string;
	tmuxWindow?: string;
	[key: string]: unknown;
}

export interface IMailboxWatcher {
	/** Begin monitoring + dedupe. */
	start(): Promise<void>;
	/** Graceful shutdown. */
	stop(): Promise<void>;
	/** Liveness probe (used by Bridge LeadWatchdog). */
	health(): Promise<MailboxWatcherHealth>;
	/** Optional telemetry hook fired when a deduped message is delivered. */
	onDelivered?: (msg: MailboxMessage) => void | Promise<void>;
}

export interface MailboxWatcherHealth {
	ok: boolean;
	lastEventTs?: number;
	pendingCount?: number;
}

export interface IReceiverWakeTransport {
	/**
	 * Returns null if the vendor has a builtin in-binary poller
	 * (claude-code's useInboxPoller). Returns an `IMailboxWatcher` instance
	 * otherwise (codex would return an external watcher daemon).
	 */
	createReceiver(ctx: RunnerSpawnContext): IMailboxWatcher | null;
}

// ============================================================================
// Spawn config (vendor-opaque output — TmuxAdapter / claude-lead.sh consume)
// ============================================================================

export interface RunnerSpawnConfig {
	/** Vendor-specific CLI args (caller treats as opaque list). */
	args: string[];
	/** Env vars to inject into spawn shell. */
	env: Record<string, string>;
}

export interface LeadSpawnContext {
	leadName: string;
	teamName: string;
	workspace?: string;
	parentSessionId?: string;
	[key: string]: unknown;
}

export type LeadSpawnConfig = RunnerSpawnConfig;

export interface IAgentSpawnTransport {
	buildRunnerSpawnConfig(ctx: RunnerSpawnContext): RunnerSpawnConfig;
	buildLeadSpawnConfig(ctx: LeadSpawnContext): LeadSpawnConfig;
}

// ============================================================================
// Preflight / health
// ============================================================================

export interface AvailabilitySignal {
	kind: "ok" | "warn" | "error";
	/**
	 * Free-text vendor-specific signal name. Examples:
	 *   "claude-code:tengu_amber_flint=stale-cached"
	 *   "claude-code:behavioral-probe=pass"
	 *   "codex:watcher-pid=down"
	 *
	 * Bridge alert path matches by prefix (e.g. all `kind: "error"` signals
	 * trigger a Discord alert to Annie).
	 */
	name: string;
	detail?: string;
}

export interface PreflightResult {
	ok: boolean;
	availabilitySignals: AvailabilitySignal[];
	message?: string;
}

export interface ITransportPreflight {
	/**
	 * Preflight checks that the transport is healthy enough to use.
	 *
	 * `opts.logger` is optional. Adapters MUST NOT dereference `opts.logger`
	 * unconditionally — use optional chaining (`opts?.logger?.info(...)`).
	 * Callers like Bridge `createLeadRuntime` legitimately omit the logger
	 * when they only need `PreflightResult.ok`.
	 *
	 * **History (FLY-142 verify, 2026-05-12)**: was previously
	 * `opts: { logger: ILogger }` (required). Bridge `plugin.ts` was calling
	 * `transport.preflight({})` without a logger; `ClaudeCodeAdapter` then
	 * dereferenced `opts.logger.info(...)` and threw — the throw was caught
	 * and misclassified as a `claude-code:cli-not-found` error signal, so
	 * preflight returned `{ok: false, message: "claude CLI not found..."}`
	 * even when the CLI was healthy. Bridge skipped runtime registration
	 * for every Lead, and the FLY-142 wake bug fix was never actually
	 * deployed. Optional now to remove the footgun.
	 */
	preflight(opts?: { logger?: ILogger }): Promise<PreflightResult>;
}

// ============================================================================
// Capabilities (vendor-leak-free per Codex r1 medium #7)
// ============================================================================

export interface TransportCapabilities {
	/**
	 * `builtin-receiver`: vendor binary polls mailbox itself (claude-code).
	 * `external-watcher`: needs `IMailboxWatcher` + tmux send-keys (codex).
	 * `push-only`: no polling at all — sender's responsibility to push.
	 */
	wakeMode: "builtin-receiver" | "external-watcher" | "push-only";
	/** Whether `preflight()` is reliable enough to gate boot on. */
	preflightIsHardGate: boolean;
	/**
	 * Whether the adapter preserves `metadata` round-trip. claude-code sidecar
	 * preserves; codex up to vendor.
	 */
	preservesMetadata: boolean;
	/** Flywheel-imposed cap on payload bytes per write. */
	maxPayloadBytes: number;
	/**
	 * Whether spawn requires a stable agent identity across restarts (drives
	 * team-file member persistence requirements).
	 */
	requiresStableAgentIdentity: boolean;
}

// ============================================================================
// Aggregate adapter interface
// ============================================================================

export interface IAgentTeamTransport
	extends IMailboxWriter,
		IMailboxReader,
		IReceiverWakeTransport,
		IAgentSpawnTransport,
		ITransportPreflight {
	/** "claude-code" | "codex" | future vendor */
	vendorId(): string;
	capabilities(): TransportCapabilities;
	/**
	 * Vendor-aware path resolver. Production code MUST NOT hardcode
	 * `~/.claude/teams/...` literals — always go through this helper.
	 */
	getInboxPath(leadName: string, agentName: string): string;
	/** Vendor-neutral state dir for structured-inbox / sentinel files. */
	getStateDir(): string;
}
