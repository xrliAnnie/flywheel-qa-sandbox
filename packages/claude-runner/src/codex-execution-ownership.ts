import { randomUUID } from "node:crypto";

export type CodexExecutionOwnerKind = "dispatch" | "rescue";

/** FLY-2903: why a Bridge terminal path asked the in-process owner to stop. */
export type CodexStopReason =
	| "terminate"
	| "close_runner"
	| "process_retirement"
	| "close_tmux"
	| "terminal_sweep";

export type CodexStopResult =
	| "not_owned"
	| "reserved_fenced"
	| "stopped"
	| "timeout";

export type CodexOwnershipState = "none" | "reserved" | "active";

/**
 * FLY-2903: bounded wait for the owner to drain and release, per caller.
 * Retirement runs serially inside the retirement tick, and the sweep shares a
 * maintenance tick, so both wait less than the HTTP handler paths.
 */
export const CODEX_STOP_WAIT_MS: Readonly<Record<CodexStopReason, number>> = {
	terminate: 25_000,
	close_runner: 25_000,
	close_tmux: 25_000,
	process_retirement: 8_000,
	terminal_sweep: 5_000,
};

const DEFAULT_STOP_MARK_LIMIT = 2048;

export interface CodexExecutionOwnershipLease {
	readonly executionId: string;
	readonly kind: CodexExecutionOwnerKind;
	/** FLY-2919: the same identity is persisted by the Bridge before runGoal. */
	readonly ownerToken: string;
	/** FLY-2903: set synchronously by requestStop; null while no stop was asked. */
	readonly stopRequested: CodexStopReason | null;
	release(): void;
}

export interface CodexExecutionClaimOptions {
	/** Optional Bridge-issued durable identity; legacy callers receive a UUID. */
	ownerToken?: string;
	/** Called synchronously, at most once, when a Bridge terminal path asks this owner to stop. */
	onStopRequested?: (reason: CodexStopReason) => void;
}

interface ActiveOwner {
	state: "active";
	kind: CodexExecutionOwnerKind;
	token: string;
	lease: { stopRequested: CodexStopReason | null };
	onStopRequested?: (reason: CodexStopReason) => void;
	waiters: Set<() => void>;
}

type Ownership = { state: "reserved" } | ActiveOwner;

/**
 * Process-local FLY-2211 owner registry shared by first dispatch and recovery.
 * A reservation is created at session-start persistence time, before the row is
 * visible to the reconciler. Adapter activation consumes that reservation. The
 * active lease is token-bound so delayed cleanup cannot erase a successor.
 *
 * FLY-2903 adds a stop channel: Bridge terminal paths ask the in-process goal
 * runtime to stop before reaping its daemon, so the runtime never mistakes the
 * kill for a mid-goal crash and resumes the goal. A stop request also fences
 * the execution: no later claim is admitted.
 */
export class CodexExecutionOwnershipRegistry {
	private readonly owners = new Map<string, Ownership>();
	private readonly stopMarks = new Map<string, CodexStopReason>();
	private readonly stopMarkLimit: number;
	private readonly log: (line: string) => void;

	constructor(options?: {
		stopMarkLimit?: number;
		log?: (line: string) => void;
	}) {
		this.stopMarkLimit = Math.max(
			1,
			options?.stopMarkLimit ?? DEFAULT_STOP_MARK_LIMIT,
		);
		this.log = options?.log ?? ((line) => console.warn(line));
	}

	reserve(executionId: string): boolean {
		if (!executionId || this.owners.has(executionId)) return false;
		this.owners.set(executionId, { state: "reserved" });
		return true;
	}

	claim(
		executionId: string,
		kind: CodexExecutionOwnerKind,
		options?: CodexExecutionClaimOptions,
	): CodexExecutionOwnershipLease | undefined {
		if (!executionId) return undefined;
		if (this.stopMarks.has(executionId)) return undefined;
		const current = this.owners.get(executionId);
		if (current?.state === "active") return undefined;
		const token = options?.ownerToken ?? randomUUID();
		if (!token || token.length > 256 || /\p{Cc}/u.test(token)) return undefined;
		const leaseState: ActiveOwner["lease"] = { stopRequested: null };
		const owner: ActiveOwner = {
			state: "active",
			kind,
			token,
			lease: leaseState,
			...(options?.onStopRequested
				? { onStopRequested: options.onStopRequested }
				: {}),
			waiters: new Set(),
		};
		this.owners.set(executionId, owner);
		let released = false;
		return {
			executionId,
			kind,
			ownerToken: token,
			get stopRequested() {
				return leaseState.stopRequested;
			},
			release: () => {
				if (released) return;
				released = true;
				const owned = this.owners.get(executionId);
				if (owned?.state === "active" && owned.token === token) {
					this.owners.delete(executionId);
				}
				// Waiters belong to this lease only, so a stale release can never
				// wake a successor's stop wait.
				for (const wake of [...owner.waiters]) wake();
				owner.waiters.clear();
			},
		};
	}

	releaseReservation(executionId: string): boolean {
		const current = this.owners.get(executionId);
		if (current?.state !== "reserved") return false;
		this.owners.delete(executionId);
		return true;
	}

	isExecutionOwned(executionId: string): boolean {
		return this.owners.has(executionId);
	}

	ownershipState(executionId: string): CodexOwnershipState {
		return this.owners.get(executionId)?.state ?? "none";
	}

	isStopRequested(executionId: string): boolean {
		if (this.stopMarks.has(executionId)) return true;
		const current = this.owners.get(executionId);
		return current?.state === "active" && current.lease.stopRequested !== null;
	}

	/**
	 * FLY-2903: ask the in-process owner of `executionId` to stop. Marking the
	 * lease and firing the owner callback happen synchronously; only the drain
	 * wait is bounded. Callers keep reaping after `timeout` — the owner is
	 * already marked, so the runtime restart gate refuses to resurrect it.
	 *
	 * Terminal reasons also fence the execution: no later claim is admitted.
	 * `process_retirement` does not — a retired process body is resumed later
	 * under the SAME execution id (FLY-2808 standby resume), so it only stops
	 * the current owner.
	 */
	requestStop(
		executionId: string,
		reason: CodexStopReason,
		options?: { timeoutMs?: number },
	): Promise<CodexStopResult> {
		const fence = reason !== "process_retirement";
		if (fence) this.markStop(executionId, reason);
		const current = this.owners.get(executionId);
		if (!current) return Promise.resolve("not_owned");
		if (current.state === "reserved") {
			return Promise.resolve(fence ? "reserved_fenced" : "not_owned");
		}
		if (current.lease.stopRequested === null) {
			current.lease.stopRequested = reason;
			if (current.onStopRequested) {
				try {
					current.onStopRequested(reason);
				} catch (error) {
					this.log(
						`[CodexExecutionOwnership] stop callback threw exec=${executionId} reason=${reason}: ${(error as Error)?.message ?? String(error)}`,
					);
				}
			}
		}
		const timeoutMs = Math.max(
			0,
			options?.timeoutMs ?? CODEX_STOP_WAIT_MS[reason],
		);
		return new Promise<CodexStopResult>((resolve) => {
			let settled = false;
			const wake = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				current.waiters.delete(wake);
				resolve("stopped");
			};
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				current.waiters.delete(wake);
				resolve("timeout");
			}, timeoutMs);
			timer.unref?.();
			current.waiters.add(wake);
		});
	}

	private markStop(executionId: string, reason: CodexStopReason): void {
		if (!executionId || this.stopMarks.has(executionId)) return;
		this.stopMarks.set(executionId, reason);
		while (this.stopMarks.size > this.stopMarkLimit) {
			const oldest = this.stopMarks.keys().next().value;
			if (oldest === undefined) break;
			this.stopMarks.delete(oldest);
		}
	}
}
