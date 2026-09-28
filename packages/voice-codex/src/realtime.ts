/**
 * Utterance ownership shared by the Discord room layer and engine B
 * (`codex-realtime`). The OpenAI Realtime frontend that used to live here
 * (engine A) was removed in FLY-2982; only this data shape remains.
 */
export interface RealtimeAudioOwner {
	utteranceId: string | null;
	ownerUserId: string | null;
	ownerName?: string | null;
}
