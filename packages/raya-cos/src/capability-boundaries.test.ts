import { describe, expect, it } from "vitest";
import { beginLeadQuestion, observeLeadAnswer } from "./lead-questions.js";
import {
	cancelMeeting,
	parseMeetingCommand,
	rescheduleMeeting,
	scheduleMeeting,
} from "./meeting.js";
import { createUnavailablePorts } from "./ports.js";
import { requestVoiceIntent } from "./voice-intent.js";

describe("capability boundaries", () => {
	it("reports announcements as unavailable without leaving them pending forever", async () => {
		const ports = createUnavailablePorts();

		await expect(
			ports.announce({
				eventId: "summary:round-1:report",
				target: "chat",
				text: "No outbound adapter is installed.",
			}),
		).resolves.toEqual({
			status: "unavailable",
			reason: "announcement_transport_not_available",
		});
	});

	it("preserves a question without claiming it was queued or delivered", async () => {
		const result = await beginLeadQuestion(
			{
				ask: {
					askId: "question-1",
					revision: 1,
					to: { project: "flywheel", leadId: "flywheel-eng-lead" },
					body: "Which release owns this?",
					expiresAt: 2_000,
				},
				status: "posting",
				createdAt: 1_000,
				updatedAt: 1_000,
			},
			createUnavailablePorts(),
		);

		expect(result.status).toBe("posting");
		expect(result.transport).toEqual({
			status: "unavailable",
			reason: "lead_transport_not_available",
		});
		expect(result.deliveryId).toBeUndefined();
	});

	it("keeps meeting state and separate known receipts when delivery is unavailable", async () => {
		const result = await scheduleMeeting(
			{
				meetingId: "f5e14717-049b-4d43-b58d-78f18cc1aebb",
				revision: 3,
				title: "Portfolio review",
				startsAt: "2026-09-09T17:00:00.000Z",
				participants: [{ project: "flywheel", leadId: "flywheel-eng-lead" }],
				calendarEventId: "calendar-existing",
				outboundMessageId: "discord-existing",
				mailboxDeliveryId: "mailbox-existing",
			},
			createUnavailablePorts(),
		);

		expect(result.status).toBe("scheduled");
		expect(result.calendarEventId).toBe("calendar-existing");
		expect(result.outboundMessageId).toBe("discord-existing");
		expect(result.mailboxDeliveryId).toBe("mailbox-existing");
		expect(result.notification).toEqual({
			status: "unavailable",
			reason: "lead_transport_not_available",
		});
	});

	it("accepts an answer only from the canonical recipient Lead", () => {
		const posted = {
			ask: {
				askId: "question-1",
				revision: 1,
				to: { project: "flywheel", leadId: "flywheel-eng-lead" },
				body: "Which release owns this?",
				expiresAt: 2_000,
			},
			status: "posted" as const,
			createdAt: 1_000,
			updatedAt: 1_100,
			deliveryId: "mailbox-1",
		};
		expect(() =>
			observeLeadAnswer(posted, {
				from: { project: "growth", leadId: "other" },
				messageId: "answer-1",
				body: "Fake answer",
				observedAt: 1_200,
			}),
		).toThrow("canonical recipient");
		expect(
			observeLeadAnswer(posted, {
				from: { project: "flywheel", leadId: "flywheel-eng-lead" },
				messageId: "answer-2",
				body: "The updater owns deployment.",
				observedAt: 1_200,
			}),
		).toMatchObject({ status: "answer_observed", answerMessageId: "answer-2" });
	});

	it("does not report voice as started without a shared voice capability", async () => {
		const result = await requestVoiceIntent(
			{
				meetingId: "f5e14717-049b-4d43-b58d-78f18cc1aebb",
				action: "start",
			},
			createUnavailablePorts(),
		);

		expect(result).toEqual({
			meetingId: "f5e14717-049b-4d43-b58d-78f18cc1aebb",
			action: "start",
			status: "unavailable",
			reason: "voice_transport_not_available",
		});
	});

	it("parses the bounded meeting commands through a central directory projection", () => {
		const directory = {
			resolve: (name: string) =>
				name.normalize("NFKC").replaceAll(/\s/gu, "").toLowerCase() ===
				"tadashi"
					? {
							status: "found" as const,
							ref: { project: "flywheel", leadId: "tadashi" },
						}
					: { status: "not_found" as const },
		};
		expect(
			parseMeetingCommand(
				"安排会议 明天 8：05 和 ＴＡＤＡＳＨＩ 聊 路线 时长 45",
				directory,
			),
		).toEqual({
			kind: "schedule",
			when: { hour: 8, minute: 5, tomorrow: true },
			to: { project: "flywheel", leadId: "tadashi" },
			topic: "路线",
			durationMinutes: 45,
		});
		expect(parseMeetingCommand("改期会议 25:00", directory)).toEqual({
			kind: "hint",
		});
		expect(parseMeetingCommand("取消会议", directory)).toEqual({
			kind: "cancel",
		});
	});

	it("reschedules and cancels locally without manufacturing new receipts", async () => {
		const original = {
			meetingId: "f5e14717-049b-4d43-b58d-78f18cc1aebb",
			revision: 3,
			title: "Portfolio review",
			startsAt: "2026-09-09T17:00:00.000Z",
			participants: [{ project: "flywheel", leadId: "flywheel-eng-lead" }],
			status: "scheduled" as const,
			calendarEventId: "calendar-existing",
			outboundMessageId: "discord-existing",
			mailboxDeliveryId: "mailbox-existing",
		};
		const moved = await rescheduleMeeting(
			original,
			"2026-09-10T18:00:00.000Z",
			createUnavailablePorts(),
		);
		expect(moved).toMatchObject({
			revision: 4,
			status: "rescheduled",
			calendarEventId: "calendar-existing",
			outboundMessageId: "discord-existing",
			mailboxDeliveryId: "mailbox-existing",
			notification: { status: "unavailable" },
		});
		expect(cancelMeeting(moved)).toMatchObject({
			revision: 5,
			status: "cancelled",
			calendarEventId: "calendar-existing",
		});
	});
});
