/**
 * FLY-799 Part A — founder ship-approval handler (RED first).
 *
 * The assembly the deliverer's ship branch calls: identity (canonical founder) →
 * A-2 narrow to EXACTLY ONE current ship gate (status awaiting_review &&
 * review_question_id === questionId) → TextSource (v1) → shared gate-write
 * helper.
 *
 * FLY-1099 §3.2: the return contract is the explicit ShipApprovalOutcome —
 * `bound` requires the decision's POSTCONDITION (approve: FSM flipped;
 * reject: hook ok), `deferred` = durably parked on a held gate, `retry` =
 * transient infra failure; null = WAKE-only.
 */

import { describe, expect, it, vi } from "vitest";
import { tryFounderShipApproval } from "../approval-signal/founder-ship-approval-handler.js";

const CTX = {
	issueId: "issue-uuid",
	projectName: "proj",
	projectRoot: "/repo",
	threadId: "T-1",
	ownerUserId: "FOUNDER-1",
	graceMs: 0,
	commDbPath: "/x",
	leadId: "lead",
};
const HEAD = "a".repeat(40);

const session = (over = {}) => ({
	status: "awaiting_review",
	review_question_id: "Q-1",
	pr_head_sha: HEAD,
	pr_number: 799,
	issue_identifier: "FLY-799",
	...over,
});

const oneShipGate = [
	{
		questionId: "Q-1",
		checkpoint: "approve_to_ship",
		executionId: "E-1",
		createdAtMs: 1,
	},
];

/**
 * FLY-1099 (Codex R2 #1): the fixture models the PRODUCTION postcondition —
 * a successful write's post-write hook flips the session to approved_to_ship
 * (the handler re-reads the store to verify), so the fake store is stateful
 * and the fake writer flips it exactly when a structured approval is written.
 */
function deps(over: Record<string, unknown> = {}) {
	const state = { status: "awaiting_review" };
	const base = {
		canonicalFounderId: "FOUNDER-1",
		store: {
			getSession: vi
				.fn()
				.mockImplementation(() => session({ status: state.status })),
		},
		db: {},
		evaluateTextImpl: vi.fn().mockResolvedValue({
			source: "text",
			kind: "approve",
			questionId: "Q-1",
			prHeadSha: HEAD,
			messageId: "MSG-1",
			authorUserId: "FOUNDER-1",
		}),
		writeGateResponseImpl: vi.fn().mockImplementation(async (args) => {
			try {
				if (JSON.parse(args.answer)?.approved === true) {
					state.status = "approved_to_ship"; // production hook's FSM flip
				}
			} catch {
				/* reject payload — no flip */
			}
			return { written: true, retrySafe: true };
		}),
		_state: state,
	};
	return { ...base, ...over };
}

const founderMsg = { id: "MSG-1", content: "ship it", authorId: "FOUNDER-1" };

describe("tryFounderShipApproval — approve path", () => {
	it("pins before writing when durable decision classification fails", async () => {
		const d = deps();
		const result = await tryFounderShipApproval(
			{
				msg: founderMsg,
				shipGates: oneShipGate,
				ctx: CTX,
				recordDecisionClassification: vi.fn(() => {
					throw new Error("classification store unavailable");
				}),
			},
			d,
		);

		expect(result).toMatchObject({
			bound: [],
			deferred: [],
			retry: true,
			stage: "decision_classification_failed",
		});
		expect(d.writeGateResponseImpl).not.toHaveBeenCalled();
	});

	it("founder approval on the one current gate → writes approval, returns handled", async () => {
		const cardAuthority = vi.fn().mockReturnValue({ ok: true });
		const d = deps({ cardAuthority });
		const r = await tryFounderShipApproval(
			{ msg: founderMsg, shipGates: oneShipGate, ctx: CTX },
			d,
		);
		expect(r).toEqual({
			bound: [{ questionId: "Q-1", decision: "approve" }],
			deferred: [],
			retry: false,
		});
		// wrote a structured approval for this gate
		const [writeArgs] = d.writeGateResponseImpl.mock.calls[0];
		expect(writeArgs.questionId).toBe("Q-1");
		expect(writeArgs.actor).toBe("FOUNDER-1");
		expect(JSON.parse(writeArgs.answer).approved).toBe(true);
		expect(writeArgs).toMatchObject({ source: "text", cardAuthority });
	});

	it("engine gate remains approvable after its QA source session is gone", async () => {
		const authority = {
			kind: "engine" as const,
			runId: "run-1",
			questionId: "Q-1",
			executionId: "E-1",
			issueId: "issue-uuid",
			projectName: "proj",
			headSha: HEAD,
			state: "awaiting_review" as const,
			cardMessageId: "GATE-CARD",
			prNumber: 799,
			issueIdentifier: "FLY-1375",
		};
		const gateAuthorityView = { resolve: vi.fn().mockReturnValue(authority) };
		const d = deps({
			store: { getSession: vi.fn().mockReturnValue(undefined) },
			gateAuthorityView,
		});

		const result = await tryFounderShipApproval(
			{ msg: founderMsg, shipGates: oneShipGate, ctx: CTX },
			d,
		);

		expect(result).toEqual({
			bound: [{ questionId: "Q-1", decision: "approve" }],
			deferred: [],
			retry: false,
		});
		expect(d.writeGateResponseImpl).toHaveBeenCalledWith(
			expect.objectContaining({ gateAuthorityView }),
		);
	});
});

describe("tryFounderShipApproval — fail-closed (returns null → WAKE-only)", () => {
	it("non-founder author → null (never evaluates)", async () => {
		const d = deps();
		const r = await tryFounderShipApproval(
			{
				msg: { ...founderMsg, authorId: "SOMEONE" },
				shipGates: oneShipGate,
				ctx: CTX,
			},
			d,
		);
		expect(r).toBeNull();
		expect(d.evaluateTextImpl).not.toHaveBeenCalled();
	});

	it("A-2: more than one current ship gate → null (no write)", async () => {
		const d = deps({
			store: {
				getSession: vi
					.fn()
					.mockImplementation((e: string) =>
						session({ review_question_id: e === "E-1" ? "Q-1" : "Q-2" }),
					),
			},
		});
		const two = [
			{
				questionId: "Q-1",
				checkpoint: "approve_to_ship",
				executionId: "E-1",
				createdAtMs: 1,
			},
			{
				questionId: "Q-2",
				checkpoint: "approve_to_ship",
				executionId: "E-2",
				createdAtMs: 2,
			},
		];
		const r = await tryFounderShipApproval(
			{ msg: founderMsg, shipGates: two, ctx: CTX },
			d,
		);
		expect(r).toBeNull();
		expect(d.writeGateResponseImpl).not.toHaveBeenCalled();
	});

	it("gate not awaiting_review → not a current gate → null", async () => {
		const d = deps({
			store: {
				getSession: vi.fn().mockReturnValue(session({ status: "running" })),
			},
		});
		const r = await tryFounderShipApproval(
			{ msg: founderMsg, shipGates: oneShipGate, ctx: CTX },
			d,
		);
		expect(r).toBeNull();
	});

	it("review_question_id mismatch → not the current gate → null", async () => {
		const d = deps({
			store: {
				getSession: vi
					.fn()
					.mockReturnValue(session({ review_question_id: "Q-OTHER" })),
			},
		});
		const r = await tryFounderShipApproval(
			{ msg: founderMsg, shipGates: oneShipGate, ctx: CTX },
			d,
		);
		expect(r).toBeNull();
	});

	it("TextSource unclear → null (WAKE-only, no write)", async () => {
		const d = deps({
			evaluateTextImpl: vi.fn().mockResolvedValue({
				source: "text",
				kind: "unclear",
				questionId: "Q-1",
				prHeadSha: HEAD,
				messageId: "MSG-1",
				authorUserId: "FOUNDER-1",
			}),
		});
		const r = await tryFounderShipApproval(
			{ msg: founderMsg, shipGates: oneShipGate, ctx: CTX },
			d,
		);
		expect(r).toBeNull();
		expect(d.writeGateResponseImpl).not.toHaveBeenCalled();
	});
});

describe("tryFounderShipApproval — reject path", () => {
	it("TextSource reject → writes feedback (not approval), returns handled", async () => {
		const founderRework = {
			target: "qa" as const,
			invalidationScope: ["qa" as const],
			verificationPolicy: ["qa_retest" as const, "founder_gate" as const],
			interpretedBy: "founder-reply-prefix",
			interpretationReason: "matched_prefix:qa",
		};
		const d = deps({
			evaluateTextImpl: vi.fn().mockResolvedValue({
				source: "text",
				kind: "reject",
				questionId: "Q-1",
				prHeadSha: HEAD,
				messageId: "MSG-1",
				authorUserId: "FOUNDER-1",
				founderRework,
			}),
		});
		const r = await tryFounderShipApproval(
			{ msg: founderMsg, shipGates: oneShipGate, ctx: CTX },
			d,
		);
		expect(r).toMatchObject({
			bound: [{ questionId: "Q-1", decision: "reject" }],
			retry: false,
		});
		const [writeArgs] = d.writeGateResponseImpl.mock.calls[0];
		expect(JSON.parse(writeArgs.answer).approved).not.toBe(true);
		expect(writeArgs.founderRework).toEqual(founderRework);
	});
});

describe("tryFounderShipApproval — attribution audit + hold guard (FLY-1041)", () => {
	it("narrow_zero: no current gate → auditSink('narrow_zero') + null", async () => {
		const auditSink = vi.fn();
		const d = deps({
			auditSink,
			store: {
				getSession: vi
					.fn()
					.mockReturnValue(session({ review_question_id: "Q-OTHER" })),
			},
		});
		const r = await tryFounderShipApproval(
			{ msg: founderMsg, shipGates: oneShipGate, ctx: CTX },
			d,
		);
		expect(r).toBeNull();
		expect(auditSink).toHaveBeenCalledWith(
			"narrow_zero",
			expect.objectContaining({ shipGateQids: ["Q-1"] }),
		);
	});

	it("narrow_multi: two current gates → auditSink with per-gate snapshots + null", async () => {
		const auditSink = vi.fn();
		const d = deps({
			auditSink,
			store: {
				getSession: vi
					.fn()
					.mockImplementation((e: string) =>
						session({ review_question_id: e === "E-1" ? "Q-1" : "Q-2" }),
					),
			},
		});
		const two = [
			{
				questionId: "Q-1",
				checkpoint: "approve_to_ship",
				executionId: "E-1",
				createdAtMs: 1,
			},
			{
				questionId: "Q-2",
				checkpoint: "approve_to_ship",
				executionId: "E-2",
				createdAtMs: 2,
			},
		];
		const r = await tryFounderShipApproval(
			{ msg: founderMsg, shipGates: two, ctx: CTX },
			d,
		);
		expect(r).toBeNull();
		expect(auditSink).toHaveBeenCalledWith(
			"narrow_multi",
			expect.objectContaining({
				candidates: [
					expect.objectContaining({ questionId: "Q-1", executionId: "E-1" }),
					expect.objectContaining({ questionId: "Q-2", executionId: "E-2" }),
				],
			}),
		);
	});

	it("held session: decline BEFORE evaluation — no evaluate, no write, held_declined audit, null (WAKE-only for approve AND reject alike)", async () => {
		const auditSink = vi.fn();
		const d = deps({ auditSink, isHeld: vi.fn().mockReturnValue(true) });
		const r = await tryFounderShipApproval(
			{ msg: founderMsg, shipGates: oneShipGate, ctx: CTX },
			d,
		);
		expect(r).toBeNull();
		expect(d.evaluateTextImpl).not.toHaveBeenCalled();
		expect(d.writeGateResponseImpl).not.toHaveBeenCalled();
		expect(auditSink).toHaveBeenCalledWith(
			"held_declined",
			expect.objectContaining({ questionId: "Q-1" }),
		);
	});

	it.each(["qa_evidence_missing", "qa_evidence_unknown"] as const)(
		"FLY-1251: %s is never deferred; it rejects the click with an explicit held notice",
		async (holdReason) => {
			const deferral = {
				holdReason: vi.fn(() => holdReason),
				defer: vi.fn(() => "inserted" as const),
				queueHeldNotice: vi.fn(),
				parkForConvergence: vi.fn(),
				queueFeedbackWake: vi.fn(),
			};
			const d = deps({ deferral });

			const result = await tryFounderShipApproval(
				{ msg: founderMsg, shipGates: oneShipGate, ctx: CTX },
				d,
			);

			expect(result).toBeNull();
			expect(deferral.defer).not.toHaveBeenCalled();
			expect(d.evaluateTextImpl).not.toHaveBeenCalled();
			expect(deferral.queueHeldNotice).toHaveBeenCalledWith({
				questionId: "Q-1",
				msgId: "MSG-1",
				executionId: "E-1",
				kind: "readiness_hold",
				holdReason,
			});
		},
	);

	it("held reject parks the same immutable route hint for deferred replay", async () => {
		const founderRework = {
			target: "design" as const,
			invalidationScope: [
				"design" as const,
				"implement" as const,
				"qa" as const,
			],
			verificationPolicy: [
				"design_review" as const,
				"code_review" as const,
				"qa_retest" as const,
				"founder_gate" as const,
			],
			interpretedBy: "founder-reply-prefix",
			interpretationReason: "matched_prefix:design",
		};
		const deferral = {
			holdReason: vi.fn(() => "codex_pending" as const),
			defer: vi.fn(() => "inserted" as const),
			queueHeldNotice: vi.fn(),
			parkForConvergence: vi.fn(),
			queueFeedbackWake: vi.fn(),
		};
		const d = deps({
			deferral,
			evaluateTextImpl: vi.fn().mockResolvedValue({
				source: "text",
				kind: "reject",
				questionId: "Q-1",
				prHeadSha: HEAD,
				messageId: "MSG-1",
				authorUserId: "FOUNDER-1",
				founderRework,
			}),
		});

		await tryFounderShipApproval(
			{ msg: founderMsg, shipGates: oneShipGate, ctx: CTX },
			d,
		);

		expect(deferral.defer).toHaveBeenCalledWith(
			expect.objectContaining({ decision: "reject", founderRework }),
		);
	});

	it("un-held session: isHeld false → normal write path", async () => {
		const d = deps({ isHeld: vi.fn().mockReturnValue(false) });
		const r = await tryFounderShipApproval(
			{ msg: founderMsg, shipGates: oneShipGate, ctx: CTX },
			d,
		);
		expect(r).toEqual({
			bound: [{ questionId: "Q-1", decision: "approve" }],
			deferred: [],
			retry: false,
		});
	});

	it("signal evidence stage flows into the audit (tier2_approve → response_written)", async () => {
		const auditSink = vi.fn();
		const d = deps({
			auditSink,
			evaluateTextImpl: vi.fn().mockResolvedValue({
				source: "text",
				kind: "approve",
				questionId: "Q-1",
				prHeadSha: HEAD,
				messageId: "MSG-1",
				authorUserId: "FOUNDER-1",
				evidence: { stage: "tier2_approve" },
			}),
		});
		await tryFounderShipApproval(
			{ msg: founderMsg, shipGates: oneShipGate, ctx: CTX },
			d,
		);
		expect(auditSink).toHaveBeenCalledWith(
			"tier2_approve",
			expect.objectContaining({ questionId: "Q-1", kind: "approve" }),
		);
		expect(auditSink).toHaveBeenCalledWith(
			"response_written",
			expect.objectContaining({ decision: "approve", written: true }),
		);
	});

	it("tier3 runner failure surfaces its reason instead of being folded away", async () => {
		const auditSink = vi.fn();
		const d = deps({
			auditSink,
			evaluateTextImpl: vi.fn().mockResolvedValue({
				source: "text",
				kind: "unclear",
				questionId: "Q-1",
				prHeadSha: HEAD,
				messageId: "MSG-1",
				authorUserId: "FOUNDER-1",
				evidence: { stage: "tier3_runner_failed", reason: "spawn ENOENT" },
			}),
		});
		const r = await tryFounderShipApproval(
			{ msg: founderMsg, shipGates: oneShipGate, ctx: CTX },
			d,
		);
		// FLY-1099 §7.3: classifier INFRA failure is transient — bounded retry
		// (the cursor pins) instead of permanently consuming the message.
		expect(r).toEqual({
			bound: [],
			deferred: [],
			retry: true,
			stage: "tier3_runner_failed",
			reason: "spawn ENOENT",
		});
		expect(auditSink).toHaveBeenCalledWith(
			"tier3_runner_failed",
			expect.objectContaining({ reason: "spawn ENOENT" }),
		);
		expect(d.writeGateResponseImpl).not.toHaveBeenCalled();
	});

	it("reply-to-card context is audited (reply_to_card_hit)", async () => {
		const auditSink = vi.fn();
		const d = deps({ auditSink });
		await tryFounderShipApproval(
			{ msg: founderMsg, shipGates: oneShipGate, ctx: CTX, replyToCard: true },
			d,
		);
		expect(auditSink).toHaveBeenCalledWith(
			"reply_to_card_hit",
			expect.objectContaining({ questionId: "Q-1" }),
		);
	});
});

describe("FLY-1099 Codex code R1 fixes — postcondition ownership", () => {
	const baseDeferral = () => ({
		holdReason: vi.fn(() => null),
		defer: vi.fn(() => "inserted" as const),
		queueHeldNotice: vi.fn(),
		parkForConvergence: vi.fn(),
		queueFeedbackWake: vi.fn(),
	});

	it("HIGH-2: live reject bound = response durable + DURABLE feedback_wake intent (void hook never trusted)", async () => {
		const deferral = baseDeferral();
		const d = deps({
			deferral,
			evaluateTextImpl: vi.fn().mockResolvedValue({
				source: "text",
				kind: "reject",
				questionId: "Q-1",
				prHeadSha: HEAD,
				messageId: "MSG-1",
				authorUserId: "FOUNDER-1",
			}),
			// hook "failed" (retrySafe false) — must NOT matter for reject anymore
			writeGateResponseImpl: vi
				.fn()
				.mockResolvedValue({ written: true, retrySafe: false }),
		});
		const r = await tryFounderShipApproval(
			{
				msg: { ...founderMsg, content: "改 A/B/C" },
				shipGates: oneShipGate,
				ctx: CTX,
			},
			d,
		);
		expect(deferral.queueFeedbackWake).toHaveBeenCalledWith(
			expect.objectContaining({ questionId: "Q-1", feedback: "改 A/B/C" }),
		);
		expect(r).toMatchObject({
			bound: [{ questionId: "Q-1", decision: "reject" }],
			retry: false,
		});
	});

	it("HIGH-1: approve response durable but FSM unflipped → PARKED for the rebind pass (deferred outcome, not an unreachable retry)", async () => {
		const deferral = baseDeferral();
		const d = deps({
			deferral,
			// writer succeeds but the fake does NOT flip (simulates a silent hook
			// FSM failure)
			writeGateResponseImpl: vi
				.fn()
				.mockResolvedValue({ written: true, retrySafe: true }),
		});
		const r = await tryFounderShipApproval(
			{ msg: founderMsg, shipGates: oneShipGate, ctx: CTX },
			d,
		);
		expect(deferral.parkForConvergence).toHaveBeenCalledWith(
			expect.objectContaining({ questionId: "Q-1", decision: "approve" }),
		);
		expect(r).toMatchObject({
			deferred: [{ questionId: "Q-1", decision: "approve" }],
			retry: false,
		});
	});

	it("legacy (no deferral wired): unflipped approve keeps the retry disposition", async () => {
		const d = deps({
			writeGateResponseImpl: vi
				.fn()
				.mockResolvedValue({ written: true, retrySafe: true }),
		});
		const r = await tryFounderShipApproval(
			{ msg: founderMsg, shipGates: oneShipGate, ctx: CTX },
			d,
		);
		expect(r).toMatchObject({ retry: true, stage: "postcondition_pending" });
	});
});

describe("Codex code R2 HIGH: reject wake-intent failure is PARKED (not an unreachable retry)", () => {
	it("queueFeedbackWake throws after the reject response is durable → parkForConvergence(reject) → deferred outcome", async () => {
		const deferral = {
			holdReason: vi.fn(() => null),
			defer: vi.fn(() => "inserted" as const),
			queueHeldNotice: vi.fn(),
			parkForConvergence: vi.fn(),
			queueFeedbackWake: vi.fn(() => {
				throw new Error("ledger write failed");
			}),
		};
		const d = deps({
			deferral,
			evaluateTextImpl: vi.fn().mockResolvedValue({
				source: "text",
				kind: "reject",
				questionId: "Q-1",
				prHeadSha: HEAD,
				messageId: "MSG-1",
				authorUserId: "FOUNDER-1",
			}),
			writeGateResponseImpl: vi
				.fn()
				.mockResolvedValue({ written: true, retrySafe: true }),
		});
		const r = await tryFounderShipApproval(
			{
				msg: { ...founderMsg, content: "改 A/B/C" },
				shipGates: oneShipGate,
				ctx: CTX,
			},
			d,
		);
		expect(deferral.parkForConvergence).toHaveBeenCalledWith(
			expect.objectContaining({ questionId: "Q-1", decision: "reject" }),
		);
		expect(r).toMatchObject({
			deferred: [{ questionId: "Q-1", decision: "reject" }],
			retry: false,
		});
	});
});

describe("Codex code R3 HIGH: double failure (wake intent + park) → deadLetter disposition", () => {
	it("queueFeedbackWake AND parkForConvergence both throw → immediate deadLetter, never a bare retry", async () => {
		const deferral = {
			holdReason: vi.fn(() => null),
			defer: vi.fn(() => "inserted" as const),
			queueHeldNotice: vi.fn(),
			parkForConvergence: vi.fn(() => {
				throw new Error("store still down");
			}),
			queueFeedbackWake: vi.fn(() => {
				throw new Error("ledger write failed");
			}),
		};
		const d = deps({
			deferral,
			evaluateTextImpl: vi.fn().mockResolvedValue({
				source: "text",
				kind: "reject",
				questionId: "Q-1",
				prHeadSha: HEAD,
				messageId: "MSG-1",
				authorUserId: "FOUNDER-1",
			}),
			writeGateResponseImpl: vi
				.fn()
				.mockResolvedValue({ written: true, retrySafe: true }),
		});
		const r = await tryFounderShipApproval(
			{
				msg: { ...founderMsg, content: "改 A/B/C" },
				shipGates: oneShipGate,
				ctx: CTX,
			},
			d,
		);
		expect(r).toMatchObject({
			retry: false,
			deadLetter: {
				questionId: "Q-1",
				stage: "convergence_park_failed",
			},
		});
	});
});

describe("FLY-1238 merged-PR last-mile guard", () => {
	it("silences the exact merge_block incident before queuing the stale pointer", async () => {
		const deferral = {
			holdReason: vi.fn(() => "merge_block" as const),
			defer: vi.fn(() => "inserted" as const),
			queueHeldNotice: vi.fn(),
			parkForConvergence: vi.fn(),
			queueFeedbackWake: vi.fn(),
		};
		const mergedGateGuard = vi.fn().mockResolvedValue({
			kind: "suppress_merged",
			cleanupComplete: true,
		});
		const d = deps({ deferral, mergedGateGuard });
		const result = await tryFounderShipApproval(
			{ msg: founderMsg, shipGates: oneShipGate, ctx: CTX },
			d,
		);
		expect(result).toEqual({
			bound: [],
			deferred: [],
			suppressed: [{ questionId: "Q-1" }],
			retry: false,
		});
		expect(mergedGateGuard).toHaveBeenCalledWith(
			expect.objectContaining({
				questionId: "Q-1",
				prNumber: 799,
				source: "text",
			}),
		);
		expect(deferral.queueHeldNotice).not.toHaveBeenCalled();
		expect(d.writeGateResponseImpl).not.toHaveBeenCalled();
	});

	it("keeps transient UNKNOWN retryable without writing the response", async () => {
		const mergedGateGuard = vi.fn().mockResolvedValue({
			kind: "retry_later",
			reason: "unknown",
		});
		const d = deps({ mergedGateGuard });
		const result = await tryFounderShipApproval(
			{ msg: founderMsg, shipGates: oneShipGate, ctx: CTX },
			d,
		);
		expect(result).toMatchObject({
			retry: true,
			stage: "merged_gate_guard_retry",
		});
		expect(d.writeGateResponseImpl).not.toHaveBeenCalled();
	});

	it("keeps a missing PR binding retryable instead of dead-lettering the decision", async () => {
		const d = deps({
			store: {
				getSession: vi.fn().mockReturnValue(session({ pr_number: null })),
			},
			mergedGateGuard: vi.fn().mockResolvedValue({
				kind: "retry_later",
				reason: "missing_binding",
			}),
		});
		const result = await tryFounderShipApproval(
			{ msg: founderMsg, shipGates: oneShipGate, ctx: CTX },
			d,
		);
		expect(result).toMatchObject({
			retry: true,
			stage: "merged_gate_guard_retry",
			reason: "missing_binding",
		});
		expect(result).not.toHaveProperty("deadLetter");
		expect(d.writeGateResponseImpl).not.toHaveBeenCalled();
	});

	it("terminal guard failure dead-letters the input instead of retrying forever", async () => {
		const d = deps({
			mergedGateGuard: vi.fn().mockResolvedValue({
				kind: "terminal_unavailable",
				reason: "unknown_exhausted",
			}),
		});
		const result = await tryFounderShipApproval(
			{ msg: founderMsg, shipGates: oneShipGate, ctx: CTX },
			d,
		);
		expect(result).toMatchObject({
			retry: false,
			deadLetter: {
				questionId: "Q-1",
				stage: "merged_gate_guard_terminal",
			},
		});
		expect(d.writeGateResponseImpl).not.toHaveBeenCalled();
	});
});
