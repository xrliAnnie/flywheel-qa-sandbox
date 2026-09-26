/**
 * FLY-2862 — `POST /api/lead-outbound/reply-failed`.
 *
 * A Codex Lead runtime reports that an inbound which owed a reply (a founder
 * message or a voice-room turn) got an empty final answer, so nothing was posted.
 * The report is always logged; when a daemon-held voice session owns the reply
 * thread, one fixed status line is queued for the voice daemon, which speaks it
 * and thereby stops the "Lead is thinking" waiting tone. Nothing goes to Discord.
 *
 * Mounted behind the same Bridge API token as `/api/lead-outbound/send`. The
 * session lookup is bound to the reporting (project, Lead, thread), so a report
 * can only reach that Lead's own live voice session.
 */
import type express from "express";
import type { StateStore } from "../StateStore.js";

export const LEAD_REPLY_FAILED_VOICE_TEXT =
	"这次 Lead 没有给出回复（回话失败），请再说一遍。";

const NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const SNOWFLAKE = /^\d{17,20}$/;
const KEY = /^[A-Za-z0-9_.:#-]{1,200}$/;

export function createLeadReplyFailedHandler(deps: {
	store: Pick<StateStore, "recordVoiceLeadReplyFailure">;
	now?: () => string;
	log?: (line: string) => void;
}): express.RequestHandler {
	const now = deps.now ?? (() => new Date().toISOString());
	const log = deps.log ?? ((line: string) => console.warn(line));
	return (req, res) => {
		const body = (req.body ?? {}) as Record<string, unknown>;
		const { projectName, leadId, channelId, idempotencyKey, reason } = body;
		if (
			typeof projectName !== "string" ||
			!NAME.test(projectName) ||
			typeof leadId !== "string" ||
			!NAME.test(leadId) ||
			typeof channelId !== "string" ||
			!SNOWFLAKE.test(channelId) ||
			typeof idempotencyKey !== "string" ||
			!KEY.test(idempotencyKey) ||
			reason !== "empty_final_answer"
		) {
			res.status(400).json({ error: "invalid_reply_failed_report" });
			return;
		}
		let sessionId: string | undefined;
		try {
			sessionId = deps.store.recordVoiceLeadReplyFailure({
				projectName,
				leadId,
				threadId: channelId,
				key: idempotencyKey,
				text: LEAD_REPLY_FAILED_VOICE_TEXT,
				now: now(),
			});
		} catch (error) {
			log(
				`[lead-reply-failed] ${projectName}/${leadId} record failed: ${(error as Error).message}`,
			);
			res.status(500).json({ error: "reply_failed_record_failed" });
			return;
		}
		log(
			`[lead-reply-failed] ${projectName}/${leadId} channel=${channelId} key=${idempotencyKey} reason=${reason} voice=${sessionId ?? "none"}`,
		);
		res
			.status(200)
			.json(
				sessionId
					? { status: "voice_notified", sessionId }
					: { status: "no_voice_session" },
			);
	};
}
