/** Select the claim's report reference; host trust and retained bytes are checked by the caller. */
export function selectQaReportReference(
	summary: string,
): { url: string; token: string } | null {
	if (summary.length > 65_536) return null;
	const labels = [
		...summary.matchAll(
			/(?:QA\s*report|QA\s*报告|Ship\s*report|验收报告)\s*(?:\([^\n)]{0,160}\))?\s*[:：]\s*/gi,
		),
	];
	const sources = labels.length
		? labels.map((match) => summary.slice(match.index! + match[0].length))
		: [summary];
	const reports = new Map<string, { url: string; token: string }>();
	for (const source of sources) {
		// A label identifies its immediately following plain URL or Markdown link.
		const candidates = labels.length
			? [
					source.match(
						/^(?:\[[^\]\n]{1,160}\]\()?((?:https?):\/\/[^\s<>"'[\]()]+)/,
					)?.[1],
				]
			: [...source.matchAll(/https:\/\/[^\s<>"'[\]()]+/g)].map(
					(match) => match[0],
				);
		for (const candidate of candidates) {
			if (!candidate) {
				if (labels.length) return null;
				continue;
			}
			try {
				const url = new URL(candidate.replace(/[.,;]+$/, ""));
				const path = /^\/r\/([A-Za-z0-9_-]{1,64})\/?$/.exec(url.pathname);
				if (
					url.protocol !== "https:" ||
					url.username ||
					url.password ||
					!path ||
					url.search ||
					url.hash
				) {
					if (labels.length) return null;
					continue;
				}
				url.pathname = `/r/${path[1]}/`;
				reports.set(url.href, { url: url.href, token: path[1]! });
			} catch {
				if (labels.length) return null;
			}
		}
	}
	return reports.size === 1 ? [...reports.values()][0]! : null;
}
