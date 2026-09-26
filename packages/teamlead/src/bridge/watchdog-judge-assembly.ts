/**
 * FLY-1234 (T3, Codex code R1 #3): the judge-routing ASSEMBLY, extracted from
 * plugin.ts so the production composition is testable (FLY-1048
 * detection-detector-wiring precedent — wiring lives in a module, plugin.ts
 * only injects its closures).
 *
 * Three exports, consumed by plugin.ts verbatim:
 *  - buildJudgeInputFromStore: the shared judge-input builder (truthful
 *    stage/FSM/comm context from the store; unparseable timestamps dropped);
 *  - createJudgeRoutingDepsFactory: ONE shared judge instance + shared
 *    audits/park-evidence/input builder, with per-caller seams injected
 *    (deliver / onConfirmedStuck / onDecision / judgeCacheKey /
 *    errorSignatureKinds). The unified-escalation side effect
 *    (notifyDetectionEpisode) is ONLY ever the suspicious pipeline's
 *    injected onConfirmedStuck — the heartbeat confirm layer never notifies
 *    (single emission right, INV-4);
 *  - createStuckConfirmRunner: the heartbeat confirm-layer glue
 *    (per-call knob parse → confirmStuckCandidate with a FRESH per-call
 *    routing closure).
 */

import { createHash } from "node:crypto";
import { CommDB } from "flywheel-comm/db";
import type { Session } from "../StateStore.js";
import { openGapReader } from "./detection-gap-scan.js";
import type {
	SuspiciousOwner,
	SuspiciousReport,
} from "./detection-suspicious.js";
import { scanErrorSignatures } from "./error-signatures.js";
import { parseSqliteUtcMs } from "./founder-notify-utils.js";
import { defaultGetCommDbPath } from "./session-capture.js";
import {
	buildHeartbeatJudgeCacheKey,
	type ConfirmLiveness,
	confirmStuckCandidate,
	type JudgeDecision,
	parseStuckConfirmKnobs,
	type StuckConfirmResult,
} from "./stuck-pane-confirm.js";
import {
	routeSuspiciousReport,
	type SuspiciousJudgeRoutingDeps,
	type WatchdogJudge,
	type WatchdogJudgeInput,
	type WatchdogJudgeVerdict,
} from "./watchdog-judge.js";

/** The narrow store surface the assembly reads/audits through. */
export interface JudgeAssemblyStore {
	getSession(executionId: string): Session | undefined;
	getEventsByExecution(
		executionId: string,
	): Array<{ event_type: string; event_id?: string; ts?: string }>;
	insertEvent(event: {
		event_id: string;
		execution_id: string;
		issue_id: string;
		project_name: string;
		event_type: string;
		severity?: string;
		payload?: unknown;
		source: string;
	}): boolean;
}

/**
 * Shared judge-input builder (extracted from plugin.ts deliverSuspicious).
 * Codex PR-B R1 LOW / R2 MEDIUM: only truthful ages reach the judge —
 * unparseable timestamps drop the event rather than presenting "0min ago".
 *
 * FLY-1234 QA N-to-N (MEDIUM): `park` is caller-supplied instead of the old
 * hardcoded null — a runner's declared park/busy marker is exactly the
 * mechanical corroboration the judge's b_parked few-shot demands, and it
 * never reached the prompt (2/2 real runs on a genuinely parked husk landed
 * `suspicious` because the model was never shown the park evidence).
 */
export function buildJudgeInputFromStore(
	store: Pick<JudgeAssemblyStore, "getSession" | "getEventsByExecution">,
	report: SuspiciousReport,
	errorSignatureKinds: string[] = [],
	now: () => number = () => Date.now(),
	park: WatchdogJudgeInput["park"] = null,
): WatchdogJudgeInput | null {
	if (!report.frames || report.frames.length < 2) return null;
	const session =
		report.targetKind === "runner"
			? store.getSession(report.targetKey)
			: undefined;
	let commEvents: WatchdogJudgeInput["commEvents"];
	if (session) {
		try {
			const nowMs = now();
			commEvents = store
				.getEventsByExecution(report.targetKey)
				.slice(-10)
				.flatMap((e) => {
					const raw = e.ts ?? "";
					const parsed = parseSqliteUtcMs(raw) ?? Date.parse(raw);
					if (parsed === null || !Number.isFinite(parsed)) return [];
					return [
						{
							kind: e.event_type,
							ageMs: Math.max(0, nowMs - parsed),
							summary: String(e.event_id ?? e.event_type).slice(0, 120),
						},
					];
				})
				.slice(0, 10);
		} catch {
			commEvents = undefined;
		}
	}
	return {
		frames: report.frames,
		stage: session?.session_stage ?? null,
		fsmStatus: session?.status ?? null,
		park,
		commEvents,
		errorSignatureKinds,
	};
}

/**
 * FLY-1234 QA (MEDIUM): the runner's currently-effective declared park/busy
 * marker (`flywheel-comm park` / `declare-state busy`) from the per-project
 * CommDB — the b_parked corroboration the judge prompt renders as `park:`.
 * Best-effort read-only probe: missing DB / read error / expired marker →
 * null (the prompt truthfully shows "(none)"; never throws into routing).
 */
export function probeDeclaredParkFromCommDb(
	executionId: string,
	commDbPath: string,
	nowMs: number,
): { kind: string; reason?: string | null } | null {
	let db: CommDB | undefined;
	try {
		db = CommDB.openReadonly(commDbPath);
		const state = db.getEffectiveDeclaredState(executionId, nowMs);
		return state ? { kind: state.kind, reason: state.reason ?? null } : null;
	} catch {
		return null;
	} finally {
		try {
			db?.close();
		} catch {
			/* best-effort */
		}
	}
}

/** Per-caller seams for one routing-deps instance. */
export interface JudgeRoutingFactoryOpts {
	deliver: (report: SuspiciousReport) => void;
	/** Unified-escalation side effect — suspicious pipeline ONLY (INV-4). */
	onConfirmedStuck?: (
		report: SuspiciousReport,
		verdict: WatchdogJudgeVerdict,
	) => void;
	onDecision?: (decision: JudgeDecision) => void;
	judgeCacheKey?: (
		report: SuspiciousReport,
		input: WatchdogJudgeInput,
	) => string;
	errorSignatureKinds?: string[];
}

export interface JudgeRoutingAssembly {
	store: JudgeAssemblyStore;
	judge: WatchdogJudge;
	/** Read at CALL time so live env flips apply. */
	judgeEnabled: () => boolean;
	/** Owner resolution (plugin closure over projects). */
	resolveOwner: (report: SuspiciousReport) => SuspiciousOwner | null;
	/** CommDB path resolver for mechanical park evidence (test seam). */
	getCommDbPath?: (projectName: string) => string;
	/**
	 * FLY-1234 QA (MEDIUM): declared park/busy probe feeding the judge
	 * prompt's `park:` line (test seam). Default: CommDB effective declared
	 * state via `getCommDbPath`.
	 */
	probeDeclaredPark?: (
		executionId: string,
		projectName: string,
	) => { kind: string; reason?: string | null } | null;
	now?: () => number;
}

/**
 * The buildJudgeRoutingDeps factory (extracted from plugin.ts). Shared parts:
 * judgeEnabled / judge instance / suppression + confirmed-stuck AUDIT rows /
 * mechanicalParkEvidence / buildJudgeInputFromStore.
 */
export function createJudgeRoutingDepsFactory(
	assembly: JudgeRoutingAssembly,
): (opts: JudgeRoutingFactoryOpts) => SuspiciousJudgeRoutingDeps {
	const { store, judge, judgeEnabled, resolveOwner } = assembly;
	const getCommDbPath = assembly.getCommDbPath ?? defaultGetCommDbPath;
	const now = assembly.now ?? (() => Date.now());
	const probeDeclaredPark =
		assembly.probeDeclaredPark ??
		((executionId: string, projectName: string) =>
			probeDeclaredParkFromCommDb(
				executionId,
				getCommDbPath(projectName),
				now(),
			));
	/** Runner targets only; any probe failure reads as "no declared park". */
	const parkFor = (r: SuspiciousReport): WatchdogJudgeInput["park"] => {
		if (r.targetKind !== "runner") return null;
		const session = store.getSession(r.targetKey);
		if (!session?.project_name) return null;
		try {
			return probeDeclaredPark(r.targetKey, session.project_name);
		} catch {
			return null;
		}
	};
	return (opts) => ({
		judgeEnabled,
		judge,
		deliver: opts.deliver,
		onDecision: opts.onDecision,
		judgeCacheKey: opts.judgeCacheKey,
		auditSuppression: (r, verdict, ttlMs) => {
			const owner = resolveOwner(r);
			store.insertEvent({
				event_id: `watchdog-judge-suppressed-${createHash("sha256")
					.update(`${r.targetKey}|${r.episodeFingerprint}|${verdict.verdict}`)
					.digest("hex")
					.slice(0, 16)}`,
				execution_id: owner?.executionId ?? r.targetKey,
				issue_id: owner?.issueId ?? "unknown",
				project_name: owner?.projectName ?? "unknown",
				event_type: "watchdog_judge_suppressed",
				severity: "info",
				payload: {
					target_kind: r.targetKind,
					target_key: r.targetKey,
					verdict: verdict.verdict,
					attribution: verdict.attribution,
					rationale: verdict.rationale,
					episode_fingerprint: r.episodeFingerprint,
					ttl_ms: ttlMs,
				},
				source: "watchdog-judge",
			});
		},
		auditConfirmedStuck: (r, verdict) => {
			const owner = resolveOwner(r);
			store.insertEvent({
				event_id: `watchdog-judge-confirmed-stuck-${createHash("sha256")
					.update(`${r.targetKey}|${r.episodeFingerprint}`)
					.digest("hex")
					.slice(0, 16)}`,
				execution_id: owner?.executionId ?? r.targetKey,
				issue_id: owner?.issueId ?? "unknown",
				project_name: owner?.projectName ?? "unknown",
				event_type: "watchdog_judge_confirmed_stuck",
				severity: "warning",
				payload: {
					target_kind: r.targetKind,
					target_key: r.targetKey,
					verdict: verdict.verdict,
					attribution: verdict.attribution,
					rationale: verdict.rationale,
					suggested_action: verdict.suggestedAction,
					episode_fingerprint: r.episodeFingerprint,
				},
				source: "watchdog-judge",
			});
			// FLY-1234 (INV-4): the unified-escalation side effect is injected —
			// only the suspicious pipeline notifies; the audit row above lands
			// for every caller.
			opts.onConfirmedStuck?.(r, verdict);
		},
		mechanicalParkEvidence: (r) => {
			// Lead targets have no park semantics; runner targets: awaiting
			// statuses or a declared park corroborate b_parked.
			if (r.targetKind !== "runner") return false;
			const session = store.getSession(r.targetKey);
			if (!session) return false;
			if (
				session.status === "awaiting_review" ||
				session.status === "approved_to_ship"
			) {
				return true;
			}
			const reader = openGapReader(getCommDbPath(session.project_name ?? ""));
			if (!reader) return false;
			try {
				const ev = reader.evidenceFor(r.targetKey, null, now());
				// Codex PR-B R1 HIGH: only a BLOCKING gate corroborates b_parked —
				// an unanswered non-blocking ask is exactly the 漏② signal and
				// must never let the judge silence it.
				return (
					ev.declaredParked === true || (ev.pendingBlockingGateCount ?? 0) > 0
				);
			} catch {
				return false;
			} finally {
				reader.close();
			}
		},
		buildJudgeInput: (r) =>
			buildJudgeInputFromStore(
				store,
				r,
				opts.errorSignatureKinds ?? [],
				now,
				parkFor(r),
			),
	});
}

/** The heartbeat confirm-layer runner glue (extracted from plugin.ts). */
export interface StuckConfirmRunnerDeps {
	buildRoutingDeps: (
		opts: JudgeRoutingFactoryOpts,
	) => SuspiciousJudgeRoutingDeps;
	probeLiveness: (session: Session) => Promise<ConfirmLiveness>;
	captureFrame: (
		session: Session,
	) => Promise<{ text: string; capturedAtMs: number } | null>;
	/** Live comm-corroboration window (stuckCommActivityMs) for the cache key. */
	commCorroborationMs: () => number;
	env?: NodeJS.ProcessEnv;
	sleep?: (ms: number) => Promise<void>;
	logger?: (msg: string) => void;
}

export function createStuckConfirmRunner(
	deps: StuckConfirmRunnerDeps,
): (session: Session) => Promise<StuckConfirmResult> {
	const env = deps.env ?? process.env;
	const sleep =
		deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const unavailable: JudgeDecision = {
		outcome: "delivered",
		decision: "unavailable",
	};
	return (session) => {
		// Per-call knob parse (call-time env reads; the boot-time parse in
		// plugin.ts owns the misconfig warn).
		const knobs = parseStuckConfirmKnobs(env);
		return confirmStuckCandidate(session, {
			probeLiveness: deps.probeLiveness,
			captureFrame: deps.captureFrame,
			frameGapMs: knobs.frameGapMs,
			deadlineMs: knobs.deadlineMs,
			sleep,
			scanErrorSignatures,
			// R2 #2: a FRESH routing-deps closure per call — deliver is a no-op
			// (INV-4: HeartbeatService owns the emission), onDecision writes to a
			// per-call local. A deadline-abandoned call's late resolution lands in
			// a promise nobody holds — structurally isolated.
			routeToJudge: (report, ctx) => {
				let decision: JudgeDecision | undefined;
				return routeSuspiciousReport(
					deps.buildRoutingDeps({
						deliver: () => {},
						onDecision: (d) => {
							decision = d;
						},
						errorSignatureKinds: ctx.errorSignatureKinds,
						judgeCacheKey: (r, input) =>
							buildHeartbeatJudgeCacheKey(r, input, {
								commCorroborationMs: deps.commCorroborationMs(),
							}),
					}),
					report,
				)
					.then(() => decision ?? unavailable)
					.catch(() => unavailable);
			},
			logger: deps.logger,
		});
	};
}
