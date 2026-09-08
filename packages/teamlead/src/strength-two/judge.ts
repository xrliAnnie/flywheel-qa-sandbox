import {
	type RanReason,
	type RecordReason,
	SHA40_LOWER_PATTERN,
	SHA256_PATTERN,
	type StrengthTwoLane,
} from "flywheel-comm/strength-two-contract";

export type SiteRawFacts = Record<string, unknown>;

export type SiteProbe =
	| {
			ok: true;
			httpStatus: 200;
			healthOk: true;
			shuttingDown: false;
			buildMode: "built";
			buildSha: string;
			artifactBuildSha: string;
			/** Constructed by the site probe only; judgeRan still revalidates at runtime. */
			validated?: "site_probe";
	  }
	| {
			ok: false;
			reason: "unreachable" | "timeout" | "bad_payload" | "not_ready";
			httpStatus?: number;
			raw: SiteRawFacts;
			detail: string;
	  };

export interface RanInput {
	siteProbe: SiteProbe;
	headSha: string;
	lane: StrengthTwoLane;
	driverExitCode: number | null;
}

export interface RecordEvidence {
	httpStatus: 200;
	digest: string;
	bytes: number;
}

export type RecordProbe =
	| {
			kind: "hosted_report";
			outcome:
				| "not_in_registry"
				| "expired"
				| "timeout"
				| "unreachable"
				| "http_error"
				| "body_too_large"
				| "digest_mismatch";
			httpStatus?: number;
			digest?: string;
			bytes?: number;
			detail: string;
	  }
	| { kind: "hosted_report"; outcome: "ok"; evidence: RecordEvidence }
	| {
			kind: "github_comment";
			outcome:
				| "timeout"
				| "unreachable"
				| "not_found"
				| "forbidden"
				| "bad_payload"
				| "url_mismatch";
			detail: string;
	  }
	| { kind: "github_comment"; outcome: "ok"; evidence: RecordEvidence };

export function judgeRan(input: RanInput): {
	satisfied: boolean;
	reason: RanReason;
} {
	if (!input.siteProbe.ok) {
		const reasons = {
			unreachable: "site_unreachable",
			timeout: "site_timeout",
			bad_payload: "site_bad_payload",
			not_ready: "site_not_ready",
		} as const;
		return { satisfied: false, reason: reasons[input.siteProbe.reason] };
	}
	const probe = input.siteProbe as Record<string, unknown>;
	if (
		probe.httpStatus !== 200 ||
		probe.healthOk !== true ||
		probe.shuttingDown !== false ||
		probe.buildMode !== "built"
	) {
		return { satisfied: false, reason: "site_not_ready" };
	}
	if (
		typeof probe.buildSha !== "string" ||
		!SHA40_LOWER_PATTERN.test(probe.buildSha) ||
		typeof probe.artifactBuildSha !== "string" ||
		!SHA40_LOWER_PATTERN.test(probe.artifactBuildSha)
	) {
		return { satisfied: false, reason: "site_bad_payload" };
	}
	if (
		probe.buildSha !== input.headSha ||
		probe.artifactBuildSha !== input.headSha
	) {
		return { satisfied: false, reason: "site_head_mismatch" };
	}
	if (input.lane === "manual_test_deploy") {
		return { satisfied: false, reason: "lane_unproven" };
	}
	if (input.driverExitCode !== 0) {
		return { satisfied: false, reason: "driver_nonzero" };
	}
	return { satisfied: true, reason: "ok" };
}

const HOSTED_REASON = {
	not_in_registry: "url_not_in_registry",
	expired: "url_expired",
	timeout: "url_timeout",
	unreachable: "url_unreachable",
	http_error: "url_http_error",
	body_too_large: "url_body_too_large",
	digest_mismatch: "digest_mismatch",
} as const;

const GITHUB_REASON = {
	timeout: "gh_timeout",
	unreachable: "gh_unreachable",
	not_found: "gh_not_found",
	forbidden: "gh_forbidden",
	bad_payload: "gh_bad_payload",
	url_mismatch: "gh_url_mismatch",
} as const;

export interface RecordJudgment {
	satisfied: boolean;
	reason: RecordReason;
	httpStatus?: number;
	digest?: string;
	bytes?: number;
}

export function judgeRecord(probe: RecordProbe): RecordJudgment {
	if (probe.outcome === "ok") {
		const evidence = (probe as { evidence?: Partial<RecordEvidence> }).evidence;
		if (
			!evidence ||
			evidence.httpStatus !== 200 ||
			typeof evidence.digest !== "string" ||
			!SHA256_PATTERN.test(evidence.digest) ||
			!Number.isSafeInteger(evidence.bytes) ||
			Number(evidence.bytes) <= 0
		) {
			throw new Error("record probe invariant violated");
		}
		return {
			satisfied: true,
			reason: "ok",
			httpStatus: 200,
			digest: evidence.digest,
			bytes: evidence.bytes,
		};
	}
	const reason =
		probe.kind === "hosted_report"
			? HOSTED_REASON[probe.outcome]
			: GITHUB_REASON[probe.outcome];
	const source = probe as {
		httpStatus?: unknown;
		digest?: unknown;
		bytes?: unknown;
	};
	return {
		satisfied: false,
		reason,
		...(Number.isInteger(source.httpStatus)
			? { httpStatus: Number(source.httpStatus) }
			: {}),
		...(typeof source.digest === "string" && SHA256_PATTERN.test(source.digest)
			? { digest: source.digest }
			: {}),
		...(Number.isSafeInteger(source.bytes) && Number(source.bytes) >= 0
			? { bytes: Number(source.bytes) }
			: {}),
	};
}

export interface StrengthTwoLedgerRow {
	record_id: string;
	recorded_at: string;
	ran_status: "satisfied" | "unsatisfied";
	ran_reason: RanReason;
	record_status: "satisfied" | "unsatisfied";
	record_reason: RecordReason;
	verdict: "satisfied" | "unsatisfied";
}

export interface StrengthTwoVerdict {
	ran: { satisfied: boolean; reason: RanReason | "no_ledger_row" };
	record: { satisfied: boolean; reason: RecordReason | "no_ledger_row" };
	verdict: "satisfied" | "unsatisfied";
	basisRecordId: string | null;
}

function newest(rows: readonly StrengthTwoLedgerRow[]): StrengthTwoLedgerRow {
	return [...rows].sort((left, right) => {
		const time = left.recorded_at.localeCompare(right.recorded_at);
		return time !== 0 ? time : left.record_id.localeCompare(right.record_id);
	})[rows.length - 1]!;
}

export function evaluateStrengthTwo(
	rows: readonly StrengthTwoLedgerRow[],
): StrengthTwoVerdict {
	if (rows.length === 0) {
		return {
			ran: { satisfied: false, reason: "no_ledger_row" },
			record: { satisfied: false, reason: "no_ledger_row" },
			verdict: "unsatisfied",
			basisRecordId: null,
		};
	}
	const satisfied = rows.filter((row) => row.verdict === "satisfied");
	const basis = newest(satisfied.length > 0 ? satisfied : rows);
	return {
		ran: {
			satisfied: basis.ran_status === "satisfied",
			reason: basis.ran_reason,
		},
		record: {
			satisfied: basis.record_status === "satisfied",
			reason: basis.record_reason,
		},
		verdict: basis.verdict,
		basisRecordId: basis.record_id,
	};
}
