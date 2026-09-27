import type { Database } from "better-sqlite3";
import type { WorkflowRunEventRow } from "./StateStore.js";
import {
	readScorecardAssignment,
	readScorecardDegradation,
	readScorecardQuotaFallback,
} from "./workflow-model-assignment.js";

export interface WorkflowScorecardReportOptions {
	project: string;
	from: string;
	to: string;
	asOf: string;
	issue?: string;
	qa?: "all" | "eligible";
	detailLimit?: number;
	detailOffset?: number;
	poolCapacity?: WorkflowScorecardPoolCapacityConfig;
}

export interface WorkflowScorecardPoolCapacityConfig {
	schemaVersion: 1;
	unit: "provider_total_tokens_v1";
	providers: Record<
		string,
		{
			weeklyTokensPerCapacityUnit: number;
			accounts: Array<{ slot: string; capacityUnits: number }>;
		}
	>;
}

export type ReviewCoverage = "complete" | "incomplete" | "unverified" | "none";

/** FLY-2891: one raw reviewer verdict on the author's artifact. */
export interface NormalizedRound {
	at: string;
	rawVerdict: "APPROVED" | "CHANGES_REQUESTED";
	seriesKey: string;
	ordinal: number;
}

/** One adapter unit whose completeness can be reconciled on its own. */
export interface ReviewRoundGroup {
	rounds: NormalizedRound[];
	/** Rounds the source says exist; null = cannot say (→ unverified). */
	expectedTotal: number | null;
	/** A known hole in the source (→ incomplete). */
	gap?: boolean;
}

export interface ReviewMetric {
	firstPass: boolean | null;
	roundsToApproval: number | null;
	coverage: ReviewCoverage;
}

export interface WorkflowScorecardReviewReport extends ReviewMetric {
	reviewerModels: string[];
	source: "bridge_job" | "local_round" | "mixed" | "none";
	timeBasisFallback: number;
}

export interface WorkflowScorecardReviewGroupMetrics {
	firstPass: { numerator: number; denominator: number; rate: number | null };
	roundsMean: number | null;
	coverage: Record<ReviewCoverage, number>;
	timeBasisFallback: number;
}

export interface WorkflowScorecardIssueReport {
	issueId: string;
	canonicalIssueId: string;
	runIds: string[];
	qaFirstPass: boolean | null;
	qaExempt: boolean;
	founderRejectCount: number | null;
	founderReviewed: boolean;
	terminal: boolean;
	totalTokens: number | null;
	nodeWorkMs: number | null;
	elapsedMs: number | null;
	degraded: boolean;
	groups: Record<"design" | "implement" | "qa", string>;
	groupPolicies: Record<"design" | "implement" | "qa", string | null>;
	originalGroups: Record<"design" | "implement" | "qa", string>;
	originalGroupPolicies: Record<"design" | "implement" | "qa", string | null>;
	nodes: Array<{
		activationId: string;
		executionId: string;
		runId: string;
		nodeId: string;
		axis: string;
		assignmentState: string;
		policyVersion: string | null;
		arm: string | null;
		assignedModel: string | null;
		launchModel: string | null;
		observedModels: string[];
		vendors: string[];
		vendorMix: Array<{ vendor: string; model: string; tokens: number }>;
		degraded: boolean;
		degradationReason: string | null;
		tokens: number | null;
		durationMs: number | null;
	}>;
	/** FLY-2891: design/code review first pass + rounds, both review lines. */
	designReview: WorkflowScorecardReviewReport;
	codeReview: WorkflowScorecardReviewReport;
}

export interface WorkflowScorecardGroupReport {
	axis: "design" | "implement" | "qa" | "all";
	group: string;
	policyVersion: string | null;
	unit: "provider_total_tokens_v1";
	issueCount: number;
	terminalCount: number;
	openCount: number;
	assignedIssueCountBeforeExclusions: number;
	degradedFromThisArm: number;
	degradedFromThisArmRate: number | null;
	assignmentNotHonoredFromThisArm: number;
	unknownEvidenceFromThisArm: number;
	qaFirstPass: { numerator: number; denominator: number; rate: number | null };
	founderReject: {
		numerator: number;
		denominator: number;
		rate: number | null;
	};
	tokensPerFirstPassIssue: number | null;
	meanTokensOfFirstPassIssues: number | null;
	meanNodeWorkMs: number | null;
	meanElapsedMs: number | null;
	usageCoverage: { complete: number; terminal: number };
	timeCoverage: {
		nodeWorkComplete: number;
		elapsedComplete: number;
		terminal: number;
	};
	completeSubsetEstimate: {
		tokensPerFirstPassIssue: number | null;
		meanNodeWorkMs: number | null;
		meanElapsedMs: number | null;
	};
	vendorMix: Array<{ vendor: string; model: string; tokens: number }>;
	crossVendorUnitIncomparable: boolean;
	designReviewFirstPass: WorkflowScorecardReviewGroupMetrics["firstPass"];
	designReviewRoundsMean: number | null;
	designReviewCoverage: Record<ReviewCoverage, number>;
	designReviewTimeBasisFallback: number;
	codeReviewFirstPass: WorkflowScorecardReviewGroupMetrics["firstPass"];
	codeReviewRoundsMean: number | null;
	codeReviewCoverage: Record<ReviewCoverage, number>;
	codeReviewTimeBasisFallback: number;
}

export interface WorkflowScorecardReport {
	schemaVersion: 1;
	metricVersion: 1;
	status: "ok";
	unit: "provider_total_tokens_v1";
	cohortPolicy: "first_admission_in_window";
	qaFilter: "all" | "eligible";
	project: string;
	from: string;
	to: string;
	asOf: string;
	issueCount: number;
	degradedCount: number;
	crossVendorUnitIncomparable: boolean;
	providerConsumption: Array<{
		vendor: string;
		tokens: number;
		accountCount: number | null;
		capacityUnits: number | null;
		weeklyPoolCapacity: number | null;
		weeklyPoolUsedPercent: number | null;
		coverageComplete: boolean;
	}>;
	detailPage: { offset: number; limit: number; returned: number };
	issues: WorkflowScorecardIssueReport[];
	groups: WorkflowScorecardGroupReport[];
	/** FLY-2891: undelivered review-round records (filled by the CLI). */
	reviewRoundSpool?: { pending: number; quarantined: number };
}

type Row = Record<string, unknown>;

/** SQLite `datetime('now')` is UTC without a zone; never read it as local. */
function parseDbTime(value: unknown): number {
	if (typeof value !== "string") return Number.NaN;
	return Date.parse(
		/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)
			? `${value.replace(" ", "T")}Z`
			: value,
	);
}

/**
 * FLY-2891: one shared definition for both review lines. A round is a raw
 * reviewer verdict. Completeness must be provable (contiguous ordinals per
 * series AND the source's expected total met) or the metric is unknown —
 * missing data never counts as a pass.
 */
export function normalizeReviewRounds(
	groups: readonly ReviewRoundGroup[],
): ReviewMetric {
	const all = groups.flatMap((group) => group.rounds);
	if (
		all.length === 0 &&
		!groups.some((group) => group.gap || (group.expectedTotal ?? 0) > 0)
	)
		return { firstPass: null, roundsToApproval: null, coverage: "none" };
	let incomplete = false;
	let unverified = false;
	for (const group of groups) {
		if (group.gap) incomplete = true;
		const bySeries = new Map<string, number[]>();
		for (const round of group.rounds)
			bySeries.set(round.seriesKey, [
				...(bySeries.get(round.seriesKey) ?? []),
				round.ordinal,
			]);
		for (const ordinals of bySeries.values()) {
			ordinals.sort((left, right) => left - right);
			if (ordinals.some((ordinal, index) => ordinal !== index + 1))
				incomplete = true;
		}
		if (group.expectedTotal === null) unverified = true;
		else if (group.expectedTotal !== group.rounds.length) incomplete = true;
	}
	if (incomplete)
		return { firstPass: null, roundsToApproval: null, coverage: "incomplete" };
	if (unverified)
		return { firstPass: null, roundsToApproval: null, coverage: "unverified" };
	const ordered = [...all].sort(
		(left, right) =>
			Date.parse(left.at) - Date.parse(right.at) ||
			left.seriesKey.localeCompare(right.seriesKey) ||
			left.ordinal - right.ordinal,
	);
	const approvedAt = ordered.findIndex(
		(round) => round.rawVerdict === "APPROVED",
	);
	return {
		firstPass: ordered[0]!.rawVerdict === "APPROVED",
		roundsToApproval: approvedAt < 0 ? null : approvedAt + 1,
		coverage: "complete",
	};
}

type LocalRoundRow = {
	execution_id: string;
	review_type: string;
	codex_thread_id: string;
	codex_turn_id: string;
	round: number;
	verdict: string;
	observed_model: string | null;
	/** Server-derived at ingest: 1/0 when a requirement and evidence existed. */
	model_match?: number | null;
	required_model?: string | null;
	reviewed_at: string;
};
type GateAcceptanceRow = {
	execution_id: string;
	review_type: string;
	codex_thread_id: string;
	codex_turn_id: string;
	final_round: number;
	rounds_total: number;
	accepted_at: string;
};

/**
 * Claude-author local rounds. Expected total = the earliest gate acceptance's
 * rounds_total; rounds after the accepted turn are not counted; without an
 * acceptance the rounds are unverified. Rounds that ran on a model other than
 * the required reviewer (model_match=0 — the FLY-2830 pattern) are not review
 * rounds: they are dropped and subtracted from rounds_total on both sides. A
 * round with no model evidence under a requirement makes the unit unverified.
 */
export function localReviewGroups(
	rounds: readonly LocalRoundRow[],
	acceptances: readonly GateAcceptanceRow[],
	asOf: string,
): { groups: ReviewRoundGroup[]; reviewerModels: Set<string> } {
	const asOfMs = Date.parse(asOf);
	const key = (row: { execution_id: string; review_type: string }) =>
		`${row.execution_id}|${row.review_type}`;
	const roundsByKey = new Map<string, LocalRoundRow[]>();
	const reviewerModels = new Set<string>();
	for (const round of rounds) {
		if (!(parseDbTime(round.reviewed_at) < asOfMs)) continue;
		roundsByKey.set(key(round), [
			...(roundsByKey.get(key(round)) ?? []),
			round,
		]);
	}
	const acceptedByKey = new Map<string, GateAcceptanceRow>();
	for (const accepted of acceptances) {
		if (!(parseDbTime(accepted.accepted_at) < asOfMs)) continue;
		const current = acceptedByKey.get(key(accepted));
		if (
			!current ||
			parseDbTime(accepted.accepted_at) < parseDbTime(current.accepted_at)
		)
			acceptedByKey.set(key(accepted), accepted);
	}
	const groups: ReviewRoundGroup[] = [];
	const settle = (
		rows: readonly LocalRoundRow[],
		declaredTotal: number | null,
		knownGap = false,
	): void => {
		const byThread = new Map<string, LocalRoundRow[]>();
		for (const row of rows)
			byThread.set(row.codex_thread_id, [
				...(byThread.get(row.codex_thread_id) ?? []),
				row,
			]);
		let gap = knownGap;
		const counted: NormalizedRound[] = [];
		for (const [thread, threadRows] of byThread) {
			threadRows.sort(
				(left, right) => Number(left.round) - Number(right.round),
			);
			// Contiguity is judged on everything recorded: a missing round is a
			// hole even when its neighbours are later excluded as off-model.
			if (threadRows.some((row, index) => Number(row.round) !== index + 1))
				gap = true;
			let ordinal = 0;
			for (const row of threadRows) {
				if (row.model_match === 0) continue;
				if (row.verdict !== "APPROVED" && row.verdict !== "CHANGES_REQUESTED")
					continue;
				ordinal += 1;
				counted.push({
					at: new Date(parseDbTime(row.reviewed_at)).toISOString(),
					rawVerdict: row.verdict,
					seriesKey: `${key(row)}|${thread}`,
					ordinal,
				});
				if (row.observed_model) reviewerModels.add(row.observed_model);
			}
		}
		const offModel = rows.filter((row) => row.model_match === 0).length;
		// More excluded rounds than the runner declared is a contradiction.
		if (declaredTotal !== null && offModel > declaredTotal) gap = true;
		const unproven = rows.some(
			(row) => row.model_match == null && !!row.required_model,
		);
		groups.push({
			rounds: counted,
			expectedTotal:
				declaredTotal === null || unproven ? null : declaredTotal - offModel,
			...(gap ? { gap: true } : {}),
		});
	};
	for (const groupKey of new Set([
		...roundsByKey.keys(),
		...acceptedByKey.keys(),
	])) {
		const rows = roundsByKey.get(groupKey) ?? [];
		const accepted = acceptedByKey.get(groupKey);
		if (!accepted) {
			if (rows.length > 0) settle(rows, null);
			continue;
		}
		const acceptedRound = rows.find(
			(row) =>
				row.codex_thread_id === accepted.codex_thread_id &&
				row.codex_turn_id === accepted.codex_turn_id &&
				row.verdict === "APPROVED" &&
				// An off-model turn is not a review round, so it cannot be the
				// accepted one; the unit is then a coverage gap.
				row.model_match !== 0 &&
				Number(row.round) === Number(accepted.final_round),
		);
		if (!acceptedRound) {
			settle(rows, Number(accepted.rounds_total), true);
			continue;
		}
		const cut = parseDbTime(acceptedRound.reviewed_at);
		settle(
			rows.filter((row) => parseDbTime(row.reviewed_at) <= cut),
			Number(accepted.rounds_total),
		);
	}
	return { groups, reviewerModels };
}

type ReviewJobRow = {
	request_id: string;
	execution_id: string;
	review_type: string;
	target_repo_identity: string | null;
	status: string;
	reviewer_verdict: string | null;
	created_at: string;
	updated_at: string | null;
	completed_at?: string | null;
};

/**
 * Bridge-run review jobs (the Astra line). Every done job is a round, keyed by
 * the stable completion time (historical rows fall back to updated_at and are
 * counted); a done job without a raw reviewer verdict is a coverage gap.
 * Failed/skipped/pending jobs and reuse copies are not rounds.
 */
export function jobReviewGroups(
	jobs: readonly ReviewJobRow[],
	reuseCopies: ReadonlySet<string>,
	asOf: string,
): {
	groups: ReviewRoundGroup[];
	timeBasisFallback: number;
	/** The done jobs that entered the metric (reviewer models come from these). */
	countedRequestIds: Set<string>;
} {
	const asOfMs = Date.parse(asOf);
	let timeBasisFallback = 0;
	const countedRequestIds = new Set<string>();
	const series = new Map<string, Array<ReviewJobRow & { at: number }>>();
	for (const row of jobs) {
		if (row.status !== "done" || reuseCopies.has(row.request_id)) continue;
		const fallback = !row.completed_at;
		const at = parseDbTime(
			row.completed_at || row.updated_at || row.created_at,
		);
		if (!(at < asOfMs)) continue;
		if (fallback) timeBasisFallback += 1;
		countedRequestIds.add(row.request_id);
		const seriesKey = `${row.execution_id}|${row.review_type}|${row.target_repo_identity ?? "__main__"}`;
		series.set(seriesKey, [...(series.get(seriesKey) ?? []), { ...row, at }]);
	}
	const groups: ReviewRoundGroup[] = [];
	for (const [seriesKey, rows] of series) {
		rows.sort(
			(left, right) =>
				parseDbTime(left.created_at) - parseDbTime(right.created_at) ||
				left.request_id.localeCompare(right.request_id),
		);
		let gap = false;
		const rounds: NormalizedRound[] = [];
		rows.forEach((row, index) => {
			if (
				row.reviewer_verdict !== "APPROVED" &&
				row.reviewer_verdict !== "CHANGES_REQUESTED"
			) {
				gap = true;
				return;
			}
			rounds.push({
				at: new Date(row.at).toISOString(),
				rawVerdict: row.reviewer_verdict,
				seriesKey,
				ordinal: index + 1,
			});
		});
		groups.push({ rounds, expectedTotal: rows.length, gap });
	}
	return { groups, timeBasisFallback, countedRequestIds };
}

function readIssueReviewMetrics(
	db: Database,
	executionIds: readonly string[],
	eventRows: readonly WorkflowRunEventRow[],
	asOf: string,
): Record<"design" | "code", WorkflowScorecardReviewReport> {
	const placeholders = executionIds.map(() => "?").join(",") || "NULL";
	const localRounds = tableExists(db, "review_round_record")
		? (rows(
				db,
				`SELECT * FROM review_round_record WHERE execution_id IN (${placeholders})`,
				...executionIds,
			) as unknown as LocalRoundRow[])
		: [];
	const acceptances = tableExists(db, "review_gate_acceptance")
		? (rows(
				db,
				`SELECT * FROM review_gate_acceptance WHERE execution_id IN (${placeholders})`,
				...executionIds,
			) as unknown as GateAcceptanceRow[])
		: [];
	const jobs = tableExists(db, "codex_review_job")
		? (rows(
				db,
				`SELECT * FROM codex_review_job WHERE execution_id IN (${placeholders})`,
				...executionIds,
			) as unknown as ReviewJobRow[])
		: [];
	const reuseCopies = new Set<string>(
		jobs.length > 0 && tableExists(db, "codex_review_reuse_binding")
			? rows(
					db,
					`SELECT request_id FROM codex_review_reuse_binding
					  WHERE request_id IN (${jobs.map(() => "?").join(",")})`,
					...jobs.map((job) => job.request_id),
				).map((row) => String(row.request_id))
			: [],
	);
	const routedModels = new Map<string, string>();
	for (const event of eventRows) {
		if (event.kind !== "review_model_routed") continue;
		const payload = event.payload as Record<string, unknown> | undefined;
		if (
			typeof payload?.requestId === "string" &&
			typeof payload.reviewerModel === "string"
		)
			routedModels.set(payload.requestId, payload.reviewerModel);
	}
	const result = {} as Record<"design" | "code", WorkflowScorecardReviewReport>;
	for (const reviewType of ["design", "code"] as const) {
		const local = localReviewGroups(
			localRounds.filter((row) => row.review_type === reviewType),
			acceptances.filter((row) => row.review_type === reviewType),
			asOf,
		);
		const typeJobs = jobs.filter((row) => row.review_type === reviewType);
		const bridge = jobReviewGroups(typeJobs, reuseCopies, asOf);
		const models = new Set(local.reviewerModels);
		for (const requestId of bridge.countedRequestIds) {
			const model = routedModels.get(requestId);
			if (model) models.add(model);
		}
		result[reviewType] = {
			...normalizeReviewRounds([...local.groups, ...bridge.groups]),
			reviewerModels: [...models].sort(),
			source:
				local.groups.length > 0 && bridge.groups.length > 0
					? "mixed"
					: local.groups.length > 0
						? "local_round"
						: bridge.groups.length > 0
							? "bridge_job"
							: "none",
			timeBasisFallback: bridge.timeBasisFallback,
		};
	}
	return result;
}

function reviewGroupMetrics(
	issues: readonly WorkflowScorecardIssueReport[],
	key: "designReview" | "codeReview",
): WorkflowScorecardReviewGroupMetrics {
	const known = issues.filter((issue) => issue[key].firstPass !== null);
	const passed = known.filter((issue) => issue[key].firstPass === true).length;
	const coverage: Record<ReviewCoverage, number> = {
		complete: 0,
		incomplete: 0,
		unverified: 0,
		none: 0,
	};
	for (const issue of issues) coverage[issue[key].coverage] += 1;
	return {
		firstPass: {
			numerator: passed,
			denominator: known.length,
			rate: rate(passed, known.length),
		},
		roundsMean: mean(
			issues.flatMap((issue) =>
				issue[key].roundsToApproval === null
					? []
					: [issue[key].roundsToApproval],
			),
		),
		coverage,
		timeBasisFallback: issues.reduce(
			(sum, issue) => sum + issue[key].timeBasisFallback,
			0,
		),
	};
}

function rows(db: Database, sql: string, ...params: unknown[]): Row[] {
	return db.prepare(sql).all(...params) as Row[];
}

function rate(numerator: number, denominator: number): number | null {
	return denominator === 0 ? null : numerator / denominator;
}

function mean(values: number[]): number | null {
	return values.length === 0
		? null
		: values.reduce((sum, value) => sum + value, 0) / values.length;
}

function event(row: Row): WorkflowRunEventRow {
	return {
		run_id: String(row.run_id),
		seq: Number(row.seq),
		event_uid: String(row.event_uid),
		kind: String(row.kind),
		node_id: row.node_id == null ? null : String(row.node_id),
		edge_id: row.edge_id == null ? null : String(row.edge_id),
		execution_id: row.execution_id == null ? null : String(row.execution_id),
		payload:
			row.payload == null
				? undefined
				: typeof row.payload === "string"
					? JSON.parse(row.payload)
					: row.payload,
		at: String(row.at),
	};
}

function groupReport(
	axis: WorkflowScorecardGroupReport["axis"],
	group: string,
	policyVersion: string | null,
	issues: WorkflowScorecardIssueReport[],
	before: WorkflowScorecardIssueReport[],
): WorkflowScorecardGroupReport {
	const qaKnown = issues.filter((issue) => issue.qaFirstPass !== null);
	const founderKnown = issues.filter(
		(issue) => issue.founderReviewed && issue.founderRejectCount !== null,
	);
	const founderRejects = founderKnown.filter(
		(issue) => (issue.founderRejectCount ?? 0) > 0,
	).length;
	const terminal = issues.filter((issue) => issue.terminal);
	const completeUsage = terminal.filter((issue) => issue.totalTokens !== null);
	const firstPass = completeUsage.filter((issue) => issue.qaFirstPass === true);
	const nodeWorkComplete = terminal.flatMap((issue) =>
		issue.nodeWorkMs === null ? [] : [issue.nodeWorkMs],
	);
	const elapsedComplete = terminal.flatMap((issue) =>
		issue.elapsedMs === null ? [] : [issue.elapsedMs],
	);
	const mainMetricComplete =
		completeUsage.length === terminal.length &&
		terminal.every((issue) => issue.qaFirstPass !== null || issue.qaExempt);
	const numerator = completeUsage.reduce(
		(sum, issue) => sum + (issue.totalTokens ?? 0),
		0,
	);
	const vendorTotals = new Map<string, number>();
	for (const issue of issues)
		for (const node of issue.nodes)
			for (const entry of node.vendorMix) {
				const key = `${entry.vendor}\0${entry.model}`;
				vendorTotals.set(key, (vendorTotals.get(key) ?? 0) + entry.tokens);
			}
	const vendorMix = [...vendorTotals]
		.map(([key, tokens]) => {
			const [vendor, model] = key.split("\0");
			return { vendor: vendor!, model: model!, tokens };
		})
		.sort((left, right) =>
			`${left.vendor}/${left.model}`.localeCompare(
				`${right.vendor}/${right.model}`,
			),
		);
	return {
		axis,
		group,
		policyVersion,
		unit: "provider_total_tokens_v1",
		issueCount: issues.length,
		terminalCount: terminal.length,
		openCount: issues.length - terminal.length,
		assignedIssueCountBeforeExclusions: before.length,
		degradedFromThisArm: before.filter((issue) => issue.degraded).length,
		degradedFromThisArmRate: rate(
			before.filter((issue) => issue.degraded).length,
			before.length,
		),
		assignmentNotHonoredFromThisArm: before.filter((issue) =>
			Object.values(issue.groups).includes("assignment_not_honored"),
		).length,
		unknownEvidenceFromThisArm: before.filter((issue) =>
			Object.values(issue.groups).includes("unknown"),
		).length,
		qaFirstPass: {
			numerator: qaKnown.filter((issue) => issue.qaFirstPass).length,
			denominator: qaKnown.length,
			rate: rate(
				qaKnown.filter((issue) => issue.qaFirstPass).length,
				qaKnown.length,
			),
		},
		founderReject: {
			numerator: founderRejects,
			denominator: founderKnown.length,
			rate: rate(founderRejects, founderKnown.length),
		},
		tokensPerFirstPassIssue:
			mainMetricComplete && firstPass.length > 0
				? numerator / firstPass.length
				: null,
		meanTokensOfFirstPassIssues:
			firstPass.length === 0
				? null
				: firstPass.reduce((sum, issue) => sum + (issue.totalTokens ?? 0), 0) /
					firstPass.length,
		meanNodeWorkMs:
			nodeWorkComplete.length === terminal.length
				? mean(nodeWorkComplete)
				: null,
		meanElapsedMs:
			elapsedComplete.length === terminal.length ? mean(elapsedComplete) : null,
		usageCoverage: {
			complete: completeUsage.length,
			terminal: terminal.length,
		},
		timeCoverage: {
			nodeWorkComplete: nodeWorkComplete.length,
			elapsedComplete: elapsedComplete.length,
			terminal: terminal.length,
		},
		completeSubsetEstimate: {
			tokensPerFirstPassIssue:
				firstPass.length > 0 ? numerator / firstPass.length : null,
			meanNodeWorkMs: mean(nodeWorkComplete),
			meanElapsedMs: mean(elapsedComplete),
		},
		vendorMix,
		crossVendorUnitIncomparable:
			new Set(vendorMix.map((entry) => entry.vendor)).size > 1,
		...(() => {
			const design = reviewGroupMetrics(issues, "designReview");
			const code = reviewGroupMetrics(issues, "codeReview");
			return {
				designReviewFirstPass: design.firstPass,
				designReviewRoundsMean: design.roundsMean,
				designReviewCoverage: design.coverage,
				designReviewTimeBasisFallback: design.timeBasisFallback,
				codeReviewFirstPass: code.firstPass,
				codeReviewRoundsMean: code.roundsMean,
				codeReviewCoverage: code.coverage,
				codeReviewTimeBasisFallback: code.timeBasisFallback,
			};
		})(),
	};
}

export function parseWorkflowScorecardPoolCapacityConfig(
	value: unknown,
): WorkflowScorecardPoolCapacityConfig {
	const record = (input: unknown): input is Record<string, unknown> =>
		typeof input === "object" && input !== null && !Array.isArray(input);
	if (
		!record(value) ||
		value.schemaVersion !== 1 ||
		value.unit !== "provider_total_tokens_v1" ||
		!record(value.providers)
	)
		throw new Error("invalid_pool_capacity_config");
	for (const [vendor, provider] of Object.entries(value.providers)) {
		if (
			!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(vendor) ||
			!record(provider) ||
			typeof provider.weeklyTokensPerCapacityUnit !== "number" ||
			!Number.isFinite(provider.weeklyTokensPerCapacityUnit) ||
			provider.weeklyTokensPerCapacityUnit <= 0 ||
			!Array.isArray(provider.accounts) ||
			provider.accounts.length === 0
		)
			throw new Error("invalid_pool_capacity_config");
		const slots = new Set<string>();
		for (const account of provider.accounts) {
			if (
				!record(account) ||
				typeof account.slot !== "string" ||
				!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(account.slot) ||
				slots.has(account.slot) ||
				typeof account.capacityUnits !== "number" ||
				!Number.isFinite(account.capacityUnits) ||
				account.capacityUnits <= 0
			)
				throw new Error("invalid_pool_capacity_config");
			slots.add(account.slot);
		}
	}
	return value as unknown as WorkflowScorecardPoolCapacityConfig;
}

function tableExists(db: Database, table: string): boolean {
	return !!db
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get(table);
}

function issueCohorts(
	db: Database,
	options: Pick<
		WorkflowScorecardReportOptions,
		"project" | "from" | "to" | "issue"
	>,
): Array<{
	canonicalIssueId: string;
	issueId: string;
	runs: Row[];
}> {
	const runRows = rows(
		db,
		`SELECT run.run_id, run.issue_id, run.status,
		        MIN(binding.bound_at) AS first_admission
		   FROM workflow_run run
		   LEFT JOIN workflow_execution_binding binding ON binding.run_id = run.run_id
		  WHERE run.project_name = ?
		  GROUP BY run.run_id
		  ORDER BY first_admission, run.run_id`,
		options.project,
	);
	const aliases = rows(
		db,
		`SELECT alias.run_id, alias.issue_alias
		   FROM workflow_run_issue_alias alias
		   JOIN workflow_run run ON run.run_id = alias.run_id
		  WHERE run.project_name = ?`,
		options.project,
	);
	const parent = new Map(
		runRows.map((run) => [String(run.run_id), String(run.run_id)]),
	);
	const find = (runId: string): string => {
		const root = parent.get(runId)!;
		if (root === runId) return root;
		const canonical = find(root);
		parent.set(runId, canonical);
		return canonical;
	};
	const union = (left: string, right: string): void => {
		const leftRoot = find(left);
		const rightRoot = find(right);
		if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
	};
	const aliasOwner = new Map<string, string>();
	for (const run of runRows) {
		const runId = String(run.run_id);
		aliasOwner.set(
			String(run.issue_id),
			aliasOwner.get(String(run.issue_id)) ?? runId,
		);
		union(runId, aliasOwner.get(String(run.issue_id))!);
	}
	for (const alias of aliases) {
		const runId = String(alias.run_id);
		const issueAlias = String(alias.issue_alias);
		const owner = aliasOwner.get(issueAlias);
		if (owner) union(runId, owner);
		else aliasOwner.set(issueAlias, runId);
	}
	const aliasesByRun = new Map<string, Set<string>>();
	for (const run of runRows)
		aliasesByRun.set(String(run.run_id), new Set([String(run.issue_id)]));
	for (const alias of aliases)
		aliasesByRun.get(String(alias.run_id))?.add(String(alias.issue_alias));
	const grouped = new Map<string, Row[]>();
	for (const run of runRows) {
		const root = find(String(run.run_id));
		grouped.set(root, [...(grouped.get(root) ?? []), run]);
	}
	return [...grouped.values()]
		.map((runs) => {
			const issueAliases = new Set(
				runs.flatMap((run) => [
					...(aliasesByRun.get(String(run.run_id)) ?? []),
				]),
			);
			const sortedAliases = [...issueAliases].sort();
			const canonicalIssueId =
				sortedAliases.find((alias) =>
					/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
						alias,
					),
				) ?? sortedAliases[0]!;
			const issueId =
				sortedAliases.find((alias) =>
					/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(alias),
				) ?? canonicalIssueId;
			const firstAdmission = Math.min(
				...runs.flatMap((run) => {
					const parsed = Date.parse(String(run.first_admission));
					return Number.isFinite(parsed) ? [parsed] : [];
				}),
			);
			return { canonicalIssueId, issueId, issueAliases, firstAdmission, runs };
		})
		.filter(
			(cohort) =>
				cohort.firstAdmission >= Date.parse(options.from) &&
				cohort.firstAdmission < Date.parse(options.to) &&
				(!options.issue || cohort.issueAliases.has(options.issue)),
		)
		.sort(
			(left, right) =>
				left.firstAdmission - right.firstAdmission ||
				left.canonicalIssueId.localeCompare(right.canonicalIssueId),
		);
}

export function readWorkflowScorecardReport(
	db: Database,
	options: WorkflowScorecardReportOptions,
): WorkflowScorecardReport {
	const issues: WorkflowScorecardIssueReport[] = [];
	for (const cohort of issueCohorts(db, options)) {
		const { canonicalIssueId, issueId, runs: runRows } = cohort;
		const terminal =
			runRows.length > 0 &&
			runRows.every((row) =>
				["completed", "terminated", "canceled", "cancelled"].includes(
					String(row.status),
				),
			);
		const runIds = runRows.map((row) => String(row.run_id));
		const placeholders = runIds.map(() => "?").join(",");
		const activations = rows(
			db,
			`SELECT binding.activation_id, binding.execution_id, binding.run_id,
			        binding.node_id, binding.attempt,
			        activation.axis,
			        COALESCE(activation.assignment_state, 'accounting_unavailable') AS assignment_state,
			        activation.policy_version, activation.arm_id,
			        activation.assignment_event_uid, activation.assignment_digest,
			        COALESCE(activation.admitted_at, binding.bound_at) AS admitted_at,
			        activation.closed_at, activation.close_event_uid, activation.close_kind,
			        CASE WHEN activation.activation_id IS NULL THEN 0 ELSE 1 END AS accounting_available,
			        runtime.model AS launch_model
			   FROM workflow_execution_binding binding
			   LEFT JOIN workflow_scorecard_activation activation
			     ON activation.activation_id = binding.activation_id
			   LEFT JOIN workflow_execution_runtime runtime
			     ON runtime.execution_id = binding.execution_id
			  WHERE binding.run_id IN (${placeholders}) AND binding.bound_at <= ?
			  ORDER BY binding.bound_at, binding.activation_id`,
			...runIds,
			options.asOf,
		);
		const hotEvents = rows(
			db,
			`SELECT * FROM workflow_run_event
			  WHERE run_id IN (${placeholders}) AND at <= ? ORDER BY run_id, seq`,
			...runIds,
			options.asOf,
		).map(event);
		const archivedEvents = tableExists(db, "workflow_terminal_archive")
			? rows(
					db,
					`SELECT row_json FROM workflow_terminal_archive
					  WHERE source_table = 'workflow_run_event'
					    AND json_extract(row_json, '$.run_id') IN (${placeholders})
					    AND json_extract(row_json, '$.at') <= ?`,
					...runIds,
					options.asOf,
				).map((row) => event(JSON.parse(String(row.row_json)) as Row))
			: [];
		const eventRows = [
			...new Map(
				[...hotEvents, ...archivedEvents].map((row) => [row.event_uid, row]),
			).values(),
		].sort((left, right) => left.seq - right.seq);
		const usageRows = rows(
			db,
			`SELECT turn.activation_id, usage.vendor, usage.observed_model_id,
			        SUM(usage.normalized_delta) AS tokens
			   FROM workflow_scorecard_turn turn
			   JOIN workflow_scorecard_usage usage
			     ON usage.vendor = turn.vendor
			    AND usage.native_session_id = turn.native_session_id
			    AND usage.source_generation = turn.source_generation
			    AND usage.native_turn_id = turn.native_turn_id
			  WHERE turn.activation_id IN (${activations.map(() => "?").join(",") || "NULL"})
			  GROUP BY turn.activation_id, usage.vendor, usage.observed_model_id`,
			...activations.map((activation) => activation.activation_id),
		);
		const cursors = rows(
			db,
			`SELECT DISTINCT turn.activation_id, turn.vendor, turn.native_session_id,
			        turn.source_generation, cursor.coverage
			   FROM workflow_scorecard_turn turn
			   LEFT JOIN workflow_scorecard_cursor cursor
			     ON cursor.vendor = turn.vendor
			    AND cursor.native_session_id = turn.native_session_id
			    AND cursor.source_generation = turn.source_generation
			  WHERE turn.activation_id IN (${activations.map(() => "?").join(",") || "NULL"})`,
			...activations.map((activation) => activation.activation_id),
		);
		const groups = {
			design: "unassigned",
			implement: "unassigned",
			qa: "unassigned",
		};
		const groupPolicies: Record<"design" | "implement" | "qa", string | null> =
			{
				design: null,
				implement: null,
				qa: null,
			};
		const degradations = new Map<
			string,
			{ degraded: boolean; reason: string | null }
		>();
		let assignmentNotHonored = false;
		let invalidEvidence = activations.some(
			(activation) => Number(activation.accounting_available) !== 1,
		);
		if (
			terminal &&
			activations.some((activation) => activation.closed_at == null)
		)
			invalidEvidence = true;
		let degraded = false;
		for (const axis of ["design", "implement", "qa"] as const) {
			const axisActivations = activations.filter(
				(activation) => activation.axis === axis,
			);
			const armIds = new Set<string>();
			const policyVersions = new Set<string>();
			let sawUnassigned = false;
			let sawUnknown = false;
			for (const activation of axisActivations) {
				if (
					readScorecardQuotaFallback(eventRows, {
						runId: String(activation.run_id),
						nodeId: String(activation.node_id),
						activationId: String(activation.activation_id),
					})
				) {
					// FLY-2900: a quota fallback sample is excluded like a degradation.
					degraded = true;
					degradations.set(String(activation.activation_id), {
						degraded: true,
						reason: "quota_fallback",
					});
					continue;
				}
				const assignment = readScorecardAssignment(eventRows, {
					runId: String(activation.run_id),
					nodeId: String(activation.node_id),
				});
				if (assignment.state === "assigned") {
					armIds.add(assignment.receipt.arm);
					policyVersions.add(assignment.receipt.policyVersion);
					const degradation = readScorecardDegradation(eventRows, {
						runId: String(activation.run_id),
						nodeId: String(activation.node_id),
						activationId: String(activation.activation_id),
						launchModel: String(activation.launch_model ?? ""),
						assignment,
					});
					if (degradation.state === "degraded") {
						degraded = true;
						degradations.set(String(activation.activation_id), {
							degraded: true,
							reason: degradation.receipt.reason,
						});
					}
					if (degradation.state === "invalid_degradation")
						invalidEvidence = true;
					if (
						assignment.receipt.resolvedModel !== activation.launch_model &&
						degradation.state !== "degraded"
					)
						assignmentNotHonored = true;
				} else if (assignment.state === "unassigned") sawUnassigned = true;
				else sawUnknown = true;
			}
			groups[axis] = sawUnknown
				? "unknown"
				: armIds.size === 0
					? "unassigned"
					: armIds.size === 1 && policyVersions.size === 1 && !sawUnassigned
						? [...armIds][0]!
						: "mixed";
			groupPolicies[axis] =
				!sawUnknown &&
				!sawUnassigned &&
				armIds.size === 1 &&
				policyVersions.size === 1
					? [...policyVersions][0]!
					: null;
		}
		const originalGroups = { ...groups };
		const originalGroupPolicies = { ...groupPolicies };
		for (const usage of usageRows) {
			const activation = activations.find(
				(candidate) => candidate.activation_id === usage.activation_id,
			);
			if (
				activation?.launch_model &&
				usage.observed_model_id &&
				activation.launch_model !== usage.observed_model_id
			) {
				assignmentNotHonored = true;
			}
		}
		if (invalidEvidence) {
			groups.design = groups.implement = groups.qa = "unknown";
			groupPolicies.design = groupPolicies.implement = groupPolicies.qa = null;
		} else if (assignmentNotHonored) {
			groups.design = groups.implement = groups.qa = "assignment_not_honored";
			groupPolicies.design = groupPolicies.implement = groupPolicies.qa = null;
		}
		const claims = rows(
			db,
			`SELECT predicate FROM workflow_claims
			  WHERE workflow_run_id IN (${placeholders})
			    AND predicate IN ('qa_passed','qa_failed','qa_exempt')
			    AND issued_at <= ?
			  ORDER BY server_seq`,
			...runIds,
			options.asOf,
		);
		const firstQa = claims.find((row) =>
			["qa_passed", "qa_failed"].includes(String(row.predicate)),
		);
		const founder = rows(
			db,
			`SELECT outcome_id, decision, authorship FROM ship_judgment_outcome
			  WHERE run_id IN (${placeholders})
			    AND julianday(decided_at) <= julianday(?)`,
			...runIds,
			options.asOf,
		);
		const founderReviewMissing =
			rows(
				db,
				`SELECT 1 FROM workflow_gate_holder holder
				  LEFT JOIN ship_judgment_outcome outcome
				    ON outcome.run_id = holder.run_id
				   AND outcome.question_id = holder.question_id
				   AND julianday(outcome.decided_at) <= julianday(?)
				 WHERE holder.run_id IN (${placeholders})
				   AND julianday(holder.created_at) <= julianday(?)
				 GROUP BY holder.run_id, holder.question_id
				HAVING COUNT(outcome.outcome_id) = 0
				 LIMIT 1`,
				options.asOf,
				...runIds,
				options.asOf,
			).length > 0;
		const activationIds = new Set(
			activations.map((row) => String(row.activation_id)),
		);
		const usageComplete =
			terminal &&
			activations.every(
				(activation) => Number(activation.accounting_available) === 1,
			) &&
			cursors.length > 0 &&
			[...activationIds].every((activationId) => {
				const activationCursors = cursors.filter(
					(cursor) => cursor.activation_id === activationId,
				);
				return (
					activationCursors.length > 0 &&
					activationCursors.every((cursor) => cursor.coverage === "complete")
				);
			});
		const nodes = activations.map((activation) => {
			const usage = usageRows.filter(
				(row) => row.activation_id === activation.activation_id,
			);
			const assignment = readScorecardAssignment(eventRows, {
				runId: String(activation.run_id),
				nodeId: String(activation.node_id),
			});
			const opened = Date.parse(String(activation.admitted_at));
			const closed = activation.closed_at
				? Date.parse(String(activation.closed_at))
				: Number.NaN;
			return {
				activationId: String(activation.activation_id),
				executionId: String(activation.execution_id),
				runId: String(activation.run_id),
				nodeId: String(activation.node_id),
				axis: activation.axis == null ? "unknown" : String(activation.axis),
				assignmentState:
					Number(activation.accounting_available) === 1
						? assignment.state
						: "accounting_unavailable",
				policyVersion:
					activation.policy_version == null
						? null
						: String(activation.policy_version),
				arm: activation.arm_id == null ? null : String(activation.arm_id),
				assignedModel:
					assignment.state === "assigned"
						? assignment.receipt.resolvedModel
						: null,
				launchModel:
					activation.launch_model == null
						? null
						: String(activation.launch_model),
				observedModels: [
					...new Set(usage.map((row) => String(row.observed_model_id))),
				],
				vendors: [...new Set(usage.map((row) => String(row.vendor)))],
				vendorMix: usage.map((row) => ({
					vendor: String(row.vendor),
					model: String(row.observed_model_id),
					tokens: Number(row.tokens),
				})),
				degraded:
					degradations.get(String(activation.activation_id))?.degraded === true,
				degradationReason:
					degradations.get(String(activation.activation_id))?.reason ?? null,
				tokens:
					usage.length === 0
						? null
						: usage.reduce((sum, row) => sum + Number(row.tokens), 0),
				durationMs:
					Number.isFinite(opened) && Number.isFinite(closed) && closed >= opened
						? closed - opened
						: null,
			};
		});
		const durations = nodes.map((node) => node.durationMs);
		const firstAdmission = Math.min(
			...activations.map((activation) =>
				Date.parse(String(activation.admitted_at)),
			),
		);
		const reviews = readIssueReviewMetrics(
			db,
			[...new Set(activations.map((row) => String(row.execution_id)))],
			eventRows,
			options.asOf,
		);
		const lastClose = terminal
			? Math.max(
					...activations.map((activation) =>
						Date.parse(String(activation.closed_at)),
					),
				)
			: Number.NaN;
		issues.push({
			issueId,
			canonicalIssueId,
			runIds,
			qaFirstPass: firstQa ? firstQa.predicate === "qa_passed" : null,
			qaExempt: claims.some((row) => row.predicate === "qa_exempt"),
			founderRejectCount: founderReviewMissing
				? null
				: new Set(
						founder
							.filter(
								(row) =>
									row.decision === "rework" &&
									row.authorship === "founder_verified",
							)
							.map((row) => String(row.outcome_id)),
					).size,
			founderReviewed:
				!founderReviewMissing &&
				founder.some((row) => row.authorship === "founder_verified"),
			terminal,
			totalTokens: usageComplete
				? nodes.reduce((sum, node) => sum + (node.tokens ?? 0), 0)
				: null,
			nodeWorkMs: durations.every((duration) => duration !== null)
				? (durations as number[]).reduce((sum, duration) => sum + duration, 0)
				: null,
			elapsedMs:
				Number.isFinite(firstAdmission) && Number.isFinite(lastClose)
					? lastClose - firstAdmission
					: null,
			degraded,
			groups,
			groupPolicies,
			originalGroups,
			originalGroupPolicies,
			nodes,
			designReview: reviews.design,
			codeReview: reviews.code,
		});
	}
	const selectedIssues =
		options.qa === "eligible"
			? issues.filter((issue) => !issue.qaExempt)
			: issues;
	const groupRows: WorkflowScorecardGroupReport[] = [];
	for (const axis of ["design", "implement", "qa"] as const) {
		for (const key of new Set(
			selectedIssues.flatMap((issue) => [
				`${issue.groupPolicies[axis] ?? ""}\0${issue.groups[axis]}`,
				`${issue.originalGroupPolicies[axis] ?? ""}\0${issue.originalGroups[axis]}`,
			]),
		)) {
			const [policyVersion, group] = key.split("\0");
			const included = selectedIssues.filter(
				(issue) =>
					issue.groups[axis] === group &&
					(issue.groupPolicies[axis] ?? "") === policyVersion &&
					!issue.degraded,
			);
			const before = ["unknown", "assignment_not_honored", "mixed"].includes(
				group!,
			)
				? selectedIssues.filter(
						(issue) =>
							issue.groups[axis] === group &&
							(issue.groupPolicies[axis] ?? "") === policyVersion,
					)
				: selectedIssues.filter(
						(issue) =>
							issue.originalGroups[axis] === group &&
							(issue.originalGroupPolicies[axis] ?? "") === policyVersion,
					);
			groupRows.push(
				groupReport(axis, group!, policyVersion || null, included, before),
			);
		}
	}
	const degradedIssues = selectedIssues.filter((issue) => issue.degraded);
	if (degradedIssues.length > 0) {
		for (const axis of ["design", "implement", "qa"] as const)
			groupRows.push(
				groupReport(axis, "degraded", null, degradedIssues, degradedIssues),
			);
		groupRows.push(
			groupReport("all", "degraded", null, degradedIssues, degradedIssues),
		);
	}
	const crossVendorUnitIncomparable =
		new Set(
			selectedIssues.flatMap((issue) =>
				issue.nodes.flatMap((node) => node.vendors),
			),
		).size > 1;
	const usageCoverageComplete = selectedIssues.every(
		(issue) => issue.terminal && issue.totalTokens !== null,
	);
	const vendorTokens = new Map<string, number>();
	for (const issue of selectedIssues)
		for (const node of issue.nodes)
			for (const usage of node.vendorMix)
				vendorTokens.set(
					usage.vendor,
					(vendorTokens.get(usage.vendor) ?? 0) + usage.tokens,
				);
	const providerConsumption = [
		...new Set([
			...vendorTokens.keys(),
			...Object.keys(options.poolCapacity?.providers ?? {}),
		]),
	]
		.sort()
		.map((vendor) => {
			const configured = options.poolCapacity?.providers[vendor];
			const capacityUnits = configured
				? configured.accounts.reduce(
						(sum, account) => sum + account.capacityUnits,
						0,
					)
				: null;
			const weeklyPoolCapacity = configured
				? capacityUnits! * configured.weeklyTokensPerCapacityUnit
				: null;
			const tokens = vendorTokens.get(vendor) ?? 0;
			return {
				vendor,
				tokens,
				accountCount: configured?.accounts.length ?? null,
				capacityUnits,
				weeklyPoolCapacity,
				weeklyPoolUsedPercent:
					usageCoverageComplete && weeklyPoolCapacity !== null
						? (tokens / weeklyPoolCapacity) * 100
						: null,
				coverageComplete: usageCoverageComplete,
			};
		});
	const detailOffset = options.detailOffset ?? 0;
	const detailLimit = options.detailLimit ?? 100;
	const detailIssues = selectedIssues.slice(
		detailOffset,
		detailOffset + detailLimit,
	);
	return {
		schemaVersion: 1,
		metricVersion: 1,
		status: "ok",
		unit: "provider_total_tokens_v1",
		cohortPolicy: "first_admission_in_window",
		qaFilter: options.qa ?? "all",
		project: options.project,
		from: options.from,
		to: options.to,
		asOf: options.asOf,
		issueCount: selectedIssues.length,
		degradedCount: degradedIssues.length,
		crossVendorUnitIncomparable,
		providerConsumption,
		detailPage: {
			offset: detailOffset,
			limit: detailLimit,
			returned: detailIssues.length,
		},
		issues: detailIssues,
		groups: groupRows,
	};
}
