/**
 * FLY-1944: synchronous evidence for dispatches that passed the first fleet
 * pause check but have not yet reached durable launch-claim/inflight state.
 *
 * `enter()` is intentionally allocation-light and has no await. Both public
 * dispatcher entrypoints call it before their first await; the returned release
 * is idempotent so every terminal path may safely converge in `finally`.
 */
export class AdmissionCrossingBarrier {
	private startCount = 0;
	private dispatchCount = 0;

	enter(lane: "start" | "dispatch"): () => void {
		if (lane === "start") this.startCount += 1;
		else this.dispatchCount += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (lane === "start") this.startCount = Math.max(0, this.startCount - 1);
			else this.dispatchCount = Math.max(0, this.dispatchCount - 1);
		};
	}

	snapshot(): { start: number; dispatch: number; total: number } {
		return {
			start: this.startCount,
			dispatch: this.dispatchCount,
			total: this.startCount + this.dispatchCount,
		};
	}
}
