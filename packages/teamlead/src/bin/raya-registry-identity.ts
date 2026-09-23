/**
 * FLY-2654 (QA2 rework): the Raya-scoped identity projection of projects.json.
 *
 * The migration ledger used to freeze the whole-file sha256 of projects.json
 * (`registry_digest`). On 2026-09-19 an unrelated Lead model edit that only
 * changed the trailing newline made every shuttle refuse with
 * `awaiting_pre_activation_rebind`. The standing carve-out must fail closed
 * only when Raya's own project or lead identity rows change, so the ledger now
 * records this projection (`registry_identity`) and every consumer compares
 * projections semantically instead of file bytes.
 *
 * `scripts/lib/raya-registry-identity.jq` is the shell twin used by
 * `updater-raya-deploy.sh`; the vitest for this module runs jq on the same
 * fixtures and asserts both projections are equal.
 */

const TUNING_FIELDS = new Set(["model", "effort", "modelContextWindow"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type RayaRegistryIdentity = Record<string, unknown>[];

/** Project the Raya project row(s) with only the Raya lead row(s) inside. */
export function rayaRegistryIdentity(registry: unknown): RayaRegistryIdentity {
	if (!Array.isArray(registry)) return [];
	const projection: RayaRegistryIdentity = [];
	for (const project of registry) {
		if (!isRecord(project) || project.projectName !== "raya") continue;
		const leads = Array.isArray(project.leads) ? project.leads : [];
		projection.push({
			...project,
			leads: leads
				.filter((lead) => isRecord(lead) && lead.agentId === "raya")
				.map((lead) =>
					Object.fromEntries(
						Object.entries(lead as Record<string, unknown>).filter(
							([key]) => !TUNING_FIELDS.has(key),
						),
					),
				),
		});
	}
	return projection;
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (isRecord(value))
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

/** Semantic (key-order independent) equality of two projections. */
export function rayaRegistryIdentityEqual(a: unknown, b: unknown): boolean {
	return canonical(a) === canonical(b);
}

/**
 * Dotted paths whose scalar values differ between two projections, for the
 * named refusal reason. Index segments are positional within the projection.
 */
export function rayaRegistryIdentityDrift(a: unknown, b: unknown): string[] {
	const leaves = (
		value: unknown,
		prefix: string,
		into: Map<string, string>,
	) => {
		if (Array.isArray(value)) {
			value.forEach((item, index) =>
				leaves(item, prefix ? `${prefix}.${index}` : String(index), into),
			);
		} else if (isRecord(value)) {
			for (const key of Object.keys(value).sort())
				leaves(value[key], prefix ? `${prefix}.${key}` : key, into);
		} else into.set(prefix, JSON.stringify(value));
	};
	const left = new Map<string, string>();
	const right = new Map<string, string>();
	leaves(a, "", left);
	leaves(b, "", right);
	const drift = new Set<string>();
	for (const [path, value] of left)
		if (right.get(path) !== value) drift.add(path);
	for (const [path, value] of right)
		if (left.get(path) !== value) drift.add(path);
	return [...drift].sort();
}
