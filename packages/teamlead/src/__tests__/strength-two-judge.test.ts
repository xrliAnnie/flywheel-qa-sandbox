import { describe, expect, it } from "vitest";
import {
	evaluateStrengthTwo,
	judgeRan,
	judgeRecord,
	type StrengthTwoLedgerRow,
} from "../strength-two/judge.js";

const HEAD = "a".repeat(40);
const SITE_OK = {
	ok: true as const,
	httpStatus: 200 as const,
	healthOk: true as const,
	shuttingDown: false as const,
	buildMode: "built" as const,
	buildSha: HEAD,
	artifactBuildSha: HEAD,
};
const RECORD_OK = {
	kind: "hosted_report" as const,
	outcome: "ok" as const,
	evidence: { httpStatus: 200 as const, digest: "b".repeat(64), bytes: 42 },
};

describe("judgeRan", () => {
	it.each([
		["unreachable", "site_unreachable"],
		["timeout", "site_timeout"],
		["bad_payload", "site_bad_payload"],
		["not_ready", "site_not_ready"],
	] as const)("maps %s independently", (reason, expected) => {
		expect(
			judgeRan({
				siteProbe: { ok: false, reason, raw: {}, detail: reason },
				headSha: HEAD,
				lane: "generalized_e2e_stub",
				driverExitCode: 0,
			}),
		).toEqual({ satisfied: false, reason: expected });
	});

	it("defensively rejects a contradictory success object", () => {
		expect(
			judgeRan({
				siteProbe: { ...SITE_OK, httpStatus: 500 } as never,
				headSha: HEAD,
				lane: "generalized_e2e_stub",
				driverExitCode: 0,
			}),
		).toEqual({ satisfied: false, reason: "site_not_ready" });
	});

	it("keeps head, lane, and driver failures distinct and ordered", () => {
		expect(
			judgeRan({
				...baseRan(),
				siteProbe: { ...SITE_OK, buildSha: "c".repeat(40) },
			}),
		).toEqual({ satisfied: false, reason: "site_head_mismatch" });
		expect(
			judgeRan({
				...baseRan(),
				lane: "manual_test_deploy",
				driverExitCode: null,
			}),
		).toEqual({
			satisfied: false,
			reason: "lane_unproven",
		});
		expect(judgeRan({ ...baseRan(), driverExitCode: 1 })).toEqual({
			satisfied: false,
			reason: "driver_nonzero",
		});
		expect(judgeRan(baseRan())).toEqual({ satisfied: true, reason: "ok" });
	});
});

function baseRan() {
	return {
		siteProbe: SITE_OK,
		headSha: HEAD,
		lane: "generalized_e2e_stub" as const,
		driverExitCode: 0,
	};
}

describe("judgeRecord", () => {
	it.each([
		["hosted_report", "not_in_registry", "url_not_in_registry"],
		["hosted_report", "expired", "url_expired"],
		["hosted_report", "timeout", "url_timeout"],
		["hosted_report", "unreachable", "url_unreachable"],
		["hosted_report", "http_error", "url_http_error"],
		["hosted_report", "body_too_large", "url_body_too_large"],
		["hosted_report", "digest_mismatch", "digest_mismatch"],
		["github_comment", "timeout", "gh_timeout"],
		["github_comment", "unreachable", "gh_unreachable"],
		["github_comment", "not_found", "gh_not_found"],
		["github_comment", "forbidden", "gh_forbidden"],
		["github_comment", "bad_payload", "gh_bad_payload"],
		["github_comment", "url_mismatch", "gh_url_mismatch"],
	] as const)("maps %s/%s to %s", (kind, outcome, reason) => {
		expect(judgeRecord({ kind, outcome, detail: outcome } as never)).toEqual({
			satisfied: false,
			reason,
		});
	});

	it("returns complete successful evidence", () => {
		expect(judgeRecord(RECORD_OK)).toEqual({
			satisfied: true,
			reason: "ok",
			httpStatus: 200,
			digest: "b".repeat(64),
			bytes: 42,
		});
	});

	it.each([
		{ httpStatus: 200, digest: "b".repeat(64), bytes: 0 },
		{ httpStatus: 200, digest: "bad", bytes: 42 },
		{ httpStatus: 204, digest: "b".repeat(64), bytes: 42 },
	])("throws on contradictory successful evidence %#", (evidence) => {
		expect(() => judgeRecord({ ...RECORD_OK, evidence } as never)).toThrow(
			/record probe invariant/,
		);
	});
});

function row(
	overrides: Partial<StrengthTwoLedgerRow> = {},
): StrengthTwoLedgerRow {
	return {
		record_id: "11111111-1111-4111-8111-111111111111",
		recorded_at: "2026-09-07T03:00:00.000Z",
		ran_status: "satisfied",
		ran_reason: "ok",
		record_status: "satisfied",
		record_reason: "ok",
		verdict: "satisfied",
		...overrides,
	};
}

describe("evaluateStrengthTwo", () => {
	it("fails closed when no ledger row exists and accepts no claim input", () => {
		expect(evaluateStrengthTwo([])).toEqual({
			ran: { satisfied: false, reason: "no_ledger_row" },
			record: { satisfied: false, reason: "no_ledger_row" },
			verdict: "unsatisfied",
			basisRecordId: null,
		});
	});

	it("keeps the two halves separately visible in both asymmetric controls", () => {
		expect(
			evaluateStrengthTwo([
				row({
					record_status: "unsatisfied",
					record_reason: "url_http_error",
					verdict: "unsatisfied",
				}),
			]),
		).toMatchObject({
			ran: { satisfied: true, reason: "ok" },
			record: { satisfied: false, reason: "url_http_error" },
			verdict: "unsatisfied",
		});
		expect(
			evaluateStrengthTwo([
				row({
					ran_status: "unsatisfied",
					ran_reason: "site_head_mismatch",
					verdict: "unsatisfied",
				}),
			]),
		).toMatchObject({
			ran: { satisfied: false, reason: "site_head_mismatch" },
			record: { satisfied: true, reason: "ok" },
			verdict: "unsatisfied",
		});
	});

	it("chooses the newest satisfied row, breaking timestamp ties by record id", () => {
		const oldSatisfied = row({
			record_id: "11111111-1111-4111-8111-111111111111",
			recorded_at: "2026-09-07T01:00:00.000Z",
		});
		const newestFailed = row({
			record_id: "22222222-2222-4222-8222-222222222222",
			recorded_at: "2026-09-07T04:00:00.000Z",
			record_status: "unsatisfied",
			record_reason: "url_expired",
			verdict: "unsatisfied",
		});
		const tieSatisfied = row({
			record_id: "33333333-3333-4333-8333-333333333333",
			recorded_at: "2026-09-07T01:00:00.000Z",
		});
		expect(
			evaluateStrengthTwo([newestFailed, oldSatisfied, tieSatisfied]),
		).toEqual({
			ran: { satisfied: true, reason: "ok" },
			record: { satisfied: true, reason: "ok" },
			verdict: "satisfied",
			basisRecordId: tieSatisfied.record_id,
		});
	});
});
