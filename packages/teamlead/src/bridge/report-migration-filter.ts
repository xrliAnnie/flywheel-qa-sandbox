import type { ReportEntry } from "./report-registry.js";

const LEGACY_AUTOMATIC_HISTORY_TITLE = "<title>机器试判历史</title>";

/** Excludes only the old untitled worker artifact; manual/on-demand reports remain portable. */
export function isUntitledLegacyAutomaticHistory(
	entry: Pick<ReportEntry, "title">,
	html: string,
): boolean {
	return !entry.title && html.includes(LEGACY_AUTOMATIC_HISTORY_TITLE);
}
