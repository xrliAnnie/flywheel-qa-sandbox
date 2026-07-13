/**
 * FLY-228 / FLY-229: pure, unit-testable helpers for the runner-lifecycle MCP
 * tools (`runner_terminal_list` classification + `close_runner --abandon`).
 *
 * Terminal MCP can only read the per-machine CommDB (status ∈
 * {running, completed, timeout}) + a live tmux probe. It CANNOT see the Bridge
 * WorkflowFSM state (awaiting_review, etc.), so classification is strictly
 * (CommDB status, tmux liveness) — it never claims FSM state.
 */

/** FLY-229 row class derived from (CommDB status, tmux liveness). */
export type RunnerClass = "running" | "parked-alive" | "dead";

/**
 * Classify a runner row. `running` rows are always surfaced (liveness is only
 * annotated, never used to hide a running row — preserves prior behavior).
 * Terminal rows (completed/timeout) split on liveness: alive = `parked-alive`
 * (idle, re-engageable), not alive = `dead`.
 */
export function classifyRunnerRow(status: string, alive: boolean): RunnerClass {
	if (status === "running") return "running";
	return alive ? "parked-alive" : "dead";
}

export interface RunnerRow {
	executionId: string;
	tmuxWindow: string;
	issueId: string | null;
	status: string;
	alive: boolean;
	startedAt: string;
}

export const REENGAGE_HINT =
	"→ re-engageable via 'flywheel-comm send' / SendMessage (no new run needed)";

/** Render one row: `[id] tmux=… issue=… status=… alive=… class=… started=…`. */
export function formatRunnerRow(row: RunnerRow): string {
	const cls = classifyRunnerRow(row.status, row.alive);
	const base = `[${row.executionId}] tmux=${row.tmuxWindow} issue=${row.issueId ?? "-"} status=${row.status} alive=${row.alive} class=${cls} started=${row.startedAt}`;
	return cls === "parked-alive" ? `${base} ${REENGAGE_HINT}` : base;
}

export interface BuildListInput {
	/** running rows (already lead-scoped + alive-probed); ALWAYS shown. */
	running: RunnerRow[];
	/** terminal rows fetched within the cap (already lead-scoped + alive-probed). */
	terminal: RunnerRow[];
	/** total terminal rows in scope (countTerminalSessions) — for truncation. */
	terminalTotal: number;
	/** the probe cap used to fetch `terminal`. */
	cap: number;
	/** default true = hide `dead` terminal rows; false = show all classes. */
	activeOnly: boolean;
}

/**
 * Build the `runner_terminal_list` text. Running rows always render; terminal
 * rows render as parked-alive/dead (dead hidden when activeOnly). A single
 * count-only truncation summary is appended when more in-scope terminal rows
 * exist than were examined (Codex R2 LOW-1: no synthetic per-row "unknown").
 */
export function buildRunnerListText(input: BuildListInput): string {
	const lines: string[] = [];
	for (const r of input.running) lines.push(formatRunnerRow(r));
	for (const r of input.terminal) {
		const cls = classifyRunnerRow(r.status, r.alive);
		if (input.activeOnly && cls === "dead") continue;
		lines.push(formatRunnerRow(r));
	}
	if (input.terminalTotal > input.cap) {
		const n = input.terminalTotal - input.cap;
		lines.push(
			`(${n} older in-scope terminal session${n === 1 ? "" : "s"} not examined; liveness unknown — raise the cap or query CommDB directly)`,
		);
	}
	return lines.length === 0 ? "No sessions found." : lines.join("\n");
}

/**
 * FLY-228: the ONLY FSM states a `close_runner --abandon` may resolve by issue
 * lookup — the parked states. Deliberately NOT a union with the close-eligible
 * set (Codex R1 MED-1): a union would hit the >1 disambiguation guard whenever
 * a historical `completed` execution coexists with the current parked one.
 */
export const ABANDON_STATUS_SET = [
	"awaiting_review",
	"approved_to_ship",
] as const;

export const ABANDON_STATUSES_PARAM = ABANDON_STATUS_SET.join(",");

/**
 * FLY-638: the FSM states a `close_runner --done` may resolve by issue lookup —
 * a done-but-stuck runner sits in one of these (ship succeeded → parked at
 * awaiting_review/approved_to_ship, or QA passed → still running but emitted no
 * final `complete`). Mirrors FINALIZE_DONE_SOURCE_STATES on the Bridge side. Like
 * abandon, the lookup is scoped to the calling Lead so a same-identifier run in
 * another Lead's scope can't trip the >1 disambiguation guard.
 *
 * FLY-1204: `design_done` was missing here while the Bridge-side
 * FINALIZE_DONE_SOURCE_STATES (close-runner.ts) already listed it (FLY-793), so a
 * three-stage Design phase-session parked at `design_done` (kept alive as the
 * design-context holder until ship) could not be reclaimed with `close_runner
 * --done` — the only recourse was a manual `kill -9`. Added to close the drift so
 * ops can reclaim a leaked design phase-session normally.
 */
export const DONE_STATUS_SET = [
	"running",
	"awaiting_review",
	"approved_to_ship",
	"design_done",
] as const;

export const DONE_STATUSES_PARAM = DONE_STATUS_SET.join(",");

/** Max length for an abandon reason (written to the terminate audit trail). */
export const ABANDON_REASON_MAX = 500;

/**
 * Validate + normalize an abandon reason: trimmed non-empty, capped. Abandon is
 * a reserved destructive action whose reason is persisted to the transition +
 * hook audit, so an empty/whitespace reason is rejected (Codex R1 LOW-8).
 */
export function validateAbandonReason(reason: string | undefined): string {
	const trimmed = (reason ?? "").trim();
	if (trimmed.length === 0) {
		throw new Error(
			"abandon requires a non-empty reason (recorded in the terminate audit trail)",
		);
	}
	return trimmed.slice(0, ABANDON_REASON_MAX);
}

/**
 * Run `fn` over `items` with at most `limit` concurrent in-flight calls.
 * Preserves input order in the result. Used to bound concurrent `tmux` liveness
 * probes (Codex R2 LOW-1 — not a single 150-wide Promise.all).
 */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let cursor = 0;
	const worker = async (): Promise<void> => {
		while (cursor < items.length) {
			const index = cursor++;
			results[index] = await fn(items[index] as T, index);
		}
	};
	const poolSize = Math.max(1, Math.min(limit, items.length));
	await Promise.all(Array.from({ length: poolSize }, () => worker()));
	return results;
}
