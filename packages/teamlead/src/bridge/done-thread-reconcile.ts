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

import { existsSync } from "node:fs";
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
	"ship_parked",
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

export function resolveDoneThreadReconcileConfig(
	env: NodeJS.ProcessEnv = process.env,
): DoneThreadReconcileConfig {
	return {
		enabled: env.FLYWHEEL_DONE_THREAD_RECONCILE !== "0",
		// FLY-2101: founder 2026-08-27 v4 fixed the former runtime values.
		intervalMin: 360,
		dryRun: false,
		maxArchivesPerRun: 25,
		maxCandidatesPerRun: 200,
		runDeadlineMs: 120_000,
	};
}

// ── Sweep ────────────────────────────────────────────────────────────────────

/** Minimal structural shape of the fresh Linear lookup the sweep needs.
 *  FLY-1185: `updatedAt` feeds the monotonic episode observation (R10#4). */
export type ReconcileLinearLookup = (
	linearApiKey: string,
	identifier: string,
) => Promise<{
	id: string;
	identifier: string;
	stateType: string;
	updatedAt?: string;
} | null>;

// ── FLY-1185 §2.12 (R9#4): hardcoded per-run budgets for the D entry's NEW
// mutator surface (issue closeouts). NOT env-configurable by contract. ──
export const MAX_ISSUE_CLOSEOUTS_PER_RUN = 5;
export const MAX_CLOSEOUT_MUTATORS_PER_RUN = 40;

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
	/**
	 * FLY-1185 D entry: the unified issue closeout (composition wires
	 * `closeoutIssue`). Invoked ONLY for a durably-observed nonterminal→
	 * terminal migration (`terminal_authorized` episode) — ANY first-seen-
	 * terminal issue goes to the manual list instead, in EVERY round (R8#1).
	 * Returns the number of mutator-bearing nodes it drove (budget input).
	 */
	lifecycleCloseout?: (input: {
		issueKey: string;
		projectName: string;
		disposition: "shipped" | "canceled";
		extraAliases: string[];
		/** Codex R1#14: per-run mutator budget/deadline, enforced per node
		 * INSIDE the executor (before each mutation). */
		budget?: {
			tryConsume: () => boolean;
			shouldStop?: () => boolean;
		};
		/** Codex R2#5: fresh Linear authority re-check, called by the executor
		 * before every mutation — a reopen mid-closeout must win. */
		freshAuthority?: () => Promise<"authorized" | "reopened" | "unknown">;
	}) => Promise<{ nodes: unknown[]; outcome: string } | undefined>;
	/**
	 * FLY-1448 E1: fresh Linear Done/Canceled is independent authority for
	 * gate retirement, including running sessions and issues without a ship gate.
	 * The implementation must call `revalidate` before every irreversible mutation;
	 * reopen/unknown wins.
	 */
	retireIssueGates?: (input: {
		projectName: string;
		canonicalIssueId: string;
		issueAliases: string[];
		authorityCredential: string;
		revalidate: () => Promise<"authorized" | "reopened" | "unknown">;
	}) => Promise<void>;
	/**
	 * FLY-1185 dual-switch contract (R9#4): the NEW mutators (closeout) hang
	 * off the autoclean integration seam; the ORIGINAL FLY-1165 husk/archive
	 * behavior stays under FLYWHEEL_DONE_THREAD_RECONCILE — neither switch
	 * crosses into the other's territory. Injectable for the byte-compat
	 * integration tests.
	 */
	newMutatorsEnabled?: boolean;
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
	skippedReopenProtected: number;
	failed: number;
	capped: boolean;
	deadlineHit: boolean;
	aborted: boolean;
	dryRunWouldArchive: number;
	/** FLY-1185 D entry counters. */
	closeoutRuns: number;
	closeoutMutators: number;
	legacyManualCandidates: number;
	/** Codex R1#1 residue union: extra thread-less issues D examined. */
	residueScanned: number;
}

type SessionAliasRow = ReturnType<StateStore["getSessionsForIssueAliases"]>[0];

/** Codex R2#5 + R3#5 — mutation-time fresh-Linear authority for ONE issue:
 * EVERY call is a real uncached read (a cached terminal verdict must never
 * authorize a mutation after a reopen). terminal → authorized; nonterminal →
 * reopened; lookup failure → unknown (both non-authorized outcomes BLOCK). */
function makeFreshAuthority(
	lookup: () => Promise<{ stateType: string } | null | undefined>,
	_now: () => number,
): () => Promise<"authorized" | "reopened" | "unknown"> {
	return async () => {
		try {
			const fresh = await lookup();
			return !fresh
				? "unknown"
				: DONE_STATE_TYPES.has(fresh.stateType)
					? "authorized"
					: "reopened";
		} catch {
			return "unknown";
		}
	};
}

/**
 * One reconcile pass. Never throws. The per-thread pipeline order IS the
 * safety design — do not reorder:
 *   budget/abort → fresh Linear → durable observation (nonterminal included)
 *   → [authorized: unified closeout (owns live nodes, budgeted per node)]
 *   → [legacy: veto → husk finalize (fail-closed)]
 *   → veto #3 + fresh archived/missing recheck → archive.
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
		skippedReopenProtected: 0,
		failed: 0,
		capped: false,
		deadlineHit: false,
		aborted: false,
		dryRunWouldArchive: 0,
		closeoutRuns: 0,
		closeoutMutators: 0,
		legacyManualCandidates: 0,
		residueScanned: 0,
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
		const linearApiKey = deps.linearApiKey; // narrowed by the guard above
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

		// Codex R1#14 — ONE budget across the whole run (threads + residue):
		// the executor consumes a slot per node BEFORE each mutation; exhausted
		// → the node blocks and the next run continues from durable state.
		const closeoutBudget = {
			tryConsume: () => {
				if (result.closeoutMutators >= MAX_CLOSEOUT_MUTATORS_PER_RUN) {
					return false;
				}
				result.closeoutMutators++;
				return true;
			},
			shouldStop: () => shouldAbort() || now() - startedAt >= runDeadlineMs,
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
				// (FLY-1185 Codex R1#1: the old veto #1 — skip-on-liveness BEFORE
				// the Linear lookup — is gone. A live runner is the NORMAL state of
				// a nonterminal issue; vetoing here meant the nonterminal
				// observation was never persisted, so every issue aged into a
				// first-seen-terminal legacy episode and automation was dead.
				// Liveness vetoes remain on the legacy finalize/archive paths.)

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
				const aliasKeys = [
					...new Set(
						[thread.issue_id, linear.id, linear.identifier].filter(Boolean),
					),
				];

				// ── FLY-1185 D entry: durable episode observation (R9#1/R10#4) —
				// written on EVERY fresh Linear read, nonterminal included (Codex
				// R1#1: a durable nonterminal observation is exactly what ends a
				// legacy episode and authorizes the later terminal migration).
				// Ambiguous project → no observation, no new authority. ──
				let closeoutAuthorized = false;
				const obsProjectNames = [
					...new Set(
						store
							.getSessionsForIssueAliases(aliasKeys)
							.map((r) => r.project_name)
							.filter(Boolean),
					),
				];
				const obsProject =
					obsProjectNames.length === 1 ? obsProjectNames[0] : undefined;
				const isTerminal = DONE_STATE_TYPES.has(linear.stateType);
				if (obsProject) {
					const obs = store.observeLinearStateAndClaimCloseout({
						project: obsProject,
						issueUuid: linear.id,
						stateType: linear.stateType,
						linearUpdatedAt: linear.updatedAt ?? "",
					});
					if (obs.outcome !== "conflict") {
						closeoutAuthorized = obs.terminalAuthorized;
					}
					if (obs.legacyTerminalEpisode && isTerminal) {
						result.legacyManualCandidates++;
						store.insertEvent({
							event_id: `lifecycle-manual-candidate-${linear.id}`,
							execution_id: `reconcile-${obsProject}`,
							issue_id: linear.id,
							project_name: obsProject,
							event_type: "lifecycle_manual_candidate",
							source: "bridge.done-thread-reconcile",
							payload: {
								identifier: linear.identifier,
								stateType: linear.stateType,
								reason: "first_seen_terminal_legacy_episode",
							},
						});
					}
				}
				if (!isTerminal) {
					// Observation persisted; a nonterminal issue has nothing to
					// reconcile — this is the durable-migration recording pass.
					result.skippedNotDone++;
					continue;
				}
				if (obsProject && deps.retireIssueGates && !dryRun) {
					try {
						await deps.retireIssueGates({
							projectName: obsProject,
							canonicalIssueId: linear.id,
							issueAliases: aliasKeys,
							authorityCredential: `${linear.id}:${linear.updatedAt ?? ""}`,
							revalidate: makeFreshAuthority(
								() => lookupIssue(linearApiKey, thread.issue_id),
								now,
							),
						});
					} catch (err) {
						result.failed++;
						log(
							`${thread.issue_id}: issue gate retirement failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
				const newMutatorsOn = deps.newMutatorsEnabled ?? true;
				const runCloseout =
					closeoutAuthorized &&
					newMutatorsOn &&
					!!deps.lifecycleCloseout &&
					!!obsProject &&
					!dryRun &&
					result.closeoutRuns < MAX_ISSUE_CLOSEOUTS_PER_RUN &&
					result.closeoutMutators < MAX_CLOSEOUT_MUTATORS_PER_RUN;
				// R9#3 + Codex R1#1: an AUTHORIZED closeout owns EVERY husk (FSM
				// terminate for canceled, finalizeDone for shipped) — the legacy
				// finalizeDone loop must not run beside it. Non-authorized /
				// switched-off cases keep the original FLY-1165 behavior.
				const skipLegacyFinalize = runCloseout;

				// veto #2 — LEGACY paths only (Codex R1#1: the authorized closeout
				// is the component that CLOSES live runners; vetoing it on
				// liveness made the target scenario — Linear canceled, runner
				// alive — unreachable). The executor confirms per node.
				if (!runCloseout) {
					const veto2 = await checkLiveness(aliasKeys);
					if (veto2.live) {
						result.skippedActive++;
						continue;
					}
				}

				// Husk finalize: dead rows stuck in FSM-finalizable states go
				// through closeRunner({finalizeDone}) — WITHOUT archive deps (the
				// sweep archives once, below; no double-write race). Any failure
				// downgrades the whole thread (fail-closed).
				const finalizable = skipLegacyFinalize
					? []
					: store
							.getSessionsForIssueAliases(aliasKeys)
							.filter((r) =>
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

				// ── FLY-1185 D entry: authorized full closeout (nodes + claims +
				// forensics-release semantics) under the hardcoded per-run caps.
				// Abort/deadline are re-checked here — this is a mutator boundary
				// (R9#4: check granularity down to every mutation). ──
				if (runCloseout && deps.lifecycleCloseout && obsProject) {
					if (shouldAbort() || now() - startedAt >= runDeadlineMs) {
						result.deadlineHit = now() - startedAt >= runDeadlineMs;
						result.aborted = shouldAbort();
						break;
					}
					try {
						const closeReport = await deps.lifecycleCloseout({
							issueKey: linear.id,
							projectName: obsProject,
							disposition:
								linear.stateType === "canceled" ? "canceled" : "shipped",
							extraAliases: aliasKeys,
							// Codex R1#14: the per-run mutator budget is enforced
							// INSIDE the executor, per node, before each mutation.
							budget: closeoutBudget,
							// Codex R2#5: reopen wins — the executor re-reads Linear
							// before every mutation (5s TTL guards the API rate).
							freshAuthority: makeFreshAuthority(
								() => lookupIssue(linearApiKey, thread.issue_id),
								now,
							),
						});
						result.closeoutRuns++;
						if (
							closeReport &&
							(closeReport.outcome === "blocked" ||
								closeReport.outcome === "conflict")
						) {
							// Codex R1#3 family: nodes not confirmed gone → no archive
							// this pass; the next run (or sweep) continues.
							continue;
						}
					} catch (err) {
						result.failed++;
						log(
							`${thread.issue_id}: lifecycle closeout failed: ${err instanceof Error ? err.message : String(err)}`,
						);
						continue; // fail-closed for THIS issue only
					}
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

				// Codex R2#5: FRESH Linear re-read right before the archive — a
				// founder reopen during the closeout/liveness awaits must win
				// (fail-closed on lookup failure: skip, never archive on stale).
				try {
					const recheck = await lookupIssue(linearApiKey, thread.issue_id);
					if (!recheck || !DONE_STATE_TYPES.has(recheck.stateType)) {
						result.skippedNotDone++;
						continue;
					}
				} catch {
					result.skippedUnresolved++;
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
					} else if (
						sinkResult.reason === "founder_reopened" ||
						sinkResult.reason === "in_active_use"
					) {
						result.skippedReopenProtected++;
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

		// ── FLY-1185 D residue union (Codex R1#1): issues holding live/husk
		// sessions or stale starting launch-claims but NO unarchived thread
		// still need the observation + authorized-closeout check. Same caps,
		// same deadline, same budget; no thread → no archive step here. ──
		if (!result.aborted && !result.deadlineHit) {
			const seenIssueKeys = new Set(candidates.map((c) => c.issue_id));
			const residue = new Map<string, string>();
			// Codex R2#4: the FULL non-terminal status set (pending/design_done/
			// blocked/failed included) — a thread-less issue in ANY live state is
			// residue. Terminal-status husks with a live window are owned by the
			// per-node confirm inside the closeout (they surface whenever their
			// issue is examined) plus the FLY-817 husk reconcile + E sweep.
			for (const sess of store.listNonTerminalSessions()) {
				if (!seenIssueKeys.has(sess.issue_id)) {
					residue.set(sess.issue_id, sess.project_name);
				}
			}
			// R3#4 + R6#5 + R7#3: TERMINAL-LIVE residue — a terminal session
			// whose runner is STILL alive. `found` only proves a CommDB record;
			// probe the actual process and count only alive/indeterminate (an
			// error is fail-closed → kept, an absent/dead pane is dropped). A
			// fully-zeroed issue (process gone) is not re-added → no cap
			// starvation.
			for (const sess of store.listTerminalSessionsWithResidue()) {
				if (seenIssueKeys.has(sess.issue_id) || residue.has(sess.issue_id)) {
					continue;
				}
				const look = lookupTarget(sess.execution_id, sess.project_name);
				// R8#2: three-state, fail-closed. `gone` is the ONLY drop — a
				// `error` (CommDB corruption/lock) can NOT prove the target
				// vanished, so it is kept as a cleanup-pending residue candidate
				// (the lookup's own fail-closed contract; deps note: error ⇒ LIVE).
				// Only a `found` (real CommDB record) is probed for liveness.
				if (look.kind === "gone") continue;
				if (look.kind === "found") {
					const live = await probeLiveness(look.target.tmuxWindow).catch(
						() => "indeterminate" as RunnerLiveness,
					);
					if (live === "absent" || live === "dead_pin") continue;
				}
				residue.set(sess.issue_id, sess.project_name);
			}
			// R3#4 + R6#5 + R7#3: binding-owned residue — a SEPARATE D source
			// (plan.md:143/156): real residue when the bound worktree still
			// PHYSICALLY exists on disk, NOT only when a live runner remains (a
			// dead-runner + leftover worktree/branch + open PR is exactly the
			// residue D must reconcile — E-sweep skips git objects behind an open
			// PR and can't run D's mechanically-bound PR close). A zeroed issue
			// (worktree removed) → path gone → not re-added → no cap starvation.
			for (const project of projects) {
				for (const b of store.listWorktreeBindings(project.projectName)) {
					const sess = store.getSession(b.execution_id);
					if (!sess || seenIssueKeys.has(sess.issue_id)) continue;
					if (residue.has(sess.issue_id)) continue;
					if (b.path && existsSync(b.path)) {
						residue.set(sess.issue_id, sess.project_name);
					}
				}
			}
			for (const claim of store.listStaleStartingClaims(30)) {
				if (!seenIssueKeys.has(claim.rootUuid)) {
					residue.set(claim.rootUuid, claim.project);
				}
			}
			// R4#6 + R5#6: Linear-mismatch source — Linear reads terminal but a
			// local session is STILL non-terminal (a genuine local/Linear
			// disagreement that needs reconciling). Crucially this is gated on a
			// TRUE mismatch: a fully-zeroed issue (every local session already
			// terminal) is NOT re-added each round, so historical terminal issues
			// can never starve the per-run closeout cap (Codex R5#6). The
			// non-terminal sessions are also covered by listNonTerminalSessions
			// above; this is the defensive Linear-authority cross-check.
			const NONTERMINAL_GATE = (st: string): boolean =>
				st !== "completed" &&
				st !== "terminated" &&
				st !== "rejected" &&
				st !== "deferred" &&
				st !== "shelved" &&
				st !== "approved" &&
				st !== "timeout";
			for (const obs of store.listTerminalLinearObservations()) {
				if (seenIssueKeys.has(obs.issueUuid) || residue.has(obs.issueUuid)) {
					continue;
				}
				const rows = store.getSessionsForIssueAliases([obs.issueUuid]);
				if (rows.some((r) => NONTERMINAL_GATE(r.status))) {
					residue.set(obs.issueUuid, obs.project);
				}
			}
			for (const [issueKey, residueProject] of residue) {
				if (shouldAbort()) {
					result.aborted = true;
					break;
				}
				if (now() - startedAt >= runDeadlineMs) {
					result.deadlineHit = true;
					break;
				}
				if (result.scanned + result.residueScanned >= maxCandidates) {
					result.capped = true;
					break;
				}
				result.residueScanned++;
				try {
					let linear: Awaited<ReturnType<ReconcileLinearLookup>>;
					try {
						linear = await lookupIssue(deps.linearApiKey, issueKey);
					} catch {
						continue;
					}
					if (!linear) continue;
					const obs = store.observeLinearStateAndClaimCloseout({
						project: residueProject,
						issueUuid: linear.id,
						stateType: linear.stateType,
						linearUpdatedAt: linear.updatedAt ?? "",
					});
					if (!DONE_STATE_TYPES.has(linear.stateType)) continue;
					const residueAliases = [
						...new Set(
							[issueKey, linear.id, linear.identifier].filter(Boolean),
						),
					];
					if (deps.retireIssueGates && !dryRun) {
						await deps.retireIssueGates({
							projectName: residueProject,
							canonicalIssueId: linear.id,
							issueAliases: residueAliases,
							authorityCredential: `${linear.id}:${linear.updatedAt ?? ""}`,
							revalidate: makeFreshAuthority(
								() => lookupIssue(linearApiKey, issueKey),
								now,
							),
						});
					}
					const authorized =
						obs.outcome !== "conflict" && obs.terminalAuthorized;
					const canRun =
						authorized &&
						(deps.newMutatorsEnabled ?? true) &&
						!!deps.lifecycleCloseout &&
						!dryRun &&
						result.closeoutRuns < MAX_ISSUE_CLOSEOUTS_PER_RUN;
					if (!canRun) continue;
					await deps.lifecycleCloseout?.({
						issueKey: linear.id,
						projectName: residueProject,
						disposition:
							linear.stateType === "canceled" ? "canceled" : "shipped",
						extraAliases: residueAliases,
						budget: closeoutBudget,
						freshAuthority: makeFreshAuthority(
							() => lookupIssue(linearApiKey, issueKey),
							now,
						),
					});
					result.closeoutRuns++;
				} catch (err) {
					result.failed++;
					log(
						`residue ${issueKey}: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
		}

		log(
			`pass done: scanned=${result.scanned} archived=${result.archived} huskFinalized=${result.huskFinalized} huskFinalizeFailed=${result.huskFinalizeFailed} skippedActive=${result.skippedActive} skippedNotDone=${result.skippedNotDone} skippedUnresolved=${result.skippedUnresolved} skippedNoToken=${result.skippedNoToken} skippedNoProject=${result.skippedNoProject} skippedAlreadyArchived=${result.skippedAlreadyArchived} skippedReopenProtected=${result.skippedReopenProtected} failed=${result.failed} dryRunWouldArchive=${result.dryRunWouldArchive} capped=${result.capped} deadlineHit=${result.deadlineHit} aborted=${result.aborted}`,
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
	/**
	 * FLY-1282 Part C: per-issue archive-only targeted check (composition wraps
	 * `runTargetedArchiveCheck` + outcome mapping). `done:true` dequeues;
	 * `done:false` is retried with capped backoff + fair tail rotation. Absent
	 * → the scheduler is byte-identical to pre-FLY-1282 ({enqueue} is a loud
	 * no-op).
	 */
	runTargeted?: (issueId: string) => Promise<{ done: boolean; note?: string }>;
	now?: () => number;
}

/** FLY-1282 Part C queue tuning (per Codex R11 #4 / R12 #4 / R13 #2). */
const TARGETED_QUEUE_CAP = 64;
const TARGETED_BACKOFF_BASE_MS = 60_000;
const TARGETED_BACKOFF_CAP_MS = 30 * 60_000;
const TARGETED_SLOW_AFTER_MS = 24 * 3_600_000;
const TARGETED_SLOW_INTERVAL_MS = 3_600_000;

export function startDoneThreadReconcileScheduler(
	opts: DoneThreadReconcileSchedulerOpts,
): { enqueue: (issueId: string) => void; stop: () => Promise<void> } {
	const resolveConfig =
		opts.resolveConfig ?? (() => resolveDoneThreadReconcileConfig());
	const bootDelayMs = opts.bootDelayMs ?? 15_000;
	const tickMs = opts.tickMs ?? 60_000;
	const now = opts.now ?? (() => Date.now());
	const log =
		opts.log ??
		((msg: string) => console.log(`[done-thread-reconcile] ${msg}`));

	let stopped = false;
	let inFlight: Promise<unknown> | null = null;
	let lastRunAt = now();

	// ── FLY-1282 Part C: in-memory targeted queue (scheduler-owned; shares
	// the SAME inFlight single-flight as global passes — never concurrent). ──
	interface TargetedItem {
		issueId: string;
		attempts: number;
		enqueuedAt: number;
		nextEligibleAt: number;
	}
	const targetedQueue: TargetedItem[] = [];
	// Code R1 #8: dedupe must cover the item CURRENTLY in flight too — a
	// completion re-fired while the targeted check is suspended must not mint
	// a second logical item (double backoff entries, wasted capacity).
	const targetedMembers = new Set<string>();

	const shouldAbort = () => stopped;

	const startRun = () => {
		if (stopped || inFlight) return;
		lastRunAt = now();
		inFlight = opts
			.runOnce(shouldAbort)
			.catch((err) =>
				log(`pass failed: ${err instanceof Error ? err.message : String(err)}`),
			)
			.finally(() => {
				inFlight = null;
			});
	};

	const startTargeted = (item: TargetedItem) => {
		const runTargeted = opts.runTargeted;
		if (!runTargeted || stopped || inFlight) return;
		inFlight = runTargeted(item.issueId)
			.then((outcome) => {
				if (outcome.done) {
					targetedMembers.delete(item.issueId);
					return;
				}
				// Retryable: capped backoff, fair tail rotation; after 24h drop
				// to low-frequency-forever (never silently dropped — R13 #2).
				item.attempts += 1;
				const age = now() - item.enqueuedAt;
				const backoff =
					age > TARGETED_SLOW_AFTER_MS
						? TARGETED_SLOW_INTERVAL_MS
						: Math.min(
								TARGETED_BACKOFF_BASE_MS * 2 ** (item.attempts - 1),
								TARGETED_BACKOFF_CAP_MS,
							);
				item.nextEligibleAt = now() + backoff;
				if (age > TARGETED_SLOW_AFTER_MS) {
					log(
						`targeted archive for ${item.issueId} still pending after ${Math.round(age / 3_600_000)}h (${outcome.note ?? "retryable"}) — low-frequency retry continues`,
					);
				}
				targetedQueue.push(item); // tail — later items are not starved
			})
			.catch((err) => {
				item.attempts += 1;
				item.nextEligibleAt =
					now() +
					Math.min(
						TARGETED_BACKOFF_BASE_MS * 2 ** (item.attempts - 1),
						TARGETED_BACKOFF_CAP_MS,
					);
				targetedQueue.push(item);
				log(
					`targeted archive for ${item.issueId} threw: ${err instanceof Error ? err.message : String(err)}`,
				);
			})
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
		// Disabled PAUSES consumption (items retained; resumes on re-enable
		// without restart — R12 #4; construction stays unconditional).
		if (!cfg.enabled) return;
		if (inFlight) return; // single-flight (shared with targeted)
		// Targeted items first (the minutes-not-hours path); one per tick.
		if (opts.runTargeted) {
			const idx = targetedQueue.findIndex((i) => i.nextEligibleAt <= now());
			if (idx >= 0) {
				const item = targetedQueue.splice(idx, 1)[0];
				if (item) {
					startTargeted(item);
					return;
				}
			}
		}
		if (cfg.intervalMin === 0) return; // boot-only mode (global pass)
		if (now() - lastRunAt >= cfg.intervalMin * 60_000) startRun();
	}, tickMs);
	tickTimer.unref?.();

	return {
		/**
		 * FLY-1282 Part C: enqueue an issue for the archive-only targeted
		 * check. Deduped; bounded (overflow REFUSES + loud log — the periodic
		 * sweep is the backstop when enabled; boot-only + >cap burst is a
		 * documented accepted gap, never a fake backstop).
		 */
		enqueue: (issueId: string) => {
			if (!opts.runTargeted) {
				log(`enqueue(${issueId}) ignored — no targeted runner wired`);
				return;
			}
			if (stopped) return;
			if (targetedMembers.has(issueId)) return; // queued OR in flight
			if (targetedQueue.length >= TARGETED_QUEUE_CAP) {
				log(
					`targeted queue full (${TARGETED_QUEUE_CAP}) — REFUSING enqueue for ${issueId}; periodic sweep is the backstop when enabled`,
				);
				return;
			}
			targetedMembers.add(issueId);
			targetedQueue.push({
				issueId,
				attempts: 0,
				enqueuedAt: now(),
				nextEligibleAt: now(),
			});
		},
		// Cooperative drain: new runs stop immediately; an in-flight pass exits
		// between candidates via shouldAbort and is awaited before returning —
		// callers MUST stop() before store.close(). Queued targeted items are
		// dropped on stop (shutdown drain).
		stop: async () => {
			stopped = true;
			clearTimeout(bootTimer);
			clearInterval(tickTimer);
			targetedQueue.length = 0;
			targetedMembers.clear();
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
