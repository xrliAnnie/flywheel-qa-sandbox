/**
 * Compatibility adapter for the pre-RoomIO voice-codex surface.
 *
 * The physical Discord implementation lives only in
 * flywheel-voice-bridge/room/RoomIO. Keep this wrapper until every legacy
 * voice-codex caller has moved to the versioned RoomIO contract.
 */
import {
	type BridgeRoomIO,
	createRoomIO,
	type RoomIOOptions,
} from "flywheel-voice-bridge";

export interface DiscordVoiceRoomOptions
	extends Omit<
		RoomIOOptions,
		"sessionId" | "generation" | "roomKey" | "buildSha" | "instanceId"
	> {}

export class DiscordVoiceRoom {
	readonly roomIO: BridgeRoomIO;

	constructor(options: DiscordVoiceRoomOptions) {
		this.roomIO = createRoomIO({
			...options,
			sessionId: `legacy:${options.threadId}`,
			generation: 1,
			roomKey: `${options.guildId}:${options.voiceChannelId}`,
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
			generation: 1,
			format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
			pcm: pcm24Mono,
		});
		if (receipt.outcome === "rejected") throw new Error(receipt.reason);
	}

	cancelSpeech(speechId: string): void {
		this.roomIO.localPlaybackCancel(speechId, 1);
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
