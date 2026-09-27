/**
 * FLY-2882 §5.1 — in-memory "is this Codex Lead inside a turn" state, one
 * instance per proc generation (a reconnect / rebuild gets a fresh instance;
 * a disconnected one is dead forever, so a late event from an old generation
 * can never leak into the new one).
 *
 * Linearization: every turn lifecycle event bumps `revision`. A seed read
 * (`thread/turns/list`) is applied only when nothing happened since it was
 * issued — any live event is newer than a seed reply, so a late in-progress
 * seed can never resurrect a turn that already completed. A live start or
 * completion is itself authoritative (a thread has at most one active turn),
 * so it seeds the tracker too.
 *
 * design-correction C1/C3: lifecycle is observed at the RAW proc-notification
 * seam (before TurnDemux can hold or tombstone anything); the demux only names
 * the owner via `setOrigin`. Events for the bound thread are validated —
 * start must be `inProgress`, completion must be terminal — and a malformed
 * one voids trust (unseeded ⇒ the Bridge answers unknown) until a re-seed or
 * the next valid event.
 *
 * Nothing here reads or returns message bodies: the snapshot carries turn ids,
 * start times and (for message turns) the mailbox delivery ids bound to the
 * journal entry that opened the turn.
 */

import { randomUUID } from "node:crypto";
import type { LatestTurn } from "./codex-lead-thread-rotation.js";

export const TURN_STATE_SCHEMA = "turn-state.v1" as const;
export const MAX_BOUND_DELIVERIES = 64;
const FUTURE_SKEW_MS = 5_000;
const COMPLETED_MEMORY = 64;

export type TurnBinding =
	| { status: "pending" }
	| { status: "ambiguous" }
	| { status: "no_members" }
	| { status: "overflow" }
	| { status: "unavailable" }
	| { status: "bound"; deliveryIds: string[] };

export type SidecarTurn =
	| {
			origin: "message";
			turnId: string;
			startedAtMs: number;
			binding: TurnBinding;
	  }
	| {
			origin: "founder_terminal" | "unknown";
			turnId: string;
			startedAtMs: number;
	  };

export interface TurnStateSnapshot {
	schema: typeof TURN_STATE_SCHEMA;
	generation: string;
	connected: boolean;
	seeded: boolean;
	activeTurns: SidecarTurn[];
}

/** Read-only journal seam (LeadJournal satisfies it). */
export interface TurnBindingSource {
	findEntryIdsByTurnId(turnId: string): string[];
	listMemberIds(entryId: string): string[];
}

export type TurnOrigin = "message" | "founder_terminal" | "unknown";

type ActiveTurn = { startedAtMs: number; origin: TurnOrigin };

type Lifecycle =
	| { kind: "started"; turnId: string; startedAtMs: number }
	| { kind: "completed"; turnId: string };

const TERMINAL_STATUSES = new Set(["completed", "interrupted", "failed"]);
const MAX_TURN_ID = 128;

export class LeadTurnStateTracker {
	readonly generation: string;
	private readonly binding: TurnBindingSource;
	private readonly now: () => number;
	private readonly onTrustLost: (() => void) | undefined;
	private threadId: string | undefined;
	private connected = false;
	private seeded = false;
	private dead = false;
	private revision = 0;
	private readonly active = new Map<string, ActiveTurn>();
	private readonly completed: string[] = [];

	constructor(opts: {
		binding: TurnBindingSource;
		now?: () => number;
		generation?: string;
		/** Called when a malformed current-thread event voids trust (re-seed). */
		onTrustLost?: () => void;
	}) {
		this.binding = opts.binding;
		this.now = opts.now ?? Date.now;
		this.generation = opts.generation ?? randomUUID();
		this.onTrustLost = opts.onTrustLost;
	}

	/** The generation's thread is established; events for it now count. */
	bindThread(threadId: string): void {
		if (this.dead) return;
		this.threadId = threadId;
		this.connected = true;
	}

	/**
	 * Raw proc-notification seam (BEFORE any demux hold/tombstone). Only
	 * `turn/started` / `turn/completed` are read, and only their metadata.
	 * Other threads are ignored; a malformed event on the bound thread voids
	 * trust (unseeded → "unknown") and asks for a re-seed.
	 */
	observeLifecycle(method: string, params: unknown): void {
		if (method !== "turn/started" && method !== "turn/completed") return;
		if (this.dead || !this.connected || this.threadId === undefined) return;
		const threadId = (params as { threadId?: unknown } | null | undefined)
			?.threadId;
		if (typeof threadId === "string" && threadId !== this.threadId) return;
		const event =
			typeof threadId === "string"
				? this.parseLifecycle(method, params)
				: undefined;
		if (!event) {
			this.invalidate();
			return;
		}
		if (event.kind === "started") {
			if (this.completed.includes(event.turnId)) return;
			this.revision++;
			if (!this.active.has(event.turnId))
				this.active.set(event.turnId, {
					startedAtMs: event.startedAtMs,
					origin: "unknown",
				});
		} else {
			this.revision++;
			this.active.delete(event.turnId);
			if (!this.completed.includes(event.turnId)) {
				this.completed.push(event.turnId);
				if (this.completed.length > COMPLETED_MEMORY) this.completed.shift();
			}
		}
		this.seeded = true;
	}

	/** Ownership named by the demux; never affects busy/idle. */
	setOrigin(turnId: string, origin: TurnOrigin): void {
		const turn = this.active.get(turnId);
		if (turn) turn.origin = origin;
	}

	markDisconnected(): void {
		this.dead = true;
		this.connected = false;
		this.seeded = false;
		this.active.clear();
	}

	needsSeed(): boolean {
		return !this.dead && this.connected && !this.seeded;
	}

	beginSeed(): number {
		return this.revision;
	}

	/** Returns true only when the seed was applied. */
	applySeed(rev0: number, latest: LatestTurn | null): boolean {
		if (!this.needsSeed() || this.revision !== rev0) return false;
		if (latest?.status === "inProgress") {
			const startedAtMs = this.validStartMs(latest.startedAt);
			if (startedAtMs === undefined) return false;
			this.active.clear();
			if (!this.completed.includes(latest.id))
				this.active.set(latest.id, { startedAtMs, origin: "unknown" });
		} else {
			this.active.clear();
		}
		this.seeded = true;
		return true;
	}

	snapshot(): TurnStateSnapshot {
		const activeTurns = [...this.active.entries()]
			.sort(([, a], [, b]) => a.startedAtMs - b.startedAtMs)
			.map(
				([turnId, turn]): SidecarTurn =>
					turn.origin === "message"
						? {
								origin: "message",
								turnId,
								startedAtMs: turn.startedAtMs,
								binding: this.bindingFor(turnId),
							}
						: { origin: turn.origin, turnId, startedAtMs: turn.startedAtMs },
			);
		return {
			schema: TURN_STATE_SCHEMA,
			generation: this.generation,
			connected: this.connected,
			seeded: this.seeded,
			activeTurns,
		};
	}

	private invalidate(): void {
		this.revision++;
		this.seeded = false;
		this.active.clear();
		this.onTrustLost?.();
	}

	private parseLifecycle(
		method: string,
		params: unknown,
	): Lifecycle | undefined {
		const turn = (params as { turn?: unknown }).turn as
			| { id?: unknown; status?: unknown; startedAt?: unknown }
			| null
			| undefined;
		if (typeof turn !== "object" || turn === null) return undefined;
		const turnId = turn.id;
		if (
			typeof turnId !== "string" ||
			turnId.length === 0 ||
			turnId.length > MAX_TURN_ID
		)
			return undefined;
		if (method === "turn/completed")
			return typeof turn.status === "string" &&
				TERMINAL_STATUSES.has(turn.status)
				? { kind: "completed", turnId }
				: undefined;
		if (turn.status !== "inProgress") return undefined;
		if (turn.startedAt === undefined || turn.startedAt === null)
			return { kind: "started", turnId, startedAtMs: this.now() };
		const startedAtMs =
			typeof turn.startedAt === "number"
				? this.validStartMs(turn.startedAt)
				: undefined;
		return startedAtMs === undefined
			? undefined
			: { kind: "started", turnId, startedAtMs };
	}

	private validStartMs(seconds: number | null): number | undefined {
		if (seconds === null || !Number.isFinite(seconds) || seconds <= 0)
			return undefined;
		const ms = seconds * 1000;
		return ms <= this.now() + FUTURE_SKEW_MS ? ms : undefined;
	}

	private bindingFor(turnId: string): TurnBinding {
		try {
			const entries = this.binding.findEntryIdsByTurnId(turnId);
			if (entries.length === 0) return { status: "pending" };
			if (entries.length > 1) return { status: "ambiguous" };
			const members = this.binding.listMemberIds(entries[0]!);
			if (members.length === 0) return { status: "no_members" };
			if (members.length > MAX_BOUND_DELIVERIES) return { status: "overflow" };
			return {
				status: "bound",
				deliveryIds: members.map((id) => id.replace(/#r\d+$/, "")),
			};
		} catch {
			return { status: "unavailable" };
		}
	}
}

/**
 * Seed once now, then retry after 2s and 10s while still unseeded. A live
 * event seeds the tracker on its own, so retries stop as soon as one arrives.
 */
export function seedTurnStateWithRetry(args: {
	tracker: LeadTurnStateTracker;
	read: () => Promise<LatestTurn | null>;
	retryDelaysMs?: readonly number[];
}): { cancel(): void } {
	const delays = [...(args.retryDelaysMs ?? [2_000, 10_000])];
	let timer: ReturnType<typeof setTimeout> | undefined;
	let cancelled = false;
	const attempt = (): void => {
		timer = undefined;
		if (cancelled || !args.tracker.needsSeed()) return;
		const rev0 = args.tracker.beginSeed();
		void args
			.read()
			.then(
				(latest) => args.tracker.applySeed(rev0, latest),
				() => false,
			)
			.then((applied) => {
				const delay = delays.shift();
				if (
					applied ||
					cancelled ||
					delay === undefined ||
					!args.tracker.needsSeed()
				)
					return;
				timer = setTimeout(attempt, delay);
				(timer as { unref?: () => void }).unref?.();
			});
	};
	attempt();
	return {
		cancel: () => {
			cancelled = true;
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
		},
	};
}
