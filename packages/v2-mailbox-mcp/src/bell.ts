/**
 * FLY-1547 R3-F3: the channel bell cycle as a pure state machine.
 *
 * Health (`lastOkAt`/failure counter) is refreshed ONLY after the ENTIRE
 * cycle that was needed succeeded — a cycle that had to ring counts as
 * successful only when the notification was accepted. Notification-only
 * failures therefore climb to the fail-stop bound exactly like status
 * failures, the lease goes stale, `channelHealthy` flips false, and the
 * engine's pointer paste takes over the same pending sequence. Cycles are
 * serialized by the caller-held `running` latch (no overlapping polls).
 */
export interface BellCycleState {
	lastBelledSeq: number;
	consecutiveFailures: number;
	running: boolean;
}

export function initialBellState(): BellCycleState {
	// Restart policy (frozen in the plan): ring once for whatever is pending.
	return { lastBelledSeq: -1, consecutiveFailures: 0, running: false };
}

export interface BellCycleIo {
	peekMaxPendingSeq(): Promise<number | null>;
	notify(maxSeq: number): Promise<void>;
	/** Touch the health lease — called only on a fully successful cycle. */
	touchLease(): void;
	failStop(reason: string): void;
	log(message: string): void;
	maxConsecutiveFailures: number;
}

export async function runBellCycle(
	state: BellCycleState,
	io: BellCycleIo,
): Promise<void> {
	if (state.running) return; // in-flight guard — no overlapping cycles
	state.running = true;
	try {
		let maxSeq: number | null;
		try {
			maxSeq = await io.peekMaxPendingSeq();
		} catch (error) {
			recordFailure(state, io, "status", error);
			return;
		}
		if (maxSeq !== null && maxSeq > state.lastBelledSeq) {
			try {
				await io.notify(maxSeq);
			} catch (error) {
				recordFailure(state, io, "notify", error);
				return;
			}
			state.lastBelledSeq = maxSeq;
		}
		// Full cycle (including any required ring) succeeded — only now is the
		// channel provably healthy.
		state.consecutiveFailures = 0;
		io.touchLease();
	} finally {
		state.running = false;
	}
}

function recordFailure(
	state: BellCycleState,
	io: BellCycleIo,
	stage: "status" | "notify",
	error: unknown,
): void {
	state.consecutiveFailures += 1;
	io.log(
		`bell ${stage} failure ${state.consecutiveFailures}/${io.maxConsecutiveFailures}: ${
			error instanceof Error ? error.message : String(error)
		}`,
	);
	if (state.consecutiveFailures >= io.maxConsecutiveFailures) {
		io.failStop(`consecutive bell ${stage} failures reached the health bound`);
	}
}
