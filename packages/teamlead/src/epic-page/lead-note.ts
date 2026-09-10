export const DEFAULT_LEAD_NOTE_FADE_DAYS = 3;

export function leadNoteAge(writtenAt: string, now: Date, fadeDays: number) {
	const age = Math.max(0, now.getTime() - Date.parse(writtenAt));
	const hours = Math.floor(age / 3_600_000);
	return {
		stale: age > fadeDays * 86_400_000,
		relative: hours < 1 ? "刚写" : `${hours} 小时前写`,
	};
}
