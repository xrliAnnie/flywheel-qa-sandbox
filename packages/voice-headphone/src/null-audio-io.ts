/**
 * NullAudioIO (FLY-546 B2-2.4) — the desktop dry-run HeadphoneIO:
 * speak() plays through the LOCAL speakers (voice-core EdgeTts announce),
 * while sendReply/postReceipt go to real Discord and submitApproval to the
 * real Bridge. Used for development self-test and the B3-3 desk dry-run;
 * the product path (VC audio via FLY-545) replaces only the audio face in
 * M-B4 — the Discord/Bridge sides stay identical.
 */
import type {
	HeadphoneIO,
	PersistedTurnState,
	QueueItem,
	VoiceDirectory,
	VoiceSpec,
} from "flywheel-voice-core";
import type {
	ShipApprovalRequest,
	ShipApprovalResult,
} from "./bridge-client.js";
import { adoptOrSend, sendMarker } from "./recovery.js";

export interface LocalAnnouncerLike {
	speak(text: string, voice: VoiceSpec): Promise<void>;
	stop(): void;
}

export interface DiscordSenderLike {
	/** returns the created message id. */
	sendMessage(
		channelId: string,
		content: string,
		replyToMessageId?: string,
	): Promise<string>;
	scanRecent(
		channelId: string,
	): Promise<Array<{ id: string; content: string }>>;
}

export interface ShipApprovalClientLike {
	postShipApproval(body: ShipApprovalRequest): Promise<ShipApprovalResult>;
}

export interface NullAudioIOOptions {
	announcer: LocalAnnouncerLike;
	directory: VoiceDirectory;
	sender: DiscordSenderLike;
	bridge: ShipApprovalClientLike;
	/** the founder id the daemon attributes utterances to (verified against
	 * the Bridge scope fingerprint at startup) — sent as the transcript's
	 * attested speaker on approval writes. */
	founderUserId: string;
	persist: (state: unknown) => void;
}

export class NullAudioIO implements HeadphoneIO {
	constructor(private readonly opts: NullAudioIOOptions) {}

	async speak(agentId: string | "system", text: string): Promise<void> {
		const voice = this.opts.directory.resolve(agentId);
		await this.opts.announcer.speak(text, voice);
	}

	stopSpeaking(): void {
		this.opts.announcer.stop();
	}

	async sendReply(
		item: QueueItem,
		text: string,
	): Promise<{ ok: boolean; sentMessageId?: string }> {
		const marker = sendMarker(item.id);
		// Fixed relay structure (exploration D4): our OWN bot identity, never
		// impersonating her; @ the original Lead bot + reply-reference so both
		// Lead mention-gate paths accept it (research §3).
		const mention = item.authorId ? ` <@${item.authorId}>` : "";
		const content = `🎧 Annie(语音)${mention}:${text} ${marker}`;
		try {
			const res = await adoptOrSend({
				marker,
				scanRecent: () => this.opts.sender.scanRecent(item.channelId),
				send: () =>
					this.opts.sender.sendMessage(item.channelId, content, item.messageId),
			});
			return { ok: true, sentMessageId: res.messageId };
		} catch (_err) {
			return { ok: false, sentMessageId: undefined };
		}
	}

	async postReceipt(
		item: QueueItem,
		transcript: string,
	): Promise<{ ok: boolean; receiptMessageId?: string }> {
		const gate = item.gate;
		if (!gate) return { ok: false };
		const card = [
			"🧾 语音批准收据(TIV)",
			`- issue: ${item.headline.issueRef ?? gate.issueId}`,
			`- questionId: ${gate.questionId}`,
			`- prHeadSha: ${gate.prHeadSha}`,
			`- 原话转写: 「${transcript}」`,
			`- 时间: ${new Date().toISOString()}`,
			`〔hp:receipt:${item.id}〕`,
		].join("\n");
		try {
			const id = await this.opts.sender.sendMessage(
				item.channelId,
				card,
				gate.gateMessageId,
			);
			return { ok: true, receiptMessageId: id };
		} catch {
			return { ok: false };
		}
	}

	async submitApproval(
		item: QueueItem,
		transcript: string,
		receiptMessageId: string,
	): Promise<{ ok: boolean; reason?: string; warning?: string }> {
		const gate = item.gate;
		if (!gate) {
			// structurally unreachable from the machine (only ship_gate items
			// enter the approval state) — refuse anyway, never guess a target.
			return { ok: false, reason: "no gate binding on this item" };
		}
		const res = await this.opts.bridge.postShipApproval({
			gateMessageId: gate.gateMessageId,
			questionId: gate.questionId,
			prHeadSha: gate.prHeadSha,
			transcript: {
				id: `hp-${item.id}`,
				text: transcript,
				atMs: Date.now(),
				founderUserId: this.opts.founderUserId,
			},
			receiptMessageId,
		});
		if (!res.ok) return { ok: false, reason: res.reason };
		if (res.written) {
			if (res.retrySafe === false) {
				// the approval IS recorded but the flip+wake hook did not confirm
				// — say so honestly instead of a clean "已 ship" (Codex R1 HIGH-2).
				return {
					ok: true,
					warning: "批准已写入,但后续推进没确认,回屏幕看一眼。",
				};
			}
			return { ok: true };
		}
		return {
			ok: false,
			reason: `bridge 判定 ${res.kind ?? "unclear"},未写批准`,
		};
	}

	persist(state: unknown): void {
		this.opts.persist(state as PersistedTurnState);
	}

	now(): number {
		return Date.now();
	}
}
