import type {
	SpeechArbiterKind,
	SpeechArbiterRequest,
	SpeechArbiterTerminal,
} from "./SpeechArbiter.js";

export type BrainSpeechRequest = SpeechArbiterRequest;

type ObligationState = "pending" | "attached" | "unconfirmed" | "settled";

export interface BrainObligation {
	handoffId: string;
	inputTranscript: string;
	arrivedAt: number;
	state: ObligationState;
	turnId?: string;
}

export interface BrainCoordinatorOptions {
	now?(): number;
	schedule?(callback: () => void, delayMs: number): unknown;
	cancelScheduled?(handle: unknown): void;
	speech: {
		enqueue(request: BrainSpeechRequest): Promise<SpeechArbiterTerminal>;
		drop(businessId: string, kind?: SpeechArbiterKind): void;
	};
}

export interface BackgroundTurnTerminal {
	turnId: string;
	outcome: "completed" | "failed" | "interrupted";
	spokenSegments?: string[];
	reasonCategory?: "额度" | "权限" | "出错" | string;
	hadWriteReceipt?: boolean;
	writeReceiptUnknown?: boolean;
}

interface StoredObligation extends BrainObligation {
	pendingTimer?: unknown;
	waitingTimers: unknown[];
}

interface TerminalTurn {
	turnId: string;
	at: number;
	hadWriteReceipt: boolean;
}

const PENDING_BIND_MS = 5_000;
const PREVIOUS_TURN_GRACE_MS = 2_000;

/** Owns handoff obligations independently of provider turn segmentation. */
export class BrainCoordinator {
	private readonly now: () => number;
	private readonly schedule: (callback: () => void, delayMs: number) => unknown;
	private readonly cancelScheduled: (handle: unknown) => void;
	private readonly obligations = new Map<string, StoredObligation>();
	private activeTurnId?: string;
	private lastTerminal?: TerminalTurn;
	private waitingAnchorId?: string;
	private closed = false;

	constructor(private readonly options: BrainCoordinatorOptions) {
		this.now = options.now ?? Date.now;
		this.schedule =
			options.schedule ??
			((callback, delayMs) => setTimeout(callback, delayMs));
		this.cancelScheduled =
			options.cancelScheduled ??
			((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	}

	registerHandoff(input: {
		handoffId: string;
		inputTranscript: string;
	}): boolean {
		if (
			this.closed ||
			!input.handoffId ||
			this.obligations.has(input.handoffId)
		)
			return false;
		const obligation: StoredObligation = {
			...input,
			arrivedAt: this.now(),
			state: this.activeTurnId ? "attached" : "pending",
			...(this.activeTurnId ? { turnId: this.activeTurnId } : {}),
			waitingTimers: [],
		};
		this.obligations.set(input.handoffId, obligation);
		if (obligation.state === "pending") {
			obligation.pendingTimer = this.schedule(
				() => this.expirePending(obligation.handoffId),
				PENDING_BIND_MS,
			);
		} else {
			this.refreshWaitingAnchor();
		}
		return true;
	}

	obligation(handoffId: string): BrainObligation | undefined {
		const value = this.obligations.get(handoffId);
		if (!value) return undefined;
		const {
			pendingTimer: _pending,
			waitingTimers: _waiting,
			...snapshot
		} = value;
		return { ...snapshot };
	}

	turnStarted(turnId: string): void {
		if (this.closed || !turnId) return;
		this.activeTurnId = turnId;
		for (const obligation of this.obligations.values()) {
			if (obligation.state !== "pending") continue;
			if (obligation.pendingTimer !== undefined)
				this.cancelScheduled(obligation.pendingTimer);
			obligation.pendingTimer = undefined;
			obligation.state = "attached";
			obligation.turnId = turnId;
		}
		this.refreshWaitingAnchor();
	}

	turnTerminal(turn: BackgroundTurnTerminal): void {
		if (this.closed || !turn.turnId) return;
		const at = this.now();
		this.lastTerminal = {
			turnId: turn.turnId,
			at,
			hadWriteReceipt: Boolean(
				turn.hadWriteReceipt || turn.writeReceiptUnknown,
			),
		};
		if (this.activeTurnId === turn.turnId) this.activeTurnId = undefined;
		const attached = [...this.obligations.values()].filter(
			(obligation) =>
				obligation.state === "attached" && obligation.turnId === turn.turnId,
		);
		for (const obligation of attached) this.settleObligation(obligation);
		if (attached.length > 0) this.enqueueTurnResult(turn);
		this.refreshWaitingAnchor();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const obligation of this.obligations.values()) {
			this.clearTimers(obligation);
			if (obligation.state !== "settled") obligation.state = "unconfirmed";
			this.options.speech.drop(obligation.handoffId, "cue");
		}
	}

	private expirePending(handoffId: string): void {
		const obligation = this.obligations.get(handoffId);
		if (!obligation || obligation.state !== "pending") return;
		obligation.pendingTimer = undefined;
		obligation.state = "unconfirmed";
		const prior = this.lastTerminal;
		const recentPrior =
			prior &&
			obligation.arrivedAt >= prior.at &&
			obligation.arrivedAt - prior.at <= PREVIOUS_TURN_GRACE_MS
				? prior
				: undefined;
		if (recentPrior) obligation.turnId = recentPrior.turnId;
		void this.options.speech.enqueue({
			businessId: obligation.handoffId,
			kind: "fallback",
			text: recentPrior?.hadWriteReceipt
				? "刚才那件的结果还没对应上，我先核对一下"
				: "刚才那件我没接上，你再说一次？",
		});
		this.refreshWaitingAnchor();
	}

	private enqueueTurnResult(turn: BackgroundTurnTerminal): void {
		const segments = (turn.spokenSegments ?? []).filter(
			(segment) => segment.trim().length > 0,
		);
		if (turn.outcome === "completed" && segments.length > 0) {
			segments.forEach((text, index) => {
				void this.options.speech.enqueue({
					businessId: `turn:${turn.turnId}:result:${index}`,
					kind: "result",
					text,
					threadText: text,
				});
			});
			return;
		}
		const reason = turn.reasonCategory ?? "出错";
		const text = `这件没查成：${reason}。细节我发到 thread。`;
		void this.options.speech.enqueue({
			businessId: `turn:${turn.turnId}:failure`,
			kind: "result",
			text,
			threadText: text,
		});
	}

	private settleObligation(obligation: StoredObligation): void {
		this.clearTimers(obligation);
		obligation.state = "settled";
		this.options.speech.drop(obligation.handoffId, "cue");
	}

	private clearTimers(obligation: StoredObligation): void {
		if (obligation.pendingTimer !== undefined)
			this.cancelScheduled(obligation.pendingTimer);
		obligation.pendingTimer = undefined;
		for (const timer of obligation.waitingTimers) this.cancelScheduled(timer);
		obligation.waitingTimers.length = 0;
	}

	private refreshWaitingAnchor(): void {
		const current = this.waitingAnchorId
			? this.obligations.get(this.waitingAnchorId)
			: undefined;
		if (current?.state === "attached") return;
		this.waitingAnchorId = undefined;
		const next = [...this.obligations.values()]
			.filter((obligation) => obligation.state === "attached")
			.sort((left, right) => left.arrivedAt - right.arrivedAt)[0];
		if (!next) return;
		this.waitingAnchorId = next.handoffId;
		this.scheduleWaiting(next, 20_000, next.arrivedAt + 40_000);
		this.scheduleWaiting(next, 40_000);
	}

	private scheduleWaiting(
		obligation: StoredObligation,
		dueAfterMs: number,
		expiresAt?: number,
	): void {
		const delay = Math.max(0, obligation.arrivedAt + dueAfterMs - this.now());
		const timer = this.schedule(() => {
			const index = obligation.waitingTimers.indexOf(timer);
			if (index >= 0) obligation.waitingTimers.splice(index, 1);
			if (
				this.closed ||
				obligation.state !== "attached" ||
				this.waitingAnchorId !== obligation.handoffId
			)
				return;
			void this.options.speech.enqueue({
				businessId: obligation.handoffId,
				kind: "cue",
				text: "还在查",
				...(expiresAt === undefined ? {} : { expiresAt }),
			});
		}, delay);
		obligation.waitingTimers.push(timer);
	}
}
