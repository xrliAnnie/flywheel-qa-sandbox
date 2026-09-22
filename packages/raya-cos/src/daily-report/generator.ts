import type { ReportSource } from "../contracts/daily-report.js";

export type ReportGenerationSource = ReportSource & { content: string };

export type ReportGenerationInput = {
	date: string;
	timeZone: string;
	mainCommit: string;
	sources: readonly ReportGenerationSource[];
};

export function buildDailyReportPrompt(input: ReportGenerationInput): string {
	const material = input.sources
		.map((source, index) => {
			const { content, ...manifest } = source;
			return [
				`## source:${index} — ${source.project} / ${source.lead}`,
				source.state === "open"
					? "状态：未吸收（open PR）"
					: "状态：已合并；是否已记入 memory 必须另查 provenance，不由 merge 推断。",
				`manifest: ${JSON.stringify(manifest)}`,
				source.omitted ? "正文：因容量限制未提供，不可补写。" : content,
			].join("\n");
		})
		.join("\n\n");
	return [
		`请为 ${input.date}（${input.timeZone}）生成 Raya 的跨项目日报。`,
		`来源固定在 main ${input.mainCommit}；只依据下列材料，不补写未知事实。`,
		"必须包含“今天各项目发生了什么”和“我的判断”两个二级标题。",
		material,
	].join("\n\n");
}

export function assertDailyReportBody(body: string): void {
	if (Buffer.byteLength(body, "utf8") > 16 * 1024)
		throw new Error("daily report body exceeds 16 KiB");
	const sections = new Map<string, string[]>();
	let current: string | null = null,
		fence: string | null = null;
	for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
		const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (marker) {
			if (!fence) fence = marker;
			else if (marker[0] === fence[0] && marker.length >= fence.length)
				fence = null;
			continue;
		}
		if (fence) continue;
		const heading = /^#{1,2}\s+(.+?)\s*#*\s*$/.exec(line);
		if (heading) {
			current = line.startsWith("## ") ? heading[1] : null;
			if (current) {
				if (sections.has(current))
					throw new Error("daily report has duplicate sections");
				sections.set(current, []);
			}
		} else if (current) sections.get(current)?.push(line);
	}
	for (const title of ["今天各项目发生了什么", "我的判断"]) {
		if (!sections.get(title)?.join("\n").trim())
			throw new Error(`daily report body needs nonempty ${title}`);
	}
}
