import { canonicalDigest, type FrozenPacket } from "./contract.js";

/** Index scope passages conservatively; semantic evaluation determines their obligations and accepted supersession. */
export function requirementCatalog(
	sources: FrozenPacket["sources"],
): FrozenPacket["requirements"] {
	const entries: (FrozenPacket["requirements"][number] & {
		explicit?: string;
	})[] = [];
	for (const source of sources) {
		if (!["issue", "plan", "prd", "revision"].includes(source.kind)) continue;
		let offset = 0,
			start = -1,
			end = -1;
		const points = Array.from(source.text);
		const flush = () => {
			if (start < 0) return;
			const passage = points.slice(start, end).join("");
			const explicit =
				/^(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*)?([A-Z][A-Z0-9_-]*\d+(?:\.\d+)*)(?:\*\*)?(?=[:：\s])/.exec(
					passage,
				)?.[1];
			const fallback = `${source.source_id}:${start}-${end}`;
			entries.push({
				requirement_id:
					fallback.length <= 200 ? fallback : canonicalDigest(fallback),
				source_id: source.source_id,
				quote_start: start,
				quote_end: end,
				...(explicit ? { explicit } : {}),
			});
			if (entries.length > 100) throw new Error("requirement_budget_exceeded");
			start = -1;
		};
		for (const line of source.text.split("\n")) {
			const length = Array.from(line).length;
			if (
				!line.trim() ||
				/^\s*#{1,6}\s/.test(line) ||
				/^(?:Issue|日期|基于):/.test(line)
			)
				flush();
			else {
				if (
					/^\s*(?:[-*+]\s|\d+[.)]\s|(?:\*\*)?[A-Z][A-Z0-9_-]*\d+(?:\.\d+)*(?:\*\*)?[:：\s])/.test(
						line,
					)
				)
					flush();
				if (start < 0)
					start = offset + Array.from(line.match(/^\s*/)?.[0] ?? "").length;
				end = offset + Array.from(line.trimEnd()).length;
			}
			offset += length + 1;
		}
		flush();
	}
	const counts = new Map<string, number>();
	for (const entry of entries)
		if (entry.explicit)
			counts.set(entry.explicit, (counts.get(entry.explicit) ?? 0) + 1);
	return entries.map(({ explicit, ...entry }) => ({
		...entry,
		requirement_id:
			explicit && counts.get(explicit) === 1 ? explicit : entry.requirement_id,
	}));
}
