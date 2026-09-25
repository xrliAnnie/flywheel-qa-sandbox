/**
 * Refactored from Raya apps/voice/src/inbox/InboxReader.ts@f669d1b.
 * Preserved: one in-flight poll, decision-first ordering, claim-before-speak,
 * all-segments-before-ack, and two attempts with a sixty-second backoff.
 * Removed by the approved V2 boundary: filters, spoken ship, and text-only
 * treatment of reports.
 */
import {
	SPEAK_BARGE_IN_REASON,
	type SpeakContentProof,
	type SpeakKind,
	type SpeakReceipt,
} from "../types.js";
import {
	renderSpeechBrief,
	splitSpeechText,
	type VoiceSpeechBrief,
	validateSpeechBrief,
} from "./SpeechBrief.js";

export interface HeadphoneInboxItem {
	id: string;
	revision: number;
	createdAt: string;
	needsDecision: boolean;
	text: string;
	speechBrief?: VoiceSpeechBrief;
}

export interface HeadphoneInboxClaim {
	item: HeadphoneInboxItem;
	claimToken: string;
	attempt: number;
	pendingKey: string;
}

export interface InboxReaderOptions {
	list(): Promise<readonly HeadphoneInboxItem[]>;
	claim(item: HeadphoneInboxItem): Promise<HeadphoneInboxClaim | undefined>;
	ack(
		claim: HeadphoneInboxClaim,
		receipts: readonly SpeakReceipt[],
	): Promise<void>;
	speak(
		text: string,
		kind: SpeakKind,
		opts: { pendingKey: string; verification: "required" },
	): Promise<SpeakReceipt>;
	record(event: Record<string, unknown>): void;
	now(): number;
	retryBackoffMs?: number;
	maxSpeechCodePoints?: number;
}

const MAX_ATTEMPTS_PER_SESSION = 2;
const DEFAULT_RETRY_BACKOFF_MS = 60_000;

export interface InboxPollResult {
	listed: number;
	spoken: number;
	acked: number;
}

function proven(proof: SpeakContentProof): boolean {
	return proof === "deterministic_tts" || proof === "transcript_equivalent";
}

export class InboxReader {
	private polling: Promise<InboxPollResult> | null = null;
	private stopped = false;
	private readonly attempts = new Map<
		string,
		{ count: number; nextAt: number; deferred: boolean }
	>();
	private readonly pendingAcks = new Map<
		string,
		{
			claim: HeadphoneInboxClaim;
			receipts: readonly SpeakReceipt[];
		}
	>();

	constructor(private readonly options: InboxReaderOptions) {}

	poll(): Promise<InboxPollResult> {
		if (this.stopped)
			return Promise.resolve({ listed: 0, spoken: 0, acked: 0 });
		if (this.polling) return this.polling;
		const task = this.runPoll();
		const settled = task.finally(() => {
			if (this.polling === settled) this.polling = null;
		});
		this.polling = settled;
		return settled;
	}

	stop(): void {
		this.stopped = true;
	}

	private async runPoll(): Promise<InboxPollResult> {
		const listed = [...(await this.options.list())];
		const currentKeys = new Set(listed.map((item) => this.itemKey(item)));
		for (const key of this.pendingAcks.keys())
			if (!currentKeys.has(key)) this.pendingAcks.delete(key);
		const items = listed
			.filter((item) => this.canAttempt(this.itemKey(item)))
			.sort(
				(left, right) =>
					Number(right.needsDecision) - Number(left.needsDecision) ||
					Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
					left.id.localeCompare(right.id),
			);
		let acked = 0;
		let spoken = 0;
		for (const item of items) {
			if (this.stopped) break;
			const key = this.itemKey(item);
			const pendingAck = this.pendingAcks.get(key);
			if (pendingAck) {
				try {
					await this.options.ack(pendingAck.claim, pendingAck.receipts);
					this.pendingAcks.delete(key);
					this.attempts.delete(key);
					acked += 1;
				} catch (error) {
					this.options.record({
						kind: "inbox_ack_retry_failed",
						itemId: item.id,
						message: error instanceof Error ? error.message : String(error),
					});
				}
				continue;
			}
			const claim = await this.options.claim(item);
			if (!claim) continue;
			const validation = validateSpeechBrief(item.speechBrief);
			if (!validation.ok) {
				this.options.record({
					kind: "voice_inbox_brief_rejected",
					itemId: item.id,
					reason: validation.reason,
				});
			}
			const text = validation.ok
				? renderSpeechBrief(item.speechBrief!)
				: item.text;
			const chunks = splitSpeechText(
				text,
				this.options.maxSpeechCodePoints ?? 500,
			);
			const kind: SpeakKind = item.needsDecision ? "question" : "brief";
			let complete = chunks.length > 0;
			let interrupted = false;
			const receipts: SpeakReceipt[] = [];
			for (const [index, chunk] of chunks.entries()) {
				const pendingKey = `${claim.pendingKey}:${index}`;
				let receipt: SpeakReceipt;
				try {
					receipt = await this.options.speak(chunk, kind, {
						pendingKey,
						verification: "required",
					});
				} catch (error) {
					this.options.record({
						kind: "inbox_speech_failed",
						itemId: item.id,
						message: error instanceof Error ? error.message : String(error),
					});
					complete = false;
					break;
				}
				if (
					receipt.outcome !== "completed" ||
					receipt.pendingKey !== pendingKey ||
					!proven(receipt.contentProof)
				) {
					complete = false;
					interrupted =
						receipt.outcome === "failed" &&
						receipt.reason === SPEAK_BARGE_IN_REASON;
					break;
				}
				receipts.push(receipt);
			}
			if (complete) {
				spoken += 1;
				this.pendingAcks.set(key, { claim, receipts });
				try {
					await this.options.ack(claim, receipts);
					this.pendingAcks.delete(key);
					this.attempts.delete(key);
					acked += 1;
				} catch (error) {
					this.options.record({
						kind: "inbox_ack_retry_scheduled",
						itemId: item.id,
						message: error instanceof Error ? error.message : String(error),
					});
				}
			} else if (interrupted) {
				// The founder spoke over this item. It is not a failed delivery:
				// keep its place and attempt budget, and pull nothing after it
				// until a later poll (the live claim is reused within its lease).
				this.options.record({
					kind: "inbox_speech_interrupted",
					itemId: item.id,
				});
				break;
			} else {
				this.noteFailure(key, item.id);
			}
		}
		return { listed: items.length, spoken, acked };
	}

	private canAttempt(itemId: string): boolean {
		const attempt = this.attempts.get(itemId);
		return (
			!attempt || (!attempt.deferred && this.options.now() >= attempt.nextAt)
		);
	}

	private noteFailure(key: string, itemId: string): void {
		const attempt = this.attempts.get(key) ?? {
			count: 0,
			nextAt: 0,
			deferred: false,
		};
		attempt.count += 1;
		attempt.deferred = attempt.count >= MAX_ATTEMPTS_PER_SESSION;
		attempt.nextAt =
			this.options.now() +
			(this.options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS);
		this.attempts.set(key, attempt);
		this.options.record({
			kind: attempt.deferred
				? "inbox_speech_deferred_for_session"
				: "inbox_speech_retry_scheduled",
			itemId,
			nextAt: attempt.nextAt,
		});
	}

	private itemKey(item: HeadphoneInboxItem): string {
		return `${item.id}:${item.revision}`;
	}
}
