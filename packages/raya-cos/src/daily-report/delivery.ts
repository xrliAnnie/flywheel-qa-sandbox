import type { CoSPorts } from "../ports.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

export type DailyReportChunkKind =
	| "title"
	| "body"
	| "footer"
	| "notice"
	| "unknown-notice";

export type DailyReportChunk = {
	date: string;
	fileSha: string;
	kind: DailyReportChunkKind;
	index: number;
	text: string;
};

export function dailyReportEventId(
	date: string,
	fileSha: string,
	kind: DailyReportChunkKind,
	index: number,
): string {
	if (!DATE_PATTERN.test(date) || !GIT_SHA_PATTERN.test(fileSha)) {
		throw new Error("daily report delivery identity is invalid");
	}
	if (!Number.isSafeInteger(index) || index < 0) {
		throw new Error("daily report delivery index is invalid");
	}
	return `daily-report:${date}:${fileSha}:${kind}:${index}`;
}

export async function announceDailyReportChunk(
	chunk: DailyReportChunk,
	ports: CoSPorts,
) {
	return ports.announce({
		eventId: dailyReportEventId(
			chunk.date,
			chunk.fileSha,
			chunk.kind,
			chunk.index,
		),
		target: "chat",
		text: chunk.text,
	});
}
