import { scheduledAtOrBefore } from "../bridge/patrol-tick.js";
import type {
	EpicPageFreshnessRead,
	EpicPagePublicationRead,
} from "../StateStore.js";
import type { Cell, FreshnessSection, RefreshReason } from "./model.js";
import { normalizeRefreshReasons } from "./model.js";

export interface FreshnessSourceCell {
	path: string;
	observedAt: string;
}

export interface BuildFreshnessInput {
	projectName: string;
	generatedAt: string;
	version: number;
	trigger: "manual" | "event" | "scan";
	reasons: RefreshReason[];
	history: EpicPageFreshnessRead;
	publication?: EpicPagePublicationRead;
	sourceCells: FreshnessSourceCell[];
	scanSchedule?: { leadId: string; intervalMs: number };
}

function stateCell<T>(
	input: BuildFreshnessInput,
	table: "epic_page" | "epic_page_refresh" | "epic_page_publication",
	value: T | undefined,
	options?: {
		sourceUpdatedAt?: string;
		missing?:
			| "no_prior_generation"
			| "no_prior_publication"
			| "no_prior_failure"
			| "no_publication";
	},
): Cell<T> {
	const base = {
		provenance: {
			kind: "statestore" as const,
			table,
			key: { project_name: input.projectName },
		},
		observed_at: input.generatedAt,
		...(options?.sourceUpdatedAt
			? { source_updated_at: options.sourceUpdatedAt }
			: {}),
	};
	return value === undefined
		? {
				...base,
				value: null,
				missing: { reason: options?.missing ?? "no_prior_failure" },
			}
		: { ...base, value };
}

export function buildFreshness(input: BuildFreshnessInput): FreshnessSection {
	const current = stateCell(
		input,
		"epic_page",
		{
			version: input.version,
			trigger: input.trigger,
			reasons: normalizeRefreshReasons(input.reasons),
		},
		{ sourceUpdatedAt: input.generatedAt },
	);
	if (current.provenance.kind !== "statestore") {
		throw new Error("Epic freshness current provenance invariant failed");
	}
	current.provenance.key.version = String(input.version);
	const lastGenerated = stateCell(
		input,
		"epic_page_refresh",
		input.history.last_generated
			? {
					version: input.history.last_generated.version,
					trigger: input.history.last_generated.trigger,
				}
			: undefined,
		{
			sourceUpdatedAt: input.history.last_generated?.attempted_at,
			missing: "no_prior_generation",
		},
	);
	const lastPublished = stateCell(
		input,
		"epic_page_refresh",
		input.history.last_published
			? {
					version: input.history.last_published.version,
					trigger: input.history.last_published.trigger,
				}
			: undefined,
		{
			sourceUpdatedAt: input.history.last_published?.attempted_at,
			missing: "no_prior_publication",
		},
	);
	const publishFailures = stateCell(input, "epic_page_refresh", {
		count: input.history.publish_failures_since_last_published,
	});
	const lastFailure = stateCell(
		input,
		"epic_page_refresh",
		input.history.last_failure
			? { token: input.history.last_failure.token }
			: undefined,
		{
			sourceUpdatedAt: input.history.last_failure?.attempted_at,
			missing: "no_prior_failure",
		},
	);
	const lastPublishFailure = stateCell(
		input,
		"epic_page_refresh",
		input.history.last_publish_failure
			? { token: input.history.last_publish_failure.token }
			: undefined,
		{
			sourceUpdatedAt: input.history.last_publish_failure?.attempted_at,
			missing: "no_prior_failure",
		},
	);
	const hosted = stateCell(
		input,
		"epic_page_publication",
		input.publication
			? {
					token8: input.publication.token.slice(0, 8),
					published: input.publication.published,
					last_version: input.publication.last_version ?? null,
				}
			: undefined,
		{
			sourceUpdatedAt: input.publication?.last_published_at,
			missing: "no_publication",
		},
	);

	const freshnessSources: FreshnessSourceCell[] = [
		{ path: "/freshness/current", observedAt: current.observed_at },
		{
			path: "/freshness/last_generated",
			observedAt: lastGenerated.observed_at,
		},
		{
			path: "/freshness/last_published",
			observedAt: lastPublished.observed_at,
		},
		{
			path: "/freshness/publish_failures",
			observedAt: publishFailures.observed_at,
		},
		{ path: "/freshness/last_failure", observedAt: lastFailure.observed_at },
		{
			path: "/freshness/last_publish_failure",
			observedAt: lastPublishFailure.observed_at,
		},
		{ path: "/freshness/hosted", observedAt: hosted.observed_at },
	];
	const allSources = [...input.sourceCells, ...freshnessSources].sort(
		(left, right) =>
			left.observedAt.localeCompare(right.observedAt) ||
			left.path.localeCompare(right.path),
	);
	const oldestPath = allSources[0]?.path ?? "/freshness/current";
	const from = [...new Set(allSources.map(({ path }) => path))].sort();
	const oldestSource: FreshnessSection["oldest_source"] = {
		value: { path: oldestPath },
		provenance: { kind: "derived", rule: "freshness.v1", from },
		observed_at: input.generatedAt,
	};
	const nextScan: FreshnessSection["next_scan"] = input.scanSchedule
		? {
				value: {
					expected_in_seconds: Math.ceil(
						(scheduledAtOrBefore(
							Date.parse(input.generatedAt),
							input.scanSchedule.leadId,
							input.scanSchedule.intervalMs,
						) +
							input.scanSchedule.intervalMs -
							Date.parse(input.generatedAt)) /
							1_000,
					),
				},
				provenance: {
					kind: "derived",
					rule: "freshness.v1",
					from: ["/freshness/current"],
				},
				observed_at: input.generatedAt,
			}
		: {
				value: null,
				provenance: {
					kind: "derived",
					rule: "freshness.v1",
					from: ["/freshness/current"],
				},
				observed_at: input.generatedAt,
				missing: { reason: "no_scan_schedule" },
			};

	return {
		current,
		last_generated: lastGenerated,
		last_published: lastPublished,
		publish_failures: publishFailures,
		last_failure: lastFailure,
		last_publish_failure: lastPublishFailure,
		hosted,
		oldest_source: oldestSource,
		next_scan: nextScan,
	};
}
