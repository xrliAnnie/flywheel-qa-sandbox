/**
 * VoiceConnSupervisor — instrument + self-heal a voice connection (FLY-967
 * round-3 revised kickback).
 *
 * Annie's real-machine failure shape: the orchestrator's voice.join resolved
 * Ready, then the connection dropped ASYNCHRONOUSLY (best hypothesis:
 * @discordjs/voice IP-discovery erroring on Node v25 after Ready) and the bot
 * silently left the VC — total silence, nothing in the logs. This supervisor
 * makes that failure impossible to miss and recoverable:
 *
 *   - logs EVERY state transition (ready/disconnected/destroyed/...) so the
 *     next real-machine round pins exactly where the connection dies;
 *   - listens to the connection's error events (also protects the process:
 *     an unhandled 'error' on an EventEmitter is fatal);
 *   - mode "supervise": on disconnect, waits settleMs for @discordjs/voice's
 *     own resume (signalling/connecting), then forces rejoin() up to
 *     maxRejoins; exhaustion / rejoin failure / destruction surfaces LOUDLY
 *     via onFatal — never a silent death;
 *   - mode "observe": logging only (the ears connection has its own
 *     EARS_LOST degradation flow; we only want the diagnostics).
 *
 * SDK-free by design (duck-typed VoiceConnHandle; discordWiring provides the
 * real adapter) so this state machine stays unit-testable.
 */

export interface VoiceConnHandle {
	/** current connection status name (e.g. "ready", "disconnected"). */
	status(): string;
	/** attempt to rejoin with the existing join config; false = cannot. */
	rejoin(): boolean;
	/** subscribe to state transitions; returns unsubscribe. */
	onStateChange(cb: (from: string, to: string) => void): () => void;
	/** subscribe to connection errors; returns unsubscribe. */
	onError(cb: (err: Error) => void): () => void;
}

export interface SuperviseOptions {
	label: string;
	log: (line: string) => void;
	/** "supervise" (default): reconnect + loud fatal. "observe": logs only. */
	mode?: "supervise" | "observe";
	/** called ONCE when the connection is down for good (also logged). */
	onFatal?: (reason: string) => void;
	maxRejoins?: number;
	settleMs?: number;
	/** injectable timers for tests. */
	timers?: {
		set: (fn: () => void, ms: number) => unknown;
		clear: (t: unknown) => void;
	};
}

export function superviseVoiceConnection(
	handle: VoiceConnHandle,
	opts: SuperviseOptions,
): () => void {
	const mode = opts.mode ?? "supervise";
	const maxRejoins = opts.maxRejoins ?? 3;
	const settleMs = opts.settleMs ?? 5_000;
	const timers = opts.timers ?? {
		set: (fn: () => void, ms: number) => setTimeout(fn, ms),
		clear: (t: unknown) => clearTimeout(t as NodeJS.Timeout),
	};

	let rejoins = 0;
	let fatal = false;
	let disposed = false;
	let timer: unknown | null = null;

	const clearTimer = () => {
		if (timer) {
			timers.clear(timer);
			timer = null;
		}
	};

	const loud = (reason: string) => {
		if (fatal || disposed) return;
		fatal = true;
		clearTimer();
		opts.log(
			`[voice-conn][${opts.label}] FATAL — ${reason}; connection is DOWN and will not self-recover`,
		);
		opts.onFatal?.(reason);
	};

	// after a disconnect (or a rejoin attempt), give @discordjs/voice settleMs
	// to land back on ready by itself before forcing the next rejoin.
	const armSettleCheck = () => {
		clearTimer();
		timer = timers.set(() => {
			timer = null;
			if (disposed || fatal) return;
			const status = handle.status();
			if (status === "ready") {
				rejoins = 0;
				return;
			}
			if (status === "destroyed") {
				loud("connection destroyed");
				return;
			}
			if (rejoins >= maxRejoins) {
				loud(`still ${status} after ${maxRejoins} rejoin attempts`);
				return;
			}
			rejoins++;
			opts.log(
				`[voice-conn][${opts.label}] rejoin attempt ${rejoins}/${maxRejoins} (status=${status})`,
			);
			let ok = false;
			try {
				ok = handle.rejoin();
			} catch {
				ok = false;
			}
			if (!ok) {
				loud(`rejoin() failed on attempt ${rejoins}`);
				return;
			}
			armSettleCheck();
		}, settleMs);
	};

	const offState = handle.onStateChange((from, to) => {
		opts.log(`[voice-conn][${opts.label}] ${from} -> ${to}`);
		if (disposed || fatal || mode === "observe") return;
		if (to === "ready") {
			rejoins = 0;
			clearTimer();
			return;
		}
		if (to === "destroyed") {
			loud("connection destroyed");
			return;
		}
		// ANY other state (disconnected, but also signalling/connecting — the
		// @discordjs/voice self-reconnect path can stall there, Codex R15) gets
		// a settle check. Only arm when none is pending: rapid flapping between
		// non-ready states must not keep resetting (starving) the check.
		if (!timer) {
			armSettleCheck();
		}
	});
	const offError = handle.onError((err) => {
		opts.log(
			`[voice-conn][${opts.label}] ERROR: ${String(err?.message ?? err)}`,
		);
	});

	return () => {
		disposed = true;
		clearTimer();
		offState();
		offError();
	};
}
