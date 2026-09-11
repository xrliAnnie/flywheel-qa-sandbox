export interface BetaReceiptIdentity {
	projectName: string;
	repositoryId: number;
	workflowId: number;
	runId: number;
	scheduleKey: string;
	sourceCommit: string;
}
export interface BetaReceipt extends BetaReceiptIdentity {
	schemaVersion: 1;
	outcome: "published" | "no_change" | "covered_by_newer" | "not_activated";
	publishedSourceCommit: string | null;
	publishedVersion: string | null;
	publishedAt: string | null;
}
/** Structural and identity checks; covered_by_newer additionally requires GitHub ancestry verification. */
export function validateBetaReceipt(
	value: unknown,
	expected: BetaReceiptIdentity,
): BetaReceipt {
	const invalid = (): never => {
		throw new Error("beta_receipt_invalid");
	};
	if (!value || typeof value !== "object" || Array.isArray(value))
		return invalid();
	const r = value as Record<string, unknown>;
	const keys = [
		"schemaVersion",
		"projectName",
		"repositoryId",
		"workflowId",
		"runId",
		"scheduleKey",
		"sourceCommit",
		"outcome",
		"publishedSourceCommit",
		"publishedVersion",
		"publishedAt",
	];
	if (
		Object.keys(r).length !== keys.length ||
		keys.some((k) => !Object.hasOwn(r, k)) ||
		r.schemaVersion !== 1
	)
		return invalid();
	for (const key of Object.keys(expected) as (keyof BetaReceiptIdentity)[])
		if (r[key] !== expected[key]) return invalid();
	if (
		!/^[a-f0-9]{64}$/.test(String(r.scheduleKey)) ||
		!/^[a-f0-9]{40}$/.test(String(r.sourceCommit))
	)
		return invalid();
	if (
		!["repositoryId", "workflowId", "runId"].every(
			(k) => Number.isSafeInteger(r[k]) && Number(r[k]) > 0,
		)
	)
		return invalid();
	if (r.outcome === "not_activated") {
		if (
			r.publishedSourceCommit !== null ||
			r.publishedVersion !== null ||
			r.publishedAt !== null
		)
			return invalid();
	} else {
		if (
			!["published", "no_change", "covered_by_newer"].includes(
				String(r.outcome),
			)
		)
			return invalid();
		if (
			typeof r.publishedSourceCommit !== "string" ||
			!/^[a-f0-9]{40}$/.test(r.publishedSourceCommit)
		)
			return invalid();
		if (
			r.outcome !== "covered_by_newer" &&
			r.publishedSourceCommit !== r.sourceCommit
		)
			return invalid();
		if (
			typeof r.publishedVersion !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(r.publishedVersion)
		)
			return invalid();
		if (
			typeof r.publishedAt !== "string" ||
			!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(r.publishedAt) ||
			!Number.isFinite(Date.parse(r.publishedAt))
		)
			return invalid();
	}
	return r as unknown as BetaReceipt;
}
