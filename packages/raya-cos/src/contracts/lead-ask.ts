export type LeadAskInvalidReason =
	| "missing_colon"
	| "empty_name"
	| "empty_question"
	| "too_long"
	| "malformed";

export interface ParsedLeadAsk {
	leadName: string;
	question: string;
	line: string;
}

export interface InvalidLeadAsk {
	line: string;
	reason: LeadAskInvalidReason;
}

export interface ParsedLeadAskLines {
	asks: ParsedLeadAsk[];
	invalid: InvalidLeadAsk[];
	rest: string;
}

function invalidReason(line: string): LeadAskInvalidReason {
	const prefix = "【问 Lead】";
	const normalized = line.normalize("NFKC");
	if (!normalized.startsWith(prefix)) return "malformed";
	const body = normalized.slice(prefix.length);
	const colon = body.search(/[:：]/);
	if (colon < 0) return "missing_colon";
	if (!body.slice(0, colon).trim()) return "empty_name";
	if (!body.slice(colon + 1).trim()) return "empty_question";
	return "malformed";
}

export function parseLeadAskLines(text: string): ParsedLeadAskLines {
	const asks: ParsedLeadAsk[] = [];
	const invalid: InvalidLeadAsk[] = [];
	const rest: string[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		const candidate = trimmed.normalize("NFKC");
		const match = /^【问 Lead】\s*(.+?)\s*:\s*(.+)$/.exec(candidate);
		if (!match) {
			if (candidate.startsWith("【问") || candidate.startsWith("[问")) {
				invalid.push({ line, reason: invalidReason(trimmed) });
			}
			rest.push(line);
			continue;
		}
		const body = trimmed.slice(trimmed.indexOf("】") + 1);
		const colon = body.search(/[:：]/);
		const leadName = body.slice(0, colon).trim().normalize("NFKC");
		const question = body.slice(colon + 1).trim();
		if (Array.from(question).length > 800) {
			invalid.push({ line, reason: "too_long" });
			rest.push(line);
			continue;
		}
		asks.push({
			leadName,
			question,
			line,
		});
	}
	return { asks, invalid, rest: rest.join("\n") };
}
