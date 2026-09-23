import type { AudioFormat } from "./types.js";
import type { ReceiveHealth } from "./receive-health.js";

export interface RoomAudioOwner {
	utteranceId: string | null;
	ownerUserId: string | null;
	ownerName?: string | null;
}

/** @deprecated Legacy voice-codex name; the owner contract belongs to RoomIO. */
export type RealtimeAudioOwner = RoomAudioOwner;

export type RoomAudioAttribution =
	| { kind: "known"; speakerUserId: string; speakerName?: string | null }
	| { kind: "unknown"; reason: string };

export interface RoomAudioFrame {
	pcm: Buffer;
	format: AudioFormat;
	sessionId: string;
	generation: number;
	sequence: number;
	capturedAt: number;
	utteranceId: string | null;
	attribution: RoomAudioAttribution;
}

export interface RoomPresence {
	founderPresent: boolean;
	humanCount: number;
}

export interface RoomBargeInEvent {
	sessionId: string;
	generation: number;
	utteranceId: string;
	owner: RoomAudioAttribution;
	startedAt: number;
	observedAt: number;
	durationMs: number;
	phase: "start" | "sustained" | "end";
}

export interface RoomIOIdentity {
	moduleExport: string;
	roomIOVersion: 1;
	implementationDigest: string;
	buildSha: string | null;
	instanceId: string;
	sessionId: string;
	roomKey: string;
	generation: number;
	inputRouteInstanceId: string;
	outputRouteInstanceId: string;
}

export type SpeechStartReceipt =
	| { outcome: "accepted"; speechId: string; generation: number }
	| {
			outcome: "rejected";
			speechId: string;
			generation: number;
			reason: string;
	  };

export type FrameReceipt =
	| {
			outcome: "submitted";
			speechId: string;
			generation: number;
			sequence: number;
	  }
	| {
			outcome: "rejected";
			speechId: string;
			generation: number;
			sequence: number;
			reason: string;
	  };

export type SubmittedReceipt =
	| { outcome: "submitted"; speechId: string; generation: number }
	| {
			outcome: "rejected";
			speechId: string;
			generation: number;
			reason: string;
	  };

export interface SpeechStart {
	speechId: string;
	generation: number;
	format: AudioFormat;
}

export interface SpeechFrame {
	speechId: string;
	generation: number;
	sequence: number;
	pcm: Buffer;
}

export type RoomClipSource =
	| { kind: "file"; path: string }
	| { kind: "encoded"; bytes: Buffer; format: "wav" | "mp3" };

export interface RoomClip {
	speechId: string;
	generation: number;
	source: RoomClipSource;
	priority: "cue" | "speech";
}

export interface AudibleTailEstimate {
	estimated: true;
	remainingMs: number | null;
	drained: boolean;
	observedAt: number;
	sessionId: string;
	generation: number;
}

export interface RoomIO {
	readonly identity: RoomIOIdentity;
	onFrame(listener: (frame: RoomAudioFrame) => void): () => void;
	onPresence(listener: (presence: RoomPresence) => void): () => void;
	onReceiveHealth(listener: (health: ReceiveHealth) => void): () => void;
	onBargeIn(listener: (event: RoomBargeInEvent) => void): () => void;
	start(signal?: AbortSignal): Promise<RoomPresence>;
	stop(): Promise<void>;
	status(text: string): Promise<void>;
	startSpeech(input: SpeechStart): SpeechStartReceipt;
	writeSpeech(frame: SpeechFrame): Promise<FrameReceipt>;
	endSpeech(speechId: string, generation: number): Promise<SubmittedReceipt>;
	playSpeech(input: SpeechStart & { pcm: Buffer }): Promise<SubmittedReceipt>;
	playClip(input: RoomClip): Promise<SubmittedReceipt>;
	localPlaybackCancel(speechId: string, generation: number): void;
	audibleTail(): AudibleTailEstimate;
	speaker(): { userId: string; name: string } | null;
	setWaiting(waiting: boolean): void;
	setBedEnabled(enabled: boolean): void;
}

export type RoomReceiveHealth = ReceiveHealth;
