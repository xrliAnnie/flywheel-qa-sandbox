/**
 * FLY-259 PR-B — TurnDemux: the sidecar's SINGLE event entry for a thread
 * shared with the founder's TUI (design review R4 HIGH-2 + R5 HIGH-1 — the
 * routing rules below are review-pinned):
 *
 *   - registry of SIDECAR-INITIATED turnIds: registered events route to the
 *     executor sink (CodexTurnExecutor keeps its own belongsToTurn filter —
 *     this is a second fence, not a replacement);
 *   - foreign turnIds (the founder typing in the TUI) route to the observer
 *     sink (journal observe-only rows; NEVER Discord outbound);
 *   - events WITHOUT a turnId only feed activity (lastActivityAt) — they
 *     never enter any turn buffer;
 *   - pending-dispatch handshake (R5 HIGH-1): the daemon may emit turnId'd
 *     notifications BEFORE the `turn/start` RPC response returns. From
 *     `beginDispatch()` until `claimTurn()`/`abortDispatch()` settles,
 *     unregistered-turnId events are HELD; `claimTurn(turnId)` claims the id,
 *     registers it, and REPLAYS held events for it IN ORDER to the executor;
 *     held events for other ids (or after an abort) fall to the observer.
 *     Single-flight upstream guarantees at most one pending dispatch.
 *
 * Pure logic, fully injectable sinks — no I/O here.
 */

export interface DemuxEvent {
	method: string;
	params?: unknown;
}

export interface TurnDemuxSinks {
	/** Sidecar-initiated turn events (the executor's notification feed). */
	toExecutor: (method: string, params: unknown) => void;
	/** Foreign (founder-terminal) turn events. */
	toObserver: (method: string, params: unknown) => void;
	/** Every event with any sign of life (activity timestamp feed). */
	onActivity?: () => void;
	log?: (m: string) => void;
}

/** Extract the turnId from a notification's params — deltas carry it
 * top-level (`turnId`), TurnCompletedNotification nests it under `turn.id`
 * (same accept-either shape CodexTurnExecutor uses). */
export function extractTurnId(params: unknown): string | undefined {
	const p = params as { turnId?: unknown; turn?: { id?: unknown } } | undefined;
	if (typeof p?.turnId === "string") return p.turnId;
	const nested = p?.turn?.id;
	return typeof nested === "string" ? nested : undefined;
}

const DEFAULT_HELD_CAP = 256;
const TOMBSTONE_CAP = 64;

export class TurnDemux {
	private readonly sinks: TurnDemuxSinks;
	/** turnIds the sidecar started (bounded — completed ids are released). */
	private readonly registered = new Set<string>();
	private dispatchPending = false;
	/** Set when an overflow force-settles a pending window (R2 MED-3): the
	 * eventual claimTurn must fail instead of registering a turn whose early
	 * events already went to the observer. */
	private dispatchPoisoned = false;
	/** Events held during a pending dispatch, keyed by turnId (insertion order kept). */
	private held: Array<{ turnId: string; method: string; params: unknown }> = [];
	/** Code review R1 MED-4: the hold buffer is CAPPED — a stuck turn/start
	 * (integration bug / wedged RPC) must not accumulate founder events
	 * unboundedly. Overflow settles the window as an abort (fail-closed for
	 * the dispatch; events flush to the observer) with a loud log. */
	private readonly heldCap: number;
	/** Code review R1 MED-5: recently-released sidecar turnIds (bounded FIFO).
	 * Late duplicates (stray turn/completed, trailing deltas) are DROPPED with
	 * a diagnostic — never mislabeled as founder-terminal rows. */
	private readonly tombstones: string[] = [];

	constructor(sinks: TurnDemuxSinks, opts?: { heldCap?: number }) {
		this.sinks = sinks;
		this.heldCap = opts?.heldCap ?? DEFAULT_HELD_CAP;
	}

	/** Call immediately BEFORE issuing `turn/start` (single-flight upstream). */
	beginDispatch(): void {
		this.dispatchPending = true;
		this.dispatchPoisoned = false;
	}

	/** Call with the turnId from the `turn/start` response: registers it and
	 * replays any events held for it, in arrival order. Held events for OTHER
	 * turnIds are released to the observer (they were foreign all along).
	 * Returns false (and registers NOTHING) when the window was already
	 * force-settled by an overflow (code review R2 MED-3) — early events are
	 * gone to the observer; the caller must treat the dispatch as ambiguous,
	 * never wait on this turn. */
	claimTurn(turnId: string): boolean {
		if (this.dispatchPoisoned) {
			this.dispatchPoisoned = false;
			// R3 MED-1: tombstone the rejected id — its late completion/deltas
			// must DROP, not become founder-terminal observer rows.
			this.tombstones.push(turnId);
			if (this.tombstones.length > TOMBSTONE_CAP) this.tombstones.shift();
			this.sinks.log?.(
				`TurnDemux: claim for ${turnId} rejected — dispatch window was force-settled by overflow`,
			);
			return false;
		}
		this.registered.add(turnId);
		this.settleDispatch(turnId);
		return true;
	}

	/** Call when `turn/start` failed/errored — nothing was ours; all held
	 * events are foreign. */
	abortDispatch(): void {
		this.settleDispatch(undefined);
	}

	/** A finished sidecar turn no longer needs registration (bounded memory).
	 * Late stragglers for a released id fall to the observer — they carry no
	 * executor meaning anymore (the executor settled at turn/completed). */
	releaseTurn(turnId: string): void {
		this.registered.delete(turnId);
		this.tombstones.push(turnId);
		if (this.tombstones.length > TOMBSTONE_CAP) this.tombstones.shift();
	}

	/** The single event entry. */
	route(method: string, params: unknown): void {
		this.sinks.onActivity?.();
		const turnId = extractTurnId(params);
		if (turnId === undefined) {
			// No turn identity → activity only (review-pinned conservative rule).
			return;
		}
		if (this.registered.has(turnId)) {
			this.sinks.toExecutor(method, params);
			return;
		}
		if (this.tombstones.includes(turnId)) {
			// R1 MED-5: late straggler of a RELEASED sidecar turn — drop with a
			// diagnostic; it must never become a founder-terminal journal row.
			this.sinks.log?.(
				`TurnDemux: dropped late event for released turn ${turnId} (${method})`,
			);
			return;
		}
		if (this.dispatchPending) {
			// R5 HIGH-1 window: this might be OUR turn's early event — hold it.
			if (this.held.length >= this.heldCap) {
				// R1 MED-4: overflow — fail the window closed (abort semantics):
				// everything held flushes to the observer and the window shuts.
				// R2 MED-3: the window is also POISONED so the still-outstanding
				// turn/start's eventual claimTurn fails instead of registering.
				this.sinks.log?.(
					`TurnDemux: hold buffer overflow (${this.heldCap}) — settling dispatch window as abort`,
				);
				this.settleDispatch(undefined);
				this.dispatchPoisoned = true;
				this.sinks.toObserver(method, params);
				return;
			}
			this.held.push({ turnId, method, params });
			return;
		}
		this.sinks.toObserver(method, params);
	}

	private settleDispatch(claimedId: string | undefined): void {
		this.dispatchPending = false;
		const held = this.held;
		this.held = [];
		for (const e of held) {
			if (claimedId !== undefined && e.turnId === claimedId) {
				this.sinks.toExecutor(e.method, e.params);
			} else {
				this.sinks.toObserver(e.method, e.params);
			}
		}
	}
}
