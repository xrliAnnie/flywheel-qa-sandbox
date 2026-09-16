import { verifyLeadVoiceTokenIdentity } from "./bot-identity.js";
import type { VoiceLease } from "./bridge-client.js";
import { resolveLeadVoiceToken, type VoiceProjectRow } from "./config.js";
import type { SessionJournal } from "./journal.js";
import { parseVoiceProjection } from "./projection.js";
import type {
	SavedVoiceSession,
	VoiceRecoveryRecord,
} from "./session-state.js";

/** Failed admission closes only local journal work; it never selects a new bot. */
export function abandonVoiceJournal(
	journal: SessionJournal,
	reason: string,
): number {
	const pending = journal.pending();
	for (const row of pending)
		journal.append({
			kind: "abandoned",
			transcriptId: row.transcriptId,
			reason,
		});
	return pending.length;
}

export async function recoverPinnedVoiceSession(input: {
	saved: VoiceRecoveryRecord;
	authority?: VoiceLease;
	projects: VoiceProjectRow[];
	env: Readonly<Record<string, string | undefined>>;
	journal: SessionJournal;
	fetchImpl?: typeof fetch;
	replay(
		saved: SavedVoiceSession,
		token: string,
		authority: VoiceLease,
	): Promise<number>;
}): Promise<number> {
	try {
		if (!input.authority) throw new Error("voice_lease_fenced");
		input.authority.assert();
		const projection = parseVoiceProjection(
			input.saved.projection,
			input.saved.sessionId,
		);
		const token = resolveLeadVoiceToken(projection, input.projects, input.env);
		await verifyLeadVoiceTokenIdentity(
			token,
			projection.voiceBotUserId,
			input.fetchImpl,
		);
		input.authority.assert();
		return await input.replay(
			{ ...input.saved, projection },
			token,
			input.authority,
		);
	} catch {
		return abandonVoiceJournal(input.journal, "voice_recovery_rejected");
	}
}
