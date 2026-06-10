import type {
	VerifyApprovalArgs,
	VerifyApprovalResult,
} from "flywheel-comm/verify-approval";
import { describe, expect, it, vi } from "vitest";
import {
	CodexFounderPreflight,
	type FounderPreflightContext,
} from "../CodexFounderPreflight.js";

const SHA = "a".repeat(40);

function ctx(
	over: Partial<FounderPreflightContext> = {},
): FounderPreflightContext {
	return {
		action: "merge",
		execId: "exec-1",
		prHead: SHA,
		dbPath: "/tmp/comm.db",
		...over,
	};
}

function verifyReturning(result: Partial<VerifyApprovalResult>) {
	const calls: VerifyApprovalArgs[] = [];
	const fn = (args: VerifyApprovalArgs): VerifyApprovalResult => {
		calls.push(args);
		return {
			approved: false,
			reason: "gate_not_answered",
			exitCode: 1,
			...result,
		} as VerifyApprovalResult;
	};
	return { fn, calls };
}

describe("CodexFounderPreflight — construction", () => {
	it("requires a verify fn", () => {
		// @ts-expect-error intentionally missing
		expect(() => new CodexFounderPreflight({})).toThrow(/verify/);
	});
});

describe("CodexFounderPreflight — ALLOWS only a genuine structured approval", () => {
	it("allows when approved===true AND reason==='approved'", () => {
		const { fn, calls } = verifyReturning({
			approved: true,
			reason: "approved",
			questionId: "q1",
			expectedPrHeadSha: SHA,
			exitCode: 0,
		});
		const pf = new CodexFounderPreflight({ verify: fn });
		const d = pf.check(ctx());
		expect(d.allowed).toBe(true);
		expect(d.reason).toBe("approved");
		expect(d.detail?.questionId).toBe("q1");
		// passed the real authority args through
		expect(calls[0]).toMatchObject({
			execId: "exec-1",
			prHead: SHA,
			dbPath: "/tmp/comm.db",
		});
	});

	it("REJECTS approved===true with a non-'approved' reason (defense-in-depth)", () => {
		const { fn } = verifyReturning({
			approved: true,
			reason: "status_not_approved_to_ship",
			exitCode: 0,
		});
		const pf = new CodexFounderPreflight({ verify: fn });
		expect(pf.check(ctx()).allowed).toBe(false);
	});
});

describe("CodexFounderPreflight — FAIL-CLOSED rejections (the security contract)", () => {
	const cases: Array<[string, Partial<VerifyApprovalResult>]> = [
		[
			"no approval — gate not answered",
			{ approved: false, reason: "gate_not_answered" },
		],
		[
			"no binding — review question unbound",
			{ approved: false, reason: "review_question_unbound" },
		],
		[
			"FORGED — bare-text not structured",
			{ approved: false, reason: "response_not_structured_approval" },
		],
		[
			"explicit not-approved",
			{ approved: false, reason: "response_not_approved" },
		],
		[
			"STALE — pr head sha mismatch",
			{ approved: false, reason: "pr_head_sha_mismatch" },
		],
		["pr head sha missing", { approved: false, reason: "pr_head_sha_missing" }],
		["commdb unreadable", { approved: false, reason: "commdb_unreadable" }],
		["state db unreadable", { approved: false, reason: "state_db_unreadable" }],
	];
	for (const [name, result] of cases) {
		it(`rejects: ${name}`, () => {
			const { fn } = verifyReturning(result);
			const pf = new CodexFounderPreflight({ verify: fn });
			const d = pf.check(ctx());
			expect(d.allowed).toBe(false);
			expect(d.reason).toBe(result.reason);
		});
	}

	it("rejects (fail-closed) when verify THROWS — never proceeds on an error", () => {
		const pf = new CodexFounderPreflight({
			verify: () => {
				throw new Error("db exploded");
			},
			logger: { warn: vi.fn() },
		});
		const d = pf.check(ctx());
		expect(d.allowed).toBe(false);
		expect(d.reason).toBe("verify_threw");
	});
});

describe("CodexFounderPreflight — context validation (never calls the gate on bad input)", () => {
	it("rejects missing execId without calling verify", () => {
		const { fn, calls } = verifyReturning({
			approved: true,
			reason: "approved",
		});
		const pf = new CodexFounderPreflight({ verify: fn });
		const d = pf.check(ctx({ execId: "" }));
		expect(d.allowed).toBe(false);
		expect(d.reason).toBe("missing_context");
		expect(calls).toHaveLength(0);
	});

	it("rejects missing dbPath without calling verify", () => {
		const { fn, calls } = verifyReturning({
			approved: true,
			reason: "approved",
		});
		const pf = new CodexFounderPreflight({ verify: fn });
		expect(pf.check(ctx({ dbPath: "" })).reason).toBe("missing_context");
		expect(calls).toHaveLength(0);
	});

	it("rejects an invalid (non-40-hex) PR head without calling verify", () => {
		const { fn, calls } = verifyReturning({
			approved: true,
			reason: "approved",
		});
		const pf = new CodexFounderPreflight({ verify: fn });
		const d = pf.check(ctx({ prHead: "deadbeef" }));
		expect(d.allowed).toBe(false);
		expect(d.reason).toBe("invalid_pr_head_format");
		expect(calls).toHaveLength(0);
	});
});

describe("CodexFounderPreflight — applies to every founder-gated action", () => {
	for (const action of ["merge", "ship", "runner_lifecycle"] as const) {
		it(`enforces for action='${action}' (approved passes, unapproved rejects)`, () => {
			const ok = new CodexFounderPreflight({
				verify: verifyReturning({ approved: true, reason: "approved" }).fn,
			});
			expect(ok.check(ctx({ action })).allowed).toBe(true);
			const no = new CodexFounderPreflight({
				verify: verifyReturning({
					approved: false,
					reason: "gate_not_answered",
				}).fn,
			});
			const d = no.check(ctx({ action }));
			expect(d.allowed).toBe(false);
			expect(d.action).toBe(action);
		});
	}
});
