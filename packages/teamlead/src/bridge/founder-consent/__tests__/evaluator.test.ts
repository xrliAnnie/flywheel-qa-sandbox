import { describe, expect, it, vi } from "vitest";
import type { FounderConsentAuditRow } from "../audit.js";
import { ConsentCache } from "../cache.js";
import { parseFounderConsentConfig } from "../config.js";
import type { FetchImpl } from "../discord-fetch.js";
import {
	type EvaluateInput,
	FounderConsentEvaluator,
	type LLMChat,
	parseDecision,
} from "../evaluator.js";

const FOUNDER = "founder-123";

function mkConfig(over: Record<string, string | undefined> = {}) {
	return parseFounderConsentConfig(
		{
			FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE: "enforce",
			FLYWHEEL_FOUNDER_USER_ID: FOUNDER,
			...over,
		} as NodeJS.ProcessEnv,
		() => {},
	);
}

function mkAudit() {
	const rows: FounderConsentAuditRow[] = [];
	return {
		rows,
		insert(row: FounderConsentAuditRow) {
			rows.push(row);
			return rows.length;
		},
	};
}

function mkFetch(
	messages: Array<{
		id: string;
		content: string;
		authorId: string;
		bot?: boolean;
		ts?: string;
	}>,
	opts: { status?: number; throws?: boolean } = {},
): FetchImpl {
	return async () => {
		if (opts.throws) throw new Error("network down");
		const status = opts.status ?? 200;
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () =>
				messages.map((m) => ({
					id: m.id,
					content: m.content,
					timestamp: m.ts ?? "2026-05-28T10:00:00Z",
					author: { id: m.authorId, bot: m.bot ?? false },
				})),
		};
	};
}

function mkLLM(decision: unknown): LLMChat {
	return {
		chat: vi.fn(async () => ({
			content:
				typeof decision === "string" ? decision : JSON.stringify(decision),
			usage: { input_tokens: 10, output_tokens: 5 },
		})),
	};
}

const baseInput = (over: Partial<EvaluateInput> = {}): EvaluateInput => ({
	action: "close_tmux",
	issueId: "issue-uuid-1",
	issueIdentifier: "FLY-175",
	projectName: "Flywheel",
	executionId: "exec-1",
	sessionRole: "main",
	sessionStatusAtCall: "needs_review",
	actorSource: "http_middleware",
	threadId: "thread-1",
	botToken: "bot-token",
	leadBotIds: new Set<string>(),
	runnerBotIds: new Set<string>(),
	...over,
});

function mkEvaluator(deps: {
	config?: ReturnType<typeof mkConfig>;
	llm?: LLMChat;
	fetchImpl?: FetchImpl;
	audit?: ReturnType<typeof mkAudit>;
	cache?: ConsentCache;
}) {
	const audit = deps.audit ?? mkAudit();
	const config = deps.config ?? mkConfig();
	const ev = new FounderConsentEvaluator({
		config,
		llm: deps.llm ?? mkLLM({ allowed: false, confidence: 0 }),
		audit,
		cache: deps.cache ?? new ConsentCache(60, () => 0),
		fetchImpl: deps.fetchImpl ?? mkFetch([]),
		now: () => 0,
		nowIso: () => "2026-05-28T10:00:01Z",
	});
	return { ev, audit, config };
}

describe("FounderConsentEvaluator decision paths", () => {
	it("ALLOW: founder directive + high confidence + founder evidence", async () => {
		const { ev, audit } = mkEvaluator({
			fetchImpl: mkFetch([
				{ id: "m-f", content: "停 FLY-175", authorId: FOUNDER },
			]),
			llm: mkLLM({
				allowed: true,
				confidence: 0.95,
				evidence_message_id: "m-f",
				evidence_excerpt: "停 FLY-175",
				reason: "explicit stop",
			}),
		});
		const r = await ev.evaluate(baseInput());
		expect(r.decision).toBe("allow");
		expect(r.decisionSource).toBe("llm");
		expect(audit.rows).toHaveLength(1);
		expect(audit.rows[0]?.decision).toBe("allow");
	});

	it("DENY: LLM not allowed", async () => {
		const { ev } = mkEvaluator({
			fetchImpl: mkFetch([
				{ id: "m-f", content: "QA 通过了吗", authorId: FOUNDER },
			]),
			llm: mkLLM({
				allowed: false,
				confidence: 0,
				evidence_message_id: null,
				evidence_excerpt: null,
				reason: "status question",
			}),
		});
		const r = await ev.evaluate(baseInput());
		expect(r.decision).toBe("deny");
		expect(r.code).toBe("FOUNDER_CONSENT_REQUIRED");
	});

	it("DENY: allowed but confidence below threshold", async () => {
		const { ev } = mkEvaluator({
			fetchImpl: mkFetch([{ id: "m-f", content: "OK", authorId: FOUNDER }]),
			llm: mkLLM({
				allowed: true,
				confidence: 0.7,
				evidence_message_id: "m-f",
				evidence_excerpt: "OK",
				reason: "ambiguous",
			}),
		});
		const r = await ev.evaluate(baseInput());
		expect(r.decision).toBe("deny");
	});

	it("DENY: evidence message is NOT a founder message", async () => {
		const { ev } = mkEvaluator({
			fetchImpl: mkFetch([
				{ id: "m-lead", content: "ship?", authorId: "lead-bot", bot: true },
			]),
			llm: mkLLM({
				allowed: true,
				confidence: 0.99,
				evidence_message_id: "m-lead", // not a founder message
				evidence_excerpt: "ship?",
				reason: "bogus evidence",
			}),
		});
		const r = await ev.evaluate(baseInput());
		expect(r.decision).toBe("deny");
	});

	it("BYPASS: env single-issue bypass skips the LLM", async () => {
		const llm = mkLLM({ allowed: false, confidence: 0 });
		const { ev, audit } = mkEvaluator({
			config: mkConfig({ FLYWHEEL_FOUNDER_CONSENT_BYPASS_ISSUE_ID: "FLY-175" }),
			llm,
		});
		const r = await ev.evaluate(baseInput());
		expect(r.decision).toBe("bypass");
		expect(r.decisionSource).toBe("bypass_env");
		expect(llm.chat).not.toHaveBeenCalled();
		expect(audit.rows[0]?.decision).toBe("bypass");
	});

	it("BYPASS: auto-approve label (stored snapshot)", async () => {
		const llm = mkLLM({ allowed: false, confidence: 0 });
		const { ev } = mkEvaluator({
			config: mkConfig({
				FLYWHEEL_FOUNDER_CONSENT_BYPASS_LABEL: "auto-approve-eligible",
			}),
			llm,
		});
		const r = await ev.evaluate(
			baseInput({ issueLabels: ["auto-approve-eligible"] }),
		);
		expect(r.decision).toBe("bypass");
		expect(r.decisionSource).toBe("bypass_label");
		expect(llm.chat).not.toHaveBeenCalled();
	});

	it("FAIL-CLOSED: no thread", async () => {
		const { ev } = mkEvaluator({});
		const r = await ev.evaluate(baseInput({ threadId: undefined }));
		expect(r.decision).toBe("fail_closed");
		expect(r.code).toBe("FOUNDER_CONSENT_NO_THREAD");
	});

	it("FAIL-CLOSED: Discord fetch 5xx (closed mode)", async () => {
		const { ev } = mkEvaluator({ fetchImpl: mkFetch([], { status: 500 }) });
		const r = await ev.evaluate(baseInput());
		expect(r.decision).toBe("fail_closed");
		expect(r.code).toBe("FOUNDER_CONSENT_DISCORD_UNREACHABLE");
	});

	it("FAIL-OPEN: per-action open mode lets a fetch failure through", async () => {
		const { ev } = mkEvaluator({
			config: mkConfig({
				FLYWHEEL_FOUNDER_CONSENT_FAIL_MODE_PER_ACTION: '{"close_tmux":"open"}',
			}),
			fetchImpl: mkFetch([], { throws: true }),
		});
		const r = await ev.evaluate(baseInput());
		expect(r.decision).toBe("allow");
		expect(r.decisionSource).toBe("fail_mode");
	});

	it("FAIL-CLOSED: malformed JSON twice", async () => {
		const { ev } = mkEvaluator({
			fetchImpl: mkFetch([{ id: "m-f", content: "停", authorId: FOUNDER }]),
			llm: mkLLM("not json at all"),
		});
		const r = await ev.evaluate(baseInput());
		expect(r.decision).toBe("fail_closed");
		expect(r.code).toBe("FOUNDER_CONSENT_LLM_MALFORMED");
	});

	it("CACHE: second identical call is served from cache", async () => {
		const cache = new ConsentCache(60, () => 0);
		const llm = mkLLM({
			allowed: true,
			confidence: 0.95,
			evidence_message_id: "m-f",
			evidence_excerpt: "停",
			reason: "ok",
		});
		const { ev } = mkEvaluator({
			cache,
			llm,
			fetchImpl: mkFetch([{ id: "m-f", content: "停", authorId: FOUNDER }]),
		});
		const first = await ev.evaluate(baseInput());
		const second = await ev.evaluate(baseInput());
		expect(first.decisionSource).toBe("llm");
		expect(second.decisionSource).toBe("cache");
		expect(second.decision).toBe("allow");
		expect(llm.chat as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
	});

	it("DENY: founder evidence is stale (outside window_hours)", async () => {
		// nowIso = 2026-05-28T10:00:01Z, window 24h; evidence 48h old.
		const { ev } = mkEvaluator({
			fetchImpl: mkFetch([
				{
					id: "m-f",
					content: "approve FLY-175",
					authorId: FOUNDER,
					ts: "2026-05-26T10:00:00Z",
				},
			]),
			llm: mkLLM({
				allowed: true,
				confidence: 0.95,
				evidence_message_id: "m-f",
				evidence_excerpt: "approve FLY-175",
				reason: "approve (but stale)",
			}),
		});
		const r = await ev.evaluate(baseInput());
		expect(r.decision).toBe("deny"); // deterministic recency override
	});

	it("FAIL-CLOSED (enforce): audit insert failure downgrades an allow", async () => {
		const throwingAudit = {
			rows: [] as FounderConsentAuditRow[],
			insert() {
				throw new Error("disk full");
			},
		};
		const { ev } = mkEvaluator({
			audit: throwingAudit as unknown as ReturnType<typeof mkAudit>,
			fetchImpl: mkFetch([{ id: "m-f", content: "停", authorId: FOUNDER }]),
			llm: mkLLM({
				allowed: true,
				confidence: 0.95,
				evidence_message_id: "m-f",
				evidence_excerpt: "停",
				reason: "ok",
			}),
		});
		const r = await ev.evaluate(baseInput());
		expect(r.decision).toBe("fail_closed");
		expect(r.code).toBe("FOUNDER_CONSENT_AUDIT_FAILED");
	});

	it("audit_only: audit insert failure still allows (Phase 0 must not block)", async () => {
		const throwingAudit = {
			insert() {
				throw new Error("disk full");
			},
		};
		const { ev } = mkEvaluator({
			config: mkConfig({
				FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE: "audit_only",
			}),
			audit: throwingAudit as unknown as ReturnType<typeof mkAudit>,
			fetchImpl: mkFetch([{ id: "m-f", content: "停", authorId: FOUNDER }]),
			llm: mkLLM({
				allowed: true,
				confidence: 0.95,
				evidence_message_id: "m-f",
				evidence_excerpt: "停",
				reason: "ok",
			}),
		});
		const r = await ev.evaluate(baseInput());
		expect(r.decision).toBe("allow"); // not blocked despite audit failure
	});

	it("writes an audit row on every evaluation", async () => {
		const { ev, audit } = mkEvaluator({
			fetchImpl: mkFetch([{ id: "m-f", content: "停", authorId: FOUNDER }]),
			llm: mkLLM({
				allowed: true,
				confidence: 0.95,
				evidence_message_id: "m-f",
				evidence_excerpt: "停",
				reason: "ok",
			}),
		});
		await ev.evaluate(baseInput({ executionId: "e1" }));
		await ev.evaluate(baseInput({ executionId: "e2" }));
		expect(audit.rows).toHaveLength(2);
		expect(audit.rows[0]?.config_hash).toBeTruthy();
		expect(audit.rows[0]?.founder_user_id_snapshot).toBe(FOUNDER);
	});
});

describe("parseDecision", () => {
	it("parses strict JSON", () => {
		expect(
			parseDecision('{"allowed":true,"confidence":0.9,"reason":"x"}'),
		).toMatchObject({ allowed: true, confidence: 0.9 });
	});
	it("strips ```json fences", () => {
		expect(
			parseDecision('```json\n{"allowed":false,"confidence":0.1}\n```'),
		).toMatchObject({ allowed: false });
	});
	it("rejects non-JSON", () => {
		expect(parseDecision("nope")).toBeNull();
	});
	it("rejects out-of-range confidence (>1 and <0)", () => {
		expect(parseDecision('{"allowed":true,"confidence":2}')).toBeNull();
		expect(parseDecision('{"allowed":true,"confidence":-0.5}')).toBeNull();
	});
	it("rejects missing allowed", () => {
		expect(parseDecision('{"confidence":0.5}')).toBeNull();
	});
	it("truncates evidence_excerpt to 200 chars", () => {
		const long = "x".repeat(400);
		const d = parseDecision(
			JSON.stringify({
				allowed: true,
				confidence: 0.9,
				evidence_excerpt: long,
			}),
		);
		expect(d?.evidence_excerpt?.length).toBe(200);
	});
});
