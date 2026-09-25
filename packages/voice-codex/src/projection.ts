import { isRealtimeV2Voice } from "flywheel-teamlead/realtime-voices";
import type { VoiceSessionProjection } from "./bridge-client.js";

export const VOICE_SESSION_UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const snowflake = (value: unknown): value is string =>
	typeof value === "string" && /^\d{17,20}$/u.test(value);
const text = (value: unknown): value is string =>
	typeof value === "string" && value.trim().length > 0;
const instant = (value: unknown): value is string =>
	typeof value === "string" && Number.isFinite(Date.parse(value));

/** Validate disk/HTTP data before it may select credentials or IO destinations. */
export function parseVoiceProjection(
	value: unknown,
	sessionId: string,
): VoiceSessionProjection {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("voice_projection_invalid");
	const row = value as Record<string, unknown>;
	if (
		!VOICE_SESSION_UUID.test(sessionId) ||
		row.sessionId !== sessionId ||
		!text(row.projectName) ||
		!/^[a-zA-Z0-9_-]+$/u.test(row.projectName) ||
		!text(row.leadId) ||
		!text(row.displayName) ||
		!isRealtimeV2Voice(row.realtimeVoice) ||
		!["meeting", "rg"].includes(String(row.mode)) ||
		![
			row.guildId,
			row.voiceChannelId,
			row.voiceBotUserId,
			row.threadId,
			row.founderUserId,
		].every(snowflake) ||
		!Array.isArray(row.boundChannelIds) ||
		!row.boundChannelIds.every(snowflake) ||
		!Array.isArray(row.qaAllowUserIds) ||
		!row.qaAllowUserIds.every(snowflake) ||
		(row.evidenceDir != null && !text(row.evidenceDir)) ||
		(row.meetingId != null && !text(row.meetingId)) ||
		// FLY-2701: the live floor decides when a bot may open its microphone, so
		// an unparseable instant must be refused, never treated as "now".
		(row.notBeforeLiveAt != null && !instant(row.notBeforeLiveAt)) ||
		(row.presenceDeadlineAt != null && !instant(row.presenceDeadlineAt)) ||
		(row.scheduleRevision != null &&
			(!Number.isSafeInteger(row.scheduleRevision) ||
				(row.scheduleRevision as number) < 1)) ||
		(row.sessionGeneration != null &&
			(!Number.isSafeInteger(row.sessionGeneration) ||
				(row.sessionGeneration as number) < 1))
	) {
		throw new Error("voice_projection_invalid");
	}
	return value as VoiceSessionProjection;
}
