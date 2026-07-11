import type { FounderConsentConfig } from "./founder-consent/config.js";
import type { RunnerAdmissionController } from "./runner-admission.js";

export function sqliteDatetime(): string {
	return new Date()
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d+Z$/, "");
}

export interface BridgeConfig {
	host: string;
	port: number;
	dbPath: string;
	ingestToken?: string;
	apiToken?: string;
	/** @deprecated Pre-FLY-163 default fallback channel. Per-lead chatChannel now drives notifications. */
	notificationChannel: string;
	/** Default lead agent ID for project-less notifications (e.g., CIPHER proposals). */
	defaultLeadAgentId: string;
	stuckThresholdMinutes: number;
	stuckCheckIntervalMs: number;
	orphanThresholdMinutes: number;
	discordBotToken?: string;
	// GEO-187: Linear API proxy
	linearApiKey?: string;
	discordGuildId?: string;
	/**
	 * FLY-123 WS-D (P4): runner admission by REAL resource pressure (load +
	 * memory). Replaces the retired `maxConcurrentRunners` hard cap (GEO-267) —
	 * runner count is uncapped; admission defers only under genuine
	 * load/memory pressure, never because of a count.
	 */
	runnerAdmission: RunnerAdmissionController;
	/** FLY-91: Enable per-issue chat thread creation in chatChannel. */
	chatThreadsEnabled?: boolean;
	/** FLY-91: Discord user ID to auto-add as thread member (e.g., server owner). */
	discordOwnerUserId?: string;
	/**
	 * FLY-162: Enable `/api/chat-threads/send` (Lead `reply.by_issue`) and
	 * `/api/chat-threads/by-thread/:threadId` (inbound enrichment) routes.
	 * Requires `apiToken` to be set — `loadConfig()` throws if true and
	 * `apiToken` is missing/empty, since the route posts as the Discord bot
	 * and must not be exposed unauthenticated.
	 */
	replyByIssueEnabled: boolean;
	/**
	 * FLY-162 Layer 2: Enable `POST /api/discord/reply-guard`. The forked
	 * Discord plugin calls it before sending a reply/edit so the Bridge can
	 * deny issue content posted at a Lead's chatChannel top level. Requires
	 * `apiToken` — `loadConfig()` throws if true and `apiToken` is missing.
	 */
	replyGuardEnabled: boolean;
	/**
	 * FLY-162 Layer 2: configured team prefixes (e.g. ["FLY","GEO"]) the guard
	 * counts as issue tokens. Normalized to uppercase at load time.
	 */
	issuePrefixes: string[];
	/**
	 * FLY-175 Track 2: founder-consent hard gate. Parsed from
	 * `FLYWHEEL_FOUNDER_CONSENT_*` env. Optional — when absent or
	 * `decisionMode === "off"` the evaluator is never constructed and Bridge
	 * behavior is byte-identical to pre-Track-2.
	 */
	founderConsent?: FounderConsentConfig;
	/**
	 * FLY-1018 M4: scoped token for the gemini-agent tool surface
	 * (`TEAMLEAD_GEMINI_AGENT_TOKEN`). When set, a Bearer of this value
	 * reaches ONLY the 6+1 tool routes (server-side enforcement of the
	 * client-side whitelist). Unset = byte-compatible zero change.
	 * loadConfig() refuses to start when it equals the master apiToken and
	 * ignores it (with an ERROR log) when apiToken is unset.
	 */
	geminiAgentToken?: string;
}

// ──────────────────────────────────────────────────────────────────────
// FLY-162: HTTP route contracts for Lead reply-by-issue (P1)
// Used by routes in P2/P3 to assemble responses with stable shapes.
// ──────────────────────────────────────────────────────────────────────

/**
 * FLY-162 P2: Request body for `POST /api/chat-threads/send`.
 * Exactly one of `issueId` or `issueIdentifier` must be present (both
 * is also valid; if both are given, Bridge resolves identifier → UUID
 * and validates they match — otherwise 400).
 */
export interface LeadReplyByIssueRequest {
	issueId?: string;
	issueIdentifier?: string;
	channelId: string;
	leadId: string;
	projectName: string;
	text: string;
	replyTo?: string;
}

/** FLY-162 P2: Successful `POST /api/chat-threads/send` response. */
export interface LeadReplyByIssueResponse {
	threadId: string;
	messageIds: string[];
	/** true when `ensureChatThread()` was invoked (row was missing). */
	created: boolean;
}

/**
 * FLY-162 P2: Partial-failure envelope for `POST /api/chat-threads/send`
 * (HTTP 502 when split text fails mid-way). Lead resends `remainingText`
 * directly as `text` in a follow-up call — does NOT resend the whole
 * original text. `remainingText` is the unsent suffix after
 * `splitDiscordMessage` normalization (helper trims edges); test
 * assertions should compare against helper output, not byte-identical
 * to original.
 */
export interface LeadReplyByIssuePartialFailure {
	error: string;
	threadId: string;
	messageIds: string[];
	chunksSent: number;
	chunksTotal: number;
	failedChunkIndex: number;
	remainingText: string;
}

/**
 * FLY-162 P3: Response shape for
 * `GET /api/chat-threads/by-thread/:threadId`. `issueIdentifier`,
 * `issueTitle`, and `projectName` are nullable — present when
 * `getSessionByIssue` has a row, null otherwise (still 200).
 */
export interface ByThreadLookupResponse {
	threadId: string;
	channelId: string;
	issueId: string;
	issueIdentifier: string | null;
	issueTitle: string | null;
	projectName: string | null;
}
