import type { CustomerNoticeIntent } from "./types.js";

export const customerNoticeFields = [
	"noticeId",
	"messageDigest",
	"channelId",
	"applicationId",
	"botUserId",
	"founderId",
	"noticeAt",
	"deadlineAt",
	"claimNotAfter",
	"minimumVetoMinutes",
] as const;
export const isDiscordId = (value: unknown): value is string =>
	typeof value === "string" && /^[1-9]\d{16,19}$/.test(value);
export function validNoticeIntent(intent: CustomerNoticeIntent): boolean {
	return (
		intent !== null &&
		typeof intent === "object" &&
		Object.keys(intent).every((key) =>
			(customerNoticeFields as readonly string[]).includes(key),
		) &&
		typeof intent.noticeId === "string" &&
		/^[a-f0-9]{32}$/.test(intent.noticeId) &&
		typeof intent.messageDigest === "string" &&
		/^[a-f0-9]{64}$/.test(intent.messageDigest) &&
		[
			intent.channelId,
			intent.applicationId,
			intent.botUserId,
			intent.founderId,
		].every(isDiscordId) &&
		Number.isSafeInteger(intent.noticeAt) &&
		intent.noticeAt >= 0 &&
		Number.isSafeInteger(intent.deadlineAt) &&
		intent.deadlineAt > intent.noticeAt &&
		Number.isSafeInteger(intent.claimNotAfter) &&
		intent.claimNotAfter > intent.deadlineAt &&
		Number.isSafeInteger(intent.minimumVetoMinutes) &&
		intent.minimumVetoMinutes >= 120 &&
		intent.minimumVetoMinutes <= 480 &&
		intent.deadlineAt - intent.noticeAt >= intent.minimumVetoMinutes * 60_000
	);
}
