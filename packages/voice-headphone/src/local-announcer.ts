/**
 * LocalEdgeAnnouncer — desktop speaker face for the dry-run mode: one
 * voice-core EdgeTts announcer session per utterance so每条可带自己的
 * per-agent VoiceSpec (announcer sessions pin their voice at creation).
 */
import type {
	AnnouncerSession,
	EdgeTtsBackend,
	VoiceSpec,
} from "flywheel-voice-core";
import type { LocalAnnouncerLike } from "./null-audio-io.js";

export class LocalEdgeAnnouncer implements LocalAnnouncerLike {
	private current?: AnnouncerSession;

	constructor(private readonly backend: EdgeTtsBackend) {}

	async speak(text: string, voice: VoiceSpec): Promise<void> {
		const session = await this.backend.createAnnouncer({ voice });
		this.current = session;
		try {
			await session.speak(text);
		} finally {
			this.current = undefined;
			await session.close().catch(() => {});
		}
	}

	stop(): void {
		this.current?.interrupt();
	}
}
