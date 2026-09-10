import { createHash } from "node:crypto";
import { scrubTranscript } from "flywheel-voice-core";
import type { PendingTranscript, SessionJournal } from "./journal.js";

export type IngestLane =
	| "inserted_inbox"
	| "active_inbox"
	| "inserted_external"
	| "legacy_external"
	| "archived";

export interface CapturedTranscript {
	transcriptId: string;
	speakerUserId: string;
	speakerName: string;
	rawText: string;
	ts: string;
}

interface VoiceDeliveryOptions {
	sessionId: string;
	leadId: string;
	threadId: string;
	founderUserId: string;
	journal: SessionJournal;
	assertLease(): void;
	mirror(input: {
		text: string;
		nonce: string;
	}): Promise<{ messageId: string }>;
	ingest(input: {
		leadId: string;
		voiceSessionId: string;
		threadId: string;
		messageId: string;
		authorId: string;
		authorName: string;
		text: string;
		ts: string;
	}): Promise<{ lane: IngestLane; deliveryId: string }>;
	readDelivery(deliveryId: string): Promise<{
		origin: string;
		voiceSessionId: string;
		authorId: string;
		text: string;
	} | null>;
	status(text: string): void | Promise<void>;
	evidence(record: Record<string, unknown>): void;
	mirrorRetries?: number;
	mirrorRetryWindowMs?: number;
	ingestRetries?: number;
	deliveryRetryMs?: number;
	retryDelay?(ms: number): Promise<void>;
	now?(): Date;
}

function nonce(sessionId: string, transcriptId: string): string {
	return BigInt(
		`0x${createHash("sha256").update(`${sessionId}:${transcriptId}`).digest("hex")}`,
	)
		.toString(36)
		.slice(0, 25);
}

function leaseFenced(error: unknown): boolean {
	return error instanceof Error && error.message === "voice_lease_fenced";
}

export class VoiceDelivery {
	constructor(private readonly options: VoiceDeliveryOptions) {}

	async capture(input: CapturedTranscript): Promise<boolean> {
		const safeText = Array.from(scrubTranscript(input.rawText).trim())
			.slice(0, 1_800)
			.join("");
		if (!safeText) return false;
		const pending: PendingTranscript = {
			transcriptId: input.transcriptId,
			stage: "captured",
			safeText,
			nonce: nonce(this.options.sessionId, input.transcriptId),
			speakerUserId: input.speakerUserId,
			speakerName: input.speakerName,
			ts: input.ts,
		};
		this.options.journal.append({ kind: "captured", ...pending });
		this.options.evidence({
			ts: input.ts,
			kind: "realtime_transcript",
			role: "user",
			generation: 1,
			text: safeText,
			speakerUserId: input.speakerUserId,
		});
		return this.deliver(pending);
	}

	async recover(): Promise<number> {
		const pending = this.options.journal.pending();
		try {
			this.options.assertLease();
		} catch {
			for (const row of pending) {
				this.options.journal.append({
					kind: "abandoned",
					transcriptId: row.transcriptId,
					reason: "recovery_fenced",
				});
			}
			return pending.length;
		}
		let abandoned = 0;
		for (const row of pending) {
			if (!(await this.deliver(row))) abandoned += 1;
		}
		return abandoned;
	}

	private async deliver(row: PendingTranscript): Promise<boolean> {
		let messageId = row.messageId;
		if (!messageId) {
			if (row.stage === "captured") {
				row.mirrorRequestedAt = this.now().toISOString();
				this.options.journal.append({
					kind: "mirror_requested",
					transcriptId: row.transcriptId,
					ts: row.mirrorRequestedAt,
				});
			} else if (!this.withinMirrorRetryWindow(row)) {
				return this.abandon(row.transcriptId, "mirror_unknown");
			}
			for (
				let attempt = 0;
				attempt <= (this.options.mirrorRetries ?? 0);
				attempt += 1
			) {
				try {
					this.options.assertLease();
					messageId = (
						await this.options.mirror({
							text: `🗣️ **${row.speakerName.replace(/[*_~`\\]/gu, "").slice(0, 80)}**: ${row.safeText}`,
							nonce: row.nonce,
						})
					).messageId;
					break;
				} catch (error) {
					if (leaseFenced(error)) {
						this.options.journal.append({
							kind: "fenced",
							transcriptId: row.transcriptId,
							reason: "lease_fenced",
						});
						return false;
					}
					if (
						attempt < (this.options.mirrorRetries ?? 0) &&
						this.withinMirrorRetryWindow(row)
					) {
						await this.retryDelay();
					}
				}
			}
			if (!messageId) {
				return this.abandon(row.transcriptId, "mirror_unknown");
			}
			this.options.journal.append({
				kind: "mirrored",
				transcriptId: row.transcriptId,
				messageId,
			});
		}

		const ingestInput = {
			leadId: this.options.leadId,
			voiceSessionId: this.options.sessionId,
			threadId: this.options.threadId,
			messageId,
			authorId: row.speakerUserId || this.options.founderUserId,
			authorName: row.speakerName,
			text: row.safeText,
			ts: row.ts,
		};
		for (
			let attempt = 0;
			attempt <= (this.options.ingestRetries ?? 0);
			attempt += 1
		) {
			try {
				this.options.assertLease();
				const ingested = await this.options.ingest(ingestInput);
				if (ingested.lane === "active_inbox") {
					const existing = await this.options.readDelivery(ingested.deliveryId);
					if (
						existing?.origin !== "voice" ||
						existing.voiceSessionId !== this.options.sessionId ||
						existing.authorId !==
							(row.speakerUserId || this.options.founderUserId) ||
						existing.text !== row.safeText
					) {
						return this.abandon(row.transcriptId, "ingest_identity_conflict");
					}
				} else if (ingested.lane !== "inserted_inbox") {
					return this.abandon(row.transcriptId, `ingest_lane_${ingested.lane}`);
				}
				this.options.journal.append({
					kind: "ingested",
					transcriptId: row.transcriptId,
					deliveryId: ingested.deliveryId,
					lane: ingested.lane,
				});
				return true;
			} catch (error) {
				if (leaseFenced(error)) {
					this.options.journal.append({
						kind: "fenced",
						transcriptId: row.transcriptId,
						reason: "lease_fenced",
					});
					return false;
				}
				if (attempt < (this.options.ingestRetries ?? 0))
					await this.retryDelay();
			}
		}
		return this.abandon(row.transcriptId, "ingest_failed");
	}

	private now(): Date {
		return this.options.now?.() ?? new Date();
	}

	private withinMirrorRetryWindow(row: PendingTranscript): boolean {
		const requestedAt = Date.parse(row.mirrorRequestedAt ?? "");
		return (
			Number.isFinite(requestedAt) &&
			this.now().getTime() - requestedAt <=
				(this.options.mirrorRetryWindowMs ?? 60_000)
		);
	}

	private async retryDelay(): Promise<void> {
		await (
			this.options.retryDelay ??
			((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
		)(this.options.deliveryRetryMs ?? 500);
	}

	private async abandon(transcriptId: string, reason: string): Promise<false> {
		this.options.journal.append({ kind: "abandoned", transcriptId, reason });
		try {
			this.options.assertLease();
			await this.options.status("📻 有一句可能没送到,请再说一遍");
		} catch (error) {
			if (!leaseFenced(error)) throw error;
		}
		return false;
	}
}
