/**
 * FLY-1549: the v2 display refresher — turns v2 lifecycle events into the
 * FLY-907 three-surface refresh on the messenger's `[FLY-XXXX]` threads.
 *
 * Contract (ported verbatim from the FLY-907 PRD):
 *  - events only TRIGGER; content derives from a real-state kernel snapshot;
 *  - per-issue coalesce-to-latest (`Map<issueId,{rerun,done}>`), enqueue is
 *    fire-and-forget and never throws into the trigger;
 *  - `DisplayWriteResult = changed | noop | deferred | failed` per face; the
 *    fingerprint persists ONLY when every face landed (changed|noop) — any
 *    failed/deferred face keeps the issue a sweep candidate;
 *  - 429 on a title write honors bounded short retries; a long Retry-After
 *    (thread renames are limited to ~2 per 10 min) defers to the sweep
 *    instead of sleeping the window away;
 *  - a self-healing sweep re-derives fingerprints and re-enqueues drift,
 *    including tmux-only drift (late window registration) via the probe
 *    component; terminal + archived + current issues cost nothing.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	editChatMessage,
	getChannelMessage,
	getChannelName,
	pinThreadMessage,
	postChatMessage,
	renameChannel,
} from "./bridge/chat-thread-utils.js";
import type { DisplayWriteResult } from "./bridge/issue-display.js";
import type { V2DisplayReader } from "./v2-display-state-reader.js";
import {
	applyV2TitleBadge,
	computeV2DisplayFingerprint,
	deriveV2IssueTitleBadge,
	deriveV2TaskDisplayState,
	isV2DisplayTerminal,
	renderV2PipelineHeader,
	type V2HeaderRow,
	type V2IssueDisplaySnapshot,
	v2AttachCommand,
	v2RunnerTmuxSessionName,
	v2SelfBadges,
	v2WindowMatchesIssue,
} from "./v2-issue-display.js";

const execFileAsync = promisify(execFile);

/** Durable per-issue display record, persisted in the messenger state file. */
export interface V2DisplayRecord {
	/** Confirmed-written fingerprint (all faces changed|noop). */
	fp?: string;
	/** The pinned header message id — persisted as soon as the post lands so
	 * a later failed pin/edit never duplicates the header. */
	headerMessageId?: string;
	/** Hash of the last header content that landed (zero-churn edit skip). */
	headerContent?: string;
	/** Codex design R2 #1: the pin outcome tracked separately — a posted but
	 * unpinned header keeps the face deferred and the pin retrying. */
	headerPinned?: boolean;
	/** Snapshot was terminal (closure done/failed) when fp persisted. */
	terminal?: boolean;
	/** Set when the deferred issue_closed archive was caught up by the sweep
	 * (or landed inline). terminal+archived+current issues are skipped. */
	archivedAt?: string;
	/** Codex design R1 #3: a 429'd title write persists the server's
	 * Retry-After horizon (epoch ms) — no title request is attempted before
	 * it, so a sweep-retried deferral can never violate the server's answer. */
	titleRetryNotBeforeMs?: number;
}

export interface V2DisplayStore {
	getThreadId(issueId: string): string | undefined;
	getRecord(issueId: string): V2DisplayRecord | undefined;
	setRecord(issueId: string, record: V2DisplayRecord): void;
	/** Sweep domain: every issue with a thread. */
	listIssues(): string[];
}

export interface V2DisplayRefresherOptions {
	reader: V2DisplayReader;
	store: V2DisplayStore;
	botToken: string;
	fetchImpl?: typeof fetch;
	/** Resolve a tmux session's current window name; null = session absent.
	 * Default shells out to `tmux display-message`. */
	probeWindowName?: (sessionName: string) => Promise<string | null>;
	/** Archive a thread (sweep catch-up for a deferred issue_closed archive).
	 * Returns true when archived (or already gone). */
	archiveThread?: (threadId: string) => Promise<boolean>;
	logger?: Pick<Console, "log" | "warn" | "error">;
	now?: () => number;
	/** Sweep cadence; 0 disables the sweep. Default 180_000. */
	sweepIntervalMs?: number;
	/** Max issues examined per sweep round (rotating cursor). Default 50. */
	sweepBatchLimit?: number;
	/** Bounded 429 retries on title reads/writes. Default 5. */
	titleRetryLimit?: number;
	/** Cap on one honored Retry-After sleep. Default 10_000. */
	titleRetrySleepCapMs?: number;
	/** A Retry-After beyond this defers to the sweep instead. Default 30_000. */
	titleDeferThresholdMs?: number;
	/** Hard bound on one tmux window-name probe. Default 3_000. */
	probeTimeoutMs?: number;
	/** Whole-snapshot probe deadline — a wedged tmux costs at most this per
	 * refresh, regardless of active-row count. Default 10_000. */
	probeSnapshotBudgetMs?: number;
	sleepImpl?: (ms: number) => Promise<void>;
}

interface RefreshQueueState {
	rerun: boolean;
	done: Promise<boolean>;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function defaultProbeWindowName(
	sessionName: string,
): Promise<string | null> {
	try {
		// Bounded: a wedged tmux server must never hang a refresh or the sweep
		// (Codex design R1 #7); the child is killed on timeout.
		const { stdout } = await execFileAsync(
			"tmux",
			["display-message", "-p", "-t", `=${sessionName}:`, "#{window_name}"],
			{ timeout: 3_000 },
		);
		const name = stdout.trim();
		return name.length > 0 ? name : null;
	} catch {
		return null;
	}
}

export class V2DisplayRefresher {
	readonly #options: V2DisplayRefresherOptions;
	readonly #logger: Pick<Console, "log" | "warn" | "error">;
	readonly #sleep: (ms: number) => Promise<void>;
	readonly #probe: (sessionName: string) => Promise<string | null>;
	readonly #queue = new Map<string, RefreshQueueState>();
	/** Issues inside an inline issue_closed sequence (refresh → archive HTTP
	 * → archivedAt stamp). The sweep's CAS treats a held issue like an
	 * in-flight refresh (Codex design R7 #1): the archive-await window is
	 * otherwise invisible — no queue entry, no archivedAt yet — and a late
	 * 404 verdict landing inside it would strand terminal+archived+no-fp. */
	readonly #held = new Set<string>();
	#lastSweepAt = 0;
	#sweepCursor = 0;
	#sweeping = false;

	constructor(options: V2DisplayRefresherOptions) {
		this.#options = options;
		this.#logger = options.logger ?? console;
		this.#sleep = options.sleepImpl ?? defaultSleep;
		this.#probe = options.probeWindowName ?? defaultProbeWindowName;
	}

	/**
	 * Run an inline lifecycle sequence (issue_closed: refresh → archive →
	 * archivedAt stamp) under the per-issue fence so no sweep verdict can
	 * interleave with its await windows.
	 */
	async holdIssue<T>(issueId: string, fn: () => Promise<T>): Promise<T> {
		this.#held.add(issueId);
		try {
			return await fn();
		} finally {
			this.#held.delete(issueId);
		}
	}

	/** Fire-and-forget trigger — never throws into the caller. */
	enqueue(issueId: string): void {
		void this.refresh(issueId).catch((error) => {
			this.#logger.warn(
				`[v2-display] refresh for ${issueId} failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		});
	}

	/**
	 * Coalesce-to-latest awaited refresh. Resolves true when the display is
	 * confirmed current (fingerprint persisted by the final pass).
	 */
	refresh(issueId: string): Promise<boolean> {
		const existing = this.#queue.get(issueId);
		if (existing) {
			existing.rerun = true;
			return existing.done;
		}
		const state: RefreshQueueState = {
			rerun: false,
			done: Promise.resolve(false),
		};
		state.done = (async () => {
			// Async boundary: triggers must never pay for kernel/tmux reads on
			// their own stack (FLY-907 discipline).
			await Promise.resolve();
			let landed = false;
			try {
				do {
					state.rerun = false;
					landed = await this.#refreshOnce(issueId);
				} while (state.rerun);
			} finally {
				this.#queue.delete(issueId);
			}
			return landed;
		})();
		this.#queue.set(issueId, state);
		return state.done;
	}

	/**
	 * Piggybacked on the messenger's pull loop — no new timer. A no-drift
	 * pass costs kernel reads only (zero Discord requests).
	 */
	async maybeSweep(): Promise<void> {
		const interval = this.#options.sweepIntervalMs ?? 180_000;
		if (interval <= 0 || this.#sweeping) return;
		const now = (this.#options.now ?? Date.now)();
		if (now - this.#lastSweepAt < interval) return;
		this.#lastSweepAt = now;
		this.#sweeping = true;
		try {
			await this.#sweepOnce();
		} catch (error) {
			this.#logger.warn(
				`[v2-display] sweep failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		} finally {
			this.#sweeping = false;
		}
	}

	async #sweepOnce(): Promise<void> {
		const issues = this.#options.store.listIssues();
		if (issues.length === 0) return;
		const limit = this.#options.sweepBatchLimit ?? 50;
		// Codex design R1 #4: the sweep is a correctness MAIN PATH (rework /
		// reap / writer-gap mutate tasks without a lifecycle outbox row), so
		// frozen entries must not consume batch slots. Terminal+archived+
		// current issues are skipped during candidate selection (a record
		// lookup each — no kernel read); the batch holds only live candidates.
		// Worst-case staleness ≈ ceil(liveCandidates / limit) × sweep interval.
		const batch: string[] = [];
		let consumed = 0;
		for (
			let index = 0;
			index < issues.length && batch.length < limit;
			index += 1
		) {
			const issueId = issues[
				(this.#sweepCursor + index) % issues.length
			] as string;
			consumed = index + 1;
			const record = this.#options.store.getRecord(issueId);
			if (record?.terminal && record.archivedAt && record.fp) continue;
			batch.push(issueId);
		}
		this.#sweepCursor = (this.#sweepCursor + consumed) % issues.length;
		for (const issueId of batch) {
			const record = this.#options.store.getRecord(issueId);
			const snapshot = this.#options.reader.read(issueId);
			if (!snapshot) continue;
			const probes = await this.#probeSnapshot(snapshot);
			const fingerprint = computeV2DisplayFingerprint(snapshot, probes);
			if (fingerprint !== record?.fp) {
				this.enqueue(issueId);
				continue;
			}
			// Codex design R4 #1: a CONVERGED header can still be deleted or
			// unpinned externally — the fast path would otherwise never look at
			// Discord again. Remote-verify once per sweep round (one GET per
			// live converged issue, bounded by the batch limit): 404 → clear
			// the record + fingerprint and repost; unpinned → clear the pin
			// confirmation AND the fingerprint (R5 #1: a later failed re-pin
			// must keep the issue an fp-mismatch sweep candidate, never wedge
			// at fp-current + headerPinned=false). Archived threads are frozen.
			// R5 #3 + R6: every async step below (GET / archive) races with the
			// per-issue refresh queue AND with an inline issue_closed archive.
			// A verdict or write is applied only when a re-read still shows the
			// EXACT state this round verified — same header, same fingerprint,
			// still unarchived — and no refresh is in flight. Otherwise the
			// round skips; the next sweep sees the newer state.
			const verifiedMessageId = record?.headerMessageId;
			const verifiedFp = record?.fp;
			const stillApplies = (
				current: V2DisplayRecord | undefined,
			): current is V2DisplayRecord =>
				!this.#queue.has(issueId) &&
				!this.#held.has(issueId) &&
				current !== undefined &&
				current.headerMessageId === verifiedMessageId &&
				current.fp === verifiedFp &&
				!current.archivedAt;
			if (record?.headerMessageId && !record.archivedAt) {
				const threadId = this.#options.store.getThreadId(issueId);
				if (threadId) {
					const message = await getChannelMessage(
						threadId,
						record.headerMessageId,
						this.#options.botToken,
						this.#restDeps(),
					);
					const fresh = this.#options.store.getRecord(issueId);
					if (!message.ok && message.status === 404) {
						if (!stillApplies(fresh)) continue;
						this.#logger.warn(
							`[v2-display] converged header for ${issueId} vanished — clearing for repost`,
						);
						const next = { ...fresh };
						delete next.headerMessageId;
						delete next.headerContent;
						delete next.headerPinned;
						delete next.fp;
						this.#options.store.setRecord(issueId, next);
						this.enqueue(issueId);
						continue;
					}
					if (!message.ok) {
						// R5 #2: transient verification failure (429/network) —
						// nothing below (incl. the archive catch-up) may act on an
						// unverified record this round.
						continue;
					}
					if (!message.pinned && fresh?.headerPinned) {
						if (!stillApplies(fresh)) continue;
						this.#logger.warn(
							`[v2-display] converged header for ${issueId} was unpinned — re-pinning`,
						);
						const next = { ...fresh, headerPinned: false };
						delete next.fp;
						this.#options.store.setRecord(issueId, next);
						this.enqueue(issueId);
						continue;
					}
					if (!stillApplies(fresh)) continue;
				}
			}
			// Current but the issue_closed archive was deferred — catch up.
			// R6 #2: CAS before the archive AND after its await — the archive
			// call itself is idempotent, so a skipped archivedAt stamp simply
			// lands on a later round once the state is quiet again.
			if (
				record?.terminal &&
				!record.archivedAt &&
				snapshot.closure === "done" &&
				this.#options.archiveThread
			) {
				if (!stillApplies(this.#options.store.getRecord(issueId))) continue;
				const threadId = this.#options.store.getThreadId(issueId);
				if (!threadId) continue;
				const archived = await this.#options.archiveThread(threadId);
				if (archived) {
					const freshest = this.#options.store.getRecord(issueId);
					if (!stillApplies(freshest)) continue;
					this.#options.store.setRecord(issueId, {
						...freshest,
						archivedAt: new Date(
							(this.#options.now ?? Date.now)(),
						).toISOString(),
					});
					this.#logger.log(
						`[v2-display] sweep archived ${issueId} after deferred close`,
					);
				}
			}
		}
	}

	/** Codex design R3 #3: probes run with bounded concurrency under ONE
	 * whole-snapshot deadline — a wedged tmux costs at most the budget per
	 * refresh even for a 500-active legal DAG, never probes × timeout. Past
	 * the deadline the remaining sessions read as absent (deferred, sweep
	 * retries). */
	async #probeSnapshot(
		snapshot: V2IssueDisplaySnapshot,
	): Promise<Record<string, string | null>> {
		const names: string[] = [];
		const seen = new Set<string>();
		for (const task of snapshot.tasks) {
			const sessionRef = task.attempt?.sessionRef;
			if (!sessionRef) continue;
			if (deriveV2TaskDisplayState(task) !== "active") continue;
			const sessionName = v2RunnerTmuxSessionName(sessionRef);
			if (seen.has(sessionName)) continue;
			seen.add(sessionName);
			names.push(sessionName);
		}
		const probes: Record<string, string | null> = {};
		if (names.length === 0) return probes;
		const perProbeMs = this.#options.probeTimeoutMs ?? 3_000;
		const budgetMs = this.#options.probeSnapshotBudgetMs ?? 10_000;
		const deadline = Date.now() + budgetMs;
		let cursor = 0;
		const worker = async (): Promise<void> => {
			while (cursor < names.length) {
				const name = names[cursor] as string;
				cursor += 1;
				const remaining = deadline - Date.now();
				if (remaining <= 0) {
					probes[name] = null;
					continue;
				}
				probes[name] = await this.#probeBounded(
					name,
					Math.min(perProbeMs, remaining),
				);
			}
		};
		const workers = Math.min(4, names.length);
		await Promise.all(Array.from({ length: workers }, () => worker()));
		return probes;
	}

	/** A probe that never resolves must not wedge a refresh or the sweep
	 * (Codex design R1 #7) — bounded regardless of the injected impl; a
	 * timeout reads as "session absent" (deferred, sweep retries). */
	#probeBounded(
		sessionName: string,
		timeoutMs: number,
	): Promise<string | null> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(null), timeoutMs);
			this.#probe(sessionName).then(
				(value) => {
					clearTimeout(timer);
					resolve(value);
				},
				() => {
					clearTimeout(timer);
					resolve(null);
				},
			);
		});
	}

	async #refreshOnce(issueId: string): Promise<boolean> {
		const threadId = this.#options.store.getThreadId(issueId);
		if (!threadId) return false;
		const snapshot = this.#options.reader.read(issueId);
		if (!snapshot) return false;
		const probes = await this.#probeSnapshot(snapshot);
		const fingerprint = computeV2DisplayFingerprint(snapshot, probes);
		const record = this.#options.store.getRecord(issueId) ?? {};
		// Fast path only when the LAST confirmed state is genuinely converged:
		// a matching fingerprint with a header that was posted but never pinned
		// must keep retrying (Codex design R3 #2 — R1-era records could carry
		// fp-with-unpinned-header; the render-version bump also invalidates
		// every pre-R3 fingerprint once).
		if (
			record.fp === fingerprint &&
			(!record.headerMessageId || record.headerPinned === true)
		) {
			return true;
		}
		// fp current but pin outstanding: fall through to the normal pass —
		// the title no-ops (zero-churn) and the header face retries the pin.

		const { result: faceA, record: afterA } = await this.#writeTitle(
			issueId,
			threadId,
			snapshot,
			record,
		);
		const { result: faceB, record: afterB } = await this.#writeHeader(
			issueId,
			threadId,
			snapshot,
			probes,
			afterA,
		);

		const landed =
			(faceA === "changed" || faceA === "noop") &&
			(faceB === "changed" || faceB === "noop");
		if (landed) {
			this.#options.store.setRecord(issueId, {
				...afterB,
				fp: fingerprint,
				terminal: isV2DisplayTerminal(snapshot),
			});
		} else {
			// Codex code R1 #1: a pass that wrote SOMETHING but did not fully
			// land leaves Discord in a mixed state — the previously confirmed
			// fingerprint no longer describes it. Drop it, or a later state
			// flip back to the old fingerprint would fast-path over the
			// half-written surfaces and freeze them.
			if (afterB.fp !== undefined) {
				const next = { ...afterB };
				delete next.fp;
				this.#options.store.setRecord(issueId, next);
			}
			this.#logger.warn(
				`[v2-display] ${issueId} not confirmed (title=${faceA} header=${faceB}) — fingerprint withheld, sweep will retry`,
			);
		}
		return landed;
	}

	/** Face A — the title badge. Zero-churn: identical name never PATCHes.
	 * Honors a persisted Retry-After horizon across passes and sweeps
	 * (Codex design R1 #3): after a 429 deferral no title request fires
	 * before the server-given time. */
	async #writeTitle(
		issueId: string,
		threadId: string,
		snapshot: V2IssueDisplaySnapshot,
		record: V2DisplayRecord,
	): Promise<{ result: DisplayWriteResult; record: V2DisplayRecord }> {
		const badge = deriveV2IssueTitleBadge(snapshot);
		if (badge === null) return { result: "noop", record };
		const now = (this.#options.now ?? Date.now)();
		if (record.titleRetryNotBeforeMs && now < record.titleRetryNotBeforeMs) {
			return { result: "deferred", record };
		}
		const deps = this.#restDeps();
		const retryLimit = this.#options.titleRetryLimit ?? 5;
		const sleepCap = this.#options.titleRetrySleepCapMs ?? 10_000;
		const deferThreshold = this.#options.titleDeferThresholdMs ?? 30_000;

		const deferWithHorizon = (retryAfterMs: number | undefined) => {
			// Persist the server's answer (bounded to v1's 600s max) so the
			// sweep respects it instead of re-asking early.
			const horizon =
				(this.#options.now ?? Date.now)() +
				Math.min(retryAfterMs ?? 10_000, 600_000);
			const next = { ...record, titleRetryNotBeforeMs: horizon };
			this.#options.store.setRecord(issueId, next);
			return { result: "deferred" as const, record: next };
		};
		const clearHorizon = (result: DisplayWriteResult) => {
			if (!record.titleRetryNotBeforeMs) return { result, record };
			const next = { ...record };
			delete next.titleRetryNotBeforeMs;
			this.#options.store.setRecord(issueId, next);
			return { result, record: next };
		};

		for (let attempt = 0; ; attempt += 1) {
			const current = await getChannelName(
				threadId,
				this.#options.botToken,
				deps,
			);
			if (!current.ok) {
				if (current.status === 429) {
					if (
						attempt >= retryLimit ||
						(current.retryAfterMs ?? 0) > deferThreshold
					) {
						return deferWithHorizon(current.retryAfterMs);
					}
					await this.#sleep(Math.min(current.retryAfterMs ?? 10_000, sleepCap));
					continue;
				}
				return { result: "failed", record };
			}
			if (current.archived) return { result: "deferred", record };
			const desired = applyV2TitleBadge(
				current.name,
				badge,
				v2SelfBadges(snapshot),
			);
			if (desired === current.name) return clearHorizon("noop");
			const renamed = await renameChannel(
				threadId,
				desired,
				this.#options.botToken,
				deps,
			);
			if (renamed.ok) return clearHorizon("changed");
			if (renamed.status === 429) {
				if (
					attempt >= retryLimit ||
					(renamed.retryAfterMs ?? 0) > deferThreshold
				) {
					return deferWithHorizon(renamed.retryAfterMs);
				}
				await this.#sleep(Math.min(renamed.retryAfterMs ?? 10_000, sleepCap));
				continue;
			}
			if (renamed.archived) return { result: "deferred", record };
			this.#logger.warn(
				`[v2-display] title write failed for ${issueId}: ${renamed.error}`,
			);
			return { result: "failed", record };
		}
	}

	/** Face B — the pinned pipeline header (carries the status vocabulary —
	 * FLY-907 final form: status converges into the ONE pinned block). */
	async #writeHeader(
		issueId: string,
		threadId: string,
		snapshot: V2IssueDisplaySnapshot,
		probes: Record<string, string | null>,
		record: V2DisplayRecord,
	): Promise<{ result: DisplayWriteResult; record: V2DisplayRecord }> {
		if (snapshot.tasks.length === 0) return { result: "noop", record };
		let anyUnresolvedLive = false;
		const rows: V2HeaderRow[] = snapshot.tasks.map((task) => {
			const state = deriveV2TaskDisplayState(task);
			const row: V2HeaderRow = { view: task, state };
			const sessionRef = task.attempt?.sessionRef;
			if (state === "active" && sessionRef) {
				const sessionName = v2RunnerTmuxSessionName(sessionRef);
				const windowName = probes[sessionName] ?? null;
				if (windowName === null) {
					// Live per the kernel but no resolvable tmux session yet —
					// render degraded and stay a sweep candidate.
					row.attach = { unresolved: true };
					anyUnresolvedLive = true;
				} else if (!v2WindowMatchesIssue(issueId, windowName)) {
					// Cross-wire: the window belongs to another issue. Withhold
					// the command (deliberate content, not a deferral) and leave
					// loud evidence (FLY-923 discipline).
					this.#logger.warn(
						`[v2-display] attach cross-wire for ${issueId}: session ${sessionName} window "${windowName}" — withholding attach command`,
					);
					row.attach = { unresolved: true };
				} else {
					row.attach = { command: v2AttachCommand(sessionRef) };
				}
			}
			return row;
		});
		const content = renderV2PipelineHeader(issueId, rows);
		const deps = this.#restDeps();

		if (record.headerMessageId) {
			let next = record;
			let edited = false;
			if (record.headerContent !== content) {
				const edit = await editChatMessage(
					{
						channelId: threadId,
						messageId: record.headerMessageId,
						content,
						botToken: this.#options.botToken,
					},
					deps,
				);
				if (edit.edited) {
					next = { ...record, headerContent: content };
					this.#options.store.setRecord(issueId, next);
					edited = true;
				} else if (edit.status === 404) {
					// The header message vanished — fall through to a fresh post.
					record = { ...record };
					delete record.headerMessageId;
					delete record.headerContent;
					delete record.headerPinned;
				} else if (edit.status === 429) {
					return { result: "deferred", record };
				} else {
					this.#logger.warn(
						`[v2-display] header edit failed for ${issueId}: ${edit.error}`,
					);
					return { result: "failed", record };
				}
			}
			if (record.headerMessageId) {
				// Codex design R2 #1: an unpinned header must not read as
				// converged — the pin retries until it lands, and until then the
				// face stays deferred (fingerprint withheld, sweep retries).
				if (!next.headerPinned) {
					const pinned = await this.#ensurePinned(
						issueId,
						threadId,
						record.headerMessageId,
						next,
					);
					if (!pinned.ok) return { result: "deferred", record: pinned.record };
					next = pinned.record;
					edited = true;
				}
				return {
					result: anyUnresolvedLive ? "deferred" : edited ? "changed" : "noop",
					record: next,
				};
			}
		}

		const posted = await postChatMessage(
			{ channelId: threadId, content, botToken: this.#options.botToken },
			deps,
		);
		if (!posted.posted) {
			if (posted.status === 429) return { result: "deferred", record };
			this.#logger.warn(
				`[v2-display] header post failed for ${issueId}: ${posted.error}`,
			);
			return { result: "failed", record };
		}
		// Persist the message id IMMEDIATELY — a failed pin below must never
		// cause a duplicate header on the next pass.
		let next: V2DisplayRecord = {
			...record,
			headerMessageId: posted.messageId,
			headerContent: content,
			headerPinned: false,
		};
		this.#options.store.setRecord(issueId, next);
		const pinned = await this.#ensurePinned(
			issueId,
			threadId,
			posted.messageId,
			next,
		);
		if (!pinned.ok) return { result: "deferred", record: pinned.record };
		next = pinned.record;
		return {
			result: anyUnresolvedLive ? "deferred" : "changed",
			record: next,
		};
	}

	async #ensurePinned(
		issueId: string,
		threadId: string,
		messageId: string,
		record: V2DisplayRecord,
	): Promise<{ ok: boolean; record: V2DisplayRecord }> {
		const pin = await pinThreadMessage(
			threadId,
			messageId,
			this.#options.botToken,
			this.#restPinDeps(),
		);
		if (pin.outcome === "missing") {
			// Codex design R3 #1: the header message is GONE (deleted) — a 404
			// must clear the record so the next pass reposts, never PUT the
			// same dead id forever. The fingerprint goes too (R5 #1): a
			// persisted fp with no headerMessageId would satisfy the fast path
			// and the repost would never happen.
			this.#logger.warn(
				`[v2-display] header message for ${issueId} vanished — clearing record for repost`,
			);
			const next = { ...record };
			delete next.headerMessageId;
			delete next.headerContent;
			delete next.headerPinned;
			delete next.fp;
			this.#options.store.setRecord(issueId, next);
			return { ok: false, record: next };
		}
		if (pin.outcome !== "pinned") {
			// Posted but not pinned: content is visible; the pin retries via the
			// sweep (deferred keeps the fingerprint unpersisted).
			this.#logger.warn(
				`[v2-display] header pin for ${issueId} is ${pin.outcome}`,
			);
			return { ok: false, record };
		}
		const next = { ...record, headerPinned: true };
		this.#options.store.setRecord(issueId, next);
		return { ok: true, record: next };
	}

	#restDeps(): { fetchImpl?: typeof fetch } {
		return this.#options.fetchImpl
			? { fetchImpl: this.#options.fetchImpl }
			: {};
	}

	#restPinDeps(): { fetchImpl?: typeof fetch } {
		return this.#restDeps();
	}
}
