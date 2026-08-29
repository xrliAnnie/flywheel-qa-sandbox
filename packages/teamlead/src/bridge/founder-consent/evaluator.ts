/**
 * FLY-175 Track 2 — FounderConsentEvaluator (plan §1.2, §7, §9).
 *
 * Single point of consent enforcement, reached from the HTTP middleware
 * (Surface A) and the gate-response router (Surface B). Every call writes
 * exactly one `founder_consent_audit` row — the calibration corpus.
 *
 * The evaluator is purely decision logic: it never sends HTTP responses. It
 * returns a raw decision; the caller (middleware / router) maps that to
 * allow/next vs 403/503, and the operating `decisionMode` (audit_only forces
 * allow at the HTTP layer) is applied there.
 */

import type {
	AuditDecision,
	AuditDecisionSource,
	FounderConsentAuditRow,
} from "./audit.js";
import type { ConsentCache } from "./cache.js";
import {
	configHash,
	type FounderConsentConfig,
	failModeForAction,
	thresholdForAction,
} from "./config.js";
import {
	annotateRoles,
	type DiscordFetchError,
	DiscordFetcher,
	type FetchImpl,
} from "./discord-fetch.js";
import {
	assembledPromptHash,
	buildUserMessage,
	FEW_SHOT,
	SYSTEM_PROMPT,
} from "./prompt.js";

/** LLM chat interface (matches flywheel-claude-runner's AnthropicLLMClient). */
export interface LLMChat {
	chat(params: {
		model: string;
		messages: Array<{ role: string; content: string }>;
		max_tokens: number;
		system?: string;
	}): Promise<{
		content: string;
		usage?: { input_tokens?: number; output_tokens?: number };
	}>;
}

export interface AuditSink {
	insert(row: FounderConsentAuditRow): number;
}

export interface EvaluatorDeps {
	config: FounderConsentConfig;
	llm: LLMChat;
	audit: AuditSink;
	cache: ConsentCache;
	/** Injected fetch for Discord (tests). Defaults to global fetch. */
	fetchImpl?: FetchImpl;
	/** Injected clock (tests). */
	now?: () => number;
	/** ISO timestamp factory (tests). Defaults to new Date().toISOString(). */
	nowIso?: () => string;
	/** Fresh-from-Linear label fetch for `linear_live` bypass freshness. */
	linearLabelFetcher?: (issueId: string) => Promise<string[]>;
	logger?: { info: (m: string) => void; warn: (m: string) => void };
}

/** Resolved per-request context the caller assembles before evaluating. */
export interface EvaluateInput {
	action: string;
	issueId: string;
	issueIdentifier?: string;
	projectName?: string;
	executionId?: string;
	sessionRole?: string;
	sessionStatusAtCall?: string;
	/** Snapshot label set from the session row. */
	issueLabels?: string[];
	prNumber?: number;
	prHeadSha?: string | null;

	leadId?: string;
	actorSource: "http_middleware" | "gate_response_wrapper" | "dashboard";
	requestedBy?: string;
	requestReason?: string;

	/** Discord thread + channel for the issue. */
	threadId?: string;
	discordChannelId?: string;
	/** Bot token authorized to read the thread. */
	botToken?: string;
	leadBotIds?: ReadonlySet<string>;
	runnerBotIds?: ReadonlySet<string>;

	/** Surface B linkage. */
	commQuestionId?: string;
	commResponseId?: string;
	commProjectName?: string;
}

export interface EvaluateResult {
	decision: AuditDecision;
	decisionSource: AuditDecisionSource;
	confidence: number | null;
	thresholdApplied: number;
	evidenceMessageId: string | null;
	evidenceExcerpt: string | null;
	llmReason: string | null;
	auditId: number;
	/** HTTP error code hint for the caller (deny/fail rendering). */
	code?: string;
	/** Human-readable failure reason for 503 responses. */
	failReason?: string;
}

interface LLMDecision {
	allowed: boolean;
	confidence: number;
	evidence_message_id: string | null;
	evidence_excerpt: string | null;
	reason: string;
}

const HARD_TIMEOUT_MS = 3000;

export class FounderConsentEvaluator {
	private readonly d: EvaluatorDeps;
	private readonly now: () => number;
	private readonly nowIso: () => string;

	constructor(deps: EvaluatorDeps) {
		this.d = deps;
		this.now = deps.now ?? (() => Date.now());
		this.nowIso = deps.nowIso ?? (() => new Date().toISOString());
	}

	get decisionMode() {
		return this.d.config.decisionMode;
	}

	async evaluate(input: EvaluateInput): Promise<EvaluateResult> {
		const cfg = this.d.config;
		const threshold = thresholdForAction(cfg, input.action);

		// 1. Env single-issue bypass (operator escape hatch).
		if (
			cfg.bypassIssueId &&
			input.issueIdentifier &&
			cfg.bypassIssueId === input.issueIdentifier
		) {
			return this.finish(input, {
				decision: "bypass",
				decisionSource: "bypass_env",
				confidence: null,
				thresholdApplied: threshold,
				evidenceMessageId: null,
				evidenceExcerpt: null,
				llmReason: `env bypass for ${input.issueIdentifier}`,
			});
		}

		// 2. Label bypass.
		const labelBypass = await this.checkLabelBypass(input);
		if (labelBypass) {
			return this.finish(input, {
				decision: "bypass",
				decisionSource: labelBypass,
				confidence: null,
				thresholdApplied: threshold,
				evidenceMessageId: null,
				evidenceExcerpt: null,
				llmReason: `bypass label "${cfg.autoApproveLabel}"`,
			});
		}

		// 3. Cache.
		const cacheKey = this.d.cache.buildKey({
			issueId: input.issueId,
			executionId: input.executionId,
			sessionRole: input.sessionRole,
			sessionStatusAtCall: input.sessionStatusAtCall,
			action: input.action,
			prHeadSha: input.prHeadSha ?? null,
		});
		const cached = this.d.cache.get(cacheKey);
		if (cached) {
			const v = cached.value as Omit<
				EvaluateResult,
				"auditId" | "decisionSource"
			>;
			return this.finish(
				input,
				{ ...v, decisionSource: "cache" },
				{ cacheHitTs: cached.decidedAt },
			);
		}

		// 4. No thread → defensive deny (plan §9.4).
		if (!input.threadId) {
			return this.finish(input, {
				decision: "fail_closed",
				decisionSource: "fail_mode",
				confidence: null,
				thresholdApplied: threshold,
				evidenceMessageId: null,
				evidenceExcerpt: null,
				llmReason: "no Discord thread for issue",
				code: "FOUNDER_CONSENT_NO_THREAD",
				failReason: "No Discord thread found for this issue",
			});
		}

		// 5. Fetch + annotate.
		let annotated: ReturnType<typeof annotateRoles>;
		let fetchedCount = 0;
		try {
			const fetcher = new DiscordFetcher(
				input.botToken ?? "",
				this.d.fetchImpl,
			);
			const msgs = await fetcher.fetchThreadMessages(
				input.threadId,
				cfg.maxMsgs,
			);
			fetchedCount = msgs.length;
			annotated = annotateRoles(msgs, {
				founderUserId: cfg.founderUserId,
				leadBotIds: input.leadBotIds ?? new Set(),
				runnerBotIds: input.runnerBotIds ?? new Set(),
			});
		} catch (err) {
			return this.fetchFailure(input, threshold, err);
		}

		const founderCount = annotated.filter((m) => m.role === "founder").length;
		const userMessage = buildUserMessage({
			action: input.action,
			issueIdentifier: input.issueIdentifier ?? input.issueId,
			executionId: input.executionId,
			sessionRole: input.sessionRole,
			nowTs: this.nowIso(),
			windowHours: cfg.windowHours,
			messages: annotated,
		});
		const promptHash = assembledPromptHash(userMessage);
		const windowOldest = annotated.at(-1)?.ts ?? null;
		const windowNewest = annotated[0]?.ts ?? null;

		// 6. LLM with timeout + one malformed-JSON retry.
		const startMs = this.now();
		let llmRaw = "";
		let parsed: LLMDecision | null = null;
		let usage: { input_tokens?: number; output_tokens?: number } | undefined;
		try {
			for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
				const res = await this.callLLMWithTimeout(userMessage, attempt === 1);
				llmRaw = res.content;
				usage = res.usage;
				parsed = parseDecision(res.content);
			}
		} catch (err) {
			return this.llmFailure(input, threshold, err, this.now() - startMs);
		}
		const latency = this.now() - startMs;

		if (!parsed) {
			return this.finish(
				input,
				{
					decision: this.failDecision(input.action),
					decisionSource: "fail_mode",
					confidence: null,
					thresholdApplied: threshold,
					evidenceMessageId: null,
					evidenceExcerpt: null,
					llmReason: "LLM returned malformed JSON twice",
					code: "FOUNDER_CONSENT_LLM_MALFORMED",
					failReason: "Consent evaluator could not parse LLM output",
				},
				{
					llmRaw,
					promptHash,
					latency,
					usage,
					fetchedCount,
					founderCount,
					windowOldest,
					windowNewest,
				},
			);
		}

		// 7. Threshold gate. Evidence MUST be a founder message id AND that
		//    message MUST be within window_hours (deterministic recency check —
		//    Codex R1 MEDIUM: don't trust the LLM to honor the window; a stale
		//    founder "approve" must not be re-used as authorization).
		const evidenceMsg =
			parsed.evidence_message_id == null
				? undefined
				: annotated.find((m) => m.id === parsed.evidence_message_id);
		const evidenceIsFounder = evidenceMsg?.role === "founder";
		const evidenceWithinWindow = this.isWithinWindow(
			evidenceMsg?.ts,
			cfg.windowHours,
		);
		const allow =
			parsed.allowed &&
			parsed.confidence >= threshold &&
			evidenceIsFounder &&
			evidenceWithinWindow;

		const decision: AuditDecision = allow ? "allow" : "deny";
		const result = await this.finish(
			input,
			{
				decision,
				decisionSource: "llm",
				confidence: parsed.confidence,
				thresholdApplied: threshold,
				evidenceMessageId: parsed.evidence_message_id,
				evidenceExcerpt: parsed.evidence_excerpt,
				llmReason: parsed.reason,
				code: allow ? undefined : "FOUNDER_CONSENT_REQUIRED",
			},
			{
				llmRaw,
				promptHash,
				latency,
				usage,
				fetchedCount,
				founderCount,
				windowOldest,
				windowNewest,
			},
		);

		// Cache the (decision, confidence, evidence) tuple.
		this.d.cache.set(
			cacheKey,
			{
				decision,
				confidence: parsed.confidence,
				thresholdApplied: threshold,
				evidenceMessageId: parsed.evidence_message_id,
				evidenceExcerpt: parsed.evidence_excerpt,
				llmReason: parsed.reason,
				code: allow ? undefined : "FOUNDER_CONSENT_REQUIRED",
			},
			this.nowIso(),
		);

		return result;
	}

	private async checkLabelBypass(
		input: EvaluateInput,
	): Promise<AuditDecisionSource | null> {
		const cfg = this.d.config;
		if (!cfg.autoApproveLabel) return null;
		const has = (labels: string[] | undefined) =>
			!!labels?.includes(cfg.autoApproveLabel as string);

		if (
			cfg.bypassLabelFreshness === "linear_live" &&
			this.d.linearLabelFetcher
		) {
			try {
				const fresh = await this.d.linearLabelFetcher(input.issueId);
				return has(fresh) ? "bypass_label" : null;
			} catch {
				this.d.logger?.warn(
					"linear_live label fetch failed; falling back to stored snapshot",
				);
				return has(input.issueLabels) ? "bypass_label_stored_fallback" : null;
			}
		}
		return has(input.issueLabels) ? "bypass_label" : null;
	}

	private async callLLMWithTimeout(
		userMessage: string,
		stricter: boolean,
	): Promise<{
		content: string;
		usage?: { input_tokens?: number; output_tokens?: number };
	}> {
		const system = stricter
			? `${SYSTEM_PROMPT}\n\n${FEW_SHOT}\n\nIMPORTANT: Return ONLY valid strict JSON. No prose, no markdown fences.`
			: `${SYSTEM_PROMPT}\n\n${FEW_SHOT}`;
		const call = this.d.llm.chat({
			model: this.d.config.llmModel,
			system,
			messages: [{ role: "user", content: userMessage }],
			max_tokens: 512,
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`LLM timeout after ${HARD_TIMEOUT_MS}ms`)),
				HARD_TIMEOUT_MS,
			);
		});
		try {
			return await Promise.race([call, timeout]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	/**
	 * Deterministic recency check (Codex R1 MEDIUM): is `ts` within
	 * `windowHours` of now? Used to reject a stale founder message the LLM
	 * might otherwise cite as authorization. Returns false on missing/invalid
	 * ts (fail-safe: no evidence → no authorization).
	 */
	private isWithinWindow(ts: string | undefined, windowHours: number): boolean {
		if (!ts) return false;
		const tsMs = Date.parse(ts);
		const nowMs = Date.parse(this.nowIso());
		if (Number.isNaN(tsMs) || Number.isNaN(nowMs)) return false;
		// Within the window, allowing a small future skew (clock drift).
		return nowMs - tsMs <= windowHours * 3_600_000 && tsMs - nowMs <= 60_000;
	}

	private failDecision(action: string): AuditDecision {
		// "open" fail mode still records as a decision; the caller treats
		// fail_closed as block and "allow" via open mode as pass.
		return failModeForAction(this.d.config, action) === "open"
			? "allow"
			: "fail_closed";
	}

	private fetchFailure(
		input: EvaluateInput,
		threshold: number,
		err: unknown,
	): Promise<EvaluateResult> {
		const e = err as DiscordFetchError;
		const kind = e?.kind ?? "network";
		const codeMap: Record<string, string> = {
			auth: "FOUNDER_CONSENT_DISCORD_AUTH",
			not_found: "FOUNDER_CONSENT_NO_THREAD",
			rate_limited: "FOUNDER_CONSENT_DISCORD_RATELIMIT",
			upstream: "FOUNDER_CONSENT_DISCORD_UNREACHABLE",
			network: "FOUNDER_CONSENT_DISCORD_UNREACHABLE",
		};
		return this.finish(
			input,
			{
				decision: this.failDecision(input.action),
				decisionSource: "fail_mode",
				confidence: null,
				thresholdApplied: threshold,
				evidenceMessageId: null,
				evidenceExcerpt: null,
				llmReason: `Discord fetch failed: ${e?.message ?? String(err)}`,
				code: codeMap[kind] ?? "FOUNDER_CONSENT_DISCORD_UNREACHABLE",
				failReason: e?.message ?? "Discord unreachable",
			},
			{ llmRaw: `DISCORD_ERROR:${kind}` },
		);
	}

	private llmFailure(
		input: EvaluateInput,
		threshold: number,
		err: unknown,
		latency: number,
	): Promise<EvaluateResult> {
		return this.finish(
			input,
			{
				decision: this.failDecision(input.action),
				decisionSource: "fail_mode",
				confidence: null,
				thresholdApplied: threshold,
				evidenceMessageId: null,
				evidenceExcerpt: null,
				llmReason: `LLM unreachable: ${(err as Error).message}`,
				code: "FOUNDER_CONSENT_LLM_UNREACHABLE",
				failReason: (err as Error).message,
			},
			{ llmRaw: `LLM_ERROR: ${(err as Error).message}`, latency },
		);
	}

	/** Write the audit row and return the result with its auditId. */
	private async finish(
		input: EvaluateInput,
		partial: Omit<EvaluateResult, "auditId">,
		extra: {
			cacheHitTs?: string;
			llmRaw?: string;
			promptHash?: string;
			latency?: number;
			usage?: { input_tokens?: number; output_tokens?: number };
			fetchedCount?: number;
			founderCount?: number;
			windowOldest?: string | null;
			windowNewest?: string | null;
		} = {},
	): Promise<EvaluateResult> {
		const cfg = this.d.config;
		const row: FounderConsentAuditRow = {
			ts: this.nowIso(),
			evaluator_version: cfg.evaluatorVersion,
			prompt_content_hash: extra.promptHash ?? null,
			decision_mode: cfg.decisionMode,
			action: input.action,
			issue_id: input.issueId,
			issue_identifier: input.issueIdentifier ?? null,
			project_name: input.projectName ?? null,
			execution_id: input.executionId ?? null,
			session_role: input.sessionRole ?? null,
			session_status_at_decision: input.sessionStatusAtCall ?? null,
			issue_labels_json: input.issueLabels
				? JSON.stringify(input.issueLabels)
				: null,
			pr_number: input.prNumber ?? null,
			pr_head_sha: input.prHeadSha ?? null,
			actor_source: input.actorSource,
			lead_id: input.leadId ?? null,
			requested_by: input.requestedBy ?? null,
			request_reason: input.requestReason ?? null,
			decision: partial.decision,
			decision_source: partial.decisionSource,
			confidence: partial.confidence,
			threshold_applied: partial.thresholdApplied,
			evidence_message_id: partial.evidenceMessageId,
			evidence_excerpt: partial.evidenceExcerpt,
			llm_reason: partial.llmReason,
			llm_raw_response: extra.llmRaw ?? null,
			prompt_token_count: extra.usage?.input_tokens ?? null,
			completion_token_count: extra.usage?.output_tokens ?? null,
			llm_latency_ms: extra.latency ?? null,
			fetched_msg_count: extra.fetchedCount ?? null,
			founder_msg_count: extra.founderCount ?? null,
			cache_hit_ts: extra.cacheHitTs ?? null,
			thread_id: input.threadId ?? null,
			discord_channel_id: input.discordChannelId ?? null,
			founder_user_id_snapshot: cfg.founderUserId || null,
			message_window_oldest_ts: extra.windowOldest ?? null,
			message_window_newest_ts: extra.windowNewest ?? null,
			config_hash: configHash(cfg),
			comm_question_id: input.commQuestionId ?? null,
			comm_response_id: input.commResponseId ?? null,
			comm_project_name: input.commProjectName ?? null,
		};
		let auditId = -1;
		let auditFailed = false;
		try {
			auditId = this.d.audit.insert(row);
		} catch (err) {
			auditFailed = true;
			this.d.logger?.warn(
				`founder-consent audit insert failed: ${(err as Error).message}`,
			);
		}

		// Codex R1 MEDIUM: "audit row on every path" is a hard invariant for the
		// Track 3 corpus. If the audit write fails while ENFORCING, an
		// allow/bypass would let an irreversible action run with no record — so
		// downgrade it to fail_closed. In audit_only/off we never block (Phase 0
		// must not change behavior), but the failure is logged loudly above.
		if (
			auditFailed &&
			cfg.decisionMode === "enforce" &&
			(partial.decision === "allow" || partial.decision === "bypass")
		) {
			return {
				...partial,
				decision: "fail_closed",
				decisionSource: "fail_mode",
				code: "FOUNDER_CONSENT_AUDIT_FAILED",
				failReason: "consent audit write failed; failing closed",
				auditId,
			};
		}
		return { ...partial, auditId };
	}
}

/** Parse the strict-JSON decision, tolerating ```json fences. */
export function parseDecision(raw: string): LLMDecision | null {
	if (!raw) return null;
	let text = raw.trim();
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence?.[1]) text = fence[1].trim();
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) return null;
	try {
		const obj = JSON.parse(text.slice(start, end + 1)) as Record<
			string,
			unknown
		>;
		if (typeof obj.allowed !== "boolean") return null;
		const confidence =
			typeof obj.confidence === "number" ? obj.confidence : Number.NaN;
		// Codex R1 LOW: reject out-of-range confidence (a malformed `2` must
		// NOT clear the threshold). Treat as malformed -> retry/fail-closed.
		if (Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
			return null;
		}
		return {
			allowed: obj.allowed,
			confidence,
			evidence_message_id:
				typeof obj.evidence_message_id === "string"
					? obj.evidence_message_id
					: null,
			evidence_excerpt:
				typeof obj.evidence_excerpt === "string"
					? obj.evidence_excerpt.slice(0, 200)
					: null,
			reason: typeof obj.reason === "string" ? obj.reason : "",
		};
	} catch {
		return null;
	}
}
