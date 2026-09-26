/**
 * Engine A room: the canonical RoomIO v1 (FLY-2798) behind the voice-codex
 * room surface. The legacy and Codex engines keep DiscordVoiceRoom until the
 * two room implementations are unified.
 */
import {
	type BridgeRoomIO,
	createRoomIO,
	type RoomIOOptions,
} from "flywheel-voice-bridge";

export interface RoomIOVoiceRoomOptions
	extends Omit<
		RoomIOOptions,
		"sessionId" | "generation" | "roomKey" | "buildSha" | "instanceId"
	> {
	sessionId?: string;
	generation?: number;
	roomKey?: string;
}

export class RoomIOVoiceRoom {
	readonly roomIO: BridgeRoomIO;
	private readonly generation: number;

	constructor({
		sessionId,
		generation,
		roomKey,
		...options
	}: RoomIOVoiceRoomOptions) {
		this.generation = generation ?? 1;
		this.roomIO = createRoomIO({
			...options,
			sessionId: sessionId ?? `legacy:${options.threadId}`,
			generation: this.generation,
			roomKey: roomKey ?? `${options.guildId}:${options.voiceChannelId}`,
		});
	}

	async start(signal?: AbortSignal): Promise<{ founderPresent: boolean }> {
		const { founderPresent } = await this.roomIO.start(signal);
		return { founderPresent };
	}

	speaker(): { userId: string; name: string } | null {
		return this.roomIO.speaker();
	}

	async playSpeech(speechId: string, pcm24Mono: Buffer): Promise<void> {
		const receipt = await this.roomIO.playSpeech({
			speechId,
			generation: this.generation,
			format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
			pcm: pcm24Mono,
		});
		if (receipt.outcome === "rejected") throw new Error(receipt.reason);
	}

	cancelSpeech(speechId: string): void {
		this.roomIO.localPlaybackCancel(speechId, this.generation);
	}

	setWaiting(waiting: boolean): void {
		this.roomIO.setWaiting(waiting);
	}

	setBedEnabled(enabled: boolean): void {
		this.roomIO.setBedEnabled(enabled);
	}

	status(text: string): Promise<void> {
		return this.roomIO.status(text);
	}

	stop(): Promise<void> {
		return this.roomIO.stop();
	}
}
