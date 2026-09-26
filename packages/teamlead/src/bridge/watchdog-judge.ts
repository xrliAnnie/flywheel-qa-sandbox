/**
 * FLY-1048 PR-B (Tasks B1+B2+B3, absorbs FLY-976): watchdog-judge — the
 * LLM judgement layer for detection uncertainty.
 *
 * Shape (plan §3): a ONE-SHOT `codex exec` call (cheap tier, runs on the
 * Codex subscription — zero Claude quota), fed PURE TEXT (frame window +
 * truthful stage/FSM/park/comm context), returning a strict JSON verdict.
 * Invoked ONLY when the mechanical fast path is uncertain (A4 veto-2 /
 * A7 unclear) — clear mechanical verdicts never pay for a judge call.
 *
 * Hard contracts:
 *  - Process primitive = injectable spawn runner with the prompt on STDIN
 *    (codex-resume precedent) — pane text must NEVER appear in argv or env
 *    (`ps` leak; Codex design R1 #1).
 *  - Fail-closed (subscription-classifier contract): spawn error / timeout /
 *    stdout overflow / parse failure / out-of-enum verdict → null. Never
 *    throws, never fakes success — callers route null to fail-suspicious.
 *  - Ad-hoc + bounded (FLY-513 "don't spray processes" note): global
 *    single-flight queue + per-target cooldown serving the CACHED verdict.
 *  - Bounded downgrade authority (Codex design R1 #5, protects "C never
 *    missed"): see decideJudgeOutcome.
 */

import { spawn } from "node:child_process";

// ── B2: prompt + verdict contract ───────────────────────────────────────────

export interface WatchdogJudgeInput {
	/** ≥2 frames (each truncated to the last 80 lines before prompting). */
	frames: Array<{ text: string; capturedAtMs: number }>;
	/** Truthful session stage (never guessed). */
	stage?: string | null;
	fsmStatus?: string | null;
	/** Declared park tuple when one exists. */
	park?: { kind: string; reason?: string | null } | null;
	/** Recent CommDB event summaries (≤10). */
	commEvents?: Array<{ kind: string; ageMs: number; summary: string }>;
	/** Error-signature kinds the mechanical layer saw (A1 table). */
	errorSignatureKinds?: string[];
}

export const JUDGE_VERDICTS = [
	"a_working",
	"b_parked",
	"c_stuck",
	"suspicious",
] as const;
export type JudgeVerdictKind = (typeof JUDGE_VERDICTS)[number];

const JUDGE_ATTRIBUTIONS = [
	"founder",
	"lead",
	"runner",
	"ci",
	"unknown",
] as const;
export type JudgeAttribution = (typeof JUDGE_ATTRIBUTIONS)[number];

export interface WatchdogJudgeVerdict {
	verdict: JudgeVerdictKind;
	attribution: JudgeAttribution;
	suggestedAction: string;
	rationale: string;
}

const FRAME_TAIL_LINES = 80;
const MAX_COMM_EVENTS = 10;

/**
 * Build the judge prompt: what stuck looks like, what healthy looks like,
 * the evidence, and a demand for JSON ONLY (generic model + good prompt —
 * no fine-tune, PRD §3.2).
 */
export function buildJudgePrompt(input: WatchdogJudgeInput): string {
	const frames = input.frames
		.map((f, i) => {
			const tail = f.text.split("\n").slice(-FRAME_TAIL_LINES).join("\n");
			return `--- frame ${i + 1} (capturedAtMs=${f.capturedAtMs}) ---\n${tail}`;
		})
		.join("\n");
	const comm = (input.commEvents ?? [])
		.slice(0, MAX_COMM_EVENTS)
		.map(
			(e) =>
				`- [${e.kind}] ${Math.round(e.ageMs / 60_000)}min ago: ${e.summary}`,
		)
		.join("\n");
	return [
		"You are a watchdog judge for an autonomous coding-agent fleet. Given",
		"consecutive terminal-pane frames of ONE agent plus its runtime context,",
		"classify its true state:",
		"- a_working: tokens/output flowing or a long healthy operation in progress.",
		"- b_parked: deliberately idle waiting on a human/gate (must match the runtime context).",
		"- c_stuck: genuinely wedged (frozen mid-operation, error loop, dead prompt with pending work).",
		"- suspicious: you cannot tell from this evidence.",
		"Stuck looks like: an error line frozen above an idle prompt across frames;",
		"the SAME error recurring while text churns; a spinner/thinking line that",
		"never advances between frames. Healthy looks like: growing output,",
		"changing spinner counters, or an idle prompt WITH a matching park/gate in",
		"the runtime context.",
		"",
		// FLY-1234 few-shot: the 2026-07-13 production false-positive formations.
		// Corroboration REQUIRED (R1 #3) — static pane text alone never earns a
		// downgrade; "pane process alive" alone is not "a build/review child is
		// running".
		"Known healthy-but-quiet formations (real production cases, 2026-07-13).",
		"IMPORTANT: these downgrades require corroboration from the runtime",
		"context — static pane text ALONE is never sufficient:",
		"- External code/design review wait: review-driver output at the tail AND",
		"  a recent comm/stage event indicates the review started → a_working.",
		"  No such corroboration → suspicious.",
		'- Long thinking turn: a LIVE spinner line ("esc to interrupt", "✻ … Ns")',
		"  in the CURRENT frame → a_working.",
		"- Test suite / long build: runner/build output at the tail AND no error",
		"  signature AND recent comm/stage corroboration → a_working.",
		"  Stale-looking test output with no corroboration → suspicious.",
		"",
		`Runtime context: stage: ${input.stage ?? "(unknown)"} | fsm: ${input.fsmStatus ?? "(unknown)"} | park: ${
			input.park
				? `${input.park.kind}${input.park.reason ? ` (${input.park.reason})` : ""}`
				: "(none)"
		} | error signatures seen: ${(input.errorSignatureKinds ?? []).join(", ") || "(none)"}`,
		comm ? `Recent comm events:\n${comm}` : "Recent comm events: (none)",
		"",
		frames,
		"",
		"Respond with ONLY one JSON object, no prose, no code fences:",
		'{"verdict":"a_working|b_parked|c_stuck|suspicious","attribution":"founder|lead|runner|ci|unknown","suggestedAction":"<one sentence>","rationale":"<one sentence>"}',
	].join("\n");
}

/**
 * Validate a decoded candidate object against the verdict schema: both enums
 * strict, keep ONLY the schema fields (unknown fields dropped). Off-contract
 * → null (fail-closed).
 */
function validateVerdict(
	raw: Record<string, unknown>,
): WatchdogJudgeVerdict | null {
	const verdict = raw.verdict;
	const attribution = raw.attribution;
	if (
		typeof verdict === "string" &&
		(JUDGE_VERDICTS as readonly string[]).includes(verdict) &&
		typeof attribution === "string" &&
		(JUDGE_ATTRIBUTIONS as readonly string[]).includes(attribution) &&
		typeof raw.suggestedAction === "string" &&
		typeof raw.rationale === "string"
	) {
		return {
			verdict: verdict as JudgeVerdictKind,
			attribution: attribution as JudgeAttribution,
			suggestedAction: raw.suggestedAction,
			rationale: raw.rationale,
		};
	}
	return null;
}

/**
 * Extract a verdict from ONE model answer text: direct JSON.parse first (the
 * prompt demands JSON only), then a bounded object scan for prose-wrapped
 * answers ("Here is my verdict: {...}"). Last valid object wins.
 */
function parseVerdictFromText(text: string): WatchdogJudgeVerdict | null {
	try {
		const direct = JSON.parse(text) as Record<string, unknown>;
		const verdict = validateVerdict(direct);
		if (verdict) return verdict;
	} catch {
		/* fall through to the scan */
	}
	const candidates = text.match(/\{[^{}]*"verdict"[^{}]*\}/g) ?? [];
	for (let i = candidates.length - 1; i >= 0; i--) {
		try {
			const verdict = validateVerdict(
				JSON.parse(candidates[i]!) as Record<string, unknown>,
			);
			if (verdict) return verdict;
		} catch {
			/* try the next candidate */
		}
	}
	return null;
}

/**
 * Parse the judge child's stdout into a verdict. Anything off-contract →
 * null (fail-closed).
 *
 * FLY-1234 QA N-to-N (CONFIRMED HIGH, evidence commit ac026780a): real
 * `codex exec --json` emits JSONL — the model's answer is an ESCAPED string
 * inside `{"type":"item.completed","item":{"type":"agent_message","text":
 * "{\"verdict\":…}"}}`. The old bare-object regex could NEVER match that
 * (escaped quotes), so every real judge call failed closed to null and the
 * confirm layer fail-opened to `judge_unavailable` — the model answered
 * correctly and the parser threw the answer away. Contract now:
 *  1. JSONL envelope FIRST: per line, tolerate non-JSON lines, collect every
 *     `item.completed` agent_message text, take the LAST one that yields a
 *     valid verdict (multi-item tolerant);
 *  2. legacy bare scan as FALLBACK for non-JSONL runners (test doubles /
 *     FLYWHEEL_WATCHDOG_JUDGE_BIN overrides that print the verdict directly).
 */
export function parseJudgeVerdict(stdout: string): WatchdogJudgeVerdict | null {
	const agentTexts: string[] = [];
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		try {
			const event = JSON.parse(trimmed) as {
				type?: unknown;
				item?: { type?: unknown; text?: unknown };
			};
			if (
				event.type === "item.completed" &&
				event.item?.type === "agent_message" &&
				typeof event.item.text === "string"
			) {
				agentTexts.push(event.item.text);
			}
		} catch {
			/* not a JSON line — skip (codex may interleave logs) */
		}
	}
	for (let i = agentTexts.length - 1; i >= 0; i--) {
		const verdict = parseVerdictFromText(agentTexts[i]!);
		if (verdict) return verdict;
	}
	// Legacy fallback: bare verdict object directly in stdout.
	return parseVerdictFromText(stdout);
}

// ── B1: argv / env / spawn contracts ────────────────────────────────────────

/**
 * One-shot codex argv (codex-resume fresh-mode shape, read-only sandbox):
 * `exec --json -C <repoRoot> -s read-only [-m <model>] -` — the trailing "-"
 * makes codex read the prompt from STDIN (zero shell/argv interpolation).
 */
export function buildJudgeArgv(opts: {
	repoRoot: string;
	env: NodeJS.ProcessEnv;
}): { bin: string; argv: string[] } {
	const bin =
		opts.env.FLYWHEEL_WATCHDOG_JUDGE_BIN?.trim() ||
		opts.env.FLYWHEEL_CODEX_BIN?.trim() ||
		"codex-with-fallback";
	const argv = ["exec", "--json", "-C", opts.repoRoot, "-s", "read-only"];
	const model = opts.env.FLYWHEEL_WATCHDOG_JUDGE_MODEL?.trim();
	if (model) argv.push("-m", model);
	argv.push("-");
	return { bin, argv };
}

/**
 * Child-env wash: anything token/secret/key/password-shaped plus the
 * GH_TOKEN family never reaches the judge child (codex reads its own auth
 * from CODEX_HOME files, not env). Over-removal is safe; under-removal is not.
 */
export function washJudgeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const washed: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(env)) {
		if (/TOKEN|SECRET|PASSWORD|(?:^|_)KEY(?:_|$)|API_KEY/i.test(k)) continue;
		washed[k] = v;
	}
	for (const k of [
		"GH_TOKEN",
		"GITHUB_TOKEN",
		"GH_ENTERPRISE_TOKEN",
		"GITHUB_ENTERPRISE_TOKEN",
	]) {
		delete washed[k];
	}
	return washed;
}

export interface JudgeSpawnResult {
	code: number;
	stdout: string;
	timedOut: boolean;
}

export type JudgeSpawnRunner = (opts: {
	bin: string;
	argv: string[];
	stdin: string;
	env: NodeJS.ProcessEnv;
	timeoutMs: number;
	maxStdoutBytes: number;
}) => Promise<JudgeSpawnResult>;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_STDOUT_BYTES = 1_048_576; // 1MB
const DEFAULT_COOLDOWN_MS = 600_000; // 10min

/**
 * Real spawn runner: prompt on stdin, stdout bounded (overflow → SIGKILL +
 * timedOut-equivalent failure), timeout → SIGKILL. Never rejects.
 */
export const defaultJudgeSpawnRunner: JudgeSpawnRunner = (opts) =>
	new Promise((resolve) => {
		let stdout = "";
		let done = false;
		let timedOut = false;
		// detached → own process group, so timeout/overflow kills the WHOLE
		// tree (codex spawns children; plan B1 demands tree kill).
		const child = spawn(opts.bin, opts.argv, {
			stdio: ["pipe", "pipe", "ignore"],
			env: opts.env,
			detached: true,
		});
		const finish = (code: number) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve({ code, stdout, timedOut });
		};
		const killTree = () => {
			try {
				if (child.pid)
					process.kill(-child.pid, "SIGKILL"); // whole group
				else child.kill("SIGKILL");
			} catch {
				try {
					child.kill("SIGKILL");
				} catch {
					/* already dead */
				}
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			killTree();
		}, opts.timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf-8");
			if (stdout.length > opts.maxStdoutBytes) {
				timedOut = true; // overflow treated as a bounded failure
				killTree();
			}
		});
		child.on("error", () => finish(127));
		child.on("close", (code) => finish(code ?? 1));
		try {
			child.stdin.write(opts.stdin);
			child.stdin.end();
		} catch {
			/* close event carries the failure */
		}
	});

export interface WatchdogJudge {
	/** null = judge unavailable/failed (fail-closed) → caller goes fail-suspicious. */
	judge(
		targetKey: string,
		input: WatchdogJudgeInput,
	): Promise<WatchdogJudgeVerdict | null>;
}

export interface WatchdogJudgeDeps {
	repoRoot: string;
	env?: NodeJS.ProcessEnv;
	spawnRunner?: JudgeSpawnRunner;
	timeoutMs?: number;
	maxStdoutBytes?: number;
	/** Per-target cooldown; within it the CACHED verdict is served (no spawn). */
	cooldownMs?: number;
	now?: () => number;
	logger?: (msg: string) => void;
}

export function createWatchdogJudge(deps: WatchdogJudgeDeps): WatchdogJudge {
	const env = deps.env ?? process.env;
	const spawnRunner = deps.spawnRunner ?? defaultJudgeSpawnRunner;
	const now = deps.now ?? (() => Date.now());
	const logger =
		deps.logger ?? ((m: string) => console.log(`[watchdog-judge] ${m}`));
	const timeoutMs =
		deps.timeoutMs ??
		positiveInt(env.FLYWHEEL_WATCHDOG_JUDGE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
	const cooldownMs =
		deps.cooldownMs ??
		positiveInt(env.FLYWHEEL_JUDGE_COOLDOWN_MS, DEFAULT_COOLDOWN_MS);
	const maxStdoutBytes = deps.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;

	/** Per-target verdict cache (successful verdicts only). */
	const cache = new Map<
		string,
		{ verdict: WatchdogJudgeVerdict; atMs: number }
	>();
	/** Global single-flight queue: at most ONE codex child at a time. */
	let queueTail: Promise<unknown> = Promise.resolve();

	return {
		async judge(targetKey, input) {
			const cached = cache.get(targetKey);
			if (cached && now() - cached.atMs < cooldownMs) {
				return cached.verdict;
			}
			const run = queueTail.then(
				async (): Promise<WatchdogJudgeVerdict | null> => {
					// Re-check after waiting in the queue (a concurrent call for the
					// same target may have just populated the cache).
					const fresh = cache.get(targetKey);
					if (fresh && now() - fresh.atMs < cooldownMs) return fresh.verdict;
					try {
						const { bin, argv } = buildJudgeArgv({
							repoRoot: deps.repoRoot,
							env,
						});
						const result = await spawnRunner({
							bin,
							argv,
							stdin: buildJudgePrompt(input),
							env: washJudgeEnv(env),
							timeoutMs,
							maxStdoutBytes,
						});
						if (result.timedOut || result.code !== 0) {
							logger(
								`judge failed for ${targetKey}: code=${result.code} timedOut=${result.timedOut}`,
							);
							return null;
						}
						const verdict = parseJudgeVerdict(result.stdout);
						if (verdict === null) {
							logger(`judge unparseable verdict for ${targetKey}`);
							return null;
						}
						cache.set(targetKey, { verdict, atMs: now() });
						return verdict;
					} catch (err) {
						logger(
							`judge threw for ${targetKey} (fail-closed): ${(err as Error).message}`,
						);
						return null;
					}
				},
			);
			// The queue must survive failures (tail never rejects).
			queueTail = run.catch(() => undefined);
			return run;
		},
	};
}

function positiveInt(raw: string | undefined, fallback: number): number {
	const n = Number.parseInt(raw ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ── B3: bounded downgrade authority ─────────────────────────────────────────

export interface JudgeOutcome {
	action: "suppress" | "escalate" | "suspicious";
	/** For suppress: how long the target stays quiet before re-evaluation. */
	ttlMs?: number;
}

const DEFAULT_SUPPRESS_TTL_MS = 1_200_000; // 20min

/**
 * The judge can only DOWNGRADE what is mechanically ambiguous (Codex design
 * R1 #5, "C is never missed"):
 *  - a HIGH-CONFIDENCE mechanical C (repeated error signature / clean
 *    silence) should never have reached the judge — an a/b verdict there is
 *    treated as `suspicious`, never as a downgrade;
 *  - `b_parked` needs mechanical corroboration (declared park / pending gate
 *    / awaiting status) — a verdict on model rationale alone is `suspicious`;
 *  - accepted a/b → `suppress` with a TTL (the target re-enters the
 *    suspicion queue after expiry; the episode is never closed for good);
 *  - c_stuck → `escalate`; suspicious/null → `suspicious` (never silent).
 */
export function decideJudgeOutcome(
	verdict: WatchdogJudgeVerdict | null,
	opts: {
		highConfidenceC: boolean;
		mechanicalParkEvidence: boolean;
		suppressTtlMs?: number;
	},
): JudgeOutcome {
	if (verdict === null) return { action: "suspicious" };
	if (
		opts.highConfidenceC &&
		(verdict.verdict === "a_working" || verdict.verdict === "b_parked")
	) {
		return { action: "suspicious" };
	}
	switch (verdict.verdict) {
		case "c_stuck":
			return { action: "escalate" };
		case "suspicious":
			return { action: "suspicious" };
		case "b_parked":
			if (!opts.mechanicalParkEvidence) return { action: "suspicious" };
			return {
				action: "suppress",
				ttlMs: opts.suppressTtlMs ?? DEFAULT_SUPPRESS_TTL_MS,
			};
		case "a_working":
			return {
				action: "suppress",
				ttlMs: opts.suppressTtlMs ?? DEFAULT_SUPPRESS_TTL_MS,
			};
	}
}

// ── B3: suspicious-report routing (the judge sits in front of the deliverer) ─

import type { SuspiciousReport } from "./detection-suspicious.js";

/**
 * FLY-1234 (R2 #2 + R3 #1): the structured per-call routing decision. A
 * discriminated union so illegal outcome/decision combinations are
 * unconstructible at the type level. `unavailable` covers every delivered
 * path where the judge did not answer (env off / no frames / null verdict /
 * routing threw); `suspicious` also covers b_parked-without-evidence (the
 * verdict was answered but demoted by decideJudgeOutcome).
 */
export type JudgeDecision =
	| { outcome: "suppressed"; decision: "a_working" | "b_parked" }
	| {
			outcome: "delivered";
			decision: "c_stuck" | "suspicious" | "unavailable";
	  };

export interface SuspiciousJudgeRoutingDeps {
	/** Read at CALL time (FLYWHEEL_WATCHDOG_JUDGE === "1") so live flips apply. */
	judgeEnabled: () => boolean;
	judge: WatchdogJudge;
	/** The A5 fail-suspicious deliverer (PR-A behavior). */
	deliver: (report: SuspiciousReport) => void;
	/** session_events audit — a suppression MUST leave a durable trace. */
	auditSuppression: (
		report: SuspiciousReport,
		verdict: WatchdogJudgeVerdict,
		ttlMs: number,
	) => void;
	/** Durable machine-readable confirmed-C record (Codex PR-B R1 MEDIUM):
	 * the PR-C unified escalation flow consumes this event as its judge-
	 * confirmed case-c input — the annotated Lead-face reason alone is not
	 * reliably parseable. Best-effort; failure never blocks delivery. */
	auditConfirmedStuck?: (
		report: SuspiciousReport,
		verdict: WatchdogJudgeVerdict,
	) => void;
	/** Mechanical corroboration for b_parked (declared park / pending gate /
	 * awaiting status). Lead targets: always false. */
	mechanicalParkEvidence: (report: SuspiciousReport) => boolean;
	/** Build the judge input from the report; null = insufficient evidence
	 * (fewer than 2 frames) → skip the judge, deliver directly. */
	buildJudgeInput: (report: SuspiciousReport) => WatchdogJudgeInput | null;
	/**
	 * FLY-1234 (R3 #1): optional per-call structured decision sink. EVERY
	 * terminal path of routeSuspiciousReport (env off / no input / a / b / c /
	 * suspicious / null / catch) converges to an exactly-once finish(decision)
	 * — callers must never reverse-engineer the decision from deliver/audit
	 * callbacks. Absent → byte-compat (suspicious pipeline unchanged).
	 */
	onDecision?: (decision: JudgeDecision) => void;
	/**
	 * FLY-1234 (R2 #1 / R3 #4): optional judge cooldown-cache key derivation.
	 * Default = `report.targetKey` (suspicious pipeline: zero change). The
	 * heartbeat confirm layer injects an evidence-identity hash so a cached
	 * verdict never outlives the evidence it judged. `report.targetKey` itself
	 * ALWAYS stays the true execId — owner resolution, getSession,
	 * mechanicalParkEvidence and audit rows must never see a derived key.
	 */
	judgeCacheKey?: (
		report: SuspiciousReport,
		input: WatchdogJudgeInput,
	) => string;
	logger?: (msg: string) => void;
}

/**
 * FLY-1048 PR-B (B3): route a mechanical-uncertain report through the judge.
 * Env off / no frames → PR-A behavior (deliver). Accepted a/b → suppress +
 * audit (no Lead event; the target re-enters the suspicion queue after the
 * TTL — the episode is never closed for good). c_stuck / suspicious / null →
 * deliver, never silent; c_stuck annotates the verdict into the reason (the
 * PR-C unified escalation flow picks this up as its confirmed-c input).
 * Every failure path fail-closes to DELIVERY — a routing bug must never
 * swallow a report.
 */
export async function routeSuspiciousReport(
	deps: SuspiciousJudgeRoutingDeps,
	report: SuspiciousReport,
): Promise<"suppressed" | "delivered"> {
	const logger =
		deps.logger ?? ((m: string) => console.log(`[watchdog-judge] ${m}`));
	// FLY-1234 (R3 #1): every terminal path funnels through finish() —
	// exactly one onDecision per call, even if a sink callback throws.
	let decided = false;
	const finish = (decision: JudgeDecision): "suppressed" | "delivered" => {
		if (!decided) {
			decided = true;
			try {
				deps.onDecision?.(decision);
			} catch (err) {
				logger(
					`onDecision sink threw for ${report.targetKey} (ignored): ${(err as Error).message}`,
				);
			}
		}
		return decision.outcome;
	};
	// FLY-1234 (Codex code R1 #1): delivery is best-effort behind a
	// non-throwing wrapper — a synchronous deliver-sink throw must neither
	// double-deliver via the outer catch nor skip finish() (exactly-once
	// onDecision holds regardless of sink failures).
	const safeDeliver = (r: SuspiciousReport): void => {
		try {
			deps.deliver(r);
		} catch (err) {
			logger(
				`deliver sink threw for ${report.targetKey} (decision unchanged): ${(err as Error).message}`,
			);
		}
	};
	try {
		if (!deps.judgeEnabled()) {
			safeDeliver(report);
			return finish({ outcome: "delivered", decision: "unavailable" });
		}
		const input = deps.buildJudgeInput(report);
		if (input === null) {
			safeDeliver(report);
			return finish({ outcome: "delivered", decision: "unavailable" });
		}
		const cacheKey = deps.judgeCacheKey
			? deps.judgeCacheKey(report, input)
			: report.targetKey;
		const verdict = await deps.judge.judge(cacheKey, input);
		const outcome = decideJudgeOutcome(verdict, {
			// Reports only exist for mechanically-UNCERTAIN windows: the
			// high-confidence C paths (repeated signature / clean silence) alert
			// directly and never produce a suspicious report. The guard in
			// decideJudgeOutcome stays for the PR-C confirmed-c consumers.
			highConfidenceC: false,
			mechanicalParkEvidence: deps.mechanicalParkEvidence(report),
			suppressTtlMs: positiveInt(
				process.env.FLYWHEEL_JUDGE_SUPPRESS_TTL_MS,
				DEFAULT_SUPPRESS_TTL_MS,
			),
		});
		if (outcome.action === "suppress" && verdict) {
			const ttlMs = outcome.ttlMs ?? 0;
			try {
				deps.auditSuppression(report, verdict, ttlMs);
			} catch (err) {
				logger(
					`suppression audit failed for ${report.targetKey} (still suppressing): ${(err as Error).message}`,
				);
			}
			return finish({
				outcome: "suppressed",
				decision: verdict.verdict === "b_parked" ? "b_parked" : "a_working",
			});
		}
		if (outcome.action === "escalate" && verdict) {
			try {
				deps.auditConfirmedStuck?.(report, verdict);
			} catch (err) {
				logger(
					`confirmed-stuck audit failed for ${report.targetKey} (still delivering): ${(err as Error).message}`,
				);
			}
			safeDeliver({
				...report,
				reason: `${report.reason} | judge verdict c_stuck (attribution=${verdict.attribution}): ${verdict.rationale}`,
			});
			return finish({ outcome: "delivered", decision: "c_stuck" });
		}
		// suspicious / null / b_parked-without-evidence → deliver (annotated
		// when the judge actually answered).
		safeDeliver(
			verdict
				? {
						...report,
						reason: `${report.reason} | judge verdict ${verdict.verdict}: ${verdict.rationale}`,
					}
				: report,
		);
		return finish({
			outcome: "delivered",
			decision: verdict ? "suspicious" : "unavailable",
		});
	} catch (err) {
		logger(
			`judge routing threw for ${report.targetKey} — fail-closed to delivery: ${(err as Error).message}`,
		);
		safeDeliver(report);
		return finish({ outcome: "delivered", decision: "unavailable" });
	}
}
