import type {
	BodyObservation,
	CodexExecutionOwnershipRegistry,
	CodexProcessRecord,
	CodexStopResult,
	CodexUnattributedProcess,
} from "flywheel-claude-runner";
import type { Session } from "../StateStore.js";
import type { CodexDaemonTeardownResult } from "./codex-daemon-teardown.js";
import type { RolloutTokenRead } from "./codex-rollout-token-watch.js";
import {
	CODEX_TERMINAL_SWEEP_STATUSES,
	type CodexTerminalCloseEvidence,
	type CodexTerminalCloseObservation,
	type CodexTerminalCloseRow,
	type CodexTerminalCloseState,
	type CodexTerminalCloseStore,
	type CodexTerminalCloseWrite,
} from "./codex-terminal-close-ledger.js";

/**
 * FLY-2903 terminal-body sweep. Once per maintenance tick, every terminal
 * Codex execution from the last 48h (plus any terminal execution that still
 * has a live codex process, whatever its age) gets a close verdict that is
 * proven by a current BodyObservation, or an alert.
 *
 * It adds no kill path: the only signal comes from the existing
 * `reapCodexDaemonForExecution` (ledger pgid proven to hold the socket, with a
 * synchronous final guard); `requestStop` only asks the in-process runtime to
 * stop itself. Anything that cannot be proven is alerted, never signalled.
 */

export const CODEX_TERMINAL_SWEEP_SOURCE = "bridge.codex-terminal-sweep";
const MAX_CANDIDATES = 25;
const SOFT_BUDGET_MS = 30_000;
const SWEEP_STOP_WAIT_MS = 5_000;
const UNKNOWN_ALERT_STREAK = 3;
const OWNED_STOP_STREAK = 2;
const SKIPPED_BODY_STATES = new Set(["standby", "resuming", "retiring"]);
const HELD_RESIDENT_STATES = new Set(["resident", "woken"]);
const TERMINAL = new Set<string>(CODEX_TERMINAL_SWEEP_STATUSES);

export type SweepSession = Pick<
	Session,
	| "execution_id"
	| "issue_id"
	| "project_name"
	| "status"
	| "adapter_type"
	| "terminal_at"
	| "issue_identifier"
>;

export interface SweepTokenObservation {
	rolloutPath: string | null;
	read?: RolloutTokenRead;
	error?: "rollout_read_failed";
}

export interface CodexTerminalSweepAlert {
	executionId: string;
	issueIdentifier: string | null;
	projectName: string | null;
	sessionStatus: string;
	terminalAt: string | null;
	state: CodexTerminalCloseState;
	tokensAfterTerminal: number | null;
	/** `requestStop:<result>` / `reap:<outcome>` / `none`. */
	action: string;
	/** Dedupe key: `<state>:<token order of magnitude | u>`. */
	alertKey: string;
}

export interface CodexTerminalSweepDeps {
	now: () => Date;
	ledger: Pick<
		CodexTerminalCloseStore,
		"get" | "listSweepCandidateExecutionIds"
	>;
	/** Bound single writer (`observeCodexTerminalClose`). */
	observe: (
		executionId: string,
		observation: CodexTerminalCloseObservation,
	) => CodexTerminalCloseWrite;
	getSession: (executionId: string) => SweepSession | undefined;
	processBodyState: (executionId: string) => string | undefined;
	residentHoldState: (executionId: string) => string | undefined;
	/** One parsed FLY-2877 process snapshot per tick; a throw means unknown. */
	snapshot: () => Promise<{
		codex: CodexProcessRecord[];
		unattributed: CodexUnattributedProcess[];
	}>;
	owners: Pick<
		CodexExecutionOwnershipRegistry,
		"ownershipState" | "requestStop"
	>;
	bodyObserver: {
		observe(executionId: string): Promise<BodyObservation | undefined>;
		isCurrent(observation: BodyObservation): boolean;
	};
	/** Pending completion reconciliation vetoes destructive cleanup. */
	completionPending(executionId: string): boolean;
	/** Current TURN/activation permission, independent of physical liveness. */
	stopAuthorized(executionId: string): boolean;
	/** The existing Bridge reap; `beforeSignal` is its synchronous final guard. */
	reap: (
		session: SweepSession,
		beforeSignal: () => boolean,
	) => Promise<CodexDaemonTeardownResult>;
	tokens: (input: {
		executionId: string;
		session: SweepSession;
		row: CodexTerminalCloseRow | undefined;
		processHomes: readonly string[];
	}) => SweepTokenObservation;
	/** Best-effort unlink of this execution's own socket path (never a link target). */
	unlinkSocket: (executionId: string) => void;
	/** Kill switch for the sweep's requestStop and reap only. */
	reapEnabled: () => boolean;
	alert: (alert: CodexTerminalSweepAlert) => Promise<void>;
	log?: (line: string) => void;
	maxCandidates?: number;
	budgetMs?: number;
	clockMs?: () => number;
}

export interface CodexTerminalSweepResult {
	skipped?: "inflight";
	candidates: number;
	evaluated: number;
	deferred: number;
	skippedBodies: number;
	states: Partial<Record<CodexTerminalCloseState, number>>;
}

type Verdict = "active" | "alive" | "unknown" | "closed";

interface ProcessView {
	status: "ok" | "unknown";
	byExecution: Map<string, CodexProcessRecord[]>;
}

/** `terminal_at` is SQLite `datetime('now')` (UTC, no zone) or ISO. */
export function parseTerminalAtMs(
	value: string | null | undefined,
): number | null {
	if (!value) return null;
	const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : null;
}

function tokenBucket(tokens: number | null): string {
	return tokens === null || tokens < 0
		? "u"
		: String(Math.floor(Math.log10(tokens + 1)));
}

export class CodexTerminalSweep {
	private inflight = false;

	constructor(private readonly deps: CodexTerminalSweepDeps) {}

	async tick(): Promise<CodexTerminalSweepResult> {
		const empty: CodexTerminalSweepResult = {
			candidates: 0,
			evaluated: 0,
			deferred: 0,
			skippedBodies: 0,
			states: {},
		};
		if (this.inflight) {
			this.log("sweep_skipped_inflight");
			return { ...empty, skipped: "inflight" };
		}
		this.inflight = true;
		try {
			return await this.run(empty);
		} finally {
			this.inflight = false;
		}
	}

	private log(line: string): void {
		(this.deps.log ?? ((l: string) => console.log(l)))(
			`[codex-terminal-sweep] ${line}`,
		);
	}

	private async run(
		result: CodexTerminalSweepResult,
	): Promise<CodexTerminalSweepResult> {
		const clockMs = this.deps.clockMs ?? Date.now;
		const startedMs = clockMs();
		const budgetMs = this.deps.budgetMs ?? SOFT_BUDGET_MS;
		const now = this.deps.now();
		const view = await this.processView();
		const candidates = this.candidates(now, view);
		result.candidates = candidates.length;
		for (const [index, session] of candidates.entries()) {
			if (clockMs() - startedMs >= budgetMs) {
				result.deferred = candidates.length - index;
				this.log(`budget spent; ${result.deferred} candidate(s) deferred`);
				break;
			}
			const exec = session.execution_id;
			try {
				const state = await this.sweepOne(session, view);
				if (!state) {
					result.skippedBodies += 1;
					continue;
				}
				result.states[state] = (result.states[state] ?? 0) + 1;
			} catch (error) {
				this.log(
					`candidate ${exec} failed: ${error instanceof Error ? error.message : String(error)}`,
				);
				this.recordFailure(session, "sweep_candidate_failed");
			}
			result.evaluated += 1;
		}
		return result;
	}

	private safe<T>(fn: () => T): T | undefined {
		try {
			return fn();
		} catch {
			return undefined;
		}
	}

	private async processView(): Promise<ProcessView> {
		try {
			const parsed = await this.deps.snapshot();
			const byExecution = new Map<string, CodexProcessRecord[]>();
			for (const record of parsed.codex) {
				if (!record.executionId) continue;
				byExecution.set(record.executionId, [
					...(byExecution.get(record.executionId) ?? []),
					record,
				]);
			}
			return {
				status: parsed.unattributed.length > 0 ? "unknown" : "ok",
				byExecution,
			};
		} catch (error) {
			this.log(
				`process snapshot unavailable: ${error instanceof Error ? error.message : String(error)}`,
			);
			return { status: "unknown", byExecution: new Map() };
		}
	}

	/** Live-process hits first (no age limit), then the 48h ledger backlog. */
	private candidates(now: Date, view: ProcessView): SweepSession[] {
		const eligible = (session: SweepSession | undefined) =>
			!!session &&
			session.adapter_type === "codex-tmux" &&
			TERMINAL.has(session.status);
		const live: SweepSession[] = [];
		for (const exec of view.byExecution.keys()) {
			const session = this.safe(() => this.deps.getSession(exec));
			if (!eligible(session) || !session) continue;
			const terminalMs = parseTerminalAtMs(session.terminal_at);
			if (terminalMs !== null && terminalMs > now.getTime()) continue;
			live.push(session);
		}
		live.sort(
			(a, b) =>
				(parseTerminalAtMs(a.terminal_at) ?? 0) -
				(parseTerminalAtMs(b.terminal_at) ?? 0),
		);
		const max = this.deps.maxCandidates ?? MAX_CANDIDATES;
		const seen = new Set(live.map((session) => session.execution_id));
		const out = live.slice(0, max);
		if (out.length >= max) return out;
		for (const exec of this.deps.ledger.listSweepCandidateExecutionIds({
			now,
			limit: max * 2,
		})) {
			if (out.length >= max) break;
			if (seen.has(exec)) continue;
			const session = this.safe(() => this.deps.getSession(exec));
			if (!eligible(session) || !session) continue;
			seen.add(exec);
			out.push(session);
		}
		return out;
	}

	private recordFailure(session: SweepSession, error: string): void {
		try {
			const row = this.deps.ledger.get(session.execution_id);
			this.deps.observe(session.execution_id, {
				...this.base(session, row),
				state: "probe_unknown",
				unknownStreak: (row?.unknown_streak ?? 0) + 1,
				ownedStreak: 0,
				evidence: { error },
			});
		} catch {
			// The ledger itself is unavailable; the next tick retries.
		}
	}

	private base(
		session: SweepSession,
		row: CodexTerminalCloseRow | undefined,
	): Omit<CodexTerminalCloseObservation, "state" | "evidence"> {
		return {
			source: CODEX_TERMINAL_SWEEP_SOURCE,
			projectName: session.project_name ?? row?.project_name ?? null,
			issueIdentifier:
				session.issue_identifier ?? session.issue_id ?? row?.issue_identifier,
			sessionStatus: session.status,
			terminalAt: session.terminal_at ?? null,
		};
	}

	private finalGuard(
		exec: string,
		observation: BodyObservation,
		allowOwned = false,
	): () => boolean {
		return () => {
			if (
				!this.deps.reapEnabled() ||
				!this.currentBody(exec, observation) ||
				!this.deps.stopAuthorized(exec)
			)
				return false;
			const current = this.deps.getSession(exec);
			if (!current || !TERMINAL.has(current.status)) return false;
			if (!allowOwned && this.deps.owners.ownershipState(exec) === "active")
				return false;
			const hold = this.deps.residentHoldState(exec);
			if (hold && HELD_RESIDENT_STATES.has(hold)) return false;
			const body = this.deps.processBodyState(exec);
			if (body && SKIPPED_BODY_STATES.has(body)) return false;
			return true;
		};
	}

	private async sweepOne(
		session: SweepSession,
		view: ProcessView,
	): Promise<CodexTerminalCloseState | undefined> {
		const exec = session.execution_id;
		const row = this.deps.ledger.get(exec);
		const reapOn = this.deps.reapEnabled();
		const evidence: CodexTerminalCloseEvidence = {};

		const ownership = this.deps.owners.ownershipState(exec);
		evidence.ownership = ownership;

		const procs =
			view.status === "ok" ? (view.byExecution.get(exec) ?? []) : null;
		evidence.procs = {
			status: procs === null ? "unknown" : "ok",
			count: procs?.length ?? view.byExecution.get(exec)?.length ?? 0,
		};

		let body: BodyObservation | undefined;
		try {
			body = await this.deps.bodyObserver.observe(exec);
			evidence.liveness =
				body?.verdict === "dead" ? "absent" : (body?.verdict ?? "unknown");
			if (body?.verdict === "unknown") evidence.error = "body_evidence_unknown";
		} catch {
			evidence.error = "evidence_probe_failed";
		}
		if (
			ownership === "reserved" &&
			body?.verdict === "dead" &&
			this.currentBody(exec, body)
		) {
			// Fence only a proven-dead reservation; this memory operation sends no signal.
			evidence.ownerStop = await this.deps.owners.requestStop(
				exec,
				"terminal_sweep",
				{ timeoutMs: 0 },
			);
			body = await this.deps.bodyObserver.observe(exec);
		}
		// Intentional standby is protected from stop/reap, but never proves death.
		const processBody = this.deps.processBodyState(exec);
		if (
			body?.verdict !== "dead" &&
			processBody &&
			SKIPPED_BODY_STATES.has(processBody)
		)
			return undefined;

		const processHomes = [
			...new Set(
				(view.byExecution.get(exec) ?? [])
					.map((record) => record.codexHome)
					.filter((home): home is string => !!home),
			),
		];
		let tokenView: SweepTokenObservation = { rolloutPath: null };
		try {
			tokenView = this.deps.tokens({
				executionId: exec,
				session,
				row,
				processHomes,
			});
		} catch {
			tokenView = {
				rolloutPath: row?.rollout_path ?? null,
				error: "rollout_read_failed",
			};
		}
		const read = tokenView.read;
		evidence.rollout = read
			? (read.note ?? "ok")
			: tokenView.rolloutPath
				? "ok"
				: "unresolved";
		if (tokenView.error && !evidence.error) evidence.error = tokenView.error;
		const tokens: CodexTerminalCloseObservation["tokens"] = {
			// A moved or vanished rollout replaces (or clears) the cached path.
			...(tokenView.rolloutPath !== (row?.rollout_path ?? null)
				? { rolloutPath: tokenView.rolloutPath }
				: {}),
			...(read
				? {
						rolloutOffset: read.offset,
						rolloutLastTotal: read.lastTotal,
						tokensAtTerminal: read.tokensAtTerminal,
						tokensAfterTerminal: read.tokensAfterTerminal,
					}
				: {}),
		};
		const tokensAfter = read
			? read.tokensAfterTerminal
			: (row?.tokens_after_terminal ?? null);

		const verdict = this.verdict(exec, ownership, body);
		let state: CodexTerminalCloseState;
		let ownedStreak = 0;
		let unknownStreak = 0;
		let alertAction: string | undefined;
		let closedAt: string | undefined;

		switch (verdict) {
			case "active": {
				ownedStreak = (row?.owned_streak ?? 0) + 1;
				if (ownedStreak < OWNED_STOP_STREAK) {
					state = "owned_seen";
				} else if (reapOn && body && this.finalGuard(exec, body, true)()) {
					const stop = await this.deps.owners.requestStop(
						exec,
						"terminal_sweep",
						{ timeoutMs: SWEEP_STOP_WAIT_MS },
					);
					evidence.ownerStop = stop;
					state = "stop_requested";
					alertAction = `requestStop:${stop satisfies CodexStopResult}`;
				} else {
					state = "owned_seen";
					alertAction = "none";
				}
				break;
			}
			case "alive": {
				if (!reapOn) {
					state = "alive_residual";
					alertAction = "none";
					break;
				}
				if (!body || !this.finalGuard(exec, body)()) {
					state = "alive_unverifiable";
					alertAction = "none";
					break;
				}
				const reaped = await this.deps.reap(
					session,
					this.finalGuard(exec, body!),
				);
				const outcome =
					reaped.outcome === "not_codex" ? "unverifiable" : reaped.outcome;
				evidence.reap = outcome;
				state =
					outcome === "residual"
						? "alive_residual"
						: outcome === "unverifiable"
							? "alive_unverifiable"
							: "alive_reaped_pending";
				// A terminal body that was still alive is always worth a line, even
				// when the reap worked (the issue asks to reap AND alert).
				alertAction = `reap:${outcome}`;
				break;
			}
			case "closed": {
				// Token reads are diagnostics, never another clock for process death.
				// There is no await between the exact-body fence, cleanup and close write.
				if (!body || !this.currentBody(exec, body)) {
					state = "probe_unknown";
					unknownStreak = (row?.unknown_streak ?? 0) + 1;
					break;
				}
				state = "closed";
				closedAt = this.deps.now().toISOString();
				try {
					this.deps.unlinkSocket(exec);
				} catch {
					/* UI/socket residue is retried separately. */
				}
				break;
			}

			default: {
				state = "probe_unknown";
				unknownStreak = (row?.unknown_streak ?? 0) + 1;
				if (unknownStreak >= UNKNOWN_ALERT_STREAK) alertAction = "none";
			}
		}

		const alertKey = `${state}:${tokenBucket(tokensAfter)}`;
		let alertedKey: string | undefined;
		if (alertAction !== undefined && row?.alerted_key !== alertKey) {
			try {
				await this.deps.alert({
					executionId: exec,
					issueIdentifier: session.issue_identifier ?? session.issue_id ?? null,
					projectName: session.project_name ?? null,
					sessionStatus: session.status,
					terminalAt: session.terminal_at ?? null,
					state,
					tokensAfterTerminal: tokensAfter,
					action: alertAction,
					alertKey,
				});
				alertedKey = alertKey;
			} catch (error) {
				this.log(
					`alert for ${exec} (${state}) deferred: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		if (body && body.verdict !== "unknown" && !this.currentBody(exec, body)) {
			state = "probe_unknown";
			closedAt = undefined;
			unknownStreak = (row?.unknown_streak ?? 0) + 1;
		}

		this.deps.observe(exec, {
			...this.base(session, row),
			state,
			evidence,
			ownedStreak,
			unknownStreak,
			tokens,
			...(closedAt ? { closedAt } : {}),
			...(alertedKey ? { alertedKey } : {}),
		});
		return state;
	}

	/** Authoritative process proof precedes diagnostic registries and token age. */
	private verdict(
		exec: string,
		ownership: "none" | "reserved" | "active",
		body: BodyObservation | undefined,
	): Verdict {
		if (!body || body.verdict === "unknown") return "unknown";
		if (!this.currentBody(exec, body)) return "unknown";
		if (body.verdict === "dead") return "closed";
		return ownership === "active" || ownership === "reserved"
			? "active"
			: "alive";
	}
	private currentBody(exec: string, observation: BodyObservation): boolean {
		try {
			return (
				observation.identity.executionId === exec &&
				this.deps.bodyObserver.isCurrent(observation) &&
				!this.deps.completionPending(exec) &&
				TERMINAL.has(this.deps.getSession(exec)?.status ?? "")
			);
		} catch {
			return false;
		}
	}
}
