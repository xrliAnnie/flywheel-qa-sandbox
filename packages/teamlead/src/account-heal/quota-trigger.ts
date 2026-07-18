export type CanonicalModels = readonly [string, ...string[]];

export type AccountQuotaTrigger = {
	kind: "account";
	scope: "5h" | "weekly" | "both";
	resetAt: string;
};

export type ModelQuotaTrigger = {
	kind: "model";
	models: CanonicalModels;
};

export type QuotaTrigger = AccountQuotaTrigger | ModelQuotaTrigger;

export interface PaneModelDetection {
	paneKey: string;
	model: string;
}

export function canonicalizeModels(
	models: Iterable<string>,
): CanonicalModels | null {
	const normalized = [...models]
		.map((model) => model.replace(/\s+/g, " ").trim())
		.filter(Boolean);
	const unique = [...new Set(normalized)].sort();
	return unique.length === 0 ? null : (unique as unknown as CanonicalModels);
}

/** Account quota is authoritative; otherwise aggregate one deterministic model set. */
export function aggregateQuotaTrigger(input: {
	account: AccountQuotaTrigger | null;
	modelDetections: PaneModelDetection[];
}): QuotaTrigger | null {
	if (input.account !== null) return { ...input.account };

	const byPane = new Map<string, string>();
	for (const detection of [...input.modelDetections].sort((a, b) => {
		if (a.paneKey !== b.paneKey) return a.paneKey < b.paneKey ? -1 : 1;
		if (a.model === b.model) return 0;
		return a.model < b.model ? -1 : 1;
	})) {
		if (detection.paneKey.length === 0 || byPane.has(detection.paneKey))
			continue;
		const model = canonicalizeModels([detection.model]);
		if (model !== null) byPane.set(detection.paneKey, model[0]);
	}
	const models = canonicalizeModels(byPane.values());
	return models === null ? null : { kind: "model", models };
}
