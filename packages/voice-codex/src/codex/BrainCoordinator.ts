import type { VoiceUnplayedItem } from "../voice-minutes.js";
import type {
	SpeechArbiterKind,
	SpeechArbiterRequest,
	SpeechArbiterTerminal,
} from "./SpeechArbiter.js";
import {
	type SpokenScriptSource,
	repairSpokenScript,
	THREAD_POINTER_SENTENCE,
	validateSpokenScript,
} from "./SpokenScript.js";

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
	evidence?(record: Record<string, unknown>): void;
	postThread?(input: { businessId: string; text: string }): Promise<void>;
	now?(): number;
	schedule?(callback: () => void, delayMs: number): unknown;
	cancelScheduled?(handle: unknown): void;
	speech: {
		enqueue(request: BrainSpeechRequest): Promise<SpeechArbiterTerminal>;
		drop(businessId: string, kind?: SpeechArbiterKind): void;
		/** Drop queued entries but let a playing one finish (no barge-in). */
		retire(businessId: string, kind?: SpeechArbiterKind): void;
	};
}

export interface BackgroundTurnTerminal {
	turnId: string;
	outcome: "completed" | "failed" | "interrupted";
	spokenSegments?: string[];
	threadSegments?: string[];
	sources?: readonly SpokenScriptSource[];
	rosterNames?: readonly string[];
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
	/** A completed result no obligation claimed yet (handoff after terminal). */
	unclaimed?: BackgroundTurnTerminal;
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
	private readonly pendingResults = new Map<string, VoiceUnplayedItem>();

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
		if (this.activeTurnId === turn.turnId) this.activeTurnId = undefined;
		const attached = [...this.obligations.values()].filter(
			(obligation) =>
				obligation.state === "attached" && obligation.turnId === turn.turnId,
		);
		this.lastTerminal = {
			turnId: turn.turnId,
			at,
			hadWriteReceipt: Boolean(
				turn.hadWriteReceipt || turn.writeReceiptUnknown,
			),
			// Keep only the latest turn's material, and only until one late
			// handoff within the grace window claims it (plan §3).
			...(attached.length === 0 && turn.outcome === "completed"
				? { unclaimed: turn }
				: {}),
		};
		for (const obligation of attached) this.settleObligation(obligation);
		if (attached.length > 0)
			void this.enqueueTurnResult({
				...turn,
				sources: [
					...(turn.sources ?? []),
					...attached.map((row) => ({
						itemId: `founder:${row.handoffId}`,
						text: row.inputTranscript,
					})),
				],
			});
		this.refreshWaitingAnchor();
	}

	unfinished(): readonly VoiceUnplayedItem[] {
		return Object.freeze([
			...this.pendingResults.values(),
			...[...this.obligations.values()]
				.filter((row) => row.state !== "settled")
				.map((row) =>
					Object.freeze({
						businessId: row.handoffId,
						kind: "obligation" as const,
						text: row.inputTranscript,
						status: "unfinished" as const,
						attempts: 0,
					}),
				),
		]);
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
		const fallback = () =>
			void this.options.speech.enqueue({
				businessId: obligation.handoffId,
				kind: "fallback",
				text: recentPrior?.hadWriteReceipt
					? "刚才那件的结果还没对应上，我先核对一下"
					: "刚才那件我没接上，你再说一次？",
			});
		const unclaimed = recentPrior?.hadWriteReceipt
			? recentPrior.unclaimed
			: undefined;
		if (unclaimed && recentPrior) {
			// Play that turn's existing terminal result first, then the prompt.
			recentPrior.unclaimed = undefined;
			void this.enqueueTurnResult({
				...unclaimed,
				sources: [
					...(unclaimed.sources ?? []),
					{
						itemId: `founder:${obligation.handoffId}`,
						text: obligation.inputTranscript,
					},
				],
			})
				.catch(() => undefined)
				.then(() => {
					if (!this.closed) fallback();
				});
		} else fallback();
		this.refreshWaitingAnchor();
	}

	private async enqueueTurnResult(turn: BackgroundTurnTerminal): Promise<void> {
		const segments = (turn.spokenSegments ?? []).filter((text) => text.trim());
		let threadText =
			(turn.threadSegments ?? []).join("\n\n") ||
			segments.join("\n\n") ||
			`这件没查成：${turn.reasonCategory ?? "出错"}。`;
		const businessId = `turn:${turn.turnId}:material`;
		// Free paraphrase; a sentence whose key fact the tool output does not
		// support is dropped whole and the thread carries the text (FLY-2886
		// Lead 1c8019f8). Links and over-long segments still go to the thread.
		const repairs = segments.map((text) =>
			repairSpokenScript({
				spoken: text,
				sources: turn.sources ?? [],
				rosterNames: turn.rosterNames ?? [],
				mode: "background_result",
			}),
		);
		const kept = repairs
			.map((repair) =>
				repair.needsThread
					? repair.spoken.slice(0, -THREAD_POINTER_SENTENCE.length).trim()
					: repair.spoken,
			)
			.filter((text) => text.trim());
		const validations = kept.map((text) =>
			validateSpokenScript({
				spoken: text,
				sources: turn.sources ?? [],
				rosterNames: turn.rosterNames ?? [],
				mode: "background_result",
			}),
		);
		const shapeOk = kept.every(
			(text) => Array.from(text).length <= 120 && !/https?:\/\//iu.test(text),
		);
		const repaired = repairs.some((repair) => repair.needsThread);
		const valid =
			turn.outcome === "completed" &&
			kept.length > 0 &&
			shapeOk &&
			validations.every((result) => result.ok);
		this.options.evidence?.({
			kind: "voice_background_script_validated",
			turnId: turn.turnId,
			valid,
			checks: validations,
			droppedSentences: repairs.flatMap((repair) => repair.droppedSentences),
		});
		// The pointer says the thread is authoritative, so a repaired answer never
		// posts the dropped sentence: it posts what was kept plus the tool output
		// those facts come from (not her words, not the opening brief).
		if (repaired && !turn.threadSegments?.length) {
			const toolText = (turn.sources ?? [])
				.filter(
					(source) =>
						!source.itemId.startsWith("founder:") &&
						!source.itemId.startsWith("context:"),
				)
				.map((source) => source.text)
				.join("\n")
				.slice(0, 1_500);
			threadText = [kept.join(""), toolText && `工具原始结果：\n${toolText}`]
				.filter(Boolean)
				.join("\n\n");
		}
		const needsPost =
			!valid ||
			repaired ||
			Boolean(turn.threadSegments?.length) ||
			validations.some((result) => result.usedThreadPointer);

		let posted = false;
		if (needsPost) {
			this.pendingResults.set(
				businessId,
				Object.freeze({
					businessId,
					kind: "result",
					text: threadText,
					status: "unfinished",
					attempts: 0,
				}),
			);
			try {
				if (!this.options.postThread) throw new Error("thread_sink_missing");
				await this.options.postThread({ businessId, text: threadText });
				posted = true;
			} catch {
				/* Retain unpublished material for minutes. */
			}
			if (this.closed) return;
			if (posted) this.pendingResults.delete(businessId);
		}
		const speech =
			turn.outcome !== "completed"
				? [
						`这件没查成：${turn.reasonCategory ?? "出错"}。${posted ? "细节我发到 thread。" : ""}`,
					]
				: valid && (!needsPost || posted)
					? repaired &&
						!validations.some((result) => result.usedThreadPointer)
						? [...kept, THREAD_POINTER_SENTENCE]
						: kept
					: [
							posted
								? THREAD_POINTER_SENTENCE
								: "编号我没核对上，等下再给你",
						];
		for (const [index, text] of speech.entries()) {
			void this.options.speech.enqueue({
				businessId: `turn:${turn.turnId}:result:${index}`,
				kind: "result",
				text,
				threadText,
			});
		}
	}

	private settleObligation(obligation: StoredObligation): void {
		this.clearTimers(obligation);
		obligation.state = "settled";
		// A playing “还在查” finishes; cutting it off would restart the realtime
		// generation under the result that is about to play (FLY-2886 QA@4 D2).
		this.options.speech.retire(obligation.handoffId, "cue");
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
