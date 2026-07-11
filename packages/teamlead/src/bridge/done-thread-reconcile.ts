/**
 * FLY-1165: done-thread reconcile sweep — the structural backstop behind the
 * FLY-369 close→archive cascade.
 *
 * The cascade only fires on a real close action, so four leak classes pile up
 * unarchived threads for issues that are long Done (production forensics on
 * #flywheel-engineer, 35 threads):
 *   A. terminate-only — runner terminated, never `close_runner done=true`;
 *   B. husk-block — a dead awaiting_review/approved_to_ship husk counts as
 *      "active" forever, so the cascade is permanently refused;
 *   C. never-closed — session ended without any close action;
 *   D. blocked-preserve — failed/blocked rows are (correctly) preserved, but
 *      nothing ever archives the thread after the issue is Done.
 * There is no common trigger point to fix, so the root cure is this sweep:
 * boot + periodic, purely incremental, archiving ONLY what the double gate
 * proves safe.
 *
 * Safety contract (mirrors the deliverable-1 script, Codex-approved plan):
 *   - double gate: fresh per-issue Linear lookup must say Done/Canceled AND
 *     no session row for the issue may own a live process;
 *   - triple veto: liveness is re-checked after EVERY slow await — before
 *     Linear (#1, cheap), after Linear (#2), and after husk finalize right
 *     before the archive (#3) — so a run started mid-sweep always wins;
 *   - fail-closed: tri-state target lookup `error`, probe throw,
 *     `indeterminate`, and terminal-status rows with a live process ALL count
 *     as live; a failed husk finalize skips the whole thread; ambiguous
 *     project resolution skips; Linear failure skips.
 *   - never kills a live tmux: finalize only runs on rows whose process is
 *     provably gone AND whose status is FSM-finalizable.
 *
 * Archiving goes through `archiveThreadAndRecord` (the single token-bearing
 * sink; per-thread serialization + archive-once live there — a founder
 * re-open is never fought).
 */

import type { ApplyTransitionOpts } from "../applyTransition.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import type {
	archiveChatThread,
	removeUserFromChatThread,
} from "./chat-thread-utils.js";
import { closeRunner } from "./close-runner.js";
import {
	archiveThreadAndRecord,
	resolveBotTokenForThread,
} from "./done-thread-archiver.js";
import { lookupLinearIssueByIdentifier } from "./linear-query.js";
import {
	lookupTmuxTarget,
	probeRunnerProcessLiveness,
	type RunnerLiveness,
} from "./tmux-lookup.js";

/**
 * Statuses a dead husk can be finalized out of (FSM-legal edges to
 * `completed`) — MUST equal `FINALIZE_DONE_SOURCE_STATES` in close-runner.ts.
 * blocked/failed rows are left alone: they are not "done", and they do not
 * block the archive itself.
 */
export const RECONCILE_FINALIZABLE_STATUSES = [
	"running",
	"awaiting_review",
	"approved_to_ship",
	"design_done",
] as const;

const DONE_STATE_TYPES = new Set(["completed", "canceled"]);

// ── Config (env re-read every scheduler tick — true direct toggle) ──────────

export interface DoneThreadReconcileConfig {
	enabled: boolean;
	/** Minutes between periodic passes; 0 = boot-only. */
	intervalMin: number;
	dryRun: boolean;
	maxArchivesPerRun: number;
	maxCandidatesPerRun: number;
	runDeadlineMs: number;
}

function parsePositiveInt(
	raw: string | undefined,
	fallback: number,
	opts: { allowZero?: boolean } = {},
): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
	if (n < 0) return fallback;
	if (n === 0 && !opts.allowZero) return fallback;
	return n;
}

export function resolveDoneThreadReconcileConfig(
	env: NodeJS.ProcessEnv = process.env,
): DoneThreadReconcileConfig {
	return {
		enabled: env.FLYWHEEL_DONE_THREAD_RECONCILE !== "0",
		intervalMin: parsePositiveInt(
			env.FLYWHEEL_DONE_THREAD_RECONCILE_INTERVAL_MIN,
			360,
			{ allowZero: true },
		),
		dryRun: env.FLYWHEEL_DONE_THREAD_RECONCILE_DRYRUN === "1",
		maxArchivesPerRun: parsePositiveInt(
			env.FLYWHEEL_DONE_THREAD_RECONCILE_MAX_PER_RUN,
			25,
		),
		maxCandidatesPerRun: 200,
		runDeadlineMs: 120_000,
	};
}

// ── Sweep ────────────────────────────────────────────────────────────────────

/** Minimal structural shape of the fresh Linear lookup the sweep needs. */
export type ReconcileLinearLookup = (
	linearApiKey: string,
	identifier: string,
) => Promise<{ id: string; identifier: string; stateType: string } | null>;

export interface DoneThreadReconcileDeps {
	store: StateStore;
	projects: ProjectEntry[];
	linearApiKey?: string;
	globalBotToken?: string;
	discordOwnerUserId?: string;
	/** Required for husk finalize (FSM path). Missing + finalizable dead husk
	 * present → that thread counts as finalize-failed and is skipped
	 * (fail-closed; production always wires this). */
	transitionOpts?: ApplyTransitionOpts;
	dryRun?: boolean;
	maxArchivesPerRun?: number;
	maxCandidatesPerRun?: number;
	runDeadlineMs?: number;
	archiveSpacingMs?: number;
	/** Cooperative shutdown (scheduler stop) — checked between candidates. */
	shouldAbort?: () => boolean;
	// Seams (default to the real implementations).
	lookupIssue?: ReconcileLinearLookup;
	/** Whole-sink seam (already_archived mapping tests). */
	archiveSinkFn?: typeof archiveThreadAndRecord;
	archiveFn?: typeof archiveChatThread;
	removeUserFn?: typeof removeUserFromChatThread;
	fetchImpl?: typeof fetch;
	/** Tri-state discriminated target lookup — `error` ⇒ LIVE (fail-closed). */
	lookupTarget?: typeof lookupTmuxTarget;
	probeLiveness?: (tmuxWindow: string) => Promise<RunnerLiveness>;
	closeRunnerFn?: typeof closeRunner;
	sleepImpl?: (ms: number) => Promise<void>;
	now?: () => number;
	log?: (msg: string) => void;
}

export interface DoneThreadReconcileResult {
	scanned: number;
	archived: number;
	huskFinalized: number;
	huskFinalizeFailed: number;
	skippedActive: number;
	skippedNotDone: number;
	skippedUnresolved: number;
	skippedNoToken: number;
	skippedNoProject: number;
	skippedAlreadyArchived: number;
	failed: number;
	capped: boolean;
	deadlineHit: boolean;
	aborted: boolean;
	dryRunWouldArchive: number;
}

type SessionAliasRow = ReturnType<StateStore["getSessionsForIssueAliases"]>[0];

/**
 * One reconcile pass. Never throws. The per-thread pipeline order IS the
 * safety design — do not reorder:
 *   budget/abort → veto #1 → fresh Linear → veto #2 → husk finalize
 *   (fail-closed) → veto #3 + fresh archived/missing recheck → archive.
 */
export async function reconcileDoneThreads(
	deps: DoneThreadReconcileDeps,
): Promise<DoneThreadReconcileResult> {
	const result: DoneThreadReconcileResult = {
		scanned: 0,
		archived: 0,
		huskFinalized: 0,
		huskFinalizeFailed: 0,
		skippedActive: 0,
		skippedNotDone: 0,
		skippedUnresolved: 0,
		skippedNoToken: 0,
		skippedNoProject: 0,
		skippedAlreadyArchived: 0,
		failed: 0,
		capped: false,
		deadlineHit: false,
		aborted: false,
		dryRunWouldArchive: 0,
	};
	const log =
		deps.log ??
		((msg: string) => console.log(`[done-thread-reconcile] ${msg}`));

	try {
		if (!deps.linearApiKey) {
			log(
				"no LINEAR_API_KEY configured — sweep skipped (fresh per-issue Linear lookups are mandatory)",
			);
			return result;
		}
		const { store, projects } = deps;
		const lookupIssue: ReconcileLinearLookup =
			deps.lookupIssue ?? lookupLinearIssueByIdentifier;
		const lookupTarget = deps.lookupTarget ?? lookupTmuxTarget;
		const probeLiveness = deps.probeLiveness ?? probeRunnerProcessLiveness;
		const closeRunnerFn = deps.closeRunnerFn ?? closeRunner;
		const archiveSink = deps.archiveSinkFn ?? archiveThreadAndRecord;
		const sleepImpl =
			deps.sleepImpl ??
			((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
		const now = deps.now ?? Date.now;
		const dryRun = deps.dryRun ?? false;
		const maxArchives = deps.maxArchivesPerRun ?? 25;
		const maxCandidates = deps.maxCandidatesPerRun ?? 200;
		const runDeadlineMs = deps.runDeadlineMs ?? 120_000;
		const spacingMs = deps.archiveSpacingMs ?? 500;
		const shouldAbort = deps.shouldAbort ?? (() => false);
		const startedAt = now();

		/**
		 * Alias-aware liveness over ALL session rows (any status — a terminal
		 * row can still own a live process, HeartbeatService precedent). Any
		 * signal that is not a provable "dead" counts as LIVE.
		 */
		const checkLiveness = async (
			keys: string[],
		): Promise<{ live: boolean; rows: SessionAliasRow[] }> => {
			const rows = store.getSessionsForIssueAliases(keys);
			for (const row of rows) {
				let lookup: ReturnType<typeof lookupTmuxTarget>;
				try {
					lookup = lookupTarget(row.execution_id, row.project_name);
				} catch {
					return { live: true, rows };
				}
				if (lookup.kind === "error") return { live: true, rows };
				if (lookup.kind === "gone") continue;
				let liveness: RunnerLiveness;
				try {
					liveness = await probeLiveness(lookup.target.tmuxWindow);
				} catch {
					return { live: true, rows };
				}
				if (liveness === "alive" || liveness === "indeterminate") {
					return { live: true, rows };
				}
				// dead_pin / absent → provably dead, keep checking siblings.
			}
			return { live: false, rows };
		};

		const candidates = store.getUnarchivedIssueChatThreads();
		for (const thread of candidates) {
			if (shouldAbort()) {
				result.aborted = true;
				break;
			}
			if (result.scanned >= maxCandidates) {
				result.capped = true;
				log(
					`candidate cap reached — ${candidates.length - result.scanned} candidate(s) left for the next pass`,
				);
				break;
			}
			if (now() - startedAt >= runDeadlineMs) {
				result.deadlineHit = true;
				log(
					`run deadline hit — ${candidates.length - result.scanned} candidate(s) left for the next pass`,
				);
				break;
			}
			result.scanned++;

			try {
				// veto #1 — cheap local liveness before spending a Linear call.
				const veto1 = await checkLiveness([thread.issue_id]);
				if (veto1.live) {
					result.skippedActive++;
					continue;
				}

				// Fresh per-issue Linear lookup (identifier OR UUID — issue(id:)
				// accepts both). Failure is fail-closed: skip, never guess.
				let linear: Awaited<ReturnType<ReconcileLinearLookup>>;
				try {
					linear = await lookupIssue(deps.linearApiKey, thread.issue_id);
				} catch {
					result.skippedUnresolved++;
					continue;
				}
				if (!linear) {
					result.skippedUnresolved++;
					continue;
				}
				if (!DONE_STATE_TYPES.has(linear.stateType)) {
					result.skippedNotDone++;
					continue;
				}
				const aliasKeys = [
					...new Set(
						[thread.issue_id, linear.id, linear.identifier].filter(Boolean),
					),
				];

				// veto #2 — the Linear await is a TOCTOU window; recheck with the
				// full alias set (UUID ↔ identifier both directions).
				const veto2 = await checkLiveness(aliasKeys);
				if (veto2.live) {
					result.skippedActive++;
					continue;
				}

				// Husk finalize: dead rows stuck in FSM-finalizable states go
				// through closeRunner({finalizeDone}) — WITHOUT archive deps (the
				// sweep archives once, below; no double-write race). Any failure
				// downgrades the whole thread (fail-closed).
				const finalizable = veto2.rows.filter((r) =>
					(RECONCILE_FINALIZABLE_STATUSES as readonly string[]).includes(
						r.status,
					),
				);
				if (!dryRun && finalizable.length > 0) {
					if (!deps.transitionOpts) {
						// finalize unavailable = finalize failed (test/abnormal
						// assembly only — production always wires transitionOpts).
						result.huskFinalizeFailed++;
						log(
							`${thread.issue_id}: finalizable husk present but no transitionOpts — skipping thread (fail-closed)`,
						);
						continue;
					}
					let finalizeFailed = false;
					for (const husk of finalizable) {
						let closeResult:
							| Awaited<ReturnType<typeof closeRunner>>
							| undefined;
						try {
							closeResult = await closeRunnerFn(
								{
									executionId: husk.execution_id,
									issueId: thread.issue_id,
									projectName: husk.project_name,
									reason: "FLY-1165 reconcile: dead husk on Done issue",
									leadId: "bridge.done-thread-reconcile",
									finalizeDone: true,
									transitionOpts: deps.transitionOpts,
								},
								store,
							);
						} catch {
							closeResult = undefined;
						}
						if (
							!(closeResult && (closeResult.closed || closeResult.alreadyGone))
						) {
							result.huskFinalizeFailed++;
							finalizeFailed = true;
							log(
								`${thread.issue_id}: husk finalize failed for ${husk.execution_id} (${closeResult?.error ?? "no result"}) — skipping thread`,
							);
							break;
						}
						result.huskFinalized++;
					}
					if (finalizeFailed) continue;
				}

				// veto #3 — closeRunner can await cmux/tmux teardown for seconds;
				// recheck liveness AND the thread's own archived/missing state
				// right before the PATCH (another path may have archived it, or
				// Annie may have re-opened it — the sink guard is the 2nd layer).
				const veto3 = await checkLiveness(aliasKeys);
				if (veto3.live) {
					result.skippedActive++;
					continue;
				}
				if (
					store.isChatThreadArchived(thread.thread_id) ||
					!store.getChatThreadByThreadId(thread.thread_id)
				) {
					result.skippedAlreadyArchived++;
					continue;
				}

				// Project resolution — fail-closed: the unique session project, or
				// the unique (lead_id, channel_id) project-config match; 0 or >1 →
				// skip (never archive with a guessed bot identity).
				const projectNames = [
					...new Set(veto3.rows.map((r) => r.project_name).filter(Boolean)),
				];
				let projectName: string | undefined;
				if (projectNames.length === 1) {
					projectName = projectNames[0];
				} else if (projectNames.length === 0) {
					const matches = projects.filter((p) =>
						p.leads?.some(
							(l) =>
								l.agentId === thread.lead_id &&
								l.chatChannel === thread.channel_id,
						),
					);
					if (matches.length === 1) projectName = matches[0]?.projectName;
				}
				if (!projectName) {
					result.skippedNoProject++;
					log(
						`${thread.issue_id}: ambiguous project resolution (sessions=${projectNames.length}) — skipping`,
					);
					continue;
				}

				const session = veto3.rows[0];
				const botToken = resolveBotTokenForThread(projects, {
					projectName,
					leadId: thread.lead_id,
					labels: session ? store.getSessionLabels(session.execution_id) : [],
					fallbackBotToken: deps.globalBotToken,
				});
				if (!botToken) {
					result.skippedNoToken++;
					continue;
				}

				if (dryRun) {
					result.dryRunWouldArchive++;
				} else {
					const sinkResult = await archiveSink(
						store,
						{
							threadId: thread.thread_id,
							issueId: thread.issue_id,
							projectName,
							executionId:
								session?.execution_id ?? `fly1165-reconcile-${thread.issue_id}`,
						},
						botToken,
						{
							archiveFn: deps.archiveFn,
							removeUserFn: deps.removeUserFn,
							fetchImpl: deps.fetchImpl,
							discordOwnerUserId: deps.discordOwnerUserId,
							auditSource: "bridge.done-thread-reconcile",
						},
					);
					if (sinkResult.reason === "already_archived") {
						result.skippedAlreadyArchived++;
					} else if (sinkResult.archived) {
						result.archived++;
					} else {
						// 404 is handled inside the sink (markDiscordMissing drops the
						// row out of future candidate sets).
						result.failed++;
					}
					await sleepImpl(spacingMs);
				}

				if (result.archived + result.dryRunWouldArchive >= maxArchives) {
					result.capped = true;
					log(
						"archive cap reached — remaining candidates deferred to the next pass",
					);
					break;
				}
			} catch (err) {
				result.failed++;
				log(
					`${thread.issue_id}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		log(
			`pass done: scanned=${result.scanned} archived=${result.archived} huskFinalized=${result.huskFinalized} huskFinalizeFailed=${result.huskFinalizeFailed} skippedActive=${result.skippedActive} skippedNotDone=${result.skippedNotDone} skippedUnresolved=${result.skippedUnresolved} skippedNoToken=${result.skippedNoToken} skippedNoProject=${result.skippedNoProject} skippedAlreadyArchived=${result.skippedAlreadyArchived} failed=${result.failed} dryRunWouldArchive=${result.dryRunWouldArchive} capped=${result.capped} deadlineHit=${result.deadlineHit} aborted=${result.aborted}`,
		);
	} catch (err) {
		// Never let the sweep break its caller (boot chain / scheduler tick).
		log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
	}
	return result;
}

// ── Scheduler (boot pass + periodic tick; direct toggle; drainable stop) ────

export interface DoneThreadReconcileSchedulerOpts {
	runOnce: (
		shouldAbort: () => boolean,
	) => Promise<DoneThreadReconcileResult | undefined>;
	/** Re-resolved EVERY tick — off→on / on→off needs no restart. */
	resolveConfig?: () => DoneThreadReconcileConfig;
	/** Boot pass delay — the boot chain itself never awaits the sweep. */
	bootDelayMs?: number;
	/** Heartbeat tick; each tick re-reads config and checks the interval. */
	tickMs?: number;
	log?: (msg: string) => void;
}

export function startDoneThreadReconcileScheduler(
	opts: DoneThreadReconcileSchedulerOpts,
): { stop: () => Promise<void> } {
	const resolveConfig =
		opts.resolveConfig ?? (() => resolveDoneThreadReconcileConfig());
	const bootDelayMs = opts.bootDelayMs ?? 15_000;
	const tickMs = opts.tickMs ?? 60_000;
	const log =
		opts.log ??
		((msg: string) => console.log(`[done-thread-reconcile] ${msg}`));

	let stopped = false;
	let inFlight: Promise<unknown> | null = null;
	let lastRunAt = Date.now();

	const shouldAbort = () => stopped;

	const startRun = () => {
		if (stopped || inFlight) return;
		lastRunAt = Date.now();
		inFlight = opts
			.runOnce(shouldAbort)
			.catch((err) =>
				log(`pass failed: ${err instanceof Error ? err.message : String(err)}`),
			)
			.finally(() => {
				inFlight = null;
			});
	};

	const bootTimer = setTimeout(() => {
		if (stopped) return;
		if (!resolveConfig().enabled) return;
		startRun();
	}, bootDelayMs);
	bootTimer.unref?.();

	const tickTimer = setInterval(() => {
		if (stopped) return;
		const cfg = resolveConfig();
		if (!cfg.enabled) return;
		if (cfg.intervalMin === 0) return; // boot-only mode
		if (inFlight) return; // single-flight
		if (Date.now() - lastRunAt >= cfg.intervalMin * 60_000) startRun();
	}, tickMs);
	tickTimer.unref?.();

	return {
		// Cooperative drain: new runs stop immediately; an in-flight pass exits
		// between candidates via shouldAbort and is awaited before returning —
		// callers MUST stop() before store.close().
		stop: async () => {
			stopped = true;
			clearTimeout(bootTimer);
			clearInterval(tickTimer);
			if (inFlight) {
				try {
					await inFlight;
				} catch {
					// runOnce already logs; stop() never throws.
				}
			}
		},
	};
}
