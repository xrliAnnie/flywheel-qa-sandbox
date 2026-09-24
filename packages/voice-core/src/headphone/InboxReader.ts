/**
 * Refactored from Raya apps/voice/src/inbox/InboxReader.ts@f669d1b.
 * Preserved: one in-flight poll, decision-first ordering, claim-before-speak,
 * all-segments-before-ack, and two attempts with a sixty-second backoff.
 * Removed by the approved V2 boundary: filters, spoken ship, and text-only
 * treatment of reports.
 */
import type { SpeakContentProof, SpeakKind, SpeakReceipt } from "../types.js";
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

function proven(proof: SpeakContentProof): boolean {
	return proof === "deterministic_tts" || proof === "transcript_equivalent";
}

export class InboxReader {
	private polling: Promise<number> | null = null;
	private stopped = false;
	private readonly attempts = new Map<
		string,
		{ count: number; nextAt: number; deferred: boolean }
	>();

	constructor(private readonly options: InboxReaderOptions) {}

	poll(): Promise<number> {
		if (this.stopped) return Promise.resolve(0);
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

	private async runPoll(): Promise<number> {
		const items = [...(await this.options.list())]
			.filter((item) => this.canAttempt(item.id))
			.sort(
				(left, right) =>
					Number(right.needsDecision) - Number(left.needsDecision) ||
					Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
					left.id.localeCompare(right.id),
			);
		let acked = 0;
		for (const item of items) {
			if (this.stopped) break;
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
			const receipts: SpeakReceipt[] = [];
			for (const [index, chunk] of chunks.entries()) {
				const pendingKey = `inbox:${item.id}:${item.revision}:${index}`;
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
					break;
				}
				receipts.push(receipt);
			}
			if (complete) {
				await this.options.ack(claim, receipts);
				this.attempts.delete(item.id);
				acked += 1;
			} else {
				this.noteFailure(item.id);
			}
		}
		return acked;
	}

	private canAttempt(itemId: string): boolean {
		const attempt = this.attempts.get(itemId);
		return (
			!attempt || (!attempt.deferred && this.options.now() >= attempt.nextAt)
		);
	}

	private noteFailure(itemId: string): void {
		const attempt = this.attempts.get(itemId) ?? {
			count: 0,
			nextAt: 0,
			deferred: false,
		};
		attempt.count += 1;
		attempt.deferred = attempt.count >= MAX_ATTEMPTS_PER_SESSION;
		attempt.nextAt =
			this.options.now() +
			(this.options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS);
		this.attempts.set(itemId, attempt);
		this.options.record({
			kind: attempt.deferred
				? "inbox_speech_deferred_for_session"
				: "inbox_speech_retry_scheduled",
			itemId,
			nextAt: attempt.nextAt,
		});
	}
}
